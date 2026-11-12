import { isDirectUserMessage } from './labels.js';
import type { ConversationItem } from './response-projection.js';

export const conversationTurnBatchSize = 10;

export function conversationTurnStarts(items: readonly ConversationItem[]): number[] {
  return items.flatMap((item, index) =>
    item.kind === 'message' && isDirectUserMessage(item.value.message) ? [index] : [],
  );
}

export function conversationTurnCount(
  items: readonly ConversationItem[],
  turnStarts: readonly number[],
): number {
  return items.length === 0 ? 0 : Math.max(1, turnStarts.length);
}

export function initialHiddenTurnCount(turnCount: number): number {
  return Math.max(0, turnCount - conversationTurnBatchSize);
}

export function clampHiddenTurnCount(turnCount: number, hiddenTurnCount: number): number {
  return Math.min(Math.max(0, hiddenTurnCount), Math.max(0, turnCount - 1));
}

export function revealEarlierTurnCount(hiddenTurnCount: number): number {
  return Math.max(0, hiddenTurnCount - conversationTurnBatchSize);
}

export function conversationHistoryStartIndex(
  turnStarts: readonly number[],
  hiddenTurnCount: number,
): number {
  if (hiddenTurnCount <= 0 || turnStarts.length === 0) return 0;
  return turnStarts[Math.min(hiddenTurnCount, turnStarts.length - 1)] ?? 0;
}
