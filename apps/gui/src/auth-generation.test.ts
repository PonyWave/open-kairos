/// <reference lib="dom" />

import { Code, createRouterTransport } from '@connectrpc/connect';
import {
  AuthenticationState,
  AuthService,
  create,
  IdentitySchema,
  InputMode,
} from '@kairos/contracts';
import { describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.js';
import { createKairosClients } from './client.js';

const accountA = create(IdentitySchema, {
  userId: 'user-a',
  tenantId: 'tenant-a',
  email: 'a@kairos.local',
  username: '用户 A',
  mainThreadId: 'main-a',
});
const accountB = create(IdentitySchema, {
  userId: 'user-b',
  tenantId: 'tenant-b',
  email: 'b@kairos.local',
  username: '用户 B',
  mainThreadId: 'main-b',
});

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve?.(value) };
}

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ code: 'unauthenticated', message: 'expired' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}

function endStreamUnauthorized(): Uint8Array {
  const payload = new TextEncoder().encode(
    JSON.stringify({ error: { code: 'unauthenticated', message: 'expired' } }),
  );
  const frame = new Uint8Array(payload.length + 5);
  frame[0] = 2;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

function createController(current: { identity: typeof accountA | typeof accountB }) {
  const transport = createRouterTransport((router) => {
    router.service(AuthService, {
      getCurrentIdentity() {
        return { state: AuthenticationState.AUTHENTICATED, identity: current.identity };
      },
    });
  });
  return new AuthController({ clients: createKairosClients({ transport }) });
}

function businessClients(controller: AuthController, fetch: typeof globalThis.fetch) {
  return createKairosClients({
    baseUrl: 'http://127.0.0.1:4317',
    fetch,
    getAuthenticationGeneration: () => controller.authenticationGeneration,
    onUnauthenticated: (generation) => controller.expireSession(generation),
  });
}

function sendMessage(clients: ReturnType<typeof businessClients>, threadId: string) {
  return clients.messages.sendMessage({
    clientActionId: `send-${threadId}`,
    threadId,
    text: '消息',
    mode: InputMode.FOLLOW_UP,
  });
}

describe('authentication generation for session expiration', () => {
  it('ignores a late unary 401 from account A and still expires account B for a real 401', async () => {
    const current = { identity: accountA };
    const controller = createController(current);
    const first = deferred<Response>();
    const second = deferred<Response>();
    let calls = 0;
    const clients = businessClients(controller, () => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    });
    await controller.restore();
    expect(controller.state.identity?.userId).toBe('user-a');

    const lateA = sendMessage(clients, 'main-a');
    await vi.waitFor(() => expect(calls).toBe(1));
    current.identity = accountB;
    await controller.restore();
    expect(controller.state.identity?.userId).toBe('user-b');
    first.resolve(unauthorizedResponse());
    await expect(lateA).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(controller.state.step).toBe('authenticated');
    expect(controller.state.identity?.userId).toBe('user-b');

    const currentB = sendMessage(clients, 'main-b');
    await vi.waitFor(() => expect(calls).toBe(2));
    second.resolve(unauthorizedResponse());
    await expect(currentB).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(controller.state.step).toBe('email');
    expect(controller.state.identity).toBeNull();
  });

  it('ignores a late stream 401 from account A and still expires account B for a real stream 401', async () => {
    const current = { identity: accountA };
    const controller = createController(current);
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const clients = businessClients(controller, () => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          streams.push(stream);
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/connect+proto' },
        }),
      );
    });
    await controller.restore();

    const streamA = clients.events
      .watchThread({ threadId: 'main-a', afterSeq: 0n })
      [Symbol.asyncIterator]();
    const nextA = streamA.next();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    current.identity = accountB;
    await controller.restore();
    streams[0]?.enqueue(endStreamUnauthorized());
    streams[0]?.close();
    await expect(nextA).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(controller.state.step).toBe('authenticated');
    expect(controller.state.identity?.userId).toBe('user-b');

    const streamB = clients.events
      .watchThread({ threadId: 'main-b', afterSeq: 0n })
      [Symbol.asyncIterator]();
    const nextB = streamB.next();
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    streams[1]?.enqueue(endStreamUnauthorized());
    streams[1]?.close();
    await expect(nextB).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(controller.state.step).toBe('email');
    expect(controller.state.identity).toBeNull();
  });
});
