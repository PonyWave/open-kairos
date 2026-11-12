import type { DelegationKey } from '../context/types.js';
import { wrapSystemReminder } from './system-reminder.js';

export function threadNotificationDeliveryText(key: DelegationKey, message: string): string {
  return wrapSystemReminder(
    'A Thread sent a notification to this main conversation. This is an automatic delivery record, not a user message; read the message field and continue the conversation accordingly.\n' +
      JSON.stringify({
        kind: 'thread_notification',
        source_thread_id: key.sourceThreadId,
        source_agent_id: key.sourceAgentId,
        tool_call_id: key.sourceToolCallId,
        thread_id: key.sourceThreadId,
        message,
      }),
  );
}
