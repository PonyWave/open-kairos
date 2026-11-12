import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Code, createClient, createRouterTransport } from '@connectrpc/connect';
import {
  ContextService,
  validateReloadResourcesResponse,
  WorkspaceService,
} from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { DeviceBashStore } from '../devices/operation-store.js';
import type { WorkspaceResourceSource } from '../integration/environment-fixture.js';
import {
  controlledEnvironmentDependencies,
  createEnvironmentThreadClient,
  seedTestEnvironment,
} from '../integration/environment-fixture.js';
import {
  createTestAuthentication,
  testSessionInterceptor,
} from '../integration/test-authentication.js';
import { WorkspaceResourceLoader } from '../integration/workspace-resource-loader.js';
import { RunCoordinator } from '../sessions/runtime.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import type { WorkspaceResourceSnapshot } from '../workspace/index.js';
import { registerGuiRoutes } from './connect.js';
import { BashLogReader } from './logs.js';

const ownerId = 'local-user';

function snapshot(id: string): WorkspaceResourceSnapshot {
  return Object.freeze({
    snapshotId: id,
    systemInstructions: `workspace ${id}`,
    resources: Object.freeze([Object.freeze({ path: 'AGENTS.md', content: `instructions ${id}` })]),
  });
}

async function fixture(loader: WorkspaceResourceSource) {
  const database = openDatabase(':memory:');
  seedTestEnvironment(database, ownerId);
  const store = new SessionStore(database);
  const operations = new DeviceBashStore(database);
  const dependencies = controlledEnvironmentDependencies(store.database, ownerId);
  dependencies.environmentOperations.loadResources = () => loader.load();
  const coordinator = new RunCoordinator({
    ...dependencies,
    store,
  });
  const main = store.getOrCreateMainThread(ownerId);
  await coordinator.reloadResources({
    ownerId,
    threadId: main.threadId,
    clientActionId: 'fixture-initial-resources',
  });
  const transport = createRouterTransport(
    (router) =>
      registerGuiRoutes(router, {
        store,
        coordinator,
        operations,
        logs: new BashLogReader({ store, operations }),
        modelStatus: {
          providerId: '',
          modelId: '',
          contextCapacity: 1,
          outputReserve: 1,
          available: false,
          configurationErrors: [{ code: 'model_not_configured', message: 'No model.' }],
        },
        authentication: createTestAuthentication(database, ownerId),
      }),
    { transport: { interceptors: [testSessionInterceptor()] } },
  );
  return {
    database,
    store,
    coordinator,
    workspace: createClient(WorkspaceService, transport),
    threads: createEnvironmentThreadClient(transport),
    context: createClient(ContextService, transport),
  };
}

async function cleanup(current: Awaited<ReturnType<typeof fixture>>, directory: string) {
  await current.coordinator.close();
  current.database.close();
  await rm(directory, { recursive: true, force: true });
}

it('returns only workspace-relative resource paths and validates ReloadResources requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-reload-connect-'));
  await mkdir(join(directory, '.agents', 'skills', 'alpha'), { recursive: true });
  await writeFile(join(directory, 'AGENTS.md'), 'old instructions');
  await writeFile(join(directory, '.agents', 'skills', 'alpha', 'SKILL.md'), 'old skill');
  const current = await fixture(new WorkspaceResourceLoader(directory));
  try {
    const created = current.store.getOrCreateMainThread(ownerId);
    const other = await current.threads.createThread({
      clientActionId: 'create-other',
      title: 'Other',
    });
    const threadId = created.threadId;
    const otherThreadId = other.thread?.threadId ?? '';
    await writeFile(join(directory, 'AGENTS.md'), 'new instructions');
    await rm(join(directory, '.agents', 'skills', 'alpha'), { recursive: true });
    await mkdir(join(directory, '.agents', 'skills', 'beta'), { recursive: true });
    await writeFile(join(directory, '.agents', 'skills', 'beta', 'SKILL.md'), 'new skill');

    const request = { threadId, clientActionId: 'reload-1' };
    const response = await current.workspace.reloadResources(request);
    expect(response).toMatchObject({
      changed: true,
      resources: ['.agents/skills/beta/SKILL.md', 'AGENTS.md'],
      added: ['.agents/skills/beta/SKILL.md'],
      updated: ['AGENTS.md'],
      removed: ['.agents/skills/alpha/SKILL.md'],
    });
    expect(response.snapshotId).toMatch(/^[a-f0-9]{64}$/);
    expect(() => validateReloadResourcesResponse(response)).not.toThrow();
    expect(JSON.stringify(response)).not.toContain('new instructions');
    expect(JSON.stringify(response)).not.toContain(directory);
    expect(await current.workspace.reloadResources(request)).toEqual(response);
    expect(
      await current.workspace.reloadResources({ threadId, clientActionId: 'reload-unchanged' }),
    ).toMatchObject({ changed: false, added: [], updated: [], removed: [] });

    await expect(
      current.workspace.reloadResources({ threadId: '', clientActionId: 'invalid-thread' }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(
      current.workspace.reloadResources({ threadId, clientActionId: '' }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(
      current.workspace.reloadResources({ threadId: 'missing', clientActionId: 'missing-thread' }),
    ).rejects.toMatchObject({ code: Code.NotFound });
    await expect(
      current.workspace.reloadResources({ threadId: otherThreadId, clientActionId: 'reload-1' }),
    ).rejects.toMatchObject({ code: Code.AlreadyExists });
    await expect(current.context.compactContext(request)).rejects.toMatchObject({
      code: Code.AlreadyExists,
    });
    expect(current.store.listInputs(ownerId, threadId)).toEqual([]);
    expect(current.store.listRuns(ownerId, threadId)).toEqual([]);
    expect(current.store.listContext(ownerId, threadId, 'thread')).toEqual([]);
    expect(current.store.listRecaps(ownerId, threadId, 'thread')).toEqual([]);
  } finally {
    await cleanup(current, directory);
  }
});

it('returns optional runtime fields through Connect without inventing a root Run or baseline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-reload-runtime-connect-'));
  const current = await fixture(new WorkspaceResourceLoader(directory));
  try {
    const empty = current.store.getOrCreateMainThread(ownerId);
    const emptyResult = await current.workspace.reloadResources({
      threadId: empty.threadId,
      clientActionId: 'reload-empty-runtime',
    });
    expect(emptyResult.runtimeFingerprint).toBeUndefined();
    expect(emptyResult.runtimeChanged).toBeUndefined();

    const created = current.store.sendMessage({
      ownerId,
      clientActionId: 'create-root-runtime',
      method: 'SendMessage',
      parameters: { threadId: empty.threadId, text: 'pending', mode: 'follow_up' },
      threadId: empty.threadId,
      text: 'pending',
      mode: 'follow_up',
    });
    current.store.appendModelMessage({
      runId: created.runId,
      inputId: created.input.inputId,
      message: { role: 'user', content: created.input.text },
    });
    current.store.updateRunStatus(created.runId, 'interrupted');
    const result = await current.workspace.reloadResources({
      threadId: empty.threadId,
      clientActionId: 'reload-root-runtime',
    });
    expect(result.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.runtimeChanged).toBeUndefined();
    expect(() => validateReloadResourcesResponse(result)).not.toThrow();
  } finally {
    await cleanup(current, directory);
  }
});

it('finishes a disconnected reload and replays the same server result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-reload-disconnect-'));
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const loader = {
    load: vi.fn(async () => {
      calls += 1;
      if (calls === 1) return snapshot('old');
      await gate;
      return snapshot('new');
    }),
  };
  const current = await fixture(loader);
  try {
    const created = current.store.getOrCreateMainThread(ownerId);
    const request = {
      threadId: created.threadId,
      clientActionId: 'reload-disconnect',
    };
    const controller = new AbortController();
    const disconnected = current.workspace.reloadResources(request, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(disconnected).rejects.toMatchObject({ code: Code.Canceled });
    release();
    await vi.waitFor(() => {
      const row = current.store.database
        .prepare(
          "SELECT response_json FROM client_actions WHERE client_action_id = 'reload-disconnect'",
        )
        .get() as { response_json: string };
      expect(row.response_json).toContain('completed');
    });
    expect(await current.workspace.reloadResources(request)).toMatchObject({
      snapshotId: expect.stringMatching(/^[a-f0-9]{64}$/),
      changed: true,
      resources: ['AGENTS.md'],
      updated: ['AGENTS.md'],
    });
    expect(loader.load).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await cleanup(current, directory);
  }
});
