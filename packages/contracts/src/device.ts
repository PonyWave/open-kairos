import type { MessageInitShape } from '@bufbuild/protobuf';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { ContractValidationError } from './error.js';
import type {
  DaemonMessage,
  OperationStart,
  OperationTarget,
  ServerMessage,
} from './gen/kairos/device/v1/device_pb.js';
import {
  DaemonMessageSchema,
  DeviceCapability,
  DeviceErrorAction,
  DeviceErrorCode,
  EnvironmentMaintenanceMode,
  OperationStatus,
  OutputStream,
  ServerMessageSchema,
} from './gen/kairos/device/v1/device_pb.js';

export * from './error.js';
export * from './gen/kairos/device/v1/device_pb.js';

export const DEVICE_PROTOCOL_MAJOR = 1;
export const DEVICE_BASH_MAX_TIMEOUT_SECONDS = 2_147_483;
export const DEVICE_SYNC_LIMITS = {
  maxFiles: 256,
  maxEntries: 512,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  chunkBytes: 64 * 1024,
  responseBytes: 1024 * 1024,
  operationMilliseconds: 30_000,
  syncMilliseconds: 5 * 60 * 1000,
} as const;

function rejectPayload(message: string): never {
  throw new ContractValidationError('UNSUPPORTED_PAYLOAD', message);
}

function rejectMessage(message: string): never {
  throw new ContractValidationError('INVALID_MESSAGE', message);
}

function assertProtocolMajor(protocolMajor: number, location: string): void {
  if (protocolMajor !== DEVICE_PROTOCOL_MAJOR) {
    throw new ContractValidationError(
      'INCOMPATIBLE_PROTOCOL_MAJOR',
      `${location} uses incompatible protocol major ${protocolMajor}.`,
    );
  }
}

function assertOperationStatus(status: number, terminal = false): void {
  const known = Object.values(OperationStatus).some((value) => value === status);
  if (
    !known ||
    status === OperationStatus.UNSPECIFIED ||
    (terminal && status < OperationStatus.COMPLETED)
  ) {
    rejectPayload(`Operation status ${status} is not supported for this message.`);
  }
}

function assertOutputStream(stream: number): void {
  if (stream !== OutputStream.STDOUT && stream !== OutputStream.STDERR) {
    rejectPayload(`Output stream ${stream} is not supported.`);
  }
}

export function isDeviceCapability(value: number): value is DeviceCapability {
  return (
    value !== DeviceCapability.UNSPECIFIED &&
    Object.values(DeviceCapability).some((known) => known === value)
  );
}

function assertCapabilities(capabilities: readonly number[]): void {
  if (capabilities.some((capability) => !isDeviceCapability(capability))) {
    rejectPayload('Device capabilities contain an unknown or unspecified value.');
  }
}

function assertIdentifier(value: string, field: string): void {
  if (!value.trim() || value.includes('\0')) rejectMessage(`${field} must not be empty.`);
}

function assertAbsolutePath(value: string, field: string): void {
  assertIdentifier(value, field);
  if (!value.startsWith('/')) rejectMessage(`${field} must be an absolute path.`);
}

function assertTarget(
  target: OperationTarget | undefined,
  bindingVersion: 'required' | 'forbidden' | 'optional' = 'optional',
): void {
  if (!target) rejectMessage('Operation target must be present.');
  assertIdentifier(target.envId, 'OperationTarget.env_id');
  assertIdentifier(target.deviceBindingId, 'OperationTarget.device_binding_id');
  assertIdentifier(target.instanceId, 'OperationTarget.instance_id');
  if (
    bindingVersion === 'required' &&
    (target.bindingVersion === undefined || target.bindingVersion <= 0n)
  ) {
    rejectMessage('OperationTarget.binding_version must be greater than zero.');
  }
  if (bindingVersion === 'forbidden' && target.bindingVersion !== undefined) {
    rejectMessage('Directory checks must not contain an Agent binding version.');
  }
  if (target.bindingVersion !== undefined && target.bindingVersion < 0n) {
    rejectMessage('OperationTarget.binding_version must be a uint64 value.');
  }
}

function assertOperationStart(start: OperationStart): void {
  assertIdentifier(start.operationId, 'OperationStart.operation_id');
  assertIdentifier(start.requestId, 'OperationStart.request_id');
  if (!start.expiresAt) rejectMessage('OperationStart.expires_at must be present.');
  if (start.action.case === undefined) {
    rejectPayload('OperationStart must contain a supported action.');
  }
  assertTarget(
    start.target,
    ['directoryCheck', 'directoryList'].includes(start.action.case) ? 'forbidden' : 'required',
  );
  switch (start.action.case) {
    case 'read':
      assertIdentifier(start.action.value.path, 'ReadAction.path');
      assertAbsolutePath(start.action.value.cwd, 'ReadAction.cwd');
      if (
        start.action.value.offset === 0 ||
        (start.action.value.limit !== undefined &&
          (start.action.value.limit === 0 || start.action.value.limit > 2000))
      ) {
        rejectMessage('ReadAction offset starts at one and limit must be between 1 and 2000.');
      }
      break;
    case 'readImage':
      assertIdentifier(start.action.value.path, 'ReadImageAction.path');
      assertAbsolutePath(start.action.value.cwd, 'ReadImageAction.cwd');
      break;
    case 'write': {
      const value = start.action.value;
      assertIdentifier(value.path, 'WriteAction.path');
      assertAbsolutePath(value.cwd, 'WriteAction.cwd');
      if (value.transferId !== undefined) {
        assertIdentifier(value.transferId, 'WriteAction.transfer_id');
        if (
          value.binaryContent === undefined ||
          value.binaryContent.length > DEVICE_SYNC_LIMITS.chunkBytes ||
          value.offset === undefined ||
          value.totalSize === undefined ||
          value.totalSize > DEVICE_SYNC_LIMITS.maxFileBytes ||
          value.offset > value.totalSize ||
          value.offset + BigInt(value.binaryContent.length) > value.totalSize ||
          !/^[a-f0-9]{64}$/.test(value.expectedSha256 ?? '') ||
          value.executable === undefined ||
          value.createDirectory === true
        ) {
          rejectMessage('Chunked write metadata or content is invalid.');
        }
      } else if (value.createDirectory === true) {
        if (value.content || value.binaryContent !== undefined) {
          rejectMessage('Directory creation does not accept file content.');
        }
      }
      break;
    }
    case 'edit':
      assertIdentifier(start.action.value.path, 'EditAction.path');
      assertAbsolutePath(start.action.value.cwd, 'EditAction.cwd');
      assertIdentifier(start.action.value.oldText, 'EditAction.old_text');
      assertIdentifier(start.action.value.expectedFileVersion, 'EditAction.expected_file_version');
      if (
        start.action.value.expectedOccurrences !== undefined &&
        (start.action.value.expectedOccurrences === 0 ||
          start.action.value.expectedOccurrences > 1000)
      ) {
        rejectMessage('EditAction.expected_occurrences must be between 1 and 1000.');
      }
      break;
    case 'bash':
      assertIdentifier(start.action.value.command, 'BashAction.command');
      assertAbsolutePath(start.action.value.cwd, 'BashAction.cwd');
      if (
        start.action.value.timeoutSeconds === 0 ||
        start.action.value.timeoutSeconds > DEVICE_BASH_MAX_TIMEOUT_SECONDS
      ) {
        rejectMessage('BashAction.timeout_seconds exceeds the supported range.');
      }
      break;
    case 'directoryList':
      assertAbsolutePath(start.action.value.path, 'DirectoryListAction.path');
      if (
        start.action.value.limit < 1 ||
        start.action.value.limit > 200 ||
        start.action.value.offset > 10000
      )
        rejectMessage('Directory list range exceeds its limit.');
      break;
    case 'directoryCheck':
      assertAbsolutePath(start.action.value.path, 'DirectoryCheckAction.path');
      break;
    case 'syncScan': {
      const value = start.action.value;
      assertIdentifier(value.path, 'SyncScanAction.path');
      assertAbsolutePath(value.cwd, 'SyncScanAction.cwd');
      if (value.relativePaths.length > DEVICE_SYNC_LIMITS.maxEntries) {
        rejectMessage('Sync conflict scan exceeds its entry limit.');
      }
      if (value.conflictScan !== true && value.relativePaths.length > 0) {
        rejectMessage('A full sync scan does not accept relative paths.');
      }
      for (const relativePath of value.relativePaths) {
        if (
          relativePath !== '.' &&
          (!relativePath ||
            relativePath.startsWith('/') ||
            relativePath.length > 4096 ||
            relativePath.includes('\0') ||
            relativePath.split('/').some((part) => !part || part === '.' || part === '..'))
        ) {
          rejectMessage('Sync conflict scan contains an invalid relative path.');
        }
      }
      break;
    }
    case 'syncRead':
      assertIdentifier(start.action.value.path, 'SyncReadAction.path');
      assertAbsolutePath(start.action.value.cwd, 'SyncReadAction.cwd');
      if (
        start.action.value.limit < 1 ||
        start.action.value.limit > DEVICE_SYNC_LIMITS.chunkBytes
      ) {
        rejectMessage('Sync read chunk exceeds its limit.');
      }
      break;
  }
}

export function isDeviceErrorCode(value: number): value is DeviceErrorCode {
  return (
    value !== DeviceErrorCode.UNSPECIFIED &&
    Object.values(DeviceErrorCode).some((known) => known === value)
  );
}

export function isDeviceErrorAction(value: number): value is DeviceErrorAction {
  return (
    value !== DeviceErrorAction.UNSPECIFIED &&
    Object.values(DeviceErrorAction).some((known) => known === value)
  );
}

function assertDeviceError(code: number, action: number): void {
  if (!isDeviceErrorCode(code) || !isDeviceErrorAction(action)) {
    rejectPayload(`Device error code ${code} or action ${action} is not supported.`);
  }
}

export function decodeDaemonMessage(data: Uint8Array): DaemonMessage {
  const message = fromBinary(DaemonMessageSchema, data);
  assertProtocolMajor(message.protocolMajor, 'DaemonMessage');
  if (message.payload.case === undefined) {
    rejectPayload('DaemonMessage must contain a supported payload.');
  }
  switch (message.payload.case) {
    case 'deviceHello':
      assertProtocolMajor(message.payload.value.protocolMajor, 'DeviceHello');
      if (
        message.payload.value.controlOnly &&
        (message.payload.value.authentication.case !== 'deviceCredential' ||
          message.payload.value.capabilities.length !== 0)
      ) {
        rejectPayload(
          'Control-only DeviceHello requires an existing credential and no capabilities.',
        );
      }
      if (message.payload.value.authentication.case === undefined) {
        rejectPayload('DeviceHello must contain a supported authentication method.');
      }
      assertCapabilities(message.payload.value.capabilities);
      break;
    case 'operationAccepted':
      assertOperationStatus(message.payload.value.status);
      assertTarget(message.payload.value.target);
      break;
    case 'operationState':
      assertOperationStatus(message.payload.value.status);
      assertTarget(message.payload.value.target);
      break;
    case 'operationOutputChunk':
      assertOutputStream(message.payload.value.stream);
      assertTarget(message.payload.value.target);
      break;
    case 'operationResult': {
      const result = message.payload.value;
      assertOperationStatus(result.status, true);
      assertTarget(result.target);
      if (result.outcome.case === undefined) {
        rejectPayload('OperationResult must contain a supported outcome.');
      }
      if (result.outcome.case === 'directoryCheck') {
        assertCapabilities(result.outcome.value.capabilities);
      }
      if (result.outcome.case === 'readImage') {
        const value = result.outcome.value;
        if (
          !value.path ||
          value.path.length > 4096 ||
          value.path.includes('\0') ||
          value.data.length > 700_000 ||
          (result.status === OperationStatus.COMPLETED &&
            (value.data.length === 0 || !/^[a-f0-9]{64}$/.test(value.fileVersion)))
        ) {
          rejectMessage('Image read result exceeds its limits.');
        }
      }
      if (result.outcome.case === 'directoryList') {
        const value = result.outcome.value;
        if (
          !value.normalizedPath.startsWith('/') ||
          value.normalizedPath.length > 4096 ||
          value.normalizedPath.includes('\0') ||
          value.entries.length > 200 ||
          (value.reason?.length ?? 0) > 500
        )
          rejectMessage('Directory list result exceeds its limits.');
        for (const entry of value.entries) {
          if (
            !entry.name ||
            entry.name === '.' ||
            entry.name === '..' ||
            entry.name.includes('/') ||
            entry.name.includes('\0') ||
            entry.name.length > 1024 ||
            !entry.name.isWellFormed() ||
            entry.path.length > 4096 ||
            entry.path !==
              `${value.normalizedPath === '/' ? '' : value.normalizedPath}/${entry.name}`
          )
            rejectMessage('Directory entry is invalid.');
        }
        if (
          (value.hasMore &&
            (!value.entries.length ||
              value.nextOffset === undefined ||
              value.nextOffset > 10000)) ||
          (!value.hasMore && value.nextOffset !== undefined) ||
          new TextEncoder().encode(JSON.stringify(value)).byteLength > 192 * 1024
        )
          rejectMessage('Directory list pagination or size is invalid.');
      }
      if (result.outcome.case === 'syncScan') {
        const value = result.outcome.value;
        const fullScan = !value.conflictScan;
        if (
          !value.path.startsWith('/') ||
          value.path.length > 4096 ||
          value.path.includes('\0') ||
          value.kind < 0 ||
          value.kind > 5 ||
          (result.status === OperationStatus.COMPLETED && value.kind < 1) ||
          (fullScan && value.size > DEVICE_SYNC_LIMITS.maxFileBytes) ||
          value.entries.length > DEVICE_SYNC_LIMITS.maxEntries ||
          (value.reason?.length ?? 0) > 500 ||
          (value.kind === 2 &&
            value.size <= DEVICE_SYNC_LIMITS.maxFileBytes &&
            !/^[a-f0-9]{64}$/.test(value.sha256)) ||
          (value.kind === 2 && value.sha256.length > 0 && !/^[a-f0-9]{64}$/.test(value.sha256))
        ) {
          rejectMessage('Sync scan result exceeds its limits.');
        }
        let files = value.kind === 2 ? 1 : 0;
        let totalBytes = value.kind === 2 ? value.size : 0n;
        for (const entry of value.entries) {
          if (
            !entry.relativePath ||
            entry.relativePath.startsWith('/') ||
            entry.relativePath.length > 4096 ||
            entry.relativePath.includes('\0') ||
            entry.relativePath.split('/').some((part) => !part || part === '.' || part === '..') ||
            entry.kind < 2 ||
            entry.kind > 5 ||
            (fullScan && entry.size > DEVICE_SYNC_LIMITS.maxFileBytes) ||
            (entry.kind === 2 &&
              entry.size <= DEVICE_SYNC_LIMITS.maxFileBytes &&
              !/^[a-f0-9]{64}$/.test(entry.sha256)) ||
            (entry.kind === 2 && entry.sha256.length > 0 && !/^[a-f0-9]{64}$/.test(entry.sha256))
          ) {
            rejectMessage('Sync scan entry is invalid.');
          }
          if (entry.kind === 2) {
            files += 1;
            totalBytes += entry.size;
          }
        }
        if (
          fullScan &&
          (files > DEVICE_SYNC_LIMITS.maxFiles || totalBytes > DEVICE_SYNC_LIMITS.maxTotalBytes)
        ) {
          rejectMessage('Sync scan exceeds file or byte limits.');
        }
        const responseBytes = new TextEncoder().encode(
          JSON.stringify(value, (_key, entry: unknown) =>
            typeof entry === 'bigint' ? entry.toString() : entry,
          ),
        ).byteLength;
        if (responseBytes > DEVICE_SYNC_LIMITS.responseBytes) {
          rejectMessage('Sync scan response exceeds its byte limit.');
        }
      }
      if (result.outcome.case === 'syncRead') {
        const value = result.outcome.value;
        if (
          !value.path.startsWith('/') ||
          value.path.length > 4096 ||
          value.data.length > DEVICE_SYNC_LIMITS.chunkBytes ||
          value.size > DEVICE_SYNC_LIMITS.maxFileBytes ||
          (result.status === OperationStatus.COMPLETED &&
            value.offset + BigInt(value.data.length) > value.size) ||
          (value.reason?.length ?? 0) > 500
        ) {
          rejectMessage('Sync read result exceeds its limits.');
        }
      }
      break;
    }
    case 'environmentRevoke':
      assertIdentifier(message.payload.value.requestId, 'EnvironmentRevoke.request_id');
      assertIdentifier(message.payload.value.envId, 'EnvironmentRevoke.env_id');
      assertIdentifier(
        message.payload.value.deviceBindingId,
        'EnvironmentRevoke.device_binding_id',
      );
      break;
    case 'environmentMaintenanceQuery':
      assertIdentifier(message.payload.value.requestId, 'EnvironmentMaintenanceQuery.request_id');
      assertIdentifier(message.payload.value.envId, 'EnvironmentMaintenanceQuery.env_id');
      assertIdentifier(
        message.payload.value.deviceBindingId,
        'EnvironmentMaintenanceQuery.device_binding_id',
      );
      break;
    case 'error':
      assertDeviceError(message.payload.value.code, message.payload.value.action);
      break;
    default:
      break;
  }
  return message;
}

export function decodeServerMessage(data: Uint8Array): ServerMessage {
  const message = fromBinary(ServerMessageSchema, data);
  assertProtocolMajor(message.protocolMajor, 'ServerMessage');
  if (message.payload.case === undefined) {
    rejectPayload('ServerMessage must contain a supported payload.');
  }
  switch (message.payload.case) {
    case 'serverHello':
      assertProtocolMajor(message.payload.value.protocolMajor, 'ServerHello');
      if (
        message.payload.value.controlOnly &&
        (message.payload.value.capabilities.length !== 0 ||
          message.payload.value.deviceCredential !== undefined)
      ) {
        rejectPayload('Control-only ServerHello must not grant capabilities or issue credentials.');
      }
      assertCapabilities(message.payload.value.capabilities);
      break;
    case 'operationStart':
      assertOperationStart(message.payload.value);
      break;
    case 'operationQuery':
    case 'operationCancel':
    case 'operationOutputAck':
    case 'operationResultAck':
      assertTarget(message.payload.value.target);
      break;
    case 'environmentRevokeAck':
      assertIdentifier(message.payload.value.requestId, 'EnvironmentRevokeAck.request_id');
      assertIdentifier(message.payload.value.envId, 'EnvironmentRevokeAck.env_id');
      assertIdentifier(
        message.payload.value.deviceBindingId,
        'EnvironmentRevokeAck.device_binding_id',
      );
      if (!message.payload.value.revokedAt) {
        rejectMessage('EnvironmentRevokeAck.revoked_at must be present.');
      }
      break;
    case 'environmentMaintenanceReport':
      assertIdentifier(message.payload.value.requestId, 'EnvironmentMaintenanceReport.request_id');
      assertIdentifier(message.payload.value.envId, 'EnvironmentMaintenanceReport.env_id');
      assertIdentifier(
        message.payload.value.deviceBindingId,
        'EnvironmentMaintenanceReport.device_binding_id',
      );
      if (
        message.payload.value.maintenanceMode !== EnvironmentMaintenanceMode.NORMAL &&
        message.payload.value.maintenanceMode !== EnvironmentMaintenanceMode.DRAINING
      ) {
        rejectPayload('EnvironmentMaintenanceReport.maintenance_mode is not supported.');
      }
      break;
    case 'error':
      assertDeviceError(message.payload.value.code, message.payload.value.action);
      break;
    default:
      break;
  }
  return message;
}

export type DaemonMessageInit = Omit<
  Exclude<MessageInitShape<typeof DaemonMessageSchema>, DaemonMessage>,
  'protocolMajor' | '$typeName'
>;
export type ServerMessageInit = Omit<
  Exclude<MessageInitShape<typeof ServerMessageSchema>, ServerMessage>,
  'protocolMajor' | '$typeName'
>;

export function encodeDaemonMessage(init: DaemonMessageInit): Uint8Array {
  return toBinary(
    DaemonMessageSchema,
    create(DaemonMessageSchema, { ...init, protocolMajor: DEVICE_PROTOCOL_MAJOR }),
  );
}

export function encodeServerMessage(init: ServerMessageInit): Uint8Array {
  return toBinary(
    ServerMessageSchema,
    create(ServerMessageSchema, { ...init, protocolMajor: DEVICE_PROTOCOL_MAJOR }),
  );
}
