import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { type Clock, isoTime, systemClock } from '../context/types.js';
import { inTransaction } from '../storage/transaction.js';

export type ChannelIdValue = 'wechat' | 'feishu';
export type ChannelStatus =
  | 'unconfigured'
  | 'pending_login'
  | 'pending_binding'
  | 'active'
  | 'error';
export type ChannelDeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'failed';

export const wechatCredentialsSchema = z
  .object({
    kind: z.literal('wechat'),
    botToken: z.string().min(1),
    baseUrl: z.string().min(1),
    botId: z.string().min(1),
    ilinkUserId: z.string().min(1),
  })
  .strict();
export type WechatCredentials = z.infer<typeof wechatCredentialsSchema>;

export const feishuCredentialsSchema = z
  .object({
    kind: z.literal('feishu'),
    appId: z.string().min(1),
    appSecret: z.string().min(1),
  })
  .strict();
export type FeishuCredentials = z.infer<typeof feishuCredentialsSchema>;

export type ChannelCredentials = WechatCredentials | FeishuCredentials;

export interface ChannelStateRecord {
  channel: ChannelIdValue;
  status: ChannelStatus;
  accountLabel: string;
  externalUserId: string | null;
  hasCredentials: boolean;
  contextToken: string | null;
  inboundCursor: string;
  pairingCode: string | null;
  statusReason: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelDeliveryRecord {
  deliveryId: string;
  ownerId: string;
  channel: ChannelIdValue;
  messageId: string | null;
  toolCallId: string | null;
  content: string;
  status: ChannelDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorRetryable: boolean | null;
  nextAttemptAt: string | null;
  notifiedAt: string | null;
  attachmentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export class ChannelDeliveryError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelDeliveryError';
  }
}

const stateRowSchema = z.object({
  tenant_id: z.string(),
  channel: z.enum(['wechat', 'feishu']),
  status: z.enum(['unconfigured', 'pending_login', 'pending_binding', 'active', 'error']),
  account_label: z.string(),
  external_user_id: z.string().nullable(),
  encrypted_credentials: z.string().nullable(),
  context_token: z.string().nullable(),
  inbound_cursor: z.string(),
  pairing_code: z.string().nullable(),
  status_reason: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const deliveryRowSchema = z.object({
  delivery_id: z.string(),
  owner_id: z.string(),
  channel: z.enum(['wechat', 'feishu']),
  message_id: z.string().nullable(),
  tool_call_id: z.string().nullable(),
  content: z.string(),
  status: z.enum(['pending', 'delivering', 'succeeded', 'failed']),
  attempts: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(),
  last_error_code: z.string().nullable(),
  last_error_message: z.string().nullable(),
  last_error_retryable: z.union([z.literal(0), z.literal(1)]).nullable(),
  next_attempt_at: z.string().nullable(),
  notified_at: z.string().nullable(),
  attachment_ids_json: z.string().default('[]'),
  created_at: z.string(),
  updated_at: z.string(),
});

const defaultMaxAttempts = 4;

export class ChannelStore {
  readonly #key: Buffer;
  readonly #clock: Clock;
  constructor(
    readonly database: DatabaseSync,
    secret: string,
    clock: Clock = systemClock,
  ) {
    this.#key = Buffer.from(hkdfSync('sha256', secret, '', 'kairos-channels-v1', 32));
    this.#clock = clock;
  }

  getState(ownerId: string, channel: ChannelIdValue): ChannelStateRecord {
    const row = this.database
      .prepare('SELECT * FROM channel_states WHERE tenant_id = ? AND channel = ?')
      .get(ownerId, channel);
    if (row === undefined) {
      return {
        channel,
        status: 'unconfigured',
        accountLabel: '',
        externalUserId: null,
        hasCredentials: false,
        contextToken: null,
        inboundCursor: '',
        pairingCode: null,
        statusReason: '',
        createdAt: '',
        updatedAt: '',
      };
    }
    return this.#toState(stateRowSchema.parse(row));
  }

  listStates(ownerId: string): ChannelStateRecord[] {
    return (['wechat', 'feishu'] as const).map((channel) => this.getState(ownerId, channel));
  }

  getCredentials(ownerId: string, channel: ChannelIdValue): ChannelCredentials | null {
    const row = this.database
      .prepare(
        'SELECT encrypted_credentials FROM channel_states WHERE tenant_id = ? AND channel = ?',
      )
      .get(ownerId, channel);
    if (row === undefined) return null;
    const encrypted = stateRowSchema
      .pick({ encrypted_credentials: true })
      .parse(row).encrypted_credentials;
    if (encrypted === null) return null;
    const parsed = JSON.parse(this.#decrypt(ownerId, encrypted));
    return channel === 'wechat'
      ? wechatCredentialsSchema.parse(parsed)
      : feishuCredentialsSchema.parse(parsed);
  }

  beginWechatLogin(ownerId: string): ChannelStateRecord {
    this.#upsert(ownerId, 'wechat', (previous) => ({
      status: 'pending_login',
      accountLabel: previous?.account_label ?? '',
      externalUserId: null,
      credentials: null,
      contextToken: null,
      inboundCursor: '',
      pairingCode: null,
      statusReason: '',
    }));
    return this.getState(ownerId, 'wechat');
  }

  completeWechatLogin(ownerId: string, credentials: WechatCredentials): ChannelStateRecord {
    this.#upsert(ownerId, 'wechat', () => ({
      status: 'active',
      accountLabel: credentials.botId,
      externalUserId: credentials.ilinkUserId,
      credentials,
      contextToken: null,
      inboundCursor: '',
      pairingCode: null,
      statusReason: '',
    }));
    return this.getState(ownerId, 'wechat');
  }

  saveFeishuCredentials(
    ownerId: string,
    credentials: FeishuCredentials,
    pairingCode: string,
  ): ChannelStateRecord {
    this.#upsert(ownerId, 'feishu', () => ({
      status: 'pending_binding',
      accountLabel: credentials.appId,
      externalUserId: null,
      credentials,
      contextToken: null,
      inboundCursor: '',
      pairingCode,
      statusReason: '',
    }));
    return this.getState(ownerId, 'feishu');
  }

  bindExternalUser(
    ownerId: string,
    channel: ChannelIdValue,
    externalUserId: string,
  ): ChannelStateRecord {
    this.#upsert(ownerId, channel, (previous) => {
      if (previous === undefined || previous.encrypted_credentials === null) {
        throw new ChannelDeliveryError(false, 'not_configured', '渠道尚未配置凭证。');
      }
      return {
        status: 'active',
        accountLabel: previous.account_label,
        externalUserId,
        credentialsRaw: previous.encrypted_credentials,
        contextToken: previous.context_token,
        inboundCursor: previous.inbound_cursor,
        pairingCode: null,
        statusReason: '',
      };
    });
    return this.getState(ownerId, channel);
  }

  setStatus(
    ownerId: string,
    channel: ChannelIdValue,
    status: ChannelStatus,
    statusReason: string,
  ): ChannelStateRecord {
    this.#upsert(ownerId, channel, (previous) => ({
      status,
      accountLabel: previous?.account_label ?? '',
      externalUserId: previous?.external_user_id ?? null,
      credentialsRaw: previous?.encrypted_credentials ?? null,
      contextToken: previous?.context_token ?? null,
      inboundCursor: previous?.inbound_cursor ?? '',
      pairingCode: previous?.pairing_code ?? null,
      statusReason,
    }));
    return this.getState(ownerId, channel);
  }

  unbind(ownerId: string, channel: ChannelIdValue): ChannelStateRecord {
    this.database
      .prepare('DELETE FROM channel_states WHERE tenant_id = ? AND channel = ?')
      .run(ownerId, channel);
    return this.getState(ownerId, channel);
  }

  updateContextToken(ownerId: string, channel: ChannelIdValue, contextToken: string): void {
    this.database
      .prepare(
        'UPDATE channel_states SET context_token = ?, updated_at = ? WHERE tenant_id = ? AND channel = ?',
      )
      .run(contextToken, isoTime(undefined, this.#clock), ownerId, channel);
  }

  updateInboundCursor(ownerId: string, channel: ChannelIdValue, cursor: string): void {
    this.database
      .prepare(
        'UPDATE channel_states SET inbound_cursor = ?, updated_at = ? WHERE tenant_id = ? AND channel = ?',
      )
      .run(cursor, isoTime(undefined, this.#clock), ownerId, channel);
  }

  recordInboundEvent(ownerId: string, channel: ChannelIdValue, externalMessageId: string): boolean {
    const result = this.database
      .prepare(
        'INSERT OR IGNORE INTO channel_inbound_events(tenant_id, channel, external_message_id, received_at) VALUES (?, ?, ?, ?)',
      )
      .run(ownerId, channel, externalMessageId, isoTime(undefined, this.#clock));
    return result.changes > 0;
  }

  recordMessageMap(input: {
    ownerId: string;
    channel: ChannelIdValue;
    externalMessageId: string;
    direction: 'inbound' | 'outbound';
    inputId?: string | null;
    messageSeq?: number | null;
    excerpt?: string;
  }): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO channel_message_map(
          tenant_id, channel, external_message_id, direction, input_id, message_seq, excerpt, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.ownerId,
        input.channel,
        input.externalMessageId,
        input.direction,
        input.inputId ?? null,
        input.messageSeq ?? null,
        (input.excerpt ?? '').slice(0, 500),
        isoTime(undefined, this.#clock),
      );
  }

  findMessageMap(
    ownerId: string,
    channel: ChannelIdValue,
    externalMessageId: string,
  ):
    | {
        direction: 'inbound' | 'outbound';
        inputId: string | null;
        messageSeq: number | null;
        excerpt: string;
      }
    | undefined {
    const row = this.database
      .prepare(
        `SELECT direction, input_id, message_seq, excerpt FROM channel_message_map
         WHERE tenant_id = ? AND channel = ? AND external_message_id = ?`,
      )
      .get(ownerId, channel, externalMessageId);
    if (row === undefined) return undefined;
    const parsed = z
      .object({
        direction: z.enum(['inbound', 'outbound']),
        input_id: z.string().nullable(),
        message_seq: z.number().int().positive().nullable(),
        excerpt: z.string(),
      })
      .parse(row);
    return {
      direction: parsed.direction,
      inputId: parsed.input_id,
      messageSeq: parsed.message_seq,
      excerpt: parsed.excerpt,
    };
  }

  messageSeqForInput(ownerId: string, inputId: string): number | undefined {
    const row = this.database
      .prepare(
        `SELECT seq FROM context_messages
         WHERE source_input_id = ? AND superseded_by_run_id IS NULL
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(inputId);
    void ownerId;
    return row === undefined
      ? undefined
      : z.object({ seq: z.number().int().positive() }).parse(row).seq;
  }

  messageSeqForMessageId(messageId: string): number | undefined {
    const row = this.database
      .prepare('SELECT seq FROM context_messages WHERE message_id = ?')
      .get(messageId);
    return row === undefined
      ? undefined
      : z.object({ seq: z.number().int().positive() }).parse(row).seq;
  }

  latestInboundMessageId(ownerId: string, channel: ChannelIdValue): string | undefined {
    const row = this.database
      .prepare(
        `SELECT external_message_id FROM channel_message_map
         WHERE tenant_id = ? AND channel = ? AND direction = 'inbound'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(ownerId, channel);
    return row === undefined
      ? undefined
      : z.object({ external_message_id: z.string() }).parse(row).external_message_id;
  }

  createDelivery(input: {
    ownerId: string;
    channel: ChannelIdValue;
    messageId?: string | null;
    toolCallId?: string | null;
    content: string;
    maxAttempts?: number;
    attachmentIds?: readonly string[];
  }): ChannelDeliveryRecord {
    const deliveryId = randomUUID();
    const now = isoTime(undefined, this.#clock);
    this.database
      .prepare(
        `INSERT INTO channel_deliveries(
          delivery_id, owner_id, channel, message_id, tool_call_id, content,
          status, attempts, max_attempts, next_attempt_at, attachment_ids_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        deliveryId,
        input.ownerId,
        input.channel,
        input.messageId ?? null,
        input.toolCallId ?? null,
        input.content,
        input.maxAttempts ?? defaultMaxAttempts,
        now,
        JSON.stringify(input.attachmentIds ?? []),
        now,
        now,
      );
    return this.getDelivery(input.ownerId, deliveryId);
  }

  getDelivery(ownerId: string, deliveryId: string): ChannelDeliveryRecord {
    const row = this.database
      .prepare('SELECT * FROM channel_deliveries WHERE delivery_id = ? AND owner_id = ?')
      .get(deliveryId, ownerId);
    if (row === undefined) {
      throw new ChannelDeliveryError(false, 'delivery_not_found', '投递记录不存在。');
    }
    return this.#toDelivery(deliveryRowSchema.parse(row));
  }

  listDeliveries(ownerId: string, deliveryIds: readonly string[]): ChannelDeliveryRecord[] {
    if (deliveryIds.length === 0) return [];
    const placeholders = deliveryIds.map(() => '?').join(', ');
    return this.database
      .prepare(
        `SELECT * FROM channel_deliveries WHERE owner_id = ? AND delivery_id IN (${placeholders})`,
      )
      .all(ownerId, ...deliveryIds)
      .map((row) => this.#toDelivery(deliveryRowSchema.parse(row)));
  }

  dueDeliveries(now: string, limit: number): ChannelDeliveryRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM channel_deliveries
         WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at, delivery_id LIMIT ?`,
      )
      .all(now, limit)
      .map((row) => this.#toDelivery(deliveryRowSchema.parse(row)));
  }

  recoverDelivering(): number {
    const now = isoTime(undefined, this.#clock);
    const result = this.database
      .prepare(
        "UPDATE channel_deliveries SET status = 'pending', updated_at = ? WHERE status = 'delivering'",
      )
      .run(now);
    return Number(result.changes);
  }

  markDelivering(ownerId: string, deliveryId: string): ChannelDeliveryRecord {
    const now = isoTime(undefined, this.#clock);
    this.database
      .prepare(
        `UPDATE channel_deliveries
         SET status = 'delivering', attempts = attempts + 1, updated_at = ?
         WHERE delivery_id = ? AND owner_id = ? AND status = 'pending'`,
      )
      .run(now, deliveryId, ownerId);
    return this.getDelivery(ownerId, deliveryId);
  }

  markSucceeded(ownerId: string, deliveryId: string): ChannelDeliveryRecord {
    const now = isoTime(undefined, this.#clock);
    this.database
      .prepare(
        `UPDATE channel_deliveries
         SET status = 'succeeded', last_error_code = NULL, last_error_message = NULL,
             last_error_retryable = NULL, next_attempt_at = NULL, updated_at = ?
         WHERE delivery_id = ? AND owner_id = ?`,
      )
      .run(now, deliveryId, ownerId);
    return this.getDelivery(ownerId, deliveryId);
  }

  markAttemptFailed(
    ownerId: string,
    deliveryId: string,
    error: { code: string; message: string; retryable: boolean },
    nextAttemptAt: string | null,
  ): ChannelDeliveryRecord {
    const now = isoTime(undefined, this.#clock);
    const record = this.getDelivery(ownerId, deliveryId);
    const exhausted = !error.retryable || record.attempts >= record.maxAttempts;
    this.database
      .prepare(
        `UPDATE channel_deliveries
         SET status = ?, last_error_code = ?, last_error_message = ?, last_error_retryable = ?,
             next_attempt_at = ?, updated_at = ?
         WHERE delivery_id = ? AND owner_id = ?`,
      )
      .run(
        exhausted ? 'failed' : 'pending',
        error.code,
        error.message,
        error.retryable ? 1 : 0,
        exhausted ? null : nextAttemptAt,
        now,
        deliveryId,
        ownerId,
      );
    return this.getDelivery(ownerId, deliveryId);
  }

  markNotified(ownerId: string, deliveryId: string): void {
    this.database
      .prepare(
        'UPDATE channel_deliveries SET notified_at = ?, updated_at = ? WHERE delivery_id = ? AND owner_id = ?',
      )
      .run(isoTime(undefined, this.#clock), isoTime(undefined, this.#clock), deliveryId, ownerId);
  }

  #toState(row: z.infer<typeof stateRowSchema>): ChannelStateRecord {
    return {
      channel: row.channel,
      status: row.status,
      accountLabel: row.account_label,
      externalUserId: row.external_user_id,
      hasCredentials: row.encrypted_credentials !== null,
      contextToken: row.context_token,
      inboundCursor: row.inbound_cursor,
      pairingCode: row.pairing_code,
      statusReason: row.status_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #toDelivery(row: z.infer<typeof deliveryRowSchema>): ChannelDeliveryRecord {
    return {
      deliveryId: row.delivery_id,
      ownerId: row.owner_id,
      channel: row.channel,
      messageId: row.message_id,
      toolCallId: row.tool_call_id,
      content: row.content,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastErrorCode: row.last_error_code,
      lastErrorMessage: row.last_error_message,
      lastErrorRetryable: row.last_error_retryable === null ? null : row.last_error_retryable === 1,
      nextAttemptAt: row.next_attempt_at,
      notifiedAt: row.notified_at,
      attachmentIds: z.array(z.string()).parse(JSON.parse(row.attachment_ids_json)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #upsert(
    ownerId: string,
    channel: ChannelIdValue,
    update: (previous: z.infer<typeof stateRowSchema> | undefined) => {
      status: ChannelStatus;
      accountLabel: string;
      externalUserId: string | null;
      credentials?: ChannelCredentials | null;
      credentialsRaw?: string | null;
      contextToken: string | null;
      inboundCursor: string;
      pairingCode: string | null;
      statusReason: string;
    },
  ): void {
    inTransaction(this.database, () => {
      const previousRow = this.database
        .prepare('SELECT * FROM channel_states WHERE tenant_id = ? AND channel = ?')
        .get(ownerId, channel);
      const previous = previousRow === undefined ? undefined : stateRowSchema.parse(previousRow);
      const next = update(previous);
      const encrypted =
        next.credentialsRaw !== undefined
          ? next.credentialsRaw
          : next.credentials === null || next.credentials === undefined
            ? null
            : this.#encrypt(ownerId, JSON.stringify(next.credentials));
      const now = isoTime(undefined, this.#clock);
      this.database
        .prepare(
          `INSERT INTO channel_states(
            tenant_id, channel, status, account_label, external_user_id, encrypted_credentials,
            context_token, inbound_cursor, pairing_code, status_reason, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, channel) DO UPDATE SET
            status = excluded.status, account_label = excluded.account_label,
            external_user_id = excluded.external_user_id,
            encrypted_credentials = excluded.encrypted_credentials,
            context_token = excluded.context_token, inbound_cursor = excluded.inbound_cursor,
            pairing_code = excluded.pairing_code, status_reason = excluded.status_reason,
            updated_at = excluded.updated_at`,
        )
        .run(
          ownerId,
          channel,
          next.status,
          next.accountLabel,
          next.externalUserId,
          encrypted,
          next.contextToken,
          next.inboundCursor,
          next.pairingCode,
          next.statusReason,
          previous?.created_at ?? now,
          now,
        );
    });
  }

  #encrypt(ownerId: string, value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(`${ownerId}:channels`));
    return Buffer.concat([
      iv,
      cipher.update(value, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64url');
  }

  #decrypt(ownerId: string, value: string): string {
    try {
      const bytes = Buffer.from(value, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${ownerId}:channels`));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      throw new ChannelDeliveryError(
        false,
        'credentials_unreadable',
        '渠道凭证无法解密，请重新配置渠道。',
      );
    }
  }
}
