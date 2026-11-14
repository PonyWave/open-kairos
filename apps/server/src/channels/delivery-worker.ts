import type { ChannelReference } from '../context/types.js';
import { isoTime, systemClock } from '../context/types.js';
import type { InputRecord } from '../sessions/records.js';
import type { SessionStore } from '../sessions/store.js';
import { wrapSystemReminder } from '../sessions/system-reminder.js';
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
        "SELECT delivery_id FROM channel_deliveries WHERE owner_id = ? AND status = 'failed' AND notified_at IS NULL ORDER BY created_at, delivery_id LIMIT 10",
      )
      .all(ownerId);
    for (const row of rows) {
      const { delivery_id: deliveryId } = row as { delivery_id: string };
      const delivery = this.#options.channelStore.getDelivery(ownerId, deliveryId);
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
}

function failureReference(delivery: ChannelDeliveryRecord): ChannelReference {
  return { channel: delivery.channel, kind: 'delivery_failure', deliveryId: delivery.deliveryId };
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
