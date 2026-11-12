import { useState } from 'react';
import type { AuthView } from './use-auth.js';

export function LoginScreen({ auth }: { auth: AuthView }) {
  const [token, setToken] = useState('');
  const { state } = auth;
  const busy = state.busy !== null;

  if (state.step === 'loading') {
    return (
      <main className="login-screen">
        <section aria-busy={state.busy === 'restore'}>
          <p className="eyebrow">OPEN-KAIROS</p>
          <h1>正在恢复登录状态</h1>
          {state.busy === 'restore' && <p role="status">正在向 Server 核对当前身份。</p>}
          {state.error && (
            <div className="error-text" role="alert">
              <p>{state.error}</p>
              <button type="button" onClick={() => void auth.restore()}>
                重新核对当前身份
              </button>
            </div>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="login-screen">
      <section aria-busy={busy}>
        <p className="eyebrow">OPEN-KAIROS · 个人工作空间</p>
        <h1>登录本地 Agent</h1>
        <p>
          使用 <code>kairos start</code> 启动命令打印的本地会话令牌登录。令牌只保存在 Server
          数据目录与本机浏览器会话中。
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void auth.bootstrap(token);
          }}
        >
          <label htmlFor="login-token">本地会话令牌</label>
          <input
            id="login-token"
            type="password"
            autoComplete="off"
            required
            disabled={busy}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <button type="submit" className="primary" disabled={busy || !token.trim()}>
            {state.busy === 'bootstrap' ? '正在登录' : state.error ? '重试登录' : '登录'}
          </button>
        </form>
        {state.busy === 'logout' && <p role="status">正在撤销 Server 会话。</p>}
        {state.error && (
          <div className="error-text auth-error" role="alert">
            <p>{state.error}</p>
            {state.logoutUnknown && (
              <button type="button" disabled={busy} onClick={() => void auth.logout()}>
                重试退出登录
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
