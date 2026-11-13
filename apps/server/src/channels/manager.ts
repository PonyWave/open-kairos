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

export class ChannelManager {
  readonly store: ChannelStore;
  readonly wechat: WechatChannel;
  readonly feishu: FeishuChannel;
  readonly worker: ChannelDeliveryWorker;
  readonly #sessionStore: SessionStore;
  readonly #ownerId: () => string;
  readonly #deliver: (input: InputRecord, runId: string) => Promise<string>;

  constructor(options: {
    database: DatabaseSync;
    secret: string;
    sessionStore: SessionStore;
    ownerId: () => string;
    deliver: (input: InputRecord, runId: string) => Promise<string>;
    clock?: Clock;
    wechatClient?: WechatClientApi;
  }) {
    this.#sessionStore = options.sessionStore;
    this.#ownerId = options.ownerId;
    this.#deliver = options.deliver;
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
  }

  #handleInbound(message: InboundChannelMessage): void {
    try {
      const accepted = this.#sessionStore.acceptChannelInput({
        ownerId: this.#ownerId(),
        method: 'ChannelInbound',
        clientActionId: `channel-inbound:${message.channel}:${message.externalMessageId}`,
        parameters: {},
        text: message.text,
        channel: {
          channel: message.channel,
          kind: 'inbound',
          externalMessageId: message.externalMessageId,
        },
      });
      void this.#deliver(accepted.input, accepted.runId).catch((error: unknown) => {
        // 输入已持久化，调度失败时由后续重试或重启恢复。
        console.error('channel inbound deliver failed', error);
      });
    } catch (error) {
      // 入站入队失败（如取消中的 Run）不阻断渠道监听，消息由用户重发。
      console.error('channel inbound enqueue failed', error);
    }
  }
}
