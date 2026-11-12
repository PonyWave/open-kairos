import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';
import {
  AutomationFireStatus,
  AutomationScheduleKind,
  AutomationService,
  AutomationTargetKind,
  AutomationTrigger,
  create,
  GetAutomationThreadResponseSchema,
  GetThreadRequestSchema,
  validateEnvironmentPolicy,
} from '@kairos/contracts';
import type { AutomationService as AutomationManager } from '../automation/service.js';
import { automationHasMoreLimit } from '../automation/store.js';
import type {
  AutomationFireRecord,
  AutomationRecord,
  AutomationSchedule,
  AutomationTarget,
} from '../automation/types.js';
import { requirePositiveInteger, requireText, SessionError } from '../sessions/errors.js';
import type { SessionStore } from '../sessions/store.js';
import type { GuiAuthentication } from './auth.js';
import { requireOwner } from './auth.js';
import { timestamp, toErrorDetail } from './convert.js';
import { asConnectError } from './errors.js';
import { getThreadSnapshot, type ThreadSnapshotPageOptions } from './snapshot.js';

export interface AutomationApiOptions {
  automations: AutomationManager;
  store: SessionStore;
  authentication: GuiAuthentication;
  snapshot?: Omit<ThreadSnapshotPageOptions, 'allowAutomationOnly'> | undefined;
}

function readTimestamp(value: { seconds: bigint; nanos: number } | undefined, field: string) {
  if (
    !value ||
    !Number.isInteger(value.nanos) ||
    value.nanos < 0 ||
    value.nanos > 999_999_999 ||
    value.nanos % 1_000_000 !== 0
  ) {
    throw new SessionError('invalid_argument', `${field} must be a millisecond timestamp.`);
  }
  const milliseconds = value.seconds * 1000n + BigInt(value.nanos / 1_000_000);
  if (
    milliseconds > BigInt(Number.MAX_SAFE_INTEGER) ||
    milliseconds < -BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new SessionError('invalid_argument', `${field} is outside the supported range.`);
  }
  return new Date(Number(milliseconds)).toISOString();
}

function readSchedule(request: unknown) {
  if (typeof request !== 'object' || request === null) {
    throw new SessionError('invalid_argument', 'Automation schedule is required.');
  }
  const value = request as {
    kind: AutomationScheduleKind;
    cronExpression?: string | undefined;
    timeZone: string;
    runAt?: { seconds: bigint; nanos: number } | undefined;
  };
  if (value.kind === AutomationScheduleKind.CRON) {
    if (value.cronExpression === undefined || value.runAt !== undefined) {
      throw new SessionError(
        'invalid_argument',
        'A cron Automation requires only cron_expression.',
      );
    }
    return {
      kind: 'cron',
      expression: value.cronExpression,
      timeZone: requireText(value.timeZone, 'schedule.time_zone', 100),
    } satisfies AutomationSchedule;
  }
  if (value.kind === AutomationScheduleKind.ONCE) {
    if (value.cronExpression !== undefined || value.runAt === undefined) {
      throw new SessionError('invalid_argument', 'A one-time Automation requires only run_at.');
    }
    return {
      kind: 'once',
      runAt: readTimestamp(value.runAt, 'schedule.run_at'),
      timeZone: requireText(value.timeZone, 'schedule.time_zone', 100),
    } satisfies AutomationSchedule;
  }
  throw new SessionError('invalid_argument', 'Automation schedule kind is not supported.');
}

function readTarget(request: unknown): AutomationTarget {
  if (typeof request !== 'object' || request === null) {
    throw new SessionError('invalid_argument', 'Automation target is required.');
  }
  const value = request as {
    kind: AutomationTargetKind;
    threadId?: string | undefined;
    environmentPolicy?: Parameters<typeof validateEnvironmentPolicy>[0] | undefined;
  };
  const environmentPolicy = value.environmentPolicy
    ? {
        allowedEnv: (() => {
          if (value.environmentPolicy?.policyVersion !== 1n) {
            throw new SessionError(
              'invalid_argument',
              'environment_policy.policy_version must be 1.',
            );
          }
          validateEnvironmentPolicy(value.environmentPolicy);
          return [...value.environmentPolicy.allowedEnv];
        })(),
      }
    : undefined;
  if (value.kind === AutomationTargetKind.MAIN) {
    return { kind: 'main', ...(environmentPolicy ? { environmentPolicy } : {}) };
  }
  if (value.kind === AutomationTargetKind.EXISTING_THREAD) {
    return {
      kind: 'existing_thread',
      threadId: requireText(value.threadId ?? '', 'target.thread_id', 200),
      ...(environmentPolicy ? { environmentPolicy } : {}),
    };
  }
  if (value.kind === AutomationTargetKind.NEW_TASK) {
    return {
      kind: 'new_task',
      ...(value.threadId === undefined ? {} : { threadId: value.threadId }),
      ...(environmentPolicy ? { environmentPolicy } : {}),
    };
  }
  if (value.kind === AutomationTargetKind.NEW_AUTOMATION_ONLY) {
    return {
      kind: 'new_automation_only',
      ...(value.threadId === undefined ? {} : { threadId: value.threadId }),
      ...(environmentPolicy ? { environmentPolicy } : {}),
    };
  }
  throw new SessionError('invalid_argument', 'Automation target kind is not supported.');
}

function toSchedule(schedule: AutomationSchedule) {
  return {
    kind: schedule.kind === 'cron' ? AutomationScheduleKind.CRON : AutomationScheduleKind.ONCE,
    ...(schedule.kind === 'cron' ? { cronExpression: schedule.expression } : {}),
    timeZone: schedule.timeZone,
    ...(schedule.kind === 'once' ? { runAt: timestamp(schedule.runAt) } : {}),
  };
}

function toTargetKind(kind: AutomationTarget['kind']): AutomationTargetKind {
  switch (kind) {
    case 'main':
      return AutomationTargetKind.MAIN;
    case 'existing_thread':
      return AutomationTargetKind.EXISTING_THREAD;
    case 'new_task':
      return AutomationTargetKind.NEW_TASK;
    case 'new_automation_only':
      return AutomationTargetKind.NEW_AUTOMATION_ONLY;
  }
}

function toTarget(target: AutomationTarget) {
  return {
    kind: toTargetKind(target.kind),
    ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
    ...(target.environmentPolicy
      ? {
          environmentPolicy: {
            allowedEnv: [...target.environmentPolicy.allowedEnv],
            policyVersion: 1n,
          },
        }
      : {}),
  };
}

export function toAutomation(automation: AutomationRecord) {
  return {
    seq: BigInt(automation.seq),
    scheduleId: automation.scheduleId,
    name: automation.name,
    prompt: automation.prompt,
    schedule: toSchedule(automation.schedule),
    target: toTarget(automation.target),
    enabled: automation.enabled,
    version: BigInt(automation.version),
    ...(automation.nextFireAt === null ? {} : { nextFireAt: timestamp(automation.nextFireAt) }),
    createdAt: timestamp(automation.createdAt),
    updatedAt: timestamp(automation.updatedAt),
  };
}

function toFireStatus(status: AutomationFireRecord['status']): AutomationFireStatus {
  switch (status) {
    case 'queued':
      return AutomationFireStatus.QUEUED;
    case 'running':
      return AutomationFireStatus.RUNNING;
    case 'completed':
      return AutomationFireStatus.COMPLETED;
    case 'failed':
      return AutomationFireStatus.FAILED;
    case 'cancelled':
      return AutomationFireStatus.CANCELLED;
    case 'interrupted':
      return AutomationFireStatus.INTERRUPTED;
  }
}

export function toAutomationFire(fire: AutomationFireRecord) {
  return {
    seq: BigInt(fire.seq),
    fireId: fire.fireId,
    scheduleId: fire.scheduleId,
    trigger: fire.trigger === 'run_now' ? AutomationTrigger.RUN_NOW : AutomationTrigger.SCHEDULED,
    scheduleVersion: BigInt(fire.scheduleVersion),
    scheduledAt: timestamp(fire.scheduledAt),
    actualAt: timestamp(fire.actualAt),
    coalescedCount: fire.coalescedCount,
    prompt: fire.prompt,
    targetKind: toTargetKind(fire.targetKind),
    ...(fire.targetThreadId === null ? {} : { targetThreadId: fire.targetThreadId }),
    ...(fire.inputId === null ? {} : { inputId: fire.inputId }),
    ...(fire.acceptedRunId === null ? {} : { acceptedRunId: fire.acceptedRunId }),
    ...(fire.consumedRunId === null ? {} : { consumedRunId: fire.consumedRunId }),
    status: toFireStatus(fire.status),
    ...(fire.error ? { error: toErrorDetail(fire.error) } : {}),
    createdAt: timestamp(fire.createdAt),
    updatedAt: timestamp(fire.updatedAt),
    ...(fire.finishedAt === null ? {} : { finishedAt: timestamp(fire.finishedAt) }),
  };
}

export function registerAutomationRoutes(
  router: ConnectRouter,
  options: AutomationApiOptions,
): void {
  const owner = (context: HandlerContext) => requireOwner(context, options.authentication);
  const handle = async <T>(
    clientActionId: string | undefined,
    work: () => T | Promise<T>,
  ): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw asConnectError(error, clientActionId);
    }
  };

  router.service(AutomationService, {
    createAutomation: (request, context) =>
      handle(request.clientActionId, () => {
        const ownerId = owner(context);
        requireText(request.clientActionId, 'clientActionId', 200);
        const automation = options.automations.create({
          ownerId,
          clientActionId: request.clientActionId,
          name: request.name,
          prompt: request.prompt,
          schedule: readSchedule(request.schedule),
          target: readTarget(request.target),
          ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
        });
        return { clientActionId: request.clientActionId, automation: toAutomation(automation) };
      }),
    getAutomation: (request, context) =>
      handle(undefined, () => ({
        automation: toAutomation(
          options.automations.store.getAutomation(
            owner(context),
            requireText(request.scheduleId, 'scheduleId', 200),
          ),
        ),
      })),
    listAutomations: (request, context) =>
      handle(undefined, () => {
        const ownerId = owner(context);
        const limit = requirePositiveInteger(request.limit, 'limit', 100);
        const records = options.automations.store.listAutomations(
          ownerId,
          request.afterSeq,
          automationHasMoreLimit(limit),
        );
        const hasMore = records.length > limit;
        const page = records.slice(0, limit);
        return {
          automations: page.map(toAutomation),
          ...(hasMore && page.length > 0 ? { nextSeq: BigInt(page.at(-1)?.seq ?? 0) } : {}),
          hasMore,
        };
      }),
    updateAutomation: (request, context) =>
      handle(request.clientActionId, () => {
        const ownerId = owner(context);
        const automation = options.automations.update({
          ownerId,
          clientActionId: requireText(request.clientActionId, 'clientActionId', 200),
          scheduleId: requireText(request.scheduleId, 'scheduleId', 200),
          expectedVersion: request.expectedVersion,
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
          ...(request.schedule === undefined ? {} : { schedule: readSchedule(request.schedule) }),
          ...(request.target === undefined ? {} : { target: readTarget(request.target) }),
          ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
        });
        return { clientActionId: request.clientActionId, automation: toAutomation(automation) };
      }),
    deleteAutomation: (request, context) =>
      handle(request.clientActionId, () => {
        const result = options.automations.delete({
          ownerId: owner(context),
          clientActionId: requireText(request.clientActionId, 'clientActionId', 200),
          scheduleId: requireText(request.scheduleId, 'scheduleId', 200),
          expectedVersion: request.expectedVersion,
        });
        return { clientActionId: request.clientActionId, ...result };
      }),
    runAutomationNow: (request, context) =>
      handle(request.clientActionId, async () => {
        const ownerId = owner(context);
        const fire = await options.automations.runNow({
          ownerId,
          clientActionId: requireText(request.clientActionId, 'clientActionId', 200),
          scheduleId: requireText(request.scheduleId, 'scheduleId', 200),
        });
        return {
          clientActionId: request.clientActionId,
          fire: {
            ...toAutomationFire(fire),
            ...(fire.targetThreadId === null
              ? {}
              : {
                  targetThreadTitle: options.store.getThread(ownerId, fire.targetThreadId).title,
                }),
          },
        };
      }),
    listAutomationFires: (request, context) =>
      handle(undefined, () => {
        const ownerId = owner(context);
        const scheduleId = requireText(request.scheduleId, 'scheduleId', 200);
        const limit = requirePositiveInteger(request.limit, 'limit', 100);
        const records = options.automations.store.listFires(
          ownerId,
          scheduleId,
          request.afterSeq,
          automationHasMoreLimit(limit),
        );
        const hasMore = records.length > limit;
        const page = records.slice(0, limit);
        return {
          fires: page.map((fire) => ({
            ...toAutomationFire(fire),
            ...(fire.targetThreadId === null
              ? {}
              : { targetThreadTitle: options.store.getThread(ownerId, fire.targetThreadId).title }),
          })),
          ...(hasMore && page.length > 0 ? { nextSeq: BigInt(page.at(-1)?.seq ?? 0) } : {}),
          hasMore,
        };
      }),
    getAutomationThread: (request, context) =>
      handle(undefined, () => {
        const ownerId = owner(context);
        const scheduleId = requireText(request.scheduleId, 'scheduleId', 200);
        const threadId = requireText(request.threadId, 'threadId', 200);
        options.automations.store.requireAutomationThread(ownerId, scheduleId, threadId);
        const snapshot = getThreadSnapshot(
          options.store,
          ownerId,
          create(GetThreadRequestSchema, {
            threadId,
            ...(request.limit === undefined ? {} : { limit: request.limit }),
            ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          }),
          { ...options.snapshot, allowAutomationOnly: true },
        );
        return create(GetAutomationThreadResponseSchema, {
          ...(snapshot.snapshot === undefined ? {} : { snapshot: snapshot.snapshot }),
          throughSeq: snapshot.throughSeq,
          ...(snapshot.nextCursor === undefined ? {} : { nextCursor: snapshot.nextCursor }),
          hasMore: snapshot.hasMore,
        });
      }),
  });
}
