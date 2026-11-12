import type { AgentTool } from '@kairos/agent-core';
import { z } from 'zod';
import { SessionError } from '../sessions/errors.js';
import type { RunRecord } from '../sessions/records.js';
import type { AcceptedThreadNotification, SessionStore } from '../sessions/store.js';

const threadNotifyInputSchema = z.object({ message: z.string().min(1).max(20_000) }).strict();

export interface ThreadNotificationToolOptions {
  store: SessionStore;
  source: RunRecord;
  scheduleThreadNotification(accepted: AcceptedThreadNotification): Promise<void>;
}

export function createThreadNotificationTool(
  options: ThreadNotificationToolOptions,
): AgentTool<z.infer<typeof threadNotifyInputSchema>> {
  return {
    name: 'thread_notify',
    description:
      'Send a concise user-facing message from this persistent task Thread to its main conversation. Use it for a meaningful finding, changed plan, blocker or required input that should reach the main Agent before this task finishes. The Server chooses the main conversation and persists the exact source Thread, root Agent and tool call. Accepted means the notification was saved for automatic injection, not that the main Agent or user has read it. Do not use this tool for routine progress or duplicate a final response.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: {
        message: {
          type: 'string',
          minLength: 1,
          maxLength: 20_000,
          description:
            'The complete message for the main Agent, with relevant facts and requested action.',
        },
      },
    },
    concurrent: true,
    validate: (value) => threadNotifyInputSchema.parse(value),
    execute: async (input, { signal, call }) => {
      signal.throwIfAborted();
      if (options.source.agentId !== 'thread' || options.source.parentRunId !== null) {
        throw new SessionError(
          'permission_denied',
          'thread_notify requires a persistent task Thread root Agent.',
        );
      }
      const thread = options.store.getThread(options.source.ownerId, options.source.threadId);
      if (thread.threadType !== 'task' || thread.automationOnly) {
        throw new SessionError(
          'permission_denied',
          'thread_notify requires a normal persistent task Thread root Agent.',
        );
      }
      const accepted = options.store.acceptThreadNotification({
        ownerId: options.source.ownerId,
        sourceThreadId: options.source.threadId,
        sourceAgentId: options.source.agentId,
        sourceRunId: options.source.runId,
        sourceToolCallId: call.id,
        content: input.message,
      });
      await options.scheduleThreadNotification(accepted);
      return { content: JSON.stringify(threadNotificationAcceptance(accepted.notification)) };
    },
  };
}

export function threadNotificationAcceptance(
  notification: AcceptedThreadNotification['notification'],
) {
  return {
    tool_call_id: notification.sourceToolCallId,
    status: 'accepted',
    automatic_delivery: true,
    next_step:
      'The notification is persisted and will be injected into the main conversation automatically, with a root Run scheduled if needed. Accepted does not mean the main Agent or user has read it. Continue the task without resending the same notification.',
  };
}
