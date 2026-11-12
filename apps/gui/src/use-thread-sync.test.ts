import { createRouterTransport } from '@connectrpc/connect';
import {
  BashOperationStatus,
  create,
  EventService,
  type GetThreadResponse,
  GetThreadResponseSchema,
  MessageRole,
  ThreadSchema,
  ThreadService,
  ThreadSnapshotCursorSchema,
  ThreadSnapshotSchema,
  ThreadType,
} from '@kairos/contracts';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKairosClients } from './client.js';
import type { ThreadSyncState } from './thread-sync.js';
import { ThreadSyncManager } from './thread-sync-manager.js';
import { useThreadSync } from './use-thread-sync.js';

const threadA = create(ThreadSchema, {
  threadId: 'thread-a',
  title: 'Thread A',
  seq: 1n,
  threadType: ThreadType.TASK,
});
const threadB = create(ThreadSchema, {
  threadId: 'thread-b',
  title: 'Thread B',
  seq: 2n,
  threadType: ThreadType.TASK,
});

function deferred<T = void>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve?.(value) };
}

function snapshot(thread: typeof threadA, content: string): GetThreadResponse {
  return create(GetThreadResponseSchema, {
    snapshot: create(ThreadSnapshotSchema, {
      thread,
      messages: [
        {
          messageId: `${thread.threadId}-message`,
          threadId: thread.threadId,
          agentId: 'thread',
          seq: 1n,
          role: MessageRole.USER,
          content,
        },
      ],
      inputs: [],
      runs: [],
      devices: [],
      queueVersion: 0n,
    }),
    throughSeq: 0n,
    hasMore: false,
  });
}

function snapshotPage(content: string, hasMore: boolean): GetThreadResponse {
  const response = snapshot(threadA, content);
  response.throughSeq = 3n;
  response.hasMore = hasMore;
  if (hasMore) {
    response.nextCursor = create(ThreadSnapshotCursorSchema, {
      threadId: threadA.threadId,
      throughSeq: 3n,
    });
  }
  return response;
}

function textDelta(deltaSeq: bigint, text: string) {
  return {
    payload: {
      case: 'textDelta' as const,
      value: {
        threadId: threadA.threadId,
        messageId: 'transient-a',
        deltaSeq,
        text,
      },
    },
  };
}

function bashEvent(seq: bigint, operationId: string) {
  return {
    payload: {
      case: 'event' as const,
      value: {
        eventId: operationId,
        threadId: threadA.threadId,
        seq,
        payload: {
          case: 'bashOperationChanged' as const,
          value: {
            operation: {
              operationId,
              runId: 'run-a',
              deviceId: '',
              command: 'printf A',
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

function derivedEvent(seq: bigint) {
  return [
    {
      payload: {
        case: 'event' as const,
        value: {
          eventId: 'hard-cut-a',
          threadId: threadA.threadId,
          seq,
          payload: { case: 'hardCutStarted' as const, value: { runId: 'run-a' } },
        },
      },
    },
    {
      payload: {
        case: 'event' as const,
        value: {
          eventId: 'recap-a',
          threadId: threadA.threadId,
          seq: seq + 1n,
          payload: {
            case: 'recapInvalidated' as const,
            value: { recapId: 'recap-a', reason: 'A 的迟到失效记录' },
          },
        },
      },
    },
  ] as const;
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

function installReactDomContainer(): HTMLElement {
  const noop = () => {};
  const document = {
    nodeType: 9,
    addEventListener: noop,
    removeEventListener: noop,
    activeElement: null,
  };
  const window = {
    document,
    addEventListener: noop,
    removeEventListener: noop,
    getSelection: () => null,
    HTMLIFrameElement: class {},
    HTMLElement: class {},
  };
  const container = {
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: document,
    addEventListener: noop,
    removeEventListener: noop,
    firstChild: null,
    appendChild: <T>(child: T) => child,
    insertBefore: <T>(child: T) => child,
    removeChild: <T>(child: T) => child,
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('navigator', { userAgent: 'node' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return container as unknown as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

type ThreadSyncResult = ReturnType<typeof useThreadSync>;

function ThreadSyncProbe({
  manager,
  threadId,
  onRender,
}: {
  manager: ThreadSyncManager;
  threadId: string;
  onRender: (threadId: string, sync: ThreadSyncResult) => void;
}) {
  const sync = useThreadSync(manager, threadId);
  onRender(threadId, sync);
  return null;
}

describe('useThreadSync Thread switching', () => {
  it('shares a Thread between two mounted views until the final view unmounts', async () => {
    const container = installReactDomContainer();
    let snapshotReads = 0;
    const watchSignals: AbortSignal[] = [];
    const manager = new ThreadSyncManager(
      createKairosClients({
        transport: createRouterTransport((router) => {
          router.service(ThreadService, {
            getThread() {
              snapshotReads += 1;
              return snapshot(threadA, '共享消息');
            },
          });
          router.service(EventService, {
            async *watchThread(_request, context) {
              watchSignals.push(context.signal);
              await abortWhenCancelled(context.signal);
              yield* [];
            },
          });
        }),
      }),
    );
    const views = new Map<string, ThreadSyncResult>();
    const renderViews = (includeSubagent: boolean) =>
      createElement(
        Fragment,
        null,
        createElement(ThreadSyncProbe, {
          key: 'root',
          manager,
          threadId: threadA.threadId,
          onRender: (_threadId, sync) => views.set('root', sync),
        }),
        includeSubagent
          ? createElement(ThreadSyncProbe, {
              key: 'child',
              manager,
              threadId: threadA.threadId,
              onRender: (_threadId, sync) => views.set('child', sync),
            })
          : null,
      );
    const root = createRoot(container);
    try {
      await act(async () => root.render(renderViews(true)));
      await act(async () => {
        await vi.waitFor(() => {
          expect(views.get('root')?.state.status).toBe('live');
          expect(views.get('child')?.state.status).toBe('live');
        });
      });
      expect(snapshotReads).toBe(1);
      expect(watchSignals).toHaveLength(1);
      expect(views.get('root')?.state).toBe(views.get('child')?.state);

      await act(async () => root.render(renderViews(false)));
      expect(watchSignals[0]?.aborted).toBe(false);
      expect(views.get('root')?.state.snapshot?.messages[0]?.content).toBe('共享消息');
      expect(snapshotReads).toBe(1);
    } finally {
      await act(async () => root.unmount());
      expect(watchSignals[0]?.aborted).toBe(true);
      manager.stop();
    }
  });

  it('excludes late A pages, transient text, and event-derived data after rendering B', async () => {
    const container = installReactDomContainer();
    const latePage = deferred<GetThreadResponse>();
    const lateStream = deferred();
    let aSnapshotReads = 0;
    let lateStreamReleased = false;
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        getThread(request) {
          if (request.threadId === threadB.threadId) return snapshot(threadB, 'B 的持久消息');
          aSnapshotReads += 1;
          if (aSnapshotReads === 1) return snapshot(threadA, 'A 的持久消息');
          if (aSnapshotReads === 2) return snapshotPage('A 的刷新首页', true);
          return latePage.promise;
        },
      });
      router.service(EventService, {
        async *watchThread(request, context) {
          if (request.threadId === threadB.threadId) {
            await abortWhenCancelled(context.signal);
            return;
          }
          yield textDelta(1n, 'A 的临时文本');
          yield bashEvent(1n, 'operation-a');
          yield* derivedEvent(2n);
          await lateStream.promise;
          lateStreamReleased = true;
          yield textDelta(2n, 'A 的迟到临时文本');
          yield bashEvent(4n, 'operation-a-late');
        },
      });
    });
    const clients = createKairosClients({ transport });
    const manager = new ThreadSyncManager(clients);
    const rendered: { threadId: string; state: ThreadSyncState }[] = [];
    let latest: ThreadSyncResult | null = null;
    const onRender = (threadId: string, sync: ThreadSyncResult) => {
      latest = sync;
      rendered.push({ threadId, state: sync.state });
    };
    const readLatest = (): ThreadSyncResult => {
      if (!latest) throw new Error('Hook 尚未渲染。');
      return latest;
    };
    const renderProbe = (threadId: string) =>
      createElement(ThreadSyncProbe, { manager, threadId, onRender });

    const root = createRoot(container);
    let reloading: Promise<void> | undefined;
    try {
      await act(async () => {
        root.render(renderProbe(threadA.threadId));
      });
      await act(async () => {
        await vi.waitFor(() => {
          expect(readLatest().state.snapshot?.thread?.threadId).toBe(threadA.threadId);
          expect(readLatest().state.transientResponses[0]?.contentBlocks[0]?.text).toBe(
            'A 的临时文本',
          );
          expect(readLatest().state.bashOperations[0]?.operationId).toBe('operation-a');
          expect(readLatest().state.hardCuts[0]?.runId).toBe('run-a');
          expect(readLatest().state.invalidatedRecaps['recap-a']).toBe('A 的迟到失效记录');
        });
      });

      await act(async () => {
        reloading = readLatest().reload();
        await vi.waitFor(() => expect(aSnapshotReads).toBe(3));
      });
      const firstBRender = rendered.length;
      await act(async () => {
        root.render(renderProbe(threadB.threadId));
      });
      await act(async () => {
        await vi.waitFor(() => {
          expect(readLatest().state.snapshot?.thread?.threadId).toBe(threadB.threadId);
          expect(readLatest().state.snapshot?.messages[0]?.content).toBe('B 的持久消息');
        });
      });

      await act(async () => {
        latePage.resolve(snapshotPage('A 的迟到分页', false));
        lateStream.resolve();
        await reloading;
        await new Promise((resolve) => setTimeout(resolve, 5));
      });

      expect(lateStreamReleased).toBe(true);
      expect(readLatest().state.snapshot?.thread?.threadId).toBe(threadB.threadId);
      expect(readLatest().state.snapshot?.messages.map((message) => message.content)).toEqual([
        'B 的持久消息',
      ]);
      expect(readLatest().state.transientResponses).toEqual([]);
      expect(readLatest().state.bashOperations).toEqual([]);
      expect(readLatest().state.hardCuts).toEqual([]);
      expect(readLatest().state.invalidatedRecaps).toEqual({});
      for (const entry of rendered.slice(firstBRender)) {
        expect(entry.threadId).toBe(threadB.threadId);
        expect(entry.state.snapshot?.thread?.threadId).not.toBe(threadA.threadId);
        expect(
          entry.state.snapshot?.messages.some((message) => message.content.includes('A')) ?? false,
        ).toBe(false);
        expect(
          entry.state.transientResponses.some((item) =>
            item.contentBlocks.some((block) => block.text.includes('A')),
          ),
        ).toBe(false);
        expect(entry.state.bashOperations.some((item) => item.operationId.includes('a'))).toBe(
          false,
        );
        expect(entry.state.hardCuts.some((item) => item.runId === 'run-a')).toBe(false);
        expect(entry.state.invalidatedRecaps['recap-a']).toBeUndefined();
      }
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('stops the old account subscription when a keyed workbench changes accounts', async () => {
    const container = installReactDomContainer();
    const clients = createKairosClients({
      transport: createRouterTransport((router) => {
        let snapshotReads = 0;
        let watchCalls = 0;
        router.service(ThreadService, {
          getThread() {
            snapshotReads += 1;
            return snapshot(threadA, snapshotReads === 1 ? '账号 A 持久消息' : '账号 B 持久消息');
          },
        });
        router.service(EventService, {
          async *watchThread(_request, context) {
            watchCalls += 1;
            if (watchCalls === 1) {
              firstSignal = context.signal;
              yield textDelta(1n, '账号 A 临时消息');
              await abortWhenCancelled(context.signal);
              return;
            }
            secondWatchStarted = true;
            await abortWhenCancelled(context.signal);
          },
        });
      }),
    });
    let firstSignal: AbortSignal | undefined;
    let secondWatchStarted = false;
    let latest: ThreadSyncResult | null = null;
    const rendered: ThreadSyncState[] = [];
    const readLatest = (): ThreadSyncResult => {
      if (!latest) throw new Error('Hook 尚未渲染。');
      return latest;
    };
    const managers = new Map([
      ['account-a', new ThreadSyncManager(clients)],
      ['account-b', new ThreadSyncManager(clients)],
    ]);
    const renderAccount = (account: string) => {
      const manager = managers.get(account);
      if (!manager) throw new Error('Missing account manager.');
      return createElement(ThreadSyncProbe, {
        key: account,
        manager,
        threadId: threadA.threadId,
        onRender: (_threadId, sync) => {
          latest = sync;
          rendered.push(sync.state);
        },
      });
    };
    const root = createRoot(container);

    try {
      await act(async () => root.render(renderAccount('account-a')));
      await act(async () => {
        await vi.waitFor(() => {
          expect(readLatest().state.snapshot?.messages[0]?.content).toBe('账号 A 持久消息');
          expect(readLatest().state.transientResponses[0]?.contentBlocks[0]?.text).toBe(
            '账号 A 临时消息',
          );
        });
      });

      const firstBRender = rendered.length;
      await act(async () => root.render(renderAccount('account-b')));
      await act(async () => {
        await vi.waitFor(() => {
          expect(readLatest().state.snapshot?.messages[0]?.content).toBe('账号 B 持久消息');
          expect(secondWatchStarted).toBe(true);
        });
      });

      expect(firstSignal?.aborted).toBe(true);
      for (const state of rendered.slice(firstBRender)) {
        expect(
          state.snapshot?.messages.some((message) => message.content.includes('账号 A')),
        ).not.toBe(true);
        expect(
          state.transientResponses.some((response) =>
            response.contentBlocks.some((block) => block.text.includes('账号 A')),
          ),
        ).toBe(false);
      }
    } finally {
      await act(async () => root.unmount());
    }
  });
});
