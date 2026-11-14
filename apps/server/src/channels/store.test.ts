import { describe, expect, it } from 'vitest';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { ChannelStore } from './store.js';

const secret = 'channel-store-test-secret-32-characters';

function fixture() {
  const database = openDatabase(':memory:');
  new SessionStore(database);
  const store = new ChannelStore(database, secret);
  return { database, store };
}

describe('ChannelStore state', () => {
  it('starts unconfigured and completes the wechat login with encrypted credentials', () => {
    const { database, store } = fixture();
    try {
      expect(store.getState('owner', 'wechat').status).toBe('unconfigured');
      store.beginWechatLogin('owner');
      expect(store.getState('owner', 'wechat').status).toBe('pending_login');
      store.completeWechatLogin('owner', {
        kind: 'wechat',
        botToken: 'token-1',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        botId: 'bot-1',
        ilinkUserId: 'user-1',
      });
      const state = store.getState('owner', 'wechat');
      expect(state.status).toBe('active');
      expect(state.externalUserId).toBe('user-1');
      expect(state.hasCredentials).toBe(true);
      expect(store.getCredentials('owner', 'wechat')).toEqual({
        kind: 'wechat',
        botToken: 'token-1',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        botId: 'bot-1',
        ilinkUserId: 'user-1',
      });
      const raw = database
        .prepare(
          "SELECT encrypted_credentials FROM channel_states WHERE tenant_id = 'owner' AND channel = 'wechat'",
        )
        .get() as { encrypted_credentials: string };
      expect(raw.encrypted_credentials).not.toContain('token-1');
    } finally {
      database.close();
    }
  });

  it('saves feishu credentials pending binding and binds an external user', () => {
    const { database, store } = fixture();
    try {
      store.saveFeishuCredentials(
        'owner',
        { kind: 'feishu', appId: 'cli_1', appSecret: 's' },
        '123456',
      );
      let state = store.getState('owner', 'feishu');
      expect(state.status).toBe('pending_binding');
      expect(state.pairingCode).toBe('123456');
      store.bindExternalUser('owner', 'feishu', 'ou_1');
      state = store.getState('owner', 'feishu');
      expect(state.status).toBe('active');
      expect(state.externalUserId).toBe('ou_1');
      expect(state.pairingCode).toBeNull();
      store.unbind('owner', 'feishu');
      expect(store.getState('owner', 'feishu').status).toBe('unconfigured');
      expect(store.getCredentials('owner', 'feishu')).toBeNull();
    } finally {
      database.close();
    }
  });

  it('deduplicates inbound events per channel and message id', () => {
    const { database, store } = fixture();
    try {
      expect(store.recordInboundEvent('owner', 'wechat', 'm1')).toBe(true);
      expect(store.recordInboundEvent('owner', 'wechat', 'm1')).toBe(false);
      expect(store.recordInboundEvent('owner', 'feishu', 'm1')).toBe(true);
    } finally {
      database.close();
    }
  });
});

describe('ChannelStore deliveries', () => {
  it('runs the retry lifecycle until exhaustion', () => {
    const { database, store } = fixture();
    try {
      const created = store.createDelivery({
        ownerId: 'owner',
        channel: 'wechat',
        content: '你好',
        maxAttempts: 2,
      });
      expect(created.status).toBe('pending');
      expect(store.dueDeliveries(new Date().toISOString(), 10)).toHaveLength(1);
      store.markDelivering('owner', created.deliveryId);
      let record = store.markAttemptFailed(
        'owner',
        created.deliveryId,
        { code: 'network_error', message: '超时', retryable: true },
        new Date(Date.now() + 60_000).toISOString(),
      );
      expect(record.status).toBe('pending');
      expect(record.attempts).toBe(1);
      expect(store.dueDeliveries(new Date().toISOString(), 10)).toHaveLength(0);
      store.markDelivering('owner', created.deliveryId);
      record = store.markAttemptFailed(
        'owner',
        created.deliveryId,
        { code: 'network_error', message: '超时', retryable: true },
        new Date(Date.now() + 60_000).toISOString(),
      );
      expect(record.status).toBe('failed');
      expect(record.lastErrorCode).toBe('network_error');
      store.markDelivering('owner', created.deliveryId);
      expect(store.markSucceeded('owner', created.deliveryId).status).toBe('succeeded');
    } finally {
      database.close();
    }
  });

  it('fails immediately for non-retryable errors', () => {
    const { database, store } = fixture();
    try {
      const created = store.createDelivery({ ownerId: 'owner', channel: 'feishu', content: 'x' });
      store.markDelivering('owner', created.deliveryId);
      const record = store.markAttemptFailed(
        'owner',
        created.deliveryId,
        { code: 'auth_invalid', message: '凭证无效', retryable: false },
        new Date(Date.now() + 60_000).toISOString(),
      );
      expect(record.status).toBe('failed');
      expect(record.lastErrorRetryable).toBe(false);
    } finally {
      database.close();
    }
  });
});

describe('ChannelStore.listDeliveries', () => {
  it('returns only the requested deliveries owned by the tenant', () => {
    const { database, store } = fixture();
    try {
      const first = store.createDelivery({ ownerId: 'owner', channel: 'wechat', content: 'a' });
      const second = store.createDelivery({ ownerId: 'owner', channel: 'feishu', content: 'b' });
      store.createDelivery({ ownerId: 'other', channel: 'feishu', content: 'c' });
      const deliveries = store.listDeliveries('owner', [first.deliveryId, second.deliveryId]);
      expect(deliveries.map((delivery) => delivery.deliveryId).sort()).toEqual(
        [first.deliveryId, second.deliveryId].sort(),
      );
      expect(store.listDeliveries('owner', [])).toEqual([]);
      expect(store.listDeliveries('owner', ['missing'])).toEqual([]);
    } finally {
      database.close();
    }
  });
});
