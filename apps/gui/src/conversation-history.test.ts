import { create, type Message, MessageRole, MessageSchema, MessageSource } from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import {
  clampHiddenTurnCount,
  conversationHistoryStartIndex,
  conversationTurnCount,
  conversationTurnStarts,
  initialHiddenTurnCount,
  revealEarlierTurnCount,
} from './conversation-history.js';
import type { ConversationItem } from './response-projection.js';

function item(id: string, role: MessageRole, source?: MessageSource): ConversationItem {
  const message = create(MessageSchema, {
    messageId: id,
    threadId: 'thread-1',
    agentId: 'thread',
    role,
    content: id,
    ...(source === undefined ? {} : { source }),
  });
  return {
    kind: 'message',
    key: id,
    value: { message, streaming: false, delegationCall: null },
  };
}

function turn(index: number): ConversationItem[] {
  return [item(`user-${index}`, MessageRole.USER), item(`reply-${index}`, MessageRole.ASSISTANT)];
}

function turns(count: number): ConversationItem[] {
  return Array.from({ length: count }, (_, index) => turn(index)).flat();
}

function visibleUsers(items: readonly ConversationItem[], startIndex: number): string[] {
  return items
    .slice(startIndex)
    .filter(
      (entry): entry is ConversationItem & { kind: 'message'; value: { message: Message } } =>
        entry.kind === 'message' && entry.value.message.role === MessageRole.USER,
    )
    .map((entry) => entry.value.message.messageId);
}

describe('conversation history turns', () => {
  it('shows the latest ten turns and reveals ten more on each request', () => {
    const items = turns(25);
    const turnStarts = conversationTurnStarts(items);
    expect(conversationTurnCount(items, turnStarts)).toBe(25);

    const initialHidden = initialHiddenTurnCount(turnStarts.length);
    expect(initialHidden).toBe(15);
    expect(visibleUsers(items, conversationHistoryStartIndex(turnStarts, initialHidden))).toEqual(
      Array.from({ length: 10 }, (_, index) => `user-${index + 15}`),
    );

    const nextHidden = revealEarlierTurnCount(initialHidden);
    expect(nextHidden).toBe(5);
    expect(visibleUsers(items, conversationHistoryStartIndex(turnStarts, nextHidden))).toEqual(
      Array.from({ length: 20 }, (_, index) => `user-${index + 5}`),
    );
    expect(revealEarlierTurnCount(nextHidden)).toBe(0);
    expect(conversationHistoryStartIndex(turnStarts, 0)).toBe(0);
  });

  it('keeps every revealed turn visible when new turns arrive', () => {
    const items = turns(25);
    const hiddenAfterLoad = revealEarlierTurnCount(initialHiddenTurnCount(25));
    const extended = [...items, ...turn(25)];
    const extendedStarts = conversationTurnStarts(extended);
    const hidden = clampHiddenTurnCount(conversationTurnCount(extended, extendedStarts), 5);

    expect(hiddenAfterLoad).toBe(5);
    expect(hidden).toBe(5);
    expect(visibleUsers(extended, conversationHistoryStartIndex(extendedStarts, hidden))).toEqual(
      Array.from({ length: 21 }, (_, index) => `user-${index + 5}`),
    );
    expect(conversationHistoryStartIndex(extendedStarts, 0)).toBe(0);
  });

  it('shows short and non-direct message streams without an earlier-message control', () => {
    const short = turns(10);
    expect(
      initialHiddenTurnCount(conversationTurnCount(short, conversationTurnStarts(short))),
    ).toBe(0);

    const delegated = item('delegated', MessageRole.USER, MessageSource.THREAD_CALL);
    const reply = item('reply', MessageRole.ASSISTANT);
    const items = [delegated, reply];
    const turnStarts = conversationTurnStarts(items);
    expect(turnStarts).toEqual([]);
    expect(conversationTurnCount(items, turnStarts)).toBe(1);
    expect(conversationHistoryStartIndex(turnStarts, 10)).toBe(0);
  });
});
