import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionExecutor } from './action-executor.js';
import type { ActionHandlers } from './action-handlers.js';
import { ClientActionStore } from './actions.js';

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
