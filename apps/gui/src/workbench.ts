import { type Thread, ThreadType } from '@kairos/contracts';

export interface WorkbenchState {
  page:
    | 'thread'
    | 'directory'
    | 'draft'
    | 'devices'
    | 'workspaces'
    | 'settings'
    | 'automations'
    | 'automationThread';
  selectedThreadId: string | null;
  automationScheduleId: string | null;
  automationThreadId: string | null;
  draftWorkspaceId: string | null;
  mainThreadId: string;
  mainThread: Thread | null;
  threads: readonly Thread[];
}

interface ThreadDirectoryOptions {
  mainThreadId: string;
  onChange?: (state: WorkbenchState) => void;
}

export class ThreadDirectory {
  private current: WorkbenchState;
  private listener: ((state: WorkbenchState) => void) | undefined;

  constructor(options: ThreadDirectoryOptions) {
    if (!options.mainThreadId) throw new Error('主对话编号不能为空。');
    this.current = initialState(options.mainThreadId);
    this.listener = options.onChange;
  }

  get state(): WorkbenchState {
    return { ...this.current, threads: [...this.current.threads] };
  }

  subscribe(listener: (state: WorkbenchState) => void): () => void {
    this.listener = listener;
    listener(this.state);
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  showMain(): void {
    this.patch({
      page: 'thread',
      selectedThreadId: this.current.mainThreadId,
      automationScheduleId: null,
      automationThreadId: null,
    });
  }

  showThreadPage(): void {
    if (this.current.page === 'thread' && this.current.selectedThreadId !== null) return;
    this.showMain();
  }

  openDirectory(): void {
    this.patch({
      page: 'directory',
      selectedThreadId: null,
      automationScheduleId: null,
      automationThreadId: null,
    });
  }

  openDraft(workspaceId: string | null = null): void {
    this.patch({
      page: 'draft',
      selectedThreadId: null,
      automationScheduleId: null,
      automationThreadId: null,
      draftWorkspaceId: workspaceId,
    });
  }

  openWorkspaces(): void {
    this.patch({
      page: 'workspaces',
      selectedThreadId: null,
      automationScheduleId: null,
      automationThreadId: null,
    });
  }

  openDevices(): void {
    this.patch({
      page: 'devices',
      selectedThreadId: null,
      automationScheduleId: null,
      automationThreadId: null,
    });
  }

  openSettings(): void {
    this.patch({
      page: 'settings',
      selectedThreadId: null,
      automationScheduleId: null,
      automationThreadId: null,
    });
  }

  openAutomations(scheduleId: string | null = null): void {
    this.patch({
      page: 'automations',
      selectedThreadId: null,
      automationScheduleId: scheduleId,
      automationThreadId: null,
    });
  }

  openAutomationThread(scheduleId: string, threadId: string): void {
    if (!scheduleId || !threadId) return;
    this.patch({
      page: 'automationThread',
      selectedThreadId: null,
      automationScheduleId: scheduleId,
      automationThreadId: threadId,
    });
  }

  openThread(threadId: string): void {
    if (!threadId) return;
    this.patch({
      page: 'thread',
      selectedThreadId: threadId,
      automationScheduleId: null,
      automationThreadId: null,
    });
  }

  forgetThreads(threadIds: readonly string[]): void {
    const removed = new Set(threadIds);
    this.patch({ threads: this.current.threads.filter((thread) => !removed.has(thread.threadId)) });
    if (this.current.selectedThreadId && removed.has(this.current.selectedThreadId))
      this.showMain();
  }

  upsertThread(thread: Thread): void {
    if (!isListedThread(thread)) return;
    const byId = new Map(this.current.threads.map((item) => [item.threadId, item]));
    byId.set(thread.threadId, thread);
    this.patch({
      threads: sortThreads([...byId.values()]),
      ...(this.current.mainThreadId === thread.threadId && thread.threadType === ThreadType.MAIN
        ? { mainThread: thread }
        : {}),
    });
  }

  private patch(patch: Partial<WorkbenchState>): void {
    this.current = { ...this.current, ...patch };
    this.emit();
  }

  private emit(): void {
    this.listener?.(this.state);
  }
}

function initialState(mainThreadId: string): WorkbenchState {
  return {
    page: 'thread',
    selectedThreadId: null,
    automationScheduleId: null,
    automationThreadId: null,
    draftWorkspaceId: null,
    mainThreadId,
    mainThread: null,
    threads: [],
  };
}

function isListedThread(thread: Thread): boolean {
  return (
    !thread.automationOnly &&
    (thread.threadType === ThreadType.MAIN ||
      thread.threadType === ThreadType.TASK ||
      thread.threadType === ThreadType.WORKSPACE_MAIN)
  );
}

function sortThreads(threads: Thread[]): Thread[] {
  return threads.sort((left, right) => {
    if (left.seq < right.seq) return -1;
    if (left.seq > right.seq) return 1;
    return left.threadId < right.threadId ? -1 : 1;
  });
}
