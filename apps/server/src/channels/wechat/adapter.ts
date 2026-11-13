import { randomUUID } from 'node:crypto';
import type { OutboundChannel } from '../delivery-worker.js';
import { renderWechatSegments } from '../render-wechat.js';
import type { ChannelStore } from '../store.js';
import { ChannelDeliveryError } from '../store.js';
import { inboundMessageText, WechatClient, type WechatClientApi } from './client.js';

export interface InboundChannelMessage {
  channel: 'wechat' | 'feishu';
  externalMessageId: string;
  externalUserId: string;
  text: string;
}

export type InboundHandler = (message: InboundChannelMessage) => void;

export interface WechatLoginSession {
  id: string;
  status: 'pending' | 'confirmed' | 'failed';
  reason: string;
  awaitingPin: boolean;
}

const pinWaitTimeoutMs = 300_000;

export class WechatChannel implements OutboundChannel {
  readonly #ownerId: () => string;
  readonly #store: ChannelStore;
  readonly #onInbound: InboundHandler;
  readonly #client: WechatClientApi;
  #monitorAbort: AbortController | undefined;
  readonly #loginSessions = new Map<string, WechatLoginSession>();
  readonly #pendingPins = new Map<string, string>();
  readonly #pinWaiters = new Map<string, () => void>();

  constructor(options: {
    ownerId: () => string;
    store: ChannelStore;
    onInbound: InboundHandler;
    client?: WechatClientApi;
  }) {
    this.#ownerId = options.ownerId;
    this.#store = options.store;
    this.#onInbound = options.onInbound;
    this.#client = options.client ?? new WechatClient();
  }

  sync(): void {
    const state = this.#store.getState(this.#ownerId(), 'wechat');
    if (state.status === 'active' && state.hasCredentials) {
      this.#startMonitor();
    } else {
      this.#stopMonitor();
    }
  }

  stop(): void {
    this.#stopMonitor();
  }

  async startLogin(): Promise<{ sessionId: string; qrContent: string }> {
    this.#store.beginWechatLogin(this.#ownerId());
    const qr = await this.#client.getBotQrcode();
    const session: WechatLoginSession = {
      id: randomUUID(),
      status: 'pending',
      reason: '',
      awaitingPin: false,
    };
    this.#loginSessions.set(session.id, session);
    void this.#pollLoginLoop(session, qr.qrcode).catch(() => {
      session.status = 'failed';
      session.reason = '登录流程异常结束，请重新登录。';
    });
    return { sessionId: session.id, qrContent: qr.qrcode_img_content };
  }

  pollLogin(sessionId: string): WechatLoginSession {
    const session = this.#loginSessions.get(sessionId);
    if (session === undefined) {
      return {
        id: sessionId,
        status: 'failed',
        reason: '登录会话不存在或已过期。',
        awaitingPin: false,
      };
    }
    return session;
  }

  submitLoginPin(sessionId: string, pin: string): WechatLoginSession {
    const session = this.#loginSessions.get(sessionId);
    if (session === undefined) {
      throw new ChannelDeliveryError(false, 'login_session_not_found', '登录会话不存在或已过期。');
    }
    if (session.status !== 'pending' || !session.awaitingPin) {
      throw new ChannelDeliveryError(false, 'pin_not_expected', '当前登录会话不需要数字验证码。');
    }
    if (!/^\d{1,12}$/.test(pin)) {
      throw new ChannelDeliveryError(false, 'invalid_pin', '数字验证码格式无效。');
    }
    this.#pendingPins.set(sessionId, pin);
    session.awaitingPin = false;
    session.reason = '已提交数字验证码，等待微信确认。';
    const waiter = this.#pinWaiters.get(sessionId);
    if (waiter !== undefined) {
      this.#pinWaiters.delete(sessionId);
      waiter();
    }
    return session;
  }

  #waitForPin(session: WechatLoginSession): Promise<boolean> {
    if (this.#pendingPins.has(session.id)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pinWaiters.delete(session.id);
        session.status = 'failed';
        session.reason = '等待数字验证码超时，请重新登录。';
        this.#store.setStatus(this.#ownerId(), 'wechat', 'pending_login', session.reason);
        resolve(false);
      }, pinWaitTimeoutMs);
      timer.unref();
      this.#pinWaiters.set(session.id, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async #pollLoginLoop(session: WechatLoginSession, qrcode: string): Promise<void> {
    const ownerId = this.#ownerId();
    let refreshCount = 0;
    let currentQrcode = qrcode;
    while (session.status === 'pending') {
      if (session.awaitingPin) {
        const submitted = await this.#waitForPin(session);
        if (!submitted) return;
      }
      const verifyCode = this.#pendingPins.get(session.id);
      const status = await this.#client.pollQrcodeStatus(currentQrcode, verifyCode);
      if (status.status.includes('need_verifycode')) {
        this.#pendingPins.delete(session.id);
        session.awaitingPin = true;
        session.reason =
          verifyCode === undefined
            ? '微信要求输入手机上的数字验证码。'
            : '数字验证码不正确，请重新输入手机上的数字。';
        continue;
      }
      if (verifyCode !== undefined) {
        this.#pendingPins.delete(session.id);
        session.awaitingPin = false;
        session.reason = '';
      }
      switch (status.status) {
        case 'confirmed': {
          if (
            status.bot_token === undefined ||
            status.ilink_bot_id === undefined ||
            status.ilink_user_id === undefined
          ) {
            session.status = 'failed';
            session.reason = '微信登录响应缺少凭证。';
            return;
          }
          this.#store.completeWechatLogin(ownerId, {
            kind: 'wechat',
            botToken: status.bot_token,
            baseUrl: status.baseurl ?? this.#client.baseUrl,
            botId: status.ilink_bot_id,
            ilinkUserId: status.ilink_user_id,
          });
          session.status = 'confirmed';
          session.awaitingPin = false;
          this.sync();
          return;
        }
        case 'expired':
        case 'verify_code_blocked': {
          this.#pendingPins.delete(session.id);
          session.awaitingPin = false;
          refreshCount += 1;
          if (refreshCount > 3) {
            session.status = 'failed';
            session.reason = '二维码多次过期，请重新登录。';
            this.#store.setStatus(ownerId, 'wechat', 'pending_login', session.reason);
            return;
          }
          const qr = await this.#client.getBotQrcode();
          currentQrcode = qr.qrcode;
          break;
        }
        case 'scaned_but_redirect': {
          if (status.redirect_host !== undefined && status.redirect_host.length > 0) {
            this.#client.baseUrl = `https://${status.redirect_host}`;
          }
          break;
        }
        default:
          break;
      }
    }
  }

  async send(
    input: { externalUserId: string; contextToken: string | null; markdown: string },
    signal: AbortSignal,
  ): Promise<void> {
    const ownerId = this.#ownerId();
    const credentials = this.#store.getCredentials(ownerId, 'wechat');
    if (credentials === null || credentials.kind !== 'wechat') {
      throw new ChannelDeliveryError(false, 'channel_not_configured', '微信渠道未登录。');
    }
    const segments = renderWechatSegments(input.markdown);
    if (segments.length === 0) {
      throw new ChannelDeliveryError(false, 'empty_message', '没有可发送的文本内容。');
    }
    for (const segment of segments) {
      signal.throwIfAborted();
      await this.#client.sendText(
        credentials.botToken,
        input.externalUserId,
        input.contextToken,
        segment,
        signal,
      );
    }
  }

  #startMonitor(): void {
    if (this.#monitorAbort !== undefined) return;
    const abort = new AbortController();
    this.#monitorAbort = abort;
    void this.#monitorLoop(abort.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.#monitorAbort === abort) this.#monitorAbort = undefined;
      });
  }

  #stopMonitor(): void {
    const abort = this.#monitorAbort;
    this.#monitorAbort = undefined;
    abort?.abort();
  }

  async #monitorLoop(signal: AbortSignal): Promise<void> {
    const ownerId = this.#ownerId();
    const credentials = this.#store.getCredentials(ownerId, 'wechat');
    if (credentials === null || credentials.kind !== 'wechat') return;
    if (credentials.baseUrl.length > 0) this.#client.baseUrl = credentials.baseUrl;
    void this.#client.notifyLifecycle(credentials.botToken, 'start');
    let backoffMs = 1_000;
    try {
      while (!signal.aborted) {
        const state = this.#store.getState(ownerId, 'wechat');
        if (state.status !== 'active') return;
        try {
          const response = await this.#client.getUpdates(
            credentials.botToken,
            state.inboundCursor,
            signal,
          );
          backoffMs = 1_000;
          const failure = response.ret ?? response.errcode ?? 0;
          if (failure !== 0) {
            if (failure === -14) {
              this.#store.setStatus(ownerId, 'wechat', 'error', '微信登录态已失效，请重新登录。');
              return;
            }
            await sleep(backoffMs, signal);
            backoffMs = Math.min(backoffMs * 2, 30_000);
            continue;
          }
          if (response.get_updates_buf !== undefined && response.get_updates_buf.length > 0) {
            this.#store.updateInboundCursor(ownerId, 'wechat', response.get_updates_buf);
          }
          for (const message of response.msgs ?? []) {
            this.#handleMessage(ownerId, state.externalUserId, message);
          }
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof ChannelDeliveryError && error.code === 'session_expired') {
            this.#store.setStatus(ownerId, 'wechat', 'error', '微信登录态已失效，请重新登录。');
            return;
          }
          await sleep(backoffMs, signal);
          backoffMs = Math.min(backoffMs * 2, 30_000);
        }
      }
    } finally {
      void this.#client.notifyLifecycle(credentials.botToken, 'stop');
    }
  }

  #handleMessage(
    ownerId: string,
    boundUserId: string | null,
    message: Parameters<typeof inboundMessageText>[0],
  ): void {
    if (message.message_type !== 1) return;
    if (boundUserId === null || message.from_user_id !== boundUserId) return;
    const externalMessageId =
      message.message_id === undefined ? undefined : String(message.message_id);
    if (externalMessageId === undefined) return;
    if (message.context_token !== undefined && message.context_token.length > 0) {
      this.#store.updateContextToken(ownerId, 'wechat', message.context_token);
    }
    if (!this.#store.recordInboundEvent(ownerId, 'wechat', externalMessageId)) return;
    const text = inboundMessageText(message);
    if (text.trim().length === 0) return;
    this.#onInbound({
      channel: 'wechat',
      externalMessageId,
      externalUserId: boundUserId,
      text,
    });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
