import {
  type Input,
  type InputMode,
  type Message,
  MessageRole,
  type Run,
  RunStatus,
  type SubagentCallView,
  type Thread,
  type ThreadSnapshot,
  ThreadType,
} from '@kairos/contracts';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppDialog } from './app-dialog.js';
import { AttachmentUploader } from './attachment-upload.js';
import type { KairosClients } from './client.js';
import { Composer } from './composer.js';
import { type ComposerSubmission, planComposerSubmission } from './composer-submission.js';
import { MessageCard, projectQueuedInputs, RecapLine, RunOutcomeCard } from './conversation.js';
import type { ConversationDisplayMode } from './conversation-display.js';
import { projectConversationDisplay } from './conversation-display-projection.js';
import {
  clampHiddenTurnCount,
  conversationHistoryStartIndex,
  conversationTurnCount,
  conversationTurnStarts,
  initialHiddenTurnCount,
  revealEarlierTurnCount,
} from './conversation-history.js';
import { ConversationLoading } from './conversation-loading.js';
import { delegationKey } from './delegation.js';
import type { OpenTopicRequest } from './delegation-cards.js';
import { type DraftAttachment, localTaskDraftId } from './drafts.js';
import { EntityMark } from './entity-mark.js';
import { FailureNotice } from './failure-notice.js';
import { Icon } from './icon.js';
import { isDirectUserMessage, isRootAgent } from './labels.js';
import { queueDraftRestorePayload } from './queue-draft.js';
import { QueueStack } from './queue-stack.js';
import { PendingAgentCard } from './response-components.js';
import { projectConversation, selectPaneMessages } from './response-projection.js';
import type { ThinkingExpansionChoices } from './thinking-expansion.js';
import { withThinkingBlockExpanded } from './thinking-expansion.js';
import type { ThreadSyncManager } from './thread-sync-manager.js';
import { TitleEditor, TopicTitleActions } from './thread-title.js';
import { type AgentOrigin, projectDelegationReceipts, type TopicCardView } from './thread-view.js';
import { calendarDateKey, formatCalendarDate, timestampDate } from './time-format.js';
import type { ToolExpansionChange, ToolExpansionChoices } from './tool-call-groups.js';
import { projectAssociatedToolResultIds, projectToolOutcomes } from './tool-group-projection.js';
import type { useActionExecutor } from './use-action-executor.js';
import { useCallPreviews } from './use-call-previews.js';
import { useChannelDeliveries } from './use-channel-deliveries.js';
import { useConversationScroll } from './use-conversation-scroll.js';
import type { useDrafts } from './use-drafts.js';
import { useMessageEntrance } from './use-message-entrance.js';
import { useSubagentViews } from './use-subagent-views.js';
import { useThreadSync } from './use-thread-sync.js';
import { canLocateAgentOrigin, originElementId } from './workbench-navigation.js';

export type ConversationVariant =
  | 'main'
  | 'fullscreen'
  | 'topic'
  | 'draft'
  | 'subagent'
  | 'automation';
type SharedActions = ReturnType<typeof useActionExecutor>;
type DraftStore = Omit<ReturnType<typeof useDrafts>, 'discardDrafts'>;

export function ConversationPane({
  clients,
  threadSyncManager,
  variant,
  composerOwner,
  threadId,
  thread,
  mainThreadId,
  draftOwner,
  draftWorkspaceId = null,
  actions,
  drafts,
  topicCards,
  previewRevision,
  toolExpansionChoices,
  onToolExpansionChange,
  origin: requestedOrigin = null,
  subagent,
  automationScheduleId,
  onOpenSubagent = () => {},
  invocationId = null,
  highlightedCallId = null,
  hidden = false,
  displayMode = 'full',
  onOpenTopic,
  onCloseTopic,
  onShowOrigin,
  showNotice,
  onEditWorkspace,
}: {
  clients: KairosClients;
  threadSyncManager: ThreadSyncManager;
  variant: ConversationVariant;
  composerOwner: string;
  threadId: string | null;
  thread: Thread | null;
  mainThreadId: string | null;
  draftOwner: string;
  draftWorkspaceId?: string | null;
  onEditWorkspace?: (() => void) | undefined;
  actions: SharedActions;
  drafts: DraftStore;
  topicCards: readonly TopicCardView[];
  previewRevision: number;
  toolExpansionChoices: ToolExpansionChoices;
  onToolExpansionChange: ToolExpansionChange;
  origin?: AgentOrigin | null;
  subagent?: SubagentCallView | undefined;
  automationScheduleId?: string | undefined;
  onOpenSubagent?: (view: SubagentCallView) => void;
  invocationId?: string | null;
  highlightedCallId?: string | null;
  hidden?: boolean;
  displayMode?: ConversationDisplayMode;
  onOpenTopic: (request: OpenTopicRequest) => void;
  onOpenDirectory: () => void;
  onOpenMain: () => void;
  onCloseTopic: () => void;
  onShowOrigin: (threadId: string, origin: AgentOrigin) => void;
  showNotice: (message: string) => void;
}) {
  const isDraft = variant === 'draft';
  const isSubagent = variant === 'subagent';
  const isAutomation = variant === 'automation';
  const readOnly = isSubagent || isAutomation;
  const [fullViewOverride, setFullViewOverride] = useState(false);
  const usesDisplayMode =
    variant === 'main' ||
    (variant === 'fullscreen' && thread?.threadType === ThreadType.WORKSPACE_MAIN);
  const effectiveDisplayMode: ConversationDisplayMode = fullViewOverride ? 'full' : displayMode;
  const agentId = isSubagent ? (subagent?.agentId ?? '') : 'thread';
  const origin: AgentOrigin | null =
    requestedOrigin ??
    (subagent?.call?.delegation
      ? {
          delegation: subagent.call.delegation,
          prompt: subagent.task,
          sourceMessageId: subagent.call.sourceMessageId,
        }
      : null);
  const activeThreadId = isDraft ? null : threadId;
  const threadSync = useThreadSync(
    threadSyncManager,
    activeThreadId,
    isAutomation ? automationScheduleId : undefined,
  );
  const snapshot = threadSync.state.snapshot;
  const selectedThread = snapshot?.thread ?? thread;
  const [title, setTitle] = useState(
    isSubagent ? '子代理' : (selectedThread?.title ?? (isAutomation ? '定时任务历史' : '新话题')),
  );
  const [editingTitle, setEditingTitle] = useState(false);
  const [historyWindow, setHistoryWindow] = useState<{
    key: string;
    hiddenTurnCount: number;
  } | null>(null);
  const [editingActionKey, setEditingActionKey] = useState<string | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [newConversationSubmission, setNewConversationSubmission] = useState<Extract<
    ComposerSubmission,
    { kind: 'action' }
  > | null>(null);
  const [newConversationStarting, setNewConversationStarting] = useState(false);
  const [thinkingExpansionChoices, setThinkingExpansionChoices] =
    useState<ThinkingExpansionChoices>({});
  const root = useRef<HTMLElement>(null);
  const locatedInvocation = useRef<string | null>(null);
  const locatedHighlight = useRef<string | null>(null);
  const draft = drafts.getDraft(draftOwner);
  const attachmentUploader = useMemo(
    () =>
      new AttachmentUploader(
        clients,
        {
          getDraft: () => drafts.getDraft(draftOwner),
          updateDraft: (next) => drafts.updateDraft(draftOwner, next),
        },
        { composerOwner, threadId: activeThreadId ?? localTaskDraftId },
      ),
    [activeThreadId, clients, composerOwner, draftOwner, drafts.getDraft, drafts.updateDraft],
  );
  const allMessages = useMemo(() => snapshot?.messages ?? [], [snapshot]);
  const sourceCall = variant === 'topic' ? origin?.delegation : undefined;
  const messages = useMemo(
    () =>
      selectPaneMessages(
        allMessages,
        agentId,
        isSubagent
          ? { task: subagent?.task, runId: subagent?.runId }
          : sourceCall
            ? { sourceCall }
            : undefined,
      ),
    [allMessages, agentId, isSubagent, subagent?.task, subagent?.runId, sourceCall],
  );
  const latestDirectUserMessageId = allMessages.findLast(
    (message) =>
      !message.supersededByRunId && isRootAgent(message.agentId) && isDirectUserMessage(message),
  )?.messageId;
  const subagentViews = useSubagentViews(clients, messages, previewRevision);
  const receipts = useMemo(() => projectDelegationReceipts(messages), [messages]);
  const toolOutcomes = useMemo(() => projectToolOutcomes(messages), [messages]);
  const associatedToolResultIds = useMemo(
    () => projectAssociatedToolResultIds(messages, toolOutcomes),
    [messages, toolOutcomes],
  );
  const callPreviews = useCallPreviews(clients, activeThreadId, messages, previewRevision);
  const notifications = useMemo(() => {
    const views = new Map<string, NonNullable<ThreadSnapshot['notifications'][number]>>();
    for (const notification of snapshot?.notifications ?? []) {
      if (notification.delegation) {
        views.set(delegationKey(notification.delegation), notification);
      }
    }
    return views;
  }, [snapshot?.notifications]);
  const topicTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const card of topicCards) titles.set(card.thread.threadId, card.thread.title);
    for (const preview of callPreviews.previews.values()) {
      if (preview.target) titles.set(preview.target.threadId, preview.target.title);
    }
    if (selectedThread) titles.set(selectedThread.threadId, selectedThread.title);
    return titles;
  }, [callPreviews.previews, selectedThread, topicCards]);
  const conversationItems = useMemo(() => {
    const visibleMessageIds = new Set(messages.map((message) => message.messageId));
    const visibleSequences = new Set(messages.map((message) => message.seq));
    return projectConversation({
      threadId: activeThreadId ?? '',
      agentId,
      messages: allMessages,
      transientResponses: threadSync.state.transientResponses,
      runs: snapshot?.runs ?? [],
      inputs: snapshot?.inputs ?? [],
      recaps: snapshot?.recaps ?? [],
      invalidatedRecaps: threadSync.state.invalidatedRecaps,
    }).filter((item) => {
      if (item.kind === 'run-outcome' || item.kind === 'missing-user-reply') return true;
      if (item.kind === 'pending-agent') return true;
      if (item.kind === 'recap') return visibleSequences.has(item.value.sourceSeqEnd);
      return item.value.streaming || visibleMessageIds.has(item.value.message.messageId);
    });
  }, [
    activeThreadId,
    agentId,
    allMessages,
    messages,
    snapshot?.runs,
    snapshot?.inputs,
    snapshot?.recaps,
    threadSync.state.transientResponses,
    threadSync.state.invalidatedRecaps,
  ]);
  const turnStarts = useMemo(() => conversationTurnStarts(conversationItems), [conversationItems]);
  const turnCount = conversationTurnCount(conversationItems, turnStarts);
  const initialHiddenCount = initialHiddenTurnCount(turnCount);
  const historyKey = `${activeThreadId ?? localTaskDraftId}:${agentId}`;
  const hiddenTurnCount =
    historyWindow?.key === historyKey
      ? clampHiddenTurnCount(turnCount, historyWindow.hiddenTurnCount)
      : initialHiddenCount;
  const historyStartIndex = conversationHistoryStartIndex(turnStarts, hiddenTurnCount);
  const hasEarlierTurns = historyStartIndex > 0;
  const visibleConversationItems = useMemo(
    () =>
      projectConversationDisplay(
        conversationItems.slice(historyStartIndex),
        snapshot?.runs ?? [],
        usesDisplayMode ? effectiveDisplayMode : 'full',
      ),
    [conversationItems, historyStartIndex, snapshot?.runs, usesDisplayMode, effectiveDisplayMode],
  );
  const channelDeliveryIds = useMemo(() => {
    const ids: string[] = [];
    for (const item of visibleConversationItems) {
      if (item.kind !== 'message') continue;
      for (const delivery of item.value.sentMessage?.deliveries ?? []) {
        ids.push(delivery.deliveryId);
      }
    }
    return ids;
  }, [visibleConversationItems]);
  const channelDeliveries = useChannelDeliveries(clients, channelDeliveryIds);
  const loadEarlierTurns = useCallback((): boolean => {
    if (!hasEarlierTurns) return false;
    setHistoryWindow((current) => {
      const currentHiddenCount =
        current?.key === historyKey
          ? clampHiddenTurnCount(turnCount, current.hiddenTurnCount)
          : initialHiddenCount;
      return { key: historyKey, hiddenTurnCount: revealEarlierTurnCount(currentHiddenCount) };
    });
    return true;
  }, [hasEarlierTurns, historyKey, initialHiddenCount, turnCount]);
  const { viewportRef, contentRef, followAfterSend, pauseFollowing, loadEarlier, loadingEarlier } =
    useConversationScroll(!hidden && snapshot !== null && !isDraft, loadEarlierTurns, {
      key: historyKey,
      startIndex: historyStartIndex,
      displayMode: usesDisplayMode ? effectiveDisplayMode : 'full',
    });
  useMessageEntrance(
    viewportRef,
    !hidden && snapshot !== null && !isDraft,
    `${historyKey}:${historyStartIndex}:${usesDisplayMode ? effectiveDisplayMode : 'full'}`,
  );

  useEffect(() => {
    if (!snapshot || isDraft) return;
    setHistoryWindow((current) =>
      current?.key === historyKey
        ? current
        : { key: historyKey, hiddenTurnCount: initialHiddenCount },
    );
  }, [historyKey, initialHiddenCount, isDraft, snapshot]);

  useEffect(() => {
    attachmentUploader.activate();
    return () => attachmentUploader.stop();
  }, [attachmentUploader]);

  useEffect(() => {
    if (!isSubagent && snapshot?.thread) setTitle(snapshot.thread.title);
  }, [isSubagent, snapshot?.thread]);

  useEffect(() => {
    if (hidden || !invocationId || !root.current || messages.length === 0) return;
    const key = `${activeThreadId}:${invocationId}`;
    if (locatedInvocation.current === key) return;
    const target = root.current.querySelector(
      `[data-delegation-call-id="${CSS.escape(invocationId)}"]`,
    );
    if (!target) {
      if (hasEarlierTurns) loadEarlierTurns();
      return;
    }
    locatedInvocation.current = key;
    pauseFollowing();
    target.scrollIntoView({ block: 'start' });
  }, [
    activeThreadId,
    hasEarlierTurns,
    hidden,
    invocationId,
    loadEarlierTurns,
    messages,
    pauseFollowing,
  ]);

  useEffect(() => {
    if (hidden || (variant !== 'main' && variant !== 'fullscreen') || !highlightedCallId) return;
    const key = `${activeThreadId}:${highlightedCallId}`;
    if (locatedHighlight.current === key) return;
    const frame = requestAnimationFrame(() => {
      const target = root.current?.querySelector(
        `#${CSS.escape(originElementId(highlightedCallId))}`,
      );
      if (!target) {
        if (hasEarlierTurns) loadEarlierTurns();
        return;
      }
      locatedHighlight.current = key;
      pauseFollowing();
      target.scrollIntoView({
        block: 'center',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
      target.classList.add('source-highlight');
    });
    return () => cancelAnimationFrame(frame);
  }, [
    activeThreadId,
    hasEarlierTurns,
    hidden,
    highlightedCallId,
    loadEarlierTurns,
    variant,
    pauseFollowing,
  ]);

  const onThinkingExpansionChange = useCallback(
    (messageId: string, blockIndex: number, expanded: boolean) => {
      setThinkingExpansionChoices((current) =>
        withThinkingBlockExpanded(current, messageId, blockIndex, expanded),
      );
    },
    [],
  );

  async function renameThread(nextTitle: string): Promise<boolean> {
    if (!activeThreadId || !nextTitle.trim()) return false;
    const result = await actions.execute(`rename-thread:${activeThreadId}`, 'renameThread', {
      threadId: activeThreadId,
      title: nextTitle.trim(),
    });
    if (result !== undefined) {
      setTitle(nextTitle.trim());
      setEditingTitle(false);
      return true;
    }
    return false;
  }

  async function sendMessage(mode: InputMode): Promise<void> {
    const submission = planComposerSubmission({
      draftId: draft.id,
      text: draft.text,
      attachments: draft.attachments ?? [],
      mode,
      busy: actions.busy,
      isTaskDraft: isDraft,
      isMainThread: variant === 'main',
      workspaceId: draftWorkspaceId,
      selectedThreadId: activeThreadId,
      snapshotReady: snapshot !== null,
    });
    if (submission.kind === 'error') {
      setComposerError(submission.message);
      return;
    }
    if (submission.kind === 'ignore') {
      if (!actions.busy) setComposerError(null);
      return;
    }
    setComposerError(null);
    if (submission.requiresConfirmation === 'newConversation') {
      setNewConversationSubmission(submission);
      return;
    }
    await executeSubmission(submission);
  }

  async function executeSubmission(
    submission: Extract<ComposerSubmission, { kind: 'action' }>,
  ): Promise<void> {
    const pendingNotice = submission.pendingNotice;
    if (pendingNotice) showNotice(pendingNotice);
    const payload =
      isDraft &&
      submission.actionKind === 'createThread' &&
      submission.payload &&
      typeof submission.payload === 'object'
        ? { ...submission.payload, title: title.trim() || '新话题', draftOwner }
        : submission.payload;
    if (submission.actionKind === 'sendMessage' || submission.actionKind === 'createThread')
      followAfterSend();
    const startingNewConversation = submission.actionKind === 'startNewMain';
    if (startingNewConversation) setNewConversationStarting(true);
    try {
      const result = await actions.execute(submission.key, submission.actionKind, payload);
      if (pendingNotice && result === undefined) showNotice('');
    } finally {
      if (startingNewConversation) setNewConversationStarting(false);
    }
  }

  async function removeDraftAttachment(attachment: DraftAttachment): Promise<void> {
    if (attachment.status !== 'ready' && attachment.status !== 'deleting') {
      try {
        attachmentUploader.removeLocal(attachment.localId);
        setComposerError(null);
      } catch (cause) {
        setComposerError(cause instanceof Error ? cause.message : String(cause));
      }
      return;
    }
    const metadata = attachment.metadata;
    if (!metadata) {
      setComposerError('已确认附件缺少元数据，不能请求删除。');
      return;
    }
    if (attachment.status === 'ready') {
      drafts.updateDraft(draftOwner, {
        ...draft,
        attachments: (draft.attachments ?? []).map((item) =>
          item.localId === attachment.localId ? { ...item, status: 'deleting' as const } : item,
        ),
      });
    }
    await actions.execute(
      `delete-attachment:${composerOwner}:${activeThreadId ?? localTaskDraftId}:${draft.id}:${attachment.localId}`,
      'deleteAttachment',
      {
        draftOwner,
        composerOwner,
        threadId: activeThreadId ?? localTaskDraftId,
        draftId: draft.id,
        localId: attachment.localId,
        attachmentId: metadata.attachmentId,
      },
    );
  }

  async function reviseMessage(message: Message, text: string): Promise<boolean> {
    if (!activeThreadId || (!text.trim() && message.attachments.length === 0)) return false;
    const key = `revise-message:${message.messageId}`;
    const response = await actions.execute(key, 'reviseMessage', {
      threadId: activeThreadId,
      messageId: message.messageId,
      text,
      expectedRevisionId: message.revisionId ?? null,
    });
    const saved = response !== undefined;
    if (saved) setEditingActionKey((current) => (current === key ? null : current));
    return saved;
  }

  async function rerun(message: Message): Promise<void> {
    if (!activeThreadId) return;
    await actions.execute(`rerun:${message.messageId}`, 'rerun', {
      threadId: activeThreadId,
      messageId: message.messageId,
    });
  }

  async function takeInput(input: Input): Promise<void> {
    if (!activeThreadId || input.delegation) return;
    const restored = await actions.execute(`remove-input:${input.inputId}`, 'removeInput', {
      threadId: activeThreadId,
      inputId: input.inputId,
      expectedVersion: input.version.toString(),
      draftRestore: queueDraftRestorePayload(input, draftOwner),
    });
    if (restored !== undefined)
      requestAnimationFrame(() =>
        root.current?.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(),
      );
  }

  async function removeInput(input: Input): Promise<void> {
    if (!activeThreadId) return;
    await actions.execute(`remove-input:${input.inputId}`, 'removeInput', {
      threadId: activeThreadId,
      inputId: input.inputId,
      expectedVersion: input.version.toString(),
    });
  }

  async function reorderInputs(inputIds: string[]): Promise<boolean> {
    if (!activeThreadId || !snapshot) return false;
    const response = await actions.execute(`reorder-inputs:${activeThreadId}`, 'reorderInputs', {
      threadId: activeThreadId,
      inputIds,
      expectedVersion: snapshot.queueVersion.toString(),
    });
    return response !== undefined;
  }

  async function cancelRun(run: Run): Promise<void> {
    if (!activeThreadId) return;
    await actions.execute(`cancel-run:${run.runId}`, 'cancelRun', {
      threadId: activeThreadId,
      runId: run.runId,
      reason: '用户从 GUI 请求停止',
    });
  }

  async function continueRun(run: Run): Promise<void> {
    if (!activeThreadId) return;
    await actions.execute(`continue-run:${run.runId}`, 'continueRun', {
      threadId: activeThreadId,
      runId: run.runId,
    });
  }

  const latestRun = snapshot?.runs.filter((run) => run.agentId === agentId).at(-1);
  const activeRun =
    latestRun &&
    (latestRun.status === RunStatus.QUEUED ||
      latestRun.status === RunStatus.RUNNING ||
      latestRun.status === RunStatus.WAITING ||
      latestRun.status === RunStatus.CANCEL_REQUESTED)
      ? latestRun
      : null;
  const messageActionsUnavailable = actions.busy || activeRun !== null;
  useEffect(() => {
    if (activeRun) setEditingActionKey(null);
  }, [activeRun]);
  const label =
    variant === 'subagent'
      ? '子代理详情'
      : variant === 'automation'
        ? '定时任务历史'
        : variant === 'main'
          ? '主对话'
          : variant === 'topic'
            ? '话题回复'
            : variant === 'draft'
              ? '新话题'
              : '全屏话题';
  const continuationIds = new Set<string>();
  let previousAssistant: Message | null = null;
  for (const item of visibleConversationItems) {
    if (item.kind !== 'message') {
      previousAssistant = null;
      continue;
    }
    const message = item.value.message;
    if (item.value.sentMessage) {
      if (previousAssistant?.runId && message.runId === previousAssistant.runId) {
        continuationIds.add(item.key);
      }
      previousAssistant = message;
      continue;
    }
    if (
      message.role === MessageRole.TOOL &&
      (associatedToolResultIds.has(message.toolCallId) ||
        receipts.get(message.toolCallId)?.status === 'accepted')
    )
      continue;
    if (
      message.role === MessageRole.ASSISTANT &&
      previousAssistant?.runId &&
      message.runId === previousAssistant.runId &&
      message.agentId === previousAssistant.agentId
    )
      continuationIds.add(item.key);
    previousAssistant = message.role === MessageRole.ASSISTANT ? message : null;
  }
  const visibleMessageCount = messages.filter(
    (message) =>
      !message.supersededByRunId &&
      (message.role === MessageRole.USER || message.role === MessageRole.ASSISTANT),
  ).length;

  const dates = new Map<string, { label: string; dateTime: string }>();
  const now = new Date();
  let previousDay = '';
  for (const item of visibleConversationItems) {
    if (
      item.kind !== 'message' ||
      (item.value.message.role === MessageRole.TOOL && !item.value.sentMessage) ||
      !item.value.message.createdAt
    )
      continue;
    const date = timestampDate(item.value.message.createdAt);
    if (!date) continue;
    const day = calendarDateKey(date);
    if (day === previousDay) continue;
    previousDay = day;
    dates.set(item.key, {
      label: formatCalendarDate(date, now),
      dateTime: date.toISOString(),
    });
  }
  const renderItem = (item: (typeof conversationItems)[number]) => (
    <Fragment key={item.key}>
      {dates.has(item.key) && (
        <div className="chat-date">
          <time dateTime={dates.get(item.key)?.dateTime}>{dates.get(item.key)?.label}</time>
        </div>
      )}
      {item.kind === 'pending-agent' ? (
        'runId' in item.value && !(usesDisplayMode && effectiveDisplayMode === 'compact') ? null : (
          <PendingAgentCard
            input={item.value}
            compact={usesDisplayMode && effectiveDisplayMode === 'compact'}
            mainAgent={item.value.threadId === mainThreadId}
          />
        )
      ) : item.kind === 'missing-user-reply' ? (
        <div className="missing-user-reply" role="status">
          <span>本次执行未发送回复。</span>
          <button type="button" className="text-button" onClick={() => setFullViewOverride(true)}>
            查看完整记录
          </button>
        </div>
      ) : item.kind === 'run-outcome' ? (
        readOnly ? (
          <FailureNotice
            label={isAutomation ? '定时执行结束' : '子代理执行结束'}
            message={
              item.value.error?.message ??
              (item.value.status === RunStatus.CANCELLED
                ? isAutomation
                  ? '定时执行已停止。'
                  : '子代理已停止。'
                : isAutomation
                  ? '定时执行中断。'
                  : '子代理执行中断。')
            }
          />
        ) : (
          <RunOutcomeCard
            key={item.key}
            run={item.value}
            busy={messageActionsUnavailable}
            onContinue={continueRun}
          />
        )
      ) : item.kind === 'recap' ? (
        <RecapLine recap={item.value} />
      ) : (
        <MessageCard
          key={item.key}
          message={item.value.message}
          delegationCall={item.value.delegationCall}
          sourceCallMessage={messages.find(
            (message) => message.messageId === item.value.delegationCall?.messageId,
          )}
          clients={clients}
          busy={actions.busy}
          editing={
            item.value.message.messageId === latestDirectUserMessageId &&
            editingActionKey === `revise-message:${item.value.message.messageId}`
          }
          streaming={item.value.streaming}
          continuation={continuationIds.has(item.key)}
          displayId={item.key}
          readOnly={readOnly}
          allowActions={
            item.value.message.messageId === latestDirectUserMessageId && !messageActionsUnavailable
          }
          subagentViews={subagentViews.views}
          onOpenSubagent={onOpenSubagent}
          thinkingExpansionChoices={thinkingExpansionChoices}
          mainThreadId={mainThreadId ?? undefined}
          receipts={receipts}
          callPreviews={callPreviews.previews}
          topicTitles={topicTitles}
          notifications={notifications}
          toolOutcomes={toolOutcomes}
          toolProgress={threadSync.state.toolProgress}
          associatedToolResultIds={associatedToolResultIds}
          toolItems={item.value.toolItems}
          mergedThinkingBlockIndexes={item.value.mergedThinkingBlockIndexes}
          sentMessage={item.value.sentMessage}
          channelDeliveries={channelDeliveries}
          hideContent={item.value.hideContent}
          compact={item.value.compact}
          sendFailure={item.value.sendFailure}
          toolExpansionChoices={toolExpansionChoices}
          onToolExpansionChange={onToolExpansionChange}
          onOpenTopic={onOpenTopic}
          onThinkingExpansionChange={onThinkingExpansionChange}
          onStartEditing={() =>
            setEditingActionKey(`revise-message:${item.value.message.messageId}`)
          }
          onCancelEditing={() => setEditingActionKey(null)}
          onRevise={reviseMessage}
          onRerun={rerun}
        />
      )}
    </Fragment>
  );

  return (
    <section
      ref={root}
      className={`conversation-pane conversation-${variant}${isSubagent ? ' conversation-topic' : ''}${hidden ? ' pane-hidden' : ''}`}
      aria-label={label}
      hidden={hidden}
    >
      {variant !== 'main' && (
        <header className={`workspace-header${variant === 'fullscreen' ? ' task-head' : ''}`}>
          {isAutomation && (
            <button
              type="button"
              className="icon-button"
              aria-label="返回定时任务详情"
              title="返回定时任务详情"
              onClick={onCloseTopic}
            >
              <Icon name="back" />
            </button>
          )}
          <div className="workspace-heading">
            <div className="thread-title-row">
              {(selectedThread || isDraft) && (
                <EntityMark
                  threadId={selectedThread?.threadId ?? localTaskDraftId}
                  subagent={isSubagent}
                  className="thread-title-mark"
                />
              )}
              {isDraft ? (
                <h1>{title}</h1>
              ) : editingTitle ? (
                <TitleEditor
                  title={title}
                  busy={actions.busy}
                  onSave={renameThread}
                  onCancel={() => setEditingTitle(false)}
                />
              ) : (
                <>
                  <h1>{title}</h1>
                  <TopicTitleActions
                    onLocate={
                      origin && canLocateAgentOrigin(origin.delegation)
                        ? () => onShowOrigin(activeThreadId ?? '', origin)
                        : undefined
                    }
                    onEdit={readOnly || onEditWorkspace ? undefined : () => setEditingTitle(true)}
                  />
                </>
              )}
            </div>
          </div>
          {onEditWorkspace && (
            <button
              type="button"
              className="icon-button"
              aria-label="工作空间设置"
              title="工作空间设置"
              onClick={onEditWorkspace}
            >
              <Icon name="settings" />
            </button>
          )}
          {(variant === 'topic' || (readOnly && !isAutomation)) && (
            <button
              type="button"
              className="icon-button"
              aria-label={readOnly ? '关闭子代理详情' : '关闭话题'}
              onClick={onCloseTopic}
            >
              <Icon name="close" />
            </button>
          )}
        </header>
      )}
      {!isDraft && threadSync.state.status === 'reconnecting' && (
        <div className="sync-notice" role="status">
          <Icon name="spinner" className="i-sm spinning" />
          连接已断开，正在重连；任务继续执行。
        </div>
      )}
      {(threadSync.state.error || composerError || callPreviews.error || subagentViews.error) && (
        <div className="pane-errors">
          {threadSync.state.error && (
            <FailureNotice
              label="连接异常"
              message={threadSync.state.error}
              onRetry={() => void threadSync.reload()}
            />
          )}
          {composerError && <FailureNotice label="发送失败" message={composerError} />}
          {subagentViews.error && (
            <FailureNotice
              label="子代理详情读取失败"
              message={subagentViews.error}
              onRetry={() => void threadSync.reload()}
            />
          )}
          {callPreviews.error && (
            <FailureNotice
              label="话题预览加载失败"
              message={callPreviews.error}
              onRetry={() => void threadSync.reload()}
            />
          )}
        </div>
      )}
      <div className="session-scroll" ref={viewportRef}>
        {(variant === 'topic' || readOnly) &&
          origin &&
          canLocateAgentOrigin(origin.delegation) &&
          origin.prompt && (
            <button
              type="button"
              className="topic-original"
              onClick={() => onShowOrigin(activeThreadId ?? '', origin)}
            >
              <span className="original-sender">
                <EntityMark mainAgent subagent={isSubagent} />
                <strong>
                  {origin.delegation.sourceThreadId === mainThreadId ? '主对话' : '来源话题'}
                </strong>
                <code>call</code>
              </span>
              <span className="original-message">{origin.prompt}</span>
            </button>
          )}
        {(variant === 'topic' || (readOnly && !isAutomation)) && (
          <div className="reply-divider">
            <span>{visibleMessageCount} 条消息</span>
          </div>
        )}
        <div className="session-body" ref={contentRef}>
          {variant === 'main' && newConversationStarting ? (
            <div className="chat-date new-conversation-marker" role="status">
              <span className="new-conversation-loading">
                <Icon name="spinner" className="i-sm spinning" />
                正在开始新对话…
              </span>
            </div>
          ) : variant === 'main' && selectedThread?.newConversation === true ? (
            <div className="chat-date new-conversation-marker" role="status">
              <span>已开始新对话</span>
            </div>
          ) : null}
          {!isDraft && threadSync.state.status === 'loading' && !snapshot ? (
            <ConversationLoading />
          ) : conversationItems.length === 0 ? (
            variant === 'main' && !readOnly ? (
              <div className="empty conversation-empty conversation-onboarding">
                <EntityMark mainAgent className="onboarding-mark" />
                <div className="onboarding-copy">
                  <h2>欢迎来到 Kairos</h2>
                  <p>
                    在这里你可以进行对话，在不同的设备中管理、创建工作空间，使用话题和 Subagent
                    完成各种任务。
                  </p>
                </div>
              </div>
            ) : (
              <div className="empty conversation-empty">
                <h2>{readOnly ? '暂无消息' : '具体要求'}</h2>
                <p>
                  {readOnly
                    ? isAutomation
                      ? '该次定时执行的消息会在这里更新。'
                      : '子代理的执行消息会在这里更新。'
                    : '补充背景、资料与完成标准。'}
                </p>
              </div>
            )
          ) : (
            <div className="message-list">
              {hasEarlierTurns && (
                <button
                  type="button"
                  className="earlier-discussions"
                  disabled={loadingEarlier}
                  aria-busy={loadingEarlier}
                  onClick={loadEarlier}
                >
                  <span role={loadingEarlier ? 'status' : undefined}>
                    {loadingEarlier ? '正在加载消息…' : '较早的消息'}
                  </span>
                  <Icon
                    name={loadingEarlier ? 'spinner' : 'up'}
                    className={`i-sm${loadingEarlier ? ' spinning' : ''}`}
                  />
                </button>
              )}
              {visibleConversationItems.map(renderItem)}
            </div>
          )}
        </div>
      </div>
      {!readOnly && (
        <div className="session-compose">
          {!isDraft && projectQueuedInputs(snapshot?.inputs ?? []).length > 0 && (
            <details className="queue-management" open>
              <summary>
                <Icon name="chevron" className="i-xs queue-management-chevron" />
                排队消息（{projectQueuedInputs(snapshot?.inputs ?? []).length} 条）
              </summary>
              <QueueStack
                inputs={snapshot?.inputs ?? []}
                busy={actions.busy}
                onEdit={takeInput}
                onRemove={removeInput}
                onReorder={reorderInputs}
              />
            </details>
          )}
          <Composer
            draft={draft}
            busy={actions.busy}
            unavailable={!isDraft && !snapshot}
            running={activeRun !== null}
            stopping={activeRun?.status === RunStatus.CANCEL_REQUESTED}
            onStop={activeRun ? () => cancelRun(activeRun) : undefined}
            placeholder={
              variant === 'topic'
                ? '回复话题…'
                : isDraft
                  ? '补充背景、资料与完成标准…'
                  : '发送消息…'
            }
            composerOwner={composerOwner}
            threadId={activeThreadId ?? localTaskDraftId}
            onChange={(next) => {
              setComposerError(null);
              drafts.updateDraft(draftOwner, next);
            }}
            onSend={sendMessage}
            onAddFiles={(files, source) => {
              setComposerError(null);
              void attachmentUploader.addFiles(files, { source }).catch((cause: unknown) => {
                setComposerError(cause instanceof Error ? cause.message : String(cause));
              });
            }}
            onRemoveAttachment={(attachment) => void removeDraftAttachment(attachment)}
            onRetryAttachment={(attachment) => {
              void attachmentUploader.retry(attachment.localId).catch((cause: unknown) => {
                setComposerError(cause instanceof Error ? cause.message : String(cause));
              });
            }}
            onReselectAttachment={(attachment, file) => {
              void attachmentUploader.reselect(attachment.localId, file).catch((cause: unknown) => {
                setComposerError(cause instanceof Error ? cause.message : String(cause));
              });
            }}
          />
        </div>
      )}
      {newConversationSubmission && (
        <AppDialog
          title="开始新对话"
          onClose={() => setNewConversationSubmission(null)}
          actions={
            <>
              <button
                type="button"
                className="device-secondary"
                data-dialog-initial-focus=""
                onClick={() => setNewConversationSubmission(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="device-primary device-danger"
                disabled={actions.busy}
                onClick={() => {
                  const submission = newConversationSubmission;
                  setNewConversationSubmission(null);
                  void executeSubmission(submission);
                }}
              >
                清空并开始新对话
              </button>
            </>
          }
        >
          <p>当前主对话的上下文将被清空，无法恢复。</p>
          <p>历史消息将不再显示，recall 也无法查询之前的内容。</p>
        </AppDialog>
      )}
    </section>
  );
}
