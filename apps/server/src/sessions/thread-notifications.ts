import type { DelegationKey } from '../context/types.js';

export function threadNotificationDeliveryText(key: DelegationKey, message: string): string {
  return JSON.stringify({
    kind: 'thread_notification',
    source_thread_id: key.sourceThreadId,
    source_agent_id: key.sourceAgentId,
    tool_call_id: key.sourceToolCallId,
    thread_id: key.sourceThreadId,
    message,
  });
}
