import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AssistantMessage,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ToolCall,
  ToolMessage,
} from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AutomationService } from '../automation/service.js';
import {
  controlledEnvironmentDependencies,
  seedTestEnvironment,
  testEnvironmentPolicyInput,
} from '../integration/environment-fixture.js';
import { MemoryWiki } from '../memory/index.js';
import { openDatabase } from '../storage/database.js';
import type { RunStatus } from './records.js';
import {
  RunCoordinator,
  type RunCoordinatorOptions,
  type RuntimeModelConfiguration,
} from './runtime.js';
import { SessionStore } from './store.js';

const ownerId = 'owner-1';
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

it('requires the environment store and Operation gateway before constructing a coordinator', () => {
  const database = openDatabase(':memory:');
  try {
    const store = new SessionStore(database);
    expect(() => Reflect.construct(RunCoordinator, [{ store }])).toThrow(
      'EnvironmentStore, the remote Operation gateway and the environment usage gateway are required.',
    );
  } finally {
    database.close();
  }
});

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

function action<T extends Record<string, unknown>>(
  method: string,
  clientActionId: string,
  parameters: T & { mode?: 'follow_up' | 'steer' },
): T & { ownerId: string; clientActionId: string; method: string; parameters: T } {
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

async function fixture(
  provider: ModelProvider,
  model?: Partial<RuntimeModelConfiguration>,
  runtime: {
    maxActiveThreads?: number;
    environmentPolicy?: typeof testEnvironmentPolicyInput;
    periodicRecap?: RunCoordinatorOptions['periodicRecap'];
    sqlRecall?: RunCoordinatorOptions['sqlRecall'];
    memory?: MemoryWiki;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-runtime-'));
  const database = openDatabase(join(directory, 'server.sqlite'));
  const store = new SessionStore(database);
  const { periodicRecap, sqlRecall, environmentPolicy, ...coordinatorOptions } = runtime;
  const dependencies = controlledEnvironmentDependencies(store.database, ownerId);
  if (environmentPolicy) seedTestEnvironment(database, ownerId);
  const coordinator = new RunCoordinator({
    ...dependencies,
    store,
    model: {
      provider,
      providerId: 'test',
      modelId: 'test-model',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
      ...model,
    },
    ...(periodicRecap ? { periodicRecap } : {}),
    ...(sqlRecall ? { sqlRecall } : {}),
    ...coordinatorOptions,
  });
  const thread = store.createThread(
    action('CreateThread', 'create-1', {
      title: '会话',
      ...(environmentPolicy ? { environmentPolicy } : {}),
    }),
  );
  return {
    database,
    store,
    coordinator,
    thread,
    directory,
    environmentOperations: dependencies.environmentOperations,
  };
}

function send(
  store: SessionStore,
  threadId: string,
  text: string,
  id = 'send-1',
  mode: 'follow_up' | 'steer' = 'follow_up',
) {
  return store.sendMessage(action('SendMessage', id, { threadId, text, mode }));
}

function crashToolRun(store: SessionStore, threadId: string, callId = 'call-1') {
  const sent = send(store, threadId, 'start tool');
  store.appendModelMessage({
    runId: sent.runId,
    inputId: sent.input.inputId,
    message: { role: 'user', content: sent.input.text },
  });
  store.appendModelMessage({
    runId: sent.runId,
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: callId, name: 'bash', arguments: { command: 'unknown write' } }],
    },
  });
  store.updateRunStatus(sent.runId, 'interrupted');
  return sent;
}

async function waitStatus(store: SessionStore, runId: string, status: RunStatus) {
  await vi.waitFor(
    () => {
      expect(store.getRunById(runId).status).toBe(status);
    },
    { timeout: 3000 },
  );
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

it('deduplicates and cancels pending Thread title summaries during shutdown', async () => {
  const provider = new GatedProvider([response('不应保存')]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const input = {
      ownerId,
      threadId: thread.threadId,
      prompt: '生成标题',
      expectedTitle: thread.title,
    };
    send(store, thread.threadId, '生成标题', 'title-input');
    coordinator.scheduleThreadTitleSummary(input);
    coordinator.scheduleThreadTitleSummary(input);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));

    await coordinator.close();
    expect(store.getThread(ownerId, thread.threadId).title).toBe('会话');
    expect(provider.requests).toHaveLength(1);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('persists every final tool result before the next model request', async () => {
  const file = '/srv/one/input.txt';
  const provider = new ScriptedProvider([
    [
      {
        type: 'response',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'unknown', name: 'missing', arguments: {} },
            { id: 'invalid', name: 'read', arguments: { path: 1 } },
            { id: 'valid', name: 'read', arguments: { path: file, limit: 1 } },
          ],
          incomplete_tool_calls: [
            { id: 'incomplete', name: 'read', arguments_text: '{', error: 'Incomplete JSON.' },
          ],
        },
        usage,
      },
    ],
    response('done'),
  ]);
  const { database, store, coordinator, thread, directory, environmentOperations } = await fixture(
    provider,
    {},
    { environmentPolicy: testEnvironmentPolicyInput },
  );
  environmentOperations.readContent = 'tool-content';
  try {
    const sent = send(store, thread.threadId, 'use tools');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'completed');
    expect(provider.requests).toHaveLength(2);
    const secondRequest = provider.requests[1];
    expect(secondRequest?.messages.filter((message) => message.role === 'tool')).toHaveLength(4);
    const messages = store.listContext(ownerId, thread.threadId, 'thread');
    expect(messages.filter((message) => message.message.role === 'tool')).toHaveLength(4);
    expect(
      messages.some(
        (message) =>
          message.message.role === 'tool' && message.message.content.includes('tool-content'),
      ),
    ).toBe(true);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('enters steer input at a safe boundary and holds follow-up input until natural end', async () => {
  const provider = new GatedProvider([response('first'), response('second'), response('third')]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = send(store, thread.threadId, 'initial');
    await coordinator.deliver(sent.input, sent.runId);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    const steer = send(store, thread.threadId, 'steer', 'send-2', 'steer');
    await coordinator.deliver(steer.input, steer.runId);
    const followUp = send(store, thread.threadId, 'follow up', 'send-3');
    await coordinator.deliver(followUp.input, followUp.runId);
    await coordinator.deliver(steer.input, steer.runId);
    await coordinator.deliver(followUp.input, followUp.runId);
    provider.gates[0]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    expect(provider.requests[1]?.messages.some((message) => message.content === 'steer')).toBe(
      true,
    );
    expect(provider.requests[1]?.messages.some((message) => message.content === 'follow up')).toBe(
      false,
    );
    provider.gates[1]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(3));
    expect(provider.requests[2]?.messages.some((message) => message.content === 'follow up')).toBe(
      true,
    );
    provider.gates[2]?.resolve();
    await waitStatus(store, sent.runId, 'completed');
    expect(
      store
        .listContext(ownerId, thread.threadId, 'thread')
        .map((message) => message.message.content),
    ).toEqual(['initial', 'first', 'steer', 'second', 'follow up', 'third']);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('uses edited, removed and reordered follow-up inputs while a Run is active', async () => {
  const provider = new GatedProvider([
    response('initial answer'),
    response('second answer'),
    response('first answer'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = send(store, thread.threadId, 'initial');
    await coordinator.deliver(sent.input, sent.runId);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    const first = send(store, thread.threadId, 'first queued', 'send-2');
    const second = send(store, thread.threadId, 'second queued', 'send-3');
    const removed = send(store, thread.threadId, 'remove me', 'send-4');
    for (const input of [first, second, removed]) {
      await coordinator.deliver(input.input, input.runId);
    }
    store.editInput(
      action('EditInput', 'edit-follow-up', {
        threadId: thread.threadId,
        inputId: second.input.inputId,
        text: 'second edited',
        expectedVersion: BigInt(second.input.version),
      }),
    );
    store.removeInput(
      action('RemoveInput', 'remove-follow-up', {
        threadId: thread.threadId,
        inputId: removed.input.inputId,
        expectedVersion: BigInt(removed.input.version),
      }),
    );
    store.reorderInputs(
      action('ReorderInputs', 'reorder-follow-up', {
        threadId: thread.threadId,
        inputIds: [second.input.inputId, first.input.inputId],
        expectedVersion: BigInt(store.queueVersion(thread.threadId)),
      }),
    );

    provider.gates[0]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    expect(provider.requests[1]?.messages.at(-1)?.content).toBe('second edited');
    provider.gates[1]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(3));
    expect(provider.requests[2]?.messages.at(-1)?.content).toBe('first queued');
    provider.gates[2]?.resolve();
    await waitStatus(store, sent.runId, 'completed');

    expect(store.getInput(ownerId, removed.input.inputId).status).toBe('cancelled');
    expect(
      store
        .listContext(ownerId, thread.threadId, 'thread')
        .map((message) => message.message.content),
    ).toEqual([
      'initial',
      'initial answer',
      'second edited',
      'second answer',
      'first queued',
      'first answer',
    ]);
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await cleanup(coordinator, database, directory);
  }
});

it('uses edited, removed and reordered steer inputs while a Run is active', async () => {
  const provider = new GatedProvider([response('initial answer'), response('steered answer')]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = send(store, thread.threadId, 'initial');
    await coordinator.deliver(sent.input, sent.runId);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    const first = send(store, thread.threadId, 'first steer', 'send-2', 'steer');
    const second = send(store, thread.threadId, 'second steer', 'send-3', 'steer');
    const removed = send(store, thread.threadId, 'remove me', 'send-4', 'steer');
    for (const input of [first, second, removed]) {
      await coordinator.deliver(input.input, input.runId);
    }
    store.editInput(
      action('EditInput', 'edit-steer', {
        threadId: thread.threadId,
        inputId: second.input.inputId,
        text: 'second steer edited',
        expectedVersion: BigInt(second.input.version),
      }),
    );
    store.removeInput(
      action('RemoveInput', 'remove-steer', {
        threadId: thread.threadId,
        inputId: removed.input.inputId,
        expectedVersion: BigInt(removed.input.version),
      }),
    );
    store.reorderInputs(
      action('ReorderInputs', 'reorder-steer', {
        threadId: thread.threadId,
        inputIds: [second.input.inputId, first.input.inputId],
        expectedVersion: BigInt(store.queueVersion(thread.threadId)),
      }),
    );

    provider.gates[0]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    expect(
      provider.requests[1]?.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
    ).toEqual(['initial', 'second steer edited', 'first steer']);
    provider.gates[1]?.resolve();
    await waitStatus(store, sent.runId, 'completed');

    expect(store.getInput(ownerId, removed.input.inputId).status).toBe('cancelled');
    expect(
      store
        .listContext(ownerId, thread.threadId, 'thread')
        .map((message) => message.message.content),
    ).toEqual([
      'initial',
      'initial answer',
      'second steer edited',
      'first steer',
      'steered answer',
    ]);
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await cleanup(coordinator, database, directory);
  }
});

it('keeps follow-up and steer bodies bound to their own input records', async () => {
  const provider = new GatedProvider([
    response('answer 1'),
    response('answer 2'),
    response('answer 3'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  const appended = vi.spyOn(store, 'appendModelMessage');
  try {
    const sent = send(store, thread.threadId, 'initial');
    await coordinator.deliver(sent.input, sent.runId);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    const followUp = send(store, thread.threadId, 'follow-up body', 'send-2');
    const steer = send(store, thread.threadId, 'steer body', 'send-3', 'steer');
    await coordinator.deliver(followUp.input, followUp.runId);
    await coordinator.deliver(steer.input, steer.runId);

    provider.gates[0]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    expect(
      provider.requests[1]?.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
    ).toEqual(['initial', 'steer body']);
    expect(store.getInput(ownerId, followUp.input.inputId).status).toBe('queued');
    expect(store.getInput(ownerId, steer.input.inputId).status).toBe('consumed');

    provider.gates[1]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(3));
    expect(provider.requests[2]?.messages.at(-1)?.content).toBe('follow-up body');
    provider.gates[2]?.resolve();
    await waitStatus(store, sent.runId, 'completed');

    expect(
      appended.mock.calls.flatMap(([input]) =>
        input.message.role === 'user'
          ? [{ content: input.message.content, inputId: input.inputId }]
          : [],
      ),
    ).toEqual([
      { content: 'initial', inputId: sent.input.inputId },
      { content: 'steer body', inputId: steer.input.inputId },
      { content: 'follow-up body', inputId: followUp.input.inputId },
    ]);
    for (const input of [sent, followUp, steer]) {
      expect(store.getInput(ownerId, input.input.inputId)).toMatchObject({
        status: 'consumed',
        consumedRunId: sent.runId,
      });
    }
    expect(
      store
        .listContext(ownerId, thread.threadId, 'thread')
        .map((message) => message.message.content),
    ).toEqual(['initial', 'answer 1', 'steer body', 'answer 2', 'follow-up body', 'answer 3']);
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await cleanup(coordinator, database, directory);
  }
});

it('keeps edited, removed and reordered mixed inputs aligned', async () => {
  const provider = new GatedProvider([
    response('answer 1'),
    response('answer 2'),
    response('answer 3'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  const appended = vi.spyOn(store, 'appendModelMessage');
  try {
    const sent = send(store, thread.threadId, 'initial');
    await coordinator.deliver(sent.input, sent.runId);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    const followUp = send(store, thread.threadId, 'follow-up source', 'send-2');
    const firstSteer = send(store, thread.threadId, 'steer one', 'send-3', 'steer');
    const removed = send(store, thread.threadId, 'remove me', 'send-4');
    const secondSteer = send(store, thread.threadId, 'steer two', 'send-5', 'steer');
    for (const input of [followUp, firstSteer, removed, secondSteer]) {
      await coordinator.deliver(input.input, input.runId);
    }
    store.editInput(
      action('EditInput', 'edit-mixed', {
        threadId: thread.threadId,
        inputId: followUp.input.inputId,
        text: 'follow-up edited',
        expectedVersion: BigInt(followUp.input.version),
      }),
    );
    store.removeInput(
      action('RemoveInput', 'remove-mixed', {
        threadId: thread.threadId,
        inputId: removed.input.inputId,
        expectedVersion: BigInt(removed.input.version),
      }),
    );
    store.reorderInputs(
      action('ReorderInputs', 'reorder-mixed', {
        threadId: thread.threadId,
        inputIds: [secondSteer.input.inputId, followUp.input.inputId, firstSteer.input.inputId],
        expectedVersion: BigInt(store.queueVersion(thread.threadId)),
      }),
    );

    provider.gates[0]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    expect(
      provider.requests[1]?.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
    ).toEqual(['initial', 'steer two', 'steer one']);
    provider.gates[1]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(3));
    expect(provider.requests[2]?.messages.at(-1)?.content).toBe('follow-up edited');
    provider.gates[2]?.resolve();
    await waitStatus(store, sent.runId, 'completed');

    expect(
      appended.mock.calls.flatMap(([input]) =>
        input.message.role === 'user'
          ? [{ content: input.message.content, inputId: input.inputId }]
          : [],
      ),
    ).toEqual([
      { content: 'initial', inputId: sent.input.inputId },
      { content: 'steer two', inputId: secondSteer.input.inputId },
      { content: 'steer one', inputId: firstSteer.input.inputId },
      { content: 'follow-up edited', inputId: followUp.input.inputId },
    ]);
    for (const input of [sent, followUp, firstSteer, secondSteer]) {
      expect(store.getInput(ownerId, input.input.inputId)).toMatchObject({
        status: 'consumed',
        consumedRunId: sent.runId,
      });
    }
    expect(store.getInput(ownerId, removed.input.inputId)).toMatchObject({
      status: 'cancelled',
      consumedRunId: null,
    });
    expect(
      store
        .listContext(ownerId, thread.threadId, 'thread')
        .map((message) => message.message.content),
    ).toEqual([
      'initial',
      'answer 1',
      'steer two',
      'steer one',
      'answer 2',
      'follow-up edited',
      'answer 3',
    ]);
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await cleanup(coordinator, database, directory);
  }
});

it('reruns an anchor before consuming queued inputs in their original order', async () => {
  const provider = new ScriptedProvider([
    response('旧回答'),
    response('锚点新回答'),
    response('第一队列回答'),
    response('第二队列回答'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const original = send(store, thread.threadId, '原始问题');
    await coordinator.deliver(original.input, original.runId);
    await waitStatus(store, original.runId, 'completed');
    const first = send(store, thread.threadId, '队列一', 'queue-1');
    const second = send(store, thread.threadId, '队列二', 'queue-2');
    expect(second.runId).toBe(first.runId);
    store.updateRunStatus(first.runId, 'failed');
    const anchor = store
      .listContext(ownerId, thread.threadId, 'thread')
      .find((message) => message.message.role === 'user');
    if (!anchor) throw new Error('Rerun anchor is missing.');

    const rerun = store.rerun(
      action('Rerun', 'rerun-queue', {
        threadId: thread.threadId,
        messageId: anchor.messageId,
      }),
    );
    coordinator.schedule(thread.threadId, rerun.runId);
    await waitStatus(store, rerun.runId, 'completed');

    expect(provider.requests).toHaveLength(4);
    const anchorRequest = JSON.stringify(provider.requests[1]);
    expect(anchorRequest).toContain('原始问题');
    expect(anchorRequest).not.toContain('旧回答');
    expect(anchorRequest).not.toContain('队列一');
    expect(JSON.stringify(provider.requests[2])).toContain('队列一');
    expect(JSON.stringify(provider.requests[2])).not.toContain('队列二');
    expect(JSON.stringify(provider.requests[3])).toContain('队列二');
    const current = store.context.query({
      threadId: thread.threadId,
      agentId: 'thread',
      currentOnly: true,
    });
    expect(current.map((message) => message.message.content)).toEqual([
      '原始问题',
      '锚点新回答',
      '队列一',
      '第一队列回答',
      '队列二',
      '第二队列回答',
    ]);
    expect(
      store
        .listContext(ownerId, thread.threadId, 'thread')
        .filter((message) => message.message.content === '原始问题'),
    ).toHaveLength(1);
    expect(store.getRunById(rerun.runId).inputIds).toEqual([
      first.input.inputId,
      second.input.inputId,
    ]);
    expect(store.getRunById(rerun.runId).usage).toEqual({ inputTokens: 3, outputTokens: 3 });
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('schedules queued input after an anchor Run fails before its first response', async () => {
  const provider = new ScriptedProvider([
    response('旧回答'),
    [
      {
        type: 'stream_interrupted',
        error: { code: 'stream_interrupted', message: '锚点中断' },
        usage,
      },
    ],
    response('队列回答'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const original = send(store, thread.threadId, '原始问题');
    await coordinator.deliver(original.input, original.runId);
    await waitStatus(store, original.runId, 'completed');
    const queued = send(store, thread.threadId, '待消费输入', 'queue-after-failure');
    store.updateRunStatus(queued.runId, 'failed');
    const anchor = store
      .listContext(ownerId, thread.threadId, 'thread')
      .find((message) => message.message.role === 'user');
    if (!anchor) throw new Error('Rerun anchor is missing.');
    const rerun = store.rerun(
      action('Rerun', 'rerun-fails-before-response', {
        threadId: thread.threadId,
        messageId: anchor.messageId,
      }),
    );
    coordinator.schedule(thread.threadId, rerun.runId);
    await waitStatus(store, rerun.runId, 'interrupted');
    await vi.waitFor(() => expect(store.listRuns(ownerId, thread.threadId)).toHaveLength(4));
    const continuation = store.listRuns(ownerId, thread.threadId).at(-1);
    if (!continuation) throw new Error('Queued continuation Run is missing.');
    await waitStatus(store, continuation.runId, 'completed');

    expect(store.getRunById(rerun.runId).inputIds).toEqual([]);
    expect(store.getRunById(continuation.runId).inputIds).toEqual([queued.input.inputId]);
    expect(
      store.context
        .query({ threadId: thread.threadId, agentId: 'thread', currentOnly: true })
        .map((message) => message.message.content),
    ).toEqual(['原始问题', '待消费输入', '队列回答']);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('separates cancellation acceptance from actual Loop termination', async () => {
  const provider: ModelProvider = {
    async *stream(request, signal) {
      void request;
      await new Promise<void>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = send(store, thread.threadId, 'wait');
    await coordinator.deliver(sent.input, sent.runId);
    const accepted = store.requestCancelRun(
      action('CancelRun', 'cancel-1', {
        threadId: thread.threadId,
        runId: sent.runId,
        reason: 'stop',
      }),
    );
    expect(accepted.status).toBe('cancel_requested');
    expect(() => send(store, thread.threadId, 'rejected', 'send-2')).toThrowError(
      expect.objectContaining({ code: 'failed_precondition' }),
    );
    await coordinator.cancel(accepted, 'stop');
    await waitStatus(store, sent.runId, 'cancelled');
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('reminds the execution after a user-cancelled Run and clears the reminder once work completes', async () => {
  let attempts = 0;
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    async *stream(request, signal) {
      requests.push(structuredClone(request));
      attempts += 1;
      if (attempts === 1) {
        await new Promise<void>((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return;
      }
      yield* response('done');
    },
  };
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  const systemOf = (marker: string) =>
    requests
      .find((candidate) =>
        candidate.messages.some(
          (message) => message.role === 'user' && message.content.includes(marker),
        ),
      )
      ?.messages.filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n') ?? '';
  try {
    const cancelled = send(store, thread.threadId, 'first', 'send-first');
    await coordinator.deliver(cancelled.input, cancelled.runId);
    await vi.waitFor(() => expect(attempts).toBe(1));
    const accepted = store.requestCancelRun(
      action('CancelRun', 'cancel-reminder', {
        threadId: thread.threadId,
        runId: cancelled.runId,
        reason: 'stop',
      }),
    );
    await coordinator.cancel(accepted, 'stop');
    await waitStatus(store, cancelled.runId, 'cancelled');

    const resumed = send(store, thread.threadId, 'second', 'send-second');
    await coordinator.deliver(resumed.input, resumed.runId);
    await waitStatus(store, resumed.runId, 'completed');
    expect(systemOf('second')).toContain(
      '<system-reminder>The previous execution was interrupted by the user before completion;',
    );

    const settled = send(store, thread.threadId, 'third', 'send-third');
    await coordinator.deliver(settled.input, settled.runId);
    await waitStatus(store, settled.runId, 'completed');
    expect(systemOf('third')).not.toContain('The previous execution was interrupted');
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('reuses the stable request ID when an interrupted model step continues', async () => {
  let attempts = 0;
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    async *stream(request) {
      requests.push(structuredClone(request));
      attempts += 1;
      if (attempts === 1) throw new Error('connection lost');
      yield* response('recovered');
    },
  };
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = send(store, thread.threadId, 'retry');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'failed');
    const continued = store.continueRun(
      action('ContinueRun', 'continue-1', { threadId: thread.threadId, runId: sent.runId }),
    );
    coordinator.schedule(thread.threadId, continued.runId);
    await waitStatus(store, sent.runId, 'completed');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    const count = database.prepare('SELECT COUNT(*) AS count FROM model_request_records').get() as {
      count: number;
    };
    expect(count.count).toBe(1);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('runs a Subagent in an isolated Context and returns its result to the parent', async () => {
  const provider = new ScriptedProvider([
    response('', [
      { id: 'child-call', name: 'subagent', arguments: { task: 'child task', mode: 'foreground' } },
    ]),
    response('child answer'),
    response('parent answer'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = send(store, thread.threadId, 'parent task');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'completed');
    const runs = store.listRuns(ownerId, thread.threadId);
    const child = runs.find((run) => run.parentRunId === sent.runId);
    expect(child?.status).toBe('completed');
    expect(child?.agentId).not.toBe('thread');
    if (child) {
      expect(
        store.listContext(ownerId, thread.threadId, child.agentId).map((m) => m.message.content),
      ).toEqual(['child task', 'child answer']);
    }
    const parentContext = store.listContext(ownerId, thread.threadId, 'thread');
    expect(parentContext.some((message) => message.message.content.includes('child answer'))).toBe(
      true,
    );
    expect(parentContext.some((message) => message.message.content === 'child task')).toBe(false);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('authorizes parent and child recall tools by the current Run relationship', async () => {
  const provider = new GatedProvider([
    response('', [
      { id: 'child-call', name: 'subagent', arguments: { task: 'child task', mode: 'foreground' } },
    ]),
    response('child placeholder'),
    response('child answer'),
    response('parent placeholder'),
    response('parent answer'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  const replaceResponse = (index: number, events: ModelEvent[]) => {
    const target = provider.responses[index];
    if (!target) throw new Error(`Missing response ${index}.`);
    target.splice(0, target.length, ...events);
  };
  try {
    const unrelatedRoot = send(store, thread.threadId, 'unrelated root', 'send-unrelated-root');
    store.appendModelMessage({
      runId: unrelatedRoot.runId,
      inputId: unrelatedRoot.input.inputId,
      message: { role: 'user', content: unrelatedRoot.input.text },
    });
    store.updateRunStatus(unrelatedRoot.runId, 'completed');
    const unrelated = store.createChildRun(ownerId, unrelatedRoot.runId, 'subagent-unrelated');
    store.appendModelMessage({
      runId: unrelated.runId,
      message: { role: 'user', content: 'unrelated child secret' },
    });
    store.updateRunStatus(unrelated.runId, 'completed');

    const otherThread = store.createThread(
      action('CreateThread', 'create-cross-thread', { title: '其他会话' }),
    );
    const crossRoot = send(store, otherThread.threadId, 'cross root', 'send-cross-root');
    store.appendModelMessage({
      runId: crossRoot.runId,
      inputId: crossRoot.input.inputId,
      message: { role: 'user', content: crossRoot.input.text },
    });
    store.updateRunStatus(crossRoot.runId, 'completed');
    const crossThread = store.createChildRun(ownerId, crossRoot.runId, 'subagent-cross-thread');
    store.appendModelMessage({
      runId: crossThread.runId,
      message: { role: 'user', content: 'cross-thread secret' },
    });
    store.updateRunStatus(crossThread.runId, 'completed');

    const sent = send(store, thread.threadId, 'parent task', 'send-parent');
    await coordinator.deliver(sent.input, sent.runId);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    const registeredTools = provider.requests[0]?.tools ?? [];
    expect(
      registeredTools.map((tool) => tool.name).filter((name) => name.startsWith('recall')),
    ).toEqual(['recall']);
    expect(registeredTools.find((tool) => tool.name === 'recall')?.description).toContain(
      thread.threadId,
    );
    provider.gates[0]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    const child = store
      .listRuns(ownerId, thread.threadId)
      .find((run) => run.parentRunId === sent.runId);
    if (!child) throw new Error('Child Run was not created.');
    const sibling = store.createChildRun(ownerId, sent.runId, 'subagent-sibling');
    store.appendModelMessage({
      runId: sibling.runId,
      message: { role: 'user', content: 'sibling secret' },
    });
    store.updateRunStatus(sibling.runId, 'completed');
    const childSource = store
      .listContext(ownerId, thread.threadId, child.agentId)
      .find((record) => record.message.role === 'user');
    if (!childSource) throw new Error('Child source message is missing.');
    store.recaps.save({
      recapId: 'child-recap-valid',
      threadId: thread.threadId,
      agentId: child.agentId,
      sourceMessageSeqs: [childSource.seq],
      content: 'authorized child recap',
    });
    store.recaps.save({
      recapId: 'child-recap-invalid',
      threadId: thread.threadId,
      agentId: child.agentId,
      sourceMessageSeqs: [childSource.seq],
      content: 'invalid-child-secret',
    });
    store.recaps.invalidate(
      thread.threadId,
      child.agentId,
      'child-recap-invalid',
      'test invalidation',
    );

    replaceResponse(
      1,
      response('', [
        {
          id: 'child-self-context',
          name: 'recall',
          arguments: { sql: "SELECT role, content FROM context WHERE content = 'child task'" },
        },
        {
          id: 'child-self-recap',
          name: 'recall',
          arguments: { sql: 'SELECT recap_id, content FROM recap ORDER BY recap_id' },
        },
        {
          id: 'child-parent',
          name: 'recall',
          arguments: { sql: "SELECT content FROM context WHERE agent_id = 'thread'" },
        },
        {
          id: 'child-sibling',
          name: 'recall',
          arguments: { sql: `SELECT content FROM context WHERE agent_id = '${sibling.agentId}'` },
        },
        {
          id: 'child-unrelated',
          name: 'recall',
          arguments: { sql: `SELECT content FROM context WHERE agent_id = '${unrelated.agentId}'` },
        },
        {
          id: 'child-cross-thread',
          name: 'recall',
          arguments: {
            sql: `SELECT content FROM context WHERE thread_id = '${otherThread.threadId}' AND agent_id = '${crossThread.agentId}'`,
          },
        },
      ]),
    );
    replaceResponse(
      3,
      response('', [
        {
          id: 'parent-child-context',
          name: 'recall',
          arguments: {
            sql: `SELECT role, content FROM context WHERE agent_id = '${child.agentId}' AND seq = ${childSource.seq}`,
          },
        },
        {
          id: 'parent-child-recap',
          name: 'recall',
          arguments: { sql: 'SELECT recap_id, content FROM recap ORDER BY recap_id' },
        },
        {
          id: 'parent-unrelated',
          name: 'recall',
          arguments: { sql: `SELECT content FROM context WHERE agent_id = '${unrelated.agentId}'` },
        },
        {
          id: 'parent-cross-thread',
          name: 'recall',
          arguments: {
            sql: `SELECT content FROM context WHERE thread_id = '${otherThread.threadId}' AND agent_id = '${crossThread.agentId}'`,
          },
        },
      ]),
    );
    provider.gates[1]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(3), { timeout: 3000 });
    provider.gates[2]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(4));
    provider.gates[3]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(5), { timeout: 3000 });
    provider.gates[4]?.resolve();
    await waitStatus(store, sent.runId, 'completed');

    const toolMessage = (agentId: string, callId: string): ToolMessage => {
      const message = store
        .listContext(ownerId, thread.threadId, agentId)
        .find(
          (record) => record.message.role === 'tool' && record.message.tool_call_id === callId,
        )?.message;
      if (message?.role !== 'tool') throw new Error(`Tool result ${callId} is missing.`);
      return message;
    };
    const childContext = JSON.parse(toolMessage(child.agentId, 'child-self-context').content);
    expect(childContext.rows).toEqual([['user', 'child task']]);
    const childRecaps = JSON.parse(toolMessage(child.agentId, 'child-self-recap').content);
    expect(childRecaps.rows).toEqual([['child-recap-valid', 'authorized child recap']]);
    expect(JSON.stringify(childRecaps)).not.toContain('invalid-child-secret');

    const parentContext = JSON.parse(toolMessage('thread', 'parent-child-context').content);
    expect(parentContext.rows).toEqual([['user', 'child task']]);
    expect(JSON.stringify(parentContext)).not.toContain('run_id');
    expect(JSON.stringify(parentContext)).not.toContain('queue');
    const parentRecaps = JSON.parse(toolMessage('thread', 'parent-child-recap').content);
    expect(parentRecaps.rows).toEqual([['child-recap-valid', 'authorized child recap']]);
    expect(JSON.stringify(parentRecaps)).not.toContain('run_id');
    expect(JSON.stringify(parentRecaps)).not.toContain('queue');
    expect(JSON.stringify(parentRecaps)).not.toContain('invalid-child-secret');

    for (const [agentId, callId] of [
      [child.agentId, 'child-parent'],
      [child.agentId, 'child-sibling'],
      [child.agentId, 'child-unrelated'],
      [child.agentId, 'child-cross-thread'],
      ['thread', 'parent-unrelated'],
      ['thread', 'parent-cross-thread'],
    ] as const) {
      expect(toolMessage(agentId, callId)).toMatchObject({ status: 'success' });
      expect(JSON.parse(toolMessage(agentId, callId).content).rows).toEqual([]);
    }
    expect(
      JSON.stringify(store.listContext(ownerId, thread.threadId, child.agentId)),
    ).not.toContain('sibling secret');
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await cleanup(coordinator, database, directory);
  }
});

it('elevates recall visibility to the owner for the global main root Run', async () => {
  const provider = new ScriptedProvider([
    response('', [
      {
        id: 'main-owner-recall',
        name: 'recall',
        arguments: { sql: "SELECT content FROM context WHERE content = 'task secret note'" },
      },
    ]),
    response('done'),
  ]);
  const { database, store, coordinator, directory } = await fixture(provider);
  try {
    const main = store.getOrCreateMainThread(ownerId);
    const task = store.createThread(action('CreateThread', 'create-owner-task', { title: '任务' }));
    const taskRun = send(store, task.threadId, 'task secret note', 'send-owner-task');
    store.appendModelMessage({
      runId: taskRun.runId,
      inputId: taskRun.input.inputId,
      message: { role: 'user', content: taskRun.input.text },
    });
    store.updateRunStatus(taskRun.runId, 'completed');
    const sent = send(store, main.threadId, 'query owner visibility', 'send-owner-main');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'completed');
    const message = store
      .listContext(ownerId, main.threadId, 'thread')
      .map((record) => record.message)
      .find(
        (candidate) => candidate.role === 'tool' && candidate.tool_call_id === 'main-owner-recall',
      );
    const result = JSON.parse(message?.content ?? '{}');
    expect(result.rows).toEqual([['task secret note']]);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('limits recall visibility to the same workspace for a workspace main root Run', async () => {
  const provider = new ScriptedProvider([
    response('', [
      {
        id: 'ws-visibility',
        name: 'recall',
        arguments: {
          sql: "SELECT content FROM context WHERE content LIKE '%workspace note' ORDER BY content",
        },
      },
    ]),
    response('done'),
  ]);
  const { database, store, coordinator, directory } = await fixture(provider);
  try {
    const created = store.createWorkspace({
      ownerId,
      name: '空间一',
      envId: 'main',
      path: '/ws-one',
    });
    const insideTask = store.createThread(
      action('CreateThread', 'create-ws-inside', {
        title: '空间内任务',
        workspaceId: created.workspace.workspaceId,
      }),
    );
    const insideRun = send(store, insideTask.threadId, 'inside workspace note', 'send-ws-inside');
    store.appendModelMessage({
      runId: insideRun.runId,
      inputId: insideRun.input.inputId,
      message: { role: 'user', content: insideRun.input.text },
    });
    store.updateRunStatus(insideRun.runId, 'completed');
    const outsideTask = store.createThread(
      action('CreateThread', 'create-ws-outside', { title: '空间外任务' }),
    );
    const outsideRun = send(
      store,
      outsideTask.threadId,
      'outside workspace note',
      'send-ws-outside',
    );
    store.appendModelMessage({
      runId: outsideRun.runId,
      inputId: outsideRun.input.inputId,
      message: { role: 'user', content: outsideRun.input.text },
    });
    store.updateRunStatus(outsideRun.runId, 'completed');
    const sent = send(
      store,
      created.mainThread.threadId,
      'query workspace visibility',
      'send-ws-main',
    );
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'completed');
    const message = store
      .listContext(ownerId, created.mainThread.threadId, 'thread')
      .map((record) => record.message)
      .find((candidate) => candidate.role === 'tool' && candidate.tool_call_id === 'ws-visibility');
    const result = JSON.parse(message?.content ?? '{}');
    expect(result.rows).toEqual([['inside workspace note']]);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('keeps delegated Runs in the global main Thread at self visibility', async () => {
  const provider = new GatedProvider([
    response('', [
      {
        id: 'main-delegate',
        name: 'subagent',
        arguments: { task: 'child task', mode: 'foreground' },
      },
    ]),
    response('child placeholder'),
    response('child answer'),
    response('parent placeholder'),
    response('parent answer'),
  ]);
  const { database, store, coordinator, directory } = await fixture(provider);
  const replaceResponse = (index: number, events: ModelEvent[]) => {
    const target = provider.responses[index];
    if (!target) throw new Error(`Missing response ${index}.`);
    target.splice(0, target.length, ...events);
  };
  try {
    const otherThread = store.createThread(
      action('CreateThread', 'create-narrow-other', { title: '其他会话' }),
    );
    const otherRun = send(store, otherThread.threadId, 'narrowing secret', 'send-narrow-other');
    store.appendModelMessage({
      runId: otherRun.runId,
      inputId: otherRun.input.inputId,
      message: { role: 'user', content: otherRun.input.text },
    });
    store.updateRunStatus(otherRun.runId, 'completed');
    const main = store.getOrCreateMainThread(ownerId);
    const sent = send(store, main.threadId, 'delegate work', 'send-narrow-main');
    await coordinator.deliver(sent.input, sent.runId);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    provider.gates[0]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    const child = store
      .listRuns(ownerId, main.threadId)
      .find((run) => run.parentRunId === sent.runId);
    if (!child) throw new Error('Child Run was not created.');
    replaceResponse(
      1,
      response('', [
        {
          id: 'child-cross',
          name: 'recall',
          arguments: { sql: "SELECT content FROM context WHERE content = 'narrowing secret'" },
        },
      ]),
    );
    replaceResponse(
      3,
      response('', [
        {
          id: 'parent-cross',
          name: 'recall',
          arguments: { sql: "SELECT content FROM context WHERE content = 'narrowing secret'" },
        },
      ]),
    );
    provider.gates[1]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(3), { timeout: 3000 });
    provider.gates[2]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(4));
    provider.gates[3]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(5), { timeout: 3000 });
    provider.gates[4]?.resolve();
    await waitStatus(store, sent.runId, 'completed');
    const toolRows = (agentId: string, callId: string): unknown => {
      const message = store
        .listContext(ownerId, main.threadId, agentId)
        .find(
          (record) => record.message.role === 'tool' && record.message.tool_call_id === callId,
        )?.message;
      if (message?.role !== 'tool') throw new Error(`Tool result ${callId} is missing.`);
      return JSON.parse(message.content).rows;
    };
    expect(toolRows(child.agentId, 'child-cross')).toEqual([]);
    expect(toolRows('thread', 'parent-cross')).toEqual([['narrowing secret']]);
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await cleanup(coordinator, database, directory);
  }
});

it('injects the memory index into root Agents and the write policy only into the global main', async () => {
  const memoryDirectory = await mkdtemp(join(tmpdir(), 'kairos-runtime-memory-'));
  await writeFile(join(memoryDirectory, 'MEMORY.md'), '# 记忆\n- 偏好中文回复\n');
  const provider = new ScriptedProvider([response('main done'), response('task done')]);
  const { database, store, coordinator, thread, directory } = await fixture(provider, undefined, {
    memory: new MemoryWiki({ directory: memoryDirectory }),
  });
  try {
    const main = store.getOrCreateMainThread(ownerId);
    const mainSent = send(store, main.threadId, 'query memory', 'send-memory-main');
    await coordinator.deliver(mainSent.input, mainSent.runId);
    await waitStatus(store, mainSent.runId, 'completed');
    const taskSent = send(store, thread.threadId, 'query memory task', 'send-memory-task');
    await coordinator.deliver(taskSent.input, taskSent.runId);
    await waitStatus(store, taskSent.runId, 'completed');

    const systemText = (index: number) =>
      (provider.requests[index]?.messages ?? [])
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
    expect(systemText(0)).toContain('<memory-index');
    expect(systemText(0)).toContain('偏好中文回复');
    expect(systemText(0)).toContain('Memory updates:');
    expect(systemText(1)).toContain('<memory-index');
    expect(systemText(1)).not.toContain('Memory updates:');
  } finally {
    await rm(memoryDirectory, { recursive: true, force: true });
    await cleanup(coordinator, database, directory);
  }
});

it('omits memory instructions when the configured memory directory is missing', async () => {
  const provider = new ScriptedProvider([response('done')]);
  const missingDirectory = join(tmpdir(), 'kairos-memory-missing-dir');
  const { database, store, coordinator, thread, directory } = await fixture(provider, undefined, {
    memory: new MemoryWiki({ directory: missingDirectory }),
  });
  try {
    const sent = send(store, thread.threadId, 'memory directory missing');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'completed');
    const systemText = (provider.requests[0]?.messages ?? [])
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(systemText).not.toContain('<memory-index');
    expect(systemText).not.toContain('Memory updates:');
    expect(systemText).not.toContain('Long-term memory:');
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('omits memory instructions when no memory wiki is configured', async () => {
  const provider = new ScriptedProvider([response('done')]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = send(store, thread.threadId, 'no memory');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'completed');
    const systemText = (provider.requests[0]?.messages ?? [])
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(systemText).not.toContain('<memory-index');
    expect(systemText).not.toContain('Memory updates:');
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('elevates recall visibility to the owner for automation-only Thread root Runs', async () => {
  const provider = new ScriptedProvider([
    response('', [
      {
        id: 'dream-recall',
        name: 'recall',
        arguments: { sql: "SELECT content FROM context WHERE content = 'watched thread note'" },
      },
    ]),
    response('dream done'),
  ]);
  const { database, store, coordinator, directory } = await fixture(provider);
  const service = new AutomationService(store, {
    deliver: (input, runId) => coordinator.deliver(input, runId),
  });
  try {
    const other = store.createThread(
      action('CreateThread', 'create-dream-other', { title: '其他会话' }),
    );
    const otherRun = send(store, other.threadId, 'watched thread note', 'send-dream-other');
    store.appendModelMessage({
      runId: otherRun.runId,
      inputId: otherRun.input.inputId,
      message: { role: 'user', content: otherRun.input.text },
    });
    store.updateRunStatus(otherRun.runId, 'completed');
    const automation = service.create({
      ownerId,
      clientActionId: 'create-dream-automation',
      name: '记忆整理 (dream)',
      prompt: '整理记忆',
      schedule: { kind: 'cron', expression: '23 3 * * *', timeZone: 'Asia/Shanghai' },
      target: { kind: 'new_automation_only' },
    });
    const fire = await service.runNow({
      ownerId,
      clientActionId: 'run-dream-automation',
      scheduleId: automation.scheduleId,
    });
    await vi.waitFor(
      () => {
        const message = database
          .prepare(
            `SELECT content FROM context_messages
             WHERE role = 'tool' AND tool_call_id = 'dream-recall' ORDER BY seq DESC LIMIT 1`,
          )
          .get();
        expect(message).toBeDefined();
      },
      { timeout: 5000 },
    );
    const message = database
      .prepare(
        `SELECT content FROM context_messages
         WHERE role = 'tool' AND tool_call_id = 'dream-recall' ORDER BY seq DESC LIMIT 1`,
      )
      .get();
    const result = JSON.parse(z.object({ content: z.string() }).parse(message).content);
    expect(result.rows).toEqual([['watched thread note']]);
    const currentFire = service.store
      .listFires(ownerId, automation.scheduleId, 0n, 10)
      .find((candidate) => candidate.fireId === fire.fireId);
    expect(currentFire?.targetThreadId).toBeTruthy();
    const dreamThread = store.getThread(ownerId, currentFire?.targetThreadId ?? '');
    expect(dreamThread.automationOnly).toBe(true);
  } finally {
    await service.close();
    await cleanup(coordinator, database, directory);
  }
});

it('passes configured SQL limits through to real recall results', async () => {
  const provider = new ScriptedProvider([
    response('', [
      {
        id: 'recall-limited',
        name: 'recall',
        arguments: { sql: 'SELECT seq FROM context ORDER BY seq' },
      },
    ]),
    response('done'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider, undefined, {
    sqlRecall: {
      timeoutMs: 2000,
      maxRows: 1,
      maxCellCharacters: 16_384,
      maxResponseBytes: 256 * 1024,
    },
  });
  try {
    const sent = send(store, thread.threadId, 'check recall limit');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'completed');
    const message = store
      .listContext(ownerId, thread.threadId, 'thread')
      .map((record) => record.message)
      .find(
        (candidate) => candidate.role === 'tool' && candidate.tool_call_id === 'recall-limited',
      );
    const result = JSON.parse(message?.content ?? '{}');
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.truncation.reasons).toEqual(['row_limit']);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('persists safe SQL recall errors from the real engine', async () => {
  const provider = new ScriptedProvider([
    response('', [
      {
        id: 'recall-denied',
        name: 'recall',
        arguments: { sql: 'SELECT * FROM context_messages' },
      },
    ]),
    response('done'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = send(store, thread.threadId, 'check recall error');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'completed');
    const message = store
      .listContext(ownerId, thread.threadId, 'thread')
      .map((record) => record.message)
      .find((candidate) => candidate.role === 'tool' && candidate.tool_call_id === 'recall-denied');
    expect(message).toMatchObject({
      role: 'tool',
      status: 'error',
      content: expect.stringContaining('not permitted'),
      error: { code: 'execution_failed', message: expect.stringContaining('not permitted') },
    });
    expect(message?.content).not.toContain('server.sqlite');
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('records an executing SQL recall as cancelled with the Run', async () => {
  const provider = new ScriptedProvider([
    response('', [
      {
        id: 'recall-cancel',
        name: 'recall',
        arguments: {
          sql: `WITH RECURSIVE series(value) AS (
            SELECT 1 UNION ALL SELECT value + 1 FROM series
          ) SELECT sum(value) FROM series`,
        },
      },
    ]),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = send(store, thread.threadId, 'cancel recall');
    await coordinator.deliver(sent.input, sent.runId);
    await vi.waitFor(() => {
      expect(
        store
          .listContext(ownerId, thread.threadId, 'thread')
          .some(
            (record) =>
              record.message.role === 'assistant' &&
              record.message.tool_calls?.some((call) => call.id === 'recall-cancel'),
          ),
      ).toBe(true);
    });
    const accepted = store.requestCancelRun(
      action('CancelRun', 'cancel-sql-recall', {
        threadId: thread.threadId,
        runId: sent.runId,
        reason: 'stop SQL recall',
      }),
    );
    await coordinator.cancel(accepted, 'stop SQL recall');
    await waitStatus(store, sent.runId, 'cancelled');
    const message = store
      .listContext(ownerId, thread.threadId, 'thread')
      .map((record) => record.message)
      .find((candidate) => candidate.role === 'tool' && candidate.tool_call_id === 'recall-cancel');
    expect(message).toMatchObject({
      role: 'tool',
      status: 'error',
      error: { code: 'cancelled' },
    });
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('automatically cuts input above 80 percent and preserves original Context', async () => {
  const provider = new ScriptedProvider([response('short recap'), response('done')]);
  const { database, store, coordinator, thread, directory } = await fixture(provider, {
    contextWindowTokens: 16_000,
    outputReserveTokens: 100,
    countTokens: (request) =>
      request.messages.reduce((total, message) => total + message.content.length, 0),
  });
  try {
    const original = 'x'.repeat(20_000);
    const sent = send(store, thread.threadId, original);
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'completed');
    expect(store.listContext(ownerId, thread.threadId, 'thread')[0]?.message.content).toBe(
      original,
    );
    expect(store.recaps.query({ threadId: thread.threadId, agentId: 'thread' })).toHaveLength(1);
    expect(provider.requests[1]?.messages.some((message) => message.content === original)).toBe(
      false,
    );
    expect(
      provider.requests[1]?.messages.reduce((total, message) => total + message.content.length, 0),
    ).toBeLessThanOrEqual(12_800);
    expect(
      store
        .listEvents(thread.threadId, 0n)
        .some((event) => event.payload.case === 'hardCutCompleted'),
    ).toBe(true);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('does not fail a normal Run when periodic Recap generation fails', async () => {
  const provider = new ScriptedProvider([response('normal answer'), response('')]);
  const { database, store, coordinator, thread, directory } = await fixture(
    provider,
    {},
    { periodicRecap: { triggerMessages: 1, idleAfterMs: 0, maxMessages: 20 } },
  );
  try {
    const sent = send(store, thread.threadId, 'normal request');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'completed');
    await vi.waitFor(() => {
      expect(provider.requests).toHaveLength(2);
      expect(database.prepare('SELECT status FROM recap_generation_operations').get()).toEqual({
        status: 'failed',
      });
    });
    expect(store.getRunById(sent.runId).status).toBe('completed');
    expect(store.recaps.query({ threadId: thread.threadId, agentId: 'thread' })).toHaveLength(0);
    const context = store.listContext(ownerId, thread.threadId, 'thread');
    expect(context.map((record) => record.message.content)).toEqual([
      'normal request',
      'normal answer',
    ]);
    expect(JSON.stringify(context)).not.toContain('Kairos internal Recap operation');
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('includes original tool semantics in actual recap generation requests', async () => {
  const provider = new ScriptedProvider([
    response('user recap'),
    response('tool recap'),
    response('done'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider, {
    contextWindowTokens: 16_000,
    outputReserveTokens: 100,
    countTokens: (request) => JSON.stringify(request.messages).length,
  });
  try {
    const sent = send(store, thread.threadId, 'inspect command results');
    store.appendModelMessage({
      runId: sent.runId,
      inputId: sent.input.inputId,
      message: { role: 'user', content: sent.input.text },
    });
    const longCommand = `printf '${'x'.repeat(20_000)}'`;
    const assistant: AssistantMessage = {
      role: 'assistant',
      content: 'running checks',
      tool_calls: [
        {
          id: 'bash-nonzero',
          name: 'bash',
          arguments: { command: 'printf nonzero; exit 7' },
        },
        { id: 'bash-cancelled', name: 'bash', arguments: { command: 'sleep 60' } },
        { id: 'bash-unknown', name: 'bash', arguments: { command: 'printf unknown' } },
        { id: 'bash-long', name: 'bash', arguments: { command: longCommand } },
      ],
      incomplete_tool_calls: [
        {
          id: 'incomplete-read',
          name: 'read',
          arguments_text: '{"path":',
          error: 'Incomplete JSON.',
        },
      ],
    };
    const storedAssistant = store.appendModelMessage({ runId: sent.runId, message: assistant });
    if (storedAssistant.message.role !== 'assistant') {
      throw new Error('Stored assistant message has the wrong role.');
    }
    const toolResults: ToolMessage[] = [
      {
        role: 'tool',
        content: JSON.stringify({
          status: 'completed',
          exit_code: 7,
          output: 'nonzero preview',
          output_complete: false,
          truncated: true,
          full_output_path: '/server/nonzero.log',
        }),
        tool_call_id: 'bash-nonzero',
        tool_name: 'bash',
        status: 'error',
        error: { code: 'execution_failed', message: 'Command exited with code 7.' },
      },
      {
        role: 'tool',
        content: JSON.stringify({ status: 'cancelled', output: 'cancelled preview' }),
        tool_call_id: 'bash-cancelled',
        tool_name: 'bash',
        status: 'error',
        error: { code: 'cancelled', message: 'Command was cancelled.' },
      },
      {
        role: 'tool',
        content: JSON.stringify({ status: 'unknown', error: 'tool_result_unknown' }),
        tool_call_id: 'bash-unknown',
        tool_name: 'bash',
        status: 'error',
        error: { code: 'execution_failed', message: 'Tool result is unknown.' },
      },
      {
        role: 'tool',
        content: JSON.stringify({ status: 'completed', output: 'long command preview' }),
        tool_call_id: 'bash-long',
        tool_name: 'bash',
        status: 'success',
      },
      {
        role: 'tool',
        content: 'Incomplete JSON.',
        tool_call_id: 'incomplete-read',
        tool_name: 'read',
        status: 'error',
        error: { code: 'incomplete_call', message: 'Incomplete JSON.' },
      },
    ];
    for (const message of toolResults) {
      store.appendModelMessage({ runId: sent.runId, message });
    }
    store.updateRunStatus(sent.runId, 'interrupted');
    const continued = store.continueRun(
      action('ContinueRun', 'continue-recap-tools', {
        threadId: thread.threadId,
        runId: sent.runId,
      }),
    );
    coordinator.schedule(thread.threadId, continued.runId);
    await waitStatus(store, sent.runId, 'completed');

    expect(provider.requests).toHaveLength(3);
    const firstRecapRequest = provider.requests[0];
    const secondRecapRequest = provider.requests[1];
    const completePrefix = firstRecapRequest?.messages.slice(0, -1);
    expect(completePrefix).toEqual(secondRecapRequest?.messages.slice(0, -1));
    expect(completePrefix?.filter((message) => message.role !== 'system')).toEqual([
      { role: 'user', content: 'inspect command results' },
      storedAssistant.message,
      ...toolResults,
    ]);
    const sourceStart = completePrefix?.findIndex(
      (message) => message.role === 'user' && message.content === 'inspect command results',
    );
    expect(sourceStart).toBeGreaterThan(0);
    expect(firstRecapRequest?.messages.at(-1)?.content).toContain(
      JSON.stringify([{ seq: 1, message_index: sourceStart }]),
    );
    expect(secondRecapRequest?.messages.at(-1)?.content).toContain(
      JSON.stringify(
        [2, 3, 4, 5, 6, 7].map((seq) => ({
          seq,
          message_index: (sourceStart ?? 0) + seq - 1,
        })),
      ),
    );
    expect(firstRecapRequest?.tools).toEqual(provider.requests[2]?.tools);
    expect(JSON.stringify(completePrefix)).toContain(longCommand);
    expect(JSON.stringify(completePrefix)).toContain('\\"exit_code\\":7');
    expect(JSON.stringify(completePrefix)).toContain('\\"status\\":\\"cancelled\\"');
    expect(JSON.stringify(completePrefix)).toContain('\\"status\\":\\"unknown\\"');
    expect(JSON.stringify(completePrefix)).toContain('/server/nonzero.log');
    expect(JSON.stringify(completePrefix)).not.toContain(sent.runId);
    expect(JSON.stringify(store.listContext(ownerId, thread.threadId, 'thread'))).not.toContain(
      'Kairos internal Recap operation',
    );
    expect(JSON.stringify([assistant, ...toolResults]).length).toBeGreaterThan(12_800);
    expect(JSON.stringify(provider.requests[2]?.messages).length).toBeLessThanOrEqual(12_800);
    expect(provider.requests[2]?.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ content: longCommand })]),
    );
    expect(store.recaps.query({ threadId: thread.threadId, agentId: 'thread' })).toHaveLength(2);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('stops before business tool execution when assistant persistence fails', async () => {
  const command = 'touch /srv/one/executed';
  const provider = new ScriptedProvider([
    response('', [{ id: 'bash-call', name: 'bash', arguments: { command } }]),
    response('must not reach'),
  ]);
  const { database, store, coordinator, thread, directory, environmentOperations } = await fixture(
    provider,
    {},
    { environmentPolicy: testEnvironmentPolicyInput },
  );
  try {
    database.exec(`
      CREATE TRIGGER fail_assistant_event BEFORE INSERT ON thread_events
      WHEN NEW.payload_json LIKE '%"role":"assistant"%'
      BEGIN SELECT RAISE(FAIL, 'injected assistant storage failure'); END;
    `);
    const sent = send(store, thread.threadId, 'execute');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'failed');
    expect(
      environmentOperations.started.filter((operation) => operation.action.case === 'bash'),
    ).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('starts queued Threads when an active slot is released', async () => {
  const provider = new GatedProvider([response('first'), response('second'), response('third')]);
  const { database, store, coordinator, thread, directory } = await fixture(
    provider,
    {},
    { maxActiveThreads: 1 },
  );
  try {
    const secondThread = store.createThread(action('CreateThread', 'create-2', { title: '第二' }));
    const thirdThread = store.createThread(action('CreateThread', 'create-3', { title: '第三' }));
    const first = send(store, thread.threadId, 'first', 'send-1');
    const second = send(store, secondThread.threadId, 'second', 'send-2');
    const third = send(store, thirdThread.threadId, 'third', 'send-3');
    await coordinator.deliver(first.input, first.runId);
    await coordinator.deliver(second.input, second.runId);
    await coordinator.deliver(third.input, third.runId);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    expect(store.getRunById(second.runId).status).toBe('queued');
    expect(store.getRunById(third.runId).status).toBe('queued');
    provider.gates[0]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    provider.gates[1]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(3));
    provider.gates[2]?.resolve();
    await waitStatus(store, first.runId, 'completed');
    await waitStatus(store, second.runId, 'completed');
    await waitStatus(store, third.runId, 'completed');
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('overlaps two Subagents and persists parent tool results in call order', async () => {
  const provider = new GatedProvider([
    response('', [
      { id: 'child-1', name: 'subagent', arguments: { task: 'task one', mode: 'foreground' } },
      { id: 'child-2', name: 'subagent', arguments: { task: 'task two', mode: 'foreground' } },
    ]),
    response('child one answer'),
    response('child two answer'),
    response('parent answer'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = send(store, thread.threadId, 'parent task');
    await coordinator.deliver(sent.input, sent.runId);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    provider.gates[0]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(3));
    const children = store
      .listRuns(ownerId, thread.threadId)
      .filter((run) => run.parentRunId === sent.runId);
    expect(children).toHaveLength(2);
    const firstChild = children[0];
    const secondChild = children[1];
    if (!firstChild || !secondChild) throw new Error('Child Runs were not created.');

    provider.gates[2]?.resolve();
    await waitStatus(store, secondChild.runId, 'completed');
    expect(store.getRunById(firstChild.runId).status).toBe('running');
    expect(
      store
        .listContext(ownerId, thread.threadId, 'thread')
        .filter((message) => message.message.role === 'tool'),
    ).toEqual([]);

    provider.gates[1]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(4));
    const toolMessages = store
      .listContext(ownerId, thread.threadId, 'thread')
      .flatMap((message) =>
        message.message.role === 'tool'
          ? [{ callId: message.message.tool_call_id, content: message.message.content }]
          : [],
      );
    expect(toolMessages.map((message) => message.callId)).toEqual(['child-1', 'child-2']);
    expect(toolMessages.map((message) => JSON.parse(message.content).result)).toEqual([
      'child one answer',
      'child two answer',
    ]);
    expect(
      store.listContext(ownerId, thread.threadId, firstChild.agentId).map((m) => m.message.content),
    ).toEqual(['task one', 'child one answer']);
    expect(
      store
        .listContext(ownerId, thread.threadId, secondChild.agentId)
        .map((m) => m.message.content),
    ).toEqual(['task two', 'child two answer']);

    provider.gates[3]?.resolve();
    await waitStatus(store, sent.runId, 'completed');
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await cleanup(coordinator, database, directory);
  }
});

it('propagates parent cancellation to two active Subagents', async () => {
  const provider = new GatedProvider([
    response('', [
      { id: 'child-1', name: 'subagent', arguments: { task: 'task one', mode: 'foreground' } },
      { id: 'child-2', name: 'subagent', arguments: { task: 'task two', mode: 'foreground' } },
    ]),
    response('child one answer'),
    response('child two answer'),
    response('parent answer'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = send(store, thread.threadId, 'parent task');
    await coordinator.deliver(sent.input, sent.runId);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    provider.gates[0]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(3));
    const children = store
      .listRuns(ownerId, thread.threadId)
      .filter((run) => run.parentRunId === sent.runId);
    expect(children).toHaveLength(2);
    const accepted = store.requestCancelRun(
      action('CancelRun', 'cancel-1', {
        threadId: thread.threadId,
        runId: sent.runId,
        reason: 'stop parent',
      }),
    );
    await coordinator.cancel(accepted, 'stop parent');
    await waitStatus(store, sent.runId, 'cancelled');
    for (const child of children) await waitStatus(store, child.runId, 'cancelled');
    const toolMessages = store
      .listContext(ownerId, thread.threadId, 'thread')
      .flatMap((message) =>
        message.message.role === 'tool'
          ? [{ callId: message.message.tool_call_id, content: message.message.content }]
          : [],
      );
    expect(toolMessages.map((message) => message.callId)).toEqual(['child-1', 'child-2']);
    expect(toolMessages.map((message) => JSON.parse(message.content).status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await cleanup(coordinator, database, directory);
  }
});

it('stops later tool calls when a final tool result cannot be persisted', async () => {
  const firstCommand = 'printf x > /srv/one/first';
  const secondCommand = 'printf x > /srv/one/second';
  const provider = new ScriptedProvider([
    response('', [
      { id: 'first-call', name: 'bash', arguments: { command: firstCommand } },
      { id: 'second-call', name: 'bash', arguments: { command: secondCommand } },
    ]),
    response('must not reach'),
  ]);
  const { database, store, coordinator, thread, directory, environmentOperations } = await fixture(
    provider,
    {},
    { environmentPolicy: testEnvironmentPolicyInput },
  );
  try {
    database.exec(`
      CREATE TRIGGER fail_tool_result_event BEFORE INSERT ON thread_events
      WHEN NEW.payload_json LIKE '%"role":"tool"%'
      BEGIN SELECT RAISE(FAIL, 'injected tool result storage failure'); END;
    `);
    const sent = send(store, thread.threadId, 'execute');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'failed');
    expect(
      environmentOperations.started.flatMap((operation) =>
        operation.action.case === 'bash' ? [operation.action.value.command] : [],
      ),
    ).toEqual([firstCommand]);
    expect(provider.requests).toHaveLength(1);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('completes an unconfirmed crashed tool call as unknown without re-executing it', async () => {
  const provider = new ScriptedProvider([response('recovered')]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = crashToolRun(store, thread.threadId);
    const continued = store.continueRun(
      action('ContinueRun', 'continue-1', { threadId: thread.threadId, runId: sent.runId }),
    );
    coordinator.schedule(thread.threadId, continued.runId);
    await waitStatus(store, sent.runId, 'completed');
    const relation = store.context
      .listToolCallRelations(thread.threadId, 'thread')
      .find((candidate) => candidate.callId === 'call-1');
    expect(relation?.resultSeq).not.toBeNull();
    const result = store.context.get(thread.threadId, 'thread', relation?.resultSeq ?? 0);
    expect(result?.message.role).toBe('tool');
    if (result?.message.role === 'tool') {
      expect(JSON.parse(result.message.content)).toMatchObject({
        status: 'unknown',
        error: 'tool_result_unknown',
      });
    }
    expect(provider.requests).toHaveLength(1);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('uses an old Run Server Bash result when new input follows an interruption', async () => {
  const provider = new ScriptedProvider([response('recovered')]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = crashToolRun(store, thread.threadId);
    store.recordServerBashOperation({
      operationId: 'server-crash-operation',
      runId: sent.runId,
      toolCallId: 'call-1',
      logPath: null,
      outputComplete: true,
      endOffset: 0n,
      expiresAt: null,
      content: JSON.stringify({ status: 'completed', operation_id: 'server-crash-operation' }),
      status: 'success',
    });
    const next = send(store, thread.threadId, 'new input', 'send-2');
    await coordinator.deliver(next.input, next.runId);
    await waitStatus(store, next.runId, 'completed');
    const relation = store.context
      .listToolCallRelations(thread.threadId, 'thread')
      .find((candidate) => candidate.callId === 'call-1');
    const result = store.context.get(thread.threadId, 'thread', relation?.resultSeq ?? 0);
    expect(result?.message.role).toBe('tool');
    expect(result?.runId).toBe(sent.runId);
    if (result?.message.role === 'tool') {
      expect(JSON.parse(result.message.content)).toMatchObject({
        status: 'completed',
        operation_id: 'server-crash-operation',
      });
      expect(result.message.status).toBe('success');
    }
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('does not cancel a new main Run when the target main Run is already terminal', async () => {
  const provider = new GatedProvider([response('old'), response('new')]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const old = send(store, thread.threadId, 'old');
    await coordinator.deliver(old.input, old.runId);
    provider.gates[0]?.resolve();
    await waitStatus(store, old.runId, 'completed');
    const current = send(store, thread.threadId, 'new', 'send-2');
    await coordinator.deliver(current.input, current.runId);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    const accepted = store.requestCancelRun(
      action('CancelRun', 'cancel-old', {
        threadId: thread.threadId,
        runId: old.runId,
        reason: 'old cancel',
      }),
    );
    expect(accepted.status).toBe('completed');
    await coordinator.cancel(accepted, 'old cancel');
    expect(store.getRunById(current.runId).status).not.toBe('cancelled');
    provider.gates[1]?.resolve();
    await waitStatus(store, current.runId, 'completed');
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('cancels only the targeted active Subagent and lets its parent finish', async () => {
  const provider = new GatedProvider([
    response('', [
      { id: 'child-call', name: 'subagent', arguments: { task: 'child task', mode: 'foreground' } },
    ]),
    response('child answer'),
    response('parent answer'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const parent = send(store, thread.threadId, 'parent task');
    await coordinator.deliver(parent.input, parent.runId);
    provider.gates[0]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    const child = store
      .listRuns(ownerId, thread.threadId)
      .find((run) => run.parentRunId === parent.runId);
    if (!child) throw new Error('Child Run was not created.');
    const accepted = store.requestCancelRun(
      action('CancelRun', 'cancel-child', {
        threadId: thread.threadId,
        runId: child.runId,
        reason: 'stop child',
      }),
    );
    await coordinator.cancel(accepted, 'stop child');
    await waitStatus(store, child.runId, 'cancelled');
    expect(store.getRunById(parent.runId).status).not.toBe('cancel_requested');
    provider.gates[1]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(3));
    provider.gates[2]?.resolve();
    await waitStatus(store, parent.runId, 'completed');
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await cleanup(coordinator, database, directory);
  }
});

it('does not cancel a parent when the target Subagent is already terminal', async () => {
  const provider = new GatedProvider([
    response('', [
      { id: 'child-call', name: 'subagent', arguments: { task: 'child task', mode: 'foreground' } },
    ]),
    response('child answer'),
    response('parent answer'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const parent = send(store, thread.threadId, 'parent task');
    await coordinator.deliver(parent.input, parent.runId);
    provider.gates[0]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    const child = store
      .listRuns(ownerId, thread.threadId)
      .find((run) => run.parentRunId === parent.runId);
    if (!child) throw new Error('Child Run was not created.');
    provider.gates[1]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(3));
    await waitStatus(store, child.runId, 'completed');
    const accepted = store.requestCancelRun(
      action('CancelRun', 'cancel-terminal-child', {
        threadId: thread.threadId,
        runId: child.runId,
        reason: 'late child cancel',
      }),
    );
    expect(accepted.status).toBe('completed');
    await coordinator.cancel(accepted, 'late child cancel');
    expect(store.getRunById(parent.runId).status).not.toBe('cancel_requested');
    provider.gates[2]?.resolve();
    await waitStatus(store, parent.runId, 'completed');
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await cleanup(coordinator, database, directory);
  }
});

it('persists each response usage with its assistant message', async () => {
  const blocks = [
    { type: 'thinking' as const, block_index: 0, text: 'reasoning' },
    { type: 'text' as const, block_index: 1, text: 'use tool' },
  ];
  const provider = new ScriptedProvider([
    [
      { type: 'thinking_delta', text: 'reasoning', block_index: 0 },
      { type: 'text_delta', text: 'use tool', block_index: 1 },
      {
        type: 'response',
        message: {
          role: 'assistant',
          content: 'use tool',
          content_blocks: blocks,
          tool_calls: [{ id: 'call-1', name: 'missing', arguments: {} }],
        },
        usage,
      },
    ],
    response('done'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = send(store, thread.threadId, 'usage');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'completed');

    const assistants = store
      .listContext(ownerId, thread.threadId, 'thread')
      .filter((record) => record.message.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants.map((record) => record.responseUsage)).toEqual([usage, usage]);
    expect(assistants[0]?.message.content).toBe('use tool');
    expect(assistants[0]?.message.content).not.toContain('reasoning');
    expect(
      database
        .prepare(
          'SELECT response_usage_json FROM context_messages WHERE message_id = ? AND role = ?',
        )
        .get(assistants[0]?.messageId ?? '', 'assistant'),
    ).toEqual({ response_usage_json: JSON.stringify(usage) });
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('rolls back the assistant message when response usage cannot be persisted', async () => {
  const provider = new ScriptedProvider([response('must roll back')]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    database.exec(`
      CREATE TRIGGER reject_response_usage BEFORE INSERT ON context_messages
      WHEN NEW.response_usage_json IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'injected response usage failure'); END;
    `);
    const sent = send(store, thread.threadId, 'usage failure');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'failed');

    expect(
      store
        .listContext(ownerId, thread.threadId, 'thread')
        .filter((record) => record.message.role === 'assistant'),
    ).toEqual([]);
    expect(
      store
        .listEvents(thread.threadId, 0n)
        .some(
          (event) =>
            event.payload.case === 'messageCommitted' &&
            event.payload.value.message.message.role === 'assistant',
        ),
    ).toBe(false);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('adds Continue usage to the existing Run total', async () => {
  let attempts = 0;
  const provider: ModelProvider = {
    async *stream() {
      attempts += 1;
      if (attempts === 1) {
        yield {
          type: 'response',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'unknown-tool', name: 'missing', arguments: {} }],
          },
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        };
        return;
      }
      if (attempts === 2) throw new Error('stream failed');
      yield {
        type: 'response',
        message: { role: 'assistant', content: 'recovered' },
        usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 },
      };
    },
  };
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = send(store, thread.threadId, 'usage');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'failed');
    expect(store.getRunById(sent.runId).usage).toEqual({ inputTokens: 5, outputTokens: 3 });
    const continued = store.continueRun(
      action('ContinueRun', 'continue-1', { threadId: thread.threadId, runId: sent.runId }),
    );
    coordinator.schedule(thread.threadId, continued.runId);
    await waitStatus(store, sent.runId, 'completed');
    expect(store.getRunById(sent.runId).usage).toEqual({ inputTokens: 12, outputTokens: 7 });
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('maps a wrapped request conflict through the cause chain', async () => {
  let attempts = 0;
  const provider: ModelProvider = {
    async *stream() {
      attempts += 1;
      if (attempts === 1) throw new Error('stream failed');
      yield* response('unexpected');
    },
  };
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  await coordinator.close();
  const model: RuntimeModelConfiguration = {
    provider,
    providerId: 'test',
    modelId: 'test-model',
    contextWindowTokens: 128000,
    outputReserveTokens: 4096,
  };
  const recovering = new RunCoordinator({
    ...controlledEnvironmentDependencies(store.database, ownerId),
    store,
    model,
  });
  try {
    const sent = send(store, thread.threadId, 'conflict');
    await recovering.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'failed');
    model.contextWindowTokens = 64000;
    const continued = store.continueRun(
      action('ContinueRun', 'continue-1', { threadId: thread.threadId, runId: sent.runId }),
    );
    recovering.schedule(thread.threadId, continued.runId);
    await waitStatus(store, sent.runId, 'failed');
    expect(store.getRunById(sent.runId).error?.code).toBe('action_conflict');
    expect(attempts).toBe(1);
  } finally {
    await cleanup(recovering, database, directory);
  }
});

it('keeps wrapped model-input storage failures retryable', async () => {
  const provider = new ScriptedProvider([response('must not reach')]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    database.exec(`
      CREATE TRIGGER fail_model_request BEFORE INSERT ON model_request_records
      BEGIN SELECT RAISE(FAIL, 'injected request storage failure'); END;
    `);
    const sent = send(store, thread.threadId, 'storage failure');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'failed');
    expect(store.getRunById(sent.runId).error).toMatchObject({
      code: 'internal',
      retryable: true,
    });
    expect(provider.requests).toHaveLength(0);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('registers web tools on a main Thread without changing its existing delegation tools', async () => {
  const provider = new ScriptedProvider([response('main done')]);
  const { database, store, coordinator, directory } = await fixture(provider);
  try {
    const main = store.getOrCreateMainThread(ownerId);
    const sent = send(store, main.threadId, 'main task');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'completed');
    const tools = provider.requests[0]?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'bash',
        'read',
        'edit',
        'write',
        'recall',
        'thread_list',
        'thread_call',
        'subagent',
        'web_fetch',
        'web_search',
      ]),
    );
    expect(names.filter((name) => name === 'web_fetch' || name === 'web_search')).toEqual([
      'web_fetch',
      'web_search',
    ]);
  } finally {
    await cleanup(coordinator, database, directory);
  }
});

it('registers identical web tools on a task Thread and its Subagent', async () => {
  const provider = new ScriptedProvider([
    response('', [
      { id: 'child-web', name: 'subagent', arguments: { task: 'child task', mode: 'foreground' } },
    ]),
    response('', [
      { id: 'search-in-child', name: 'web_search', arguments: { query: 'child query' } },
    ]),
    response('child done'),
    response('parent done'),
  ]);
  const { database, store, coordinator, thread, directory } = await fixture(provider);
  try {
    const sent = send(store, thread.threadId, 'parent task');
    await coordinator.deliver(sent.input, sent.runId);
    await waitStatus(store, sent.runId, 'completed');
    expect(provider.requests).toHaveLength(4);
    const webDefinitions = (request: ModelRequest | undefined) =>
      (request?.tools ?? []).filter(
        (tool) => tool.name === 'web_fetch' || tool.name === 'web_search',
      );
    expect(webDefinitions(provider.requests[0])).toHaveLength(2);
    expect(webDefinitions(provider.requests[1])).toEqual(webDefinitions(provider.requests[0]));
    expect(provider.requests[0]?.tools.some((tool) => tool.name === 'thread_call')).toBe(false);
    const child = store.listRuns(ownerId, thread.threadId).find((run) => run.parentRunId !== null);
    expect(child).toBeDefined();
    if (child) {
      const searchResult = store
        .listContext(ownerId, thread.threadId, child.agentId)
        .find(
          (record) => record.message.role === 'tool' && record.message.tool_name === 'web_search',
        );
      expect(searchResult?.message.role).toBe('tool');
      if (searchResult?.message.role === 'tool') {
        expect(searchResult.message.status).toBe('error');
        expect(JSON.parse(searchResult.message.content).error).toMatchObject({
          code: 'search_not_configured',
        });
      }
    }
  } finally {
    await cleanup(coordinator, database, directory);
  }
});
