import { randomUUID } from 'node:crypto';
import type { OutboundChannel } from '../delivery-worker.js';
import { renderWechatSegments } from '../render-wechat.js';
import type { ChannelStore } from '../store.js';
import { ChannelDeliveryError } from '../store.js';
import { inboundMessageText, WechatClient } from './client.js';

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
}

export class WechatChannel implements OutboundChannel {
  readonly #ownerId: () => string;
  readonly #store: ChannelStore;
  readonly #onInbound: InboundHandler;
  readonly #client: WechatClient;
  #monitorAbort: AbortController | undefined;
  readonly #loginSessions = new Map<string, WechatLoginSession>();

  constructor(options: {
    ownerId: () => string;
    store: ChannelStore;
    onInbound: InboundHandler;
    client?: WechatClient;
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
    const session: WechatLoginSession = { id: randomUUID(), status: 'pending', reason: '' };
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
      return { id: sessionId, status: 'failed', reason: '登录会话不存在或已过期。' };
    }
    return session;
  }

  async #pollLoginLoop(session: WechatLoginSession, qrcode: string): Promise<void> {
    const ownerId = this.#ownerId();
    let refreshCount = 0;
    let currentQrcode = qrcode;
    while (session.status === 'pending') {
      const status = await this.#client.pollQrcodeStatus(currentQrcode);
      if (status.status.includes('need_verifycode')) {
        session.reason = '微信要求输入手机上的数字验证码，当前版本暂不支持，请重新登录。';
        session.status = 'failed';
        this.#store.setStatus(ownerId, 'wechat', 'pending_login', session.reason);
        return;
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
          this.sync();
          return;
        }
        case 'expired':
        case 'verify_code_blocked': {
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
