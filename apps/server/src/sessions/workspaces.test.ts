import { expect, it } from 'vitest';
import { seedTestTenant } from '../integration/environment-fixture.js';
import { openDatabase } from '../storage/database.js';
import { SessionStore } from './store.js';

const ownerId = 'owner-1';

function action<T extends Record<string, unknown>>(
  method: string,
  clientActionId: string,
  parameters: T,
): T & { ownerId: string; clientActionId: string; method: string; parameters: T } {
  return { ownerId, clientActionId, method, parameters, ...parameters };
}

function fixture() {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database, {
    mainEnvironment: { envId: 'main', workspace: '/workspace' },
  });
  seedTestTenant(database, ownerId);
  return { database, store };
}

it('creates a workspace with its workspace main atomically and enforces uniqueness', () => {
  const { database, store } = fixture();
  try {
    const created = store.createWorkspace({
      ownerId,
      name: 'Kairos 项目',
      envId: 'main',
      path: '/srv/kairos',
    });
    expect(created.workspace).toMatchObject({
      name: 'Kairos 项目',
      envId: 'main',
      path: '/srv/kairos',
    });
    expect(created.mainThread).toMatchObject({
      threadType: 'workspace_main',
      workspaceId: created.workspace.workspaceId,
      title: 'Kairos 项目',
    });
    expect(store.workspaceMainThreadId(ownerId, created.workspace.workspaceId)).toBe(
      created.mainThread.threadId,
    );
    expect(
      store.agentEnvironments.requirePolicy(created.mainThread.threadId, 'thread'),
    ).toMatchObject({ defaultEnv: 'main', defaultPwd: '/srv/kairos' });

    expect(() =>
      store.createWorkspace({ ownerId, name: '重复', envId: 'main', path: '/srv/kairos' }),
    ).toThrowError(expect.objectContaining({ code: 'action_conflict' }));
    expect(() =>
      store.createWorkspace({ ownerId, name: '相对路径', envId: 'main', path: 'srv/kairos' }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_argument' }));

    const renamed = store.renameWorkspace({
      ownerId,
      workspaceId: created.workspace.workspaceId,
      name: 'Kairos 主项目',
    });
    expect(renamed.name).toBe('Kairos 主项目');
    expect(store.listWorkspaces(ownerId)).toHaveLength(1);
  } finally {
    database.close();
  }
});

it('fixes workspace task Threads to the workspace device and directory', () => {
  const { database, store } = fixture();
  try {
    const workspace = store.createWorkspace({
      ownerId,
      name: '项目',
      envId: 'main',
      path: '/srv/kairos',
    });
    const task = store.createThread(
      action('CreateThread', 'create-task', {
        title: '任务',
        workspaceId: workspace.workspace.workspaceId,
      }),
    );
    expect(task).toMatchObject({
      threadType: 'task',
      workspaceId: workspace.workspace.workspaceId,
    });
    expect(store.agentEnvironments.requirePolicy(task.threadId, 'thread')).toMatchObject({
      defaultEnv: 'main',
      defaultPwd: '/srv/kairos',
    });

    const temporary = store.createThread(action('CreateThread', 'create-temp', { title: '临时' }));
    expect(temporary.workspaceId).toBeNull();
    expect(store.agentEnvironments.requirePolicy(temporary.threadId, 'thread')).toMatchObject({
      defaultEnv: 'main',
      defaultPwd: '/workspace',
    });

    expect(() =>
      store.createThread(
        action('CreateThread', 'create-missing', { title: '不存在', workspaceId: 'missing' }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'not_found' }));

    expect(
      store.listThreads(ownerId, 0n, 50, 'task', workspace.workspace.workspaceId),
    ).toHaveLength(1);
    expect(store.listThreads(ownerId, 0n, 50, 'task', null)).toHaveLength(1);
    expect(store.listThreads(ownerId, 0n, 50, 'task')).toHaveLength(2);
  } finally {
    database.close();
  }
});

it('routes thread notifications to the workspace main or the global main by target', () => {
  const { database, store } = fixture();
  try {
    const workspace = store.createWorkspace({
      ownerId,
      name: '项目',
      envId: 'main',
      path: '/srv/kairos',
    });
    const task = store.createThread(
      action('CreateThread', 'create-task', {
        title: '任务',
        workspaceId: workspace.workspace.workspaceId,
      }),
    );
    const sent = store.sendMessage(
      action('SendMessage', 'send-task', {
        threadId: task.threadId,
        text: 'work',
        mode: 'follow_up' as const,
      }),
    );
    store.appendModelMessage({
      runId: sent.runId,
      inputId: sent.input.inputId,
      message: { role: 'user', content: 'work' },
    });
    store.appendModelMessage({
      runId: sent.runId,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'notify-workspace', name: 'thread_notify', arguments: { message: '工作区进展' } },
          { id: 'notify-global', name: 'thread_notify', arguments: { message: '全局进展' } },
        ],
      },
    });

    const workspaceNotification = store.acceptThreadNotification({
      ownerId,
      sourceThreadId: task.threadId,
      sourceAgentId: 'thread',
      sourceRunId: sent.runId,
      sourceToolCallId: 'notify-workspace',
      content: '工作区进展',
      target: 'workspace',
    });
    expect(workspaceNotification.notification).toMatchObject({
      target: 'workspace',
      replyThreadId: workspace.mainThread.threadId,
    });

    const globalNotification = store.acceptThreadNotification({
      ownerId,
      sourceThreadId: task.threadId,
      sourceAgentId: 'thread',
      sourceRunId: sent.runId,
      sourceToolCallId: 'notify-global',
      content: '全局进展',
      target: 'global',
    });
    expect(globalNotification.notification.target).toBe('global');
    expect(globalNotification.notification.replyThreadId).not.toBe(workspace.mainThread.threadId);

    const temporary = store.createThread(action('CreateThread', 'create-temp', { title: '临时' }));
    const tempSent = store.sendMessage(
      action('SendMessage', 'send-temp', {
        threadId: temporary.threadId,
        text: 'temp',
        mode: 'follow_up' as const,
      }),
    );
    store.appendModelMessage({
      runId: tempSent.runId,
      inputId: tempSent.input.inputId,
      message: { role: 'user', content: 'temp' },
    });
    store.appendModelMessage({
      runId: tempSent.runId,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'notify-temp-workspace',
            name: 'thread_notify',
            arguments: { message: '临时进展' },
          },
          { id: 'notify-temp-global', name: 'thread_notify', arguments: { message: '临时进展' } },
        ],
      },
    });
    expect(() =>
      store.acceptThreadNotification({
        ownerId,
        sourceThreadId: temporary.threadId,
        sourceAgentId: 'thread',
        sourceRunId: tempSent.runId,
        sourceToolCallId: 'notify-temp-workspace',
        content: '临时进展',
        target: 'workspace',
      }),
    ).toThrowError(expect.objectContaining({ code: 'failed_precondition' }));
    const temporaryGlobal = store.acceptThreadNotification({
      ownerId,
      sourceThreadId: temporary.threadId,
      sourceAgentId: 'thread',
      sourceRunId: tempSent.runId,
      sourceToolCallId: 'notify-temp-global',
      content: '临时进展',
    });
    expect(temporaryGlobal.notification.target).toBe('global');
  } finally {
    database.close();
  }
});

it('scopes workspace main Thread calls to its own workspace', () => {
  const { database, store } = fixture();
  try {
    const first = store.createWorkspace({ ownerId, name: '一', envId: 'main', path: '/srv/one' });
    const second = store.createWorkspace({ ownerId, name: '二', envId: 'main', path: '/srv/two' });
    const firstTask = store.createThread(
      action('CreateThread', 'create-first-task', {
        title: '一任务',
        workspaceId: first.workspace.workspaceId,
      }),
    );
    const secondTask = store.createThread(
      action('CreateThread', 'create-second-task', {
        title: '二任务',
        workspaceId: second.workspace.workspaceId,
      }),
    );
    const mainSent = store.sendMessage(
      action('SendMessage', 'send-workspace-main', {
        threadId: first.mainThread.threadId,
        text: '协调',
        mode: 'follow_up' as const,
      }),
    );

    const ownCall = store.acceptThreadCall({
      ownerId,
      sourceThreadId: first.mainThread.threadId,
      sourceAgentId: 'thread',
      sourceRunId: mainSent.runId,
      sourceToolCallId: 'call-own',
      targetThreadId: firstTask.threadId,
      prompt: '继续',
      mode: 'follow_up',
    });
    expect(ownCall.interaction.targetThreadId).toBe(firstTask.threadId);

    expect(() =>
      store.acceptThreadCall({
        ownerId,
        sourceThreadId: first.mainThread.threadId,
        sourceAgentId: 'thread',
        sourceRunId: mainSent.runId,
        sourceToolCallId: 'call-cross',
        targetThreadId: secondTask.threadId,
        prompt: '越界',
        mode: 'follow_up',
      }),
    ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));

    const created = store.acceptThreadCall({
      ownerId,
      sourceThreadId: first.mainThread.threadId,
      sourceAgentId: 'thread',
      sourceRunId: mainSent.runId,
      sourceToolCallId: 'call-create',
      prompt: '新任务',
      mode: 'follow_up',
    });
    expect(created.input.threadId).not.toBe(firstTask.threadId);
    expect(store.getThread(ownerId, created.interaction.targetThreadId)).toMatchObject({
      threadType: 'task',
      workspaceId: first.workspace.workspaceId,
    });

    const main = store.getOrCreateMainThread(ownerId);
    const mainMainSent = store.sendMessage(
      action('SendMessage', 'send-global-main', {
        threadId: main.threadId,
        text: '全局',
        mode: 'follow_up' as const,
      }),
    );
    const callWorkspaceMain = store.acceptThreadCall({
      ownerId,
      sourceThreadId: main.threadId,
      sourceAgentId: 'thread',
      sourceRunId: mainMainSent.runId,
      sourceToolCallId: 'call-workspace-main',
      targetThreadId: second.mainThread.threadId,
      prompt: '全局指令',
      mode: 'follow_up',
    });
    expect(callWorkspaceMain.interaction.targetThreadId).toBe(second.mainThread.threadId);
  } finally {
    database.close();
  }
});
