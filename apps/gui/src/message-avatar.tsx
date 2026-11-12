import type { Message } from '@kairos/contracts';
import { useLayoutEffect, useRef, useState } from 'react';
import { EntityMark } from './entity-mark.js';
import { type MessageTimeSide, observeMessageTimePosition } from './message-time-layout.js';
import { formatAbsoluteDateTime, formatMessageTime, timestampDate } from './time-format.js';
import { UserAvatar } from './user-avatar.js';

export type { MessageTimePosition, MessageTimeSide } from './message-time-layout.js';
export { messageTimePosition } from './message-time-layout.js';
export { formatMessageTime } from './time-format.js';

export function MessageAvatar({
  label,
  timestamp,
  user = false,
  threadId,
  mainAgent = false,
  side = 'left',
  subagent = false,
}: {
  label: string;
  timestamp: Message['createdAt'];
  user?: boolean;
  threadId?: string;
  mainAgent?: boolean;
  subagent?: boolean;
  side?: MessageTimeSide;
}) {
  const container = useRef<HTMLButtonElement>(null);
  const time = useRef<HTMLTimeElement>(null);
  const [timeVisible, setTimeVisible] = useState(false);
  const timeText = formatMessageTime(timestamp);
  const date = timestampDate(timestamp);

  useLayoutEffect(() => {
    const avatar = container.current;
    const timeElement = time.current;
    if (!avatar || !timeElement || !timeText) return;
    return observeMessageTimePosition({ avatar, timeElement, side, windowObject: window });
  }, [side, timeText]);

  return (
    <button
      ref={container}
      type="button"
      className={`message-avatar-container time-${side}${timeVisible ? ' time-visible' : ''}`}
      data-time-position={side}
      aria-label={`${label}，${timeText}；切换时间显示`}
      aria-expanded={timeVisible}
      onClick={() => setTimeVisible((visible) => !visible)}
    >
      <span className={`message-avatar${user && !subagent ? ' person' : ''}`}>
        {user && !subagent ? (
          <UserAvatar />
        ) : (
          <EntityMark threadId={threadId} mainAgent={mainAgent} subagent={subagent} />
        )}
      </span>
      <time
        ref={time}
        className="message-time"
        dateTime={date?.toISOString()}
        title={date ? formatAbsoluteDateTime(date) : undefined}
      >
        {timeText}
      </time>
    </button>
  );
}
