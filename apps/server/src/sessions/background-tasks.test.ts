import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelEvent, ModelProvider, ModelRequest, ToolCall } from '@kairos/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripMessageMeta } from '../context/model-input.js';
import { controlledEnvironmentDependencies } from '../integration/environment-fixture.js';
import { openDatabase } from '../storage/database.js';
import { RunCoordinator } from './runtime.js';
import { SessionStore } from './store.js';

const ownerId = 'owner-background-tasks';

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

function response(content: string, toolCalls?: ToolCall[]): ModelEvent[] {
  return [
    { type: 'text_delta', text: content },
    {
      type: 'response',
      message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      usage,
    },
  ];
}

function requestKey(request: ModelRequest): string {
  const last = request.messages.at(-1);
  const content = last === undefined ? undefined : stripMessageMeta(last.content);
  if (last?.role === 'tool') return `tool:${last.tool_call_id}`;
  if (last?.role === 'user' && content !== undefined) {
    if (content.includes('"kind":"bash"') && content.includes('task_id')) {
      return 'delivery:bash';
    }
    return `user:${content}`;
  }
  return last?.role ?? 'empty';
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
    for (const event of events) yield event;
  }
}

async function waitRequest(provider: ControlledProvider, key: string): Promise<void> {
  await vi.waitFor(() => {
    expect(provider.requests.some((request) => request.key === key)).toBe(true);
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(provider: ModelProvider) {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-background-tasks-'));
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  const dependencies = controlledEnvironmentDependencies(database, ownerId);
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
  const main = store.getOrCreateMainThread(ownerId);
  cleanups.push(async () => {
    await coordinator.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    database,
    store,
    coordinator,
    main,
    directory,
    operations: dependencies.environmentOperations,
  };
}

function send(store: SessionStore, threadId: string, text: string, id: string) {
  return store.sendMessage({
    ownerId,
    clientActionId: id,
    method: 'SendMessage',
    parameters: { threadId, text, mode: 'follow_up' },
    threadId,
    text,
    mode: 'follow_up',
  });
}

async function waitStatus(store: SessionStore, runId: string, status: string): Promise<void> {
  await vi.waitFor(() => {
    expect(store.getRunById(runId).status).toBe(status);
  });
}

function toolContent(store: SessionStore, threadId: string, callId: string): string {
  const record = store
    .listContext(ownerId, threadId, 'thread')
    .find((message) => message.message.role === 'tool' && message.message.tool_call_id === callId);
  if (!record || record.message.role !== 'tool') throw new Error(`Tool message ${callId} missing.`);
  return record.message.content;
}

describe('background bash tasks', () => {
  it('registers task tools and runs a background bash with automatic delivery', async () => {
    const provider = new ControlledProvider();
    provider.register(
      'user:start background work',
      response('', [
        {
          id: 'bg-bash',
          name: 'bash',
          arguments: {
            command: 'sleep 60',
            run_in_background: true,
            description: 'long sleep',
          },
        },
      ]),
    );
    provider.register('tool:bg-bash', response('background started'));
    provider.register('delivery:bash', response('delivery received'));
    provider.resolve('delivery:bash');
    const { store, coordinator, main, operations } = await fixture(provider);
    (operations as { bashDelayMs: number }).bashDelayMs = 300;

    const first = send(store, main.threadId, 'start background work', 'send-bg-1');
    await coordinator.deliver(first.input, first.runId);
    await waitRequest(provider, 'user:start background work');
    provider.resolve('user:start background work');
    await waitRequest(provider, 'tool:bg-bash');
    provider.resolve('tool:bg-bash');
    await waitStatus(store, first.runId, 'completed');

    const accepted = JSON.parse(toolContent(store, main.threadId, 'bg-bash')) as {
      task_id: string;
      status: string;
    };
    expect(accepted.status).toBe('accepted');
    expect(accepted.task_id.length).toBeGreaterThan(0);

    await vi.waitFor(() => {
      const task = store.getBackgroundTask(ownerId, accepted.task_id);
      expect(task.status).toBe('completed');
    });
    const delivered = await vi.waitFor(() => {
      const task = store.getBackgroundTask(ownerId, accepted.task_id);
      expect(task.deliveryStatus).toBe('consumed');
      return task;
    });
    expect(delivered.contextMessageSeq).not.toBeNull();
    expect(provider.requests.some((request) => request.key === 'delivery:bash')).toBe(true);

    const task = store.getBackgroundTask(ownerId, accepted.task_id);
    expect(task.kind).toBe('bash');
    expect(task.description).toBe('long sleep');
    expect(task.resultText).toContain('"exit_code":0');
  });

  it('task_list and task_output report bash tasks and task_stop cancels them', async () => {
    const provider = new ControlledProvider();
    provider.register(
      'user:begin',
      response('', [
        {
          id: 'bg-slow',
          name: 'bash',
          arguments: {
            command: 'sleep 600',
            run_in_background: true,
            description: 'very long sleep',
          },
        },
      ]),
    );
    provider.register(
      'tool:bg-slow',
      response('', [{ id: 'list-1', name: 'task_list', arguments: {} }]),
    );
    const { store, coordinator, main, operations } = await fixture(provider);
    (operations as { bashDelayMs: number }).bashDelayMs = 60_000;

    const first = send(store, main.threadId, 'begin', 'send-stop-1');
    await coordinator.deliver(first.input, first.runId);
    await waitRequest(provider, 'user:begin');
    provider.resolve('user:begin');
    await waitRequest(provider, 'tool:bg-slow');
    const accepted = JSON.parse(toolContent(store, main.threadId, 'bg-slow')) as {
      task_id: string;
    };
    provider.register(
      'tool:list-1',
      response('', [{ id: 'stop-1', name: 'task_stop', arguments: { task_id: accepted.task_id } }]),
    );
    provider.register('tool:stop-1', response('stopped'));
    provider.register('delivery:bash', response('delivery received'));
    provider.resolve('delivery:bash');
    provider.resolve('tool:bg-slow');
    await waitRequest(provider, 'tool:list-1');
    provider.resolve('tool:list-1');
    await waitRequest(provider, 'tool:stop-1');
    provider.resolve('tool:stop-1');
    await waitStatus(store, first.runId, 'completed');

    const listResult = JSON.parse(toolContent(store, main.threadId, 'list-1')) as {
      tasks: Array<{ task_id: string; kind: string; status: string; description: string }>;
    };
    expect(listResult.tasks).toEqual([
      expect.objectContaining({
        task_id: accepted.task_id,
        kind: 'bash',
        description: 'very long sleep',
      }),
    ]);
    const stopResult = JSON.parse(toolContent(store, main.threadId, 'stop-1')) as {
      status: string;
    };
    expect(stopResult.status).toBe('killed');
    const task = store.getBackgroundTask(ownerId, accepted.task_id);
    expect(task.status).toBe('killed');
    expect((operations as { cancelled: string[] }).cancelled.length).toBeGreaterThan(0);
  });

  it('marks running background tasks unknown after a Server restart', async () => {
    const provider = new ControlledProvider();
    provider.register(
      'user:begin',
      response('', [
        {
          id: 'bg-restart',
          name: 'bash',
          arguments: {
            command: 'sleep 600',
            run_in_background: true,
            description: 'interrupted sleep',
          },
        },
      ]),
    );
    provider.register('tool:bg-restart', response('accepted'));
    provider.register('delivery:bash', response('late delivery'));
    provider.resolve('delivery:bash');
    const { store, coordinator, main, operations } = await fixture(provider);
    (operations as { bashDelayMs: number }).bashDelayMs = 200;

    const first = send(store, main.threadId, 'begin', 'send-restart-1');
    await coordinator.deliver(first.input, first.runId);
    await waitRequest(provider, 'user:begin');
    provider.resolve('user:begin');
    await waitRequest(provider, 'tool:bg-restart');
    provider.resolve('tool:bg-restart');
    await waitStatus(store, first.runId, 'completed');
    const accepted = JSON.parse(toolContent(store, main.threadId, 'bg-restart')) as {
      task_id: string;
    };
    expect(store.getBackgroundTask(ownerId, accepted.task_id).status).toBe('running');

    coordinator.recoverBackgroundTasks();
    const task = store.getBackgroundTask(ownerId, accepted.task_id);
    expect(task.status).toBe('unknown');
    expect(task.resultText).toContain('restarted');
  });
});
