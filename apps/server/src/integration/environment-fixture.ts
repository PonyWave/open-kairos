import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createClient, type Interceptor, type Transport } from '@connectrpc/connect';
import {
  AttachmentService,
  BashLogService,
  ContextService,
  create,
  EnvironmentPolicySchema,
  EnvironmentService,
  EventService,
  MessageService,
  QueueService,
  RunService,
  ThreadService,
} from '@kairos/contracts';
import { DeviceCapability, GrepMode, OperationStatus } from '@kairos/contracts/device';
import { z } from 'zod';
import { DeviceChannel } from '../devices/channel.js';
import { EnvironmentOperationStore } from '../devices/environment-operation-store.js';
import { EnvironmentStore } from '../devices/environment-store.js';
import type { EnvironmentUse, EnvironmentUseGateway } from '../devices/environment-use.js';
import { ensureMainEnvironment } from '../devices/main-environment.js';
import type {
  EnvironmentOperationAction,
  EnvironmentOperationGateway,
  EnvironmentOperationRecord,
} from '../sessions/environment-runtime.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import type { WorkspaceResourceSnapshot } from '../workspace/index.js';
import {
  createTestServer as createServer,
  type TestServerOptions as ServerOptions,
  testSessionHeaders,
} from './test-authentication.js';

export interface WorkspaceResourceSource {
  load(): Promise<WorkspaceResourceSnapshot>;
}

export const testEnvironmentPolicyInput = {
  allowedEnv: ['env-1'],
};

export const testEnvironmentPolicy = {
  ...testEnvironmentPolicyInput,
  policyVersion: 1n,
};

export const testEnvironmentPolicyJson = {
  ...testEnvironmentPolicyInput,
  policyVersion: '1',
};

export function createEnvironmentThreadClient(
  transport: Transport,
  policy = testEnvironmentPolicy,
) {
  const client = createClient(ThreadService, transport);
  const createThread: typeof client.createThread = (request, options) =>
    client.createThread(
      {
        environmentPolicy: create(EnvironmentPolicySchema, policy),
        ...request,
      },
      options,
    );
  return { ...client, createThread };
}

export function seedTestTenant(database: DatabaseSync, tenantId: string): void {
  const now = '2026-01-01T00:00:00.000Z';
  database
    .prepare(
      `INSERT INTO tenants(tenant_id, user_id, default_env_id, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?) ON CONFLICT(tenant_id) DO NOTHING`,
    )
    .run(tenantId, `user-${tenantId}`, now, now);
  const tenant = database.prepare('SELECT user_id FROM tenants WHERE tenant_id=?').get(tenantId);
  const userId = String(tenant?.user_id);
  database
    .prepare(`INSERT INTO users(user_id,email,email_verified_at,username,tenant_id,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'active',?,?) ON CONFLICT(user_id) DO NOTHING`)
    .run(userId, `${userId}@example.com`, now, tenantId, tenantId, now, now);
}

export function seedTestEnvironment(
  database: DatabaseSync,
  tenantId: string,
  envId = 'env-1',
  pwd = '/srv/one',
): void {
  seedTestTenant(database, tenantId);
  const now = '2026-01-01T00:00:00.000Z';
  const capabilities = JSON.stringify([
    DeviceCapability.BASH,
    DeviceCapability.FILE_READ,
    DeviceCapability.FILE_WRITE,
    DeviceCapability.FILE_EDIT,
    DeviceCapability.DIRECTORY_CHECK,
  ]);
  database
    .prepare(
      `INSERT INTO environments(
        env_id, tenant_id, name, kind, recommended_pwd, binding_status, connection_status,
        capability_status, directory_status, maintenance_mode, maintenance_version,
        authorized_capabilities_json, granted_capabilities_json, device_id, device_binding_id,
        instance_id, daemon_version, os, architecture, normalized_pwd, checked_at,
        created_at, updated_at, paired_at, last_seen_at
      ) VALUES (?, ?, ?, 'self_hosted_linux', ?, 'active', 'online', 'ready', 'ready',
        'normal', '0', ?, ?, ?, ?, ?, 'test', 'ubuntu', 'x86_64', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(env_id) DO NOTHING`,
    )
    .run(
      envId,
      tenantId,
      envId,
      pwd,
      capabilities,
      capabilities,
      `device-${envId}`,
      `binding-${envId}`,
      `instance-${envId}`,
      pwd,
      now,
      now,
      now,
      now,
      now,
    );
  database
    .prepare(
      `INSERT INTO environment_device_bindings(
        device_binding_id, tenant_id, env_id, device_id, status, granted_capabilities_json,
        created_at, updated_at, paired_at, last_seen_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
      ON CONFLICT(device_binding_id) DO NOTHING`,
    )
    .run(`binding-${envId}`, tenantId, envId, `device-${envId}`, capabilities, now, now, now, now);
}

export class ControlledEnvironmentOperations implements EnvironmentOperationGateway {
  readonly started: Array<{
    operationId: string;
    tenantId: string;
    envId: string;
    bindingVersion?: bigint;
    action: EnvironmentOperationAction;
  }> = [];
  readonly cancelled: string[] = [];
  readonly #operations = new Map<string, EnvironmentOperationRecord>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  bashDelayMs = 0;
  bashOutput = 'remote output\n';
  readContent: string | undefined;

  constructor(
    readonly environments: EnvironmentStore,
    public loadResources?: () => Promise<WorkspaceResourceSnapshot>,
  ) {}

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
    const environment = this.environments.get(input.tenantId, input.envId);
    const delayed = input.action.case === 'bash' && this.bashDelayMs > 0;
    const operation: EnvironmentOperationRecord = {
      operationId: input.operationId,
      tenantId: input.tenantId,
      envId: input.envId,
      deviceBindingId: environment.deviceBindingId ?? '',
      targetInstanceId: environment.instanceId ?? '',
      action: structuredClone(input.action),
      status: delayed ? OperationStatus.RUNNING : OperationStatus.COMPLETED,
      outputComplete: !delayed,
      ...(delayed
        ? {}
        : { postProcessedAt: new Date().toISOString(), resultSource: 'device' as const }),
      ...(delayed
        ? {}
        : {
            resultStatus: OperationStatus.COMPLETED,
            outcome: await this.#outcome(input.envId, input.action),
          }),
      expiresAt: input.expiresAt.toISOString(),
    };
    this.#operations.set(input.operationId, operation);
    if (delayed) {
      const timer = setTimeout(() => {
        this.#timers.delete(input.operationId);
        operation.status = OperationStatus.COMPLETED;
        operation.outputComplete = true;
        operation.postProcessedAt = new Date().toISOString();
        operation.resultSource = 'device';
        operation.resultStatus = OperationStatus.COMPLETED;
        operation.outcome = this.#bashOutcome();
      }, this.bashDelayMs);
      timer.unref();
      this.#timers.set(input.operationId, timer);
    }
    return operation;
  }

  async cancelEnvironmentOperation(input: {
    tenantId: string;
    operationId: string;
    reason: string;
  }): Promise<EnvironmentOperationRecord> {
    this.cancelled.push(input.operationId);
    const operation = this.getEnvironmentOperation(input.tenantId, input.operationId);
    const timer = this.#timers.get(input.operationId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(input.operationId);
    if (operation.resultStatus === undefined) {
      operation.status = OperationStatus.CANCELLED;
      operation.outputComplete = true;
      operation.postProcessedAt = new Date().toISOString();
      operation.resultSource = 'device';
      operation.resultStatus = OperationStatus.CANCELLED;
      operation.outcome = {
        case: 'bash',
        value: { outputComplete: false },
      };
    }
    return operation;
  }

  getEnvironmentOperation(tenantId: string, operationId: string): EnvironmentOperationRecord {
    const operation = this.#operations.get(operationId);
    if (!operation || operation.tenantId !== tenantId) throw new Error('Unknown operation.');
    return operation;
  }

  readEnvironmentOperationSpill(
    _operationId: string,
  ): { data: Uint8Array; truncated: boolean } | undefined {
    return { data: new TextEncoder().encode(this.bashOutput), truncated: false };
  }

  readEnvironmentOperationOutput(input: {
    tenantId: string;
    operationId: string;
    offset: bigint;
    limit: number;
  }) {
    this.getEnvironmentOperation(input.tenantId, input.operationId);
    const data = new TextEncoder().encode(this.bashOutput);
    const sliced = data.slice(Number(input.offset), Number(input.offset) + input.limit);
    const nextOffset = input.offset + BigInt(sliced.byteLength);
    return {
      data: sliced,
      nextOffset,
      outputComplete: nextOffset >= BigInt(data.byteLength),
      outputGap: false,
    };
  }

  async #outcome(envId: string, action: EnvironmentOperationAction): Promise<unknown> {
    if (action.case === 'directoryCheck') {
      let snapshot: WorkspaceResourceSnapshot;
      try {
        snapshot = this.loadResources
          ? await this.loadResources()
          : {
              snapshotId: '',
              systemInstructions: '',
              resources: [
                {
                  path: 'AGENTS.md',
                  content: `instructions for ${envId} at ${action.value.path}`,
                },
              ],
            };
      } catch (error) {
        return {
          case: 'directoryCheck',
          value: {
            normalizedPath: action.value.path,
            exists: false,
            directory: false,
            readable: false,
            writable: false,
            executable: false,
            os: '',
            architecture: '',
            capabilities: [],
            resources: [],
            reason: error instanceof Error ? error.message : 'Directory resource loading failed.',
          },
        };
      }
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
          capabilities: [
            DeviceCapability.BASH,
            DeviceCapability.FILE_READ,
            DeviceCapability.FILE_WRITE,
            DeviceCapability.FILE_EDIT,
            DeviceCapability.DIRECTORY_CHECK,
          ],
          resources: snapshot.resources.map((resource) => ({
            path: resource.path,
            content: resource.content,
            sha256: createHash('sha256').update(resource.content, 'utf8').digest('hex'),
          })),
        },
      };
    }
    if (action.case === 'read') {
      return {
        case: 'read',
        value: {
          path: action.value.path,
          content: this.readContent ?? `content from ${envId}`,
          startLine: 1,
          endLine: 1,
          hasMore: false,
          fileVersion: 'a'.repeat(64),
          truncated: false,
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
    if (action.case === 'glob') {
      return {
        case: 'glob',
        value: {
          path: action.value.path,
          files: [`${action.value.path}/src/alpha.ts`, `${action.value.path}/src/beta.ts`],
          truncated: false,
        },
      };
    }
    if (action.case === 'grep') {
      return {
        case: 'grep',
        value: {
          path: action.value.path,
          matches:
            action.value.mode === GrepMode.CONTENT
              ? [{ file: `${action.value.path}/src/alpha.ts`, line: 1, text: 'const needle = 1;' }]
              : [],
          files:
            action.value.mode === GrepMode.FILES_WITH_MATCHES
              ? [`${action.value.path}/src/alpha.ts`]
              : [],
          counts:
            action.value.mode === GrepMode.COUNT
              ? [{ file: `${action.value.path}/src/alpha.ts`, count: 2n }]
              : [],
          truncated: false,
        },
      };
    }
    return this.#bashOutcome();
  }

  #bashOutcome() {
    return {
      case: 'bash',
      value: {
        exitCode: 0,
        outputComplete: true,
        endOffset: BigInt(Buffer.byteLength(this.bashOutput)),
      },
    };
  }
}

export function controlledEnvironmentOperations(
  database: DatabaseSync,
  loadResources?: () => Promise<WorkspaceResourceSnapshot>,
): ControlledEnvironmentOperations {
  return new ControlledEnvironmentOperations(new EnvironmentStore(database), loadResources);
}

export function seedLoadedTestWorkspace(
  store: SessionStore,
  threadId: string,
  agentId = 'thread',
): void {
  const policy = store.agentEnvironments.requirePolicy(threadId, agentId);
  if (!policy.defaultEnv || !policy.defaultPwd)
    throw new Error('A fixture requires a default workspace.');
  const owner = store.database
    .prepare('SELECT owner_id FROM threads WHERE thread_id=?')
    .get(threadId);
  if (!owner || typeof owner.owner_id !== 'string')
    throw new Error('Fixture thread owner is missing.');
  seedReadyMainEnvironment(store.database, owner.owner_id, policy.defaultEnv);
  const environment = new EnvironmentStore(store.database).get(owner.owner_id, policy.defaultEnv);
  store.transaction(() =>
    store.agentEnvironments.commitResources({
      threadId,
      agentId,
      expectedHistoryId: policy.currentHistoryId,
      envId: policy.defaultEnv ?? '',
      pwd: policy.defaultPwd ?? '',
      snapshot: {
        snapshotId: createHash('sha256').update('fixture resources').digest('hex'),
        systemInstructions: '',
        resources: [],
      },
      reason: 'reload',
      resultContent: '',
      deviceBindingId: environment.deviceBindingId ?? '',
      instanceId: environment.instanceId ?? '',
    }),
  );
}

export class ControlledEnvironmentUseGateway implements EnvironmentUseGateway {
  readonly uses = new Map<string, EnvironmentUse>();
  readonly reserved: EnvironmentUse[] = [];
  readonly released: EnvironmentUse[] = [];
  prepare: ((input: EnvironmentUse & { signal: AbortSignal }) => Promise<void>) | undefined;

  constructor(readonly database: DatabaseSync) {}

  reserveUse(input: EnvironmentUse): void {
    if (this.uses.has(input.usageId)) return;
    this.uses.set(input.usageId, { ...input });
    this.reserved.push({ ...input });
  }

  async ensureReady(input: EnvironmentUse & { signal: AbortSignal }): Promise<void> {
    input.signal.throwIfAborted();
    if (!this.uses.has(input.usageId))
      throw new Error('An environment use must be reserved first.');
    if (this.prepare) await this.prepare(input);
    input.signal.throwIfAborted();
    const row = this.database
      .prepare('SELECT recommended_pwd FROM environments WHERE env_id = ? AND tenant_id = ?')
      .get(input.envId, input.tenantId);
    const pwd =
      row === undefined
        ? '/workspace'
        : z.object({ recommended_pwd: z.string() }).parse(row).recommended_pwd;
    seedReadyMainEnvironment(this.database, input.tenantId, input.envId, pwd);
  }

  releaseUse(input: EnvironmentUse): void {
    if (this.uses.delete(input.usageId)) this.released.push({ ...input });
  }
}

export function seedReadyMainEnvironment(
  database: DatabaseSync,
  tenantId: string,
  envId = 'main',
  pwd = '/workspace',
): string {
  seedTestTenant(database, tenantId);
  ensureMainEnvironment(database, tenantId, { envId, workspace: pwd });
  const capabilities = JSON.stringify([
    DeviceCapability.BASH,
    DeviceCapability.FILE_READ,
    DeviceCapability.FILE_WRITE,
    DeviceCapability.FILE_EDIT,
    DeviceCapability.DIRECTORY_CHECK,
  ]);
  database
    .prepare(`UPDATE environments SET binding_status='active', connection_status='online', capability_status='ready', directory_status='ready',
    granted_capabilities_json=?, device_id=?,device_binding_id=?,instance_id=?,normalized_pwd=?,checked_at=? WHERE env_id=? AND tenant_id=?`)
    .run(
      capabilities,
      `device-${envId}`,
      `binding-${envId}`,
      `instance-${envId}`,
      pwd,
      '2026-01-01T00:00:00.000Z',
      envId,
      tenantId,
    );
  database
    .prepare(
      `INSERT INTO environment_device_bindings(
        device_binding_id, tenant_id, env_id, device_id, status, granted_capabilities_json,
        created_at, updated_at, paired_at, last_seen_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
      ON CONFLICT(device_binding_id) DO NOTHING`,
    )
    .run(
      `binding-${envId}`,
      tenantId,
      envId,
      `device-${envId}`,
      capabilities,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
  return envId;
}

export function controlledEnvironmentDependencies(database: DatabaseSync, tenantId: string) {
  seedTestTenant(database, tenantId);
  const operations = controlledEnvironmentOperations(database);
  return {
    environments: operations.environments,
    environmentOperations: operations,
    environmentUse: new ControlledEnvironmentUseGateway(database),
  };
}

export const createEnvironmentTestServer: typeof createServer = (
  database,
  logger = false,
  options = {},
) => {
  const loader = options.workspaceResourceLoader;
  const environmentOperations =
    options.environmentOperations ??
    controlledEnvironmentOperations(database, loader ? () => loader.load() : undefined);
  return createServer(database, logger, {
    mainEnvironment: { envId: 'main', workspace: '/workspace' },
    ...options,
    environmentOperations,
    environmentUse: options.environmentUse ?? new ControlledEnvironmentUseGateway(database),
  });
};

type ConnectTransportFactory = (options: {
  baseUrl: string;
  httpVersion: '1.1';
  interceptors: Interceptor[];
}) => Transport;

const fastifyEntry = createRequire(import.meta.url).resolve('@connectrpc/connect-fastify');
const connectNode = createRequire(fastifyEntry)('@connectrpc/connect-node') as {
  createConnectTransport: ConnectTransportFactory;
};
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const daemonMain = join(repository, 'apps/daemon/src/main.ts');
const requiredCapabilities = [
  DeviceCapability.BASH,
  DeviceCapability.FILE_READ,
  DeviceCapability.FILE_WRITE,
  DeviceCapability.FILE_EDIT,
  DeviceCapability.DIRECTORY_CHECK,
];

async function waitForValue<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the real environment fixture.');
}

export async function startRealEnvironmentServer(
  directory: string,
  options: ServerOptions & {
    ownerId: string;
    accessToken: string;
    existingEnvId?: string;
    mainEnvironmentOperations?: (database: DatabaseSync) => EnvironmentOperationGateway;
  },
) {
  mkdirSync(directory, { recursive: true });
  const database = openDatabase(join(directory, 'server.sqlite'));
  seedTestTenant(database, options.ownerId);
  const mainEnvironment = options.mainEnvironment ?? {
    envId: 'main',
    workspace: join(directory, 'workspace-main'),
  };
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO users(user_id, email, email_verified_at, username, tenant_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?) ON CONFLICT(user_id) DO NOTHING`,
    )
    .run(
      `user-${options.ownerId}`,
      `${options.ownerId}@example.com`,
      now,
      options.ownerId,
      options.ownerId,
      now,
      now,
    );
  new SessionStore(database, { mainEnvironment });
  const environments = new EnvironmentStore(database, { mainEnvironment });
  const operations = new EnvironmentOperationStore(database);
  const channel = new DeviceChannel({
    environments,
    environmentOperations: operations,
  });
  const mainEnvironmentOperations =
    options.mainEnvironmentOperations?.(database) ?? controlledEnvironmentOperations(database);
  const mainEnvironmentOperationIds = new Set<string>();
  const routedOperations: EnvironmentOperationGateway = {
    startEnvironmentOperation: (input) => {
      if (input.envId === mainEnvironment.envId) {
        mainEnvironmentOperationIds.add(input.operationId);
        return mainEnvironmentOperations.startEnvironmentOperation(input);
      }
      return channel.startEnvironmentOperation(input);
    },
    cancelEnvironmentOperation: (input) =>
      mainEnvironmentOperationIds.has(input.operationId)
        ? mainEnvironmentOperations.cancelEnvironmentOperation(input)
        : channel.cancelEnvironmentOperation(input),
    getEnvironmentOperation: (tenantId, operationId) =>
      mainEnvironmentOperationIds.has(operationId)
        ? mainEnvironmentOperations.getEnvironmentOperation(tenantId, operationId)
        : channel.getEnvironmentOperation(tenantId, operationId),
    readEnvironmentOperationOutput: (input) =>
      mainEnvironmentOperationIds.has(input.operationId)
        ? mainEnvironmentOperations.readEnvironmentOperationOutput(input)
        : channel.readEnvironmentOperationOutput(input),
  };
  const server = createServer(database, false, {
    ...options,
    mainEnvironment,
    tenantId: options.ownerId,
    sessionToken: options.accessToken,
    deviceChannel: channel,
    environmentOperations: routedOperations,
  });
  const daemons = new Set<() => Promise<void>>();
  let environmentSequence = 0;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    for (const stop of [...daemons].reverse()) await stop();
    if (database.isOpen) await server.close();
  };
  const addEnvironment = async (
    name: string,
    connection?: { envId: string; pairingCredential: string },
  ) => {
    environmentSequence += 1;
    const suffix = `${environmentSequence}-${name}`;
    const workspace = join(directory, `workspace-${suffix}`);
    const identityDirectory = join(directory, `identity-${suffix}`);
    mkdirSync(workspace, { recursive: true });
    mkdirSync(identityDirectory, { recursive: true });
    writeFileSync(join(workspace, 'AGENTS.md'), `Remote instructions for ${name}.\n`);
    mkdirSync(join(workspace, '.agents', 'skills', 'review'), { recursive: true });
    writeFileSync(join(workspace, '.agents', 'skills', 'review', 'SKILL.md'), '# Review skill\n');
    const existingEnvId = environmentSequence === 1 ? options.existingEnvId : undefined;
    const issued = connection
      ? {
          environment: { envId: connection.envId },
          pairingCredential: connection.pairingCredential,
        }
      : existingEnvId
        ? undefined
        : environments.register({
            tenantId: options.ownerId,
            clientActionId: `register-${suffix}`,
            name,
            recommendedPwd: workspace,
            kind: process.platform === 'darwin' ? 'self_hosted_macos' : 'self_hosted_linux',
          });
    const envId = existingEnvId ?? issued?.environment.envId;
    if (!envId) throw new Error('The real environment registration is missing.');
    const identityPath = join(identityDirectory, 'identity.json');
    const address = server.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The real environment Server has no TCP address.');
    }
    const url = `ws://127.0.0.1:${address.port}/devices/wss`;
    const resourcesHome = join(directory, 'daemon-resources-home');
    mkdirSync(resourcesHome, { recursive: true });
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      KAIROS_DEVICE_IDENTITY_PATH: identityPath,
      KAIROS_DAEMON_VERSION: 'agent-integration-test',
      KAIROS_DEVICE_RESOURCES_HOME: resourcesHome,
    };
    if (issued) {
      const pairing = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          daemonMain,
          'pair-once',
          '--env-id',
          envId,
          '--server-url',
          url,
          '--directory',
          workspace,
          '--device-name',
          name,
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
    }

    let child: ChildProcess | undefined;
    let serviceOutput = '';
    const stop = async (signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') => {
      const current = child;
      child = undefined;
      if (current === undefined || current.exitCode !== null || current.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => current.once('exit', () => resolve()));
      current.kill(signal);
      const timeout = setTimeout(() => current.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timeout);
    };
    const start = async (serverUrl = url) => {
      if (child !== undefined) return;
      const identity: unknown = JSON.parse(readFileSync(identityPath, 'utf8'));
      if (typeof identity !== 'object' || identity === null) {
        throw new Error('The real Daemon identity is invalid.');
      }
      if (Reflect.get(identity, 'serverUrl') !== serverUrl) {
        Reflect.set(identity, 'serverUrl', serverUrl);
        writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
      }
      child = spawn(process.execPath, ['--import', 'tsx', daemonMain], {
        cwd: repository,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (chunk) => (serviceOutput += chunk));
      child.stderr?.on('data', (chunk) => (serviceOutput += chunk));
      try {
        await waitForValue(() => {
          const current = environments.get(options.ownerId, envId);
          return current.ready &&
            requiredCapabilities.every((capability) =>
              current.grantedCapabilities.includes(capability),
            )
            ? true
            : undefined;
        });
      } catch (error) {
        throw new AggregateError([error], `Daemon service did not become ready: ${serviceOutput}`);
      }
    };
    daemons.add(() => stop());
    await start();
    return {
      envId,
      workspace,
      identityDirectory,
      daemon: { start, stop, output: () => serviceOutput },
      environmentPolicy: {
        allowedEnv: [envId],
        policyVersion: 1n,
      },
    };
  };

  try {
    await server.listen({ host: '127.0.0.1', port: 0 });
    const first = await addEnvironment('primary');
    const address = server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const authentication: Interceptor = (next) => async (request) => {
      for (const [name, value] of Object.entries(testSessionHeaders(options.accessToken)))
        request.header.set(name, value);
      return next(request);
    };
    const transport = connectNode.createConnectTransport({
      baseUrl,
      httpVersion: '1.1',
      interceptors: [authentication],
    });
    return {
      database,
      server,
      channel,
      environments,
      operations,
      baseUrl,
      mainEnvironment,
      clients: {
        attachments: createClient(AttachmentService, transport),
        environments: createClient(EnvironmentService, transport),
        thread: createEnvironmentThreadClient(transport, first.environmentPolicy),
        messages: createClient(MessageService, transport),
        queue: createClient(QueueService, transport),
        runs: createClient(RunService, transport),
        context: createClient(ContextService, transport),
        events: createClient(EventService, transport),
        logs: createClient(BashLogService, transport),
      },
      ...first,
      addEnvironment,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
