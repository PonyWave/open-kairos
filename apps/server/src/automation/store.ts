import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AutomationReference } from '../context/types.js';
import { requirePositiveInteger, requireText, SessionError } from '../sessions/errors.js';
import type { RunError, RunStatus } from '../sessions/records.js';
import type { SessionStore } from '../sessions/store.js';
import { countOccurrences, nextOccurrence, normalizeSchedule, previousOccurrence } from './cron.js';
import type {
  AutomationFireRecord,
  AutomationFireStatus,
  AutomationRecord,
  AutomationSchedule,
  AutomationTarget,
  AutomationTrigger,
  CreateAutomationInput,
  UpdateAutomationInput,
} from './types.js';

const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cron'), expression: z.string(), timeZone: z.string() }),
  z.object({ kind: z.literal('once'), runAt: z.string(), timeZone: z.string() }),
]);
const targetSchema = z.object({
  kind: z.enum(['main', 'existing_thread', 'new_task', 'new_automation_only']),
  threadId: z.string().optional(),
  environmentPolicy: z.object({ allowedEnv: z.array(z.string()).readonly() }).optional(),
  workspaceId: z.string().optional(),
});
const runErrorSchema = z.object({
  code: z.enum([
    'unauthenticated',
    'permission_denied',
    'version_conflict',
    'action_conflict',
    'sandbox_capacity_exhausted',
    'sandbox_unavailable',
    'device_offline',
    'operation_unknown',
    'recap_invalid',
    'input_too_large',
    'protocol_incompatible',
    'invalid_argument',
    'not_found',
    'failed_precondition',
    'internal',
  ]),
  message: z.string(),
  retryable: z.boolean(),
});
const automationResponseSchema = z.object({
  seq: z.number().int().positive(),
  scheduleId: z.string(),
  ownerId: z.string(),
  name: z.string(),
  prompt: z.string(),
  schedule: scheduleSchema,
  target: targetSchema,
  enabled: z.boolean(),
  version: z.number().int().positive(),
  cursorAt: z.string().nullable(),
  nextFireAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
const fireResponseSchema = z.object({
  seq: z.number().int().positive(),
  fireId: z.string(),
  scheduleId: z.string(),
  ownerId: z.string(),
  trigger: z.enum(['scheduled', 'run_now']),
  scheduleVersion: z.number().int().positive(),
  scheduledAt: z.string(),
  actualAt: z.string(),
  coalescedCount: z.number().int().nonnegative(),
  prompt: z.string(),
  targetKind: z.enum(['main', 'existing_thread', 'new_task', 'new_automation_only']),
  targetThreadId: z.string().nullable(),
  inputId: z.string().nullable(),
  acceptedRunId: z.string().nullable(),
  consumedRunId: z.string().nullable(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
  error: runErrorSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});
const deleteResponseSchema = z.object({ scheduleId: z.string(), deleted: z.literal(true) });

const automationRowSchema = z.object({
  seq: z.number().int().positive(),
  schedule_id: z.string(),
  owner_id: z.string(),
  name: z.string(),
  prompt: z.string(),
  schedule_kind: z.enum(['cron', 'once']),
  cron_expression: z.string().nullable(),
  time_zone: z.string(),
  run_at: z.string().nullable(),
  target_kind: z.enum(['main', 'existing_thread', 'new_task', 'new_automation_only']),
  target_thread_id: z.string().nullable(),
  workspace_id: z.string().nullable(),
  environment_policy_json: z.string().nullable(),
  enabled: z.number().int().min(0).max(1),
  version: z.number().int().positive(),
  cursor_at: z.string().nullable(),
  next_fire_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});
const fireRowSchema = z.object({
  seq: z.number().int().positive(),
  fire_id: z.string(),
  schedule_id: z.string(),
  owner_id: z.string(),
  trigger_source: z.enum(['scheduled', 'run_now']),
  schedule_version: z.number().int().positive(),
  scheduled_at: z.string(),
  actual_at: z.string(),
  coalesced_count: z.number().int().nonnegative(),
  prompt: z.string(),
  target_kind: z.enum(['main', 'existing_thread', 'new_task', 'new_automation_only']),
  target_thread_id: z.string().nullable(),
  input_id: z.string().nullable(),
  accepted_run_id: z.string().nullable(),
  consumed_run_id: z.string().nullable(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
  error_code: runErrorSchema.shape.code.nullable(),
  error_message: z.string().nullable(),
  error_retryable: z.number().int().min(0).max(1).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable(),
});

export interface AutomationStoreOptions {
  clock?: () => Date;
  createId?: () => string;
}

export const automationPageLimit = 100;

export function automationHasMoreLimit(limit: number): number {
  requirePositiveInteger(limit, 'limit', automationPageLimit);
  return Math.min(limit + 1, automationPageLimit + 1);
}

export class AutomationStore {
  readonly #sessions: SessionStore;
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(sessions: SessionStore, options: AutomationStoreOptions = {}) {
    this.#sessions = sessions;
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  create(input: CreateAutomationInput): AutomationRecord {
    const name = requireText(input.name, 'name', 200);
    const prompt = requireText(input.prompt, 'prompt', 100_000, { maximumBytes: 100_000 });
    const schedule = normalizeSchedule(input.schedule);
    const target = this.#normalizeTarget(input.ownerId, input.target);
    return this.#sessions.runAction(
      {
        ownerId: input.ownerId,
        clientActionId: input.clientActionId,
        method: 'CreateAutomation',
        parameters: { name, prompt, schedule, target, enabled: input.enabled ?? true },
      },
      automationResponseSchema,
      () => {
        const now = this.#now();
        const enabled = input.enabled ?? true;
        if (schedule.kind === 'cron' && nextOccurrence(schedule, now) === null) {
          throw new SessionError(
            'invalid_argument',
            'The cron schedule has no future occurrence within the supported range.',
          );
        }
        const scheduleId = this.#createId();
        const cursorAt = schedule.kind === 'cron' ? now : null;
        const nextFireAt = enabled
          ? schedule.kind === 'once'
            ? schedule.runAt
            : nextOccurrence(schedule, now)
          : null;
        this.#sessions.database
          .prepare(
            `INSERT INTO automations(
              schedule_id, owner_id, name, prompt, schedule_kind, cron_expression, time_zone,
              run_at, target_kind, target_thread_id, workspace_id, environment_policy_json, enabled, version,
              cursor_at, next_fire_at, created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)`,
          )
          .run(
            scheduleId,
            input.ownerId,
            name,
            prompt,
            schedule.kind,
            schedule.kind === 'cron' ? schedule.expression : null,
            schedule.timeZone,
            schedule.kind === 'once' ? schedule.runAt : null,
            target.kind,
            target.threadId ?? null,
            target.workspaceId ?? null,
            target.environmentPolicy ? JSON.stringify(target.environmentPolicy) : null,
            enabled ? 1 : 0,
            cursorAt,
            nextFireAt,
            now,
            now,
          );
        return this.getAutomation(input.ownerId, scheduleId);
      },
    );
  }

  getAutomation(ownerId: string, scheduleId: string, includeDeleted = false): AutomationRecord {
    requireText(ownerId, 'ownerId', 200);
    requireText(scheduleId, 'scheduleId', 200);
    const automation = this.#automation(scheduleId);
    if (automation.ownerId !== ownerId || (!includeDeleted && automation.deletedAt !== null)) {
      throw new SessionError('permission_denied', 'Automation is not available to this owner.');
    }
    return automation;
  }

  listAutomations(ownerId: string, afterSeq: bigint, limit: number): AutomationRecord[] {
    requirePositiveInteger(limit, 'limit', automationPageLimit + 1);
    if (afterSeq < 0n || afterSeq > BigInt(Number.MAX_SAFE_INTEGER)) return [];
    return this.#sessions.database
      .prepare(
        `SELECT * FROM automations
         WHERE owner_id = ? AND deleted_at IS NULL AND seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(ownerId, Number(afterSeq), limit)
      .map((row) => this.#toAutomation(automationRowSchema.parse(row)));
  }

  update(input: UpdateAutomationInput): AutomationRecord {
    if (!Number.isSafeInteger(Number(input.expectedVersion)) || input.expectedVersion <= 0n) {
      throw new SessionError('invalid_argument', 'expected_version must be a positive integer.');
    }
    if (
      input.name === undefined &&
      input.prompt === undefined &&
      input.schedule === undefined &&
      input.target === undefined &&
      input.enabled === undefined
    ) {
      throw new SessionError('invalid_argument', 'An Automation update must change one field.');
    }
    return this.#sessions.runAction(
      {
        ownerId: input.ownerId,
        clientActionId: input.clientActionId,
        method: 'UpdateAutomation',
        parameters: {
          scheduleId: input.scheduleId,
          expectedVersion: input.expectedVersion.toString(),
          name: input.name,
          prompt: input.prompt,
          schedule: input.schedule,
          target: input.target,
          enabled: input.enabled,
        },
      },
      automationResponseSchema,
      () => {
        const current = this.getAutomation(input.ownerId, input.scheduleId);
        if (BigInt(current.version) !== input.expectedVersion) {
          throw new SessionError('version_conflict', 'Automation was modified by another action.');
        }
        const now = this.#now();
        const name = input.name === undefined ? current.name : requireText(input.name, 'name', 200);
        const prompt =
          input.prompt === undefined
            ? current.prompt
            : requireText(input.prompt, 'prompt', 100_000, { maximumBytes: 100_000 });
        const schedule = input.schedule ? normalizeSchedule(input.schedule) : current.schedule;
        const target = input.target
          ? this.#normalizeTarget(input.ownerId, input.target)
          : current.target;
        const enabled = input.enabled ?? current.enabled;
        if (enabled && schedule.kind === 'cron' && nextOccurrence(schedule, now) === null) {
          throw new SessionError(
            'invalid_argument',
            'The cron schedule has no future occurrence within the supported range.',
          );
        }
        const scheduleChanged = JSON.stringify(schedule) !== JSON.stringify(current.schedule);
        let cursorAt = current.cursorAt;
        let nextFireAt = current.nextFireAt;
        if (input.enabled === false) {
          nextFireAt = null;
        } else if (input.enabled === true && !current.enabled) {
          cursorAt = schedule.kind === 'cron' ? now : current.cursorAt;
          nextFireAt = nextOccurrence(schedule, now);
        } else if (scheduleChanged) {
          cursorAt = schedule.kind === 'cron' ? now : null;
          nextFireAt = enabled
            ? schedule.kind === 'once'
              ? schedule.runAt
              : nextOccurrence(schedule, now)
            : null;
        }
        this.#sessions.database
          .prepare(
            `UPDATE automations SET name = ?, prompt = ?, schedule_kind = ?, cron_expression = ?,
             time_zone = ?, run_at = ?, target_kind = ?, target_thread_id = ?,
             environment_policy_json = ?, enabled = ?, version = version + 1, cursor_at = ?,
             next_fire_at = ?, updated_at = ? WHERE schedule_id = ? AND version = ?`,
          )
          .run(
            name,
            prompt,
            schedule.kind,
            schedule.kind === 'cron' ? schedule.expression : null,
            schedule.timeZone,
            schedule.kind === 'once' ? schedule.runAt : null,
            target.kind,
            target.threadId ?? null,
            target.environmentPolicy ? JSON.stringify(target.environmentPolicy) : null,
            enabled ? 1 : 0,
            cursorAt,
            nextFireAt,
            now,
            current.scheduleId,
            current.version,
          );
        return this.getAutomation(input.ownerId, input.scheduleId);
      },
    );
  }

  delete(input: {
    ownerId: string;
    clientActionId: string;
    scheduleId: string;
    expectedVersion: bigint;
  }): { scheduleId: string; deleted: true } {
    return this.#sessions.runAction(
      {
        ownerId: input.ownerId,
        clientActionId: input.clientActionId,
        method: 'DeleteAutomation',
        parameters: {
          scheduleId: input.scheduleId,
          expectedVersion: input.expectedVersion.toString(),
        },
      },
      deleteResponseSchema,
      () => {
        const current = this.getAutomation(input.ownerId, input.scheduleId);
        if (BigInt(current.version) !== input.expectedVersion) {
          throw new SessionError('version_conflict', 'Automation was modified by another action.');
        }
        const now = this.#now();
        this.#sessions.database
          .prepare(
            `UPDATE automations SET enabled = 0, next_fire_at = NULL, deleted_at = ?,
             version = version + 1, updated_at = ? WHERE schedule_id = ?`,
          )
          .run(now, now, current.scheduleId);
        return { scheduleId: current.scheduleId, deleted: true as const };
      },
    );
  }

  runNow(input: {
    ownerId: string;
    clientActionId: string;
    scheduleId: string;
  }): AutomationFireRecord {
    return this.#sessions.runAction(
      {
        ownerId: input.ownerId,
        clientActionId: input.clientActionId,
        method: 'RunAutomationNow',
        parameters: { scheduleId: input.scheduleId },
      },
      fireResponseSchema,
      () => {
        const automation = this.getAutomation(input.ownerId, input.scheduleId);
        return this.#sessions.transaction(() =>
          this.#acceptFire(automation, 'run_now', this.#now(), 0),
        );
      },
    );
  }

  acceptScheduled(scheduleId: string): AutomationFireRecord | null {
    return this.#sessions.transaction(() => {
      const automation = this.#automation(scheduleId);
      const now = this.#now();
      if (!automation.enabled || automation.deletedAt !== null || automation.nextFireAt === null) {
        return null;
      }
      if (Date.parse(automation.nextFireAt) > Date.parse(now)) return null;
      if (this.#activeFire(scheduleId)) return null;
      const latest = previousOccurrence(automation.schedule, now);
      if (latest === null) return null;
      if (automation.cursorAt !== null && Date.parse(latest) <= Date.parse(automation.cursorAt)) {
        this.#advanceCursor(
          automation,
          automation.cursorAt,
          nextOccurrence(automation.schedule, now),
        );
        return null;
      }
      const count =
        automation.schedule.kind === 'once'
          ? automation.cursorAt === null
            ? 1
            : 0
          : countOccurrences(
              automation.schedule,
              automation.cursorAt ?? automation.createdAt,
              latest,
            );
      if (count <= 0) return null;
      return this.#acceptFire(automation, 'scheduled', latest, count - 1);
    });
  }

  listActiveFires(): AutomationFireRecord[] {
    return this.#sessions.database
      .prepare("SELECT * FROM automation_fires WHERE status IN ('queued', 'running') ORDER BY seq")
      .all()
      .map((row) => this.#toFire(fireRowSchema.parse(row)));
  }

  listDueAutomations(now: string): AutomationRecord[] {
    return this.#sessions.database
      .prepare(
        `SELECT * FROM automations WHERE enabled = 1 AND deleted_at IS NULL
         AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at, seq`,
      )
      .all(now)
      .map((row) => this.#toAutomation(automationRowSchema.parse(row)));
  }

  nextDueAt(): string | null {
    const row = z.object({ next_fire_at: z.string().nullable() }).parse(
      this.#sessions.database
        .prepare(
          `SELECT MIN(next_fire_at) AS next_fire_at FROM automations
             WHERE enabled = 1 AND deleted_at IS NULL AND next_fire_at IS NOT NULL`,
        )
        .get(),
    );
    return row.next_fire_at;
  }

  recordAcceptedRun(fireId: string, runId: string): AutomationFireRecord {
    return this.#sessions.transaction(() => {
      const fire = this.#fire(fireId);
      if (fire.status !== 'queued') return fire;
      const run = this.#sessions.getRunById(runId);
      if (run.ownerId !== fire.ownerId || run.threadId !== fire.targetThreadId) {
        throw new SessionError(
          'internal',
          'The delivered Automation Run does not match its target.',
        );
      }
      if (fire.acceptedRunId !== runId) {
        this.#sessions.database
          .prepare(
            'UPDATE automation_fires SET accepted_run_id = ?, updated_at = ? WHERE fire_id = ?',
          )
          .run(runId, this.#now(), fireId);
      }
      return this.#fire(fireId);
    });
  }

  reconcileFire(fireId: string): AutomationFireRecord {
    return this.#sessions.transaction(() => {
      const fire = this.#fire(fireId);
      if (isTerminalFire(fire.status)) return fire;
      if (fire.inputId === null) {
        throw new SessionError('internal', 'An active Automation fire has no accepted input.');
      }
      const input = this.#sessions.getInput(fire.ownerId, fire.inputId);
      if (input.status === 'queued') return fire;
      if (input.status === 'cancelled') {
        return this.#finishFire(fire, 'cancelled', null);
      }
      if (input.consumedRunId === null) {
        throw new SessionError('internal', 'A consumed Automation input has no Run association.');
      }
      const run = this.#sessions.getRunById(input.consumedRunId);
      if (!isTerminalRun(run.status)) {
        this.#sessions.database
          .prepare(
            `UPDATE automation_fires SET status = 'running', consumed_run_id = ?, updated_at = ?
             WHERE fire_id = ?`,
          )
          .run(run.runId, this.#now(), fire.fireId);
        return this.#fire(fire.fireId);
      }
      const status: AutomationFireStatus =
        run.status === 'completed'
          ? 'completed'
          : run.status === 'cancelled'
            ? 'cancelled'
            : run.status === 'interrupted'
              ? 'interrupted'
              : 'failed';
      return this.#finishFire(fire, status, run.error, run.runId);
    });
  }

  getFire(ownerId: string, scheduleId: string, fireId: string): AutomationFireRecord {
    this.getAutomation(ownerId, scheduleId, true);
    const fire = this.#fire(fireId);
    if (fire.ownerId !== ownerId || fire.scheduleId !== scheduleId) {
      throw new SessionError(
        'permission_denied',
        'Automation fire is not available to this owner.',
      );
    }
    return fire;
  }

  listFires(ownerId: string, scheduleId: string, afterSeq: bigint, limit: number) {
    this.getAutomation(ownerId, scheduleId, true);
    requirePositiveInteger(limit, 'limit', automationPageLimit + 1);
    if (afterSeq < 0n || afterSeq > BigInt(Number.MAX_SAFE_INTEGER)) return [];
    return this.#sessions.database
      .prepare(
        `SELECT * FROM automation_fires WHERE owner_id = ? AND schedule_id = ? AND seq > ?
         ORDER BY seq LIMIT ?`,
      )
      .all(ownerId, scheduleId, Number(afterSeq), limit)
      .map((row) => this.#toFire(fireRowSchema.parse(row)));
  }

  requireAutomationThread(ownerId: string, scheduleId: string, threadId: string) {
    this.getAutomation(ownerId, scheduleId, true);
    const present = this.#sessions.database
      .prepare(
        `SELECT 1 AS present FROM automation_fires
         WHERE owner_id = ? AND schedule_id = ? AND target_thread_id = ? LIMIT 1`,
      )
      .get(ownerId, scheduleId, threadId);
    if (present === undefined) {
      throw new SessionError(
        'permission_denied',
        'The Thread is not an execution target of this Automation.',
      );
    }
    return this.#sessions.getThread(ownerId, threadId);
  }

  #automation(scheduleId: string): AutomationRecord {
    const row = this.#sessions.database
      .prepare('SELECT * FROM automations WHERE schedule_id = ?')
      .get(scheduleId);
    if (row === undefined) throw new SessionError('not_found', 'Automation was not found.');
    return this.#toAutomation(automationRowSchema.parse(row));
  }

  #fire(fireId: string): AutomationFireRecord {
    const row = this.#sessions.database
      .prepare('SELECT * FROM automation_fires WHERE fire_id = ?')
      .get(fireId);
    if (row === undefined) throw new SessionError('not_found', 'Automation fire was not found.');
    return this.#toFire(fireRowSchema.parse(row));
  }

  #activeFire(scheduleId: string): AutomationFireRecord | undefined {
    const row = this.#sessions.database
      .prepare(
        "SELECT * FROM automation_fires WHERE schedule_id = ? AND status IN ('queued', 'running')",
      )
      .get(scheduleId);
    return row === undefined ? undefined : this.#toFire(fireRowSchema.parse(row));
  }

  #acceptFire(
    automation: AutomationRecord,
    trigger: AutomationTrigger,
    scheduledAt: string,
    coalescedCount: number,
  ): AutomationFireRecord {
    const active = this.#activeFire(automation.scheduleId);
    if (active) {
      if (trigger === 'scheduled') return active;
      throw new SessionError(
        'action_conflict',
        'This Automation already has a queued or running fire.',
      );
    }
    if (trigger === 'scheduled') {
      const existing = this.#sessions.database
        .prepare(
          "SELECT fire_id FROM automation_fires WHERE schedule_id = ? AND trigger_source = 'scheduled' AND scheduled_at = ?",
        )
        .get(automation.scheduleId, scheduledAt);
      if (existing !== undefined) return active ?? this.#fire(fireIdFromRow(existing));
    }
    const fireId = this.#createId();
    const now = this.#now();
    const reference: AutomationReference = {
      scheduleId: automation.scheduleId,
      fireId,
      trigger,
      scheduledAt,
    };
    let accepted:
      | {
          thread: { threadId: string };
          input: { inputId: string };
          runId: string;
        }
      | undefined;
    let failure: RunError | undefined;
    this.#sessions.database.exec('SAVEPOINT automation_input_acceptance');
    try {
      accepted = this.#sessions.acceptAutomationInput({
        ownerId: automation.ownerId,
        clientActionId: `automation-fire:${fireId}`,
        method: 'AutomationFire',
        parameters: {
          targetKind: automation.target.kind,
          threadId: automation.target.threadId,
          title: automation.name,
          prompt: automation.prompt,
          environmentPolicy: automation.target.environmentPolicy,
          workspaceId: automation.target.workspaceId,
          automation: reference,
        },
        targetKind: automation.target.kind,
        threadId: automation.target.threadId,
        title: automation.name,
        prompt: automation.prompt,
        environmentPolicy: automation.target.environmentPolicy,
        workspaceId: automation.target.workspaceId,
        automation: reference,
      });
      this.#sessions.database.exec('RELEASE SAVEPOINT automation_input_acceptance');
    } catch (error) {
      this.#sessions.database.exec('ROLLBACK TO SAVEPOINT automation_input_acceptance');
      this.#sessions.database.exec('RELEASE SAVEPOINT automation_input_acceptance');
      failure = asRunError(error);
    }
    const status: AutomationFireStatus = accepted ? 'queued' : 'failed';
    this.#insertFire({
      seq: 0,
      fireId,
      scheduleId: automation.scheduleId,
      ownerId: automation.ownerId,
      trigger,
      scheduleVersion: automation.version,
      scheduledAt,
      actualAt: now,
      coalescedCount,
      prompt: automation.prompt,
      targetKind: automation.target.kind,
      targetThreadId:
        accepted?.thread.threadId ??
        (automation.target.kind === 'existing_thread'
          ? (automation.target.threadId ?? null)
          : automation.target.kind === 'main'
            ? this.#mainThreadId(automation.ownerId)
            : null),
      inputId: accepted?.input.inputId ?? null,
      acceptedRunId: accepted?.runId ?? null,
      consumedRunId: null,
      status,
      error: failure ?? null,
      createdAt: now,
      updatedAt: now,
      finishedAt: accepted ? null : now,
    });
    if (trigger === 'scheduled') {
      const next = nextOccurrence(automation.schedule, scheduledAt);
      this.#advanceCursor(automation, scheduledAt, next);
    }
    return this.#fire(fireId);
  }

  #advanceCursor(automation: AutomationRecord, cursorAt: string, nextFireAt: string | null): void {
    const enabled = automation.schedule.kind === 'once' ? 0 : 1;
    this.#sessions.database
      .prepare(
        `UPDATE automations SET cursor_at = ?, next_fire_at = ?, enabled = ?, updated_at = ?
         WHERE schedule_id = ? AND version = ?`,
      )
      .run(cursorAt, nextFireAt, enabled, this.#now(), automation.scheduleId, automation.version);
  }

  #insertFire(fire: AutomationFireRecord): void {
    this.#sessions.database
      .prepare(
        `INSERT INTO automation_fires(
          fire_id, schedule_id, owner_id, trigger_source, schedule_version, scheduled_at,
          actual_at, coalesced_count, prompt, target_kind, target_thread_id, input_id,
          accepted_run_id, consumed_run_id, status, error_code, error_message, error_retryable,
          created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fire.fireId,
        fire.scheduleId,
        fire.ownerId,
        fire.trigger,
        fire.scheduleVersion,
        fire.scheduledAt,
        fire.actualAt,
        fire.coalescedCount,
        fire.prompt,
        fire.targetKind,
        fire.targetThreadId,
        fire.inputId,
        fire.acceptedRunId,
        fire.consumedRunId,
        fire.status,
        fire.error?.code ?? null,
        fire.error?.message ?? null,
        fire.error ? (fire.error.retryable ? 1 : 0) : null,
        fire.createdAt,
        fire.updatedAt,
        fire.finishedAt,
      );
  }

  #finishFire(
    fire: AutomationFireRecord,
    status: AutomationFireStatus,
    error: RunError | null,
    consumedRunId?: string,
  ): AutomationFireRecord {
    const now = this.#now();
    this.#sessions.database
      .prepare(
        `UPDATE automation_fires SET status = ?, consumed_run_id = ?, error_code = ?,
         error_message = ?, error_retryable = ?, updated_at = ?, finished_at = ? WHERE fire_id = ?`,
      )
      .run(
        status,
        consumedRunId ?? fire.consumedRunId,
        error?.code ?? null,
        error?.message ?? null,
        error ? (error.retryable ? 1 : 0) : null,
        now,
        now,
        fire.fireId,
      );
    return this.#fire(fire.fireId);
  }

  #mainThreadId(ownerId: string): string | null {
    const row = this.#sessions.database
      .prepare(
        "SELECT thread_id FROM threads WHERE owner_id = ? AND thread_type = 'main' AND archived_at IS NULL",
      )
      .get(ownerId);
    return row === undefined ? null : z.object({ thread_id: z.string() }).parse(row).thread_id;
  }

  #normalizeTarget(ownerId: string, target: AutomationTarget): AutomationTarget {
    const creates = target.kind === 'new_task' || target.kind === 'new_automation_only';
    if (target.kind === 'existing_thread') {
      const threadId = requireText(target.threadId ?? '', 'target.thread_id', 200);
      const thread = this.#sessions.getThread(ownerId, threadId);
      if (thread.threadType !== 'task' || thread.automationOnly) {
        throw new SessionError(
          'failed_precondition',
          'An existing Automation target must be a normal persistent task Thread.',
        );
      }
      if (target.environmentPolicy !== undefined || target.workspaceId !== undefined) {
        throw new SessionError(
          'invalid_argument',
          'An existing Thread keeps its own environment policy and workspace.',
        );
      }
      return { kind: target.kind, threadId };
    }
    if (target.threadId !== undefined) {
      throw new SessionError(
        'invalid_argument',
        'target.thread_id only belongs to existing_thread.',
      );
    }
    if (!creates && (target.environmentPolicy !== undefined || target.workspaceId !== undefined)) {
      throw new SessionError(
        'invalid_argument',
        'environment_policy and workspace_id only apply to a newly created Automation Thread.',
      );
    }
    const workspaceId =
      target.workspaceId === undefined
        ? undefined
        : this.#sessions.getWorkspace(ownerId, target.workspaceId).workspaceId;
    if (target.environmentPolicy) {
      const allowedEnv = target.environmentPolicy.allowedEnv;
      if (
        allowedEnv.length === 0 ||
        allowedEnv.length > 32 ||
        new Set(allowedEnv).size !== allowedEnv.length
      ) {
        throw new SessionError(
          'invalid_argument',
          'allowed_env must contain between 1 and 32 distinct environments.',
        );
      }
      for (const envId of allowedEnv) requireText(envId, 'allowed_env', 200);
      return {
        kind: target.kind,
        environmentPolicy: { allowedEnv: [...allowedEnv] },
        ...(workspaceId === undefined ? {} : { workspaceId }),
      };
    }
    return { kind: target.kind, ...(workspaceId === undefined ? {} : { workspaceId }) };
  }

  #toAutomation(row: z.infer<typeof automationRowSchema>): AutomationRecord {
    const schedule: AutomationSchedule =
      row.schedule_kind === 'cron'
        ? {
            kind: 'cron',
            expression: requireText(row.cron_expression ?? '', 'cron_expression', 200),
            timeZone: row.time_zone,
          }
        : {
            kind: 'once',
            runAt: requireText(row.run_at ?? '', 'run_at', 100),
            timeZone: row.time_zone,
          };
    const target: AutomationTarget = {
      kind: row.target_kind,
      ...(row.target_thread_id === null ? {} : { threadId: row.target_thread_id }),
      ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
      ...(row.environment_policy_json === null
        ? {}
        : {
            environmentPolicy: {
              allowedEnv: z
                .object({ allowedEnv: z.array(z.string()) })
                .parse(JSON.parse(row.environment_policy_json)).allowedEnv,
            },
          }),
    };
    return {
      seq: row.seq,
      scheduleId: row.schedule_id,
      ownerId: row.owner_id,
      name: row.name,
      prompt: row.prompt,
      schedule,
      target,
      enabled: row.enabled === 1,
      version: row.version,
      cursorAt: row.cursor_at,
      nextFireAt: row.next_fire_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    };
  }

  #toFire(row: z.infer<typeof fireRowSchema>): AutomationFireRecord {
    return {
      seq: row.seq,
      fireId: row.fire_id,
      scheduleId: row.schedule_id,
      ownerId: row.owner_id,
      trigger: row.trigger_source,
      scheduleVersion: row.schedule_version,
      scheduledAt: row.scheduled_at,
      actualAt: row.actual_at,
      coalescedCount: row.coalesced_count,
      prompt: row.prompt,
      targetKind: row.target_kind,
      targetThreadId: row.target_thread_id,
      inputId: row.input_id,
      acceptedRunId: row.accepted_run_id,
      consumedRunId: row.consumed_run_id,
      status: row.status,
      error:
        row.error_code === null
          ? null
          : {
              code: row.error_code,
              message: row.error_message ?? 'Automation fire failed.',
              retryable: row.error_retryable === 1,
            },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
    };
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

function isTerminalRun(status: RunStatus): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
}

function isTerminalFire(status: AutomationFireStatus): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
}

function asRunError(error: unknown): RunError {
  if (error instanceof SessionError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function fireIdFromRow(row: unknown): string {
  return z.object({ fire_id: z.string() }).parse(row).fire_id;
}
