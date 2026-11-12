import type { ModelEvent, ToolCall } from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import { DeviceCapability, OperationStatus } from '@kairos/contracts/device';
import { expect, it, vi } from 'vitest';
import { ModelInputService } from '../context/model-input-service.js';
import { EnvironmentStore } from '../devices/environment-store.js';
import { StandaloneDeviceUseGateway } from '../devices/standalone-device.js';
import {
  controlledEnvironmentDependencies,
  seedTestEnvironment,
  seedTestTenant,
} from '../integration/environment-fixture.js';
import { openDatabase } from '../storage/database.js';
import { createWorkspaceResourceSnapshot } from '../workspace/index.js';
import { AgentEnvironmentRuntime } from './environment-runtime.js';
import { RunCoordinator } from './runtime.js';
import { SessionStore } from './store.js';

const ownerId = 'execution-tenant';
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
function response(content: string, toolCalls?: ToolCall[]): ModelEvent[] {
  return [
    {
      type: 'response',
      message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      usage,
    },
  ];
}
function action<T extends Record<string, unknown>>(
  method: string,
  clientActionId: string,
  parameters: T,
) {
  return { ownerId, method, clientActionId, parameters, ...parameters };
}
function fixture(script: ModelEvent[][] = [response('done')]) {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  const dependencies = controlledEnvironmentDependencies(database, ownerId);
  const provider = new ScriptedProvider(script);
  const coordinator = new RunCoordinator({
    store,
    ...dependencies,
    model: {
      provider,
      providerId: 'test',
      modelId: 'test',
      contextWindowTokens: 128000,
      outputReserveTokens: 4096,
    },
    browser: false,
  });
  const close = async () => {
    await coordinator.close();
    database.close();
  };
  return { database, store, provider, coordinator, ...dependencies, close };
}
const standaloneDevice = { envId: 'cvm-device', workspace: '/workspace' } as const;
function standaloneFixture(script: ModelEvent[][] = [response('done')]) {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database, { standaloneDevice });
  const dependencies = controlledEnvironmentDependencies(database, ownerId);
  const provider = new ScriptedProvider(script);
  const platformUse = new StandaloneDeviceUseGateway(
    dependencies.environments,
    dependencies.environmentOperations,
    standaloneDevice,
  );
  const coordinator = new RunCoordinator({
    store,
    environments: dependencies.environments,
    environmentOperations: dependencies.environmentOperations,
    platformUse,
    model: {
      provider,
      providerId: 'test',
      modelId: 'test',
      contextWindowTokens: 128000,
      outputReserveTokens: 4096,
    },
    browser: false,
  });
  const close = async () => {
    await coordinator.close();
    database.close();
  };
  return { database, store, provider, coordinator, ...dependencies, platformUse, close };
}
function send(store: SessionStore, threadId: string, id = 'send') {
  return store.sendMessage(
    action('SendMessage', id, { threadId, text: 'perform work', mode: 'follow_up' as const }),
  );
}
async function completed(store: SessionStore, runId: string) {
  await vi.waitFor(() => expect(store.getRunById(runId).status).toBe('completed'));
}

it('fixes main and task workspaces to the sandbox without reserving capacity and preserves device authorization', async () => {
  const f = fixture();
  try {
    const main = f.store.getOrCreateMainThread(ownerId);
    const task = f.store.createThread(action('CreateThread', 'task', { title: 'platform task' }));
    expect(main.currentBinding?.pwd).toBe('/workspace');
    expect(task.currentBinding?.envId).toBe(main.currentBinding?.envId);
    seedTestEnvironment(f.database, ownerId, 'device', '/project');
    f.database
      .prepare('UPDATE tenants SET default_env_id=? WHERE tenant_id=?')
      .run('device', ownerId);
    expect(f.store.getOrCreateMainThread(ownerId).currentBinding?.envId).toBe(
      main.currentBinding?.envId,
    );
    const device = f.store.createThread(
      action('CreateThread', 'device-task', {
        title: 'device',
        environmentPolicy: { allowedEnv: ['device'] },
      }),
    );
    expect(device.currentBinding).toMatchObject({
      envId: main.currentBinding?.envId,
      pwd: '/workspace',
    });
    expect(device.environmentPolicy?.allowedEnv).toEqual([main.currentBinding?.envId, 'device']);
    expect(f.platformUse.reserved).toHaveLength(0);
    expect(f.environmentOperations.started).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it('routes concurrent env_id calls independently and keeps subsequent paths and instructions at the fixed default', async () => {
  const f = fixture([
    response('', [
      { id: 'other', name: 'read', arguments: { env_id: 'two', path: 'other.txt' } },
      { id: 'default', name: 'read', arguments: { path: 'default.txt' } },
      {
        id: 'bad-cwd',
        name: 'bash',
        arguments: { env_id: 'two', command: 'pwd', cwd: 'relative' },
      },
    ]),
    response('', [{ id: 'after', name: 'bash', arguments: { command: 'pwd' } }]),
    response('done'),
  ]);
  try {
    seedTestEnvironment(f.database, ownerId, 'one', '/one');
    seedTestEnvironment(f.database, ownerId, 'two', '/two');
    const task = f.store.createThread(
      action('CreateThread', 'task', {
        title: 'devices',
        environmentPolicy: { allowedEnv: ['one', 'two'] },
      }),
    );
    const input = send(f.store, task.threadId);
    await f.coordinator.deliver(input.input, input.runId);
    await completed(f.store, input.runId);
    const operations = f.environmentOperations.started.filter(
      (entry) => entry.action.case !== 'directoryCheck',
    );
    expect(
      operations.map((entry) => [
        entry.envId,
        'cwd' in entry.action.value ? entry.action.value.cwd : undefined,
      ]),
    ).toEqual([
      ['two', '/two'],
      [task.currentBinding?.envId, '/workspace'],
      [task.currentBinding?.envId, '/workspace'],
    ]);
    expect(operations[0]?.action).toMatchObject({
      case: 'read',
      value: { path: '/two/other.txt' },
    });
    expect(operations[1]?.action).toMatchObject({
      case: 'read',
      value: { path: '/workspace/default.txt' },
    });
    expect(f.platformUse.reserved.some((use) => use.envId === task.currentBinding?.envId)).toBe(
      true,
    );
    for (const request of f.provider.requests) {
      expect(request.tools.some((tool) => tool.name === 'env_switch')).toBe(false);
      expect(
        JSON.stringify(request.messages.filter((message) => message.role === 'system')),
      ).toContain('/workspace');
    }
    const stored = f.database
      .prepare(
        "SELECT env_id,resolved_action_json FROM agent_environment_operations WHERE tool_call_id='other'",
      )
      .get();
    expect(stored?.env_id).toBe('two');
    expect(JSON.parse(String(stored?.resolved_action_json))).toMatchObject({
      value: { cwd: '/two', path: '/two/other.txt' },
    });
    f.database
      .prepare(
        "UPDATE environments SET recommended_pwd='/changed',normalized_pwd='/changed' WHERE env_id='two'",
      )
      .run();
    const runtime = new AgentEnvironmentRuntime({
      store: f.store,
      environments: f.environments,
      operations: f.environmentOperations,
      platformUse: f.platformUse,
    });
    const count = f.environmentOperations.started.length;
    expect((await runtime.savedResult(input.runId, 'other'))?.content).toContain('/two/other.txt');
    expect(f.environmentOperations.started).toHaveLength(count);
  } finally {
    await f.close();
  }
});

it('persists capacity failure on the accepted Run and only retries a new Continue generation', async () => {
  const f = fixture();
  try {
    const main = f.store.getOrCreateMainThread(ownerId);
    f.platformUse.capacity = 0;
    const accepted = send(f.store, main.threadId);
    await f.coordinator.deliver(accepted.input, accepted.runId);
    expect(f.store.getRunById(accepted.runId)).toMatchObject({
      status: 'failed',
      error: { code: 'sandbox_capacity_exhausted' },
    });
    expect(f.store.listQueuedInputs(main.threadId)).toHaveLength(0);
    expect(
      f.store.listContext(ownerId, main.threadId, 'thread').map((message) => message.message.role),
    ).toEqual(['user']);
    expect(f.provider.requests).toHaveLength(0);
    f.platformUse.capacity = 1;
    const replay = send(f.store, main.threadId);
    await f.coordinator.deliver(replay.input, replay.runId);
    expect(replay.runId).toBe(accepted.runId);
    expect(f.store.listRuns(ownerId, main.threadId)).toHaveLength(1);
    expect(f.provider.requests).toHaveLength(0);
    const continued = f.store.continueRun(
      action('ContinueRun', 'continue', { threadId: main.threadId, runId: accepted.runId }),
    );
    f.coordinator.schedule(main.threadId, continued.runId);
    await completed(f.store, continued.runId);
    expect(continued.generation).toBe(2);
    expect(f.provider.requests).toHaveLength(1);
    expect(f.store.agentEnvironments.getExecution(continued.runId, 1)?.resourceVersion).toBeNull();
    expect(f.store.agentEnvironments.getExecution(continued.runId, 2)?.resourceVersion).toMatch(
      /^[a-f0-9]{64}$/,
    );
    await vi.waitFor(() => expect(f.platformUse.uses.size).toBe(0));
  } finally {
    await f.close();
  }
});

it('does not call Provider while an accepted default workspace is preparing and releases a cancelled preparation', async () => {
  const f = fixture();
  try {
    const main = f.store.getOrCreateMainThread(ownerId);
    f.platformUse.prepare = ({ signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    const input = send(f.store, main.threadId);
    await f.coordinator.deliver(input.input, input.runId);
    expect(f.platformUse.uses.size).toBe(1);
    expect(f.provider.requests).toHaveLength(0);
    const cancelled = f.store.requestCancelRun(
      action('CancelRun', 'cancel', {
        threadId: main.threadId,
        runId: input.runId,
        reason: 'cancel preparation',
      }),
    );
    await f.coordinator.cancel(cancelled, 'cancel preparation');
    await vi.waitFor(() => expect(f.store.getRunById(input.runId).status).toBe('cancelled'));
    await vi.waitFor(() => expect(f.platformUse.uses.size).toBe(0));
    expect(f.provider.requests).toHaveLength(0);
    expect(f.environmentOperations.started).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it('reloads the fixed main workspace before the first Run and preserves resources on capacity failure', async () => {
  const f = fixture();
  try {
    const main = f.store.getOrCreateMainThread(ownerId);
    const loaded = await f.coordinator.reloadResources({
      ownerId,
      threadId: main.threadId,
      clientActionId: 'reload',
    });
    expect(loaded.resources).toEqual(['AGENTS.md']);
    expect(f.store.listRuns(ownerId, main.threadId)).toHaveLength(0);
    const previous = f.store.agentEnvironments.requirePolicy(
      main.threadId,
      'thread',
    ).currentHistoryId;
    f.platformUse.capacity = 0;
    await expect(
      f.coordinator.reloadResources({
        ownerId,
        threadId: main.threadId,
        clientActionId: 'reload-full',
      }),
    ).rejects.toMatchObject({ code: 'sandbox_capacity_exhausted', terminal: true });
    expect(f.store.agentEnvironments.requirePolicy(main.threadId, 'thread').currentHistoryId).toBe(
      previous,
    );
    f.platformUse.capacity = 1;
    await expect(
      f.coordinator.reloadResources({
        ownerId,
        threadId: main.threadId,
        clientActionId: 'reload-full',
      }),
    ).rejects.toMatchObject({ code: 'sandbox_capacity_exhausted' });
    expect(f.environmentOperations.started).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('inherits a caller execution scope and rejects environments registered after that execution was fixed', async () => {
  const f = fixture();
  try {
    const main = f.store.getOrCreateMainThread(ownerId);
    const input = send(f.store, main.threadId);
    const parent = f.store.getRunById(input.runId);
    seedTestEnvironment(f.database, ownerId, 'later', '/later');
    const child = f.store.createChildRun(ownerId, parent.runId, 'subagent-child');
    const inherited = f.store.agentEnvironments.requireExecution(child);
    expect(inherited.defaultEnv).toBe(main.currentBinding?.envId);
    expect(inherited.defaultPwd).toBe('/workspace');
    expect(inherited.allowedEnv).not.toContain('later');
    const runtime = new AgentEnvironmentRuntime({
      store: f.store,
      environments: f.environments,
      operations: f.environmentOperations,
      platformUse: f.platformUse,
    });
    await expect(
      runtime.execute(
        child,
        { case: 'read', value: { path: 'private', cwd: '' } },
        'forbidden',
        new AbortController().signal,
        { envId: 'later' },
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    expect(f.environmentOperations.started).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it('keeps env_list and main-environment events free of lifecycle side effects', async () => {
  const f = fixture();
  try {
    const main = f.store.getOrCreateMainThread(ownerId);
    const input = send(f.store, main.threadId);
    const runtime = new AgentEnvironmentRuntime({
      store: f.store,
      environments: f.environments,
      operations: f.environmentOperations,
      platformUse: f.platformUse,
    });
    const catalog = JSON.parse(runtime.list(f.store.getRunById(input.runId)));
    expect(catalog.environments).toContainEqual(
      expect.objectContaining({
        env_id: 'sandbox',
        name: 'sandbox',
        is_main: true,
        lifecycle_state: 'uninitialized',
      }),
    );
    const environment = f.environments.get(ownerId, main.currentBinding?.envId ?? '');
    f.store.publishMainEnvironment(ownerId, environment);
    expect(f.store.listEvents(main.threadId, 0n).at(-1)?.payload).toEqual({
      case: 'mainEnvironmentChanged',
      value: environment,
    });
    expect(f.platformUse.reserved).toHaveLength(0);
    expect(f.environmentOperations.started).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it('requires sandbox capacity even when a task is authorized to use only a device', async () => {
  const f = fixture([
    response('', [
      { id: 'device-read', name: 'read', arguments: { env_id: 'device', path: 'AGENTS.md' } },
    ]),
    response('done'),
  ]);
  try {
    const main = f.store.getOrCreateMainThread(ownerId);
    seedTestEnvironment(f.database, ownerId, 'device', '/device');
    const task = f.store.createThread(
      action('CreateThread', 'device-task', {
        title: 'device',
        environmentPolicy: { allowedEnv: ['device'] },
      }),
    );
    expect(task.currentBinding?.envId).toBe(main.currentBinding?.envId);
    f.platformUse.capacity = 0;
    const input = send(f.store, task.threadId);
    await f.coordinator.deliver(input.input, input.runId);
    expect(f.store.getRunById(input.runId)).toMatchObject({
      status: 'failed',
      error: { code: 'sandbox_capacity_exhausted' },
    });
    expect(f.provider.requests).toHaveLength(0);
    expect(f.environmentOperations.started).toHaveLength(0);
    f.platformUse.capacity = 1;
    const continued = f.store.continueRun(
      action('ContinueRun', 'continue-device-task', {
        threadId: task.threadId,
        runId: input.runId,
      }),
    );
    f.coordinator.schedule(task.threadId, continued.runId);
    await completed(f.store, continued.runId);
    expect(f.environmentOperations.started.at(-1)).toMatchObject({
      envId: 'device',
      action: { value: { cwd: '/device', path: '/device/AGENTS.md' } },
    });
  } finally {
    await f.close();
  }
});

it('inherits resources from the caller execution after its policy has a newer reload snapshot', async () => {
  const f = fixture();
  try {
    let version = 'old';
    f.environmentOperations.loadResources = async () => ({
      snapshotId: '',
      systemInstructions: '',
      resources: [{ path: 'AGENTS.md', content: version }],
    });
    const main = f.store.getOrCreateMainThread(ownerId);
    await f.coordinator.reloadResources({
      ownerId,
      threadId: main.threadId,
      clientActionId: 'load-old',
    });
    const input = send(f.store, main.threadId);
    const parent = f.store.getRunById(input.runId);
    f.store.appendModelMessage({
      runId: parent.runId,
      inputId: input.input.inputId,
      message: { role: 'user', content: 'work' },
    });
    const original = f.store.agentEnvironments.requireExecution(parent);
    f.store.updateRunStatus(parent.runId, 'interrupted');
    version = 'new';
    await f.coordinator.reloadResources({
      ownerId,
      threadId: main.threadId,
      clientActionId: 'load-new',
    });
    expect(
      f.store.agentEnvironments.requirePolicy(main.threadId, 'thread').current.resourceVersion,
    ).not.toBe(original.resourceVersion);
    const child = f.store.createChildRun(ownerId, parent.runId, 'subagent-inherited');
    const inherited = f.store.agentEnvironments.requireExecution(child);
    expect(inherited.resourceVersion).toBe(original.resourceVersion);
    expect(
      f.store.agentEnvironments.requireHistory(inherited.historyId).resources?.resources,
    ).toEqual([{ path: 'AGENTS.md', content: 'old' }]);
  } finally {
    await f.close();
  }
});

it('reserves global capacity before the ordinary background Run queue and cancels queued references', async () => {
  const f = fixture();
  const coordinator = new RunCoordinator({
    store: f.store,
    environments: f.environments,
    environmentOperations: f.environmentOperations,
    platformUse: f.platformUse,
    maxActiveThreads: 1,
    browser: false,
    model: {
      provider: f.provider,
      providerId: 'test',
      modelId: 'test',
      contextWindowTokens: 128000,
      outputReserveTokens: 4096,
    },
  });
  try {
    f.platformUse.prepare = ({ signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    const accepted = [];
    for (let index = 0; index < 6; index++) {
      const tenantId = `capacity-tenant-${index}`;
      seedTestTenant(f.database, tenantId);
      const task = f.store.createThread({
        ...action('CreateThread', `task-${index}`, {
          title: `task ${index}`,
          initialText: 'work',
          initialMode: 'follow_up' as const,
        }),
        ownerId: tenantId,
      });
      accepted.push(task);
      await coordinator.deliver(task.input, task.runId);
    }
    expect(f.platformUse.uses.size).toBe(5);
    expect(f.store.getRunById(accepted[5]?.runId ?? '')).toMatchObject({
      status: 'failed',
      error: { code: 'sandbox_capacity_exhausted' },
    });
    expect(f.provider.requests).toHaveLength(0);
    const queued = accepted[1];
    if (!queued) throw new Error('Queued fixture Run is missing.');
    const cancelled = f.store.requestCancelRun({
      ...action('CancelRun', 'cancel-queued', {
        threadId: queued.thread.threadId,
        runId: queued.runId,
        reason: 'cancel queued',
      }),
      ownerId: queued.input.ownerId,
    });
    await coordinator.cancel(cancelled, 'cancel queued');
    expect(f.platformUse.uses.size).toBe(4);
  } finally {
    await coordinator.close();
    await f.close();
  }
});

it('keeps an undelivered result on its failed capacity Run until explicit Continue', async () => {
  const f = fixture();
  try {
    const main = f.store.getOrCreateMainThread(ownerId);
    seedTestEnvironment(f.database, ownerId, 'device', '/device');
    const source = send(f.store, main.threadId);
    f.store.appendModelMessage({
      runId: source.runId,
      inputId: source.input.inputId,
      message: { role: 'user', content: 'delegate' },
    });
    f.store.appendModelMessage({
      runId: source.runId,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'delegate', name: 'thread_call', arguments: { prompt: 'work' } }],
      },
    });
    const accepted = f.store.acceptThreadCall({
      ownerId,
      sourceThreadId: main.threadId,
      sourceAgentId: 'thread',
      sourceRunId: source.runId,
      sourceToolCallId: 'delegate',
      targetThreadId: '',
      prompt: 'work',
      mode: 'follow_up',
      environmentPolicy: { allowedEnv: ['device'] },
    });
    f.store.appendModelMessage({
      runId: accepted.runId,
      inputId: accepted.input.inputId,
      message: { role: 'user', content: 'work' },
    });
    const result = f.store.appendModelMessage({
      runId: accepted.runId,
      message: { role: 'assistant', content: 'persisted child result' },
    });
    f.store.recordInteractionResponses({
      runId: accepted.runId,
      messageId: result.messageId,
      interactionKeys: [accepted.interaction],
    });
    f.store.updateRunStatus(accepted.runId, 'completed');
    f.store.updateRunStatus(source.runId, 'completed');
    f.platformUse.capacity = 0;
    f.coordinator.resumeDeliveries();
    await vi.waitFor(() => expect(f.store.listRuns(ownerId, main.threadId)).toHaveLength(2));
    const delivery = f.store.getInteractionDelivery(ownerId, accepted.interaction);
    expect(delivery.status).toBe('queued');
    const failed = f.store.getRunById(delivery.runId ?? '');
    expect(failed.error?.code).toBe('sandbox_capacity_exhausted');
    f.platformUse.capacity = 1;
    f.coordinator.resumeDeliveries();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.store.getInteractionDelivery(ownerId, accepted.interaction).runId).toBe(failed.runId);
    expect(f.store.listRuns(ownerId, main.threadId)).toHaveLength(2);
    expect(f.provider.requests).toHaveLength(0);
    const continued = f.store.continueRun(
      action('ContinueRun', 'continue-delivery', { threadId: main.threadId, runId: failed.runId }),
    );
    f.coordinator.schedule(main.threadId, continued.runId);
    await completed(f.store, continued.runId);
    expect(f.store.getInteractionDelivery(ownerId, accepted.interaction).status).toBe('consumed');
    expect(f.provider.requests[0]?.messages.at(-1)?.content).toContain('persisted child result');
  } finally {
    await f.close();
  }
});

it('retains an initial directory Operation reference after its result becomes unknown', async () => {
  const f = fixture();
  try {
    const start = f.environmentOperations.startEnvironmentOperation.bind(f.environmentOperations);
    vi.spyOn(f.environmentOperations, 'startEnvironmentOperation').mockImplementation(
      async (input) => {
        const operation = await start(input);
        operation.status = OperationStatus.RUNNING;
        delete operation.resultStatus;
        delete operation.postProcessedAt;
        delete operation.resultSource;
        operation.outputComplete = false;
        operation.expiresAt = new Date(Date.now() + 30).toISOString();
        return operation;
      },
    );
    const main = f.store.getOrCreateMainThread(ownerId);
    const input = send(f.store, main.threadId);
    await f.coordinator.deliver(input.input, input.runId);
    await vi.waitFor(() =>
      expect(f.store.getRunById(input.runId)).toMatchObject({
        status: 'failed',
        error: { code: 'operation_unknown' },
      }),
    );
    await vi.waitFor(() =>
      expect([...f.platformUse.uses.values()].map((use) => use.kind)).toEqual(['operation']),
    );
    expect(f.store.listQueuedInputs(main.threadId)).toHaveLength(0);
    expect(f.provider.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it('limits the complete Agent authorization to 32 environments including the shared sandbox', async () => {
  const f = fixture();
  try {
    const devices = Array.from({ length: 32 }, (_, index) => `device-${index}`);
    for (const device of devices) seedTestEnvironment(f.database, ownerId, device, '/project');
    const task = f.store.createThread(
      action('CreateThread', 'scope-boundary', {
        title: 'scope',
        environmentPolicy: { allowedEnv: devices.slice(0, 31) },
      }),
    );
    expect(task.environmentPolicy?.allowedEnv).toHaveLength(32);
    expect(task.environmentPolicy?.allowedEnv).toContain(task.currentBinding?.envId);
    const accepted = send(f.store, task.threadId);
    const child = f.store.createChildRun(ownerId, accepted.runId, 'scope-child');
    expect(
      [
        ...(f.store.agentEnvironments.requirePolicy(child.threadId, child.agentId).allowedEnv ??
          []),
      ].sort(),
    ).toEqual(
      [
        ...f.store.agentEnvironments.requireExecution(f.store.getRunById(accepted.runId))
          .allowedEnv,
      ].sort(),
    );
    expect(() =>
      f.store.createThread(
        action('CreateThread', 'too-many-devices', {
          title: 'too many',
          environmentPolicy: { allowedEnv: devices },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
  } finally {
    await f.close();
  }
});

it('rejects removed default workspace parameters on task and Subagent tools', async () => {
  const f = fixture([
    response('', [
      {
        id: 'old-task-default',
        name: 'thread_call',
        arguments: {
          title: 'old task',
          prompt: 'work',
          default_env: 'device',
          default_pwd: '/device',
        },
      },
      {
        id: 'old-child-default',
        name: 'subagent',
        arguments: {
          task: 'work',
          mode: 'foreground',
          default_env: 'device',
          default_pwd: '/device',
        },
      },
    ]),
    response('done'),
  ]);
  try {
    const main = f.store.getOrCreateMainThread(ownerId);
    seedTestEnvironment(f.database, ownerId, 'device', '/device');
    const accepted = send(f.store, main.threadId);
    await f.coordinator.deliver(accepted.input, accepted.runId);
    await completed(f.store, accepted.runId);
    expect(f.database.prepare('SELECT COUNT(*) AS n FROM interactions').get()).toEqual({ n: 0 });
    const results = f.store
      .listContext(ownerId, main.threadId, 'thread')
      .filter((record) => record.message.role === 'tool');
    expect(results).toHaveLength(2);
    expect(
      results.every(
        (record) => record.message.role === 'tool' && record.message.status === 'error',
      ),
    ).toBe(true);
    const tools = f.provider.requests[0]?.tools.filter(
      (tool) => tool.name === 'thread_call' || tool.name === 'subagent',
    );
    expect(tools).toHaveLength(2);
    expect(JSON.stringify(tools)).not.toContain('default_env');
    expect(JSON.stringify(tools)).not.toContain('default_pwd');
  } finally {
    await f.close();
  }
});

it('preserves a historical device execution specification and requires a new generation for the sandbox', async () => {
  const f = fixture();
  try {
    seedTestEnvironment(f.database, ownerId, 'device', '/device');
    const task = f.store.createThread(
      action('CreateThread', 'legacy-task', {
        title: 'legacy',
        environmentPolicy: { allowedEnv: ['device'] },
      }),
    );
    const accepted = send(f.store, task.threadId);
    f.database
      .prepare(
        "UPDATE agent_execution_environments SET default_env='device',default_pwd='/device' WHERE run_id=? AND generation=1",
      )
      .run(accepted.runId);
    const legacy = f.store.agentEnvironments.getExecution(accepted.runId, 1);
    await f.coordinator.deliver(accepted.input, accepted.runId);
    expect(f.store.getRunById(accepted.runId)).toMatchObject({
      status: 'failed',
      error: { code: 'version_conflict' },
    });
    expect(f.provider.requests).toHaveLength(0);
    expect(f.environmentOperations.started).toHaveLength(0);
    const continued = f.store.continueRun(
      action('ContinueRun', 'continue-legacy-task', {
        threadId: task.threadId,
        runId: accepted.runId,
      }),
    );
    f.coordinator.schedule(task.threadId, continued.runId);
    await completed(f.store, continued.runId);
    expect(f.store.agentEnvironments.getExecution(accepted.runId, 1)).toEqual(legacy);
    expect(f.store.agentEnvironments.getExecution(accepted.runId, 2)).toMatchObject({
      defaultEnv: task.currentBinding?.envId,
      defaultPwd: '/workspace',
    });
    expect(f.provider.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it.each(['preparing', 'prepared', 'dispatched', 'legacy'] as const)(
  'continues a migrated device execution safely with %s request evidence',
  async (evidence) => {
    const f = fixture();
    try {
      seedTestEnvironment(f.database, ownerId, 'device', '/device');
      f.environmentOperations.loadResources = async () =>
        createWorkspaceResourceSnapshot([{ path: 'AGENTS.md', content: 'current sandbox rules' }]);
      const task = f.store.createThread(
        action('CreateThread', 'migration-task', {
          title: 'migrated',
          environmentPolicy: { allowedEnv: ['device'] },
        }),
      );
      const accepted = send(f.store, task.threadId);
      const legacyResources = createWorkspaceResourceSnapshot([
        { path: 'AGENTS.md', content: 'historical device rules' },
      ]);
      f.database
        .prepare(`INSERT INTO agent_environment_binding_history(history_id,thread_id,agent_id,binding_version,env_id,pwd,resource_version,resources_json,reason,created_at)
        SELECT 'legacy-device-history',thread_id,agent_id,0,'device','/device',?,?,'initial',created_at FROM agent_environment_binding_history WHERE history_id=?`)
        .run(
          legacyResources.snapshotId,
          JSON.stringify(legacyResources),
          task.currentBinding?.historyId ?? '',
        );
      f.database
        .prepare(
          "UPDATE agent_execution_environments SET default_env='device',default_pwd='/device',history_id='legacy-device-history',resource_version=? WHERE run_id=? AND generation=1",
        )
        .run(legacyResources.snapshotId, accepted.runId);
      const user = f.store.appendModelMessage({
        runId: accepted.runId,
        inputId: accepted.input.inputId,
        message: { role: 'user', content: 'continue migrated work' },
      });
      f.store.recaps.save({
        threadId: task.threadId,
        agentId: 'thread',
        sourceMessageSeqs: [user.seq],
        content: 'Historical device work.',
      });
      const requestId = `migration-${evidence}-request`;
      const inputs = new ModelInputService(f.database, { countTokens: () => 100 });
      await inputs.prepare({
        requestId,
        threadId: task.threadId,
        agentId: 'thread',
        systemInstructions: [legacyResources.systemInstructions],
        tools: [],
        pendingContextSeqs: [user.seq],
        contextWindowTokens: 128_000,
        outputReserveTokens: 4096,
      });
      f.store.setCurrentRequestId(accepted.runId, requestId);
      if (evidence === 'prepared' || evidence === 'dispatched')
        f.store.recordModelRequestPrepared(accepted.runId, requestId);
      if (evidence === 'dispatched')
        f.store.recordModelRequestDispatched(accepted.runId, requestId);
      if (evidence === 'preparing')
        f.database
          .prepare(
            "UPDATE model_request_records SET status='preparing',request_json=NULL WHERE request_id=?",
          )
          .run(requestId);
      const requestAudit = () =>
        f.database.prepare('SELECT * FROM model_request_records WHERE request_id=?').get(requestId);
      const before = requestAudit();
      const legacy = f.store.agentEnvironments.getExecution(accepted.runId, 1);
      const recapAudit = () => ({
        recaps: f.database.prepare('SELECT * FROM recaps ORDER BY recap_id').all(),
        sources: f.database.prepare('SELECT * FROM recap_sources ORDER BY recap_id,position').all(),
        selection: f.database
          .prepare('SELECT * FROM model_input_recaps ORDER BY merge_position')
          .all(),
      });
      const recapBefore = recapAudit();
      f.coordinator.schedule(task.threadId, accepted.runId);
      expect(f.store.getRunById(accepted.runId)).toMatchObject({
        status: 'failed',
        error: { code: 'version_conflict' },
      });
      expect(requestAudit()).toEqual(before);
      const continued = f.store.continueRun(
        action('ContinueRun', 'continue-migrated-request', {
          threadId: task.threadId,
          runId: accepted.runId,
        }),
      );
      expect(continued.generation).toBe(2);
      expect(recapAudit()).toEqual(recapBefore);
      const safe = evidence === 'preparing' || evidence === 'prepared';
      expect(continued.currentRequestId).toBe(safe ? null : requestId);
      if (safe)
        expect(requestAudit()).toEqual({
          ...before,
          status: 'cancelled',
          error_code: 'cancelled',
          error_message: 'Rebuilt for explicit Continue before Provider dispatch.',
          updated_at: expect.any(String),
        });
      else expect(requestAudit()).toEqual(before);
      f.coordinator.schedule(task.threadId, continued.runId);
      await vi.waitFor(() =>
        expect(f.store.getRunById(continued.runId).status).toBe(safe ? 'completed' : 'failed'),
      );
      expect(f.store.agentEnvironments.getExecution(accepted.runId, 1)).toEqual(legacy);
      expect(recapAudit()).toEqual(recapBefore);
      if (safe) {
        expect(f.provider.requests).toHaveLength(1);
        const instructions = f.provider.requests[0]?.messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n');
        expect(instructions).toContain('current sandbox rules');
        expect(instructions).not.toContain('historical device rules');
        const newRequest = f.database
          .prepare(
            "SELECT request_id FROM model_request_records WHERE request_id<>? AND status='completed'",
          )
          .get(requestId);
        expect(newRequest?.request_id).not.toBe(requestId);
        expect(newRequest?.request_id).toEqual(expect.any(String));
        expect(requestAudit()?.request_json).toBe(before?.request_json);
      } else {
        expect(f.provider.requests).toHaveLength(0);
        expect(requestAudit()).toEqual(before);
        expect(f.store.getRunById(continued.runId).currentRequestId).toBe(requestId);
      }
    } finally {
      await f.close();
    }
  },
);

it.each([
  { envId: 'two', pwd: '/two' },
  { envId: 'one', pwd: '/different' },
])('rejects a historical switched workspace on Rerun: $envId $pwd', async ({ envId, pwd }) => {
  const f = fixture();
  try {
    seedTestEnvironment(f.database, ownerId, 'one', '/one');
    seedTestEnvironment(f.database, ownerId, 'two', '/two');
    const task = f.store.createThread(
      action('CreateThread', 'task', {
        title: 'fixed workspace',
        environmentPolicy: { allowedEnv: ['one', 'two'] },
      }),
    );
    await f.coordinator.reloadResources({
      ownerId,
      threadId: task.threadId,
      clientActionId: 'prepare-fixed',
    });
    const accepted = send(f.store, task.threadId);
    const message = f.store.appendModelMessage({
      runId: accepted.runId,
      inputId: accepted.input.inputId,
      message: { role: 'user', content: 'historical input' },
    });
    f.store.updateRunStatus(accepted.runId, 'completed');
    const policy = f.store.agentEnvironments.requirePolicy(task.threadId, 'thread');
    f.database
      .prepare(`INSERT INTO agent_environment_binding_history(history_id,thread_id,agent_id,binding_version,env_id,pwd,resource_version,resources_json,reason,created_at)
      SELECT 'legacy-switch',thread_id,agent_id,99,?,?,resource_version,resources_json,'switch',created_at FROM agent_environment_binding_history WHERE history_id=?`)
      .run(envId, pwd, policy.currentHistoryId);
    f.database
      .prepare(
        "UPDATE agent_environment_message_bindings SET history_id='legacy-switch',binding_version=99 WHERE message_seq=?",
      )
      .run(message.seq);
    expect(() =>
      f.store.rerun(
        action('Rerun', 'rerun-history', { threadId: task.threadId, messageId: message.messageId }),
      ),
    ).toThrow(expect.objectContaining({ code: 'failed_precondition' }));
    expect(f.store.agentEnvironments.requirePolicy(task.threadId, 'thread').currentHistoryId).toBe(
      policy.currentHistoryId,
    );
    expect(f.store.listRuns(ownerId, task.threadId)).toHaveLength(1);
    expect(f.environmentOperations.started).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('allows standalone main creation before pairing but rejects execution without a device', async () => {
  const f = standaloneFixture();
  try {
    const main = f.store.getOrCreateMainThread(ownerId);
    expect(main.currentBinding).toMatchObject({
      envId: standaloneDevice.envId,
      pwd: '/workspace',
      resourceVersion: null,
    });
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM platform_environments').get()).toEqual(
      {
        count: 0,
      },
    );
    const accepted = send(f.store, main.threadId);
    await f.coordinator.deliver(accepted.input, accepted.runId);
    expect(f.store.getRunById(accepted.runId)).toMatchObject({
      status: 'failed',
      error: { code: 'failed_precondition' },
    });
    expect(f.provider.requests).toHaveLength(0);
    expect(f.environmentOperations.started).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it('executes standalone main, Rerun, tasks and inherited agents through the ready device', async () => {
  const f = standaloneFixture([
    response('main done'),
    response('rerun done'),
    response('task done'),
  ]);
  try {
    seedTestEnvironment(f.database, ownerId, standaloneDevice.envId, '/workspace');
    const main = f.store.getOrCreateMainThread(ownerId);
    const accepted = send(f.store, main.threadId);
    await f.coordinator.deliver(accepted.input, accepted.runId);
    await completed(f.store, accepted.runId);
    expect(
      f.store.agentEnvironments.requireExecution(f.store.getRunById(accepted.runId)),
    ).toMatchObject({
      defaultEnv: standaloneDevice.envId,
      defaultPwd: '/workspace',
    });
    const runtime = new AgentEnvironmentRuntime({
      store: f.store,
      environments: f.environments,
      operations: f.environmentOperations,
      platformUse: f.platformUse,
    });
    expect(JSON.parse(runtime.list(f.store.getRunById(accepted.runId)))).toMatchObject({
      main_env: 'sandbox',
      environments: [
        {
          env_id: 'sandbox',
          kind: 'self_hosted_linux',
          is_main: true,
          ready: true,
        },
      ],
    });
    const user = f.store
      .listContext(ownerId, main.threadId, 'thread')
      .find((record) => record.message.role === 'user');
    if (!user) throw new Error('The accepted user message is missing.');
    const rerun = f.store.rerun(
      action('Rerun', 'standalone-rerun', {
        threadId: main.threadId,
        messageId: user.messageId,
      }),
    );
    f.coordinator.schedule(main.threadId, rerun.runId);
    await completed(f.store, rerun.runId);
    f.environmentOperations.loadResources = async () =>
      createWorkspaceResourceSnapshot([{ path: 'AGENTS.md', content: 'standalone rules' }]);
    const reloaded = await f.coordinator.reloadResources({
      ownerId,
      threadId: main.threadId,
      clientActionId: 'standalone-reload',
    });
    expect(reloaded.resources).toEqual(['AGENTS.md']);
    const task = f.store.createThread(
      action('CreateThread', 'standalone-task', { title: 'standalone task' }),
    );
    expect(task.currentBinding).toMatchObject({
      envId: standaloneDevice.envId,
      pwd: '/workspace',
    });
    const taskInput = send(f.store, task.threadId, 'standalone-task-send');
    await f.coordinator.deliver(taskInput.input, taskInput.runId);
    await completed(f.store, taskInput.runId);
    const child = f.store.createChildRun(ownerId, accepted.runId, 'standalone-child');
    expect(f.store.agentEnvironments.requireExecution(child)).toMatchObject({
      defaultEnv: standaloneDevice.envId,
      defaultPwd: '/workspace',
    });
    expect(f.provider.requests).toHaveLength(3);
    expect(f.database.prepare('SELECT COUNT(*) AS count FROM platform_environments').get()).toEqual(
      {
        count: 0,
      },
    );
  } finally {
    await f.close();
  }
});

it.each([
  { name: 'offline', sql: "connection_status='offline'", code: 'device_offline' },
  { name: 'missing instance', sql: 'instance_id=NULL', code: 'failed_precondition' },
  { name: 'failed capabilities', sql: "capability_status='failed'", code: 'failed_precondition' },
  { name: 'failed directory', sql: "directory_status='failed'", code: 'failed_precondition' },
  {
    name: 'changed workspace',
    sql: "recommended_pwd='/other',normalized_pwd='/other'",
    code: 'failed_precondition',
  },
])('rejects standalone execution after $name', async ({ sql, code }) => {
  const f = standaloneFixture();
  try {
    seedTestEnvironment(f.database, ownerId, standaloneDevice.envId, '/workspace');
    const main = f.store.getOrCreateMainThread(ownerId);
    f.database
      .prepare(`UPDATE environments SET ${sql} WHERE tenant_id=? AND env_id=?`)
      .run(ownerId, standaloneDevice.envId);
    const accepted = send(f.store, main.threadId);
    await f.coordinator.deliver(accepted.input, accepted.runId);
    expect(f.store.getRunById(accepted.runId)).toMatchObject({
      status: 'failed',
      error: { code },
    });
    expect(f.provider.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it('requires a new binding and fresh readiness after standalone recovery', async () => {
  const f = standaloneFixture();
  try {
    const environments = new EnvironmentStore(f.database, { standaloneDevice });
    const gateway = new StandaloneDeviceUseGateway(
      environments,
      f.environmentOperations,
      standaloneDevice,
    );
    const capabilities = [DeviceCapability.BASH, DeviceCapability.DIRECTORY_CHECK];
    const initial = environments.beginConnection({
      tenantId: ownerId,
      clientActionId: 'standalone-gateway-initial',
    });
    const first = environments.exchangePairing({
      envId: standaloneDevice.envId,
      pairingCredential: initial.pairingCredential,
      reportedCapabilities: capabilities,
    });
    environments.markConnected({
      ...first,
      instanceId: 'old-instance',
      reportedCapabilities: capabilities,
    });
    environments.recordReadiness({
      ...first,
      instanceId: 'old-instance',
      reportedCapabilities: capabilities,
      directoryStatus: 'ready',
      normalizedPwd: '/workspace',
    });
    await gateway.ensureReady({
      tenantId: ownerId,
      envId: standaloneDevice.envId,
      kind: 'operation',
      usageId: 'standalone-before-revoke',
      signal: new AbortController().signal,
    });
    expect(f.environmentOperations.started).toHaveLength(0);
    environments.revoke({
      tenantId: ownerId,
      clientActionId: 'standalone-gateway-revoke',
      envId: standaloneDevice.envId,
    });
    const restored = environments.beginConnection({
      tenantId: ownerId,
      clientActionId: 'standalone-gateway-retry',
    });
    expect(restored.environment).toMatchObject({
      bindingStatus: 'pairing',
      connectionStatus: 'offline',
      capabilityStatus: 'pending',
      directoryStatus: 'pending',
      ready: false,
    });
    await expect(
      gateway.ensureReady({
        tenantId: ownerId,
        envId: standaloneDevice.envId,
        kind: 'operation',
        usageId: 'standalone-after-revoke',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
    expect(() =>
      environments.markConnected({
        ...first,
        instanceId: 'old-instance',
        reportedCapabilities: capabilities,
      }),
    ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
    expect(f.environmentOperations.started).toHaveLength(0);

    const second = environments.exchangePairing({
      envId: standaloneDevice.envId,
      pairingCredential: restored.pairingCredential,
      reportedCapabilities: capabilities,
    });
    expect(second.deviceBindingId).not.toBe(first.deviceBindingId);
    await expect(
      gateway.ensureReady({
        tenantId: ownerId,
        envId: standaloneDevice.envId,
        kind: 'operation',
        usageId: 'standalone-offline-retry',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'device_offline' });
    const startOperation = f.environmentOperations.startEnvironmentOperation.bind(
      f.environmentOperations,
    );
    f.environmentOperations.startEnvironmentOperation = async (input) => {
      const result = await startOperation(input);
      if (input.action.case === 'directoryCheck') {
        const current = environments.get(ownerId, standaloneDevice.envId);
        if (!current.deviceId || !current.deviceBindingId || !current.instanceId)
          throw new Error('The new device instance is missing.');
        environments.recordReadiness({
          envId: current.envId,
          deviceId: current.deviceId,
          deviceBindingId: current.deviceBindingId,
          instanceId: current.instanceId,
          reportedCapabilities: capabilities,
          directoryStatus: 'ready',
          normalizedPwd: '/workspace',
        });
      }
      return result;
    };
    environments.markConnected({
      ...second,
      instanceId: 'new-instance',
      reportedCapabilities: capabilities,
    });
    await gateway.ensureReady({
      tenantId: ownerId,
      envId: standaloneDevice.envId,
      kind: 'operation',
      usageId: 'standalone-ready-retry',
      signal: new AbortController().signal,
    });
    expect(environments.requireReady(ownerId, standaloneDevice.envId)).toMatchObject({
      bindingStatus: 'active',
      connectionStatus: 'online',
      capabilityStatus: 'ready',
      directoryStatus: 'ready',
      instanceId: 'new-instance',
      deviceBindingId: second.deviceBindingId,
      normalizedPwd: '/workspace',
      ready: true,
    });
    expect(f.environmentOperations.started).toHaveLength(1);
    expect(f.environmentOperations.started[0]?.action).toMatchObject({
      case: 'directoryCheck',
      value: { path: '/workspace' },
    });
  } finally {
    await f.close();
  }
});
