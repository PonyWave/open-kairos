import { Code, ConnectError } from '@connectrpc/connect';
import {
  ChannelId,
  type ChannelLoginSession,
  ChannelLoginSessionSchema,
  ChannelLoginState,
  type ChannelState,
  create,
} from '@kairos/contracts';
import type { KairosClients } from './client.js';
import { randomId } from './random.js';

export type ChannelOperation = 'start' | 'pin' | 'cancel' | 'save' | 'unbind' | 'reconnect';
export interface ChannelSettingsState {
  states: readonly ChannelState[] | null;
  login: ChannelLoginSession | null;
  loading: boolean;
  loadError: string | null;
  busy: Readonly<Partial<Record<ChannelId, ChannelOperation>>>;
  errors: Readonly<Partial<Record<ChannelId, string>>>;
  feedback: Readonly<Partial<Record<ChannelId, string>>>;
}
export function channelError(error: unknown): string {
  if (error instanceof ConnectError) {
    if ([Code.Unavailable, Code.DeadlineExceeded, Code.Canceled, Code.Unknown].includes(error.code))
      return '暂时无法连接服务，请检查网络后重试；已提交的操作可先检查状态。';
    if (error.code === Code.Unauthenticated) return '登录已失效，请重新登录 Kairos。';
    return error.rawMessage;
  }
  return '操作未完成，请检查连接后重试。';
}

export class ChannelSettingsController {
  #state: ChannelSettingsState = {
    states: null,
    login: null,
    loading: true,
    loadError: null,
    busy: {},
    errors: {},
    feedback: {},
  };
  #listeners = new Set<() => void>();
  #lifecycle = new AbortController();
  #query: AbortController | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #revision = 0;
  #running = false;
  constructor(private readonly client: KairosClients['channels']) {}
  snapshot = (): ChannelSettingsState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#lifecycle = new AbortController();
    void this.refresh();
  }
  stop(): void {
    this.#running = false;
    this.#revision++;
    this.#lifecycle.abort();
    this.#query?.abort();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#state = { ...this.#state, busy: {} };
  }
  #patch(patch: Partial<ChannelSettingsState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#running) return;
    const pending =
      this.#state.login?.loginState === ChannelLoginState.PENDING ||
      this.#state.states?.some((s) => s.loginState === ChannelLoginState.PENDING);
    if (pending || this.#state.states?.some((s) => s.configured))
      this.#timer = setTimeout(
        () => {
          if (Object.keys(this.#state.busy).length) this.#schedule();
          else void this.refresh();
        },
        pending ? 2000 : 15000,
      );
  }
  async refresh(channel?: ChannelId): Promise<boolean> {
    if (!this.#running) return false;
    this.#query?.abort();
    const query = new AbortController();
    this.#query = query;
    const revision = this.#revision;
    this.#patch({ loading: this.#state.states === null || channel !== undefined });
    try {
      const response = await this.client.getChannelStates(
        {},
        { signal: AbortSignal.any([query.signal, this.#lifecycle.signal]) },
      );
      if (query.signal.aborted || !this.#running || revision !== this.#revision) return false;
      const errors = { ...this.#state.errors };
      if (channel !== undefined) delete errors[channel];
      this.#patch({
        ...(channel !== undefined ? { errors } : {}),
        states: response.states,
        login: response.wechatLogin ?? null,
        loadError: null,
        ...(channel
          ? { feedback: { ...this.#state.feedback, [channel]: '连接状态已更新。' } }
          : {}),
      });
      return true;
    } catch (error) {
      if (!query.signal.aborted && this.#running && revision === this.#revision)
        this.#patch({ loadError: channelError(error) });
      return false;
    } finally {
      if (this.#query === query) {
        this.#patch({ loading: false });
        this.#schedule();
      }
    }
  }
  #upsert(state: ChannelState | undefined): void {
    if (!state) throw new Error('Channel response missing state');
    this.#patch({
      states: [...(this.#state.states ?? []).filter((s) => s.channel !== state.channel), state],
    });
  }
  async #run<T>(
    channel: ChannelId,
    operation: ChannelOperation,
    work: (signal: AbortSignal) => Promise<T>,
    apply: (result: T) => void,
  ): Promise<boolean> {
    if (this.#state.busy[channel] || !this.#running) return false;
    this.#revision++;
    this.#query?.abort();
    const lifecycle = this.#lifecycle;
    const errors = { ...this.#state.errors };
    delete errors[channel];
    const feedback = { ...this.#state.feedback };
    delete feedback[channel];
    this.#patch({ busy: { ...this.#state.busy, [channel]: operation }, errors, feedback });
    let saved = false;
    try {
      const result = await work(lifecycle.signal);
      if (!this.#running || lifecycle.signal.aborted) return false;
      apply(result);
      saved = true;
    } catch (error) {
      if (!lifecycle.signal.aborted)
        this.#patch({ errors: { ...this.#state.errors, [channel]: channelError(error) } });
    } finally {
      if (!lifecycle.signal.aborted) {
        this.#revision++;
        const busy = { ...this.#state.busy };
        delete busy[channel];
        this.#patch({ busy });
        await this.refresh();
      }
    }
    return saved;
  }
  startWechat(): Promise<boolean> {
    return this.#run(
      ChannelId.WECHAT,
      'start',
      (signal) =>
        this.client.startChannelLogin(
          { channel: ChannelId.WECHAT, clientActionId: randomId() },
          { signal },
        ),
      (result) => {
        this.#upsert(result.state);
        this.#patch({
          login: create(ChannelLoginSessionSchema, {
            loginSessionId: result.loginSessionId,
            qrContent: result.qrContent,
            loginState: ChannelLoginState.PENDING,
          }),
        });
      },
    );
  }
  submitPin(pin: string): Promise<boolean> {
    const login = this.#state.login;
    if (!login) return Promise.resolve(false);
    return this.#run(
      ChannelId.WECHAT,
      'pin',
      (signal) =>
        this.client.submitChannelLoginPin(
          { loginSessionId: login.loginSessionId, pin },
          { signal },
        ),
      (result) => {
        this.#patch({
          login: create(ChannelLoginSessionSchema, {
            loginSessionId: login.loginSessionId,
            qrContent: result.qrContent,
            loginState: result.loginState,
            statusReason: result.statusReason,
            awaitingPin: result.awaitingPin,
            pollingFailed: result.pollingFailed,
          }),
        });
      },
    );
  }
  cancelLogin(): Promise<boolean> {
    const login = this.#state.login;
    if (!login) return Promise.resolve(false);
    return this.#run(
      ChannelId.WECHAT,
      'cancel',
      (signal) =>
        this.client.cancelChannelLogin({ loginSessionId: login.loginSessionId }, { signal }),
      () => this.#patch({ login: null }),
    );
  }
  saveFeishu(appId: string, appSecret: string, preserveSecret: boolean): Promise<boolean> {
    return this.#run(
      ChannelId.FEISHU,
      'save',
      (signal) =>
        this.client.saveFeishuCredentials(
          { clientActionId: randomId(), appId, appSecret, preserveSecret },
          { signal },
        ),
      (result) => this.#upsert(result.state),
    );
  }
  unbind(channel: ChannelId): Promise<boolean> {
    return this.#run(
      channel,
      'unbind',
      (signal) => this.client.unbindChannel({ clientActionId: randomId(), channel }, { signal }),
      (result) => {
        this.#upsert(result.state);
        if (channel === ChannelId.WECHAT) this.#patch({ login: null });
      },
    );
  }
  reconnectFeishu(): Promise<boolean> {
    return this.#run(
      ChannelId.FEISHU,
      'reconnect',
      (signal) =>
        this.client.reconnectChannel(
          { clientActionId: randomId(), channel: ChannelId.FEISHU },
          { signal },
        ),
      (result) => {
        this.#upsert(result.state);
        this.#patch({
          feedback: {
            ...this.#state.feedback,
            [ChannelId.FEISHU]: '已请求重新连接，将自动更新状态。',
          },
        });
      },
    );
  }
}
