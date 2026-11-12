import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { normalizeEmail } from '@kairos/contracts';
import { AuthError } from './errors.js';
import type { EmailSender } from './mailer.js';
import type { AuthStore, EmailVerification } from './store.js';
import type { Identity, VerifiedAuthentication } from './types.js';

export const LOCAL_TEST_EMAIL = 'test@kairos.com';
export const LOCAL_TEST_CODE = '945945';

export interface AuthServiceOptions {
  secret: string;
  invitedEmails: readonly string[];
  testAccountEnabled: boolean;
  createMainThread: (tenantId: string) => { threadId: string };
  mailer?: EmailSender;
  now?: () => Date;
  createId?: () => string;
  verificationTtlMs?: number;
  setupTtlMs?: number;
  sessionTtlMs?: number;
  maxCodeAttempts?: number;
  resendIntervalMs?: number;
  sourceWindowMs?: number;
  sourceLimit?: number;
  globalWindowMs?: number;
  globalLimit?: number;
}

export class AuthService {
  readonly store: AuthStore;
  readonly #options: AuthServiceOptions;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #invitedEmails: Set<string>;
  readonly #inflightDeliveries = new Map<
    string,
    Promise<{ verificationId: string; expiresAt: string }>
  >();

  constructor(store: AuthStore, options: AuthServiceOptions) {
    if (options.secret.length < 32) {
      throw new Error('The authentication secret must contain at least 32 characters.');
    }
    this.store = store;
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#invitedEmails = new Set(options.invitedEmails);
  }

  async requestEmailCode(input: {
    email: string;
    clientActionId: string;
    sourceAddress: string;
  }): Promise<{ verificationId: string; expiresAt: string }> {
    const email = this.#email(input.email);
    const clientActionId = this.#actionId(input.clientActionId);
    const sourceAddress = input.sourceAddress.trim().slice(0, 200) || 'unknown';
    const isTestAccount = email === LOCAL_TEST_EMAIL;
    if (isTestAccount && !this.#options.testAccountEnabled) {
      throw new AuthError('permission_denied', 'The local test account is not available.');
    }
    if (!isTestAccount && !this.#loginAllowed(email)) {
      throw new AuthError('permission_denied', 'This email address is not invited.');
    }
    if (!isTestAccount && !this.#options.mailer) {
      throw new AuthError('unavailable', 'SMTP email delivery is not configured.');
    }
    const existing = this.store.getVerificationByAction(clientActionId);
    if (existing && existing.email !== email) {
      throw new AuthError(
        'conflict',
        'The client action ID was already used for another email address.',
      );
    }
    const inflight = this.#inflightDeliveries.get(clientActionId);
    if (inflight) return inflight;
    if (existing) return this.#existingDelivery(existing);
    const operation = this.#newDelivery({ email, clientActionId, sourceAddress, isTestAccount });
    this.#inflightDeliveries.set(clientActionId, operation);
    try {
      return await operation;
    } finally {
      this.#inflightDeliveries.delete(clientActionId);
    }
  }

  verifyEmailCode(input: {
    email: string;
    verificationId: string;
    code: string;
  }): VerifiedAuthentication {
    const email = this.#email(input.email);
    this.#assertLoginAllowed(email);
    if (!/^\d{6}$/.test(input.code)) {
      throw new AuthError('invalid_argument', 'The email code must contain six digits.');
    }
    const setupToken = this.#token();
    const sessionToken = this.#token();
    const now = this.#now().toISOString();
    const result = this.store.exchangeVerification({
      verificationId: input.verificationId,
      email,
      codeHash: this.#codeHash(input.verificationId, email, input.code),
      now,
      maxAttempts: this.#options.maxCodeAttempts ?? 5,
      setup: {
        credentialId: this.#createId(),
        tokenHash: this.#tokenHash('setup', setupToken),
        expiresAt: this.#expires(this.#options.setupTtlMs ?? 15 * 60 * 1000),
      },
      session: {
        credentialId: this.#createId(),
        tokenHash: this.#tokenHash('session', sessionToken),
        expiresAt: this.#expires(this.#options.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000),
      },
    });
    if (result.kind === 'invalid') {
      throw new AuthError('unauthenticated', 'The email code is invalid or expired.');
    }
    if (result.kind === 'profile_required') {
      return {
        kind: 'profile_required',
        credential: { token: setupToken, expiresAt: result.credential.expiresAt },
      };
    }
    return {
      kind: 'authenticated',
      identity: result.identity,
      credential: { token: sessionToken, expiresAt: result.credential.expiresAt },
    };
  }

  completeProfile(
    setupToken: string,
    username: string,
  ): {
    identity: Identity;
    token: string;
    expiresAt: string;
  } {
    const normalizedUsername = username.trim();
    if (
      normalizedUsername.length === 0 ||
      normalizedUsername.length > 80 ||
      normalizedUsername.includes('\0')
    ) {
      throw new AuthError(
        'invalid_argument',
        'The username must contain between 1 and 80 characters without null characters.',
      );
    }
    const setupTokenHash = this.#tokenHash('setup', setupToken);
    const now = this.#now().toISOString();
    const setupEmail = this.store.setupEmailByToken(setupTokenHash, now);
    if (setupEmail) this.#assertLoginAllowed(setupEmail);
    const sessionToken = this.#token();
    const result = this.store.completeProfile({
      setupTokenHash,
      username: normalizedUsername,
      now,
      userId: this.#createId(),
      tenantId: this.#createId(),
      sessionId: this.#createId(),
      sessionTokenHash: this.#tokenHash('session', sessionToken),
      sessionExpiresAt: this.#expires(this.#options.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000),
      createMainThread: this.#options.createMainThread,
    });
    return { identity: result.identity, token: sessionToken, expiresAt: result.sessionExpiresAt };
  }

  currentIdentity(
    sessionToken: string | undefined,
    setupToken: string | undefined,
  ):
    | { state: 'authenticated'; identity: Identity }
    | { state: 'profile_required' }
    | { state: 'anonymous' } {
    const now = this.#now().toISOString();
    if (sessionToken) {
      const identity = this.store.identityBySessionToken(
        this.#tokenHash('session', sessionToken),
        now,
      );
      if (identity && this.#loginAllowed(identity.email)) {
        return { state: 'authenticated', identity };
      }
    }
    const setupEmail = setupToken
      ? this.store.setupEmailByToken(this.#tokenHash('setup', setupToken), now)
      : undefined;
    if (setupEmail && this.#loginAllowed(setupEmail)) return { state: 'profile_required' };
    return { state: 'anonymous' };
  }

  requireIdentity(sessionToken: string | undefined): Identity {
    if (!sessionToken) throw new AuthError('unauthenticated', 'A login session is required.');
    const identity = this.store.identityBySessionToken(
      this.#tokenHash('session', sessionToken),
      this.#now().toISOString(),
    );
    if (!identity)
      throw new AuthError('unauthenticated', 'The login session is invalid or expired.');
    this.#assertLoginAllowed(identity.email);
    return identity;
  }

  revokeSession(sessionToken: string | undefined): void {
    if (!sessionToken) return;
    this.store.revokeSession(this.#tokenHash('session', sessionToken), this.#now().toISOString());
  }

  async #newDelivery(input: {
    email: string;
    clientActionId: string;
    sourceAddress: string;
    isTestAccount: boolean;
  }): Promise<{ verificationId: string; expiresAt: string }> {
    const now = this.#now().toISOString();
    const verificationId = this.#createId();
    const expiresAt = this.#expires(this.#options.verificationTtlMs ?? 10 * 60 * 1000);
    const code = input.isTestAccount
      ? LOCAL_TEST_CODE
      : randomInt(0, 1_000_000).toString().padStart(6, '0');
    const created = this.store.createVerification({
      verificationId,
      clientActionId: input.clientActionId,
      email: input.email,
      sourceAddress: input.sourceAddress,
      codeHash: this.#codeHash(verificationId, input.email, code),
      deliveryStatus: input.isTestAccount ? 'not_required' : 'pending',
      now,
      expiresAt,
      limits: {
        resendIntervalMs: this.#options.resendIntervalMs ?? 60_000,
        sourceWindowMs: this.#options.sourceWindowMs ?? 60 * 60 * 1000,
        sourceLimit: this.#options.sourceLimit ?? 10,
        globalWindowMs: this.#options.globalWindowMs ?? 60 * 60 * 1000,
        globalLimit: this.#options.globalLimit ?? 100,
      },
    });
    if (!created.created) return this.#existingDelivery(created.verification);
    if (input.isTestAccount) return { verificationId, expiresAt };
    try {
      if (!this.#options.mailer) {
        throw new AuthError('unavailable', 'SMTP email delivery is not configured.');
      }
      await this.#options.mailer.send({
        to: input.email,
        subject: 'Kairos 登录验证码',
        text: `你的 Kairos 登录验证码是 ${code}，10 分钟内有效。`,
      });
      this.store.finishDelivery(verificationId, 'sent', this.#now().toISOString());
      return { verificationId, expiresAt };
    } catch {
      this.store.finishDelivery(verificationId, 'failed', this.#now().toISOString());
      throw new AuthError('unavailable', 'Email delivery failed.', {
        retryable: true,
      });
    }
  }

  async #existingDelivery(verification: EmailVerification): Promise<{
    verificationId: string;
    expiresAt: string;
  }> {
    if (verification.delivery_status === 'failed') {
      throw new AuthError('unavailable', 'Email delivery failed.', { retryable: true });
    }
    if (verification.delivery_status === 'pending') {
      throw new AuthError(
        'unavailable',
        'The previous email delivery outcome is unknown; use a new client action ID.',
        { retryable: true },
      );
    }
    return { verificationId: verification.verification_id, expiresAt: verification.expires_at };
  }

  #loginAllowed(email: string): boolean {
    return email === LOCAL_TEST_EMAIL
      ? this.#options.testAccountEnabled
      : this.#invitedEmails.has('*') || this.#invitedEmails.has(email);
  }

  #assertLoginAllowed(email: string): void {
    if (email === LOCAL_TEST_EMAIL && !this.#options.testAccountEnabled) {
      throw new AuthError('permission_denied', 'The local test account is not available.');
    }
    if (email !== LOCAL_TEST_EMAIL && !this.#loginAllowed(email)) {
      throw new AuthError('permission_denied', 'This email address is not invited.');
    }
  }

  #email(value: string): string {
    try {
      return normalizeEmail(value);
    } catch {
      throw new AuthError('invalid_argument', 'The email address is invalid.');
    }
  }

  #actionId(value: string): string {
    if (value.trim().length === 0 || value.length > 200 || value.includes('\0')) {
      throw new AuthError('invalid_argument', 'The client action ID is invalid.');
    }
    return value;
  }

  #token(): string {
    return randomBytes(32).toString('base64url');
  }

  #expires(ttlMs: number): string {
    return new Date(this.#now().getTime() + ttlMs).toISOString();
  }

  #codeHash(verificationId: string, email: string, code: string): string {
    return createHmac('sha256', this.#options.secret)
      .update(`kairos-email-code\0${verificationId}\0${email}\0${code}`)
      .digest('hex');
  }

  #tokenHash(kind: 'setup' | 'session', token: string): string {
    return createHmac('sha256', this.#options.secret)
      .update(`kairos-${kind}-credential\0${token}`)
      .digest('hex');
  }
}
