import { useState } from 'react';
import { formatDateTime } from './time-format.js';
import type { AuthView } from './use-auth.js';

export function LoginScreen({ auth }: { auth: AuthView }) {
  const [email, setEmail] = useState(auth.state.email);
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const { state } = auth;
  const busy = state.busy !== null;

  if (state.step === 'loading') {
    return (
      <main className="login-screen">
        <section aria-busy={state.busy === 'restore'}>
          <p className="eyebrow">KAIROS</p>
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
        <p className="eyebrow">KAIROS · 个人工作空间</p>
        <h1>
          {state.step === 'profile'
            ? '设置用户名'
            : state.step === 'code'
              ? '输入邮箱验证码'
              : '登录个人 Agent'}
        </h1>
        {state.step === 'email' && (
          <>
            <p>使用受邀邮箱接收一次性验证码。登录不会在浏览器存储中保存会话凭据。</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void auth.requestEmailCode(email);
              }}
            >
              <label htmlFor="login-email">邮箱</label>
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                required
                disabled={busy}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <button type="submit" className="primary" disabled={busy || !email.trim()}>
                {state.busy === 'request-code'
                  ? '正在请求验证码'
                  : state.error
                    ? '沿用原请求编号重试'
                    : '发送验证码'}
              </button>
            </form>
          </>
        )}
        {state.step === 'code' && (
          <>
            <p>
              验证码已请求发送至 <strong>{state.email}</strong>。
              {state.verificationExpiresAt
                ? ` 本次验证记录有效期至 ${formatDateTime(new Date(state.verificationExpiresAt))}。`
                : ''}
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void auth.verifyEmailCode(code);
              }}
            >
              <label htmlFor="login-code">6 位验证码</label>
              <input
                id="login-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                disabled={busy}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <button type="submit" className="primary" disabled={busy || code.length !== 6}>
                {state.busy === 'verify-code'
                  ? '正在验证'
                  : state.error
                    ? '重试验证'
                    : '验证并登录'}
              </button>
              <button type="button" disabled={busy} onClick={auth.restartEmail}>
                更换邮箱或重新获取验证码
              </button>
            </form>
          </>
        )}
        {state.step === 'profile' && (
          <>
            <p>首次登录需要设置用户名。提交后将创建个人租户，不会创建执行环境。</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void auth.completeProfile(username);
              }}
            >
              <label htmlFor="login-username">用户名</label>
              <input
                id="login-username"
                autoComplete="nickname"
                maxLength={80}
                required
                disabled={busy}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
              <button type="submit" className="primary" disabled={busy || !username.trim()}>
                {state.busy === 'profile'
                  ? '正在保存资料'
                  : state.error
                    ? '重试保存资料'
                    : '保存并进入工作台'}
              </button>
            </form>
          </>
        )}
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
