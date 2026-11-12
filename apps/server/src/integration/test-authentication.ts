import { createHmac, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Interceptor } from '@connectrpc/connect';
import type { GuiAuthentication } from '../api/auth.js';
import { createServer, type IdentityServerOptions, type ServerOptions } from '../app.js';
import { AuthService } from '../auth/service.js';
import { AuthStore } from '../auth/store.js';
import type { MainEnvironmentConfiguration } from '../devices/main-environment.js';
import { SessionStore } from '../sessions/store.js';
import { inTransaction } from '../storage/transaction.js';
import type { WorkspaceResourceSource } from './environment-fixture.js';
import { ControlledEnvironmentUseGateway } from './environment-fixture.js';

export const testSessionToken = 'test-session-token';
const testSecret = 'test-session-authentication-secret-at-least-32-characters';
const testOrigin = 'http://127.0.0.1:4317';
const testCsrfToken = 'test-csrf-token';

export function testIdentityOptions(): IdentityServerOptions {
  return {
    secret: testSecret,
    invitedEmails: ['*'],
    testAccountEnabled: true,
    allowedOrigin: testOrigin,
    secureCookies: false,
  };
}

export function testSessionHeaders(token = testSessionToken): Record<string, string> {
  return {
    cookie: `kairos_session=${token}; kairos_csrf=${testCsrfToken}`,
    origin: testOrigin,
    'x-csrf-token': testCsrfToken,
  };
}

export function testSessionInterceptor(token = testSessionToken): Interceptor {
  return (next) => async (request) => {
    for (const [name, value] of Object.entries(testSessionHeaders(token))) {
      request.header.set(name, value);
    }
    return next(request);
  };
}

export function seedTestSession(
  database: DatabaseSync,
  tenantId: string,
  token: string,
  mainEnvironment?: MainEnvironmentConfiguration,
): void {
  const store = new SessionStore(database, mainEnvironment ? { mainEnvironment } : {});
  const now = new Date().toISOString();
  inTransaction(database, () => {
    const tenant = database
      .prepare('SELECT user_id FROM tenants WHERE tenant_id = ?')
      .get(tenantId);
    const userId = tenant ? String(tenant.user_id) : `user-${tenantId}`;
    if (!tenant) {
      database
        .prepare(
          `INSERT INTO tenants(tenant_id, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(tenantId, userId, now, now);
    }
    database
      .prepare(
        `INSERT INTO users(
          user_id, email, email_verified_at, username, tenant_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET tenant_id = excluded.tenant_id,
          username = COALESCE(users.username, excluded.username)`,
      )
      .run(userId, `${userId}@example.com`, now, tenantId, tenantId, now, now);
    store.getOrCreateMainThread(tenantId);
    database
      .prepare(
        `INSERT INTO auth_sessions(
          session_id, user_id, token_hash, created_at, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(token_hash) DO NOTHING`,
      )
      .run(
        randomUUID(),
        userId,
        createHmac('sha256', testSecret)
          .update(`kairos-session-credential\0${token}`)
          .digest('hex'),
        now,
        '2099-01-01T00:00:00.000Z',
      );
  });
}

export function createTestAuthentication(
  database: DatabaseSync,
  tenantId: string,
  token = testSessionToken,
  mainEnvironment?: MainEnvironmentConfiguration,
): GuiAuthentication {
  seedTestSession(database, tenantId, token, mainEnvironment);
  const options = testIdentityOptions();
  return {
    authService: new AuthService(new AuthStore(database), {
      ...options,
      createMainThread: (ownerId) =>
        new SessionStore(
          database,
          mainEnvironment ? { mainEnvironment } : {},
        ).getOrCreateMainThread(ownerId),
    }),
    allowedOrigin: options.allowedOrigin,
    secureCookies: options.secureCookies,
  };
}

export interface TestServerOptions extends ServerOptions {
  tenantId?: string;
  sessionToken?: string;
  workspaceDirectory?: string;
  workspaceResourceLoader?: WorkspaceResourceSource;
}

export function createTestServer(
  database: DatabaseSync,
  logger = false,
  options: TestServerOptions = {},
) {
  const {
    tenantId = 'local-user',
    sessionToken = testSessionToken,
    workspaceDirectory: _workspaceDirectory,
    workspaceResourceLoader: _workspaceResourceLoader,
    ...serverOptions
  } = options;
  const server = createServer(database, logger, {
    ...serverOptions,
    identity: serverOptions.identity ?? testIdentityOptions(),
    environmentUse: serverOptions.environmentUse ?? new ControlledEnvironmentUseGateway(database),
  });
  if (serverOptions.identity === undefined)
    seedTestSession(database, tenantId, sessionToken, serverOptions.mainEnvironment);
  return server;
}
