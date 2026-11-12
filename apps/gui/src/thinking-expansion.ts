export type ThinkingExpansionChoices = Readonly<Record<string, boolean>>;

export function thinkingBlockKey(messageId: string, blockIndex: number): string {
  return JSON.stringify([messageId, blockIndex]);
}

export function isThinkingBlockExpanded(
  choices: ThinkingExpansionChoices,
  messageId: string,
  blockIndex: number,
): boolean {
  return choices[thinkingBlockKey(messageId, blockIndex)] === true;
}

export function withThinkingBlockExpanded(
  choices: ThinkingExpansionChoices,
  messageId: string,
  blockIndex: number,
  expanded: boolean,
): ThinkingExpansionChoices {
  return { ...choices, [thinkingBlockKey(messageId, blockIndex)]: expanded };
}
