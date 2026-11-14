import { expect, it, vi } from 'vitest';
import { seedTestTenant } from '../integration/environment-fixture.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { ChannelManager } from './manager.js';
import type { WechatClientApi } from './wechat/client.js';

const ownerId = 'channel-manager-owner';
const secret = 'channel-manager-test-secret-32char';

class StubWechatClient implements WechatClientApi {
  baseUrl = 'https://ilinkai.weixin.qq.com';

  async getBotQrcode(): Promise<never> {
    throw new Error('not used');
  }

  async pollQrcodeStatus(): Promise<never> {
    throw new Error('not used');
  }

  async getUpdates(): Promise<never> {
    throw new Error('not used');
  }

  async sendText(): Promise<void> {}

  async getConfig(): Promise<string | null> {
    return 'ticket-1';
  }

  async downloadMedia(): Promise<Uint8Array> {
    return new Uint8Array([1, 2, 3]);
  }

  async sendTyping(): Promise<void> {}

  async notifyLifecycle(): Promise<void> {}
}

it('delivers inbound wechat messages to the run coordinator', async () => {
  const database = openDatabase(':memory:');
  const sessionStore = new SessionStore(database);
  seedTestTenant(database, ownerId);
  const delivered: string[] = [];
  const manager = new ChannelManager({
    database,
    secret,
    sessionStore,
    ownerId: () => ownerId,
    deliver: (input, runId) => {
      delivered.push(input.inputId);
      return Promise.resolve(runId);
    },
    wechatClient: new StubWechatClient(),
  });
  try {
    manager.store.completeWechatLogin(ownerId, {
      kind: 'wechat',
      botToken: 'token-1',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botId: 'bot-1',
      ilinkUserId: 'user-1',
    });
    await manager.wechat.handleInboundMessage(ownerId, 'user-1', {
      message_type: 1,
      from_user_id: 'user-1',
      message_id: 42,
      context_token: 'ctx-1',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    });
    const thread = sessionStore.getOrCreateMainThread(ownerId);
    const inputs = sessionStore.listInputs(ownerId, thread.threadId);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.text).toContain('你好');
    expect(delivered).toEqual([inputs[0]?.inputId]);
  } finally {
    manager.stop();
    database.close();
  }
});

it('batches pure media messages and flushes them with a following text', async () => {
  const database = openDatabase(':memory:');
  const sessionStore = new SessionStore(database);
  seedTestTenant(database, ownerId);
  const manager = new ChannelManager({
    database,
    secret,
    sessionStore,
    ownerId: () => ownerId,
    deliver: () => Promise.resolve('run'),
    wechatClient: new StubWechatClient(),
    mediaBatchWindowMs: 60,
  });
  try {
    manager.store.completeWechatLogin(ownerId, {
      kind: 'wechat',
      botToken: 'token-1',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botId: 'bot-1',
      ilinkUserId: 'user-1',
    });
    await manager.wechat.handleInboundMessage(ownerId, 'user-1', {
      message_type: 1,
      from_user_id: 'user-1',
      message_id: 100,
      item_list: [
        {
          type: 4,
          file_item: {
            file_name: '报告.pdf',
            media: { encrypt_query_param: 'p', aes_key: 'aa'.repeat(16) },
          },
        },
      ],
    });
    const thread = sessionStore.getOrCreateMainThread(ownerId);
    expect(sessionStore.listInputs(ownerId, thread.threadId)).toHaveLength(0);
    await manager.wechat.handleInboundMessage(ownerId, 'user-1', {
      message_type: 1,
      from_user_id: 'user-1',
      message_id: 101,
      item_list: [{ type: 1, text_item: { text: '帮我看看这个文件' } }],
    });
    const inputs = sessionStore.listInputs(ownerId, thread.threadId);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.text).toBe('[文件: 报告.pdf]\n帮我看看这个文件');
    expect(inputs[0]?.mode).toBe('steer');
    expect(inputs[0]?.attachments).toHaveLength(1);
    expect(inputs[0]?.attachments?.[0]?.fileName).toBe('报告.pdf');
  } finally {
    manager.stop();
    database.close();
  }
});

it('flushes a pending media batch after the window without a following text', async () => {
  const database = openDatabase(':memory:');
  const sessionStore = new SessionStore(database);
  seedTestTenant(database, ownerId);
  const manager = new ChannelManager({
    database,
    secret,
    sessionStore,
    ownerId: () => ownerId,
    deliver: () => Promise.resolve('run'),
    wechatClient: new StubWechatClient(),
    mediaBatchWindowMs: 40,
  });
  try {
    manager.store.completeWechatLogin(ownerId, {
      kind: 'wechat',
      botToken: 'token-1',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botId: 'bot-1',
      ilinkUserId: 'user-1',
    });
    await manager.wechat.handleInboundMessage(ownerId, 'user-1', {
      message_type: 1,
      from_user_id: 'user-1',
      message_id: 200,
      item_list: [{ type: 2, image_item: { media: { full_url: 'https://cdn/x' } } }],
    });
    const thread = sessionStore.getOrCreateMainThread(ownerId);
    expect(sessionStore.listInputs(ownerId, thread.threadId)).toHaveLength(0);
    await vi.waitFor(() =>
      expect(sessionStore.listInputs(ownerId, thread.threadId)).toHaveLength(1),
    );
    const input = sessionStore.listInputs(ownerId, thread.threadId)[0];
    expect(input?.text).toBe('[图片]');
    expect(input?.attachments).toHaveLength(1);
  } finally {
    manager.stop();
    database.close();
  }
});

it('enqueues plain text immediately and marks it steer', async () => {
  const database = openDatabase(':memory:');
  const sessionStore = new SessionStore(database);
  seedTestTenant(database, ownerId);
  const manager = new ChannelManager({
    database,
    secret,
    sessionStore,
    ownerId: () => ownerId,
    deliver: () => Promise.resolve('run'),
    wechatClient: new StubWechatClient(),
  });
  try {
    manager.store.completeWechatLogin(ownerId, {
      kind: 'wechat',
      botToken: 'token-1',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botId: 'bot-1',
      ilinkUserId: 'user-1',
    });
    await manager.wechat.handleInboundMessage(ownerId, 'user-1', {
      message_type: 1,
      from_user_id: 'user-1',
      message_id: 300,
      item_list: [{ type: 1, text_item: { text: '直接发文字' } }],
    });
    const thread = sessionStore.getOrCreateMainThread(ownerId);
    const inputs = sessionStore.listInputs(ownerId, thread.threadId);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.mode).toBe('steer');
  } finally {
    manager.stop();
    database.close();
  }
});

it('records inbound message map entries and resolves quotes into the channel reference', async () => {
  const database = openDatabase(':memory:');
  const sessionStore = new SessionStore(database);
  seedTestTenant(database, ownerId);
  const manager = new ChannelManager({
    database,
    secret,
    sessionStore,
    ownerId: () => ownerId,
    deliver: () => Promise.resolve('run'),
    wechatClient: new StubWechatClient(),
  });
  try {
    manager.store.completeWechatLogin(ownerId, {
      kind: 'wechat',
      botToken: 'token-1',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botId: 'bot-1',
      ilinkUserId: 'user-1',
    });
    await manager.wechat.handleInboundMessage(ownerId, 'user-1', {
      message_type: 1,
      from_user_id: 'user-1',
      message_id: 400,
      item_list: [{ type: 1, text_item: { text: '原始问题' } }],
    });
    await manager.wechat.handleInboundMessage(ownerId, 'user-1', {
      message_type: 1,
      from_user_id: 'user-1',
      message_id: 401,
      item_list: [
        { type: 1, text_item: { text: '引用一下' } },
        { ref_msg: { svr_id: '400', title: '原始问题' } },
      ],
    });
    const mapped = manager.store.findMessageMap(ownerId, 'wechat', '400');
    expect(mapped?.direction).toBe('inbound');
    expect(mapped?.excerpt).toBe('原始问题');
    const thread = sessionStore.getOrCreateMainThread(ownerId);
    const inputs = sessionStore.listInputs(ownerId, thread.threadId);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.channel?.quoteExcerpt).toBe('原始问题');
  } finally {
    manager.stop();
    database.close();
  }
});
