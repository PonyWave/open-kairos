import { createRouterTransport } from '@connectrpc/connect';
import {
  ContentBlockSchema,
  ContentBlockType,
  create,
  EventService,
  type Message,
  MessageRole,
  MessageSchema,
  type Run,
  RunSchema,
  RunStatus,
  ThreadSchema,
  ThreadService,
  ThreadSnapshotSchema,
  ThreadType,
  type WatchThreadResponse,
  WatchThreadResponseSchema,
} from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { createKairosClients } from './client.js';
import { ThreadSynchronizer, type ThreadSyncState } from './thread-sync.js';

const threadId = 'thread-1';
const baseSeq = 100n;
const thread = create(ThreadSchema, {
  threadId,
  title: '当前视图恢复',
  seq: 1n,
  threadType: ThreadType.TASK,
});

function message(
  messageId: string,
  seq: bigint,
  content: string,
  contentBlocks: Array<{ type: ContentBlockType; blockIndex: number; text: string }> = [],
  revisionId?: string,
): Message {
  return create(MessageSchema, {
    messageId,
    threadId,
    agentId: 'thread',
    seq,
    role: messageId === 'user-1' ? MessageRole.USER : MessageRole.ASSISTANT,
    content,
    contentBlocks: contentBlocks.map((block) => create(ContentBlockSchema, block)),
    ...(revisionId === undefined ? {} : { revisionId }),
  });
}

function run(runId: string, status: RunStatus, supersededByRunId?: string): Run {
  return create(RunSchema, {
    runId,
    threadId,
    status,
    ...(supersededByRunId === undefined ? {} : { supersededByRunId }),
  });
}

function snapshot(throughSeq: bigint, messages: Message[], runs: Run[] = []) {
  return {
    snapshot: create(ThreadSnapshotSchema, {
      thread,
      messages,
      inputs: [],
      runs,
      devices: [],
      queueVersion: 0n,
    }),
    throughSeq,
  };
}

function viewEvent(seq: bigint, viewVersion: bigint): WatchThreadResponse {
  return create(WatchThreadResponseSchema, {
    payload: {
      case: 'event',
      value: {
        eventId: `view-${seq}`,
        threadId,
        seq,
        payload: {
          case: 'contextViewChanged',
          value: { agentId: 'thread', viewVersion, anchorMessageSeq: 1n },
        },
      },
    },
  });
}

function reviseEvent(seq: bigint, revisionId: string, text: string): WatchThreadResponse {
  return create(WatchThreadResponseSchema, {
    payload: {
      case: 'event',
      value: {
        eventId: `revise-${seq}`,
        threadId,
        seq,
        payload: {
          case: 'messageRevised',
          value: {
            messageId: 'user-1',
            revision: { revisionId, messageId: 'user-1', text },
          },
        },
      },
    },
  });
}

function committedEvent(seq: bigint, value: Message): WatchThreadResponse {
  return create(WatchThreadResponseSchema, {
    payload: {
      case: 'event',
      value: {
        eventId: `message-${seq}`,
        threadId,
        seq,
        payload: { case: 'messageCommitted', value: { message: value } },
      },
    },
  });
}

function runEvent(seq: bigint, value: Run): WatchThreadResponse {
  return create(WatchThreadResponseSchema, {
    payload: {
      case: 'event',
      value: {
        eventId: `run-${seq}`,
        threadId,
        seq,
        payload: { case: 'runChanged', value: { run: value } },
      },
    },
  });
}

function textDelta(deltaSeq: bigint, text: string, messageId: string): WatchThreadResponse {
  return create(WatchThreadResponseSchema, {
    payload: {
      case: 'textDelta',
      value: { threadId, messageId, deltaSeq, blockIndex: 1, text, runId: 'run-2' },
    },
  });
}

function thinkingDelta(deltaSeq: bigint, text: string, messageId: string): WatchThreadResponse {
  return create(WatchThreadResponseSchema, {
    payload: {
      case: 'thinkingDelta',
      value: { threadId, messageId, deltaSeq, blockIndex: 0, text, runId: 'run-2' },
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

it('restores the exact snapshot after Revise and keeps applying Thinking deltas', async () => {
  const original = message('user-1', 1n, '原始问题');
  const revised = message('user-1', 1n, '修订问题', [], 'revision-1');
  const response = message('response-1', 2n, '新回答', [
    { type: ContentBlockType.THINKING, blockIndex: 0, text: '新思考' },
    { type: ContentBlockType.TEXT, blockIndex: 1, text: '新回答' },
  ]);
  const collapsedMessageIds = new Set([original.messageId]);
  let snapshotReads = 0;
  const afterSeqs: bigint[] = [];
  const states: ThreadSyncState[] = [];
  const transport = createRouterTransport((router) => {
    router.service(ThreadService, {
      getThread: () => {
        snapshotReads += 1;
        return snapshotReads === 1
          ? snapshot(baseSeq, [original], [run('run-1', RunStatus.COMPLETED)])
          : snapshot(baseSeq + 2n, [revised], [run('run-1', RunStatus.COMPLETED)]);
      },
    });
    router.service(EventService, {
      async *watchThread(request, context) {
        afterSeqs.push(request.afterSeq);
        yield reviseEvent(baseSeq + 1n, 'revision-1', '修订问题');
        yield viewEvent(baseSeq + 2n, 1n);
        yield thinkingDelta(1n, '新思考', response.messageId);
        yield textDelta(2n, '新回答', response.messageId);
        yield committedEvent(baseSeq + 3n, response);
        yield runEvent(baseSeq + 4n, run('run-2', RunStatus.COMPLETED));
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
      expect(synchronizer.state.throughSeq).toBe(baseSeq + 4n);
      expect(synchronizer.state.snapshot?.messages).toHaveLength(2);
    });

    expect(synchronizer.state.error).toBeNull();
    expect(synchronizer.state.status).toBe('live');
    expect(snapshotReads).toBe(2);
    expect(afterSeqs).toEqual([baseSeq]);
    expect(synchronizer.state.snapshot?.messages[0]).toMatchObject({
      messageId: original.messageId,
      content: '修订问题',
      revisionId: 'revision-1',
    });
    expect(collapsedMessageIds.has(synchronizer.state.snapshot?.messages[0]?.messageId ?? '')).toBe(
      true,
    );
    expect(synchronizer.state.snapshot?.messages[1]?.contentBlocks).toMatchObject([
      { type: ContentBlockType.THINKING, text: '新思考' },
      { type: ContentBlockType.TEXT, text: '新回答' },
    ]);
    expect(
      states.some((state) =>
        state.transientResponses[0]?.contentBlocks.some((block) => block.text === '新思考'),
      ),
    ).toBe(true);
    expect(synchronizer.state.transientResponses).toEqual([]);
  } finally {
    synchronizer.stop();
  }
});

it('restores Rerun without reloading historical view events again', async () => {
  const anchor = message('user-1', 1n, '原始问题');
  const oldResponse = message('old-response', 2n, '旧回答');
  const newResponse = message('new-response', 3n, '新回答');
  const streaming = message('streaming-response', 4n, '后续回答', [
    { type: ContentBlockType.THINKING, blockIndex: 0, text: '后续思考' },
    { type: ContentBlockType.TEXT, blockIndex: 1, text: '后续回答' },
  ]);
  let snapshotReads = 0;
  const afterSeqs: bigint[] = [];
  const transport = createRouterTransport((router) => {
    router.service(ThreadService, {
      getThread: () => {
        snapshotReads += 1;
        return snapshotReads === 1
          ? snapshot(baseSeq, [anchor, oldResponse], [run('run-1', RunStatus.COMPLETED)])
          : snapshot(
              baseSeq + 5n,
              [anchor, newResponse],
              [run('run-1', RunStatus.COMPLETED, 'run-2'), run('run-2', RunStatus.COMPLETED)],
            );
      },
    });
    router.service(EventService, {
      async *watchThread(request, context) {
        afterSeqs.push(request.afterSeq);
        yield runEvent(baseSeq + 1n, run('run-2', RunStatus.QUEUED));
        yield viewEvent(baseSeq + 2n, 1n);
        yield committedEvent(baseSeq + 3n, newResponse);
        yield runEvent(baseSeq + 4n, run('run-2', RunStatus.COMPLETED));
        yield viewEvent(baseSeq + 5n, 2n);
        yield thinkingDelta(1n, '后续思考', streaming.messageId);
        yield textDelta(2n, '后续回答', streaming.messageId);
        yield committedEvent(baseSeq + 6n, streaming);
        yield runEvent(baseSeq + 7n, run('run-3', RunStatus.COMPLETED));
        await abortWhenCancelled(context.signal);
      },
    });
  });
  const synchronizer = new ThreadSynchronizer({
    clients: createKairosClients({ transport }),
  });
  try {
    synchronizer.start(threadId);
    await vi.waitFor(() => {
      expect(synchronizer.state.throughSeq).toBe(baseSeq + 7n);
      expect(synchronizer.state.snapshot?.messages).toHaveLength(3);
    });

    expect(synchronizer.state.error).toBeNull();
    expect(synchronizer.state.status).toBe('live');
    expect(snapshotReads).toBe(2);
    expect(afterSeqs).toEqual([baseSeq]);
    expect(synchronizer.state.snapshot?.messages.map((item) => item.messageId)).toEqual([
      anchor.messageId,
      newResponse.messageId,
      streaming.messageId,
    ]);
    expect(synchronizer.state.snapshot?.messages.some((item) => item.content === '旧回答')).toBe(
      false,
    );
    expect(synchronizer.state.snapshot?.messages[2]?.contentBlocks).toMatchObject([
      { type: ContentBlockType.THINKING, text: '后续思考' },
      { type: ContentBlockType.TEXT, text: '后续回答' },
    ]);
    expect(synchronizer.state.transientResponses).toEqual([]);
  } finally {
    synchronizer.stop();
  }
});
