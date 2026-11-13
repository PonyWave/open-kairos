import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ModelEvent, ToolCall } from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import { DeviceCapability, OperationStatus } from '@kairos/contracts/device';
import { afterEach, expect, it, vi } from 'vitest';
import { pngBytes } from '../attachments/fixtures.js';
import { EnvironmentStore } from '../devices/environment-store.js';
import { ensureMainEnvironment } from '../devices/main-environment.js';
import {
  AgentEnvironmentRuntime,
  type EnvironmentOperationAction,
  type EnvironmentOperationGateway,
  type EnvironmentOperationRecord,
} from '../sessions/environment-runtime.js';
import type { RunStatus } from '../sessions/records.js';
import { RunCoordinator } from '../sessions/runtime.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import {
  ControlledEnvironmentUseGateway,
  seedReadyMainEnvironment,
} from './environment-fixture.js';

const ownerId = 'tenant-1';
const now = '2026-11-06T00:00:00.000Z';
const capabilities = [
  DeviceCapability.BASH,
  DeviceCapability.FILE_READ,
  DeviceCapability.FILE_WRITE,
  DeviceCapability.FILE_EDIT,
  DeviceCapability.DIRECTORY_CHECK,
];
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const cleanup: Array<() => Promise<void>> = [];

function response(content: string, toolCalls?: ToolCall[]): ModelEvent[] {
  return [
    {
      type: 'response',
      message: {
        role: 'assistant',
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      usage,
    },
  ];
}

function action<const T extends Record<string, unknown>>(
  method: string,
  clientActionId: string,
  parameters: T,
) {
  return { ownerId, clientActionId, method, parameters, ...parameters };
}

function seedTenant(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO users(
        user_id, email, email_verified_at, username, tenant_id, status, created_at, updated_at
      ) VALUES ('user-1', 'tenant@example.com', ?, 'tenant', NULL, 'active', ?, ?)`,
    )
    .run(now, now, now);
  database
    .prepare(
      'INSERT INTO tenants(tenant_id, user_id, default_env_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
    )
    .run(ownerId, 'user-1', now, now);
  database.prepare('UPDATE users SET tenant_id = ? WHERE user_id = ?').run(ownerId, 'user-1');
}

function seedEnvironment(store: EnvironmentStore, envId: string, pwd: string): void {
  const deviceId = `device-${envId}`;
  const deviceBindingId = `binding-${envId}`;
  const instanceId = `instance-${envId}`;
  const serializedCapabilities = JSON.stringify(capabilities);
  store.database
    .prepare(
      `INSERT INTO environments(
        env_id, tenant_id, name, kind, recommended_pwd, binding_status, connection_status,
        capability_status, directory_status, maintenance_mode, maintenance_version,
        authorized_capabilities_json, granted_capabilities_json, device_id, device_binding_id,
        instance_id, daemon_version, os, architecture, normalized_pwd, checked_at,
        created_at, updated_at, paired_at, last_seen_at
      ) VALUES (?, ?, ?, 'self_hosted_linux', ?, 'active', 'online', 'ready', 'ready',
        'normal', '0', ?, ?, ?, ?, ?, 'test', 'ubuntu', 'x86_64', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      envId,
      ownerId,
      envId,
      pwd,
      serializedCapabilities,
      serializedCapabilities,
      deviceId,
      deviceBindingId,
      instanceId,
      pwd,
      now,
      now,
      now,
      now,
      now,
    );
  store.database
    .prepare(
      `INSERT INTO environment_device_bindings(
        device_binding_id, tenant_id, env_id, device_id, status, granted_capabilities_json,
        created_at, updated_at, paired_at, last_seen_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    )
    .run(deviceBindingId, ownerId, envId, deviceId, serializedCapabilities, now, now, now, now);
}

class FakeOperations implements EnvironmentOperationGateway {
  readonly started: Array<{
    operationId: string;
    tenantId: string;
    envId: string;
    bindingVersion?: bigint;
    action: EnvironmentOperationAction;
  }> = [];
  readonly cancelled: string[] = [];
  readonly #environments: EnvironmentStore;
  readonly #operations = new Map<string, EnvironmentOperationRecord>();
  failDirectory = false;
  deferBash = false;
  truncateBashOutput = false;
  agentsMdPaths = new Set<string>();
  deferWrite = false;
  deferDirectory = false;
  deferImage = false;
  imageBytes: Uint8Array = pngBytes;
  imageFileVersion = createHash('sha256').update(pngBytes).digest('hex');
  cancelExpiresAt?: Date;
  resourceSuffix = '';

  constructor(environments: EnvironmentStore) {
    this.#environments = environments;
  }

  async startEnvironmentOperation(input: {
    operationId: string;
    tenantId: string;
    envId: string;
    bindingVersion?: bigint;
    action: EnvironmentOperationAction;
    expiresAt: Date;
  }): Promise<EnvironmentOperationRecord> {
    this.started.push({
      operationId: input.operationId,
      tenantId: input.tenantId,
      envId: input.envId,
      ...(input.bindingVersion === undefined ? {} : { bindingVersion: input.bindingVersion }),
      action: structuredClone(input.action),
    });
    const environment = this.#environments.get(input.tenantId, input.envId);
    const running =
      (this.deferBash && input.action.case === 'bash') ||
      (this.deferWrite && input.action.case === 'write') ||
      (this.deferDirectory && input.action.case === 'directoryCheck') ||
      (this.deferImage && input.action.case === 'readImage');
    const outcome = running ? undefined : this.#outcome(input.envId, input.action);
    const status = running
      ? OperationStatus.RUNNING
      : this.failDirectory && input.action.case === 'directoryCheck'
        ? OperationStatus.FAILED
        : OperationStatus.COMPLETED;
    const operation: EnvironmentOperationRecord = {
      operationId: input.operationId,
      tenantId: input.tenantId,
      envId: input.envId,
      deviceBindingId: environment.deviceBindingId ?? '',
      targetInstanceId: environment.instanceId ?? '',
      action: structuredClone(input.action),
      status,
      ...(status === OperationStatus.RUNNING ? {} : { resultStatus: status }),
      ...(outcome ? { outcome } : {}),
      expiresAt: input.expiresAt.toISOString(),
    };
    this.#operations.set(input.operationId, operation);
    return operation;
  }

  async cancelEnvironmentOperation(input: {
    tenantId: string;
    operationId: string;
    reason: string;
  }): Promise<EnvironmentOperationRecord> {
    this.cancelled.push(input.operationId);
    const operation = this.#operations.get(input.operationId);
    if (!operation) throw new Error('Unknown operation.');
    operation.status = OperationStatus.CANCEL_REQUESTED;
    if (this.cancelExpiresAt) operation.expiresAt = this.cancelExpiresAt.toISOString();
    return operation;
  }

  completeOperation(operationId: string, status: OperationStatus): void {
    const operation = this.#operations.get(operationId);
    if (!operation) throw new Error('Unknown operation.');
    operation.status = status;
    operation.resultStatus = status;
    operation.outcome = this.#outcome(operation.envId, operation.action);
  }

  getEnvironmentOperation(tenantId: string, operationId: string): EnvironmentOperationRecord {
    const operation = this.#operations.get(operationId);
    if (!operation || operation.tenantId !== tenantId) throw new Error('Unknown operation.');
    return operation;
  }

  readEnvironmentOperationOutput(input: {
    tenantId: string;
    operationId: string;
    offset: bigint;
    limit: number;
  }) {
    const data = new TextEncoder().encode('remote output\n');
    const sliced = data.slice(Number(input.offset), Number(input.offset) + input.limit);
    const nextOffset = input.offset + BigInt(sliced.byteLength);
    if (this.truncateBashOutput) {
      return { data: sliced, nextOffset, outputComplete: false, outputGap: true };
    }
    return {
      data: sliced,
      nextOffset,
      outputComplete: nextOffset >= BigInt(data.byteLength),
      outputGap: false,
    };
  }

  #outcome(envId: string, action: EnvironmentOperationAction): unknown {
    if (action.case === 'directoryCheck') {
      const content = `instructions for ${envId} at ${action.value.path}${this.resourceSuffix}`;
      return {
        case: 'directoryCheck',
        value: {
          normalizedPath: action.value.path,
          exists: true,
          directory: true,
          readable: true,
          writable: true,
          executable: true,
          os: 'ubuntu',
          architecture: 'x86_64',
          capabilities,
          resources: [
            {
              path: 'AGENTS.md',
              content,
              sha256: sha256(content),
            },
          ],
        },
      };
    }
    if (action.case === 'read') {
      if (action.value.path.endsWith('/AGENTS.md') && !this.agentsMdPaths.has(action.value.path)) {
        return { case: 'error', value: { code: 'file_not_found', message: 'File not found.' } };
      }
      return {
        case: 'read',
        value: {
          path: action.value.path,
          content: `content from ${envId}`,
          startLine: 1,
          endLine: 1,
          hasMore: false,
          fileVersion: 'a'.repeat(64),
          truncated: false,
        },
      };
    }
    if (action.case === 'readImage') {
      return {
        case: 'readImage',
        value: {
          path: action.value.path,
          data: this.imageBytes,
          fileVersion: this.imageFileVersion,
        },
      };
    }
    if (action.case === 'write') {
      const bytes = action.value.binaryContent ?? Buffer.from(action.value.content, 'utf8');
      return {
        case: 'write',
        value: {
          path: action.value.path,
          bytesWritten: BigInt(bytes.byteLength),
          fileVersion: createHash('sha256').update(bytes).digest('hex'),
        },
      };
    }
    if (action.case === 'edit') {
      return {
        case: 'edit',
        value: {
          path: action.value.path,
          replacements: 1,
          bytesWritten: BigInt(Buffer.byteLength(action.value.newText)),
          fileVersion: 'c'.repeat(64),
        },
      };
    }
    return {
      case: 'bash',
      value: { exitCode: 0, outputComplete: true, endOffset: 14n },
    };
  }

  bashOutputLog(
    operationId: string,
  ): { path: string; sizeBytes: bigint; truncated: boolean } | undefined {
    if (!this.truncateBashOutput || !this.#operations.has(operationId)) return undefined;
    return { path: '/main-workspace/.kairos/logs/mock.log', sizeBytes: 14n, truncated: false };
  }
}

async function fixture(provider: ScriptedProvider, options: { seedEnvironments?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-environment-agent-'));
  const database = openDatabase(':memory:');
  const store = new SessionStore(database, {
    mainEnvironment: { envId: 'env-main-1', workspace: '/workspace' },
  });
  seedTenant(database);
  seedReadyMainEnvironment(database, ownerId, 'env-main-1', '/workspace');
  const environments = new EnvironmentStore(database);
  if (options.seedEnvironments !== false) {
    seedEnvironment(environments, 'env-1', '/srv/one');
    seedEnvironment(environments, 'env-2', '/srv/two');
  }
  const operations = new FakeOperations(environments);
  const coordinator = new RunCoordinator({
    store,
    model: {
      provider,
      providerId: 'test',
      modelId: 'test-model',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
    },
    environments,
    environmentOperations: operations,
    environmentUse: new ControlledEnvironmentUseGateway(store.database),
  });
  const close = async () => {
    await coordinator.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  };
  cleanup.push(close);
  return { database, store, environments, operations, coordinator, directory };
}

function policy(environment = 'env-1', allowedEnv = [environment]) {
  return { allowedEnv };
}

function mainEnvId(store: SessionStore): string {
  ensureMainEnvironment(store.database, ownerId, store.agentEnvironments.mainEnvironment);
  return store.agentEnvironments.mainEnvironmentIdFor(ownerId);
}

async function waitStatus(store: SessionStore, runId: string, status: RunStatus) {
  await vi.waitFor(() => expect(store.getRunById(runId).status).toBe(status), { timeout: 3000 });
}

function toolNames(request: { tools: readonly { name: string }[] }): string[] {
  return request.tools.map((tool) => tool.name).sort();
}

async function seedInitialAttempt(
  store: SessionStore,
  operations: FakeOperations,
  runStatus: RunStatus,
  remoteStatus: OperationStatus,
  operationId = 'initial-operation',
) {
  const task = store.createThread(
    action('CreateThread', `create-initial-${runStatus}-${remoteStatus}`, {
      title: 'initial recovery',
      environmentPolicy: policy(),
    }),
  );
  const sent = store.sendMessage(
    action('SendMessage', `send-initial-${runStatus}-${remoteStatus}`, {
      threadId: task.threadId,
      text: 'continue initial directory check',
      mode: 'follow_up',
    }),
  );
  const current = store.agentEnvironments.requirePolicy(task.threadId, 'thread');
  seedReadyMainEnvironment(store.database, ownerId, mainEnvId(store));
  store.transaction(() => {
    store.agentEnvironments.recordOperationIntent({
      operationId,
      runId: sent.runId,
      toolCallId: `initial:${sent.runId}`,
      policy: current,
      action: 'directory_check',
    });
  });
  await operations.startEnvironmentOperation({
    operationId,
    tenantId: ownerId,
    envId: mainEnvId(store),
    action: {
      case: 'directoryCheck',
      value: { path: '/workspace', loadWorkspace: true },
    },
    expiresAt: new Date(Date.now() + 30_000),
  });
  if (remoteStatus !== OperationStatus.RUNNING) {
    operations.completeOperation(operationId, remoteStatus);
  }
  store.updateRunStatus(sent.runId, runStatus);
  return { task, sent };
}

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('persists creation policies and restricts continuation and child inheritance', async () => {
  const { store } = await fixture(new ScriptedProvider([]));
  const main = store.getOrCreateMainThread(ownerId);
  const rootInput = store.sendMessage(
    action('SendMessage', 'root-input', {
      threadId: main.threadId,
      text: 'coordinate',
      mode: 'follow_up',
    }),
  );
  const accepted = store.acceptThreadCall({
    ownerId,
    sourceThreadId: main.threadId,
    sourceAgentId: 'thread',
    sourceRunId: rootInput.runId,
    sourceToolCallId: 'call-create',
    title: 'task',
    prompt: 'execute',
    mode: 'follow_up',
    environmentPolicy: policy(),
  });
  const saved = store.agentEnvironments.requirePolicy(
    accepted.interaction.targetThreadId,
    'thread',
  );
  expect(saved).toMatchObject({
    allowedEnv: [mainEnvId(store), 'env-1'],
    defaultEnv: mainEnvId(store),
    defaultPwd: '/workspace',
    current: {
      envId: mainEnvId(store),
      pwd: '/workspace',
      bindingVersion: 1,
      resourceVersion: null,
    },
  });
  expect(() =>
    store.acceptThreadCall({
      ownerId,
      sourceThreadId: main.threadId,
      sourceAgentId: 'thread',
      sourceRunId: rootInput.runId,
      sourceToolCallId: 'call-continue-policy',
      targetThreadId: accepted.interaction.targetThreadId,
      prompt: 'continue',
      mode: 'follow_up',
      environmentPolicy: policy('env-2', ['env-1', 'env-2']),
    }),
  ).toThrow(/only thread_id, prompt and mode/);
  const child = store.createSubagentInteraction({
    ownerId,
    sourceThreadId: accepted.interaction.targetThreadId,
    sourceAgentId: 'thread',
    sourceRunId: accepted.runId,
    sourceToolCallId: 'call-child',
    targetAgentId: 'subagent-child',
    prompt: 'child task',
    executionMode: 'foreground',
  });
  expect(
    store.agentEnvironments.requirePolicy(child.targetThreadId, child.targetAgentId).current,
  ).toMatchObject({ envId: mainEnvId(store), pwd: '/workspace', bindingVersion: 1 });
  expect(() =>
    store.createSubagentInteraction({
      ownerId,
      sourceThreadId: accepted.interaction.targetThreadId,
      sourceAgentId: 'thread',
      sourceRunId: accepted.runId,
      sourceToolCallId: 'call-expand',
      targetAgentId: 'subagent-expand',
      prompt: 'expand',
      executionMode: 'foreground',
      environmentPolicy: policy('env-2', ['env-1', 'env-2']),
    }),
  ).toThrow(/cannot expand/);
  const unbound = store.createThread(
    action('CreateThread', 'missing-policy', { title: 'missing' }),
  );
  expect(unbound.environmentPolicy).toBeUndefined();
  expect(unbound.currentBinding).toMatchObject({ pwd: '/workspace' });
  expect(store.agentEnvironments.requirePolicyState(unbound.threadId, 'thread')).toMatchObject({
    allowedEnv: null,
    defaultEnv: unbound.currentBinding?.envId,
    defaultPwd: '/workspace',
    bindingVersion: 1,
    current: expect.objectContaining({ pwd: '/workspace' }),
  });
});

it('filters revoked environments from Router and Agent catalogs until active again', async () => {
  const { store, environments, operations } = await fixture(new ScriptedProvider([]));
  seedEnvironment(environments, 'env-3', '/srv/three');
  store.getOrCreateMainThread(ownerId);
  const task = store.createThread(
    action('CreateThread', 'catalog-task', {
      title: 'catalog',
      initialText: 'inspect environments',
      initialMode: 'follow_up',
      environmentPolicy: policy('env-1', ['env-1', 'env-2']),
    }),
  );
  const run = store.getRunById(task.runId);
  const runtime = new AgentEnvironmentRuntime({
    store,
    environments,
    operations,
    environmentUse: new ControlledEnvironmentUseGateway(store.database),
  });
  const readCatalogs = () => {
    const routerCatalog = environments
      .list(ownerId)
      .environments.filter((environment) => environment.bindingStatus === 'active');
    const agentCatalog = JSON.parse(runtime.list(run)) as {
      environments: Array<{ env_id: string }>;
    };
    return {
      router: routerCatalog.map((environment) => environment.envId),
      agent: agentCatalog.environments.map((environment) => environment.env_id),
    };
  };
  expect(readCatalogs()).toEqual({
    router: ['env-1', 'env-2', 'env-3', 'env-main-1'],
    agent: ['env-1', 'env-2', 'main'],
  });

  environments.revoke({ tenantId: ownerId, clientActionId: 'revoke-catalog-env', envId: 'env-2' });
  expect(environments.get(ownerId, 'env-2').bindingStatus).toBe('revoked');
  expect(readCatalogs()).toEqual({
    router: ['env-1', 'env-3', 'env-main-1'],
    agent: ['env-1', 'main'],
  });
  expect(store.agentEnvironments.requirePolicy(task.thread.threadId, 'thread').allowedEnv).toEqual([
    mainEnvId(store),
    'env-1',
    'env-2',
  ]);
  await expect(
    runtime.execute(
      run,
      { case: 'read', value: { path: 'AGENTS.md', cwd: '' } },
      'revoked-catalog-read',
      new AbortController().signal,
      { envId: 'env-2' },
    ),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  expect(operations.started).toHaveLength(0);

  environments.database
    .prepare(
      "UPDATE environments SET binding_status = 'active', paired_at = ?, revoked_at = NULL, updated_at = ? WHERE env_id = 'env-2'",
    )
    .run(now, now);
  expect(environments.get(ownerId, 'env-2').bindingStatus).toBe('active');
  expect(readCatalogs()).toEqual({
    router: ['env-1', 'env-2', 'env-3', 'env-main-1'],
    agent: ['env-1', 'env-2', 'main'],
  });
  expect(store.agentEnvironments.requirePolicy(task.thread.threadId, 'thread').allowedEnv).toEqual([
    mainEnvId(store),
    'env-1',
    'env-2',
  ]);
});

it('uses the main alias only at the model boundary and keeps real audit routing', async () => {
  const { store, environments, operations } = await fixture(new ScriptedProvider([]));
  const task = store.createThread(
    action('CreateThread', 'sandbox-alias-task', {
      title: 'sandbox alias',
      initialText: 'inspect sandbox',
      initialMode: 'follow_up',
      environmentPolicy: policy('env-1', ['env-1', 'env-2']),
    }),
  );
  const run = store.getRunById(task.runId);
  const runtime = new AgentEnvironmentRuntime({
    store,
    environments,
    operations,
    environmentUse: new ControlledEnvironmentUseGateway(store.database),
  });
  const catalog = JSON.parse(runtime.list(run)) as {
    main_env: string;
    environments: Array<{ env_id: string; name: string; is_main: boolean }>;
  };
  const sandboxId = mainEnvId(store);
  expect(catalog.main_env).toBe('main');
  expect(catalog.environments).toMatchObject([
    { env_id: 'env-1', name: 'env-1', is_main: false },
    { env_id: 'env-2', name: 'env-2', is_main: false },
    { env_id: 'main', name: 'main', is_main: true },
  ]);
  expect(JSON.stringify(catalog)).not.toContain(sandboxId);
  expect(runtime.resolveEnvironmentIds(ownerId, ['main', 'env-1'])).toEqual([sandboxId, 'env-1']);

  operations.agentsMdPaths.add('/workspace/AGENTS.md');
  const result = await runtime.execute(
    run,
    { case: 'read', value: { path: 'AGENTS.md', cwd: '' } },
    'sandbox-alias-read',
    new AbortController().signal,
    { envId: 'main' },
  );
  expect(result.content).toContain('"env_id":"main"');
  expect(operations.started.at(-1)).toMatchObject({ envId: sandboxId });
  const association = store.agentEnvironments.findOperation(run.runId, 'sandbox-alias-read');
  expect(association).toMatchObject({ envId: sandboxId, action: 'read' });
});

it('projects the main alias in thread_list without changing stored identifiers', async () => {
  const provider = new ScriptedProvider([
    response('', [{ id: 'list-environments', name: 'thread_list', arguments: {} }]),
    response('done'),
  ]);
  const { store, coordinator } = await fixture(provider);
  const task = store.createThread(
    action('CreateThread', 'thread-list-alias-task', {
      title: 'thread list alias',
      initialText: 'inspect environments',
      initialMode: 'follow_up',
      environmentPolicy: policy('env-1', ['env-1']),
    }),
  );
  const main = store.getOrCreateMainThread(ownerId);
  const input = store.sendMessage(
    action('SendMessage', 'thread-list-alias-input', {
      threadId: main.threadId,
      text: 'list environments',
      mode: 'follow_up',
    }),
  );
  await coordinator.deliver(input.input, input.runId);
  await waitStatus(store, input.runId, 'completed');
  const message = store
    .listContext(ownerId, main.threadId, 'thread')
    .find(
      (candidate) =>
        candidate.message.role === 'tool' && candidate.message.tool_call_id === 'list-environments',
    );
  if (!message) throw new Error('The thread_list result is missing.');
  const result = JSON.parse(message.message.content) as {
    threads: Array<{
      thread_id: string;
      environment_policy: { allowed_env: string[] };
      current_binding: { env_id: string };
    }>;
  };
  const listed = result.threads.find((candidate) => candidate.thread_id === task.thread.threadId);
  expect(listed).toMatchObject({
    environment_policy: { allowed_env: ['main', 'env-1'] },
    current_binding: { env_id: 'main' },
  });
  const sandboxId = mainEnvId(store);
  expect(message.message.content).not.toContain(sandboxId);
  expect(store.agentEnvironments.requirePolicy(task.thread.threadId, 'thread')).toMatchObject({
    allowedEnv: [sandboxId, 'env-1'],
    defaultEnv: sandboxId,
  });
});

it('gives all Agents execution tools and loads main and task resources from the shared sandbox', async () => {
  const provider = new ScriptedProvider([response('router done'), response('task done')]);
  const { store, coordinator, operations } = await fixture(provider);
  const main = store.getOrCreateMainThread(ownerId);
  const mainInput = store.sendMessage(
    action('SendMessage', 'main-input', {
      threadId: main.threadId,
      text: 'hello',
      mode: 'follow_up',
    }),
  );
  await coordinator.deliver(mainInput.input, mainInput.runId);
  await waitStatus(store, mainInput.runId, 'completed');
  const task = store.createThread(
    action('CreateThread', 'task-input', {
      title: 'task',
      initialText: 'execute',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  await coordinator.deliver(task.input, task.runId);
  await waitStatus(store, task.runId, 'completed');

  const routerRequest = provider.requests[0];
  const taskRequest = provider.requests[1];
  expect(routerRequest).toBeDefined();
  expect(taskRequest).toBeDefined();
  if (!routerRequest || !taskRequest) throw new Error('Provider requests are missing.');
  expect(toolNames(routerRequest)).toEqual([
    'bash',
    'edit',
    'env_list',
    'env_sync',
    'glob',
    'grep',
    'read',
    'read_image',
    'recall',
    'send_to_user',
    'skill',
    'subagent',
    'task_list',
    'task_output',
    'task_stop',
    'task_wait',
    'thread_archive',
    'thread_call',
    'thread_cancel',
    'thread_list',
    'thread_read',
    'web_fetch',
    'web_search',
    'workspace_create',
    'workspace_delete',
    'workspace_list',
    'write',
  ]);
  expect(toolNames(taskRequest)).toEqual(
    [
      'bash',
      'edit',
      'env_list',
      'env_sync',
      'glob',
      'grep',
      'read',
      'read_image',
      'recall',
      'skill',
      'subagent',
      'task_list',
      'task_output',
      'task_stop',
      'task_wait',
      'thread_notify',
      'web_fetch',
      'web_search',
      'write',
    ].sort(),
  );
  expect(JSON.stringify(routerRequest.messages)).toContain('authorized-environment-catalog');
  expect(toolNames(taskRequest)).not.toContain('send_to_user');
  expect(JSON.stringify(routerRequest.messages)).toContain(
    'Use Subagent for a bounded one-off task',
  );
  expect(JSON.stringify(routerRequest.messages)).not.toContain(
    'use the available environment tools directly when useful',
  );
  expect(JSON.stringify(routerRequest.messages)).not.toContain('instructions for env-1');
  expect(JSON.stringify(taskRequest.messages)).toContain(
    `instructions for ${mainEnvId(store)} at /workspace`,
  );
  expect(JSON.stringify(taskRequest.messages)).toContain(
    'You are the root Agent of a persistent task Thread',
  );
  expect(JSON.stringify(taskRequest.messages)).not.toContain('You are the main Agent');
  expect(taskRequest.messages.map((message) => message.content).join('\n')).toContain(
    '"workspace":"/workspace"',
  );
  expect(operations.started).toHaveLength(2);
  expect(operations.started.at(-1)).toMatchObject({ envId: mainEnvId(store) });
  expect(operations.started[0]?.bindingVersion).toBeUndefined();
  expect(
    store.agentEnvironments.requirePolicy(task.thread.threadId, 'thread').current.resourceVersion,
  ).toMatch(/^[a-f0-9]{64}$/);
});

it('reminds once about a nested AGENTS.md after writes in its directory tree', async () => {
  const provider = new ScriptedProvider([
    response('', [
      {
        id: 'write-1',
        name: 'write',
        arguments: { env_id: 'env-1', path: 'src/app.ts', content: 'one' },
      },
    ]),
    response('', [
      {
        id: 'write-2',
        name: 'write',
        arguments: { env_id: 'env-1', path: 'src/lib.ts', content: 'two' },
      },
    ]),
    response('done'),
  ]);
  const { store, coordinator, operations } = await fixture(provider);
  operations.agentsMdPaths.add('/srv/one/src/AGENTS.md');
  const task = store.createThread(
    action('CreateThread', 'agents-md-task', {
      title: 'agents-md',
      initialText: 'agents-md',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  await coordinator.deliver(task.input, task.runId);
  await waitStatus(store, task.runId, 'completed');
  const results = store
    .listContext(ownerId, task.thread.threadId, 'thread')
    .filter((message) => message.message.role === 'tool' && message.message.tool_name === 'write');
  expect(results).toHaveLength(2);
  expect(results[0]?.message.content).toContain('agents_md_hint');
  expect(results[0]?.message.content).toContain('/srv/one/src/AGENTS.md');
  expect(results[1]?.message.content).not.toContain('agents_md_hint');
});

it('points to the device log file when the bash output preview is truncated', async () => {
  const provider = new ScriptedProvider([
    response('', [{ id: 'bash-1', name: 'bash', arguments: { env_id: 'env-1', command: 'pwd' } }]),
    response('done'),
  ]);
  const { store, coordinator, operations } = await fixture(provider);
  operations.truncateBashOutput = true;
  const task = store.createThread(
    action('CreateThread', 'truncated-bash-task', {
      title: 'truncated',
      initialText: 'truncated',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  await coordinator.deliver(task.input, task.runId);
  await waitStatus(store, task.runId, 'completed');
  const bashResult = store
    .listContext(ownerId, task.thread.threadId, 'thread')
    .find((message) => message.message.role === 'tool' && message.message.tool_name === 'bash');
  expect(bashResult?.message.content).toContain('"output_truncated":true');
  expect(bashResult?.message.content).toContain('"output_file"');
  expect(bashResult?.message.content).toContain('"env_id":"main"');
  expect(bashResult?.message.content).toContain('/main-workspace/.kairos/logs/mock.log');
  expect(bashResult?.message.content).toContain('env_id main');
  expect(bashResult?.message.content).not.toContain('read_output');
});

it('routes remote operations by binding and preserves cwd and output authorization', async () => {
  const provider = new ScriptedProvider([
    response('', [
      {
        id: 'bash-1',
        name: 'bash',
        arguments: { env_id: 'env-1', command: 'pwd', cwd: '/srv/once' },
      },
    ]),
    response('done'),
  ]);
  const { store, coordinator, operations } = await fixture(provider);
  const task = store.createThread(
    action('CreateThread', 'operation-task', {
      title: 'operations',
      initialText: 'operations',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  await coordinator.deliver(task.input, task.runId);
  await waitStatus(store, task.runId, 'completed');
  const bashResult = store
    .listContext(ownerId, task.thread.threadId, 'thread')
    .find((message) => message.message.role === 'tool' && message.message.tool_name === 'bash');
  expect(bashResult?.message).toMatchObject({ status: 'success' });
  expect(bashResult?.message.content).toContain('"endOffset":"14"');
  const bash = operations.started.find((operation) => operation.action.case === 'bash');
  expect(bash).toMatchObject({ envId: 'env-1', bindingVersion: 1n });
  expect(bash?.action).toMatchObject({ case: 'bash', value: { cwd: '/srv/once' } });
  expect(store.agentEnvironments.requirePolicy(task.thread.threadId, 'thread').current.pwd).toBe(
    '/workspace',
  );
});

it('creates Subagents with execution tools but without Router delegation tools', async () => {
  const provider = new ScriptedProvider([
    response('', [
      {
        id: 'subagent-1',
        name: 'subagent',
        arguments: {
          task: 'child work',
          mode: 'foreground',
          allowed_env: ['env-1'],
        },
      },
    ]),
    response('child done'),
    response('parent done'),
  ]);
  const { store, coordinator } = await fixture(provider);
  const main = store.getOrCreateMainThread(ownerId);
  const input = store.sendMessage(
    action('SendMessage', 'parent-subagent', {
      threadId: main.threadId,
      text: 'delegate',
      mode: 'follow_up',
    }),
  );
  await coordinator.deliver(input.input, input.runId);
  await waitStatus(store, input.runId, 'completed');
  expect(provider.requests).toHaveLength(3);
  const childRequest = provider.requests[1];
  if (!childRequest) throw new Error('The Subagent Provider request is missing.');
  const childSystem = childRequest.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
  expect(childSystem).toContain('You are a Subagent assigned a bounded one-off task');
  expect(childSystem).toContain('Return a self-contained final response');
  expect(childSystem).not.toContain('You are the main Agent');
  expect(childSystem).not.toContain('You are the root Agent of a persistent task Thread');
  expect(toolNames(childRequest)).toEqual([
    'bash',
    'edit',
    'env_list',
    'env_sync',
    'glob',
    'grep',
    'read',
    'read_image',
    'recall',
    'skill',
    'task_list',
    'task_output',
    'task_stop',
    'task_wait',
    'web_fetch',
    'web_search',
    'write',
  ]);
  expect(toolNames(childRequest)).not.toContain('send_to_user');
  expect(provider.requests[1]?.messages.map((message) => message.content).join('\n')).toContain(
    '"role":"subagent"',
  );
});

it('reloads resources without changing the binding version and deduplicates the action', async () => {
  const provider = new ScriptedProvider([response('initial'), response('after reload')]);
  const { store, coordinator, operations } = await fixture(provider);
  operations.resourceSuffix = '';
  const task = store.createThread(
    action('CreateThread', 'reload-task', {
      title: 'reload',
      initialText: 'initial',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  await coordinator.deliver(task.input, task.runId);
  await waitStatus(store, task.runId, 'completed');
  const before = store.agentEnvironments.requirePolicy(task.thread.threadId, 'thread').current;
  operations.resourceSuffix = ' updated';
  const first = await coordinator.reloadResources({
    ownerId,
    threadId: task.thread.threadId,
    clientActionId: 'reload-1',
  });
  const duplicate = await coordinator.reloadResources({
    ownerId,
    threadId: task.thread.threadId,
    clientActionId: 'reload-1',
  });
  expect(duplicate).toEqual(first);
  expect(first.changed).toBe(true);
  const current = store.agentEnvironments.requirePolicy(task.thread.threadId, 'thread').current;
  expect(current.bindingVersion).toBe(before.bindingVersion);
  expect(current.resourceVersion).not.toBe(before.resourceVersion);
  expect(operations.started).toHaveLength(2);
  const next = store.sendMessage(
    action('SendMessage', 'after-reload', {
      threadId: task.thread.threadId,
      text: 'next',
      mode: 'follow_up',
    }),
  );
  await coordinator.deliver(next.input, next.runId);
  await waitStatus(store, next.runId, 'completed');
  expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
    `instructions for ${mainEnvId(store)} at /workspace updated`,
  );
});

it('rejects a conflicting Thread action before sharing an active reload', async () => {
  const provider = new ScriptedProvider([response('first initial'), response('second initial')]);
  const { store, coordinator, operations } = await fixture(provider);
  const firstTask = store.createThread(
    action('CreateThread', 'reload-first-thread', {
      title: 'first reload',
      initialText: 'first initial',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  await coordinator.deliver(firstTask.input, firstTask.runId);
  await waitStatus(store, firstTask.runId, 'completed');
  operations.resourceSuffix = ' second';
  const secondTask = store.createThread(
    action('CreateThread', 'reload-second-thread', {
      title: 'second reload',
      initialText: 'second initial',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  await coordinator.deliver(secondTask.input, secondTask.runId);
  await waitStatus(store, secondTask.runId, 'completed');
  const secondBefore = store.agentEnvironments.requirePolicy(secondTask.thread.threadId, 'thread')
    .current.resourceVersion;

  operations.resourceSuffix = ' updated';
  operations.deferDirectory = true;
  const firstReload = coordinator.reloadResources({
    ownerId,
    threadId: firstTask.thread.threadId,
    clientActionId: 'shared-reload-action',
  });
  const duplicate = coordinator.reloadResources({
    ownerId,
    threadId: firstTask.thread.threadId,
    clientActionId: 'shared-reload-action',
  });
  expect(duplicate).toBe(firstReload);
  await vi.waitFor(() => expect(operations.started).toHaveLength(3));
  const operationId = operations.started.at(-1)?.operationId;
  if (!operationId) throw new Error('The delayed reload operation is missing.');
  const conflicting = coordinator.reloadResources({
    ownerId,
    threadId: secondTask.thread.threadId,
    clientActionId: 'shared-reload-action',
  });
  operations.completeOperation(operationId, OperationStatus.COMPLETED);
  await expect(conflicting).rejects.toMatchObject({ code: 'action_conflict' });
  const firstResult = await firstReload;
  expect(await duplicate).toEqual(firstResult);
  expect(
    store.agentEnvironments.requirePolicy(secondTask.thread.threadId, 'thread').current
      .resourceVersion,
  ).toBe(secondBefore);
  expect(
    store.agentEnvironments.requirePolicy(firstTask.thread.threadId, 'thread').current
      .resourceVersion,
  ).toBe(firstResult.snapshotId);
  expect(operations.started).toHaveLength(3);

  const replay = await coordinator.reloadResources({
    ownerId,
    threadId: firstTask.thread.threadId,
    clientActionId: 'shared-reload-action',
  });
  expect(replay).toEqual(firstResult);
  expect(operations.started).toHaveLength(3);
});

it('recovers a completed attachment Operation without writing again after restart', async () => {
  const provider = new ScriptedProvider([
    response('first complete'),
    response('recovered complete'),
  ]);
  const { database, store, environments, coordinator, operations } = await fixture(provider);
  const attachment = store.attachments.upload({
    ownerId,
    clientActionId: 'upload-recover-attachment',
    fileName: 'note.txt',
    bytes: new TextEncoder().encode('recovery body'),
  }).attachment;
  const task = store.createThread(
    action('CreateThread', 'recover-attachment-task', {
      title: 'recover attachment',
      initialText: '',
      initialMode: 'follow_up',
      attachmentIds: [attachment.attachmentId],
      environmentPolicy: policy(),
    }),
  );
  await coordinator.deliver(task.input, task.runId);
  await waitStatus(store, task.runId, 'completed');
  const operationId = operations.started.find(
    (operation) => operation.action.case === 'write',
  )?.operationId;
  if (!operationId) throw new Error('The completed attachment write is missing.');

  database
    .prepare(
      "UPDATE context_message_attachments SET workspace_status = 'pending' WHERE attachment_id = ?",
    )
    .run(attachment.attachmentId);
  database
    .prepare("UPDATE input_attachments SET workspace_status = 'pending' WHERE attachment_id = ?")
    .run(attachment.attachmentId);
  store.updateRunStatus(task.runId, 'interrupted', {
    code: 'operation_unknown',
    message: 'simulated restart before the location commit',
    retryable: true,
  });
  const continued = store.continueRun(
    action('ContinueRun', 'continue-attachment-recovery', {
      threadId: task.thread.threadId,
      runId: task.runId,
    }),
  );
  await coordinator.close();
  const resumed = new RunCoordinator({
    store,
    model: {
      provider,
      providerId: 'test',
      modelId: 'test-model',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
    },
    environments,
    environmentOperations: operations,
    environmentUse: new ControlledEnvironmentUseGateway(store.database),
  });
  cleanup.push(async () => resumed.close());
  resumed.schedule(task.thread.threadId, continued.runId);
  await waitStatus(store, task.runId, 'completed');

  expect(provider.requests).toHaveLength(2);
  expect(operations.started.filter((operation) => operation.action.case === 'write')).toHaveLength(
    1,
  );
  expect(
    database
      .prepare(
        `SELECT workspace_status, operation_id FROM context_message_attachments
           WHERE attachment_id = ?`,
      )
      .get(attachment.attachmentId),
  ).toMatchObject({ workspace_status: 'completed', operation_id: operationId });
});

it('cancels an attachment write before Provider dispatch and preserves its pending evidence', async () => {
  const provider = new ScriptedProvider([]);
  const { database, store, coordinator, operations } = await fixture(provider);
  const attachment = store.attachments.upload({
    ownerId,
    clientActionId: 'upload-cancel-attachment',
    fileName: 'note.txt',
    bytes: new TextEncoder().encode('attachment body'),
  }).attachment;
  const task = store.createThread(
    action('CreateThread', 'cancel-attachment-task', {
      title: 'cancel attachment',
      initialText: '',
      initialMode: 'follow_up',
      attachmentIds: [attachment.attachmentId],
      environmentPolicy: policy(),
    }),
  );
  operations.deferWrite = true;
  await coordinator.deliver(task.input, task.runId);
  await vi.waitFor(() => {
    expect(operations.started.some((operation) => operation.action.case === 'write')).toBe(true);
  });
  const operationId = operations.started.find(
    (operation) => operation.action.case === 'write',
  )?.operationId;
  if (!operationId) throw new Error('The attachment write is missing.');
  const accepted = store.requestCancelRun(
    action('CancelRun', 'cancel-attachment-write', {
      threadId: task.thread.threadId,
      runId: task.runId,
      reason: 'stop attachment write',
    }),
  );
  await coordinator.cancel(accepted, 'stop attachment write');
  await vi.waitFor(() => expect(operations.cancelled).toContain(operationId));
  operations.completeOperation(operationId, OperationStatus.CANCELLED);
  await waitStatus(store, task.runId, 'cancelled');

  expect(provider.requests).toHaveLength(0);
  expect(operations.cancelled).toEqual([operationId]);
  expect(
    database
      .prepare(
        `SELECT workspace_status, env_id, path, operation_id FROM context_message_attachments
           WHERE attachment_id = ?`,
      )
      .get(attachment.attachmentId),
  ).toMatchObject({
    workspace_status: 'pending',
    env_id: expect.any(String),
    path: `/workspace/.kairos/attachments/${attachment.attachmentId}.txt`,
    operation_id: operationId,
  });
  expect(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM context_events WHERE event_type = 'model_request_dispatched'",
      )
      .get(),
  ).toEqual({ count: 0 });

  operations.deferWrite = false;
  const continued = store.continueRun(
    action('ContinueRun', 'continue-changed-attachment', {
      threadId: task.thread.threadId,
      runId: task.runId,
    }),
  );
  coordinator.schedule(task.thread.threadId, continued.runId);
  await waitStatus(store, task.runId, 'failed');
  expect(operations.started.filter((operation) => operation.action.case === 'write')).toHaveLength(
    1,
  );
  expect(store.getRunById(task.runId).error?.message).toContain('different content');
  expect(provider.requests).toHaveLength(0);
});

it('cancels an in-flight remote operation without changing the binding', async () => {
  const provider = new ScriptedProvider([
    response('', [{ id: 'bash-cancel', name: 'bash', arguments: { command: 'sleep 60' } }]),
  ]);
  const { store, coordinator, operations } = await fixture(provider);
  const task = store.createThread(
    action('CreateThread', 'cancel-task', {
      title: 'cancel',
      initialText: 'cancel',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  operations.deferBash = true;
  await coordinator.deliver(task.input, task.runId);
  await vi.waitFor(() => {
    expect(operations.started.some((operation) => operation.action.case === 'bash')).toBe(true);
  });
  const operationId = operations.started.find(
    (operation) => operation.action.case === 'bash',
  )?.operationId;
  const accepted = store.requestCancelRun(
    action('CancelRun', 'cancel-run', {
      threadId: task.thread.threadId,
      runId: task.runId,
      reason: 'stop',
    }),
  );
  await coordinator.cancel(accepted, 'stop');
  if (!operationId) throw new Error('The in-flight operation is missing.');
  await vi.waitFor(() => expect(operations.cancelled).toContain(operationId));
  operations.completeOperation(operationId, OperationStatus.CANCELLED);
  await waitStatus(store, task.runId, 'cancelled');
  expect(operations.cancelled).toEqual([operationId]);
  expect(operations.getEnvironmentOperation(ownerId, operationId).status).toBe(
    OperationStatus.CANCELLED,
  );
  const toolMessage = store
    .listContext(ownerId, task.thread.threadId, 'thread')
    .find(
      (message) =>
        message.message.role === 'tool' && message.message.tool_call_id === 'bash-cancel',
    );
  if (!toolMessage) throw new Error('The cancelled tool result is missing.');
  expect(toolMessage.message).toMatchObject({ status: 'error' });
  expect(toolMessage.message.content).toContain('"status":"cancelled"');
  expect(toolMessage.message.content).not.toBe('Tool execution was cancelled.');
  expect(
    store.agentEnvironments.requireOperation(task.thread.threadId, 'thread', operationId),
  ).toMatchObject({ resultContent: toolMessage.message.content, resultStatus: 'error' });
  expect(
    store.agentEnvironments.requirePolicy(task.thread.threadId, 'thread').current,
  ).toMatchObject({
    envId: mainEnvId(store),
    bindingVersion: 1,
  });
});

it('rejects new business operations while draining but allows directory reload', async () => {
  const provider = new ScriptedProvider([response('initial')]);
  const { store, coordinator, operations, environments } = await fixture(provider);
  const task = store.createThread(
    action('CreateThread', 'draining-task', {
      title: 'draining',
      initialText: 'initial',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  await coordinator.deliver(task.input, task.runId);
  await waitStatus(store, task.runId, 'completed');
  environments.setMaintenance({
    tenantId: ownerId,
    clientActionId: 'draining-1',
    envId: 'env-1',
    mode: 'draining',
    expectedVersion: 0n,
  });
  const run = store.getRunById(task.runId);
  const runtime = new AgentEnvironmentRuntime({
    store,
    environments,
    operations,
    environmentUse: new ControlledEnvironmentUseGateway(store.database),
  });
  await expect(
    runtime.execute(
      run,
      { case: 'read', value: { path: 'AGENTS.md', cwd: '/srv/one' } },
      'read-draining',
      new AbortController().signal,
      { envId: 'env-1' },
    ),
  ).rejects.toThrow(/draining/);
  expect(operations.started).toHaveLength(1);
  const reloaded = await coordinator.reloadResources({
    ownerId,
    threadId: task.thread.threadId,
    clientActionId: 'reload-draining',
  });
  expect(reloaded.changed).toBe(false);
  expect(operations.started).toHaveLength(2);
  expect(
    store.agentEnvironments.requirePolicy(task.thread.threadId, 'thread').current,
  ).toMatchObject({
    envId: mainEnvId(store),
    pwd: '/workspace',
    bindingVersion: 1,
  });
});

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

it('recovers a persisted operation result for the owning tenant after restart', async () => {
  const { store, environments, operations } = await fixture(new ScriptedProvider([]));
  const task = store.createThread(
    action('CreateThread', 'create-recovery-tenant', {
      title: 'recovery tenant',
      environmentPolicy: policy(),
    }),
  );
  const sent = store.sendMessage(
    action('SendMessage', 'send-recovery-tenant', {
      threadId: task.threadId,
      text: 'recover',
      mode: 'follow_up',
    }),
  );
  const current = store.agentEnvironments.requirePolicy(task.threadId, 'thread');
  store.transaction(() => {
    store.agentEnvironments.recordOperationIntent({
      operationId: 'recover-tenant-operation',
      runId: sent.runId,
      toolCallId: 'recover-tenant-call',
      policy: current,
      action: 'bash',
    });
  });
  await operations.startEnvironmentOperation({
    operationId: 'recover-tenant-operation',
    tenantId: ownerId,
    envId: 'env-1',
    bindingVersion: 1n,
    action: {
      case: 'bash',
      value: { command: 'printf recovered', cwd: '/srv/one', timeoutSeconds: 10 },
    },
    expiresAt: new Date(Date.now() + 30_000),
  });
  const runtime = new AgentEnvironmentRuntime({
    store,
    environments,
    operations,
    environmentUse: new ControlledEnvironmentUseGateway(store.database),
  });
  const recovered = await runtime.savedResult(sent.runId, 'recover-tenant-call');
  expect(recovered).toMatchObject({ status: 'success' });
  expect(recovered?.content).toContain('recover-tenant-operation');
  expect(recovered?.content).toContain('remote output');
  expect(store.agentEnvironments.savedResult(sent.runId, 'recover-tenant-call')).toEqual(recovered);
});

it('finishes cancellation during the initial directory check without dispatching a model request', async () => {
  const provider = new ScriptedProvider([]);
  const { store, coordinator, operations } = await fixture(provider);
  operations.deferDirectory = true;
  const task = store.createThread(
    action('CreateThread', 'create-initial-cancel', {
      title: 'initial cancellation',
      environmentPolicy: policy(),
    }),
  );
  const sent = store.sendMessage(
    action('SendMessage', 'send-initial-cancel', {
      threadId: task.threadId,
      text: 'cancel during initial directory check',
      mode: 'follow_up',
    }),
  );
  await coordinator.deliver(sent.input, sent.runId);
  await vi.waitFor(() =>
    expect(operations.started.some((operation) => operation.action.case === 'directoryCheck')).toBe(
      true,
    ),
  );
  const accepted = store.requestCancelRun(
    action('CancelRun', 'cancel-initial-directory', {
      threadId: task.threadId,
      runId: sent.runId,
      reason: 'stop initial directory check',
    }),
  );
  await coordinator.cancel(accepted, 'stop initial directory check');
  const operationId = operations.started.find(
    (operation) => operation.action.case === 'directoryCheck',
  )?.operationId;
  if (!operationId) throw new Error('The initial directory cancellation is missing.');
  await vi.waitFor(() => expect(operations.cancelled).toContain(operationId));
  operations.completeOperation(operationId, OperationStatus.CANCELLED);
  await waitStatus(store, sent.runId, 'cancelled');
  expect(operations.cancelled).toHaveLength(1);
  expect(operations.getEnvironmentOperation(ownerId, operationId).status).toBe(
    OperationStatus.CANCELLED,
  );
  expect(provider.requests).toHaveLength(0);
  expect(
    store.agentEnvironments.requirePolicy(task.threadId, 'thread').current.resourceVersion,
  ).toBeNull();
});

it('discards an unstarted association when aborted after the intent record', async () => {
  const { store, environments, operations } = await fixture(new ScriptedProvider([]));
  const task = store.createThread(
    action('CreateThread', 'abort-after-intent', {
      title: 'abort after intent',
      initialText: 'abort after intent',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  const run = store.getRunById(task.runId);
  const runtime = new AgentEnvironmentRuntime({
    store,
    environments,
    operations,
    environmentUse: new ControlledEnvironmentUseGateway(store.database),
  });
  runtime.reserveRun(run);
  const controller = new AbortController();
  const record = store.agentEnvironments.recordOperationIntent.bind(store.agentEnvironments);
  const spy = vi
    .spyOn(store.agentEnvironments, 'recordOperationIntent')
    .mockImplementation((input) => {
      record(input);
      controller.abort(new DOMException('Abort after intent record.', 'AbortError'));
    });
  try {
    await expect(runtime.prepare(run, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  } finally {
    spy.mockRestore();
  }
  expect(operations.started).toHaveLength(0);
  expect(operations.cancelled).toHaveLength(0);
  expect(
    store.agentEnvironments.findLatestOperation(run.runId, `initial:${run.runId}`),
  ).toBeUndefined();
  expect(
    store.agentEnvironments.requirePolicy(run.threadId, 'thread').current.resourceVersion,
  ).toBeNull();
});

it('continues once after closing before the initial remote start', async () => {
  const provider = new ScriptedProvider([response('continued before start')]);
  const { store, coordinator, operations, environments } = await fixture(provider);
  const task = store.createThread(
    action('CreateThread', 'close-before-start', {
      title: 'close before start',
      initialText: 'close before start',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  coordinator.schedule(task.thread.threadId, task.runId);
  await coordinator.close();
  expect(store.getRunById(task.runId).status).toBe('interrupted');
  expect(operations.started).toHaveLength(0);
  expect(provider.requests).toHaveLength(0);

  const continued = store.continueRun(
    action('ContinueRun', 'continue-close-before-start', {
      threadId: task.thread.threadId,
      runId: task.runId,
    }),
  );
  const resumed = new RunCoordinator({
    store,
    model: {
      provider,
      providerId: 'test',
      modelId: 'test-model',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
    },
    environments,
    environmentOperations: operations,
    environmentUse: new ControlledEnvironmentUseGateway(store.database),
  });
  cleanup.push(async () => resumed.close());
  resumed.schedule(task.thread.threadId, continued.runId);
  await waitStatus(store, task.runId, 'completed');
  expect(
    operations.started.filter((operation) => operation.action.case === 'directoryCheck'),
  ).toHaveLength(1);
  expect(provider.requests).toHaveLength(1);
  expect(
    store.agentEnvironments.requirePolicy(task.thread.threadId, 'thread').current.resourceVersion,
  ).not.toBeNull();
});

it('reuses a completed initial directory result after an interrupted Run', async () => {
  const provider = new ScriptedProvider([response('recovered initial resources')]);
  const { store, coordinator, operations } = await fixture(provider);
  const { task, sent } = await seedInitialAttempt(
    store,
    operations,
    'interrupted',
    OperationStatus.COMPLETED,
  );
  expect(
    store.agentEnvironments.requirePolicy(task.threadId, 'thread').current.resourceVersion,
  ).toBeNull();
  const continued = store.continueRun(
    action('ContinueRun', 'continue-completed-initial', {
      threadId: task.threadId,
      runId: sent.runId,
    }),
  );
  await coordinator.schedule(task.threadId, continued.runId);
  await waitStatus(store, sent.runId, 'completed');
  expect(operations.started).toHaveLength(1);
  expect(provider.requests).toHaveLength(1);
  expect(
    store.agentEnvironments.requirePolicy(task.threadId, 'thread').current.resourceVersion,
  ).toMatch(/^[a-f0-9]{64}$/);
});

it('coordinates an in-flight initial directory result without starting a duplicate', async () => {
  const provider = new ScriptedProvider([response('coordinated initial resources')]);
  const { store, coordinator, operations } = await fixture(provider);
  const { task, sent } = await seedInitialAttempt(
    store,
    operations,
    'interrupted',
    OperationStatus.RUNNING,
  );
  const continued = store.continueRun(
    action('ContinueRun', 'continue-inflight-initial', {
      threadId: task.threadId,
      runId: sent.runId,
    }),
  );
  await coordinator.schedule(task.threadId, continued.runId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  operations.completeOperation('initial-operation', OperationStatus.COMPLETED);
  await waitStatus(store, sent.runId, 'completed');
  expect(operations.started).toHaveLength(1);
  expect(provider.requests).toHaveLength(1);
});

it('creates a new initial attempt after a known failed directory check', async () => {
  const provider = new ScriptedProvider([response('retried failed initial check')]);
  const { store, coordinator, operations } = await fixture(provider);
  const { task, sent } = await seedInitialAttempt(
    store,
    operations,
    'failed',
    OperationStatus.FAILED,
  );
  const continued = store.continueRun(
    action('ContinueRun', 'continue-failed-initial', {
      threadId: task.threadId,
      runId: sent.runId,
    }),
  );
  await coordinator.schedule(task.threadId, continued.runId);
  await waitStatus(store, sent.runId, 'completed');
  expect(operations.started).toHaveLength(2);
  expect(provider.requests).toHaveLength(1);
  expect(
    store.agentEnvironments.findLatestOperation(sent.runId, `initial:${sent.runId}`)?.toolCallId,
  ).toContain(':retry:');
});

it('uses the second initial attempt when equal timestamps and UUIDs sort in reverse', async () => {
  const provider = new ScriptedProvider([response('recovered second initial attempt')]);
  const { store, coordinator, operations } = await fixture(provider);
  const firstOperationId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const secondOperationId = '00000000-0000-0000-0000-000000000000';
  const { task, sent } = await seedInitialAttempt(
    store,
    operations,
    'interrupted',
    OperationStatus.FAILED,
    firstOperationId,
  );
  const current = store.agentEnvironments.requirePolicy(task.threadId, 'thread');
  store.transaction(() => {
    store.agentEnvironments.recordOperationIntent({
      operationId: secondOperationId,
      runId: sent.runId,
      toolCallId: `initial:${sent.runId}:retry:${firstOperationId}`,
      policy: current,
      action: 'directory_check',
    });
  });
  await operations.startEnvironmentOperation({
    operationId: secondOperationId,
    tenantId: ownerId,
    envId: mainEnvId(store),
    action: {
      case: 'directoryCheck',
      value: { path: '/workspace', loadWorkspace: true },
    },
    expiresAt: new Date(Date.now() + 30_000),
  });
  operations.completeOperation(secondOperationId, OperationStatus.COMPLETED);
  store.database
    .prepare('UPDATE agent_environment_operations SET created_at = ? WHERE run_id = ?')
    .run(now, sent.runId);
  expect(secondOperationId < firstOperationId).toBe(true);
  expect(
    store.agentEnvironments.findLatestOperation(sent.runId, `initial:${sent.runId}`)?.operationId,
  ).toBe(secondOperationId);

  const continued = store.continueRun(
    action('ContinueRun', 'continue-second-initial', {
      threadId: task.threadId,
      runId: sent.runId,
    }),
  );
  await coordinator.schedule(task.threadId, continued.runId);
  await waitStatus(store, sent.runId, 'completed');
  expect(operations.started.map((operation) => operation.operationId)).toEqual([
    firstOperationId,
    secondOperationId,
  ]);
  expect(provider.requests).toHaveLength(1);
});

it('creates a new initial attempt after a confirmed cancelled directory check', async () => {
  const provider = new ScriptedProvider([response('retried cancelled initial check')]);
  const { store, coordinator, operations } = await fixture(provider);
  const { task, sent } = await seedInitialAttempt(
    store,
    operations,
    'cancelled',
    OperationStatus.CANCELLED,
  );
  const continued = store.continueRun(
    action('ContinueRun', 'continue-cancelled-initial', {
      threadId: task.threadId,
      runId: sent.runId,
    }),
  );
  await coordinator.schedule(task.threadId, continued.runId);
  await waitStatus(store, sent.runId, 'completed');
  expect(operations.started).toHaveLength(2);
  expect(provider.requests).toHaveLength(1);
});

it('does not replay an unknown initial directory operation', async () => {
  const provider = new ScriptedProvider([]);
  const { store, coordinator, operations } = await fixture(provider);
  const { task, sent } = await seedInitialAttempt(
    store,
    operations,
    'interrupted',
    OperationStatus.UNKNOWN,
  );
  const continued = store.continueRun(
    action('ContinueRun', 'continue-unknown-initial', {
      threadId: task.threadId,
      runId: sent.runId,
    }),
  );
  await coordinator.schedule(task.threadId, continued.runId);
  await waitStatus(store, sent.runId, 'failed');
  expect(store.getRunById(sent.runId).error?.code).toBe('operation_unknown');
  expect(operations.started).toHaveLength(1);
  expect(provider.requests).toHaveLength(0);
  expect(
    store.agentEnvironments.requirePolicy(task.threadId, 'thread').current.resourceVersion,
  ).toBeNull();
});

it('keeps an unconfirmed cancellation as operation_unknown instead of cancelled', async () => {
  const provider = new ScriptedProvider([
    response('', [{ id: 'bash-cancel-unknown', name: 'bash', arguments: { command: 'sleep 60' } }]),
  ]);
  const { store, coordinator, operations } = await fixture(provider);
  operations.deferBash = true;
  operations.cancelExpiresAt = new Date(Date.now() + 50);
  const task = store.createThread(
    action('CreateThread', 'create-cancel-unknown', {
      title: 'cancel unknown',
      initialText: 'cancel unknown',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  await coordinator.deliver(task.input, task.runId);
  await vi.waitFor(() => {
    expect(operations.started.some((operation) => operation.action.case === 'bash')).toBe(true);
  });
  const operationId = operations.started.find(
    (operation) => operation.action.case === 'bash',
  )?.operationId;
  const accepted = store.requestCancelRun(
    action('CancelRun', 'cancel-unknown-run', {
      threadId: task.thread.threadId,
      runId: task.runId,
      reason: 'stop without a terminal result',
    }),
  );
  await coordinator.cancel(accepted, 'stop without a terminal result');
  await waitStatus(store, task.runId, 'failed');
  expect(store.getRunById(task.runId).error?.code).toBe('operation_unknown');
  if (!operationId) throw new Error('The unconfirmed operation is missing.');
  const remote = operations.getEnvironmentOperation(ownerId, operationId);
  expect(remote.status).toBe(OperationStatus.CANCEL_REQUESTED);
  expect(remote.resultStatus).toBeUndefined();
  const tool = store
    .listContext(ownerId, task.thread.threadId, 'thread')
    .find(
      (message) =>
        message.message.role === 'tool' && message.message.tool_call_id === 'bash-cancel-unknown',
    );
  expect(tool?.message.content).toContain('not confirmed before expiration');
  expect(tool?.message.content).not.toContain('Tool execution was cancelled.');
});

it('fails an unconfirmed initial directory cancellation without dispatching a model request', async () => {
  const provider = new ScriptedProvider([]);
  const { store, coordinator, operations } = await fixture(provider);
  operations.deferDirectory = true;
  operations.cancelExpiresAt = new Date(Date.now() + 50);
  const task = store.createThread(
    action('CreateThread', 'create-initial-cancel-unknown', {
      title: 'initial cancellation unknown',
      initialText: 'cancel initial directory check',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  await coordinator.deliver(task.input, task.runId);
  await vi.waitFor(() =>
    expect(operations.started.some((operation) => operation.action.case === 'directoryCheck')).toBe(
      true,
    ),
  );
  const operationId = operations.started.find(
    (operation) => operation.action.case === 'directoryCheck',
  )?.operationId;
  const accepted = store.requestCancelRun(
    action('CancelRun', 'cancel-initial-directory-unknown', {
      threadId: task.thread.threadId,
      runId: task.runId,
      reason: 'stop without a directory result',
    }),
  );
  await coordinator.cancel(accepted, 'stop without a directory result');
  await waitStatus(store, task.runId, 'failed');
  expect(store.getRunById(task.runId).error?.code).toBe('operation_unknown');
  if (!operationId) throw new Error('The initial directory operation is missing.');
  const remote = operations.getEnvironmentOperation(ownerId, operationId);
  expect(remote.status).toBe(OperationStatus.CANCEL_REQUESTED);
  expect(remote.resultStatus).toBeUndefined();
  expect(provider.requests).toHaveLength(0);
  expect(
    store.agentEnvironments.requirePolicy(task.thread.threadId, 'thread').current.resourceVersion,
  ).toBeNull();
});

it('executes read_image in a task Thread and persists only attachment references', async () => {
  const provider = new ScriptedProvider([
    response('', [{ id: 'image-task', name: 'read_image', arguments: { path: 'pixel.png' } }]),
    response('image done'),
  ]);
  const { database, store, coordinator, operations } = await fixture(provider);
  const task = store.createThread(
    action('CreateThread', 'image-task-thread', {
      title: 'image task',
      initialText: 'inspect the image',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  await coordinator.deliver(task.input, task.runId);
  await waitStatus(store, task.runId, 'completed');

  expect(operations.started).toContainEqual(
    expect.objectContaining({
      operationId: expect.any(String),
      action: { case: 'readImage', value: { path: '/workspace/pixel.png', cwd: '/workspace' } },
      bindingVersion: 1n,
    }),
  );
  const saved = store
    .listContext(ownerId, task.thread.threadId, 'thread')
    .find(
      (record) => record.message.role === 'tool' && record.message.tool_call_id === 'image-task',
    );
  expect(saved?.attachments).toHaveLength(1);
  expect(saved?.attachments?.[0]).toMatchObject({
    fileName: 'pixel.png',
    mediaType: 'image/png',
    width: 1,
    height: 1,
    byteSize: pngBytes.length,
    sha256: createHash('sha256').update(pngBytes).digest('hex'),
  });
  expect(saved?.message.content).not.toContain(';base64,');

  const dispatched = provider.requests[1]?.messages.find(
    (message) => message.role === 'tool' && message.tool_call_id === 'image-task',
  );
  expect(dispatched).toMatchObject({
    role: 'tool',
    tool_call_id: 'image-task',
    tool_name: 'read_image',
    content_parts: [
      { type: 'text', text: 'Attachment: pixel.png' },
      { type: 'image_url', image_url: { detail: 'low' } },
    ],
  });
  expect(JSON.stringify(dispatched)).toContain(';base64,');
  const evidence = database
    .prepare('SELECT request_json FROM model_request_records WHERE request_json IS NOT NULL')
    .all();
  expect(evidence.length).toBeGreaterThan(0);
  expect(JSON.stringify(evidence)).not.toContain(';base64,');
});

it('executes read_image in the main conversation after binding an environment', async () => {
  const provider = new ScriptedProvider([
    response('', [
      {
        id: 'image-main-switch',
        name: 'env_switch',
        arguments: { env_id: 'env-1', pwd: '/srv/one' },
      },
    ]),
    response('', [{ id: 'image-main', name: 'read_image', arguments: { path: 'pixel.png' } }]),
    response('main image done'),
  ]);
  const { store, coordinator, operations } = await fixture(provider);
  const main = store.getOrCreateMainThread(ownerId);
  const input = store.sendMessage(
    action('SendMessage', 'image-main-input', {
      threadId: main.threadId,
      text: 'inspect the image',
      mode: 'follow_up',
    }),
  );
  await coordinator.deliver(input.input, input.runId);
  await waitStatus(store, input.runId, 'completed');
  expect(operations.started.map((operation) => operation.action.case)).toEqual([
    'directoryCheck',
    'readImage',
  ]);
  const saved = store
    .listContext(ownerId, main.threadId, 'thread')
    .find(
      (record) => record.message.role === 'tool' && record.message.tool_call_id === 'image-main',
    );
  expect(saved?.attachments).toHaveLength(1);
});

it('executes read_image in a Subagent with its inherited environment scope', async () => {
  const provider = new ScriptedProvider([
    response('', [
      {
        id: 'image-subagent-create',
        name: 'subagent',
        arguments: {
          task: 'inspect the image',
          mode: 'foreground',
          allowed_env: ['env-1'],
        },
      },
    ]),
    response('', [{ id: 'image-subagent', name: 'read_image', arguments: { path: 'pixel.png' } }]),
    response('child image done'),
    response('parent image done'),
  ]);
  const { store, coordinator, operations } = await fixture(provider);
  const main = store.getOrCreateMainThread(ownerId);
  const input = store.sendMessage(
    action('SendMessage', 'image-subagent-input', {
      threadId: main.threadId,
      text: 'delegate image inspection',
      mode: 'follow_up',
    }),
  );
  await coordinator.deliver(input.input, input.runId);
  await waitStatus(store, input.runId, 'completed');
  const child = store
    .listRuns(ownerId, main.threadId)
    .find((run) => run.parentRunId === input.runId);
  if (!child) throw new Error('The image Subagent Run is missing.');
  const saved = store
    .listContext(ownerId, main.threadId, child.agentId)
    .find(
      (record) =>
        record.message.role === 'tool' && record.message.tool_call_id === 'image-subagent',
    );
  expect(saved?.attachments).toHaveLength(1);
  expect(operations.started).toContainEqual(
    expect.objectContaining({
      action: { case: 'readImage', value: { path: '/workspace/pixel.png', cwd: '/workspace' } },
    }),
  );
});

it('returns read_image validation errors and rejects offline self-hosted environments', async () => {
  const { database, store, environments, operations } = await fixture(new ScriptedProvider([]));
  const task = store.createThread(
    action('CreateThread', 'image-validation-task', {
      title: 'image validation',
      initialText: 'validate images',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  const run = store.getRunById(task.runId);
  const runtime = new AgentEnvironmentRuntime({
    store,
    environments,
    operations,
    environmentUse: new ControlledEnvironmentUseGateway(store.database),
  });
  const execute = (callId: string) =>
    runtime.execute(
      run,
      { case: 'readImage', value: { path: 'candidate.png', cwd: '/srv/one' } },
      callId,
      new AbortController().signal,
      { envId: 'env-1' },
    );
  const commit = (result: { commit?: () => void }) =>
    store.transaction(() => {
      result.commit?.();
    });

  const text = new TextEncoder().encode('not an image');
  operations.imageBytes = text;
  operations.imageFileVersion = createHash('sha256').update(text).digest('hex');
  const nonImage = await execute('image-non-image');
  expect(nonImage.status).toBe('error');
  expect(nonImage.content).toContain('only PNG and JPEG');
  commit(nonImage);

  const oversized = new Uint8Array(700_001);
  operations.imageBytes = oversized;
  operations.imageFileVersion = createHash('sha256').update(oversized).digest('hex');
  const tooLarge = await execute('image-too-large');
  expect(tooLarge.status).toBe('error');
  expect(tooLarge.content).toContain('700000');
  commit(tooLarge);

  operations.imageBytes = pngBytes;
  operations.imageFileVersion = '0'.repeat(64);
  const mismatched = await execute('image-hash-mismatch');
  expect(mismatched.status).toBe('error');
  expect(mismatched.content).toContain('SHA-256');
  commit(mismatched);
  expect(database.prepare('SELECT COUNT(*) AS count FROM attachments').get()).toEqual({ count: 0 });

  environments.database
    .prepare("UPDATE environments SET connection_status = 'offline' WHERE env_id = 'env-1'")
    .run();
  await expect(execute('image-offline')).rejects.toMatchObject({ code: 'failed_precondition' });
  expect(operations.started).toHaveLength(3);
});

it('cancels read_image and recovers its saved attachment result without repeating the Operation', async () => {
  const { store, environments, operations } = await fixture(new ScriptedProvider([]));
  const task = store.createThread(
    action('CreateThread', 'image-recovery-task', {
      title: 'image recovery',
      initialText: 'recover images',
      initialMode: 'follow_up',
      environmentPolicy: policy(),
    }),
  );
  const run = store.getRunById(task.runId);
  const runtime = new AgentEnvironmentRuntime({
    store,
    environments,
    operations,
    environmentUse: new ControlledEnvironmentUseGateway(store.database),
  });
  operations.deferImage = true;
  const controller = new AbortController();
  const pending = runtime.execute(
    run,
    { case: 'readImage', value: { path: 'cancel.png', cwd: '/srv/one' } },
    'image-cancel',
    controller.signal,
  );
  await vi.waitFor(() =>
    expect(operations.started.some((operation) => operation.action.case === 'readImage')).toBe(
      true,
    ),
  );
  controller.abort(new DOMException('stop image read', 'AbortError'));
  await vi.waitFor(() => expect(operations.cancelled).toHaveLength(1));
  const cancelledId = operations.cancelled[0];
  if (!cancelledId) throw new Error('The cancelled image Operation is missing.');
  operations.completeOperation(cancelledId, OperationStatus.CANCELLED);
  const cancelled = await pending;
  expect(cancelled.status).toBe('error');
  expect(cancelled.content).toContain('"status":"cancelled"');
  store.transaction(() => {
    cancelled.commit?.();
  });

  operations.deferImage = false;
  const completed = await runtime.execute(
    run,
    { case: 'readImage', value: { path: 'recovered.png', cwd: '/srv/one' } },
    'image-recovered',
    new AbortController().signal,
  );
  expect(completed.status).toBe('success');
  const recovered = await runtime.savedResult(run.runId, 'image-recovered');
  const saved = await runtime.savedResult(run.runId, 'image-recovered');
  expect(recovered?.status).toBe('success');
  expect(recovered?.content_parts).toEqual([
    { type: 'attachment', attachment_id: expect.any(String) },
  ]);
  expect(saved?.content_parts).toEqual(recovered?.content_parts);
  expect(
    operations.started.filter((operation) => operation.action.case === 'readImage'),
  ).toHaveLength(2);
});
