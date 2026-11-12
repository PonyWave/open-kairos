import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelEvent, ModelProvider, ModelRequest } from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import { expect, it, vi } from 'vitest';
import {
  ModelInputService,
  runtimeSpecFingerprint,
  runtimeSpecFingerprintFromRequest,
} from '../context/model-input-service.js';
import { controlledEnvironmentDependencies } from '../integration/environment-fixture.js';
import { openDatabase } from '../storage/database.js';
import type { WorkspaceResourceSnapshot } from '../workspace/index.js';
import type { RunStatus } from './records.js';
import { RunCoordinator } from './runtime.js';
import { SessionStore } from './store.js';

const ownerId = 'owner-runtime-reload';
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

function response(content: string): ModelEvent[] {
  return [
    {
      type: 'response',
      message: { role: 'assistant', content },
      usage,
    },
  ];
}

function action<T extends Record<string, unknown>>(
  method: string,
  clientActionId: string,
  parameters: T,
) {
  return { ownerId, clientActionId, method, parameters, ...parameters };
}

function snapshot(id: string): WorkspaceResourceSnapshot {
  return Object.freeze({
    snapshotId: id,
    systemInstructions: `workspace ${id}`,
    resources: Object.freeze([Object.freeze({ path: 'AGENTS.md', content: `instructions ${id}` })]),
  });
}

function source(ids: string[]) {
  let index = 0;
  return {
    load: vi.fn(async () => {
      const id = ids[index];
      index += 1;
      if (id === undefined) throw new Error('No workspace snapshot remains.');
      return snapshot(id);
    }),
  };
}

async function fixture(provider: ModelProvider, ids = ['old', 'new'], persistent = false) {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-runtime-spec-reload-'));
  const database = openDatabase(persistent ? join(directory, 'state.sqlite') : ':memory:');
  const store = new SessionStore(database);
  const loader = source(ids);
  const dependencies = controlledEnvironmentDependencies(store.database, ownerId);
  dependencies.environmentOperations.loadResources = () => loader.load();
  const coordinator = new RunCoordinator({
    ...dependencies,
    store,
    model: {
      provider,
      providerId: 'test',
      modelId: 'test-model',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
    },
  });
  const thread = store.getOrCreateMainThread(ownerId);
  await coordinator.reloadResources({
    ownerId,
    threadId: thread.threadId,
    clientActionId: 'fixture-initial-resources',
  });
  return { directory, database, store, coordinator, loader, thread };
}

async function cleanup(current: Awaited<ReturnType<typeof fixture>>) {
  await current.coordinator.close();
  current.database.close();
  await rm(current.directory, { recursive: true, force: true });
}

function send(store: SessionStore, threadId: string, text: string, id: string) {
  return store.sendMessage(
    action('SendMessage', id, { threadId, text, mode: 'follow_up' as const }),
  );
}

function reload(coordinator: RunCoordinator, threadId: string, clientActionId: string) {
  return coordinator.reloadResources({ ownerId, threadId, clientActionId });
}

async function waitStatus(store: SessionStore, runId: string, status: RunStatus) {
  await vi.waitFor(() => expect(store.getRunById(runId).status).toBe(status), { timeout: 3000 });
}

function instructions(request: ModelRequest | undefined): string {
  return (request?.messages ?? [])
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
}

async function seedReady(
  current: Awaited<ReturnType<typeof fixture>>,
  requestId: string,
  evidence: 'prepared' | 'dispatched' | 'legacy',
) {
  const { store, database, thread } = current;
  const sent = send(store, thread.threadId, `input ${requestId}`, `send-${requestId}`);
  const user = store.appendModelMessage({
    runId: sent.runId,
    inputId: sent.input.inputId,
    message: { role: 'user', content: sent.input.text },
  });
  store.updateRunStatus(sent.runId, 'interrupted');
  const modelInputs = new ModelInputService(database, { countTokens: () => 100 });
  const prepared = await modelInputs.prepare({
    requestId,
    threadId: thread.threadId,
    agentId: 'thread',
    systemInstructions: ['legacy system'],
    tools: [],
    pendingContextSeqs: [user.seq],
    contextWindowTokens: 128_000,
    outputReserveTokens: 4096,
  });
  store.setCurrentRequestId(sent.runId, requestId);
  if (evidence !== 'legacy') store.recordModelRequestPrepared(sent.runId, requestId);
  if (evidence === 'dispatched') store.recordModelRequestDispatched(sent.runId, requestId);
  return { sent, prepared };
}

function requestRow(current: Awaited<ReturnType<typeof fixture>>, requestId: string) {
  return current.database
    .prepare(
      `SELECT status, request_json, request_fingerprint, read_through_seq, view_version,
       selected_recap_ids_json FROM model_request_records WHERE request_id = ?`,
    )
    .get(requestId);
}

it('hashes ordered system instructions and complete tool definitions with canonical object keys', () => {
  const tools: ModelRequest['tools'] = [
    {
      name: 'example',
      description: 'version one',
      parameters: {
        type: 'object',
        properties: { second: { type: 'string' }, first: { type: 'number' } },
      },
    },
  ];
  const reordered: ModelRequest['tools'] = [
    {
      name: 'example',
      description: 'version one',
      parameters: {
        properties: { first: { type: 'number' }, second: { type: 'string' } },
        type: 'object',
      },
    },
  ];
  const fingerprint = runtimeSpecFingerprint(['base', 'workspace'], tools);
  expect(runtimeSpecFingerprint(['base', 'workspace'], reordered)).toBe(fingerprint);
  expect(runtimeSpecFingerprint(['workspace', 'base'], tools)).not.toBe(fingerprint);
  expect(
    runtimeSpecFingerprint(
      ['base', 'workspace'],
      tools.map((tool) => ({ ...tool, description: 'version two' })),
    ),
  ).not.toBe(fingerprint);
  expect(
    runtimeSpecFingerprintFromRequest({
      messages: [
        { role: 'system', content: 'base' },
        { role: 'system', content: 'workspace' },
        { role: 'user', content: 'message' },
      ],
      tools,
    }),
  ).toBe(fingerprint);
  expect(
    runtimeSpecFingerprintFromRequest({
      messages: [{ role: 'user', content: 'message' }],
      tools,
    }),
  ).toBeUndefined();
});

it('reports the current root runtime fingerprint against the latest completed request in the same view', async () => {
  const provider = new ScriptedProvider([response('old answer'), response('new answer')]);
  const current = await fixture(provider, ['old', 'new', 'new', 'new', 'new']);
  const { store, coordinator, thread, database } = current;
  try {
    const first = send(store, thread.threadId, 'old input', 'send-old');
    await coordinator.deliver(first.input, first.runId);
    await waitStatus(store, first.runId, 'completed');
    const baseline = database.prepare('SELECT request_json FROM model_request_records').get() as {
      request_json: string;
    };

    const changed = await reload(coordinator, thread.threadId, 'reload-new');
    expect(changed).toMatchObject({ changed: true, runtimeChanged: true });
    expect(changed.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const repeated = await reload(coordinator, thread.threadId, 'reload-repeated');
    expect(repeated).toMatchObject({
      changed: false,
      runtimeFingerprint: changed.runtimeFingerprint,
      runtimeChanged: true,
    });
    expect(database.prepare('SELECT request_json FROM model_request_records').get()).toEqual(
      baseline,
    );

    const next = send(store, thread.threadId, 'new input', 'send-new');
    await coordinator.deliver(next.input, next.runId);
    await waitStatus(store, next.runId, 'completed');
    expect(instructions(provider.requests[1])).toContain('instructions new');
    const settled = await reload(coordinator, thread.threadId, 'reload-settled');
    expect(settled).toMatchObject({
      changed: false,
      runtimeFingerprint: changed.runtimeFingerprint,
      runtimeChanged: false,
    });

    database.prepare('UPDATE model_input_states SET view_version = view_version + 1').run();
    const noBaseline = await reload(coordinator, thread.threadId, 'reload-no-baseline');
    expect(noBaseline.runtimeFingerprint).toBe(changed.runtimeFingerprint);
    expect(noBaseline.runtimeChanged).toBeUndefined();
  } finally {
    await cleanup(current);
  }
});

it('invalidates a prepared undispatched request after reopen and rebuilds it only on explicit Continue', async () => {
  let current = await fixture(new ScriptedProvider([]), ['old', 'new'], true);
  const { thread } = current;
  try {
    const { sent, prepared } = await seedReady(current, 'old-safe-ready', 'prepared');
    const before = requestRow(current, 'old-safe-ready');
    const stateBefore = new ModelInputService(current.database, {
      countTokens: () => 100,
    }).getState(thread.threadId, 'thread');
    const contextBefore = current.store.listContext(ownerId, thread.threadId, 'thread');
    await current.coordinator.close();
    current.database.close();

    const provider = new ScriptedProvider([response('continued with current spec')]);
    const database = openDatabase(join(current.directory, 'state.sqlite'));
    const store = new SessionStore(database);
    store.recoverInterrupted();
    const dependencies = controlledEnvironmentDependencies(store.database, ownerId);
    dependencies.environmentOperations.loadResources = () => current.loader.load();
    const coordinator = new RunCoordinator({
      ...dependencies,
      store,
      model: {
        provider,
        providerId: 'test',
        modelId: 'test-model',
        contextWindowTokens: 128_000,
        outputReserveTokens: 4096,
      },
    });
    current = { ...current, database, store, coordinator };

    const result = await reload(coordinator, thread.threadId, 'reload-safe-ready');
    expect(result.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.runtimeChanged).toBeUndefined();
    expect(provider.requests).toHaveLength(0);
    expect(store.getRunById(sent.runId).currentRequestId).toBeNull();
    expect(requestRow(current, 'old-safe-ready')).toEqual({
      ...before,
      status: 'cancelled',
    });
    expect(prepared.request.messages.at(-1)?.content).toBe('input old-safe-ready');
    expect(
      new ModelInputService(database, { countTokens: () => 100 }).getState(
        thread.threadId,
        'thread',
      ),
    ).toEqual(stateBefore);
    expect(store.listContext(ownerId, thread.threadId, 'thread')).toEqual(contextBefore);
    expect(store.listRecaps(ownerId, thread.threadId, 'thread')).toEqual([]);

    const continued = store.continueRun(
      action('ContinueRun', 'continue-safe-ready', {
        threadId: thread.threadId,
        runId: sent.runId,
      }),
    );
    coordinator.schedule(thread.threadId, continued.runId);
    await waitStatus(store, sent.runId, 'completed');
    expect(provider.requests).toHaveLength(1);
    expect(instructions(provider.requests[0])).toContain('instructions new');
    expect(instructions(provider.requests[0])).not.toContain('legacy system');
    expect(provider.requests[0]?.tools.length).toBeGreaterThan(0);
    expect(
      database.prepare('SELECT request_id, status FROM model_request_records ORDER BY rowid').all(),
    ).toEqual([
      { request_id: 'old-safe-ready', status: 'cancelled' },
      { request_id: expect.not.stringMatching(/^old-safe-ready$/), status: 'completed' },
    ]);
    expect(
      store
        .listContext(ownerId, thread.threadId, 'thread')
        .filter((message) => message.message.content === 'input old-safe-ready'),
    ).toHaveLength(1);
    expect(
      database
        .prepare(
          "SELECT event_type FROM context_events WHERE event_type LIKE 'model_request_%' ORDER BY event_seq",
        )
        .all(),
    ).toEqual([
      { event_type: 'model_request_prepared' },
      { event_type: 'model_request_prepared' },
      { event_type: 'model_request_dispatched' },
    ]);
  } finally {
    await cleanup(current);
  }
});

it.each(['dispatched', 'legacy'] as const)(
  'retains a %s ready request as unknown and keeps its spec conflict without a Provider retry',
  async (evidence) => {
    const provider = new ScriptedProvider([response('new Run answer')]);
    const current = await fixture(provider);
    const { store, coordinator, thread } = current;
    try {
      const requestId = `old-${evidence}-ready`;
      const { sent } = await seedReady(current, requestId, evidence);
      const before = requestRow(current, requestId);
      await reload(coordinator, thread.threadId, `reload-${evidence}`);
      expect(store.getRunById(sent.runId).currentRequestId).toBe(requestId);
      expect(requestRow(current, requestId)).toEqual(before);

      const continued = store.continueRun(
        action('ContinueRun', `continue-${evidence}`, {
          threadId: thread.threadId,
          runId: sent.runId,
        }),
      );
      coordinator.schedule(thread.threadId, continued.runId);
      await waitStatus(store, sent.runId, 'failed');
      expect(store.getRunById(sent.runId).error?.code).toBe('action_conflict');
      expect(provider.requests).toHaveLength(0);

      const next = send(store, thread.threadId, `new input ${evidence}`, `send-new-${evidence}`);
      await coordinator.deliver(next.input, next.runId);
      await waitStatus(store, next.runId, 'completed');
      expect(provider.requests).toHaveLength(1);
      expect(instructions(provider.requests[0])).toContain('instructions new');
      expect(requestRow(current, requestId)).toEqual(before);
    } finally {
      await cleanup(current);
    }
  },
);

it('clears preparing, failed and cancelled associations without rewriting their saved request data', async () => {
  const current = await fixture(new ScriptedProvider([]));
  const { store, coordinator, thread, database } = current;
  try {
    const records = [];
    for (const status of ['preparing', 'failed', 'cancelled'] as const) {
      const requestId = `old-${status}`;
      const { sent } = await seedReady(current, requestId, 'legacy');
      database
        .prepare(
          `UPDATE model_request_records SET status = ?, error_code = ?, error_message = ?
           WHERE request_id = ?`,
        )
        .run(
          status,
          status === 'preparing' ? null : 'existing-error',
          status === 'preparing' ? null : `existing ${status} audit`,
          requestId,
        );
      records.push({
        requestId,
        runId: sent.runId,
        status,
        before: requestRow(current, requestId),
      });
    }

    await reload(coordinator, thread.threadId, 'reload-non-ready');
    for (const record of records) {
      expect(store.getRunById(record.runId).currentRequestId).toBeNull();
      expect(requestRow(current, record.requestId)).toEqual({
        ...record.before,
        ...(record.status === 'preparing' ? { status: 'cancelled' } : {}),
      });
    }
  } finally {
    await cleanup(current);
  }
});

it('writes prepared with ready and dispatched before Provider stream without exposing GUI events', async () => {
  let database: ReturnType<typeof openDatabase> | undefined;
  const evidenceAtDispatch: unknown[] = [];
  const provider: ModelProvider = {
    async *stream(_request) {
      evidenceAtDispatch.push(
        database
          ?.prepare(
            "SELECT event_type FROM context_events WHERE event_type LIKE 'model_request_%' ORDER BY event_seq",
          )
          .all(),
      );
      yield* response('evidence recorded');
    },
  };
  const current = await fixture(provider);
  database = current.database;
  const { store, coordinator, thread } = current;
  try {
    const sent = send(store, thread.threadId, 'check evidence', 'send-evidence');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'completed');
    expect(evidenceAtDispatch).toEqual([
      [{ event_type: 'model_request_prepared' }, { event_type: 'model_request_dispatched' }],
    ]);
    expect(JSON.stringify(store.listEvents(thread.threadId, 0n))).not.toContain(
      'model_request_prepared',
    );
  } finally {
    await cleanup(current);
  }
});

it('rolls back ready when prepared evidence cannot commit and does not call Provider', async () => {
  const provider = new ScriptedProvider([response('must not run')]);
  const current = await fixture(provider);
  const { store, coordinator, thread, database } = current;
  try {
    database.exec(`
      CREATE TRIGGER reject_prepared BEFORE INSERT ON context_events
      WHEN NEW.event_type = 'model_request_prepared'
      BEGIN SELECT RAISE(ABORT, 'injected prepared failure'); END;
    `);
    const sent = send(store, thread.threadId, 'prepared rollback', 'send-prepared-rollback');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'failed');
    expect(provider.requests).toHaveLength(0);
    expect(
      database.prepare('SELECT status, error_code, request_json FROM model_request_records').get(),
    ).toEqual({ status: 'failed', error_code: 'storage_failed', request_json: null });
    expect(database.prepare('SELECT COUNT(*) AS count FROM model_input_states').get()).toEqual({
      count: 0,
    });
  } finally {
    await cleanup(current);
  }
});

it('rolls back invalidation when the reload receipt cannot commit and retains the old snapshot', async () => {
  const provider = new ScriptedProvider([response('old snapshot answer')]);
  const current = await fixture(provider, ['old', 'new', 'new']);
  const { store, coordinator, thread, database } = current;
  try {
    const { sent } = await seedReady(current, 'old-atomic-ready', 'prepared');
    const before = requestRow(current, 'old-atomic-ready');
    database.exec(`
      CREATE TRIGGER reject_reload_completion BEFORE UPDATE OF response_json ON client_actions
      WHEN OLD.method = 'ReloadEnvironmentResources' AND NEW.response_json LIKE '%"completed"%'
      BEGIN SELECT RAISE(ABORT, 'injected reload receipt failure'); END;
    `);
    await expect(
      reload(coordinator, thread.threadId, 'reload-atomic-failure'),
    ).rejects.toMatchObject({ code: 'internal', terminal: true });
    expect(store.getRunById(sent.runId).currentRequestId).toBe('old-atomic-ready');
    expect(requestRow(current, 'old-atomic-ready')).toEqual(before);

    const next = send(store, thread.threadId, 'after failed reload', 'send-after-failed-reload');
    await coordinator.deliver(next.input, next.runId);
    await waitStatus(store, next.runId, 'completed');
    expect(instructions(provider.requests[0])).toContain('instructions old');
    expect(instructions(provider.requests[0])).not.toContain('instructions new');

    database.exec('DROP TRIGGER reject_reload_completion');
    await reload(coordinator, thread.threadId, 'reload-atomic-retry');
    expect(store.getRunById(sent.runId).currentRequestId).toBeNull();
    expect(requestRow(current, 'old-atomic-ready')).toMatchObject({ status: 'cancelled' });
  } finally {
    await cleanup(current);
  }
});

it('preserves manual compact audit records and uses the reloaded spec for a new compact operation', async () => {
  const provider = new ScriptedProvider([response('first recap'), response('second recap')]);
  const current = await fixture(provider);
  const { store, coordinator, thread } = current;
  try {
    const sent = send(store, thread.threadId, 'compact source', 'send-compact-source');
    store.appendModelMessage({
      runId: sent.runId,
      inputId: sent.input.inputId,
      message: { role: 'user', content: sent.input.text },
    });
    store.updateRunStatus(sent.runId, 'interrupted');
    await coordinator.compactContext({
      ownerId,
      threadId: thread.threadId,
      clientActionId: 'compact-before-reload',
    });
    const manual = store.database
      .prepare('SELECT operation_id FROM manual_compact_operations')
      .get() as { operation_id: string };
    const before = requestRow(current, manual.operation_id);
    const recapsBefore = store.listRecaps(ownerId, thread.threadId, 'thread');

    await reload(coordinator, thread.threadId, 'reload-preserve-manual');
    expect(requestRow(current, manual.operation_id)).toEqual(before);
    expect(store.listRecaps(ownerId, thread.threadId, 'thread')).toEqual(recapsBefore);
    expect(provider.requests).toHaveLength(1);

    store.appendModelMessage({
      runId: sent.runId,
      message: { role: 'user', content: 'new compact source' },
    });
    await coordinator.compactContext({
      ownerId,
      threadId: thread.threadId,
      clientActionId: 'compact-after-reload',
    });
    expect(provider.requests).toHaveLength(2);
    expect(instructions(provider.requests[1])).toContain('instructions new');
    expect(instructions(provider.requests[1])).not.toContain('instructions old');
  } finally {
    await cleanup(current);
  }
});
