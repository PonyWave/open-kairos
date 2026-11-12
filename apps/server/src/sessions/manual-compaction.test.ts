import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelEvent, ModelProvider, ModelRequest } from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { controlledEnvironmentDependencies } from '../integration/environment-fixture.js';
import { openDatabase } from '../storage/database.js';
import { RunCoordinator } from './runtime.js';
import { SessionStore } from './store.js';

const ownerId = 'owner-1';
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

function response(content: string): ModelEvent[] {
  return [{ type: 'response', message: { role: 'assistant', content }, usage }];
}

function action<T extends Record<string, unknown>>(
  clientActionId: string,
  method: string,
  parameters: T,
) {
  return { ownerId, clientActionId, method, parameters, ...parameters };
}

async function fixture(
  provider: ModelProvider,
  countTokens: (request: ModelRequest) => number | Promise<number> = () => 100,
) {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'kairos-manual-compact-'));
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  const coordinator = new RunCoordinator({
    ...controlledEnvironmentDependencies(store.database, ownerId),
    store,
    model: {
      provider,
      providerId: 'test',
      modelId: 'test-model',
      contextWindowTokens: 1000,
      outputReserveTokens: 0,
      countTokens,
    },
  });
  const thread = store.createThread(
    action('create-thread', 'CreateThread', { title: 'Compact test' }),
  );
  await coordinator.reloadResources({
    ownerId,
    threadId: thread.threadId,
    clientActionId: 'fixture-resources',
  });
  return { database, store, coordinator, thread, outputDirectory };
}

async function cleanup(current: Awaited<ReturnType<typeof fixture>>) {
  await current.coordinator.close();
  current.database.close();
  await rm(current.outputDirectory, { recursive: true, force: true });
}

function appendUser(store: SessionStore, threadId: string, content: string) {
  const record = store.context.append({
    threadId,
    agentId: 'thread',
    message: { role: 'user', content },
  });
  store.agentEnvironments.recordMessageBinding(threadId, 'thread', record.seq);
  return record;
}

function compact(coordinator: RunCoordinator, threadId: string, clientActionId: string) {
  return coordinator.compactContext({ ownerId, threadId, clientActionId });
}

function controlledProvider(content = 'generated summary') {
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
    async *stream(request, signal) {
      requests.push(structuredClone(request));
      notifyStarted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        void finished.then(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        });
      });
      yield* response(content);
    },
  };
  return { provider, requests, started, finish };
}

describe('manual compaction', () => {
  it('compacts at the automatic threshold and preserves the next raw suffix', async () => {
    const provider = new ScriptedProvider([
      response('summary'),
      response('next answer'),
      response('suffix user summary'),
      response('suffix assistant summary'),
    ]);
    const current = await fixture(provider, () => 800);
    const { store, coordinator, thread } = current;
    try {
      appendUser(store, thread.threadId, 'original user message');
      const result = await compact(coordinator, thread.threadId, 'compact-success');
      expect(result).toMatchObject({ status: 'changed', readThroughSeq: 1 });
      expect(result.recapIds).toHaveLength(1);
      expect(provider.requests).toHaveLength(1);
      expect(store.listRuns(ownerId, thread.threadId)).toEqual([]);
      expect(store.listInputs(ownerId, thread.threadId)).toEqual([]);
      expect(
        store.listContext(ownerId, thread.threadId).map((message) => message.message.content),
      ).toEqual(['original user message']);
      const events = store.listEvents(thread.threadId, 0n);
      expect(events.map((event) => event.payload.case)).toEqual([
        'threadCreated',
        'environmentBindingChanged',
        'hardCutStarted',
        'recapCreated',
        'hardCutCompleted',
      ]);
      expect(events.at(-2)?.payload).toMatchObject({
        case: 'recapCreated',
        value: { recap: { content: 'summary', sourceSeqEnd: 1 } },
      });
      expect(events.at(-1)?.payload).toMatchObject({
        case: 'hardCutCompleted',
        value: { operationId: result.operationId, runId: '', replacedSourceSeqs: [1] },
      });

      const sent = store.sendMessage(
        action('next-input', 'SendMessage', {
          threadId: thread.threadId,
          text: 'new raw suffix',
          mode: 'follow_up' as const,
        }),
      );
      await coordinator.deliver(sent.input, sent.runId);
      await vi.waitFor(() => {
        expect(store.getRunById(sent.runId).status).toBe('completed');
      });
      expect(provider.requests).toHaveLength(2);
      const nextMessages = provider.requests[1]?.messages ?? [];
      expect(nextMessages[0]?.role).toBe('system');
      const conversation = nextMessages.filter((message) => message.role !== 'system');
      expect(conversation[0]?.role).toBe('user');
      expect(conversation[0]?.content).toContain('summary');
      expect(nextMessages.at(-1)).toEqual({ role: 'user', content: 'new raw suffix' });
      expect(nextMessages.some((message) => message.content === 'original user message')).toBe(
        false,
      );
      expect(
        store
          .listContext(ownerId, thread.threadId)
          .some((message) => message.message.content.includes('Kairos internal Recap operation')),
      ).toBe(false);

      const compactedAgain = await compact(coordinator, thread.threadId, 'compact-with-run-tools');
      expect(compactedAgain).toMatchObject({ status: 'changed', readThroughSeq: 3 });
      expect(compactedAgain.recapIds).toHaveLength(3);
      expect(provider.requests).toHaveLength(4);
      expect(provider.requests[2]?.tools).toEqual(provider.requests[1]?.tools);
      expect(provider.requests[3]?.tools).toEqual(provider.requests[1]?.tools);
      expect(store.listRuns(ownerId, thread.threadId)).toHaveLength(1);
    } finally {
      await cleanup(current);
    }
  });

  it('reuses valid recaps and returns noop without more model writes or completion events', async () => {
    const provider = new ScriptedProvider([response('new summary')]);
    const current = await fixture(provider);
    const { store, coordinator, thread } = current;
    try {
      appendUser(store, thread.threadId, 'first');
      store.recaps.save({
        recapId: 'existing-recap',
        threadId: thread.threadId,
        agentId: 'thread',
        sourceMessageSeqs: [1],
        content: 'existing summary',
      });
      appendUser(store, thread.threadId, 'second');
      const changed = await compact(coordinator, thread.threadId, 'compact-reuse');
      expect(changed.status).toBe('changed');
      expect(changed.recapIds[0]).toBe('existing-recap');
      expect(changed.recapIds).toHaveLength(2);
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.messages.at(-1)?.content).toContain('"seq":2');
      expect(provider.requests[0]?.messages.at(-1)?.content).not.toContain('"seq":1');
      const recapCount = store.listRecaps(ownerId, thread.threadId).length;
      const eventCount = store.listEvents(thread.threadId, 0n).length;

      const noop = await compact(coordinator, thread.threadId, 'compact-noop-after-change');
      expect(noop).toEqual({
        operationId: expect.any(String),
        status: 'noop',
        readThroughSeq: changed.readThroughSeq,
        recapIds: changed.recapIds,
      });
      expect(noop.operationId).not.toBe(changed.operationId);
      expect(provider.requests).toHaveLength(1);
      expect(store.listRecaps(ownerId, thread.threadId)).toHaveLength(recapCount);
      expect(store.listEvents(thread.threadId, 0n)).toHaveLength(eventCount);
      expect(await compact(coordinator, thread.threadId, 'compact-noop-after-change')).toEqual(
        noop,
      );
    } finally {
      await cleanup(current);
    }
  });

  it('returns noop for empty history without a model request, Recap or hard-cut event', async () => {
    const provider = new ScriptedProvider([]);
    const current = await fixture(provider);
    const { store, coordinator, thread } = current;
    try {
      const result = await compact(coordinator, thread.threadId, 'compact-empty');
      expect(result).toMatchObject({ status: 'noop', readThroughSeq: 0, recapIds: [] });
      expect(provider.requests).toHaveLength(0);
      expect(store.listRecaps(ownerId, thread.threadId)).toEqual([]);
      expect(store.listEvents(thread.threadId, 0n).map((event) => event.payload.case)).toEqual([
        'threadCreated',
        'environmentBindingChanged',
      ]);
      expect(store.listRuns(ownerId, thread.threadId)).toEqual([]);
      expect(store.listInputs(ownerId, thread.threadId)).toEqual([]);
    } finally {
      await cleanup(current);
    }
  });

  it('rejects active Runs and unfinished tool round trips without cancelling work', async () => {
    const provider = new ScriptedProvider([]);
    const current = await fixture(provider);
    const { store, coordinator, thread } = current;
    try {
      const sent = store.sendMessage(
        action('busy-input', 'SendMessage', {
          threadId: thread.threadId,
          text: 'queued work',
          mode: 'follow_up' as const,
        }),
      );
      await expect(compact(coordinator, thread.threadId, 'compact-busy-run')).rejects.toMatchObject(
        {
          code: 'failed_precondition',
        },
      );
      expect(store.getRunById(sent.runId).status).toBe('queued');
      expect(store.getInput(ownerId, sent.input.inputId).status).toBe('queued');
      expect(provider.requests).toHaveLength(0);
    } finally {
      await cleanup(current);
    }

    const other = await fixture(provider);
    try {
      other.store.context.append({
        threadId: other.thread.threadId,
        agentId: 'thread',
        message: {
          role: 'assistant',
          content: 'call',
          tool_calls: [{ id: 'call-1', name: 'bash', arguments: { command: 'true' } }],
        },
      });
      await expect(
        compact(other.coordinator, other.thread.threadId, 'compact-unfinished-tool'),
      ).rejects.toMatchObject({ code: 'failed_precondition' });
      expect(other.store.listRecaps(ownerId, other.thread.threadId)).toEqual([]);
      expect(provider.requests).toHaveLength(0);
    } finally {
      await cleanup(other);
    }
  });

  it('rejects a running periodic Recap or another compaction', async () => {
    const controlled = controlledProvider();
    const current = await fixture(controlled.provider);
    const { store, coordinator, thread } = current;
    try {
      store.database
        .prepare(
          `INSERT INTO recap_generation_operations(
            operation_id, thread_id, agent_id, view_version, source_message_seqs_json,
            source_fingerprint, instruction_version, request_fingerprint, operation_kind,
            status, created_at, updated_at
          ) VALUES ('periodic-running', ?, 'thread', 0, '[1]', 'source', 1, 'request',
                    'periodic', 'running', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')`,
        )
        .run(thread.threadId);
      appendUser(store, thread.threadId, 'history');
      await expect(
        compact(coordinator, thread.threadId, 'compact-periodic-busy'),
      ).rejects.toMatchObject({ code: 'failed_precondition' });
      store.database
        .prepare(
          "UPDATE recap_generation_operations SET status = 'failed' WHERE operation_id = 'periodic-running'",
        )
        .run();

      const running = compact(coordinator, thread.threadId, 'compact-concurrent');
      await controlled.started;
      const duplicate = compact(coordinator, thread.threadId, 'compact-concurrent');
      await expect(
        compact(coordinator, thread.threadId, 'compact-other-action'),
      ).rejects.toMatchObject({ code: 'failed_precondition' });
      expect(() =>
        store.renameThread(
          action('compact-concurrent', 'RenameThread', {
            threadId: thread.threadId,
            title: 'conflict',
          }),
        ),
      ).toThrowError('The client action ID was already used with different parameters.');
      const otherThread = store.createThread(
        action('create-other-thread', 'CreateThread', { title: 'Other Thread' }),
      );
      await expect(
        compact(coordinator, otherThread.threadId, 'compact-concurrent'),
      ).rejects.toMatchObject({ code: 'action_conflict' });
      controlled.finish();
      const [first, replayed] = await Promise.all([running, duplicate]);
      expect(replayed).toEqual(first);
      expect(controlled.requests).toHaveLength(1);
      expect(await compact(coordinator, thread.threadId, 'compact-concurrent')).toEqual(first);
    } finally {
      await cleanup(current);
    }
  });

  it.each([
    { name: 'empty summary', content: '', toolCall: false, tokenFailure: false },
    { name: 'tool call', content: 'summary', toolCall: true, tokenFailure: false },
    { name: 'token failure', content: 'summary', toolCall: false, tokenFailure: true },
  ])('rolls back $name without a partial hard cut', async ({ content, toolCall, tokenFailure }) => {
    const provider = new ScriptedProvider([
      [
        {
          type: 'response',
          message: {
            role: 'assistant',
            content,
            ...(toolCall
              ? { tool_calls: [{ id: 'call', name: 'bash', arguments: { command: 'true' } }] }
              : {}),
          },
          usage,
        },
      ],
    ]);
    const current = await fixture(provider, () => {
      if (tokenFailure) throw new Error('injected token failure');
      return 100;
    });
    const { store, coordinator, thread } = current;
    try {
      appendUser(store, thread.threadId, 'original');
      await expect(compact(coordinator, thread.threadId, 'compact-failure')).rejects.toMatchObject({
        code: 'recap_invalid',
        terminal: true,
      });
      expect(store.listRecaps(ownerId, thread.threadId)).toEqual([]);
      expect(store.recaps.query({ threadId: thread.threadId, agentId: 'thread' })).toEqual([]);
      expect(
        store.context.query({ threadId: thread.threadId, agentId: 'thread', currentOnly: true }),
      ).toHaveLength(1);
      expect(store.listEvents(thread.threadId, 0n).map((event) => event.payload.case)).toEqual([
        'threadCreated',
        'environmentBindingChanged',
        'hardCutStarted',
        'hardCutFailed',
      ]);
      expect(
        store.database.prepare('SELECT COUNT(*) AS count FROM model_input_recaps').get(),
      ).toEqual({ count: 0 });
      const saved = store.database
        .prepare(
          "SELECT operation_id, status FROM manual_compact_operations WHERE status = 'failed'",
        )
        .get();
      expect(saved).toMatchObject({ status: 'failed' });
      expect(provider.requests).toHaveLength(tokenFailure ? 0 : 1);
      await expect(compact(coordinator, thread.threadId, 'compact-failure')).rejects.toMatchObject({
        code: 'recap_invalid',
        terminal: true,
      });
      expect(provider.requests).toHaveLength(tokenFailure ? 0 : 1);
    } finally {
      await cleanup(current);
    }
  });

  it('rolls back an injected Recap storage failure and records the operation failure', async () => {
    const provider = new ScriptedProvider([response('summary')]);
    const current = await fixture(provider);
    const { store, coordinator, thread } = current;
    try {
      appendUser(store, thread.threadId, 'original');
      store.database.exec(
        "CREATE TRIGGER reject_recap BEFORE INSERT ON recaps BEGIN SELECT RAISE(ABORT, 'injected recap storage failure'); END",
      );
      await expect(compact(coordinator, thread.threadId, 'compact-storage')).rejects.toMatchObject({
        code: 'internal',
        terminal: true,
      });
      expect(store.listRecaps(ownerId, thread.threadId)).toEqual([]);
      expect(
        store.database.prepare('SELECT COUNT(*) AS count FROM model_input_recaps').get(),
      ).toEqual({
        count: 0,
      });
      expect(store.database.prepare('SELECT status FROM manual_compact_operations').get()).toEqual({
        status: 'failed',
      });
      expect(store.listEvents(thread.threadId, 0n).at(-1)?.payload.case).toBe('hardCutFailed');
    } finally {
      await cleanup(current);
    }
  });

  it('keeps the outcome unknown when the compaction failure receipt cannot be saved', async () => {
    const provider = new ScriptedProvider([response('summary')]);
    const current = await fixture(provider);
    const { store, coordinator, thread } = current;
    try {
      appendUser(store, thread.threadId, 'original');
      store.database.exec(
        "CREATE TRIGGER reject_recap BEFORE INSERT ON recaps BEGIN SELECT RAISE(ABORT, 'injected recap storage failure'); END",
      );
      store.database.exec(
        `CREATE TRIGGER reject_compact_failure_receipt BEFORE UPDATE OF response_json ON client_actions
         WHEN OLD.method = 'CompactContext'
         BEGIN SELECT RAISE(ABORT, 'injected failure receipt error'); END`,
      );
      const failure = compact(coordinator, thread.threadId, 'compact-receipt-failure');
      await expect(failure).rejects.toMatchObject({ code: 'internal' });
      await expect(failure).rejects.toMatchObject({ terminal: undefined });
      expect(store.database.prepare('SELECT status FROM manual_compact_operations').get()).toEqual({
        status: 'running',
      });
      expect(store.listEvents(thread.threadId, 0n).at(-1)?.payload.case).toBe('hardCutStarted');
    } finally {
      await cleanup(current);
    }
  });

  it('rejects a revision made during generation without committing stale recaps', async () => {
    const controlled = controlledProvider('stale summary');
    const current = await fixture(controlled.provider);
    const { store, coordinator, thread } = current;
    try {
      const original = appendUser(store, thread.threadId, 'original');
      const running = compact(coordinator, thread.threadId, 'compact-revision');
      await controlled.started;
      store.reviseMessage(
        action('revise-during-compact', 'ReviseMessage', {
          threadId: thread.threadId,
          messageId: original.messageId,
          text: 'revised',
        }),
      );
      controlled.finish();
      await expect(running).rejects.toMatchObject({ code: 'version_conflict' });
      expect(store.listRecaps(ownerId, thread.threadId)).toEqual([]);
      expect(
        store.database
          .prepare('SELECT read_through_seq, view_version FROM model_input_states')
          .get(),
      ).toEqual({
        read_through_seq: 0,
        view_version: 1,
      });
      expect(store.listEvents(thread.threadId, 0n).at(-1)?.payload.case).toBe('hardCutFailed');
    } finally {
      await cleanup(current);
    }
  });
});

it('interrupts manual compaction on close and does not replay it after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-manual-restart-'));
  const path = join(directory, 'state.sqlite');
  const firstDatabase = openDatabase(path);
  const firstStore = new SessionStore(firstDatabase);
  const controlled = controlledProvider();
  const firstCoordinator = new RunCoordinator({
    ...controlledEnvironmentDependencies(firstStore.database, ownerId),
    store: firstStore,
    model: {
      provider: controlled.provider,
      providerId: 'test',
      modelId: 'test-model',
      contextWindowTokens: 1000,
      outputReserveTokens: 0,
      countTokens: () => 100,
    },
  });
  const thread = firstStore.createThread(
    action('create-thread', 'CreateThread', { title: 'Restart compact' }),
  );
  await firstCoordinator.reloadResources({
    ownerId,
    threadId: thread.threadId,
    clientActionId: 'fixture-resources',
  });
  appendUser(firstStore, thread.threadId, 'original');
  const running = compact(firstCoordinator, thread.threadId, 'compact-interrupted');
  await controlled.started;
  const closing = firstCoordinator.close();
  await expect(running).rejects.toMatchObject({ code: 'operation_unknown', terminal: true });
  await closing;
  expect(firstDatabase.prepare('SELECT status FROM manual_compact_operations').get()).toEqual({
    status: 'interrupted',
  });
  expect(firstStore.listEvents(thread.threadId, 0n).at(-1)?.payload.case).toBe('hardCutFailed');
  firstDatabase.close();

  const secondDatabase = openDatabase(path);
  const secondStore = new SessionStore(secondDatabase);
  const provider = new ScriptedProvider([response('new summary')]);
  const secondCoordinator = new RunCoordinator({
    ...controlledEnvironmentDependencies(secondStore.database, ownerId),
    store: secondStore,
    model: {
      provider,
      providerId: 'test',
      modelId: 'test-model',
      contextWindowTokens: 1000,
      outputReserveTokens: 0,
      countTokens: () => 100,
    },
  });
  try {
    secondStore.recoverInterrupted();
    secondCoordinator.recoverManualCompactions();
    await expect(
      compact(secondCoordinator, thread.threadId, 'compact-interrupted'),
    ).rejects.toMatchObject({ code: 'operation_unknown', terminal: true });
    expect(controlled.requests).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    const retried = await compact(secondCoordinator, thread.threadId, 'compact-new-action');
    expect(retried.status).toBe('changed');
    expect(provider.requests).toHaveLength(1);
  } finally {
    await secondCoordinator.close();
    secondDatabase.close();
    await rm(directory, { recursive: true, force: true });
  }
});
