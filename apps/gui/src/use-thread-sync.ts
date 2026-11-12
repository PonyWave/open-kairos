import { useEffect, useState } from 'react';
import type { ThreadSyncState } from './thread-sync.js';
import type { ThreadSyncManager } from './thread-sync-manager.js';

const initialState: ThreadSyncState = {
  snapshot: null,
  throughSeq: 0n,
  transientResponses: [],
  bashOperations: [],
  hardCuts: [],
  invalidatedRecaps: {},
  status: 'idle',
  error: null,
};

export function useThreadSync(
  manager: ThreadSyncManager,
  threadId: string | null,
  automationScheduleId?: string,
): { state: ThreadSyncState; reload: () => Promise<void> } {
  const [tracked, setTracked] = useState<{
    manager: ThreadSyncManager | null;
    threadId: string | null;
    automationScheduleId: string | undefined;
    state: ThreadSyncState;
  }>({ manager: null, threadId: null, automationScheduleId: undefined, state: initialState });

  useEffect(() => {
    if (!threadId) {
      setTracked({
        manager,
        threadId: null,
        automationScheduleId: undefined,
        state: initialState,
      });
      return;
    }
    return manager.subscribe(
      threadId,
      (state) => setTracked({ manager, threadId, automationScheduleId, state }),
      automationScheduleId,
    );
  }, [manager, threadId, automationScheduleId]);

  const current =
    tracked.manager === manager &&
    tracked.threadId === threadId &&
    tracked.automationScheduleId === automationScheduleId;
  return {
    state:
      threadId === null
        ? initialState
        : current
          ? tracked.state
          : { ...initialState, status: 'loading' },
    reload: () =>
      current && threadId ? manager.reload(threadId, automationScheduleId) : Promise.resolve(),
  };
}
