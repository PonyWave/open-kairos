import { expect, it } from 'vitest';
import { AutomationService } from '../automation/service.js';
import { controlledEnvironmentDependencies } from '../integration/environment-fixture.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { createAutomationTools } from './automation.js';

const ownerId = 'automation-tools-owner';

function fixture() {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  controlledEnvironmentDependencies(database, ownerId);
  const service = new AutomationService(store, {
    deliver: (_input, runId) => Promise.resolve(runId),
  });
  const main = store.getOrCreateMainThread(ownerId);
  const sent = store.sendMessage({
    ownerId,
    clientActionId: 'main-run',
    method: 'SendMessage',
    parameters: { threadId: main.threadId, text: '管理定时任务', mode: 'follow_up' },
    threadId: main.threadId,
    text: '管理定时任务',
    mode: 'follow_up',
  });
  return { database, store, service, main, run: store.getRunById(sent.runId) };
}

function context(name: string, id: string) {
  return {
    call: { id, name, arguments: {} },
    signal: new AbortController().signal,
  };
}

function content(result: string | { content: string }) {
  return typeof result === 'string' ? result : result.content;
}

const createInput = {
  name: '每日检查',
  prompt: '检查工作区',
  schedule: { kind: 'cron', expression: '0 9 * * *', time_zone: 'Asia/Shanghai' },
  target: { kind: 'new_automation_only' },
  enabled: false,
};

it('provides bounded CRUD, read, list and run_now operations through the shared Store', async () => {
  const current = fixture();
  try {
    const tools = createAutomationTools({ automations: current.service, source: current.run });
    expect(tools.map((tool) => tool.name)).toEqual([
      'automation_create',
      'automation_list',
      'automation_read',
      'automation_update',
      'automation_delete',
      'automation_run_now',
    ]);
    const first = JSON.parse(
      content(
        await tools[0].execute(
          await tools[0].validate(createInput),
          context('automation_create', 'create-1'),
        ),
      ),
    );
    const second = JSON.parse(
      content(
        await tools[0].execute(
          await tools[0].validate({
            ...createInput,
            name: '普通话题',
            target: { kind: 'new_task' },
          }),
          context('automation_create', 'create-2'),
        ),
      ),
    );
    const scheduleId = first.automation.schedule_id as string;
    const listed = JSON.parse(
      content(
        await tools[1].execute(
          await tools[1].validate({ limit: 1 }),
          context('automation_list', 'list-1'),
        ),
      ),
    );
    expect(listed.automations).toHaveLength(1);
    expect(listed.next_cursor).toBeDefined();
    const secondPage = JSON.parse(
      content(
        await tools[1].execute(
          await tools[1].validate({ limit: 1, cursor: listed.next_cursor }),
          context('automation_list', 'list-2'),
        ),
      ),
    );
    expect(secondPage.automations[0].schedule_id).toBe(second.automation.schedule_id);

    const updated = JSON.parse(
      content(
        await tools[3].execute(
          await tools[3].validate({
            schedule_id: scheduleId,
            expected_version: 1,
            name: '修改后的每日检查',
          }),
          context('automation_update', 'update-1'),
        ),
      ),
    );
    expect(updated.automation).toMatchObject({ name: '修改后的每日检查', version: 2 });
    const fired = JSON.parse(
      content(
        await tools[5].execute(
          await tools[5].validate({ schedule_id: scheduleId }),
          context('automation_run_now', 'run-1'),
        ),
      ),
    );
    expect(fired.fire).toMatchObject({ trigger: 'run_now', status: 'queued' });
    const read = JSON.parse(
      content(
        await tools[2].execute(
          await tools[2].validate({ schedule_id: scheduleId, fire_limit: 1 }),
          context('automation_read', 'read-1'),
        ),
      ),
    );
    expect(read.fires).toHaveLength(1);
    expect(read.fires[0].fire_id).toBe(fired.fire.fire_id);
    const deleted = JSON.parse(
      content(
        await tools[4].execute(
          await tools[4].validate({ schedule_id: scheduleId, expected_version: 2 }),
          context('automation_delete', 'delete-1'),
        ),
      ),
    );
    expect(deleted).toEqual({ scheduleId, deleted: true });
  } finally {
    await current.service.close();
    current.database.close();
  }
});

it('rejects management from task Threads and Subagents even if a tool is invoked directly', async () => {
  const current = fixture();
  try {
    const task = current.store.createThread({
      ownerId,
      clientActionId: 'task-run',
      method: 'CreateThread',
      parameters: { title: '任务', initialText: '工作', initialMode: 'follow_up' },
      title: '任务',
      initialText: '工作',
      initialMode: 'follow_up',
    });
    const taskRun = current.store.getRunById(task.runId);
    const taskTools = createAutomationTools({ automations: current.service, source: taskRun });
    await expect(
      taskTools[0].execute(
        await taskTools[0].validate(createInput),
        context('automation_create', 'task-create'),
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });

    const child = current.store.createChildRun(ownerId, current.run.runId, 'subagent-test');
    const childTools = createAutomationTools({ automations: current.service, source: child });
    await expect(
      childTools[0].execute(
        await childTools[0].validate(createInput),
        context('automation_create', 'child-create'),
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  } finally {
    await current.service.close();
    current.database.close();
  }
});

it('keeps has-more pagination usable for the Agent tool at limit 100', async () => {
  const current = fixture();
  try {
    for (let index = 0; index < 101; index += 1) {
      current.service.create({
        ownerId,
        clientActionId: `agent-page-${index}`,
        name: `分页 ${index}`,
        prompt: '分页验证',
        schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' },
        target: { kind: 'main' },
        enabled: false,
      });
    }
    const tools = createAutomationTools({ automations: current.service, source: current.run });
    const first = JSON.parse(
      content(
        await tools[1].execute(
          await tools[1].validate({ limit: 100 }),
          context('automation_list', 'page-100'),
        ),
      ),
    );
    expect(first.automations).toHaveLength(100);
    expect(first.next_cursor).toBeDefined();
    const second = JSON.parse(
      content(
        await tools[1].execute(
          await tools[1].validate({ limit: 100, cursor: first.next_cursor }),
          context('automation_list', 'page-101'),
        ),
      ),
    );
    expect(second.automations).toHaveLength(1);
    expect(second.next_cursor).toBeUndefined();
  } finally {
    await current.service.close();
    current.database.close();
  }
});
