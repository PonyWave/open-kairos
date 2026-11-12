import { createRouterTransport } from '@connectrpc/connect';
import {
  AutomationService,
  create,
  EventService,
  MessageRole,
  MessageSchema,
  MessageSource,
  ThreadSchema,
  ThreadService,
  ThreadType,
} from '@kairos/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createKairosClients } from './client.js';
import { ThreadSyncManager } from './thread-sync-manager.js';

const hiddenThread = create(ThreadSchema, {
  threadId: 'hidden-1',
  title: '定时执行历史',
  seq: 1n,
  threadType: ThreadType.TASK,
  automationOnly: true,
});
const initialMessage = create(MessageSchema, {
  messageId: 'message-1',
  threadId: 'hidden-1',
  agentId: 'thread',
  seq: 1n,
  role: MessageRole.USER,
  source: MessageSource.AUTOMATION,
  content: '定时 prompt',
});

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

describe('Automation-only Thread history synchronization', () => {
  it('uses the authorized snapshot and schedule-scoped event stream without ordinary reads', async () => {
    const ordinaryRead = vi.fn();
    const snapshotRequests: { scheduleId: string; threadId: string; limit: number | undefined }[] =
      [];
    const watchRequests: {
      threadId: string;
      afterSeq: bigint;
      scheduleId?: string | undefined;
    }[] = [];
    const clients = createKairosClients({
      transport: createRouterTransport((router) => {
        router.service(ThreadService, {
          getThread(request) {
            ordinaryRead(request);
            throw new Error('ordinary snapshot must not be used');
          },
        });
        router.service(AutomationService, {
          getAutomationThread(request) {
            snapshotRequests.push({
              scheduleId: request.scheduleId,
              threadId: request.threadId,
              limit: request.limit,
            });
            return {
              snapshot: {
                thread: hiddenThread,
                messages: [initialMessage],
                inputs: [],
                runs: [],
                recaps: [],
              },
              throughSeq: 0n,
              hasMore: false,
            };
          },
        });
        router.service(EventService, {
          async *watchThread(request, context) {
            watchRequests.push({
              threadId: request.threadId,
              afterSeq: request.afterSeq,
              scheduleId: request.scheduleId,
            });
            yield {
              payload: {
                case: 'event' as const,
                value: {
                  eventId: 'event-1',
                  threadId: 'hidden-1',
                  seq: 1n,
                  payload: {
                    case: 'messageCommitted' as const,
                    value: {
                      message: create(MessageSchema, {
                        messageId: 'message-2',
                        threadId: 'hidden-1',
                        agentId: 'thread',
                        seq: 2n,
                        role: MessageRole.ASSISTANT,
                        content: '真实事件回复',
                      }),
                    },
                  },
                },
              },
            };
            await untilAborted(context.signal);
          },
        });
      }),
    });
    const manager = new ThreadSyncManager(clients);
    const listener = vi.fn();
    const release = manager.subscribe('hidden-1', listener, 'schedule-1');
    try {
      await vi.waitFor(() => {
        expect(listener.mock.lastCall?.[0].throughSeq).toBe(1n);
      });
      expect(ordinaryRead).not.toHaveBeenCalled();
      expect(snapshotRequests).toEqual([
        { scheduleId: 'schedule-1', threadId: 'hidden-1', limit: 100 },
      ]);
      expect(watchRequests).toEqual([
        { threadId: 'hidden-1', afterSeq: 0n, scheduleId: 'schedule-1' },
      ]);
      expect(listener.mock.lastCall?.[0].snapshot.thread.automationOnly).toBe(true);
      expect(
        listener.mock.lastCall?.[0].snapshot.messages.map(
          (message: { content: string }) => message.content,
        ),
      ).toEqual(['定时 prompt', '真实事件回复']);
    } finally {
      release();
      manager.stop();
    }
  });

  it('does not share a hidden Thread cursor between different schedule grants', async () => {
    const snapshots: string[] = [];
    const watches: (string | undefined)[] = [];
    const clients = createKairosClients({
      transport: createRouterTransport((router) => {
        router.service(AutomationService, {
          getAutomationThread(request) {
            snapshots.push(request.scheduleId);
            return {
              snapshot: { thread: hiddenThread, messages: [initialMessage] },
              throughSeq: 0n,
              hasMore: false,
            };
          },
        });
        router.service(EventService, {
          async *watchThread(request, context) {
            watches.push(request.scheduleId);
            await untilAborted(context.signal);
            yield* [];
          },
        });
      }),
    });
    const manager = new ThreadSyncManager(clients);
    const first = manager.subscribe('hidden-1', vi.fn(), 'schedule-1');
    const second = manager.subscribe('hidden-1', vi.fn(), 'schedule-2');
    try {
      await vi.waitFor(() => expect(watches).toHaveLength(2));
      expect(snapshots).toEqual(['schedule-1', 'schedule-2']);
      expect(new Set(watches)).toEqual(new Set(['schedule-1', 'schedule-2']));
    } finally {
      first();
      second();
      manager.stop();
    }
  });
});
