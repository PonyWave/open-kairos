import type { Message } from '@kairos/contracts';
import { AttachmentList } from './attachment-list.js';
import type { KairosClients } from './client.js';
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
  compact,
  continuation,
  deliveryStatuses,
  mainThreadId,
  clients,
  embedded = false,
}: {
  message: Message;
  sent: SentUserMessage;
  compact: boolean;
  continuation: boolean;
  deliveryStatuses?: ReadonlyMap<string, ChannelDeliveryStatusInfo> | undefined;
  mainThreadId?: string | null | undefined;
  clients?: KairosClients | undefined;
  embedded?: boolean;
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
      className={`message assistant sent-user-message${compact ? ' sent-user-message-compact' : ''}${continuation ? ' assistant-continuation' : ''}${embedded ? ' sent-user-message-embedded' : ''}${sent.deliveries.length > 0 ? ' has-channel-deliveries' : ''}`}
      data-message-id={message.messageId}
      data-user-message-call-id={message.toolCallId}
    >
      {embedded ? null : continuation ? (
        <span className="avatar-spacer" aria-hidden="true" />
      ) : (
        <MessageAvatar
          label="Kairos"
          timestamp={message.createdAt}
          threadId={message.threadId}
          mainAgent={mainThreadId === undefined || message.threadId === mainThreadId}
        />
      )}
      <div className="message-content">
        <div className="sent-message-bubble">
          {!compact && <span className="sent-message-tag">回复用户</span>}
          {badges}
          <SafeMarkdown>{sent.content}</SafeMarkdown>
          <AttachmentList attachments={message.attachments} clients={clients} />
        </div>
      </div>
    </article>
  );
}

export function UserMessageFailure({ message }: { message: Message }) {
  return (
    <FailureNotice label="回复发送失败" message={message.toolError?.message || message.content} />
  );
}
