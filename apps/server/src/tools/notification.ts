import type { AgentTool } from '@kairos/agent-core';
import { z } from 'zod';
import { SessionError } from '../sessions/errors.js';
import type { RunRecord } from '../sessions/records.js';
import type { AcceptedThreadNotification, SessionStore } from '../sessions/store.js';

const threadNotifyInputSchema = z
  .object({
    message: z.string().min(1).max(20_000),
    target: z.enum(['workspace', 'global']).optional(),
  })
  .strict();

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
      'Send a message from this persistent Thread to a main conversation. A task Thread in a workspace notifies its workspace main by default, or the global main with target global; a workspace main or a temporary conversation notifies the global main. Use it for a meaningful finding, changed plan, blocker or required input that should reach the main Agent before this task finishes. The accepted receipt means the notification is persisted for automatic injection, not that it was read; do not resend it or use it for routine progress.',
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
        target: {
          type: 'string',
          enum: ['workspace', 'global'],
          description:
            'Notification target. Task Threads default to their workspace main; use global for the global main. Workspace mains and temporary conversations only accept global.',
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
          'thread_notify requires a persistent Thread root Agent.',
        );
      }
      const thread = options.store.getThread(options.source.ownerId, options.source.threadId);
      const isWorkspaceMain = thread.threadType === 'workspace_main';
      const isTask = thread.threadType === 'task' && !thread.automationOnly;
      if (!isWorkspaceMain && !isTask) {
        throw new SessionError(
          'permission_denied',
          'thread_notify requires a normal persistent task Thread or workspace main root Agent.',
        );
      }
      const target =
        input.target ?? (isWorkspaceMain || !thread.workspaceId ? 'global' : 'workspace');
      if (target === 'workspace' && (isWorkspaceMain || !thread.workspaceId)) {
        throw new SessionError(
          'failed_precondition',
          'This Thread has no workspace main; notify the global main instead.',
        );
      }
      const accepted = options.store.acceptThreadNotification({
        ownerId: options.source.ownerId,
        sourceThreadId: options.source.threadId,
        sourceAgentId: options.source.agentId,
        sourceRunId: options.source.runId,
        sourceToolCallId: call.id,
        content: input.message,
        target,
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
    target: notification.target,
    automatic_delivery: true,
    next_step:
      'The notification is persisted and will be injected into the target main conversation automatically, with a root Run scheduled if needed. Accepted does not mean the main Agent or user has read it. Continue the task without resending the same notification.',
  };
}
