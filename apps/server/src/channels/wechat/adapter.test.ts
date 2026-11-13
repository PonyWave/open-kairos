import { expect, it, vi } from 'vitest';
import { SessionStore } from '../../sessions/store.js';
import { openDatabase } from '../../storage/database.js';
import { ChannelStore } from '../store.js';
import { WechatChannel } from './adapter.js';
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

  async sendText(): Promise<void> {}

  async notifyLifecycle(): Promise<void> {}
}

function fixture() {
  const database = openDatabase(':memory:');
  new SessionStore(database);
  const store = new ChannelStore(database, secret);
  const client = new StubClient();
  const channel = new WechatChannel({
    ownerId: () => ownerId,
    store,
    onInbound: () => {},
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
