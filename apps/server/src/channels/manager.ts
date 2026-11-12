import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../context/types.js';
import type { SessionStore } from '../sessions/store.js';
import { ChannelDeliveryWorker } from './delivery-worker.js';
import { FeishuChannel } from './feishu/adapter.js';
import { ChannelStore } from './store.js';
import type { InboundChannelMessage } from './wechat/adapter.js';
import { WechatChannel } from './wechat/adapter.js';
import type { WechatClient } from './wechat/client.js';

export class ChannelManager {
  readonly store: ChannelStore;
  readonly wechat: WechatChannel;
  readonly feishu: FeishuChannel;
  readonly worker: ChannelDeliveryWorker;
  readonly #sessionStore: SessionStore;
  readonly #ownerId: () => string;

  constructor(options: {
    database: DatabaseSync;
    secret: string;
    sessionStore: SessionStore;
    ownerId: () => string;
    clock?: Clock;
    wechatClient?: WechatClient;
  }) {
    this.#sessionStore = options.sessionStore;
    this.#ownerId = options.ownerId;
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
    const prefix = message.channel === 'wechat' ? '[来自微信]' : '[来自飞书]';
    try {
      this.#sessionStore.acceptChannelInput({
        ownerId: this.#ownerId(),
        method: 'ChannelInbound',
        clientActionId: `channel-inbound:${message.channel}:${message.externalMessageId}`,
        parameters: {},
        text: `${prefix}\n${message.text}`,
        channel: {
          channel: message.channel,
          kind: 'inbound',
          externalMessageId: message.externalMessageId,
        },
      });
    } catch (error) {
      // 入站入队失败（如取消中的 Run）不阻断渠道监听，消息由用户重发。
      console.error('channel inbound enqueue failed', error);
    }
  }
}
