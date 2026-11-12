import { describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { AuthService, LOCAL_TEST_CODE, LOCAL_TEST_EMAIL } from './service.js';
import { AuthStore } from './store.js';

function fixture() {
  const database = openDatabase(':memory:');
  const sessions = new SessionStore(database);
  const createMainThread = vi.fn((tenantId: string) => sessions.getOrCreateMainThread(tenantId));
  const service = new AuthService(new AuthStore(database), {
    secret: 'one-use-setup-authentication-secret-at-least-32-characters',
    invitedEmails: [],
    testAccountEnabled: true,
    createMainThread,
  });
  const setup = async () => {
    const requested = await service.requestEmailCode({
      email: LOCAL_TEST_EMAIL,
      clientActionId: 'setup-request',
      sourceAddress: '127.0.0.1',
    });
    const verified = service.verifyEmailCode({
      email: LOCAL_TEST_EMAIL,
      verificationId: requested.verificationId,
      code: LOCAL_TEST_CODE,
    });
    if (verified.kind !== 'profile_required') throw new Error('A setup credential is required.');
    return verified.credential.token;
  };
  return { database, createMainThread, service, setup };
}

describe('profile setup credential consumption', () => {
  it('prevents a consumed setup credential from issuing another session after logout', async () => {
    const { database, service, setup } = fixture();
    try {
      const token = await setup();
      const completed = service.completeProfile(token, '测试用户');
      service.revokeSession(completed.token);
      expect(() => service.completeProfile(token, '再次登录')).toThrow(
        expect.objectContaining({ code: 'unauthenticated' }),
      );
      expect(service.currentIdentity(undefined, token)).toEqual({ state: 'anonymous' });
      expect(database.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get()).toEqual({
        count: 1,
      });
    } finally {
      database.close();
    }
  });

  it('preserves the setup credential when profile creation rolls back', async () => {
    const { database, createMainThread, service, setup } = fixture();
    try {
      const token = await setup();
      createMainThread.mockImplementationOnce(() => {
        throw new Error('Injected main Thread failure.');
      });
      expect(() => service.completeProfile(token, '测试用户')).toThrow(
        'Injected main Thread failure.',
      );
      expect(database.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 0 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get()).toEqual({
        count: 0,
      });
      expect(service.currentIdentity(undefined, token)).toEqual({ state: 'profile_required' });
      const completed = service.completeProfile(token, '测试用户');
      expect(service.requireIdentity(completed.token).username).toBe('测试用户');
      expect(service.currentIdentity(undefined, token)).toEqual({ state: 'anonymous' });
    } finally {
      database.close();
    }
  });
});
