import {
  healthResponseSchema,
  type Identity,
  type SubagentCallView,
  type ThreadSnapshot,
  ThreadType,
  type Workspace,
} from '@kairos/contracts';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { accountScopeKey, scopedStorage } from './account-storage.js';
import { completeGuiAction } from './action-completion.js';
import type { ActionCompletion } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import { browserStorage, type StorageLike } from './actions.js';
import { AppDialog } from './app-dialog.js';
import { AutomationPage } from './automation-page.js';
import { createKairosClients, type KairosClients } from './client.js';
import { ConnectedDevicesPage } from './connected-devices-page.js';
import {
  type ConversationDisplayMode,
  loadConversationDisplay,
  saveConversationDisplay,
} from './conversation-display.js';
import { ConversationPane } from './conversation-pane.js';
import type { OpenTopicRequest } from './delegation-cards.js';
import { localTaskDraftId } from './drafts.js';
import { Dropdown } from './dropdown.js';
import { DualPaneLayout } from './dual-pane-layout.js';
import { EntityMark } from './entity-mark.js';
import { formatClientError } from './errors.js';
import { FailureNotice } from './failure-notice.js';
import { Icon } from './icon.js';
import { LoginScreen } from './login-screen.js';
import {
  getNarrowViewportServerSnapshot,
  getNarrowViewportSnapshot,
  subscribeNarrowViewport,
} from './narrow-viewport.js';
import { randomId } from './random.js';
import {
  SettingsPage,
  type SettingsSection,
  settingsSectionFromLocation,
} from './settings-page.js';
import { TemporaryThreadsSection, WorkspaceGroupSection } from './sidebar-workspaces.js';
import { ThreadListPage } from './thread-list-page.js';
import { ThreadSyncManager } from './thread-sync-manager.js';
import type { AgentOrigin, TopicCardView } from './thread-view.js';
import { type ThreadIdentity, ThreadWorkspaceProvider } from './thread-workspaces.js';
import { withToolExpanded } from './tool-group-projection.js';
import { type ActionExecutorView, useActionExecutor } from './use-action-executor.js';
import { useAuth } from './use-auth.js';
import { useDrafts } from './use-drafts.js';
import { useTopicPreviews } from './use-topic-previews.js';
import { useWorkbench } from './use-workbench.js';
import { useWorkspaceCards } from './use-workspace-cards.js';
import type { WorkspaceGroup } from './use-workspaces.js';
import { useWorkspaceDirectory } from './use-workspaces.js';
import { UserAvatar, UserProfileProvider } from './user-avatar.js';
import {
  automationRouteFromLocation,
  isMainShortcut,
  shouldInvalidateTopicCards,
  shouldRefreshConversationPreviews,
  workbenchLocation,
} from './workbench-navigation.js';
import { WorkspaceDialog } from './workspace-dialog.js';
import { WorkspacesPage } from './workspaces-page.js';

const wordmark = new URL('./assets/kairos-wordmark.svg', import.meta.url).href;

export function App() {
  const narrowViewport = useSyncExternalStore(
    subscribeNarrowViewport,
    getNarrowViewportSnapshot,
    getNarrowViewportServerSnapshot,
  );
  const [storage] = useState(browserStorage);
  const expireSessionRef = useRef<(authenticationGeneration: number) => void>(() => {});
  const authenticationGenerationRef = useRef(0);
  const clients = useMemo(
    () =>
      createKairosClients({
        getAuthenticationGeneration: () => authenticationGenerationRef.current,
        onUnauthenticated: (authenticationGeneration) =>
          expireSessionRef.current(authenticationGeneration),
      }),
    [],
  );
  const auth = useAuth(clients);
  authenticationGenerationRef.current = auth.authenticationGeneration;
  expireSessionRef.current = auth.expireSession;
  const identity = auth.state.step === 'authenticated' ? auth.state.identity : null;
  const scopeKey = identity ? accountScopeKey(identity) : null;
  const accountStorage = useMemo(() => scopedStorage(storage, scopeKey), [storage, scopeKey]);
  const actionHandlers = useMemo(() => createActionHandlers(clients), [clients]);
  const completionRef = useRef<ActionCompletion | null>(null);
  const completeAction = useCallback<ActionCompletion>(
    (record, result) => completionRef.current?.(record, result),
    [],
  );
  const actions = useActionExecutor(accountStorage, actionHandlers, completeAction);
  const registerCompletion = useCallback((completion: ActionCompletion | null) => {
    completionRef.current = completion;
  }, []);

  if (!identity || !scopeKey) {
    return <LoginScreen auth={auth} />;
  }

  return (
    <AccountWorkbench
      key={scopeKey}
      identity={identity}
      clients={clients}
      storage={accountStorage}
      actions={actions}
      registerCompletion={registerCompletion}
      onIdentityChange={auth.updateIdentity}
      onLogout={auth.logout}
      narrowViewport={narrowViewport}
    />
  );
}

export function AccountWorkbench({
  identity,
  clients,
  storage,
  actions,
  registerCompletion,
  onLogout,
  onIdentityChange = () => {},
  narrowViewport = false,
  serverHealth,
}: {
  identity: Identity;
  clients: KairosClients;
  storage: StorageLike | undefined;
  actions: ActionExecutorView;
  registerCompletion: (completion: ActionCompletion | null) => void;
  onLogout: () => Promise<void>;
  onIdentityChange?: (identity: Identity) => void;
  narrowViewport?: boolean;
  serverHealth?: 'ready';
}) {
  const workbench = useWorkbench(identity.mainThreadId);
  const threadSyncManager = useMemo(() => new ThreadSyncManager(clients), [clients]);
  const topics = useTopicPreviews(clients, true);
  const workspaceDirectory = useWorkspaceDirectory(clients, true);
  const threadWorkspaces = useMemo(() => {
    const map = new Map<string, ThreadIdentity>();
    map.set(identity.mainThreadId, { main: true });
    for (const group of workspaceDirectory.groups) {
      const workspaceId = group.workspace?.workspaceId;
      if (!workspaceId) continue;
      if (group.mainThread) map.set(group.mainThread.threadId, { workspaceId, main: true });
      for (const thread of group.tasks) map.set(thread.threadId, { workspaceId, main: false });
    }
    for (const thread of workspaceDirectory.temporary) {
      map.set(thread.threadId, { main: false });
    }
    return map;
  }, [workspaceDirectory.groups, workspaceDirectory.temporary, identity.mainThreadId]);
  const drafts = useDrafts(storage);
  const directory = workbench.state;
  const workspaceCards = useWorkspaceCards(
    clients,
    directory.page === 'workspaces',
    workspaceDirectory.groups,
    workspaceDirectory.temporary,
  );
  const mainThread = directory.mainThread;
  const mainThreadId = identity.mainThreadId;
  const selectedThreadId = directory.page === 'thread' ? directory.selectedThreadId : null;
  const mainVisible =
    directory.page === 'thread' && selectedThreadId !== null && selectedThreadId === mainThreadId;
  const [health, setHealth] = useState<'loading' | 'ready' | 'error'>('loading');
  const [conversationDisplay, setConversationDisplay] = useState(() =>
    loadConversationDisplay(storage),
  );
  const changeConversationDisplay = useCallback(
    (mode: ConversationDisplayMode) =>
      setConversationDisplay(saveConversationDisplay(storage, mode)),
    [storage],
  );
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    storage?.getItem('kairos.theme') === 'dark' ? 'dark' : 'light',
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    storage?.setItem('kairos.theme', theme);
  }, [theme, storage]);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [workspaceEditor, setWorkspaceEditor] = useState<{ workspace: Workspace | null } | null>(
    null,
  );
  const [deletingWorkspace, setDeletingWorkspace] = useState<WorkspaceGroup | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const deleteActionId = useRef('');
  const sidebarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const navigationButton = useRef<HTMLButtonElement>(null);

  const [notice, setNotice] = useState<string | null>(null);
  const [activeTopic, setActiveTopic] = useState<OpenTopicRequest | null>(null);
  const [activeSubagent, setActiveSubagent] = useState<SubagentCallView | null>(null);
  const [fullTopic, setFullTopic] = useState<{
    origin: AgentOrigin | null;
    invocationId: string | null;
  }>({ origin: null, invocationId: null });
  const [highlightedCallId, setHighlightedCallId] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [automationRevision, setAutomationRevision] = useState(0);
  const [toolExpansionChoices, setToolExpansionChoices] = useState<Record<string, boolean>>({});
  const onToolExpansionChange = useCallback((operationId: string, expanded: boolean) => {
    setToolExpansionChoices((current) => withToolExpanded(current, operationId, expanded));
  }, []);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(() =>
    typeof window === 'undefined' ? 'account' : settingsSectionFromLocation(window.location.search),
  );
  const [locationReady, setLocationReady] = useState(false);
  const dirtySettings = useRef(false);
  const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
  const onSettingsDirty = useCallback((dirty: boolean) => {
    dirtySettings.current = dirty;
  }, []);
  const navigate = useCallback((action: () => void) => {
    if (dirtySettings.current) setLeaveAction(() => action);
    else action();
  }, []);
  const historyIndex = useRef(0);
  const restoringHistory = useRef(false);

  const showNotice = useCallback((message: string) => setNotice(message || null), []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const openMain = useCallback(() => {
    navigate(() => {
      setNavigationOpen(false);
      setActiveTopic(null);
      setActiveSubagent(null);
      setHighlightedCallId(null);
      topics.closeDirectory();
      workbench.showMain();
    });
  }, [navigate, topics.closeDirectory, workbench.showMain]);

  const openDirectory = useCallback(() => {
    navigate(() => {
      setNavigationOpen(false);
      setActiveTopic(null);
      setActiveSubagent(null);
      setHighlightedCallId(null);
      workbench.openDirectory();
      void topics.openDirectory();
    });
  }, [navigate, topics.openDirectory, workbench.openDirectory]);

  const openFullThread = useCallback(
    (threadId: string, origin: AgentOrigin | null = null, invocationId: string | null = null) => {
      navigate(() => {
        setNavigationOpen(false);
        setActiveTopic(null);
        setActiveSubagent(null);
        setHighlightedCallId(null);
        setFullTopic({ origin, invocationId });
        topics.closeDirectory();
        workbench.openThread(threadId);
      });
    },
    [navigate, topics.closeDirectory, workbench.openThread],
  );

  const openDraft = useCallback(
    (workspaceId: string | null = null) => {
      navigate(() => {
        setNavigationOpen(false);
        setActiveTopic(null);
        setActiveSubagent(null);
        setHighlightedCallId(null);
        topics.closeDirectory();
        workbench.openDraft(workspaceId);
      });
    },
    [navigate, topics.closeDirectory, workbench.openDraft],
  );

  const openDevices = useCallback(() => {
    navigate(() => {
      setNavigationOpen(false);
      setActiveTopic(null);
      setActiveSubagent(null);
      setHighlightedCallId(null);
      topics.closeDirectory();
      workbench.openDevices();
    });
  }, [navigate, topics.closeDirectory, workbench.openDevices]);

  const openWorkspaces = useCallback(() => {
    navigate(() => {
      setNavigationOpen(false);
      setActiveTopic(null);
      setActiveSubagent(null);
      setHighlightedCallId(null);
      topics.closeDirectory();
      workspaceDirectory.refresh();
      workbench.openWorkspaces();
    });
  }, [navigate, topics.closeDirectory, workbench.openWorkspaces, workspaceDirectory.refresh]);

  const createWorkspace = useCallback(() => {
    navigate(() => {
      setNavigationOpen(false);
      setWorkspaceEditor({ workspace: null });
    });
  }, [navigate]);
  const editWorkspace = useCallback(
    (workspace: Workspace) => {
      navigate(() => {
        setNavigationOpen(false);
        setWorkspaceEditor({ workspace });
      });
    },
    [navigate],
  );
  async function changeWorkspaceVisibility(workspace: Workspace) {
    setWorkspaceBusy(true);
    setWorkspaceError(null);
    try {
      await clients.workspaces.updateWorkspace({
        clientActionId: randomId(),
        workspaceId: workspace.workspaceId,
        hidden: !workspace.hidden,
      });
      workspaceDirectory.refresh();
      showNotice(
        workspace.hidden
          ? '工作空间已显示在侧边栏。'
          : '工作空间已从侧边栏隐藏，可在全部工作空间恢复。',
      );
    } catch (cause) {
      setWorkspaceError(formatClientError(cause));
    } finally {
      setWorkspaceBusy(false);
    }
  }
  async function removeWorkspace() {
    const workspace = deletingWorkspace?.workspace;
    if (!workspace || deleteConfirmation !== workspace.name || workspaceBusy) return;
    setWorkspaceBusy(true);
    setWorkspaceError(null);
    try {
      await clients.workspaces.deleteWorkspace({
        clientActionId: deleteActionId.current,
        workspaceId: workspace.workspaceId,
      });
      const ids = [
        ...(deletingWorkspace?.tasks ?? []).map((t) => t.threadId),
        ...(deletingWorkspace?.mainThread ? [deletingWorkspace.mainThread.threadId] : []),
      ];
      drafts.discardDrafts([...ids, `${localTaskDraftId}:${workspace.workspaceId}`]);
      workbench.forgetThreads(ids);
      setActiveTopic(null);
      setActiveSubagent(null);
      setWorkspaceEditor(null);
      setDeletingWorkspace(null);
      workspaceDirectory.refresh();
      void topics.openDirectory();
      openWorkspaces();
      showNotice('工作空间及其中的对话已删除，设备文件保留。');
    } catch (cause) {
      setWorkspaceError(formatClientError(cause));
    } finally {
      setWorkspaceBusy(false);
    }
  }

  const openSettings = useCallback(() => {
    navigate(() => {
      setNavigationOpen(false);
      setActiveTopic(null);
      setActiveSubagent(null);
      setHighlightedCallId(null);
      topics.closeDirectory();
      workbench.openSettings();
    });
  }, [navigate, topics.closeDirectory, workbench.openSettings]);

  const openAutomations = useCallback(
    (scheduleId: string | null = null) => {
      navigate(() => {
        setNavigationOpen(false);
        setActiveTopic(null);
        setActiveSubagent(null);
        setHighlightedCallId(null);
        topics.closeDirectory();
        workbench.openAutomations(scheduleId);
      });
    },
    [navigate, topics.closeDirectory, workbench.openAutomations],
  );

  const openAutomationTarget = useCallback(
    (scheduleId: string, threadId: string, automationOnly: boolean) => {
      if (!automationOnly) {
        openFullThread(threadId);
        return;
      }
      navigate(() => {
        setNavigationOpen(false);
        setActiveTopic(null);
        setActiveSubagent(null);
        setHighlightedCallId(null);
        topics.closeDirectory();
        workbench.openAutomationThread(scheduleId, threadId);
      });
    },
    [navigate, openFullThread, topics.closeDirectory, workbench.openAutomationThread],
  );

  const openTopic = useCallback(
    (request: OpenTopicRequest) => {
      setNavigationOpen(false);
      topics.closeDirectory();
      workbench.showThreadPage();
      setActiveSubagent(null);
      setActiveTopic(request);
    },
    [topics.closeDirectory, workbench.showThreadPage],
  );

  const closeDetail = useCallback(() => {
    setActiveTopic(null);
    setActiveSubagent(null);
  }, []);
  const openSubagent = useCallback((view: SubagentCallView) => {
    setActiveTopic(null);
    setActiveSubagent(view);
  }, []);

  const showOrigin = useCallback(
    (threadId: string, origin: AgentOrigin) => {
      setNavigationOpen(false);
      const invocationId = origin.delegation.sourceToolCallId;
      const sourceThreadId = origin.delegation.sourceThreadId;
      setHighlightedCallId(invocationId);
      if (sourceThreadId === mainThreadId) workbench.showMain();
      else {
        setFullTopic({ origin: null, invocationId: null });
        workbench.openThread(sourceThreadId);
      }
      setActiveSubagent(null);
      setActiveTopic({ threadId, invocationId, origin });
      topics.closeDirectory();
    },
    [mainThreadId, topics.closeDirectory, workbench.openThread, workbench.showMain],
  );

  const completeAction = useCallback<ActionCompletion>(
    (record, result) => {
      completeGuiAction(record, result, {
        upsertThread: (thread) => {
          workbench.upsertThread(thread);
          topics.upsertThread(thread);
          workspaceDirectory.refresh();
        },
        selectThread: (threadId) => openFullThread(threadId),
        startNewMain: (thread) => {
          setActiveTopic(null);
          setActiveSubagent(null);
          setHighlightedCallId(null);
          onIdentityChange({ ...identity, mainThreadId: thread.threadId });
        },
        completeDraft: drafts.completeDraft,
        removeDraftAttachment: drafts.removeAttachment,
        restoreQueueDraft: drafts.restoreQueueDraft,
        closeForm: () => {},
        showNotice,
        automationChanged: () => setAutomationRevision((value) => value + 1),
      });
    },
    [
      drafts.completeDraft,
      drafts.removeAttachment,
      drafts.restoreQueueDraft,
      openFullThread,
      identity,
      onIdentityChange,
      showNotice,
      topics.upsertThread,
      workbench.upsertThread,
      workspaceDirectory.refresh,
    ],
  );
  useLayoutEffect(() => {
    registerCompletion(completeAction);
    return () => registerCompletion(null);
  }, [completeAction, registerCompletion]);

  const onSnapshot = useCallback(
    (threadId: string, snapshot: ThreadSnapshot, previous: ThreadSnapshot | undefined) => {
      if (snapshot.thread?.automationOnly) return;
      if (!shouldRefreshConversationPreviews(previous, snapshot)) return;
      if (snapshot.thread) {
        workbench.upsertThread(snapshot.thread);
        topics.upsertThread(snapshot.thread);
      }
      setPreviewRevision((value) => value + 1);
      if (shouldInvalidateTopicCards(threadId, mainThreadId, snapshot.messages)) {
        void topics.invalidate();
      }
    },
    [mainThreadId, topics.invalidate, topics.upsertThread, workbench.upsertThread],
  );

  useLayoutEffect(
    () => threadSyncManager.observeSnapshots(onSnapshot),
    [onSnapshot, threadSyncManager],
  );
  useLayoutEffect(() => () => threadSyncManager.stop(), [threadSyncManager]);

  const allCards = useMemo(() => {
    const cards = new Map<string, TopicCardView>();
    for (const card of topics.state.recent) cards.set(card.thread.threadId, card);
    for (const card of topics.state.cards) cards.set(card.thread.threadId, card);
    return [...cards.values()];
  }, [topics.state.cards, topics.state.recent]);
  const selectedThread = selectedThreadId
    ? (allCards.find((card) => card.thread.threadId === selectedThreadId)?.thread ??
      directory.threads.find((thread) => thread.threadId === selectedThreadId) ??
      null)
    : null;
  const activeThread = activeTopic
    ? (allCards.find((card) => card.thread.threadId === activeTopic.threadId)?.thread ?? null)
    : null;

  useEffect(() => {
    if (serverHealth) {
      setHealth(serverHealth);
      return;
    }
    const controller = new AbortController();
    setHealth('loading');
    async function checkHealth() {
      try {
        const response = await fetch('/api/health', {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        healthResponseSchema.parse(await response.json());
        if (!controller.signal.aborted) setHealth('ready');
      } catch {
        if (!controller.signal.aborted) setHealth('error');
      }
    }
    void checkHealth();
    return () => controller.abort();
  }, [serverHealth]);

  useEffect(() => {
    const readIndex = (state: unknown): number =>
      state &&
      typeof state === 'object' &&
      'kairosNavigationIndex' in state &&
      typeof state.kairosNavigationIndex === 'number'
        ? state.kairosNavigationIndex
        : 0;
    const applyLocation = () => {
      const params = new URLSearchParams(window.location.search);
      const view = params.get('view');
      const section = settingsSectionFromLocation(window.location.search);
      const automationRoute = automationRouteFromLocation(window.location.search);
      const page =
        automationRoute?.page ??
        (view === 'topics'
          ? 'directory'
          : view === 'devices' || view === 'settings' || view === 'draft' || view === 'workspaces'
            ? view
            : 'thread');
      const automationThreadId =
        automationRoute?.page === 'automationThread' ? automationRoute.threadId : null;
      const canonical = workbenchLocation(
        page,
        view === 'thread' ? params.get('thread') : null,
        mainThreadId,
        section,
        automationRoute?.scheduleId ?? null,
        automationThreadId,
        view === 'draft' ? params.get('workspace') : null,
      );
      window.history.replaceState(
        { kairosNavigationIndex: historyIndex.current },
        '',
        `${window.location.pathname}${canonical}`,
      );
      setSettingsSection(section);
      if (automationRoute?.page === 'automationThread')
        openAutomationTarget(automationRoute.scheduleId, automationRoute.threadId, true);
      else if (automationRoute?.page === 'automations') openAutomations(automationRoute.scheduleId);
      else if (view === 'settings') openSettings();
      else if (view === 'devices') openDevices();
      else if (view === 'topics') openDirectory();
      else if (view === 'workspaces') openWorkspaces();
      else if (view === 'draft') openDraft(params.get('workspace'));
      else if (view === 'thread' && params.get('thread'))
        openFullThread(params.get('thread') ?? '');
      else openMain();
    };
    historyIndex.current = readIndex(window.history.state);
    window.history.replaceState(
      { kairosNavigationIndex: historyIndex.current },
      '',
      window.location.href,
    );
    applyLocation();
    setLocationReady(true);
    const onPopState = (event: PopStateEvent) => {
      if (restoringHistory.current) {
        restoringHistory.current = false;
        return;
      }
      const nextIndex = readIndex(event.state);
      if (dirtySettings.current && nextIndex !== historyIndex.current) {
        const delta = nextIndex - historyIndex.current;
        restoringHistory.current = true;
        window.history.go(-delta);
        setLeaveAction(() => () => window.history.go(delta));
        return;
      }
      historyIndex.current = nextIndex;
      applyLocation();
    };
    window.addEventListener('popstate', onPopState);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtySettings.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [
    mainThreadId,
    openSettings,
    openDevices,
    openWorkspaces,
    openDirectory,
    openDraft,
    openFullThread,
    openMain,
    openAutomations,
    openAutomationTarget,
  ]);

  useEffect(() => {
    if (!locationReady) return;
    const search = workbenchLocation(
      directory.page,
      selectedThreadId,
      mainThreadId,
      settingsSection,
      directory.automationScheduleId,
      directory.automationThreadId,
      directory.draftWorkspaceId,
    );
    if (search !== window.location.search) {
      historyIndex.current += 1;
      window.history.pushState(
        { kairosNavigationIndex: historyIndex.current },
        '',
        `${window.location.pathname}${search}`,
      );
    }
  }, [
    locationReady,
    directory.page,
    directory.automationScheduleId,
    directory.automationThreadId,
    directory.draftWorkspaceId,
    selectedThreadId,
    mainThreadId,
    settingsSection,
  ]);

  useEffect(() => {
    if (!highlightedCallId) return;
    const timer = window.setTimeout(() => setHighlightedCallId(null), 1600);
    return () => window.clearTimeout(timer);
  }, [highlightedCallId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isMainShortcut(event)) {
        event.preventDefault();
        openMain();
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLTextAreaElement>('[data-composer-owner="main"] textarea')
            ?.focus();
        });
        return;
      }
      if (event.key === 'Escape') {
        setNavigationOpen(false);
        setActiveTopic(null);
        setActiveSubagent(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openMain]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1020px)');
    const update = () => {
      if (!media.matches && navigationOpen) setNavigationOpen(false);
      if (sidebarRef.current) sidebarRef.current.inert = media.matches && !navigationOpen;
      if (mainRef.current) mainRef.current.inert = media.matches && navigationOpen;
    };
    update();
    media.addEventListener('change', update);
    if (navigationOpen && media.matches)
      sidebarRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (!navigationOpen || !media.matches || event.key !== 'Tab') return;
      const elements = Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled)',
        ) ?? [],
      ).filter((e) => e.getClientRects().length > 0 && !e.closest('[inert]'));
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      media.removeEventListener('change', update);
      document.removeEventListener('keydown', trap);
      if (mainRef.current) mainRef.current.inert = false;
      if (navigationOpen) navigationButton.current?.focus({ preventScroll: true });
    };
  }, [navigationOpen]);

  const renderTopicPane = () =>
    activeTopic && (
      <ConversationPane
        key={activeTopic.threadId}
        clients={clients}
        threadSyncManager={threadSyncManager}
        variant="topic"
        composerOwner="topic"
        threadId={activeTopic.threadId}
        thread={activeThread}
        mainThreadId={mainThreadId}
        draftOwner={activeTopic.threadId}
        actions={actions}
        drafts={drafts}
        topicCards={allCards}
        previewRevision={previewRevision}
        toolExpansionChoices={toolExpansionChoices}
        onToolExpansionChange={onToolExpansionChange}
        origin={activeTopic.origin}
        invocationId={activeTopic.invocationId}
        onOpenTopic={openTopic}
        onOpenSubagent={openSubagent}
        onOpenDirectory={openDirectory}
        onOpenMain={openMain}
        onCloseTopic={closeDetail}
        onShowOrigin={showOrigin}
        showNotice={showNotice}
      />
    );

  const renderSubagentPane = () =>
    activeSubagent && (
      <ConversationPane
        key={`${activeSubagent.threadId}:${activeSubagent.agentId}`}
        clients={clients}
        threadSyncManager={threadSyncManager}
        variant="subagent"
        subagent={activeSubagent}
        composerOwner="subagent"
        threadId={activeSubagent.threadId}
        thread={null}
        mainThreadId={mainThreadId}
        draftOwner={`subagent:${activeSubagent.agentId}`}
        actions={actions}
        drafts={drafts}
        topicCards={allCards}
        previewRevision={previewRevision}
        toolExpansionChoices={toolExpansionChoices}
        onToolExpansionChange={onToolExpansionChange}
        onOpenTopic={openTopic}
        onOpenSubagent={openSubagent}
        onOpenDirectory={openDirectory}
        onOpenMain={openMain}
        onCloseTopic={closeDetail}
        onShowOrigin={showOrigin}
        showNotice={showNotice}
      />
    );

  return (
    <UserProfileProvider identity={identity} clients={clients}>
      <ThreadWorkspaceProvider value={threadWorkspaces}>
        <div className={`app-shell${navigationOpen ? ' navigation-open' : ''}`}>
          <a className="skip-link" href="#main-content">
            跳到消息区
          </a>
          <aside ref={sidebarRef} className="thread-sidebar" aria-label="工作台导航">
            <div className="brand-row">
              <button
                type="button"
                className="icon-button drawer-close"
                aria-label="关闭侧边栏"
                onClick={() => setNavigationOpen(false)}
              >
                <Icon name="close" />
              </button>
              <button type="button" className="brand" onClick={openMain} aria-label="Kairos 主对话">
                <EntityMark mainAgent className="brand-mark" />
                <img className="brand-wordmark" src={wordmark} alt="" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="搜索，暂不可用"
                title="搜索暂不可用"
                disabled
              >
                <Icon name="search" />
              </button>
            </div>
            <nav className="thread-list" aria-label="主要页面">
              <button
                type="button"
                className={mainVisible ? 'selected' : ''}
                data-nav="main"
                aria-current={mainVisible ? 'page' : undefined}
                onClick={openMain}
              >
                <Icon name="chat" />
                <span className="nav-label">主对话</span>
                <kbd>⌘ J</kbd>
              </button>
              <button
                type="button"
                className={
                  directory.page === 'automations' || directory.page === 'automationThread'
                    ? 'selected'
                    : ''
                }
                aria-current={
                  directory.page === 'automations' || directory.page === 'automationThread'
                    ? 'page'
                    : undefined
                }
                onClick={() => openAutomations()}
                data-nav="automations"
              >
                <Icon name="clock" />
                <span className="nav-label">定时任务</span>
              </button>
              <button
                type="button"
                className={directory.page === 'directory' ? 'selected' : ''}
                data-nav="topics"
                aria-current={directory.page === 'directory' ? 'page' : undefined}
                onClick={openDirectory}
              >
                <Icon name="chat" />
                <span className="nav-label">全部话题</span>
              </button>
              <button type="button" aria-label="看板，暂不可用" title="看板暂不可用" disabled>
                <Icon name="tasks" />
                <span className="nav-label">看板</span>
              </button>
            </nav>
            <section className="sidebar-section" aria-label="工作空间">
              <div className="sidebar-label">
                <span>工作空间</span>
                <span className="sidebar-label-actions">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="添加工作空间"
                    title="添加工作空间"
                    onClick={createWorkspace}
                  >
                    <Icon name="plus" className="i-sm" />
                  </button>
                  <button
                    type="button"
                    className={`icon-button${directory.page === 'workspaces' ? ' current' : ''}`}
                    aria-label="查看全部工作空间"
                    title="查看全部工作空间"
                    aria-current={directory.page === 'workspaces' ? 'page' : undefined}
                    onClick={openWorkspaces}
                  >
                    <Icon name="grid" className="i-sm" />
                  </button>
                </span>
              </div>
              {workspaceDirectory.loading && workspaceDirectory.groups.length === 0 && (
                <p className="muted">正在加载工作空间</p>
              )}
              {workspaceDirectory.error && (
                <p className="sidebar-error" role="alert">
                  {workspaceDirectory.error}
                </p>
              )}
              {workspaceDirectory.groups
                .filter((group) => !group.workspace?.hidden)
                .map((group) => (
                  <WorkspaceGroupSection
                    key={group.workspace?.workspaceId ?? 'unknown'}
                    group={group}
                    selectedThreadId={selectedThreadId}
                    busy={actions.busy}
                    onOpenThread={(threadId) => openFullThread(threadId, null, null)}
                    onNewTopic={() => openDraft(group.workspace?.workspaceId ?? null)}
                    onRename={async (threadId, title) =>
                      (await actions.execute(`rename-thread:${threadId}`, 'renameThread', {
                        threadId,
                        title,
                      })) !== undefined
                    }
                  />
                ))}
              {
                <TemporaryThreadsSection
                  threads={workspaceDirectory.temporary}
                  selectedThreadId={selectedThreadId}
                  busy={actions.busy}
                  onOpenThread={(threadId) => openFullThread(threadId, null, null)}
                  onNewTopic={() => openDraft(null)}
                  onRename={async (threadId, title) =>
                    (await actions.execute(`rename-thread:${threadId}`, 'renameThread', {
                      threadId,
                      title,
                    })) !== undefined
                  }
                />
              }
            </section>
            <div className="sidebar-bottom">
              <button
                type="button"
                className="connection-banner"
                aria-label="连接设备"
                title="连接设备"
                aria-current={directory.page === 'devices' ? 'page' : undefined}
                onClick={openDevices}
              >
                <Icon name="monitor" />
                <span className="nav-label">连接设备</span>
              </button>
              <button
                type="button"
                className="connection-banner"
                aria-label="设置"
                title="设置"
                aria-current={directory.page === 'settings' ? 'page' : undefined}
                onClick={openSettings}
              >
                <Icon name="settings" />
                <span className="nav-label">设置</span>
              </button>
              <div className="profile">
                <Dropdown
                  className="account-menu"
                  triggerClassName="account-trigger"
                  panelClassName="profile-popover"
                  label="账号菜单"
                  placement="top"
                  trigger={
                    <>
                      <UserAvatar className="avatar" />
                      <span className="profile-info">{identity.username}</span>
                    </>
                  }
                  header={
                    <>
                      <strong>{identity.username}</strong>
                      <span>{identity.email}</span>
                    </>
                  }
                  items={[{ value: 'logout', label: '退出登录' }]}
                  onSelect={() =>
                    navigate(() => {
                      void onLogout();
                    })
                  }
                />
                <button
                  type="button"
                  className="icon-button theme-toggle"
                  aria-label={theme === 'dark' ? '切换浅色' : '切换深色'}
                  onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                >
                  <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
                </button>
              </div>
            </div>
          </aside>
          <button
            type="button"
            className="phone-scrim"
            aria-label="关闭导航"
            tabIndex={-1}
            onClick={() => setNavigationOpen(false)}
          />
          <main ref={mainRef} id="main-content" className="workspace">
            <div className="mobile-toolbar">
              <button
                type="button"
                ref={navigationButton}
                className="icon-button mobile-menu"
                aria-label="打开导航"
                aria-expanded={navigationOpen}
                onClick={() => setNavigationOpen(true)}
              >
                <Icon name="menu" />
              </button>
              <span>Kairos</span>
            </div>
            {health !== 'ready' && (
              <span
                className={`server-status health-${health}`}
                role="status"
                title={health === 'loading' ? '正在连接服务' : '服务连接失败'}
              >
                <Icon
                  name={health === 'loading' ? 'spinner' : 'alert'}
                  className={`i-sm${health === 'loading' ? ' spinning' : ''}`}
                />
                <span className="sr-only">
                  {health === 'loading' ? '正在连接服务' : '服务连接失败'}
                </span>
              </span>
            )}
            {notice && (
              <div className="workspace-notice" role="status">
                <span title={notice}>{notice}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="关闭通知"
                  onClick={() => setNotice(null)}
                >
                  <Icon name="close" className="i-sm" />
                </button>
              </div>
            )}
            {actions.failures.length > 0 && (
              <div className="operation-failures">
                {actions.failures.map((failure) => (
                  <FailureNotice
                    key={failure.key}
                    label="操作失败"
                    message={`${failure.message}${failure.outcome === 'unknown' ? ' 操作结果未知，重试将沿用原操作编号。' : ' 本次操作失败，可以重新提交。'}`}
                    busy={actions.busy}
                    onRetry={
                      failure.outcome === 'unknown'
                        ? () => void actions.retry(failure.key)
                        : undefined
                    }
                    onDismiss={() => actions.dismiss(failure.key)}
                  />
                ))}
              </div>
            )}
            <div className="workbench-viewport">
              {mainThreadId && directory.page !== 'draft' && (
                <DualPaneLayout
                  mainVisible={mainVisible}
                  hasTopic={activeTopic !== null || activeSubagent !== null}
                  narrowViewport={narrowViewport}
                >
                  <ConversationPane
                    key={mainThreadId}
                    clients={clients}
                    threadSyncManager={threadSyncManager}
                    variant="main"
                    displayMode={conversationDisplay.mode}
                    composerOwner="main"
                    threadId={mainThreadId}
                    thread={mainThread}
                    mainThreadId={mainThreadId}
                    draftOwner={mainThreadId}
                    actions={actions}
                    drafts={drafts}
                    topicCards={allCards}
                    previewRevision={previewRevision}
                    toolExpansionChoices={toolExpansionChoices}
                    onToolExpansionChange={onToolExpansionChange}
                    highlightedCallId={highlightedCallId}
                    hidden={!mainVisible}
                    onOpenTopic={openTopic}
                    onOpenSubagent={openSubagent}
                    onOpenDirectory={openDirectory}
                    onOpenMain={openMain}
                    onCloseTopic={closeDetail}
                    onShowOrigin={showOrigin}
                    showNotice={showNotice}
                  />
                  {mainVisible && renderTopicPane()}
                  {activeSubagent && mainVisible && renderSubagentPane()}
                </DualPaneLayout>
              )}
              {directory.page === 'automationThread' &&
              directory.automationScheduleId &&
              directory.automationThreadId ? (
                <ConversationPane
                  key={`${directory.automationScheduleId}:${directory.automationThreadId}`}
                  clients={clients}
                  threadSyncManager={threadSyncManager}
                  variant="automation"
                  automationScheduleId={directory.automationScheduleId}
                  composerOwner="automation"
                  threadId={directory.automationThreadId}
                  thread={null}
                  mainThreadId={mainThreadId}
                  draftOwner={`automation:${directory.automationScheduleId}:${directory.automationThreadId}`}
                  actions={actions}
                  drafts={drafts}
                  topicCards={allCards}
                  previewRevision={previewRevision}
                  toolExpansionChoices={toolExpansionChoices}
                  onToolExpansionChange={onToolExpansionChange}
                  onOpenTopic={openTopic}
                  onOpenSubagent={openSubagent}
                  onOpenDirectory={openDirectory}
                  onOpenMain={openMain}
                  onCloseTopic={() => openAutomations(directory.automationScheduleId)}
                  onShowOrigin={() => {}}
                  showNotice={showNotice}
                />
              ) : directory.page === 'automations' ? (
                <AutomationPage
                  clients={clients}
                  actions={actions}
                  mainThreadId={mainThreadId}
                  selectedScheduleId={directory.automationScheduleId}
                  revision={automationRevision}
                  onSelect={openAutomations}
                  onOpenThread={openAutomationTarget}
                />
              ) : directory.page === 'settings' ? (
                <SettingsPage
                  clients={clients}
                  identity={identity}
                  section={settingsSection}
                  onSectionChange={(section) => {
                    if (section !== settingsSection) navigate(() => setSettingsSection(section));
                  }}
                  onIdentityChange={onIdentityChange}
                  onDirtyChange={onSettingsDirty}
                  conversationDisplayMode={conversationDisplay.mode}
                  conversationDisplayError={conversationDisplay.error}
                  onConversationDisplayChange={changeConversationDisplay}
                  theme={theme}
                  onThemeChange={setTheme}
                />
              ) : directory.page === 'devices' ? (
                <ConnectedDevicesPage clients={clients} />
              ) : directory.page === 'workspaces' ? (
                <WorkspacesPage
                  groups={workspaceDirectory.groups}
                  temporary={workspaceDirectory.temporary}
                  cards={workspaceCards.cards}
                  cardsError={workspaceCards.error}
                  onCardsRetry={workspaceCards.reload}
                  mainThreadId={mainThreadId}
                  busy={workspaceBusy}
                  onCreate={createWorkspace}
                  onEdit={editWorkspace}
                  onVisibility={(workspace) => void changeWorkspaceVisibility(workspace)}
                  onDelete={(group) => {
                    setDeletingWorkspace(group);
                    setDeleteConfirmation('');
                    setWorkspaceError(null);
                    deleteActionId.current = randomId();
                  }}
                  onNewTopic={openDraft}
                  loading={workspaceDirectory.loading}
                  error={(deletingWorkspace ? null : workspaceError) ?? workspaceDirectory.error}
                  onChanged={workspaceDirectory.refresh}
                  onOpenThread={(threadId) => openFullThread(threadId, null, null)}
                />
              ) : directory.page === 'directory' ? (
                <ThreadListPage
                  cards={topics.state.cards}
                  sort={topics.state.sort}
                  mainThreadId={mainThreadId}
                  loading={topics.state.loading}
                  error={topics.state.error}
                  hasMore={topics.state.hasMore}
                  workspaceNames={
                    new Map(
                      workspaceDirectory.groups
                        .filter((group) => group.workspace !== null)
                        .map((group) => [
                          group.workspace?.workspaceId ?? '',
                          group.workspace?.name ?? '',
                        ]),
                    )
                  }
                  onOpen={(card) =>
                    openFullThread(
                      card.thread.threadId,
                      card.origin,
                      card.origin?.delegation.sourceToolCallId ?? null,
                    )
                  }
                  onSort={(sort) => void topics.setSort(sort)}
                  onLoadMore={topics.loadMore}
                  onReload={topics.openDirectory}
                  onManageWorkspaces={openWorkspaces}
                />
              ) : directory.page === 'draft' ? (
                <ConversationPane
                  clients={clients}
                  threadSyncManager={threadSyncManager}
                  variant="draft"
                  composerOwner="draft"
                  threadId={null}
                  thread={null}
                  mainThreadId={mainThreadId}
                  draftOwner={`${localTaskDraftId}:${directory.draftWorkspaceId ?? 'temporary'}`}
                  draftWorkspaceId={directory.draftWorkspaceId}
                  actions={actions}
                  drafts={drafts}
                  topicCards={allCards}
                  previewRevision={previewRevision}
                  toolExpansionChoices={toolExpansionChoices}
                  onToolExpansionChange={onToolExpansionChange}
                  onOpenTopic={openTopic}
                  onOpenSubagent={openSubagent}
                  onOpenDirectory={openDirectory}
                  onOpenMain={openMain}
                  onCloseTopic={closeDetail}
                  onShowOrigin={() => {}}
                  showNotice={showNotice}
                />
              ) : !mainVisible && selectedThreadId ? (
                <DualPaneLayout
                  mainVisible
                  hasTopic={activeTopic !== null || activeSubagent !== null}
                  narrowViewport={narrowViewport}
                >
                  <ConversationPane
                    key={selectedThreadId}
                    onEditWorkspace={
                      selectedThread?.threadType === ThreadType.WORKSPACE_MAIN
                        ? () => {
                            const workspace = workspaceDirectory.groups.find(
                              (g) => g.workspace?.workspaceId === selectedThread.workspaceId,
                            )?.workspace;
                            if (workspace) editWorkspace(workspace);
                          }
                        : undefined
                    }
                    clients={clients}
                    threadSyncManager={threadSyncManager}
                    variant="fullscreen"
                    displayMode={conversationDisplay.mode}
                    composerOwner="fullscreen"
                    threadId={selectedThreadId}
                    thread={selectedThread}
                    mainThreadId={mainThreadId}
                    draftOwner={selectedThreadId}
                    actions={actions}
                    drafts={drafts}
                    topicCards={allCards}
                    previewRevision={previewRevision}
                    toolExpansionChoices={toolExpansionChoices}
                    onToolExpansionChange={onToolExpansionChange}
                    highlightedCallId={highlightedCallId}
                    origin={fullTopic.origin}
                    invocationId={fullTopic.invocationId}
                    onOpenTopic={openTopic}
                    onOpenSubagent={openSubagent}
                    onOpenDirectory={openDirectory}
                    onOpenMain={openMain}
                    onCloseTopic={closeDetail}
                    onShowOrigin={showOrigin}
                    showNotice={showNotice}
                  />
                  {renderTopicPane()}
                  {renderSubagentPane()}
                </DualPaneLayout>
              ) : null}
            </div>
          </main>
        </div>
        {workspaceEditor && (
          <WorkspaceDialog
            clients={clients}
            workspace={workspaceEditor.workspace}
            onClose={() => setWorkspaceEditor(null)}
            onSaved={() => {
              setWorkspaceEditor(null);
              workspaceDirectory.refresh();
              setPreviewRevision((v) => v + 1);
            }}
          />
        )}
        {deletingWorkspace?.workspace && (
          <AppDialog
            title="删除工作空间"
            closeDisabled={workspaceBusy}
            onClose={() => {
              setDeletingWorkspace(null);
              setWorkspaceError(null);
            }}
            actions={
              <>
                <button
                  type="button"
                  className="device-secondary"
                  disabled={workspaceBusy}
                  onClick={() => {
                    setDeletingWorkspace(null);
                    setWorkspaceError(null);
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="device-primary device-danger"
                  disabled={
                    workspaceBusy || deleteConfirmation !== deletingWorkspace.workspace.name
                  }
                  onClick={() => void removeWorkspace()}
                >
                  {workspaceBusy ? '正在删除…' : '删除工作空间及对话'}
                </button>
              </>
            }
          >
            <div className="workspace-delete-confirm">
              <p>
                将永久删除“{deletingWorkspace.workspace.name}”、主对话和其中的{' '}
                {deletingWorkspace.tasks.length} 个话题及其历史记录。
              </p>
              <p>
                设备上的项目目录和文件保留。仍在执行的任务需要先停止；使用该空间的定时任务需先修改执行目标或删除。
              </p>
              <label className="settings-field">
                输入工作空间名称确认
                <input
                  value={deleteConfirmation}
                  onChange={(e) => setDeleteConfirmation(e.target.value)}
                  autoComplete="off"
                  placeholder={deletingWorkspace.workspace.name}
                />
              </label>
              {workspaceError && (
                <p className="settings-error" role="alert">
                  {workspaceError}
                </p>
              )}
            </div>
          </AppDialog>
        )}
        {leaveAction && (
          <AppDialog
            title="放弃未保存的修改"
            subtitle="设置中有未保存的修改或尚未确认的操作。离开后请重新进入核对保存结果。"
            onClose={() => setLeaveAction(null)}
            actions={
              <>
                <button
                  type="button"
                  className="device-secondary"
                  onClick={() => setLeaveAction(null)}
                >
                  继续编辑
                </button>
                <button
                  type="button"
                  className="device-primary"
                  onClick={() => {
                    dirtySettings.current = false;
                    const action = leaveAction;
                    setLeaveAction(null);
                    action();
                  }}
                >
                  放弃并离开
                </button>
              </>
            }
          >
            <p>已完成的保存不会撤销。</p>
          </AppDialog>
        )}
      </ThreadWorkspaceProvider>
    </UserProfileProvider>
  );
}
