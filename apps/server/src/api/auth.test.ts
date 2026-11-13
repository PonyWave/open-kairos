import { createClient, createRouterTransport } from '@connectrpc/connect';
import { AuthenticationState, AuthService } from '@kairos/contracts';
import { expect, it } from 'vitest';
import { AuthService as AuthServiceClass } from '../auth/service.js';
import { AuthStore } from '../auth/store.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { registerAuthRoutes } from './auth.js';

const secret = 'local-bootstrap-test-secret-at-least-32-characters';

function fixture() {
  const database = openDatabase(':memory:');
  const sessions = new SessionStore(database);
  const service = new AuthServiceClass(new AuthStore(database), {
    secret,
    createMainThread: (tenantId) => sessions.getOrCreateMainThread(tenantId),
  });
  return { database, sessions, service };
}

it('creates the local identity idempotently and bootstraps sessions', () => {
  const { database, service } = fixture();
  try {
    const first = service.ensureLocalIdentity();
    const second = service.ensureLocalIdentity();
    expect(second.userId).toBe(first.userId);
    expect(second.tenantId).toBe(first.tenantId);
    expect(first.email).toBe('local@open-kairos.local');
    expect(first.mainThreadId).toBeTruthy();

    const session = service.createLocalSession();
    const bootstrapped = service.bootstrapSession(session.token);
    expect(bootstrapped.identity?.userId).toBe(first.userId);
    expect(bootstrapped.expiresAt).toBe(session.expiresAt);
    expect(() => service.bootstrapSession('wrong-token')).toThrowError(
      expect.objectContaining({ code: 'unauthenticated' }),
    );

    expect(service.currentIdentity(session.token)).toMatchObject({
      state: 'authenticated',
      identity: { userId: first.userId },
    });
    expect(service.currentIdentity(undefined)).toEqual({ state: 'anonymous' });
    expect(service.requireIdentity(session.token).tenantId).toBe(first.tenantId);
    expect(() => service.requireIdentity(undefined)).toThrowError(
      expect.objectContaining({ code: 'unauthenticated' }),
    );

    service.revokeSession(session.token);
    expect(service.currentIdentity(session.token)).toEqual({ state: 'anonymous' });
    expect(() => service.bootstrapSession(session.token)).toThrowError(
      expect.objectContaining({ code: 'unauthenticated' }),
    );
  } finally {
    database.close();
  }
});

it('allows loopback and same-origin requests by default and rejects foreign origins', async () => {
  const { database, service } = fixture();
  try {
    const csrf = 'test-csrf-token';
    let origin = 'http://127.0.0.1:4317';
    let host = '127.0.0.1:4317';
    const router = createRouterTransport(
      (connectRouter) => {
        registerAuthRoutes(connectRouter, {
          authService: service,
          allowedOrigin: null,
          secureCookies: false,
        });
      },
      {
        transport: {
          interceptors: [
            (next) => async (request) => {
              request.header.set('origin', origin);
              request.header.set('host', host);
              request.header.set('cookie', `kairos_csrf=${csrf}`);
              request.header.set('x-csrf-token', csrf);
              return next(request);
            },
          ],
        },
      },
    );
    const client = createClient(AuthService, router);

    await expect(client.bootstrapSession({ token: 'invalid-token' })).rejects.toMatchObject({
      code: 16,
    });

    origin = 'http://192.168.1.10:4317';
    host = '192.168.1.10:4317';
    await expect(client.bootstrapSession({ token: 'invalid-token' })).rejects.toMatchObject({
      code: 16,
    });

    origin = 'https://attacker.example.com';
    host = '192.168.1.10:4317';
    await expect(client.bootstrapSession({ token: 'invalid-token' })).rejects.toMatchObject({
      code: 7,
    });

    origin = 'http://192.168.1.10:4317';
    host = '192.168.1.10:4317';
    const session = service.createLocalSession();
    const bootstrapped = await client.bootstrapSession({ token: session.token });
    expect(bootstrapped.identity?.userId).toBe(service.ensureLocalIdentity().userId);
  } finally {
    database.close();
  }
});

it('treats requests as the local identity without a session when authentication is disabled', async () => {
  const { database, service } = fixture();
  try {
    const csrf = 'test-csrf-token';
    const router = createRouterTransport(
      (connectRouter) => {
        registerAuthRoutes(connectRouter, {
          authService: service,
          allowedOrigin: null,
          secureCookies: false,
          disabled: true,
        });
      },
      {
        transport: {
          interceptors: [
            (next) => async (request) => {
              request.header.set('origin', 'http://127.0.0.1:4317');
              request.header.set('cookie', `kairos_csrf=${csrf}`);
              request.header.set('x-csrf-token', csrf);
              return next(request);
            },
          ],
        },
      },
    );
    const client = createClient(AuthService, router);

    const current = await client.getCurrentIdentity({});
    expect(current.state).toBe(AuthenticationState.AUTHENTICATED);
    expect(current.identity?.userId).toBe(service.ensureLocalIdentity().userId);

    const bootstrapped = await client.bootstrapSession({ token: 'any-token' });
    expect(bootstrapped.identity?.userId).toBe(service.ensureLocalIdentity().userId);

    await client.logout({});
  } finally {
    database.close();
  }
});

it('serves bootstrap, current identity and logout over Connect with cookies', async () => {
  const { database, service } = fixture();
  try {
    const csrf = 'test-csrf-token';
    const router = createRouterTransport(
      (connectRouter) => {
        registerAuthRoutes(connectRouter, {
          authService: service,
          allowedOrigin: 'http://127.0.0.1:4317',
          secureCookies: false,
        });
      },
      {
        transport: {
          interceptors: [
            (next) => async (request) => {
              request.header.set('origin', 'http://127.0.0.1:4317');
              request.header.set('cookie', `kairos_csrf=${csrf}`);
              request.header.set('x-csrf-token', csrf);
              return next(request);
            },
          ],
        },
      },
    );
    const client = createClient(AuthService, router);
    const anonymous = await client.getCurrentIdentity({});
    expect(anonymous.state).toBe(AuthenticationState.ANONYMOUS);

    const session = service.createLocalSession();
    const bootstrapped = await client.bootstrapSession({ token: session.token });
    expect(bootstrapped.identity?.userId).toBe(service.ensureLocalIdentity().userId);

    await expect(client.bootstrapSession({ token: 'invalid-token' })).rejects.toMatchObject({
      code: 16,
    });
  } finally {
    database.close();
  }
});
