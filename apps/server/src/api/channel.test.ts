import { createClient, createRouterTransport } from '@connectrpc/connect';
import { ChannelId, ChannelLoginState, ChannelService } from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { ChannelManager } from '../channels/manager.js';
import {
  createTestAuthentication,
  testSessionInterceptor,
} from '../integration/test-authentication.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { registerChannelRoutes } from './channel.js';

it('retains configured credentials on explicit reconnect and validates replacement credentials', async () => {
  const db = openDatabase(':memory:');
  const sessions = new SessionStore(db);
  const authentication = createTestAuthentication(db, 'channel-user');
  const manager = new ChannelManager({
    database: db,
    secret: 'channel-test-secret',
    sessionStore: sessions,
    ownerId: () => 'channel-user',
    deliver: (_input, runId) => Promise.resolve(runId),
  });
  const reconnect = vi.spyOn(manager.feishu, 'reconnect').mockImplementation(() => {});
  const client = createClient(
    ChannelService,
    createRouterTransport((router) => registerChannelRoutes(router, manager, authentication), {
      transport: { interceptors: [testSessionInterceptor()] },
    }),
  );
  try {
    const appId = 'cli_0123456789abcdef';
    const saved = await client.saveFeishuCredentials({
      clientActionId: 'save-1',
      appId,
      appSecret: 'original',
    });
    expect(saved.state).toMatchObject({ configured: true, loginState: ChannelLoginState.PENDING });
    expect(saved.state?.pairingCode).toMatch(/^\d{6}$/);
    await client.saveFeishuCredentials({ clientActionId: 'save-2', appId, preserveSecret: true });
    expect(manager.store.getCredentials('channel-user', 'feishu')).toMatchObject({
      appSecret: 'original',
    });
    await expect(
      client.saveFeishuCredentials({
        clientActionId: 'save-3',
        appId: 'cli_fedcba9876543210',
        preserveSecret: true,
      }),
    ).rejects.toThrow();
    await expect(
      client.saveFeishuCredentials({ clientActionId: 'bad', appId: 'bad-id', appSecret: 'secret' }),
    ).rejects.toThrow(/App ID/);
    await client.reconnectChannel({ clientActionId: 'reconnect-1', channel: ChannelId.FEISHU });
    expect(reconnect).toHaveBeenCalledTimes(3);
    expect(
      (await client.getChannelStates({})).states.find((s) => s.channel === ChannelId.FEISHU)
        ?.configured,
    ).toBe(true);
    await client.unbindChannel({ clientActionId: 'remove-1', channel: ChannelId.FEISHU });
    expect(manager.store.getCredentials('channel-user', 'feishu')).toBeNull();
  } finally {
    manager.stop();
    db.close();
  }
});
