import type { Input } from '@kairos/contracts';
import { createPortal } from 'react-dom';
import { Icon } from './icon.js';

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
        <span className="queue-text">
          {ghost.input.text || ghost.input.attachments.map((file) => file.fileName).join('、')}
        </span>
        {ghost.input.attachments.length > 0 && <Icon name="clip" className="i-sm" />}
        <Icon name="edit" className="i-sm" />
        <Icon name="trash" className="i-sm" />
      </div>
    </>,
    document.body,
  );
}
