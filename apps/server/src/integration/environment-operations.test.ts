import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Code } from '@connectrpc/connect';
import type { ModelEvent, ModelProvider, ModelRequest, ToolCall } from '@kairos/agent-core';
import { InputMode } from '@kairos/contracts';
import type { ServerMessage } from '@kairos/contracts/device';
import {
  DEVICE_PROTOCOL_MAJOR,
  DeviceCapability,
  DeviceErrorAction,
  DeviceErrorCode,
  decodeServerMessage,
  encodeDaemonMessage,
  OperationStatus,
} from '@kairos/contracts/device';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';
import type { StartEnvironmentOperationInput } from '../devices/channel.js';
import { DeviceChannel } from '../devices/channel.js';
import { EnvironmentOperationStore } from '../devices/environment-operation-store.js';
import { EnvironmentStore } from '../devices/environment-store.js';
import { DeviceFailure } from '../devices/errors.js';
import { registerDeviceWebSocket } from '../devices/websocket.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { startRealEnvironmentServer } from './environment-fixture.js';

const cleanup: Array<() => Promise<void> | void> = [];
const tenantId = 'tenant-integration';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const daemonMain = join(repository, 'apps/daemon/src/main.ts');

async function waitFor<T>(read: () => T | undefined, timeoutMilliseconds = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for environment operation state.');
}

interface DaemonController {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

interface Fixture {
  database: DatabaseSync;
  environments: EnvironmentStore;
  operations: EnvironmentOperationStore;
  channel: DeviceChannel;
  daemon: DaemonController;
  workspace: string;
  identityDirectory: string;
  envId: string;
  url: string;
}

async function startFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'kairos-environment-operations-'));
  const workspace = join(root, 'workspace');
  const identityDirectory = join(root, 'identity');
  const databasePath = join(root, 'server.sqlite');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(identityDirectory, { recursive: true });
  writeFileSync(join(workspace, 'AGENTS.md'), '# Remote workspace\n');
  mkdirSync(join(workspace, '.agents', 'skills'), { recursive: true });
  mkdirSync(join(workspace, '.agents', 'skills', 'review'));
  writeFileSync(join(workspace, '.agents', 'skills', 'review', 'SKILL.md'), '# Review skill\n');
  const database = openDatabase(databasePath);
  const now = new Date().toISOString();
  database
    .prepare('INSERT INTO tenants(tenant_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(tenantId, 'user-integration', now, now);
  database
    .prepare(
      `INSERT INTO users(user_id, email, email_verified_at, tenant_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run('user-integration', 'integration@example.com', now, tenantId, now, now);
  new SessionStore(database);
  const environments = new EnvironmentStore(database);
  const operations = new EnvironmentOperationStore(database);
  const channel = new DeviceChannel({
    environments,
    environmentOperations: operations,
  });
  const server: FastifyInstance = Fastify({ logger: false });
  registerDeviceWebSocket(server, channel);
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Missing integration Server address.');
  const issued = environments.register({
    tenantId,
    clientActionId: 'register-integration',
    name: 'Integration environment',
    recommendedPwd: workspace,
    kind: process.platform === 'darwin' ? 'self_hosted_macos' : 'self_hosted_linux',
  });
  const identityPath = join(identityDirectory, 'identity.json');
  const url = `ws://127.0.0.1:${address.port}/devices/wss`;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    KAIROS_DEVICE_IDENTITY_PATH: identityPath,
    KAIROS_DAEMON_VERSION: 'integration-test',
  };
  const pairing = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      daemonMain,
      'pair-once',
      '--env-id',
      issued.environment.envId,
      '--server-url',
      url,
      '--directory',
      workspace,
      '--device-name',
      'Integration macOS device',
      '--identity-path',
      identityPath,
      '--timeout-seconds',
      '10',
    ],
    { cwd: repository, env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let pairingOutput = '';
  pairing.stdout.on('data', (chunk) => (pairingOutput += chunk));
  pairing.stderr.on('data', (chunk) => (pairingOutput += chunk));
  pairing.stdin.end(issued.pairingCredential);
  const pairingCode = await new Promise<number | null>((resolve, reject) => {
    pairing.once('error', reject);
    pairing.once('exit', resolve);
  });
  if (pairingCode !== 0) throw new Error(`Daemon pair-once failed: ${pairingOutput}`);

  let child: ChildProcess | undefined;
  let serviceOutput = '';
  const stop = async () => {
    const current = child;
    child = undefined;
    if (current === undefined) return;
    if (current.exitCode !== null || current.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => current.once('exit', () => resolve()));
    current.kill('SIGTERM');
    const timeout = setTimeout(() => current.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timeout);
  };
  const start = async () => {
    if (child !== undefined) return;
    child = spawn(process.execPath, ['--import', 'tsx', daemonMain], {
      cwd: repository,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => (serviceOutput += chunk));
    child.stderr?.on('data', (chunk) => (serviceOutput += chunk));
    try {
      await waitFor(() => {
        const current = environments.get(tenantId, issued.environment.envId);
        const capabilities = current.grantedCapabilities;
        return current.ready &&
          [
            DeviceCapability.BASH,
            DeviceCapability.FILE_READ,
            DeviceCapability.FILE_WRITE,
            DeviceCapability.FILE_EDIT,
            DeviceCapability.DIRECTORY_CHECK,
          ].every((capability) => capabilities.includes(capability))
          ? true
          : undefined;
      });
    } catch (error) {
      throw new AggregateError([error], `Daemon service did not become ready: ${serviceOutput}`);
    }
  };
  cleanup.push(async () => {
    await stop();
    channel.close();
    await server.close();
    if (database.isOpen) database.close();
    rmSync(root, { recursive: true, force: true });
  });
  await start();
  return {
    database,
    environments,
    operations,
    channel,
    daemon: { start, stop },
    workspace,
    identityDirectory,
    envId: issued.environment.envId,
    url,
  };
}

function operationInput(
  fixture: Fixture,
  operationId: string,
  action: StartEnvironmentOperationInput['action'],
): StartEnvironmentOperationInput {
  return {
    operationId,
    tenantId,
    envId: fixture.envId,
    ...(action.case === 'directoryCheck' ? {} : { bindingVersion: 1n }),
    action,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

async function waitOperation(fixture: Fixture, operationId: string, acknowledged = true) {
  return waitFor(() => {
    const operation = fixture.operations.find(operationId);
    if (
      operation?.resultRecordedAt === undefined ||
      operation.postProcessedAt === undefined ||
      (acknowledged && operation.resultAcknowledgedAt === undefined)
    ) {
      return undefined;
    }
    return operation;
  });
}

async function startAndWait(fixture: Fixture, input: StartEnvironmentOperationInput) {
  await fixture.channel.startEnvironmentOperation(input);
  return waitOperation(fixture, input.operationId);
}

async function startAfterReconnect(fixture: Fixture, input: StartEnvironmentOperationInput) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      return await fixture.channel.startEnvironmentOperation(input);
    } catch (error) {
      if (!(error instanceof DeviceFailure && error.code === DeviceErrorCode.ENVIRONMENT_OFFLINE)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error('Daemon did not reconnect before the operation deadline.');
}

afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

describe('real environment Operation execution', () => {
  it('executes remote files and Bash with persisted output, maintenance, and revocation checks', async () => {
    const fixture = await startFixture();
    const { workspace, channel, operations, environments, database } = fixture;
    expect(environments.requireReady(tenantId, fixture.envId).grantedCapabilities).toEqual([
      DeviceCapability.BASH,
      DeviceCapability.FILE_READ,
      DeviceCapability.FILE_WRITE,
      DeviceCapability.FILE_EDIT,
      DeviceCapability.DIRECTORY_CHECK,
      DeviceCapability.DIRECTORY_LIST,
    ]);
    const directoryRow = database
      .prepare(
        `SELECT result_payload FROM environment_operations
         WHERE action = 'directory_check' ORDER BY created_at DESC LIMIT 1`,
      )
      .get();
    expect(directoryRow).toBeDefined();
    const readinessOperation = operations.listPendingForInstance(
      environments.get(tenantId, fixture.envId).deviceBindingId ?? '',
      environments.get(tenantId, fixture.envId).instanceId ?? '',
    );
    expect(readinessOperation).toHaveLength(0);

    const path = join(workspace, 'remote.txt');
    await startAndWait(
      fixture,
      operationInput(fixture, 'write-1', {
        case: 'write',
        value: { path, cwd: workspace, content: 'alpha old old\n', overwrite: false },
      }),
    );
    expect(readFileSync(path, 'utf8')).toBe('alpha old old\n');
    await expect(
      channel.startEnvironmentOperation(
        operationInput(fixture, 'write-1', {
          case: 'write',
          value: { path, cwd: workspace, content: 'different', overwrite: true },
        }),
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.OPERATION_CONFLICT });
    expect(readFileSync(path, 'utf8')).toBe('alpha old old\n');
    await expect(
      channel.startEnvironmentOperation({
        ...operationInput(fixture, 'write-1', {
          case: 'write',
          value: { path, cwd: workspace, content: 'alpha old old\n', overwrite: false },
        }),
        envId: 'different-env',
      }),
    ).rejects.toMatchObject({ code: DeviceErrorCode.OPERATION_CONFLICT });
    await expect(
      channel.startEnvironmentOperation({
        ...operationInput(fixture, 'write-1', {
          case: 'write',
          value: { path, cwd: workspace, content: 'alpha old old\n', overwrite: false },
        }),
        bindingVersion: 999n,
      }),
    ).rejects.toMatchObject({ code: DeviceErrorCode.OPERATION_CONFLICT });
    expect(operations.find('write-1')).toMatchObject({ envId: fixture.envId, bindingVersion: 1n });

    const read = await startAndWait(
      fixture,
      operationInput(fixture, 'read-1', {
        case: 'read',
        value: { path, cwd: workspace, offset: 1, limit: 1 },
      }),
    );
    if (read.outcome?.case !== 'read') throw new Error('Read outcome is missing.');
    expect(read.outcome.value.content).toBe('alpha old old\n');
    expect(read.outcome.value.fileVersion).toMatch(/^[a-f0-9]{64}$/);

    const edited = await startAndWait(
      fixture,
      operationInput(fixture, 'edit-1', {
        case: 'edit',
        value: {
          path,
          cwd: workspace,
          oldText: 'old',
          newText: 'new',
          expectedOccurrences: 2,
          expectedFileVersion: read.outcome.value.fileVersion,
        },
      }),
    );
    if (edited.outcome?.case !== 'edit') throw new Error('Edit outcome is missing.');
    expect(edited.outcome.value.replacements).toBe(2);
    expect(readFileSync(path, 'utf8')).toBe('alpha new new\n');
    expect(readdirSync(workspace).sort()).toEqual(['.agents', 'AGENTS.md', 'remote.txt']);

    const appendPath = join(workspace, 'append.txt');
    const bashInput = operationInput(fixture, 'bash-1', {
      case: 'bash',
      value: {
        command: `printf once >> ${JSON.stringify(appendPath)}; printf remote-output`,
        cwd: workspace,
        timeoutSeconds: 20,
      },
    });
    const bash = await startAndWait(fixture, bashInput);
    expect(bash).toMatchObject({
      status: OperationStatus.COMPLETED,
      outputComplete: true,
      outputGap: false,
    });
    if (bash.outcome?.case !== 'bash') throw new Error('Bash outcome is missing.');
    expect(bash.outcome.value).toMatchObject({ exitCode: 0, endOffset: 13n });
    expect(readFileSync(appendPath, 'utf8')).toBe('once');
    await channel.startEnvironmentOperation(bashInput);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(appendPath, 'utf8')).toBe('once');
    const log = channel.readEnvironmentOperationOutput({
      tenantId,
      operationId: 'bash-1',
      offset: 0n,
      limit: 1024,
    });
    expect(Buffer.from(log.data).toString()).toBe('remote-output');
    expect(log).toMatchObject({ nextOffset: 13n, outputComplete: true, outputGap: false });

    await channel.startEnvironmentOperation(
      operationInput(fixture, 'bash-drain-active', {
        case: 'bash',
        value: { command: 'sleep 30', cwd: workspace, timeoutSeconds: 30 },
      }),
    );
    const maintenance = environments.setMaintenance({
      tenantId,
      clientActionId: 'drain-1',
      envId: fixture.envId,
      mode: 'draining',
      expectedVersion: 0n,
    });
    expect(
      operations.countActiveForBinding(
        environments.get(tenantId, fixture.envId).deviceBindingId ?? '',
      ),
    ).toBe(1);
    await expect(
      channel.startEnvironmentOperation(
        operationInput(fixture, 'read-during-drain', {
          case: 'read',
          value: { path, cwd: workspace },
        }),
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.PERMISSION_DENIED });
    await startAndWait(
      fixture,
      operationInput(fixture, 'directory-during-drain', {
        case: 'directoryCheck',
        value: { path: workspace, loadWorkspace: true },
      }),
    );
    await channel.cancelEnvironmentOperation({
      tenantId,
      operationId: 'bash-drain-active',
      reason: 'finish maintenance drain',
    });
    await waitOperation(fixture, 'bash-drain-active');
    expect(
      operations.countActiveForBinding(
        environments.get(tenantId, fixture.envId).deviceBindingId ?? '',
      ),
    ).toBe(0);

    const cancelledInput = operationInput(fixture, 'bash-cancel', {
      case: 'bash',
      value: { command: 'sleep 30', cwd: workspace, timeoutSeconds: 30 },
    });
    expect(maintenance.mode).toBe('draining');
    environments.setMaintenance({
      tenantId,
      clientActionId: 'normal-1',
      envId: fixture.envId,
      mode: 'normal',
      expectedVersion: 1n,
    });
    await channel.startEnvironmentOperation(cancelledInput);
    await channel.cancelEnvironmentOperation({
      tenantId,
      operationId: 'bash-cancel',
      reason: 'integration cancellation',
    });
    const cancelled = await waitOperation(fixture, 'bash-cancel');
    expect(cancelled.status).toBe(OperationStatus.CANCELLED);
    if (cancelled.outcome?.case !== 'bash') throw new Error('Cancellation outcome is missing.');
    expect(cancelled.outcome.value.exitCode).toBeUndefined();

    environments.revoke({ tenantId, clientActionId: 'revoke-1', envId: fixture.envId });
    await expect(
      channel.startEnvironmentOperation(
        operationInput(fixture, 'bash-after-revoke', {
          case: 'bash',
          value: { command: 'printf forbidden', cwd: workspace, timeoutSeconds: 20 },
        }),
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.ENVIRONMENT_REVOKED });
  }, 20_000);

  it('recovers the same instance and marks replaced-instance operations unknown without replay', async () => {
    const fixture = await startFixture();
    const { channel, operations, daemon, workspace, environments } = fixture;
    const recoveredPath = join(workspace, 'recovered.txt');
    await channel.startEnvironmentOperation(
      operationInput(fixture, 'bash-recover', {
        case: 'bash',
        value: {
          command: `sleep 0.2; printf recovered > ${JSON.stringify(recoveredPath)}; printf recovered-output`,
          cwd: workspace,
          timeoutSeconds: 20,
        },
      }),
    );
    await waitFor(() =>
      operations.find('bash-recover')?.acceptedAt !== undefined ? true : undefined,
    );
    const disconnectedAt = environments.get(tenantId, fixture.envId).lastSeenAt;
    channel.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const recovered = await waitOperation(fixture, 'bash-recover', false);
    expect(recovered).toMatchObject({ status: OperationStatus.COMPLETED, outputComplete: true });
    expect(readFileSync(recoveredPath, 'utf8')).toBe('recovered');
    expect(
      Buffer.from(
        channel.readEnvironmentOperationOutput({
          tenantId,
          operationId: 'bash-recover',
          offset: 0n,
          limit: 1024,
        }).data,
      ).toString(),
    ).toBe('recovered-output');
    await waitFor(() =>
      environments.get(tenantId, fixture.envId).lastSeenAt !== disconnectedAt ? true : undefined,
    );

    const unknownPath = join(workspace, 'unknown-must-not-replay.txt');
    await startAfterReconnect(
      fixture,
      operationInput(fixture, 'bash-unknown', {
        case: 'bash',
        value: {
          command: `sleep 0.5; printf must-not-replay > ${JSON.stringify(unknownPath)}`,
          cwd: workspace,
          timeoutSeconds: 20,
        },
      }),
    );
    const currentEnvironment = environments.get(tenantId, fixture.envId);
    if (
      currentEnvironment.deviceId === undefined ||
      currentEnvironment.deviceBindingId === undefined ||
      currentEnvironment.instanceId === undefined
    ) {
      throw new Error('Current environment target is incomplete.');
    }
    operations.createIntent({
      operationId: 'bash-terminal-unacked',
      tenantId,
      envId: fixture.envId,
      deviceId: currentEnvironment.deviceId,
      deviceBindingId: currentEnvironment.deviceBindingId,
      targetInstanceId: currentEnvironment.instanceId,
      bindingVersion: 1n,
      action: {
        case: 'bash',
        value: { command: 'printf done', cwd: workspace, timeoutSeconds: 20 },
      },
      expiresAt: new Date(Date.now() + 60_000),
    });
    operations.markSent(
      'bash-terminal-unacked',
      currentEnvironment.deviceBindingId,
      currentEnvironment.instanceId,
    );
    operations.recordResult({
      operationId: 'bash-terminal-unacked',
      envId: fixture.envId,
      deviceBindingId: currentEnvironment.deviceBindingId,
      targetInstanceId: currentEnvironment.instanceId,
      bindingVersion: 1n,
      status: OperationStatus.COMPLETED,
      outcome: {
        case: 'bash',
        value: { exitCode: 0, outputComplete: true, endOffset: 0n },
      },
      observedAt: new Date(),
    });
    operations.markPostProcessed('bash-terminal-unacked');
    const terminalRecordedAt = operations.find('bash-terminal-unacked')?.resultRecordedAt;
    const oldInstance = currentEnvironment.instanceId;
    await daemon.stop();
    await waitFor(() =>
      environments.get(tenantId, fixture.envId).connectionStatus === 'offline' ? true : undefined,
    );
    await daemon.start();
    expect(environments.get(tenantId, fixture.envId).instanceId).not.toBe(oldInstance);
    const unknown = await waitOperation(fixture, 'bash-unknown', false);
    expect(unknown).toMatchObject({
      status: OperationStatus.UNKNOWN,
      resultSource: 'recovery',
      outputComplete: false,
    });
    expect(operations.find('bash-terminal-unacked')).toMatchObject({
      status: OperationStatus.COMPLETED,
      resultSource: 'device',
      resultRecordedAt: terminalRecordedAt,
    });
    expect(operations.find('bash-terminal-unacked')?.resultAcknowledgedAt).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(readFileSync(recoveredPath, 'utf8')).toBe('recovered');
    expect(readdirSync(workspace)).not.toContain('unknown-must-not-replay.txt');
    expect(operations.countActiveForBinding(unknown.deviceBindingId)).toBe(0);
  }, 20_000);

  it('rejects an operation error forged by another environment binding', async () => {
    const fixture = await startFixture();
    const { channel, database, environments, operations, workspace, url } = fixture;
    await channel.startEnvironmentOperation(
      operationInput(fixture, 'bash-auth-target', {
        case: 'bash',
        value: { command: 'sleep 30', cwd: workspace, timeoutSeconds: 30 },
      }),
    );
    const now = new Date().toISOString();
    database
      .prepare(
        'INSERT INTO tenants(tenant_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run('tenant-other', 'user-other', now, now);
    database
      .prepare(
        `INSERT INTO users(user_id, email, email_verified_at, tenant_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run('user-other', 'other@example.com', now, 'tenant-other', now, now);
    const other = environments.register({
      tenantId: 'tenant-other',
      clientActionId: 'register-other',
      name: 'Other environment',
      recommendedPwd: workspace,
      kind: 'self_hosted_macos',
    });
    const socket = new WebSocket(url);
    const messages: ServerMessage[] = [];
    socket.on('message', (data) => {
      const bytes = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      messages.push(decodeServerMessage(bytes));
    });
    cleanup.push(() => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(
      encodeDaemonMessage({
        payload: {
          case: 'deviceHello',
          value: {
            deviceId: '',
            instanceId: 'other-instance',
            protocolMajor: DEVICE_PROTOCOL_MAJOR,
            deviceName: 'Other environment device',
            capabilities: [
              DeviceCapability.BASH,
              DeviceCapability.FILE_READ,
              DeviceCapability.FILE_WRITE,
              DeviceCapability.FILE_EDIT,
              DeviceCapability.DIRECTORY_CHECK,
            ],
            envId: other.environment.envId,
            daemonVersion: 'integration-test',
            os: 'darwin',
            architecture: 'arm64',
            deviceBindingId: '',
            authentication: { case: 'pairingCredential', value: other.pairingCredential },
          },
        },
      }),
      { binary: true },
    );
    await waitFor(() =>
      messages.some((message) => message.payload.case === 'serverHello') ? true : undefined,
    );
    socket.send(
      encodeDaemonMessage({
        payload: {
          case: 'error',
          value: {
            code: DeviceErrorCode.OPERATION_UNKNOWN,
            message: 'Forged cross-environment unknown result.',
            action: DeviceErrorAction.QUERY_OPERATION,
            operationId: 'bash-auth-target',
            requestId: 'forged-error',
          },
        },
      }),
      { binary: true },
    );
    await waitFor(() =>
      messages.some(
        (message) =>
          message.payload.case === 'error' &&
          message.payload.value.code === DeviceErrorCode.PERMISSION_DENIED,
      )
        ? true
        : undefined,
    );
    expect(operations.find('bash-auth-target')?.resultRecordedAt).toBeUndefined();
    expect(operations.find('bash-auth-target')?.status).not.toBe(OperationStatus.UNKNOWN);
    await channel.cancelEnvironmentOperation({
      tenantId,
      operationId: 'bash-auth-target',
      reason: 'finish authorization test',
    });
    await waitOperation(fixture, 'bash-auth-target');
  }, 20_000);
});

function agentResponse(content: string, toolCalls?: ToolCall[]): ModelEvent[] {
  return [
    {
      type: 'response',
      message: {
        role: 'assistant',
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  ];
}

class AgentProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  constructor(readonly respond: (request: ModelRequest, index: number) => ModelEvent[]) {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    signal.throwIfAborted();
    const index = this.requests.length;
    this.requests.push(structuredClone(request));
    for (const event of this.respond(request, index)) {
      signal.throwIfAborted();
      yield event;
    }
  }
}

function toolResult(request: ModelRequest, callId: string): Record<string, unknown> {
  const message = request.messages.find(
    (candidate) => candidate.role === 'tool' && candidate.tool_call_id === callId,
  );
  if (!message) throw new Error(`Missing tool result for ${callId}.`);
  return z.record(z.string(), z.unknown()).parse(JSON.parse(message.content));
}

it('executes Agent tools through the real Server channel and isolates two environments', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-agent-environment-operations-'));
  const firstPath = join(directory, 'workspace-1-primary', 'agent.txt');
  const imagePath = join(directory, 'workspace-1-primary', 'pixel.png');
  let targetEnvId = '';
  let primaryEnvId = '';
  const provider = new AgentProvider((request, index) => {
    if (index === 0) {
      return agentResponse('', [
        {
          id: 'agent-write',
          name: 'write',
          arguments: {
            env_id: primaryEnvId,
            path: firstPath,
            content: 'alpha old old\n',
            overwrite: false,
          },
        },
      ]);
    }
    if (index === 1) {
      return agentResponse('', [
        {
          id: 'agent-read',
          name: 'read',
          arguments: { env_id: primaryEnvId, path: firstPath, offset: 1, limit: 1 },
        },
      ]);
    }
    if (index === 2) {
      const outcome = z
        .record(z.string(), z.unknown())
        .parse(toolResult(request, 'agent-read').outcome);
      const fileVersion = outcome.fileVersion;
      if (typeof fileVersion !== 'string') throw new Error('Read file version is missing.');
      return agentResponse('', [
        {
          id: 'agent-edit',
          name: 'edit',
          arguments: {
            env_id: primaryEnvId,
            path: firstPath,
            oldText: 'old',
            newText: 'new',
            expectedOccurrences: 2,
            expected_file_version: fileVersion,
          },
        },
      ]);
    }
    if (index === 3) {
      return agentResponse('', [
        {
          id: 'agent-bash',
          name: 'bash',
          arguments: {
            env_id: primaryEnvId,
            command: `printf agent-bash >> ${JSON.stringify(join(directory, 'workspace-1-primary', 'bash.txt'))}; printf agent-output`,
            timeoutSeconds: 20,
          },
        },
      ]);
    }
    if (index === 4) {
      return agentResponse('', [
        {
          id: 'agent-read-image',
          name: 'read_image',
          arguments: { env_id: primaryEnvId, path: imagePath },
        },
      ]);
    }
    if (index === 5) {
      return agentResponse('', [
        {
          id: 'agent-read-second-rules',
          name: 'read',
          arguments: { env_id: targetEnvId, path: 'AGENTS.md' },
        },
      ]);
    }
    if (index === 6) {
      return agentResponse('', [
        {
          id: 'agent-write-second',
          name: 'write',
          arguments: {
            env_id: targetEnvId,
            path: 'agent.txt',
            content: 'second environment\n',
            overwrite: false,
          },
        },
      ]);
    }
    if (index === 7) {
      const operationId = z
        .object({ operation_id: z.string() })
        .parse(toolResult(request, 'agent-bash')).operation_id;
      return agentResponse('', [
        {
          id: 'agent-read-output',
          name: 'read_output',
          arguments: { operation_id: operationId, offset: 0, limit: 1024 },
        },
        {
          id: 'agent-read-primary-again',
          name: 'read',
          arguments: { env_id: primaryEnvId, path: 'agent.txt' },
        },
      ]);
    }
    if (index === 8) return agentResponse('agent complete');
    throw new Error(`Unexpected Agent request ${index}.`);
  });
  const fixture = await startRealEnvironmentServer(directory, {
    ownerId: tenantId,
    accessToken: 'agent-integration-secret',
    model: {
      provider,
      providerId: 'agent-integration-provider',
      modelId: 'agent-integration-model',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
    },
  });
  try {
    primaryEnvId = fixture.envId;
    const second = await fixture.addEnvironment('secondary');
    expect(second.envId).not.toBe(fixture.envId);
    targetEnvId = second.envId;
    writeFileSync(
      imagePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const environmentPolicy = {
      allowedEnv: [fixture.envId, second.envId],
      policyVersion: 1n,
    };
    const created = await fixture.clients.thread.createThread({
      clientActionId: 'create-real-agent-task',
      title: 'Real Agent environment task',
      initialText: 'execute all environment operations',
      initialMode: InputMode.FOLLOW_UP,
      environmentPolicy,
    });
    const runId = created.runId;
    if (!runId) throw new Error('The real Agent Run was not created.');
    await waitFor(() => {
      const run = z
        .object({ status: z.string(), error_message: z.string().nullable() })
        .parse(
          fixture.database
            .prepare('SELECT status, error_message FROM runs WHERE run_id = ?')
            .get(runId),
        );
      if (run.status === 'completed') return true;
      if (['failed', 'cancelled', 'interrupted'].includes(run.status)) {
        throw new Error(`Agent Run ended as ${run.status}: ${run.error_message ?? ''}`);
      }
      return undefined;
    });

    expect(provider.requests).toHaveLength(9);
    expect(provider.requests[0]?.tools.map((tool) => tool.name).sort()).toEqual(
      [
        'bash',
        'browser',
        'edit',
        'env_list',
        'env_sync',
        'read',
        'read_image',
        'read_output',
        'recall',
        'skill',
        'subagent',
        'subagent_cancel',
        'subagent_status',
        'thread_notify',
        'web_fetch',
        'web_search',
        'write',
      ].sort(),
    );
    expect(
      provider.requests.every((request) =>
        request.tools.every((tool) => tool.name !== 'device_bash'),
      ),
    ).toBe(true);
    const targetRequest = provider.requests[6];
    const imageResult = provider.requests[5]?.messages.find(
      (message) => message.role === 'tool' && message.tool_call_id === 'agent-read-image',
    );
    expect(imageResult).toMatchObject({
      role: 'tool',
      tool_call_id: 'agent-read-image',
      content_parts: [
        { type: 'text', text: 'Attachment: pixel.png' },
        { type: 'image_url', image_url: { detail: 'low' } },
      ],
    });
    expect(JSON.stringify(imageResult)).toContain(';base64,');
    expect(
      fixture.database
        .prepare('SELECT media_type, width, height FROM attachments WHERE file_name = ?')
        .get('pixel.png'),
    ).toEqual({ media_type: 'image/png', width: 1, height: 1 });
    expect(
      targetRequest?.messages.some(
        (message) =>
          message.role === 'system' && message.content.includes('Remote instructions for primary'),
      ),
    ).toBe(false);
    expect(
      targetRequest?.messages.some(
        (message) =>
          message.role === 'system' &&
          message.content.includes('Remote instructions for secondary'),
      ),
    ).toBe(false);
    const secondaryRules = toolResult(
      provider.requests[6] ?? { messages: [], tools: [] },
      'agent-read-second-rules',
    );
    expect(secondaryRules).toMatchObject({
      env_id: second.envId,
      cwd: realpathSync(second.workspace),
      outcome: { content: expect.stringContaining('Remote instructions for secondary') },
    });
    expect(readFileSync(firstPath, 'utf8')).toBe('alpha new new\n');
    expect(readFileSync(join(second.workspace, 'agent.txt'), 'utf8')).toBe('second environment\n');
    expect(readFileSync(join(fixture.workspace, 'bash.txt'), 'utf8')).toBe('agent-bash');
    const outputResult = toolResult(
      provider.requests[8] ?? { messages: [], tools: [] },
      'agent-read-output',
    );
    expect(outputResult.content).toContain('agent-output');
    expect(outputResult.output_complete).toBe(true);
    expect(
      toolResult(provider.requests[8] ?? { messages: [], tools: [] }, 'agent-read-primary-again'),
    ).toMatchObject({
      env_id: fixture.envId,
      cwd: realpathSync(fixture.workspace),
      outcome: { content: 'alpha new new\n' },
    });
    const binding = z
      .object({
        current_env: z.string(),
        current_pwd: z.string(),
        current_binding_version: z.number(),
      })
      .parse(
        fixture.database
          .prepare(
            'SELECT current_env, current_pwd, current_binding_version FROM agent_environment_policies WHERE thread_id = ?',
          )
          .get(created.thread?.threadId ?? ''),
      );
    expect(binding).toEqual({
      current_env: created.thread?.currentBinding?.envId,
      current_pwd: fixture.mainEnvironment.workspace,
      current_binding_version: 1,
    });
    const operationActions = z
      .array(z.object({ action: z.string() }))
      .parse(
        fixture.database
          .prepare(
            'SELECT action FROM agent_environment_operations WHERE thread_id = ? ORDER BY created_at',
          )
          .all(created.thread?.threadId ?? ''),
      )
      .map((row) => row.action);
    expect(operationActions).toEqual(
      expect.arrayContaining(['directory_check', 'write', 'read', 'read_image', 'edit', 'bash']),
    );
  } finally {
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('reruns in the shared sandbox workspace and explicitly targets another environment', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-production-rerun-'));
  let targetEnvId = '';
  let primaryEnvId = '';
  const provider = new AgentProvider((_request, index) => {
    if (index === 0) {
      return agentResponse('', [
        {
          id: 'production-read-second',
          name: 'read',
          arguments: { env_id: targetEnvId, path: 'AGENTS.md' },
        },
      ]);
    }
    if (index === 1) return agentResponse('read env two without changing the default');
    if (index === 2) {
      return agentResponse('', [
        {
          id: 'rerun-write',
          name: 'write',
          arguments: {
            env_id: primaryEnvId,
            path: join(directory, 'workspace-1-primary', 'rerun.txt'),
            content: 'rerun restored env one',
            overwrite: false,
          },
        },
      ]);
    }
    if (index === 3) return agentResponse('rerun completed on env one');
    throw new Error(`Unexpected production Rerun request ${index}.`);
  });
  const fixture = await startRealEnvironmentServer(directory, {
    ownerId: tenantId,
    accessToken: 'production-rerun-secret',
    model: {
      provider,
      providerId: 'production-rerun-provider',
      modelId: 'production-rerun-model',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
    },
  });
  try {
    primaryEnvId = fixture.envId;
    const second = await fixture.addEnvironment('secondary');
    targetEnvId = second.envId;
    const created = await fixture.clients.thread.createThread({
      clientActionId: 'create-production-rerun-task',
      title: 'Production Rerun task',
      initialText: 'start on env one and inspect env two',
      initialMode: InputMode.FOLLOW_UP,
      environmentPolicy: {
        allowedEnv: [fixture.envId, second.envId],
        policyVersion: 1n,
      },
    });
    const threadId = created.thread?.threadId ?? '';
    const initialRunId = created.runId;
    if (!initialRunId) throw new Error('The initial production Run was not created.');
    await waitFor(() => {
      const run = z
        .object({ status: z.string(), error_message: z.string().nullable() })
        .parse(
          fixture.database
            .prepare('SELECT status, error_message FROM runs WHERE run_id = ?')
            .get(initialRunId),
        );
      if (run.status === 'completed') return true;
      if (['failed', 'cancelled', 'interrupted'].includes(run.status)) {
        throw new Error(
          `Initial production Run ended as ${run.status}: ${run.error_message ?? ''}`,
        );
      }
      return undefined;
    });
    const initialResource = new SessionStore(fixture.database).agentEnvironments.requirePolicy(
      threadId,
      'thread',
    ).current.resourceVersion;
    const snapshot = await fixture.clients.thread.getThread({ threadId });
    const user = snapshot.snapshot?.messages.find(
      (message) => message.role === 2 && message.content === 'start on env one and inspect env two',
    );
    if (!user) throw new Error('The production Rerun anchor is missing.');
    const rerun = await fixture.clients.runs.rerun({
      clientActionId: 'rerun-production-env-one',
      threadId,
      messageId: user.messageId,
    });
    await waitFor(() => {
      const run = z
        .object({ status: z.string(), error_message: z.string().nullable() })
        .parse(
          fixture.database
            .prepare('SELECT status, error_message FROM runs WHERE run_id = ?')
            .get(rerun.runId),
        );
      if (run.status === 'completed') return true;
      if (['failed', 'cancelled', 'interrupted'].includes(run.status)) {
        throw new Error(`Production Rerun ended as ${run.status}: ${run.error_message ?? ''}`);
      }
      return undefined;
    });

    const restored = new SessionStore(fixture.database).agentEnvironments.requirePolicy(
      threadId,
      'thread',
    );
    expect(restored.current.envId).toBe(created.thread?.currentBinding?.envId);
    expect(restored.current.pwd).toBe(fixture.mainEnvironment.workspace);
    expect(restored.current.bindingVersion).toBe(2);
    expect(restored.current.resourceVersion).toBe(initialResource);
    expect(readFileSync(join(fixture.workspace, 'rerun.txt'), 'utf8')).toBe(
      'rerun restored env one',
    );
    expect(readdirSync(second.workspace)).not.toContain('rerun.txt');
    expect(
      provider.requests[2]?.messages.some(
        (message) =>
          message.role === 'system' && message.content.includes('Remote instructions for primary'),
      ),
    ).toBe(false);
    const events = new SessionStore(fixture.database)
      .listEvents(threadId, 0n)
      .filter((event) => event.payload.case === 'environmentBindingChanged');
    expect(events.at(-1)?.payload).toMatchObject({
      case: 'environmentBindingChanged',
      value: {
        agentId: 'thread',
        binding: {
          envId: restored.current.envId,
          bindingVersion: 2,
          resourceVersion: restored.current.resourceVersion,
        },
      },
    });
  } finally {
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('rejects a historical switched target through the production Rerun entry without executing another Run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-rerun-historical-target-'));
  const provider = new AgentProvider(() => agentResponse('initial execution completed'));
  const fixture = await startRealEnvironmentServer(directory, {
    ownerId: tenantId,
    accessToken: 'historical-rerun-test-token',
    model: {
      provider,
      providerId: 'test',
      modelId: 'test',
      contextWindowTokens: 128000,
      outputReserveTokens: 4096,
    },
  });
  try {
    const second = await fixture.addEnvironment('secondary');
    const created = await fixture.clients.thread.createThread({
      clientActionId: 'historical-task',
      title: 'Fixed default task',
      initialText: 'historical source',
      initialMode: InputMode.FOLLOW_UP,
      environmentPolicy: {
        allowedEnv: [fixture.envId, second.envId],
        policyVersion: 1n,
      },
    });
    const threadId = created.thread?.threadId ?? '';
    if (!created.runId) throw new Error('The historical fixture Run is missing.');
    const runId = created.runId;
    await waitFor(() =>
      fixture.database.prepare('SELECT status FROM runs WHERE run_id=?').get(runId)?.status ===
      'completed'
        ? true
        : undefined,
    );
    const store = new SessionStore(fixture.database);
    const policy = store.agentEnvironments.requirePolicy(threadId, 'thread');
    const user = store
      .listContext(tenantId, threadId, 'thread')
      .find((message) => message.message.role === 'user');
    if (!user) throw new Error('The historical fixture source message is missing.');
    fixture.database
      .prepare(`INSERT INTO agent_environment_binding_history(history_id,thread_id,agent_id,binding_version,env_id,pwd,resource_version,resources_json,reason,created_at)
      SELECT 'historical-device-target',thread_id,agent_id,99,?,?,resource_version,resources_json,'switch',created_at FROM agent_environment_binding_history WHERE history_id=?`)
      .run(second.envId, realpathSync(second.workspace), policy.currentHistoryId);
    fixture.database
      .prepare(
        "UPDATE agent_environment_message_bindings SET history_id='historical-device-target',binding_version=99 WHERE thread_id=? AND message_seq=?",
      )
      .run(threadId, user.seq);
    await expect(
      fixture.clients.runs.rerun({
        clientActionId: 'rerun-different-historical-target',
        threadId,
        messageId: user.messageId,
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(provider.requests).toHaveLength(1);
    expect(store.listRuns(tenantId, threadId)).toHaveLength(1);
    expect(store.agentEnvironments.requirePolicy(threadId, 'thread').currentHistoryId).toBe(
      policy.currentHistoryId,
    );
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM environment_operations WHERE action IN ('write','edit','bash')",
        )
        .get(),
    ).toEqual({ count: 0 });
  } finally {
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
