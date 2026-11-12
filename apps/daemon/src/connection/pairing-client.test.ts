import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DaemonMessage,
  DeviceError,
  DeviceHello,
  OperationAccepted,
  OperationOutputChunk,
  OperationState,
  ServerMessageInit,
} from '@kairos/contracts/device';
import {
  DeviceCapability,
  DeviceErrorCode,
  decodeDaemonMessage,
  encodeServerMessage,
  OperationStatus,
} from '@kairos/contracts/device';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import { DaemonIdentityStore } from '../identity.js';
import { DaemonClient } from './client.js';

const cleanup: Array<() => Promise<void> | void> = [];

async function waitFor<T>(read: () => T | undefined, timeoutMilliseconds = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for Daemon WebSocket state.');
}

class ProtocolServer {
  readonly messages: DaemonMessage[] = [];
  readonly deviceId = 'device-test';
  readonly envId = 'env-test';
  readonly deviceBindingId = 'binding-test';
  readonly deviceCredential = 'kd2_independent_test_credential';
  autoAcknowledge = true;
  autoDirectoryCheck = false;
  controlHelloOverride: boolean | undefined;
  platformPodOverride: { uid: string; name: string } | undefined;
  directoryPath = process.cwd();
  private operationSequence = 0;
  private socket: WebSocket | undefined;
  private socketClosed = true;
  private paired = false;

  private constructor(readonly server: WebSocketServer) {
    server.on('connection', (socket: WebSocket) => {
      this.socket = socket;
      this.socketClosed = false;
      socket.once('close', () => {
        this.socketClosed = true;
      });
      socket.on('message', (data) => {
        const message = decodeDaemonMessage(
          Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data),
        );
        this.messages.push(message);
        if (message.payload.case === 'deviceHello') this.handleHello(message.payload.value);
        if (message.payload.case === 'heartbeat') {
          this.send({
            payload: {
              case: 'heartbeatAck',
              value: {
                sequence: message.payload.value.sequence,
                receivedAt: { seconds: 1n, nanos: 0 },
              },
            },
          });
        }
        if (message.payload.case === 'operationOutputChunk' && this.autoAcknowledge) {
          const value = message.payload.value;
          this.send({
            payload: {
              case: 'operationOutputAck',
              value: {
                operationId: value.operationId,
                target: value.target,
                nextOffset: value.offset + BigInt(value.data.length),
              },
            },
          });
        }
        if (message.payload.case === 'operationResult' && this.autoAcknowledge) {
          const value = message.payload.value;
          this.send({
            payload: {
              case: 'operationResultAck',
              value: {
                operationId: value.operationId,
                target: value.target,
                ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
              },
            },
          });
        }
      });
    });
  }

  static async listen(pairingCredential = 'ke2_test_pairing'): Promise<ProtocolServer> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const protocol = new ProtocolServer(server);
    protocol.pairingCredential = pairingCredential;
    cleanup.push(async () => {
      protocol.socket?.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return protocol;
  }

  private pairingCredential = 'ke2_test_pairing';

  get closed(): boolean {
    return this.socketClosed;
  }

  get url(): string {
    const address = this.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Unexpected pipe address.');
    return `ws://127.0.0.1:${address.port}/devices/wss`;
  }

  send(init: ServerMessageInit): void {
    this.socket?.send(encodeServerMessage(init), { binary: true });
  }

  sendRaw(data: Uint8Array): void {
    this.socket?.send(data, { binary: true });
  }

  disconnect(): void {
    this.socket?.terminate();
  }

  values(kind: 'deviceHello'): DeviceHello[];
  values(kind: 'operationAccepted'): OperationAccepted[];
  values(kind: 'operationState'): OperationState[];
  values(kind: 'operationOutputChunk'): OperationOutputChunk[];
  values(kind: 'error'): DeviceError[];
  values(
    kind: NonNullable<DaemonMessage['payload']['case']>,
  ): Array<NonNullable<DaemonMessage['payload']['value']>> {
    const values: Array<NonNullable<DaemonMessage['payload']['value']>> = [];
    for (const message of this.messages) {
      if (
        message.payload.case !== 'heartbeat' &&
        message.payload.case === kind &&
        message.payload.value !== undefined
      ) {
        values.push(message.payload.value);
      }
    }
    return values;
  }

  bashResults() {
    return this.messages.flatMap((message) => {
      if (
        message.payload.case !== 'operationResult' ||
        message.payload.value.outcome.case !== 'bash'
      )
        return [];
      return [{ status: message.payload.value.status, ...message.payload.value.outcome.value }];
    });
  }

  private handleHello(
    hello: Extract<DaemonMessage['payload'], { case: 'deviceHello' }>['value'],
  ): void {
    const pairing = hello.authentication.case === 'pairingCredential';
    const valid =
      hello.envId === this.envId &&
      (pairing
        ? !this.paired && hello.authentication.value === this.pairingCredential
        : hello.authentication.case === 'deviceCredential' &&
          hello.deviceId === this.deviceId &&
          hello.deviceBindingId === this.deviceBindingId &&
          hello.authentication.value === this.deviceCredential);
    if (!valid) {
      this.send({
        payload: {
          case: 'error',
          value: {
            code: DeviceErrorCode.UNAUTHENTICATED,
            message: 'Authentication failed.',
            action: 3,
          },
        },
      });
      this.socket?.close(1008, 'Authentication failed');
      return;
    }
    this.paired = true;
    this.send({
      payload: {
        case: 'serverHello',
        value: {
          controlOnly: this.controlHelloOverride ?? hello.controlOnly,
          deviceId: this.deviceId,
          instanceId: hello.instanceId,
          protocolMajor: 1,
          capabilities:
            (this.controlHelloOverride ?? hello.controlOnly)
              ? []
              : [DeviceCapability.BASH, DeviceCapability.DIRECTORY_CHECK],
          serverTime: { seconds: 1n, nanos: 0 },
          envId: this.envId,
          deviceBindingId: this.deviceBindingId,
          platformPodUid: this.platformPodOverride?.uid ?? hello.platformPodUid,
          platformPodName: this.platformPodOverride?.name ?? hello.platformPodName,
          ...(pairing ? { deviceCredential: this.deviceCredential } : {}),
        },
      },
    });
    if (this.autoDirectoryCheck && !hello.controlOnly) this.sendDirectoryCheck(hello.instanceId);
  }

  private sendDirectoryCheck(instanceId: string): void {
    this.operationSequence += 1;
    this.send({
      payload: {
        case: 'operationStart',
        value: {
          operationId: `directory-${this.operationSequence}`,
          requestId: `directory-request-${this.operationSequence}`,
          target: {
            envId: this.envId,
            deviceBindingId: this.deviceBindingId,
            instanceId,
          },
          expiresAt: {
            seconds: BigInt(Math.floor((Date.now() + 60_000) / 1000)),
            nanos: 0,
          },
          action: {
            case: 'directoryCheck',
            value: { path: this.directoryPath, loadWorkspace: false },
          },
        },
      },
    });
  }
}

function bashOperation(input: {
  operationId: string;
  requestId: string;
  runId?: string;
  deviceId?: string;
  instanceId: string;
  command: string;
  cwd: string;
  expiresAt: { seconds: bigint; nanos: number };
  timeoutSeconds: number;
}): Extract<ServerMessageInit['payload'], { case: 'operationStart' }>['value'] {
  return {
    operationId: input.operationId,
    requestId: input.requestId,
    expiresAt: input.expiresAt,
    target: {
      envId: 'env-test',
      deviceBindingId: 'binding-test',
      instanceId: input.instanceId,
      bindingVersion: 1n,
    },
    action: {
      case: 'bash',
      value: { command: input.command, cwd: input.cwd, timeoutSeconds: input.timeoutSeconds },
    },
  };
}

function identityDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-daemon-client-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function clientFor(
  server: ProtocolServer,
  directory: string,
  options: {
    pairingCredential?: string;
    maxPendingOutputBytes?: number;
    maxMessageBytes?: number;
    maxQueueBytes?: number;
    onFatalError?: (error: Error) => void;
    platformPod?: { uid: string; name: string };
  } = {},
): DaemonClient {
  const client = new DaemonClient({
    identityStore: new DaemonIdentityStore(join(directory, 'identity.json')),
    pairingCredential: options.pairingCredential ?? 'ke2_test_pairing',
    serverUrl: server.url,
    envId: server.envId,
    daemonVersion: 'test-daemon',
    deviceName: 'Test macOS device',
    bashEnabled: true,
    heartbeatIntervalMilliseconds: 20,
    reconnectDelayMilliseconds: 10,
    ...(options.maxPendingOutputBytes === undefined
      ? {}
      : { maxPendingOutputBytes: options.maxPendingOutputBytes }),
    ...(options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes }),
    ...(options.maxQueueBytes === undefined ? {} : { maxQueueBytes: options.maxQueueBytes }),
    maxOutputChunkBytes: 1024,
    onError: () => undefined,
    ...(options.platformPod ? { platformPod: options.platformPod } : {}),
    ...(options.onFatalError === undefined ? {} : { onFatalError: options.onFatalError }),
  });
  cleanup.push(() => client.close());
  return client;
}

afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

describe('DaemonClient identity and reconnection', () => {
  it('keeps one platform process identity across pairing/reconnect and rejects a wrong Pod echo before saving identity', async () => {
    const pod = { uid: '11111111-1111-1111-1111-111111111111', name: 'platform-pod' };
    const server = await ProtocolServer.listen();
    const directory = identityDirectory();
    const client = clientFor(server, directory, { platformPod: pod });
    client.start();
    await client.waitForConnection();
    const instance = client.instanceId;
    expect(server.values('deviceHello')[0]).toMatchObject({
      platformPodUid: pod.uid,
      platformPodName: pod.name,
    });
    server.disconnect();
    await waitFor(() => (!client.connected ? true : undefined));
    await client.waitForConnection();
    expect(client.instanceId).toBe(instance);
    expect(server.values('deviceHello').at(-1)?.authentication.case).toBe('deviceCredential');
    const rejecting = await ProtocolServer.listen();
    rejecting.platformPodOverride = { ...pod, uid: '22222222-2222-2222-2222-222222222222' };
    const invalidDirectory = identityDirectory();
    const invalid = clientFor(rejecting, invalidDirectory, { platformPod: pod });
    invalid.start();
    await expect(invalid.waitForConnection()).rejects.toThrow('handshake was rejected');
    expect(existsSync(join(invalidDirectory, 'identity.json'))).toBe(false);
  });
  it('persists the exchanged identity and reuses instance ID only within the process', async () => {
    const server = await ProtocolServer.listen();
    const directory = identityDirectory();
    const client = clientFor(server, directory);
    client.start();
    await client.waitForConnection();
    const instanceId = client.instanceId;
    const identity = new DaemonIdentityStore(join(directory, 'identity.json')).load();
    expect(identity).toMatchObject({
      version: 2,
      envId: server.envId,
      deviceId: server.deviceId,
      deviceBindingId: server.deviceBindingId,
      deviceCredential: server.deviceCredential,
      daemonVersion: 'test-daemon',
      grantedCapabilities: ['bash', 'directory_check'],
    });
    const originalFile = readFileSync(join(directory, 'identity.json'), 'utf8');

    server.disconnect();
    await waitFor(() => (!client.connected ? true : undefined));
    await client.waitForConnection();
    expect(client.instanceId).toBe(instanceId);
    expect(server.values('deviceHello')).toHaveLength(2);
    expect(readFileSync(join(directory, 'identity.json'), 'utf8')).toBe(originalFile);

    const restarted = clientFor(server, directory);
    restarted.start();
    await restarted.waitForConnection();
    expect(restarted.instanceId).not.toBe(instanceId);
    expect(server.values('deviceHello')).toHaveLength(3);
  });

  it('waits for the old WSS close before a background client authenticates', async () => {
    const server = await ProtocolServer.listen();
    const directory = identityDirectory();
    const pairing = clientFor(server, directory);
    pairing.start();
    await pairing.waitForConnection();
    const closing = pairing.close();
    expect(pairing.close()).toBe(closing);
    await closing;
    await waitFor(() => (server.closed ? true : undefined));
    expect(pairing.connected).toBe(false);

    const background = clientFor(server, directory);
    background.start();
    await background.waitForConnection();
    expect(server.values('deviceHello')).toHaveLength(2);
    await background.close();
    await waitFor(() => (server.closed ? true : undefined));
  });

  it('waits for the persisted directory result acknowledgement before reporting readiness', async () => {
    const server = await ProtocolServer.listen();
    const directory = identityDirectory();
    server.autoDirectoryCheck = true;
    server.directoryPath = directory;
    const client = clientFor(server, directory);
    const readiness = client.waitForReadiness();
    client.start();
    await expect(readiness).resolves.toBe(
      await (await import('node:fs/promises')).realpath(directory),
    );
    const result = server.messages.find((message) => message.payload.case === 'operationResult');
    expect(result?.payload).toMatchObject({
      case: 'operationResult',
      value: {
        status: 5,
        outcome: {
          case: 'directoryCheck',
          value: { capabilities: [1, 5] },
        },
      },
    });
  });

  it('keeps a bound identity but rejects readiness when directory validation fails', async () => {
    const server = await ProtocolServer.listen();
    const directory = identityDirectory();
    server.autoDirectoryCheck = true;
    server.directoryPath = join(directory, 'missing');
    const client = clientFor(server, directory);
    const readiness = client.waitForReadiness();
    client.start();
    await expect(readiness).rejects.toThrow('directory readiness failed');
    expect(new DaemonIdentityStore(join(directory, 'identity.json')).load()).toMatchObject({
      envId: server.envId,
      deviceBindingId: server.deviceBindingId,
    });
  });

  it('does not repeatedly reconnect after fatal authentication rejection', async () => {
    const server = await ProtocolServer.listen('ke2_correct');
    const fatal: Error[] = [];
    const client = clientFor(server, identityDirectory(), {
      pairingCredential: 'ke2_wrong',
      onFatalError: (error) => fatal.push(error),
    });
    client.start();
    await expect(client.waitForConnection()).rejects.toThrow('authentication');
    await waitFor(() => (fatal.length === 1 ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.values('deviceHello')).toHaveLength(1);
  });

  it('does not execute a queued BashStart after a fatal protocol error', async () => {
    const server = await ProtocolServer.listen();
    const directory = identityDirectory();
    const fatal: Error[] = [];
    const client = clientFor(server, directory, { onFatalError: (error) => fatal.push(error) });
    client.start();
    await client.waitForConnection();
    const businessFile = join(directory, 'must-not-exist.txt');

    server.send({
      payload: {
        case: 'serverHello',
        value: {
          deviceId: server.deviceId,
          instanceId: client.instanceId,
          protocolMajor: 1,
          capabilities: [DeviceCapability.BASH],
          serverTime: { seconds: 1n, nanos: 0 },
        },
      },
    });
    server.send({
      payload: {
        case: 'operationStart',
        value: bashOperation({
          operationId: 'operation-after-fatal',
          runId: 'run-1',
          deviceId: server.deviceId,
          command: `printf executed > ${JSON.stringify(businessFile)}`,
          cwd: directory,
          expiresAt: { seconds: BigInt(Math.floor((Date.now() + 60_000) / 1000)), nanos: 0 },
          timeoutSeconds: 20,
          instanceId: client.instanceId,
          requestId: 'request-after-fatal',
        }),
      },
    });
    await waitFor(() => (fatal.length === 1 ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(existsSync(businessFile)).toBe(false);
    expect(server.values('operationAccepted')).toHaveLength(0);
  });

  it('does not execute BashStart after the incoming queue limit rejects the peer', async () => {
    const server = await ProtocolServer.listen();
    const directory = identityDirectory();
    const client = clientFor(server, directory, { maxMessageBytes: 4096, maxQueueBytes: 512 });
    client.start();
    await client.waitForConnection();
    const businessFile = join(directory, 'queue-limit-must-not-exist.txt');

    server.sendRaw(new Uint8Array(600));
    server.send({
      payload: {
        case: 'operationStart',
        value: bashOperation({
          operationId: 'operation-after-queue-limit',
          runId: 'run-1',
          deviceId: server.deviceId,
          command: `printf executed > ${JSON.stringify(businessFile)}`,
          cwd: directory,
          expiresAt: { seconds: BigInt(Math.floor((Date.now() + 60_000) / 1000)), nanos: 0 },
          timeoutSeconds: 20,
          instanceId: client.instanceId,
          requestId: 'request-after-queue-limit',
        }),
      },
    });
    await waitFor(() => server.values('error').length === 1 || undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(existsSync(businessFile)).toBe(false);
    expect(server.values('operationAccepted')).toHaveLength(0);
  });
});

describe('DaemonClient Bash transport', () => {
  it('executes real commands, returns output, and deduplicates a repeated start', async () => {
    const server = await ProtocolServer.listen();
    const directory = identityDirectory();
    const client = clientFor(server, directory);
    client.start();
    await client.waitForConnection();
    const businessFile = join(directory, 'business.txt');
    const start = {
      operationId: 'operation-1',
      runId: 'run-1',
      deviceId: server.deviceId,
      command: `printf executed >> ${JSON.stringify(businessFile)}; printf output`,
      cwd: directory,
      expiresAt: { seconds: BigInt(Math.floor((Date.now() + 60_000) / 1000)), nanos: 0 },
      timeoutSeconds: 20,
      instanceId: client.instanceId,
      requestId: 'request-1',
    };
    server.send({ payload: { case: 'operationStart', value: bashOperation(start) } });
    await waitFor(() => server.bashResults().length === 1 || undefined);
    expect(server.bashResults()[0]).toMatchObject({
      status: OperationStatus.COMPLETED,
      exitCode: 0,
      outputComplete: true,
      endOffset: 6n,
    });
    expect(readFileSync(businessFile, 'utf8')).toBe('executed');
    server.send({
      payload: {
        case: 'operationStart',
        value: bashOperation({ ...start, requestId: 'request-2' }),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(readFileSync(businessFile, 'utf8')).toBe('executed');
    expect(readdirSync(directory).sort()).toEqual(['business.txt', 'identity.json']);
    expect(server.values('error')[0]).toMatchObject({ code: DeviceErrorCode.OPERATION_EXPIRED });
    server.messages.length = 0;

    server.send({
      payload: {
        case: 'operationStart',
        value: bashOperation({ ...start, command: 'printf conflict' }),
      },
    });
    await waitFor(() => server.values('error').length > 0 || undefined);
    expect(server.values('error')[0]).toMatchObject({ code: DeviceErrorCode.OPERATION_CONFLICT });
  });

  it('resends unacknowledged data on the same instance without executing again', async () => {
    const server = await ProtocolServer.listen();
    server.autoAcknowledge = false;
    const directory = identityDirectory();
    const client = clientFor(server, directory);
    client.start();
    await client.waitForConnection();
    const businessFile = join(directory, 'once.txt');
    server.send({
      payload: {
        case: 'operationStart',
        value: bashOperation({
          operationId: 'operation-reconnect',
          runId: 'run-1',
          deviceId: server.deviceId,
          command: `printf once >> ${JSON.stringify(businessFile)}; printf resend`,
          cwd: directory,
          expiresAt: { seconds: BigInt(Math.floor((Date.now() + 60_000) / 1000)), nanos: 0 },
          timeoutSeconds: 20,
          instanceId: client.instanceId,
          requestId: 'request-1',
        }),
      },
    });
    await waitFor(() => server.bashResults().length === 1 || undefined);
    expect(server.values('operationOutputChunk')).toHaveLength(1);
    server.disconnect();
    await waitFor(() => (!client.connected ? true : undefined));
    await client.waitForConnection();
    await waitFor(() => server.bashResults().length >= 2 || undefined);
    expect(server.values('operationOutputChunk')).toHaveLength(2);
    expect(readFileSync(businessFile, 'utf8')).toBe('once');
  });

  it('pauses at the configured memory limit while Server acknowledgements are delayed', async () => {
    const server = await ProtocolServer.listen();
    server.autoAcknowledge = false;
    const client = clientFor(server, identityDirectory(), { maxPendingOutputBytes: 4096 });
    client.start();
    await client.waitForConnection();
    server.send({
      payload: {
        case: 'operationStart',
        value: bashOperation({
          operationId: 'operation-backpressure',
          runId: 'run-1',
          deviceId: server.deviceId,
          command: "for i in $(seq 1 1024); do printf '%01024d' 0; done",
          cwd: '/tmp',
          expiresAt: { seconds: BigInt(Math.floor((Date.now() + 60_000) / 1000)), nanos: 0 },
          timeoutSeconds: 20,
          instanceId: client.instanceId,
          requestId: 'request-1',
        }),
      },
    });
    await waitFor(() => (client.isOutputPaused('operation-backpressure') ? true : undefined));
    expect(client.bufferedOutputBytes('operation-backpressure')).toBe(4096);
    server.autoAcknowledge = true;
    for (const chunk of server.values('operationOutputChunk')) {
      server.send({
        payload: {
          case: 'operationOutputAck',
          value: {
            operationId: chunk.operationId,
            target: chunk.target,
            nextOffset: chunk.offset + BigInt(chunk.data.length),
          },
        },
      });
    }
    await waitFor(() => server.bashResults().length === 1 || undefined);
    expect(server.bashResults()[0]?.endOffset).toBe(1_048_576n);
    await waitFor(() =>
      client.bufferedOutputBytes('operation-backpressure') === 0 ? true : undefined,
    );
  });

  it('reports cancel requested separately from actual cancellation', async () => {
    const server = await ProtocolServer.listen();
    const client = clientFor(server, identityDirectory());
    client.start();
    await client.waitForConnection();
    server.send({
      payload: {
        case: 'operationStart',
        value: bashOperation({
          operationId: 'operation-cancel',
          runId: 'run-1',
          deviceId: server.deviceId,
          command: 'sleep 30',
          cwd: '/tmp',
          expiresAt: { seconds: BigInt(Math.floor((Date.now() + 60_000) / 1000)), nanos: 0 },
          timeoutSeconds: 20,
          instanceId: client.instanceId,
          requestId: 'request-1',
        }),
      },
    });
    await waitFor(() => server.values('operationAccepted').length === 1 || undefined);
    server.send({
      payload: {
        case: 'operationCancel',
        value: {
          operationId: 'operation-cancel',
          target: {
            envId: 'env-test',
            deviceBindingId: 'binding-test',
            instanceId: client.instanceId,
            bindingVersion: 1n,
          },
          requestId: 'cancel-1',
          reason: 'test cancellation',
        },
      },
    });
    await waitFor(() => server.bashResults().length === 1 || undefined);
    expect(
      server
        .values('operationState')
        .some((state) => state.status === OperationStatus.CANCEL_REQUESTED),
    ).toBe(true);
    expect(server.bashResults()[0]).toMatchObject({ status: OperationStatus.CANCELLED });
    expect(server.bashResults()[0]?.exitCode).toBeUndefined();
  });
});

function pairedMaintenanceClient(server: ProtocolServer, controlOnly = true) {
  const directory = identityDirectory();
  const file = join(directory, 'identity.json');
  const store = new DaemonIdentityStore(file);
  store.save({
    version: 2,
    envId: server.envId,
    deviceId: server.deviceId,
    deviceBindingId: server.deviceBindingId,
    deviceCredential: server.deviceCredential,
    serverUrl: server.url,
    deviceName: 'Existing device',
    grantedCapabilities: ['bash', 'directory_check'],
    daemonVersion: 'installed-version',
  });
  const before = readFileSync(file, 'utf8');
  const client = new DaemonClient({
    identityStore: store,
    controlOnly,
    daemonVersion: 'candidate-version',
    heartbeatIntervalMilliseconds: 20,
    reconnectDelayMilliseconds: 10,
  });
  cleanup.push(() => client.close());
  return { client, file, before, directory };
}

describe('control-only Daemon client', () => {
  it('authenticates without directory readiness or changing the stored device profile', async () => {
    const server = await ProtocolServer.listen();
    server.autoDirectoryCheck = true;
    const { client, file, before } = pairedMaintenanceClient(server);
    client.start();
    await client.waitForConnection();
    expect(server.values('deviceHello')[0]).toMatchObject({ controlOnly: true, capabilities: [] });
    const drain = client.waitForDrain(7n, 2000);
    const query = await waitFor(() =>
      server.messages.find((message) => message.payload.case === 'environmentMaintenanceQuery'),
    );
    if (query.payload.case !== 'environmentMaintenanceQuery')
      throw Error('Unexpected maintenance message.');
    server.send({
      payload: {
        case: 'environmentMaintenanceReport',
        value: {
          requestId: query.payload.value.requestId,
          envId: server.envId,
          deviceBindingId: server.deviceBindingId,
          maintenanceMode: 2,
          maintenanceVersion: 7n,
          activeOperationCount: 0n,
        },
      },
    });
    await expect(drain).resolves.toBe(7n);
    expect(server.values('operationAccepted')).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    await expect(client.waitForReadiness()).rejects.toThrow('Control-only');
  });

  it.each([false, true])(
    'rejects a ServerHello with a different control_only value when requested=%s',
    async (controlOnly) => {
      const server = await ProtocolServer.listen();
      server.controlHelloOverride = !controlOnly;
      const { client, file, before } = pairedMaintenanceClient(server, controlOnly);
      const rejection = expect(client.waitForConnection(2000)).rejects.toThrow('handshake');
      client.start();
      await rejection;
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(server.values('operationAccepted')).toEqual([]);
    },
  );

  it('rejects execution messages before a control connection can write a file', async () => {
    const server = await ProtocolServer.listen();
    const { client, directory, file, before } = pairedMaintenanceClient(server);
    client.start();
    await client.waitForConnection();
    const target = join(directory, 'must-not-exist.txt');
    server.send({
      payload: {
        case: 'operationStart',
        value: {
          operationId: 'control-write',
          requestId: 'control-write',
          target: {
            envId: server.envId,
            deviceBindingId: server.deviceBindingId,
            instanceId: client.instanceId,
            bindingVersion: 1n,
          },
          expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 60) },
          action: {
            case: 'write',
            value: { path: target, cwd: directory, content: 'unauthorized', overwrite: false },
          },
        },
      },
    });
    await waitFor(() => (server.closed ? true : undefined));
    expect(existsSync(target)).toBe(false);
    expect(server.values('operationAccepted')).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('fails a disconnected revoke without replaying the request after reconnection', async () => {
    const server = await ProtocolServer.listen();
    const { client } = pairedMaintenanceClient(server);
    client.start();
    await client.waitForConnection();
    const revoke = client.revokeEnvironment(2000);
    const rejected = expect(revoke).rejects.toThrow('interrupted');
    await waitFor(() =>
      server.messages.some((message) => message.payload.case === 'environmentRevoke')
        ? true
        : undefined,
    );
    server.disconnect();
    await rejected;
    await waitFor(() => (server.values('deviceHello').length === 2 ? true : undefined));
    expect(
      server.messages.filter((message) => message.payload.case === 'environmentRevoke'),
    ).toHaveLength(1);
  });

  it('requires an existing paired identity for control connections', async () => {
    const server = await ProtocolServer.listen();
    expect(
      () =>
        new DaemonClient({
          identityStore: new DaemonIdentityStore(join(identityDirectory(), 'identity.json')),
          serverUrl: server.url,
          envId: server.envId,
          deviceName: 'Unpaired control',
          pairingCredential: 'test-pairing-credential',
          controlOnly: true,
        }),
    ).toThrow('existing paired identity');
  });
});

it('processes a queued control revocation acknowledgement before the close frame', async () => {
  const server = await ProtocolServer.listen();
  const { client, file, before } = pairedMaintenanceClient(server);
  client.start();
  await client.waitForConnection();
  const revoked = client.revokeEnvironment(2000);
  const request = await waitFor(() =>
    server.messages.find((message) => message.payload.case === 'environmentRevoke'),
  );
  if (request.payload.case !== 'environmentRevoke') throw Error('Missing revoke request.');
  server.send({
    payload: {
      case: 'environmentRevokeAck',
      value: {
        requestId: request.payload.value.requestId,
        envId: server.envId,
        deviceBindingId: server.deviceBindingId,
        revokedAt: { seconds: 1n },
      },
    },
  });
  for (const socket of server.server.clients) socket.close(1000, 'Revoked.');
  await expect(revoked).resolves.toBeUndefined();
  expect(readFileSync(file, 'utf8')).toBe(before);
});
