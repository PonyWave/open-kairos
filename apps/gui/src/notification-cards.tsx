import {
  type Message,
  MessageSource,
  type ThreadNotification,
  ThreadNotificationStatus,
  type ToolCall,
  ToolResultStatus,
} from '@kairos/contracts';
import type { OpenTopicRequest } from './delegation-cards.js';
import { Icon } from './icon.js';
import { MessageAvatar } from './message-avatar.js';
import { SafeMarkdown } from './safe-markdown.js';
import type { ToolOutcome } from './tool-group-projection.js';
import { originElementId } from './workbench-navigation.js';

export function ThreadNotificationCard({
  message,
  topicTitle,
  onOpenTopic,
}: {
  message: Message;
  topicTitle?: string | undefined;
  onOpenTopic: (request: OpenTopicRequest) => void;
}) {
  const threadId = message.sourceThreadId;
  if (message.source !== MessageSource.THREAD_NOTIFICATION || !threadId) return null;
  const title = topicTitle || threadId;
  const content = threadNotificationContent(message);
  const invocationId = message.delegation?.sourceToolCallId ?? null;
  return (
    <article
      className="message assistant thread-notification"
      data-message-id={message.messageId}
      data-delegation-call-id={invocationId ?? undefined}
    >
      <MessageAvatar label={title} timestamp={message.createdAt} threadId={threadId} side="left" />
      <div className="message-content">
        <div className="thread-notification-heading">
          <button
            type="button"
            className="text-button thread-notification-source"
            onClick={() => onOpenTopic({ threadId, invocationId, origin: null })}
          >
            {title}
          </button>
          <span>话题通知</span>
        </div>
        <div className="message-text">
          {content === null ? (
            <span className="empty">通知正文不可用。</span>
          ) : (
            <SafeMarkdown>{content}</SafeMarkdown>
          )}
        </div>
      </div>
    </article>
  );
}

export function ThreadNotificationCallCard({
  call,
  notification,
  outcome,
}: {
  call: ToolCall;
  notification?: ThreadNotification | undefined;
  outcome?: ToolOutcome | undefined;
}) {
  const content = threadNotificationMessage(call);
  return (
    <section
      className="delegation-tool thread-call-reply thread-notify-call"
      id={originElementId(call.toolCallId)}
      data-delegation-call-id={call.toolCallId}
    >
      <div className="thread-call-reply-heading">
        <Icon name="chat" className="i-sm" />
        <span>给主对话发消息</span>
        <small className="thread-notify-status">{notificationStatus(notification, outcome)}</small>
      </div>
      {content !== null && (
        <div className="thread-call-reply-body">
          <div className="thread-call-reply-prompt">
            <SafeMarkdown>{content}</SafeMarkdown>
          </div>
        </div>
      )}
    </section>
  );
}

export function threadNotificationContent(message: Message): string | null {
  if (message.source !== MessageSource.THREAD_NOTIFICATION) return null;
  try {
    const value: unknown = JSON.parse(message.content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Reflect.get(value, 'kind') !== 'thread_notification') return null;
    if (Reflect.get(value, 'thread_id') !== message.sourceThreadId) return null;
    if (message.delegation) {
      if (Reflect.get(value, 'source_thread_id') !== message.delegation.sourceThreadId) return null;
      if (Reflect.get(value, 'source_agent_id') !== message.delegation.sourceAgentId) return null;
      if (Reflect.get(value, 'tool_call_id') !== message.delegation.sourceToolCallId) return null;
    }
    const content = Reflect.get(value, 'message');
    return typeof content === 'string' ? content : null;
  } catch {
    return null;
  }
}

function threadNotificationMessage(call: ToolCall): string | null {
  try {
    const value: unknown = JSON.parse(call.argumentsJson);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const message = Reflect.get(value, 'message');
    return typeof message === 'string' ? message : null;
  } catch {
    return null;
  }
}

function notificationStatus(
  notification: ThreadNotification | undefined,
  outcome: ToolOutcome | undefined,
): string {
  switch (notification?.status) {
    case ThreadNotificationStatus.PENDING:
      return '已接受';
    case ThreadNotificationStatus.QUEUED:
      return '等待注入主对话';
    case ThreadNotificationStatus.CONSUMED:
      return '已注入主对话';
    case ThreadNotificationStatus.SUPERSEDED:
      return '来源已失效';
  }
  if (outcome?.result.resultUnknown) return '结果待核对';
  if (outcome?.message.toolStatus === ToolResultStatus.ERROR) return '发送失败';
  if (outcome?.result.status === 'accepted') return '已接受';
  return '等待接受回执';
}
