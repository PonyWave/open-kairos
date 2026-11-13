import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { OutboundChannel } from '../delivery-worker.js';
import { renderWechatSegments } from '../render-wechat.js';
import type { ChannelStore } from '../store.js';
import { ChannelDeliveryError } from '../store.js';
import { inboundMessageText, WechatClient, type WechatClientApi } from './client.js';

export interface InboundChannelMedia {
  fileName: string;
  bytes: Uint8Array;
}

export interface InboundChannelQuote {
  quoteSeq?: number | null;
  quoteExcerpt?: string | null;
}

export interface InboundChannelMessage {
  channel: 'wechat' | 'feishu';
  externalMessageId: string;
  externalUserId: string;
  text: string;
  media?: InboundChannelMedia[];
  quote?: InboundChannelQuote;
}

export type InboundHandler = (message: InboundChannelMessage) => void;

export interface WechatLoginSession {
  id: string;
  status: 'pending' | 'confirmed' | 'failed';
  reason: string;
  awaitingPin: boolean;
  qrContent: string;
  pollingFailed: boolean;
  failure?: unknown;
}

const pinWaitTimeoutMs = 300_000;
const typingRefreshMs = 5_000;

export class WechatChannel implements OutboundChannel {
  readonly #ownerId: () => string;
  readonly #store: ChannelStore;
  readonly #onInbound: InboundHandler;
  readonly #client: WechatClientApi;
  #monitorAbort: AbortController | undefined;
  readonly #loginSessions = new Map<string, WechatLoginSession>();
  readonly #pendingPins = new Map<string, string>();
  readonly #pinWaiters = new Map<string, () => void>();
  #currentLoginId: string | null = null;
  #loginAbort: AbortController | null = null;
  #loginActionId: string | undefined;
  #typingActive = false;
  #typingTimer: ReturnType<typeof setInterval> | undefined;
  #typingTicket: string | null = null;
  #typingUserId: string | null = null;

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
    this.cancelLogin();
    this.#stopMonitor();
    this.#stopTyping();
  }

  currentLogin(ownerId?: string): WechatLoginSession | undefined {
    if (ownerId !== undefined && ownerId !== this.#ownerId()) return undefined;
    return this.#currentLoginId ? this.#loginSessions.get(this.#currentLoginId) : undefined;
  }

  cancelLogin(sessionId?: string, ownerId?: string): void {
    if (ownerId !== undefined && ownerId !== this.#ownerId()) return;
    const current = this.currentLogin();
    if (sessionId !== undefined && current?.id !== sessionId) return;
    this.#loginAbort?.abort();
    this.#loginAbort = null;
    if (current?.status === 'pending') {
      current.status = 'failed';
      current.reason = '本次配对已取消，请重新开始。';
      current.qrContent = '';
      this.#pinWaiters.get(current.id)?.();
      this.#pendingPins.delete(current.id);
      this.#store.setStatus(this.#ownerId(), 'wechat', 'unconfigured', '');
    }
    this.#currentLoginId = null;
    this.#loginActionId = undefined;
  }

  async startLogin(
    actionId?: string,
    ownerId?: string,
  ): Promise<{ sessionId: string; qrContent: string }> {
    if (ownerId !== undefined && ownerId !== this.#ownerId())
      throw new ChannelDeliveryError(false, 'permission_denied', '该登录会话不属于当前账号。');
    const previous = this.currentLogin();
    if (
      actionId !== undefined &&
      actionId === this.#loginActionId &&
      previous &&
      (previous.status === 'confirmed' || (previous.status === 'pending' && previous.qrContent))
    ) {
      return { sessionId: previous.id, qrContent: previous.qrContent };
    }
    this.cancelLogin();
    const abort = new AbortController();
    this.#loginAbort = abort;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(600_000)]);
    const session: WechatLoginSession = {
      id: randomUUID(),
      status: 'pending',
      reason: '',
      awaitingPin: false,
      qrContent: '',
      pollingFailed: false,
    };
    this.#currentLoginId = session.id;
    this.#loginActionId = actionId;
    this.#loginSessions.set(session.id, session);
    if (this.#loginSessions.size > 12) {
      const oldest = this.#loginSessions.keys().next().value;
      if (oldest !== undefined) this.#loginSessions.delete(oldest);
    }
    this.#store.beginWechatLogin(this.#ownerId());
    try {
      const qr = await this.#client.getBotQrcode(signal);
      signal.throwIfAborted();
      session.qrContent = qr.qrcode_img_content;
      void this.#pollLoginLoop(session, qr.qrcode, signal).catch((error: unknown) => {
        if (this.#currentLoginId !== session.id) return;
        session.status = 'failed';
        session.qrContent = '';
        session.reason = signal.aborted
          ? '配对已超时，请重新生成二维码。'
          : '登录流程异常结束，请重新生成二维码。';
        this.#store.setStatus(this.#ownerId(), 'wechat', 'error', session.reason);
        session.failure = error;
      });
      return { sessionId: session.id, qrContent: session.qrContent };
    } catch (error) {
      if (this.#currentLoginId === session.id) {
        session.status = 'failed';
        session.reason = '无法获取微信二维码，请稍后重试。';
        this.#store.setStatus(this.#ownerId(), 'wechat', 'error', session.reason);
      }
      throw error;
    }
  }

  pollLogin(sessionId: string, ownerId?: string): WechatLoginSession {
    const session = this.#loginSessions.get(sessionId);
    if (session === undefined || (ownerId !== undefined && ownerId !== this.#ownerId())) {
      return {
        id: sessionId,
        status: 'failed',
        reason: '登录会话不存在或已过期。',
        awaitingPin: false,
        qrContent: '',
        pollingFailed: false,
      };
    }
    return session;
  }

  submitLoginPin(sessionId: string, pin: string, ownerId?: string): WechatLoginSession {
    const session = this.#loginSessions.get(sessionId);
    if (session === undefined || (ownerId !== undefined && ownerId !== this.#ownerId())) {
      throw new ChannelDeliveryError(false, 'login_session_not_found', '登录会话不存在或已过期。');
    }
    if (
      session.id !== this.#currentLoginId ||
      session.status !== 'pending' ||
      !session.awaitingPin
    ) {
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

  #waitForPin(session: WechatLoginSession, signal: AbortSignal): Promise<boolean> {
    if (this.#pendingPins.has(session.id)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pinWaiters.delete(session.id);
        session.status = 'failed';
        session.reason = '等待数字验证码超时，请重新登录。';
        this.#store.setStatus(this.#ownerId(), 'wechat', 'error', session.reason);
        resolve(false);
      }, pinWaitTimeoutMs);
      timer.unref();
      const cancel = () => {
        clearTimeout(timer);
        this.#pinWaiters.delete(session.id);
        resolve(false);
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.#pinWaiters.set(session.id, () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        resolve(!signal.aborted);
      });
    });
  }

  async #pollLoginLoop(
    session: WechatLoginSession,
    qrcode: string,
    signal: AbortSignal,
  ): Promise<void> {
    const ownerId = this.#ownerId();
    let refreshCount = 0;
    let currentQrcode = qrcode;
    while (session.status === 'pending' && session.id === this.#currentLoginId) {
      signal.throwIfAborted();
      if (session.awaitingPin) {
        const submitted = await this.#waitForPin(session, signal);
        if (!submitted) {
          signal.throwIfAborted();
          return;
        }
      }
      const verifyCode = this.#pendingPins.get(session.id);
      let status: Awaited<ReturnType<WechatClientApi['pollQrcodeStatus']>>;
      try {
        status = await this.#client.pollQrcodeStatus(currentQrcode, verifyCode, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        if (session.id !== this.#currentLoginId) return;
        session.pollingFailed = true;
        session.reason = '连接中断，正在重新查询扫码结果。';
        await delay(2_000, undefined, { signal });
        continue;
      }
      signal.throwIfAborted();
      if (session.id !== this.#currentLoginId) return;
      if (session.pollingFailed) session.reason = '';
      session.pollingFailed = false;
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
          session.qrContent = '';
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
            this.#store.setStatus(ownerId, 'wechat', 'error', session.reason);
            return;
          }
          const qr = await this.#client.getBotQrcode(signal);
          signal.throwIfAborted();
          if (session.id !== this.#currentLoginId) return;
          currentQrcode = qr.qrcode;
          session.qrContent = qr.qrcode_img_content;
          session.reason = '二维码已更新，请重新扫码。';
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
      await delay(250, undefined, { signal });
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
    this.#stopTyping();
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
            await this.handleInboundMessage(ownerId, state.externalUserId, message);
          }
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof ChannelDeliveryError && error.code === 'session_expired') {
            this.#store.setStatus(ownerId, 'wechat', 'error', '微信登录态已失效，请重新登录。');
            return;
          }
          console.error('wechat monitor poll failed', error);
          await sleep(backoffMs, signal);
          backoffMs = Math.min(backoffMs * 2, 30_000);
        }
      }
    } finally {
      void this.#client.notifyLifecycle(credentials.botToken, 'stop');
    }
  }

  async handleInboundMessage(
    ownerId: string,
    boundUserId: string | null,
    message: Parameters<typeof inboundMessageText>[0],
  ): Promise<void> {
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
    const media = await this.#downloadMessageMedia(externalMessageId, message);
    if (text.trim().length === 0 && media.length === 0) return;
    const quote = this.#resolveQuote(ownerId, message);
    this.#onInbound({
      channel: 'wechat',
      externalMessageId,
      externalUserId: boundUserId,
      text,
      ...(media.length === 0 ? {} : { media }),
      ...(quote === undefined ? {} : { quote }),
    });
    void this.#startTyping(boundUserId, message.context_token);
  }

  #resolveQuote(
    ownerId: string,
    message: Parameters<typeof inboundMessageText>[0],
  ): InboundChannelQuote | undefined {
    for (const item of message.item_list ?? []) {
      const ref = item?.ref_msg;
      if (ref === undefined) continue;
      const excerpt = ['text', 'title', 'content', 'description']
        .map((key) => ref[key])
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      const refId = ['msg_id', 'message_id', 'id']
        .map((key) => ref[key])
        .find((value): value is number | string =>
          typeof value === 'number' ? Number.isSafeInteger(value) : typeof value === 'string',
        );
      const mapped =
        refId === undefined
          ? undefined
          : this.#store.findMessageMap(ownerId, 'wechat', String(refId));
      if (mapped === undefined && excerpt === undefined) continue;
      return {
        ...(mapped?.messageSeq == null ? {} : { quoteSeq: mapped.messageSeq }),
        quoteExcerpt: (mapped?.excerpt ?? excerpt ?? '').slice(0, 500),
      };
    }
    return undefined;
  }

  async #downloadMessageMedia(
    externalMessageId: string,
    message: Parameters<typeof inboundMessageText>[0],
  ): Promise<InboundChannelMedia[]> {
    const media: InboundChannelMedia[] = [];
    const items = message.item_list ?? [];
    for (const [index, item] of items.entries()) {
      if (item === undefined) continue;
      const ref =
        item.type === 2
          ? item.image_item
          : item.type === 3
            ? item.voice_item
            : item.type === 4
              ? item.file_item
              : item.type === 5
                ? item.video_item
                : undefined;
      const mediaRef = ref?.media;
      if (ref === undefined || mediaRef === undefined) continue;
      if (
        item.type === 3 &&
        item.voice_item?.text !== undefined &&
        item.voice_item.text.length > 0
      ) {
        continue;
      }
      const aesKey =
        item.type === 2 && item.image_item?.aeskey !== undefined
          ? item.image_item.aeskey
          : mediaRef.aes_key;
      const fileName =
        item.type === 4 && item.file_item?.file_name !== undefined
          ? item.file_item.file_name
          : `wechat-${item.type === 2 ? 'image' : item.type === 3 ? 'voice' : 'video'}-${externalMessageId}-${index + 1}`;
      try {
        const bytes = await this.#client.downloadMedia(
          {
            ...(mediaRef.full_url === undefined ? {} : { fullUrl: mediaRef.full_url }),
            ...(mediaRef.encrypt_query_param === undefined
              ? {}
              : { encryptQueryParam: mediaRef.encrypt_query_param }),
          },
          aesKey,
          AbortSignal.timeout(60_000),
        );
        media.push({ fileName, bytes });
      } catch (error) {
        console.error('wechat media download failed', error);
      }
    }
    return media;
  }

  async #startTyping(userId: string, contextToken: string | undefined): Promise<void> {
    this.#typingActive = true;
    this.#typingUserId = userId;
    try {
      const credentials = this.#store.getCredentials(this.#ownerId(), 'wechat');
      if (credentials === null || credentials.kind !== 'wechat') return;
      if (this.#typingTicket === null) {
        this.#typingTicket = await this.#client.getConfig(
          credentials.botToken,
          userId,
          contextToken,
        );
        if (this.#typingTicket === null) return;
      }
      if (!this.#typingActive) return;
      await this.#client.sendTyping(credentials.botToken, userId, this.#typingTicket, 1);
    } catch {
      return;
    }
    if (this.#typingTimer !== undefined) return;
    this.#typingTimer = setInterval(() => {
      if (!this.#typingActive || this.#typingTicket === null || this.#typingUserId === null) return;
      const credentials = this.#store.getCredentials(this.#ownerId(), 'wechat');
      if (credentials === null || credentials.kind !== 'wechat') return;
      void this.#client
        .sendTyping(credentials.botToken, this.#typingUserId, this.#typingTicket, 1)
        .catch(() => undefined);
    }, typingRefreshMs);
    this.#typingTimer.unref();
  }

  #stopTyping(): void {
    this.#typingActive = false;
    if (this.#typingTimer !== undefined) {
      clearInterval(this.#typingTimer);
      this.#typingTimer = undefined;
    }
    const userId = this.#typingUserId;
    this.#typingUserId = null;
    const ticket = this.#typingTicket;
    if (userId === null || ticket === null) return;
    const credentials = this.#store.getCredentials(this.#ownerId(), 'wechat');
    if (credentials === null || credentials.kind !== 'wechat') return;
    void this.#client.sendTyping(credentials.botToken, userId, ticket, 2).catch(() => undefined);
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
