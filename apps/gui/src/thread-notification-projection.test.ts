import {
  create,
  DelegationReferenceSchema,
  MessageRole,
  MessageSchema,
  MessageSource,
  ThreadNotificationSchema,
  ThreadNotificationStatus,
  ThreadSchema,
  ThreadSnapshotSchema,
  WatchThreadResponseSchema,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { ThreadProjector, UnsupportedEventError } from './thread-projection.js';

const delegation = create(DelegationReferenceSchema, {
  sourceThreadId: 'task-1',
  sourceAgentId: 'thread',
  sourceToolCallId: 'notify-1',
});

function notification(status: ThreadNotificationStatus) {
  return create(ThreadNotificationSchema, {
    delegation,
    sourceRunId: 'task-run-1',
    replyThreadId: 'main-1',
    content: '通知正文',
    status,
    ...(status === ThreadNotificationStatus.CONSUMED
      ? { contextMessageSeq: 4n, runId: 'main-run-1' }
      : {}),
  });
}

function notificationEvent(status: ThreadNotificationStatus) {
  return create(WatchThreadResponseSchema, {
    payload: {
      case: 'event',
      value: {
        eventId: `notification-${status}`,
        threadId: 'task-1',
        seq: 1n,
        payload: {
          case: 'threadNotificationChanged',
          value: { notification: notification(status) },
        },
      },
    },
  });
}

describe('thread notification snapshot and event projection', () => {
  it('deduplicates notification pages and restores consumed status from Watch', () => {
    const projector = new ThreadProjector('task-1');
    projector.applySnapshot(
      create(ThreadSnapshotSchema, {
        thread: create(ThreadSchema, { threadId: 'task-1', title: '通知话题' }),
        notifications: [notification(ThreadNotificationStatus.PENDING)],
      }),
      0n,
    );
    projector.applySnapshotPage(
      create(ThreadSnapshotSchema, {
        notifications: [notification(ThreadNotificationStatus.QUEUED)],
      }),
      0n,
    );
    expect(projector.state.snapshot?.notifications).toHaveLength(1);
    expect(projector.state.snapshot?.notifications[0]?.status).toBe(
      ThreadNotificationStatus.QUEUED,
    );
    projector.applyWatchResponse(notificationEvent(ThreadNotificationStatus.CONSUMED));
    expect(projector.state.snapshot?.notifications).toHaveLength(1);
    expect(projector.state.snapshot?.notifications[0]).toMatchObject({
      status: ThreadNotificationStatus.CONSUMED,
      contextMessageSeq: 4n,
      runId: 'main-run-1',
    });
    expect(projector.state.throughSeq).toBe(1n);
  });

  it('accepts the dedicated main message source and rejects unknown notification states', () => {
    const main = new ThreadProjector('main-1');
    main.applySnapshot(
      create(ThreadSnapshotSchema, {
        thread: create(ThreadSchema, { threadId: 'main-1', title: '主对话' }),
      }),
      0n,
    );
    main.applyWatchResponse(
      create(WatchThreadResponseSchema, {
        payload: {
          case: 'event',
          value: {
            eventId: 'main-notification-message',
            threadId: 'main-1',
            seq: 1n,
            payload: {
              case: 'messageCommitted',
              value: {
                message: create(MessageSchema, {
                  messageId: 'main-notification-1',
                  threadId: 'main-1',
                  agentId: 'thread',
                  role: MessageRole.USER,
                  source: MessageSource.THREAD_NOTIFICATION,
                  sourceThreadId: 'task-1',
                  delegation,
                  content: '{"kind":"thread_notification","message":"通知正文"}',
                }),
              },
            },
          },
        },
      }),
    );
    expect(main.state.snapshot?.messages[0]?.source).toBe(MessageSource.THREAD_NOTIFICATION);
    const invalid = new ThreadProjector('task-1');
    expect(() =>
      invalid.applySnapshot(
        create(ThreadSnapshotSchema, {
          thread: create(ThreadSchema, { threadId: 'task-1' }),
          notifications: [notification(999 as ThreadNotificationStatus)],
        }),
        0n,
      ),
    ).toThrow(UnsupportedEventError);
  });
});
