import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectError, createClient, type Interceptor, type Transport } from '@connectrpc/connect';
import type { ModelProvider, ModelRequest } from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import { ContextService, InputMode } from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import {
  createEnvironmentThreadClient,
  createEnvironmentTestServer as createServer,
  seedTestEnvironment,
} from './integration/environment-fixture.js';
import { testSessionInterceptor } from './integration/test-authentication.js';
import { SessionStore } from './sessions/store.js';
import { openDatabase } from './storage/database.js';

type ConnectTransportFactory = (options: {
  baseUrl: string;
  httpVersion: '1.1';
  interceptors: Interceptor[];
}) => Transport;

const fastifyEntry = createRequire(import.meta.url).resolve('@connectrpc/connect-fastify');
const connectNode = createRequire(fastifyEntry)('@connectrpc/connect-node') as {
  createConnectTransport: ConnectTransportFactory;
};

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function controlledProvider() {
  const requests: ModelRequest[] = [];
  const started = deferred();
  const aborted = deferred();
  let finish = () => {};
  const provider: ModelProvider = {
    async *stream(request, signal) {
      const index = requests.length;
      requests.push(structuredClone(request));
      if (index === 0) {
        yield {
          type: 'response',
          message: { role: 'assistant', content: 'initial environment answer' },
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
        return;
      }
      const waiting = new Promise<void>((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener('abort', abort);
          aborted.resolve();
          reject(signal.reason);
        };
        finish = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
      started.resolve();
      await waiting;
      yield {
        type: 'response',
        message: { role: 'assistant', content: 'summary after delayed release' },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
    },
  };
  return {
    provider,
    requests,
    started: started.promise,
    aborted: aborted.promise,
    finish: () => finish(),
  };
}

async function startNetworkServer(databasePath: string, provider: ModelProvider) {
  const database = openDatabase(databasePath);
  seedTestEnvironment(database, 'local-user');
  const server = createServer(database, false, {
    model: {
      provider,
      providerId: 'test',
      modelId: 'test-model',
      contextWindowTokens: 1000,
      outputReserveTokens: 100,
      countTokens: () => 100,
    },
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test Server has no TCP address.');
  }
  const transport = connectNode.createConnectTransport({
    baseUrl: `http://127.0.0.1:${address.port}`,
    httpVersion: '1.1',
    interceptors: [testSessionInterceptor()],
  });
  return {
    database,
    server,
    clients: {
      thread: createEnvironmentThreadClient(transport),
      context: createClient(ContextService, transport),
    },
  };
}

it('cancels active compaction before closing Fastify and does not replay it after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-compact-close-'));
  const databasePath = join(directory, 'state.sqlite');
  const controlled = controlledProvider();
  const restartedProvider = new ScriptedProvider([]);
  const restartedRequests = restartedProvider.requests;
  const first = await startNetworkServer(databasePath, controlled.provider);
  let second: Awaited<ReturnType<typeof startNetworkServer>> | undefined;
  let firstClosing: Promise<void> | undefined;
  try {
    const created = await first.clients.thread.createThread({
      clientActionId: 'create-compact-close',
      title: 'Compact close',
      initialText: 'load the environment before compacting',
      initialMode: InputMode.FOLLOW_UP,
    });
    const threadId = created.thread?.threadId;
    if (!threadId) throw new Error('The compact Thread was not created.');
    await vi.waitFor(() => {
      expect(
        first.database.prepare('SELECT status FROM runs WHERE run_id = ?').get(created.runId ?? ''),
      ).toEqual({ status: 'completed' });
    });
    new SessionStore(first.database).context.append({
      threadId,
      agentId: 'thread',
      message: { role: 'user', content: 'original context' },
    });
    const request = { threadId, clientActionId: 'compact-during-close' };
    const rpcResult = first.clients.context.compactContext(request).then(
      () => ({ status: 'resolved' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await controlled.started;
    firstClosing = first.server.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closeState = await Promise.race([
      firstClosing.then(() => 'closed' as const),
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), 1000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    expect(closeState).toBe('closed');
    expect(await rpcResult).toMatchObject({
      status: 'rejected',
      error: expect.any(ConnectError),
    });
    await controlled.aborted;
    expect(controlled.requests).toHaveLength(2);

    const inspect = openDatabase(databasePath);
    try {
      expect(
        inspect
          .prepare(
            `SELECT status, error_code, error_message FROM manual_compact_operations
             WHERE client_action_id = 'compact-during-close'`,
          )
          .get(),
      ).toEqual({
        status: 'interrupted',
        error_code: 'operation_unknown',
        error_message: 'Server shut down during manual compaction; the operation was interrupted.',
      });
    } finally {
      inspect.close();
    }

    second = await startNetworkServer(databasePath, restartedProvider);
    expect(restartedRequests).toHaveLength(0);
    await expect(second.clients.context.compactContext(request)).rejects.toBeInstanceOf(
      ConnectError,
    );
    expect(restartedRequests).toHaveLength(0);
    expect(
      second.database
        .prepare(
          "SELECT status FROM manual_compact_operations WHERE client_action_id = 'compact-during-close'",
        )
        .get(),
    ).toEqual({ status: 'interrupted' });
    const events = new SessionStore(second.database).listEvents(threadId, 0n);
    expect(events.filter((event) => event.payload.case === 'hardCutFailed')).toHaveLength(1);
  } finally {
    controlled.finish();
    if (firstClosing) await firstClosing;
    else if (first.database.isOpen) await first.server.close();
    if (second?.database.isOpen) await second.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
