import { Code, ConnectError, createRouterTransport, type ServiceImpl } from '@connectrpc/connect';
import { ChannelId, ChannelLoginState, ChannelService } from '@kairos/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { ChannelSettingsController } from './channel-settings-state.js';
import { createKairosClients } from './client.js';

const controllers: ChannelSettingsController[] = [];
afterEach(() => {
  for (const c of controllers.splice(0)) c.stop();
  vi.useRealTimers();
});
const pending = {
  channel: ChannelId.FEISHU,
  loginState: ChannelLoginState.PENDING,
  configured: true,
  pairingCode: '123456',
};
function fixture(methods: Partial<ServiceImpl<typeof ChannelService>> = {}) {
  const transport = createRouterTransport((router) =>
    router.service(ChannelService, { getChannelStates: () => ({ states: [] }), ...methods }),
  );
  const controller = new ChannelSettingsController(createKairosClients({ transport }).channels);
  controllers.push(controller);
  controller.start();
  return controller;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
it('keeps unknown state distinct from unconfigured after a failed initial read', async () => {
  const c = fixture({
    getChannelStates: () => {
      throw new ConnectError('network', Code.Unavailable);
    },
  });
  await vi.waitFor(() => expect(c.snapshot().loading).toBe(false));
  expect(c.snapshot().states).toBeNull();
  expect(c.snapshot().loadError).toContain('网络');
});
it('polls a pending Feishu pairing into the completed account state', async () => {
  vi.useFakeTimers();
  let bound = false;
  const c = fixture({
    getChannelStates: () => ({
      states: [
        bound
          ? { ...pending, loginState: ChannelLoginState.ACTIVE, boundExternalUserId: 'ou_test' }
          : pending,
      ],
    }),
  });
  await vi.waitFor(() => expect(c.snapshot().states).not.toBeNull());
  bound = true;
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() =>
    expect(c.snapshot().states?.[0]?.loginState).toBe(ChannelLoginState.ACTIVE),
  );
  expect(c.snapshot().states?.[0]?.boundExternalUserId).toBe('ou_test');
});
it('restores the current login and replaces an expired QR image without creating another login', async () => {
  vi.useFakeTimers();
  let content = 'qr-one';
  const c = fixture({
    getChannelStates: () => ({
      states: [],
      wechatLogin: {
        loginSessionId: 's',
        qrContent: content,
        loginState: ChannelLoginState.PENDING,
      },
    }),
  });
  await vi.waitFor(() => expect(c.snapshot().login?.qrContent).toBe('qr-one'));
  content = 'qr-two';
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(c.snapshot().login?.qrContent).toBe('qr-two'));
  c.stop();
  c.start();
  await vi.waitFor(() => expect(c.snapshot().loading).toBe(false));
  expect(c.snapshot().login?.loginSessionId).toBe('s');
});
it('does not replace an action error with a successful automatic state refresh', async () => {
  const c = fixture({
    saveFeishuCredentials: () => {
      throw new ConnectError('保存失败', Code.InvalidArgument);
    },
  });
  await vi.waitFor(() => expect(c.snapshot().loading).toBe(false));
  expect(await c.saveFeishu('cli_test', 'secret', false)).toBe(false);
  await c.refresh();
  expect(c.snapshot().errors[ChannelId.FEISHU]).toBe('保存失败');
});
it('allows independent channels to progress during a slow save and cancels reads on stop', async () => {
  const saving = deferred<{ state: typeof pending }>();
  let signal: AbortSignal | undefined;
  const c = fixture({
    getChannelStates: (_req, ctx) => {
      signal = ctx.signal;
      return { states: [pending] };
    },
    saveFeishuCredentials: () => saving.promise,
    startChannelLogin: () => ({
      state: { channel: ChannelId.WECHAT, loginState: ChannelLoginState.PENDING },
      loginSessionId: 'wx',
      qrContent: 'qr',
    }),
  });
  await vi.waitFor(() => expect(c.snapshot().loading).toBe(false));
  const save = c.saveFeishu('cli_test', 'secret', false);
  await vi.waitFor(() => expect(c.snapshot().busy[ChannelId.FEISHU]).toBe('save'));
  expect(await c.startWechat()).toBe(true);
  expect(c.snapshot().busy[ChannelId.FEISHU]).toBe('save');
  saving.resolve({ state: pending });
  expect(await save).toBe(true);
  expect(c.snapshot().busy).toEqual({});
  c.stop();
  expect(signal?.aborted).toBe(true);
});
it('rejects a stale state response after a mutation has replaced it', async () => {
  const initial = deferred<{ states: (typeof pending)[] }>();
  let first = true;
  const c = fixture({
    getChannelStates: () => {
      if (first) {
        first = false;
        return initial.promise;
      }
      return { states: [] };
    },
    unbindChannel: () => ({
      state: { channel: ChannelId.FEISHU, loginState: ChannelLoginState.UNCONFIGURED },
    }),
  });
  await c.unbind(ChannelId.FEISHU);
  initial.resolve({ states: [pending] });
  await Promise.resolve();
  expect(c.snapshot().states).toEqual([]);
});
