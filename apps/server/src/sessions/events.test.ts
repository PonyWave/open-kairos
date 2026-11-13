import { expect, it } from 'vitest';
import { seedTestTenant } from '../integration/environment-fixture.js';
import { openDatabase } from '../storage/database.js';
import { watchThreadEvents } from './events.js';
import type { StreamDeltaRecord } from './records.js';
import { SessionStore } from './store.js';

const ownerId = 'owner-1';

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The expected watch events did not arrive.');
}

it('replays buffered stream deltas to a new watcher and deduplicates them against live events', async () => {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  seedTestTenant(database, ownerId);
  const thread = store.getOrCreateMainThread(ownerId);
  store.publishTextDelta({
    threadId: thread.threadId,
    messageId: 'message-1',
    deltaSeq: 1,
    text: '你',
  });
  store.publishTextDelta({
    threadId: thread.threadId,
    messageId: 'message-1',
    deltaSeq: 2,
    text: '好',
  });

  const controller = new AbortController();
  const watch = watchThreadEvents(
    store,
    ownerId,
    thread.threadId,
    BigInt(store.latestEventSequence(thread.threadId)),
    controller.signal,
  )[Symbol.asyncIterator]();
  const received: string[] = [];
  const collect = (async () => {
    while (true) {
      const item = await watch.next();
      if (item.done) return;
      if ('deltaSeq' in item.value) {
        const delta = item.value as StreamDeltaRecord;
        received.push(`${delta.deltaSeq}:${delta.text}`);
      }
    }
  })();

  await waitFor(() => received.length >= 2);
  expect(received).toEqual(['1:你', '2:好']);

  store.publishTextDelta({
    threadId: thread.threadId,
    messageId: 'message-1',
    deltaSeq: 2,
    text: '好',
  });
  store.publishTextDelta({
    threadId: thread.threadId,
    messageId: 'message-1',
    deltaSeq: 3,
    text: '吗',
  });
  store.publishTextDelta({
    threadId: thread.threadId,
    messageId: 'message-1',
    deltaSeq: 4,
    text: '？',
  });
  await waitFor(() => received.length >= 4);
  expect(received).toEqual(['1:你', '2:好', '3:吗', '4:？']);

  controller.abort();
  await collect;
  database.close();
});
