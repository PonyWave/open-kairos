import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { controlledEnvironmentDependencies } from '../integration/environment-fixture.js';
import type { InputRecord, RunStatus } from '../sessions/records.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { jitteredNextOccurrence } from './cron.js';
import { AutomationService } from './service.js';
import type { AutomationFireRecord, AutomationTarget } from './types.js';

const ownerId = 'automation-owner';
const initialTime = Date.parse('2026-01-01T00:00:00.000Z');

function fixture(databasePath = ':memory:') {
  const database = openDatabase(databasePath);
  let now = initialTime;
  let ids = 0;
  const store = new SessionStore(database, { clock: () => new Date(now) });
  controlledEnvironmentDependencies(database, ownerId);
  const deliveries: Array<{ input: InputRecord; runId: string }> = [];
  const errors: unknown[] = [];
  const service = new AutomationService(store, {
    clock: () => new Date(now),
    createId: () => `automation-id-${++ids}`,
    deliver: (input, runId) => {
      deliveries.push({ input, runId });
      const accepted = store.getRunById(runId);
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(accepted.status)) {
        return Promise.resolve(store.moveInputToNewRun(ownerId, input.inputId).runId);
      }
      return Promise.resolve(runId);
    },
    onError: (error) => errors.push(error),
  });
  return {
    database,
    store,
    service,
    deliveries,
    errors,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    setTime(value: number) {
      now = value;
    },
  };
}

function create(
  service: AutomationService,
  target: AutomationTarget,
  options: { id?: string; enabled?: boolean; cron?: string; runAt?: string } = {},
) {
  return service.create({
    ownerId,
    clientActionId: options.id ?? `create-${target.kind}`,
    name: `定时 ${target.kind}`,
    prompt: `执行 ${target.kind}`,
    schedule: options.runAt
      ? { kind: 'once', runAt: options.runAt, timeZone: 'Asia/Shanghai' }
      : {
          kind: 'cron',
          expression: options.cron ?? '* * * * *',
          timeZone: 'Asia/Shanghai',
        },
    target,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  });
}

function runNow(service: AutomationService, scheduleId: string, actionId: string) {
  return service.runNow({ ownerId, scheduleId, clientActionId: actionId });
}

function finishFire(
  store: SessionStore,
  fire: AutomationFireRecord,
  status: RunStatus = 'completed',
) {
  if (!fire.inputId || !fire.acceptedRunId) throw new Error('The fire has no accepted input.');
  const input = store.getInput(fire.ownerId, fire.inputId);
  if (input.status === 'queued') {
    store.appendModelMessage({
      runId: fire.acceptedRunId,
      inputId: input.inputId,
      message: { role: 'user', content: input.text },
    });
  }
  if (status === 'completed') {
    store.appendModelMessage({
      runId: fire.acceptedRunId,
      message: { role: 'assistant', content: '完成' },
    });
  }
  store.updateRunStatus(
    fire.acceptedRunId,
    status,
    status === 'failed'
      ? { code: 'internal', message: 'model failed', retryable: false }
      : undefined,
  );
  return input;
}

describe('Automation CRUD and targets', () => {
  it('supports all four targets, preserves provenance and filters automation_only Threads', async () => {
    const current = fixture();
    try {
      const existing = current.store.createThread({
        ownerId,
        clientActionId: 'existing-thread',
        method: 'CreateThread',
        parameters: { title: '已有任务' },
        title: '已有任务',
      });
      const definitions = [
        create(current.service, { kind: 'main' }, { enabled: false }),
        create(
          current.service,
          { kind: 'existing_thread', threadId: existing.threadId },
          { enabled: false },
        ),
        create(current.service, { kind: 'new_task' }, { enabled: false }),
        create(current.service, { kind: 'new_automation_only' }, { enabled: false }),
      ];
      const fires = [];
      for (const definition of definitions) {
        fires.push(await runNow(current.service, definition.scheduleId, `run-${definition.seq}`));
      }
      expect(fires.map((fire) => fire.targetKind)).toEqual([
        'main',
        'existing_thread',
        'new_task',
        'new_automation_only',
      ]);
      expect(fires[0]?.targetThreadId).toBe(current.store.getOrCreateMainThread(ownerId).threadId);
      expect(fires[1]?.targetThreadId).toBe(existing.threadId);
      const ordinary = current.store.getThread(ownerId, fires[2]?.targetThreadId ?? '');
      const hidden = current.store.getThread(ownerId, fires[3]?.targetThreadId ?? '');
      expect(ordinary.automationOnly).toBe(false);
      expect(hidden.automationOnly).toBe(true);
      expect(hidden.threadType).toBe('task');
      expect(current.store.listThreads(ownerId, 0n, 20).map((thread) => thread.threadId)).toEqual([
        existing.threadId,
        fires[0]?.targetThreadId,
        ordinary.threadId,
      ]);
      for (const fire of fires) {
        expect(fire).toMatchObject({ trigger: 'run_now', status: 'queued', coalescedCount: 0 });
        const input = current.store.getInput(ownerId, fire.inputId ?? '');
        expect(input).toMatchObject({
          mode: 'follow_up',
          source: 'automation',
          automation: {
            scheduleId: fire.scheduleId,
            fireId: fire.fireId,
            trigger: 'run_now',
          },
        });
        expect(
          current.service.store.requireAutomationThread(ownerId, fire.scheduleId, input.threadId),
        ).toBeDefined();
      }
      expect(() =>
        current.service.store.requireAutomationThread(
          ownerId,
          definitions[0]?.scheduleId ?? '',
          hidden.threadId,
        ),
      ).toThrow(/not an execution target/);
      expect(() =>
        current.service.store.getAutomation('another-owner', definitions[0]?.scheduleId ?? ''),
      ).toThrow(/not available/);
      expect(current.errors).toEqual([]);
    } finally {
      await current.service.close();
      current.database.close();
    }
  });

  it('deduplicates management actions, checks versions and resets cursors on schedule changes', async () => {
    const current = fixture();
    try {
      const created = create(current.service, { kind: 'new_task' });
      const duplicate = create(current.service, { kind: 'new_task' });
      expect(duplicate).toEqual(created);
      expect(created.version).toBe(1);
      expect(() =>
        create(current.service, { kind: 'new_task' }, { id: 'invalid-cron', cron: '0 0 30 2 *' }),
      ).toThrow(/no future occurrence/);
      expect(() =>
        current.service.update({
          ownerId,
          clientActionId: 'stale-update',
          scheduleId: created.scheduleId,
          expectedVersion: 99n,
          name: '过期修改',
        }),
      ).toThrow(/modified by another action/);
      const disabled = current.service.update({
        ownerId,
        clientActionId: 'disable',
        scheduleId: created.scheduleId,
        expectedVersion: 1n,
        enabled: false,
      });
      expect(disabled).toMatchObject({ enabled: false, nextFireAt: null, version: 2 });
      current.advance(5 * 60_000);
      const enabled = current.service.update({
        ownerId,
        clientActionId: 'enable',
        scheduleId: created.scheduleId,
        expectedVersion: 2n,
        enabled: true,
      });
      expect(enabled.cursorAt).toBe('2026-01-01T00:05:00.000Z');
      expect(enabled.nextFireAt).toBe(
        jitteredNextOccurrence(
          { kind: 'cron', expression: '* * * * *', timeZone: 'Asia/Shanghai' },
          '2026-01-01T00:05:00.000Z',
          created.scheduleId,
        ),
      );
      const changed = current.service.update({
        ownerId,
        clientActionId: 'change-cron',
        scheduleId: created.scheduleId,
        expectedVersion: 3n,
        schedule: { kind: 'cron', expression: '0 * * * *', timeZone: 'Asia/Shanghai' },
      });
      expect(changed.nextFireAt).toBe(
        jitteredNextOccurrence(
          { kind: 'cron', expression: '0 * * * *', timeZone: 'Asia/Shanghai' },
          '2026-01-01T00:05:00.000Z',
          created.scheduleId,
        ),
      );
      const deleted = current.service.delete({
        ownerId,
        clientActionId: 'delete',
        scheduleId: created.scheduleId,
        expectedVersion: 4n,
      });
      expect(deleted.deleted).toBe(true);
      expect(current.service.store.listAutomations(ownerId, 0n, 10)).toEqual([]);
      expect(current.service.store.listFires(ownerId, created.scheduleId, 0n, 10)).toEqual([]);
    } finally {
      await current.service.close();
      current.database.close();
    }
  });

  it('replays the original run_now receipt after the fire reaches a terminal state', async () => {
    const current = fixture();
    try {
      const automation = create(current.service, { kind: 'new_task' }, { enabled: false });
      const accepted = await runNow(current.service, automation.scheduleId, 'run-replay');
      finishFire(current.store, accepted);
      current.service.store.reconcileFire(accepted.fireId);
      const replay = await runNow(current.service, automation.scheduleId, 'run-replay');
      expect(replay).toEqual(accepted);
      expect(
        current.service.store.getFire(ownerId, automation.scheduleId, accepted.fireId).status,
      ).toBe('completed');
    } finally {
      await current.service.close();
      current.database.close();
    }
  });

  it('records acceptance failures without creating a partial Thread', async () => {
    const current = fixture();
    try {
      const automation = create(
        current.service,
        { kind: 'new_task', environmentPolicy: { allowedEnv: ['missing-env'] } },
        { enabled: false },
      );
      const fire = await runNow(current.service, automation.scheduleId, 'invalid-environment');
      expect(fire).toMatchObject({
        status: 'failed',
        inputId: null,
        acceptedRunId: null,
        error: { code: 'permission_denied' },
      });
      expect(current.store.listThreads(ownerId, 0n, 10)).toEqual([]);
      expect(current.service.store.listFires(ownerId, automation.scheduleId, 0n, 10)).toHaveLength(
        1,
      );

      const main = current.store.getOrCreateMainThread(ownerId);
      const sent = current.store.sendMessage({
        ownerId,
        clientActionId: 'cancel-main-run',
        method: 'SendMessage',
        parameters: { threadId: main.threadId, text: '取消目标', mode: 'follow_up' },
        threadId: main.threadId,
        text: '取消目标',
        mode: 'follow_up',
      });
      current.store.updateRunStatus(sent.runId, 'running');
      current.store.requestCancelRun({
        ownerId,
        clientActionId: 'cancel-main-run-request',
        method: 'CancelRun',
        parameters: { threadId: main.threadId, runId: sent.runId, reason: 'test' },
        threadId: main.threadId,
        runId: sent.runId,
        reason: 'test',
      });
      const mainAutomation = create(current.service, { kind: 'main' }, { enabled: false });
      const mainFailure = await runNow(current.service, mainAutomation.scheduleId, 'main-failure');
      expect(mainFailure).toMatchObject({
        status: 'failed',
        targetThreadId: main.threadId,
        inputId: null,
        acceptedRunId: null,
        error: { code: 'failed_precondition' },
      });
    } finally {
      await current.service.close();
      current.database.close();
    }
  });
});

describe('Automation scheduling and recovery', () => {
  it('coalesces missed cron occurrences and does not overlap an active Automation', async () => {
    const current = fixture();
    try {
      const automation = create(current.service, { kind: 'new_task' });
      current.advance(5 * 60_000 + 30_000);
      await current.service.runDue();
      const first = current.service.store.listFires(ownerId, automation.scheduleId, 0n, 10)[0];
      expect(first).toMatchObject({
        trigger: 'scheduled',
        scheduledAt: '2026-01-01T00:05:00.000Z',
        coalescedCount: 4,
        status: 'queued',
      });
      await current.service.runDue();
      expect(current.service.store.listFires(ownerId, automation.scheduleId, 0n, 10)).toHaveLength(
        1,
      );
      current.advance(3 * 60_000);
      await current.service.runDue();
      expect(current.service.store.listFires(ownerId, automation.scheduleId, 0n, 10)).toHaveLength(
        1,
      );
      finishFire(current.store, first as AutomationFireRecord);
      current.service.store.reconcileFire((first as AutomationFireRecord).fireId);
      await current.service.runDue();
      const fires = current.service.store.listFires(ownerId, automation.scheduleId, 0n, 10);
      expect(fires).toHaveLength(2);
      expect(fires[1]).toMatchObject({
        scheduledAt: '2026-01-01T00:08:00.000Z',
        coalescedCount: 2,
      });
      expect(current.service.store.getAutomation(ownerId, automation.scheduleId).cursorAt).toBe(
        '2026-01-01T00:08:00.000Z',
      );
    } finally {
      await current.service.close();
      current.database.close();
    }
  });

  it('fires a one-time schedule once and disables its subsequent schedule', async () => {
    const current = fixture();
    try {
      const automation = create(
        current.service,
        { kind: 'new_automation_only' },
        { runAt: '2026-01-01T00:00:00.000+08:00' },
      );
      current.advance(60_000);
      await current.service.runDue();
      await current.service.runDue();
      const fires = current.service.store.listFires(ownerId, automation.scheduleId, 0n, 10);
      expect(fires).toHaveLength(1);
      expect(fires[0]).toMatchObject({
        scheduledAt: '2025-12-31T16:00:00.000Z',
        trigger: 'scheduled',
      });
      expect(current.service.store.getAutomation(ownerId, automation.scheduleId)).toMatchObject({
        enabled: false,
        nextFireAt: null,
      });
    } finally {
      await current.service.close();
      current.database.close();
    }
  });

  it('recovers the same fire and input after reopening SQLite without creating a duplicate', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kairos-automation-restart-'));
    const databasePath = join(directory, 'server.sqlite');
    let first: ReturnType<typeof fixture> | undefined;
    let second: ReturnType<typeof fixture> | undefined;
    try {
      first = fixture(databasePath);
      const automation = create(
        first.service,
        { kind: 'new_task' },
        { runAt: '2026-01-01T00:01:00.000Z' },
      );
      first.advance(61_000);
      await first.service.runDue();
      const before = first.service.store.listFires(ownerId, automation.scheduleId, 0n, 10);
      expect(before).toHaveLength(1);
      await first.service.close();
      first.database.close();
      first = undefined;

      second = fixture(databasePath);
      const interrupted = second.store.recoverInterrupted();
      expect(interrupted).toHaveLength(1);
      await second.service.runDue();
      await second.service.runDue();
      const after = second.service.store.listFires(ownerId, automation.scheduleId, 0n, 10);
      expect(after).toHaveLength(1);
      expect(after[0]?.fireId).toBe(before[0]?.fireId);
      expect(after[0]?.inputId).toBe(before[0]?.inputId);
      expect(second.deliveries.at(-1)?.input.inputId).toBe(before[0]?.inputId);
      expect(second.deliveries.at(-1)?.runId).not.toBe(before[0]?.acceptedRunId);
      const latestAccepted = after[0]?.acceptedRunId;
      await second.service.runDue();
      expect(second.deliveries.at(-1)?.runId).toBe(latestAccepted);
    } finally {
      if (first) {
        await first.service.close();
        first.database.close();
      }
      if (second) {
        await second.service.close();
        second.database.close();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('Automation enablement and timer recovery', () => {
  it('enables a future once without resetting its cursor and leaves an expired once disabled by time', async () => {
    const current = fixture();
    try {
      const future = create(
        current.service,
        { kind: 'new_task' },
        { id: 'future-once', runAt: '2026-01-01T01:00:00.000Z', enabled: false },
      );
      const enabled = current.service.update({
        ownerId,
        clientActionId: 'enable-future-once',
        scheduleId: future.scheduleId,
        expectedVersion: 1n,
        enabled: true,
      });
      expect(enabled.cursorAt).toBeNull();
      expect(enabled.nextFireAt).toBe(
        jitteredNextOccurrence(
          { kind: 'once', runAt: '2026-01-01T01:00:00.000Z', timeZone: 'Asia/Shanghai' },
          '2026-01-01T00:00:00.000Z',
          future.scheduleId,
        ),
      );
      current.advance(61 * 60_000);
      await current.service.runDue();
      expect(current.service.store.listFires(ownerId, future.scheduleId, 0n, 10)).toHaveLength(1);
      await current.service.runDue();
      expect(current.service.store.listFires(ownerId, future.scheduleId, 0n, 10)).toHaveLength(1);

      const expired = create(
        current.service,
        { kind: 'new_task' },
        { id: 'expired-once', runAt: '2025-12-31T23:00:00.000Z', enabled: false },
      );
      const enabledExpired = current.service.update({
        ownerId,
        clientActionId: 'enable-expired-once',
        scheduleId: expired.scheduleId,
        expectedVersion: 1n,
        enabled: true,
      });
      expect(enabledExpired.cursorAt).toBeNull();
      expect(enabledExpired.nextFireAt).toBeNull();
      await current.service.runDue();
      expect(current.service.store.listFires(ownerId, expired.scheduleId, 0n, 10)).toHaveLength(0);
    } finally {
      await current.service.close();
      current.database.close();
    }
  });

  it('recovers a queued fire without a future cron after a delivery failure', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const errors: unknown[] = [];
    let attempts = 0;
    const service = new AutomationService(current.store, {
      clock: () => new Date(initialTime),
      deliver: (_input, runId) => {
        attempts += 1;
        if (attempts < 3) throw new Error('temporary delivery failure');
        const fire = service.store.listActiveFires()[0];
        if (!fire) throw new Error('Active fire is missing.');
        finishFire(current.store, fire);
        return Promise.resolve(runId);
      },
      onError: (error) => errors.push(error),
    });
    try {
      const automation = create(service, { kind: 'new_task' }, { enabled: false });
      await runNow(service, automation.scheduleId, 'recover-delivery').catch(() => undefined);
      expect(attempts).toBe(1);
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(3);
      expect(service.store.listActiveFires()).toEqual([]);
      expect(service.store.listFires(ownerId, automation.scheduleId, 0n, 10)[0]?.status).toBe(
        'completed',
      );
      expect(errors).toHaveLength(2);
    } finally {
      await service.close();
      current.database.close();
      vi.useRealTimers();
    }
  });

  it('recovers after a listener reconciliation failure even when the next cron is far away', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const errors: unknown[] = [];
    let deliveries = 0;
    let started = false;
    const service = new AutomationService(current.store, {
      clock: () => new Date(initialTime),
      deliver: (_input, runId) => {
        if (!started) return Promise.resolve(runId);
        deliveries += 1;
        const fire = service.store.listActiveFires()[0];
        if (!fire) throw new Error('Active fire is missing.');
        finishFire(current.store, fire);
        return Promise.resolve(runId);
      },
      onError: (error) => errors.push(error),
    });
    try {
      const automation = create(service, { kind: 'new_task' }, { cron: '0 0 1 1 *' });
      const accepted = await runNow(service, automation.scheduleId, 'recover-reconciliation');
      expect(accepted.status).toBe('queued');
      const reconcile = service.store.reconcileFire.bind(service.store);
      const reconciliation = vi
        .spyOn(service.store, 'reconcileFire')
        .mockImplementationOnce(() => {
          throw new Error('temporary reconciliation failure');
        })
        .mockImplementation(reconcile);
      service.start();
      started = true;
      await vi.advanceTimersByTimeAsync(0);
      expect(deliveries).toBe(0);
      await vi.advanceTimersByTimeAsync(999);
      expect(deliveries).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(deliveries).toBe(1);
      expect(reconciliation.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(service.store.getFire(ownerId, automation.scheduleId, accepted.fireId).status).toBe(
        'completed',
      );
      expect(errors).toHaveLength(1);
    } finally {
      await service.close();
      current.database.close();
      vi.useRealTimers();
    }
  });
});

describe('Automation overdue recovery timer', () => {
  it('uses the recovery interval instead of an overdue cron delay', async () => {
    vi.useFakeTimers();
    const current = fixture();
    let attempts = 0;
    const service = new AutomationService(current.store, {
      clock: () => new Date(initialTime + 61_000),
      deliver: () => {
        attempts += 1;
        throw new Error('delivery remains unavailable');
      },
      onError: () => undefined,
    });
    try {
      const automation = create(service, { kind: 'new_task' });
      await runNow(service, automation.scheduleId, 'overdue-recovery').catch(() => undefined);
      expect(attempts).toBe(1);
      current.advance(61_000);
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(3);
    } finally {
      await service.close();
      current.database.close();
      vi.useRealTimers();
    }
  });
});

describe('Automation runNow recovery arming', () => {
  it('automatically retries after the first runNow delivery fails without a future cron', async () => {
    vi.useFakeTimers();
    const current = fixture();
    let attempts = 0;
    const service = new AutomationService(current.store, {
      clock: () => new Date(initialTime),
      deliver: (_input, runId) => {
        attempts += 1;
        if (attempts === 1) throw new Error('first runNow delivery failure');
        const fire = service.store.listActiveFires()[0];
        if (!fire) throw new Error('Active fire is missing.');
        finishFire(current.store, fire);
        return Promise.resolve(runId);
      },
      onError: () => undefined,
    });
    try {
      const automation = create(service, { kind: 'new_task' }, { enabled: false });
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      await expect(runNow(service, automation.scheduleId, 'run-now-first-failure')).rejects.toThrow(
        'first runNow delivery failure',
      );
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);
      expect(service.store.listActiveFires()).toEqual([]);
    } finally {
      await service.close();
      current.database.close();
      vi.useRealTimers();
    }
  });

  it('automatically retries after the first runNow delivery fails with a distant cron', async () => {
    vi.useFakeTimers();
    const current = fixture();
    let attempts = 0;
    const service = new AutomationService(current.store, {
      clock: () => new Date(initialTime),
      deliver: (_input, runId) => {
        attempts += 1;
        if (attempts === 1) throw new Error('first runNow delivery failure');
        const fire = service.store.listActiveFires()[0];
        if (!fire) throw new Error('Active fire is missing.');
        finishFire(current.store, fire);
        return Promise.resolve(runId);
      },
      onError: () => undefined,
    });
    try {
      const automation = create(service, { kind: 'new_task' }, { cron: '0 0 1 1 *' });
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        runNow(service, automation.scheduleId, 'run-now-distant-failure'),
      ).rejects.toThrow('first runNow delivery failure');
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);
      expect(service.store.listActiveFires()).toEqual([]);
    } finally {
      await service.close();
      current.database.close();
      vi.useRealTimers();
    }
  });

  it('automatically retries after the first runNow listener reconciliation fails', async () => {
    vi.useFakeTimers();
    const current = fixture();
    let deliveries = 0;
    let recovered = false;
    const service = new AutomationService(current.store, {
      clock: () => new Date(initialTime),
      deliver: (_input, runId) => {
        if (!recovered) return Promise.resolve(runId);
        deliveries += 1;
        const fire = service.store.listActiveFires()[0];
        if (!fire) throw new Error('Active fire is missing.');
        finishFire(current.store, fire);
        return Promise.resolve(runId);
      },
      onError: () => undefined,
    });
    try {
      const automation = create(service, { kind: 'new_task' }, { enabled: false });
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      const reconcile = service.store.reconcileFire.bind(service.store);
      const reconciliation = vi
        .spyOn(service.store, 'reconcileFire')
        .mockImplementationOnce(() => {
          throw new Error('first runNow reconciliation failure');
        })
        .mockImplementation(reconcile);
      await expect(
        runNow(service, automation.scheduleId, 'run-now-reconcile-failure'),
      ).rejects.toThrow('first runNow reconciliation failure');
      expect(deliveries).toBe(0);
      recovered = true;
      await vi.advanceTimersByTimeAsync(999);
      expect(deliveries).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(deliveries).toBe(1);
      expect(reconciliation.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(service.store.listActiveFires()).toEqual([]);
    } finally {
      await service.close();
      current.database.close();
      vi.useRealTimers();
    }
  });
});
