import { expect, it } from 'vitest';
import { controlledEnvironmentDependencies } from '../integration/environment-fixture.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import {
  createThreadArchiveTool,
  createWorkspaceCreateTool,
  createWorkspaceDeleteTool,
} from './delegation.js';

const ownerId = 'workspace-tools-owner';

function fixture() {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  controlledEnvironmentDependencies(database, ownerId);
  const main = store.getOrCreateMainThread(ownerId);
  const sent = store.sendMessage({
    ownerId,
    clientActionId: 'main-run',
    method: 'SendMessage',
    parameters: { threadId: main.threadId, text: '创建工作空间', mode: 'follow_up' },
    threadId: main.threadId,
    text: '创建工作空间',
    mode: 'follow_up',
  });
  return { database, store, main, run: store.getRunById(sent.runId) };
}

function toolOptions(store: SessionStore, source: ReturnType<SessionStore['getRunById']>) {
  return {
    store,
    source,
    scheduleThreadCall: () => Promise.resolve(),
    waitForInteraction: () => Promise.resolve(),
    cancelInteraction: () => Promise.reject(new Error('not used by workspace tools')),
  };
}

function context(id: string) {
  return {
    call: { id, name: 'workspace_create', arguments: {} },
    signal: new AbortController().signal,
  };
}

const createInput = {
  name: 'Kairos 项目',
  env_id: 'main',
  path: '/srv/kairos',
  description: '主项目目录',
};

it('creates a workspace with its main conversation from the global main', async () => {
  const current = fixture();
  const tool = createWorkspaceCreateTool(toolOptions(current.store, current.run));
  const result = await tool.execute(await tool.validate(createInput), context('create-1'));
  const payload = JSON.parse(typeof result === 'string' ? result : result.content);
  expect(payload.workspace_id).toBeTruthy();
  expect(payload.main_thread_id).toBeTruthy();
  expect(payload.env_id).toBe('main');
  expect(payload.path).toBe('/srv/kairos');
  const workspaces = current.store.listWorkspaces(ownerId);
  expect(workspaces.map((workspace) => workspace.name)).toEqual(['Kairos 项目']);
  expect(current.store.workspaceMainThreadId(ownerId, payload.workspace_id as string)).toBe(
    payload.main_thread_id,
  );
});

it('rejects relative paths, duplicate device directories and non-main sources', async () => {
  const current = fixture();
  const tool = createWorkspaceCreateTool(toolOptions(current.store, current.run));
  expect(() => tool.validate({ ...createInput, path: 'relative/path' })).toThrow('absolute');

  await tool.execute(await tool.validate(createInput), context('create-1'));
  await expect(
    tool.execute(await tool.validate({ ...createInput, name: '重复' }), context('create-2')),
  ).rejects.toThrow('already exists');

  const workspace = current.store.listWorkspaces(ownerId)[0];
  if (!workspace) throw new Error('Workspace fixture is missing.');
  const workspaceMainId = current.store.workspaceMainThreadId(ownerId, workspace.workspaceId);
  if (!workspaceMainId) throw new Error('Workspace main is missing.');
  const sent = current.store.sendMessage({
    ownerId,
    clientActionId: 'workspace-main-run',
    method: 'SendMessage',
    parameters: { threadId: workspaceMainId, text: '再建一个', mode: 'follow_up' },
    threadId: workspaceMainId,
    text: '再建一个',
    mode: 'follow_up',
  });
  const workspaceMainTool = createWorkspaceCreateTool(
    toolOptions(current.store, current.store.getRunById(sent.runId)),
  );
  await expect(
    workspaceMainTool.execute(
      await workspaceMainTool.validate({ ...createInput, path: '/srv/other' }),
      context('create-3'),
    ),
  ).rejects.toThrow('Only the global main');
});

function taskThread(store: SessionStore, title: string, workspaceId?: string) {
  return store.createThread({
    ownerId,
    method: 'CreateThread',
    clientActionId: `create-${title}`,
    parameters: {},
    title,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  });
}

it('archives a finished task Thread from the global main', async () => {
  const current = fixture();
  const task = taskThread(current.store, '已完成任务');
  const tool = createThreadArchiveTool(toolOptions(current.store, current.run));
  const result = await tool.execute(
    await tool.validate({ thread_id: task.threadId }),
    context('archive-1'),
  );
  const payload = JSON.parse(typeof result === 'string' ? result : result.content);
  expect(payload).toEqual({ thread_id: task.threadId, status: 'archived' });
  expect(current.store.getThread(ownerId, task.threadId).archivedAt).not.toBeNull();
});

it('clears a workspace main context instead of archiving it', async () => {
  const current = fixture();
  const workspace = current.store.createWorkspace({
    ownerId,
    name: '项目',
    envId: 'main',
    path: '/srv/project',
  });
  const mainId = workspace.mainThread.threadId;
  const tool = createThreadArchiveTool(toolOptions(current.store, current.run));
  const result = await tool.execute(
    await tool.validate({ thread_id: mainId }),
    context('archive-ws-main'),
  );
  const payload = JSON.parse(typeof result === 'string' ? result : result.content);
  expect(payload.status).toBe('context_cleared');
  expect(payload.thread_id).toBe(mainId);
  expect(payload.main_thread_id).toBeTruthy();
  expect(payload.main_thread_id).not.toBe(mainId);
  expect(current.store.getThread(ownerId, mainId).archivedAt).not.toBeNull();
  const successor = current.store.getThread(ownerId, payload.main_thread_id as string);
  expect(successor.threadType).toBe('workspace_main');
  expect(successor.archivedAt).toBeNull();
  expect(successor.workspaceId).toBe(workspace.workspace.workspaceId);
});

it('scopes a workspace main to its own workspace Threads', async () => {
  const current = fixture();
  const workspaceA = current.store.createWorkspace({
    ownerId,
    name: 'A',
    envId: 'main',
    path: '/srv/a',
  });
  const workspaceB = current.store.createWorkspace({
    ownerId,
    name: 'B',
    envId: 'main',
    path: '/srv/b',
  });
  const foreignTask = taskThread(current.store, 'B 的任务', workspaceB.workspace.workspaceId);
  const aMainId = current.store.workspaceMainThreadId(ownerId, workspaceA.workspace.workspaceId);
  if (!aMainId) throw new Error('Workspace A main is missing.');
  const sent = current.store.sendMessage({
    ownerId,
    clientActionId: 'a-main-run',
    method: 'SendMessage',
    parameters: { threadId: aMainId, text: '归档', mode: 'follow_up' },
    threadId: aMainId,
    text: '归档',
    mode: 'follow_up',
  });
  const tool = createThreadArchiveTool(
    toolOptions(current.store, current.store.getRunById(sent.runId)),
  );
  await expect(
    tool.execute(
      await tool.validate({ thread_id: foreignTask.threadId }),
      context('archive-foreign'),
    ),
  ).rejects.toThrow('its own workspace');
  const ownTask = taskThread(current.store, 'A 的任务', workspaceA.workspace.workspaceId);
  const ownResult = await tool.execute(
    await tool.validate({ thread_id: ownTask.threadId }),
    context('archive-own-task'),
  );
  expect(JSON.parse(typeof ownResult === 'string' ? ownResult : ownResult.content).status).toBe(
    'archived',
  );
  await expect(
    tool.execute(await tool.validate({ thread_id: aMainId }), context('archive-busy-main')),
  ).rejects.toThrow('active root Run');
});

it('rejects archiving the global main conversation', async () => {
  const current = fixture();
  const tool = createThreadArchiveTool(toolOptions(current.store, current.run));
  await expect(
    tool.execute(
      await tool.validate({ thread_id: current.main.threadId }),
      context('archive-main'),
    ),
  ).rejects.toThrow('global main');
});

it('deletes a workspace from the global main and rejects workspace main sources', async () => {
  const current = fixture();
  const workspace = current.store.createWorkspace({
    ownerId,
    name: '待删除',
    envId: 'main',
    path: '/srv/remove-me',
  });
  const tool = createWorkspaceDeleteTool(toolOptions(current.store, current.run));
  const result = await tool.execute(
    await tool.validate({ workspace_id: workspace.workspace.workspaceId }),
    context('delete-1'),
  );
  expect(JSON.parse(typeof result === 'string' ? result : result.content)).toEqual({
    workspace_id: workspace.workspace.workspaceId,
    status: 'deleted',
  });
  expect(current.store.listWorkspaces(ownerId)).toHaveLength(0);

  const other = current.store.createWorkspace({
    ownerId,
    name: '另一个',
    envId: 'main',
    path: '/srv/another',
  });
  const otherMainId = current.store.workspaceMainThreadId(ownerId, other.workspace.workspaceId);
  if (!otherMainId) throw new Error('Workspace main is missing.');
  const sent = current.store.sendMessage({
    ownerId,
    clientActionId: 'other-main-run',
    method: 'SendMessage',
    parameters: { threadId: otherMainId, text: '删除', mode: 'follow_up' },
    threadId: otherMainId,
    text: '删除',
    mode: 'follow_up',
  });
  const workspaceMainTool = createWorkspaceDeleteTool(
    toolOptions(current.store, current.store.getRunById(sent.runId)),
  );
  await expect(
    workspaceMainTool.execute(
      await workspaceMainTool.validate({ workspace_id: other.workspace.workspaceId }),
      context('delete-2'),
    ),
  ).rejects.toThrow('Only the global main');
});
