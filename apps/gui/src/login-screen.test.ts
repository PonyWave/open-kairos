import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AuthState } from './auth.js';
import { LoginScreen } from './login-screen.js';
import type { AuthView } from './use-auth.js';

function authView(step: AuthState['step'], overrides: Partial<AuthState> = {}): AuthView {
  const state: AuthState = {
    step,
    identity: null,
    email: step === 'code' ? 'test@kairos.com' : '',
    verificationId: step === 'code' ? 'verification-private-id' : null,
    verificationExpiresAt: null,
    busy: null,
    error: null,
    logoutUnknown: false,
    ...overrides,
  };
  return {
    state,
    updateIdentity: vi.fn(),
    authenticationGeneration: 0,
    restore: vi.fn(async () => {}),
    requestEmailCode: vi.fn(async (_email: string) => {}),
    verifyEmailCode: vi.fn(async (_code: string) => {}),
    completeProfile: vi.fn(async (_username: string) => {}),
    restartEmail: vi.fn(),
    logout: vi.fn(async () => {}),
    expireSession: vi.fn(),
  };
}

describe('LoginScreen', () => {
  it('renders verification retry without exposing the verification record id', () => {
    const markup = renderToStaticMarkup(
      createElement(LoginScreen, {
        auth: authView('code', { error: 'Server 暂时不可用。' }),
      }),
    );

    expect(markup).toContain('重试验证');
    expect(markup).toContain('更换邮箱或重新获取验证码');
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain('verification-private-id');
  });

  it('provides first-profile completion and restore failure states', () => {
    const profile = renderToStaticMarkup(createElement(LoginScreen, { auth: authView('profile') }));
    const restore = renderToStaticMarkup(
      createElement(LoginScreen, {
        auth: authView('loading', { error: '连接失败' }),
      }),
    );

    expect(profile).toContain('设置用户名');
    expect(profile).toContain('创建个人租户');
    expect(profile).toContain('不会创建执行环境');
    expect(profile).not.toContain('945945');
    expect(restore).toContain('重新核对当前身份');
    expect(restore).toContain('连接失败');
  });
});
