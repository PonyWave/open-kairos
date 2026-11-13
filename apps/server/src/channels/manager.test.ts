import { expect, it } from 'vitest';
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
