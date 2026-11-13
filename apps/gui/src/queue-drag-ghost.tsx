import type { Input } from '@kairos/contracts';
import { createPortal } from 'react-dom';
import { Icon } from './icon.js';
import { queuedInputDisplay } from './queue-display.js';

export interface QueueDragGhostState {
  input: Input;
  left: number;
  top: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  settling: boolean;
  pointerId: number;
}

export function QueueDragGhost({ ghost }: { ghost: QueueDragGhostState }) {
  const display = queuedInputDisplay(ghost.input);
  return createPortal(
    <>
      <button
        type="button"
        className="queue-drag-shield"
        tabIndex={-1}
        aria-label="正在拖动队列消息"
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      />
      <div
        className="queue-drag-ghost"
        data-settling={ghost.settling}
        aria-hidden="true"
        style={{ left: ghost.left, top: ghost.top, width: ghost.width, height: ghost.height }}
      >
        <Icon name="grip" className="i-sm" />
        {display.channelKey && (
          <span className={`queue-channel channel-${display.channelKey}`}>
            <Icon name={display.channelKey === 'wechat' ? 'wechat' : 'feishu'} className="i-sm" />
          </span>
        )}
        <span className="queue-text">{display.text}</span>
        {ghost.input.attachments.length > 0 && <Icon name="clip" className="i-sm" />}
        <Icon name="edit" className="i-sm" />
        <Icon name="trash" className="i-sm" />
      </div>
    </>,
    document.body,
  );
}
