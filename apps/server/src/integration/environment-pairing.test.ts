import { execFileSync, spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { DaemonMessageInit, ServerMessage } from '@kairos/contracts/device';
import {
  DeviceCapability,
  DeviceErrorCode,
  decodeServerMessage,
  EnvironmentMaintenanceMode,
  encodeDaemonMessage,
  OperationStatus,
} from '@kairos/contracts/device';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DeviceChannel } from '../devices/channel.js';
import { EnvironmentOperationStore } from '../devices/environment-operation-store.js';
import { EnvironmentStore } from '../devices/environment-store.js';
import { registerDeviceWebSocket } from '../devices/websocket.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const daemonMain = join(repository, 'apps/daemon/src/main.ts');
const cleanup: Array<() => Promise<void> | void> = [];
let actionSequence = 0;

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function waitFor<T>(read: () => T | undefined, timeoutMilliseconds = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for environment pairing state.');
}

function seedTenant(database: DatabaseSync, tenantId: string): void {
  const now = new Date().toISOString();
  const userId = `user-${tenantId}`;
  database
    .prepare(
      `INSERT INTO users(user_id, email, email_verified_at, username, tenant_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'active', ?, ?)`,
    )
    .run(userId, `${tenantId}@example.com`, now, tenantId, now, now);
  database
    .prepare(
      'INSERT INTO tenants(tenant_id, user_id, default_env_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
    )
    .run(tenantId, userId, now, now);
  database.prepare('UPDATE users SET tenant_id = ? WHERE user_id = ?').run(tenantId, userId);
}

interface FixtureOptions {
  tls?: { key: string; cert: string };
  now?: () => Date;
}

async function fixture(options: FixtureOptions = {}) {
  const database = openDatabase(':memory:');
  new SessionStore(database);
  seedTenant(database, 'tenant-1');
  seedTenant(database, 'tenant-2');
  const environments = new EnvironmentStore(database, {
    ...(options.now ? { now: options.now } : {}),
    pairingCredentialTtlMs: 60_000,
  });
  const environmentOperations = new EnvironmentOperationStore(database, options.now);
  const channel = new DeviceChannel({
    environments,
    environmentOperations,
    ...(options.now ? { now: options.now } : {}),
  });
  const server = Fastify({ logger: false, ...(options.tls ? { https: options.tls } : {}) });
  registerDeviceWebSocket(server, channel);
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing WSS test address.');
  const protocol = options.tls === undefined ? 'ws' : 'wss';
  const hostname = options.tls === undefined ? '127.0.0.1' : 'localhost';
  const url = `${protocol}://${hostname}:${address.port}/devices/wss`;
  cleanup.push(async () => {
    await server.close();
    database.close();
  });
  return { database, environments, environmentOperations, channel, server, url };
}

function registerEnvironment(
  environments: EnvironmentStore,
  recommendedPwd: string,
  tenantId = 'tenant-1',
) {
  actionSequence += 1;
  return environments.register({
    tenantId,
    clientActionId: `pairing-${actionSequence}`,
    name: `Pairing server ${actionSequence}`,
    recommendedPwd,
    kind: process.platform === 'darwin' ? 'self_hosted_macos' : 'self_hosted_linux',
  });
}

interface DaemonResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runDaemon(
  args: string[],
  identityPath: string,
  pairingCredential?: string,
  caPath?: string,
): Promise<DaemonResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', daemonMain, ...args], {
      cwd: repository,
      env: {
        ...process.env,
        KAIROS_DEVICE_IDENTITY_PATH: identityPath,
        KAIROS_DAEMON_VERSION: '2.0.0-integration',
        ...(caPath === undefined ? {} : { NODE_EXTRA_CA_CERTS: caPath }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(pairingCredential ?? '');
  });
}

function pairOnce(
  url: string,
  issued: ReturnType<EnvironmentStore['register']>,
  identityDirectory: string,
  directory: string,
  caPath?: string,
) {
  const identityPath = join(identityDirectory, 'identity.json');
  return runDaemon(
    [
      'pair-once',
      '--env-id',
      issued.environment.envId,
      '--server-url',
      url,
      '--directory',
      directory,
      '--device-name',
      'Integration Ubuntu server',
      '--identity-path',
      identityPath,
      '--timeout-seconds',
      '5',
    ],
    identityPath,
    issued.pairingCredential,
    caPath,
  );
}

class ProtocolDevice {
  readonly messages: ServerMessage[] = [];
  serverHello?: Extract<ServerMessage['payload'], { case: 'serverHello' }>['value'];

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const bytes = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      const message = decodeServerMessage(bytes);
      this.messages.push(message);
      if (message.payload.case === 'serverHello') this.serverHello = message.payload.value;
      if (message.payload.case === 'operationStart')
        this.answerDirectoryCheck(message.payload.value);
    });
  }

  static async connect(url: string): Promise<ProtocolDevice> {
    const socket = new WebSocket(url);
    socket.binaryType = 'nodebuffer';
    const device = new ProtocolDevice(socket);
    await new Promise<void>((resolveOpen, reject) => {
      socket.once('open', resolveOpen);
      socket.once('error', reject);
    });
    cleanup.push(() => socket.terminate());
    return device;
  }

  get connected(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  send(init: DaemonMessageInit): void {
    this.socket.send(encodeDaemonMessage(init), { binary: true });
  }

  hello(input: {
    envId: string;
    instanceId: string;
    deviceId?: string;
    deviceBindingId?: string;
    credential: string;
    pairing: boolean;
  }): void {
    this.send({
      payload: {
        case: 'deviceHello',
        value: {
          deviceId: input.deviceId ?? '',
          instanceId: input.instanceId,
          protocolMajor: 1,
          deviceName: 'Protocol integration device',
          capabilities: [DeviceCapability.DIRECTORY_CHECK],
          envId: input.envId,
          daemonVersion: '2.0.0-integration',
          os: process.platform,
          architecture: 'x86_64',
          deviceBindingId: input.deviceBindingId ?? '',
          authentication: {
            case: input.pairing ? 'pairingCredential' : 'deviceCredential',
            value: input.credential,
          },
        },
      },
    });
  }

  payload<T extends NonNullable<ServerMessage['payload']['case']>>(kind: T) {
    return this.messages.find(
      (message): message is ServerMessage & { payload: { case: T } } =>
        message.payload.case === kind,
    )?.payload;
  }

  async waitPayload<T extends NonNullable<ServerMessage['payload']['case']>>(kind: T) {
    return waitFor(() => this.payload(kind));
  }

  async maintenanceQuery(): Promise<
    Extract<ServerMessage['payload'], { case: 'environmentMaintenanceReport' }>['value']
  > {
    const requestId = `maintenance-${this.messages.length}`;
    this.send({
      payload: {
        case: 'environmentMaintenanceQuery',
        value: {
          requestId,
          envId: this.serverHello?.envId ?? '',
          deviceBindingId: this.serverHello?.deviceBindingId ?? '',
        },
      },
    });
    const report = await waitFor(
      () =>
        this.messages.find(
          (message) =>
            message.payload.case === 'environmentMaintenanceReport' &&
            message.payload.value.requestId === requestId,
        ) as (ServerMessage & { payload: { case: 'environmentMaintenanceReport' } }) | undefined,
    );
    return report.payload.value;
  }

  async revoke(): Promise<void> {
    const requestId = `revoke-${this.messages.length}`;
    this.send({
      payload: {
        case: 'environmentRevoke',
        value: {
          requestId,
          envId: this.serverHello?.envId ?? '',
          deviceBindingId: this.serverHello?.deviceBindingId ?? '',
          reason: 'Integration uninstall',
        },
      },
    });
    await waitFor(() =>
      this.messages.some(
        (message) =>
          message.payload.case === 'environmentRevokeAck' &&
          message.payload.value.requestId === requestId,
      )
        ? true
        : undefined,
    );
  }

  private answerDirectoryCheck(
    start: Extract<ServerMessage['payload'], { case: 'operationStart' }>['value'],
  ): void {
    if (start.action.case !== 'directoryCheck' || start.target === undefined) return;
    const path = start.action.value.path;
    let ready = false;
    let normalizedPath = path;
    try {
      normalizedPath = realpathSync(path);
      ready = statSync(normalizedPath).isDirectory();
      accessSync(normalizedPath, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch {
      ready = false;
    }
    const outcome = {
      normalizedPath,
      exists: existsSync(path),
      directory: ready,
      readable: ready,
      writable: ready,
      executable: ready,
      os: 'linux',
      architecture: 'x86_64',
      capabilities: [DeviceCapability.DIRECTORY_CHECK],
      resources: [],
      ...(ready ? {} : { reason: 'Directory is unavailable.' }),
    };
    this.send({
      payload: {
        case: 'operationAccepted',
        value: {
          operationId: start.operationId,
          requestId: start.requestId,
          target: start.target,
          status: OperationStatus.ACCEPTED,
          acceptedAt: { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 },
        },
      },
    });
    this.send({
      payload: {
        case: 'operationResult',
        value: {
          operationId: start.operationId,
          target: start.target,
          status: ready ? OperationStatus.COMPLETED : OperationStatus.FAILED,
          observedAt: { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 },
          requestId: start.requestId,
          outcome: { case: 'directoryCheck', value: outcome },
        },
      },
    });
  }
}

async function pairProtocolDevice(
  device: ProtocolDevice,
  input: Parameters<ProtocolDevice['hello']>[0],
): Promise<void> {
  device.hello(input);
  await device.waitPayload('serverHello');
  await device.waitPayload('operationResultAck');
}

afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

describe('environment pairing integration', () => {
  it('runs pair-once over TLS and persists readiness without logging credentials', async () => {
    const directory = temporaryDirectory('kairos-environment-wss-');
    const keyPath = join(directory, 'key.pem');
    const certificatePath = join(directory, 'certificate.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certificatePath,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
      ],
      { stdio: 'ignore' },
    );
    const fixtureServer = await fixture({
      tls: { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certificatePath, 'utf8') },
    });
    const workspace = temporaryDirectory('kairos-environment-workspace-');
    const before = readdirSync(workspace);
    const issued = registerEnvironment(fixtureServer.environments, workspace);
    const identityDirectory = temporaryDirectory('kairos-environment-identity-');
    const result = await pairOnce(
      fixtureServer.url,
      issued,
      identityDirectory,
      workspace,
      certificatePath,
    );
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain('persisted readiness confirmed');
    expect(`${result.stdout}${result.stderr}`).not.toContain(issued.pairingCredential);
    expect(fixtureServer.environments.get('tenant-1', issued.environment.envId)).toMatchObject({
      bindingStatus: 'active',
      connectionStatus: 'offline',
      capabilityStatus: 'ready',
      directoryStatus: 'ready',
      grantedCapabilities: [
        DeviceCapability.DIRECTORY_CHECK,
        DeviceCapability.DIRECTORY_LIST,
        DeviceCapability.FILE_SEARCH,
      ],
      normalizedPwd: realpathSync(workspace),
      ready: false,
    });
    const persisted = fixtureServer.database
      .prepare(
        `SELECT status, result_status, result_acknowledged_at FROM environment_operations
         WHERE env_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(issued.environment.envId) as Record<string, unknown>;
    expect(persisted.status).toBe(OperationStatus.COMPLETED);
    expect(persisted.result_status).toBe(OperationStatus.COMPLETED);
    expect(persisted.result_acknowledged_at).not.toBeNull();
    expect(readdirSync(workspace)).toEqual(before);
    const identityPath = join(identityDirectory, 'identity.json');
    const identityText = readFileSync(identityPath, 'utf8');
    expect(statSync(identityPath).mode & 0o777).toBe(0o600);
    expect(identityText).not.toContain('instanceId');
    expect(identityText).not.toContain(issued.pairingCredential);

    const replayDirectory = temporaryDirectory('kairos-environment-replay-');
    const replay = await pairOnce(
      fixtureServer.url,
      issued,
      replayDirectory,
      workspace,
      certificatePath,
    );
    expect(replay.code).toBe(78);
    expect(existsSync(join(replayDirectory, 'identity.json'))).toBe(false);
    expect(`${replay.stdout}${replay.stderr}`).not.toContain(issued.pairingCredential);
  });

  it('arbitrates conflicts before old state changes, then recovers, reports maintenance and revokes', async () => {
    const fixtureServer = await fixture();
    const workspace = temporaryDirectory('kairos-environment-protocol-workspace-');
    const issued = registerEnvironment(fixtureServer.environments, workspace);
    const first = await ProtocolDevice.connect(fixtureServer.url);
    await pairProtocolDevice(first, {
      envId: issued.environment.envId,
      instanceId: 'instance-1',
      credential: issued.pairingCredential,
      pairing: true,
    });
    const hello = first.serverHello;
    if (hello === undefined) throw new Error('Pairing ServerHello is missing.');
    const credential = hello.deviceCredential ?? '';

    first.socket.terminate();
    await waitFor(() =>
      fixtureServer.environments.get('tenant-1', issued.environment.envId).connectionStatus ===
      'offline'
        ? true
        : undefined,
    );
    const sameInstance = await ProtocolDevice.connect(fixtureServer.url);
    await pairProtocolDevice(sameInstance, {
      envId: issued.environment.envId,
      instanceId: 'instance-1',
      deviceId: hello.deviceId,
      deviceBindingId: hello.deviceBindingId,
      credential,
      pairing: false,
    });

    const conflict = await ProtocolDevice.connect(fixtureServer.url);
    conflict.hello({
      envId: issued.environment.envId,
      instanceId: 'instance-conflict',
      deviceId: hello.deviceId,
      deviceBindingId: hello.deviceBindingId,
      credential,
      pairing: false,
    });
    expect((await conflict.waitPayload('error')).value.code).toBe(
      DeviceErrorCode.IDENTITY_CONFLICT,
    );
    expect(sameInstance.connected).toBe(true);
    expect(fixtureServer.environments.get('tenant-1', issued.environment.envId)).toMatchObject({
      instanceId: 'instance-1',
      connectionStatus: 'online',
    });
    expect(
      fixtureServer.database
        .prepare('SELECT COUNT(*) AS count FROM environment_operations WHERE status = ?')
        .get(OperationStatus.UNKNOWN),
    ).toMatchObject({ count: 0 });

    const abandoned = fixtureServer.environmentOperations.createIntent({
      operationId: 'abandoned-read-only-check',
      tenantId: 'tenant-1',
      envId: issued.environment.envId,
      deviceId: hello.deviceId,
      deviceBindingId: hello.deviceBindingId,
      targetInstanceId: 'instance-1',
      path: workspace,
      loadWorkspace: false,
      expiresAt: new Date(Date.now() + 60_000),
    }).operation;
    sameInstance.socket.terminate();
    await waitFor(() =>
      fixtureServer.environments.get('tenant-1', issued.environment.envId).connectionStatus ===
      'offline'
        ? true
        : undefined,
    );
    const restarted = await ProtocolDevice.connect(fixtureServer.url);
    await pairProtocolDevice(restarted, {
      envId: issued.environment.envId,
      instanceId: 'instance-2',
      deviceId: hello.deviceId,
      deviceBindingId: hello.deviceBindingId,
      credential,
      pairing: false,
    });
    expect(fixtureServer.environmentOperations.find(abandoned.operationId)).toMatchObject({
      status: OperationStatus.UNKNOWN,
      deliveryState: 'intent',
    });

    expect((await restarted.maintenanceQuery()).maintenanceMode).toBe(
      EnvironmentMaintenanceMode.NORMAL,
    );
    fixtureServer.environments.setMaintenance({
      tenantId: 'tenant-1',
      clientActionId: 'maintenance-draining',
      envId: issued.environment.envId,
      mode: 'draining',
      expectedVersion: 0n,
    });
    const active = fixtureServer.environmentOperations.createIntent({
      operationId: 'maintenance-active-check',
      tenantId: 'tenant-1',
      envId: issued.environment.envId,
      deviceId: hello.deviceId,
      deviceBindingId: hello.deviceBindingId,
      targetInstanceId: 'instance-2',
      path: workspace,
      loadWorkspace: false,
      expiresAt: new Date(Date.now() + 60_000),
    }).operation;
    expect(await restarted.maintenanceQuery()).toMatchObject({
      maintenanceMode: EnvironmentMaintenanceMode.DRAINING,
      maintenanceVersion: 1n,
      activeOperationCount: 1n,
    });
    fixtureServer.environmentOperations.markInstanceLost(
      active.deviceBindingId,
      active.targetInstanceId,
    );
    expect((await restarted.maintenanceQuery()).activeOperationCount).toBe(0n);

    await restarted.revoke();
    expect(fixtureServer.environments.get('tenant-1', issued.environment.envId)).toMatchObject({
      bindingStatus: 'revoked',
      connectionStatus: 'offline',
      ready: false,
    });
    const revoked = await ProtocolDevice.connect(fixtureServer.url);
    revoked.hello({
      envId: issued.environment.envId,
      instanceId: 'instance-3',
      deviceId: hello.deviceId,
      deviceBindingId: hello.deviceBindingId,
      credential,
      pairing: false,
    });
    expect((await revoked.waitPayload('error')).value.code).toBe(
      DeviceErrorCode.ENVIRONMENT_REVOKED,
    );
  });

  it('rejects a DeviceError targeting another tenant binding without changing state', async () => {
    const fixtureServer = await fixture();
    const workspace = temporaryDirectory('kairos-environment-cross-tenant-');
    const victimIssued = registerEnvironment(fixtureServer.environments, workspace, 'tenant-1');
    const attackerIssued = registerEnvironment(fixtureServer.environments, workspace, 'tenant-2');
    const victim = await ProtocolDevice.connect(fixtureServer.url);
    await pairProtocolDevice(victim, {
      envId: victimIssued.environment.envId,
      instanceId: 'instance-victim',
      credential: victimIssued.pairingCredential,
      pairing: true,
    });
    const attacker = await ProtocolDevice.connect(fixtureServer.url);
    await pairProtocolDevice(attacker, {
      envId: attackerIssued.environment.envId,
      instanceId: 'instance-attacker',
      credential: attackerIssued.pairingCredential,
      pairing: true,
    });
    const victimHello = victim.serverHello;
    if (victimHello === undefined) throw new Error('Victim ServerHello is missing.');
    const readinessBefore = fixtureServer.environments.get(
      'tenant-1',
      victimIssued.environment.envId,
    );
    const pending = fixtureServer.environmentOperations.createIntent({
      operationId: 'victim-pending-operation',
      tenantId: 'tenant-1',
      envId: victimIssued.environment.envId,
      deviceId: victimHello.deviceId,
      deviceBindingId: victimHello.deviceBindingId,
      targetInstanceId: 'instance-victim',
      path: workspace,
      loadWorkspace: false,
      expiresAt: new Date(Date.now() + 60_000),
    }).operation;
    expect(
      fixtureServer.environmentOperations.countActiveForBinding(victimHello.deviceBindingId),
    ).toBe(1);

    attacker.send({
      payload: {
        case: 'error',
        value: {
          code: DeviceErrorCode.CAPABILITY_UNAVAILABLE,
          message: 'cross-tenant result injection',
          action: 5,
          operationId: pending.operationId,
        },
      },
    });
    expect((await attacker.waitPayload('error')).value.code).toBe(
      DeviceErrorCode.PERMISSION_DENIED,
    );
    expect(fixtureServer.environmentOperations.find(pending.operationId)).toEqual(pending);
    expect(
      fixtureServer.environmentOperations.countActiveForBinding(victimHello.deviceBindingId),
    ).toBe(1);
    expect(fixtureServer.environments.get('tenant-1', victimIssued.environment.envId)).toEqual(
      readinessBefore,
    );

    victim.send({
      payload: {
        case: 'error',
        value: {
          code: DeviceErrorCode.CAPABILITY_UNAVAILABLE,
          message: 'legitimate directory failure',
          action: 5,
          operationId: pending.operationId,
        },
      },
    });
    await waitFor(() =>
      fixtureServer.environmentOperations.find(pending.operationId)?.resultStatus ===
      OperationStatus.FAILED
        ? true
        : undefined,
    );
    expect(
      fixtureServer.environmentOperations.countActiveForBinding(victimHello.deviceBindingId),
    ).toBe(0);
    expect(fixtureServer.environments.get('tenant-1', victimIssued.environment.envId)).toEqual(
      readinessBefore,
    );
  });

  it('distinguishes bound-not-ready from unbound expiry without leaking credentials', async () => {
    const fixtureServer = await fixture();
    const workspace = temporaryDirectory('kairos-environment-invalid-workspace-');
    const issued = registerEnvironment(fixtureServer.environments, join(workspace, 'missing'));
    const identityDirectory = temporaryDirectory('kairos-environment-invalid-identity-');
    const failed = await pairOnce(fixtureServer.url, issued, identityDirectory, workspace);
    expect(failed.code).toBe(69);
    expect(failed.stderr).toContain('bound but not executable');
    expect(failed.stderr).not.toContain(issued.pairingCredential);
    expect(existsSync(join(identityDirectory, 'identity.json'))).toBe(true);
    expect(fixtureServer.environments.get('tenant-1', issued.environment.envId)).toMatchObject({
      bindingStatus: 'active',
      capabilityStatus: 'ready',
      directoryStatus: 'failed',
      ready: false,
    });

    let current = new Date();
    const expiring = await fixture({ now: () => current });
    const expired = registerEnvironment(expiring.environments, workspace);
    current = new Date(current.getTime() + 61_000);
    const expiredDirectory = temporaryDirectory('kairos-environment-expired-');
    const rejected = await pairOnce(expiring.url, expired, expiredDirectory, workspace);
    expect(rejected.code).toBe(78);
    expect(rejected.stderr).toContain('remains unbound');
    expect(rejected.stderr).not.toContain(expired.pairingCredential);
    expect(existsSync(join(expiredDirectory, 'identity.json'))).toBe(false);
    expect(expiring.environments.get('tenant-1', expired.environment.envId)).toMatchObject({
      bindingStatus: 'pairing',
      ready: false,
    });
  });
});
