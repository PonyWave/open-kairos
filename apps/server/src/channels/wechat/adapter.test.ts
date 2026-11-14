import { expect, it, vi } from 'vitest';
import { SessionStore } from '../../sessions/store.js';
import { openDatabase } from '../../storage/database.js';
import { ChannelStore } from '../store.js';
import { segmentWechatMarkdown, WechatChannel } from './adapter.js';
import type { WechatClientApi } from './client.js';

const ownerId = 'wechat-adapter-owner';
const secret = 'wechat-adapter-test-secret-32chars';

type QrStatus = Awaited<ReturnType<WechatClientApi['pollQrcodeStatus']>>;

const confirmedStatus: QrStatus = {
  status: 'confirmed',
  bot_token: 'token-1',
  ilink_bot_id: 'bot-1',
  baseurl: 'https://ilinkai.weixin.qq.com',
  ilink_user_id: 'user-1',
};

class StubClient implements WechatClientApi {
  baseUrl = 'https://ilinkai.weixin.qq.com';
  qrCount = 0;
  polls: { qrcode: string; verifyCode: string | undefined }[] = [];
  script: QrStatus[] = [];
  sentTexts: string[] = [];
  typingCalls: { userId: string; ticket: string; status: 1 | 2 }[] = [];

  async getBotQrcode() {
    this.qrCount += 1;
    return { qrcode: `qr-${this.qrCount}`, qrcode_img_content: `content-${this.qrCount}` };
  }

  async pollQrcodeStatus(qrcode: string, verifyCode?: string) {
    this.polls.push({ qrcode, verifyCode });
    await new Promise((resolve) => setImmediate(resolve));
    return this.script.shift() ?? { status: 'wait' };
  }

  async getUpdates(): Promise<never> {
    throw new Error('not used in login tests');
  }

  async sendText(
    _botToken: string,
    _toUserId: string,
    _contextToken: string | null,
    text: string,
  ): Promise<void> {
    this.sentTexts.push(text);
  }

  mediaBytes: Uint8Array = new Uint8Array();
  mediaRequests: { ref: unknown; aesKey: string | undefined }[] = [];

  async getConfig(): Promise<string | null> {
    return 'ticket-1';
  }

  async downloadMedia(
    ref: { fullUrl?: string | undefined; encryptQueryParam?: string | undefined },
    aesKey: string | undefined,
  ): Promise<Uint8Array> {
    this.mediaRequests.push({ ref, aesKey });
    return this.mediaBytes;
  }

  async sendTyping(
    _botToken: string,
    userId: string,
    ticket: string,
    status: 1 | 2,
  ): Promise<void> {
    this.typingCalls.push({ userId, ticket, status });
  }

  async notifyLifecycle(): Promise<void> {}
}

function fixture(onInbound: (message: { text: string }) => void = () => {}) {
  const database = openDatabase(':memory:');
  new SessionStore(database);
  const store = new ChannelStore(database, secret);
  const client = new StubClient();
  const channel = new WechatChannel({
    ownerId: () => ownerId,
    store,
    onInbound,
    client,
  });
  return { database, store, client, channel };
}

it('completes login with a phone PIN and submits it on the next status poll', async () => {
  const { database, store, client, channel } = fixture();
  try {
    client.script = [{ status: 'need_verifycode' }, { status: 'scaned' }, confirmedStatus];
    const { sessionId, qrContent } = await channel.startLogin();
    expect(qrContent).toBe('content-1');
    await vi.waitFor(() => expect(channel.pollLogin(sessionId).awaitingPin).toBe(true));
    expect(channel.pollLogin(sessionId).reason).toContain('数字验证码');
    channel.submitLoginPin(sessionId, '123456');
    await vi.waitFor(() => expect(channel.pollLogin(sessionId).status).toBe('confirmed'));
    expect(client.polls[0]?.verifyCode).toBeUndefined();
    expect(client.polls[1]?.verifyCode).toBe('123456');
    const state = store.getState(ownerId, 'wechat');
    expect(state.status).toBe('active');
    expect(state.externalUserId).toBe('user-1');
    expect(store.getCredentials(ownerId, 'wechat')).toMatchObject({ botToken: 'token-1' });
  } finally {
    database.close();
  }
});

it('asks for the PIN again when the submitted code is rejected', async () => {
  const { database, client, channel } = fixture();
  try {
    client.script = [
      { status: 'need_verifycode' },
      { status: 'need_verifycode' },
      { status: 'scaned' },
      confirmedStatus,
    ];
    const { sessionId } = await channel.startLogin();
    await vi.waitFor(() => expect(channel.pollLogin(sessionId).awaitingPin).toBe(true));
    channel.submitLoginPin(sessionId, '111111');
    await vi.waitFor(() => expect(channel.pollLogin(sessionId).reason).toContain('不正确'));
    expect(channel.pollLogin(sessionId).awaitingPin).toBe(true);
    channel.submitLoginPin(sessionId, '222222');
    await vi.waitFor(() => expect(channel.pollLogin(sessionId).status).toBe('confirmed'));
    expect(client.polls[1]?.verifyCode).toBe('111111');
    expect(client.polls[2]?.verifyCode).toBe('222222');
  } finally {
    database.close();
  }
});

it('refreshes the QR code and clears the PIN state when the code is blocked', async () => {
  const { database, channel, client } = fixture();
  try {
    client.script = [{ status: 'verify_code_blocked' }, confirmedStatus];
    const { sessionId } = await channel.startLogin();
    await vi.waitFor(() => expect(channel.pollLogin(sessionId).status).toBe('confirmed'));
    expect(client.qrCount).toBe(2);
    expect(client.polls[1]?.qrcode).toBe('qr-2');
  } finally {
    database.close();
  }
});

it('rejects PIN submission when the session is not waiting for one', async () => {
  const { database, channel, client } = fixture();
  try {
    const { sessionId } = await channel.startLogin();
    expect(() => channel.submitLoginPin(sessionId, '123456')).toThrowError(/不需要数字验证码/);
    expect(() => channel.submitLoginPin('missing-session', '123456')).toThrowError(/不存在/);
    expect(() => channel.submitLoginPin(sessionId, '12ab')).toThrowError(/不需要数字验证码/);
    client.script = [confirmedStatus];
    await vi.waitFor(() => expect(channel.pollLogin(sessionId).status).toBe('confirmed'));
  } finally {
    database.close();
  }
});

it('shows typing on inbound wechat messages and cancels it after the first delivery', async () => {
  const inbound: string[] = [];
  const { database, store, client, channel } = fixture((message) => {
    inbound.push(message.text);
  });
  try {
    store.completeWechatLogin(ownerId, {
      kind: 'wechat',
      botToken: 'token-1',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botId: 'bot-1',
      ilinkUserId: 'user-1',
    });
    await channel.handleInboundMessage(ownerId, 'user-1', {
      message_type: 1,
      from_user_id: 'user-1',
      message_id: 42,
      context_token: 'ctx-1',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    });
    expect(inbound).toEqual(['你好']);
    await vi.waitFor(() => expect(client.typingCalls.some((call) => call.status === 1)).toBe(true));
    expect(store.getState(ownerId, 'wechat').contextToken).toBe('ctx-1');
    await channel.send(
      { externalUserId: 'user-1', contextToken: 'ctx-1', markdown: '回复内容' },
      new AbortController().signal,
    );
    expect(client.sentTexts).toEqual(['回复内容']);
    expect(client.typingCalls.some((call) => call.status === 2)).toBe(true);
  } finally {
    database.close();
  }
});

it('publishes the latest QR content after expiry and restores that pending session', async () => {
  const { database, channel, client } = fixture();
  try {
    client.script = [{ status: 'expired' }];
    const { sessionId } = await channel.startLogin('same-action');
    await vi.waitFor(() => expect(client.qrCount).toBe(2));
    expect(channel.currentLogin()).toMatchObject({
      id: sessionId,
      qrContent: 'content-2',
      status: 'pending',
    });
    const retried = await channel.startLogin('same-action');
    expect(retried).toEqual({ sessionId, qrContent: 'content-2' });
    expect(client.qrCount).toBe(2);
    expect(channel.currentLogin('other-user')).toBeUndefined();
  } finally {
    channel.stop();
    database.close();
  }
});

it('ignores a delayed success from a replaced or cancelled login', async () => {
  const { database, channel, client, store } = fixture();
  const pending = new Map<string, (status: QrStatus) => void>();
  client.pollQrcodeStatus = (code) => new Promise((resolve) => pending.set(code, resolve));
  try {
    const first = await channel.startLogin();
    const second = await channel.startLogin();
    pending.get('qr-1')?.(confirmedStatus);
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getState(ownerId, 'wechat').status).toBe('pending_login');
    expect(channel.pollLogin(first.sessionId).status).toBe('failed');
    channel.cancelLogin(second.sessionId);
    pending.get('qr-2')?.(confirmedStatus);
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getState(ownerId, 'wechat').status).toBe('unconfigured');
    expect(store.getCredentials(ownerId, 'wechat')).toBeNull();
  } finally {
    channel.stop();
    database.close();
  }
});

it('keeps a visible retryable error when the login status query fails', async () => {
  const { database, channel, client } = fixture();
  client.pollQrcodeStatus = async () => {
    throw new Error('offline');
  };
  try {
    await channel.startLogin();
    await vi.waitFor(() => expect(channel.currentLogin()?.pollingFailed).toBe(true));
    expect(channel.currentLogin()?.reason).toContain('连接中断');
    expect(channel.currentLogin()?.qrContent).toBe('content-1');
  } finally {
    channel.stop();
    database.close();
  }
});

it('does not restart a completed login when its original request is retried', async () => {
  const { database, channel, client, store } = fixture();
  try {
    client.script = [confirmedStatus];
    const first = await channel.startLogin('login-once');
    await vi.waitFor(() => expect(channel.pollLogin(first.sessionId).status).toBe('confirmed'));
    const retried = await channel.startLogin('login-once');
    expect(retried.sessionId).toBe(first.sessionId);
    expect(client.qrCount).toBe(1);
    expect(store.getState(ownerId, 'wechat').status).toBe('active');
  } finally {
    channel.stop();
    database.close();
  }
});

it('downloads inbound media and passes it to the inbound handler', async () => {
  const inbound: { text: string; media?: { fileName: string; bytes: Uint8Array }[] }[] = [];
  const { database, store, client, channel } = fixture((message) => {
    inbound.push(message);
  });
  try {
    store.completeWechatLogin(ownerId, {
      kind: 'wechat',
      botToken: 'token-1',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botId: 'bot-1',
      ilinkUserId: 'user-1',
    });
    client.mediaBytes = new Uint8Array([1, 2, 3, 4]);
    await channel.handleInboundMessage(ownerId, 'user-1', {
      message_type: 1,
      from_user_id: 'user-1',
      message_id: 77,
      item_list: [
        {
          type: 4,
          file_item: {
            file_name: '报告.pdf',
            media: { encrypt_query_param: 'param-1', aes_key: 'aa'.repeat(16) },
          },
        },
      ],
    });
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.text).toBe('[文件: 报告.pdf]');
    expect(inbound[0]?.media).toHaveLength(1);
    expect(inbound[0]?.media?.[0]?.fileName).toBe('报告.pdf');
    expect([...(inbound[0]?.media?.[0]?.bytes ?? [])]).toEqual([1, 2, 3, 4]);
    expect(client.mediaRequests).toEqual([
      { ref: { encryptQueryParam: 'param-1' }, aesKey: 'aa'.repeat(16) },
    ]);
  } finally {
    database.close();
  }
});

it('parses a realistic file message payload and downloads the attachment', async () => {
  const inbound: { text: string; media?: { fileName: string; bytes: Uint8Array }[] }[] = [];
  const { database, store, client, channel } = fixture((message) => {
    inbound.push(message);
  });
  try {
    store.completeWechatLogin(ownerId, {
      kind: 'wechat',
      botToken: 'token-1',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botId: 'bot-1',
      ilinkUserId: 'user-1',
    });
    client.mediaBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await channel.handleInboundMessage(ownerId, 'user-1', {
      seq: 1024,
      message_id: '7483920192837465102',
      from_user_id: 'user-1',
      to_user_id: 'bot-1',
      client_id: 'client-abc',
      create_time_ms: 1794592000000,
      message_type: 1,
      message_state: 2,
      session_id: 'session-1',
      context_token: 'ctx-file',
      item_list: [
        {
          type: 4,
          create_time_ms: 1794592000000,
          is_completed: true,
          msg_id: 'item-1',
          file_item: {
            file_name: '合同扫描件.pdf',
            len: '4',
            md5: 'd41d8cd98f00b204e9800998ecf8427e',
            media: {
              encrypt_query_param: 'eqp-file-1',
              aes_key: Buffer.from('aa'.repeat(16), 'utf8').toString('base64'),
              encrypt_type: 1,
              full_url:
                'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=eqp-file-1',
            },
          },
        },
      ],
    });
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.text).toBe('[文件: 合同扫描件.pdf]');
    expect(inbound[0]?.media).toHaveLength(1);
    expect(inbound[0]?.media?.[0]?.fileName).toBe('合同扫描件.pdf');
    expect(client.mediaRequests).toHaveLength(1);
    expect(client.mediaRequests[0]?.ref).toEqual({
      fullUrl: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=eqp-file-1',
      encryptQueryParam: 'eqp-file-1',
    });
  } finally {
    database.close();
  }
});

it('end-to-end text flow: realistic getUpdates payload enqueues and send delivers one message', async () => {
  const inbound: { text: string }[] = [];
  const { database, store, client, channel } = fixture((message) => {
    inbound.push(message);
  });
  try {
    store.completeWechatLogin(ownerId, {
      kind: 'wechat',
      botToken: 'token-1',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botId: 'bot-1',
      ilinkUserId: 'user-1',
    });
    await channel.handleInboundMessage(ownerId, 'user-1', {
      seq: 2048,
      message_id: '7483920192837465999',
      from_user_id: 'user-1',
      to_user_id: 'bot-1',
      client_id: 'client-xyz',
      create_time_ms: 1794593000000,
      update_time_ms: 1794593000001,
      message_type: 1,
      message_state: 2,
      session_id: 'session-9',
      context_token: 'ctx-text',
      item_list: [
        {
          type: 1,
          create_time_ms: 1794593000000,
          is_completed: true,
          msg_id: 'item-text-1',
          text_item: { text: '今天天气怎么样' },
        },
      ],
    });
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.text).toBe('今天天气怎么样');
    client.sentTexts.length = 0;
    await channel.send(
      { externalUserId: 'user-1', contextToken: 'ctx-text', markdown: '**晴天**，适合出门。' },
      new AbortController().signal,
    );
    expect(client.sentTexts).toEqual(['**晴天**，适合出门。']);
  } finally {
    database.close();
  }
});

it('segments long markdown at 4000 characters on paragraph boundaries', () => {
  expect(segmentWechatMarkdown('短消息')).toEqual(['短消息']);
  expect(segmentWechatMarkdown('')).toEqual([]);
  const paragraph = '汉'.repeat(3_000);
  const segments = segmentWechatMarkdown([paragraph, paragraph, paragraph].join('\n\n'));
  expect(segments).toHaveLength(3);
  for (const segment of segments) {
    expect(segment.length).toBeLessThanOrEqual(4_000);
  }
  expect(segments.join('\n\n')).toContain(paragraph);
  const hardSplit = segmentWechatMarkdown('字'.repeat(9_000));
  expect(hardSplit).toHaveLength(3);
  expect(hardSplit.join('')).toBe('字'.repeat(9_000));
});
