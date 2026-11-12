import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AuthError } from './errors.js';
import type { AuthStore } from './store.js';
import type { Identity } from './types.js';

export const LOCAL_USER_EMAIL = 'local@open-kairos.local';
export const LOCAL_USER_USERNAME = '本地用户';

export interface AuthServiceOptions {
  secret: string;
  createMainThread: (tenantId: string) => { threadId: string };
  now?: () => Date;
  createId?: () => string;
  sessionTtlMs?: number;
}

export class AuthService {
  readonly store: AuthStore;
  readonly #options: AuthServiceOptions;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(store: AuthStore, options: AuthServiceOptions) {
    if (options.secret.length < 32) {
      throw new Error('The authentication secret must contain at least 32 characters.');
    }
    this.store = store;
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  ensureLocalIdentity(): Identity {
    const existing = this.store.localIdentity();
    if (existing) return existing;
    const now = this.#now().toISOString();
    const user = this.store.createLocalUser({
      userId: this.#createId(),
      tenantId: this.#createId(),
      email: LOCAL_USER_EMAIL,
      username: LOCAL_USER_USERNAME,
      now,
    });
    this.#options.createMainThread(user.tenantId);
    const identity = this.store.localIdentity();
    if (!identity) throw new AuthError('internal', 'The local identity was not created.');
    return identity;
  }

  createLocalSession(): { token: string; expiresAt: string } {
    const identity = this.ensureLocalIdentity();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.#expires(this.#options.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000);
    this.store.createSession(
      identity.userId,
      this.#createId(),
      this.#tokenHash('session', token),
      expiresAt,
      this.#now().toISOString(),
    );
    return { token, expiresAt };
  }

  bootstrapSession(token: string): { identity: Identity; expiresAt: string } {
    const identity = this.store.identityBySessionToken(
      this.#tokenHash('session', token),
      this.#now().toISOString(),
    );
    if (!identity) {
      throw new AuthError('unauthenticated', 'The local session token is invalid or expired.');
    }
    const session = this.store.sessionExpiryByToken(this.#tokenHash('session', token));
    if (!session) {
      throw new AuthError('unauthenticated', 'The local session token is invalid or expired.');
    }
    return { identity, expiresAt: session };
  }

  currentIdentity(
    sessionToken: string | undefined,
  ): { state: 'authenticated'; identity: Identity } | { state: 'anonymous' } {
    if (!sessionToken) return { state: 'anonymous' };
    const identity = this.store.identityBySessionToken(
      this.#tokenHash('session', sessionToken),
      this.#now().toISOString(),
    );
    return identity ? { state: 'authenticated', identity } : { state: 'anonymous' };
  }

  requireIdentity(sessionToken: string | undefined): Identity {
    if (!sessionToken) throw new AuthError('unauthenticated', 'A login session is required.');
    const identity = this.store.identityBySessionToken(
      this.#tokenHash('session', sessionToken),
      this.#now().toISOString(),
    );
    if (!identity)
      throw new AuthError('unauthenticated', 'The login session is invalid or expired.');
    return identity;
  }

  revokeSession(sessionToken: string | undefined): void {
    if (!sessionToken) return;
    this.store.revokeSession(this.#tokenHash('session', sessionToken), this.#now().toISOString());
  }

  #expires(ttlMs: number): string {
    return new Date(this.#now().getTime() + ttlMs).toISOString();
  }

  #tokenHash(kind: 'session', token: string): string {
    return createHmac('sha256', this.#options.secret)
      .update(`kairos-${kind}-credential\0${token}`)
      .digest('hex');
  }
}
