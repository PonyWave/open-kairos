import { Code, ConnectError } from '@connectrpc/connect';
import {
  AuthenticationState,
  type GetCurrentIdentityResponse,
  type Identity,
  normalizeEmail,
  type VerifyEmailCodeResponse,
} from '@kairos/contracts';
import type { KairosClients } from './client.js';
import { formatClientError } from './errors.js';

export type AuthStep = 'loading' | 'email' | 'code' | 'profile' | 'authenticated';
export type AuthOperation = 'restore' | 'request-code' | 'verify-code' | 'profile' | 'logout';

export interface AuthState {
  step: AuthStep;
  identity: Identity | null;
  email: string;
  verificationId: string | null;
  verificationExpiresAt: string | null;
  busy: AuthOperation | null;
  error: string | null;
  logoutUnknown: boolean;
}

const initialState: AuthState = {
  step: 'loading',
  identity: null,
  email: '',
  verificationId: null,
  verificationExpiresAt: null,
  busy: null,
  error: null,
  logoutUnknown: false,
};

interface AuthControllerOptions {
  clients: Pick<KairosClients, 'auth'>;
  createId?: () => string;
}

type AuthenticationResponse = GetCurrentIdentityResponse | VerifyEmailCodeResponse;

export class AuthController {
  private current: AuthState = initialState;
  private generation = 0;
  private listener: ((state: AuthState) => void) | undefined;
  private codeRequest: { email: string; actionId: string } | null = null;
  private readonly createId: () => string;

  constructor(private readonly options: AuthControllerOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  get state(): AuthState {
    return { ...this.current };
  }

  get authenticationGeneration(): number {
    return this.generation;
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listener = listener;
    listener(this.state);
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  async restore(): Promise<void> {
    if (this.current.busy && this.current.busy !== 'restore') return;
    const generation = ++this.generation;
    this.codeRequest = null;
    this.patch({ ...initialState, busy: 'restore' });
    try {
      const response = await this.options.clients.auth.getCurrentIdentity({});
      this.applyAuthentication(response, generation);
    } catch (cause) {
      if (generation !== this.generation) return;
      this.patch({ busy: null, error: formatClientError(cause) });
    }
  }

  async requestEmailCode(emailInput: string): Promise<void> {
    if (this.current.busy) return;
    let email: string;
    try {
      email = normalizeEmail(emailInput);
    } catch {
      this.patch({ error: '邮箱格式无效，请核对后重试。' });
      return;
    }
    const generation = ++this.generation;
    const actionId =
      this.codeRequest?.email === email ? this.codeRequest.actionId : this.createId();
    this.codeRequest = { email, actionId };
    this.patch({ busy: 'request-code', error: null, logoutUnknown: false, email });
    try {
      const response = await this.options.clients.auth.requestEmailCode({
        email,
        clientActionId: actionId,
      });
      if (!response.verificationId) throw new Error('Server 未返回邮箱验证记录编号。');
      const expiresAt = authenticationExpiry(response.expiresAt);
      if (generation !== this.generation) return;
      this.patch({
        step: 'code',
        email,
        verificationId: response.verificationId,
        verificationExpiresAt: expiresAt,
        busy: null,
        error: null,
      });
    } catch (cause) {
      if (generation !== this.generation) return;
      this.patch({ busy: null, error: formatClientError(cause) });
    }
  }

  restartEmail(): void {
    if (this.current.busy) return;
    ++this.generation;
    this.codeRequest = null;
    this.patch({
      step: 'email',
      identity: null,
      verificationId: null,
      verificationExpiresAt: null,
      error: null,
      logoutUnknown: false,
    });
  }

  async verifyEmailCode(code: string): Promise<void> {
    if (this.current.busy) return;
    const email = this.current.email;
    const verificationId = this.current.verificationId;
    if (!email || !verificationId) {
      this.patch({ error: '邮箱验证记录已失效，请重新获取验证码。' });
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      this.patch({ error: '验证码必须包含 6 位数字。' });
      return;
    }
    const generation = ++this.generation;
    this.patch({ busy: 'verify-code', error: null });
    try {
      const response = await this.options.clients.auth.verifyEmailCode({
        email,
        verificationId,
        code,
      });
      this.applyAuthentication(response, generation);
    } catch (cause) {
      if (generation !== this.generation) return;
      if (await this.recoverAuthentication(cause, generation)) return;
      if (generation !== this.generation) return;
      this.patch({
        busy: null,
        error:
          cause instanceof ConnectError && cause.code === Code.Unauthenticated
            ? '验证码无效或已过期，请核对后重试；必要时重新获取验证码。'
            : formatClientError(cause),
      });
    }
  }

  async completeProfile(username: string): Promise<void> {
    if (this.current.busy) return;
    const normalized = username.trim();
    if (!normalized || normalized.length > 80 || normalized.includes('\0')) {
      this.patch({ error: '用户名长度须为 1 至 80 个字符，且不能包含空字符。' });
      return;
    }
    const generation = ++this.generation;
    this.patch({ busy: 'profile', error: null });
    try {
      const response = await this.options.clients.auth.completeProfile({ username: normalized });
      const identity = readIdentity(response.identity);
      if (generation !== this.generation) return;
      this.codeRequest = null;
      this.patch({
        step: 'authenticated',
        identity,
        verificationId: null,
        verificationExpiresAt: null,
        busy: null,
        error: null,
      });
    } catch (cause) {
      if (generation !== this.generation) return;
      if (cause instanceof ConnectError && cause.code === Code.Unauthenticated) {
        this.codeRequest = null;
        this.patch({
          step: 'email',
          identity: null,
          email: '',
          verificationId: null,
          verificationExpiresAt: null,
          busy: null,
          error: '资料设置会话已失效，请重新验证邮箱。',
        });
        return;
      }
      if (await this.recoverAuthentication(cause, generation)) return;
      if (generation !== this.generation) return;
      this.patch({ busy: null, error: formatClientError(cause) });
    }
  }

  updateIdentity(identity: Identity): void {
    if (
      this.current.step !== 'authenticated' ||
      this.current.identity?.userId !== identity.userId ||
      this.current.identity.tenantId !== identity.tenantId
    )
      return;
    this.patch({ identity: readIdentity(identity) });
  }

  async logout(): Promise<void> {
    if (this.current.busy) return;
    const generation = ++this.generation;
    this.codeRequest = null;
    this.patch({
      ...initialState,
      step: 'email',
      busy: 'logout',
    });
    try {
      await this.options.clients.auth.logout({});
      if (generation !== this.generation) return;
      this.patch({ busy: null, error: null, logoutUnknown: false });
    } catch (cause) {
      if (generation !== this.generation) return;
      this.patch({
        busy: null,
        logoutUnknown: true,
        error: `当前页面已退出并停止旧账号操作，但 Server 退出结果未知。${formatClientError(cause)}`,
      });
    }
  }

  expireSession(authenticationGeneration?: number): void {
    if (
      (authenticationGeneration !== undefined && authenticationGeneration !== this.generation) ||
      this.current.step !== 'authenticated'
    ) {
      return;
    }
    ++this.generation;
    this.codeRequest = null;
    this.patch({
      ...initialState,
      step: 'email',
      error: '登录已失效。旧订阅和待提交操作已停止，请重新登录。',
    });
  }

  stop(): void {
    ++this.generation;
  }

  private applyAuthentication(response: AuthenticationResponse, generation: number): void {
    if (response.state === AuthenticationState.AUTHENTICATED) {
      const identity = readIdentity(response.identity);
      if (generation !== this.generation) return;
      this.codeRequest = null;
      this.patch({
        step: 'authenticated',
        identity,
        email: identity.email,
        verificationId: null,
        verificationExpiresAt: null,
        busy: null,
        error: null,
        logoutUnknown: false,
      });
      return;
    }
    if (response.state === AuthenticationState.PROFILE_REQUIRED) {
      if (generation !== this.generation) return;
      this.patch({
        step: 'profile',
        identity: null,
        verificationId: null,
        verificationExpiresAt: null,
        busy: null,
        error: null,
      });
      return;
    }
    if (response.state === AuthenticationState.ANONYMOUS) {
      if (response.$typeName !== 'kairos.gui.v1.GetCurrentIdentityResponse') {
        throw new Error('VerifyEmailCode 返回了匿名状态。');
      }
      if (generation !== this.generation) return;
      this.patch({
        ...initialState,
        step: this.current.step === 'loading' ? 'email' : this.current.step,
        email: this.current.email,
        busy: null,
      });
      return;
    }
    throw new Error('AuthService 返回了未知认证状态。');
  }

  private async recoverAuthentication(cause: unknown, generation: number): Promise<boolean> {
    if (
      !(cause instanceof ConnectError) ||
      (cause.code !== Code.Unavailable && cause.code !== Code.DeadlineExceeded)
    ) {
      return false;
    }
    try {
      const current = await this.options.clients.auth.getCurrentIdentity({});
      if (current.state === AuthenticationState.ANONYMOUS) return false;
      this.applyAuthentication(current, generation);
      return true;
    } catch {
      return false;
    }
  }

  private patch(patch: Partial<AuthState>): void {
    this.current = { ...this.current, ...patch };
    this.listener?.(this.state);
  }
}

function readIdentity(identity: Identity | undefined): Identity {
  if (
    identity?.$typeName !== 'kairos.gui.v1.Identity' ||
    !identity.userId ||
    !identity.email ||
    !identity.username ||
    identity.username.length > 80 ||
    !identity.tenantId ||
    !identity.mainThreadId
  ) {
    throw new Error('AuthService 返回了无效身份信息。');
  }
  return identity;
}

function authenticationExpiry(
  value: { seconds: bigint; nanos: number } | undefined,
): string | null {
  if (!value) return null;
  if (
    value.seconds < 0n ||
    value.seconds > BigInt(Number.MAX_SAFE_INTEGER) ||
    !Number.isInteger(value.nanos) ||
    value.nanos < 0 ||
    value.nanos > 999_999_999
  ) {
    throw new Error('AuthService 返回了无效验证码期限。');
  }
  const date = new Date(Number(value.seconds) * 1000 + value.nanos / 1_000_000);
  if (!Number.isFinite(date.getTime())) throw new Error('AuthService 返回了无效验证码期限。');
  return date.toISOString();
}
