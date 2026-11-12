import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ToolCall,
  ToolMessage,
} from '@kairos/agent-core';
import { expect, it, vi } from 'vitest';
import {
  controlledEnvironmentDependencies,
  seedTestEnvironment,
  seedTestTenant,
  testEnvironmentPolicyInput,
} from '../../integration/environment-fixture.js';
import { openDatabase } from '../../storage/database.js';
import type { RunStatus } from '../records.js';
import { RunCoordinator } from '../runtime.js';
import { SessionStore } from '../store.js';

const ownerId = 'owner-1';
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

function response(content: string, toolCalls?: ToolCall[]): ModelEvent[] {
  return [
    { type: 'text_delta', text: content },
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

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function requestKey(request: ModelRequest): string {
  const last = request.messages.at(-1);
  if (last?.role === 'tool') return `tool:${last.tool_call_id}`;
  if (last?.role === 'user') {
    if (last.content.includes('"kind":"thread_call"')) return 'delivery:thread';
    if (last.content.includes('"kind":"subagent"')) return 'delivery:subagent';
    return `user:${last.content}`;
  }
  return last?.role ?? 'empty';
}

class ControlledProvider implements ModelProvider {
  readonly requests: Array<{ key: string; request: ModelRequest }> = [];
  readonly #responses = new Map<string, ModelEvent[]>();
  readonly #gates = new Map<string, ReturnType<typeof deferred>>();

  register(key: string, events: ModelEvent[]): void {
    this.#responses.set(key, events);
    if (!this.#gates.has(key)) this.#gates.set(key, deferred());
  }

  resolve(key: string): void {
    const gate = this.#gates.get(key);
    if (!gate) throw new Error(`No response gate registered for ${key}.`);
    gate.resolve();
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const key = requestKey(request);
    this.requests.push({ key, request: structuredClone(request) });
    const gate = this.#gates.get(key);
    if (!this.#responses.has(key) || !gate) {
      throw new Error(`No controlled response registered for ${key}.`);
    }
    await Promise.race([
      gate.promise,
      new Promise<void>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
    signal.throwIfAborted();
    const events = this.#responses.get(key);
    if (!events) throw new Error(`No controlled response registered for ${key}.`);
    if (events.length === 0) throw new Error(`Controlled model failure for ${key}.`);
    for (const event of events) yield event;
  }
}

async function fixture(
  provider: ModelProvider,
  runtime: {
    maxActiveThreads?: number;
    maxConcurrentModelRequests?: number;
    maxSubagentDepth?: number;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-delegation-'));
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  const dependencies = controlledEnvironmentDependencies(store.database, ownerId);
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
    ...runtime,
  });
  const main = store.getOrCreateMainThread(ownerId);
  return {
    database,
    store,
    coordinator,
    main,
    directory,
    environmentOperations: dependencies.environmentOperations,
  };
}

function action<T extends Record<string, unknown>>(
  method: string,
  clientActionId: string,
  parameters: T,
) {
  return { ownerId, clientActionId, method, parameters, ...parameters };
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

async function waitStatus(store: SessionStore, runId: string, status: RunStatus) {
  await vi.waitFor(() => expect(store.getRunById(runId).status).toBe(status), { timeout: 3000 });
}

async function waitRequest(provider: ControlledProvider, key: string) {
  await vi
    .waitFor(() => expect(provider.requests.some((request) => request.key === key)).toBe(true), {
      timeout: 3000,
    })
    .catch((error: unknown) => {
      const actual = provider.requests.map((request) => request.key).join(', ');
      throw new Error(`Missing model request ${key}; received: ${actual}`, { cause: error });
    });
}

function toolMessage(store: SessionStore, threadId: string, callId: string): ToolMessage {
  const message = store
    .listContext(ownerId, threadId, 'thread')
    .find(
      (record) => record.message.role === 'tool' && record.message.tool_call_id === callId,
    )?.message;
  if (message?.role !== 'tool') throw new Error(`Tool result ${callId} is missing.`);
  return message;
}

function delegationKey(sourceThreadId: string, sourceToolCallId: string) {
  return { sourceThreadId, sourceAgentId: 'thread', sourceToolCallId };
}

async function cleanup(
  coordinator: RunCoordinator,
  database: ReturnType<typeof openDatabase>,
  directory: string,
) {
  await coordinator.close();
  database.close();
  await rm(directory, { recursive: true, force: true });
}

it('exposes main Agent delegation choices and delivery guidance in actual model requests', async () => {
  const provider = new ControlledProvider();
  provider.register('user:inspect guidance', response('done'));
  provider.resolve('user:inspect guidance');
  const { database, store, coordinator, main, directory } = await fixture(provider);
  try {
    const sent = send(store, main.threadId, 'inspect guidance', 'send-guidance');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'completed');
    const request = provider.requests.find(
      (candidate) => candidate.key === 'user:inspect guidance',
    )?.request;
    if (!request) throw new Error('Guidance model request is missing.');
    const system = request.messages
      .flatMap((message) => (message.role === 'system' ? [message.content] : []))
      .join('\n');
    expect(system).toContain('accepted is not completion');
    expect(system).toContain('Persisted results auto-inject');
    expect(system).toContain('finish this turn without cancelling it');
    expect(system).toContain('You are the main Agent');
    expect(system).toContain('Delegate multi-step investigations, code changes');
    expect(system).toContain('more than two rounds of execution tools');
    expect(system).toContain('Use Subagent for a bounded one-off task');
    expect(system).toContain('This remains a Subagent task when it takes a long time');
    expect(system).toContain('Use a task Thread for ongoing work');
    expect(system).toContain('Reuse a relevant existing Thread');
    expect(system).toContain('Choose whether a task needs a persistent Thread before choosing');
    expect(system).toContain('call the skill tool with the Skill name to load its full SKILL.md');
    expect(system).toContain('completion checks');
    expect(system).toContain('Verify before reporting completion');
    expect(system).not.toContain('You are the root Agent of a persistent task Thread');
    expect(system).not.toContain('You are a Subagent assigned');

    const threadCall = request.tools.find((tool) => tool.name === 'thread_call');
    expect(threadCall?.description).toContain('the accepted receipt is not completion');
    expect(threadCall?.description).toContain('continued user conversation');
    expect(threadCall?.description).toContain('remains in the task list');
    expect(threadCall?.description).toContain('bounded one-off deliverable');
    expect(threadCall?.description).toContain('run in the background only');
    expect(threadCall?.description).toContain('Do not use thread_read or wait_ms');
    const subagent = request.tools.find((tool) => tool.name === 'subagent');
    expect(subagent?.description).toContain('bounded one-off task');
    expect(subagent?.description).toContain('A lengthy one-off task still belongs here');
    expect(subagent?.description).toContain('self-contained task');
    expect(subagent?.description).toContain('Prefer background for lengthy or independent work');
    expect(subagent?.description).toContain(
      'Use foreground when the next step needs the result immediately',
    );
    expect(subagent?.description).toContain('Background returns accepted, which is not completion');
    expect(subagent?.description).toContain('Do not use subagent_status or wait_ms');

    for (const name of ['thread_read', 'subagent_status']) {
      const tool = request.tools.find((candidate) => candidate.name === name);
      expect(tool?.description).toContain('an explicit status check');
      expect(tool?.description).toContain(
        'Automatic delivery makes routine reads and polling unnecessary',
      );
      expect(tool?.parameters).toMatchObject({
        properties: {
          wait_ms: {
            minimum: 1,
            maximum: 30_000,
            description: expect.stringContaining('omit for an immediate read'),
          },
        },
      });
      expect(JSON.stringify(tool?.parameters)).toContain('Do not use by default after creation');
    }
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it.each(['main', 'task'] as const)(
  'keeps execution guidance and delegated context separate for a %s Thread and its Subagent',
  async (threadType) => {
    const provider = new ControlledProvider();
    provider.register(
      'user:parent-only conversation',
      response('', [
        {
          id: 'role-child',
          name: 'subagent',
          arguments: { task: 'inspect delegated scope', mode: 'foreground' },
        },
      ]),
    );
    provider.register('user:inspect delegated scope', response('child result'));
    provider.register('tool:role-child', response('parent result'));
    for (const key of [
      'user:parent-only conversation',
      'user:inspect delegated scope',
      'tool:role-child',
    ]) {
      provider.resolve(key);
    }
    const { database, store, coordinator, main, directory } = await fixture(provider);
    try {
      const parent =
        threadType === 'main'
          ? main
          : store.createThread(action('CreateThread', 'role-task', { title: '长期任务' }));
      const sent = send(store, parent.threadId, 'parent-only conversation', 'role-input');
      await coordinator.deliver(sent.input, sent.runId);
      await waitStatus(store, sent.runId, 'completed');
      const parentRequest = provider.requests.find(
        (request) => request.key === 'user:parent-only conversation',
      )?.request;
      const childRequest = provider.requests.find(
        (request) => request.key === 'user:inspect delegated scope',
      )?.request;
      if (!parentRequest || !childRequest) throw new Error('Role model requests are missing.');
      const parentSystem = parentRequest.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      expect(parentSystem).toContain(
        threadType === 'main'
          ? 'You are the main Agent'
          : 'You are the root Agent of a persistent task Thread',
      );
      expect(parentSystem.includes('You are the main Agent')).toBe(threadType === 'main');
      expect(parentRequest.tools.some((tool) => tool.name === 'thread_call')).toBe(
        threadType === 'main',
      );
      const childSystem = childRequest.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      expect(childSystem).toContain('You are a Subagent assigned a bounded one-off task');
      expect(childSystem).toContain('Return a self-contained final response');
      expect(childSystem).toContain("The caller's full conversation is not included");
      expect(childSystem).not.toContain('You are the main Agent');
      expect(childSystem).not.toContain('You are the root Agent of a persistent task Thread');
      expect(childRequest.tools.some((tool) => tool.name === 'thread_call')).toBe(false);
      expect(childRequest.messages.filter((message) => message.role !== 'system')).toEqual([
        { role: 'user', content: 'inspect delegated scope' },
      ]);
    } finally {
      await cleanup(coordinator, database, directory);
    }
  },
);

it('runs Thread delegation across root Runs and delivers only the linked response', async () => {
  const provider = new ControlledProvider();
  provider.register(
    'user:create task',
    response('', [
      {
        id: 'call-1',
        name: 'thread_call',
        arguments: { prompt: 'task prompt', title: '任务甲' },
      },
    ]),
  );
  provider.register('tool:call-1', response('call accepted'));
  provider.register('user:task prompt', response('task response'));
  provider.register('delivery:thread', response('response received'));
  provider.register('tool:list-1', response('read complete'));
  provider.register('user:direct task input', response('direct response'));
  const { database, store, coordinator, main, directory } = await fixture(provider);
  try {
    const created = send(store, main.threadId, 'create task', 'send-create');
    await coordinator.deliver(created.input, created.runId);
    await vi.waitFor(() =>
      expect(provider.requests.some((request) => request.key === 'user:create task')).toBe(true),
    );
    provider.resolve('user:create task');
    await waitRequest(provider, 'tool:call-1');
    await waitRequest(provider, 'user:task prompt');
    const task = store.listThreads(ownerId, 0n, 10).find((thread) => thread.title === '任务甲');
    if (!task) throw new Error('Task Thread was not created.');
    expect(store.listInputs(ownerId, task.threadId)).toHaveLength(1);
    expect(store.listRuns(ownerId, task.threadId)).toHaveLength(1);
    const accepted = JSON.parse(toolMessage(store, main.threadId, 'call-1').content) as {
      tool_call_id: string;
      thread_id: string;
      status: string;
      automatic_delivery: boolean;
      next_step: string;
    };
    expect(accepted).toEqual({
      tool_call_id: 'call-1',
      thread_id: task.threadId,
      status: 'accepted',
      automatic_delivery: true,
      next_step: expect.stringMatching(
        /Accepted is not completion.*finish this turn.*injected automatically.*no status read or wait_ms/,
      ),
    });
    const interactionId = accepted.tool_call_id;
    expect(store.getInteraction(ownerId, delegationKey(main.threadId, interactionId)).status).toBe(
      'running',
    );
    expect(
      store
        .listContext(ownerId, main.threadId, 'thread')
        .filter(
          (message) => message.message.role === 'tool' && message.message.tool_call_id === 'call-1',
        ),
    ).toHaveLength(1);

    provider.resolve('user:task prompt');
    await vi.waitFor(() =>
      expect(
        store.getInteraction(ownerId, delegationKey(main.threadId, interactionId)).status,
      ).toBe('completed'),
    );
    const delivery = store.getInteractionDelivery(
      ownerId,
      delegationKey(main.threadId, interactionId),
    );
    expect(['queued', 'consumed']).toContain(delivery.status);
    expect(delivery.content).toContain(interactionId);
    provider.resolve('tool:call-1');
    await waitRequest(provider, 'delivery:thread');
    const deliveryRequest = provider.requests.find((request) => request.key === 'delivery:thread');
    expect(deliveryRequest?.request.messages.at(-1)?.content).toContain(interactionId);
    expect(deliveryRequest?.request.messages.at(-1)?.content).toContain('task response');
    provider.resolve('delivery:thread');
    await waitStatus(store, created.runId, 'completed');
    expect(
      store.getInteractionDelivery(ownerId, delegationKey(main.threadId, interactionId)).status,
    ).toBe('consumed');
    expect(
      store
        .listInputs(ownerId, main.threadId)
        .filter((input) => input.source === 'thread_response'),
    ).toEqual([]);
    expect(
      store
        .listContext(ownerId, main.threadId, 'thread')
        .filter(
          (message) =>
            message.source === 'thread_response' &&
            message.delegation?.sourceToolCallId === interactionId,
        ),
    ).toHaveLength(1);

    store.createThread(action('CreateThread', 'create-second-task', { title: '任务乙' }));
    provider.register(
      'user:read task',
      response('', [
        { id: 'read-1', name: 'thread_read', arguments: { tool_call_id: interactionId } },
        { id: 'list-1', name: 'thread_list', arguments: { limit: 1 } },
      ]),
    );
    const read = send(store, main.threadId, 'read task', 'send-read');
    await coordinator.deliver(read.input, read.runId);
    await vi.waitFor(() =>
      expect(provider.requests.some((request) => request.key === 'user:read task')).toBe(true),
    );
    provider.resolve('user:read task');
    await waitRequest(provider, 'tool:list-1');
    provider.resolve('tool:list-1');
    await waitStatus(store, read.runId, 'completed');
    expect(JSON.parse(toolMessage(store, main.threadId, 'read-1').content)).toMatchObject({
      tool_call_id: interactionId,
      status: 'completed',
      response: 'task response',
      timed_out: false,
    });
    const listed = JSON.parse(toolMessage(store, main.threadId, 'list-1').content) as {
      threads: Array<{ thread_id: string; thread_type: string }>;
      next_cursor?: string;
    };
    expect(listed).toEqual({
      threads: [
        expect.objectContaining({ thread_id: task.threadId, title: '任务甲', thread_type: 'task' }),
      ],
      next_cursor: String(task.seq),
    });

    const mainRequestCount = provider.requests.length;
    const direct = send(store, task.threadId, 'direct task input', 'send-direct');
    await coordinator.deliver(direct.input, direct.runId);
    await vi.waitFor(() =>
      expect(provider.requests.some((request) => request.key === 'user:direct task input')).toBe(
        true,
      ),
    );
    provider.resolve('user:direct task input');
    await waitStatus(store, direct.runId, 'completed');
    expect(provider.requests).toHaveLength(mainRequestCount + 1);
    expect(
      store.listContext(ownerId, main.threadId, 'thread').map((message) => message.message.content),
    ).not.toEqual(expect.arrayContaining(['direct task input', 'direct response']));
    expect(
      store.listContext(ownerId, task.threadId, 'thread').map((message) => message.message.content),
    ).toEqual(['task prompt', 'task response', 'direct task input', 'direct response']);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('rejects invalid delegation arguments and does not register Thread tools on task roots', async () => {
  const provider = new ControlledProvider();
  const { database, store, coordinator, main, directory } = await fixture(provider);
  try {
    seedTestTenant(database, 'other-owner');
    const otherTask = store.createThread({
      ...action('CreateThread', 'other-create', { title: '其他所有者' }),
      ownerId: 'other-owner',
    });
    provider.register(
      'user:invalid tools',
      response('', [
        {
          id: 'invalid-mode',
          name: 'thread_call',
          arguments: { thread_id: main.threadId, prompt: 'x', mode: 'foreground' },
        },
        { id: 'invalid-list', name: 'thread_list', arguments: { unknown: true } },
        { id: 'invalid-subagent', name: 'subagent', arguments: { task: 'missing mode' } },
        {
          id: 'invalid-owner',
          name: 'thread_call',
          arguments: { thread_id: otherTask.threadId, prompt: 'x' },
        },
        {
          id: 'invalid-cycle',
          name: 'thread_call',
          arguments: { thread_id: main.threadId, prompt: 'callback' },
        },
      ]),
    );
    provider.register('tool:invalid-cycle', response('invalid calls rejected'));
    const invalid = send(store, main.threadId, 'invalid tools', 'send-invalid');
    await coordinator.deliver(invalid.input, invalid.runId);
    await vi.waitFor(() =>
      expect(provider.requests.some((request) => request.key === 'user:invalid tools')).toBe(true),
    );
    provider.resolve('user:invalid tools');
    await waitRequest(provider, 'tool:invalid-cycle');
    provider.resolve('tool:invalid-cycle');
    await waitStatus(store, invalid.runId, 'completed');
    for (const callId of ['invalid-mode', 'invalid-list', 'invalid-subagent']) {
      expect(toolMessage(store, main.threadId, callId)).toMatchObject({
        status: 'error',
        error: { code: 'invalid_arguments' },
      });
    }
    for (const callId of ['invalid-owner', 'invalid-cycle']) {
      expect(toolMessage(store, main.threadId, callId).status).toBe('error');
    }
    expect(database.prepare('SELECT COUNT(*) AS count FROM interactions').get()).toEqual({
      count: 0,
    });
    const mainTools = provider.requests[0]?.request.tools.map((tool) => tool.name) ?? [];
    expect(mainTools).toEqual(
      expect.arrayContaining([
        'thread_list',
        'thread_call',
        'thread_read',
        'thread_cancel',
        'subagent_status',
        'subagent_cancel',
      ]),
    );
    expect(mainTools).not.toContain('thread_create');

    const task = store.createThread(action('CreateThread', 'task-create', { title: '任务' }));
    provider.register(
      'user:task cannot delegate',
      response('', [
        {
          id: 'task-thread-call',
          name: 'thread_call',
          arguments: { thread_id: main.threadId, prompt: 'callback' },
        },
      ]),
    );
    provider.register('tool:task-thread-call', response('task cannot delegate'));
    const taskRun = send(store, task.threadId, 'task cannot delegate', 'send-task-tools');
    await coordinator.deliver(taskRun.input, taskRun.runId);
    await vi.waitFor(() =>
      expect(provider.requests.some((request) => request.key === 'user:task cannot delegate')).toBe(
        true,
      ),
    );
    const taskRequest = provider.requests.find(
      (request) => request.key === 'user:task cannot delegate',
    );
    expect(taskRequest?.request.tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        'thread_list',
        'thread_create',
        'thread_call',
        'thread_read',
        'thread_cancel',
      ]),
    );
    expect(taskRequest?.request.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['subagent_status', 'subagent_cancel']),
    );
    provider.resolve('user:task cannot delegate');
    await waitRequest(provider, 'tool:task-thread-call');
    provider.resolve('tool:task-thread-call');
    await waitStatus(store, taskRun.runId, 'completed');
    expect(toolMessage(store, task.threadId, 'task-thread-call')).toMatchObject({
      status: 'error',
      error: { code: 'unknown_tool' },
    });
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('times out a read without holding the only model slot or cancelling the target', async () => {
  const provider = new ControlledProvider();
  const { database, store, coordinator, main, directory, environmentOperations } = await fixture(
    provider,
    {
      maxActiveThreads: 1,
      maxConcurrentModelRequests: 1,
    },
  );
  try {
    seedTestEnvironment(database, ownerId);
    environmentOperations.bashDelayMs = 30_000;
    const blocker = store.createThread(
      action('CreateThread', 'create-blocker', {
        title: '占位',
        environmentPolicy: testEnvironmentPolicyInput,
      }),
    );
    const task = store.createThread(action('CreateThread', 'create-task', { title: '慢任务' }));
    provider.register(
      'user:block background',
      response('', [{ id: 'block-bash', name: 'bash', arguments: { command: 'sleep 30' } }]),
    );
    provider.register(
      'user:start slow task',
      response('', [
        {
          id: 'slow-call',
          name: 'thread_call',
          arguments: { thread_id: task.threadId, prompt: 'slow prompt' },
        },
      ]),
    );
    provider.register(
      'tool:slow-call',
      response('', [
        { id: 'slow-read', name: 'thread_read', arguments: { tool_call_id: '', wait_ms: 20 } },
      ]),
    );
    provider.register('user:slow prompt', response('slow response'));
    provider.register('tool:slow-read', response('read timed out'));
    provider.register('delivery:thread', response('slow response received'));

    const blocked = send(store, blocker.threadId, 'block background', 'send-blocker');
    await coordinator.deliver(blocked.input, blocked.runId);
    await vi.waitFor(() =>
      expect(provider.requests.some((request) => request.key === 'user:block background')).toBe(
        true,
      ),
    );
    provider.resolve('user:block background');
    await waitStatus(store, blocked.runId, 'waiting');

    const sent = send(store, main.threadId, 'start slow task', 'send-slow');
    await coordinator.deliver(sent.input, sent.runId);
    await vi.waitFor(() =>
      expect(provider.requests.some((request) => request.key === 'user:start slow task')).toBe(
        true,
      ),
    );
    provider.resolve('user:start slow task');
    await waitRequest(provider, 'tool:slow-call');
    const interactionId = store.listInputs(ownerId, task.threadId)[0]?.delegation?.sourceToolCallId;
    if (!interactionId) throw new Error('Slow interaction is missing.');
    provider.register(
      'tool:slow-call',
      response('', [
        {
          id: 'slow-read',
          name: 'thread_read',
          arguments: { tool_call_id: interactionId, wait_ms: 20 },
        },
      ]),
    );
    provider.resolve('tool:slow-call');
    await waitRequest(provider, 'tool:slow-read');
    expect(JSON.parse(toolMessage(store, main.threadId, 'slow-read').content)).toMatchObject({
      tool_call_id: interactionId,
      status: 'queued',
      timed_out: true,
      automatic_delivery: true,
      next_step: expect.stringMatching(
        /target was not cancelled.*Do not repeat short waits or poll.*finish this turn.*injected automatically/,
      ),
    });
    expect(store.getInteraction(ownerId, delegationKey(main.threadId, interactionId)).status).toBe(
      'queued',
    );
    expect(provider.requests.some((request) => request.key === 'user:slow prompt')).toBe(false);
    provider.resolve('tool:slow-read');
    await waitStatus(store, sent.runId, 'completed');

    const cancellation = store.requestCancelRun(
      action('CancelRun', 'cancel-blocker', {
        threadId: blocker.threadId,
        runId: blocked.runId,
        reason: 'release background slot',
      }),
    );
    await coordinator.cancel(cancellation, 'release background slot');
    await waitStatus(store, blocked.runId, 'cancelled');
    await waitRequest(provider, 'user:slow prompt');
    provider.resolve('user:slow prompt');
    await vi.waitFor(() =>
      expect(
        store.getInteraction(ownerId, delegationKey(main.threadId, interactionId)).status,
      ).toBe('completed'),
    );
    await waitRequest(provider, 'delivery:thread');
    const deliveryRunId = store.getInteractionDelivery(
      ownerId,
      delegationKey(main.threadId, interactionId),
    ).runId;
    if (!deliveryRunId) throw new Error('Delivery Run is missing.');
    expect(deliveryRunId).not.toBe(sent.runId);
    provider.resolve('delivery:thread');
    await waitStatus(store, deliveryRunId, 'completed');
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('associates two interactions consumed by one target Run with their own responses', async () => {
  const provider = new ControlledProvider();
  const { database, store, coordinator, main, directory } = await fixture(provider);
  try {
    const task = store.createThread(action('CreateThread', 'create-task', { title: '多输入' }));
    provider.register(
      'user:two calls',
      response('', [
        {
          id: 'call-first',
          name: 'thread_call',
          arguments: { thread_id: task.threadId, prompt: 'first prompt', mode: 'steer' },
        },
        {
          id: 'call-second',
          name: 'thread_call',
          arguments: { thread_id: task.threadId, prompt: 'second prompt' },
        },
      ]),
    );
    provider.register('tool:call-second', response('both accepted'));
    provider.register('user:first prompt', response('first response'));
    provider.register('user:second prompt', response('second response'));
    provider.register('delivery:thread', response('delivery received'));
    for (const key of [
      'user:two calls',
      'tool:call-second',
      'user:first prompt',
      'user:second prompt',
      'delivery:thread',
    ]) {
      provider.resolve(key);
    }
    const sent = send(store, main.threadId, 'two calls', 'send-two-calls');
    await coordinator.deliver(sent.input, sent.runId);
    await vi.waitFor(() => expect(store.listInputs(ownerId, task.threadId)).toHaveLength(2));
    const [firstInput, secondInput] = store.listInputs(ownerId, task.threadId);
    const firstId = firstInput?.delegation;
    const secondId = secondInput?.delegation;
    if (!firstId || !secondId) throw new Error('Thread interactions are missing.');
    await vi.waitFor(() => {
      expect(store.getInteraction(ownerId, firstId).status).toBe('completed');
      expect(store.getInteraction(ownerId, secondId).status).toBe('completed');
    });
    await vi.waitFor(() => {
      expect(store.getInteractionDelivery(ownerId, firstId).status).toBe('consumed');
      expect(store.getInteractionDelivery(ownerId, secondId).status).toBe('consumed');
    });
    expect(store.getInteraction(ownerId, firstId)).toMatchObject({
      status: 'completed',
      consumedRunId: firstInput?.consumedRunId,
    });
    expect(store.getInteraction(ownerId, secondId)).toMatchObject({
      status: 'completed',
      consumedRunId: secondInput?.consumedRunId,
    });
    expect(firstInput?.consumedRunId).toBe(secondInput?.consumedRunId);
    expect(store.getInteractionResponse(ownerId, firstId)?.message.content).toBe('first response');
    expect(store.getInteractionResponse(ownerId, secondId)?.message.content).toBe(
      'second response',
    );
    expect(store.getInteractionResponse(ownerId, firstId)?.messageId).not.toBe(
      store.getInteractionResponse(ownerId, secondId)?.messageId,
    );
    expect(
      store.listRuns(ownerId, task.threadId).filter((run) => run.parentRunId === null),
    ).toHaveLength(1);
    expect(
      store.listContext(ownerId, task.threadId, 'thread').map((message) => message.message.content),
    ).toEqual(['first prompt', 'first response', 'second prompt', 'second response']);
    const deliveredTexts = store
      .listContext(ownerId, main.threadId, 'thread')
      .filter((message) => message.source === 'thread_response')
      .map((message) => message.message.content);
    expect(deliveredTexts).toHaveLength(2);
    expect(deliveredTexts[0]).toContain('first response');
    expect(deliveredTexts[1]).toContain('second response');
    expect(provider.requests.filter((request) => request.key === 'delivery:thread')).toHaveLength(
      2,
    );
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('keeps a background Subagent alive after parent cancellation and delivers it to a new main Run', async () => {
  const provider = new ControlledProvider();
  const { database, store, coordinator, main, directory } = await fixture(provider, {
    maxActiveThreads: 1,
    maxConcurrentModelRequests: 1,
  });
  try {
    provider.register(
      'user:orchestrate',
      response('', [
        {
          id: 'bg-create',
          name: 'subagent',
          arguments: { task: 'background work', mode: 'background' },
        },
      ]),
    );
    provider.register('tool:bg-create', response('parent must not finish'));
    provider.register('user:background work', response('background response'));
    provider.register('tool:bg-status', response('status read'));
    provider.register('delivery:subagent', response('background delivered'));
    const parent = send(store, main.threadId, 'orchestrate', 'send-orchestrate');
    await coordinator.deliver(parent.input, parent.runId);
    await vi.waitFor(() =>
      expect(provider.requests.some((request) => request.key === 'user:orchestrate')).toBe(true),
    );
    provider.resolve('user:orchestrate');
    await waitRequest(provider, 'user:background work');
    const accepted = JSON.parse(toolMessage(store, main.threadId, 'bg-create').content) as {
      tool_call_id: string;
      status: string;
      automatic_delivery: boolean;
      next_step: string;
    };
    expect(accepted).toEqual({
      tool_call_id: 'bg-create',
      status: 'accepted',
      automatic_delivery: true,
      next_step: expect.stringMatching(
        /Accepted is not completion.*finish this turn.*injected automatically.*no status read or wait_ms/,
      ),
    });
    const interactionId = accepted.tool_call_id;
    const child = store
      .listRuns(ownerId, main.threadId)
      .find((run) => run.parentRunId === parent.runId);
    if (!child) throw new Error('Background child Run is missing.');
    expect(child).toMatchObject({ executionMode: 'background', status: 'running' });
    const cancellation = store.requestCancelRun(
      action('CancelRun', 'cancel-parent', {
        threadId: main.threadId,
        runId: parent.runId,
        reason: 'stop parent only',
      }),
    );
    await coordinator.cancel(cancellation, 'stop parent only');
    await waitStatus(store, parent.runId, 'cancelled');
    expect(store.getRunById(child.runId).status).toBe('running');

    provider.register(
      'user:new main input',
      response('', [
        { id: 'bg-status', name: 'subagent_status', arguments: { tool_call_id: interactionId } },
      ]),
    );
    const current = send(store, main.threadId, 'new main input', 'send-new-main');
    expect(current.runId).not.toBe(child.runId);
    expect(store.getRunById(current.runId)).toMatchObject({ agentId: 'thread', parentRunId: null });
    await coordinator.deliver(current.input, current.runId);
    provider.resolve('user:background work');
    await waitRequest(provider, 'user:new main input');
    provider.resolve('user:new main input');
    await waitRequest(provider, 'delivery:subagent');
    expect(JSON.parse(toolMessage(store, main.threadId, 'bg-status').content)).toMatchObject({
      tool_call_id: interactionId,
      status: 'completed',
      response: 'background response',
      timed_out: false,
    });
    expect(
      store.getInteractionDelivery(ownerId, delegationKey(main.threadId, interactionId)).status,
    ).toBe('consumed');
    provider.resolve('delivery:subagent');
    await waitStatus(store, current.runId, 'completed');
    await waitStatus(store, child.runId, 'completed');
    expect(
      store.getInteractionDelivery(ownerId, delegationKey(main.threadId, interactionId)).status,
    ).toBe('consumed');
    expect(
      store.getInteractionResponse(ownerId, delegationKey(main.threadId, interactionId))?.message
        .content,
    ).toBe('background response');
    expect(
      store
        .listContext(ownerId, main.threadId, 'thread')
        .filter(
          (message) =>
            message.message.role === 'tool' && message.message.tool_call_id === 'bg-create',
        ),
    ).toHaveLength(1);
    expect(store.listThreads(ownerId, 0n, 10)).toHaveLength(1);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('cancels only the requested background Subagent and delivers the real terminal state', async () => {
  const provider = new ControlledProvider();
  const { database, store, coordinator, main, directory } = await fixture(provider);
  try {
    provider.register(
      'user:cancel orchestration',
      response('', [
        {
          id: 'bg-create',
          name: 'subagent',
          arguments: { task: 'cancel work', mode: 'background' },
        },
      ]),
    );
    provider.register('tool:bg-create', response('unused'));
    provider.register('user:cancel work', response('must not complete'));
    provider.register('tool:bg-cancel', response('cancel accepted'));
    provider.register('delivery:subagent', response('cancel delivered'));
    const parent = send(store, main.threadId, 'cancel orchestration', 'send-cancel-bg');
    await coordinator.deliver(parent.input, parent.runId);
    await vi.waitFor(() =>
      expect(provider.requests.some((request) => request.key === 'user:cancel orchestration')).toBe(
        true,
      ),
    );
    provider.resolve('user:cancel orchestration');
    await waitRequest(provider, 'tool:bg-create');
    await waitRequest(provider, 'user:cancel work');
    const childRunId = store
      .listRuns(ownerId, main.threadId)
      .filter((run) => run.parentRunId === parent.runId)
      .map((run) => run.runId)[0];
    if (!childRunId) throw new Error('Background Run is missing.');
    const accepted = JSON.parse(toolMessage(store, main.threadId, 'bg-create').content) as {
      tool_call_id: string;
    };
    provider.register(
      'tool:bg-create',
      response('', [
        {
          id: 'bg-cancel',
          name: 'subagent_cancel',
          arguments: { tool_call_id: accepted.tool_call_id },
        },
      ]),
    );
    provider.resolve('tool:bg-create');
    await waitRequest(provider, 'delivery:subagent');
    expect(['cancel_requested', 'cancelled']).toContain(
      JSON.parse(toolMessage(store, main.threadId, 'bg-cancel').content).status,
    );
    provider.resolve('delivery:subagent');
    await waitStatus(store, parent.runId, 'completed');
    await waitStatus(store, childRunId, 'cancelled');
    const cancelled = store.getInteraction(
      ownerId,
      delegationKey(main.threadId, accepted.tool_call_id),
    );
    expect(cancelled).toMatchObject({ status: 'cancelled', responseMessageSeq: null });
    const delivery = store.getInteractionDelivery(
      ownerId,
      delegationKey(main.threadId, accepted.tool_call_id),
    );
    expect(delivery.status).toBe('consumed');
    expect(delivery.content).toContain('"status":"cancelled"');
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('delivers a background Subagent model failure without inventing a response', async () => {
  const provider = new ControlledProvider();
  const { database, store, coordinator, main, directory } = await fixture(provider);
  try {
    provider.register(
      'user:failure orchestration',
      response('', [
        {
          id: 'bg-create',
          name: 'subagent',
          arguments: { task: 'failing work', mode: 'background' },
        },
      ]),
    );
    provider.register('tool:bg-create', response('parent response'));
    provider.register('user:failing work', []);
    provider.register('delivery:subagent', response('failure delivered'));
    const parent = send(store, main.threadId, 'failure orchestration', 'send-fail-bg');
    await coordinator.deliver(parent.input, parent.runId);
    await vi.waitFor(() =>
      expect(
        provider.requests.some((request) => request.key === 'user:failure orchestration'),
      ).toBe(true),
    );
    provider.resolve('user:failure orchestration');
    await waitRequest(provider, 'tool:bg-create');
    await waitRequest(provider, 'user:failing work');
    const accepted = JSON.parse(toolMessage(store, main.threadId, 'bg-create').content) as {
      tool_call_id: string;
    };
    const child = store
      .listRuns(ownerId, main.threadId)
      .find((run) => run.parentRunId === parent.runId);
    if (!child) throw new Error('Failing child Run is missing.');
    provider.resolve('user:failing work');
    await waitStatus(store, child.runId, 'failed');
    expect(
      store.getInteraction(ownerId, delegationKey(main.threadId, accepted.tool_call_id)),
    ).toMatchObject({
      status: 'failed',
      responseMessageSeq: null,
      error: { code: 'internal' },
    });
    provider.resolve('tool:bg-create');
    await waitRequest(provider, 'delivery:subagent');
    provider.resolve('delivery:subagent');
    await waitStatus(store, parent.runId, 'completed');
    const delivery = store.getInteractionDelivery(
      ownerId,
      delegationKey(main.threadId, accepted.tool_call_id),
    );
    expect(delivery.status).toBe('consumed');
    expect(delivery.content).toContain('"status":"failed"');
    expect(delivery.content).toContain('"response":null');
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('cancels a Thread interaction without cancelling its later root Run', async () => {
  const provider = new ControlledProvider();
  const { database, store, coordinator, main, directory } = await fixture(provider);
  try {
    const task = store.createThread(action('CreateThread', 'create-task', { title: '可取消' }));
    provider.register(
      'user:call cancellable',
      response('', [
        {
          id: 'thread-create',
          name: 'thread_call',
          arguments: { thread_id: task.threadId, prompt: 'cancellable prompt' },
        },
      ]),
    );
    provider.register('tool:thread-create', response('unused'));
    provider.register('user:cancellable prompt', response('must not complete'));
    provider.register('tool:thread-cancel', response('cancel complete'));
    provider.register('delivery:thread', response('cancel delivered'));
    provider.register('user:after cancel', response('after response'));
    const parent = send(store, main.threadId, 'call cancellable', 'send-cancel-thread');
    await coordinator.deliver(parent.input, parent.runId);
    await vi.waitFor(() =>
      expect(provider.requests.some((request) => request.key === 'user:call cancellable')).toBe(
        true,
      ),
    );
    provider.resolve('user:call cancellable');
    await waitRequest(provider, 'tool:thread-create');
    await waitRequest(provider, 'user:cancellable prompt');
    const targetInput = store.listInputs(ownerId, task.threadId)[0];
    const interactionId = targetInput?.delegation?.sourceToolCallId;
    if (!interactionId) throw new Error('Thread interaction is missing.');
    provider.register(
      'tool:thread-create',
      response('', [
        {
          id: 'thread-cancel',
          name: 'thread_cancel',
          arguments: { tool_call_id: interactionId },
        },
      ]),
    );
    provider.resolve('tool:thread-create');
    await waitRequest(provider, 'delivery:thread');
    const cancellation = JSON.parse(toolMessage(store, main.threadId, 'thread-cancel').content);
    expect(cancellation.tool_call_id).toBe(interactionId);
    expect(['cancel_requested', 'cancelled']).toContain(cancellation.status);
    provider.resolve('delivery:thread');
    await waitStatus(store, parent.runId, 'completed');
    expect(store.getInteraction(ownerId, delegationKey(main.threadId, interactionId)).status).toBe(
      'cancelled',
    );
    const cancelledRunId = targetInput?.consumedRunId;
    if (!cancelledRunId) throw new Error('Cancelled consumption Run is missing.');
    await waitStatus(store, cancelledRunId, 'cancelled');

    provider.resolve('user:after cancel');
    const next = send(store, task.threadId, 'after cancel', 'send-after-cancel');
    await coordinator.deliver(next.input, next.runId);
    await waitStatus(store, next.runId, 'completed');
    expect(next.runId).not.toBe(cancelledRunId);
    expect(store.getRunById(next.runId).status).toBe('completed');
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('retries a failed direct delivery without duplicating its committed response', async () => {
  const provider = new ControlledProvider();
  const { database, store, coordinator, main, directory } = await fixture(provider);
  try {
    const task = store.createThread(action('CreateThread', 'create-task', { title: '持久化' }));
    provider.register(
      'user:persist call',
      response('', [
        {
          id: 'persist-call',
          name: 'thread_call',
          arguments: { thread_id: task.threadId, prompt: 'persist prompt' },
        },
      ]),
    );
    provider.register('tool:persist-call', response('parent response'));
    provider.register('user:persist prompt', response('uncommitted response'));
    provider.register('delivery:thread', response('failed delivery received'));
    const parent = send(store, main.threadId, 'persist call', 'send-persist');
    await coordinator.deliver(parent.input, parent.runId);
    await vi.waitFor(() =>
      expect(provider.requests.some((request) => request.key === 'user:persist call')).toBe(true),
    );
    provider.resolve('user:persist call');
    await waitRequest(provider, 'tool:persist-call');
    await waitRequest(provider, 'user:persist prompt');
    const targetInput = store.listInputs(ownerId, task.threadId)[0];
    const interactionId = targetInput?.delegation?.sourceToolCallId;
    if (!interactionId) throw new Error('Persistence interaction is missing.');
    database.exec(`
      CREATE TRIGGER fail_thread_delivery BEFORE INSERT ON context_messages
      WHEN NEW.source = 'thread_response'
      BEGIN SELECT RAISE(FAIL, 'injected delivery storage failure'); END;
    `);
    provider.resolve('user:persist prompt');
    await vi.waitFor(() =>
      expect(
        store.getInteraction(ownerId, delegationKey(main.threadId, interactionId)).status,
      ).toBe('completed'),
    );
    expect(
      store.getInteractionResponse(ownerId, delegationKey(main.threadId, interactionId))?.message
        .content,
    ).toBe('uncommitted response');
    provider.resolve('tool:persist-call');
    await waitStatus(store, parent.runId, 'failed');
    expect(
      store.listContext(ownerId, task.threadId, 'thread').map((message) => message.message.content),
    ).toEqual(['persist prompt', 'uncommitted response']);
    expect(
      store.getInteractionDelivery(ownerId, delegationKey(main.threadId, interactionId)),
    ).toMatchObject({
      status: 'queued',
      content: expect.stringContaining('uncommitted response'),
      contextMessageSeq: null,
    });

    database.exec('DROP TRIGGER fail_thread_delivery');
    coordinator.resumeDeliveries();
    coordinator.resumeDeliveries();
    await waitRequest(provider, 'delivery:thread');
    provider.resolve('delivery:thread');
    const delivery = store.getInteractionDelivery(
      ownerId,
      delegationKey(main.threadId, interactionId),
    );
    if (!delivery.runId) throw new Error('Recovered delivery Run is missing.');
    await waitStatus(store, delivery.runId, 'completed');
    expect(delivery.status).toBe('consumed');
    const deliveries = store
      .listContext(ownerId, main.threadId, 'thread')
      .filter(
        (message) =>
          message.source === 'thread_response' &&
          message.delegation?.sourceToolCallId === interactionId,
      );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.message.content).toContain('"status":"completed"');
    expect(deliveries[0]?.message.content).toContain('uncommitted response');
    expect(
      store
        .listInputs(ownerId, main.threadId)
        .filter((input) => input.source === 'thread_response'),
    ).toEqual([]);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('waits for background execution during close and resumes only its persisted delivery', async () => {
  const provider = new ControlledProvider();
  const { database, store, coordinator, main, directory } = await fixture(provider);
  try {
    provider.register(
      'user:restart orchestration',
      response('', [
        {
          id: 'bg-create',
          name: 'subagent',
          arguments: { task: 'restart work', mode: 'background' },
        },
      ]),
    );
    provider.register('tool:bg-create', response('parent complete'));
    provider.register('user:restart work', response('must not complete'));
    provider.register('delivery:subagent', response('interruption delivered'));
    const parent = send(store, main.threadId, 'restart orchestration', 'send-restart');
    await coordinator.deliver(parent.input, parent.runId);
    await vi.waitFor(() =>
      expect(
        provider.requests.some((request) => request.key === 'user:restart orchestration'),
      ).toBe(true),
    );
    provider.resolve('user:restart orchestration');
    await waitRequest(provider, 'tool:bg-create');
    await waitRequest(provider, 'user:restart work');
    const accepted = JSON.parse(toolMessage(store, main.threadId, 'bg-create').content) as {
      tool_call_id: string;
    };
    const child = store
      .listRuns(ownerId, main.threadId)
      .find((run) => run.parentRunId === parent.runId);
    if (!child) throw new Error('Restart child Run is missing.');
    provider.resolve('tool:bg-create');
    await waitStatus(store, parent.runId, 'completed');
    const childRequestCount = provider.requests.filter(
      (request) => request.key === 'user:restart work',
    ).length;

    await coordinator.close();
    expect(store.getRunById(child.runId)).toMatchObject({
      status: 'interrupted',
      error: { code: 'operation_unknown' },
    });
    expect(
      store.getInteraction(ownerId, delegationKey(main.threadId, accepted.tool_call_id)),
    ).toMatchObject({
      status: 'interrupted',
      responseMessageSeq: null,
      error: { code: 'operation_unknown' },
    });
    expect(
      store.getInteractionDelivery(ownerId, delegationKey(main.threadId, accepted.tool_call_id))
        .status,
    ).toBe('queued');

    const restarted = new RunCoordinator({
      ...controlledEnvironmentDependencies(store.database, ownerId),
      store,
      model: {
        provider,
        providerId: 'test',
        modelId: 'test-model',
        contextWindowTokens: 128_000,
        outputReserveTokens: 4096,
      },
    });
    try {
      store.recoverInterrupted();
      restarted.resumeDeliveries();
      await waitRequest(provider, 'delivery:subagent');
      provider.resolve('delivery:subagent');
      await vi.waitFor(() =>
        expect(
          store.getInteractionDelivery(ownerId, delegationKey(main.threadId, accepted.tool_call_id))
            .status,
        ).toBe('consumed'),
      );
      const delivery = store.getInteractionDelivery(
        ownerId,
        delegationKey(main.threadId, accepted.tool_call_id),
      );
      expect(delivery.content).toContain('"status":"interrupted"');
      if (!delivery.runId) throw new Error('Recovered delivery Run is missing.');
      await waitStatus(store, delivery.runId, 'completed');
      expect(
        provider.requests.filter((request) => request.key === 'user:restart work'),
      ).toHaveLength(childRequestCount);
      expect(store.getRunById(child.runId).status).toBe('interrupted');
    } finally {
      await restarted.close();
    }
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('does not start an empty target Run after a queued Thread interaction is cancelled', async () => {
  const provider = new ControlledProvider();
  const { database, store, coordinator, main, directory } = await fixture(provider, {
    maxActiveThreads: 1,
    maxConcurrentModelRequests: 1,
  });
  try {
    const blocker = store.createThread(action('CreateThread', 'create-blocker', { title: '占位' }));
    const task = store.createThread(action('CreateThread', 'create-task', { title: '排队取消' }));
    provider.register('user:hold slot', response('release slot'));
    provider.register('user:source main', response('source complete'));
    provider.register('delivery:thread', response('queued cancellation delivered'));
    provider.resolve('user:source main');
    provider.resolve('delivery:thread');
    const blocked = send(store, blocker.threadId, 'hold slot', 'send-hold-slot');
    await coordinator.deliver(blocked.input, blocked.runId);
    await waitRequest(provider, 'user:hold slot');
    const source = send(store, main.threadId, 'source main', 'send-source-main');
    const accepted = store.acceptThreadCall({
      ownerId,
      sourceThreadId: main.threadId,
      sourceAgentId: 'thread',
      sourceRunId: source.runId,
      sourceToolCallId: 'queued-call',
      targetThreadId: task.threadId,
      prompt: 'queued prompt',
      mode: 'follow_up',
    });
    await coordinator.scheduleThreadCall(accepted);
    expect(store.getRunById(accepted.runId).status).toBe('queued');
    await coordinator.cancelInteraction(accepted.interaction, 'cancel queued interaction');
    expect(store.getInteraction(ownerId, accepted.interaction).status).toBe('cancelled');
    expect(store.getInput(ownerId, accepted.input.inputId).status).toBe('cancelled');

    const cancellation = store.requestCancelRun(
      action('CancelRun', 'cancel-blocker', {
        threadId: blocker.threadId,
        runId: blocked.runId,
        reason: 'release slot',
      }),
    );
    await coordinator.cancel(cancellation, 'release slot');
    await waitStatus(store, blocked.runId, 'cancelled');
    await waitStatus(store, accepted.runId, 'cancelled');
    await waitStatus(store, source.runId, 'completed');
    expect(provider.requests.some((request) => request.key === 'user:queued prompt')).toBe(false);
    expect(store.getInteractionDelivery(ownerId, accepted.interaction).status).toBe('consumed');
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('rejects a background Subagent created by a temporary Subagent', async () => {
  const provider = new ControlledProvider();
  const { database, store, coordinator, main, directory } = await fixture(provider, {
    maxSubagentDepth: 2,
  });
  try {
    provider.register(
      'user:nested outer',
      response('', [
        {
          id: 'outer-create',
          name: 'subagent',
          arguments: { task: 'outer work', mode: 'foreground' },
        },
      ]),
    );
    provider.register(
      'user:outer work',
      response('', [
        {
          id: 'nested-create',
          name: 'subagent',
          arguments: { task: 'nested background', mode: 'background' },
        },
      ]),
    );
    provider.register('tool:nested-create', response('nested background rejected'));
    provider.register('tool:outer-create', response('outer complete'));
    for (const key of [
      'user:nested outer',
      'user:outer work',
      'tool:nested-create',
      'tool:outer-create',
    ]) {
      provider.resolve(key);
    }
    const parent = send(store, main.threadId, 'nested outer', 'send-nested');
    await coordinator.deliver(parent.input, parent.runId);
    await waitStatus(store, parent.runId, 'completed');
    const children = store
      .listRuns(ownerId, main.threadId)
      .filter((run) => run.parentRunId !== null);
    expect(children).toHaveLength(1);
    const child = children[0];
    if (!child) throw new Error('Outer Subagent is missing.');
    expect(child.executionMode).toBe('foreground');
    const nestedResult = store
      .listContext(ownerId, main.threadId, child.agentId)
      .find(
        (message) =>
          message.message.role === 'tool' && message.message.tool_call_id === 'nested-create',
      )?.message;
    expect(nestedResult).toMatchObject({ role: 'tool', status: 'error' });
    expect(nestedResult?.content).toContain('persistent Thread root Agent');
    expect(database.prepare('SELECT COUNT(*) AS count FROM interactions').get()).toEqual({
      count: 1,
    });
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it.each(['cancelled', 'failed'] as const)(
  'continues every queued follow-up after the shared root is %s',
  async (outcome) => {
    const provider = new ControlledProvider();
    const { database, store, coordinator, main, directory } = await fixture(provider);
    try {
      const task = store.createThread(action('CreateThread', 'create-task', { title: '后续接管' }));
      const source = send(store, main.threadId, 'source main', 'send-source');
      const accept = (prompt: string, sourceToolCallId: string) =>
        store.acceptThreadCall({
          ownerId,
          sourceThreadId: main.threadId,
          sourceAgentId: 'thread',
          sourceRunId: source.runId,
          sourceToolCallId,
          targetThreadId: task.threadId,
          prompt,
          mode: 'follow_up',
        });
      provider.register('user:source main', response('source complete'));
      provider.register('delivery:thread', response('delivery handled'));
      provider.register(
        'user:first prompt',
        outcome === 'cancelled' ? response('must not complete') : [],
      );
      provider.register('user:second prompt', response('second response'));
      provider.register('user:third prompt', response('third response'));
      provider.resolve('user:source main');
      provider.resolve('delivery:thread');

      const first = accept('first prompt', 'call-first');
      await coordinator.scheduleThreadCall(first);
      await waitRequest(provider, 'user:first prompt');
      expect(store.getInput(ownerId, first.input.inputId).status).toBe('consumed');
      const second = accept('second prompt', 'call-second');
      const third = accept('third prompt', 'call-third');
      await coordinator.scheduleThreadCall(second);
      await coordinator.scheduleThreadCall(third);
      expect(second.runId).toBe(first.runId);
      expect(third.runId).toBe(first.runId);
      expect(store.getInput(ownerId, second.input.inputId).status).toBe('queued');
      expect(store.getInput(ownerId, third.input.inputId).status).toBe('queued');

      if (outcome === 'cancelled') {
        await coordinator.cancelInteraction(first.interaction, 'cancel first interaction');
      } else {
        provider.resolve('user:first prompt');
      }
      await waitStatus(store, first.runId, outcome);
      await waitRequest(provider, 'user:second prompt');
      provider.resolve('user:second prompt');
      await waitRequest(provider, 'user:third prompt');
      provider.resolve('user:third prompt');
      const firstId = first.interaction;
      const secondId = second.interaction;
      const thirdId = third.interaction;
      await vi.waitFor(() => {
        expect(store.getInteraction(ownerId, firstId).status).toBe(outcome);
        expect(store.getInteraction(ownerId, secondId).status).toBe('completed');
        expect(store.getInteraction(ownerId, thirdId).status).toBe('completed');
      });
      const secondInteraction = store.getInteraction(ownerId, secondId);
      const thirdInteraction = store.getInteraction(ownerId, thirdId);
      expect(secondInteraction.consumedRunId).not.toBe(first.runId);
      expect(secondInteraction.consumedRunId).toBe(thirdInteraction.consumedRunId);
      const continuedRunId = secondInteraction.consumedRunId;
      if (!continuedRunId) throw new Error('Continued root Run is missing.');
      expect(store.getRunById(continuedRunId)).toMatchObject({
        agentId: 'thread',
        parentRunId: null,
        status: 'completed',
      });
      expect(store.getInteractionResponse(ownerId, secondId)?.message.content).toBe(
        'second response',
      );
      expect(store.getInteractionResponse(ownerId, thirdId)?.message.content).toBe(
        'third response',
      );
      await vi.waitFor(() => {
        expect(store.getInteractionDelivery(ownerId, firstId).status).toBe('consumed');
        expect(store.getInteractionDelivery(ownerId, secondId).status).toBe('consumed');
        expect(store.getInteractionDelivery(ownerId, thirdId).status).toBe('consumed');
      });
      expect(
        store.listRuns(ownerId, task.threadId).filter((run) => run.parentRunId === null),
      ).toHaveLength(2);
      for (const key of ['user:first prompt', 'user:second prompt', 'user:third prompt']) {
        expect(provider.requests.filter((request) => request.key === key)).toHaveLength(1);
      }
    } finally {
      await cleanup(coordinator, database, directory);
    }
  },
);

it('does not restart queued target inputs during close or coordinator recovery', async () => {
  const provider = new ControlledProvider();
  const { database, store, coordinator, main, directory } = await fixture(provider);
  try {
    const task = store.createThread(action('CreateThread', 'create-task', { title: '关闭接管' }));
    const source = send(store, main.threadId, 'source main', 'send-source');
    const accept = (prompt: string, sourceToolCallId: string) =>
      store.acceptThreadCall({
        ownerId,
        sourceThreadId: main.threadId,
        sourceAgentId: 'thread',
        sourceRunId: source.runId,
        sourceToolCallId,
        targetThreadId: task.threadId,
        prompt,
        mode: 'follow_up',
      });
    provider.register('user:source main', response('source complete'));
    provider.register('delivery:thread', response('delivery handled'));
    provider.register('user:first prompt', response('must not complete'));
    provider.register('user:second prompt', response('second response'));
    provider.register('user:third prompt', response('third response'));
    provider.resolve('user:source main');
    provider.resolve('delivery:thread');
    const first = accept('first prompt', 'call-first');
    await coordinator.scheduleThreadCall(first);
    await waitRequest(provider, 'user:first prompt');
    const second = accept('second prompt', 'call-second');
    const third = accept('third prompt', 'call-third');
    await coordinator.scheduleThreadCall(second);
    await coordinator.scheduleThreadCall(third);

    await coordinator.close();
    expect(store.getRunById(first.runId).status).toBe('interrupted');
    expect(store.getInteraction(ownerId, first.interaction).status).toBe('interrupted');
    expect(store.getInteraction(ownerId, second.interaction).status).toBe('queued');
    expect(store.getInteraction(ownerId, third.interaction).status).toBe('queued');
    expect(store.listRuns(ownerId, task.threadId)).toHaveLength(1);
    expect(provider.requests.some((request) => request.key === 'user:second prompt')).toBe(false);
    expect(provider.requests.some((request) => request.key === 'user:third prompt')).toBe(false);

    const restarted = new RunCoordinator({
      ...controlledEnvironmentDependencies(store.database, ownerId),
      store,
      model: {
        provider,
        providerId: 'test',
        modelId: 'test-model',
        contextWindowTokens: 128_000,
        outputReserveTokens: 4096,
      },
    });
    try {
      store.recoverInterrupted();
      restarted.resumeDeliveries();
      await vi.waitFor(() =>
        expect(store.getInteractionDelivery(ownerId, first.interaction).status).toBe('consumed'),
      );
      const firstDelivery = store.getInteractionDelivery(ownerId, first.interaction);
      if (!firstDelivery.runId) throw new Error('Recovered reply Run is missing.');
      await waitStatus(store, firstDelivery.runId, 'completed');
      expect(store.listRuns(ownerId, task.threadId)).toHaveLength(1);
      expect(store.getRunById(first.runId).status).toBe('interrupted');
      expect(store.getInteraction(ownerId, second.interaction).status).toBe('queued');
      expect(store.getInteraction(ownerId, third.interaction).status).toBe('queued');
      expect(provider.requests.some((request) => request.key === 'user:second prompt')).toBe(false);
      expect(provider.requests.some((request) => request.key === 'user:third prompt')).toBe(false);
    } finally {
      await restarted.close();
    }
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('does not repeatedly reschedule an input that failed before consumption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-delegation-no-model-'));
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  seedTestTenant(database, ownerId);
  const main = store.getOrCreateMainThread(ownerId);
  const coordinator = new RunCoordinator({
    ...controlledEnvironmentDependencies(store.database, ownerId),
    store,
  });
  try {
    const sent = send(store, main.threadId, 'cannot consume', 'send-no-model');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'failed');
    expect(store.getInput(ownerId, sent.input.inputId).status).toBe('queued');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.listRuns(ownerId, main.threadId)).toHaveLength(1);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('does not register thread_notify on automation_only root Threads', async () => {
  const provider = new ControlledProvider();
  const { database, store, coordinator, directory } = await fixture(provider);
  let resolveRequest: (() => void) | undefined;
  try {
    const accepted = store.acceptAutomationInput(
      action('AutomationAccept', 'hidden-notify-registration', {
        targetKind: 'new_automation_only' as const,
        title: '隐藏定时任务',
        prompt: 'hidden automation work',
        automation: {
          scheduleId: 'schedule-hidden-notify',
          fireId: 'fire-hidden-notify',
          trigger: 'run_now' as const,
          scheduledAt: '2026-11-09T00:00:00.000Z',
        },
      }),
    );
    expect(accepted.thread.automationOnly).toBe(true);
    const automation = accepted.input.automation;
    if (!automation) throw new Error('Automation input metadata is missing.');
    const automationRequestKey = `user:Kairos Automation trigger; trigger=${automation.trigger}; schedule_id=${automation.scheduleId}; fire_id=${automation.fireId}; scheduled_at=${automation.scheduledAt}.\nThe configured Automation prompt follows; it is not a new human instruction:\n\n${accepted.input.text}`;
    provider.register(automationRequestKey, response('hidden work completed'));
    resolveRequest = () => provider.resolve(automationRequestKey);
    await coordinator.deliver(accepted.input, accepted.runId);
    await waitRequest(provider, automationRequestKey);
    const request = provider.requests.find(
      (candidate) => candidate.key === automationRequestKey,
    )?.request;
    expect(request?.tools.map((tool) => tool.name)).not.toContain('thread_notify');
    provider.resolve(automationRequestKey);
    await waitStatus(store, accepted.runId, 'completed');
    expect(database.prepare('SELECT COUNT(*) AS count FROM thread_notifications').get()).toEqual({
      count: 0,
    });
  } finally {
    resolveRequest?.();
    await cleanup(coordinator, database, directory);
  }
});
