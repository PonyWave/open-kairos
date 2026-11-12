import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import {
  AutomationFireSchema,
  AutomationFireStatus,
  AutomationSchema,
  AutomationService,
  AutomationTargetKind,
  AutomationTrigger,
  create,
  ThreadSchema,
  ThreadService,
  ThreadType,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import {
  AutomationListController,
  listAutomationFires,
  listAutomations,
  listOrdinaryThreads,
} from './automation-requests.js';
import { createKairosClients } from './client.js';

const first = create(AutomationSchema, {
  seq: 1n,
  scheduleId: 'schedule-1',
  name: '第一项',
  prompt: '执行',
  schedule: { kind: 1, cronExpression: '0 9 * * *', timeZone: 'Asia/Shanghai' },
  target: { kind: AutomationTargetKind.MAIN },
  enabled: true,
  version: 1n,
});
const second = create(AutomationSchema, {
  ...first,
  seq: 2n,
  scheduleId: 'schedule-2',
  name: '第二项',
});
const fire = create(AutomationFireSchema, {
  seq: 3n,
  fireId: 'fire-1',
  scheduleId: 'schedule-1',
  trigger: AutomationTrigger.RUN_NOW,
  scheduleVersion: 1n,
  targetKind: AutomationTargetKind.NEW_AUTOMATION_ONLY,
  targetThreadId: 'hidden-1',
  status: AutomationFireStatus.FAILED,
  error: { code: 11, message: '模型失败', terminal: true },
});

describe('Automation Connect queries', () => {
  it('reads real pagination positions for definitions and fires', async () => {
    const transport = createRouterTransport((router) => {
      router.service(AutomationService, {
        listAutomations(request) {
          return request.afterSeq === 0n
            ? { automations: [first], nextSeq: 1n, hasMore: true }
            : { automations: [second], hasMore: false };
        },
        listAutomationFires(request) {
          expect(request.scheduleId).toBe('schedule-1');
          return { fires: [fire], hasMore: false };
        },
      });
    });
    const clients = createKairosClients({ transport });
    const firstPage = await listAutomations(clients);
    expect(firstPage).toMatchObject({ nextSeq: 1n, hasMore: true });
    const secondPage = await listAutomations(clients, firstPage.nextSeq ?? 0n);
    expect(secondPage.automations.map((automation) => automation.scheduleId)).toEqual([
      'schedule-2',
    ]);
    const history = await listAutomationFires(clients, 'schedule-1');
    expect(history.fires[0]).toMatchObject({
      fireId: 'fire-1',
      targetThreadId: 'hidden-1',
      status: AutomationFireStatus.FAILED,
      error: { message: '模型失败' },
    });
  });

  it('loads every ordinary task page and excludes main and automation-only Threads', async () => {
    const main = create(ThreadSchema, {
      threadId: 'main-1',
      title: '主对话',
      seq: 1n,
      threadType: ThreadType.MAIN,
    });
    const task = create(ThreadSchema, {
      threadId: 'task-1',
      title: '普通话题',
      seq: 2n,
      threadType: ThreadType.TASK,
    });
    const hidden = create(ThreadSchema, {
      threadId: 'hidden-1',
      title: '定时专属',
      seq: 3n,
      threadType: ThreadType.TASK,
      automationOnly: true,
    });
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        listThreads(request) {
          return request.afterSeq === 0n
            ? { threads: [main], nextSeq: 1n, hasMore: true }
            : { threads: [task, hidden], hasMore: false };
        },
      });
    });
    const threads = await listOrdinaryThreads(createKairosClients({ transport }));
    expect(threads.map((thread) => thread.threadId)).toEqual(['task-1']);
  });

  it('replaces stale definitions after a failed post-delete refresh and still appends explicit pages', async () => {
    const afterSeqs: bigint[] = [];
    let phase = 'initial';
    const transport = createRouterTransport((router) => {
      router.service(AutomationService, {
        listAutomations(request) {
          afterSeqs.push(request.afterSeq);
          if (phase === 'refresh-fails') {
            throw new ConnectError('refresh failed', Code.Unavailable);
          }
          if (phase === 'after-delete') return { automations: [], hasMore: false };
          if (phase === 'append') return { automations: [second], hasMore: false };
          return { automations: [first], nextSeq: 1n, hasMore: true };
        },
      });
    });
    const controller = new AutomationListController(createKairosClients({ transport }));
    try {
      await controller.load();
      expect(controller.snapshot().automations.map((automation) => automation.scheduleId)).toEqual([
        'schedule-1',
      ]);

      phase = 'refresh-fails';
      await controller.load();
      expect(controller.snapshot().error).not.toBeNull();
      expect(controller.snapshot().automations.map((automation) => automation.scheduleId)).toEqual([
        'schedule-1',
      ]);

      phase = 'after-delete';
      await controller.load();
      expect(controller.snapshot().error).toBeNull();
      expect(controller.snapshot().automations).toEqual([]);
      expect(afterSeqs).toEqual([0n, 0n, 0n]);

      phase = 'initial';
      await controller.load();
      phase = 'append';
      await controller.load(true);
      expect(controller.snapshot().automations.map((automation) => automation.scheduleId)).toEqual([
        'schedule-1',
        'schedule-2',
      ]);
      expect(afterSeqs.at(-1)).toBe(1n);
    } finally {
      controller.stop();
    }
  });
});
