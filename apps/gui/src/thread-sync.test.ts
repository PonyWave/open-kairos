import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import {
  BashOperationStatus,
  ContextHardCutCompletedSchema,
  ErrorCode,
  EventService,
  InputMode,
  InputStatus,
  MessageRole,
  MessageService,
  RunService,
  RunStatus,
  ThreadService,
  ToolResultStatus,
  type WatchThreadResponse,
  WatchThreadResponseSchema,
} from '@kairos/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createKairosClients } from './client.js';
import { EventGapError, ThreadProjector, UnsupportedEventError } from './thread-projection.js';
import { ThreadSynchronizer, type ThreadSyncState } from './thread-sync.js';

const baseSeq = 9_007_199_254_740_993n;
const thread = { threadId: 'thread-1', title: '恢复测试', seq: baseSeq };

function snapshot(throughSeq: bigint) {
  return {
    snapshot: {
      thread,
      messages: [],
      inputs: [],
      runs: [],
      devices: [],
      queueVersion: baseSeq,
    },
    throughSeq,
  };
}

function runEvent(seq: bigint) {
  return {
    payload: {
      case: 'event' as const,
      value: {
        eventId: `event-${seq}`,
        threadId: thread.threadId,
        seq,
        payload: {
          case: 'runChanged' as const,
          value: {
            run: {
              runId: 'run-1',
              threadId: thread.threadId,
              status: RunStatus.RUNNING,
              usage: { inputTokens: baseSeq, outputTokens: baseSeq + 1n },
            },
          },
        },
      },
    },
  };
}

function messageEvent(seq: bigint, text = '最终消息') {
  return {
    payload: {
      case: 'event' as const,
      value: {
        eventId: `event-${seq}`,
        threadId: thread.threadId,
        seq,
        payload: {
          case: 'messageCommitted' as const,
          value: {
            message: {
              messageId: 'message-1',
              threadId: thread.threadId,
              agentId: 'agent-1',
              seq: baseSeq + 50n,
              role: MessageRole.ASSISTANT,
              content: text,
            },
          },
        },
      },
    },
  };
}

function inputEvent(seq: bigint) {
  return {
    payload: {
      case: 'event' as const,
      value: {
        eventId: `event-${seq}`,
        threadId: thread.threadId,
        seq,
        payload: {
          case: 'inputAccepted' as const,
          value: {
            input: {
              inputId: 'input-1',
              threadId: thread.threadId,
              text: '输入',
              mode: InputMode.FOLLOW_UP,
              status: InputStatus.QUEUED,
              position: baseSeq,
              version: baseSeq,
            },
          },
        },
      },
    },
  };
}

function bashEvent(seq: bigint) {
  return {
    payload: {
      case: 'event' as const,
      value: {
        eventId: `event-${seq}`,
        threadId: thread.threadId,
        seq,
        payload: {
          case: 'bashOperationChanged' as const,
          value: {
            operation: {
              operationId: 'operation-1',
              runId: 'run-1',
              deviceId: 'device-1',
              command: 'printf test',
              cwd: '/tmp',
              status: BashOperationStatus.RUNNING,
              outputComplete: false,
            },
          },
        },
      },
    },
  };
}

function environmentBindingEvent(
  seq: bigint,
  agentId = 'thread',
  binding?: { envId: string; pwd: string; bindingVersion: bigint },
) {
  return {
    payload: {
      case: 'event' as const,
      value: {
        eventId: `event-${seq}`,
        threadId: thread.threadId,
        seq,
        payload: {
          case: 'environmentBindingChanged' as const,
          value: { agentId, binding },
        },
      },
    },
  };
}

type ConnectEvent =
  | ReturnType<typeof runEvent>
  | ReturnType<typeof messageEvent>
  | ReturnType<typeof inputEvent>
  | ReturnType<typeof bashEvent>
  | ReturnType<typeof environmentBindingEvent>;

async function projectorForConnectEvent(event: ConnectEvent): Promise<{
  projector: ThreadProjector;
  response: WatchThreadResponse;
}> {
  const transport = createRouterTransport((router) => {
    router.service(ThreadService, { getThread: () => snapshot(baseSeq) });
    router.service(EventService, {
      async *watchThread() {
        yield event;
      },
    });
  });
  const clients = createKairosClients({ transport });
  const snapshotResponse = await clients.thread.getThread({ threadId: thread.threadId });
  if (!snapshotResponse.snapshot) throw new Error('missing snapshot');
  const projector = new ThreadProjector(thread.threadId);
  projector.applySnapshot(snapshotResponse.snapshot, snapshotResponse.throughSeq);
  const iterator = clients.events
    .watchThread({ threadId: thread.threadId, afterSeq: baseSeq })
    [Symbol.asyncIterator]();
  const next = await iterator.next();
  if (!next.value) throw new Error('missing event');
  await iterator.return?.();
  return { projector, response: next.value };
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve?.(value) };
}

function textDelta(deltaSeq: bigint, text: string) {
  return {
    payload: {
      case: 'textDelta' as const,
      value: {
        threadId: thread.threadId,
        messageId: 'message-1',
        deltaSeq,
        text,
      },
    },
  };
}

function abortWhenCancelled(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

describe('ThreadSynchronizer', () => {
  it('resumes after the last persisted seq and deduplicates transient and persisted events', async () => {
    const afterSeqs: bigint[] = [];
    const states: ThreadSyncState[] = [];
    let cancelCalls = 0;
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        getThread() {
          return snapshot(baseSeq);
        },
      });
      router.service(EventService, {
        async *watchThread(request, context) {
          afterSeqs.push(request.afterSeq);
          if (afterSeqs.length === 1) {
            yield textDelta(baseSeq + 1n, '你');
            yield textDelta(baseSeq + 2n, '好');
            yield textDelta(baseSeq + 2n, '好');
            yield runEvent(baseSeq + 1n);
            throw new ConnectError('connection lost', Code.Unavailable);
          }
          yield runEvent(baseSeq + 1n);
          yield messageEvent(baseSeq + 2n);
          await abortWhenCancelled(context.signal);
        },
      });
      router.service(RunService, {
        cancelRun(request) {
          cancelCalls += 1;
          return {
            clientActionId: request.clientActionId,
            runId: request.runId,
            status: RunStatus.CANCEL_REQUESTED,
          };
        },
      });
      router.service(MessageService, {});
    });
    const clients = createKairosClients({ transport });
    const synchronizer = new ThreadSynchronizer({
      clients,
      retryDelayMs: 1,
      maxRetryDelayMs: 2,
      onChange: (state) => states.push(state),
    });
    try {
      synchronizer.start(thread.threadId);
      await vi.waitFor(() => {
        expect(synchronizer.state.snapshot?.messages).toHaveLength(1);
        expect(synchronizer.state.throughSeq).toBe(baseSeq + 2n);
      });
      expect(afterSeqs).toEqual([baseSeq, baseSeq + 1n]);
      expect(synchronizer.state.snapshot?.messages[0]?.content).toBe('最终消息');
      expect(synchronizer.state.snapshot?.runs[0]?.usage?.inputTokens).toBe(baseSeq);
      expect(
        states.some((state) => state.transientResponses[0]?.contentBlocks[0]?.text === '你好'),
      ).toBe(true);
      expect(
        states.some((state) => state.transientResponses[0]?.contentBlocks[0]?.text === '你好好'),
      ).toBe(false);
      expect(synchronizer.state.transientResponses).toHaveLength(0);
      expect(synchronizer.state.status).toBe('live');
    } finally {
      synchronizer.stop();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cancelCalls).toBe(0);
  });

  it('reloads a snapshot when the server reports an expired cursor', async () => {
    const afterSeqs: bigint[] = [];
    let snapshots = 0;
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        getThread() {
          snapshots += 1;
          return snapshots === 1 ? snapshot(baseSeq) : snapshot(baseSeq + 10n);
        },
      });
      router.service(EventService, {
        async *watchThread(request, context) {
          afterSeqs.push(request.afterSeq);
          if (afterSeqs.length === 1) {
            throw new ConnectError('cursor expired', Code.OutOfRange);
          }
          yield messageEvent(baseSeq + 11n, '快照恢复后的消息');
          await abortWhenCancelled(context.signal);
        },
      });
    });
    const synchronizer = new ThreadSynchronizer({
      clients: createKairosClients({ transport }),
      retryDelayMs: 1,
      maxRetryDelayMs: 2,
    });
    try {
      synchronizer.start(thread.threadId);
      await vi.waitFor(() => {
        expect(synchronizer.state.snapshot?.messages[0]?.content).toBe('快照恢复后的消息');
      });
      expect(snapshots).toBe(2);
      expect(afterSeqs).toEqual([baseSeq, baseSeq + 10n]);
      expect(synchronizer.state.throughSeq).toBe(baseSeq + 11n);
    } finally {
      synchronizer.stop();
    }
  });

  it('resets the reconnect delay after a valid response between two disconnects', async () => {
    vi.useFakeTimers();
    const watchStarts: number[] = [];
    const reconnectIntervals: number[] = [];
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, { getThread: () => snapshot(baseSeq) });
      router.service(EventService, {
        async *watchThread() {
          const startedAt = Date.now();
          const previousStart = watchStarts.at(-1);
          if (previousStart !== undefined) reconnectIntervals.push(startedAt - previousStart);
          watchStarts.push(startedAt);
          if (watchStarts.length === 2) yield runEvent(baseSeq + 1n);
          throw new ConnectError('connection lost', Code.Unavailable);
        },
      });
    });
    const synchronizer = new ThreadSynchronizer({
      clients: createKairosClients({ transport }),
      retryDelayMs: 10,
      maxRetryDelayMs: 100,
    });
    try {
      synchronizer.start(thread.threadId);
      await vi.advanceTimersByTimeAsync(0);
      expect(watchStarts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(9);
      expect(watchStarts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(watchStarts).toHaveLength(2);
      expect(reconnectIntervals).toEqual([10]);

      await vi.advanceTimersByTimeAsync(9);
      expect(watchStarts).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(watchStarts).toHaveLength(3);
      expect(reconnectIntervals).toEqual([10, 10]);
    } finally {
      synchronizer.stop();
      vi.useRealTimers();
    }
  });
});

describe('ThreadSynchronizer manual reload', () => {
  it('ignores late events and stale snapshots without moving the applied cursor backwards', async () => {
    const oldStream = deferred<void>();
    const staleSnapshot = deferred<void>();
    const afterSeqs: bigint[] = [];
    let snapshots = 0;
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        getThread: async () => {
          snapshots += 1;
          if (snapshots > 1) await staleSnapshot.promise;
          return snapshot(baseSeq);
        },
      });
      router.service(EventService, {
        async *watchThread(request, context) {
          afterSeqs.push(request.afterSeq);
          if (afterSeqs.length === 1) {
            yield messageEvent(baseSeq + 1n, '已应用消息');
            await oldStream.promise;
            yield messageEvent(baseSeq + 2n, '旧流迟到消息');
          } else {
            yield messageEvent(baseSeq + 2n, '新流确认消息');
          }
          await abortWhenCancelled(context.signal);
        },
      });
    });
    const synchronizer = new ThreadSynchronizer({
      clients: createKairosClients({ transport }),
      retryDelayMs: 1,
      maxRetryDelayMs: 2,
    });
    try {
      synchronizer.start(thread.threadId);
      await vi.waitFor(() => {
        expect(synchronizer.state.snapshot?.messages[0]?.content).toBe('已应用消息');
      });
      const reloading = synchronizer.reload();
      oldStream.resolve(undefined);
      await Promise.resolve();
      staleSnapshot.resolve(undefined);
      await reloading;
      expect(synchronizer.state.throughSeq).toBe(baseSeq + 1n);
      expect(synchronizer.state.snapshot?.messages[0]?.content).toBe('已应用消息');

      await vi.waitFor(() => {
        expect(synchronizer.state.snapshot?.messages[0]?.content).toBe('新流确认消息');
      });
      expect(afterSeqs).toEqual([baseSeq, baseSeq + 1n]);
      expect(synchronizer.state.throughSeq).toBe(baseSeq + 2n);
      expect(synchronizer.state.snapshot?.messages).toHaveLength(1);
    } finally {
      synchronizer.stop();
    }
  });

  it('enters synchronization error state when a manual snapshot refresh fails', async () => {
    let snapshots = 0;
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        getThread() {
          snapshots += 1;
          if (snapshots > 1) throw new ConnectError('refresh failed', Code.Unavailable);
          return snapshot(baseSeq);
        },
      });
      router.service(EventService, {
        async *watchThread(_request, context) {
          await abortWhenCancelled(context.signal);
          yield* [];
        },
      });
    });
    const synchronizer = new ThreadSynchronizer({ clients: createKairosClients({ transport }) });
    try {
      synchronizer.start(thread.threadId);
      await vi.waitFor(() => expect(synchronizer.state.status).toBe('live'));
      await synchronizer.reload();
      expect(synchronizer.state.status).toBe('error');
      expect(synchronizer.state.error).toContain('Server 暂时不可用');
      expect(synchronizer.state.throughSeq).toBe(baseSeq);
    } finally {
      synchronizer.stop();
    }
  });

  it('clears event-derived facts that a recovery snapshot cannot confirm', async () => {
    const expire = deferred<void>();
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        getThread: (() => {
          let count = 0;
          return () => {
            count += 1;
            return count === 1 ? snapshot(baseSeq) : snapshot(baseSeq + 10n);
          };
        })(),
      });
      router.service(EventService, {
        async *watchThread(request, context) {
          if (request.afterSeq === baseSeq) {
            yield bashEvent(baseSeq + 1n);
            yield {
              payload: {
                case: 'event' as const,
                value: {
                  eventId: 'hard-cut-started',
                  threadId: thread.threadId,
                  seq: baseSeq + 2n,
                  payload: { case: 'hardCutStarted' as const, value: { runId: 'run-1' } },
                },
              },
            };
            yield {
              payload: {
                case: 'event' as const,
                value: {
                  eventId: 'recap-invalidated',
                  threadId: thread.threadId,
                  seq: baseSeq + 3n,
                  payload: {
                    case: 'recapInvalidated' as const,
                    value: { recapId: 'recap-1', reason: '来源已变化' },
                  },
                },
              },
            };
            await expire.promise;
            throw new ConnectError('cursor expired', Code.OutOfRange);
          }
          yield messageEvent(baseSeq + 11n, '恢复后的持久消息');
          await abortWhenCancelled(context.signal);
        },
      });
    });
    const synchronizer = new ThreadSynchronizer({
      clients: createKairosClients({ transport }),
      retryDelayMs: 1,
      maxRetryDelayMs: 2,
    });
    try {
      synchronizer.start(thread.threadId);
      await vi.waitFor(() => {
        expect(synchronizer.state.bashOperations).toHaveLength(1);
        expect(synchronizer.state.hardCuts).toHaveLength(1);
        expect(synchronizer.state.invalidatedRecaps['recap-1']).toBe('来源已变化');
      });
      expire.resolve(undefined);
      await vi.waitFor(() => {
        expect(synchronizer.state.snapshot?.messages[0]?.content).toBe('恢复后的持久消息');
      });
      expect(synchronizer.state.bashOperations).toHaveLength(0);
      expect(synchronizer.state.hardCuts).toHaveLength(0);
      expect(synchronizer.state.invalidatedRecaps).toEqual({});
    } finally {
      synchronizer.stop();
    }
  });
});

describe('ThreadProjector protocol validation', () => {
  async function projectorWithHardCut() {
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, { getThread: () => snapshot(baseSeq) });
      router.service(EventService, {
        async *watchThread() {
          yield {
            payload: {
              case: 'event' as const,
              value: {
                eventId: 'hard-cut-1',
                threadId: thread.threadId,
                seq: baseSeq + 1n,
                payload: {
                  case: 'hardCutCompleted' as const,
                  value: {
                    runId: 'run-1',
                    replacedSourceSeqs: [baseSeq, baseSeq + 2n],
                    recapIds: ['recap-1'],
                    injectedMessageCount: 1,
                  },
                },
              },
            },
          };
        },
      });
    });
    const clients = createKairosClients({ transport });
    const response = await clients.thread.getThread({ threadId: thread.threadId });
    if (!response.snapshot) throw new Error('missing snapshot');
    const projector = new ThreadProjector(thread.threadId);
    projector.applySnapshot(response.snapshot, response.throughSeq);
    const iterator = clients.events
      .watchThread({ threadId: thread.threadId, afterSeq: baseSeq })
      [Symbol.asyncIterator]();
    const next = await iterator.next();
    if (!next.value) throw new Error('missing hard-cut event');
    await iterator.return?.();
    return { projector, response: next.value };
  }

  it('retains hard-cut source seqs and usage-scale uint64 values as bigint', async () => {
    const { projector, response } = await projectorWithHardCut();
    projector.applyWatchResponse(response);
    expect(projector.state.hardCuts[0]?.replacedSourceSeqs).toEqual([baseSeq, baseSeq + 2n]);
    expect(projector.state.hardCuts[0]?.injectedMessageCount).toBe(1);
  });

  it('applies root environment binding events without adopting Subagent bindings', async () => {
    const bound = environmentBindingEvent(baseSeq + 1n, 'thread', {
      envId: 'env-root',
      pwd: '/srv/root',
      bindingVersion: 1n,
    });
    const child = environmentBindingEvent(baseSeq + 2n, 'subagent-child', {
      envId: 'env-child',
      pwd: '/srv/child',
      bindingVersion: 2n,
    });
    const cleared = environmentBindingEvent(baseSeq + 3n);
    const { projector, response: boundResponse } = await projectorForConnectEvent(bound);
    const { response: childResponse } = await projectorForConnectEvent(child);
    const { response: clearedResponse } = await projectorForConnectEvent(cleared);

    projector.applyWatchResponse(boundResponse);
    expect(projector.state.throughSeq).toBe(baseSeq + 1n);
    expect(projector.state.snapshot?.thread?.currentBinding).toMatchObject({
      envId: 'env-root',
      pwd: '/srv/root',
      bindingVersion: 1n,
    });
    projector.applyWatchResponse(childResponse);
    expect(projector.state.throughSeq).toBe(baseSeq + 2n);
    expect(projector.state.snapshot?.thread?.currentBinding?.envId).toBe('env-root');
    projector.applyWatchResponse(clearedResponse);
    expect(projector.state.throughSeq).toBe(baseSeq + 3n);
    expect(projector.state.snapshot?.thread?.currentBinding).toBeUndefined();
    projector.applyWatchResponse(boundResponse);
    expect(projector.state.throughSeq).toBe(baseSeq + 3n);
    expect(projector.state.snapshot?.thread?.currentBinding).toBeUndefined();
  });

  it('rejects an unknown persisted payload instead of advancing the cursor', async () => {
    const { projector, response } = await projectorWithHardCut();
    if (response.payload.case !== 'event') throw new Error('missing event');
    response.payload.value.payload = { case: undefined };
    expect(() => projector.applyWatchResponse(response)).toThrow(UnsupportedEventError);
    expect(projector.state.throughSeq).toBe(baseSeq);
  });

  it('rejects an unknown top-level payload and an event sequence gap', async () => {
    const { projector, response } = await projectorWithHardCut();
    response.payload = { case: undefined };
    expect(() => projector.applyWatchResponse(response)).toThrow(UnsupportedEventError);

    const second = await projectorWithHardCut();
    if (second.response.payload.case !== 'event') throw new Error('missing event');
    second.response.payload.value.seq = baseSeq + 2n;
    expect(() => second.projector.applyWatchResponse(second.response)).toThrow(EventGapError);
  });

  it('rejects unknown and unspecified enums from real Connect binary events', async () => {
    const cases: { name: string; make: () => ConnectEvent }[] = [
      {
        name: 'unknown MessageRole',
        make: () => {
          const event = messageEvent(baseSeq + 1n);
          Reflect.set(event.payload.value.payload.value.message, 'role', 99);
          return event;
        },
      },
      {
        name: 'unspecified MessageRole',
        make: () => {
          const event = messageEvent(baseSeq + 1n);
          Reflect.set(event.payload.value.payload.value.message, 'role', 0);
          return event;
        },
      },
      {
        name: 'unspecified MessageSource',
        make: () => {
          const event = messageEvent(baseSeq + 1n);
          Reflect.set(event.payload.value.payload.value.message, 'source', 0);
          return event;
        },
      },
      {
        name: 'unknown InputSource',
        make: () => {
          const event = inputEvent(baseSeq + 1n);
          Reflect.set(event.payload.value.payload.value.input, 'source', 99);
          return event;
        },
      },
      {
        name: 'unspecified InputMode',
        make: () => {
          const event = inputEvent(baseSeq + 1n);
          Reflect.set(event.payload.value.payload.value.input, 'mode', 0);
          return event;
        },
      },
      {
        name: 'unknown InputStatus',
        make: () => {
          const event = inputEvent(baseSeq + 1n);
          Reflect.set(event.payload.value.payload.value.input, 'status', 99);
          return event;
        },
      },
      {
        name: 'unknown RunStatus',
        make: () => {
          const event = runEvent(baseSeq + 1n);
          Reflect.set(event.payload.value.payload.value.run, 'status', 99);
          return event;
        },
      },
      {
        name: 'unspecified RunStatus',
        make: () => {
          const event = runEvent(baseSeq + 1n);
          Reflect.set(event.payload.value.payload.value.run, 'status', 0);
          return event;
        },
      },
      {
        name: 'unspecified RunExecutionMode',
        make: () => {
          const event = runEvent(baseSeq + 1n);
          Reflect.set(event.payload.value.payload.value.run, 'executionMode', 0);
          return event;
        },
      },
      {
        name: 'unknown BashOperationStatus',
        make: () => {
          const event = bashEvent(baseSeq + 1n);
          Reflect.set(event.payload.value.payload.value.operation, 'status', 99);
          return event;
        },
      },
      {
        name: 'unspecified BashOperationStatus',
        make: () => {
          const event = bashEvent(baseSeq + 1n);
          Reflect.set(event.payload.value.payload.value.operation, 'status', 0);
          return event;
        },
      },
      {
        name: 'unspecified ErrorCode',
        make: () => {
          const event = runEvent(baseSeq + 1n);
          const run = event.payload.value.payload.value.run;
          const error = { code: ErrorCode.INTERNAL, message: '失败', retryable: false };
          Reflect.set(run, 'error', error);
          Reflect.set(error, 'code', 0);
          return event;
        },
      },
      {
        name: 'unknown ErrorCode',
        make: () => {
          const event = runEvent(baseSeq + 1n);
          const run = event.payload.value.payload.value.run;
          const error = { code: ErrorCode.INTERNAL, message: '失败', retryable: false };
          Reflect.set(run, 'error', error);
          Reflect.set(error, 'code', 99);
          return event;
        },
      },
    ];
    for (const testCase of cases) {
      const { projector, response } = await projectorForConnectEvent(testCase.make());
      expect(() => projector.applyWatchResponse(response), testCase.name).toThrow(
        UnsupportedEventError,
      );
      expect(projector.state.throughSeq, testCase.name).toBe(baseSeq);
      expect(projector.state.snapshot?.messages, testCase.name).toHaveLength(0);
      expect(projector.state.snapshot?.inputs, testCase.name).toHaveLength(0);
      expect(projector.state.snapshot?.runs, testCase.name).toHaveLength(0);
      expect(projector.state.bashOperations, testCase.name).toHaveLength(0);
    }
  });

  it('rejects invalid snapshot enums before installing the snapshot', async () => {
    const invalid = snapshot(baseSeq);
    const message = {
      messageId: 'message-1',
      threadId: thread.threadId,
      agentId: 'agent-1',
      seq: baseSeq,
      role: MessageRole.USER,
      content: '非法快照',
    };
    Reflect.set(message, 'role', 0);
    const response = {
      ...invalid,
      snapshot: { ...invalid.snapshot, messages: [message] },
    };
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, { getThread: () => response });
    });
    const clients = createKairosClients({ transport });
    const decoded = await clients.thread.getThread({ threadId: thread.threadId });
    const decodedSnapshot = decoded.snapshot;
    if (!decodedSnapshot) throw new Error('missing snapshot');
    const projector = new ThreadProjector(thread.threadId);
    expect(() => projector.applySnapshot(decodedSnapshot, decoded.throughSeq)).toThrow(
      UnsupportedEventError,
    );
    expect(projector.state.snapshot).toBeNull();
    expect(projector.state.throughSeq).toBe(0n);
  });

  it('accepts a binary snapshot with an assistant, a failed Run and an empty tool error message', async () => {
    const initial = snapshot(baseSeq);
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        getThread: () => ({
          ...initial,
          snapshot: {
            ...initial.snapshot,
            messages: [
              {
                messageId: 'assistant-before-error',
                threadId: thread.threadId,
                agentId: 'thread',
                seq: 1n,
                role: MessageRole.ASSISTANT,
                content: '',
                toolCalls: [{ toolCallId: 'failed-read', toolName: 'read', argumentsJson: '{}' }],
              },
              {
                messageId: 'empty-tool-error',
                threadId: thread.threadId,
                agentId: 'thread',
                seq: 2n,
                role: MessageRole.TOOL,
                toolCallId: 'failed-read',
                toolName: 'read',
                content: '',
                toolStatus: ToolResultStatus.ERROR,
                toolError: { code: 'execution_failed', message: '' },
              },
            ],
            runs: [
              {
                runId: 'failed-run',
                threadId: thread.threadId,
                agentId: 'thread',
                status: RunStatus.FAILED,
                error: { code: ErrorCode.INTERNAL, message: '' },
              },
            ],
          },
        }),
      });
    });
    const clients = createKairosClients({ transport });
    const decoded = await clients.thread.getThread({ threadId: thread.threadId });
    if (!decoded.snapshot) throw new Error('missing snapshot');
    const projector = new ThreadProjector(thread.threadId);
    projector.applySnapshot(decoded.snapshot, decoded.throughSeq);

    expect(projector.state.snapshot?.messages[0]?.toolStatus).toBe(ToolResultStatus.UNSPECIFIED);
    expect(projector.state.snapshot?.messages[1]).toMatchObject({
      content: '',
      toolStatus: ToolResultStatus.ERROR,
      toolError: { code: 'execution_failed', message: '' },
    });
    expect(projector.state.snapshot?.runs[0]?.status).toBe(RunStatus.FAILED);
    expect(projector.state.throughSeq).toBe(baseSeq);
  });

  it('uses the generated schemas for the event under test', () => {
    expect(WatchThreadResponseSchema.typeName).toBe('kairos.gui.v1.WatchThreadResponse');
    expect(
      ContextHardCutCompletedSchema.fields.find(
        (field) => field.localName === 'replacedSourceSeqs',
      ),
    ).toBeDefined();
  });
});
