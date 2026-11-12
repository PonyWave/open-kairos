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
    bootstrap: vi.fn(async (_token: string) => {}),
    logout: vi.fn(async () => {}),
    expireSession: vi.fn(),
  };
}

describe('LoginScreen', () => {
  it('renders the token form with retry and error states', () => {
    const markup = renderToStaticMarkup(
      createElement(LoginScreen, {
        auth: authView('token', { error: 'Server 暂时不可用。' }),
      }),
    );

    expect(markup).toContain('本地会话令牌');
    expect(markup).toContain('重试登录');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('kairos start');
  });

  it('provides restore failure states', () => {
    const restore = renderToStaticMarkup(
      createElement(LoginScreen, {
        auth: authView('loading', { error: '连接失败' }),
      }),
    );

    expect(restore).toContain('重新核对当前身份');
    expect(restore).toContain('连接失败');
  });
});
