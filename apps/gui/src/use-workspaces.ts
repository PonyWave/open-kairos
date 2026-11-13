import type { Thread, Workspace } from '@kairos/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KairosClients } from './client.js';
import { formatClientError } from './errors.js';

export interface WorkspaceGroup {
  workspace: Workspace | null;
  deviceName?: string | undefined;
  mainThread: Thread | null;
  tasks: Thread[];
}

export interface WorkspaceDirectoryState {
  groups: WorkspaceGroup[];
  temporary: Thread[];
  loading: boolean;
  error: string | null;
}

const initialState: WorkspaceDirectoryState = {
  groups: [],
  temporary: [],
  loading: false,
  error: null,
};

async function listAllThreads(clients: KairosClients): Promise<Thread[]> {
  const threads: Thread[] = [];
  let afterSeq = 0n;
  for (;;) {
    const page = await clients.thread.listThreads({ afterSeq, limit: 100 });
    threads.push(...page.threads);
    if (!page.hasMore || page.threads.length === 0) return threads;
    const last = page.threads.at(-1);
    if (!last) return threads;
    afterSeq = BigInt(last.seq);
  }
}

export function useWorkspaceDirectory(clients: KairosClients, enabled: boolean) {
  const [state, setState] = useState<WorkspaceDirectoryState>(initialState);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setState(initialState);
      return;
    }
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    void (async () => {
      try {
        void revision;
        const [workspaces, threads, environments] = await Promise.all([
          clients.workspaces.listWorkspaces({}),
          listAllThreads(clients),
          clients.environments.listEnvironments({}),
        ]);
        if (cancelled) return;
        const groups: WorkspaceGroup[] = workspaces.workspaces.map((workspace) => ({
          workspace,
          deviceName: environments.environments.find((e) => e.envId === workspace.envId)?.name,
          mainThread:
            threads.find(
              (thread) =>
                thread.threadId === workspace.mainThreadId ||
                (thread.threadType === 3 && thread.workspaceId === workspace.workspaceId),
            ) ?? null,
          tasks: threads.filter(
            (thread) => thread.threadType === 2 && thread.workspaceId === workspace.workspaceId,
          ),
        }));
        const temporary = threads.filter(
          (thread) =>
            thread.threadType === 2 &&
            (thread.workspaceId === undefined || thread.workspaceId === ''),
        );
        setState({ groups, temporary, loading: false, error: null });
      } catch (cause) {
        if (cancelled) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: formatClientError(cause),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clients, enabled, revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return useMemo(() => ({ ...state, refresh }), [state, refresh]);
}
