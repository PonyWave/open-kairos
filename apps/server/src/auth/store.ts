import { timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { inTransaction } from '../storage/transaction.js';
import { AuthError } from './errors.js';
import type { Identity, VerifiedAuthentication } from './types.js';

const verificationRowSchema = z.object({
  verification_id: z.string(),
  client_action_id: z.string(),
  email: z.string(),
  source_address: z.string(),
  code_hash: z.string(),
  delivery_status: z.enum(['pending', 'sent', 'failed', 'not_required']),
  delivery_error: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string(),
  consumed_at: z.string().nullable(),
  invalidated_at: z.string().nullable(),
});

const userRowSchema = z.object({
  user_id: z.string(),
  email: z.string(),
  email_verified_at: z.string(),
  username: z.string().nullable(),
  tenant_id: z.string().nullable(),
  status: z.enum(['active', 'disabled']),
  created_at: z.string(),
  updated_at: z.string(),
});

const identityRowSchema = z.object({
  user_id: z.string(),
  email: z.string(),
  username: z.string(),
  tenant_id: z.string(),
  main_thread_id: z.string(),
  avatar_id: z.string().nullable(),
  profile_version: z.number().int().nonnegative(),
});

const countSchema = z.object({ count: z.number().int().nonnegative() });

export type EmailVerification = z.infer<typeof verificationRowSchema>;

interface CredentialRecord {
  credentialId: string;
  tokenHash: string;
  expiresAt: string;
}

export interface VerificationRequestLimits {
  resendIntervalMs: number;
  sourceWindowMs: number;
  sourceLimit: number;
  globalWindowMs: number;
  globalLimit: number;
}

export class AuthStore {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  getVerificationByAction(clientActionId: string): EmailVerification | undefined {
    const row = this.database
      .prepare('SELECT * FROM auth_email_verifications WHERE client_action_id = ?')
      .get(clientActionId);
    return row === undefined ? undefined : verificationRowSchema.parse(row);
  }

  createVerification(input: {
    verificationId: string;
    clientActionId: string;
    email: string;
    sourceAddress: string;
    codeHash: string;
    deliveryStatus: 'pending' | 'not_required';
    now: string;
    expiresAt: string;
    limits: VerificationRequestLimits;
  }): { verification: EmailVerification; created: boolean } {
    return inTransaction(this.database, () => {
      const existing = this.getVerificationByAction(input.clientActionId);
      if (existing) {
        if (existing.email !== input.email) {
          throw new AuthError(
            'conflict',
            'The client action ID was already used for another email address.',
          );
        }
        return { verification: existing, created: false };
      }
      const latest = this.database
        .prepare(
          `SELECT created_at FROM auth_email_verifications
           WHERE email = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(input.email);
      if (latest !== undefined) {
        const createdAt = z.object({ created_at: z.string() }).parse(latest).created_at;
        if (Date.parse(createdAt) + input.limits.resendIntervalMs > Date.parse(input.now)) {
          throw new AuthError('resource_exhausted', 'An email code was requested too recently.', {
            retryable: true,
          });
        }
      }
      const sourceCutoff = new Date(
        Date.parse(input.now) - input.limits.sourceWindowMs,
      ).toISOString();
      const sourceCount = countSchema.parse(
        this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM auth_email_verifications
             WHERE source_address = ? AND created_at >= ?`,
          )
          .get(input.sourceAddress, sourceCutoff),
      ).count;
      if (sourceCount >= input.limits.sourceLimit) {
        throw new AuthError(
          'resource_exhausted',
          'The email code request limit for this source was reached.',
          { retryable: true },
        );
      }
      const globalCutoff = new Date(
        Date.parse(input.now) - input.limits.globalWindowMs,
      ).toISOString();
      const globalCount = countSchema.parse(
        this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM auth_email_verifications
             WHERE delivery_status <> 'not_required' AND created_at >= ?`,
          )
          .get(globalCutoff),
      ).count;
      if (globalCount >= input.limits.globalLimit) {
        throw new AuthError('resource_exhausted', 'The email delivery limit was reached.', {
          retryable: true,
        });
      }
      this.database
        .prepare(
          `UPDATE auth_email_verifications SET invalidated_at = ?, updated_at = ?
           WHERE email = ? AND consumed_at IS NULL AND invalidated_at IS NULL`,
        )
        .run(input.now, input.now, input.email);
      this.database
        .prepare(
          `INSERT INTO auth_email_verifications(
            verification_id, client_action_id, email, source_address, code_hash,
            delivery_status, delivery_error, attempts, created_at, updated_at,
            expires_at, consumed_at, invalidated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          input.verificationId,
          input.clientActionId,
          input.email,
          input.sourceAddress,
          input.codeHash,
          input.deliveryStatus,
          input.now,
          input.now,
          input.expiresAt,
        );
      const verification = this.getVerificationByAction(input.clientActionId);
      if (!verification) throw new AuthError('internal', 'The email verification was not saved.');
      return { verification, created: true };
    });
  }

  finishDelivery(verificationId: string, status: 'sent' | 'failed', now: string): void {
    const updated = this.database
      .prepare(
        `UPDATE auth_email_verifications
         SET delivery_status = ?, delivery_error = ?, updated_at = ?
         WHERE verification_id = ? AND delivery_status = 'pending'`,
      )
      .run(status, status === 'failed' ? 'Email delivery failed.' : null, now, verificationId);
    if (updated.changes !== 1) {
      throw new AuthError('conflict', 'The email delivery state changed during sending.');
    }
  }

  exchangeVerification(input: {
    verificationId: string;
    email: string;
    codeHash: string;
    now: string;
    maxAttempts: number;
    setup: CredentialRecord;
    session: CredentialRecord;
  }): VerifiedAuthentication | { kind: 'invalid' } {
    return inTransaction(this.database, () => {
      const row = this.database
        .prepare('SELECT * FROM auth_email_verifications WHERE verification_id = ?')
        .get(input.verificationId);
      const verification = row === undefined ? undefined : verificationRowSchema.parse(row);
      const active =
        verification?.email === input.email &&
        verification.consumed_at === null &&
        verification.invalidated_at === null &&
        Date.parse(verification.expires_at) > Date.parse(input.now) &&
        verification.attempts < input.maxAttempts &&
        (verification.delivery_status === 'sent' ||
          verification.delivery_status === 'not_required');
      if (!verification || !active) return { kind: 'invalid' };
      const expected = Buffer.from(verification.code_hash);
      const supplied = Buffer.from(input.codeHash);
      const matches = expected.length === supplied.length && timingSafeEqual(expected, supplied);
      if (!matches) {
        this.database
          .prepare(
            `UPDATE auth_email_verifications
             SET attempts = attempts + 1, updated_at = ?
             WHERE verification_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL`,
          )
          .run(input.now, input.verificationId);
        return { kind: 'invalid' };
      }
      const consumed = this.database
        .prepare(
          `UPDATE auth_email_verifications SET consumed_at = ?, updated_at = ?
           WHERE verification_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
             AND attempts < ?`,
        )
        .run(input.now, input.now, input.verificationId, input.maxAttempts);
      if (consumed.changes !== 1) return { kind: 'invalid' };
      const user = this.#userByEmail(input.email);
      if (user?.status === 'disabled') {
        throw new AuthError('permission_denied', 'This account is disabled.');
      }
      if (user?.username && user.tenant_id) {
        this.#insertSession(input.session.credentialId, user.user_id, input.session, input.now);
        const identity = this.getIdentityForUser(user.user_id);
        if (!identity) throw new AuthError('internal', 'The user identity is incomplete.');
        return {
          kind: 'authenticated',
          credential: { token: '', expiresAt: input.session.expiresAt },
          identity,
        };
      }
      this.database
        .prepare(
          `INSERT INTO auth_setup_credentials(
            credential_id, email, token_hash, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.setup.credentialId,
          input.email,
          input.setup.tokenHash,
          input.now,
          input.setup.expiresAt,
        );
      return {
        kind: 'profile_required',
        credential: { token: '', expiresAt: input.setup.expiresAt },
      };
    });
  }

  completeProfile(input: {
    setupTokenHash: string;
    username: string;
    now: string;
    userId: string;
    tenantId: string;
    sessionId: string;
    sessionTokenHash: string;
    sessionExpiresAt: string;
    createMainThread: (tenantId: string) => { threadId: string };
  }): { identity: Identity; sessionExpiresAt: string } {
    return inTransaction(this.database, () => {
      const row = this.database
        .prepare('SELECT * FROM auth_setup_credentials WHERE token_hash = ?')
        .get(input.setupTokenHash);
      const setup = z
        .object({
          credential_id: z.string(),
          email: z.string(),
          expires_at: z.string(),
        })
        .optional()
        .parse(row);
      if (!setup || Date.parse(setup.expires_at) <= Date.parse(input.now)) {
        throw new AuthError(
          'unauthenticated',
          'The profile setup credential is invalid or expired.',
        );
      }
      let user = this.#userByEmail(setup.email);
      if (user?.status === 'disabled') {
        throw new AuthError('permission_denied', 'This account is disabled.');
      }
      if (!user) {
        this.database
          .prepare(
            `INSERT INTO tenants(tenant_id, user_id, default_env_id, created_at, updated_at)
             VALUES (?, ?, NULL, ?, ?)`,
          )
          .run(input.tenantId, input.userId, input.now, input.now);
        this.database
          .prepare(
            `INSERT INTO users(
              user_id, email, email_verified_at, username, tenant_id, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
          )
          .run(
            input.userId,
            setup.email,
            input.now,
            input.username,
            input.tenantId,
            input.now,
            input.now,
          );
        user = this.#userByEmail(setup.email);
      } else if (!user.tenant_id) {
        this.database
          .prepare(
            `INSERT INTO tenants(tenant_id, user_id, default_env_id, created_at, updated_at)
             VALUES (?, ?, NULL, ?, ?)`,
          )
          .run(input.tenantId, user.user_id, input.now, input.now);
        this.database
          .prepare(
            `UPDATE users SET username = COALESCE(username, ?), tenant_id = ?, updated_at = ?
             WHERE user_id = ? AND tenant_id IS NULL`,
          )
          .run(input.username, input.tenantId, input.now, user.user_id);
        user = this.#userByEmail(setup.email);
      } else if (!user.username) {
        this.database
          .prepare('UPDATE users SET username = ?, updated_at = ? WHERE user_id = ?')
          .run(input.username, input.now, user.user_id);
        user = this.#userByEmail(setup.email);
      }
      if (!user?.username || !user.tenant_id) {
        throw new AuthError('internal', 'The user or personal tenant was not created.');
      }
      input.createMainThread(user.tenant_id);
      this.#insertSession(
        input.sessionId,
        user.user_id,
        {
          credentialId: input.sessionId,
          tokenHash: input.sessionTokenHash,
          expiresAt: input.sessionExpiresAt,
        },
        input.now,
      );
      const identity = this.getIdentityForUser(user.user_id);
      if (!identity) throw new AuthError('internal', 'The user identity is incomplete.');
      const consumed = this.database
        .prepare('DELETE FROM auth_setup_credentials WHERE credential_id = ?')
        .run(setup.credential_id);
      if (consumed.changes !== 1) {
        throw new AuthError('conflict', 'The profile setup credential was already consumed.');
      }
      return { identity, sessionExpiresAt: input.sessionExpiresAt };
    });
  }

  identityBySessionToken(tokenHash: string, now: string): Identity | undefined {
    const row = this.database
      .prepare('SELECT user_id, expires_at, revoked_at FROM auth_sessions WHERE token_hash = ?')
      .get(tokenHash);
    const session = z
      .object({
        user_id: z.string(),
        expires_at: z.string(),
        revoked_at: z.string().nullable(),
      })
      .optional()
      .parse(row);
    if (
      !session ||
      session.revoked_at !== null ||
      Date.parse(session.expires_at) <= Date.parse(now)
    ) {
      return undefined;
    }
    return this.getIdentityForUser(session.user_id);
  }

  setupEmailByToken(tokenHash: string, now: string): string | undefined {
    const row = this.database
      .prepare('SELECT email, expires_at FROM auth_setup_credentials WHERE token_hash = ?')
      .get(tokenHash);
    const setup = z.object({ email: z.string(), expires_at: z.string() }).optional().parse(row);
    if (!setup || Date.parse(setup.expires_at) <= Date.parse(now)) return undefined;
    return setup.email;
  }

  revokeSession(tokenHash: string, now: string): void {
    this.database
      .prepare(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?)
         WHERE token_hash = ?`,
      )
      .run(now, tokenHash);
  }

  #insertSession(
    sessionId: string,
    userId: string,
    credential: CredentialRecord,
    now: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO auth_sessions(
          session_id, user_id, token_hash, created_at, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(sessionId, userId, credential.tokenHash, now, credential.expiresAt);
  }

  #userByEmail(email: string): z.infer<typeof userRowSchema> | undefined {
    const row = this.database.prepare('SELECT * FROM users WHERE email = ?').get(email);
    return row === undefined ? undefined : userRowSchema.parse(row);
  }

  getIdentityForUser(userId: string): Identity | undefined {
    const row = this.database
      .prepare(
        `SELECT users.user_id, users.email, users.username, users.tenant_id,
                threads.thread_id AS main_thread_id,
                user_profiles.avatar_id, COALESCE(user_profiles.version, 0) AS profile_version
         FROM users
         JOIN tenants ON tenants.tenant_id = users.tenant_id AND tenants.user_id = users.user_id
         JOIN threads ON threads.owner_id = users.tenant_id AND threads.thread_type = 'main'
           AND threads.archived_at IS NULL
         LEFT JOIN user_profiles ON user_profiles.user_id = users.user_id
         WHERE users.user_id = ? AND users.status = 'active'`,
      )
      .get(userId);
    if (row === undefined) return undefined;
    const parsed = identityRowSchema.parse(row);
    return {
      userId: parsed.user_id,
      email: parsed.email,
      username: parsed.username,
      tenantId: parsed.tenant_id,
      mainThreadId: parsed.main_thread_id,
      ...(parsed.avatar_id ? { avatarId: parsed.avatar_id } : {}),
      profileVersion: parsed.profile_version,
    };
  }
}
