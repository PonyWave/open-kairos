import { type Message, MessageRole, MessageSource } from '@kairos/contracts';

export const rootAgentId = 'thread';

export function isRootAgent(agentId: string): boolean {
  return agentId === rootAgentId;
}

export function isDirectUserMessage(message: Pick<Message, 'role' | 'source'>): boolean {
  return (
    message.role === MessageRole.USER &&
    (message.source === undefined || message.source === MessageSource.USER)
  );
}

export function formatSequence(value: bigint): string {
  return value.toString(10);
}
