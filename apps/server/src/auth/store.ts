import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { inTransaction } from '../storage/transaction.js';
import type { Identity } from './types.js';

const identityRowSchema = z.object({
  user_id: z.string(),
  email: z.string(),
  username: z.string(),
  tenant_id: z.string(),
  main_thread_id: z.string(),
  avatar_id: z.string().nullable(),
  profile_version: z.number().int().nonnegative(),
});

export class AuthStore {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  localIdentity(): Identity | undefined {
    const row = this.database
      .prepare(
        `SELECT users.user_id FROM users
         JOIN tenants ON tenants.tenant_id = users.tenant_id AND tenants.user_id = users.user_id
         WHERE users.status = 'active' ORDER BY users.created_at, users.user_id LIMIT 1`,
      )
      .get();
    if (row === undefined) return undefined;
    return this.getIdentityForUser(z.object({ user_id: z.string() }).parse(row).user_id);
  }

  createLocalUser(input: {
    userId: string;
    tenantId: string;
    email: string;
    username: string;
    now: string;
  }): { userId: string; tenantId: string } {
    return inTransaction(this.database, () => {
      const existing = this.database
        .prepare('SELECT user_id, tenant_id FROM users WHERE email = ?')
        .get(input.email);
      if (existing !== undefined) {
        const row = z
          .object({ user_id: z.string(), tenant_id: z.string().nullable() })
          .parse(existing);
        if (row.tenant_id !== null) return { userId: row.user_id, tenantId: row.tenant_id };
        this.database
          .prepare(
            `INSERT INTO tenants(tenant_id, user_id, default_env_id, created_at, updated_at)
             VALUES (?, ?, NULL, ?, ?)`,
          )
          .run(input.tenantId, row.user_id, input.now, input.now);
        this.database
          .prepare('UPDATE users SET tenant_id = ?, updated_at = ? WHERE user_id = ?')
          .run(input.tenantId, input.now, row.user_id);
        return { userId: row.user_id, tenantId: input.tenantId };
      }
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
          input.email,
          input.now,
          input.username,
          input.tenantId,
          input.now,
          input.now,
        );
      return { userId: input.userId, tenantId: input.tenantId };
    });
  }

  createSession(
    userId: string,
    sessionId: string,
    tokenHash: string,
    expiresAt: string,
    now: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO auth_sessions(
          session_id, user_id, token_hash, created_at, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(sessionId, userId, tokenHash, now, expiresAt);
  }

  sessionExpiryByToken(tokenHash: string): string | undefined {
    const row = this.database
      .prepare('SELECT expires_at, revoked_at FROM auth_sessions WHERE token_hash = ?')
      .get(tokenHash);
    const session = z
      .object({ expires_at: z.string(), revoked_at: z.string().nullable() })
      .optional()
      .parse(row);
    if (!session || session.revoked_at !== null) return undefined;
    return session.expires_at;
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

  revokeSession(tokenHash: string, now: string): void {
    this.database
      .prepare(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?)
         WHERE token_hash = ?`,
      )
      .run(now, tokenHash);
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
