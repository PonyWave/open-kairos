import type { ModelMessage } from '@kairos/agent-core';
import { mergeRecapText } from '../recap/selection.js';
import type { Recap } from '../recap/types.js';
import type { ContextMessage } from './types.js';
import { currentModelMessage } from './types.js';

export function buildModelMessages(input: {
  systemInstructions: readonly string[];
  recaps: readonly Recap[];
  contextMessages: readonly ContextMessage[];
  pendingMessages: readonly ModelMessage[];
}): ModelMessage[] {
  const messages: ModelMessage[] = input.systemInstructions.map((content) => ({
    role: 'system',
    content,
  }));
  if (input.recaps.length > 0) {
    messages.push({ role: 'user', content: mergeRecapText(input.recaps) });
  }
  messages.push(...input.contextMessages.map(currentModelMessage));
  messages.push(...input.pendingMessages);
  return messages;
}
