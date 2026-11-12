import {
  create,
  type Message,
  MessageRole,
  MessageSchema,
  PersistedThreadEventSchema,
  type Recap,
  RecapSchema,
  RecapValidity,
  ThreadSnapshotSchema,
  WatchThreadResponseSchema,
} from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RecapLine } from './conversation.js';
import { projectConversation } from './response-projection.js';
import { ThreadProjector } from './thread-projection.js';

const threadId = 'thread-1';

function message(messageId: string, seq: bigint, agentId = 'thread'): Message {
  return create(MessageSchema, {
    messageId,
    threadId,
    agentId,
    seq,
    role: MessageRole.ASSISTANT,
    content: messageId,
  });
}

function recap(
  recapId: string,
  sourceMessageSeqs: readonly bigint[],
  content = '完成区间概述',
  agentId = 'thread',
): Recap {
  const sourceSeqStart = sourceMessageSeqs[0] ?? 1n;
  const sourceSeqEnd = sourceMessageSeqs.at(-1) ?? sourceSeqStart;
  return create(RecapSchema, {
    recapId,
    threadId,
    agentId,
    seq: 1n,
    sourceSeqStart,
    sourceSeqEnd,
    sourceMessageSeqs: [...sourceMessageSeqs],
    content,
    validity: RecapValidity.VALID,
    createdAt: { seconds: 1n, nanos: 0 },
  });
}

function snapshot(recaps: readonly Recap[]) {
  return create(ThreadSnapshotSchema, {
    thread: { threadId, title: '会话', seq: 1n },
    messages: [message('message-1', 1n), message('message-2', 2n)],
    recaps: [...recaps],
  });
}

function recapEvent(eventId: string, seq: bigint, payload: 'created' | 'invalidated') {
  const value = recap('recap-1', [1n, 2n]);
  return create(WatchThreadResponseSchema, {
    payload: {
      case: 'event',
      value: create(PersistedThreadEventSchema, {
        eventId,
        threadId,
        seq,
        payload:
          payload === 'created'
            ? { case: 'recapCreated', value: { recap: value } }
            : {
                case: 'recapInvalidated',
                value: { recapId: value.recapId, reason: 'source_revised' },
              },
      }),
    },
  });
}

describe('Recap conversation projection', () => {
  it('places actual content after its source boundary and deduplicates recap ids', () => {
    const valid = recap('recap-valid', [1n, 2n]);
    const items = projectConversation({
      threadId,
      messages: [message('message-1', 1n), message('message-2', 2n), message('message-3', 3n)],
      transientResponses: [],
      runs: [],
      recaps: [
        valid,
        valid,
        recap('recap-other-agent', [1n, 2n], '其他 Agent', 'subagent-1'),
        recap('recap-stale', [9n], '失效来源'),
        create(RecapSchema, {
          ...recap('recap-invalid', [1n, 2n]),
          validity: RecapValidity.INVALID,
        }),
      ],
    });

    expect(items.map((item) => item.key)).toEqual([
      'message-1',
      'message-2',
      'recap:recap-valid',
      'message-3',
    ]);
    const projected = items.find((item) => item.kind === 'recap');
    expect(projected?.kind === 'recap' && projected.value.content).toBe('完成区间概述');

    const invalidated = projectConversation({
      threadId,
      messages: [message('message-1', 1n), message('message-2', 2n)],
      transientResponses: [],
      runs: [],
      recaps: [valid],
      invalidatedRecaps: { 'recap-valid': 'source_revised' },
    });
    expect(invalidated.some((item) => item.kind === 'recap')).toBe(false);
  });

  it('renders a subdued plain-text Recap line with the persisted content', () => {
    const html = renderToStaticMarkup(
      createElement(RecapLine, { recap: recap('recap-1', [1n, 2n], '实际生成正文') }),
    );
    expect(html).toContain('tool-operation recap-line');
    expect(html).toContain('Recap：实际生成正文');
    expect(html).toContain('data-recap-id="recap-1"');
  });
});

describe('Recap Thread projection', () => {
  it('merges snapshot pages, deduplicates events and removes invalidated content', () => {
    const projector = new ThreadProjector(threadId);
    const value = recap('recap-1', [1n, 2n]);
    projector.applySnapshot(snapshot([]), 0n);
    projector.applySnapshotPage(create(ThreadSnapshotSchema, { recaps: [value] }), 0n);
    expect(projector.state.snapshot?.recaps).toHaveLength(1);

    const created = recapEvent('created-1', 1n, 'created');
    projector.applyWatchResponse(created);
    projector.applyWatchResponse(created);
    expect(projector.state.snapshot?.recaps).toHaveLength(1);
    expect(projector.state.snapshot?.recaps[0]?.content).toBe('完成区间概述');

    projector.applyWatchResponse(recapEvent('invalidated-1', 2n, 'invalidated'));
    expect(projector.state.snapshot?.recaps).toEqual([]);
    expect(projector.state.invalidatedRecaps['recap-1']).toBe('source_revised');
    projector.applyWatchResponse(created);
    expect(projector.state.snapshot?.recaps).toEqual([]);
  });

  it('replaces event-derived Recaps with the confirmed snapshot after reconnect', () => {
    const projector = new ThreadProjector(threadId);
    projector.applySnapshot(snapshot([]), 0n);
    projector.applyWatchResponse(recapEvent('created-1', 1n, 'created'));
    expect(projector.state.snapshot?.recaps).toHaveLength(1);

    projector.applySnapshot(snapshot([]), 10n);
    expect(projector.state.snapshot?.recaps).toEqual([]);
    expect(projector.state.invalidatedRecaps).toEqual({});

    projector.applySnapshot(snapshot([recap('recap-1', [1n, 2n], '快照正文')]), 20n);
    expect(projector.state.snapshot?.recaps.map((item) => item.content)).toEqual(['快照正文']);
  });
});
