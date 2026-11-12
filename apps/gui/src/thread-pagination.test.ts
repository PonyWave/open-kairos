import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import {
  create,
  DeviceSchema,
  ErrorCode,
  EventService,
  type GetThreadResponse,
  GetThreadResponseSchema,
  InputMode,
  InputSchema,
  InputStatus,
  MessageRole,
  MessageSchema,
  RunSchema,
  RunService,
  RunStatus,
  ThreadSchema,
  ThreadService,
  ThreadSnapshotCursorSchema,
  ThreadSnapshotSchema,
} from '@kairos/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createKairosClients } from './client.js';
import { ThreadProjector, UnsupportedEventError } from './thread-projection.js';
import { ThreadSynchronizer, type ThreadSyncState } from './thread-sync.js';

const baseSeq = 9_007_199_254_740_993n;
const thread = create(ThreadSchema, { threadId: 'thread-1', title: '分页恢复', seq: baseSeq });

function cursor(index: number, count: number) {
  return create(ThreadSnapshotCursorSchema, {
    threadId: thread.threadId,
    throughSeq: baseSeq,
    messages: { afterRowid: BigInt(index), maxRowid: BigInt(count) },
    inputs: { afterRowid: 0n, maxRowid: 0n },
    runs: { afterRowid: 0n, maxRowid: 0n },
    devices: { afterRowid: 0n, maxRowid: 0n },
    recaps: { afterRowid: 0n, maxRowid: 0n },
    notifications: { afterRowid: 0n, maxRowid: 0n },
  });
}

function page(input: {
  index: number;
  count: number;
  messages?: ReturnType<typeof message>[];
  inputs?: ReturnType<typeof queuedInput>[];
  runs?: ReturnType<typeof run>[];
}): GetThreadResponse {
  const hasMore = input.index + 1 < input.count;
  return create(GetThreadResponseSchema, {
    snapshot: create(ThreadSnapshotSchema, {
      ...(input.index === 0 ? { thread, queueVersion: baseSeq } : {}),
      messages: input.messages ?? [],
      inputs: input.inputs ?? [],
      runs: input.runs ?? [],
    }),
    throughSeq: baseSeq,
    hasMore,
    ...(hasMore ? { nextCursor: cursor(input.index + 1, input.count) } : {}),
  });
}

function message(index: number, size = 20, agentId = 'thread') {
  return create(MessageSchema, {
    messageId: `message-${index}`,
    threadId: thread.threadId,
    agentId,
    seq: baseSeq,
    role: index % 2 === 0 ? MessageRole.USER : MessageRole.ASSISTANT,
    content: `${index}:${'m'.repeat(size)}`,
  });
}

function queuedInput(index: number, size = 20) {
  return create(InputSchema, {
    inputId: `input-${index}`,
    threadId: thread.threadId,
    text: 'q'.repeat(size),
    mode: InputMode.FOLLOW_UP,
    status: InputStatus.QUEUED,
    position: BigInt(index + 1),
    version: 1n,
  });
}

function run(index: number, errorSize = 0) {
  return create(RunSchema, {
    runId: `run-${index}`,
    threadId: thread.threadId,
    status: RunStatus.FAILED,
    usage: { inputTokens: baseSeq, outputTokens: baseSeq + 1n },
    ...(errorSize > 0
      ? {
          error: {
            code: ErrorCode.INTERNAL,
            message: 'r'.repeat(errorSize),
            retryable: true,
          },
        }
      : {}),
  });
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

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve?.(value) };
}

describe('ThreadProjector snapshot pages', () => {
  it('rejects a foreign record in the first snapshot without exposing partial data', () => {
    const projector = new ThreadProjector(thread.threadId);
    const foreign = create(InputSchema, { ...queuedInput(1), threadId: 'other-thread' });
    expect(() =>
      projector.applySnapshot(create(ThreadSnapshotSchema, { thread, inputs: [foreign] }), baseSeq),
    ).toThrow(UnsupportedEventError);
    expect(projector.state.snapshot).toBeNull();
    expect(projector.state.throughSeq).toBe(0n);
  });

  it('deduplicates pages and retains distinct agents with the same sequence', () => {
    const projector = new ThreadProjector(thread.threadId);
    const firstMessage = message(1);
    const secondMessage = message(2, 20, 'subagent-a');
    projector.applySnapshotPage(
      create(ThreadSnapshotSchema, {
        thread,
        messages: [firstMessage],
        inputs: [queuedInput(1)],
        runs: [run(1)],
        devices: [create(DeviceSchema, { deviceId: 'device-1', deviceName: '本机' })],
        queueVersion: baseSeq,
      }),
      baseSeq,
    );
    const revised = create(MessageSchema, { ...firstMessage, content: '修订' });
    projector.applySnapshotPage(
      create(ThreadSnapshotSchema, {
        messages: [revised, secondMessage],
        inputs: [queuedInput(1)],
        runs: [run(1)],
        devices: [create(DeviceSchema, { deviceId: 'device-1', deviceName: '本机' })],
      }),
      baseSeq,
    );
    expect(projector.state.snapshot?.messages.map((item) => item.messageId)).toEqual([
      'message-1',
      'message-2',
    ]);
    expect(projector.state.snapshot?.messages[0]?.content).toBe('修订');
    expect(projector.state.snapshot?.inputs).toHaveLength(1);
    expect(projector.state.snapshot?.runs).toHaveLength(1);
    expect(projector.state.snapshot?.devices).toHaveLength(1);
    expect(projector.state.snapshot?.queueVersion).toBe(baseSeq);
    expect(() =>
      projector.applySnapshotPage(create(ThreadSnapshotSchema, {}), baseSeq + 1n),
    ).toThrow(UnsupportedEventError);
    expect(projector.state.snapshot?.messages).toHaveLength(2);
  });
});

describe('ThreadSynchronizer snapshot pages', () => {
  it('does not expose a partial snapshot when a later page fails and retries cleanly', async () => {
    let attempt = 0;
    const states: ThreadSyncState[] = [];
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        getThread(request) {
          if (request.cursor === undefined) attempt += 1;
          const index = Number(request.cursor?.messages?.afterRowid ?? 0n);
          if (attempt === 1 && index === 1) throw new ConnectError('lost', Code.Unavailable);
          return page({ index, count: 2, messages: [message(index)] });
        },
      });
      router.service(EventService, {
        async *watchThread(_request, context) {
          await abortWhenCancelled(context.signal);
          yield* [];
        },
      });
    });
    const synchronizer = new ThreadSynchronizer({
      clients: createKairosClients({ transport }),
      onChange: (state) => states.push(state),
    });
    try {
      synchronizer.start(thread.threadId);
      await vi.waitFor(() => expect(synchronizer.state.status).toBe('error'));
      expect(synchronizer.state.snapshot).toBeNull();
      expect(states.every((state) => state.snapshot === null)).toBe(true);

      await synchronizer.reload();
      await vi.waitFor(() => expect(synchronizer.state.status).toBe('live'));
      expect(synchronizer.state.snapshot?.messages.map((item) => item.messageId)).toEqual([
        'message-0',
        'message-1',
      ]);
    } finally {
      synchronizer.stop();
    }
  });

  it('ignores an old page after switching to another Thread', async () => {
    const secondOldPage = deferred<GetThreadResponse>();
    const otherThread = create(ThreadSchema, {
      ...thread,
      threadId: 'thread-2',
      title: '新会话',
    });
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        async getThread(request) {
          if (request.threadId === otherThread.threadId) {
            return create(GetThreadResponseSchema, {
              snapshot: create(ThreadSnapshotSchema, {
                thread: otherThread,
                messages: [
                  create(MessageSchema, {
                    ...message(9),
                    threadId: otherThread.threadId,
                    content: '新会话消息',
                  }),
                ],
              }),
              throughSeq: baseSeq,
            });
          }
          if (request.cursor) return secondOldPage.promise;
          return page({ index: 0, count: 2, messages: [message(0)] });
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
      await vi.waitFor(() => expect(synchronizer.state.status).toBe('loading'));
      synchronizer.start(otherThread.threadId);
      await vi.waitFor(() =>
        expect(synchronizer.state.snapshot?.thread?.threadId).toBe(otherThread.threadId),
      );
      secondOldPage.resolve(page({ index: 1, count: 2, messages: [message(1)] }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(synchronizer.state.snapshot?.thread?.threadId).toBe(otherThread.threadId);
      expect(synchronizer.state.snapshot?.messages[0]?.content).toBe('新会话消息');
    } finally {
      synchronizer.stop();
    }
  });

  it('reopens and reloads a multi-megabyte history without duplicates or Run cancellation', async () => {
    const messages = Array.from({ length: 30 }, (_, index) => message(index, 40 * 1024));
    const inputs = Array.from({ length: 100 }, (_, index) => queuedInput(index, 40 * 1024));
    const runs = Array.from({ length: 80 }, (_, index) => run(index, 16 * 1024));
    const chunks = <T>(values: T[], size: number) =>
      Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
        values.slice(index * size, (index + 1) * size),
      );
    const definitions = [
      ...chunks(messages, 10).map((values) => ({ messages: values })),
      ...chunks(inputs, 20).map((values) => ({ inputs: values })),
      ...chunks(runs, 20).map((values) => ({ runs: values })),
    ];
    const pages = definitions.map((definition, index) =>
      page({ ...definition, index, count: definitions.length }),
    );
    const afterSeqs: bigint[] = [];
    const states: ThreadSyncState[] = [];
    let snapshotReads = 0;
    let cancelCalls = 0;
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        getThread(request) {
          expect(request.limit).toBe(100);
          const index = Number(request.cursor?.messages?.afterRowid ?? 0n);
          snapshotReads += 1;
          const response = pages[index];
          if (!response) throw new Error('Unexpected page cursor.');
          return response;
        },
      });
      router.service(EventService, {
        async *watchThread(request, context) {
          afterSeqs.push(request.afterSeq);
          await abortWhenCancelled(context.signal);
          yield* [];
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
    });
    const synchronizer = new ThreadSynchronizer({
      clients: createKairosClients({ transport }),
      onChange: (state) => states.push(state),
    });
    try {
      synchronizer.start(thread.threadId);
      await vi.waitFor(() => expect(synchronizer.state.status).toBe('live'));
      expect(synchronizer.state.snapshot?.messages).toHaveLength(30);
      expect(synchronizer.state.snapshot?.inputs).toHaveLength(100);
      expect(synchronizer.state.snapshot?.runs).toHaveLength(80);
      expect(
        states
          .filter((state) => state.snapshot !== null)
          .every((state) => state.snapshot?.messages.length === 30),
      ).toBe(true);

      await synchronizer.reload();
      await vi.waitFor(() => expect(afterSeqs).toHaveLength(2));
      expect(synchronizer.state.snapshot?.messages).toHaveLength(30);
      expect(synchronizer.state.snapshot?.inputs).toHaveLength(100);
      expect(synchronizer.state.snapshot?.runs).toHaveLength(80);
      expect(snapshotReads).toBe(pages.length * 2);
      expect(afterSeqs).toEqual([baseSeq, baseSeq]);
    } finally {
      synchronizer.stop();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cancelCalls).toBe(0);
  });
});
