import { expect, it } from 'vitest';
import { decryptWechatMedia, inboundMessageText, WechatClient } from './client.js';

const getUpdatesPayload = {
  ret: 0,
  get_updates_buf: 'buf-1',
  longpolling_timeout_ms: 30_000,
  msgs: [
    {
      seq: 3,
      message_id: 7_527_046_482_351_794_000,
      from_user_id: 'user-1',
      to_user_id: 'bot-1',
      client_id: 'mmassistant_bypmsg_inbox_56fb045f',
      create_time_ms: 1_794_587_727_061,
      update_time_ms: 1_794_587_727_212,
      delete_time_ms: 0,
      session_id: '',
      group_id: '',
      message_type: 1,
      message_state: 2,
      item_list: [
        {
          type: 1,
          create_time_ms: 1_794_587_727_061,
          update_time_ms: 1_794_587_727_061,
          is_completed: true,
          msg_id: 'v1:9321416018406954652',
          button_item_list: [],
          at_bot_username_list: [],
          text_item: { text: '测试' },
        },
      ],
      context_token: 'ctx-1',
      root_id: 0,
      parent_id: 0,
    },
  ],
};

it('accepts inbound update messages carrying fields beyond the known schema', async () => {
  const fetchStub: typeof globalThis.fetch = () =>
    Promise.resolve(new Response(JSON.stringify(getUpdatesPayload), { status: 200 }));
  const client = new WechatClient({ fetch: fetchStub });
  const response = await client.getUpdates('token-1', 'buf-0', new AbortController().signal);
  expect(response.get_updates_buf).toBe('buf-1');
  expect(response.msgs?.map((message) => inboundMessageText(message))).toEqual(['测试']);
  expect(response.msgs?.[0]).not.toHaveProperty('seq');
});

it('uploadMedia encrypts content and returns a usable media reference', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body });
    if (url.includes('getuploadurl')) {
      return new Response(
        JSON.stringify({ ret: 0, upload_full_url: 'https://cdn.example/upload?x=1' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('', {
      status: 200,
      headers: { 'x-encrypted-param': 'encrypted-param-1' },
    });
  }) as typeof globalThis.fetch;
  const client = new WechatClient({ fetch: fetchStub });
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const uploaded = await client.uploadMedia(
    'token',
    'user-1',
    3,
    bytes,
    new AbortController().signal,
  );
  expect(uploaded.encryptQueryParam).toBe('encrypted-param-1');
  expect(uploaded.rawSize).toBe(5);
  const uploadCall = calls.find((call) => call.url.includes('getuploadurl'));
  const request = JSON.parse(String(uploadCall?.body)) as { aeskey: string; filesize: number };
  expect(request.filesize).toBe(16);
  const cipherCall = calls.find((call) => call.url.includes('cdn.example'));
  const ciphertext = new Uint8Array(cipherCall?.body as ArrayBuffer);
  expect(ciphertext.length).toBe(16);
  const decrypted = decryptWechatMedia(ciphertext, request.aeskey);
  expect([...decrypted]).toEqual([1, 2, 3, 4, 5]);
  expect(Buffer.from(uploaded.aesKeyBase64, 'base64').toString('utf8')).toBe(request.aeskey);
});
