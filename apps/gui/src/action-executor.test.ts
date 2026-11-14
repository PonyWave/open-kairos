/// <reference lib="dom" />

import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import {
  type EditInputRequest,
  ErrorCode,
  ErrorDetailSchema,
  InputMode,
  MessageService,
  QueueService,
  type RerunRequest,
  RunService,
  RunStatus,
  type SendMessageRequest,
} from '@kairos/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from './action-executor.js';
import { type ActionHandlers, createActionHandlers } from './action-handlers.js';
import { ClientActionStore, type StorageLike } from './actions.js';
import { createKairosClients } from './client.js';

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('storage full');
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

interface SendResult {
  clientActionId: string;
  inputId: string;
  threadId: string;
}

interface EditInputResult {
  clientActionId: string;
  inputId: string;
  version: bigint;
}

interface RerunResult {
  clientActionId: string;
  runId: string;
  status: RunStatus;
}

function createHarness(behavior: {
  send?: (request: SendMessageRequest) => Promise<SendResult>;
  edit?: (request: EditInputRequest) => Promise<EditInputResult>;
  rerun?: (request: RerunRequest) => Promise<RerunResult>;
}) {
  const sendRequests: SendMessageRequest[] = [];
  const editRequests: EditInputRequest[] = [];
  const rerunRequests: RerunRequest[] = [];
  const transport = createRouterTransport((router) => {
    router.service(MessageService, {
      sendMessage: async (request) => {
        sendRequests.push(request);
        if (behavior.send) return behavior.send(request);
        return {
          clientActionId: request.clientActionId,
          inputId: 'input-1',
          threadId: request.threadId,
        };
      },
    });
    router.service(QueueService, {
      editInput: async (request) => {
        editRequests.push(request);
        if (behavior.edit) return behavior.edit(request);
        return {
          clientActionId: request.clientActionId,
          inputId: request.inputId,
          version: request.expectedVersion + 1n,
        };
      },
    });
    router.service(RunService, {
      rerun: async (request) => {
        rerunRequests.push(request);
        if (behavior.rerun) return behavior.rerun(request);
        return {
          clientActionId: request.clientActionId,
          runId: 'run-1',
          status: RunStatus.QUEUED,
        };
      },
    });
  });
  return {
    handlers: createActionHandlers(createKairosClients({ transport })),
    sendRequests,
    editRequests,
    rerunRequests,
  };
}

describe('ActionExecutor with generated Connect clients', () => {
  it('allows the same action key after synchronous parameter validation rejects the first attempt', async () => {
    const harness = createHarness({});
    const store = new ClientActionStore();
    const executor = new ActionExecutor(store, harness.handlers);
    const key = 'send-message:thread-1:draft-1';

    await executor.execute(key, 'sendMessage', {
      threadId: 'thread-1',
      mode: InputMode.FOLLOW_UP,
    });
    expect(harness.sendRequests).toHaveLength(0);
    expect(store.pending()).toHaveLength(0);
    expect(executor.state.busy).toBe(false);

    const accepted = await executor.execute(key, 'sendMessage', {
      threadId: 'thread-1',
      text: '修正后的参数',
      mode: InputMode.FOLLOW_UP,
    });
    expect(accepted).toMatchObject({ threadId: 'thread-1', inputId: 'input-1' });
    expect(harness.sendRequests).toHaveLength(1);
    expect(executor.state.failures).toEqual([]);
    expect(store.pending()).toHaveLength(0);
  });

  it('deduplicates repeated clicks for one logical Rerun operation', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({
      rerun: async (request) => {
        await gate;
        return { clientActionId: request.clientActionId, runId: 'run-1', status: RunStatus.QUEUED };
      },
    });
    const executor = new ActionExecutor(new ClientActionStore(), harness.handlers);
    const payload = { threadId: 'thread-1', messageId: 'message-1' };
    const first = executor.execute('rerun:message-1', 'rerun', payload);
    const duplicate = executor.execute('rerun:message-1', 'rerun', payload);
    release?.();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(firstResult).toEqual(duplicateResult);
    expect(harness.rerunRequests).toHaveLength(1);
  });

  it('clears a definite rejection and accepts new parameters with a new id', async () => {
    let reject = true;
    const harness = createHarness({
      send: async (request) => {
        if (reject) throw new ConnectError('invalid input', Code.InvalidArgument);
        return {
          clientActionId: request.clientActionId,
          inputId: 'input-1',
          threadId: request.threadId,
        };
      },
    });
    const store = new ClientActionStore();
    const executor = new ActionExecutor(store, harness.handlers);
    const key = 'send-message:thread-1:draft-1';
    await executor.execute(key, 'sendMessage', {
      threadId: 'thread-1',
      text: '旧参数',
      mode: InputMode.STEER,
    });
    const rejectedId = harness.sendRequests[0]?.clientActionId;
    expect(executor.state.failures[0]?.outcome).toBe('not-executed');
    expect(store.pending()).toHaveLength(0);

    reject = false;
    await executor.execute(key, 'sendMessage', {
      threadId: 'thread-1',
      text: '新参数',
      mode: InputMode.FOLLOW_UP,
    });
    expect(harness.sendRequests).toHaveLength(2);
    expect(harness.sendRequests[1]?.clientActionId).not.toBe(rejectedId);
    expect(harness.sendRequests[1]?.text).toBe('新参数');
    expect(executor.state.failures).toHaveLength(0);
  });

  it('recovers a queue edit with a refreshed version and new id after reload', async () => {
    let currentVersion = 2n;
    const harness = createHarness({
      edit: async (request) => {
        if (request.expectedVersion !== currentVersion) {
          throw new ConnectError('queue version conflict', Code.Aborted, undefined, [
            {
              desc: ErrorDetailSchema,
              value: {
                code: ErrorCode.VERSION_CONFLICT,
                message: '请重新加载队列',
                retryable: false,
              },
            },
          ]);
        }
        currentVersion += 1n;
        return {
          clientActionId: request.clientActionId,
          inputId: request.inputId,
          version: currentVersion,
        };
      },
    });
    const storage = new MemoryStorage();
    const key = 'edit-input:input-1';
    const executor = new ActionExecutor(new ClientActionStore(storage), harness.handlers);
    await executor.execute(key, 'editInput', {
      threadId: 'thread-1',
      inputId: 'input-1',
      text: '旧版本修改',
      expectedVersion: '1',
    });
    const rejectedId = harness.editRequests[0]?.clientActionId;
    expect(executor.state.failures[0]?.outcome).toBe('not-executed');
    executor.dismiss(key);

    const restoredStore = new ClientActionStore(storage);
    expect(restoredStore.pending()).toHaveLength(0);
    const restored = new ActionExecutor(restoredStore, harness.handlers);
    const result = await restored.execute<EditInputResult>(key, 'editInput', {
      threadId: 'thread-1',
      inputId: 'input-1',
      text: '新版本修改',
      expectedVersion: currentVersion.toString(),
    });
    expect(result?.version).toBe(3n);
    expect(harness.editRequests.map((request) => request.expectedVersion)).toEqual([1n, 2n]);
    expect(harness.editRequests[1]?.text).toBe('新版本修改');
    expect(harness.editRequests[1]?.clientActionId).not.toBe(rejectedId);
    expect(restoredStore.pending()).toHaveLength(0);
    expect(restored.state.failures).toHaveLength(0);
  });

  it('retains the original id and payload after response loss, mode changes, and reload', async () => {
    const storage = new MemoryStorage();
    const accepted = new Map<string, SendResult>();
    const harness = createHarness({
      send: async (request) => {
        const existing = accepted.get(request.clientActionId);
        if (existing) return existing;
        const result = {
          clientActionId: request.clientActionId,
          inputId: 'input-1',
          threadId: request.threadId,
        };
        accepted.set(request.clientActionId, result);
        throw new ConnectError('response lost', Code.Unavailable);
      },
    });
    const key = 'send-message:thread-1:draft-1';
    const original = { threadId: 'thread-1', text: '执行', mode: InputMode.STEER };
    const executor = new ActionExecutor(new ClientActionStore(storage), harness.handlers);
    expect(await executor.execute(key, 'sendMessage', original)).toBeUndefined();
    expect(harness.sendRequests).toHaveLength(1);
    const originalId = harness.sendRequests[0]?.clientActionId;
    expect(originalId).toBeTruthy();
    expect(executor.state.failures[0]?.outcome).toBe('unknown');

    executor.dismiss(key);
    expect(executor.state.failures).toHaveLength(0);
    expect(
      await executor.execute(key, 'sendMessage', { ...original, mode: InputMode.FOLLOW_UP }),
    ).toBeUndefined();
    expect(harness.sendRequests).toHaveLength(1);
    expect(executor.state.failures[0]?.message).toContain('已绑定不同参数');
    expect(executor.state.failures[0]?.outcome).toBe('unknown');

    const restored = new ActionExecutor(new ClientActionStore(storage), harness.handlers);
    expect(restored.state.failures).toHaveLength(1);
    expect(restored.state.failures[0]?.outcome).toBe('unknown');
    expect(restored.state.failures[0]?.restored).toBe(true);
    await restored.retry(key);
    expect(harness.sendRequests).toHaveLength(2);
    expect(harness.sendRequests[1]?.clientActionId).toBe(originalId);
    expect(harness.sendRequests[1]?.mode).toBe(InputMode.STEER);
    expect(accepted).toHaveLength(1);
    expect(restored.state.failures).toHaveLength(0);
  });

  it('retains the original id when local completion fails after Server acceptance', async () => {
    const harness = createHarness({});
    const store = new ClientActionStore();
    let failCompletion = true;
    const executor = new ActionExecutor(store, harness.handlers, () => {
      if (failCompletion) throw new Error('local completion failed');
    });
    const key = 'send-message:thread-1:draft-1';
    const payload = { threadId: 'thread-1', text: '执行', mode: InputMode.STEER };
    await executor.execute(key, 'sendMessage', payload);
    expect(executor.state.failures[0]?.outcome).toBe('unknown');
    expect(store.pending()).toHaveLength(1);

    failCompletion = false;
    await executor.retry(key);
    expect(harness.sendRequests).toHaveLength(2);
    expect(harness.sendRequests[0]?.clientActionId).toBe(harness.sendRequests[1]?.clientActionId);
    expect(store.pending()).toHaveLength(0);
    expect(executor.state.failures).toHaveLength(0);
  });

  it('does not send an operation when initial persistence fails', async () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const harness = createHarness({});
    const store = new ClientActionStore(storage);
    const executor = new ActionExecutor(store, harness.handlers);
    const key = 'send-message:thread-1:draft-1';
    const payload = { threadId: 'thread-1', text: '执行', mode: InputMode.STEER };

    await executor.execute(key, 'sendMessage', payload);
    expect(harness.sendRequests).toHaveLength(0);
    expect(store.pending()).toEqual([]);
    expect(new ClientActionStore(storage).pending()).toEqual([]);

    storage.failWrites = false;
    await executor.execute(key, 'sendMessage', payload);
    expect(harness.sendRequests).toHaveLength(1);
    expect(store.pending()).toEqual([]);
    expect(executor.state.failures).toEqual([]);
  });

  it('retains the original id when success cleanup cannot be persisted', async () => {
    const storage = new MemoryStorage();
    let requestCount = 0;
    const harness = createHarness({
      send: async (request) => {
        if (requestCount++ === 0) storage.failWrites = true;
        return {
          clientActionId: request.clientActionId,
          inputId: 'input-1',
          threadId: request.threadId,
        };
      },
    });
    const store = new ClientActionStore(storage);
    const executor = new ActionExecutor(store, harness.handlers);
    const key = 'send-message:thread-1:draft-1';
    const payload = { threadId: 'thread-1', text: '执行', mode: InputMode.STEER };

    await executor.execute(key, 'sendMessage', payload);
    const pending = store.get(key);
    expect(pending).toBeDefined();
    expect(new ClientActionStore(storage).get(key)).toEqual(pending);
    expect(executor.state.failures[0]?.outcome).toBe('unknown');

    storage.failWrites = false;
    await executor.retry(key);
    expect(harness.sendRequests).toHaveLength(2);
    expect(harness.sendRequests[1]?.clientActionId).toBe(pending?.id);
    expect(harness.sendRequests[1]?.clientActionId).toBe(harness.sendRequests[0]?.clientActionId);
    expect(store.pending()).toEqual([]);
    expect(new ClientActionStore(storage).pending()).toEqual([]);
  });

  it('keeps independent failures and retry state during concurrent operations', async () => {
    const attempted = new Set<string>();
    const harness = createHarness({
      rerun: async (request) => {
        if (!attempted.has(request.messageId)) {
          attempted.add(request.messageId);
          throw new ConnectError('response lost', Code.Unavailable);
        }
        return {
          clientActionId: request.clientActionId,
          runId: `run-${request.messageId}`,
          status: RunStatus.QUEUED,
        };
      },
    });
    const executor = new ActionExecutor(new ClientActionStore(), harness.handlers);
    await Promise.all([
      executor.execute('rerun:message-1', 'rerun', {
        threadId: 'thread-1',
        messageId: 'message-1',
      }),
      executor.execute('rerun:message-2', 'rerun', {
        threadId: 'thread-1',
        messageId: 'message-2',
      }),
    ]);
    expect(executor.state.failures.map((failure) => failure.key).sort()).toEqual([
      'rerun:message-1',
      'rerun:message-2',
    ]);

    await executor.retry('rerun:message-1');
    expect(executor.state.failures.map((failure) => failure.key)).toEqual(['rerun:message-2']);
    await executor.retry('rerun:message-2');
    expect(executor.state.failures).toHaveLength(0);
    const firstIds = harness.rerunRequests
      .filter((request) => request.messageId === 'message-1')
      .map((request) => request.clientActionId);
    expect(firstIds).toHaveLength(2);
    expect(firstIds[0]).toBe(firstIds[1]);
  });
});

describe('ActionExecutor auto-retry reconciliation', () => {
  function handlersWith(
    handler: (payload: unknown, clientActionId: string) => Promise<unknown>,
  ): ActionHandlers {
    return {
      createThread: handler,
      renameThread: handler,
      sendMessage: handler,
      deleteAttachment: handler,
      reviseMessage: handler,
      editInput: handler,
      removeInput: handler,
      reorderInputs: handler,
      cancelRun: handler,
      continueRun: handler,
      rerun: handler,
      reloadResources: handler,
      compactContext: handler,
      startNewMain: handler,
      createAutomation: handler,
      updateAutomation: handler,
      deleteAutomation: handler,
      runAutomationNow: handler,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-retries an unknown failure with the same client action id and completes', async () => {
    vi.useFakeTimers();
    const store = new ClientActionStore();
    const calls: string[] = [];
    const completed: unknown[] = [];
    let attempts = 0;
    const executor = new ActionExecutor(
      store,
      handlersWith(async (_payload, clientActionId) => {
        calls.push(clientActionId);
        attempts += 1;
        if (attempts === 1) throw new ConnectError('response lost', Code.Unavailable);
        return { ok: true };
      }),
      (_record, result) => {
        completed.push(result);
      },
      { autoRetryDelaysMs: [2_000, 10_000] },
    );
    await executor.execute('send:1', 'sendMessage', { text: 'hello' });
    expect(executor.state.failures).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(calls[1]);
    expect(completed).toEqual([{ ok: true }]);
    expect(executor.state.failures).toHaveLength(0);
    expect(store.pending()).toHaveLength(0);
  });

  it('keeps the failure after the auto-retry budget is exhausted', async () => {
    vi.useFakeTimers();
    const store = new ClientActionStore();
    let attempts = 0;
    const executor = new ActionExecutor(
      store,
      handlersWith(async () => {
        attempts += 1;
        throw new ConnectError('response lost', Code.Unavailable);
      }),
      () => undefined,
      { autoRetryDelaysMs: [2_000, 10_000] },
    );
    await executor.execute('send:1', 'sendMessage', {});
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(3);
    expect(executor.state.failures).toHaveLength(1);
    expect(store.pending()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(3);
  });

  it('stops auto-retrying when the retry returns a definitive failure', async () => {
    vi.useFakeTimers();
    const store = new ClientActionStore();
    let attempts = 0;
    const executor = new ActionExecutor(
      store,
      handlersWith(async () => {
        attempts += 1;
        if (attempts === 1) throw new ConnectError('response lost', Code.Unavailable);
        throw new ConnectError('bad request', Code.InvalidArgument);
      }),
      () => undefined,
      { autoRetryDelaysMs: [2_000, 10_000] },
    );
    await executor.execute('send:1', 'sendMessage', {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts).toBe(2);
    expect(store.pending()).toHaveLength(0);
    expect(executor.state.failures).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(2);
  });

  it('does not auto-retry without configured delays', async () => {
    vi.useFakeTimers();
    const store = new ClientActionStore();
    let attempts = 0;
    const executor = new ActionExecutor(
      store,
      handlersWith(async () => {
        attempts += 1;
        throw new ConnectError('response lost', Code.Unavailable);
      }),
    );
    await executor.execute('send:1', 'sendMessage', {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(1);
    expect(store.pending()).toHaveLength(1);
  });

  it('manual retry resets the auto-retry budget', async () => {
    vi.useFakeTimers();
    const store = new ClientActionStore();
    let attempts = 0;
    const executor = new ActionExecutor(
      store,
      handlersWith(async () => {
        attempts += 1;
        throw new ConnectError('response lost', Code.Unavailable);
      }),
      () => undefined,
      { autoRetryDelaysMs: [2_000, 10_000] },
    );
    await executor.execute('send:1', 'sendMessage', {});
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(3);
    await executor.retry('send:1');
    expect(attempts).toBe(4);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts).toBe(5);
  });
});
