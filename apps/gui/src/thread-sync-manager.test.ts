import { createRouterTransport } from '@connectrpc/connect';
import { EnvironmentKind, EventService, MessageRole, ThreadService } from '@kairos/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createKairosClients } from './client.js';
import { ThreadSyncManager } from './thread-sync-manager.js';

const threadId = 'shared-thread';

function deferred<T = void>() {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

function snapshot(content: string) {
  return {
    snapshot: {
      thread: { threadId, title: '共享会话' },
      mainEnvironment: {
        envId: 'main',
        name: content,
        kind: EnvironmentKind.SELF_HOSTED_LINUX,
      },
      messages: [
        {
          messageId: 'initial-message',
          threadId,
          agentId: 'thread',
          seq: 1n,
          role: MessageRole.USER,
          content,
        },
      ],
    },
    throughSeq: 0n,
  };
}

function messageEvent(content: string) {
  return {
    payload: {
      case: 'event' as const,
      value: {
        eventId: 'child-result',
        threadId,
        seq: 1n,
        payload: {
          case: 'messageCommitted' as const,
          value: {
            message: {
              messageId: 'child-result',
              threadId,
              agentId: 'child-agent',
              seq: 1n,
              role: MessageRole.ASSISTANT,
              content,
            },
          },
        },
      },
    },
  };
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

describe('account-owned ThreadSyncManager', () => {
  it('shares one bootstrap and stream, retains one subscriber and stops after the final release', async () => {
    const event = deferred();
    let snapshotReads = 0;
    const watchSignals: AbortSignal[] = [];
    const clients = createKairosClients({
      transport: createRouterTransport((router) => {
        router.service(ThreadService, {
          getThread: () => {
            snapshotReads += 1;
            return snapshot('shared root message');
          },
        });
        router.service(EventService, {
          async *watchThread(_request, context) {
            watchSignals.push(context.signal);
            await event.promise;
            yield messageEvent('shared child result');
            await untilAborted(context.signal);
          },
        });
      }),
    });
    const manager = new ThreadSyncManager(clients);
    const first = vi.fn();
    const second = vi.fn();
    const snapshots = vi.fn();
    manager.observeSnapshots(snapshots);
    const releaseFirst = manager.subscribe(threadId, first);
    const releaseSecond = manager.subscribe(threadId, second);
    try {
      await vi.waitFor(() => expect(watchSignals).toHaveLength(1));
      expect(snapshotReads).toBe(1);
      expect(first.mock.lastCall?.[0]).toBe(second.mock.lastCall?.[0]);
      expect(snapshots).toHaveBeenCalledTimes(1);

      releaseFirst();
      releaseFirst();
      const firstCalls = first.mock.calls.length;
      expect(watchSignals[0]?.aborted).toBe(false);
      event.resolve();
      await vi.waitFor(() => expect(second.mock.lastCall?.[0].throughSeq).toBe(1n));
      expect(first).toHaveBeenCalledTimes(firstCalls);
      expect(second.mock.lastCall?.[0].snapshot.messages).toHaveLength(2);
      expect(snapshots).toHaveBeenCalledTimes(2);

      releaseSecond();
      expect(watchSignals[0]?.aborted).toBe(true);
    } finally {
      event.resolve();
      releaseFirst();
      releaseSecond();
      manager.stop();
    }
  });

  it('merges reloads from both views into one refresh and one replacement stream', async () => {
    const refreshed = deferred<ReturnType<typeof snapshot>>();
    let snapshotReads = 0;
    const watchSignals: AbortSignal[] = [];
    const manager = new ThreadSyncManager(
      createKairosClients({
        transport: createRouterTransport((router) => {
          router.service(ThreadService, {
            getThread: () => {
              snapshotReads += 1;
              return snapshotReads === 1 ? snapshot('initial') : refreshed.promise;
            },
          });
          router.service(EventService, {
            async *watchThread(_request, context) {
              watchSignals.push(context.signal);
              await untilAborted(context.signal);
              yield* [];
            },
          });
        }),
      }),
    );
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = manager.subscribe(threadId, first);
    const releaseSecond = manager.subscribe(threadId, second);
    try {
      await vi.waitFor(() => expect(watchSignals).toHaveLength(1));
      const firstReload = manager.reload(threadId);
      const secondReload = manager.reload(threadId);
      expect(firstReload).toBe(secondReload);
      await vi.waitFor(() => expect(snapshotReads).toBe(2));
      expect(watchSignals[0]?.aborted).toBe(true);
      refreshed.resolve(snapshot('refreshed'));
      await Promise.all([firstReload, secondReload]);
      await vi.waitFor(() => expect(watchSignals).toHaveLength(2));
      expect(snapshotReads).toBe(2);
      expect(first.mock.lastCall?.[0]).toBe(second.mock.lastCall?.[0]);
      expect(first.mock.lastCall?.[0].snapshot.messages[0].content).toBe('refreshed');
    } finally {
      refreshed.resolve(snapshot('cleanup'));
      releaseFirst();
      releaseSecond();
      manager.stop();
    }
  });

  it('clears the old account and ignores late stream events for the same Thread id', async () => {
    const lateEvent = deferred();
    const old = vi.fn();
    const current = vi.fn();
    const oldSnapshots = vi.fn();
    let snapshotReads = 0;
    let lateEventSent = false;
    const watchSignals: AbortSignal[] = [];
    const clients = createKairosClients({
      transport: createRouterTransport((router) => {
        router.service(ThreadService, {
          getThread: () => snapshot(++snapshotReads === 1 ? 'account A' : 'account B'),
        });
        router.service(EventService, {
          async *watchThread(_request, context) {
            watchSignals.push(context.signal);
            if (watchSignals.length === 1) {
              await lateEvent.promise;
              lateEventSent = true;
              yield messageEvent('late account A');
              yield {
                payload: {
                  case: 'event',
                  value: {
                    eventId: 'late-platform-a',
                    threadId,
                    seq: 2n,
                    payload: {
                      case: 'mainEnvironmentChanged',
                      value: {
                        envId: 'main',
                        name: 'late account A',
                        kind: EnvironmentKind.SELF_HOSTED_LINUX,
                      },
                    },
                  },
                },
              };
            }
            await untilAborted(context.signal);
          },
        });
      }),
    });
    const previousAccount = new ThreadSyncManager(clients);
    const nextAccount = new ThreadSyncManager(clients);
    previousAccount.observeSnapshots(oldSnapshots);
    previousAccount.subscribe(threadId, old);
    try {
      await vi.waitFor(() => expect(watchSignals).toHaveLength(1));
      previousAccount.stop();
      const oldCalls = old.mock.calls.length;
      const oldSnapshotCalls = oldSnapshots.mock.calls.length;
      expect(watchSignals[0]?.aborted).toBe(true);
      nextAccount.subscribe(threadId, current);
      await vi.waitFor(() => expect(watchSignals).toHaveLength(2));
      lateEvent.resolve();
      await vi.waitFor(() => expect(lateEventSent).toBe(true));

      expect(old).toHaveBeenCalledTimes(oldCalls);
      expect(oldSnapshots).toHaveBeenCalledTimes(oldSnapshotCalls);
      expect(
        current.mock.lastCall?.[0].snapshot.messages.map(
          (message: { content: string }) => message.content,
        ),
      ).toEqual(['account B']);
      expect(current.mock.lastCall?.[0].throughSeq).toBe(0n);
      expect(current.mock.lastCall?.[0].snapshot.mainEnvironment.name).toBe('account B');
    } finally {
      lateEvent.resolve();
      previousAccount.stop();
      nextAccount.stop();
    }
  });

  it('aborts an old pending bootstrap without installing its late page in the next account', async () => {
    const oldPage = deferred<ReturnType<typeof snapshot>>();
    const old = vi.fn();
    const current = vi.fn();
    const signals: AbortSignal[] = [];
    let first = true;
    const clients = createKairosClients({
      transport: createRouterTransport((router) => {
        router.service(ThreadService, {
          getThread: (_request, context) => {
            signals.push(context.signal);
            if (first) {
              first = false;
              return oldPage.promise;
            }
            return snapshot('account B');
          },
        });
        router.service(EventService, {
          async *watchThread(_request, context) {
            await untilAborted(context.signal);
            yield* [];
          },
        });
      }),
    });
    const previousAccount = new ThreadSyncManager(clients);
    const nextAccount = new ThreadSyncManager(clients);
    previousAccount.subscribe(threadId, old);
    try {
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      previousAccount.stop();
      const oldCalls = old.mock.calls.length;
      expect(signals[0]?.aborted).toBe(true);
      nextAccount.subscribe(threadId, current);
      await vi.waitFor(() => expect(current.mock.lastCall?.[0].status).toBe('live'));
      oldPage.resolve(snapshot('late account A'));
      await oldPage.promise;

      expect(old).toHaveBeenCalledTimes(oldCalls);
      expect(current.mock.lastCall?.[0].snapshot.messages[0].content).toBe('account B');
      expect(current.mock.lastCall?.[0].snapshot.mainEnvironment.name).toBe('account B');
    } finally {
      oldPage.resolve(snapshot('cleanup'));
      previousAccount.stop();
      nextAccount.stop();
    }
  });
});
