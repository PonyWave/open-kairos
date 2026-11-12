import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import {
  ContentBlockType,
  create,
  EventService,
  MessageRole,
  ThreadSchema,
  ThreadService,
  ThreadSnapshotSchema,
  ThreadType,
  WatchThreadResponseSchema,
} from '@kairos/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createKairosClients } from './client.js';
import { EventGapError, ThreadProjector, UnsupportedEventError } from './thread-projection.js';
import { ThreadSynchronizer, type ThreadSyncState } from './thread-sync.js';

const threadId = 'thread-1';

function emptySnapshot() {
  return create(ThreadSnapshotSchema, {
    thread: create(ThreadSchema, {
      threadId,
      title: 'Thinking 测试',
      seq: 1n,
      threadType: ThreadType.TASK,
    }),
    messages: [],
    inputs: [],
    runs: [],
    devices: [],
    queueVersion: 0n,
  });
}

function newProjector(): ThreadProjector {
  const projector = new ThreadProjector(threadId);
  projector.applySnapshot(emptySnapshot(), 0n);
  return projector;
}

function textDelta(
  deltaSeq: bigint,
  blockIndex: number | undefined,
  text: string,
  messageId = 'message-1',
) {
  return create(WatchThreadResponseSchema, {
    payload: {
      case: 'textDelta',
      value: { threadId, messageId, deltaSeq, blockIndex, text },
    },
  });
}

function thinkingDelta(
  deltaSeq: bigint,
  blockIndex: number,
  text: string,
  messageId = 'message-1',
) {
  return create(WatchThreadResponseSchema, {
    payload: {
      case: 'thinkingDelta',
      value: { threadId, messageId, deltaSeq, blockIndex, text, runId: 'run-1' },
    },
  });
}

function messageCommitted(seq: bigint, withThinking: boolean) {
  const contentBlocks = withThinking
    ? [
        { type: ContentBlockType.THINKING, blockIndex: 0, text: 'persisted reasoning' },
        { type: ContentBlockType.TEXT, blockIndex: 1, text: 'persisted text' },
      ]
    : [];
  return create(WatchThreadResponseSchema, {
    payload: {
      case: 'event',
      value: {
        eventId: `event-${seq}`,
        threadId,
        seq,
        payload: {
          case: 'messageCommitted',
          value: {
            message: {
              messageId: 'message-1',
              threadId,
              agentId: 'thread',
              seq: 1n,
              role: MessageRole.ASSISTANT,
              content: 'persisted text',
              contentBlocks,
            },
          },
        },
      },
    },
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

describe('Thinking transient projection', () => {
  it('aggregates ordered text and Thinking blocks with a shared delta sequence', () => {
    const projector = newProjector();
    projector.applyWatchResponse(thinkingDelta(1n, 0, 'rea'));
    projector.applyWatchResponse(thinkingDelta(2n, 0, 'soning'));
    projector.applyWatchResponse(textDelta(3n, 1, 'answer'));
    projector.applyWatchResponse(thinkingDelta(4n, 2, 'next'));
    projector.applyWatchResponse(thinkingDelta(4n, 2, 'duplicate'));
    projector.applyWatchResponse(textDelta(5n, 3, ' done'));

    const response = projector.state.transientResponses[0];
    expect(response?.deltaSeq).toBe(5n);
    expect(response?.contentBlocks).toMatchObject([
      { type: ContentBlockType.THINKING, blockIndex: 0, text: 'reasoning' },
      { type: ContentBlockType.TEXT, blockIndex: 1, text: 'answer' },
      { type: ContentBlockType.THINKING, blockIndex: 2, text: 'next' },
      { type: ContentBlockType.TEXT, blockIndex: 3, text: ' done' },
    ]);
  });

  it('keeps legacy text deltas and rejects gaps or conflicting block types', () => {
    const projector = newProjector();
    projector.applyWatchResponse(textDelta(1n, undefined, 'legacy'));
    expect(projector.state.transientResponses[0]?.contentBlocks[0]).toMatchObject({
      type: ContentBlockType.TEXT,
      blockIndex: 0,
      text: 'legacy',
    });
    expect(() => projector.applyWatchResponse(thinkingDelta(3n, 1, 'gap'))).toThrow(EventGapError);
    expect(() => projector.applyWatchResponse(thinkingDelta(2n, 0, 'conflict'))).toThrow(
      UnsupportedEventError,
    );
  });

  it('clears only the committed response and ignores its late deltas', () => {
    const projector = newProjector();
    projector.applyWatchResponse(thinkingDelta(1n, 0, 'temporary'));
    projector.applyWatchResponse(textDelta(1n, 0, 'other response', 'message-2'));
    projector.applyWatchResponse(messageCommitted(1n, true));

    expect(projector.state.transientResponses.map((response) => response.messageId)).toEqual([
      'message-2',
    ]);
    expect(projector.state.snapshot?.messages[0]?.contentBlocks).toMatchObject([
      { type: ContentBlockType.THINKING, blockIndex: 0, text: 'persisted reasoning' },
      { type: ContentBlockType.TEXT, blockIndex: 1, text: 'persisted text' },
    ]);
    projector.applyWatchResponse(thinkingDelta(2n, 0, 'late'));
    expect(projector.state.transientResponses.map((response) => response.messageId)).toEqual([
      'message-2',
    ]);
  });

  it('uses snapshot content after recovery without reconstructing missing Thinking', () => {
    const projector = newProjector();
    projector.applyWatchResponse(thinkingDelta(1n, 0, 'uncommitted reasoning'));
    const restored = emptySnapshot();
    const committed = messageCommitted(1n, false);
    if (
      committed.payload.case !== 'event' ||
      committed.payload.value.payload.case !== 'messageCommitted'
    ) {
      throw new Error('missing committed message');
    }
    const message = committed.payload.value.payload.value.message;
    if (!message) throw new Error('missing message');
    restored.messages = [message];

    projector.applySnapshot(restored, 1n);

    expect(projector.state.transientResponses).toEqual([]);
    expect(projector.state.snapshot?.messages[0]?.content).toBe('persisted text');
    expect(projector.state.snapshot?.messages[0]?.contentBlocks).toEqual([]);
  });

  it('rejects deltas from another Thread', () => {
    const projector = newProjector();
    const foreign = thinkingDelta(1n, 0, 'foreign');
    if (foreign.payload.case !== 'thinkingDelta') throw new Error('missing Thinking delta');
    foreign.payload.value.threadId = 'thread-2';

    expect(() => projector.applyWatchResponse(foreign)).toThrow(UnsupportedEventError);
    expect(projector.state.transientResponses).toEqual([]);
  });

  it('clears temporary Thinking immediately on disconnect before the committed response arrives', async () => {
    const states: ThreadSyncState[] = [];
    let connections = 0;
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        getThread: () => ({ snapshot: emptySnapshot(), throughSeq: 0n }),
      });
      router.service(EventService, {
        async *watchThread(_request, context) {
          connections += 1;
          if (connections === 1) {
            yield thinkingDelta(1n, 0, 'disconnect reasoning');
            throw new ConnectError('connection lost', Code.Unavailable);
          }
          yield messageCommitted(1n, false);
          await abortWhenCancelled(context.signal);
        },
      });
    });
    const synchronizer = new ThreadSynchronizer({
      clients: createKairosClients({ transport }),
      retryDelayMs: 1,
      maxRetryDelayMs: 2,
      onChange: (state) => states.push(state),
    });
    try {
      synchronizer.start(threadId);
      await vi.waitFor(() => {
        expect(synchronizer.state.snapshot?.messages).toHaveLength(1);
      });

      expect(
        states.some((state) =>
          state.transientResponses[0]?.contentBlocks.some(
            (block) => block.text === 'disconnect reasoning',
          ),
        ),
      ).toBe(true);
      expect(
        states.some(
          (state) => state.status === 'reconnecting' && state.transientResponses.length === 0,
        ),
      ).toBe(true);
      expect(synchronizer.state.transientResponses).toEqual([]);
      expect(synchronizer.state.snapshot?.messages[0]?.contentBlocks).toEqual([]);
    } finally {
      synchronizer.stop();
    }
  });

  it('clears temporary Thinking during manual reload loading and snapshot failure states', async () => {
    const states: ThreadSyncState[] = [];
    let snapshotReads = 0;
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        getThread: () => {
          snapshotReads += 1;
          if (snapshotReads > 1) throw new ConnectError('refresh failed', Code.Unavailable);
          return { snapshot: emptySnapshot(), throughSeq: 0n };
        },
      });
      router.service(EventService, {
        async *watchThread(_request, context) {
          yield thinkingDelta(1n, 0, 'reasoning before reload');
          await abortWhenCancelled(context.signal);
        },
      });
    });
    const synchronizer = new ThreadSynchronizer({
      clients: createKairosClients({ transport }),
      onChange: (state) => states.push(state),
    });
    try {
      synchronizer.start(threadId);
      await vi.waitFor(() => {
        expect(synchronizer.state.transientResponses[0]?.contentBlocks[0]?.text).toBe(
          'reasoning before reload',
        );
      });

      const stateCount = states.length;
      const reloading = synchronizer.reload();
      expect(synchronizer.state.status).toBe('loading');
      expect(synchronizer.state.transientResponses).toEqual([]);
      await reloading;

      expect(synchronizer.state.status).toBe('error');
      expect(synchronizer.state.transientResponses).toEqual([]);
      expect(
        states
          .slice(stateCount)
          .filter((state) => state.status === 'loading' || state.status === 'error')
          .every((state) => state.transientResponses.length === 0),
      ).toBe(true);
    } finally {
      synchronizer.stop();
    }
  });

  it('clears temporary Thinking before a manual reload snapshot arrives', async () => {
    const states: ThreadSyncState[] = [];
    let snapshotReads = 0;
    let connections = 0;
    let resolveSnapshot:
      | ((value: { snapshot: ReturnType<typeof emptySnapshot>; throughSeq: bigint }) => void)
      | undefined;
    const pendingSnapshot = new Promise<{
      snapshot: ReturnType<typeof emptySnapshot>;
      throughSeq: bigint;
    }>((resolve) => {
      resolveSnapshot = resolve;
    });
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        getThread: () => {
          snapshotReads += 1;
          return snapshotReads === 1
            ? { snapshot: emptySnapshot(), throughSeq: 0n }
            : pendingSnapshot;
        },
      });
      router.service(EventService, {
        async *watchThread(_request, context) {
          connections += 1;
          if (connections === 1) yield thinkingDelta(1n, 0, 'reasoning before reload');
          await abortWhenCancelled(context.signal);
        },
      });
    });
    const synchronizer = new ThreadSynchronizer({
      clients: createKairosClients({ transport }),
      onChange: (state) => states.push(state),
    });
    try {
      synchronizer.start(threadId);
      await vi.waitFor(() => {
        expect(synchronizer.state.transientResponses[0]?.contentBlocks[0]?.text).toBe(
          'reasoning before reload',
        );
      });

      const stateCount = states.length;
      const reloading = synchronizer.reload();
      expect(synchronizer.state.status).toBe('loading');
      expect(synchronizer.state.transientResponses).toEqual([]);
      expect(
        states
          .slice(stateCount)
          .filter((state) => state.status === 'loading')
          .every((state) => state.transientResponses.length === 0),
      ).toBe(true);

      resolveSnapshot?.({ snapshot: emptySnapshot(), throughSeq: 0n });
      await reloading;
      expect(synchronizer.state.status).toBe('live');
      expect(synchronizer.state.transientResponses).toEqual([]);
    } finally {
      synchronizer.stop();
    }
  });
});
