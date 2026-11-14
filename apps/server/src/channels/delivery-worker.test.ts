import { expect, it } from 'vitest';
import { seedTestTenant } from '../integration/environment-fixture.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { ChannelDeliveryWorker } from './delivery-worker.js';
import { ChannelDeliveryError, ChannelStore } from './store.js';

const ownerId = 'channel-worker-owner';
const secret = 'channel-worker-test-secret-32-characters';

function fixture() {
  const database = openDatabase(':memory:');
  const sessionStore = new SessionStore(database);
  seedTestTenant(database, ownerId);
  let now = new Date('2026-11-13T00:00:00.000Z');
  const clock = () => now;
  const channelStore = new ChannelStore(database, secret, clock);
  const sent: { externalUserId: string; markdown: string }[] = [];
  let failure: ChannelDeliveryError | null = null;
  const adapter = {
    send: async (input: { externalUserId: string; markdown: string }) => {
      if (failure !== null) throw failure;
      sent.push({ externalUserId: input.externalUserId, markdown: input.markdown });
    },
  };
  const delivered: string[] = [];
  const worker = new ChannelDeliveryWorker({
    channelStore,
    sessionStore,
    ownerId: () => ownerId,
    channels: { feishu: adapter },
    deliver: (input, runId) => {
      delivered.push(input.inputId);
      return Promise.resolve(runId);
    },
    clock,
    retryDelaysMs: [2_000, 10_000, 30_000],
  });
  const bindFeishu = () => {
    channelStore.saveFeishuCredentials(
      ownerId,
      { kind: 'feishu', appId: 'cli_1', appSecret: 's' },
      '123456',
    );
    channelStore.bindExternalUser(ownerId, 'feishu', 'ou_1');
  };
  return {
    database,
    sessionStore,
    channelStore,
    worker,
    sent,
    delivered,
    bindFeishu,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    fail: (error: ChannelDeliveryError | null) => {
      failure = error;
    },
  };
}

function mainInputs(sessionStore: SessionStore) {
  const thread = sessionStore.getOrCreateMainThread(ownerId);
  return sessionStore.listInputs(ownerId, thread.threadId);
}

it('delivers a pending delivery through the bound channel', async () => {
  const value = fixture();
  try {
    value.bindFeishu();
    const delivery = value.channelStore.createDelivery({
      ownerId,
      channel: 'feishu',
      content: '**结果**\n\n完成。',
    });
    await value.worker.processNow();
    expect(value.sent).toEqual([{ externalUserId: 'ou_1', markdown: '**结果**\n\n完成。' }]);
    expect(value.channelStore.getDelivery(ownerId, delivery.deliveryId).status).toBe('succeeded');
    expect(mainInputs(value.sessionStore)).toHaveLength(0);
  } finally {
    value.database.close();
  }
});

it('retries transient failures with backoff and then succeeds', async () => {
  const value = fixture();
  try {
    value.bindFeishu();
    const delivery = value.channelStore.createDelivery({
      ownerId,
      channel: 'feishu',
      content: '重试内容',
    });
    value.fail(new ChannelDeliveryError(true, 'network_error', '网络超时'));
    await value.worker.processNow();
    let record = value.channelStore.getDelivery(ownerId, delivery.deliveryId);
    expect(record.status).toBe('pending');
    expect(record.attempts).toBe(1);
    await value.worker.processNow();
    expect(value.channelStore.getDelivery(ownerId, delivery.deliveryId).attempts).toBe(1);
    value.advance(2_000);
    value.fail(null);
    await value.worker.processNow();
    record = value.channelStore.getDelivery(ownerId, delivery.deliveryId);
    expect(record.status).toBe('succeeded');
    expect(value.sent).toHaveLength(1);
    expect(mainInputs(value.sessionStore)).toHaveLength(0);
  } finally {
    value.database.close();
  }
});

it('notifies main with retry guidance after retries are exhausted', async () => {
  const value = fixture();
  try {
    value.bindFeishu();
    const delivery = value.channelStore.createDelivery({
      ownerId,
      channel: 'feishu',
      content: '最终内容',
      maxAttempts: 2,
    });
    value.fail(new ChannelDeliveryError(true, 'network_error', '网络超时'));
    await value.worker.processNow();
    value.advance(2_000);
    await value.worker.processNow();
    const record = value.channelStore.getDelivery(ownerId, delivery.deliveryId);
    expect(record.status).toBe('failed');
    expect(record.notifiedAt).not.toBeNull();
    const inputs = mainInputs(value.sessionStore);
    expect(inputs).toHaveLength(1);
    const notice = inputs[0];
    expect(notice?.source).toBe('channel');
    expect(notice?.channel).toEqual({
      channel: 'feishu',
      kind: 'delivery_failure',
      deliveryId: delivery.deliveryId,
    });
    expect(notice?.text).toContain('network_error');
    expect(notice?.text).toContain('retryable: yes');
    expect(notice?.text).toContain('You may retry by resending');
    expect(notice?.text).toContain('最终内容');
    expect(notice === undefined ? [] : value.delivered).toEqual([notice?.inputId]);
    await value.worker.processNow();
    expect(mainInputs(value.sessionStore)).toHaveLength(1);
  } finally {
    value.database.close();
  }
});

it('notifies main without retry guidance for non-retryable failures', async () => {
  const value = fixture();
  try {
    value.bindFeishu();
    const delivery = value.channelStore.createDelivery({
      ownerId,
      channel: 'feishu',
      content: '内容',
    });
    value.fail(new ChannelDeliveryError(false, 'auth_invalid', '飞书应用凭证无效'));
    await value.worker.processNow();
    const record = value.channelStore.getDelivery(ownerId, delivery.deliveryId);
    expect(record.status).toBe('failed');
    const inputs = mainInputs(value.sessionStore);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.text).toContain('retryable: no');
    expect(inputs[0]?.text).toContain('Do not retry');
  } finally {
    value.database.close();
  }
});

it('fails deliveries for channels without an adapter as non-retryable', async () => {
  const value = fixture();
  try {
    const delivery = value.channelStore.createDelivery({
      ownerId,
      channel: 'wechat',
      content: '内容',
    });
    await value.worker.processNow();
    const record = value.channelStore.getDelivery(ownerId, delivery.deliveryId);
    expect(record.status).toBe('failed');
    expect(record.lastErrorCode).toBe('channel_not_configured');
  } finally {
    value.database.close();
  }
});

it('records outbound message map entries when the channel returns a message id', async () => {
  const database = openDatabase(':memory:');
  const sessionStore = new SessionStore(database);
  seedTestTenant(database, ownerId);
  const channelStore = new ChannelStore(database, secret);
  const adapter = {
    send: async () => ({ externalMessageId: 'om_out_1' }),
  };
  const worker = new ChannelDeliveryWorker({
    channelStore,
    sessionStore,
    ownerId: () => ownerId,
    channels: { feishu: adapter },
  });
  try {
    channelStore.saveFeishuCredentials(
      ownerId,
      { kind: 'feishu', appId: 'cli_1', appSecret: 's' },
      '123456',
    );
    channelStore.bindExternalUser(ownerId, 'feishu', 'ou_1');
    const delivery = channelStore.createDelivery({
      ownerId,
      channel: 'feishu',
      content: '出站内容',
    });
    await worker.processNow();
    expect(channelStore.getDelivery(ownerId, delivery.deliveryId).status).toBe('succeeded');
    const mapped = channelStore.findMessageMap(ownerId, 'feishu', 'om_out_1');
    expect(mapped?.direction).toBe('outbound');
    expect(mapped?.excerpt).toBe('出站内容');
    expect(channelStore.latestInboundMessageId(ownerId, 'feishu')).toBeUndefined();
  } finally {
    database.close();
  }
});

it('passes delivery attachments to the channel adapter', async () => {
  const database = openDatabase(':memory:');
  const sessionStore = new SessionStore(database);
  seedTestTenant(database, ownerId);
  const channelStore = new ChannelStore(database, secret);
  const received: { fileName: string; mediaType: string; bytes: Uint8Array }[][] = [];
  const adapter = {
    send: async (input: {
      attachments?: { fileName: string; mediaType: string; bytes: Uint8Array }[];
    }) => {
      received.push(input.attachments ?? []);
    },
  };
  const worker = new ChannelDeliveryWorker({
    channelStore,
    sessionStore,
    ownerId: () => ownerId,
    channels: { feishu: adapter },
  });
  try {
    channelStore.saveFeishuCredentials(
      ownerId,
      { kind: 'feishu', appId: 'cli_1', appSecret: 's' },
      '123456',
    );
    channelStore.bindExternalUser(ownerId, 'feishu', 'ou_1');
    const uploaded = sessionStore.attachments.uploadChannel({
      ownerId,
      fileName: 'data.bin',
      bytes: new Uint8Array([9, 8, 7]),
    });
    channelStore.createDelivery({
      ownerId,
      channel: 'feishu',
      content: '带附件',
      attachmentIds: [uploaded.attachmentId],
    });
    await worker.processNow();
    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(1);
    expect(received[0]?.[0]?.fileName).toBe('data.bin');
    expect([...(received[0]?.[0]?.bytes ?? [])]).toEqual([9, 8, 7]);
  } finally {
    database.close();
  }
});

it('keeps wechat stale-token deliveries pending with a long retry and no attempt count', async () => {
  const value = fixture();
  try {
    value.bindFeishu();
    const delivery = value.channelStore.createDelivery({
      ownerId,
      channel: 'feishu',
      content: '会话过期重试',
    });
    value.fail(new ChannelDeliveryError(true, 'wechat_ret_-2', 'prepare failed'));
    await value.worker.processNow();
    let record = value.channelStore.getDelivery(ownerId, delivery.deliveryId);
    expect(record.status).toBe('pending');
    expect(record.attempts).toBe(0);
    expect(record.lastErrorCode).toBe('wechat_ret_-2');
    expect(record.nextAttemptAt).not.toBeNull();
    const retried = value.channelStore.retryStaleTokenDeliveries(ownerId, 'feishu');
    expect(retried).toBe(1);
    record = value.channelStore.getDelivery(ownerId, delivery.deliveryId);
    expect(record.attempts).toBe(0);
    value.fail(null);
    await value.worker.processNow();
    expect(value.channelStore.getDelivery(ownerId, delivery.deliveryId).status).toBe('succeeded');
    expect(value.sent).toHaveLength(1);
  } finally {
    value.database.close();
  }
});

it('sends a failure notice to the source channel when a channel-originated run fails', async () => {
  const value = fixture();
  try {
    value.bindFeishu();
    const accepted = value.sessionStore.acceptChannelInput({
      ownerId,
      method: 'ChannelInbound',
      clientActionId: 'inbound-1',
      parameters: {},
      text: '帮我查一下天气',
      channel: { channel: 'feishu', kind: 'inbound', externalMessageId: 'om_1' },
    });
    value.sessionStore.appendModelMessage({
      runId: accepted.runId,
      message: { role: 'user', content: '帮我查一下天气' },
      inputId: accepted.input.inputId,
    });
    value.sessionStore.updateRunStatus(accepted.runId, 'failed', {
      code: 'internal',
      message: '模型请求超时',
      retryable: true,
    });
    await value.worker.processNow();
    await value.worker.processNow();
    expect(value.sent).toHaveLength(1);
    expect(value.sent[0]?.externalUserId).toBe('ou_1');
    expect(value.sent[0]?.markdown).toContain('【处理失败】');
    expect(value.sent[0]?.markdown).toContain('模型请求超时');
    expect(value.sent[0]?.markdown).toContain('帮我查一下天气');
    await value.worker.processNow();
    expect(value.sent).toHaveLength(1);
    expect(mainInputs(value.sessionStore)).toHaveLength(1);
  } finally {
    value.database.close();
  }
});

it('does not send run failure notices for GUI-originated or cancelled runs', async () => {
  const value = fixture();
  try {
    value.bindFeishu();
    const thread = value.sessionStore.getOrCreateMainThread(ownerId);
    const gui = value.sessionStore.sendMessage({
      ownerId,
      method: 'SendMessage',
      clientActionId: 'gui-1',
      parameters: {},
      threadId: thread.threadId,
      text: 'gui 消息',
      mode: 'follow_up',
    });
    value.sessionStore.updateRunStatus(gui.runId, 'failed', {
      code: 'internal',
      message: '模型请求超时',
      retryable: true,
    });
    const cancelled = value.sessionStore.acceptChannelInput({
      ownerId,
      method: 'ChannelInbound',
      clientActionId: 'inbound-2',
      parameters: {},
      text: '用户取消的消息',
      channel: { channel: 'feishu', kind: 'inbound', externalMessageId: 'om_2' },
    });
    value.sessionStore.appendModelMessage({
      runId: cancelled.runId,
      message: { role: 'user', content: '用户取消的消息' },
      inputId: cancelled.input.inputId,
    });
    value.sessionStore.updateRunStatus(cancelled.runId, 'cancelled');
    await value.worker.processNow();
    await value.worker.processNow();
    expect(value.sent).toHaveLength(0);
  } finally {
    value.database.close();
  }
});

it('sends the run failure notice only to the source channel', async () => {
  const value = fixture();
  try {
    value.bindFeishu();
    const accepted = value.sessionStore.acceptChannelInput({
      ownerId,
      method: 'ChannelInbound',
      clientActionId: 'inbound-w1',
      parameters: {},
      text: '微信消息',
      channel: { channel: 'wechat', kind: 'inbound', externalMessageId: 'wx_1' },
    });
    value.sessionStore.appendModelMessage({
      runId: accepted.runId,
      message: { role: 'user', content: '微信消息' },
      inputId: accepted.input.inputId,
    });
    value.sessionStore.updateRunStatus(accepted.runId, 'failed', {
      code: 'internal',
      message: '环境离线',
      retryable: true,
    });
    await value.worker.processNow();
    await value.worker.processNow();
    expect(value.sent).toHaveLength(0);
    const notice = value.database
      .prepare(
        "SELECT channel, status, last_error_code FROM channel_deliveries WHERE kind = 'failure_notice'",
      )
      .get();
    expect(notice).toMatchObject({
      channel: 'wechat',
      status: 'failed',
      last_error_code: 'channel_not_configured',
    });
  } finally {
    value.database.close();
  }
});

it('enqueues an IM failure notice when a message delivery finally fails', async () => {
  const value = fixture();
  try {
    value.bindFeishu();
    const delivery = value.channelStore.createDelivery({
      ownerId,
      channel: 'feishu',
      content: '最终内容',
      maxAttempts: 1,
    });
    value.fail(new ChannelDeliveryError(true, 'network_error', '网络超时'));
    await value.worker.processNow();
    expect(value.channelStore.getDelivery(ownerId, delivery.deliveryId).status).toBe('failed');
    value.fail(null);
    await value.worker.processNow();
    expect(value.sent).toHaveLength(1);
    expect(value.sent[0]?.markdown).toContain('【发送失败】');
    expect(value.sent[0]?.markdown).toContain('网络超时');
    expect(value.sent[0]?.markdown).toContain('最终内容');
    expect(mainInputs(value.sessionStore)).toHaveLength(1);
    await value.worker.processNow();
    expect(value.sent).toHaveLength(1);
  } finally {
    value.database.close();
  }
});

it('does not loop when a failure notice delivery itself fails', async () => {
  const value = fixture();
  try {
    value.bindFeishu();
    const delivery = value.channelStore.createDelivery({
      ownerId,
      channel: 'feishu',
      content: '内容',
      maxAttempts: 1,
    });
    value.fail(new ChannelDeliveryError(false, 'auth_invalid', '飞书应用凭证无效'));
    await value.worker.processNow();
    await value.worker.processNow();
    const notices = value.database
      .prepare("SELECT status FROM channel_deliveries WHERE kind = 'failure_notice'")
      .all();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ status: 'failed' });
    await value.worker.processNow();
    expect(mainInputs(value.sessionStore)).toHaveLength(1);
    const count = value.database
      .prepare("SELECT COUNT(*) AS c FROM channel_deliveries WHERE kind = 'failure_notice'")
      .get();
    expect(count).toMatchObject({ c: 1 });
  } finally {
    value.database.close();
  }
});
