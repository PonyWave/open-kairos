import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ChannelDeliveryError } from '../store.js';

export const wechatPluginVersion = '3.0.1/kairos-0.1';
export const wechatBotAgent = 'open-kairos/0.1.0';
const defaultApiBaseUrl = 'https://ilinkai.weixin.qq.com';

function encodedClientVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return '0';
  const [, major = '0', minor = '0', patch = '0'] = match;
  return String((Number(major) << 16) | (Number(minor) << 8) | Number(patch));
}

const baseInfoSchema = z.object({
  channel_version: z.string(),
  bot_agent: z.string(),
});

export interface WechatClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

const qrCodeResponseSchema = z.object({
  qrcode: z.string(),
  qrcode_img_content: z.string(),
});

const qrStatusResponseSchema = z.object({
  status: z.string(),
  bot_token: z.string().optional(),
  ilink_bot_id: z.string().optional(),
  baseurl: z.string().optional(),
  ilink_user_id: z.string().optional(),
  redirect_host: z.string().optional(),
});

export const weixinMessageSchema = z
  .object({
    message_id: z.number().optional(),
    from_user_id: z.string().optional(),
    to_user_id: z.string().optional(),
    create_time_ms: z.number().optional(),
    message_type: z.number().optional(),
    message_state: z.number().optional(),
    context_token: z.string().optional(),
    item_list: z
      .array(
        z
          .object({
            type: z.number().optional(),
            text_item: z.object({ text: z.string().optional() }).optional(),
            file_item: z.object({ file_name: z.string().optional() }).optional(),
            voice_item: z.object({ text: z.string().optional() }).optional(),
          })
          .strict()
          .optional(),
      )
      .optional(),
  })
  .strict();
export type WeixinMessage = z.infer<typeof weixinMessageSchema>;

const getUpdatesResponseSchema = z.object({
  ret: z.number().optional(),
  errcode: z.number().optional(),
  errmsg: z.string().optional(),
  msgs: z.array(weixinMessageSchema).optional(),
  get_updates_buf: z.string().optional(),
  longpolling_timeout_ms: z.number().optional(),
});

const sendMessageResponseSchema = z.object({
  ret: z.number().optional(),
  errmsg: z.string().optional(),
});

export interface WechatClientApi {
  baseUrl: string;
  getBotQrcode(signal?: AbortSignal): Promise<z.infer<typeof qrCodeResponseSchema>>;
  pollQrcodeStatus(
    qrcode: string,
    verifyCode?: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof qrStatusResponseSchema>>;
  getUpdates(
    botToken: string,
    cursor: string,
    signal: AbortSignal,
  ): Promise<z.infer<typeof getUpdatesResponseSchema>>;
  sendText(
    botToken: string,
    toUserId: string,
    contextToken: string | null,
    text: string,
    signal: AbortSignal,
  ): Promise<void>;
  notifyLifecycle(botToken: string, action: 'start' | 'stop'): Promise<void>;
}

export class WechatClient implements WechatClientApi {
  readonly #fetch: typeof globalThis.fetch;
  #baseUrl: string;

  constructor(options: WechatClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = options.baseUrl ?? defaultApiBaseUrl;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  set baseUrl(value: string) {
    this.#baseUrl = value;
  }

  #headers(botToken: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString(
        'base64',
      ),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': encodedClientVersion(wechatPluginVersion),
    };
    if (botToken !== null) headers.Authorization = `Bearer ${botToken}`;
    return headers;
  }

  #baseInfo() {
    return baseInfoSchema.parse({
      channel_version: wechatPluginVersion,
      bot_agent: wechatBotAgent,
    });
  }

  async #post<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    options: { botToken: string | null; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    const url = new URL(path, this.#baseUrl);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: this.#headers(options.botToken),
        body: JSON.stringify(body),
        signal: AbortSignal.any(
          [options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)].filter(
            (signal): signal is AbortSignal => signal !== undefined,
          ),
        ),
      });
    } catch (error) {
      throw new ChannelDeliveryError(
        true,
        'network_error',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!response.ok) {
      throw new ChannelDeliveryError(
        response.status >= 500 || response.status === 429,
        `http_${response.status}`,
        `微信接口返回 HTTP ${response.status}。`,
      );
    }
    return schema.parse(await response.json());
  }

  async getBotQrcode(signal?: AbortSignal): Promise<z.infer<typeof qrCodeResponseSchema>> {
    return this.#post(
      '/ilink/bot/get_bot_qrcode?bot_type=3',
      { local_token_list: [] },
      qrCodeResponseSchema,
      { botToken: null, ...(signal === undefined ? {} : { signal }) },
    );
  }

  async pollQrcodeStatus(
    qrcode: string,
    verifyCode?: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof qrStatusResponseSchema>> {
    const url = new URL('/ilink/bot/get_qrcode_status', this.#baseUrl);
    url.searchParams.set('qrcode', qrcode);
    if (verifyCode !== undefined) url.searchParams.set('verify_code', verifyCode);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        headers: this.#headers(null),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      return { status: 'wait' };
    }
    if (!response.ok) return { status: 'wait' };
    return qrStatusResponseSchema.parse(await response.json());
  }

  async getUpdates(
    botToken: string,
    cursor: string,
    signal: AbortSignal,
  ): Promise<z.infer<typeof getUpdatesResponseSchema>> {
    return this.#post(
      '/ilink/bot/getupdates',
      { get_updates_buf: cursor, base_info: this.#baseInfo() },
      getUpdatesResponseSchema,
      { botToken, signal, timeoutMs: 45_000 },
    );
  }

  async sendText(
    botToken: string,
    toUserId: string,
    contextToken: string | null,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.#post(
      '/ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: randomUUID(),
          message_type: 2,
          message_state: 2,
          ...(contextToken === null ? {} : { context_token: contextToken }),
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: this.#baseInfo(),
      },
      sendMessageResponseSchema,
      { botToken, signal },
    );
    if (response.ret !== undefined && response.ret !== 0) {
      const code = response.ret;
      throw new ChannelDeliveryError(
        code !== -14,
        code === -14 ? 'session_expired' : `wechat_ret_${code}`,
        response.errmsg && response.errmsg.length > 0
          ? response.errmsg
          : `微信发送失败（${code}）。`,
      );
    }
  }

  async notifyLifecycle(botToken: string, action: 'start' | 'stop'): Promise<void> {
    try {
      await this.#post(
        `/ilink/bot/msg/notify${action}`,
        { base_info: this.#baseInfo() },
        sendMessageResponseSchema,
        { botToken, timeoutMs: 10_000 },
      );
    } catch {
      // 生命周期通知失败不阻断启动或停止。
    }
  }
}

export function inboundMessageText(message: WeixinMessage): string {
  const parts: string[] = [];
  for (const item of message.item_list ?? []) {
    if (item === undefined) continue;
    if (item.type === 1 && item.text_item?.text !== undefined) {
      parts.push(item.text_item.text);
      continue;
    }
    if (item.type === 2) parts.push('[图片]');
    else if (item.type === 3) {
      parts.push(
        item.voice_item?.text !== undefined && item.voice_item.text.length > 0
          ? `[语音] ${item.voice_item.text}`
          : '[语音]',
      );
    } else if (item.type === 4) {
      parts.push(
        item.file_item?.file_name !== undefined && item.file_item.file_name.length > 0
          ? `[文件: ${item.file_item.file_name}]`
          : '[文件]',
      );
    } else if (item.type === 5) parts.push('[视频]');
  }
  return parts.join('\n');
}
