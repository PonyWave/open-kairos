import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createRouterTransport } from '@connectrpc/connect';
import { WorkspacesService } from '@kairos/contracts';
import { expect, it } from 'vitest';
import { registerWorkspacesRoutes } from '../api/workspaces.js';
import { AutomationStore } from '../automation/store.js';
import { seedTestTenant } from '../integration/environment-fixture.js';
import {
  createTestAuthentication,
  testSessionInterceptor,
} from '../integration/test-authentication.js';
import { openDatabase } from '../storage/database.js';
import { SessionStore } from './store.js';

const ownerId = 'owner-1';
function fixture() {
  const db = openDatabase(':memory:');
  const store = new SessionStore(db, {
    mainEnvironment: { envId: 'main', workspace: '/workspace' },
  });
  seedTestTenant(db, ownerId);
  const workspace = store.createWorkspace({
    ownerId,
    name: '项目',
    description: '设计与实现',
    envId: 'main',
    path: '/workspace/demo',
  });
  const remove = (spaceId = workspace.workspace.workspaceId, owner = ownerId) =>
    store.deleteWorkspace({
      ownerId: owner,
      method: 'DeleteWorkspace',
      clientActionId: 'delete-workspace',
      parameters: { workspaceId: spaceId },
      workspaceId: spaceId,
    });
  return { db, store, workspace, remove };
}
it('persists description and visibility, and renames the workspace main in the same transaction', () => {
  const { db, store, workspace } = fixture();
  try {
    const value = store.updateWorkspace({
      ownerId,
      workspaceId: workspace.workspace.workspaceId,
      name: '新空间',
      description: '新描述',
      hidden: true,
    });
    expect(value).toMatchObject({ name: '新空间', description: '新描述', hidden: true });
    expect(store.getThread(ownerId, workspace.mainThread.threadId).title).toBe('新空间');
    expect(new SessionStore(db).getWorkspace(ownerId, value.workspaceId)).toEqual(value);
    expect(store.listWorkspaces(ownerId)).toHaveLength(1);
    expect(() =>
      store.updateWorkspace({ ownerId: 'another', workspaceId: value.workspaceId, hidden: false }),
    ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
  } finally {
    db.close();
  }
});

it('deletes conversation records transactionally while retaining other spaces and device files', () => {
  const { db, store, workspace, remove } = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'kairos-workspace-delete-'));
  try {
    const keep = store.createWorkspace({
      ownerId,
      name: '保留空间',
      envId: 'main',
      path: '/workspace/keep',
    });
    writeFileSync(join(dir, 'source.txt'), '保留文件');
    // The workspace being removed points at a real directory; no filesystem cleanup is allowed.
    db.prepare('UPDATE workspaces SET path=? WHERE workspace_id=?').run(
      dir,
      workspace.workspace.workspaceId,
    );
    const created = store.createThread({
      ownerId,
      method: 'CreateThread',
      clientActionId: 'task',
      parameters: {},
      title: '任务',
      workspaceId: workspace.workspace.workspaceId,
      initialText: '请求',
      initialMode: 'follow_up',
    });
    if (!('runId' in created)) throw new Error('Expected execution');
    db.prepare("UPDATE runs SET status='completed' WHERE run_id=?").run(created.runId);
    const msg = store.context.append({
      threadId: created.thread.threadId,
      agentId: 'thread',
      runId: created.runId,
      message: {
        role: 'assistant',
        content: '已执行',
        tool_calls: [{ id: 'call1', name: 'read', arguments: { path: 'README.md' } }],
      },
    });
    const result = store.context.append({
      threadId: created.thread.threadId,
      agentId: 'thread',
      runId: created.runId,
      message: { role: 'tool', content: '正文', tool_call_id: 'call1', tool_name: 'read' },
    });
    store.context.append({
      threadId: keep.mainThread.threadId,
      agentId: 'thread',
      message: { role: 'user', content: '其他对话' },
    });
    store.recaps.save({
      threadId: created.thread.threadId,
      agentId: 'thread',
      sourceMessageSeqs: [msg.seq, result.seq],
      content: '摘要',
    });
    expect(remove()).toEqual({ workspaceId: workspace.workspace.workspaceId });
    expect(remove()).toEqual({ workspaceId: workspace.workspace.workspaceId });
    expect(() => store.getWorkspace(ownerId, workspace.workspace.workspaceId)).toThrowError(
      expect.objectContaining({ code: 'not_found' }),
    );
    expect(() => store.getThread(ownerId, created.thread.threadId)).toThrowError(
      expect.objectContaining({ code: 'not_found' }),
    );
    expect(db.prepare('SELECT content FROM context_messages').all()).toEqual([
      { content: '其他对话' },
    ]);
    expect(db.prepare('SELECT * FROM runs').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM recaps').all()).toHaveLength(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(readFileSync(join(dir, 'source.txt'), 'utf8')).toBe('保留文件');
    expect(store.listWorkspaces(ownerId).map((w) => w.workspaceId)).toEqual([
      keep.workspace.workspaceId,
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rejects active execution, foreign ownership and automation targets without deleting any data', () => {
  const { db, store, workspace, remove } = fixture();
  try {
    const task = store.createThread({
      ownerId,
      method: 'CreateThread',
      clientActionId: 'pending-task',
      parameters: {},
      title: '任务',
      workspaceId: workspace.workspace.workspaceId,
      initialText: '等待执行',
      initialMode: 'follow_up',
    });
    if (!('runId' in task)) throw new Error('Expected execution');
    expect(() => remove()).toThrowError(/正在执行/);
    expect(() => remove(workspace.workspace.workspaceId, 'another')).toThrowError(
      expect.objectContaining({ code: 'permission_denied' }),
    );
    expect(store.getThread(ownerId, task.thread.threadId).title).toBe('任务');
    db.prepare("UPDATE runs SET status='completed' WHERE run_id=?").run(task.runId);
    const schedules = new AutomationStore(store);
    const a = schedules.create({
      ownerId,
      clientActionId: 'schedule',
      name: '提醒',
      prompt: '检查',
      enabled: false,
      schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' },
      target: { kind: 'existing_thread', threadId: task.thread.threadId },
    });
    expect(() => remove()).toThrowError(/定时任务/);
    schedules.delete({
      ownerId,
      clientActionId: 'delete-schedule',
      scheduleId: a.scheduleId,
      expectedVersion: BigInt(a.version),
    });
    expect(remove()).toEqual({ workspaceId: workspace.workspace.workspaceId });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db.close();
  }
});

it('exposes editable workspace fields through RPC and rejects malformed fields', async () => {
  const { db, store, workspace } = fixture();
  try {
    const authentication = createTestAuthentication(db, ownerId);
    const client = createClient(
      WorkspacesService,
      createRouterTransport(
        (router) => registerWorkspacesRoutes(router, { store, authentication }),
        { transport: { interceptors: [testSessionInterceptor()] } },
      ),
    );
    const changed = await client.updateWorkspace({
      clientActionId: 'u',
      workspaceId: workspace.workspace.workspaceId,
      name: '工程',
      description: '说明',
      hidden: true,
    });
    expect(changed.workspace).toMatchObject({ name: '工程', description: '说明', hidden: true });
    const listed = await client.listWorkspaces({});
    expect(listed.workspaces[0]?.hidden).toBe(true);
    await expect(
      client.updateWorkspace({
        clientActionId: 'bad',
        workspaceId: workspace.workspace.workspaceId,
        description: 'x'.repeat(2001),
      }),
    ).rejects.toThrow();
    await expect(
      client.updateWorkspace({
        clientActionId: 'bad2',
        workspaceId: workspace.workspace.workspaceId,
        name: ' ',
      }),
    ).rejects.toThrow();
    await client.deleteWorkspace({
      clientActionId: 'remove',
      workspaceId: workspace.workspace.workspaceId,
    });
    expect((await client.listWorkspaces({})).workspaces).toEqual([]);
  } finally {
    db.close();
  }
});
