import {
  create,
  ThreadCardCursorSchema,
  ThreadCardSort,
  ThreadSchema,
  ThreadType,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import type { ThreadPreviewGateway, TopicSort } from './thread-preview-gateway.js';
import type { TopicCardView } from './thread-view.js';
import { mergeCards, TopicPreviewStore } from './topic-previews.js';

function card(threadId: string, title = threadId): TopicCardView {
  return {
    thread: create(ThreadSchema, {
      threadId,
      title,
      seq: BigInt(threadId.length),
      threadType: ThreadType.TASK,
    }),
    replies: [],
    origin: null,
  };
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve?.(value) };
}

describe('TopicPreviewStore', () => {
  it('keeps Server order and passes the opaque cursor across stable pages', async () => {
    const cursor = create(ThreadCardCursorSchema, {
      sort: ThreadCardSort.LAST_MESSAGE_AT,
      sortAt: { seconds: 100n, nanos: 0 },
      threadSeq: 2n,
    });
    const requests: { sort: TopicSort; cursor: typeof cursor | null }[] = [];
    const gateway: ThreadPreviewGateway = {
      async listCards({ sort, cursor: after, limit }) {
        requests.push({ sort, cursor: after });
        if (limit === 4) return { cards: [card('recent')], nextCursor: null, hasMore: false };
        if (after === null) {
          return {
            cards: [card('newest'), card('same-time-a')],
            nextCursor: cursor,
            hasMore: true,
          };
        }
        return { cards: [card('same-time-b')], nextCursor: null, hasMore: false };
      },
      async listCallPreviews() {
        return new Map();
      },
    };
    const store = new TopicPreviewStore(gateway);

    await store.openDirectory();
    await store.loadMore();

    expect(store.state.cards.map((item) => item.thread.threadId)).toEqual([
      'newest',
      'same-time-a',
      'same-time-b',
    ]);
    expect(requests).toEqual([
      { sort: 'lastMessageAt', cursor: null },
      { sort: 'lastMessageAt', cursor },
    ]);
  });

  it('resets pagination on sort changes and ignores a late response from the old sort', async () => {
    const pending = deferred<{ cards: TopicCardView[]; nextCursor: null; hasMore: false }>();
    const gateway: ThreadPreviewGateway = {
      listCards({ sort }) {
        if (sort === 'lastMessageAt') return pending.promise;
        return Promise.resolve({ cards: [card('created')], nextCursor: null, hasMore: false });
      },
      async listCallPreviews() {
        return new Map();
      },
    };
    const store = new TopicPreviewStore(gateway);
    const first = store.openDirectory();
    await store.setSort('createdAt');
    pending.resolve({ cards: [card('stale')], nextCursor: null, hasMore: false });
    await first;

    expect(store.state.sort).toBe('createdAt');
    expect(store.state.cards.map((item) => item.thread.threadId)).toEqual(['created']);
  });

  it('deduplicates page overlap without reordering existing cards', () => {
    expect(
      mergeCards([card('a'), card('b')], [card('b'), card('c')]).map(
        (item) => item.thread.threadId,
      ),
    ).toEqual(['a', 'b', 'c']);
  });

  it('aborts replaced and unmounted requests before a delayed response can update the account', async () => {
    const pending = deferred<{ cards: TopicCardView[]; nextCursor: null; hasMore: false }>();
    const signals: AbortSignal[] = [];
    const gateway: ThreadPreviewGateway = {
      listCards(_input, signal) {
        if (!signal) throw new Error('A cancellable preview request is required.');
        signals.push(signal);
        return pending.promise;
      },
      async listCallPreviews() {
        return new Map();
      },
    };
    const store = new TopicPreviewStore(gateway);
    const oldRecent = store.loadRecent();
    const newRecent = store.loadRecent();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    const directory = store.openDirectory();
    store.stop();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    pending.resolve({ cards: [card('previous-account')], nextCursor: null, hasMore: false });
    await Promise.all([oldRecent, newRecent, directory]);
    expect(store.state.recent).toEqual([]);
    expect(store.state.cards).toEqual([]);
  });
});
