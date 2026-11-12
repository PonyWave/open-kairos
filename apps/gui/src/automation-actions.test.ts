/// <reference lib="dom" />

import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import {
  type Automation,
  AutomationFireSchema,
  AutomationFireStatus,
  AutomationScheduleKind,
  AutomationSchema,
  AutomationService,
  AutomationTargetKind,
  AutomationTrigger,
  create,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { scopedStorage } from './account-storage.js';
import { completeGuiAction } from './action-completion.js';
import { ActionExecutor } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import { ClientActionStore, type StorageLike } from './actions.js';
import { createKairosClients } from './client.js';

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const definition = {
  name: '每日摘要',
  prompt: '总结工作',
  schedule: {
    kind: AutomationScheduleKind.CRON,
    cronExpression: '0 9 * * *',
    timeZone: 'Asia/Shanghai',
  },
  target: { kind: AutomationTargetKind.MAIN },
  enabled: true,
};

function automation(
  request: { name?: string | undefined; prompt?: string | undefined },
  scheduleId = 'schedule-1',
) {
  return create(AutomationSchema, {
    seq: 1n,
    scheduleId,
    name: request.name ?? '每日摘要',
    prompt: request.prompt ?? '总结工作',
    schedule: definition.schedule,
    target: definition.target,
    enabled: true,
    version: 1n,
  });
}

function completion(effects: { changed: string[] }) {
  return (record: Parameters<typeof completeGuiAction>[0], result: unknown) =>
    completeGuiAction(record, result, {
      upsertThread: () => {},
      selectThread: () => {},
      completeDraft: () => {},
      closeForm: () => {},
      showNotice: () => {},
      automationChanged: () => effects.changed.push(record.key),
    });
}

describe('Automation actions over generated Connect clients', () => {
  it('retries an unknown create with the original action and publishes one completion', async () => {
    const ids: string[] = [];
    const responses = new Map<string, { clientActionId: string; automation: Automation }>();
    let loseFirst = true;
    const transport = createRouterTransport((router) => {
      router.service(AutomationService, {
        createAutomation(request) {
          ids.push(request.clientActionId);
          const existing = responses.get(request.clientActionId);
          if (existing) return existing;
          const response = {
            clientActionId: request.clientActionId,
            automation: automation(request),
          };
          responses.set(request.clientActionId, response);
          if (loseFirst) {
            loseFirst = false;
            throw new ConnectError('response lost', Code.Unavailable);
          }
          return response;
        },
      });
    });
    const store = new ClientActionStore(new MemoryStorage());
    const effects = { changed: [] as string[] };
    const executor = new ActionExecutor(
      store,
      createActionHandlers(createKairosClients({ transport })),
      completion(effects),
    );

    await executor.execute('automation:create:draft', 'createAutomation', definition);
    expect(store.pending()).toHaveLength(1);
    expect(effects.changed).toEqual([]);
    await executor.retry('automation:create:draft');
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(effects.changed).toEqual(['automation:create:draft']);
    expect(store.pending()).toHaveLength(0);
    await executor.retry('automation:create:draft');
    expect(ids).toHaveLength(2);
  });

  it('encodes updates, deletion, run-now and all target kinds without losing uint64 versions', async () => {
    const targets: AutomationTargetKind[] = [];
    const ids: string[] = [];
    const hugeVersion = 9_007_199_254_740_993n;
    const transport = createRouterTransport((router) => {
      router.service(AutomationService, {
        createAutomation(request) {
          targets.push(request.target?.kind ?? AutomationTargetKind.UNSPECIFIED);
          ids.push(request.clientActionId);
          return {
            clientActionId: request.clientActionId,
            automation: automation(request, `schedule-${targets.length}`),
          };
        },
        updateAutomation(request) {
          ids.push(request.clientActionId);
          expect(request.expectedVersion).toBe(hugeVersion);
          return {
            clientActionId: request.clientActionId,
            automation: create(AutomationSchema, {
              ...automation(request),
              enabled: request.enabled ?? true,
              version: hugeVersion + 1n,
            }),
          };
        },
        deleteAutomation(request) {
          ids.push(request.clientActionId);
          expect(request.expectedVersion).toBe(hugeVersion);
          return {
            clientActionId: request.clientActionId,
            scheduleId: request.scheduleId,
            deleted: true,
          };
        },
        runAutomationNow(request) {
          ids.push(request.clientActionId);
          return {
            clientActionId: request.clientActionId,
            fire: create(AutomationFireSchema, {
              seq: hugeVersion,
              fireId: 'fire-1',
              scheduleId: request.scheduleId,
              trigger: AutomationTrigger.RUN_NOW,
              scheduleVersion: hugeVersion,
              targetKind: AutomationTargetKind.NEW_AUTOMATION_ONLY,
              status: AutomationFireStatus.COMPLETED,
            }),
          };
        },
      });
    });
    const effects = { changed: [] as string[] };
    const executor = new ActionExecutor(
      new ClientActionStore(),
      createActionHandlers(createKairosClients({ transport })),
      completion(effects),
    );

    for (const [index, kind] of [
      AutomationTargetKind.MAIN,
      AutomationTargetKind.EXISTING_THREAD,
      AutomationTargetKind.NEW_TASK,
      AutomationTargetKind.NEW_AUTOMATION_ONLY,
    ].entries()) {
      await executor.execute(`automation:create:${index}`, 'createAutomation', {
        ...definition,
        target: {
          kind,
          ...(kind === AutomationTargetKind.EXISTING_THREAD ? { threadId: 'task-1' } : {}),
        },
      });
    }
    expect(targets).toEqual([
      AutomationTargetKind.MAIN,
      AutomationTargetKind.EXISTING_THREAD,
      AutomationTargetKind.NEW_TASK,
      AutomationTargetKind.NEW_AUTOMATION_ONLY,
    ]);
    const versioned = {
      scheduleId: 'schedule-1',
      expectedVersion: hugeVersion.toString(),
    };
    await executor.execute('automation:enabled:schedule-1', 'updateAutomation', {
      ...versioned,
      enabled: false,
    });
    await executor.execute('automation:delete:schedule-1', 'deleteAutomation', versioned);
    await executor.execute('automation:run:schedule-1', 'runAutomationNow', {
      scheduleId: 'schedule-1',
    });
    expect(effects.changed).toHaveLength(7);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps restored Automation actions and late completions inside their account scope', async () => {
    const gate = Promise.withResolvers<void>();
    const ids = new Map<string, string[]>();
    const transport = createRouterTransport((router) => {
      router.service(AutomationService, {
        async createAutomation(request) {
          const values = ids.get(request.name) ?? [];
          values.push(request.clientActionId);
          ids.set(request.name, values);
          if (request.name === '账号 A') await gate.promise;
          return { clientActionId: request.clientActionId, automation: automation(request) };
        },
      });
    });
    const handlers = createActionHandlers(createKairosClients({ transport }));
    const storage = new MemoryStorage();
    const storeA = new ClientActionStore(scopedStorage(storage, 'account-a'));
    const storeB = new ClientActionStore(scopedStorage(storage, 'account-b'));
    const effects = { changed: [] as string[] };
    const executor = new ActionExecutor(storeA, handlers, completion(effects));

    const lateA = executor.execute('automation:create:shared', 'createAutomation', {
      ...definition,
      name: '账号 A',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    executor.activate(storeB);
    await executor.execute('automation:create:shared', 'createAutomation', {
      ...definition,
      name: '账号 B',
    });
    gate.resolve();
    await lateA;
    expect(effects.changed).toEqual(['automation:create:shared']);
    expect(storeA.pending()).toHaveLength(1);
    expect(storeB.pending()).toHaveLength(0);

    executor.activate(storeA);
    expect(executor.state.failures[0]?.restored).toBe(true);
    await executor.retry('automation:create:shared');
    expect(ids.get('账号 A')).toHaveLength(2);
    expect(ids.get('账号 A')?.[0]).toBe(ids.get('账号 A')?.[1]);
    expect(effects.changed).toHaveLength(2);
  });
});
