import { expect, it } from 'vitest';
import { controlledEnvironmentDependencies } from '../integration/environment-fixture.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { createWorkspaceCreateTool } from './delegation.js';

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
  const tool = createWorkspaceCreateTool({ store: current.store, source: current.run });
  const result = await tool.execute(tool.validate(createInput), context('create-1'));
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
  const tool = createWorkspaceCreateTool({ store: current.store, source: current.run });
  expect(() => tool.validate({ ...createInput, path: 'relative/path' })).toThrow('absolute');

  await tool.execute(tool.validate(createInput), context('create-1'));
  await expect(
    tool.execute(tool.validate({ ...createInput, name: '重复' }), context('create-2')),
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
  const workspaceMainTool = createWorkspaceCreateTool({
    store: current.store,
    source: current.store.getRunById(sent.runId),
  });
  await expect(
    workspaceMainTool.execute(
      workspaceMainTool.validate({ ...createInput, path: '/srv/other' }),
      context('create-3'),
    ),
  ).rejects.toThrow('Only the global main');
});
