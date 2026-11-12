/// <reference lib="dom" />

import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import {
  AuthenticationState,
  AuthService,
  create,
  IdentitySchema,
  InputMode,
} from '@kairos/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.js';
import { createKairosClients, readBrowserCookie } from './client.js';

const identity = create(IdentitySchema, {
  userId: 'user-1',
  tenantId: 'tenant-1',
  email: 'test@kairos.com',
  username: '测试用户',
  mainThreadId: 'main-1',
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthController login lifecycle', () => {
  it('requests and verifies a code, completes a profile, restores identity and logs out', async () => {
    const requestIds: string[] = [];
    let failRequest = true;
    let failProfile = true;
    let currentState = AuthenticationState.ANONYMOUS;
    let logoutCalls = 0;
    const transport = createRouterTransport((router) => {
      router.service(AuthService, {
        getCurrentIdentity() {
          return currentState === AuthenticationState.AUTHENTICATED
            ? { state: currentState, identity }
            : { state: currentState };
        },
        requestEmailCode(request) {
          requestIds.push(request.clientActionId);
          if (failRequest) throw new ConnectError('response lost', Code.Unavailable);
          return {
            verificationId: 'verification-1',
            expiresAt: { seconds: 1_800_000_000n, nanos: 0 },
          };
        },
        verifyEmailCode(request) {
          expect(request.verificationId).toBe('verification-1');
          if (request.code !== '945945') {
            throw new ConnectError('wrong code', Code.Unauthenticated);
          }
          currentState = AuthenticationState.PROFILE_REQUIRED;
          return { state: AuthenticationState.PROFILE_REQUIRED };
        },
        completeProfile(request) {
          expect(request.username).toBe('测试用户');
          if (failProfile) throw new ConnectError('try again', Code.InvalidArgument);
          currentState = AuthenticationState.AUTHENTICATED;
          return { identity };
        },
        logout() {
          logoutCalls += 1;
          currentState = AuthenticationState.ANONYMOUS;
          return {};
        },
      });
    });
    const controller = new AuthController({
      clients: createKairosClients({ transport }),
      createId: () => 'request-action-1',
    });

    await controller.restore();
    expect(controller.state.step).toBe('email');
    await controller.requestEmailCode(' test@kairos.com ');
    expect(controller.state.step).toBe('email');
    expect(controller.state.error).toContain('原操作编号');
    failRequest = false;
    await controller.requestEmailCode('test@kairos.com');
    expect(controller.state.step).toBe('code');
    expect(controller.state.verificationId).toBe('verification-1');
    expect(requestIds).toEqual(['request-action-1', 'request-action-1']);

    await controller.verifyEmailCode('123');
    expect(controller.state.error).toContain('6 位数字');
    await controller.verifyEmailCode('111111');
    expect(controller.state.step).toBe('code');
    expect(controller.state.error).toContain('验证码无效或已过期');
    await controller.verifyEmailCode('945945');
    expect(controller.state.step).toBe('profile');

    await controller.completeProfile(' 测试用户 ');
    expect(controller.state.step).toBe('profile');
    expect(controller.state.error).toContain('try again');
    failProfile = false;
    await controller.completeProfile('测试用户');
    expect(controller.state.step).toBe('authenticated');
    expect(controller.state.identity?.tenantId).toBe('tenant-1');

    await controller.restore();
    expect(controller.state.identity?.userId).toBe('user-1');
    await controller.logout();
    expect(logoutCalls).toBe(1);
    expect(controller.state.step).toBe('email');
    expect(controller.state.identity).toBeNull();
    expect(controller.state.verificationId).toBeNull();
    expect(controller.state.error).toBeNull();
  });

  it('offers restore retry and ignores the superseded StrictMode restore', async () => {
    let attempts = 0;
    const transport = createRouterTransport((router) => {
      router.service(AuthService, {
        getCurrentIdentity() {
          attempts += 1;
          if (attempts === 1) throw new ConnectError('offline', Code.Unavailable);
          return { state: AuthenticationState.AUTHENTICATED, identity };
        },
      });
    });
    const controller = new AuthController({ clients: createKairosClients({ transport }) });

    await controller.restore();
    expect(controller.state.step).toBe('loading');
    expect(controller.state.error).toContain('Server 暂时不可用');
    await controller.restore();
    expect(controller.state.step).toBe('authenticated');

    const first = controller.restore();
    controller.stop();
    const second = controller.restore();
    await Promise.all([first, second]);
    expect(controller.state.step).toBe('authenticated');
    expect(controller.state.busy).toBeNull();
    expect(attempts).toBe(4);
  });

  it('keeps local logout isolation when the Server result is unknown', async () => {
    const transport = createRouterTransport((router) => {
      router.service(AuthService, {
        getCurrentIdentity() {
          return { state: AuthenticationState.AUTHENTICATED, identity };
        },
        logout() {
          throw new ConnectError('response lost', Code.Unavailable);
        },
      });
    });
    const controller = new AuthController({ clients: createKairosClients({ transport }) });
    await controller.restore();
    await controller.logout();

    expect(controller.state.step).toBe('email');
    expect(controller.state.identity).toBeNull();
    expect(controller.state.logoutUnknown).toBe(true);
    expect(controller.state.error).toContain('当前页面已退出并停止旧账号操作');
  });

  it('clears the authenticated page state when a business session expires', async () => {
    const transport = createRouterTransport((router) => {
      router.service(AuthService, {
        getCurrentIdentity() {
          return { state: AuthenticationState.AUTHENTICATED, identity };
        },
      });
    });
    const controller = new AuthController({ clients: createKairosClients({ transport }) });
    await controller.restore();

    controller.expireSession();
    expect(controller.state.step).toBe('email');
    expect(controller.state.identity).toBeNull();
    expect(controller.state.verificationId).toBeNull();
    expect(controller.state.error).toContain('旧订阅和待提交操作已停止');
  });
});

describe('cookie, CSRF and session expiration transport', () => {
  it('uses credentials and CSRF without treating Auth code failures as session expiration', async () => {
    const requests: { csrf: string | null; credentials: RequestCredentials | undefined }[] = [];
    const expired = vi.fn();
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        csrf: new Headers(init?.headers).get('x-csrf-token'),
        credentials: init?.credentials,
      });
      return new Response(JSON.stringify({ code: 'unauthenticated', message: 'expired' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    const clients = createKairosClients({
      baseUrl: 'http://127.0.0.1:4317',
      fetch,
      getCsrfToken: () => 'csrf-test-token',
      onUnauthenticated: expired,
    });

    await expect(
      clients.messages.sendMessage({
        clientActionId: 'send-1',
        threadId: 'main-1',
        text: '消息',
        mode: InputMode.FOLLOW_UP,
      }),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(expired).toHaveBeenCalledTimes(1);

    await expect(
      clients.auth.verifyEmailCode({
        email: identity.email,
        verificationId: 'verification-1',
        code: '111111',
      }),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([
      { csrf: 'csrf-test-token', credentials: 'include' },
      { csrf: 'csrf-test-token', credentials: 'include' },
    ]);

    vi.stubGlobal('document', { cookie: 'other=value; kairos_csrf=csrf-from-cookie' });
    expect(readBrowserCookie('kairos_csrf')).toBe('csrf-from-cookie');
    expect(readBrowserCookie('kairos_session')).toBe('');
  });
});
