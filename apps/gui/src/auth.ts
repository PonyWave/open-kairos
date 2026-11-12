import { AuthenticationState, type Identity } from '@kairos/contracts';
import type { KairosClients } from './client.js';
import { formatClientError } from './errors.js';

export type AuthStep = 'loading' | 'token' | 'authenticated';
export type AuthOperation = 'restore' | 'bootstrap' | 'logout';

export interface AuthState {
  step: AuthStep;
  identity: Identity | null;
  busy: AuthOperation | null;
  error: string | null;
  logoutUnknown: boolean;
}

const initialState: AuthState = {
  step: 'loading',
  identity: null,
  busy: null,
  error: null,
  logoutUnknown: false,
};

interface AuthControllerOptions {
  clients: Pick<KairosClients, 'auth'>;
  readFragmentToken?: () => string | null;
  clearFragmentToken?: () => void;
}

function defaultReadFragmentToken(): string | null {
  if (typeof window === 'undefined') return null;
  const match = /^#token=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  return match?.[1] ?? null;
}

function defaultClearFragmentToken(): void {
  if (typeof window === 'undefined') return;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

export class AuthController {
  private current: AuthState = initialState;
  private generation = 0;
  private listener: ((state: AuthState) => void) | undefined;
  private readonly readFragmentToken: () => string | null;
  private readonly clearFragmentToken: () => void;

  constructor(private readonly options: AuthControllerOptions) {
    this.readFragmentToken = options.readFragmentToken ?? defaultReadFragmentToken;
    this.clearFragmentToken = options.clearFragmentToken ?? defaultClearFragmentToken;
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
    this.patch({ ...initialState, busy: 'restore' });
    try {
      const response = await this.options.clients.auth.getCurrentIdentity({});
      if (response.state === AuthenticationState.AUTHENTICATED) {
        this.applyIdentity(response.identity, generation);
        return;
      }
      const fragmentToken = this.readFragmentToken();
      if (fragmentToken) {
        await this.bootstrap(fragmentToken, generation);
        return;
      }
      if (generation !== this.generation) return;
      this.patch({ step: 'token', busy: null });
    } catch (cause) {
      if (generation !== this.generation) return;
      this.patch({ busy: null, error: formatClientError(cause) });
    }
  }

  async bootstrap(token: string, generation = ++this.generation): Promise<void> {
    if (this.current.busy && this.current.busy !== 'restore') return;
    const trimmed = token.trim();
    if (!trimmed) {
      this.patch({ step: 'token', error: '请输入启动命令打印的本地会话令牌。' });
      return;
    }
    this.patch({ busy: 'bootstrap', error: null });
    try {
      const response = await this.options.clients.auth.bootstrapSession({ token: trimmed });
      this.clearFragmentToken();
      this.applyIdentity(response.identity, generation);
    } catch (cause) {
      if (generation !== this.generation) return;
      this.patch({ step: 'token', busy: null, error: formatClientError(cause) });
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
    this.patch({
      ...initialState,
      step: 'token',
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
    this.patch({
      ...initialState,
      step: 'token',
      error: '登录已失效。旧订阅和待提交操作已停止，请重新登录。',
    });
  }

  stop(): void {
    ++this.generation;
  }

  private applyIdentity(identity: Identity | undefined, generation: number): void {
    const parsed = readIdentity(identity);
    if (generation !== this.generation) return;
    this.patch({
      step: 'authenticated',
      identity: parsed,
      busy: null,
      error: null,
      logoutUnknown: false,
    });
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
