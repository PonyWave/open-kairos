import {
  ContentBlockType,
  type Message,
  MessageRole,
  MessageSource,
  type SubagentCallView,
  type ThreadNotification,
  type ToolCall,
} from '@kairos/contracts';
import { type ReactNode, useState } from 'react';
import { AttachmentList } from './attachment-list.js';
import type { KairosClients } from './client.js';
import { ToolResultCard } from './conversation.js';
import { delegationForToolCall, delegationKey } from './delegation.js';
import {
  DelegationCallCard,
  type OpenTopicRequest,
  originFromDelegation,
  ThreadDeliveryCard,
} from './delegation-cards.js';
import { Icon } from './icon.js';
import { isDirectUserMessage, isRootAgent } from './labels.js';
import { MessageAvatar } from './message-avatar.js';
import { ThreadNotificationCallCard, ThreadNotificationCard } from './notification-cards.js';
import { EditedMarker } from './response-components.js';
import type { DelegationCallProjection } from './response-projection.js';
import { type SentUserMessage, sentUserMessage } from './sent-user-message.js';
import { SentUserMessageCard, UserMessageFailure } from './sent-user-message-card.js';
import { SubagentCard } from './subagent-card.js';
import { MessageContent } from './thinking-block.js';
import type { ThinkingExpansionChoices } from './thinking-expansion.js';
import {
  type DelegationReceipt,
  delegationThreadId,
  isDelegationTool,
  type ThreadCallView,
} from './thread-view.js';
import {
  type ToolExpansionChange,
  type ToolExpansionChoices,
  ToolOperationGroup,
} from './tool-call-groups.js';
import { projectToolItems, type ToolItem, type ToolOutcome } from './tool-group-projection.js';

export interface MessageCardProps {
  message: Message;
  delegationCall: DelegationCallProjection | null;
  sourceCallMessage?: Message | undefined;
  clients: KairosClients;
  busy: boolean;
  editing: boolean;
  streaming: boolean;
  continuation?: boolean;
  readOnly?: boolean;
  allowActions?: boolean | undefined;
  subagentViews?: ReadonlyMap<string, SubagentCallView>;
  onOpenSubagent?: (view: SubagentCallView) => void;
  thinkingExpansionChoices: ThinkingExpansionChoices;
  mainThreadId?: string | undefined;
  receipts?: ReadonlyMap<string, DelegationReceipt>;
  callPreviews?: ReadonlyMap<string, ThreadCallView>;
  topicTitles?: ReadonlyMap<string, string>;
  notifications?: ReadonlyMap<string, ThreadNotification>;
  toolOutcomes?: ReadonlyMap<string, ToolOutcome> | undefined;
  associatedToolResultIds?: ReadonlySet<string> | undefined;
  toolItems?: ToolItem[] | undefined;
  mergedThinkingBlockIndexes?: ReadonlySet<number> | undefined;
  sentMessage?: SentUserMessage | null | undefined;
  sentCall?: ToolCall | undefined;
  displayId?: string | undefined;
  hideContent?: boolean | undefined;
  compact?: boolean | undefined;
  sendFailure?: boolean | undefined;
  toolExpansionChoices?: ToolExpansionChoices | undefined;
  onToolExpansionChange?: ToolExpansionChange | undefined;
  onOpenTopic?: (request: OpenTopicRequest) => void;
  onThinkingExpansionChange: (messageId: string, blockIndex: number, expanded: boolean) => void;
  onStartEditing: () => void;
  onCancelEditing: () => void;
  onRevise: (message: Message, text: string) => Promise<unknown>;
  onRerun: (message: Message) => Promise<unknown>;
}

export function MessageCard({
  message,
  sourceCallMessage,
  clients,
  busy,
  editing,
  streaming,
  continuation = false,
  readOnly = false,
  allowActions = true,
  subagentViews = new Map(),
  onOpenSubagent = () => {},
  thinkingExpansionChoices,
  mainThreadId,
  receipts,
  callPreviews,
  topicTitles,
  notifications,
  toolOutcomes,
  associatedToolResultIds,
  toolItems: projectedToolItems,
  mergedThinkingBlockIndexes: projectedMergedThinking,
  sentMessage,
  sentCall,
  displayId,
  hideContent = false,
  compact = false,
  sendFailure = false,
  toolExpansionChoices = {},
  onToolExpansionChange = () => {},
  onOpenTopic = () => {},
  onThinkingExpansionChange,
  onStartEditing,
  onCancelEditing,
  onRevise,
  onRerun,
}: MessageCardProps) {
  const [revision, setRevision] = useState(message.content);
  const isUser = !readOnly && isRootAgent(message.agentId) && isDirectUserMessage(message);
  const showActions = isUser && allowActions;
  const editingActive = editing && showActions;
  const sent = sentMessage === undefined ? sentUserMessage(message) : sentMessage;
  if (sent) {
    return (
      <SentUserMessageCard
        message={message}
        sent={sent}
        call={sentCall}
        compact={compact}
        continuation={continuation}
      />
    );
  }
  if (sendFailure) return <UserMessageFailure message={message} />;
  if (message.source === MessageSource.SUBAGENT_RESPONSE) return null;

  if (
    message.role === MessageRole.TOOL &&
    associatedToolResultIds?.has(message.toolCallId) &&
    toolOutcomes?.has(message.toolCallId)
  ) {
    return null;
  }

  if (
    message.role === MessageRole.TOOL &&
    isDelegationTool(message) &&
    receipts?.get(message.toolCallId)?.status === 'accepted'
  ) {
    return null;
  }

  if (message.source === MessageSource.THREAD_NOTIFICATION && message.sourceThreadId) {
    return (
      <ThreadNotificationCard
        message={message}
        topicTitle={topicTitles?.get(message.sourceThreadId)}
        onOpenTopic={onOpenTopic}
      />
    );
  }

  if (message.source === MessageSource.THREAD_RESPONSE && message.sourceThreadId) {
    return (
      <ThreadDeliveryCard
        clients={clients}
        message={message}
        topicTitle={topicTitles?.get(message.sourceThreadId)}
        origin={originFromDelegation(message.delegation, sourceCallMessage)}
        onOpenTopic={onOpenTopic}
      />
    );
  }

  const toolItems =
    projectedToolItems ??
    projectToolItems(message.toolCalls, {
      contentBlocks: message.contentBlocks,
      messageId: message.messageId,
      streaming,
    });
  const ownMergedThinking = new Set<number>();
  for (const item of toolItems) {
    if (item.kind !== 'ordinary') continue;
    for (const operation of item.operations) {
      if (operation.kind === 'thinking' && operation.messageId === message.messageId) {
        ownMergedThinking.add(operation.blockIndex);
      }
    }
  }
  const mergedThinking = projectedMergedThinking ?? ownMergedThinking;
  const hasVisibleContent =
    message.contentBlocks.length > 0
      ? message.contentBlocks.some(
          (block) => block.text.trim().length > 0 && !mergedThinking.has(block.blockIndex),
        )
      : message.content.trim().length > 0;
  if (
    projectedToolItems &&
    message.role === MessageRole.ASSISTANT &&
    toolItems.length === 0 &&
    (message.toolCalls.length > 0 || mergedThinking.size > 0) &&
    !hasVisibleContent &&
    message.attachments.length === 0 &&
    !message.delegation?.sourceThreadId &&
    !message.sourceThreadId
  ) {
    return null;
  }
  const sourceThreadId = message.delegation?.sourceThreadId ?? message.sourceThreadId;
  const mainAgent =
    sourceThreadId !== undefined && mainThreadId !== undefined
      ? sourceThreadId === mainThreadId
      : message.threadId === mainThreadId;
  const avatar = (
    <MessageAvatar
      label={isUser ? '用户' : 'Kairos'}
      timestamp={message.createdAt}
      user={isUser}
      threadId={sourceThreadId ?? message.threadId}
      mainAgent={mainAgent}
      subagent={readOnly}
      side={isUser ? 'right' : 'left'}
    />
  );
  const renderText = (contentMessage: Message, key?: string) => (
    <div key={key} className={`message-text${message.revisionId ? ' has-edited' : ''}`}>
      <MessageContent
        message={contentMessage}
        streaming={streaming}
        choices={thinkingExpansionChoices}
        hiddenThinkingBlockIndexes={mergedThinking}
        onThinkingExpansionChange={onThinkingExpansionChange}
      />
      {contentMessage === message && <EditedMarker revisionId={message.revisionId} />}
    </div>
  );
  const renderedToolItems = toolItems.map((item) => {
    if (item.kind === 'subagent') {
      const key = delegationKey(delegationForToolCall(message, item.call));
      return (
        <SubagentCard
          key={item.id}
          call={item.call}
          view={subagentViews.get(key)}
          onOpen={onOpenSubagent}
        />
      );
    }
    if (item.kind === 'notification') {
      const key = delegationKey(delegationForToolCall(message, item.call));
      return (
        <ThreadNotificationCallCard
          key={item.id}
          call={item.call}
          notification={notifications?.get(key)}
          outcome={toolOutcomes?.get(item.call.toolCallId)}
        />
      );
    }
    if (item.kind === 'ordinary') {
      return (
        <ToolOperationGroup
          key={item.id}
          message={message}
          calls={item.calls}
          operations={item.operations}
          outcomes={toolOutcomes ?? new Map<string, ToolOutcome>()}
          streaming={streaming}
          clients={clients}
          choices={toolExpansionChoices}
          onExpandedChange={onToolExpansionChange}
          thinkingExpansionChoices={thinkingExpansionChoices}
          onThinkingExpansionChange={onThinkingExpansionChange}
        />
      );
    }
    const call = item.call;
    const key = delegationKey(delegationForToolCall(message, call));
    const receipt = receipts?.get(call.toolCallId);
    const preview = callPreviews?.get(key);
    const threadId = preview?.target?.threadId ?? receipt?.threadId ?? delegationThreadId(call);
    return (
      <DelegationCallCard
        key={call.toolCallId}
        message={message}
        call={call}
        receipt={receipt}
        preview={preview}
        topicTitle={threadId ? topicTitles?.get(threadId) : undefined}
        mainThreadId={mainThreadId}
        compact={compact}
        onOpenTopic={onOpenTopic}
      />
    );
  });
  const orderedContent =
    !hideContent &&
    !editingActive &&
    message.role === MessageRole.ASSISTANT &&
    message.contentBlocks.length > 0 &&
    toolItems.length > 0 &&
    toolItems.every((item) => item.blockIndex !== undefined);
  const renderOrderedContent = () => {
    const rendered: ReactNode[] = [];
    const blocks = [...message.contentBlocks].sort(
      (left, right) => left.blockIndex - right.blockIndex,
    );
    let start = 0;
    const appendText = (end: number) => {
      const segment = blocks.filter(
        (block) =>
          block.blockIndex >= start &&
          block.blockIndex < end &&
          block.text.trim().length > 0 &&
          !mergedThinking.has(block.blockIndex),
      );
      if (segment.length > 0) {
        rendered.push(
          renderText(
            {
              ...message,
              content: segment
                .filter((block) => block.type === ContentBlockType.TEXT)
                .map((block) => block.text)
                .join(''),
              contentBlocks: segment,
            },
            `content:${start}:${end}`,
          ),
        );
      }
      start = end;
    };
    for (const [index, item] of toolItems.entries()) {
      const position = item.blockIndex;
      if (position === undefined) continue;
      appendText(position);
      const renderedItem = renderedToolItems[index];
      if (renderedItem) rendered.push(renderedItem);
    }
    appendText(blocks.length);
    return rendered;
  };
  const content = (
    <>
      {sourceThreadId && sourceThreadId !== message.threadId && (
        <div className="reply-source">
          {sourceThreadId === mainThreadId ? '来自主对话' : '来自其他话题'}
        </div>
      )}
      {!hideContent && <AttachmentList attachments={message.attachments} clients={clients} />}
      {hideContent ? null : message.role === MessageRole.TOOL ? (
        <ToolResultCard message={message} clients={clients} showStatus />
      ) : editingActive ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onRevise(message, revision);
          }}
        >
          <textarea
            aria-label="修订消息"
            value={revision}
            onChange={(event) => setRevision(event.target.value)}
            rows={5}
          />
          <div className="button-row">
            <button
              type="submit"
              disabled={busy || (!revision.trim() && message.attachments.length === 0)}
            >
              保存
            </button>
            <button type="button" onClick={onCancelEditing}>
              取消
            </button>
          </div>
        </form>
      ) : orderedContent ? null : (
        renderText(message)
      )}

      {orderedContent ? renderOrderedContent() : renderedToolItems}

      {showActions && !editing && (
        <div className="message-actions">
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => {
              setRevision(message.content);
              onStartEditing();
            }}
          >
            <Icon name="edit" className="i-sm" />
            编辑
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void onRerun(message)}
          >
            <Icon name="retry" className="i-sm" />
            重试
          </button>
        </div>
      )}
    </>
  );

  return (
    <article
      className={`message role-${message.role}${streaming ? ' transient' : ''}${isUser ? ' user user-with-avatar' : ' assistant'}${continuation ? ' assistant-continuation' : ''}`}
      data-message-id={message.messageId}
      data-display-id={displayId}
      data-delegation-call-id={message.delegation?.sourceToolCallId}
    >
      {isUser ? (
        <>
          <div className="user-message-content">{content}</div>
          {avatar}
        </>
      ) : (
        <>
          {continuation ? <span className="avatar-spacer" aria-hidden="true" /> : avatar}
          <div className="message-content">{content}</div>
        </>
      )}
    </article>
  );
}
