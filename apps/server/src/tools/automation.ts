import type { AgentTool } from '@kairos/agent-core';
import { z } from 'zod';
import type { AutomationService } from '../automation/service.js';
import { automationHasMoreLimit } from '../automation/store.js';
import type {
  AutomationFireRecord,
  AutomationRecord,
  AutomationSchedule,
  AutomationTarget,
} from '../automation/types.js';
import { SessionError } from '../sessions/errors.js';
import type { RunRecord } from '../sessions/records.js';

const scheduleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cron'),
      expression: z.string().min(1).max(200),
      time_zone: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal('once'),
      run_at: z.iso.datetime({ offset: true }),
      time_zone: z.string().min(1).max(100),
    })
    .strict(),
]);
const targetSchema = z
  .object({
    kind: z.enum(['main', 'existing_thread', 'new_task', 'new_automation_only']),
    thread_id: z.string().min(1).max(200).optional(),
    allowed_env: z.array(z.string().min(1).max(200)).min(1).max(32).optional(),
  })
  .strict();
const createSchema = z
  .object({
    name: z.string().min(1).max(200),
    prompt: z.string().min(1).max(100_000),
    schedule: scheduleSchema,
    target: targetSchema,
    enabled: z.boolean().optional(),
  })
  .strict();
const updateSchema = z
  .object({
    schedule_id: z.string().min(1).max(200),
    expected_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    name: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).max(100_000).optional(),
    schedule: scheduleSchema.optional(),
    target: targetSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.name !== undefined ||
      input.prompt !== undefined ||
      input.schedule !== undefined ||
      input.target !== undefined ||
      input.enabled !== undefined,
    'At least one Automation field must be changed.',
  );
const listSchema = z
  .object({
    cursor: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER))
      .optional(),
    limit: z.number().int().positive().max(100).optional(),
  })
  .strict();
const readSchema = z
  .object({
    schedule_id: z.string().min(1).max(200),
    fire_limit: z.number().int().positive().max(50).optional(),
  })
  .strict();
const deleteSchema = z
  .object({
    schedule_id: z.string().min(1).max(200),
    expected_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const runNowSchema = z.object({ schedule_id: z.string().min(1).max(200) }).strict();

export interface AutomationToolOptions {
  automations: AutomationService;
  source: RunRecord;
  resolveEnvironmentIds?: (envIds: readonly string[]) => string[];
  projectEnvironmentIds?: (envIds: readonly string[]) => string[];
}

const scheduleParameters = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'expression', 'time_zone'],
      properties: {
        kind: { const: 'cron' },
        expression: { type: 'string', minLength: 1, maxLength: 200 },
        time_zone: { type: 'string', minLength: 1, maxLength: 100 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'run_at', 'time_zone'],
      properties: {
        kind: { const: 'once' },
        run_at: { type: 'string', format: 'date-time' },
        time_zone: { type: 'string', minLength: 1, maxLength: 100 },
      },
    },
  ],
};
const targetParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: {
      type: 'string',
      enum: ['main', 'existing_thread', 'new_task', 'new_automation_only'],
    },
    thread_id: { type: 'string', minLength: 1, maxLength: 200 },
    allowed_env: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 200 },
      minItems: 1,
      maxItems: 32,
    },
  },
};

export function createAutomationTools(
  options: AutomationToolOptions,
): [
  AgentTool<z.infer<typeof createSchema>>,
  AgentTool<z.infer<typeof listSchema>>,
  AgentTool<z.infer<typeof readSchema>>,
  AgentTool<z.infer<typeof updateSchema>>,
  AgentTool<z.infer<typeof deleteSchema>>,
  AgentTool<z.infer<typeof runNowSchema>>,
] {
  let created = 0;
  return [
    {
      name: 'automation_create',
      description:
        'Create a persistent Automation from the main conversation. Use a five-field cron with an explicit IANA time_zone, or once with an offset-bearing run_at. Targets are main, existing_thread, new_task or new_automation_only. New Threads use the main environment by default; allowed_env narrows environment access. automation_only Threads are persistent but hidden from ordinary Thread lists and readable through Automation history. Scheduled triggers and run_now execute the configured prompt as Automation input, not as a new human instruction.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'prompt', 'schedule', 'target'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          prompt: { type: 'string', minLength: 1, maxLength: 100_000 },
          schedule: scheduleParameters,
          target: targetParameters,
          enabled: { type: 'boolean' },
        },
      },
      concurrent: true,
      validate: (value) => createSchema.parse(value),
      execute: async (input, { call }) => {
        assertMainSource(options.source, options.automations);
        if (created >= 10) {
          throw new SessionError(
            'failed_precondition',
            'One Run can create at most ten Automations.',
          );
        }
        created += 1;
        return jsonResult({
          automation: automationResult(
            options.automations.create({
              ownerId: options.source.ownerId,
              clientActionId: call.id,
              name: input.name,
              prompt: input.prompt,
              schedule: readSchedule(input.schedule),
              target: readTarget(input.target, options.resolveEnvironmentIds),
              ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            }),
            options.projectEnvironmentIds,
          ),
        });
      },
    },
    {
      name: 'automation_list',
      description: 'List persistent Automations in the current tenant with bounded pagination.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cursor: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
      concurrent: true,
      validate: (value) => listSchema.parse(value),
      execute: async (input) => {
        assertMainSource(options.source, options.automations);
        const limit = input.limit ?? 50;
        const records = options.automations.store.listAutomations(
          options.source.ownerId,
          BigInt(input.cursor ?? '0'),
          automationHasMoreLimit(limit),
        );
        const page = records.slice(0, limit);
        return jsonResult({
          automations: page.map((automation) =>
            automationResult(automation, options.projectEnvironmentIds),
          ),
          ...(records.length > limit && page.length > 0
            ? { next_cursor: String(page.at(-1)?.seq ?? 0) }
            : {}),
        });
      },
    },
    {
      name: 'automation_read',
      description: 'Read one Automation and its bounded chronological fire history.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['schedule_id'],
        properties: {
          schedule_id: { type: 'string', minLength: 1, maxLength: 200 },
          fire_limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
      concurrent: true,
      validate: (value) => readSchema.parse(value),
      execute: async (input) => {
        assertMainSource(options.source, options.automations);
        const limit = input.fire_limit ?? 20;
        const fires = options.automations.store.listFires(
          options.source.ownerId,
          input.schedule_id,
          0n,
          automationHasMoreLimit(limit),
        );
        return jsonResult({
          automation: automationResult(
            options.automations.store.getAutomation(options.source.ownerId, input.schedule_id),
            options.projectEnvironmentIds,
          ),
          fires: fires.slice(0, limit).map(fireResult),
          ...(fires.length > limit ? { next_fire_cursor: String(fires[limit - 1]?.seq ?? 0) } : {}),
        });
      },
    },
    {
      name: 'automation_update',
      description:
        'Update an Automation using its current version. Changing the schedule resets its cursor to the update time for cron. Enabling a disabled Automation skips the disabled interval. Existing fire prompts and targets remain unchanged.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['schedule_id', 'expected_version'],
        properties: {
          schedule_id: { type: 'string', minLength: 1, maxLength: 200 },
          expected_version: { type: 'integer', minimum: 1 },
          name: { type: 'string', minLength: 1, maxLength: 200 },
          prompt: { type: 'string', minLength: 1, maxLength: 100_000 },
          schedule: scheduleParameters,
          target: targetParameters,
          enabled: { type: 'boolean' },
        },
      },
      concurrent: true,
      validate: (value) => updateSchema.parse(value),
      execute: async (input, { call }) => {
        assertMainSource(options.source, options.automations);
        return jsonResult({
          automation: automationResult(
            options.automations.update({
              ownerId: options.source.ownerId,
              clientActionId: call.id,
              scheduleId: input.schedule_id,
              expectedVersion: BigInt(input.expected_version),
              ...(input.name === undefined ? {} : { name: input.name }),
              ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
              ...(input.schedule === undefined ? {} : { schedule: readSchedule(input.schedule) }),
              ...(input.target === undefined
                ? {}
                : { target: readTarget(input.target, options.resolveEnvironmentIds) }),
              ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            }),
            options.projectEnvironmentIds,
          ),
        });
      },
    },
    {
      name: 'automation_delete',
      description:
        'Disable and delete an Automation from management lists using its current version. Existing Thread and fire audit records are retained.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['schedule_id', 'expected_version'],
        properties: {
          schedule_id: { type: 'string', minLength: 1, maxLength: 200 },
          expected_version: { type: 'integer', minimum: 1 },
        },
      },
      concurrent: true,
      validate: (value) => deleteSchema.parse(value),
      execute: async (input, { call }) => {
        assertMainSource(options.source, options.automations);
        return jsonResult(
          options.automations.delete({
            ownerId: options.source.ownerId,
            clientActionId: call.id,
            scheduleId: input.schedule_id,
            expectedVersion: BigInt(input.expected_version),
          }),
        );
      },
    },
    {
      name: 'automation_run_now',
      description:
        'Queue one immediate fire of an enabled or disabled Automation without changing its schedule cursor. The returned queued or running status is acceptance, not completion. Only one fire per Automation can be active at a time.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['schedule_id'],
        properties: { schedule_id: { type: 'string', minLength: 1, maxLength: 200 } },
      },
      concurrent: true,
      validate: (value) => runNowSchema.parse(value),
      execute: async (input, { call }) => {
        assertMainSource(options.source, options.automations);
        const fire = await options.automations.runNow({
          ownerId: options.source.ownerId,
          clientActionId: call.id,
          scheduleId: input.schedule_id,
        });
        return jsonResult({ fire: fireResult(fire) });
      },
    },
  ];
}

function readSchedule(input: z.infer<typeof scheduleSchema>): AutomationSchedule {
  return input.kind === 'cron'
    ? { kind: 'cron', expression: input.expression, timeZone: input.time_zone }
    : { kind: 'once', runAt: input.run_at, timeZone: input.time_zone };
}

function readTarget(
  input: z.infer<typeof targetSchema>,
  resolveEnvironmentIds?: (envIds: readonly string[]) => string[],
): AutomationTarget {
  return {
    kind: input.kind,
    ...(input.thread_id === undefined ? {} : { threadId: input.thread_id }),
    ...(input.allowed_env === undefined
      ? {}
      : {
          environmentPolicy: {
            allowedEnv: resolveEnvironmentIds?.(input.allowed_env) ?? [...input.allowed_env],
          },
        }),
  };
}

function automationResult(
  automation: AutomationRecord,
  projectEnvironmentIds?: (envIds: readonly string[]) => string[],
) {
  const target = automation.target.environmentPolicy
    ? {
        ...automation.target,
        environmentPolicy: {
          allowedEnv: projectEnvironmentIds?.(automation.target.environmentPolicy.allowedEnv) ?? [
            ...automation.target.environmentPolicy.allowedEnv,
          ],
        },
      }
    : automation.target;
  return {
    schedule_id: automation.scheduleId,
    name: automation.name,
    prompt: automation.prompt,
    schedule:
      automation.schedule.kind === 'cron'
        ? {
            kind: 'cron',
            expression: automation.schedule.expression,
            time_zone: automation.schedule.timeZone,
          }
        : {
            kind: 'once',
            run_at: automation.schedule.runAt,
            time_zone: automation.schedule.timeZone,
          },
    target,
    enabled: automation.enabled,
    version: automation.version,
    next_fire_at: automation.nextFireAt,
    created_at: automation.createdAt,
    updated_at: automation.updatedAt,
  };
}

function fireResult(fire: AutomationFireRecord) {
  return {
    fire_id: fire.fireId,
    schedule_id: fire.scheduleId,
    trigger: fire.trigger,
    schedule_version: fire.scheduleVersion,
    scheduled_at: fire.scheduledAt,
    actual_at: fire.actualAt,
    coalesced_count: fire.coalescedCount,
    prompt: fire.prompt,
    target_kind: fire.targetKind,
    target_thread_id: fire.targetThreadId,
    input_id: fire.inputId,
    accepted_run_id: fire.acceptedRunId,
    consumed_run_id: fire.consumedRunId,
    status: fire.status,
    error: fire.error,
    finished_at: fire.finishedAt,
  };
}

function assertMainSource(source: RunRecord, automations: AutomationService): void {
  if (source.agentId !== 'thread' || source.parentRunId !== null) {
    throw new SessionError(
      'permission_denied',
      'Automation management requires the main Thread root Agent.',
    );
  }
  const thread = automations.getThread(source.ownerId, source.threadId);
  if (thread.threadType !== 'main') {
    throw new SessionError(
      'permission_denied',
      'Task Threads and automation_only Threads cannot manage Automations.',
    );
  }
}

function jsonResult(value: unknown): { content: string } {
  return { content: JSON.stringify(value) };
}
