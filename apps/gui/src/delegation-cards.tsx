import {
  type DelegationReference,
  type Message,
  MessageSource,
  type ToolCall,
} from '@kairos/contracts';
import { AttachmentList, AttachmentMetadataList } from './attachment-list.js';
import type { KairosClients } from './client.js';
import { EntityMark } from './entity-mark.js';
import { Icon } from './icon.js';
import { formatSequence } from './labels.js';
import { SafeMarkdown } from './safe-markdown.js';
import {
  type AgentOrigin,
  type DelegationReceipt,
  delegationPrompt,
  delegationThreadId,
  isContinuedDelegation,
  previewSender,
  type ThreadCallView,
} from './thread-view.js';
import { UserAvatar } from './user-avatar.js';
import { originElementId } from './workbench-navigation.js';

export interface OpenTopicRequest {
  threadId: string;
  invocationId: string | null;
  origin: AgentOrigin | null;
}

export function DelegationCallCard({
  message,
  call,
  receipt,
  preview,
  topicTitle,
  mainThreadId,
  compact = false,
  onOpenTopic,
}: {
  message: Message;
  call: ToolCall;
  receipt?: DelegationReceipt | undefined;
  preview?: ThreadCallView | undefined;
  topicTitle?: string | undefined;
  mainThreadId?: string | undefined;
  compact?: boolean | undefined;
  onOpenTopic: (request: OpenTopicRequest) => void;
}) {
  const threadId = preview?.target?.threadId ?? receipt?.threadId ?? delegationThreadId(call);
  const title = preview?.target?.title || topicTitle || threadId;
  const prompt = delegationPrompt(call);
  const origin: AgentOrigin = {
    delegation: {
      sourceThreadId: message.threadId,
      sourceAgentId: message.agentId,
      sourceToolCallId: call.toolCallId,
      $typeName: 'kairos.gui.v1.DelegationReference',
    },
    prompt,
    sourceMessageId: message.messageId,
  };
  if (isContinuedDelegation(call)) {
    return (
      <section
        className="delegation-tool thread-call-reply"
        id={originElementId(call.toolCallId)}
        data-delegation={call.toolCallId}
        data-delegation-call-id={call.toolCallId}
        data-thread-id={threadId ?? undefined}
      >
        <div className="thread-call-reply-heading">
          <Icon name="chat" className="i-sm" />
          <span>回复话题</span>
          <strong>{title ?? '话题'}</strong>
        </div>
        <div className="thread-call-reply-body">
          <div className="thread-call-reply-prompt">
            <SafeMarkdown>{prompt}</SafeMarkdown>
          </div>
          <button
            type="button"
            className="text-button thread-call-open"
            disabled={!threadId}
            onClick={() =>
              threadId && onOpenTopic({ threadId, invocationId: call.toolCallId, origin })
            }
          >
            查看话题
            <Icon name="chevron" className="i-sm" />
          </button>
        </div>
      </section>
    );
  }
  const earlier = preview ? preview.replyCount - BigInt(preview.replies.length) : 0n;
  return (
    <section
      className="delegation-tool"
      id={originElementId(call.toolCallId)}
      data-delegation={call.toolCallId}
      data-delegation-call-id={call.toolCallId}
      data-thread-id={threadId ?? undefined}
    >
      <div className="delegation-tool-title">
        <Icon name="chat" className="i-sm" />
        <span className="delegation-kind">委派</span>
        <span>{title ?? '等待话题接受回执'}</span>
        <small>{isNewThread(call) ? '新话题' : '继续话题'}</small>
        <span className="receipt-label">
          {receipt?.status === 'accepted' ? '已接受' : (receipt?.status ?? '等待接受回执')}
        </span>
      </div>
      {prompt !== null && <p className="delegation-prompt">{prompt}</p>}
      {!compact && (
        <details className="call-payload">
          <summary>
            调用详情
            <Icon name="chevron" className="i-sm" />
          </summary>
          <div className="tool-detail-heading">参数</div>
          <pre>{call.argumentsJson}</pre>
          <div className="tool-detail-heading">接受回执</div>
          <pre>{receipt ? JSON.stringify(receipt, null, 2) : '尚未取得接受回执'}</pre>
        </details>
      )}
      {preview ? (
        <button
          type="button"
          className="thread-replies-preview"
          disabled={!threadId}
          onClick={() =>
            threadId && onOpenTopic({ threadId, invocationId: call.toolCallId, origin })
          }
          aria-label={title ? `查看${title}的回复` : '查看话题回复'}
        >
          {earlier > 0n && (
            <span className="thread-earlier-messages">更早的 {formatSequence(earlier)} 条消息</span>
          )}
          <ReplyPreviews
            replies={preview.replies}
            threadId={threadId}
            mainThreadId={mainThreadId}
          />
          <span className="thread-replies-footer">
            <Icon name="chat" className="i-sm" />
            <span className="thread-reply-label">回复话题</span>
            <Icon name="chevron" className="i-sm" />
          </span>
        </button>
      ) : (
        <button
          type="button"
          className="thread-replies-footer"
          disabled={!threadId}
          onClick={() =>
            threadId && onOpenTopic({ threadId, invocationId: call.toolCallId, origin })
          }
        >
          {threadId ? '回复话题' : '等待话题接受回执'}
        </button>
      )}
    </section>
  );
}

export function ThreadDeliveryCard({
  clients,
  message,
  topicTitle,
  origin,
  onOpenTopic,
}: {
  clients?: KairosClients | undefined;
  message: Message;
  topicTitle?: string | undefined;
  origin: AgentOrigin | null;
  onOpenTopic: (request: OpenTopicRequest) => void;
}) {
  const threadId = message.sourceThreadId;
  if (message.source !== MessageSource.THREAD_RESPONSE || !threadId) return null;
  const title = topicTitle || threadId;
  return (
    <details className="tool-operation thread-delivery">
      <summary>
        <Icon name="chat" className="i-sm" />
        <span className="tool-operation-title">{title} 返回结果</span>
        <Icon name="chevron" className="i-sm" />
      </summary>
      <div className="tool-operation-detail">
        <p className="delivery-content">{message.content}</p>
        <AttachmentList attachments={message.attachments} clients={clients} />
        <button
          type="button"
          className="text-button"
          onClick={() =>
            onOpenTopic({
              threadId,
              invocationId: message.delegation?.sourceToolCallId ?? null,
              origin,
            })
          }
        >
          查看话题
        </button>
      </div>
    </details>
  );
}

export function ReplyPreviews({
  replies,
  threadId,
  mainThreadId,
}: {
  replies: ThreadCallView['replies'];
  threadId: string | null;
  mainThreadId?: string | null | undefined;
}) {
  if (replies.length === 0) return <span className="empty">当前没有可显示的消息。</span>;
  return (
    <span className="preview-replies">
      {replies.map((reply) => {
        const sender = previewSender(reply);
        return (
          <span className="preview-reply" key={reply.messageId}>
            <span className={`reply-avatar${sender.user ? ' person' : ''}`}>
              {sender.user ? (
                <UserAvatar />
              ) : (
                <EntityMark
                  threadId={reply.sourceThreadId ?? threadId ?? reply.threadId}
                  mainAgent={
                    reply.sourceThreadId !== undefined && reply.sourceThreadId === mainThreadId
                  }
                />
              )}
            </span>
            <span className="preview-reply-content">
              <strong>{sender.label}</strong>
              <span>
                {plainPreviewText(reply.content)}
                {reply.truncated ? '…' : ''}
              </span>
              <AttachmentMetadataList attachments={reply.attachments ?? []} />
            </span>
          </span>
        );
      })}
    </span>
  );
}

const wrappedTriggerPrefix =
  /^(?:<system-reminder>\n(?:Kairos Automation trigger|Automation scheduled trigger)[^\n]*\n<\/system-reminder>\n\n?)+/;
const automationTriggerPrefix =
  /^Kairos Automation trigger;[^\n]*\nThe configured Automation prompt follows; it is not a new human instruction:\n\n/;

export function plainPreviewText(text: string): string {
  return text
    .replace(wrappedTriggerPrefix, '')
    .replace(automationTriggerPrefix, '')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function originFromDelegation(
  delegation: DelegationReference | undefined,
  sourceMessage: Message | undefined,
): AgentOrigin | null {
  if (!delegation) return null;
  const call = sourceMessage?.toolCalls.find(
    (item) => item.toolCallId === delegation.sourceToolCallId,
  );
  return {
    delegation,
    prompt: call ? delegationPrompt(call) : null,
    sourceMessageId: sourceMessage?.messageId ?? null,
  };
}

function isNewThread(call: ToolCall): boolean {
  try {
    const value: unknown = JSON.parse(call.argumentsJson);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const threadId = Reflect.get(value, 'thread_id');
    return threadId === undefined || threadId === '';
  } catch {
    return false;
  }
}
