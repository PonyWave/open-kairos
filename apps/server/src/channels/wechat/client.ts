import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
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

const cdnMediaSchema = z
  .object({
    encrypt_query_param: z.string().optional(),
    aes_key: z.string().optional(),
    full_url: z.string().optional(),
  })
  .optional();

export const weixinMessageSchema = z.object({
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
          image_item: z
            .object({
              aeskey: z.string().optional(),
              media: cdnMediaSchema,
            })
            .optional(),
          file_item: z
            .object({
              file_name: z.string().optional(),
              media: cdnMediaSchema,
            })
            .optional(),
          voice_item: z
            .object({
              text: z.string().optional(),
              media: cdnMediaSchema,
            })
            .optional(),
          video_item: z
            .object({
              media: cdnMediaSchema,
            })
            .optional(),
          ref_msg: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    )
    .optional(),
});
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

export interface WechatUploadedMedia {
  encryptQueryParam: string;
  aesKeyBase64: string;
  cipherSize: number;
  rawSize: number;
}

const getUploadUrlResponseSchema = z.object({
  ret: z.number().optional(),
  errmsg: z.string().optional(),
  upload_param: z.string().optional(),
  upload_full_url: z.string().optional(),
});

const getConfigResponseSchema = z.object({
  ret: z.number().optional(),
  typing_ticket: z.string().optional(),
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
  getConfig(botToken: string, ilinkUserId: string, contextToken?: string): Promise<string | null>;
  downloadMedia(
    ref: { fullUrl?: string | undefined; encryptQueryParam?: string | undefined },
    aesKey: string | undefined,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  uploadMedia(
    botToken: string,
    toUserId: string,
    mediaType: 1 | 3,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<WechatUploadedMedia>;
  sendMediaMessage(
    botToken: string,
    toUserId: string,
    contextToken: string | null,
    media: WechatUploadedMedia & { kind: 'image' | 'file'; fileName?: string },
    signal: AbortSignal,
  ): Promise<void>;
  sendTyping(
    botToken: string,
    ilinkUserId: string,
    typingTicket: string,
    status: 1 | 2,
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
    const response = await this.#fetch(url, {
      method: 'GET',
      headers: this.#headers(null),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(35_000)]),
    });
    if (!response.ok)
      throw new ChannelDeliveryError(
        true,
        `http_${response.status}`,
        `微信登录查询返回 HTTP ${response.status}。`,
      );
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

  async getConfig(
    botToken: string,
    ilinkUserId: string,
    contextToken?: string,
  ): Promise<string | null> {
    const response = await this.#post(
      '/ilink/bot/getconfig',
      {
        ilink_user_id: ilinkUserId,
        ...(contextToken === undefined ? {} : { context_token: contextToken }),
        base_info: this.#baseInfo(),
      },
      getConfigResponseSchema,
      { botToken, timeoutMs: 10_000 },
    );
    return response.typing_ticket ?? null;
  }

  async sendTyping(
    botToken: string,
    ilinkUserId: string,
    typingTicket: string,
    status: 1 | 2,
  ): Promise<void> {
    await this.#post(
      '/ilink/bot/sendtyping',
      {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status,
        base_info: this.#baseInfo(),
      },
      sendMessageResponseSchema,
      { botToken, timeoutMs: 10_000 },
    );
  }

  async downloadMedia(
    ref: { fullUrl?: string | undefined; encryptQueryParam?: string | undefined },
    aesKey: string | undefined,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const url =
      ref.fullUrl ??
      (ref.encryptQueryParam === undefined
        ? undefined
        : `${defaultCdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(ref.encryptQueryParam)}`);
    if (url === undefined) {
      throw new ChannelDeliveryError(false, 'media_unavailable', '微信媒体缺少下载地址。');
    }
    let response: Response;
    try {
      response = await this.#fetch(url, { method: 'GET', signal });
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
        `微信媒体下载返回 HTTP ${response.status}。`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (aesKey === undefined || aesKey.length === 0) return bytes;
    return decryptWechatMedia(bytes, aesKey);
  }

  async uploadMedia(
    botToken: string,
    toUserId: string,
    mediaType: 1 | 3,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<WechatUploadedMedia> {
    const aesKey = randomBytes(16);
    const aesKeyHex = aesKey.toString('hex');
    const filekey = randomUUID();
    const cipher = createCipheriv('aes-128-ecb', aesKey, null);
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const upload = await this.#post(
      '/ilink/bot/getuploadurl',
      {
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize: bytes.length,
        rawfilemd5: createHash('md5').update(bytes).digest('hex'),
        filesize: ciphertext.length,
        no_need_thumb: true,
        aeskey: aesKeyHex,
        base_info: this.#baseInfo(),
      },
      getUploadUrlResponseSchema,
      { botToken, signal },
    );
    const uploadUrl =
      upload.upload_full_url ??
      (upload.upload_param === undefined
        ? undefined
        : `${defaultCdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}`);
    if (uploadUrl === undefined) {
      throw new ChannelDeliveryError(false, 'upload_failed', '微信上传接口未返回上传地址。');
    }
    let response: Response;
    try {
      response = await this.#fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal,
      });
    } catch (error) {
      throw new ChannelDeliveryError(
        true,
        'network_error',
        error instanceof Error ? error.message : String(error),
      );
    }
    const encryptedParam = response.headers.get('x-encrypted-param');
    if (!response.ok || encryptedParam === null || encryptedParam.length === 0) {
      throw new ChannelDeliveryError(
        response.status >= 500 || response.status === 429,
        `upload_http_${response.status}`,
        `微信媒体上传失败（HTTP ${response.status}）。`,
      );
    }
    return {
      encryptQueryParam: encryptedParam,
      aesKeyBase64: Buffer.from(aesKeyHex, 'utf8').toString('base64'),
      cipherSize: ciphertext.length,
      rawSize: bytes.length,
    };
  }

  async sendMediaMessage(
    botToken: string,
    toUserId: string,
    contextToken: string | null,
    media: WechatUploadedMedia & { kind: 'image' | 'file'; fileName?: string },
    signal: AbortSignal,
  ): Promise<void> {
    const item =
      media.kind === 'image'
        ? {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: media.encryptQueryParam,
                aes_key: media.aesKeyBase64,
              },
              mid_size: media.cipherSize,
            },
          }
        : {
            type: 4,
            file_item: {
              media: {
                encrypt_query_param: media.encryptQueryParam,
                aes_key: media.aesKeyBase64,
              },
              file_name: media.fileName ?? 'file',
              len: String(media.rawSize),
            },
          };
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
          item_list: [item],
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

const defaultCdnBaseUrl = 'https://novac2c.cdn.weixin.qq.com/c2c';

export function decryptWechatMedia(bytes: Uint8Array, aesKey: string): Uint8Array {
  const key = parseWechatAesKey(aesKey);
  if (key === undefined) {
    throw new ChannelDeliveryError(false, 'media_key_invalid', '微信媒体密钥格式无效。');
  }
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    return new Uint8Array(Buffer.concat([decipher.update(bytes), decipher.final()]));
  } catch (error) {
    throw new ChannelDeliveryError(
      false,
      'media_decrypt_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function parseWechatAesKey(value: string): Buffer | undefined {
  if (/^[0-9a-fA-F]{32}$/.test(value)) return Buffer.from(value, 'hex');
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 16) return decoded;
    const asText = decoded.toString('utf8');
    if (/^[0-9a-fA-F]{32}$/.test(asText)) return Buffer.from(asText, 'hex');
  } catch {
    // 按无效密钥处理。
  }
  return undefined;
}
