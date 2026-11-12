import { expect, it, vi } from 'vitest';
import type { AuthError } from '../auth/errors.js';
import type { EmailMessage } from '../auth/mailer.js';
import { AuthService, LOCAL_TEST_EMAIL } from '../auth/service.js';
import { AuthStore } from '../auth/store.js';
import { readServerConfig } from '../config.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';

function authenticationFixture(options: {
  sourceLimit?: number;
  globalLimit?: number;
  send: (message: EmailMessage) => Promise<void>;
}) {
  const database = openDatabase(':memory:');
  const sessions = new SessionStore(database);
  const now = new Date();
  const service = new AuthService(new AuthStore(database), {
    secret: 'mail-test-authentication-secret-at-least-32-characters',
    invitedEmails: ['first@example.com', 'second@example.com', 'third@example.com'],
    testAccountEnabled: false,
    createMainThread: (tenantId) => sessions.getOrCreateMainThread(tenantId),
    mailer: { send: options.send },
    now: () => now,
    resendIntervalMs: 60_000,
    sourceLimit: options.sourceLimit ?? 100,
    globalLimit: options.globalLimit ?? 100,
  });
  return {
    database,
    service,
    advance(milliseconds: number) {
      now.setTime(now.getTime() + milliseconds);
    },
  };
}

it('deduplicates concurrent mail delivery and records failures without retrying the same action', async () => {
  let release = () => {};
  let blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = false;
  const sent: EmailMessage[] = [];
  const current = authenticationFixture({
    async send(message) {
      sent.push(message);
      if (fail) throw new Error('SMTP unavailable');
      await blocked;
    },
  });
  try {
    const input = {
      email: 'first@example.com',
      clientActionId: 'delivery-1',
      sourceAddress: '127.0.0.1',
    };
    const first = current.service.requestEmailCode(input);
    const duplicate = current.service.requestEmailCode(input);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    release();
    await expect(first).resolves.toEqual(await duplicate);
    await expect(current.service.requestEmailCode(input)).resolves.toEqual(await first);
    expect(sent).toHaveLength(1);
    const verificationId = (await first).verificationId;
    expect(
      current.database
        .prepare(
          'SELECT delivery_status, code_hash FROM auth_email_verifications WHERE verification_id = ?',
        )
        .get(verificationId),
    ).toMatchObject({ delivery_status: 'sent' });
    expect(sent[0]?.text).toMatch(/\d{6}/);

    fail = true;
    blocked = Promise.resolve();
    current.advance(61_000);
    const failedInput = { ...input, clientActionId: 'delivery-2' };
    await expect(current.service.requestEmailCode(failedInput)).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(current.service.requestEmailCode(failedInput)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(sent).toHaveLength(2);
    expect(
      current.database
        .prepare(
          "SELECT delivery_status, delivery_error FROM auth_email_verifications WHERE client_action_id = 'delivery-2'",
        )
        .get(),
    ).toEqual({ delivery_status: 'failed', delivery_error: 'Email delivery failed.' });
    expect(
      current.database
        .prepare('SELECT invalidated_at FROM auth_email_verifications WHERE verification_id = ?')
        .get(verificationId),
    ).not.toEqual({ invalidated_at: null });
  } finally {
    current.database.close();
  }
});

it('limits requests by source address and total mail delivery', async () => {
  const current = authenticationFixture({
    sourceLimit: 2,
    globalLimit: 2,
    send: async () => {},
  });
  try {
    await current.service.requestEmailCode({
      email: 'first@example.com',
      clientActionId: 'source-1',
      sourceAddress: '192.0.2.1',
    });
    await current.service.requestEmailCode({
      email: 'second@example.com',
      clientActionId: 'source-2',
      sourceAddress: '192.0.2.1',
    });
    await expect(
      current.service.requestEmailCode({
        email: 'third@example.com',
        clientActionId: 'source-3',
        sourceAddress: '192.0.2.1',
      }),
    ).rejects.toMatchObject({ code: 'resource_exhausted' });
    await expect(
      current.service.requestEmailCode({
        email: 'third@example.com',
        clientActionId: 'global-3',
        sourceAddress: '192.0.2.2',
      }),
    ).rejects.toMatchObject({ code: 'resource_exhausted' });
    await expect(
      current.service.requestEmailCode({
        email: LOCAL_TEST_EMAIL,
        clientActionId: 'test-disabled',
        sourceAddress: '127.0.0.1',
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<AuthError>>({ code: 'permission_denied' }));
  } finally {
    current.database.close();
  }
});

it('requires production SMTP, invitations and HTTPS while limiting the fixed account to loopback development', () => {
  const base = {
    KAIROS_DATA_DIR: '/tmp/kairos-auth-config',
    KAIROS_AUTH_SECRET: 'production-authentication-secret-at-least-32-characters',
  };
  expect(() =>
    readServerConfig({
      ...base,
      NODE_ENV: 'production',
      KAIROS_PUBLIC_ORIGIN: 'https://kairos.example.com',
    }),
  ).toThrow(/SMTP configuration and an invited email range/);
  const production = readServerConfig({
    ...base,
    NODE_ENV: 'production',
    KAIROS_PUBLIC_ORIGIN: 'https://kairos.example.com',
    KAIROS_AUTH_INVITED_EMAILS: '*',
    KAIROS_SMTP_URL: 'smtps://user:password@smtp.example.com:465',
    KAIROS_SMTP_FROM: 'login@example.com',
  });
  expect(production.auth.invitedEmails).toEqual(['*']);
  expect(production.auth.testAccountEnabled).toBe(false);
  expect(production.auth.secureCookies).toBe(true);
  expect(() =>
    readServerConfig({
      ...base,
      KAIROS_AUTH_SECRET: undefined,
      NODE_ENV: 'production',
      KAIROS_PUBLIC_ORIGIN: 'https://kairos.example.com',
      KAIROS_AUTH_INVITED_EMAILS: '*',
      KAIROS_SMTP_URL: 'smtps://user:password@smtp.example.com:465',
      KAIROS_SMTP_FROM: 'login@example.com',
    }),
  ).toThrow(/KAIROS_AUTH_SECRET/);
  expect(() =>
    readServerConfig({
      ...base,
      NODE_ENV: 'production',
      KAIROS_PUBLIC_ORIGIN: 'https://kairos.example.com',
      KAIROS_AUTH_INVITED_EMAILS: '*',
    }),
  ).toThrow(/SMTP configuration and an invited email range/);
  expect(
    readServerConfig({ ...base, NODE_ENV: 'development', KAIROS_HOST: '127.0.0.1' }).auth
      .testAccountEnabled,
  ).toBe(true);
  expect(
    readServerConfig({ ...base, NODE_ENV: 'development', KAIROS_HOST: '0.0.0.0' }).auth
      .testAccountEnabled,
  ).toBe(false);
  expect(() =>
    readServerConfig({
      ...base,
      NODE_ENV: 'production',
      KAIROS_PUBLIC_ORIGIN: 'http://kairos.example.com',
      KAIROS_AUTH_INVITED_EMAILS: 'person@example.com',
      KAIROS_SMTP_URL: 'smtps://user:password@smtp.example.com:465',
      KAIROS_SMTP_FROM: 'login@example.com',
    }),
  ).toThrow(/HTTP\(S\) origin/);
});

it('accepts a standalone invitation wildcard and preserves ordinary invitation parsing', () => {
  expect(readServerConfig({ KAIROS_AUTH_INVITED_EMAILS: ' * ' }).auth.invitedEmails).toEqual(['*']);
  expect(
    readServerConfig({
      KAIROS_AUTH_INVITED_EMAILS: ' First@Example.com,second@example.com,first@example.com ',
    }).auth.invitedEmails,
  ).toEqual(['first@example.com', 'second@example.com']);
  expect(readServerConfig({}).auth.invitedEmails).toEqual([]);
  expect(readServerConfig({ KAIROS_AUTH_INVITED_EMAILS: '' }).auth.invitedEmails).toEqual([]);
});

it.each([
  '*,person@example.com',
  'person@example.com,*',
  '*,*',
  'person@example.com,',
  ',person@example.com',
  'person@example.com,,second@example.com',
  ',',
  '*@example.com',
  'person*@example.com',
  '**',
])('rejects invalid invitation range %s', (value) => {
  expect(() => readServerConfig({ KAIROS_AUTH_INVITED_EMAILS: value })).toThrow(
    /KAIROS_AUTH_INVITED_EMAILS/,
  );
});

it('enforces code expiry, attempt limits and short-lived profile credentials', async () => {
  const database = openDatabase(':memory:');
  const sessions = new SessionStore(database);
  const now = new Date();
  const service = new AuthService(new AuthStore(database), {
    secret: 'expiry-test-authentication-secret-at-least-32-characters',
    invitedEmails: [],
    testAccountEnabled: true,
    createMainThread: (tenantId) => sessions.getOrCreateMainThread(tenantId),
    now: () => now,
    verificationTtlMs: 1000,
    setupTtlMs: 1000,
    maxCodeAttempts: 2,
    resendIntervalMs: 0,
  });
  try {
    const request = (clientActionId: string) =>
      service.requestEmailCode({
        email: LOCAL_TEST_EMAIL,
        clientActionId,
        sourceAddress: '127.0.0.1',
      });
    const first = await request('attempt-limit');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() =>
        service.verifyEmailCode({
          email: LOCAL_TEST_EMAIL,
          verificationId: first.verificationId,
          code: '111111',
        }),
      ).toThrow(expect.objectContaining({ code: 'unauthenticated' }));
    }
    expect(
      database
        .prepare('SELECT attempts FROM auth_email_verifications WHERE verification_id = ?')
        .get(first.verificationId),
    ).toEqual({ attempts: 2 });
    expect(() =>
      service.verifyEmailCode({
        email: LOCAL_TEST_EMAIL,
        verificationId: first.verificationId,
        code: '945945',
      }),
    ).toThrow(expect.objectContaining({ code: 'unauthenticated' }));

    const expired = await request('expired-code');
    now.setTime(now.getTime() + 1001);
    expect(() =>
      service.verifyEmailCode({
        email: LOCAL_TEST_EMAIL,
        verificationId: expired.verificationId,
        code: '945945',
      }),
    ).toThrow(expect.objectContaining({ code: 'unauthenticated' }));

    const profile = await request('profile-expiry');
    const verified = service.verifyEmailCode({
      email: LOCAL_TEST_EMAIL,
      verificationId: profile.verificationId,
      code: '945945',
    });
    if (verified.kind !== 'profile_required') throw new Error('Profile setup was required.');
    now.setTime(now.getTime() + 1001);
    expect(() => service.completeProfile(verified.credential.token, '过期用户')).toThrow(
      expect.objectContaining({ code: 'unauthenticated' }),
    );
    expect(database.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 0 });
  } finally {
    database.close();
  }
});

it('rejects previously issued local test credentials after the test account is disabled', async () => {
  const database = openDatabase(':memory:');
  const sessions = new SessionStore(database);
  const store = new AuthStore(database);
  const now = new Date();
  const options = {
    secret: 'transition-test-authentication-secret-at-least-32-characters',
    invitedEmails: [LOCAL_TEST_EMAIL],
    createMainThread: (tenantId: string) => sessions.getOrCreateMainThread(tenantId),
    now: () => now,
    resendIntervalMs: 0,
  };
  const local = new AuthService(store, { ...options, testAccountEnabled: true });
  const disabled = new AuthService(store, { ...options, testAccountEnabled: false });
  try {
    const requested = await local.requestEmailCode({
      email: LOCAL_TEST_EMAIL,
      clientActionId: 'local-before-production',
      sourceAddress: '127.0.0.1',
    });
    expect(() =>
      disabled.verifyEmailCode({
        email: LOCAL_TEST_EMAIL,
        verificationId: requested.verificationId,
        code: '945945',
      }),
    ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
    const verified = local.verifyEmailCode({
      email: LOCAL_TEST_EMAIL,
      verificationId: requested.verificationId,
      code: '945945',
    });
    if (verified.kind !== 'profile_required') throw new Error('Profile setup was required.');
    expect(() => disabled.completeProfile(verified.credential.token, '测试用户')).toThrow(
      expect.objectContaining({ code: 'permission_denied' }),
    );
    const completed = local.completeProfile(verified.credential.token, '测试用户');
    expect(() => disabled.requireIdentity(completed.token)).toThrow(
      expect.objectContaining({ code: 'permission_denied' }),
    );
    expect(disabled.currentIdentity(completed.token, undefined).state).toBe('anonymous');
  } finally {
    database.close();
  }
});
