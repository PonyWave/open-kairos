import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../context/types.js';
import type { InputRecord } from '../sessions/records.js';
import type { SessionStore } from '../sessions/store.js';
import { ChannelDeliveryWorker } from './delivery-worker.js';
import { FeishuChannel } from './feishu/adapter.js';
import { ChannelStore } from './store.js';
import type { InboundChannelMessage } from './wechat/adapter.js';
import { WechatChannel } from './wechat/adapter.js';
import type { WechatClientApi } from './wechat/client.js';

interface PendingMediaBatch {
  texts: string[];
  attachmentIds: string[];
  externalMessageIds: string[];
  timer: ReturnType<typeof setTimeout>;
}

const placeholderLine = /^\[(?:图片|语音|文件(?:: .+)?|视频)\]$/;

function hasUserText(text: string): boolean {
  return text
    .split('\n')
    .some((line) => line.trim().length > 0 && !placeholderLine.test(line.trim()));
}

export class ChannelManager {
  readonly store: ChannelStore;
  readonly wechat: WechatChannel;
  readonly feishu: FeishuChannel;
  readonly worker: ChannelDeliveryWorker;
  readonly #sessionStore: SessionStore;
  readonly #ownerId: () => string;
  readonly #deliver: (input: InputRecord, runId: string) => Promise<string>;
  readonly #mediaBatchWindowMs: number;
  readonly #mediaBatches = new Map<string, PendingMediaBatch>();

  constructor(options: {
    database: DatabaseSync;
    secret: string;
    sessionStore: SessionStore;
    ownerId: () => string;
    deliver: (input: InputRecord, runId: string) => Promise<string>;
    clock?: Clock;
    wechatClient?: WechatClientApi;
    mediaBatchWindowMs?: number;
  }) {
    this.#sessionStore = options.sessionStore;
    this.#ownerId = options.ownerId;
    this.#deliver = options.deliver;
    this.#mediaBatchWindowMs = options.mediaBatchWindowMs ?? 5_000;
    this.store = new ChannelStore(
      options.database,
      options.secret,
      ...(options.clock === undefined ? [] : [options.clock]),
    );
    const onInbound = (message: InboundChannelMessage) => this.#handleInbound(message);
    this.wechat = new WechatChannel({
      ownerId: options.ownerId,
      store: this.store,
      onInbound,
      ...(options.wechatClient === undefined ? {} : { client: options.wechatClient }),
    });
    this.feishu = new FeishuChannel({
      ownerId: options.ownerId,
      store: this.store,
      onInbound,
    });
    this.worker = new ChannelDeliveryWorker({
      channelStore: this.store,
      sessionStore: options.sessionStore,
      ownerId: options.ownerId,
      channels: { wechat: this.wechat, feishu: this.feishu },
      deliver: options.deliver,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
  }

  start(): void {
    this.wechat.sync();
    this.feishu.sync();
    this.worker.start();
  }

  stop(): void {
    this.worker.stop();
    this.wechat.stop();
    this.feishu.stop();
    for (const key of [...this.#mediaBatches.keys()]) {
      this.#flushMediaBatch(key);
    }
  }

  #handleInbound(message: InboundChannelMessage): void {
    try {
      const attachmentIds = (message.media ?? []).map(
        (media) =>
          this.#sessionStore.attachments.uploadChannel({
            ownerId: this.#ownerId(),
            fileName: media.fileName,
            bytes: media.bytes,
          }).attachmentId,
      );
      const key = `${message.channel}:${message.externalUserId}`;
      const batch = this.#mediaBatches.get(key);
      if (attachmentIds.length > 0 && !hasUserText(message.text)) {
        if (batch !== undefined) {
          batch.attachmentIds.push(...attachmentIds);
          batch.externalMessageIds.push(message.externalMessageId);
          if (message.text.trim().length > 0) batch.texts.push(message.text);
          clearTimeout(batch.timer);
          batch.timer = this.#batchTimer(key);
        } else {
          this.#mediaBatches.set(key, {
            texts: message.text.trim().length > 0 ? [message.text] : [],
            attachmentIds: [...attachmentIds],
            externalMessageIds: [message.externalMessageId],
            timer: this.#batchTimer(key),
          });
        }
        return;
      }
      if (batch !== undefined) {
        clearTimeout(batch.timer);
        this.#mediaBatches.delete(key);
        if (message.text.trim().length > 0) batch.texts.push(message.text);
        batch.attachmentIds.push(...attachmentIds);
        batch.externalMessageIds.push(message.externalMessageId);
        this.#enqueue({
          channel: message.channel,
          externalUserId: message.externalUserId,
          externalMessageIds: batch.externalMessageIds,
          batchKey: `channel-inbound-batch:${message.channel}:${batch.externalMessageIds[0] ?? message.externalMessageId}`,
          text: batch.texts.join('\n'),
          attachmentIds: batch.attachmentIds,
          ...(message.quote === undefined ? {} : { quote: message.quote }),
        });
        return;
      }
      this.#enqueue({
        channel: message.channel,
        externalUserId: message.externalUserId,
        externalMessageIds: [message.externalMessageId],
        batchKey: `channel-inbound:${message.channel}:${message.externalMessageId}`,
        text: message.text,
        attachmentIds,
        ...(message.quote === undefined ? {} : { quote: message.quote }),
      });
    } catch (error) {
      // 入站入队失败（如取消中的 Run）不阻断渠道监听，消息由用户重发。
      console.error('channel inbound enqueue failed', error);
    }
  }

  #batchTimer(key: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.#flushMediaBatch(key), this.#mediaBatchWindowMs);
    timer.unref();
    return timer;
  }

  #flushMediaBatch(key: string): void {
    const batch = this.#mediaBatches.get(key);
    if (batch === undefined) return;
    clearTimeout(batch.timer);
    this.#mediaBatches.delete(key);
    const channel = key.startsWith('wechat:') ? 'wechat' : 'feishu';
    this.#enqueue({
      channel,
      externalUserId: key.slice(channel.length + 1),
      externalMessageIds: batch.externalMessageIds,
      batchKey: `channel-inbound-batch:${channel}:${batch.externalMessageIds[0] ?? key}`,
      text: batch.texts.join('\n'),
      attachmentIds: batch.attachmentIds,
    });
  }

  #enqueue(input: {
    channel: 'wechat' | 'feishu';
    externalUserId: string;
    externalMessageIds: string[];
    batchKey: string;
    text: string;
    attachmentIds: string[];
    quote?: { quoteSeq?: number | null; quoteExcerpt?: string | null };
  }): void {
    const accepted = this.#sessionStore.acceptChannelInput({
      ownerId: this.#ownerId(),
      method: 'ChannelInbound',
      clientActionId: input.batchKey,
      parameters: {},
      text: input.text,
      channel: {
        channel: input.channel,
        kind: 'inbound',
        externalMessageId: input.externalMessageIds[0] ?? input.batchKey,
        ...(input.quote === undefined ? {} : input.quote),
      },
      ...(input.attachmentIds.length === 0 ? {} : { attachmentIds: input.attachmentIds }),
    });
    for (const externalMessageId of input.externalMessageIds) {
      this.store.recordMessageMap({
        ownerId: this.#ownerId(),
        channel: input.channel,
        externalMessageId,
        direction: 'inbound',
        inputId: accepted.input.inputId,
        excerpt: input.text.slice(0, 500),
      });
    }
    void this.#deliver(accepted.input, accepted.runId).catch((error: unknown) => {
      // 输入已持久化，调度失败时由后续重试或重启恢复。
      console.error('channel inbound deliver failed', error);
    });
  }
}
