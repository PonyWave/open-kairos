import type { AgentTool } from '@kairos/agent-core';
import { z } from 'zod';
import { SessionError } from '../sessions/errors.js';
import type { BackgroundTaskRecord, RunRecord } from '../sessions/records.js';
import type { SessionStore } from '../sessions/store.js';

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'timed_out', 'killed', 'unknown']);

export interface TaskToolBashOps {
  snapshot(
    operationId: string,
    limit: number,
  ): { content: string; terminal: boolean; status: string };
  cancel(operationId: string, reason: string): Promise<void>;
}

export interface TaskToolSubagentOps {
  read(
    toolCallId: string,
    waitMs: number | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
  cancel(toolCallId: string): Promise<Record<string, unknown>>;
}

export interface TaskToolOptions {
  store: SessionStore;
  source: RunRecord;
  bash: TaskToolBashOps;
  subagent: TaskToolSubagentOps;
  waitForBash(
    operationId: string,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<{ terminal: boolean; status: string }>;
}

const listSchema = z.object({ limit: z.number().int().positive().max(100).default(50) }).strict();
const outputSchema = z
  .object({
    task_id: z.string().min(1).max(200),
    wait_ms: z.number().int().positive().max(30_000).optional(),
    output_bytes: z.number().int().positive().max(16_384).default(4096),
  })
  .strict();
const stopSchema = z.object({ task_id: z.string().min(1).max(200) }).strict();
const waitSchema = z
  .object({
    task_id: z.string().min(1).max(200).optional(),
    timeout_ms: z.number().int().positive().max(60_000).default(30_000),
  })
  .strict();

function taskJson(task: BackgroundTaskRecord) {
  return {
    task_id: task.taskId,
    kind: task.kind,
    description: task.description,
    status: task.status,
    created_at: task.createdAt,
    ended_at: task.endedAt,
  };
}

function findTask(options: TaskToolOptions, taskId: string): BackgroundTaskRecord | undefined {
  try {
    const task = options.store.getBackgroundTask(options.source.ownerId, taskId);
    if (task.threadId !== options.source.threadId || task.agentId !== options.source.agentId) {
      return undefined;
    }
    return task;
  } catch {
    return undefined;
  }
}

export function createTaskTools(
  options: TaskToolOptions,
): [
  AgentTool<z.infer<typeof listSchema>>,
  AgentTool<z.infer<typeof outputSchema>>,
  AgentTool<z.infer<typeof stopSchema>>,
  AgentTool<z.infer<typeof waitSchema>>,
] {
  return [
    {
      name: 'task_list',
      description:
        "List this Agent's background tasks (background bash commands and background Subagents) with their current status. Terminal results are delivered automatically; use task_output only for an explicit status check.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
      },
      concurrent: true,
      validate: (value) => listSchema.parse(value),
      execute: async (input) => {
        const tasks = options.store
          .listBackgroundTasks(
            options.source.ownerId,
            options.source.threadId,
            options.source.agentId,
            input.limit,
          )
          .map(taskJson);
        const subagents = options.store
          .listBackgroundSubagentInteractions(
            options.source.ownerId,
            options.source.threadId,
            options.source.agentId,
            input.limit,
          )
          .map((interaction) => ({
            task_id: interaction.sourceToolCallId,
            kind: 'subagent',
            description: interaction.prompt,
            status: interaction.status,
            created_at: interaction.createdAt,
            ended_at: interaction.finishedAt,
          }));
        const all = [...tasks, ...subagents]
          .sort((left, right) => right.created_at.localeCompare(left.created_at))
          .slice(0, input.limit);
        return JSON.stringify({ tasks: all });
      },
    },
    {
      name: 'task_output',
      description:
        'Read one background task now, or wait briefly only for an explicit status check. Use this only when the user requests status or cancellation, recovery, or reporting requires verification. Bash tasks return their status, terminal result and a bounded output preview; Subagent tasks return the interaction status and response. Automatic delivery makes routine reads, polling, and waits unnecessary; do not query again for an automatically delivered result, and do not use this tool to keep a Run alive.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['task_id'],
        properties: {
          task_id: { type: 'string', minLength: 1, maxLength: 200 },
          wait_ms: {
            type: 'integer',
            minimum: 1,
            maximum: 30000,
            description:
              'Optional bounded wait in milliseconds for a deliberate status check; omit for an immediate read. Do not use by default after creation or for repeated short polling. After a timeout, continue other work or finish the turn and rely on automatic delivery.',
          },
          output_bytes: { type: 'integer', minimum: 1, maximum: 16384, default: 4096 },
        },
      },
      concurrent: true,
      validate: (value) => outputSchema.parse(value),
      execute: async (input, { signal }) => {
        const task = findTask(options, input.task_id);
        if (task) {
          if (
            input.wait_ms !== undefined &&
            task.status === 'running' &&
            task.operationId !== null
          ) {
            await options.waitForBash(task.operationId, input.wait_ms, signal);
          }
          const current = options.store.getBackgroundTask(options.source.ownerId, input.task_id);
          const preview =
            current.operationId === null
              ? undefined
              : options.bash.snapshot(current.operationId, input.output_bytes);
          return JSON.stringify({
            ...taskJson(current),
            result: current.resultText,
            output_preview: preview?.content ?? null,
            timed_out: input.wait_ms !== undefined && current.status === 'running',
          });
        }
        const subagent = await options.subagent.read(input.task_id, input.wait_ms, signal);
        return JSON.stringify({ kind: 'subagent', ...subagent });
      },
    },
    {
      name: 'task_stop',
      description:
        'Request cancellation of one exact background task: a running bash command is cancelled in its environment, a background Subagent interaction is cancelled.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['task_id'],
        properties: { task_id: { type: 'string', minLength: 1, maxLength: 200 } },
      },
      concurrent: true,
      validate: (value) => stopSchema.parse(value),
      execute: async (input) => {
        const task = findTask(options, input.task_id);
        if (task) {
          if (task.status !== 'running') {
            return JSON.stringify({ task_id: task.taskId, status: task.status });
          }
          if (task.operationId !== null) {
            await options.bash.cancel(task.operationId, 'Cancellation requested by task_stop.');
          }
          const killed = options.store.markBackgroundTaskKilled(task.taskId);
          return JSON.stringify({ task_id: killed.taskId, status: killed.status });
        }
        const cancelled = await options.subagent.cancel(input.task_id);
        return JSON.stringify({ kind: 'subagent', ...cancelled });
      },
    },
    {
      name: 'task_wait',
      description:
        "Wait until one background task (task_id given) or any of this Agent's running background tasks reaches a terminal status, up to timeout_ms. A timeout is not an error: the result lists the tasks still running, and terminal results are delivered automatically regardless.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', minLength: 1, maxLength: 200 },
          timeout_ms: { type: 'integer', minimum: 1, maximum: 60000, default: 30000 },
        },
      },
      concurrent: true,
      validate: (value) => waitSchema.parse(value),
      execute: async (input, { signal }) => {
        const deadline = Date.now() + input.timeout_ms;
        const matches = (task: BackgroundTaskRecord) =>
          input.task_id === undefined || task.taskId === input.task_id;
        for (;;) {
          const running = options.store
            .listBackgroundTasks(
              options.source.ownerId,
              options.source.threadId,
              options.source.agentId,
              100,
            )
            .filter((task) => matches(task) && task.status === 'running');
          if (input.task_id !== undefined && running.length === 0) {
            const task = findTask(options, input.task_id);
            if (!task) {
              const subagent = await options.subagent.read(input.task_id, undefined, signal);
              return JSON.stringify({ kind: 'subagent', ...subagent });
            }
          }
          if (running.length === 0 || Date.now() >= deadline) {
            return JSON.stringify({
              timed_out: running.length > 0,
              running: running.map(taskJson),
            });
          }
          const first = running[0];
          if (first?.operationId != null) {
            await options.waitForBash(
              first.operationId,
              Math.min(1000, Math.max(deadline - Date.now(), 1)),
              signal,
            );
          } else {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
      },
    },
  ];
}

export function assertTaskToolsAllowed(source: RunRecord): void {
  if (source.agentId !== 'thread' && !source.agentId.startsWith('subagent-')) {
    throw new SessionError('permission_denied', 'Task tools require an Agent execution.');
  }
}

export { TERMINAL_TASK_STATUSES };
