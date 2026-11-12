import type { DelegationReference, Message, ToolCall } from '@kairos/contracts';

export type DelegationIdentity = Pick<
  DelegationReference,
  'sourceThreadId' | 'sourceAgentId' | 'sourceToolCallId'
>;

export function delegationForToolCall(
  source: Pick<Message, 'threadId' | 'agentId'>,
  call: Pick<ToolCall, 'toolCallId'>,
): DelegationIdentity {
  return {
    sourceThreadId: source.threadId,
    sourceAgentId: source.agentId,
    sourceToolCallId: call.toolCallId,
  };
}

export function delegationKey(delegation: DelegationIdentity): string {
  return JSON.stringify([
    delegation.sourceThreadId,
    delegation.sourceAgentId,
    delegation.sourceToolCallId,
  ]);
}
