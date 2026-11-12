import type { Message, ToolCall } from '@kairos/contracts';
import { FailureNotice } from './failure-notice.js';
import { Icon } from './icon.js';
import { MessageAvatar } from './message-avatar.js';
import { SafeMarkdown } from './safe-markdown.js';
import type { SentUserMessage } from './sent-user-message.js';

export function SentUserMessageCard({
  message,
  sent,
  call,
  compact,
  continuation,
}: {
  message: Message;
  sent: SentUserMessage;
  call?: ToolCall | undefined;
  compact: boolean;
  continuation: boolean;
}) {
  return (
    <article
      className={`message assistant sent-user-message${compact ? ' sent-user-message-compact' : ''}${continuation ? ' assistant-continuation' : ''}`}
      data-message-id={message.messageId}
      data-user-message-call-id={message.toolCallId}
    >
      {continuation ? (
        <span className="avatar-spacer" aria-hidden="true" />
      ) : (
        <MessageAvatar
          label="Kairos"
          timestamp={message.createdAt}
          threadId={message.threadId}
          mainAgent
        />
      )}
      <div className="message-content">
        {compact ? (
          <div className="sent-message-bubble">
            <SafeMarkdown>{sent.content}</SafeMarkdown>
          </div>
        ) : (
          <SafeMarkdown>{sent.content}</SafeMarkdown>
        )}
        {!compact && (
          <details className="sent-message-details">
            <summary>
              发送详情
              <Icon name="chevron" className="i-sm" />
            </summary>
            {call && (
              <>
                <div className="tool-detail-heading">参数</div>
                <pre>{call.argumentsJson}</pre>
              </>
            )}
            <div className="tool-detail-heading">返回</div>
            <pre>{message.content}</pre>
          </details>
        )}
      </div>
    </article>
  );
}

export function UserMessageFailure({ message }: { message: Message }) {
  return (
    <FailureNotice label="回复发送失败" message={message.toolError?.message || message.content} />
  );
}
