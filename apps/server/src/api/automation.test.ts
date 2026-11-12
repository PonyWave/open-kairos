import { Code, ConnectError, createClient, createRouterTransport } from '@connectrpc/connect';
import {
  AutomationScheduleKind,
  AutomationService,
  AutomationTargetKind,
  AutomationTrigger,
  EventService,
  QueueService,
  ThreadService,
} from '@kairos/contracts';
import { expect, it } from 'vitest';
import { AutomationService as AutomationManager } from '../automation/service.js';
import { DeviceBashStore } from '../devices/operation-store.js';
import { controlledEnvironmentDependencies } from '../integration/environment-fixture.js';
import {
  createTestAuthentication,
  testSessionInterceptor,
} from '../integration/test-authentication.js';
import { RunCoordinator } from '../sessions/runtime.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { registerGuiRoutes } from './connect.js';
import { BashLogReader } from './logs.js';

const ownerId = 'automation-api-owner';

async function fixture() {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  const dependencies = controlledEnvironmentDependencies(database, ownerId);
  const coordinator = new RunCoordinator({ ...dependencies, store });
  const automations = new AutomationManager(store, {
    deliver: (_input, runId) => Promise.resolve(runId),
  });
  const operations = new DeviceBashStore(database);
  const authentication = createTestAuthentication(database, ownerId, 'owner-token');
  createTestAuthentication(database, 'other-owner', 'other-token');
  const clientsFor = (token: string) => {
    const transport = createRouterTransport(
      (router) =>
        registerGuiRoutes(router, {
          store,
          coordinator,
          automations,
          operations,
          logs: new BashLogReader({ store, operations }),
          modelStatus: {
            providerId: 'test',
            modelId: 'test',
            contextCapacity: 128000,
            outputReserve: 4096,
            available: false,
            configurationErrors: [{ code: 'test', message: 'No model in this API test.' }],
          },
          authentication,
          maxEventQueue: 16,
        }),
      { transport: { interceptors: [testSessionInterceptor(token)] } },
    );
    return {
      automation: createClient(AutomationService, transport),
      thread: createClient(ThreadService, transport),
      queue: createClient(QueueService, transport),
      events: createClient(EventService, transport),
    };
  };
  return {
    database,
    store,
    coordinator,
    automations,
    clients: clientsFor('owner-token'),
    wrong: clientsFor('other-token'),
    async close() {
      await automations.close();
      await coordinator.close();
      database.close();
    },
  };
}

const createRequest = {
  clientActionId: 'create-automation',
  name: '隐藏定时任务',
  prompt: '执行隐藏任务',
  schedule: {
    kind: AutomationScheduleKind.CRON,
    cronExpression: '0 9 * * *',
    timeZone: 'Asia/Shanghai',
  },
  target: { kind: AutomationTargetKind.NEW_AUTOMATION_ONLY },
  enabled: false,
};

it('serves CRUD, fires and authorized automation_only snapshots and events', async () => {
  const current = await fixture();
  try {
    const created = await current.clients.automation.createAutomation(createRequest);
    const duplicate = await current.clients.automation.createAutomation(createRequest);
    expect(duplicate.automation?.scheduleId).toBe(created.automation?.scheduleId);
    const scheduleId = created.automation?.scheduleId ?? '';
    expect(created.automation).toMatchObject({ enabled: false, version: 1n });
    expect(
      (await current.clients.automation.getAutomation({ scheduleId })).automation?.scheduleId,
    ).toBe(scheduleId);
    expect(
      (await current.clients.automation.listAutomations({ afterSeq: 0n, limit: 10 })).automations,
    ).toHaveLength(1);
    const updated = await current.clients.automation.updateAutomation({
      clientActionId: 'update-automation',
      scheduleId,
      expectedVersion: 1n,
      name: '修改后的隐藏任务',
    });
    expect(updated.automation).toMatchObject({ name: '修改后的隐藏任务', version: 2n });

    const accepted = await current.clients.automation.runAutomationNow({
      clientActionId: 'run-automation',
      scheduleId,
    });
    const replay = await current.clients.automation.runAutomationNow({
      clientActionId: 'run-automation',
      scheduleId,
    });
    expect(replay.fire?.fireId).toBe(accepted.fire?.fireId);
    const fireId = accepted.fire?.fireId ?? '';
    const threadId = accepted.fire?.targetThreadId ?? '';
    expect(accepted.fire).toMatchObject({ trigger: AutomationTrigger.RUN_NOW, coalescedCount: 0 });
    const history = await current.clients.automation.listAutomationFires({
      scheduleId,
      afterSeq: 0n,
      limit: 10,
    });
    expect(history.fires.map((fire) => fire.fireId)).toEqual([fireId]);
    expect(accepted.fire?.targetThreadTitle).toBe(current.store.getThread(ownerId, threadId).title);
    current.store.renameThreadIfTitle({
      ownerId,
      threadId,
      expectedTitle: current.store.getThread(ownerId, threadId).title,
      title: '每日工作摘要',
    });
    const renamedHistory = await current.clients.automation.listAutomationFires({
      scheduleId,
      limit: 10,
    });
    expect(renamedHistory.fires[0]?.targetThreadTitle).toBe('每日工作摘要');
    expect(renamedHistory.fires[0]?.prompt).toBe('执行隐藏任务');
    const wrongHistory = await current.wrong.automation
      .listAutomationFires({ scheduleId, limit: 10 })
      .catch((error: unknown) => error);
    expect((wrongHistory as ConnectError).code).toBe(Code.PermissionDenied);
    expect(
      (await current.clients.thread.listThreads({ afterSeq: 0n, limit: 20 })).threads.map(
        (thread) => thread.threadId,
      ),
    ).not.toContain(threadId);
    expect(
      (await current.clients.thread.listThreadCards({ limit: 20, sort: 1 })).cards.map(
        (card) => card.thread?.threadId,
      ),
    ).not.toContain(threadId);

    const directError = await current.clients.thread
      .getThread({ threadId })
      .catch((error: unknown) => error);
    expect(directError).toBeInstanceOf(ConnectError);
    expect((directError as ConnectError).code).toBe(Code.PermissionDenied);
    const snapshot = await current.clients.automation.getAutomationThread({ scheduleId, threadId });
    if (!snapshot.snapshot) throw new Error('Automation Thread snapshot is missing.');
    expect(snapshot.snapshot.thread).toMatchObject({ threadId, automationOnly: true });
    expect(snapshot.snapshot.inputs[0]).toMatchObject({
      source: 5,
      automation: { scheduleId, fireId, trigger: AutomationTrigger.RUN_NOW },
    });
    const reorderError = await current.clients.queue
      .reorderInputs({
        clientActionId: 'reorder-automation-only',
        threadId,
        inputIds: [accepted.fire?.inputId ?? ''],
        expectedVersion: snapshot.snapshot.queueVersion,
      })
      .catch((error: unknown) => error);
    expect(reorderError).toBeInstanceOf(ConnectError);
    expect((reorderError as ConnectError).code).toBe(Code.FailedPrecondition);
    const associationError = await current.clients.automation
      .getAutomationThread({ scheduleId: 'not-the-source-schedule', threadId })
      .catch((error: unknown) => error);
    expect((associationError as ConnectError).code).toBe(Code.NotFound);

    const unauthorizedEvents = current.clients.events
      .watchThread({ threadId, afterSeq: 0n })
      [Symbol.asyncIterator]();
    const eventError = await unauthorizedEvents.next().catch((error: unknown) => error);
    expect((eventError as ConnectError).code).toBe(Code.InvalidArgument);
    const authorizedEvents = current.clients.events
      .watchThread({
        threadId,
        afterSeq: 0n,
        scheduleId,
      })
      [Symbol.asyncIterator]();
    const firstEvent = await authorizedEvents.next();
    expect(firstEvent.done).toBe(false);
    expect(firstEvent.value.payload.case).toBe('event');
    await authorizedEvents.return?.(undefined);

    const wrongRead = await current.wrong.automation
      .getAutomation({ scheduleId })
      .catch((error: unknown) => error);
    expect((wrongRead as ConnectError).code).toBe(Code.PermissionDenied);
    const wrongSnapshot = await current.wrong.automation
      .getAutomationThread({ scheduleId, threadId })
      .catch((error: unknown) => error);
    expect((wrongSnapshot as ConnectError).code).toBe(Code.PermissionDenied);

    const deleted = await current.clients.automation.deleteAutomation({
      clientActionId: 'delete-automation',
      scheduleId,
      expectedVersion: 2n,
    });
    expect(deleted.deleted).toBe(true);
    expect(
      (await current.clients.automation.listAutomations({ afterSeq: 0n, limit: 10 })).automations,
    ).toEqual([]);
    expect(
      (
        await current.clients.automation.listAutomationFires({
          scheduleId,
          afterSeq: 0n,
          limit: 10,
        })
      ).fires,
    ).toHaveLength(1);
  } finally {
    await current.close();
  }
});

it('round-trips a one-time schedule with an explicit timestamp', async () => {
  const current = await fixture();
  try {
    const created = await current.clients.automation.createAutomation({
      ...createRequest,
      clientActionId: 'create-once',
      schedule: {
        kind: AutomationScheduleKind.ONCE,
        timeZone: 'UTC',
        runAt: { seconds: 1767225600n, nanos: 0 },
      },
      target: { kind: AutomationTargetKind.MAIN },
    });
    expect(created.automation?.schedule).toMatchObject({
      kind: AutomationScheduleKind.ONCE,
      timeZone: 'UTC',
      runAt: { seconds: 1767225600n, nanos: 0 },
    });
  } finally {
    await current.close();
  }
});

it('returns a next cursor for both Automation lists at the maximum page size', async () => {
  const current = await fixture();
  try {
    const scheduleIds: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const created = await current.clients.automation.createAutomation({
        ...createRequest,
        clientActionId: `page-create-${index}`,
        name: `分页任务 ${index}`,
        target: { kind: AutomationTargetKind.MAIN },
      });
      scheduleIds.push(created.automation?.scheduleId ?? '');
    }
    const scheduleId = scheduleIds[0] ?? '';
    for (let index = 0; index < 101; index += 1) {
      const accepted = await current.clients.automation.runAutomationNow({
        clientActionId: `page-run-${index}`,
        scheduleId,
      });
      current.store.database
        .prepare(
          "UPDATE automation_fires SET status = 'completed', finished_at = ? WHERE fire_id = ?",
        )
        .run(new Date().toISOString(), accepted.fire?.fireId ?? '');
    }
    const definitions = await current.clients.automation.listAutomations({
      afterSeq: 0n,
      limit: 100,
    });
    expect(definitions.automations).toHaveLength(100);
    expect(definitions.hasMore).toBe(true);
    expect(definitions.nextSeq).toBeDefined();
    const remainingDefinitions = await current.clients.automation.listAutomations({
      afterSeq: definitions.nextSeq ?? 0n,
      limit: 100,
    });
    expect(remainingDefinitions.automations).toHaveLength(1);
    expect(remainingDefinitions.hasMore).toBe(false);

    expect(
      current.store.database.prepare('SELECT COUNT(*) AS count FROM automation_fires').get(),
    ).toEqual({ count: 101 });
    const fires = await current.clients.automation.listAutomationFires({
      scheduleId,
      afterSeq: 0n,
      limit: 100,
    });
    expect(fires.fires).toHaveLength(100);
    expect(fires.hasMore).toBe(true);
    expect(fires.nextSeq).toBeDefined();
    const remainingFires = await current.clients.automation.listAutomationFires({
      scheduleId,
      afterSeq: fires.nextSeq ?? 0n,
      limit: 100,
    });
    expect(remainingFires.fires).toHaveLength(1);
    expect(remainingFires.hasMore).toBe(false);
  } finally {
    await current.close();
  }
});
