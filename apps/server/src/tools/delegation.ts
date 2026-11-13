import type { AgentTool } from '@kairos/agent-core';
import { z } from 'zod';
import type { DelegationKey } from '../context/types.js';
import { SessionError } from '../sessions/errors.js';
import type { InteractionRecord, RunRecord, RunStatus } from '../sessions/records.js';
import type { AcceptedThreadCall, SessionStore } from '../sessions/store.js';
import {
  environmentPolicyInput,
  environmentPolicyJson,
  optionalEnvironmentPolicySchema,
} from './environment-policy.js';

const threadListInputSchema = z
  .object({
    cursor: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER))
      .optional(),
    limit: z.number().int().positive().max(100).optional(),
  })
  .strict();
const threadCallInputSchema = z
  .object({
    thread_id: z.string().max(200).optional(),
    title: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).max(100_000),
    mode: z.enum(['steer', 'follow_up']).default('follow_up'),
    workspace_id: z.string().min(1).max(200).optional(),
    ...optionalEnvironmentPolicySchema.shape,
  })
  .strict();
const interactionReadInputSchema = z
  .object({
    tool_call_id: z.string().min(1).max(200),
    wait_ms: z.number().int().positive().max(30_000).optional(),
  })
  .strict();
const interactionCancelInputSchema = z
  .object({ tool_call_id: z.string().min(1).max(200) })
  .strict();

export interface DelegationToolOptions {
  store: SessionStore;
  source: RunRecord;
  scheduleThreadCall(accepted: AcceptedThreadCall): Promise<void>;
  waitForInteraction(key: DelegationKey, waitMs: number, signal: AbortSignal): Promise<void>;
  cancelInteraction(interaction: InteractionRecord, reason: string): Promise<InteractionRecord>;
  resolveEnvironmentIds?: (envIds: readonly string[]) => string[];
  projectEnvironmentIds?: (envIds: readonly string[]) => string[];
}

export function createThreadDelegationTools(
  options: DelegationToolOptions,
): [
  AgentTool<z.infer<typeof threadListInputSchema>>,
  AgentTool<z.infer<typeof threadCallInputSchema>>,
  AgentTool<z.infer<typeof interactionReadInputSchema>>,
  AgentTool<z.infer<typeof interactionCancelInputSchema>>,
] {
  return [
    {
      name: 'thread_list',
      description:
        'List persistent task Threads in scope with an optional cursor: the global main sees every workspace, a workspace main sees only its own workspace. Reuse a relevant existing Thread for ongoing work and follow-ups before creating another.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cursor: {
            type: 'string',
            pattern: '^(0|[1-9][0-9]*)$',
            description: 'Pagination cursor from a previous next_cursor.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: 'Maximum Threads to return; defaults to 50.',
          },
        },
      },
      concurrent: true,
      validate: (value) => threadListInputSchema.parse(value),
      execute: async (input) => {
        const scope = assertThreadToolSource(options);
        const limit = input.limit ?? 50;
        const threads = options.store.listThreads(
          options.source.ownerId,
          BigInt(input.cursor ?? '0'),
          limit + 1,
          'task',
          scope.workspaceId,
        );
        const page = threads.slice(0, limit);
        return jsonResult({
          threads: page.map((thread) => ({
            thread_id: thread.threadId,
            title: thread.title,
            thread_type: thread.threadType,
            workspace_id: thread.workspaceId ?? null,
            environment_policy: thread.environmentPolicy
              ? {
                  ...environmentPolicyJson(thread.environmentPolicy, options.projectEnvironmentIds),
                  policy_version: thread.environmentPolicy.policyVersion,
                }
              : undefined,
            current_binding: thread.currentBinding
              ? {
                  env_id:
                    options.projectEnvironmentIds?.([thread.currentBinding.envId])[0] ??
                    thread.currentBinding.envId,
                  pwd: thread.currentBinding.pwd,
                  binding_version: thread.currentBinding.bindingVersion,
                  resource_version: thread.currentBinding.resourceVersion,
                }
              : undefined,
          })),
          ...(threads.length > limit && page.length > 0
            ? { next_cursor: String(page.at(-1)?.seq ?? 0) }
            : {}),
        });
      },
    },
    {
      name: 'thread_call',
      description:
        'Create a persistent task Thread with its first prompt, or submit a prompt to an existing task Thread. A task Thread keeps its context, remains in the task list where the user can talk to it, and suits ongoing work that needs later follow-ups, repeated changes or continued user conversation; use a Subagent for a bounded one-off deliverable, even if it takes a long time. Thread calls run in the background only: the accepted receipt is not completion, the terminal result is delivered automatically, and no read or wait is needed to collect it. Do not use thread_read or wait_ms to keep a Run alive or collect the result. An existing Thread call accepts only thread_id, prompt and mode.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt'],
        properties: {
          thread_id: {
            type: 'string',
            maxLength: 200,
            description:
              'Existing task Thread to submit to; omit or pass an empty string to create a new Thread.',
          },
          title: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description: 'Title for the new Thread; only valid when creating.',
          },
          prompt: {
            type: 'string',
            minLength: 1,
            maxLength: 100_000,
            description:
              'Self-contained task prompt: goal, relevant context, constraints, exact paths, environment needs, deliverable and completion checks.',
          },
          mode: {
            type: 'string',
            enum: ['steer', 'follow_up'],
            default: 'follow_up',
            description:
              'follow_up queues after the current work; steer redirects work in progress.',
          },
          workspace_id: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description:
              'Workspace for the new Thread; only valid when creating. The global main may target any workspace, a workspace main only its own.',
          },
          allowed_env: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 32,
            description: 'Narrows the inherited environment authorization for the new Thread.',
          },
        },
      },
      concurrent: true,
      validate: (value) => {
        const input = threadCallInputSchema.parse(value);
        const creating = input.thread_id === undefined || input.thread_id.length === 0;
        const policy = environmentPolicyInput(input, options.resolveEnvironmentIds);
        if (!creating && (policy || input.workspace_id !== undefined)) {
          throw new SessionError(
            'invalid_argument',
            'An existing Thread call cannot change its environment policy or workspace.',
          );
        }
        return input;
      },
      execute: async (input, { call }) => {
        assertThreadToolSource(options);
        if (input.thread_id === options.source.threadId) {
          throw new SessionError('failed_precondition', 'A Thread cannot call itself.');
        }
        const environmentPolicy = environmentPolicyInput(input, options.resolveEnvironmentIds);
        const accepted = options.store.acceptThreadCall({
          ownerId: options.source.ownerId,
          sourceThreadId: options.source.threadId,
          sourceAgentId: options.source.agentId,
          sourceRunId: options.source.runId,
          sourceToolCallId: call.id,
          targetThreadId: input.thread_id ?? '',
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(environmentPolicy ? { environmentPolicy } : {}),
          ...(input.workspace_id === undefined ? {} : { workspaceId: input.workspace_id }),
          prompt: input.prompt,
          mode: input.mode,
        });
        await options.scheduleThreadCall(accepted);
        return jsonResult({
          tool_call_id: accepted.interaction.sourceToolCallId,
          thread_id: accepted.interaction.targetThreadId,
          status: 'accepted',
          automatic_delivery: true,
          next_step: BACKGROUND_ACCEPTED_NEXT_STEP,
        });
      },
    },
    {
      name: 'thread_read',
      description:
        'Read one Thread interaction by tool_call_id. Automatic delivery makes routine reads and polling unnecessary; use this only for an explicit status check, cancellation follow-up, recovery or reporting verification.',
      parameters: readParameters,
      concurrent: true,
      validate: (value) => interactionReadInputSchema.parse(value),
      execute: async (input, { signal }) => {
        assertThreadToolSource(options);
        const interaction = managedInteraction(options, input.tool_call_id, 'thread_call');
        if (input.wait_ms !== undefined && !isTerminal(interaction.status)) {
          await options.waitForInteraction(interaction, input.wait_ms, signal);
        }
        const current = managedInteraction(options, input.tool_call_id, 'thread_call');
        return jsonResult(interactionResult(options, current, input.wait_ms !== undefined));
      },
    },
    {
      name: 'thread_cancel',
      description:
        'Request cancellation of one Thread interaction by tool_call_id. Cancellation is requested, not confirmed; the terminal state arrives with automatic delivery.',
      parameters: cancelParameters,
      concurrent: true,
      validate: (value) => interactionCancelInputSchema.parse(value),
      execute: async (input) => {
        assertThreadToolSource(options);
        const interaction = managedInteraction(options, input.tool_call_id, 'thread_call');
        const cancelled = await options.cancelInteraction(
          interaction,
          'Cancellation requested by thread_cancel.',
        );
        return jsonResult({
          tool_call_id: cancelled.sourceToolCallId,
          status: cancelled.status,
        });
      },
    },
  ];
}

export const BACKGROUND_ACCEPTED_NEXT_STEP =
  'Accepted is not completion. Continue other work, or finish this turn after stating that the task is still running. The terminal result is persisted and injected automatically, with a root Run scheduled if needed; no status read or wait_ms is needed to receive it.';
const BACKGROUND_TIMEOUT_NEXT_STEP =
  'The wait timed out and the target was not cancelled. Do not repeat short waits or poll. Continue other work, or finish this turn after stating that the task is still running; the terminal result is persisted and injected automatically, with a root Run scheduled if needed.';

const readParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['tool_call_id'],
  properties: {
    tool_call_id: { type: 'string', minLength: 1, maxLength: 200 },
    wait_ms: {
      type: 'integer',
      minimum: 1,
      maximum: 30_000,
      description:
        'Optional bounded wait in milliseconds for a deliberate status check; omit for an immediate read. Do not use by default after creation or for repeated short polling. After a timeout, continue other work or finish the turn and rely on automatic delivery.',
    },
  },
};
const cancelParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['tool_call_id'],
  properties: { tool_call_id: { type: 'string', minLength: 1, maxLength: 200 } },
};

function managedInteraction(
  options: DelegationToolOptions,
  toolCallId: string,
  kind: InteractionRecord['kind'],
): InteractionRecord {
  const interaction = options.store.getInteractionForSource(
    options.source.ownerId,
    options.source.threadId,
    options.source.agentId,
    toolCallId,
  );
  if (interaction.kind !== kind) {
    throw new SessionError('failed_precondition', 'The interaction has the wrong target type.');
  }
  if (kind === 'subagent' && interaction.executionMode !== 'background') {
    throw new SessionError(
      'failed_precondition',
      'Subagent control tools require a background interaction.',
    );
  }
  return interaction;
}

function interactionResult(
  options: DelegationToolOptions,
  interaction: InteractionRecord,
  waited: boolean,
) {
  const response = options.store.getCurrentInteractionResponse(options.source.ownerId, interaction);
  const timedOut = waited && !isTerminal(interaction.status);
  return {
    tool_call_id: interaction.sourceToolCallId,
    status: interaction.status,
    response: response?.message.role === 'assistant' ? response.message.content : null,
    error: interaction.error,
    timed_out: timedOut,
    ...(timedOut ? { automatic_delivery: true, next_step: BACKGROUND_TIMEOUT_NEXT_STEP } : {}),
  };
}

function assertThreadToolSource(options: DelegationToolOptions): { workspaceId: string | null } {
  assertPersistentSource(options);
  const thread = options.store.getThread(options.source.ownerId, options.source.threadId);
  if (thread.threadType === 'main') return { workspaceId: null };
  if (thread.threadType === 'workspace_main' && thread.workspaceId) {
    return { workspaceId: thread.workspaceId };
  }
  throw new SessionError(
    'permission_denied',
    'Thread tools require a main or workspace main root Agent.',
  );
}

function assertPersistentSource(options: DelegationToolOptions): void {
  if (options.source.agentId !== 'thread' || options.source.parentRunId !== null) {
    throw new SessionError(
      'permission_denied',
      'Delegation controls require a persistent Thread root Agent.',
    );
  }
}

export function createSubagentTaskOps(options: DelegationToolOptions): {
  read(
    toolCallId: string,
    waitMs: number | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
  cancel(toolCallId: string): Promise<Record<string, unknown>>;
} {
  return {
    read: async (toolCallId, waitMs, signal) => {
      assertPersistentSource(options);
      const interaction = managedInteraction(options, toolCallId, 'subagent');
      if (waitMs !== undefined && !isTerminal(interaction.status)) {
        await options.waitForInteraction(interaction, waitMs, signal);
      }
      const current = managedInteraction(options, toolCallId, 'subagent');
      return interactionResult(options, current, waitMs !== undefined);
    },
    cancel: async (toolCallId) => {
      assertPersistentSource(options);
      const interaction = managedInteraction(options, toolCallId, 'subagent');
      const cancelled = await options.cancelInteraction(
        interaction,
        'Cancellation requested by task_stop.',
      );
      return { tool_call_id: cancelled.sourceToolCallId, status: cancelled.status };
    },
  };
}

function isTerminal(status: RunStatus): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
}

function jsonResult(value: unknown): { content: string } {
  return { content: JSON.stringify(value) };
}

const workspaceListInputSchema = z.object({}).strict();

const workspaceCreateInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    env_id: z.string().min(1).max(200),
    path: z.string().min(1).max(4096),
    description: z.string().max(2000).optional(),
  })
  .strict();

export function createWorkspaceCreateTool(
  options: DelegationToolOptions,
): AgentTool<z.infer<typeof workspaceCreateInputSchema>> {
  return {
    name: 'workspace_create',
    description:
      'Create a persistent workspace that pins a device and a working directory as the default execution target for its Threads, creating its workspace main conversation in the same step. Call workspace_list first and reuse an existing workspace for the same device and directory; discover device ids with env_list and pass an absolute directory on that device. Only the global main Agent can create workspaces.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'env_id', 'path'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        env_id: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Device id from env_list; use main for the primary environment.',
        },
        path: {
          type: 'string',
          minLength: 1,
          maxLength: 4096,
          description: 'Absolute working directory on that device.',
        },
        description: { type: 'string', maxLength: 2000 },
      },
    },
    concurrent: false,
    validate: (value) => {
      const input = workspaceCreateInputSchema.parse(value);
      if (!input.path.startsWith('/')) {
        throw new Error('The workspace path must be absolute.');
      }
      return input;
    },
    execute: async (input) => {
      const source = assertThreadToolSource(options);
      if (source.workspaceId !== null) {
        throw new SessionError(
          'permission_denied',
          'Only the global main Agent can create workspaces.',
        );
      }
      const envId = options.resolveEnvironmentIds?.([input.env_id])[0] ?? input.env_id;
      const created = options.store.createWorkspace({
        ownerId: options.source.ownerId,
        name: input.name,
        envId,
        path: input.path,
        ...(input.description === undefined ? {} : { description: input.description }),
      });
      return jsonResult({
        workspace_id: created.workspace.workspaceId,
        name: created.workspace.name,
        env_id:
          options.projectEnvironmentIds?.([created.workspace.envId])[0] ?? created.workspace.envId,
        path: created.workspace.path,
        main_thread_id:
          options.store.workspaceMainThreadId(
            options.source.ownerId,
            created.workspace.workspaceId,
          ) ?? null,
      });
    },
  };
}

export function createWorkspaceListTool(
  options: DelegationToolOptions,
): AgentTool<z.infer<typeof workspaceListInputSchema>> {
  return {
    name: 'workspace_list',
    description:
      'List workspaces available to this tenant. Each workspace pins a device and a working directory as the default execution target for its Threads, and has its own workspace main conversation. Use workspace_id when creating a task Thread in a workspace with thread_call, or main_thread_id to talk to the workspace main.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    concurrent: true,
    validate: (value) => workspaceListInputSchema.parse(value),
    execute: async () => {
      assertThreadToolSource(options);
      const workspaces = options.store.listWorkspaces(options.source.ownerId);
      return jsonResult({
        workspaces: workspaces.map((workspace) => ({
          workspace_id: workspace.workspaceId,
          name: workspace.name,
          env_id: options.projectEnvironmentIds?.([workspace.envId])[0] ?? workspace.envId,
          path: workspace.path,
          main_thread_id:
            options.store.workspaceMainThreadId(options.source.ownerId, workspace.workspaceId) ??
            null,
        })),
      });
    },
  };
}
