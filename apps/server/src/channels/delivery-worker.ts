import { z } from 'zod';
import type { ChannelReference } from '../context/types.js';
import { isoTime, systemClock } from '../context/types.js';
import type { InputRecord } from '../sessions/records.js';
import type { SessionStore } from '../sessions/store.js';
import { wrapSystemReminder } from '../sessions/system-reminder.js';
import { parseChannelJson } from './reference.js';
import type { ChannelDeliveryRecord, ChannelIdValue, ChannelStore } from './store.js';
import { ChannelDeliveryError } from './store.js';

export interface OutboundAttachment {
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface OutboundChannel {
  send(
    input: {
      externalUserId: string;
      contextToken: string | null;
      markdown: string;
      attachments?: OutboundAttachment[];
    },
    signal: AbortSignal,
  ): Promise<{ externalMessageId?: string } | void>;
}

export interface DeliveryWorkerOptions {
  channelStore: ChannelStore;
  sessionStore: SessionStore;
  ownerId: () => string;
  channels: Partial<Record<ChannelIdValue, OutboundChannel>>;
  deliver: (input: InputRecord, runId: string) => Promise<string>;
  pollIntervalMs?: number;
  retryDelaysMs?: readonly number[];
  sendTimeoutMs?: number;
  clock?: () => Date;
}

const defaultRetryDelaysMs = [2_000, 10_000, 30_000] as const;
const runFailureNoticeWindowMs = 15 * 60 * 1000;

const runFailureRowSchema = z.object({
  run_id: z.string(),
  error_message: z.string().nullable(),
  error_retryable: z.union([z.literal(0), z.literal(1)]).nullable(),
  channel_json: z.string(),
  excerpt: z.string(),
});

export class ChannelDeliveryWorker {
  readonly #options: DeliveryWorkerOptions;
  readonly #clock: () => Date;
  readonly #retryDelaysMs: readonly number[];
  #timer: ReturnType<typeof setInterval> | undefined;
  #processing = false;
  #stopped = false;

  constructor(options: DeliveryWorkerOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#retryDelaysMs = options.retryDelaysMs ?? defaultRetryDelaysMs;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#stopped = false;
    this.#options.channelStore.recoverDelivering();
    this.#timer = setInterval(() => {
      void this.processNow().catch(() => undefined);
    }, this.#options.pollIntervalMs ?? 1_000);
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async processNow(): Promise<void> {
    if (this.#processing || this.#stopped) return;
    this.#processing = true;
    try {
      await this.#processDue();
      await this.#notifyFailures();
      await this.#notifyRunFailures();
    } finally {
      this.#processing = false;
    }
  }

  async #processDue(): Promise<void> {
    const ownerId = this.#options.ownerId();
    const now = isoTime(undefined, this.#clock);
    for (const delivery of this.#options.channelStore.dueDeliveries(now, 10)) {
      if (this.#stopped) return;
      await this.#attempt(ownerId, delivery);
    }
  }

  async #attempt(ownerId: string, delivery: ChannelDeliveryRecord): Promise<void> {
    const store = this.#options.channelStore;
    const claimed = store.markDelivering(ownerId, delivery.deliveryId);
    try {
      const adapter = this.#options.channels[delivery.channel];
      if (adapter === undefined) {
        throw new ChannelDeliveryError(
          false,
          'channel_not_configured',
          `${delivery.channel === 'wechat' ? '微信' : '飞书'}渠道未配置。`,
        );
      }
      const state = store.getState(ownerId, delivery.channel);
      if (state.status !== 'active' || state.externalUserId === null) {
        throw new ChannelDeliveryError(
          false,
          'channel_not_bound',
          `${delivery.channel === 'wechat' ? '微信' : '飞书'}渠道未登录或未绑定用户。`,
        );
      }
      const timeout = AbortSignal.timeout(this.#options.sendTimeoutMs ?? 60_000);
      const attachments = claimed.attachmentIds.map((attachmentId) => {
        const content = this.#options.sessionStore.attachments.readForWorkspace(
          ownerId,
          attachmentId,
        );
        return {
          fileName: content.fileName,
          mediaType: content.mediaType,
          bytes: content.bytes,
        };
      });
      const sent = await adapter.send(
        {
          externalUserId: state.externalUserId,
          contextToken: state.contextToken,
          markdown: claimed.content,
          ...(attachments.length === 0 ? {} : { attachments }),
        },
        timeout,
      );
      store.markSucceeded(ownerId, delivery.deliveryId);
      if (sent !== undefined && sent.externalMessageId !== undefined) {
        store.recordMessageMap({
          ownerId,
          channel: delivery.channel,
          externalMessageId: sent.externalMessageId,
          direction: 'outbound',
          messageSeq:
            claimed.messageId === null
              ? null
              : (store.messageSeqForMessageId(claimed.messageId) ?? null),
          excerpt: claimed.content.slice(0, 500),
        });
      }
    } catch (error) {
      const classified =
        error instanceof ChannelDeliveryError
          ? error
          : new ChannelDeliveryError(
              true,
              'delivery_error',
              error instanceof Error ? error.message : String(error),
            );
      const staleToken = classified.code === 'wechat_ret_-2';
      const retryDelay = staleToken ? 300_000 : this.#retryDelaysMs[claimed.attempts - 1];
      const nextAttemptAt =
        classified.retryable &&
        retryDelay !== undefined &&
        (staleToken || claimed.attempts < claimed.maxAttempts)
          ? new Date(this.#clock().getTime() + retryDelay).toISOString()
          : null;
      store.markAttemptFailed(
        ownerId,
        delivery.deliveryId,
        { code: classified.code, message: classified.message, retryable: classified.retryable },
        nextAttemptAt,
        { countAttempt: !staleToken },
      );
    }
  }

  async #notifyFailures(): Promise<void> {
    const ownerId = this.#options.ownerId();
    const rows = this.#options.channelStore.database
      .prepare(
        "SELECT delivery_id FROM channel_deliveries WHERE owner_id = ? AND status = 'failed' AND kind = 'message' AND notified_at IS NULL ORDER BY created_at, delivery_id LIMIT 10",
      )
      .all(ownerId);
    for (const row of rows) {
      const { delivery_id: deliveryId } = row as { delivery_id: string };
      const delivery = this.#options.channelStore.getDelivery(ownerId, deliveryId);
      this.#options.channelStore.createDelivery({
        ownerId,
        channel: delivery.channel,
        kind: 'failure_notice',
        dedupKey: `delivery-failure:${delivery.deliveryId}`,
        content: deliveryFailureNoticeText(delivery),
      });
      const accepted = this.#options.sessionStore.acceptChannelInput({
        ownerId,
        method: 'ChannelDeliveryFailure',
        clientActionId: `channel-delivery-failure:${delivery.deliveryId}:${delivery.attempts}`,
        parameters: {},
        text: failureNoticeText(delivery),
        channel: failureReference(delivery),
      });
      this.#options.channelStore.markNotified(ownerId, delivery.deliveryId);
      try {
        await this.#options.deliver(accepted.input, accepted.runId);
      } catch (error) {
        // 失败通知已持久化，调度失败不阻断后续通知。
        console.error('channel delivery failure notice deliver failed', error);
      }
    }
  }

  async #notifyRunFailures(): Promise<void> {
    const ownerId = this.#options.ownerId();
    const since = new Date(this.#clock().getTime() - runFailureNoticeWindowMs).toISOString();
    const rows = this.#options.channelStore.database
      .prepare(
        `SELECT r.run_id, r.error_message, r.error_retryable, i.channel_json, substr(i.text, 1, 200) AS excerpt
         FROM runs r JOIN inputs i ON i.consumed_run_id = r.run_id
         WHERE r.owner_id = ? AND r.status IN ('failed', 'interrupted') AND r.finished_at >= ?
           AND i.channel_json IS NOT NULL
         ORDER BY r.finished_at, r.run_id, i.position`,
      )
      .all(ownerId, since);
    const seen = new Set<string>();
    for (const row of rows) {
      const parsed = runFailureRowSchema.parse(row);
      const channel = parseChannelJson(parsed.channel_json);
      if (channel === null || channel.kind !== 'inbound') continue;
      const key = `${parsed.run_id}:${channel.channel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.#options.channelStore.createDelivery({
        ownerId,
        channel: channel.channel,
        kind: 'failure_notice',
        dedupKey: `run-failure:${key}`,
        content: runFailureNoticeText({
          errorMessage: parsed.error_message,
          retryable: parsed.error_retryable === null ? null : parsed.error_retryable === 1,
          excerpt: parsed.excerpt,
        }),
      });
    }
  }
}

function failureReference(delivery: ChannelDeliveryRecord): ChannelReference {
  return { channel: delivery.channel, kind: 'delivery_failure', deliveryId: delivery.deliveryId };
}

export function runFailureNoticeText(input: {
  errorMessage: string | null;
  retryable: boolean | null;
  excerpt: string;
}): string {
  const lines = [
    '【处理失败】你发送的消息未能完成处理。',
    `原因：${input.errorMessage ?? '未知错误'}`,
    input.retryable === false
      ? '请在 GUI 中查看详情，调整后再试。'
      : '这通常是临时问题，请重新发送。',
  ];
  const excerpt = input.excerpt.trim().slice(0, 100);
  if (excerpt) lines.push(`原文：${excerpt}`);
  return lines.join('\n');
}

export function deliveryFailureNoticeText(delivery: ChannelDeliveryRecord): string {
  const channelName = delivery.channel === 'wechat' ? '微信' : '飞书';
  const lines = [
    `【发送失败】一条消息未能送达${channelName}。`,
    `原因：${delivery.lastErrorMessage ?? '未知错误'}`,
  ];
  const excerpt = delivery.content.trim().slice(0, 100);
  if (excerpt) lines.push(`原文摘要：${excerpt}`);
  return lines.join('\n');
}

export function failureNoticeText(delivery: ChannelDeliveryRecord): string {
  const channelName = delivery.channel === 'wechat' ? '微信' : '飞书';
  const attempts = `${delivery.attempts}/${delivery.maxAttempts}`;
  const lines = [
    `[Channel delivery failure] A send_to_user delivery to ${channelName} (${delivery.channel}) failed.`,
    `delivery_id: ${delivery.deliveryId}`,
    `error: ${delivery.lastErrorCode ?? 'unknown'} - ${delivery.lastErrorMessage ?? ''}`,
    `attempts: ${attempts}`,
    `retryable: ${delivery.lastErrorRetryable === true ? 'yes' : 'no'}`,
    `original content: ${delivery.content}`,
  ];
  if (delivery.lastErrorCode === 'wechat_ret_-2') {
    lines.push(
      'guidance: The WeChat session token is stale, so this delivery stays queued and is retried automatically when the user next sends a message. Do not resend it yourself.',
    );
  } else if (delivery.lastErrorRetryable === true) {
    lines.push(
      'guidance: This is a transient error. You may retry by resending the same message with the channels parameter; the GUI copy will appear again, so prefer retrying only when the IM copy matters.',
    );
  } else {
    lines.push(
      `guidance: Do not retry; the failure is not transient. Inform the user in the GUI that the ${channelName} channel needs attention in the channel settings (for example a missing login or an expired session), and continue the conversation in the GUI.`,
    );
  }
  return wrapSystemReminder(lines.join('\n'));
}
