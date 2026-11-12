import type { ConversationScrollTarget } from './conversation-scroll.js';

export interface ConversationAnchorPosition<Key> {
  key: Key;
  top: number;
  bottom: number;
}

export interface ConversationScrollAnchor<Key> {
  scrollTop: number;
  scrollHeight: number;
  positions: readonly ConversationAnchorPosition<Key>[];
}

export function captureConversationScrollAnchor<Key>(
  target: ConversationScrollTarget,
  positions: readonly ConversationAnchorPosition<Key>[],
): ConversationScrollAnchor<Key> {
  return {
    scrollTop: target.scrollTop,
    scrollHeight: target.scrollHeight,
    positions: positions.filter(
      (position) =>
        position.bottom > position.top && position.bottom > 0 && position.top < target.clientHeight,
    ),
  };
}

export function restoreConversationScrollAnchor<Key>(
  target: ConversationScrollTarget,
  anchor: ConversationScrollAnchor<Key>,
  positions: readonly ConversationAnchorPosition<Key>[],
): void {
  const currentPositions = new Map(positions.map((position) => [position.key, position]));
  let nextTop = anchor.scrollTop + target.scrollHeight - anchor.scrollHeight;
  for (const previous of anchor.positions) {
    const current = currentPositions.get(previous.key);
    if (!current || current.bottom <= current.top) continue;
    nextTop = target.scrollTop + current.top - previous.top;
    break;
  }
  nextTop = Math.max(0, Math.min(nextTop, target.scrollHeight - target.clientHeight));
  if (Math.abs(target.scrollTop - nextTop) > 0.5) target.scrollTop = nextTop;
}
