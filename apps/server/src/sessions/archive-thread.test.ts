import { expect, it } from 'vitest';
import { controlledEnvironmentDependencies } from '../integration/environment-fixture.js';
import { openDatabase } from '../storage/database.js';
import { SessionStore } from './store.js';

const ownerId = 'archive-owner';

function action<T extends Record<string, unknown>>(
  method: string,
  clientActionId: string,
  parameters: T,
) {
  return { ownerId, clientActionId, method, parameters, ...parameters };
}

function fixture() {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  controlledEnvironmentDependencies(database, ownerId);
  store.getOrCreateMainThread(ownerId);
  return { database, store };
}

function createTask(store: SessionStore, clientActionId: string, title = '归档候选') {
  return store.createThread(
    action('CreateThread', clientActionId, {
      title,
      environmentPolicy: { allowedEnv: ['main'], policyVersion: 1n },
    }),
  );
}

it('archives a task conversation, hides it from lists and recall scope, and restores it', () => {
  const { store } = fixture();
  const task = createTask(store, 'archive-1');
  store.archiveThread(action('ArchiveThread', 'archive-2', { threadId: task.threadId }));

  expect(store.listThreads(ownerId, 0n, 50, 'task')).toEqual([]);
  const archived = store.listArchivedThreads(ownerId, 0n, 50);
  expect(archived.map((thread) => thread.threadId)).toEqual([task.threadId]);
  expect(() =>
    store.sendMessage(
      action('SendMessage', 'archive-3', {
        threadId: task.threadId,
        text: '继续',
        mode: 'follow_up' as const,
      }),
    ),
  ).toThrow();

  const restored = store.restoreThread(
    action('RestoreThread', 'archive-4', { threadId: task.threadId }),
  );
  expect(restored.archivedAt ?? null).toBeNull();
  expect(store.listThreads(ownerId, 0n, 50, 'task').map((thread) => thread.threadId)).toEqual([
    task.threadId,
  ]);
  expect(store.listArchivedThreads(ownerId, 0n, 50)).toEqual([]);
});

it('rejects archiving main conversations, archived duplicates and active runs', () => {
  const { store } = fixture();
  const main = store.getOrCreateMainThread(ownerId);
  expect(() =>
    store.archiveThread(action('ArchiveThread', 'archive-5', { threadId: main.threadId })),
  ).toThrow('Only task conversations');

  const task = createTask(store, 'archive-6');
  store.archiveThread(action('ArchiveThread', 'archive-7', { threadId: task.threadId }));
  expect(() =>
    store.archiveThread(action('ArchiveThread', 'archive-8', { threadId: task.threadId })),
  ).toThrow('already archived');
  expect(() =>
    store.deleteArchivedThread(action('DeleteThread', 'archive-9', { threadId: main.threadId })),
  ).toThrow();

  const running = store.createThread(
    action('CreateThread', 'archive-10', {
      title: '执行中',
      initialText: '跑起来',
      initialMode: 'follow_up' as const,
      environmentPolicy: { allowedEnv: ['main'], policyVersion: 1n },
    }),
  );
  expect(() =>
    store.archiveThread(
      action('ArchiveThread', 'archive-11', { threadId: running.thread.threadId }),
    ),
  ).toThrow();
});

it('permanently deletes an archived conversation and its records', () => {
  const { store, database } = fixture();
  const task = createTask(store, 'archive-12');
  store.archiveThread(action('ArchiveThread', 'archive-13', { threadId: task.threadId }));
  const result = store.deleteArchivedThread(
    action('DeleteThread', 'archive-14', { threadId: task.threadId }),
  );
  expect(result.threadId).toBe(task.threadId);
  expect(store.listArchivedThreads(ownerId, 0n, 50)).toEqual([]);
  expect(
    database
      .prepare('SELECT COUNT(*) AS count FROM threads WHERE thread_id = ?')
      .get(task.threadId),
  ).toMatchObject({ count: 0 });
});

it('replaces a workspace main conversation and archives the previous one', () => {
  const { store } = fixture();
  const created = store.createWorkspace({
    ownerId,
    name: '空间',
    envId: 'main',
    path: '/srv/space',
  });
  const previous = created.mainThread;
  const next = store.startNewMain(
    action('StartNewMain', 'archive-15', { threadId: previous.threadId }),
  );
  expect(next.threadId).not.toBe(previous.threadId);
  expect(next.threadType).toBe('workspace_main');
  expect(next.workspaceId).toBe(created.workspace.workspaceId);
  expect(next.newConversation).toBe(true);
  expect(store.getThread(ownerId, previous.threadId).archivedAt).toBeTruthy();
  expect(store.workspaceMainThreadId(ownerId, created.workspace.workspaceId)).toBe(next.threadId);
});
