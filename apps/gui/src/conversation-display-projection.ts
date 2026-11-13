import {
  type Message,
  MessageRole,
  MessageSource,
  type Run,
  RunStatus,
  ToolResultStatus,
} from '@kairos/contracts';
import type { ConversationDisplayMode } from './conversation-display.js';
import { isDirectUserMessage } from './labels.js';
import type { ConversationItem } from './response-projection.js';

export function projectConversationDisplay(
  items: readonly ConversationItem[],
  runs: readonly Run[],
  mode: ConversationDisplayMode,
): ConversationItem[] {
  if (mode === 'full') {
    const displayed: ConversationItem[] = [];
    const sentCalls = new Set<string>();
    for (const item of items) {
      if (item.kind !== 'message' || !item.value.sentMessage) {
        displayed.push(item);
        continue;
      }
      const message = item.value.message;
      const key = `${message.threadId}:${message.agentId}:${message.toolCallId}`;
      if (sentCalls.has(key)) continue;
      sentCalls.add(key);
      displayed.push(item);
    }
    return displayed;
  }
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  const displayed: ConversationItem[] = [];
  const sentCalls = new Set<string>();
  const resolvedSends = new Set<string>();
  const receiptPositions = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    if (item.kind === 'message' && item.value.message.role === MessageRole.TOOL) {
      const message = item.value.message;
      if (message.toolName === 'thread_call') receiptPositions.set(message.toolCallId, index);
    }
  }
  const pendingCards: Array<{ item: ConversationItem; callId: string; blockers: string[] }> = [];
  const flushCards = (position: number) => {
    for (let index = 0; index < pendingCards.length; ) {
      const pending = pendingCards[index];
      if (!pending) break;
      if (
        (receiptPositions.get(pending.callId) ?? -1) > position ||
        !pending.blockers.every((callId) => resolvedSends.has(callId))
      ) {
        index += 1;
        continue;
      }
      displayed.push(pending.item);
      pendingCards.splice(index, 1);
    }
  };
  let directUser: Message | undefined;
  let receivedReply = false;
  let usesExplicitOutput = false;
  const finishReply = () => {
    if (!directUser || receivedReply || !usesExplicitOutput) return;
    const run = directUser.runId ? runsById.get(directUser.runId) : undefined;
    if (!run || run.supersededByRunId || run.status !== RunStatus.COMPLETED) return;
    displayed.push({
      kind: 'missing-user-reply',
      key: `missing-user-reply:${directUser.messageId}`,
      value: run,
    });
  };
  for (const [position, item] of items.entries()) {
    if (item.kind === 'run-outcome' || item.kind === 'pending-agent') {
      displayed.push(item);
      continue;
    }
    if (item.kind !== 'message') continue;
    const display = item.value;
    const message = display.message;
    if (isDirectUserMessage(message)) {
      finishReply();
      directUser = message;
      receivedReply = false;
      usesExplicitOutput = false;
      displayed.push(item);
      continue;
    }
    if (display.sentMessage) {
      const key = `${message.threadId}:${message.agentId}:${message.toolCallId}`;
      if (!sentCalls.has(key)) {
        displayed.push({ ...item, value: { ...display, compact: true } });
        sentCalls.add(key);
      }
      receivedReply = true;
      resolvedSends.add(message.toolCallId);
      flushCards(position);
      continue;
    }
    if (
      message.source === MessageSource.THREAD_RESPONSE ||
      message.source === MessageSource.SUBAGENT_RESPONSE ||
      message.source === MessageSource.THREAD_NOTIFICATION
    ) {
      continue;
    }
    const explicitOutput = display.streaming
      ? message.runId !== undefined && runsById.get(message.runId)?.sendToUserEnabled === true
      : message.sendToUserEnabled === true;
    if (explicitOutput) usesExplicitOutput = true;
    if (
      message.role === MessageRole.TOOL &&
      message.toolName === 'send_to_user' &&
      message.toolStatus === ToolResultStatus.ERROR
    ) {
      displayed.push({ ...item, value: { ...display, sendFailure: true, compact: true } });
      resolvedSends.add(message.toolCallId);
      flushCards(position);
      continue;
    }
    if (message.role === MessageRole.TOOL && message.toolName === 'thread_call') {
      flushCards(position);
    }
    if (!explicitOutput) {
      displayed.push(item);
      continue;
    }
    if (message.role !== MessageRole.ASSISTANT) continue;
    const blockers: string[] = [];
    for (const call of message.toolCalls) {
      if (call.toolName === 'send_to_user') blockers.push(call.toolCallId);
      if (call.toolName !== 'thread_call') continue;
      pendingCards.push({
        callId: call.toolCallId,
        blockers: [...blockers],
        item: {
          ...item,
          key: `${item.key}:call:${call.toolCallId}`,
          value: {
            ...display,
            toolItems: [{ kind: 'delegation', id: call.toolCallId, call }],
            hideContent: true,
            compact: true,
          },
        },
      });
    }
    flushCards(position);
  }
  finishReply();
  return displayed;
}
