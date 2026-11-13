import type { Message, ToolCall } from '@kairos/contracts';
import { FailureNotice } from './failure-notice.js';
import { Icon } from './icon.js';
import { MessageAvatar } from './message-avatar.js';
import { SafeMarkdown } from './safe-markdown.js';
import type {
  ChannelDeliveryStatusInfo,
  SentDelivery,
  SentUserMessage,
} from './sent-user-message.js';

function DeliveryBadge({
  delivery,
  live,
}: {
  delivery: SentDelivery;
  live: ChannelDeliveryStatusInfo | undefined;
}) {
  const channelName = delivery.channel === 'wechat' ? '微信' : '飞书';
  const status = live?.status ?? (delivery.status === 'failed' ? 'failed' : 'pending');
  const error = (live?.errorMessage ?? delivery.error ?? '').trim();
  const icon = <Icon name={delivery.channel === 'wechat' ? 'wechat' : 'feishu'} className="i-sm" />;
  if (status === 'failed') {
    return (
      <span
        className={`channel-delivery-badge channel-${delivery.channel} failed`}
        role="img"
        aria-label={`投递到${channelName}失败`}
      >
        {icon}
        <span
          className="channel-delivery-info"
          data-tip={error.length > 0 ? error : '投递失败'}
          role="img"
          aria-label={`投递失败原因：${error.length > 0 ? error : '未知'}`}
        >
          i
        </span>
      </span>
    );
  }
  const label = status === 'succeeded' ? `已投递到${channelName}` : `正在投递到${channelName}`;
  return (
    <span
      className={`channel-delivery-badge channel-${delivery.channel}${status === 'succeeded' ? '' : ' pending'}`}
      role="img"
      aria-label={label}
      title={label}
    >
      {icon}
    </span>
  );
}

export function SentUserMessageCard({
  message,
  sent,
  call,
  compact,
  continuation,
  deliveryStatuses,
}: {
  message: Message;
  sent: SentUserMessage;
  call?: ToolCall | undefined;
  compact: boolean;
  continuation: boolean;
  deliveryStatuses?: ReadonlyMap<string, ChannelDeliveryStatusInfo> | undefined;
}) {
  const badges =
    sent.deliveries.length === 0 ? null : (
      <span className="channel-delivery-badges">
        {sent.deliveries.map((delivery) => (
          <DeliveryBadge
            key={delivery.deliveryId}
            delivery={delivery}
            live={deliveryStatuses?.get(delivery.deliveryId)}
          />
        ))}
      </span>
    );
  return (
    <article
      className={`message assistant sent-user-message${compact ? ' sent-user-message-compact' : ''}${continuation ? ' assistant-continuation' : ''}${sent.deliveries.length > 0 ? ' has-channel-deliveries' : ''}`}
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
            {badges}
            <SafeMarkdown>{sent.content}</SafeMarkdown>
          </div>
        ) : (
          <>
            {badges}
            <SafeMarkdown>{sent.content}</SafeMarkdown>
          </>
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
