import { type Message, MessageRole, ToolResultStatus } from '@kairos/contracts';

export interface SentUserMessage {
  content: string;
  endTurn: boolean;
}

export function sentUserMessage(message: Message): SentUserMessage | null {
  if (
    message.role !== MessageRole.TOOL ||
    message.agentId !== 'thread' ||
    message.toolName !== 'send_to_user' ||
    message.toolStatus !== ToolResultStatus.SUCCESS ||
    !message.toolCallId ||
    message.supersededByRunId
  ) {
    return null;
  }
  try {
    const result: unknown = JSON.parse(message.content);
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      Reflect.get(result, 'status') !== 'sent'
    ) {
      return null;
    }
    const content: unknown = Reflect.get(result, 'content');
    const endTurn: unknown = Reflect.get(result, 'end_turn');
    if (typeof content !== 'string' || !content.trim() || typeof endTurn !== 'boolean') {
      return null;
    }
    return { content, endTurn };
  } catch {
    return null;
  }
}
