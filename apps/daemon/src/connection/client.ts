import { randomUUID } from 'node:crypto';
import { arch, homedir, platform } from 'node:os';
import {
  ContractValidationError,
  DEVICE_PROTOCOL_MAJOR,
  DeviceCapability,
  DeviceErrorAction,
  DeviceErrorCode,
  decodeServerMessage,
  EnvironmentMaintenanceMode,
  encodeDaemonMessage,
  isDeviceCapability,
  isDeviceErrorAction,
  isDeviceErrorCode,
  OperationStatus,
} from '@kairos/contracts/device';
import type { RawData } from 'ws';
import WebSocket from 'ws';
import { BashOperationFailure } from '../bash/manager.js';
import type { DaemonCapability, DaemonIdentity, DaemonIdentityStore } from '../identity.js';
import { validateServerUrl } from '../identity.js';
import { McpSessionHost } from '../mcp/host.js';
import type { EnvironmentOperationResult } from '../operations/manager.js';
import { EnvironmentOperationManager } from '../operations/manager.js';
import type { DaemonStatus } from '../status.js';

interface ConnectionWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface ControlWaiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

type MaintenanceReport = Extract<
  ReturnType<typeof decodeServerMessage>['payload'],
  { case: 'environmentMaintenanceReport' }
>['value'];
type RevokeAck = Extract<
  ReturnType<typeof decodeServerMessage>['payload'],
  { case: 'environmentRevokeAck' }
>['value'];

class DaemonPeer {
  authenticated = false;
  rejected = false;
  incoming: Promise<void> = Promise.resolve();
  incomingBytes = 0;
  private queue: Promise<void> = Promise.resolve();
  private queuedBytes = 0;

  constructor(
    readonly socket: WebSocket,
    private readonly maxMessageBytes: number,
    private readonly maxQueueBytes: number,
  ) {}

  send(data: Uint8Array): Promise<void> {
    if (data.length > this.maxMessageBytes) {
      return Promise.reject(new Error('Daemon message exceeds the configured limit.'));
    }
    if (this.queuedBytes + this.socket.bufferedAmount + data.length > this.maxQueueBytes) {
      return Promise.reject(new Error('Daemon send queue exceeds the configured limit.'));
    }
    this.queuedBytes += data.length;
    const sending = this.queue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.socket.readyState !== WebSocket.OPEN) {
            reject(new Error('Server WebSocket is not open.'));
            return;
          }
          this.socket.send(data, { binary: true }, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    );
    this.queue = sending.catch(() => undefined);
    return sending.finally(() => {
      this.queuedBytes -= data.length;
    });
  }
}

export interface DaemonClientOptions {
  identityStore: DaemonIdentityStore;
  controlOnly?: boolean;
  pairingCredential?: string;
  serverUrl?: string;
  envId?: string;
  deviceName?: string;
  initialDirectory?: string;
  daemonVersion?: string;
  os?: string;
  architecture?: string;
  ca?: string | Buffer;
  bashEnabled?: boolean;
  heartbeatIntervalMilliseconds?: number;
  reconnectDelayMilliseconds?: number;
  maxMessageBytes?: number;
  maxQueueBytes?: number;
  maxPendingOutputBytes?: number;
  maxOutputChunkBytes?: number;
  resourceHomeDirectory?: string;
  status?: Pick<DaemonStatus, 'connection' | 'operation'>;
  onError?: (error: unknown) => void;
  onFatalError?: (error: Error) => void;
  platformPod?: { uid: string; name: string };
}

export class DaemonReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonReadinessError';
  }
}

export class DaemonClient {
  readonly instanceId = randomUUID();
  private readonly controlOnly: boolean;
  private identity: DaemonIdentity | undefined;
  private readonly serverUrl: string;
  private readonly envId: string;
  private readonly daemonVersion: string;
  private readonly os: string;
  private readonly architecture: string;
  private pairingCredential: string | undefined;
  private readonly deviceName: string | undefined;
  private readonly initialDirectory: string;
  private readonly initialBashEnabled: boolean;
  private grantedCapabilities: DaemonCapability[] = [];
  private operationCapabilities: DeviceCapability[] = [];
  private readonly environmentOperations: EnvironmentOperationManager;
  private readonly mcpHost: McpSessionHost;
  private readonly heartbeatIntervalMilliseconds: number;
  private readonly reconnectDelayMilliseconds: number;
  private readonly maxMessageBytes: number;
  private readonly maxQueueBytes: number;
  private peer: DaemonPeer | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private reconnect: NodeJS.Timeout | undefined;
  private heartbeatSequence = 0n;
  private reconnectAttempts = 0;
  private started = false;
  private stopped = false;
  private fatal = false;
  private closePromise: Promise<void> | undefined;
  private readinessPath: string | undefined;
  private readonly connectionWaiters = new Set<ConnectionWaiter>();
  private readonly readinessWaiters = new Set<ControlWaiter<string>>();
  private readonly maintenanceWaiters = new Map<string, ControlWaiter<MaintenanceReport>>();
  private readonly revokeWaiters = new Map<string, ControlWaiter<RevokeAck>>();

  constructor(private readonly options: DaemonClientOptions) {
    this.controlOnly = options.controlOnly ?? false;
    this.identity = options.identityStore.load();
    if (
      this.controlOnly &&
      (this.identity === undefined || options.pairingCredential !== undefined)
    ) {
      throw new Error('Control-only connections require an existing paired identity.');
    }
    const serverUrl = this.identity?.serverUrl ?? options.serverUrl;
    if (serverUrl === undefined) throw new Error('Daemon Server URL is required for pairing.');
    this.serverUrl = validateServerUrl(serverUrl);
    const envId = this.identity?.envId ?? options.envId;
    if (!envId) throw new Error('Environment ID is required for pairing.');
    this.envId = envId;
    this.daemonVersion = options.daemonVersion ?? this.identity?.daemonVersion ?? 'development';
    if (!this.daemonVersion) throw new Error('Daemon version is required.');
    this.os = options.os ?? platform();
    this.architecture = options.architecture ?? architectureName();
    this.deviceName = this.identity?.deviceName ?? options.deviceName;
    this.initialDirectory = options.initialDirectory ?? homedir();
    this.initialBashEnabled =
      options.bashEnabled ?? this.identity?.grantedCapabilities.includes('bash') ?? false;
    if (this.identity === undefined) {
      if (!options.pairingCredential || !this.deviceName) {
        throw new Error('Pairing credential and device name are required for an unpaired Daemon.');
      }
      this.pairingCredential = options.pairingCredential;
    }
    this.heartbeatIntervalMilliseconds = options.heartbeatIntervalMilliseconds ?? 10_000;
    this.reconnectDelayMilliseconds = options.reconnectDelayMilliseconds ?? 500;
    this.maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
    this.maxQueueBytes = options.maxQueueBytes ?? 2 * 1024 * 1024;
    for (const value of [
      this.heartbeatIntervalMilliseconds,
      this.reconnectDelayMilliseconds,
      this.maxMessageBytes,
      this.maxQueueBytes,
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('Daemon connection limits must be positive safe integers.');
      }
    }
    this.mcpHost = new McpSessionHost({
      send: (message) => this.sendOperationMessage(message),
      onError: (error) => this.options.onError?.(error),
    });
    this.environmentOperations = new EnvironmentOperationManager({
      envId: () => this.envId,
      deviceBindingId: () => this.identity?.deviceBindingId ?? '',
      instanceId: this.instanceId,
      capabilities: () => this.operationCapabilities,
      send: (message) => this.sendOperationMessage(message),
      onTransportError: (error) => this.transportFailure(error),
      onOperationError: (error) => {
        const peer = this.peer;
        if (peer !== undefined && error instanceof BashOperationFailure) {
          void this.sendFailure(peer, error);
        } else {
          this.options.onError?.(error);
        }
      },
      onLifecycleEvent: (event) => options.status?.operation(event, event.error),
      onResultAcknowledged: (result) => this.completeReadiness(result),
      ...(options.maxPendingOutputBytes === undefined
        ? {}
        : { maxPendingBytes: options.maxPendingOutputBytes }),
      ...(options.maxOutputChunkBytes === undefined
        ? {}
        : { maxChunkBytes: options.maxOutputChunkBytes }),
      ...(options.resourceHomeDirectory === undefined
        ? {}
        : { resourceHomeDirectory: options.resourceHomeDirectory }),
    });
  }

  get connected(): boolean {
    return this.peer?.authenticated === true;
  }

  get deviceId(): string | undefined {
    return this.identity?.deviceId;
  }

  bufferedOutputBytes(operationId: string): number {
    return this.environmentOperations.bufferedBytes(operationId) ?? 0;
  }

  isOutputPaused(operationId: string): boolean {
    return this.environmentOperations.isPaused(operationId) ?? false;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.stopped = true;
    if (this.reconnect !== undefined) clearTimeout(this.reconnect);
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.environmentOperations.close();
    void this.mcpHost.closeAll().catch(() => undefined);
    if (!this.fatal) this.options.status?.connection('stopped');
    const peer = this.peer;
    if (peer !== undefined) {
      peer.rejected = true;
      peer.authenticated = false;
    }
    this.closePromise = new Promise<void>((resolve) => {
      if (peer === undefined || peer.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      peer.socket.once('close', resolve);
      try {
        peer.socket.close(1000, 'Daemon shutting down');
      } catch {
        peer.socket.terminate();
      }
    });
    const error = new Error('Daemon client closed.');
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.connectionWaiters.clear();
    for (const waiter of this.readinessWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.readinessWaiters.clear();
    this.rejectControlWaiters(error);
    return this.closePromise;
  }

  waitForConnection(timeoutMilliseconds = 5000): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.fatal) return Promise.reject(new Error('Daemon authentication is no longer usable.'));
    return new Promise<void>((resolve, reject) => {
      const waiter: ConnectionWaiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.connectionWaiters.delete(waiter);
          reject(new Error('Timed out waiting for the Daemon connection.'));
        }, timeoutMilliseconds),
      };
      this.connectionWaiters.add(waiter);
    });
  }

  waitForReadiness(timeoutMilliseconds = 30_000): Promise<string> {
    if (this.controlOnly) {
      return Promise.reject(
        new DaemonReadinessError('Control-only connections do not execute directory checks.'),
      );
    }
    if (this.fatal) {
      return Promise.reject(new Error('Daemon authentication is no longer usable.'));
    }
    if (this.connected && !this.grantedCapabilities.includes('directory_check')) {
      return Promise.reject(
        new DaemonReadinessError(
          'The environment is bound but directory capability is unavailable.',
        ),
      );
    }
    if (this.connected && this.readinessPath !== undefined) {
      return Promise.resolve(this.readinessPath);
    }
    return new Promise<string>((resolve, reject) => {
      const waiter: ControlWaiter<string> = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.readinessWaiters.delete(waiter);
          reject(
            new DaemonReadinessError(
              'Timed out waiting for persisted directory and capability readiness.',
            ),
          );
        }, timeoutMilliseconds),
      };
      this.readinessWaiters.add(waiter);
    });
  }

  async waitForDrain(expectedVersion?: bigint, timeoutMilliseconds = 10_000): Promise<bigint> {
    if (expectedVersion !== undefined && expectedVersion < 0n) {
      throw new Error('Expected maintenance version must be a uint64 value.');
    }
    const identity = this.identity;
    if (identity === undefined) throw new Error('A paired environment identity is required.');
    await this.waitForConnection(timeoutMilliseconds);
    const peer = this.peer;
    if (peer?.authenticated !== true) throw new Error('Environment is not connected.');
    const requestId = randomUUID();
    const reportPromise = new Promise<MaintenanceReport>((resolve, reject) => {
      const waiter: ControlWaiter<MaintenanceReport> = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.maintenanceWaiters.delete(requestId);
          reject(new Error('Timed out waiting for the environment maintenance report.'));
        }, timeoutMilliseconds),
      };
      this.maintenanceWaiters.set(requestId, waiter);
    });
    try {
      await peer.send(
        encodeDaemonMessage({
          payload: {
            case: 'environmentMaintenanceQuery',
            value: {
              requestId,
              envId: identity.envId,
              deviceBindingId: identity.deviceBindingId,
            },
          },
        }),
      );
    } catch (error) {
      const waiter = this.maintenanceWaiters.get(requestId);
      this.maintenanceWaiters.delete(requestId);
      if (waiter !== undefined) {
        clearTimeout(waiter.timeout);
        waiter.reject(error instanceof Error ? error : new Error('Maintenance query failed.'));
      }
    }
    const report = await reportPromise;
    if (report.maintenanceMode !== EnvironmentMaintenanceMode.DRAINING) {
      throw new Error('Environment is not draining; enter maintenance mode in the GUI first.');
    }
    if (report.activeOperationCount !== 0n) {
      throw new Error(
        `Environment still has ${report.activeOperationCount} active operations; upgrade is deferred.`,
      );
    }
    if (expectedVersion !== undefined && report.maintenanceVersion !== expectedVersion) {
      throw new Error('Environment maintenance version changed; upgrade is deferred.');
    }
    return report.maintenanceVersion;
  }

  async revokeEnvironment(timeoutMilliseconds = 10_000): Promise<void> {
    const identity = this.identity;
    if (identity === undefined) throw new Error('A paired environment identity is required.');
    await this.waitForConnection(timeoutMilliseconds);
    const peer = this.peer;
    if (peer?.authenticated !== true) throw new Error('Environment is not connected.');
    const requestId = randomUUID();
    const acknowledgement = new Promise<RevokeAck>((resolve, reject) => {
      const waiter: ControlWaiter<RevokeAck> = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.revokeWaiters.delete(requestId);
          reject(new Error('Timed out waiting for persisted environment revocation.'));
        }, timeoutMilliseconds),
      };
      this.revokeWaiters.set(requestId, waiter);
    });
    try {
      await peer.send(
        encodeDaemonMessage({
          payload: {
            case: 'environmentRevoke',
            value: {
              requestId,
              envId: identity.envId,
              deviceBindingId: identity.deviceBindingId,
              reason: 'Local uninstall requested environment revocation.',
            },
          },
        }),
      );
    } catch (error) {
      const waiter = this.revokeWaiters.get(requestId);
      this.revokeWaiters.delete(requestId);
      if (waiter !== undefined) {
        clearTimeout(waiter.timeout);
        waiter.reject(error instanceof Error ? error : new Error('Revocation failed.'));
      }
    }
    await acknowledgement;
  }

  private connect(): void {
    if (this.stopped || this.fatal) return;
    this.options.status?.connection(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    const socket = new WebSocket(this.serverUrl, {
      maxPayload: this.maxMessageBytes + 1024,
      handshakeTimeout: 5000,
      ...(this.options.ca === undefined ? {} : { ca: this.options.ca }),
    });
    socket.binaryType = 'nodebuffer';
    const peer = new DaemonPeer(socket, this.maxMessageBytes, this.maxQueueBytes);
    this.peer = peer;
    socket.on('message', (data: RawData, isBinary: boolean) => {
      const size = Array.isArray(data)
        ? data.reduce((total, part) => total + part.length, 0)
        : data.byteLength;
      if (peer.incomingBytes + size > this.maxQueueBytes) {
        peer.rejected = true;
        peer.authenticated = false;
        void this.handleProcessFailure(
          peer,
          new BashOperationFailure(
            DeviceErrorCode.MESSAGE_TOO_LARGE,
            'Daemon incoming queue exceeds the configured limit.',
            DeviceErrorAction.RECONNECT,
          ),
        ).finally(() => socket.close(1009, 'Incoming queue limit'));
        return;
      }
      peer.incomingBytes += size;
      peer.incoming = peer.incoming
        .then(() => this.processMessage(peer, data, isBinary))
        .catch((error: unknown) => this.handleProcessFailure(peer, error))
        .finally(() => {
          peer.incomingBytes -= size;
        });
    });
    socket.once('open', () => {
      void this.sendHello(peer).catch((error: unknown) => {
        this.options.onError?.(error);
        socket.close(1011, 'DeviceHello delivery failed');
      });
    });
    socket.on('error', (error) => {
      this.transportFailure(error);
    });
    socket.once('close', () => {
      const finish = () => {
        peer.rejected = true;
        peer.authenticated = false;
        if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
        if (this.peer === peer) this.peer = undefined;
        if (this.controlOnly)
          this.rejectControlWaiters(new Error('Control connection was interrupted.'));
        if (!this.stopped && !this.fatal) this.scheduleReconnect();
      };
      // A control acknowledgement may precede the close frame in the same socket read.
      if (this.controlOnly) void peer.incoming.then(finish, finish);
      else finish();
    });
  }

  private sendHello(peer: DaemonPeer): Promise<void> {
    const identity = this.identity;
    return peer.send(
      encodeDaemonMessage({
        payload: {
          case: 'deviceHello',
          value: {
            deviceId: identity?.deviceId ?? '',
            instanceId: this.instanceId,
            protocolMajor: DEVICE_PROTOCOL_MAJOR,
            controlOnly: this.controlOnly,
            deviceName: this.deviceName ?? '',
            homeDirectory: this.initialDirectory,
            capabilities: this.controlOnly
              ? []
              : [
                  ...(this.initialBashEnabled
                    ? [
                        DeviceCapability.BASH,
                        DeviceCapability.FILE_READ,
                        DeviceCapability.FILE_WRITE,
                        DeviceCapability.FILE_EDIT,
                      ]
                    : []),
                  DeviceCapability.DIRECTORY_CHECK,
                  DeviceCapability.DIRECTORY_LIST,
                  DeviceCapability.FILE_SEARCH,
                ],
            envId: this.envId,
            daemonVersion: this.daemonVersion,
            os: this.os,
            architecture: this.architecture,
            deviceBindingId: identity?.deviceBindingId ?? '',
            ...(this.options.platformPod
              ? {
                  platformPodUid: this.options.platformPod.uid,
                  platformPodName: this.options.platformPod.name,
                }
              : {}),
            authentication:
              identity === undefined
                ? { case: 'pairingCredential', value: this.pairingCredential ?? '' }
                : { case: 'deviceCredential', value: identity.deviceCredential },
          },
        },
      }),
    );
  }

  private async processMessage(peer: DaemonPeer, data: RawData, isBinary: boolean): Promise<void> {
    if (this.fatal || this.stopped || peer.rejected) return;
    if (!isBinary || Array.isArray(data)) {
      throw new Error('Server messages must be binary Protobuf messages.');
    }
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (bytes.length > this.maxMessageBytes) throw new Error('Server message is too large.');
    const message = decodeServerMessage(bytes);
    if (
      peer.socket.readyState !== WebSocket.OPEN &&
      message.payload.case !== 'error' &&
      !(
        this.controlOnly &&
        peer.authenticated &&
        (message.payload.case === 'environmentRevokeAck' ||
          message.payload.case === 'environmentMaintenanceReport' ||
          message.payload.case === 'heartbeatAck')
      )
    )
      return;
    if (
      !peer.authenticated &&
      message.payload.case !== 'serverHello' &&
      message.payload.case !== 'error'
    ) {
      throw new Error('ServerHello is required before other messages.');
    }
    if (peer.authenticated && message.payload.case === 'serverHello') {
      throw new Error('ServerHello is only valid once per connection.');
    }
    if (
      this.controlOnly &&
      message.payload.case !== 'serverHello' &&
      message.payload.case !== 'heartbeatAck' &&
      message.payload.case !== 'environmentRevokeAck' &&
      message.payload.case !== 'environmentMaintenanceReport' &&
      message.payload.case !== 'error'
    ) {
      throw new Error('Control-only connections cannot receive environment execution messages.');
    }
    switch (message.payload.case) {
      case 'serverHello':
        await this.handleServerHello(peer, message.payload.value);
        return;
      case 'heartbeatAck':
        timestampDate(message.payload.value.receivedAt);
        return;
      case 'operationStart':
        await this.environmentOperations.start(message.payload.value);
        return;
      case 'operationQuery':
        await this.environmentOperations.query(message.payload.value);
        return;
      case 'operationCancel':
        await this.environmentOperations.cancel(message.payload.value);
        return;
      case 'operationOutputAck':
        this.environmentOperations.acknowledgeOutput(message.payload.value);
        return;
      case 'operationResultAck':
        this.environmentOperations.acknowledgeResult(message.payload.value);
        return;
      case 'mcpSessionOpen':
        await this.mcpHost.open(message.payload.value);
        return;
      case 'mcpSessionClose':
        await this.mcpHost.close(message.payload.value.sessionId);
        return;
      case 'mcpListTools':
        await this.mcpHost.listTools(message.payload.value);
        return;
      case 'mcpCallTool':
        await this.mcpHost.callTool(message.payload.value);
        return;
      case 'mcpAuthBegin':
        await this.mcpHost.beginAuth(message.payload.value);
        return;
      case 'mcpAuthCode':
        this.mcpHost.submitAuthCode(message.payload.value);
        return;
      case 'environmentRevokeAck': {
        const value = message.payload.value;
        if (
          value.envId !== this.identity?.envId ||
          value.deviceBindingId !== this.identity.deviceBindingId
        ) {
          throw new Error('Environment revocation acknowledgement targets another binding.');
        }
        timestampDate(value.revokedAt);
        const waiter = this.revokeWaiters.get(value.requestId);
        if (waiter === undefined) throw new Error('Unexpected environment revocation reply.');
        this.revokeWaiters.delete(value.requestId);
        clearTimeout(waiter.timeout);
        waiter.resolve(value);
        return;
      }
      case 'environmentMaintenanceReport': {
        const value = message.payload.value;
        if (
          value.envId !== this.identity?.envId ||
          value.deviceBindingId !== this.identity.deviceBindingId
        ) {
          throw new Error('Environment maintenance report targets another binding.');
        }
        const waiter = this.maintenanceWaiters.get(value.requestId);
        if (waiter === undefined) throw new Error('Unexpected environment maintenance reply.');
        this.maintenanceWaiters.delete(value.requestId);
        clearTimeout(waiter.timeout);
        waiter.resolve(value);
        return;
      }
      case 'error': {
        const error = message.payload.value;
        if (!isDeviceErrorCode(error.code) || !isDeviceErrorAction(error.action)) {
          throw new Error('Server DeviceError contains an unsupported code or action.');
        }
        this.options.onError?.(error);
        if (this.controlOnly) {
          this.setFatal(
            new Error(
              `Server rejected device control request with code ${error.code}: ${error.message}`,
            ),
          );
          peer.socket.close(1008, 'Control request rejected');
          return;
        }
        if (
          error.code === DeviceErrorCode.CAPABILITY_UNAVAILABLE ||
          error.code === DeviceErrorCode.DIRECTORY_INVALID ||
          error.code === DeviceErrorCode.OPERATION_EXPIRED
        ) {
          this.failReadiness(
            new DaemonReadinessError(
              `The environment is bound but not executable; Server error code ${error.code}.`,
            ),
          );
        }
        if (
          !peer.authenticated ||
          error.code === DeviceErrorCode.UNAUTHENTICATED ||
          error.code === DeviceErrorCode.DEVICE_REVOKED ||
          error.code === DeviceErrorCode.ENVIRONMENT_REVOKED ||
          error.code === DeviceErrorCode.IDENTITY_CONFLICT ||
          error.code === DeviceErrorCode.BINDING_CONFLICT ||
          error.code === DeviceErrorCode.VERSION_CONFLICT ||
          error.action === DeviceErrorAction.REAUTHENTICATE
        ) {
          this.setFatal(
            new Error(`Server rejected device authentication with code ${error.code}.`),
          );
        }
        if (error.action === DeviceErrorAction.RECONNECT)
          peer.socket.close(1011, 'Server requested reconnect');
        return;
      }
      default:
        throw new Error('Server payload is not supported.');
    }
  }

  private async handleServerHello(
    peer: DaemonPeer,
    hello: Extract<
      ReturnType<typeof decodeServerMessage>['payload'],
      { case: 'serverHello' }
    >['value'],
  ): Promise<void> {
    if (
      hello.instanceId !== this.instanceId ||
      hello.protocolMajor !== DEVICE_PROTOCOL_MAJOR ||
      hello.controlOnly !== this.controlOnly
    ) {
      throw new Error('ServerHello identity or protocol major is incompatible.');
    }
    if (
      this.options.platformPod &&
      (hello.platformPodUid !== this.options.platformPod.uid ||
        hello.platformPodName !== this.options.platformPod.name)
    )
      throw new Error('ServerHello platform Pod identity does not match.');
    if (
      hello.envId !== this.envId ||
      hello.capabilities.some((capability) => !isDeviceCapability(capability)) ||
      new Set(hello.capabilities).size !== hello.capabilities.length
    ) {
      throw new Error('ServerHello environment or capabilities are incompatible.');
    }
    this.readinessPath = undefined;
    timestampDate(hello.serverTime);
    const grantedCapabilities = hello.capabilities
      .filter(
        (capability) =>
          capability === DeviceCapability.BASH || capability === DeviceCapability.DIRECTORY_CHECK,
      )
      .map(daemonCapability);
    if (this.identity === undefined) {
      if (
        !hello.deviceCredential ||
        !hello.deviceId ||
        !hello.deviceBindingId ||
        !this.deviceName
      ) {
        throw new Error('Pairing ServerHello does not contain a new environment identity.');
      }
      const identity: DaemonIdentity = {
        version: 2,
        envId: this.envId,
        deviceId: hello.deviceId,
        deviceBindingId: hello.deviceBindingId,
        deviceCredential: hello.deviceCredential,
        serverUrl: this.serverUrl,
        deviceName: this.deviceName,
        grantedCapabilities,
        daemonVersion: this.daemonVersion,
      };
      this.options.identityStore.save(identity);
      this.identity = identity;
      this.pairingCredential = undefined;
    } else {
      if (
        hello.deviceId !== this.identity.deviceId ||
        hello.deviceBindingId !== this.identity.deviceBindingId ||
        hello.deviceCredential !== undefined
      ) {
        throw new Error('Reconnect ServerHello attempted to replace the environment identity.');
      }
      const updated: DaemonIdentity = this.controlOnly
        ? this.identity
        : {
            ...this.identity,
            grantedCapabilities,
            daemonVersion: this.daemonVersion,
          };
      if (JSON.stringify(updated) !== JSON.stringify(this.identity)) {
        this.options.identityStore.save(updated);
        this.identity = updated;
      }
    }
    this.grantedCapabilities = grantedCapabilities;
    this.operationCapabilities = [...hello.capabilities];
    peer.authenticated = true;
    this.reconnectAttempts = 0;
    this.options.status?.connection('connected');
    if (!this.controlOnly) this.environmentOperations.resume();
    this.startHeartbeat();
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
    this.connectionWaiters.clear();
    if (!this.controlOnly && !grantedCapabilities.includes('directory_check')) {
      this.failReadiness(
        new DaemonReadinessError(
          'The environment is bound but directory capability is unavailable.',
        ),
      );
    }
  }

  private sendOperationMessage(message: Parameters<typeof encodeDaemonMessage>[0]): Promise<void> {
    const peer = this.peer;
    if (peer?.authenticated !== true) return Promise.reject(new Error('Device is not connected.'));
    return peer.send(encodeDaemonMessage(message));
  }

  private rejectControlWaiters(error: Error): void {
    for (const waiter of this.maintenanceWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.maintenanceWaiters.clear();
    for (const waiter of this.revokeWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.revokeWaiters.clear();
  }

  private completeReadiness(result: EnvironmentOperationResult): void {
    if (
      result.operationId === undefined ||
      !this.environmentOperations.isDirectoryOperation(result.operationId)
    ) {
      return;
    }
    const outcome = result.outcome;
    const normalizedPath =
      outcome?.case === 'directoryCheck' ? outcome.value?.normalizedPath : undefined;
    if (
      result.status !== OperationStatus.COMPLETED ||
      outcome?.case !== 'directoryCheck' ||
      normalizedPath === undefined ||
      outcome.value?.capabilities?.includes(DeviceCapability.DIRECTORY_CHECK) !== true
    ) {
      this.failReadiness(
        new DaemonReadinessError('The environment is bound but directory readiness failed.'),
      );
      return;
    }
    this.readinessPath = normalizedPath;
    for (const waiter of this.readinessWaiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(normalizedPath);
    }
    this.readinessWaiters.clear();
  }

  private failReadiness(error: DaemonReadinessError): void {
    this.readinessPath = undefined;
    for (const waiter of this.readinessWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.readinessWaiters.clear();
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      const peer = this.peer;
      if (peer?.authenticated !== true) return;
      this.heartbeatSequence += 1n;
      void peer
        .send(
          encodeDaemonMessage({
            payload: {
              case: 'heartbeat',
              value: { sequence: this.heartbeatSequence, sentAt: timestamp(new Date()) },
            },
          }),
        )
        .catch((error: unknown) => this.transportFailure(error));
    }, this.heartbeatIntervalMilliseconds);
  }

  private async handleProcessFailure(peer: DaemonPeer, error: unknown): Promise<void> {
    if (error instanceof BashOperationFailure) {
      await this.sendFailure(peer, error);
      return;
    }
    peer.rejected = true;
    peer.authenticated = false;
    const failure = new BashOperationFailure(
      error instanceof ContractValidationError
        ? DeviceErrorCode.PROTOCOL_INCOMPATIBLE
        : DeviceErrorCode.INVALID_MESSAGE,
      error instanceof Error ? error.message : 'Server message is invalid.',
      DeviceErrorAction.ABORT,
    );
    await this.sendFailure(peer, failure);
    this.setFatal(new Error('Server protocol or handshake was rejected.'));
    peer.socket.close(1002, 'Server message rejected');
  }

  private async sendFailure(peer: DaemonPeer, failure: BashOperationFailure): Promise<void> {
    try {
      await peer.send(
        encodeDaemonMessage({
          payload: {
            case: 'error',
            value: {
              code: failure.code,
              message: failure.message,
              action: failure.action,
              ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
              ...(failure.operationId === undefined ? {} : { operationId: failure.operationId }),
            },
          },
        }),
      );
    } catch (error) {
      this.transportFailure(error);
    }
  }

  private transportFailure(error: unknown): void {
    this.options.onError?.(error);
    if (!this.stopped && !this.fatal) this.options.status?.connection('disconnected', error);
    const peer = this.peer;
    if (peer !== undefined) {
      peer.rejected = true;
      peer.authenticated = false;
    }
    if (peer?.socket.readyState === WebSocket.OPEN) {
      peer.socket.close(1011, 'Device transport failed');
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnect !== undefined) return;
    this.reconnectAttempts += 1;
    this.options.status?.connection('reconnecting');
    const delay = Math.min(this.reconnectDelayMilliseconds * this.reconnectAttempts, 10_000);
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      this.connect();
    }, delay);
  }

  private setFatal(error: Error): void {
    if (this.fatal) return;
    this.fatal = true;
    this.options.status?.connection('fatal', error);
    this.grantedCapabilities = [];
    if (this.peer !== undefined) {
      this.peer.rejected = true;
      this.peer.authenticated = false;
    }
    if (this.reconnect !== undefined) clearTimeout(this.reconnect);
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.options.onFatalError?.(error);
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.connectionWaiters.clear();
    for (const waiter of this.readinessWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.readinessWaiters.clear();
    this.rejectControlWaiters(error);
  }
}

function daemonCapability(capability: DeviceCapability): DaemonCapability {
  if (capability === DeviceCapability.BASH) return 'bash';
  if (capability === DeviceCapability.DIRECTORY_CHECK) return 'directory_check';
  throw new Error('ServerHello contains an unsupported capability.');
}

function architectureName(): string {
  const value = arch();
  if (value === 'x64') return 'x86_64';
  if (value === 'arm64') return 'aarch64';
  return value;
}

function timestamp(date: Date): { seconds: bigint; nanos: number } {
  const milliseconds = date.getTime();
  return {
    seconds: BigInt(Math.floor(milliseconds / 1000)),
    nanos: (milliseconds % 1000) * 1_000_000,
  };
}

function timestampDate(value: { seconds: bigint; nanos: number } | undefined): Date {
  if (value === undefined) {
    throw new BashOperationFailure(
      DeviceErrorCode.INVALID_MESSAGE,
      'Bash expiration time is missing.',
    );
  }
  const milliseconds = Number(value.seconds) * 1000 + value.nanos / 1_000_000;
  if (!Number.isFinite(milliseconds)) {
    throw new BashOperationFailure(
      DeviceErrorCode.INVALID_MESSAGE,
      'Bash expiration time is invalid.',
    );
  }
  return new Date(milliseconds);
}
