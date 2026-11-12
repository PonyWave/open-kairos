import type { ThreadSnapshot } from '@kairos/contracts';
import type { KairosClients } from './client.js';
import { ThreadSynchronizer, type ThreadSyncState } from './thread-sync.js';

type StateListener = (state: ThreadSyncState) => void;
type SnapshotListener = (
  threadId: string,
  snapshot: ThreadSnapshot,
  previous: ThreadSnapshot | undefined,
) => void;

interface SharedThreadSync {
  synchronizer: ThreadSynchronizer;
  state: ThreadSyncState;
  listeners: Set<StateListener>;
  reload: Promise<void> | null;
}

export class ThreadSyncManager {
  private readonly threads = new Map<string, SharedThreadSync>();
  private readonly snapshotListeners = new Set<SnapshotListener>();

  constructor(private readonly clients: Pick<KairosClients, 'thread' | 'events' | 'automations'>) {}

  subscribe(threadId: string, listener: StateListener, automationScheduleId?: string): () => void {
    const key = threadSyncKey(threadId, automationScheduleId);
    let entry = this.threads.get(key);
    const fresh = entry === undefined;
    entry ??= this.create(key, threadId, automationScheduleId);
    const notify: StateListener = (state) => listener(state);
    entry.listeners.add(notify);
    notify(entry.state);
    if (fresh) entry.synchronizer.start(threadId);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      entry.listeners.delete(notify);
      if (entry.listeners.size === 0 && this.threads.get(key) === entry) {
        this.threads.delete(key);
        entry.synchronizer.stop();
      }
    };
  }

  observeSnapshots(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  reload(threadId: string, automationScheduleId?: string): Promise<void> {
    const entry = this.threads.get(threadSyncKey(threadId, automationScheduleId));
    if (!entry) return Promise.resolve();
    if (entry.reload) return entry.reload;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    entry.reload = promise;
    void entry.synchronizer.reload().then(
      () => {
        if (entry.reload === promise) entry.reload = null;
        resolve();
      },
      (cause: unknown) => {
        if (entry.reload === promise) entry.reload = null;
        reject(cause);
      },
    );
    return promise;
  }

  stop(): void {
    const entries = [...this.threads.values()];
    this.threads.clear();
    this.snapshotListeners.clear();
    for (const entry of entries) {
      entry.listeners.clear();
      entry.synchronizer.stop();
    }
  }

  private create(
    key: string,
    threadId: string,
    automationScheduleId: string | undefined,
  ): SharedThreadSync {
    let entry: SharedThreadSync | undefined;
    const synchronizer = new ThreadSynchronizer({
      clients: this.clients,
      automationScheduleId,
      onChange: (state) => {
        if (!entry || this.threads.get(key) !== entry) return;
        const previousSnapshot = entry.state.snapshot;
        const snapshotChanged = state.snapshot !== previousSnapshot;
        entry.state = state;
        for (const listener of entry.listeners) listener(state);
        if (snapshotChanged && state.snapshot) {
          for (const listener of this.snapshotListeners)
            listener(threadId, state.snapshot, previousSnapshot ?? undefined);
        }
      },
    });
    entry = { synchronizer, state: synchronizer.state, listeners: new Set(), reload: null };
    this.threads.set(key, entry);
    return entry;
  }
}

function threadSyncKey(threadId: string, automationScheduleId: string | undefined): string {
  return automationScheduleId
    ? `automation:${automationScheduleId}:${threadId}`
    : `thread:${threadId}`;
}
