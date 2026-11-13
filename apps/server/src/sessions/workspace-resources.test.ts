import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelEvent, ModelProvider, ModelRequest, ToolCall } from '@kairos/agent-core';
import { expect, it, vi } from 'vitest';
import { stripMessageMeta } from '../context/model-input.js';
import {
  controlledEnvironmentDependencies,
  seedTestTenant,
} from '../integration/environment-fixture.js';
import { openDatabase } from '../storage/database.js';
import type { WorkspaceResourceSnapshot } from '../workspace/index.js';
import { SessionError } from './errors.js';
import type { RunStatus } from './records.js';
import { RunCoordinator } from './runtime.js';
import { SessionStore } from './store.js';

const ownerId = 'owner-1';
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

function response(content: string, toolCalls?: ToolCall[]): ModelEvent[] {
  return [
    {
      type: 'response',
      message: {
        role: 'assistant',
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
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

function deferred() {
  let resolve = () => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class GatedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  readonly gates: Array<ReturnType<typeof deferred>>;

  constructor(readonly responses: ModelEvent[][]) {
    this.gates = responses.map(() => deferred());
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const index = this.requests.length;
    this.requests.push(structuredClone(request));
    const gate = this.gates[index];
    const events = this.responses[index];
    if (!gate || !events) throw new Error('No gated response remains.');
    await Promise.race([
      gate.promise,
      new Promise<void>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
    signal.throwIfAborted();
    for (const event of events) yield event;
  }
}

function snapshot(
  id: string,
  resources: Array<{ path: string; content: string }> = [
    { path: 'AGENTS.md', content: `instructions ${id}` },
  ],
): WorkspaceResourceSnapshot {
  return Object.freeze({
    snapshotId: id,
    systemInstructions: `workspace ${id}`,
    resources: Object.freeze(resources.map((resource) => Object.freeze(resource))),
  });
}

function source(
  responses: Array<WorkspaceResourceSnapshot | Error | Promise<WorkspaceResourceSnapshot>>,
) {
  let index = 0;
  return {
    load: vi.fn(async () => {
      const next = responses[index];
      index += 1;
      if (next === undefined) throw new Error('No workspace snapshot remains.');
      if (next instanceof Error) throw next;
      return await next;
    }),
  };
}

async function fixture(loader: ReturnType<typeof source>, provider: ModelProvider) {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-workspace-reload-'));
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
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
  seedTestTenant(database, 'workspace-other-owner');
  const other = store.getOrCreateMainThread('workspace-other-owner');
  await coordinator.reloadResources({
    ownerId,
    threadId: thread.threadId,
    clientActionId: 'fixture-initial-resources',
  });
  return { directory, database, store, coordinator, thread, other };
}

async function cleanup(current: Awaited<ReturnType<typeof fixture>>) {
  await current.coordinator.close();
  current.database.close();
  await rm(current.directory, { recursive: true, force: true });
}

function send(
  store: SessionStore,
  threadId: string,
  text: string,
  id: string,
  mode: 'follow_up' | 'steer' = 'follow_up',
) {
  return store.sendMessage(action('SendMessage', id, { threadId, text, mode }));
}

function reload(
  coordinator: RunCoordinator,
  threadId: string,
  clientActionId: string,
  tenantId = ownerId,
) {
  return coordinator.reloadResources({ ownerId: tenantId, threadId, clientActionId });
}

async function waitStatus(store: SessionStore, runId: string, status: RunStatus) {
  await vi.waitFor(() => expect(store.getRunById(runId).status).toBe(status), { timeout: 3000 });
}

async function waitRequests(provider: GatedProvider, count: number) {
  await vi.waitFor(() => expect(provider.requests).toHaveLength(count), { timeout: 3000 });
}

function instructions(request: ModelRequest | undefined): string {
  return (request?.messages ?? [])
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
}

it('pins an active Run while another Thread reloads and reloads its own default for a later Run', async () => {
  const loader = source([snapshot('old'), snapshot('new'), snapshot('new')]);
  const provider = new GatedProvider([
    response('', [
      {
        id: 'recall-1',
        name: 'recall',
        arguments: { sql: 'SELECT thread_id FROM thread LIMIT 1' },
      },
    ]),
    response('steered answer'),
    response('follow-up answer'),
    response('new answer'),
  ]);
  const current = await fixture(loader, provider);
  const { store, coordinator, thread, other } = current;
  try {
    const initial = send(store, thread.threadId, 'initial', 'send-initial');
    await coordinator.deliver(initial.input, initial.runId);
    await waitRequests(provider, 1);
    expect(instructions(provider.requests[0])).toContain('instructions old');

    await expect(reload(coordinator, thread.threadId, 'reload-busy')).rejects.toMatchObject({
      code: 'failed_precondition',
    });
    expect(store.getRunById(initial.runId).status).not.toBe('cancelled');
    const changed = await reload(coordinator, other.threadId, 'reload-other', other.ownerId);
    expect(changed).toEqual({
      snapshotId: expect.stringMatching(/^[a-f0-9]{64}$/),
      changed: true,
      resources: ['AGENTS.md'],
      added: ['AGENTS.md'],
      updated: [],
      removed: [],
    });
    expect(loader.load).toHaveBeenCalledTimes(2);
    expect(provider.requests).toHaveLength(1);

    const steer = send(store, thread.threadId, 'steer', 'send-steer', 'steer');
    await coordinator.deliver(steer.input, steer.runId);
    const followUp = send(store, thread.threadId, 'follow up', 'send-follow-up');
    await coordinator.deliver(followUp.input, followUp.runId);
    provider.gates[0]?.resolve();
    await waitRequests(provider, 2);
    expect(instructions(provider.requests[1])).toContain('instructions old');
    expect(instructions(provider.requests[1])).not.toContain('instructions new');
    expect(
      provider.requests[1]?.messages.some(
        (message) => stripMessageMeta(String(message.content)) === 'steer',
      ),
    ).toBe(true);

    provider.gates[1]?.resolve();
    await waitRequests(provider, 3);
    expect(instructions(provider.requests[2])).toContain('instructions old');
    expect(stripMessageMeta(String(provider.requests[2]?.messages.at(-1)?.content))).toBe(
      'follow up',
    );
    provider.gates[2]?.resolve();
    await waitStatus(store, initial.runId, 'completed');

    await reload(coordinator, thread.threadId, 'reload-own-default');
    const next = send(store, thread.threadId, 'new execution', 'send-new-execution');
    await coordinator.deliver(next.input, next.runId);
    await waitRequests(provider, 4);
    expect(instructions(provider.requests[3])).toContain('instructions new');
    expect(instructions(provider.requests[3])).not.toContain('instructions old');
    provider.gates[3]?.resolve();
    await waitStatus(store, next.runId, 'completed');
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await cleanup(current);
  }
});

it('inherits fixed workspace resources in a foreground Subagent', async () => {
  const loader = source([snapshot('old'), snapshot('new')]);
  const provider = new GatedProvider([
    response('', [
      { id: 'child-call', name: 'subagent', arguments: { task: 'child task', mode: 'foreground' } },
    ]),
    response('child answer'),
    response('parent answer'),
  ]);
  const current = await fixture(loader, provider);
  const { store, coordinator, thread, other } = current;
  try {
    const parent = send(store, thread.threadId, 'parent task', 'send-parent');
    await coordinator.deliver(parent.input, parent.runId);
    await waitRequests(provider, 1);
    await reload(coordinator, other.threadId, 'reload-during-parent', other.ownerId);
    provider.gates[0]?.resolve();

    await waitRequests(provider, 2);
    expect(instructions(provider.requests[1])).not.toContain('instructions new');
    expect(instructions(provider.requests[1])).toContain('instructions old');
    expect(stripMessageMeta(String(provider.requests[1]?.messages.at(-1)?.content))).toBe(
      'child task',
    );
    provider.gates[1]?.resolve();
    await waitRequests(provider, 3);
    expect(instructions(provider.requests[2])).toContain('instructions old');
    expect(instructions(provider.requests[2])).not.toContain('instructions new');
    provider.gates[2]?.resolve();
    await waitStatus(store, parent.runId, 'completed');
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await cleanup(current);
  }
});

it('loads a task Thread workspace independently from its main Agent', async () => {
  const loader = source([snapshot('old'), snapshot('new'), snapshot('new')]);
  const provider = new GatedProvider([
    response('', [
      {
        id: 'parent-recall',
        name: 'recall',
        arguments: { sql: 'SELECT thread_id FROM thread LIMIT 1' },
      },
    ]),
    response('', [
      {
        id: 'target-recall',
        name: 'recall',
        arguments: { sql: 'SELECT thread_id FROM thread LIMIT 1' },
      },
    ]),
    response('parent progress'),
    response('target response'),
    response('parent received target'),
  ]);
  const current = await fixture(loader, provider);
  const { store, coordinator, other } = current;
  try {
    const main = store.getOrCreateMainThread(ownerId);
    const target = store.createThread(
      action('CreateThread', 'create-workspace-target', { title: 'Unbound target' }),
    );
    const parent = send(store, main.threadId, 'parent delegation', 'send-parent-delegation');
    await coordinator.deliver(parent.input, parent.runId);
    await waitRequests(provider, 1);
    expect(instructions(provider.requests[0])).toContain('instructions old');

    await reload(coordinator, other.threadId, 'reload-before-thread-call', other.ownerId);
    const accepted = store.acceptThreadCall({
      ownerId,
      sourceThreadId: main.threadId,
      sourceAgentId: 'thread',
      sourceRunId: parent.runId,
      sourceToolCallId: 'thread-call-1',
      targetThreadId: target.threadId,
      prompt: 'delegated task',
      mode: 'follow_up',
    });
    expect(accepted.interaction.kind).toBe('thread_call');
    await coordinator.scheduleThreadCall(accepted);
    await waitRequests(provider, 2);
    expect(stripMessageMeta(String(provider.requests[1]?.messages.at(-1)?.content))).toBe(
      'delegated task',
    );
    expect(instructions(provider.requests[1])).toContain('instructions new');
    expect(instructions(provider.requests[1])).not.toContain('instructions old');

    provider.gates[0]?.resolve();
    await waitRequests(provider, 3);
    expect(instructions(provider.requests[2])).toContain('instructions old');
    provider.gates[1]?.resolve();
    await waitRequests(provider, 4);
    expect(instructions(provider.requests[3])).toContain('instructions new');
    expect(instructions(provider.requests[3])).not.toContain('instructions old');

    provider.gates[3]?.resolve();
    await waitStatus(store, accepted.runId, 'completed');
    provider.gates[2]?.resolve();
    await waitRequests(provider, 5);
    expect(provider.requests[4]?.messages.at(-1)?.content).toContain('"kind":"thread_call"');
    expect(instructions(provider.requests[4])).toContain('instructions old');
    expect(instructions(provider.requests[4])).not.toContain('instructions new');
    provider.gates[4]?.resolve();
    await waitStatus(store, parent.runId, 'completed');
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await cleanup(current);
  }
});

it('keeps background Subagent resources fixed through another Thread reload', async () => {
  const loader = source([snapshot('old'), snapshot('new')]);
  const provider = new GatedProvider([
    response('', [
      {
        id: 'old-child-call',
        name: 'subagent',
        arguments: { task: 'old child task', mode: 'background' },
      },
    ]),
    response('', [
      {
        id: 'old-child-recall',
        name: 'recall',
        arguments: { sql: 'SELECT thread_id FROM thread LIMIT 1' },
      },
    ]),
    response('parent accepted old child'),
    response('old child answer'),
    response('', [
      {
        id: 'new-child-call',
        name: 'subagent',
        arguments: { task: 'new child task', mode: 'background' },
      },
    ]),
    response('new child answer'),
    response('parent accepted new child'),
    response('parent done'),
  ]);
  const current = await fixture(loader, provider);
  const { store, coordinator, thread, other } = current;
  try {
    const parent = send(store, thread.threadId, 'background parent', 'send-background-parent');
    await coordinator.deliver(parent.input, parent.runId);
    await waitRequests(provider, 1);
    provider.gates[0]?.resolve();
    await waitRequests(provider, 3);
    expect(stripMessageMeta(String(provider.requests[1]?.messages.at(-1)?.content))).toBe(
      'old child task',
    );
    expect(instructions(provider.requests[1])).toContain('instructions old');
    expect(instructions(provider.requests[2])).toContain('instructions old');

    await reload(coordinator, other.threadId, 'reload-during-background-child', other.ownerId);
    provider.gates[1]?.resolve();
    await waitRequests(provider, 4);
    expect(provider.requests[3]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'old-child-recall',
    });
    expect(instructions(provider.requests[3])).toContain('instructions old');
    expect(instructions(provider.requests[3])).not.toContain('instructions new');

    provider.gates[3]?.resolve();
    provider.gates[2]?.resolve();
    await waitRequests(provider, 5);
    expect(provider.requests[4]?.messages.at(-1)?.content).toContain('old child answer');
    expect(instructions(provider.requests[4])).toContain('instructions old');
    provider.gates[4]?.resolve();
    await waitRequests(provider, 7);
    expect(stripMessageMeta(String(provider.requests[5]?.messages.at(-1)?.content))).toBe(
      'new child task',
    );
    expect(instructions(provider.requests[5])).not.toContain('instructions new');
    expect(instructions(provider.requests[5])).toContain('instructions old');
    expect(instructions(provider.requests[6])).toContain('instructions old');

    provider.gates[5]?.resolve();
    provider.gates[6]?.resolve();
    await waitRequests(provider, 8);
    expect(provider.requests[7]?.messages.at(-1)?.content).toContain('new child answer');
    expect(instructions(provider.requests[7])).toContain('instructions old');
    expect(instructions(provider.requests[7])).not.toContain('instructions new');
    provider.gates[7]?.resolve();
    await waitStatus(store, parent.runId, 'completed');
    const children = store
      .listRuns(ownerId, thread.threadId)
      .filter((run) => run.parentRunId === parent.runId);
    expect(children).toHaveLength(2);
    for (const child of children) await waitStatus(store, child.runId, 'completed');
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await cleanup(current);
  }
});

it('rechecks idleness at commit and retains the old snapshot after a read failure', async () => {
  const loading = deferred();
  const pendingSnapshot = loading.promise.then(() => snapshot('new'));
  const loader = source([
    snapshot('old'),
    pendingSnapshot,
    new Error('read failed'),
    snapshot('new'),
  ]);
  const provider = new GatedProvider([response('old answer'), response('still old answer')]);
  const current = await fixture(loader, provider);
  const { store, coordinator, thread, other } = current;
  try {
    const raced = reload(coordinator, thread.threadId, 'reload-race');
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledTimes(2));
    const queued = send(store, thread.threadId, 'queued during reload', 'send-race');
    loading.resolve();
    await expect(raced).rejects.toMatchObject({ code: 'failed_precondition' });
    expect(store.getRunById(queued.runId).status).toBe('queued');

    await coordinator.deliver(queued.input, queued.runId);
    await waitRequests(provider, 1);
    expect(instructions(provider.requests[0])).toContain('instructions old');
    provider.gates[0]?.resolve();
    await waitStatus(store, queued.runId, 'completed');

    await expect(
      reload(coordinator, other.threadId, 'reload-read-error', other.ownerId),
    ).rejects.toMatchObject({
      code: 'failed_precondition',
      message: expect.stringContaining('read failed'),
      terminal: true,
    });
    await expect(
      reload(coordinator, other.threadId, 'reload-read-error', other.ownerId),
    ).rejects.toMatchObject({
      code: 'failed_precondition',
      message: expect.stringContaining('read failed'),
      terminal: true,
    });
    expect(loader.load).toHaveBeenCalledTimes(3);
    const next = send(store, thread.threadId, 'after read error', 'send-after-error');
    await coordinator.deliver(next.input, next.runId);
    await waitRequests(provider, 2);
    expect(instructions(provider.requests[1])).toContain('instructions old');
    provider.gates[1]?.resolve();
    await waitStatus(store, next.runId, 'completed');

    expect(
      await reload(coordinator, other.threadId, 'reload-after-error', other.ownerId),
    ).toMatchObject({
      snapshotId: expect.stringMatching(/^[a-f0-9]{64}$/),
      changed: true,
      added: ['AGENTS.md'],
    });
  } finally {
    loading.resolve();
    for (const gate of provider.gates) gate.resolve();
    await cleanup(current);
  }
});

it('shares in-flight actions, replays completed results before busy checks and rejects conflicts', async () => {
  const loading = deferred();
  const loader = source([snapshot('old'), loading.promise.then(() => snapshot('new'))]);
  const provider = new GatedProvider([]);
  const current = await fixture(loader, provider);
  const { store, coordinator, thread } = current;
  try {
    const input = { ownerId, threadId: thread.threadId, clientActionId: 'reload-shared' };
    const first = coordinator.reloadResources(input);
    const duplicate = coordinator.reloadResources(input);
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledTimes(2));
    await expect(coordinator.compactContext(input)).rejects.toMatchObject({
      code: 'action_conflict',
    });
    await expect(
      coordinator.reloadResources({
        ...input,
        threadId: store.createThread(
          action('CreateThread', 'same-owner-task', { title: 'Same owner task' }),
        ).threadId,
      }),
    ).rejects.toMatchObject({ code: 'action_conflict' });
    loading.resolve();
    const result = await first;
    expect(await duplicate).toEqual(result);
    expect(loader.load).toHaveBeenCalledTimes(2);
    expect(store.listInputs(ownerId, thread.threadId)).toEqual([]);
    expect(store.listRuns(ownerId, thread.threadId)).toEqual([]);
    expect(store.listContext(ownerId, thread.threadId, 'thread')).toEqual([]);
    expect(store.listRecaps(ownerId, thread.threadId, 'thread')).toEqual([]);

    const queued = send(store, thread.threadId, 'busy after replay', 'send-replay-busy');
    expect(await coordinator.reloadResources(input)).toEqual(result);
    expect(store.getRunById(queued.runId).status).toBe('queued');
    await expect(
      reload(coordinator, thread.threadId, 'reload-new-while-busy'),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
    expect(() =>
      store.renameThread(
        action('RenameThread', 'reload-shared', { threadId: thread.threadId, title: '冲突' }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'action_conflict' }));
  } finally {
    loading.resolve();
    await cleanup(current);
  }
});

it('waits for an in-flight reload during close and commits its receipt', async () => {
  const loading = deferred();
  const loader = source([snapshot('old'), loading.promise.then(() => snapshot('new'))]);
  const current = await fixture(loader, new GatedProvider([]));
  const { coordinator, thread } = current;
  const input = { ownerId, threadId: thread.threadId, clientActionId: 'reload-close' };
  let closing: Promise<void> | undefined;
  try {
    const reloaded = coordinator.reloadResources(input);
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledTimes(2));
    let closed = false;
    closing = coordinator.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    loading.resolve();
    expect(await reloaded).toMatchObject({
      snapshotId: expect.stringMatching(/^[a-f0-9]{64}$/),
      changed: true,
    });
    await closing;
    expect(closed).toBe(true);
    expect(await coordinator.reloadResources(input)).toMatchObject({
      snapshotId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(loader.load).toHaveBeenCalledTimes(2);
  } finally {
    loading.resolve();
    await closing;
    current.database.close();
    await rm(current.directory, { recursive: true, force: true });
  }
});

it('fixes each manual compaction prompt and rejects reload on that Thread', async () => {
  const loader = source([snapshot('old'), snapshot('new'), snapshot('new')]);
  const provider = new GatedProvider([response('first summary'), response('second summary')]);
  const current = await fixture(loader, provider);
  const { store, coordinator, thread, other } = current;
  try {
    store.context.append({
      threadId: thread.threadId,
      agentId: 'thread',
      message: { role: 'user', content: 'original' },
    });
    const compacting = coordinator.compactContext({
      ownerId,
      threadId: thread.threadId,
      clientActionId: 'compact-fixed',
    });
    await waitRequests(provider, 1);
    expect(instructions(provider.requests[0])).toContain('instructions old');
    await expect(
      reload(coordinator, thread.threadId, 'reload-during-compact'),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
    await expect(reload(coordinator, thread.threadId, 'compact-fixed')).rejects.toMatchObject({
      code: 'action_conflict',
    });
    await reload(coordinator, other.threadId, 'reload-other-compact', other.ownerId);
    provider.gates[0]?.resolve();
    await compacting;

    store.context.append({
      threadId: thread.threadId,
      agentId: 'thread',
      message: { role: 'user', content: 'new suffix' },
    });
    await reload(coordinator, thread.threadId, 'reload-own-after-compact');
    const next = coordinator.compactContext({
      ownerId,
      threadId: thread.threadId,
      clientActionId: 'compact-next-version',
    });
    await waitRequests(provider, 2);
    expect(instructions(provider.requests[1])).toContain('instructions new');
    expect(instructions(provider.requests[1])).not.toContain('instructions old');
    provider.gates[1]?.resolve();
    await next;
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await cleanup(current);
  }
});

it('recovers persisted running reloads after restart without changing completed receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-workspace-restart-'));
  const path = join(directory, 'state.sqlite');
  const seedDatabase = openDatabase(path);
  const seedStore = new SessionStore(seedDatabase);
  seedTestTenant(seedDatabase, ownerId);
  const thread = seedStore.getOrCreateMainThread(ownerId);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ threadId: thread.threadId }))
    .digest('hex');
  const completed = {
    snapshotId: 'committed',
    changed: true,
    resources: ['AGENTS.md'],
    added: [],
    updated: ['AGENTS.md'],
    removed: [],
  };
  const now = '2026-11-04T00:00:00.000Z';
  const insert = seedDatabase.prepare(
    `INSERT INTO client_actions(
      owner_id, client_action_id, method, fingerprint, response_json, created_at
    ) VALUES (?, ?, 'ReloadEnvironmentResources', ?, ?, ?)`,
  );
  insert.run(
    ownerId,
    'reload-completed',
    fingerprint,
    JSON.stringify({ status: 'completed', result: completed }),
    now,
  );
  insert.run(ownerId, 'reload-running', fingerprint, JSON.stringify({ status: 'running' }), now);
  seedDatabase.close();

  const database = openDatabase(path);
  const store = new SessionStore(database);
  const loader = source([snapshot('restart-new')]);
  const dependencies = controlledEnvironmentDependencies(store.database, ownerId);
  dependencies.environmentOperations.loadResources = () => loader.load();
  const coordinator = new RunCoordinator({
    ...dependencies,
    store,
  });
  try {
    await expect(reload(coordinator, thread.threadId, 'reload-running')).rejects.toSatisfy(
      (error) =>
        error instanceof SessionError &&
        error.code === 'operation_unknown' &&
        error.terminal === undefined,
    );

    coordinator.recoverManualCompactions();
    await expect(reload(coordinator, thread.threadId, 'reload-running')).rejects.toMatchObject({
      code: 'operation_unknown',
      message: expect.stringContaining('Server restarted'),
      retryable: true,
      clientActionId: 'reload-running',
      terminal: true,
    });
    const row = database
      .prepare("SELECT response_json FROM client_actions WHERE client_action_id = 'reload-running'")
      .get() as { response_json: string };
    expect(JSON.parse(row.response_json)).toMatchObject({
      status: 'interrupted',
      error: { code: 'operation_unknown', retryable: true },
    });

    expect(await reload(coordinator, thread.threadId, 'reload-completed')).toEqual(completed);
    expect(loader.load).toHaveBeenCalledTimes(0);
    expect(await reload(coordinator, thread.threadId, 'reload-new')).toMatchObject({
      snapshotId: expect.stringMatching(/^[a-f0-9]{64}$/),
      changed: true,
      added: ['AGENTS.md'],
    });
    expect(loader.load).toHaveBeenCalledTimes(1);
  } finally {
    await coordinator.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
