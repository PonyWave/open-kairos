import { randomUUID } from 'node:crypto';
import type { ServerMessageInit } from '@kairos/contracts/device';
import {
  ContractValidationError,
  DEVICE_PROTOCOL_MAJOR,
  DeviceCapability,
  DeviceErrorAction,
  DeviceErrorCode,
  decodeDaemonMessage,
  EnvironmentMaintenanceMode,
  encodeServerMessage,
  isDeviceCapability,
  isDeviceErrorAction,
  isDeviceErrorCode,
  OperationStatus,
} from '@kairos/contracts/device';
import type { RawData, WebSocket } from 'ws';
import { SessionError } from '../sessions/errors.js';
import { inTransaction } from '../storage/transaction.js';
import { arbitrateEnvironmentConnection } from './connection.js';
import type {
  EnvironmentOperationAction,
  EnvironmentOperationRecord,
  EnvironmentOperationStore,
} from './environment-operation-store.js';
import { emptyEnvironmentOutcome } from './environment-operation-store.js';
import type { EnvironmentStore } from './environment-store.js';
import { DeviceFailure } from './errors.js';

const maximumControlConnectionsPerBinding = 4;

interface Authentication {
  controlOnly: boolean;
  deviceId: string;
  ownerId: string;
  instanceId: string;
  capabilities: DeviceCapability[];
  environment: {
    envId: string;
    deviceBindingId: string;
  };
}

interface EnvironmentTarget {
  envId: string;
  deviceBindingId: string;
  instanceId: string;
  bindingVersion?: bigint | undefined;
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
    throw new DeviceFailure(DeviceErrorCode.INVALID_MESSAGE, 'A required timestamp is missing.');
  }
  const milliseconds = Number(value.seconds) * 1000 + value.nanos / 1_000_000;
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) {
    throw new DeviceFailure(
      DeviceErrorCode.INVALID_MESSAGE,
      'A timestamp is outside the valid range.',
    );
  }
  return new Date(milliseconds);
}

function requiredText(value: string, field: string, maximum: number): void {
  if (value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new DeviceFailure(
      DeviceErrorCode.INVALID_MESSAGE,
      `${field} must contain between 1 and ${maximum} characters.`,
    );
  }
}

function environmentOperationCapability(action: EnvironmentOperationAction): DeviceCapability {
  switch (action.case) {
    case 'read':
    case 'readImage':
    case 'syncScan':
    case 'syncRead':
      return DeviceCapability.FILE_READ;
    case 'write':
      return DeviceCapability.FILE_WRITE;
    case 'edit':
      return DeviceCapability.FILE_EDIT;
    case 'bash':
      return DeviceCapability.BASH;
    case 'directoryCheck':
      return DeviceCapability.DIRECTORY_CHECK;
    case 'directoryList':
      return DeviceCapability.DIRECTORY_LIST;
    case 'glob':
    case 'grep':
      return DeviceCapability.FILE_SEARCH;
  }
}

function environmentOperationTarget(operation: EnvironmentOperationRecord) {
  return {
    envId: operation.envId,
    deviceBindingId: operation.deviceBindingId,
    instanceId: operation.targetInstanceId,
    ...(operation.bindingVersion === undefined ? {} : { bindingVersion: operation.bindingVersion }),
  };
}

class ServerPeer {
  readonly socket: WebSocket;
  rejected = false;
  authentication?: Authentication;
  readonly authenticationController = new AbortController();
  private authenticationTimer: NodeJS.Timeout | undefined;
  lastSeen = Date.now();
  incoming: Promise<void> = Promise.resolve();
  incomingBytes = 0;
  private queue: Promise<void> = Promise.resolve();
  private queuedBytes = 0;

  constructor(
    socket: WebSocket,
    private readonly maxMessageBytes: number,
    private readonly maxQueueBytes: number,
  ) {
    this.socket = socket;
  }

  authenticationDeadline(milliseconds: number): void {
    clearTimeout(this.authenticationTimer);
    this.authenticationTimer = setTimeout(() => {
      if (this.authentication === undefined) {
        this.rejected = true;
        this.authenticationController.abort(
          new DeviceFailure(
            DeviceErrorCode.UNAUTHENTICATED,
            'Device authentication deadline exceeded.',
            DeviceErrorAction.REAUTHENTICATE,
          ),
        );
        this.socket.close(1008, 'Authentication timeout');
      }
    }, milliseconds);
  }

  closeAuthentication(): void {
    clearTimeout(this.authenticationTimer);
    this.authenticationController.abort(new Error('Device connection closed.'));
  }

  send(init: ServerMessageInit): Promise<void> {
    const data = encodeServerMessage(init);
    if (data.length > this.maxMessageBytes) {
      return Promise.reject(
        new DeviceFailure(
          DeviceErrorCode.MESSAGE_TOO_LARGE,
          'Server device message exceeds the configured limit.',
        ),
      );
    }
    if (this.queuedBytes + this.socket.bufferedAmount + data.length > this.maxQueueBytes) {
      return Promise.reject(
        new DeviceFailure(
          DeviceErrorCode.MESSAGE_TOO_LARGE,
          'Server device send queue exceeds the configured limit.',
          DeviceErrorAction.RECONNECT,
        ),
      );
    }
    this.queuedBytes += data.length;
    const sending = this.queue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.socket.readyState !== this.socket.OPEN) {
            reject(new Error('Device WebSocket is not open.'));
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

export interface StartEnvironmentOperationInput {
  operationId: string;
  tenantId: string;
  envId: string;
  bindingVersion?: bigint | undefined;
  action: EnvironmentOperationAction;
  expiresAt: Date;
}

export interface DeviceChannelOptions {
  environments: EnvironmentStore;
  environmentOperations: EnvironmentOperationStore;
  now?: () => Date;
  maxMessageBytes?: number;
  maxOutputChunkBytes?: number;
  maxQueueBytes?: number;
  authenticationTimeoutMilliseconds?: number;
  offlineAfterMilliseconds?: number;
  onDeviceError?: (error: {
    name?: string;
    code: DeviceErrorCode;
    message: string;
    deviceId: string;
    instanceId: string;
    operationId?: string;
    requestId?: string;
  }) => void;
}

export class DeviceChannel {
  readonly maxMessageBytes: number;
  private readonly maxOutputChunkBytes: number;
  private readonly maxQueueBytes: number;
  private readonly authenticationTimeoutMilliseconds: number;
  private readonly offlineAfterMilliseconds: number;
  private readonly now: () => Date;
  private readonly environmentConnections = new Map<string, ServerPeer>();
  private readonly mcpWaiters = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private readonly controlConnections = new Set<ServerPeer>();
  private controlSweepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: DeviceChannelOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
    this.maxOutputChunkBytes = options.maxOutputChunkBytes ?? 64 * 1024;
    this.maxQueueBytes = options.maxQueueBytes ?? 2 * 1024 * 1024;
    this.authenticationTimeoutMilliseconds = options.authenticationTimeoutMilliseconds ?? 5000;
    this.offlineAfterMilliseconds = options.offlineAfterMilliseconds ?? 30_000;
    for (const value of [
      this.maxMessageBytes,
      this.maxOutputChunkBytes,
      this.maxQueueBytes,
      this.authenticationTimeoutMilliseconds,
      this.offlineAfterMilliseconds,
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('Device channel limits must be positive safe integers.');
      }
    }
  }

  handleConnection(socket: WebSocket): void {
    const peer = new ServerPeer(socket, this.maxMessageBytes, this.maxQueueBytes);
    socket.binaryType = 'nodebuffer';
    peer.authenticationDeadline(this.authenticationTimeoutMilliseconds);
    socket.on('message', (data: RawData, isBinary: boolean) => {
      const size = Array.isArray(data)
        ? data.reduce((total, part) => total + part.length, 0)
        : data.byteLength;
      if (peer.incomingBytes + size > this.maxQueueBytes) {
        void this.sendFailure(
          peer,
          new DeviceFailure(
            DeviceErrorCode.MESSAGE_TOO_LARGE,
            'Device incoming queue exceeds the configured limit.',
            DeviceErrorAction.RECONNECT,
          ),
          true,
        );
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
    socket.on('error', () => {
      peer.rejected = true;
      if (socket.readyState === socket.OPEN) socket.close(1011, 'WebSocket error');
    });
    socket.once('close', () => {
      peer.rejected = true;
      peer.closeAuthentication();
      this.controlConnections.delete(peer);
      this.stopControlSweepIfIdle();
      const authentication = peer.authentication;
      if (authentication === undefined) return;
      const { envId, deviceBindingId } = authentication.environment;
      if (this.environmentConnections.get(deviceBindingId) !== peer) return;
      this.environmentConnections.delete(deviceBindingId);
      try {
        this.options.environments.markDisconnected({
          envId,
          deviceBindingId,
          instanceId: authentication.instanceId,
        });
      } catch (error) {
        this.options.onDeviceError?.({
          code: DeviceErrorCode.INTERNAL,
          message: error instanceof Error ? error.message : 'Environment disconnect was not saved.',
          deviceId: authentication.deviceId,
          instanceId: authentication.instanceId,
        });
      }
    });
  }

  async startEnvironmentOperation(
    input: StartEnvironmentOperationInput,
  ): Promise<EnvironmentOperationRecord> {
    const { environments, operations } = this.environmentStores();
    const existing = operations.find(input.operationId);
    if (existing !== undefined) {
      operations.getForTenant(input.tenantId, input.operationId);
      if (existing.envId !== input.envId || existing.bindingVersion !== input.bindingVersion) {
        throw new DeviceFailure(
          DeviceErrorCode.OPERATION_CONFLICT,
          'Environment operation target or Agent binding version changed for an existing operation ID.',
          DeviceErrorAction.QUERY_OPERATION,
          input.operationId,
        );
      }
      return operations.createIntent({
        operationId: input.operationId,
        tenantId: existing.tenantId,
        envId: existing.envId,
        deviceId: existing.deviceId,
        deviceBindingId: existing.deviceBindingId,
        targetInstanceId: existing.targetInstanceId,
        ...(existing.bindingVersion === undefined
          ? {}
          : { bindingVersion: existing.bindingVersion }),
        action: input.action,
        expiresAt: input.expiresAt,
      }).operation;
    }
    const environment = environments.get(input.tenantId, input.envId);
    if (environment.bindingStatus === 'revoked') {
      throw new DeviceFailure(
        DeviceErrorCode.ENVIRONMENT_REVOKED,
        'A revoked environment cannot accept new operations.',
        DeviceErrorAction.ABORT,
        input.operationId,
      );
    }
    if (environment.maintenanceMode === 'draining' && input.action.case !== 'directoryCheck') {
      throw new DeviceFailure(
        DeviceErrorCode.PERMISSION_DENIED,
        'Environment maintenance is draining; only directory readiness checks are allowed.',
        DeviceErrorAction.ABORT,
        input.operationId,
      );
    }
    const deviceId = environment.deviceId;
    const deviceBindingId = environment.deviceBindingId;
    const instanceId = environment.instanceId;
    if (
      environment.bindingStatus !== 'active' ||
      deviceId === undefined ||
      deviceBindingId === undefined ||
      instanceId === undefined
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.ENVIRONMENT_OFFLINE,
        'Environment has no active online binding.',
        DeviceErrorAction.RECONNECT,
        input.operationId,
      );
    }
    const peer = this.environmentConnections.get(deviceBindingId);
    if (
      peer?.authentication?.environment?.envId !== input.envId ||
      peer.authentication.instanceId !== instanceId ||
      peer.socket.readyState !== peer.socket.OPEN
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.ENVIRONMENT_OFFLINE,
        'Environment operation requires the current Daemon instance to be online.',
        DeviceErrorAction.RECONNECT,
        input.operationId,
      );
    }
    if (
      input.action.case !== 'directoryCheck' &&
      input.action.case !== 'directoryList' &&
      !environment.ready
    ) {
      throw new DeviceFailure(
        environment.directoryStatus === 'ready'
          ? DeviceErrorCode.CAPABILITY_UNAVAILABLE
          : DeviceErrorCode.DIRECTORY_INVALID,
        'Environment directory and capability readiness are required for business operations.',
        DeviceErrorAction.ABORT,
        input.operationId,
      );
    }
    const capability = environmentOperationCapability(input.action);
    if (
      !environment.grantedCapabilities.includes(capability) ||
      !peer.authentication.capabilities.includes(capability)
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.CAPABILITY_UNAVAILABLE,
        'The required environment operation capability was not granted.',
        DeviceErrorAction.ABORT,
        input.operationId,
      );
    }
    const created = operations.createIntent({
      operationId: input.operationId,
      tenantId: input.tenantId,
      envId: input.envId,
      deviceId,
      deviceBindingId,
      targetInstanceId: instanceId,
      ...(input.bindingVersion === undefined ? {} : { bindingVersion: input.bindingVersion }),
      action: input.action,
      expiresAt: input.expiresAt,
    });
    if (!created.created) return created.operation;
    try {
      await this.sendEnvironmentStart(peer, created.operation);
    } catch (error) {
      if (error instanceof DeviceFailure && error.code === DeviceErrorCode.MESSAGE_TOO_LARGE) {
        peer.socket.close(1009, 'Environment operation message limit');
        throw error;
      }
      peer.socket.close(1011, 'Environment operation delivery interrupted');
      throw new DeviceFailure(
        DeviceErrorCode.ENVIRONMENT_OFFLINE,
        'Environment operation intent was persisted, but delivery requires reconciliation.',
        DeviceErrorAction.QUERY_OPERATION,
        input.operationId,
      );
    }
    operations.markSent(input.operationId, deviceBindingId, instanceId);
    return operations.getForTenant(input.tenantId, input.operationId);
  }

  async cancelEnvironmentOperation(input: {
    tenantId: string;
    operationId: string;
    reason: string;
  }): Promise<EnvironmentOperationRecord> {
    requiredText(input.reason, 'reason', 1000);
    const { operations } = this.environmentStores();
    const operation = operations.getForTenant(input.tenantId, input.operationId);
    if (operation.resultRecordedAt !== undefined) return operation;
    const peer = this.environmentConnections.get(operation.deviceBindingId);
    if (
      peer?.authentication?.environment?.envId !== operation.envId ||
      peer.authentication.instanceId !== operation.targetInstanceId ||
      peer.socket.readyState !== peer.socket.OPEN
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.ENVIRONMENT_OFFLINE,
        'Cancellation requires the original Daemon instance.',
        DeviceErrorAction.QUERY_OPERATION,
        input.operationId,
      );
    }
    const requested = operations.requestCancel(input.tenantId, input.operationId, input.reason);
    await peer.send({
      payload: {
        case: 'operationCancel',
        value: {
          requestId: randomUUID(),
          operationId: input.operationId,
          target: environmentOperationTarget(requested),
          reason: input.reason,
        },
      },
    });
    return requested;
  }

  getEnvironmentOperation(tenantId: string, operationId: string): EnvironmentOperationRecord {
    return this.environmentStores().operations.getForTenant(tenantId, operationId);
  }

  private mcpPeer(envId: string): ServerPeer {
    for (const peer of this.environmentConnections.values()) {
      const authentication = peer.authentication;
      if (authentication?.environment?.envId === envId) return peer;
    }
    throw new DeviceFailure(
      DeviceErrorCode.ENVIRONMENT_OFFLINE,
      'The MCP target environment is offline.',
    );
  }

  async openMcpSession(input: {
    envId: string;
    sessionId: string;
    serverName: string;
    transport: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }): Promise<{ error: string; needsAuth: boolean }> {
    const peer = this.mcpPeer(input.envId);
    const result = new Promise<{ error: string; needsAuth: boolean }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.mcpOpenWaiters.delete(input.sessionId);
        reject(
          new DeviceFailure(DeviceErrorCode.OPERATION_UNKNOWN, 'The MCP session open timed out.'),
        );
      }, 40_000);
      this.mcpOpenWaiters.set(input.sessionId, { resolve, timeout });
    });
    await peer
      .send({
        payload: {
          case: 'mcpSessionOpen',
          value: {
            sessionId: input.sessionId,
            serverName: input.serverName,
            transport: input.transport,
            command: input.command ?? '',
            args: input.args ?? [],
            env: input.env ?? {},
            url: input.url ?? '',
            headers: input.headers ?? {},
          },
        },
      })
      .catch((error: unknown) => {
        const waiter = this.mcpOpenWaiters.get(input.sessionId);
        if (waiter !== undefined) {
          this.mcpOpenWaiters.delete(input.sessionId);
          clearTimeout(waiter.timeout);
        }
        throw error instanceof Error ? error : new Error('The MCP session open could not be sent.');
      });
    return result;
  }

  mcpAuthBegin(
    input: {
      envId: string;
      sessionId: string;
      requestId: string;
      serverName: string;
      url: string;
      headers: Record<string, string>;
      redirectUri: string;
      accessToken?: string;
      refreshToken?: string;
    },
    hooks: { onUrl: (url: string) => void },
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresInSeconds: bigint;
    error: string;
  }> {
    const peer = this.mcpPeer(input.envId);
    const requestId = input.requestId;
    const urlWaiter = new Promise<void>((resolve) => {
      this.mcpAuthUrlWaiters.set(requestId, { onUrl: hooks.onUrl, resolve });
    });
    const resultPromise = new Promise<{
      accessToken: string;
      refreshToken: string;
      expiresInSeconds: bigint;
      error: string;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.mcpAuthWaiters.delete(requestId);
        this.mcpAuthUrlWaiters.delete(requestId);
        reject(
          new DeviceFailure(DeviceErrorCode.OPERATION_UNKNOWN, 'The MCP authorization timed out.'),
        );
      }, 16 * 60_000);
      this.mcpAuthWaiters.set(requestId, { resolve, reject, timeout });
    });
    void urlWaiter;
    void peer
      .send({
        payload: {
          case: 'mcpAuthBegin',
          value: {
            sessionId: input.sessionId,
            requestId,
            serverName: input.serverName,
            transport: 'http',
            url: input.url,
            headers: input.headers,
            redirectUri: input.redirectUri,
            accessToken: input.accessToken ?? '',
            refreshToken: input.refreshToken ?? '',
          },
        },
      })
      .catch((error: unknown) => {
        const waiter = this.mcpAuthWaiters.get(requestId);
        if (waiter !== undefined) {
          this.mcpAuthWaiters.delete(requestId);
          clearTimeout(waiter.timeout);
          waiter.reject(
            error instanceof Error ? error : new Error('The MCP authorization could not be sent.'),
          );
        }
      });
    return resultPromise;
  }

  submitMcpAuthCode(input: {
    envId: string;
    sessionId: string;
    requestId: string;
    code: string;
  }): void {
    const peer = this.mcpPeer(input.envId);
    void peer.send({
      payload: {
        case: 'mcpAuthCode',
        value: { sessionId: input.sessionId, requestId: input.requestId, code: input.code },
      },
    });
  }

  private readonly mcpOpenWaiters = new Map<
    string,
    { resolve: (value: { error: string; needsAuth: boolean }) => void; timeout: NodeJS.Timeout }
  >();
  private readonly mcpAuthUrlWaiters = new Map<
    string,
    { onUrl: (url: string) => void; resolve: () => void }
  >();
  private readonly mcpAuthWaiters = new Map<
    string,
    {
      resolve: (value: {
        accessToken: string;
        refreshToken: string;
        expiresInSeconds: bigint;
        error: string;
      }) => void;
      reject: (error: unknown) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  async closeMcpSession(input: { envId: string; sessionId: string }): Promise<void> {
    const peer = this.mcpPeer(input.envId);
    await peer.send({
      payload: { case: 'mcpSessionClose', value: { sessionId: input.sessionId } },
    });
  }

  private mcpRequest<T>(
    envId: string,
    build: (requestId: string) => Parameters<ServerPeer['send']>[0],
    timeoutMs: number,
  ): Promise<T> {
    const peer = this.mcpPeer(envId);
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.mcpWaiters.delete(requestId);
        reject(new DeviceFailure(DeviceErrorCode.OPERATION_UNKNOWN, 'The MCP request timed out.'));
      }, timeoutMs);
      this.mcpWaiters.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
      peer.send(build(requestId)).catch((error: unknown) => {
        this.mcpWaiters.delete(requestId);
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error('The MCP request could not be sent.'));
      });
    });
  }

  mcpListTools(input: { envId: string; sessionId: string }): Promise<{
    tools: Array<{ name: string; description: string; inputSchemaJson: string }>;
    error: string;
  }> {
    return this.mcpRequest(
      input.envId,
      (requestId) => ({
        payload: { case: 'mcpListTools', value: { sessionId: input.sessionId, requestId } },
      }),
      35_000,
    );
  }

  mcpCallTool(input: {
    envId: string;
    sessionId: string;
    toolName: string;
    argumentsJson: string;
  }): Promise<{ contentJson: string; isError: boolean; error: string }> {
    return this.mcpRequest(
      input.envId,
      (requestId) => ({
        payload: {
          case: 'mcpCallTool',
          value: {
            sessionId: input.sessionId,
            requestId,
            toolName: input.toolName,
            argumentsJson: input.argumentsJson,
          },
        },
      }),
      150_000,
    );
  }

  bashOutputLog(
    operationId: string,
  ): { path: string; sizeBytes: bigint; truncated: boolean } | undefined {
    const { operations } = this.environmentStores();
    return operations.bashOutputLog(operationId);
  }

  readEnvironmentOperationOutput(input: {
    tenantId: string;
    operationId: string;
    offset: bigint;
    limit: number;
  }): {
    chunks: ReturnType<EnvironmentOperationStore['readOutputForTenant']>;
    data: Uint8Array;
    nextOffset: bigint;
    outputComplete: boolean;
    outputGap: boolean;
  } {
    const { operations } = this.environmentStores();
    const operation = operations.getForTenant(input.tenantId, input.operationId);
    const chunks = operations.readOutputForTenant(
      input.tenantId,
      input.operationId,
      input.offset,
      input.limit,
    );
    return {
      chunks,
      data: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data))),
      nextOffset: chunks.at(-1)?.endOffset ?? input.offset,
      outputComplete: operation.outputComplete,
      outputGap: operation.outputGap,
    };
  }

  close(): void {
    for (const peer of this.controlConnections) peer.socket.close(1001, 'Server shutting down');
    this.controlConnections.clear();
    this.stopControlSweepIfIdle();
    for (const peer of this.environmentConnections.values()) {
      const authentication = peer.authentication;
      if (authentication?.environment !== undefined) {
        try {
          this.options.environments.markDisconnected({
            envId: authentication.environment.envId,
            deviceBindingId: authentication.environment.deviceBindingId,
            instanceId: authentication.instanceId,
          });
        } catch (error) {
          this.options.onDeviceError?.({
            code: DeviceErrorCode.INTERNAL,
            message: error instanceof Error ? error.message : 'Environment shutdown was not saved.',
            deviceId: authentication.deviceId,
            instanceId: authentication.instanceId,
          });
        }
      }
      peer.socket.close(1001, 'Server shutting down');
    }
    this.environmentConnections.clear();
  }

  private async processMessage(peer: ServerPeer, data: RawData, isBinary: boolean): Promise<void> {
    if (peer.rejected || peer.socket.readyState !== peer.socket.OPEN) return;
    if (!isBinary || Array.isArray(data)) {
      throw new DeviceFailure(
        DeviceErrorCode.PROTOCOL_INCOMPATIBLE,
        'Device messages must be single binary Protobuf messages.',
      );
    }
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (bytes.length > this.maxMessageBytes) {
      throw new DeviceFailure(DeviceErrorCode.MESSAGE_TOO_LARGE, 'Device message is too large.');
    }
    const message = decodeDaemonMessage(bytes);
    if (peer.authentication === undefined) {
      if (message.payload.case !== 'deviceHello') {
        throw new DeviceFailure(
          DeviceErrorCode.UNAUTHENTICATED,
          'DeviceHello is required before other messages.',
          DeviceErrorAction.REAUTHENTICATE,
        );
      }
      await this.handleHello(peer, message.payload.value);
      return;
    }
    if (message.payload.case === 'deviceHello') {
      throw new DeviceFailure(
        DeviceErrorCode.PROTOCOL_INCOMPATIBLE,
        'DeviceHello is only valid once per connection.',
      );
    }
    if (
      peer.authentication.controlOnly &&
      message.payload.case !== 'heartbeat' &&
      message.payload.case !== 'environmentMaintenanceQuery' &&
      message.payload.case !== 'environmentRevoke'
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.PERMISSION_DENIED,
        'Control-only connections may only query maintenance, revoke their binding or send heartbeats.',
        DeviceErrorAction.ABORT,
      );
    }
    peer.lastSeen = this.now().getTime();
    switch (message.payload.case) {
      case 'heartbeat': {
        timestampDate(message.payload.value.sentAt);
        if (peer.authentication.controlOnly) {
          this.options.environments.maintenanceForBinding(peer.authentication.environment);
        } else
          this.options.environments.markConnected({
            envId: peer.authentication.environment.envId,
            deviceId: peer.authentication.deviceId,
            deviceBindingId: peer.authentication.environment.deviceBindingId,
            instanceId: peer.authentication.instanceId,
            reportedCapabilities: peer.authentication.capabilities,
          });
        await peer.send({
          payload: {
            case: 'heartbeatAck',
            value: {
              sequence: message.payload.value.sequence,
              receivedAt: timestamp(this.now()),
            },
          },
        });
        return;
      }
      case 'operationAccepted':
        this.recordEnvironmentAccepted(
          peer,
          message.payload.value,
          timestampDate(message.payload.value.acceptedAt),
        );
        return;
      case 'operationState':
        this.recordEnvironmentAccepted(
          peer,
          message.payload.value,
          timestampDate(message.payload.value.observedAt),
        );
        return;
      case 'operationOutputChunk': {
        const value = message.payload.value;
        this.requireEnvironmentTarget(peer, value.target);
        if (value.data.length > this.maxOutputChunkBytes) {
          throw new DeviceFailure(
            DeviceErrorCode.MESSAGE_TOO_LARGE,
            'Environment output fragment exceeds the configured limit.',
            DeviceErrorAction.RECONNECT,
            value.operationId,
          );
        }
        const nextOffset = this.environmentStores().operations.recordOutput({
          operationId: value.operationId,
          envId: value.target.envId,
          deviceBindingId: value.target.deviceBindingId,
          targetInstanceId: value.target.instanceId,
          ...(value.target.bindingVersion === undefined
            ? {}
            : { bindingVersion: value.target.bindingVersion }),
          offset: value.offset,
          stream: value.stream,
          data: value.data,
        });
        await peer.send({
          payload: {
            case: 'operationOutputAck',
            value: {
              operationId: value.operationId,
              target: value.target,
              nextOffset,
            },
          },
        });
        await this.confirmEnvironmentResultIfReady(peer, value.operationId);
        return;
      }
      case 'operationResult':
        await this.recordEnvironmentResult(peer, message.payload.value);
        return;
      case 'environmentRevoke':
        await this.revokeEnvironment(peer, message.payload.value);
        return;
      case 'environmentMaintenanceQuery':
        await this.reportEnvironmentMaintenance(peer, message.payload.value);
        return;
      case 'mcpListToolsResult': {
        const value = message.payload.value;
        const waiter = this.mcpWaiters.get(value.requestId);
        if (waiter !== undefined) {
          this.mcpWaiters.delete(value.requestId);
          clearTimeout(waiter.timeout);
          waiter.resolve({ tools: value.tools, error: value.error });
        }
        return;
      }
      case 'mcpSessionOpenResult': {
        const value = message.payload.value;
        const waiter = this.mcpOpenWaiters.get(value.sessionId);
        if (waiter !== undefined) {
          this.mcpOpenWaiters.delete(value.sessionId);
          clearTimeout(waiter.timeout);
          waiter.resolve({ error: value.error, needsAuth: value.needsAuth });
        }
        return;
      }
      case 'mcpAuthUrl': {
        const value = message.payload.value;
        const waiter = this.mcpAuthUrlWaiters.get(value.requestId);
        if (waiter !== undefined) {
          this.mcpAuthUrlWaiters.delete(value.requestId);
          waiter.resolve();
          if (value.error.length === 0) waiter.onUrl(value.authorizationUrl);
        }
        return;
      }
      case 'mcpAuthResult': {
        const value = message.payload.value;
        const waiter = this.mcpAuthWaiters.get(value.requestId);
        if (waiter !== undefined) {
          this.mcpAuthWaiters.delete(value.requestId);
          clearTimeout(waiter.timeout);
          waiter.resolve({
            accessToken: value.accessToken,
            refreshToken: value.refreshToken,
            expiresInSeconds: value.expiresInSeconds,
            error: value.error,
          });
        }
        return;
      }
      case 'mcpCallToolResult': {
        const value = message.payload.value;
        const waiter = this.mcpWaiters.get(value.requestId);
        if (waiter !== undefined) {
          this.mcpWaiters.delete(value.requestId);
          clearTimeout(waiter.timeout);
          waiter.resolve({
            contentJson: value.contentJson,
            isError: value.isError,
            error: value.error,
          });
        }
        return;
      }
      case 'error': {
        const value = message.payload.value;
        if (!isDeviceErrorCode(value.code) || !isDeviceErrorAction(value.action)) {
          throw new DeviceFailure(
            DeviceErrorCode.INVALID_MESSAGE,
            'Device error is not fully specified.',
          );
        }
        await this.recordEnvironmentOperationError(peer, value);
        this.options.onDeviceError?.({
          code: value.code,
          message: value.message,
          deviceId: peer.authentication.deviceId,
          instanceId: peer.authentication.instanceId,
          ...(value.operationId === undefined ? {} : { operationId: value.operationId }),
          ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
        });
        return;
      }
      default:
        throw new DeviceFailure(
          DeviceErrorCode.PROTOCOL_INCOMPATIBLE,
          'Unsupported device payload.',
        );
    }
  }

  private async handleHello(
    peer: ServerPeer,
    hello: Extract<
      ReturnType<typeof decodeDaemonMessage>['payload'],
      { case: 'deviceHello' }
    >['value'],
  ): Promise<void> {
    requiredText(hello.instanceId, 'instanceId', 200);
    if (hello.protocolMajor !== DEVICE_PROTOCOL_MAJOR) {
      throw new DeviceFailure(
        DeviceErrorCode.VERSION_CONFLICT,
        'Device protocol major is incompatible.',
        DeviceErrorAction.ABORT,
      );
    }
    if (
      hello.capabilities.some((capability) => !isDeviceCapability(capability)) ||
      new Set(hello.capabilities).size !== hello.capabilities.length
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.PROTOCOL_INCOMPATIBLE,
        'Device capability is unknown or duplicated.',
      );
    }
    await this.handleEnvironmentHello(peer, hello);
  }

  private async handleEnvironmentHello(
    peer: ServerPeer,
    hello: Extract<
      ReturnType<typeof decodeDaemonMessage>['payload'],
      { case: 'deviceHello' }
    >['value'],
  ): Promise<void> {
    const { environments, operations } = this.environmentStores();
    requiredText(hello.envId, 'envId', 200);
    requiredText(hello.daemonVersion, 'daemonVersion', 100);
    requiredText(hello.os, 'os', 100);
    requiredText(hello.architecture, 'architecture', 100);
    if (
      hello.authentication.case === 'pairingCredential' &&
      (hello.deviceId || hello.deviceBindingId || hello.controlOnly)
    )
      throw new DeviceFailure(
        DeviceErrorCode.UNAUTHENTICATED,
        'Initial pairing must be an execution hello without an existing device binding.',
        DeviceErrorAction.REAUTHENTICATE,
      );
    let authenticated:
      | ReturnType<EnvironmentStore['exchangePairing']>
      | ReturnType<EnvironmentStore['pairing']['authenticate']>;
    const preliminary =
      hello.authentication.case === 'pairingCredential'
        ? environments.pairing.preview({
            envId: hello.envId,
            pairingCredential: hello.authentication.value,
            reportedCapabilities: hello.capabilities,
          })
        : hello.authentication.case === 'deviceCredential'
          ? environments.pairing.authenticate({
              envId: hello.envId,
              deviceId: hello.deviceId,
              deviceBindingId: hello.deviceBindingId,
              deviceCredential: hello.authentication.value,
            })
          : undefined;
    if (!preliminary)
      throw new DeviceFailure(
        DeviceErrorCode.UNAUTHENTICATED,
        'Environment authentication is missing.',
      );
    if (hello.platformPodUid || hello.platformPodName)
      throw new DeviceFailure(
        DeviceErrorCode.PERMISSION_DENIED,
        'Device hello must not claim a platform Pod.',
      );
    if (hello.authentication.case === 'pairingCredential') {
      requiredText(hello.authentication.value, 'pairing credential', 512);
      if (hello.deviceId || hello.deviceBindingId) {
        throw new DeviceFailure(
          DeviceErrorCode.UNAUTHENTICATED,
          'Initial environment pairing must not reuse a device binding.',
          DeviceErrorAction.REAUTHENTICATE,
        );
      }
      authenticated = environments.exchangePairing({
        envId: hello.envId,
        pairingCredential: hello.authentication.value,
        reportedCapabilities: hello.capabilities,
        daemonVersion: hello.daemonVersion,
        os: hello.os,
        architecture: hello.architecture,
        deviceName: hello.deviceName,
        homeDirectory: hello.homeDirectory,
      });
    } else if (hello.authentication.case === 'deviceCredential') {
      requiredText(hello.authentication.value, 'device credential', 512);
      requiredText(hello.deviceId, 'deviceId', 200);
      requiredText(hello.deviceBindingId, 'deviceBindingId', 200);
      authenticated = environments.pairing.authenticate({
        envId: hello.envId,
        deviceId: hello.deviceId,
        deviceBindingId: hello.deviceBindingId,
        deviceCredential: hello.authentication.value,
      });
    } else {
      throw new DeviceFailure(
        DeviceErrorCode.UNAUTHENTICATED,
        'Environment authentication is missing.',
        DeviceErrorAction.REAUTHENTICATE,
      );
    }

    if (hello.controlOnly) {
      const activeControls = [...this.controlConnections].filter(
        (control) =>
          control.authentication?.environment.deviceBindingId === authenticated.deviceBindingId,
      ).length;
      if (activeControls >= maximumControlConnectionsPerBinding) {
        throw new DeviceFailure(
          DeviceErrorCode.PERMISSION_DENIED,
          'The environment control connection limit has been reached.',
          DeviceErrorAction.RETRY,
        );
      }
      peer.authentication = {
        controlOnly: true,
        deviceId: authenticated.deviceId,
        ownerId: authenticated.tenantId,
        instanceId: hello.instanceId,
        capabilities: [],
        environment: {
          envId: authenticated.envId,
          deviceBindingId: authenticated.deviceBindingId,
        },
      };
      peer.lastSeen = this.now().getTime();
      this.controlConnections.add(peer);
      this.startControlSweep();
      await peer.send({
        payload: {
          case: 'serverHello',
          value: {
            controlOnly: true,
            deviceId: authenticated.deviceId,
            instanceId: hello.instanceId,
            protocolMajor: DEVICE_PROTOCOL_MAJOR,
            serverTime: timestamp(this.now()),
            envId: authenticated.envId,
            deviceBindingId: authenticated.deviceBindingId,
          },
        },
      });
      return;
    }

    const previous = this.environmentConnections.get(authenticated.deviceBindingId);
    if (previous !== undefined && previous !== peer) {
      arbitrateEnvironmentConnection(
        previous.authentication === undefined
          ? undefined
          : {
              instanceId: previous.authentication.instanceId,
              open: previous.socket.readyState === previous.socket.OPEN,
              lastSeen: previous.lastSeen,
            },
        hello.instanceId,
        this.now().getTime(),
        this.offlineAfterMilliseconds,
      );
    }
    for (const instanceId of new Set(
      operations
        .listAbandonedInstances(authenticated.deviceBindingId, hello.instanceId)
        .map((operation) => operation.targetInstanceId),
    )) {
      operations.markInstanceLost(authenticated.deviceBindingId, instanceId);
    }
    const connected = environments.markConnected({
      envId: authenticated.envId,
      deviceId: authenticated.deviceId,
      deviceBindingId: authenticated.deviceBindingId,
      instanceId: hello.instanceId,
      reportedCapabilities: hello.capabilities,
      daemonVersion: hello.daemonVersion,
      os: hello.os,
      architecture: hello.architecture,
    });
    if (previous !== undefined && previous !== peer) {
      previous.socket.close(4001, 'Environment instance reconnected');
    }
    peer.authentication = {
      controlOnly: false,
      deviceId: authenticated.deviceId,
      ownerId: authenticated.tenantId,
      instanceId: hello.instanceId,
      capabilities: connected.grantedCapabilities,
      environment: {
        envId: authenticated.envId,
        deviceBindingId: authenticated.deviceBindingId,
      },
    };
    peer.lastSeen = this.now().getTime();
    this.environmentConnections.set(authenticated.deviceBindingId, peer);
    await peer.send({
      payload: {
        case: 'serverHello',
        value: {
          deviceId: authenticated.deviceId,
          instanceId: hello.instanceId,
          protocolMajor: DEVICE_PROTOCOL_MAJOR,
          capabilities: connected.grantedCapabilities,
          serverTime: timestamp(this.now()),
          envId: authenticated.envId,
          deviceBindingId: authenticated.deviceBindingId,
          ...('deviceCredential' in authenticated
            ? { deviceCredential: authenticated.deviceCredential }
            : {}),
        },
      },
    });
    if (hello.instanceId !== connected.instanceId) {
      throw new DeviceFailure(
        DeviceErrorCode.BINDING_CONFLICT,
        'Environment connection instance changed during authentication.',
        DeviceErrorAction.REAUTHENTICATE,
      );
    }
    const pending = operations.listPendingForInstance(
      authenticated.deviceBindingId,
      hello.instanceId,
    );
    await this.startEnvironmentDirectoryCheck(peer);
    for (const operation of pending) {
      await peer.send({
        payload: {
          case: 'operationQuery',
          value: {
            requestId: randomUUID(),
            operationId: operation.operationId,
            target: environmentOperationTarget(operation),
          },
        },
      });
    }
  }

  private async startEnvironmentDirectoryCheck(peer: ServerPeer): Promise<void> {
    const authentication = this.requireEnvironmentAuthentication(peer);
    const { environments, operations } = this.environmentStores();
    const environment = environments.get(authentication.ownerId, authentication.environment.envId);
    const operation = operations.createIntent({
      operationId: randomUUID(),
      tenantId: authentication.ownerId,
      envId: authentication.environment.envId,
      deviceId: authentication.deviceId,
      deviceBindingId: authentication.environment.deviceBindingId,
      targetInstanceId: authentication.instanceId,
      action: {
        case: 'directoryCheck',
        value: { path: environment.recommendedPwd, loadWorkspace: true },
      },
      expiresAt: new Date(this.now().getTime() + 30_000),
    }).operation;
    await this.sendEnvironmentStart(peer, operation);
    operations.markSent(
      operation.operationId,
      operation.deviceBindingId,
      operation.targetInstanceId,
    );
  }

  private sendEnvironmentStart(
    peer: ServerPeer,
    operation: EnvironmentOperationRecord,
  ): Promise<void> {
    return peer.send({
      payload: {
        case: 'operationStart',
        value: {
          operationId: operation.operationId,
          requestId: randomUUID(),
          target: environmentOperationTarget(operation),
          expiresAt: timestamp(new Date(operation.expiresAt)),
          action: operation.action,
        },
      },
    });
  }

  private recordEnvironmentAccepted(
    peer: ServerPeer,
    value: Extract<
      ReturnType<typeof decodeDaemonMessage>['payload'],
      { case: 'operationAccepted' | 'operationState' }
    >['value'],
    acceptedAt: Date,
  ): void {
    const target = value.target;
    if (target === undefined) {
      throw new DeviceFailure(DeviceErrorCode.INVALID_MESSAGE, 'Operation target is missing.');
    }
    this.requireEnvironmentTarget(peer, target);
    this.environmentStores().operations.recordAccepted({
      operationId: value.operationId,
      envId: target.envId,
      deviceBindingId: target.deviceBindingId,
      targetInstanceId: target.instanceId,
      ...(target.bindingVersion === undefined ? {} : { bindingVersion: target.bindingVersion }),
      status: value.status,
      acceptedAt,
    });
  }

  private async recordEnvironmentResult(
    peer: ServerPeer,
    value: Extract<
      ReturnType<typeof decodeDaemonMessage>['payload'],
      { case: 'operationResult' }
    >['value'],
  ): Promise<void> {
    const target = value.target;
    if (target === undefined) {
      throw new DeviceFailure(DeviceErrorCode.INVALID_MESSAGE, 'Operation target is missing.');
    }
    this.requireEnvironmentTarget(peer, target);
    if (value.outcome.case === undefined) {
      throw new DeviceFailure(
        DeviceErrorCode.PROTOCOL_INCOMPATIBLE,
        'Operation outcome is missing.',
      );
    }
    const { operations } = this.environmentStores();
    const saved = operations.recordResult({
      operationId: value.operationId,
      envId: target.envId,
      deviceBindingId: target.deviceBindingId,
      targetInstanceId: target.instanceId,
      ...(target.bindingVersion === undefined ? {} : { bindingVersion: target.bindingVersion }),
      status: value.status,
      outcome: value.outcome,
      observedAt: timestampDate(value.observedAt),
      ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
    });
    await this.postProcessEnvironmentResult(peer, saved);
    await this.confirmEnvironmentResultIfReady(peer, saved.operationId, value.requestId, true);
  }

  private async postProcessEnvironmentResult(
    peer: ServerPeer,
    saved: ReturnType<EnvironmentOperationStore['recordResult']>,
  ) {
    const authentication = this.requireEnvironmentAuthentication(peer);
    if (saved.postProcessedAt !== undefined) return saved;
    if (saved.outcome === undefined || saved.resultStatus === undefined) {
      throw new DeviceFailure(DeviceErrorCode.INTERNAL, 'Environment result is incomplete.');
    }
    const { environments, operations } = this.environmentStores();
    if (
      saved.action.case === 'directoryCheck' &&
      saved.action.value.loadWorkspace &&
      saved.action.value.path ===
        environments.get(authentication.ownerId, saved.envId).recommendedPwd
    ) {
      if (saved.outcome.case !== 'directoryCheck') {
        throw new DeviceFailure(
          DeviceErrorCode.INVALID_MESSAGE,
          'Directory result outcome is invalid.',
        );
      }
      const outcome = saved.outcome.value;
      const ready =
        saved.resultStatus === OperationStatus.COMPLETED &&
        outcome.exists &&
        outcome.directory &&
        outcome.readable &&
        outcome.writable &&
        outcome.executable;
      environments.recordReadiness({
        envId: saved.envId,
        deviceId: authentication.deviceId,
        deviceBindingId: saved.deviceBindingId,
        instanceId: saved.targetInstanceId,
        reportedCapabilities: outcome.capabilities,
        directoryStatus: ready ? 'ready' : 'failed',
        ...(ready ? { normalizedPwd: outcome.normalizedPath } : {}),
        statusReason: ready
          ? undefined
          : (outcome.reason ?? 'Directory or capability readiness failed.'),
      });
    }
    return operations.markPostProcessed(saved.operationId);
  }

  private async confirmEnvironmentResultIfReady(
    peer: ServerPeer,
    operationId: string,
    requestId?: string,
    resendAcknowledged = false,
  ): Promise<void> {
    const { operations } = this.environmentStores();
    const operation = operations.find(operationId);
    if (
      operation === undefined ||
      operation.resultRecordedAt === undefined ||
      operation.resultSource !== 'device' ||
      operation.postProcessedAt === undefined ||
      operation.outputGap ||
      (operation.endOffset !== undefined && operation.nextOffset !== operation.endOffset) ||
      (!resendAcknowledged && operation.resultAcknowledgedAt !== undefined)
    ) {
      return;
    }
    await peer.send({
      payload: {
        case: 'operationResultAck',
        value: {
          operationId,
          target: environmentOperationTarget(operation),
          ...(requestId === undefined ? {} : { requestId }),
        },
      },
    });
    operations.markResultAcknowledged(operationId);
  }

  private async recordEnvironmentOperationError(
    peer: ServerPeer,
    value: Extract<ReturnType<typeof decodeDaemonMessage>['payload'], { case: 'error' }>['value'],
  ): Promise<void> {
    if (peer.authentication?.environment === undefined || value.operationId === undefined) return;
    const terminalCodes: DeviceErrorCode[] = [
      DeviceErrorCode.OPERATION_UNKNOWN,
      DeviceErrorCode.OPERATION_EXPIRED,
      DeviceErrorCode.CAPABILITY_UNAVAILABLE,
      DeviceErrorCode.DIRECTORY_INVALID,
      DeviceErrorCode.PATH_INVALID,
      DeviceErrorCode.FILE_VERSION_CONFLICT,
      DeviceErrorCode.FILE_TOO_LARGE,
      DeviceErrorCode.OPERATION_CONFLICT,
      DeviceErrorCode.PERMISSION_DENIED,
      DeviceErrorCode.INVALID_MESSAGE,
    ];
    if (!terminalCodes.includes(value.code)) return;
    const { operations } = this.environmentStores();
    const existing = operations.find(value.operationId);
    if (existing === undefined) return;
    this.requireEnvironmentTarget(peer, {
      envId: existing.envId,
      deviceBindingId: existing.deviceBindingId,
      instanceId: existing.targetInstanceId,
    });
    if (existing.resultRecordedAt !== undefined) return;
    const status =
      value.code === DeviceErrorCode.OPERATION_EXPIRED
        ? OperationStatus.EXPIRED
        : value.code === DeviceErrorCode.OPERATION_UNKNOWN
          ? OperationStatus.UNKNOWN
          : OperationStatus.FAILED;
    const saved = operations.recordResult({
      operationId: value.operationId,
      envId: existing.envId,
      deviceBindingId: existing.deviceBindingId,
      targetInstanceId: existing.targetInstanceId,
      ...(existing.bindingVersion === undefined ? {} : { bindingVersion: existing.bindingVersion }),
      status,
      outcome: emptyEnvironmentOutcome(
        existing.action,
        value.message.slice(0, 500) || 'Environment operation failed.',
      ),
      observedAt: this.now(),
    });
    await this.postProcessEnvironmentResult(peer, saved);
  }

  private async revokeEnvironment(
    peer: ServerPeer,
    value: Extract<
      ReturnType<typeof decodeDaemonMessage>['payload'],
      { case: 'environmentRevoke' }
    >['value'],
  ): Promise<void> {
    const authentication = this.requireEnvironmentAuthentication(peer);
    if (
      value.envId !== authentication.environment.envId ||
      value.deviceBindingId !== authentication.environment.deviceBindingId
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.PERMISSION_DENIED,
        'Environment revocation targets another binding.',
      );
    }
    requiredText(value.requestId, 'requestId', 200);
    requiredText(value.reason, 'reason', 500);
    const { environments, operations } = this.environmentStores();
    const runtime = this.environmentConnections.get(value.deviceBindingId);
    const revoked = inTransaction(environments.database, () => {
      const current = environments.get(authentication.ownerId, value.envId);
      const result = environments.revokeForBinding({
        envId: value.envId,
        deviceBindingId: value.deviceBindingId,
        reason: value.reason,
      });
      for (const instanceId of new Set([current.instanceId, runtime?.authentication?.instanceId])) {
        if (instanceId !== undefined)
          operations.markInstanceLost(value.deviceBindingId, instanceId);
      }
      return result;
    });
    if (runtime !== undefined && runtime !== peer) {
      await this.sendFailure(
        runtime,
        new DeviceFailure(
          DeviceErrorCode.ENVIRONMENT_REVOKED,
          'The environment binding was revoked.',
          DeviceErrorAction.REAUTHENTICATE,
        ),
        true,
      );
    }
    for (const control of this.controlConnections) {
      if (
        control !== peer &&
        control.authentication?.environment.deviceBindingId === value.deviceBindingId
      ) {
        await this.sendFailure(
          control,
          new DeviceFailure(
            DeviceErrorCode.ENVIRONMENT_REVOKED,
            'The environment binding was revoked.',
            DeviceErrorAction.REAUTHENTICATE,
          ),
          true,
        );
      }
    }
    const revokedAt = revoked.environment.revokedAt;
    if (revokedAt === undefined) {
      throw new DeviceFailure(DeviceErrorCode.INTERNAL, 'Environment revocation time is missing.');
    }
    await peer.send({
      payload: {
        case: 'environmentRevokeAck',
        value: {
          requestId: value.requestId,
          envId: value.envId,
          deviceBindingId: value.deviceBindingId,
          revokedAt: timestamp(new Date(revokedAt)),
        },
      },
    });
    peer.socket.close(1000, 'Environment revoked');
  }

  private async reportEnvironmentMaintenance(
    peer: ServerPeer,
    value: Extract<
      ReturnType<typeof decodeDaemonMessage>['payload'],
      { case: 'environmentMaintenanceQuery' }
    >['value'],
  ): Promise<void> {
    const authentication = this.requireEnvironmentAuthentication(peer);
    if (
      value.envId !== authentication.environment.envId ||
      value.deviceBindingId !== authentication.environment.deviceBindingId
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.PERMISSION_DENIED,
        'Maintenance query targets another binding.',
      );
    }
    requiredText(value.requestId, 'requestId', 200);
    const { environments, operations } = this.environmentStores();
    const maintenance = environments.maintenanceForBinding({
      envId: value.envId,
      deviceBindingId: value.deviceBindingId,
    });
    await peer.send({
      payload: {
        case: 'environmentMaintenanceReport',
        value: {
          requestId: value.requestId,
          envId: value.envId,
          deviceBindingId: value.deviceBindingId,
          maintenanceMode:
            maintenance.mode === 'draining'
              ? EnvironmentMaintenanceMode.DRAINING
              : EnvironmentMaintenanceMode.NORMAL,
          maintenanceVersion: BigInt(maintenance.maintenanceVersion),
          activeOperationCount: BigInt(operations.countActiveForBinding(value.deviceBindingId)),
        },
      },
    });
  }

  private environmentStores(): {
    environments: EnvironmentStore;
    operations: EnvironmentOperationStore;
  } {
    return {
      environments: this.options.environments,
      operations: this.options.environmentOperations,
    };
  }

  private startControlSweep(): void {
    if (this.controlSweepTimer !== undefined) return;
    this.controlSweepTimer = setInterval(
      () => {
        const now = this.now().getTime();
        for (const control of this.controlConnections) {
          if (now - control.lastSeen > this.offlineAfterMilliseconds) {
            control.rejected = true;
            this.controlConnections.delete(control);
            control.socket.terminate();
          }
        }
        this.stopControlSweepIfIdle();
      },
      Math.min(this.offlineAfterMilliseconds, 1000),
    );
    this.controlSweepTimer.unref();
  }

  private stopControlSweepIfIdle(): void {
    if (this.controlConnections.size !== 0 || this.controlSweepTimer === undefined) return;
    clearInterval(this.controlSweepTimer);
    this.controlSweepTimer = undefined;
  }

  private requireEnvironmentAuthentication(peer: ServerPeer): Authentication {
    if (peer.authentication?.environment === undefined) {
      throw new DeviceFailure(
        DeviceErrorCode.PERMISSION_DENIED,
        'An authenticated environment binding is required.',
      );
    }
    return peer.authentication;
  }

  private requireEnvironmentTarget(
    peer: ServerPeer,
    target: EnvironmentTarget | undefined,
  ): asserts target is EnvironmentTarget {
    const authentication = this.requireEnvironmentAuthentication(peer);
    if (this.environmentConnections.get(authentication.environment.deviceBindingId) !== peer)
      throw new DeviceFailure(
        DeviceErrorCode.PERMISSION_DENIED,
        'A replaced environment execution connection cannot send operation receipts.',
      );
    if (
      target === undefined ||
      target.envId !== authentication.environment.envId ||
      target.deviceBindingId !== authentication.environment.deviceBindingId ||
      target.instanceId !== authentication.instanceId
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.PERMISSION_DENIED,
        'Environment operation target does not match the authenticated instance.',
      );
    }
  }

  private async handleProcessFailure(peer: ServerPeer, error: unknown): Promise<void> {
    const failure = this.asFailure(error);
    if (peer.authentication === undefined) {
      const name =
        error instanceof Error &&
        [
          'DeviceFailure',
          'SessionError',
          'ContractValidationError',
          'ZodError',
          'Error',
          'TypeError',
          'RangeError',
          'SyntaxError',
        ].includes(error.name)
          ? error.name
          : 'Error';
      const message = Array.from(
        failure.message.slice(0, 500).replace(/\b(?:ke2|kd2|ks2)_[A-Za-z0-9_-]+\b/g, '[redacted]'),
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character,
      ).join('');
      this.options.onDeviceError?.({
        name,
        code: failure.code,
        message,
        deviceId: '',
        instanceId: '',
      });
    }
    const close =
      !(error instanceof DeviceFailure) ||
      error.code !== DeviceErrorCode.OPERATION_CONFLICT ||
      peer.authentication === undefined;
    if (close) peer.rejected = true;
    await this.sendFailure(peer, failure, close);
  }

  private asFailure(error: unknown): DeviceFailure {
    if (error instanceof DeviceFailure) return error;
    if (error instanceof SessionError) {
      if (error.code === 'version_conflict') {
        return new DeviceFailure(
          DeviceErrorCode.BINDING_CONFLICT,
          error.message,
          DeviceErrorAction.REAUTHENTICATE,
        );
      }
      if (error.code === 'permission_denied' || error.code === 'unauthenticated') {
        return new DeviceFailure(
          DeviceErrorCode.PERMISSION_DENIED,
          error.message,
          DeviceErrorAction.ABORT,
        );
      }
      if (error.code === 'failed_precondition') {
        return new DeviceFailure(
          DeviceErrorCode.CAPABILITY_UNAVAILABLE,
          error.message,
          DeviceErrorAction.ABORT,
        );
      }
    }
    if (error instanceof ContractValidationError) {
      return new DeviceFailure(
        error.code === 'INCOMPATIBLE_PROTOCOL_MAJOR'
          ? DeviceErrorCode.VERSION_CONFLICT
          : DeviceErrorCode.PROTOCOL_INCOMPATIBLE,
        error.message,
        DeviceErrorAction.ABORT,
      );
    }
    return new DeviceFailure(
      DeviceErrorCode.INTERNAL,
      'Device message could not be applied.',
      DeviceErrorAction.RECONNECT,
    );
  }

  private async sendFailure(
    peer: ServerPeer,
    failure: DeviceFailure,
    close: boolean,
  ): Promise<void> {
    if (close) peer.rejected = true;
    const code: DeviceErrorCode =
      typeof failure.code === 'number' ? failure.code : DeviceErrorCode.INTERNAL;
    try {
      await peer.send({
        payload: {
          case: 'error',
          value: {
            code,
            message: failure.message,
            action: failure.action,
            ...(failure.operationId === undefined ? {} : { operationId: failure.operationId }),
          },
        },
      });
    } catch {
      peer.socket.close(1011, 'Device error delivery failed');
      return;
    }
    if (close) peer.socket.close(closeCode(failure.code), 'Device request rejected');
  }
}

function closeCode(code: DeviceErrorCode): number {
  if (code === DeviceErrorCode.VERSION_CONFLICT || code === DeviceErrorCode.PROTOCOL_INCOMPATIBLE) {
    return 1002;
  }
  return 1008;
}
