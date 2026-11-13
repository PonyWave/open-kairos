import { useEffect, useMemo, useState } from 'react';
import { ThreadDirectory, type WorkbenchState } from './workbench.js';

export function useWorkbench(mainThreadId: string) {
  const directory = useMemo(() => new ThreadDirectory({ mainThreadId }), [mainThreadId]);
  const [state, setState] = useState<WorkbenchState>(directory.state);

  useEffect(() => {
    const unsubscribe = directory.subscribe(setState);
    directory.showMain();
    return () => {
      unsubscribe();
    };
  }, [directory]);

  const operations = useMemo(
    () => ({
      showMain: () => directory.showMain(),
      showThreadPage: () => directory.showThreadPage(),
      openDirectory: () => directory.openDirectory(),
      openDraft: (workspaceId?: string | null) => directory.openDraft(workspaceId ?? null),
      openDevices: () => directory.openDevices(),
      forgetThreads: (threadIds: readonly string[]) => directory.forgetThreads(threadIds),
      openWorkspaces: () => directory.openWorkspaces(),
      openSettings: () => directory.openSettings(),
      openAutomations: (scheduleId: string | null = null) => directory.openAutomations(scheduleId),
      openAutomationThread: (scheduleId: string, threadId: string) =>
        directory.openAutomationThread(scheduleId, threadId),
      openThread: (threadId: string) => directory.openThread(threadId),
      upsertThread: (thread: Parameters<ThreadDirectory['upsertThread']>[0]) =>
        directory.upsertThread(thread),
    }),
    [directory],
  );

  return { state, ...operations };
}
