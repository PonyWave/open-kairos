import type { StreamDeltaRecord, ThreadEventRecord, ToolProgressRecord } from './records.js';
import type { SessionStore } from './store.js';

export class EventCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventCursorError';
  }
}

type WatchedRecord = ThreadEventRecord | StreamDeltaRecord | ToolProgressRecord;
type QueueItem = { value: WatchedRecord } | { error: unknown };

class BoundedQueue {
  readonly #items: QueueItem[] = [];
  readonly #maximum: number;
  #waiting: (() => void) | undefined;
  #closed = false;

  constructor(maximum: number) {
    this.#maximum = maximum;
  }

  push(value: WatchedRecord): void {
    if (this.#closed) return;
    if (this.#items.length >= this.#maximum) {
      this.#items.length = 0;
      this.#items.push({ error: new EventCursorError('The live event queue exceeded its limit.') });
    } else {
      this.#items.push({ value });
    }
    this.#wake();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  async next(signal: AbortSignal): Promise<QueueItem | undefined> {
    if (this.#items.length > 0) return this.#items.shift();
    if (this.#closed || signal.aborted) return undefined;
    await new Promise<void>((resolve) => {
      const done = () => {
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.#waiting = done;
      signal.addEventListener('abort', done, { once: true });
    });
    this.#waiting = undefined;
    if (this.#items.length > 0) return this.#items.shift();
    return undefined;
  }

  #wake(): void {
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.();
  }
}

export async function* watchThreadEvents(
  store: SessionStore,
  ownerId: string,
  threadId: string,
  afterSeq: bigint,
  signal: AbortSignal,
  maximumQueue = 256,
): AsyncGenerator<WatchedRecord> {
  store.getThread(ownerId, threadId);
  store.pruneEvents(threadId);
  const latest = BigInt(store.latestEventSequence(threadId));
  if (afterSeq > latest) {
    throw new EventCursorError('The event cursor is ahead of the Thread snapshot.');
  }
  const firstAvailable = BigInt(store.firstAvailableEventSequence(threadId));
  if (afterSeq < firstAvailable - 1n) {
    throw new EventCursorError('The event cursor is outside the retention window.');
  }
  const queue = new BoundedQueue(maximumQueue);
  const unsubscribe = store.subscribe(threadId, (event) => queue.push(event));
  let cursor = afterSeq;
  const replayedDeltaSeq = new Map<string, number>();
  try {
    yield* catchUp(cursor);
    for (const delta of store.bufferedStreamDeltas(threadId)) {
      replayedDeltaSeq.set(delta.messageId, delta.deltaSeq);
      yield delta;
    }
    while (!signal.aborted) {
      const item = await queue.next(signal);
      if (!item) break;
      if ('error' in item) throw item.error;
      const event = item.value;
      if ('seq' in event) {
        const sequence = BigInt(event.seq);
        if (sequence <= cursor) continue;
        if (sequence > cursor + 1n) yield* catchUp(cursor);
        if (sequence <= cursor) continue;
        cursor = sequence;
      } else if ('deltaSeq' in event) {
        if (event.deltaSeq <= (replayedDeltaSeq.get(event.messageId) ?? 0)) continue;
        replayedDeltaSeq.set(event.messageId, event.deltaSeq);
      }
      yield event;
    }
  } finally {
    unsubscribe();
    queue.close();
  }

  async function* catchUp(start: bigint): AsyncGenerator<WatchedRecord> {
    let current = start;
    while (!signal.aborted) {
      const events = store.listEvents(threadId, current, 500);
      for (const event of events) {
        current = BigInt(event.seq);
        yield event;
      }
      cursor = current;
      if (events.length < 500) return;
    }
  }
}
