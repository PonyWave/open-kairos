import { randomUUID } from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import type { OutboundChannel } from '../delivery-worker.js';
import { renderFeishuCards, renderFeishuTextFallback } from '../render-feishu.js';
import type { ChannelStore } from '../store.js';
import { ChannelDeliveryError } from '../store.js';
import type { InboundHandler } from '../wechat/adapter.js';

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

  stop(): void {
    this.#stopWs();
  }

  async send(
    input: { externalUserId: string; contextToken: string | null; markdown: string },
    _signal: AbortSignal,
  ): Promise<void> {
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
    try {
      for (const payload of payloads) {
        await this.#sendPayload(client, input.externalUserId, payload.msgType, payload.content);
      }
    } catch (error) {
      if (error instanceof ChannelDeliveryError && !error.retryable) {
        const fallback = renderFeishuTextFallback(input.markdown);
        for (const payload of fallback) {
          await this.#sendPayload(client, input.externalUserId, payload.msgType, payload.content);
        }
        return;
      }
      throw error;
    }
  }

  async #sendPayload(
    client: lark.Client,
    openId: string,
    msgType: 'interactive' | 'text',
    content: string,
  ): Promise<void> {
    let response: { code?: number | undefined; msg?: string | undefined };
    try {
      response = await client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: openId, msg_type: msgType, content, uuid: randomUUID() },
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
    const client = new lark.WSClient({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
      onError: (error) => {
        const ownerId = this.#ownerId();
        this.#store.setStatus(ownerId, 'feishu', 'error', `飞书长连接失败：${error.message}`);
      },
    });
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data: unknown) => {
        this.#handleEvent(data);
      },
    });
    this.#wsClient = client;
    this.#runningAppId = appId;
    void client.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
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

  #handleEvent(data: unknown): void {
    const ownerId = this.#ownerId();
    const parsed = z
      .object({
        sender: z.object({
          sender_id: z.object({ open_id: z.string().optional() }).optional(),
          sender_type: z.string().optional(),
        }),
        message: z.object({
          message_id: z.string(),
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
    if (text.trim().length === 0) return;
    this.#onInbound({
      channel: 'feishu',
      externalMessageId: message.message_id,
      externalUserId: openId,
      text,
    });
  }
}
