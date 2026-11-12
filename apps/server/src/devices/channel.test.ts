import type { DaemonMessageInit, ServerMessage } from '@kairos/contracts/device';
import {
  DEVICE_PROTOCOL_MAJOR,
  DeviceCapability,
  DeviceErrorCode,
  decodeServerMessage,
  encodeDaemonMessage,
  OperationStatus,
  OutputStream,
} from '@kairos/contracts/device';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { seedTestSession } from '../integration/test-authentication.js';
import { ensureTenantPlatformEnvironment } from '../platform/registry.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import {
  DeviceChannel,
  type DeviceChannelOptions,
  type StartEnvironmentOperationInput,
} from './channel.js';
import { EnvironmentOperationStore } from './environment-operation-store.js';
import { EnvironmentStore } from './environment-store.js';
import { DeviceFailure } from './errors.js';
import { registerDeviceWebSocket } from './websocket.js';

const cleanup: Array<() => Promise<void> | void> = [];
const capabilities = [DeviceCapability.BASH, DeviceCapability.DIRECTORY_CHECK];
const timestamp = () => ({ seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 });

class TestDevice {
  readonly messages: ServerMessage[] = [];
  private constructor(readonly socket: WebSocket) {}
  static async connect(url: string) {
    const socket = new WebSocket(url);
    const device = new TestDevice(socket);
    socket.on('message', (data) => {
      const bytes = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      device.messages.push(decodeServerMessage(bytes));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    cleanup.push(() => socket.terminate());
    return device;
  }
  send(init: DaemonMessageInit) {
    this.socket.send(encodeDaemonMessage(init));
  }
  values<T extends NonNullable<ServerMessage['payload']['case']>>(kind: T) {
    return this.messages.flatMap((message) =>
      message.payload.case === kind ? [message.payload.value] : [],
    ) as Array<Extract<ServerMessage['payload'], { case: T }>['value']>;
  }
  async wait<T extends NonNullable<ServerMessage['payload']['case']>>(kind: T) {
    await vi.waitFor(() => expect(this.values(kind).length).toBeGreaterThan(0));
    const value = this.values(kind).at(-1);
    if (!value) throw new Error(`Missing ${kind}`);
    return value;
  }
}

async function fixture(
  options: Partial<
    Pick<DeviceChannelOptions, 'now' | 'offlineAfterMilliseconds' | 'platform' | 'onDeviceError'>
  > = {},
) {
  const database = openDatabase(':memory:');
  new SessionStore(database);
  seedTestSession(database, 'tenant-1', 'channel-test-token');
  const environments = new EnvironmentStore(database);
  const operations = new EnvironmentOperationStore(database);
  const channel = new DeviceChannel({
    environments,
    environmentOperations: operations,
    ...options,
  });
  const server = Fastify({ logger: false });
  registerDeviceWebSocket(server, channel);
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing channel test address.');
  cleanup.push(async () => {
    await server.close();
    database.close();
  });
  const issued = environments.register({
    tenantId: 'tenant-1',
    clientActionId: 'register-1',
    name: 'Test environment',
    recommendedPwd: '/tmp',
  });
  const url = `ws://127.0.0.1:${address.port}/devices/wss`;
  const start = (
    override: Partial<StartEnvironmentOperationInput> = {},
  ): StartEnvironmentOperationInput => ({
    operationId: 'operation-1',
    tenantId: 'tenant-1',
    envId: issued.environment.envId,
    bindingVersion: 1n,
    action: { case: 'bash', value: { command: 'printf test', cwd: '/tmp', timeoutSeconds: 30 } },
    expiresAt: new Date(Date.now() + 60_000),
    ...override,
  });
  const connect = async (
    identity?: { deviceId: string; deviceBindingId: string; deviceCredential: string },
    instanceId = 'instance-1',
    controlOnly = false,
  ) => {
    const peer = await TestDevice.connect(url);
    peer.send({
      payload: {
        case: 'deviceHello',
        value: {
          envId: issued.environment.envId,
          instanceId,
          protocolMajor: DEVICE_PROTOCOL_MAJOR,
          controlOnly,
          deviceName: 'Test environment',
          daemonVersion: 'test',
          os: 'linux',
          architecture: 'x86_64',
          capabilities: controlOnly ? [] : capabilities,
          ...(identity
            ? {
                deviceId: identity.deviceId,
                deviceBindingId: identity.deviceBindingId,
                authentication: {
                  case: 'deviceCredential' as const,
                  value: identity.deviceCredential,
                },
              }
            : {
                authentication: {
                  case: 'pairingCredential' as const,
                  value: issued.pairingCredential,
                },
              }),
        },
      },
    });
    const hello = await peer.wait('serverHello');
    if (controlOnly)
      return {
        peer,
        hello,
        target: {
          envId: issued.environment.envId,
          deviceBindingId: hello.deviceBindingId,
          instanceId,
          bindingVersion: 1n,
        },
      };
    const check = await peer.wait('operationStart');
    if (!check.target || check.action.case !== 'directoryCheck')
      throw new Error('Missing initial directory check.');
    peer.send({
      payload: {
        case: 'operationResult',
        value: {
          operationId: check.operationId,
          target: check.target,
          status: OperationStatus.COMPLETED,
          observedAt: timestamp(),
          outcome: {
            case: 'directoryCheck',
            value: {
              normalizedPath: '/tmp',
              exists: true,
              directory: true,
              readable: true,
              writable: true,
              executable: true,
              os: 'linux',
              architecture: 'x86_64',
              capabilities,
              resources: [],
            },
          },
        },
      },
    });
    await peer.wait('operationResultAck');
    peer.messages.length = 0;
    return { peer, hello, target: { ...check.target, bindingVersion: 1n } };
  };
  return { database, environments, operations, channel, issued, start, connect, url };
}

afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

describe('environment-only device channel', () => {
  it('validates platform Pod authorization before consuming a credential and suppresses eager directory work', async () => {
    let allowed = false;
    const authorizeHello = vi.fn(async () => {
      if (!allowed)
        throw new DeviceFailure(DeviceErrorCode.PERMISSION_DENIED, 'Old Pod cannot take over.');
      return { runtimeVersion: 1, previousInstanceGone: false };
    });
    const onDeviceError = vi.fn();
    const current = await fixture({ platform: { authorizeHello }, onDeviceError });
    const envId = ensureTenantPlatformEnvironment(current.database, 'tenant-1');
    const credential = current.environments.pairing.issue('tenant-1', envId);
    const send = async (controlOnly = false) => {
      const peer = await TestDevice.connect(current.url);
      peer.send({
        payload: {
          case: 'deviceHello',
          value: {
            envId,
            instanceId: 'platform-instance',
            protocolMajor: DEVICE_PROTOCOL_MAJOR,
            daemonVersion: 'test',
            os: 'linux',
            architecture: 'x86_64',
            deviceName: 'platform',
            capabilities,
            platformPodName: 'pod-platform',
            platformPodUid: '11111111-1111-1111-1111-111111111111',
            controlOnly,
            authentication: { case: 'pairingCredential', value: credential.pairingCredential },
          },
        },
      });
      return peer;
    };
    const denied = await send();
    expect(await denied.wait('error')).toMatchObject({ code: DeviceErrorCode.PERMISSION_DENIED });
    expect(onDeviceError).toHaveBeenCalledWith({
      name: 'DeviceFailure',
      code: DeviceErrorCode.PERMISSION_DENIED,
      message: 'Old Pod cannot take over.',
      deviceId: '',
      instanceId: '',
    });
    expect(JSON.stringify(onDeviceError.mock.calls)).not.toContain(credential.pairingCredential);
    expect(
      current.database
        .prepare('SELECT consumed_at FROM environment_pairing_credentials WHERE credential_id=?')
        .get(credential.credentialId),
    ).toMatchObject({ consumed_at: null });
    allowed = true;
    const accepted = await send();
    const hello = await accepted.wait('serverHello');
    expect(hello).toMatchObject({
      platformPodName: 'pod-platform',
      platformPodUid: '11111111-1111-1111-1111-111111111111',
    });
    expect(accepted.values('operationStart')).toEqual([]);
    expect(current.environments.get('tenant-1', envId).directoryStatus).toBe('pending');
    expect(
      current.database
        .prepare('SELECT default_env_id FROM tenants WHERE tenant_id=?')
        .get('tenant-1'),
    ).toMatchObject({ default_env_id: null });
    expect(authorizeHello).toHaveBeenCalledTimes(2);
    expect(onDeviceError).toHaveBeenCalledTimes(1);
  });
  it('rejects a hello without an environment rather than accepting legacy credentials', async () => {
    const current = await fixture();
    const peer = await TestDevice.connect(current.url);
    peer.send({
      payload: {
        case: 'deviceHello',
        value: {
          instanceId: 'instance-old',
          protocolMajor: 1,
          deviceName: 'Old device',
          capabilities: [DeviceCapability.BASH],
          authentication: { case: 'pairingCredential', value: 'kp1_old' },
        },
      },
    });
    expect(await peer.wait('error')).toMatchObject({ code: DeviceErrorCode.INVALID_MESSAGE });
    expect(peer.values('serverHello')).toEqual([]);
    expect(
      current.database.prepare('SELECT COUNT(*) AS count FROM device_pairing_credentials').get(),
    ).toEqual({ count: 0 });
  });

  it('rejects retired Bash wire payloads after successful environment authentication', async () => {
    const current = await fixture();
    const { peer } = await current.connect();
    peer.socket.send(new Uint8Array([0x08, 0x01, 0x3a, 0x00]));
    expect(await peer.wait('error')).toMatchObject({ code: DeviceErrorCode.PROTOCOL_INCOMPATIBLE });
    expect(peer.values('operationResultAck')).toEqual([]);
  });

  it('deduplicates complete intents and rejects different parameters for the same ID', async () => {
    const current = await fixture();
    const { peer } = await current.connect();
    const input = current.start();
    await current.channel.startEnvironmentOperation(input);
    const started = await peer.wait('operationStart');
    expect(started.operationId).toBe(input.operationId);
    await current.channel.startEnvironmentOperation(input);
    expect(peer.values('operationStart')).toHaveLength(1);
    await expect(
      current.channel.startEnvironmentOperation({
        ...input,
        action: { case: 'bash', value: { command: 'different', cwd: '/tmp', timeoutSeconds: 30 } },
      }),
    ).rejects.toMatchObject({ code: DeviceErrorCode.OPERATION_CONFLICT });
  });

  it('does not persist an intent while offline or transmit before a successful intent commit', async () => {
    const current = await fixture();
    await expect(current.channel.startEnvironmentOperation(current.start())).rejects.toMatchObject({
      code: DeviceErrorCode.ENVIRONMENT_OFFLINE,
    });
    expect(current.operations.find('operation-1')).toBeUndefined();
    const { peer } = await current.connect();
    current.database.exec(
      "CREATE TRIGGER fail_intent BEFORE INSERT ON environment_operations WHEN NEW.operation_id = 'operation-1' BEGIN SELECT RAISE(ABORT, 'intent failed'); END",
    );
    await expect(current.channel.startEnvironmentOperation(current.start())).rejects.toThrow(
      'intent failed',
    );
    expect(peer.values('operationStart')).toEqual([]);
  });

  it('withholds terminal acknowledgement until all output bytes are persisted', async () => {
    const current = await fixture();
    const { peer, target } = await current.connect();
    await current.channel.startEnvironmentOperation(current.start());
    await peer.wait('operationStart');
    peer.send({
      payload: {
        case: 'operationOutputChunk',
        value: {
          operationId: 'operation-1',
          target,
          offset: 0n,
          stream: OutputStream.STDOUT,
          data: Buffer.from('ab'),
        },
      },
    });
    await peer.wait('operationOutputAck');
    peer.send({
      payload: {
        case: 'operationResult',
        value: {
          operationId: 'operation-1',
          target,
          status: OperationStatus.COMPLETED,
          observedAt: timestamp(),
          outcome: { case: 'bash', value: { exitCode: 0, outputComplete: true, endOffset: 4n } },
        },
      },
    });
    await vi.waitFor(() => expect(current.operations.find('operation-1')?.outputGap).toBe(true));
    expect(peer.values('operationResultAck')).toEqual([]);
    peer.send({
      payload: {
        case: 'operationOutputChunk',
        value: {
          operationId: 'operation-1',
          target,
          offset: 2n,
          stream: OutputStream.STDOUT,
          data: Buffer.from('cd'),
        },
      },
    });
    expect(await peer.wait('operationResultAck')).toMatchObject({ operationId: 'operation-1' });
    expect(current.operations.find('operation-1')).toMatchObject({
      nextOffset: 4n,
      outputComplete: true,
      outputGap: false,
    });
  });

  it('does not acknowledge results if their SQLite transaction fails', async () => {
    const current = await fixture();
    const { peer, target } = await current.connect();
    await current.channel.startEnvironmentOperation(current.start());
    await peer.wait('operationStart');
    current.database.exec(
      "CREATE TRIGGER fail_result BEFORE UPDATE OF result_recorded_at ON environment_operations WHEN NEW.operation_id = 'operation-1' BEGIN SELECT RAISE(ABORT, 'result failed'); END",
    );
    peer.send({
      payload: {
        case: 'operationResult',
        value: {
          operationId: 'operation-1',
          target,
          status: OperationStatus.COMPLETED,
          observedAt: timestamp(),
          outcome: { case: 'bash', value: { exitCode: 0, outputComplete: true, endOffset: 0n } },
        },
      },
    });
    expect(await peer.wait('error')).toMatchObject({ code: DeviceErrorCode.INTERNAL });
    expect(peer.values('operationResultAck')).toEqual([]);
    expect(current.operations.find('operation-1')?.resultRecordedAt).toBeUndefined();
  });

  it('retains cancellation requested until a terminal result is received', async () => {
    const current = await fixture();
    const { peer, target } = await current.connect();
    await current.channel.startEnvironmentOperation(current.start());
    await peer.wait('operationStart');
    const cancelled = await current.channel.cancelEnvironmentOperation({
      tenantId: 'tenant-1',
      operationId: 'operation-1',
      reason: 'test',
    });
    expect(cancelled.status).toBe(OperationStatus.CANCEL_REQUESTED);
    await peer.wait('operationCancel');
    expect(current.operations.find('operation-1')?.resultRecordedAt).toBeUndefined();
    peer.send({
      payload: {
        case: 'operationResult',
        value: {
          operationId: 'operation-1',
          target,
          status: OperationStatus.CANCELLED,
          observedAt: timestamp(),
          outcome: { case: 'bash', value: { outputComplete: true, endOffset: 0n } },
        },
      },
    });
    await peer.wait('operationResultAck');
    expect(current.operations.find('operation-1')?.status).toBe(OperationStatus.CANCELLED);
  });
});

describe('control-only environment connections', () => {
  it('keeps runtime identity, readiness and pending operations unchanged across control heartbeats and close', async () => {
    const current = await fixture();
    const runtime = await current.connect();
    const identity = {
      deviceId: runtime.hello.deviceId,
      deviceBindingId: runtime.hello.deviceBindingId,
      deviceCredential: runtime.hello.deviceCredential ?? '',
    };
    await current.channel.startEnvironmentOperation(current.start());
    const before = current.environments.get('tenant-1', current.issued.environment.envId);
    const countBefore = current.database
      .prepare('SELECT COUNT(*) AS count FROM environment_operations')
      .get();
    const control = await current.connect(identity, 'control-1', true);
    expect(control.hello.controlOnly).toBe(true);
    expect(control.hello.capabilities).toEqual([]);
    expect(control.hello.deviceCredential).toBeUndefined();
    control.peer.send({
      payload: { case: 'heartbeat', value: { sequence: 1n, sentAt: timestamp() } },
    });
    await control.peer.wait('heartbeatAck');
    control.peer.send({
      payload: {
        case: 'environmentMaintenanceQuery',
        value: {
          requestId: 'control-maintenance',
          envId: before.envId,
          deviceBindingId: identity.deviceBindingId,
        },
      },
    });
    expect(await control.peer.wait('environmentMaintenanceReport')).toMatchObject({
      activeOperationCount: 1n,
      maintenanceVersion: 0n,
    });
    expect(control.peer.values('operationStart')).toEqual([]);
    expect(control.peer.values('operationQuery')).toEqual([]);
    expect(current.environments.get('tenant-1', before.envId)).toEqual(before);
    const closed = new Promise<void>((resolve) =>
      control.peer.socket.once('close', () => resolve()),
    );
    control.peer.socket.close();
    await closed;
    expect(current.environments.get('tenant-1', before.envId)).toEqual(before);
    expect(runtime.peer.socket.readyState).toBe(WebSocket.OPEN);
    expect(
      current.operations.getForTenant('tenant-1', 'operation-1').resultRecordedAt,
    ).toBeUndefined();
    expect(
      current.database.prepare('SELECT COUNT(*) AS count FROM environment_operations').get(),
    ).toEqual(countBefore);
  });

  it.each(['operationResult', 'error', 'retiredPayload'] as const)(
    'rejects control %s before mutating the original operation',
    async (kind) => {
      const current = await fixture();
      const runtime = await current.connect();
      const identity = {
        deviceId: runtime.hello.deviceId,
        deviceBindingId: runtime.hello.deviceBindingId,
        deviceCredential: runtime.hello.deviceCredential ?? '',
      };
      await current.channel.startEnvironmentOperation(current.start());
      const control = await current.connect(identity, 'control-forgery', true);
      if (kind === 'operationResult')
        control.peer.send({
          payload: {
            case: 'operationResult',
            value: {
              operationId: 'operation-1',
              target: runtime.target,
              status: OperationStatus.COMPLETED,
              observedAt: timestamp(),
              outcome: {
                case: 'bash',
                value: { exitCode: 0, outputComplete: true, endOffset: 0n },
              },
            },
          },
        });
      else if (kind === 'error')
        control.peer.send({
          payload: {
            case: 'error',
            value: {
              operationId: 'operation-1',
              code: DeviceErrorCode.INTERNAL,
              message: 'forged result',
              action: 1,
            },
          },
        });
      else control.peer.socket.send(new Uint8Array([0x08, 0x01, 0x3a, 0x00]));
      expect(await control.peer.wait('error')).toMatchObject({
        code:
          kind === 'retiredPayload'
            ? DeviceErrorCode.PROTOCOL_INCOMPATIBLE
            : DeviceErrorCode.PERMISSION_DENIED,
      });
      expect(
        current.operations.getForTenant('tenant-1', 'operation-1').resultRecordedAt,
      ).toBeUndefined();
      expect(
        current.environments.get('tenant-1', current.issued.environment.envId).instanceId,
      ).toBe('instance-1');
      expect(runtime.peer.socket.readyState).toBe(WebSocket.OPEN);
    },
  );

  it.each(['environmentMaintenanceQuery', 'environmentRevoke'] as const)(
    'rejects a control %s targeting another binding',
    async (kind) => {
      const current = await fixture();
      const runtime = await current.connect();
      const control = await current.connect(
        {
          deviceId: runtime.hello.deviceId,
          deviceBindingId: runtime.hello.deviceBindingId,
          deviceCredential: runtime.hello.deviceCredential ?? '',
        },
        'control-cross-binding',
        true,
      );
      const value = {
        requestId: 'cross-binding',
        envId: current.issued.environment.envId,
        deviceBindingId: 'another-binding',
        reason: 'not authorized',
      };
      if (kind === 'environmentMaintenanceQuery')
        control.peer.send({ payload: { case: kind, value } });
      else control.peer.send({ payload: { case: kind, value } });
      expect(await control.peer.wait('error')).toMatchObject({
        code: DeviceErrorCode.PERMISSION_DENIED,
      });
      expect(current.environments.get('tenant-1', current.issued.environment.envId)).toMatchObject({
        bindingStatus: 'active',
        connectionStatus: 'online',
        instanceId: 'instance-1',
      });
      expect(runtime.peer.socket.readyState).toBe(WebSocket.OPEN);
    },
  );

  it('queries an offline binding without making it online and closes controls on Server shutdown', async () => {
    const current = await fixture();
    const runtime = await current.connect();
    runtime.peer.socket.close();
    await vi.waitFor(() =>
      expect(
        current.environments.get('tenant-1', current.issued.environment.envId).connectionStatus,
      ).toBe('offline'),
    );
    const before = current.environments.get('tenant-1', current.issued.environment.envId);
    const control = await current.connect(
      {
        deviceId: runtime.hello.deviceId,
        deviceBindingId: runtime.hello.deviceBindingId,
        deviceCredential: runtime.hello.deviceCredential ?? '',
      },
      'offline-control',
      true,
    );
    control.peer.send({
      payload: { case: 'heartbeat', value: { sequence: 1n, sentAt: timestamp() } },
    });
    await control.peer.wait('heartbeatAck');
    expect(current.environments.get('tenant-1', before.envId)).toEqual(before);
    const closed = new Promise<void>((resolve) =>
      control.peer.socket.once('close', () => resolve()),
    );
    current.channel.close();
    await closed;
    expect(current.environments.get('tenant-1', before.envId)).toEqual(before);
  });

  it('refuses maintenance on an authenticated control after GUI revocation', async () => {
    const current = await fixture();
    const runtime = await current.connect();
    const control = await current.connect(
      {
        deviceId: runtime.hello.deviceId,
        deviceBindingId: runtime.hello.deviceBindingId,
        deviceCredential: runtime.hello.deviceCredential ?? '',
      },
      'revoked-control',
      true,
    );
    current.environments.revoke({
      tenantId: 'tenant-1',
      clientActionId: 'gui-revoke-control',
      envId: current.issued.environment.envId,
    });
    control.peer.send({
      payload: {
        case: 'environmentMaintenanceQuery',
        value: {
          requestId: 'after-revoke',
          envId: current.issued.environment.envId,
          deviceBindingId: runtime.hello.deviceBindingId,
        },
      },
    });
    expect(await control.peer.wait('error')).toMatchObject({
      code: DeviceErrorCode.PERMISSION_DENIED,
    });
    expect(control.peer.values('environmentMaintenanceReport')).toEqual([]);
  });
});

it('expires idle control connections without changing runtime presence', async () => {
  let now = Date.now();
  const current = await fixture({ now: () => new Date(now), offlineAfterMilliseconds: 30 });
  const runtime = await current.connect();
  const before = current.environments.get('tenant-1', current.issued.environment.envId);
  const control = await current.connect(
    {
      deviceId: runtime.hello.deviceId,
      deviceBindingId: runtime.hello.deviceBindingId,
      deviceCredential: runtime.hello.deviceCredential ?? '',
    },
    'idle-control',
    true,
  );
  const closed = new Promise<void>((resolve) => control.peer.socket.once('close', () => resolve()));
  now += 100;
  await closed;
  expect(current.environments.get('tenant-1', before.envId)).toEqual(before);
  expect(runtime.peer.socket.readyState).toBe(WebSocket.OPEN);
});

it('limits controls per binding, preserves runtime and admits a query after one control closes', async () => {
  const current = await fixture();
  const runtime = await current.connect();
  const identity = {
    deviceId: runtime.hello.deviceId,
    deviceBindingId: runtime.hello.deviceBindingId,
    deviceCredential: runtime.hello.deviceCredential ?? '',
  };
  const controls = [];
  for (let index = 0; index < 4; index += 1)
    controls.push(await current.connect(identity, `limited-control-${index}`, true));
  const excess = await TestDevice.connect(current.url);
  excess.send({
    payload: {
      case: 'deviceHello',
      value: {
        envId: current.issued.environment.envId,
        instanceId: 'excess-control',
        deviceId: identity.deviceId,
        deviceBindingId: identity.deviceBindingId,
        protocolMajor: DEVICE_PROTOCOL_MAJOR,
        daemonVersion: 'candidate',
        os: 'linux',
        architecture: 'x86_64',
        controlOnly: true,
        authentication: { case: 'deviceCredential', value: identity.deviceCredential },
      },
    },
  });
  expect(await excess.wait('error')).toMatchObject({
    code: DeviceErrorCode.PERMISSION_DENIED,
    message: 'The environment control connection limit has been reached.',
  });
  expect(excess.values('serverHello')).toEqual([]);
  expect(current.environments.get('tenant-1', current.issued.environment.envId)).toMatchObject({
    instanceId: 'instance-1',
    connectionStatus: 'online',
    ready: true,
  });
  expect(runtime.peer.socket.readyState).toBe(WebSocket.OPEN);
  const first = controls[0];
  if (!first) throw Error('Missing first control.');
  const closed = new Promise<void>((resolve) => first.peer.socket.once('close', () => resolve()));
  first.peer.socket.close();
  await closed;
  const admitted = await current.connect(identity, 'admitted-after-close', true);
  admitted.peer.send({
    payload: {
      case: 'environmentMaintenanceQuery',
      value: {
        requestId: 'after-control-release',
        envId: current.issued.environment.envId,
        deviceBindingId: identity.deviceBindingId,
      },
    },
  });
  expect(await admitted.peer.wait('environmentMaintenanceReport')).toMatchObject({
    requestId: 'after-control-release',
    activeOperationCount: 0n,
  });
});

it('rejects pairing on a control hello without consuming its credential', async () => {
  const current = await fixture();
  const peer = await TestDevice.connect(current.url);
  peer.send({
    payload: {
      case: 'deviceHello',
      value: {
        controlOnly: true,
        protocolMajor: DEVICE_PROTOCOL_MAJOR,
        envId: current.issued.environment.envId,
        instanceId: 'control-pairing',
        daemonVersion: 'candidate',
        os: 'linux',
        architecture: 'x86_64',
        authentication: { case: 'pairingCredential', value: current.issued.pairingCredential },
      },
    },
  });
  expect(await peer.wait('error')).toMatchObject({ code: DeviceErrorCode.PROTOCOL_INCOMPATIBLE });
  expect(peer.values('serverHello')).toEqual([]);
  expect(current.environments.get('tenant-1', current.issued.environment.envId).bindingStatus).toBe(
    'pairing',
  );
  expect(
    current.database
      .prepare('SELECT consumed_at FROM environment_pairing_credentials WHERE env_id = ?')
      .get(current.issued.environment.envId),
  ).toEqual({ consumed_at: null });
});

it('keeps an authenticated control usable when the execution instance reconnects', async () => {
  const current = await fixture();
  const runtime = await current.connect();
  const identity = {
    deviceId: runtime.hello.deviceId,
    deviceBindingId: runtime.hello.deviceBindingId,
    deviceCredential: runtime.hello.deviceCredential ?? '',
  };
  const control = await current.connect(identity, 'reconnect-control', true);
  runtime.peer.socket.close();
  await vi.waitFor(() =>
    expect(
      current.environments.get('tenant-1', current.issued.environment.envId).connectionStatus,
    ).toBe('offline'),
  );
  const replacement = await current.connect(identity, 'replacement-runtime');
  control.peer.send({
    payload: {
      case: 'environmentMaintenanceQuery',
      value: {
        requestId: 'after-runtime-reconnect',
        envId: current.issued.environment.envId,
        deviceBindingId: identity.deviceBindingId,
      },
    },
  });
  expect(await control.peer.wait('environmentMaintenanceReport')).toMatchObject({
    requestId: 'after-runtime-reconnect',
    activeOperationCount: 0n,
  });
  expect(control.peer.socket.readyState).toBe(WebSocket.OPEN);
  expect(replacement.peer.socket.readyState).toBe(WebSocket.OPEN);
  expect(current.environments.get('tenant-1', current.issued.environment.envId)).toMatchObject({
    instanceId: 'replacement-runtime',
    connectionStatus: 'online',
    ready: true,
  });
});

it('rolls back binding revocation if the original instance results cannot be persisted', async () => {
  const current = await fixture();
  const runtime = await current.connect();
  await current.channel.startEnvironmentOperation(current.start());
  const control = await current.connect(
    {
      deviceId: runtime.hello.deviceId,
      deviceBindingId: runtime.hello.deviceBindingId,
      deviceCredential: runtime.hello.deviceCredential ?? '',
    },
    'rollback-control',
    true,
  );
  current.database.exec(
    "CREATE TRIGGER fail_revoke_result BEFORE UPDATE OF result_status ON environment_operations WHEN NEW.operation_id = 'operation-1' BEGIN SELECT RAISE(ABORT, 'injected revocation storage failure'); END;",
  );
  control.peer.send({
    payload: {
      case: 'environmentRevoke',
      value: {
        requestId: 'rollback-revoke',
        envId: current.issued.environment.envId,
        deviceBindingId: runtime.hello.deviceBindingId,
        reason: 'controlled rollback',
      },
    },
  });
  expect(await control.peer.wait('error')).toMatchObject({ code: DeviceErrorCode.INTERNAL });
  expect(control.peer.values('environmentRevokeAck')).toEqual([]);
  expect(current.environments.get('tenant-1', current.issued.environment.envId)).toMatchObject({
    bindingStatus: 'active',
    connectionStatus: 'online',
    instanceId: 'instance-1',
  });
  expect(
    current.operations.getForTenant('tenant-1', 'operation-1').resultRecordedAt,
  ).toBeUndefined();
  expect(runtime.peer.socket.readyState).toBe(WebSocket.OPEN);
});
