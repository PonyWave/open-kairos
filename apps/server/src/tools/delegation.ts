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
        'List persistent task Threads available to the main Agent with an optional cursor. Reuse a relevant existing Thread for ongoing work and follow-ups before creating another.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cursor: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
      concurrent: true,
      validate: (value) => threadListInputSchema.parse(value),
      execute: async (input) => {
        assertMainSource(options);
        const limit = input.limit ?? 50;
        const threads = options.store.listThreads(
          options.source.ownerId,
          BigInt(input.cursor ?? '0'),
          limit + 1,
          'task',
        );
        const page = threads.slice(0, limit);
        return jsonResult({
          threads: page.map((thread) => ({
            thread_id: thread.threadId,
            title: thread.title,
            thread_type: thread.threadType,
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
        'Delegate ongoing work that needs later follow-ups, repeated changes or continued user conversation to a persistent task Thread. It keeps context and remains in the task list where the user can talk to it. Reuse an existing Thread for the same ongoing work. Use Subagent for a bounded one-off deliverable, even if it takes a long time. Create a task Thread with its first prompt when thread_id is omitted or empty, or submit a prompt to an existing task Thread. All Agents use the main environment workspace. Optional allowed_env narrows inherited environment authorization; tools select other environments per call using env_id. Include relevant context, constraints, exact paths, environment needs, deliverable and completion checks. Thread calls are background only. The accepted status is not completion. After a terminal result is persisted, it is injected automatically and a root Run is scheduled if needed. Continue other work, or finish this turn after stating that the task is still running. Do not use thread_read or wait_ms to keep a Run alive or collect the result.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt'],
        properties: {
          thread_id: { type: 'string', maxLength: 200 },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          prompt: { type: 'string', minLength: 1, maxLength: 100_000 },
          mode: { type: 'string', enum: ['steer', 'follow_up'], default: 'follow_up' },
          allowed_env: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 },
        },
      },
      concurrent: true,
      validate: (value) => {
        const input = threadCallInputSchema.parse(value);
        const creating = input.thread_id === undefined || input.thread_id.length === 0;
        const policy = environmentPolicyInput(input, options.resolveEnvironmentIds);
        if (!creating && policy) {
          throw new SessionError(
            'invalid_argument',
            'An existing Thread call cannot change its environment policy.',
          );
        }
        return input;
      },
      execute: async (input, { call }) => {
        assertMainSource(options);
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
        'Read one Thread interaction now, or wait briefly only for an explicit status check. Use this only when the user requests status or cancellation, recovery, or reporting requires verification. Automatic delivery makes routine reads, polling, and waits unnecessary; do not query again for an automatically delivered result. Do not use this tool to keep a Run alive.',
      parameters: readParameters,
      concurrent: true,
      validate: (value) => interactionReadInputSchema.parse(value),
      execute: async (input, { signal }) => {
        assertMainSource(options);
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
      description: 'Request cancellation of one exact Thread interaction.',
      parameters: cancelParameters,
      concurrent: true,
      validate: (value) => interactionCancelInputSchema.parse(value),
      execute: async (input) => {
        assertMainSource(options);
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

export function createSubagentDelegationTools(
  options: DelegationToolOptions,
): [
  AgentTool<z.infer<typeof interactionReadInputSchema>>,
  AgentTool<z.infer<typeof interactionCancelInputSchema>>,
] {
  return [
    {
      name: 'subagent_status',
      description:
        'Read one background Subagent now, or wait briefly only for an explicit status check. Use this only when the user requests status or cancellation, recovery, or reporting requires verification. Automatic delivery makes routine reads, polling, and waits unnecessary; do not query again for an automatically delivered result. Do not use this tool to keep a Run alive.',
      parameters: readParameters,
      concurrent: true,
      validate: (value) => interactionReadInputSchema.parse(value),
      execute: async (input, { signal }) => {
        assertPersistentSource(options);
        const interaction = managedInteraction(options, input.tool_call_id, 'subagent');
        if (input.wait_ms !== undefined && !isTerminal(interaction.status)) {
          await options.waitForInteraction(interaction, input.wait_ms, signal);
        }
        const current = managedInteraction(options, input.tool_call_id, 'subagent');
        return jsonResult(interactionResult(options, current, input.wait_ms !== undefined));
      },
    },
    {
      name: 'subagent_cancel',
      description: 'Request cancellation of one exact background Subagent interaction.',
      parameters: cancelParameters,
      concurrent: true,
      validate: (value) => interactionCancelInputSchema.parse(value),
      execute: async (input) => {
        assertPersistentSource(options);
        const interaction = managedInteraction(options, input.tool_call_id, 'subagent');
        const cancelled = await options.cancelInteraction(
          interaction,
          'Cancellation requested by subagent_cancel.',
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

function assertMainSource(options: DelegationToolOptions): void {
  assertPersistentSource(options);
  if (
    options.store.getThread(options.source.ownerId, options.source.threadId).threadType !== 'main'
  ) {
    throw new SessionError('permission_denied', 'Thread tools require the main Thread root Agent.');
  }
}

function assertPersistentSource(options: DelegationToolOptions): void {
  if (options.source.agentId !== 'thread' || options.source.parentRunId !== null) {
    throw new SessionError(
      'permission_denied',
      'Delegation controls require a persistent Thread root Agent.',
    );
  }
}

function isTerminal(status: RunStatus): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
}

function jsonResult(value: unknown): { content: string } {
  return { content: JSON.stringify(value) };
}
