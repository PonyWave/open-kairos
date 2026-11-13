import { randomUUID } from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import type { OutboundChannel } from '../delivery-worker.js';
import { renderFeishuCards, renderFeishuTextFallback } from '../render-feishu.js';
import type { ChannelStore } from '../store.js';
import { ChannelDeliveryError } from '../store.js';
import type {
  InboundChannelMedia,
  InboundChannelQuote,
  InboundHandler,
} from '../wechat/adapter.js';

const textContentSchema = z.object({ text: z.string() });
const postContentSchema = z.object({
  title: z.string().optional(),
  content: z.array(z.array(z.record(z.string(), z.unknown())).optional()).optional(),
});

export function feishuMessageText(messageType: string, content: string): string {
  try {
    if (messageType === 'text') {
      return textContentSchema.parse(JSON.parse(content)).text;
    }
    if (messageType === 'post') {
      const post = postContentSchema.parse(JSON.parse(content));
      const lines: string[] = [];
      if (post.title !== undefined && post.title.length > 0) lines.push(post.title);
      for (const paragraph of post.content ?? []) {
        const parts: string[] = [];
        for (const node of paragraph ?? []) {
          const text = node.text;
          if (typeof text === 'string' && text.length > 0) parts.push(text);
        }
        if (parts.length > 0) lines.push(parts.join(''));
      }
      return lines.join('\n');
    }
  } catch {
    return `[无法解析的${messageType}消息]`;
  }
  switch (messageType) {
    case 'image':
      return '[图片]';
    case 'file':
      return '[文件]';
    case 'audio':
      return '[语音]';
    case 'media':
      return '[视频]';
    default:
      return `[暂不支持的消息类型: ${messageType}]`;
  }
}

const mediaContentSchema = z.object({
  image_key: z.string().optional(),
  file_key: z.string().optional(),
  file_name: z.string().optional(),
});

function feishuMediaRef(
  messageType: string,
  content: string,
): { kind: 'image' | 'file'; fileKey: string; fileName: string } | undefined {
  if (!['image', 'file', 'audio', 'media'].includes(messageType)) return undefined;
  let parsed: z.infer<typeof mediaContentSchema>;
  try {
    parsed = mediaContentSchema.parse(JSON.parse(content));
  } catch {
    return undefined;
  }
  const fileKey = messageType === 'image' ? parsed.image_key : parsed.file_key;
  if (fileKey === undefined || fileKey.length === 0) return undefined;
  const fallback = `feishu-${messageType}-${fileKey.slice(0, 12)}`;
  return {
    kind: messageType === 'image' ? 'image' : 'file',
    fileKey,
    fileName:
      messageType === 'file' && parsed.file_name !== undefined && parsed.file_name.length > 0
        ? parsed.file_name
        : fallback,
  };
}

const authErrorCodes = new Set([99991661, 99991663, 99991664, 99991668]);
const permissionErrorCodes = new Set([230027, 230013]);

function classifyFeishuError(code: number, message: string): ChannelDeliveryError {
  if (authErrorCodes.has(code)) {
    return new ChannelDeliveryError(false, 'auth_invalid', `飞书应用凭证无效：${message}`);
  }
  if (permissionErrorCodes.has(code)) {
    return new ChannelDeliveryError(
      false,
      'permission_denied',
      `飞书应用缺少权限或可用范围不包含该用户：${message}`,
    );
  }
  if (code >= 230000 && code < 240000) {
    return new ChannelDeliveryError(false, `feishu_${code}`, `飞书消息参数错误：${message}`);
  }
  return new ChannelDeliveryError(true, `feishu_${code}`, message);
}

export class FeishuChannel implements OutboundChannel {
  readonly #ownerId: () => string;
  readonly #store: ChannelStore;
  readonly #onInbound: InboundHandler;
  #client: lark.Client | undefined;
  #wsClient: lark.WSClient | undefined;
  #runningAppId: string | undefined;

  constructor(options: {
    ownerId: () => string;
    store: ChannelStore;
    onInbound: InboundHandler;
  }) {
    this.#ownerId = options.ownerId;
    this.#store = options.store;
    this.#onInbound = options.onInbound;
  }

  sync(): void {
    const ownerId = this.#ownerId();
    const credentials = this.#store.getCredentials(ownerId, 'feishu');
    const state = this.#store.getState(ownerId, 'feishu');
    const shouldRun =
      credentials !== null &&
      credentials.kind === 'feishu' &&
      (state.status === 'active' || state.status === 'pending_binding');
    if (!shouldRun || credentials === null || credentials.kind !== 'feishu') {
      this.#stopWs();
      return;
    }
    if (this.#runningAppId === credentials.appId) return;
    this.#stopWs();
    this.#startWs(credentials.appId, credentials.appSecret);
  }

  reconnect(): void {
    this.#stopWs();
    const ownerId = this.#ownerId();
    const current = this.#store.getState(ownerId, 'feishu');
    if (!current.hasCredentials)
      throw new ChannelDeliveryError(false, 'not_configured', '请先保存飞书应用凭据。');
    this.#store.setStatus(ownerId, 'feishu', 'pending_binding', '正在连接飞书服务…');
    this.sync();
  }

  stop(): void {
    this.#stopWs();
  }

  async send(
    input: { externalUserId: string; contextToken: string | null; markdown: string },
    _signal: AbortSignal,
  ): Promise<{ externalMessageId?: string } | void> {
    const ownerId = this.#ownerId();
    const credentials = this.#store.getCredentials(ownerId, 'feishu');
    if (credentials === null || credentials.kind !== 'feishu') {
      throw new ChannelDeliveryError(false, 'channel_not_configured', '飞书渠道未配置。');
    }
    const client = this.#apiClient(credentials.appId, credentials.appSecret);
    const payloads = renderFeishuCards(input.markdown);
    if (payloads.length === 0) {
      throw new ChannelDeliveryError(false, 'empty_message', '没有可发送的文本内容。');
    }
    const replyTo = this.#store.latestInboundMessageId(this.#ownerId(), 'feishu');
    let lastMessageId: string | undefined;
    try {
      for (const payload of payloads) {
        lastMessageId = await this.#sendPayload(
          client,
          input.externalUserId,
          payload.msgType,
          payload.content,
          replyTo,
        );
      }
    } catch (error) {
      if (error instanceof ChannelDeliveryError && !error.retryable) {
        const fallback = renderFeishuTextFallback(input.markdown);
        for (const payload of fallback) {
          lastMessageId = await this.#sendPayload(
            client,
            input.externalUserId,
            payload.msgType,
            payload.content,
            replyTo,
          );
        }
        return { ...(lastMessageId === undefined ? {} : { externalMessageId: lastMessageId }) };
      }
      throw error;
    }
    return { ...(lastMessageId === undefined ? {} : { externalMessageId: lastMessageId }) };
  }

  async #sendPayload(
    client: lark.Client,
    openId: string,
    msgType: 'interactive' | 'text',
    content: string,
    replyTo?: string | undefined,
  ): Promise<string | undefined> {
    let response: {
      code?: number | undefined;
      msg?: string | undefined;
      data?: { message_id?: string | undefined } | undefined;
    };
    try {
      response =
        replyTo === undefined
          ? await client.im.message.create({
              params: { receive_id_type: 'open_id' },
              data: { receive_id: openId, msg_type: msgType, content, uuid: randomUUID() },
            })
          : await client.im.message.reply({
              path: { message_id: replyTo },
              data: { msg_type: msgType, content, uuid: randomUUID() },
            });
    } catch (error) {
      throw new ChannelDeliveryError(
        true,
        'network_error',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (response.code !== 0) {
      throw classifyFeishuError(response.code ?? -1, response.msg ?? '未知错误');
    }
    return response.data?.message_id;
  }

  #apiClient(appId: string, appSecret: string): lark.Client {
    if (this.#client === undefined || this.#runningAppId !== appId) {
      this.#client = new lark.Client({
        appId,
        appSecret,
        appType: lark.AppType.SelfBuild,
        domain: lark.Domain.Feishu,
        loggerLevel: lark.LoggerLevel.error,
      });
    }
    return this.#client;
  }

  #startWs(appId: string, appSecret: string): void {
    this.#store.setStatus(this.#ownerId(), 'feishu', 'pending_binding', '正在连接飞书服务…');
    const ready = () => {
      if (this.#wsClient !== client) return;
      const ownerId = this.#ownerId();
      const state = this.#store.getState(ownerId, 'feishu');
      this.#store.setStatus(
        ownerId,
        'feishu',
        state.externalUserId ? 'active' : 'pending_binding',
        '',
      );
    };
    const client = new lark.WSClient({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
      onReady: ready,
      onReconnected: ready,
      onReconnecting: () => {
        if (this.#wsClient === client)
          this.#store.setStatus(
            this.#ownerId(),
            'feishu',
            'pending_binding',
            '正在重新连接飞书服务…',
          );
      },
      onError: (error) => {
        if (this.#wsClient !== client) return;
        const ownerId = this.#ownerId();
        this.#store.setStatus(ownerId, 'feishu', 'error', `飞书长连接失败：${error.message}`);
      },
    });
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        if (this.#wsClient === client) await this.#handleEvent(data);
      },
    });
    this.#wsClient = client;
    this.#runningAppId = appId;
    void client.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
      if (this.#wsClient !== client) return;
      const ownerId = this.#ownerId();
      this.#store.setStatus(
        ownerId,
        'feishu',
        'error',
        `飞书长连接启动失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  #stopWs(): void {
    const ws = this.#wsClient;
    this.#wsClient = undefined;
    this.#runningAppId = undefined;
    this.#client = undefined;
    if (ws !== undefined) {
      try {
        ws.close();
      } catch {
        // 关闭失败不影响后续重建。
      }
    }
  }

  async #handleEvent(data: unknown): Promise<void> {
    const ownerId = this.#ownerId();
    const parsed = z
      .object({
        sender: z.object({
          sender_id: z.object({ open_id: z.string().optional() }).optional(),
          sender_type: z.string().optional(),
        }),
        message: z.object({
          message_id: z.string(),
          parent_id: z.string().optional(),
          chat_type: z.string(),
          message_type: z.string(),
          content: z.string(),
        }),
      })
      .safeParse(data);
    if (!parsed.success) return;
    const { sender, message } = parsed.data;
    if (sender.sender_type !== undefined && sender.sender_type !== 'user') return;
    if (message.chat_type !== 'p2p') return;
    const openId = sender.sender_id?.open_id;
    if (openId === undefined) return;
    const state = this.#store.getState(ownerId, 'feishu');
    const text = feishuMessageText(message.message_type, message.content);

    if (state.status === 'pending_binding') {
      if (state.pairingCode !== null && text.trim() === state.pairingCode) {
        this.#store.bindExternalUser(ownerId, 'feishu', openId);
        void this.send(
          {
            externalUserId: openId,
            contextToken: null,
            markdown: '绑定成功，现在可以直接在这里和 Kairos 对话。',
          },
          AbortSignal.timeout(15_000),
        ).catch(() => undefined);
        this.sync();
        return;
      }
      void this.send(
        {
          externalUserId: openId,
          contextToken: null,
          markdown:
            '该机器人尚未绑定用户。请在 open-kairos 设置页查看配对码，并把配对码作为消息发送到这里完成绑定。',
        },
        AbortSignal.timeout(15_000),
      ).catch(() => undefined);
      return;
    }

    if (state.status !== 'active' || state.externalUserId === null) return;
    if (state.externalUserId !== openId) return;
    if (!this.#store.recordInboundEvent(ownerId, 'feishu', message.message_id)) return;
    const media = await this.#downloadMessageMedia(message);
    if (text.trim().length === 0 && media.length === 0) return;
    const quote = await this.#resolveQuote(ownerId, message);
    this.#onInbound({
      channel: 'feishu',
      externalMessageId: message.message_id,
      externalUserId: openId,
      text,
      ...(media.length === 0 ? {} : { media }),
      ...(quote === undefined ? {} : { quote }),
    });
  }

  async #resolveQuote(
    ownerId: string,
    message: { message_id: string; parent_id?: string | undefined },
  ): Promise<InboundChannelQuote | undefined> {
    if (message.parent_id === undefined || message.parent_id.length === 0) return undefined;
    const mapped = this.#store.findMessageMap(ownerId, 'feishu', message.parent_id);
    if (mapped !== undefined) {
      const seq =
        mapped.messageSeq ??
        (mapped.inputId === null
          ? undefined
          : this.#store.messageSeqForInput(ownerId, mapped.inputId));
      return {
        ...(seq === undefined ? {} : { quoteSeq: seq }),
        quoteExcerpt: mapped.excerpt.slice(0, 500),
      };
    }
    const credentials = this.#store.getCredentials(ownerId, 'feishu');
    if (credentials === null || credentials.kind !== 'feishu') return undefined;
    try {
      const response = await this.#apiClient(
        credentials.appId,
        credentials.appSecret,
      ).im.message.get({ path: { message_id: message.parent_id } });
      const quoted = response.data?.items?.[0];
      if (quoted === undefined) return undefined;
      const excerpt = feishuMessageText(quoted.msg_type ?? 'text', quoted.body?.content ?? '');
      return excerpt.trim().length === 0 ? undefined : { quoteExcerpt: excerpt.slice(0, 500) };
    } catch (error) {
      console.error('feishu quote fetch failed', error);
      return undefined;
    }
  }

  async #downloadMessageMedia(message: {
    message_id: string;
    message_type: string;
    content: string;
  }): Promise<InboundChannelMedia[]> {
    const ref = feishuMediaRef(message.message_type, message.content);
    if (ref === undefined) return [];
    const credentials = this.#store.getCredentials(this.#ownerId(), 'feishu');
    if (credentials === null || credentials.kind !== 'feishu') return [];
    try {
      const response = await this.#apiClient(
        credentials.appId,
        credentials.appSecret,
      ).im.messageResource.get({
        params: { type: ref.kind },
        path: { message_id: message.message_id, file_key: ref.fileKey },
      });
      const stream = response.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      return [{ fileName: ref.fileName, bytes: new Uint8Array(Buffer.concat(chunks)) }];
    } catch (error) {
      console.error('feishu media download failed', error);
      return [];
    }
  }
}
