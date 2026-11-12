import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Code, createClient, createRouterTransport } from '@connectrpc/connect';
import type { ModelProvider, ModelRequest } from '@kairos/agent-core';
import { CompactContextStatus, ContextService } from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { DeviceBashStore } from '../devices/operation-store.js';
import {
  controlledEnvironmentDependencies,
  seedTestEnvironment,
} from '../integration/environment-fixture.js';
import {
  createTestAuthentication,
  testSessionInterceptor,
} from '../integration/test-authentication.js';
import { RunCoordinator } from '../sessions/runtime.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { registerGuiRoutes } from './connect.js';
import { BashLogReader } from './logs.js';

it('keeps a compact operation running after the RPC caller disconnects and replays its result', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'kairos-compact-rpc-'));
  const database = openDatabase(':memory:');
  seedTestEnvironment(database, 'local-user');
  const store = new SessionStore(database);
  const operations = new DeviceBashStore(database);
  const requests: ModelRequest[] = [];
  let notifyStarted = () => {};
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const provider: ModelProvider = {
    async *stream(request) {
      requests.push(structuredClone(request));
      notifyStarted();
      await finished;
      yield {
        type: 'response',
        message: { role: 'assistant', content: 'persisted summary' },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
    },
  };
  const coordinator = new RunCoordinator({
    ...controlledEnvironmentDependencies(store.database, 'local-user'),
    store,
    model: {
      provider,
      providerId: 'test',
      modelId: 'test-model',
      contextWindowTokens: 1000,
      outputReserveTokens: 0,
      countTokens: () => 100,
    },
  });
  const transport = createRouterTransport(
    (router) =>
      registerGuiRoutes(router, {
        store,
        coordinator,
        operations,
        logs: new BashLogReader({ store, operations }),
        modelStatus: {
          providerId: 'test',
          modelId: 'test-model',
          contextCapacity: 1000,
          outputReserve: 1,
          available: true,
          configurationErrors: [],
        },
        authentication: createTestAuthentication(database, 'local-user'),
      }),
    { transport: { interceptors: [testSessionInterceptor()] } },
  );
  const context = createClient(ContextService, transport);
  try {
    const threadId = store.getOrCreateMainThread('local-user').threadId;
    await coordinator.reloadResources({
      ownerId: 'local-user',
      threadId,
      clientActionId: 'prepare-compact-resources',
    });
    store.context.append({
      threadId,
      agentId: 'thread',
      message: { role: 'user', content: 'original' },
    });
    const controller = new AbortController();
    const disconnected = context.compactContext(
      { threadId, clientActionId: 'compact-disconnect' },
      { signal: controller.signal },
    );
    await started;
    controller.abort();
    await expect(disconnected).rejects.toMatchObject({ code: Code.Canceled });
    expect(store.database.prepare('SELECT status FROM manual_compact_operations').get()).toEqual({
      status: 'running',
    });
    finish();
    await vi.waitFor(() => {
      expect(store.database.prepare('SELECT status FROM manual_compact_operations').get()).toEqual({
        status: 'changed',
      });
    });
    const replayed = await context.compactContext({
      threadId,
      clientActionId: 'compact-disconnect',
    });
    expect(replayed.status).toBe(CompactContextStatus.CHANGED);
    expect(replayed.readThroughSeq).toBe(1n);
    expect(replayed.recapIds).toHaveLength(1);
    expect(requests).toHaveLength(1);
    const events = store.listEvents(threadId, 0n);
    expect(events.at(-1)?.payload).toMatchObject({
      case: 'hardCutCompleted',
      value: { operationId: replayed.operationId },
    });
  } finally {
    finish();
    await coordinator.close();
    database.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
