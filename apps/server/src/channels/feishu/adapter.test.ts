import type * as lark from '@larksuiteoapi/node-sdk';
import { beforeEach, expect, it, vi } from 'vitest';
import { SessionStore } from '../../sessions/store.js';
import { openDatabase } from '../../storage/database.js';
import { ChannelStore } from '../store.js';
import { FeishuChannel } from './adapter.js';

const ws = vi.hoisted(() => ({
  instances: [] as Array<{
    options: ConstructorParameters<typeof lark.WSClient>[0];
    closed: boolean;
  }>,
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 'feishu' },
  LoggerLevel: { error: 0 },
  WSClient: class {
    item: { options: ConstructorParameters<typeof lark.WSClient>[0]; closed: boolean };
    constructor(options: ConstructorParameters<typeof lark.WSClient>[0]) {
      this.item = { options, closed: false };
      ws.instances.push(this.item);
    }
    start() {
      return Promise.resolve();
    }
    close() {
      this.item.closed = true;
    }
  },
  EventDispatcher: class {
    register() {
      return this;
    }
  },
}));
beforeEach(() => {
  ws.instances = [];
});
it('preserves the bound user while reconnecting and ignores stale socket callbacks', () => {
  const db = openDatabase(':memory:');
  new SessionStore(db);
  const store = new ChannelStore(db, 'test-channel-secret');
  store.saveFeishuCredentials(
    'o',
    { kind: 'feishu', appId: 'cli_0123456789abcdef', appSecret: 'secret' },
    '123456',
  );
  store.bindExternalUser('o', 'feishu', 'user');
  const channel = new FeishuChannel({ ownerId: () => 'o', store, onInbound: () => {} });
  try {
    channel.sync();
    const old = ws.instances[0];
    if (!old) throw Error('Missing client');
    channel.reconnect();
    const current = ws.instances[1];
    if (!current) throw Error('Missing replacement');
    expect(old.closed).toBe(true);
    expect(store.getState('o', 'feishu')).toMatchObject({
      status: 'pending_binding',
      externalUserId: 'user',
    });
    old.options.onError?.(new Error('late error'));
    expect(store.getState('o', 'feishu').status).toBe('pending_binding');
    current.options.onReady?.();
    expect(store.getState('o', 'feishu').status).toBe('active');
    current.options.onReconnecting?.();
    expect(store.getState('o', 'feishu').status).toBe('pending_binding');
    current.options.onReconnected?.();
    expect(store.getState('o', 'feishu').status).toBe('active');
  } finally {
    channel.stop();
    db.close();
  }
});
