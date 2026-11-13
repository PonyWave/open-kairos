import { createHash } from 'node:crypto';
import type { WriteStream } from 'node:fs';
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  OutputStream,
  OperationResult as ProtocolOperationResult,
  OperationStart as ProtocolOperationStart,
  OperationTarget as ProtocolOperationTarget,
} from '@kairos/contracts/device';
import {
  BASH_MAX_TIMEOUT_SECONDS,
  DEVICE_SYNC_LIMITS,
  DeviceErrorAction,
  DeviceErrorCode,
  decodeDaemonMessage,
  encodeDaemonMessage,
  GrepMode,
  OperationStatus,
} from '@kairos/contracts/device';
import { z } from 'zod';
import { environmentOperationMigrations } from '../storage/device-migrations.js';
import { migrateDatabase } from '../storage/migrations.js';
import { assertServerDatabaseCompatible } from '../storage/server-schema.js';
import { inTransaction } from '../storage/transaction.js';
import { DeviceFailure } from './errors.js';

export { environmentOperationMigrations } from '../storage/device-migrations.js';

const UINT64_KEY_LENGTH = 20;
export const ENVIRONMENT_OPERATION_OUTPUT_RETAINED_BYTES = 16 * 1024;
export const BASH_OUTPUT_LOG_MAX_BYTES = 64 * 1024 * 1024;
const BASH_OUTPUT_LOG_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const ZERO_OFFSET = '0'.repeat(UINT64_KEY_LENGTH);
const MAX_UINT64 = 1n << 64n;

const operationRowSchema = z.object({
  operation_id: z.string(),
  tenant_id: z.string(),
  env_id: z.string(),
  device_id: z.string(),
  device_binding_id: z.string(),
  target_instance_id: z.string(),
  binding_version: z.string().nullable(),
  action: z.enum([
    'read',
    'read_image',
    'write',
    'edit',
    'bash',
    'directory_check',
    'directory_list',
  ]),
  fingerprint: z.string(),
  path: z.string().nullable(),
  cwd: z.string().nullable(),
  read_offset: z.number().int().nullable(),
  read_limit: z.number().int().nullable(),
  content: z.string().nullable(),
  binary_content: z.instanceof(Uint8Array).nullable(),
  overwrite: z.number().int().min(0).max(1).nullable(),
  create_parents: z.number().int().min(0).max(1).nullable(),
  sync_action: z.enum(['sync_scan', 'sync_read', 'sync_write', 'sync_directory']).nullable(),
  sync_offset: z.string().nullable(),
  transfer_id: z.string().nullable(),
  total_size: z.string().nullable(),
  executable: z.number().int().min(0).max(1).nullable(),
  create_directory: z.number().int().min(0).max(1).nullable(),
  conflict_scan: z.number().int().min(0).max(1).nullable(),
  relative_paths_json: z.string().nullable(),
  search_action: z.enum(['glob', 'grep']).nullable(),
  pattern: z.string().nullable(),
  include_glob: z.string().nullable(),
  grep_mode: z.enum(['content', 'files_with_matches', 'count']).nullable(),
  case_insensitive: z.number().int().min(0).max(1).nullable(),
  line_numbers: z.number().int().min(0).max(1).nullable(),
  search_offset: z.number().int().nullable(),
  search_limit: z.number().int().nullable(),
  old_text: z.string().nullable(),
  new_text: z.string().nullable(),
  expected_occurrences: z.number().int().nullable(),
  expected_file_version: z.string().nullable(),
  command: z.string().nullable(),
  timeout_seconds: z.number().int().nullable(),
  load_workspace: z.number().int().min(0).max(1).nullable(),
  delivery_state: z.enum(['intent', 'sent']),
  status: z.number().int().min(1).max(9),
  cancel_requested: z.number().int().min(0).max(1),
  cancel_reason: z.string().nullable(),
  next_offset: z.string().length(UINT64_KEY_LENGTH),
  expires_at: z.string(),
  accepted_at: z.string().nullable(),
  sent_at: z.string().nullable(),
  result_status: z.number().int().min(5).max(9).nullable(),
  result_payload: z.instanceof(Uint8Array).nullable(),
  result_fingerprint: z.string().nullable(),
  device_output_complete: z.number().int().min(0).max(1).nullable(),
  result_end_offset: z.string().length(UINT64_KEY_LENGTH).nullable(),
  output_complete: z.number().int().min(0).max(1),
  output_gap: z.number().int().min(0).max(1),
  result_source: z.enum(['device', 'recovery']).nullable(),
  result_recorded_at: z.string().nullable(),
  post_processed_at: z.string().nullable(),
  result_acknowledged_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const chunkRowSchema = z.object({
  operation_id: z.string(),
  offset: z.string().length(UINT64_KEY_LENGTH),
  end_offset: z.string().length(UINT64_KEY_LENGTH),
  stream: z.number().int().min(1).max(2),
  data: z.instanceof(Uint8Array),
});

type OperationRow = z.infer<typeof operationRowSchema>;
type ChunkRow = z.infer<typeof chunkRowSchema>;
type ProtocolData<T> = T extends Uint8Array
  ? T
  : T extends readonly (infer Item)[]
    ? ProtocolData<Item>[]
    : T extends object
      ? { [Key in keyof T as Key extends '$typeName' ? never : Key]: ProtocolData<T[Key]> }
      : T;
type EnvironmentOperationActionCase =
  | 'read'
  | 'readImage'
  | 'write'
  | 'edit'
  | 'bash'
  | 'directoryCheck'
  | 'directoryList'
  | 'syncScan'
  | 'syncRead'
  | 'glob'
  | 'grep';
export type EnvironmentOperationAction = ProtocolData<
  Extract<ProtocolOperationStart['action'], { case: EnvironmentOperationActionCase }>
>;
export type EnvironmentOperationOutcome = ProtocolData<
  Extract<ProtocolOperationResult['outcome'], { case: EnvironmentOperationActionCase }>
>;
type OperationResult = Omit<ProtocolData<ProtocolOperationResult>, 'outcome'> & {
  outcome: EnvironmentOperationOutcome;
};
type OperationTarget = ProtocolData<ProtocolOperationTarget>;

export interface EnvironmentOperationRecord {
  operationId: string;
  tenantId: string;
  envId: string;
  deviceId: string;
  deviceBindingId: string;
  targetInstanceId: string;
  bindingVersion?: bigint;
  action: EnvironmentOperationAction;
  deliveryState: 'intent' | 'sent';
  status: OperationStatus;
  cancelRequested: boolean;
  cancelReason?: string;
  nextOffset: bigint;
  expiresAt: string;
  acceptedAt?: string;
  sentAt?: string;
  resultStatus?: OperationStatus;
  outcome?: EnvironmentOperationOutcome;
  deviceOutputComplete?: boolean;
  endOffset?: bigint;
  outputComplete: boolean;
  outputGap: boolean;
  resultSource?: 'device' | 'recovery';
  resultRecordedAt?: string;
  postProcessedAt?: string;
  resultAcknowledgedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentOutputRecord {
  operationId: string;
  offset: bigint;
  endOffset: bigint;
  stream: OutputStream;
  data: Uint8Array;
}

export type CreateEnvironmentOperationInput = {
  operationId: string;
  tenantId: string;
  envId: string;
  deviceId: string;
  deviceBindingId: string;
  targetInstanceId: string;
  bindingVersion?: bigint;
  expiresAt: Date;
} & (
  | { action: EnvironmentOperationAction; path?: undefined; loadWorkspace?: undefined }
  | { action?: undefined; path: string; loadWorkspace: boolean }
);

export interface EnvironmentOperationTargetInput {
  operationId: string;
  envId: string;
  deviceBindingId: string;
  targetInstanceId: string;
  bindingVersion?: bigint;
}

export interface EnvironmentOperationResultInput extends EnvironmentOperationTargetInput {
  status: OperationStatus;
  outcome: EnvironmentOperationOutcome;
  observedAt: Date;
  requestId?: string;
  source?: 'device' | 'recovery';
}

function requiredText(value: string, field: string, maximum: number): void {
  if (value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new DeviceFailure(
      DeviceErrorCode.INVALID_MESSAGE,
      `${field} must contain between 1 and ${maximum} characters.`,
    );
  }
}

function optionalBindingVersion(value: bigint | undefined): string | null {
  if (value === undefined) return null;
  if (value <= 0n || value >= MAX_UINT64) {
    throw new DeviceFailure(
      DeviceErrorCode.INVALID_MESSAGE,
      'Agent binding version must be a positive uint64 value.',
    );
  }
  return value.toString();
}

function offsetKey(offset: bigint): string {
  if (offset < 0n || offset >= MAX_UINT64) {
    throw new DeviceFailure(
      DeviceErrorCode.INVALID_MESSAGE,
      'Output offset is outside uint64 range.',
    );
  }
  return offset.toString().padStart(UINT64_KEY_LENGTH, '0');
}

function keyOffset(value: string): bigint {
  return BigInt(value);
}

function maximumOffset(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function minimumOffset(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Uint8Array) {
    return JSON.stringify({ $bytes: createHash('sha256').update(value).digest('hex') });
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, entry]) => !key.startsWith('$') && entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function timestamp(date: Date): { seconds: bigint; nanos: number } {
  const milliseconds = date.getTime();
  return {
    seconds: BigInt(Math.floor(milliseconds / 1000)),
    nanos: (milliseconds % 1000) * 1_000_000,
  };
}

function targetOf(input: CreateEnvironmentOperationInput): OperationTarget {
  return {
    envId: input.envId,
    deviceBindingId: input.deviceBindingId,
    instanceId: input.targetInstanceId,
    ...(input.bindingVersion === undefined ? {} : { bindingVersion: input.bindingVersion }),
  };
}

function operationAction(input: CreateEnvironmentOperationInput): EnvironmentOperationAction {
  if (input.action !== undefined) return input.action;
  return {
    case: 'directoryCheck',
    value: { path: input.path, loadWorkspace: input.loadWorkspace },
  };
}

function intentFingerprint(input: CreateEnvironmentOperationInput): string {
  return fingerprint({
    tenantId: input.tenantId,
    target: targetOf(input),
    action: operationAction(input),
    expiresAt: input.expiresAt.toISOString(),
  });
}

function validateAction(
  action: EnvironmentOperationAction,
  bindingVersion: bigint | undefined,
): void {
  if (action.case === 'directoryList') {
    if (
      bindingVersion !== undefined ||
      !action.value.path.startsWith('/') ||
      action.value.limit < 1 ||
      action.value.limit > 200 ||
      action.value.offset > 10000
    )
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Directory list target or range is invalid.',
      );
    requiredText(action.value.path, 'path', 4096);
    return;
  }
  if (action.case === 'directoryCheck') {
    if (bindingVersion !== undefined) {
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Directory checks do not accept an Agent binding version.',
      );
    }
    requiredText(action.value.path, 'path', 4096);
    if (!action.value.path.startsWith('/')) {
      throw new DeviceFailure(
        DeviceErrorCode.DIRECTORY_INVALID,
        'Directory path must be absolute.',
      );
    }
    return;
  }
  if (bindingVersion === undefined) {
    throw new DeviceFailure(
      DeviceErrorCode.INVALID_MESSAGE,
      'Remote file and Bash operations require an Agent binding version.',
    );
  }
  if (action.case !== 'bash') {
    requiredText(action.value.path, 'path', 4096);
    requiredText(action.value.cwd, 'cwd', 4096);
    if (
      !action.value.cwd.startsWith('/') ||
      (action.case !== 'read' &&
        action.case !== 'readImage' &&
        action.case !== 'write' &&
        action.case !== 'edit' &&
        !action.value.path.startsWith('/'))
    ) {
      throw new DeviceFailure(DeviceErrorCode.PATH_INVALID, 'Operation paths must be absolute.');
    }
  }
  switch (action.case) {
    case 'read':
      if (
        action.value.offset === 0 ||
        (action.value.limit !== undefined &&
          (action.value.limit === 0 || action.value.limit > 2000))
      ) {
        throw new DeviceFailure(DeviceErrorCode.INVALID_MESSAGE, 'Read line range is invalid.');
      }
      break;
    case 'glob': {
      const value = action.value;
      requiredText(value.pattern, 'pattern', 4096);
      if (
        value.pattern.length === 0 ||
        (value.headLimit !== undefined && (value.headLimit < 1 || value.headLimit > 1000)) ||
        (value.offset !== undefined && value.offset > 100_000)
      ) {
        throw new DeviceFailure(DeviceErrorCode.INVALID_MESSAGE, 'Glob range is invalid.');
      }
      break;
    }
    case 'grep': {
      const value = action.value;
      requiredText(value.pattern, 'pattern', 4096);
      if (value.include !== undefined) requiredText(value.include, 'include', 4096);
      if (
        value.pattern.length === 0 ||
        (value.headLimit !== undefined && (value.headLimit < 1 || value.headLimit > 1000)) ||
        (value.offset !== undefined && value.offset > 100_000) ||
        grepModeColumn[value.mode] === undefined
      ) {
        throw new DeviceFailure(DeviceErrorCode.INVALID_MESSAGE, 'Grep parameters are invalid.');
      }
      break;
    }
    case 'readImage':
      break;
    case 'syncScan': {
      const value = action.value;
      if (
        value.relativePaths.length > DEVICE_SYNC_LIMITS.maxEntries ||
        (value.conflictScan !== true && value.relativePaths.length > 0)
      ) {
        throw new DeviceFailure(DeviceErrorCode.INVALID_MESSAGE, 'Sync scan paths are invalid.');
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
          throw new DeviceFailure(
            DeviceErrorCode.INVALID_MESSAGE,
            'Sync conflict relative path is invalid.',
          );
        }
      }
      break;
    }
    case 'syncRead':
      if (
        action.value.offset < 0n ||
        action.value.limit < 1 ||
        action.value.limit > DEVICE_SYNC_LIMITS.chunkBytes
      ) {
        throw new DeviceFailure(DeviceErrorCode.INVALID_MESSAGE, 'Sync read range is invalid.');
      }
      break;
    case 'write': {
      const value = action.value;
      if (value.createDirectory === true) {
        if (value.transferId !== undefined || value.content || value.binaryContent !== undefined) {
          throw new DeviceFailure(
            DeviceErrorCode.INVALID_MESSAGE,
            'Directory creation does not accept file transfer content.',
          );
        }
        break;
      }
      if (value.transferId !== undefined) {
        requiredText(value.transferId, 'transferId', 200);
        const bytes = value.binaryContent;
        if (
          bytes === undefined ||
          value.content.length > 0 ||
          value.offset === undefined ||
          value.totalSize === undefined ||
          value.expectedSha256 === undefined ||
          value.executable === undefined ||
          bytes.length > DEVICE_SYNC_LIMITS.chunkBytes ||
          value.totalSize > DEVICE_SYNC_LIMITS.maxFileBytes ||
          value.offset > value.totalSize ||
          value.offset + BigInt(bytes.length) > value.totalSize ||
          !/^[a-f0-9]{64}$/.test(value.expectedSha256)
        ) {
          throw new DeviceFailure(
            DeviceErrorCode.INVALID_MESSAGE,
            'Chunked write metadata or content is invalid.',
          );
        }
        break;
      }
      const binary = value.binaryContent;
      if (binary !== undefined) {
        if (value.content.length > 0) {
          throw new DeviceFailure(
            DeviceErrorCode.INVALID_MESSAGE,
            'Write text and binary content are mutually exclusive.',
          );
        }
        if (binary.length === 0) {
          throw new DeviceFailure(
            DeviceErrorCode.INVALID_MESSAGE,
            'Binary write content must not be empty.',
          );
        }
        if (binary.length > 700_000) {
          throw new DeviceFailure(
            DeviceErrorCode.FILE_TOO_LARGE,
            'Binary write content exceeds 700000 bytes.',
          );
        }
      } else if (Buffer.byteLength(value.content) > 512 * 1024) {
        throw new DeviceFailure(DeviceErrorCode.FILE_TOO_LARGE, 'Write content exceeds 512 KiB.');
      }
      break;
    }
    case 'edit':
      requiredText(action.value.oldText, 'oldText', 512 * 1024);
      requiredText(action.value.expectedFileVersion, 'expectedFileVersion', 64);
      if (!/^[a-f0-9]{64}$/.test(action.value.expectedFileVersion)) {
        throw new DeviceFailure(
          DeviceErrorCode.INVALID_MESSAGE,
          'Expected file version is invalid.',
        );
      }
      if (
        action.value.expectedOccurrences !== undefined &&
        (action.value.expectedOccurrences === 0 || action.value.expectedOccurrences > 1000)
      ) {
        throw new DeviceFailure(
          DeviceErrorCode.INVALID_MESSAGE,
          'Expected occurrence count is invalid.',
        );
      }
      if (Buffer.byteLength(action.value.newText) > 512 * 1024) {
        throw new DeviceFailure(
          DeviceErrorCode.FILE_TOO_LARGE,
          'Edit replacement exceeds 512 KiB.',
        );
      }
      break;
    case 'bash':
      requiredText(action.value.command, 'command', 64 * 1024);
      requiredText(action.value.cwd, 'cwd', 4096);
      if (!action.value.cwd.startsWith('/')) {
        throw new DeviceFailure(DeviceErrorCode.PATH_INVALID, 'Operation cwd must be absolute.');
      }
      if (
        !Number.isSafeInteger(action.value.timeoutSeconds) ||
        action.value.timeoutSeconds <= 0 ||
        action.value.timeoutSeconds > BASH_MAX_TIMEOUT_SECONDS
      ) {
        throw new DeviceFailure(DeviceErrorCode.INVALID_MESSAGE, 'Bash timeout is invalid.');
      }
      break;
  }
}

function requiredColumn<T>(value: T | null, field: string): T {
  if (value === null) throw new Error(`Persisted environment operation is missing ${field}.`);
  return value;
}

function toAction(row: OperationRow): EnvironmentOperationAction {
  if (row.sync_action === 'sync_scan') {
    return {
      case: 'syncScan',
      value: {
        path: requiredColumn(row.path, 'path'),
        cwd: requiredColumn(row.cwd, 'cwd'),
        ...(row.conflict_scan === null ? {} : { conflictScan: row.conflict_scan === 1 }),
        relativePaths:
          row.relative_paths_json === null
            ? []
            : z.array(z.string()).parse(JSON.parse(row.relative_paths_json)),
      },
    };
  }
  if (row.sync_action === 'sync_read') {
    return {
      case: 'syncRead',
      value: {
        path: requiredColumn(row.path, 'path'),
        cwd: requiredColumn(row.cwd, 'cwd'),
        offset: BigInt(requiredColumn(row.sync_offset, 'sync_offset')),
        limit: requiredColumn(row.read_limit, 'read_limit'),
      },
    };
  }
  if (row.search_action === 'glob') {
    return {
      case: 'glob',
      value: {
        pattern: requiredColumn(row.pattern, 'pattern'),
        path: requiredColumn(row.path, 'path'),
        cwd: requiredColumn(row.cwd, 'cwd'),
        ...(row.search_limit === null ? {} : { headLimit: row.search_limit }),
        ...(row.search_offset === null ? {} : { offset: row.search_offset }),
      },
    };
  }
  if (row.search_action === 'grep') {
    return {
      case: 'grep',
      value: {
        pattern: requiredColumn(row.pattern, 'pattern'),
        path: requiredColumn(row.path, 'path'),
        cwd: requiredColumn(row.cwd, 'cwd'),
        ...(row.include_glob === null ? {} : { include: row.include_glob }),
        caseInsensitive: row.case_insensitive === 1,
        mode: grepModeValue[requiredColumn(row.grep_mode, 'grep_mode')],
        lineNumbers: row.line_numbers === 1,
        ...(row.search_limit === null ? {} : { headLimit: row.search_limit }),
        ...(row.search_offset === null ? {} : { offset: row.search_offset }),
      },
    };
  }
  switch (row.action) {
    case 'directory_list':
      return {
        case: 'directoryList',
        value: {
          path: requiredColumn(row.path, 'path'),
          offset: requiredColumn(row.read_offset, 'read_offset'),
          limit: requiredColumn(row.read_limit, 'read_limit'),
        },
      };
    case 'directory_check':
      return {
        case: 'directoryCheck',
        value: {
          path: requiredColumn(row.path, 'path'),
          loadWorkspace: requiredColumn(row.load_workspace, 'load_workspace') === 1,
        },
      };
    case 'read':
      return {
        case: 'read',
        value: {
          path: requiredColumn(row.path, 'path'),
          cwd: requiredColumn(row.cwd, 'cwd'),
          ...(row.read_offset === null ? {} : { offset: row.read_offset }),
          ...(row.read_limit === null ? {} : { limit: row.read_limit }),
        },
      };
    case 'read_image':
      return {
        case: 'readImage',
        value: {
          path: requiredColumn(row.path, 'path'),
          cwd: requiredColumn(row.cwd, 'cwd'),
        },
      };
    case 'write':
      return {
        case: 'write',
        value: {
          path: requiredColumn(row.path, 'path'),
          cwd: requiredColumn(row.cwd, 'cwd'),
          content: requiredColumn(row.content, 'content'),
          overwrite: requiredColumn(row.overwrite, 'overwrite') === 1,
          ...(row.binary_content === null ? {} : { binaryContent: row.binary_content }),
          ...(row.create_parents === null ? {} : { createParents: row.create_parents === 1 }),
          ...(row.transfer_id === null ? {} : { transferId: row.transfer_id }),
          ...(row.sync_offset === null ? {} : { offset: BigInt(row.sync_offset) }),
          ...(row.total_size === null ? {} : { totalSize: BigInt(row.total_size) }),
          ...(row.expected_file_version === null
            ? {}
            : { expectedSha256: row.expected_file_version }),
          ...(row.executable === null ? {} : { executable: row.executable === 1 }),
          ...(row.create_directory === null ? {} : { createDirectory: row.create_directory === 1 }),
        },
      };
    case 'edit':
      return {
        case: 'edit',
        value: {
          path: requiredColumn(row.path, 'path'),
          cwd: requiredColumn(row.cwd, 'cwd'),
          oldText: requiredColumn(row.old_text, 'old_text'),
          newText: requiredColumn(row.new_text, 'new_text'),
          ...(row.expected_occurrences === null
            ? {}
            : { expectedOccurrences: row.expected_occurrences }),
          expectedFileVersion: requiredColumn(row.expected_file_version, 'expected_file_version'),
        },
      };
    case 'bash':
      return {
        case: 'bash',
        value: {
          command: requiredColumn(row.command, 'command'),
          cwd: requiredColumn(row.cwd, 'cwd'),
          timeoutSeconds: requiredColumn(row.timeout_seconds, 'timeout_seconds'),
        },
      };
  }
}

export function emptyEnvironmentOutcome(
  action: EnvironmentOperationAction,
  reason?: string,
): EnvironmentOperationOutcome {
  switch (action.case) {
    case 'directoryList':
      return {
        case: 'directoryList',
        value: {
          normalizedPath: action.value.path,
          entries: [],
          hasMore: false,
          ...(reason === undefined ? {} : { reason }),
        },
      };
    case 'directoryCheck':
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
          ...(reason === undefined ? {} : { reason }),
        },
      };
    case 'read':
      return {
        case: 'read',
        value: {
          path: action.value.path,
          content: '',
          startLine: 0,
          endLine: 0,
          hasMore: false,
          fileVersion: '',
          truncated: false,
        },
      };
    case 'readImage':
      return {
        case: 'readImage',
        value: { path: action.value.path, data: new Uint8Array(), fileVersion: '' },
      };
    case 'syncScan':
      return {
        case: 'syncScan',
        value: {
          path: action.value.path,
          kind: 0,
          size: 0n,
          sha256: '',
          executable: false,
          conflictScan: action.value.conflictScan === true,
          entries: [],
          ...(reason === undefined ? {} : { reason }),
        },
      };
    case 'syncRead':
      return {
        case: 'syncRead',
        value: {
          path: action.value.path,
          offset: action.value.offset,
          data: new Uint8Array(),
          size: 0n,
          executable: false,
          ...(reason === undefined ? {} : { reason }),
        },
      };
    case 'glob':
      return {
        case: 'glob',
        value: {
          path: action.value.path,
          files: [],
          truncated: false,
          ...(reason === undefined ? {} : { reason }),
        },
      };
    case 'grep':
      return {
        case: 'grep',
        value: {
          path: action.value.path,
          matches: [],
          files: [],
          counts: [],
          truncated: false,
          ...(reason === undefined ? {} : { reason }),
        },
      };
    case 'write':
      return {
        case: 'write',
        value: { path: action.value.path, bytesWritten: 0n, fileVersion: '' },
      };
    case 'edit':
      return {
        case: 'edit',
        value: { path: action.value.path, replacements: 0, bytesWritten: 0n, fileVersion: '' },
      };
    case 'bash':
      return { case: 'bash', value: { outputComplete: false } };
  }
}

function readOperation(database: DatabaseSync, operationId: string): OperationRow | undefined {
  const row = database
    .prepare('SELECT * FROM environment_operations WHERE operation_id = ?')
    .get(operationId);
  return row === undefined ? undefined : operationRowSchema.parse(row);
}

function requireOperation(database: DatabaseSync, operationId: string): OperationRow {
  const row = readOperation(database, operationId);
  if (row === undefined) {
    throw new DeviceFailure(
      DeviceErrorCode.OPERATION_UNKNOWN,
      'Environment operation is unknown.',
      DeviceErrorAction.QUERY_OPERATION,
      operationId,
    );
  }
  return row;
}

function decodeResult(row: OperationRow): OperationResult | undefined {
  if (row.result_payload === null) return undefined;
  const message = decodeDaemonMessage(row.result_payload);
  if (
    message.payload.case !== 'operationResult' ||
    message.payload.value.outcome.case === undefined
  ) {
    throw new Error('Persisted environment result has an invalid payload.');
  }
  return { ...message.payload.value, outcome: message.payload.value.outcome };
}

function toOperation(row: OperationRow): EnvironmentOperationRecord {
  const result = decodeResult(row);
  return {
    operationId: row.operation_id,
    tenantId: row.tenant_id,
    envId: row.env_id,
    deviceId: row.device_id,
    deviceBindingId: row.device_binding_id,
    targetInstanceId: row.target_instance_id,
    ...(row.binding_version === null ? {} : { bindingVersion: BigInt(row.binding_version) }),
    action: toAction(row),
    deliveryState: row.delivery_state,
    status: row.status,
    cancelRequested: row.cancel_requested === 1,
    ...(row.cancel_reason === null ? {} : { cancelReason: row.cancel_reason }),
    nextOffset: keyOffset(row.next_offset),
    expiresAt: row.expires_at,
    ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
    ...(row.sent_at === null ? {} : { sentAt: row.sent_at }),
    ...(row.result_status === null ? {} : { resultStatus: row.result_status }),
    ...(result === undefined ? {} : { outcome: result.outcome }),
    ...(row.device_output_complete === null
      ? {}
      : { deviceOutputComplete: row.device_output_complete === 1 }),
    ...(row.result_end_offset === null ? {} : { endOffset: keyOffset(row.result_end_offset) }),
    outputComplete: row.output_complete === 1,
    outputGap: row.output_gap === 1,
    ...(row.result_source === null ? {} : { resultSource: row.result_source }),
    ...(row.result_recorded_at === null ? {} : { resultRecordedAt: row.result_recorded_at }),
    ...(row.post_processed_at === null ? {} : { postProcessedAt: row.post_processed_at }),
    ...(row.result_acknowledged_at === null
      ? {}
      : { resultAcknowledgedAt: row.result_acknowledged_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toChunk(row: ChunkRow): EnvironmentOutputRecord {
  return {
    operationId: row.operation_id,
    offset: keyOffset(row.offset),
    endOffset: keyOffset(row.end_offset),
    stream: row.stream,
    data: Buffer.from(row.data),
  };
}

function terminalStatus(status: OperationStatus): boolean {
  return [
    OperationStatus.COMPLETED,
    OperationStatus.FAILED,
    OperationStatus.CANCELLED,
    OperationStatus.EXPIRED,
    OperationStatus.UNKNOWN,
  ].includes(status);
}

function actionColumn(action: EnvironmentOperationAction): string {
  if (action.case === 'directoryCheck') return 'directory_check';
  if (action.case === 'directoryList' || action.case === 'syncScan') return 'directory_list';
  if (action.case === 'readImage' || action.case === 'syncRead') return 'read_image';
  if (action.case === 'glob' || action.case === 'grep') return 'read';
  return action.case;
}

function searchActionColumn(action: EnvironmentOperationAction): 'glob' | 'grep' | null {
  if (action.case === 'glob') return 'glob';
  if (action.case === 'grep') return 'grep';
  return null;
}

const grepModeColumn: Record<number, 'content' | 'files_with_matches' | 'count'> = {
  [GrepMode.CONTENT]: 'content',
  [GrepMode.FILES_WITH_MATCHES]: 'files_with_matches',
  [GrepMode.COUNT]: 'count',
};

const grepModeValue: Record<'content' | 'files_with_matches' | 'count', GrepMode> = {
  content: GrepMode.CONTENT,
  files_with_matches: GrepMode.FILES_WITH_MATCHES,
  count: GrepMode.COUNT,
};

function syncActionColumn(
  action: EnvironmentOperationAction,
): 'sync_scan' | 'sync_read' | 'sync_write' | 'sync_directory' | null {
  if (action.case === 'syncScan') return 'sync_scan';
  if (action.case === 'syncRead') return 'sync_read';
  if (action.case === 'write' && action.value.createDirectory === true) return 'sync_directory';
  if (action.case === 'write' && action.value.transferId !== undefined) return 'sync_write';
  return null;
}

function resultFingerprint(status: OperationStatus, outcome: EnvironmentOperationOutcome): string {
  return fingerprint({ status, outcome });
}

function validateResult(
  action: EnvironmentOperationAction,
  status: OperationStatus,
  outcome: EnvironmentOperationOutcome,
): void {
  if (!terminalStatus(status) || outcome.case !== action.case) {
    throw new DeviceFailure(
      DeviceErrorCode.INVALID_MESSAGE,
      'Environment result status or outcome does not match its action.',
    );
  }
  if (action.case === 'directoryCheck' && outcome.case === 'directoryCheck') {
    if (
      status === OperationStatus.COMPLETED &&
      (!outcome.value.exists ||
        !outcome.value.directory ||
        !outcome.value.readable ||
        !outcome.value.writable ||
        !outcome.value.executable)
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'A completed directory check must confirm all directory permissions.',
      );
    }
  }
  if (action.case === 'directoryList' && outcome.case === 'directoryList') {
    const value = outcome.value;
    if (
      value.entries.length > action.value.limit ||
      (value.hasMore && value.nextOffset !== action.value.offset + value.entries.length)
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Directory pagination does not match the requested range.',
      );
    }
  }
  if (action.case === 'glob' && outcome.case === 'glob') {
    if (outcome.value.files.length > (action.value.headLimit ?? 250)) {
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Glob results exceed the requested head limit.',
      );
    }
  }
  if (action.case === 'grep' && outcome.case === 'grep') {
    const entries =
      outcome.value.matches.length + outcome.value.files.length + outcome.value.counts.length;
    if (entries > (action.value.headLimit ?? 250)) {
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Grep results exceed the requested head limit.',
      );
    }
  }
  if (action.case === 'bash' && outcome.case === 'bash') {
    const exitCode = outcome.value.exitCode;
    const invalidExit =
      status === OperationStatus.COMPLETED
        ? exitCode !== 0
        : status === OperationStatus.FAILED
          ? exitCode === 0
          : exitCode !== undefined;
    if (invalidExit) {
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Bash exit code does not match its terminal status.',
      );
    }
    if (outcome.value.outputComplete && outcome.value.endOffset === undefined) {
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Complete Bash output requires an end offset.',
      );
    }
  }
  if (status === OperationStatus.COMPLETED && outcome.case === 'readImage') {
    const sha256 = createHash('sha256').update(outcome.value.data).digest('hex');
    if (
      outcome.value.data.length === 0 ||
      outcome.value.data.length > 700_000 ||
      outcome.value.fileVersion !== sha256
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'A completed image read requires bounded bytes and a matching SHA-256.',
      );
    }
  }
  if (
    status === OperationStatus.COMPLETED &&
    action.case === 'syncRead' &&
    outcome.case === 'syncRead'
  ) {
    if (
      outcome.value.offset !== action.value.offset ||
      outcome.value.data.length > action.value.limit ||
      outcome.value.size > DEVICE_SYNC_LIMITS.maxFileBytes ||
      outcome.value.offset + BigInt(outcome.value.data.length) > outcome.value.size
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'A sync read result is inconsistent.',
      );
    }
  }
  if (status === OperationStatus.COMPLETED && action.case === 'write' && outcome.case === 'write') {
    const value = action.value;
    if (value.transferId !== undefined) {
      const complete =
        (value.offset ?? 0n) + BigInt(value.binaryContent?.length ?? 0) === value.totalSize;
      if (
        outcome.value.nextOffset !==
          (value.offset ?? 0n) + BigInt(value.binaryContent?.length ?? 0) ||
        outcome.value.transferComplete !== complete ||
        outcome.value.bytesWritten !== BigInt(value.binaryContent?.length ?? 0) ||
        (complete && outcome.value.fileVersion !== value.expectedSha256) ||
        (!complete && outcome.value.fileVersion !== '')
      ) {
        throw new DeviceFailure(
          DeviceErrorCode.INVALID_MESSAGE,
          'A sync write result is inconsistent.',
        );
      }
    } else if (value.createDirectory === true) {
      if (outcome.value.transferComplete !== true || outcome.value.bytesWritten !== 0n) {
        throw new DeviceFailure(
          DeviceErrorCode.INVALID_MESSAGE,
          'A sync directory result is inconsistent.',
        );
      }
    } else if (!/^[a-f0-9]{64}$/.test(outcome.value.fileVersion)) {
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'A completed file operation requires a SHA-256 file version.',
      );
    }
  }
  if (
    status === OperationStatus.COMPLETED &&
    ((outcome.case === 'read' && !/^[a-f0-9]{64}$/.test(outcome.value.fileVersion)) ||
      (outcome.case === 'edit' && !/^[a-f0-9]{64}$/.test(outcome.value.fileVersion)))
  ) {
    throw new DeviceFailure(
      DeviceErrorCode.INVALID_MESSAGE,
      'A completed file operation requires a SHA-256 file version.',
    );
  }
}

interface BashOutputLogState {
  head: Buffer[];
  headBytes: number;
  path?: string | undefined;
  stream?: WriteStream | undefined;
  bytes: number;
  truncated: boolean;
  failed: boolean;
}

export class EnvironmentOperationStore {
  private readonly bashLogs = new Map<string, BashOutputLogState>();

  constructor(
    readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
    private readonly options: { bashLogDirectory?: string; bashLogMaxBytes?: number } = {},
  ) {
    assertServerDatabaseCompatible(database);
    migrateDatabase(database, environmentOperationMigrations, 'environment_operations');
    this.sweepBashLogDirectory();
  }

  private sweepBashLogDirectory(): void {
    const directory = this.options.bashLogDirectory;
    if (directory === undefined) return;
    try {
      const cutoff = this.now().getTime() - BASH_OUTPUT_LOG_RETENTION_MILLISECONDS;
      for (const entry of readdirSync(directory)) {
        if (!entry.endsWith('.log')) continue;
        const path = join(directory, entry);
        try {
          if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
        } catch {}
      }
    } catch {}
  }

  // Bash 完整输出流式写入主机主环境工作目录的日志文件;SQLite 只保留头部,
  // 完整日志不进入 Server 数据库。超过 BASH_OUTPUT_LOG_MAX_BYTES 后截断。
  private appendBashLog(operationId: string, data: Buffer): void {
    const directory = this.options.bashLogDirectory;
    if (directory === undefined) return;
    let state = this.bashLogs.get(operationId);
    if (state === undefined) {
      state = { head: [], headBytes: 0, bytes: 0, truncated: false, failed: false };
      this.bashLogs.set(operationId, state);
      if (this.bashLogs.size > 256) {
        const oldest = this.bashLogs.keys().next().value;
        if (oldest !== undefined && oldest !== operationId) this.bashLogs.delete(oldest);
      }
    }
    if (state.failed || (state.truncated && state.stream === undefined)) return;
    try {
      if (state.path === undefined) {
        if (state.headBytes + data.length <= ENVIRONMENT_OPERATION_OUTPUT_RETAINED_BYTES) {
          state.head.push(data);
          state.headBytes += data.length;
          return;
        }
        const safeId = operationId.replace(/[^A-Za-z0-9_-]/g, '_');
        state.path = join(directory, `${safeId}.log`);
        mkdirSync(directory, { recursive: true });
        const stream = createWriteStream(state.path, { flags: 'w' });
        stream.on('error', () => {
          state.failed = true;
          state.truncated = true;
          state.stream = undefined;
        });
        state.stream = stream;
        for (const chunk of state.head) stream.write(chunk);
        state.bytes = state.headBytes;
        state.head = [];
        state.headBytes = 0;
      }
      const stream = state.stream;
      if (stream === undefined) return;
      const remaining = (this.options.bashLogMaxBytes ?? BASH_OUTPUT_LOG_MAX_BYTES) - state.bytes;
      if (remaining <= 0 || data.length > remaining) {
        if (remaining > 0) stream.write(data.subarray(0, remaining));
        state.bytes += Math.max(remaining, 0);
        state.truncated = true;
        stream.end();
        state.stream = undefined;
        return;
      }
      stream.write(data);
      state.bytes += data.length;
    } catch {
      state.failed = true;
      state.truncated = true;
      state.stream = undefined;
    }
  }

  private finalizeBashLog(operationId: string): void {
    const state = this.bashLogs.get(operationId);
    if (state?.stream !== undefined) {
      state.stream.end();
      state.stream = undefined;
    }
  }

  bashOutputLog(
    operationId: string,
  ): { path: string; sizeBytes: bigint; truncated: boolean } | undefined {
    const state = this.bashLogs.get(operationId);
    if (state === undefined || state.path === undefined || state.failed) return undefined;
    return { path: state.path, sizeBytes: BigInt(state.bytes), truncated: state.truncated };
  }

  createIntent(input: CreateEnvironmentOperationInput): {
    operation: EnvironmentOperationRecord;
    created: boolean;
  } {
    for (const [field, value] of Object.entries({
      operationId: input.operationId,
      tenantId: input.tenantId,
      envId: input.envId,
      deviceId: input.deviceId,
      deviceBindingId: input.deviceBindingId,
      targetInstanceId: input.targetInstanceId,
    })) {
      requiredText(value, field, 200);
    }
    optionalBindingVersion(input.bindingVersion);
    const action = operationAction(input);
    validateAction(action, input.bindingVersion);
    if (!Number.isFinite(input.expiresAt.getTime())) {
      throw new DeviceFailure(DeviceErrorCode.INVALID_MESSAGE, 'Operation expiration is invalid.');
    }
    const fingerprintValue = intentFingerprint(input);
    const now = this.now().toISOString();
    return inTransaction(this.database, () => {
      const existing = readOperation(this.database, input.operationId);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprintValue) {
          throw new DeviceFailure(
            DeviceErrorCode.OPERATION_CONFLICT,
            'Environment operation ID is associated with different parameters.',
            DeviceErrorAction.QUERY_OPERATION,
            input.operationId,
          );
        }
        return { operation: toOperation(existing), created: false };
      }
      if (input.expiresAt.getTime() <= this.now().getTime()) {
        throw new DeviceFailure(
          DeviceErrorCode.OPERATION_EXPIRED,
          'Environment operation has expired.',
          DeviceErrorAction.ABORT,
          input.operationId,
        );
      }
      const values = {
        path: action.case === 'bash' ? null : action.value.path,
        cwd:
          action.case === 'directoryCheck' || action.case === 'directoryList'
            ? null
            : action.value.cwd,
        readOffset:
          action.case === 'read' || action.case === 'directoryList'
            ? (action.value.offset ?? null)
            : null,
        readLimit:
          action.case === 'read' || action.case === 'directoryList' || action.case === 'syncRead'
            ? (action.value.limit ?? null)
            : null,
        content: action.case === 'write' ? action.value.content : null,
        binaryContent: action.case === 'write' ? (action.value.binaryContent ?? null) : null,
        overwrite: action.case === 'write' ? (action.value.overwrite ? 1 : 0) : null,
        createParents:
          action.case === 'write' && action.value.createParents !== undefined
            ? action.value.createParents
              ? 1
              : 0
            : null,
        syncAction: syncActionColumn(action),
        syncOffset:
          action.case === 'syncRead'
            ? action.value.offset.toString()
            : action.case === 'write'
              ? (action.value.offset?.toString() ?? null)
              : null,
        transferId: action.case === 'write' ? (action.value.transferId ?? null) : null,
        totalSize: action.case === 'write' ? (action.value.totalSize?.toString() ?? null) : null,
        executable:
          action.case === 'write' && action.value.executable !== undefined
            ? action.value.executable
              ? 1
              : 0
            : null,
        createDirectory:
          action.case === 'write' && action.value.createDirectory !== undefined
            ? action.value.createDirectory
              ? 1
              : 0
            : null,
        conflictScan:
          action.case === 'syncScan' ? (action.value.conflictScan === true ? 1 : 0) : null,
        relativePathsJson:
          action.case === 'syncScan' ? JSON.stringify(action.value.relativePaths) : null,
        oldText: action.case === 'edit' ? action.value.oldText : null,
        newText: action.case === 'edit' ? action.value.newText : null,
        expectedOccurrences:
          action.case === 'edit' ? (action.value.expectedOccurrences ?? null) : null,
        expectedFileVersion:
          action.case === 'edit'
            ? action.value.expectedFileVersion
            : action.case === 'write'
              ? (action.value.expectedSha256 ?? null)
              : null,
        command: action.case === 'bash' ? action.value.command : null,
        timeoutSeconds: action.case === 'bash' ? action.value.timeoutSeconds : null,
        loadWorkspace:
          action.case === 'directoryCheck' ? (action.value.loadWorkspace ? 1 : 0) : null,
        searchAction: searchActionColumn(action),
        pattern: action.case === 'glob' || action.case === 'grep' ? action.value.pattern : null,
        includeGlob:
          action.case === 'grep' && action.value.include !== undefined
            ? action.value.include
            : null,
        grepMode: action.case === 'grep' ? (grepModeColumn[action.value.mode] ?? 'content') : null,
        caseInsensitive: action.case === 'grep' ? (action.value.caseInsensitive ? 1 : 0) : null,
        lineNumbers: action.case === 'grep' ? (action.value.lineNumbers ? 1 : 0) : null,
        searchOffset:
          action.case === 'glob' || action.case === 'grep' ? (action.value.offset ?? null) : null,
        searchLimit:
          action.case === 'glob' || action.case === 'grep'
            ? (action.value.headLimit ?? null)
            : null,
      };
      this.database
        .prepare(
          `INSERT INTO environment_operations(
            operation_id, tenant_id, env_id, device_id, device_binding_id, target_instance_id,
            binding_version, action, fingerprint, path, cwd, read_offset, read_limit, content,
            binary_content, overwrite, create_parents, sync_action, sync_offset, transfer_id,
            total_size, executable, create_directory, conflict_scan, relative_paths_json, old_text,
            new_text, expected_occurrences, expected_file_version, command, timeout_seconds,
            load_workspace, search_action, pattern, include_glob, grep_mode, case_insensitive,
            line_numbers, search_offset, search_limit,
            delivery_state, status, next_offset, expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent', ?, ?, ?, ?, ?)`,
        )
        .run(
          input.operationId,
          input.tenantId,
          input.envId,
          input.deviceId,
          input.deviceBindingId,
          input.targetInstanceId,
          optionalBindingVersion(input.bindingVersion),
          actionColumn(action),
          fingerprintValue,
          values.path,
          values.cwd,
          values.readOffset,
          values.readLimit,
          values.content,
          values.binaryContent,
          values.overwrite,
          values.createParents,
          values.syncAction,
          values.syncOffset,
          values.transferId,
          values.totalSize,
          values.executable,
          values.createDirectory,
          values.conflictScan,
          values.relativePathsJson,
          values.oldText,
          values.newText,
          values.expectedOccurrences,
          values.expectedFileVersion,
          values.command,
          values.timeoutSeconds,
          values.loadWorkspace,
          values.searchAction,
          values.pattern,
          values.includeGlob,
          values.grepMode,
          values.caseInsensitive,
          values.lineNumbers,
          values.searchOffset,
          values.searchLimit,
          OperationStatus.CREATED,
          ZERO_OFFSET,
          input.expiresAt.toISOString(),
          now,
          now,
        );
      return {
        operation: toOperation(requireOperation(this.database, input.operationId)),
        created: true,
      };
    });
  }

  find(operationId: string): EnvironmentOperationRecord | undefined {
    const row = readOperation(this.database, operationId);
    return row === undefined ? undefined : toOperation(row);
  }

  getForTenant(tenantId: string, operationId: string): EnvironmentOperationRecord {
    requiredText(tenantId, 'tenantId', 200);
    const operation = requireOperation(this.database, operationId);
    if (operation.tenant_id !== tenantId) {
      throw new DeviceFailure(
        DeviceErrorCode.PERMISSION_DENIED,
        'Environment operation is not available to this tenant.',
      );
    }
    return toOperation(operation);
  }

  markSent(operationId: string, deviceBindingId: string, instanceId: string): void {
    const updated = this.database
      .prepare(
        `UPDATE environment_operations SET delivery_state = 'sent', sent_at = ?, updated_at = ?
         WHERE operation_id = ? AND device_binding_id = ? AND target_instance_id = ?`,
      )
      .run(
        this.now().toISOString(),
        this.now().toISOString(),
        operationId,
        deviceBindingId,
        instanceId,
      );
    if (updated.changes !== 1) {
      throw new DeviceFailure(
        DeviceErrorCode.OPERATION_CONFLICT,
        'Environment operation target changed before delivery confirmation.',
        DeviceErrorAction.QUERY_OPERATION,
        operationId,
      );
    }
  }

  recordAccepted(
    input: EnvironmentOperationTargetInput & { status: OperationStatus; acceptedAt: Date },
  ): void {
    if (
      input.status !== OperationStatus.ACCEPTED &&
      input.status !== OperationStatus.RUNNING &&
      input.status !== OperationStatus.CANCEL_REQUESTED
    ) {
      throw new DeviceFailure(DeviceErrorCode.INVALID_MESSAGE, 'Operation acceptance is invalid.');
    }
    if (!Number.isFinite(input.acceptedAt.getTime())) {
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Operation acceptance time is invalid.',
      );
    }
    const operation = requireOperation(this.database, input.operationId);
    this.assertTarget(operation, input);
    if (operation.result_recorded_at !== null) return;
    const status =
      operation.cancel_requested === 1 ? OperationStatus.CANCEL_REQUESTED : input.status;
    this.database
      .prepare(
        `UPDATE environment_operations SET status = ?, accepted_at = COALESCE(accepted_at, ?),
         updated_at = ? WHERE operation_id = ?`,
      )
      .run(status, input.acceptedAt.toISOString(), this.now().toISOString(), input.operationId);
  }

  requestCancel(tenantId: string, operationId: string, reason: string): EnvironmentOperationRecord {
    requiredText(reason, 'reason', 1000);
    return inTransaction(this.database, () => {
      const operation = requireOperation(this.database, operationId);
      if (operation.tenant_id !== tenantId) {
        throw new DeviceFailure(
          DeviceErrorCode.PERMISSION_DENIED,
          'Operation tenant does not match.',
        );
      }
      if (operation.result_recorded_at === null) {
        this.database
          .prepare(
            `UPDATE environment_operations SET cancel_requested = 1, cancel_reason = ?, status = ?,
             updated_at = ? WHERE operation_id = ?`,
          )
          .run(reason, OperationStatus.CANCEL_REQUESTED, this.now().toISOString(), operationId);
      }
      return toOperation(requireOperation(this.database, operationId));
    });
  }

  recordOutput(
    input: EnvironmentOperationTargetInput & {
      offset: bigint;
      stream: OutputStream;
      data: Uint8Array;
    },
  ): bigint {
    if (input.data.length === 0 || (input.stream !== 1 && input.stream !== 2)) {
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Operation output must have a supported stream and non-empty data.',
      );
    }
    const start = input.offset;
    const end = start + BigInt(input.data.length);
    offsetKey(start);
    if (end >= MAX_UINT64) {
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Operation output exceeds uint64 range.',
      );
    }
    return inTransaction(this.database, () => {
      const operation = requireOperation(this.database, input.operationId);
      this.assertTarget(operation, input);
      if (operation.action !== 'bash') {
        throw new DeviceFailure(
          DeviceErrorCode.INVALID_MESSAGE,
          'Only Bash operations have output.',
        );
      }
      if (operation.result_source === 'recovery') {
        throw new DeviceFailure(
          DeviceErrorCode.OPERATION_CONFLICT,
          'Recovered output cannot be replaced by a different instance.',
        );
      }
      if (operation.result_end_offset !== null && end > keyOffset(operation.result_end_offset)) {
        throw new DeviceFailure(
          DeviceErrorCode.OPERATION_CONFLICT,
          'Operation output exceeds the terminal end offset.',
        );
      }
      const data = Buffer.from(input.data);
      this.appendBashLog(input.operationId, data);
      const retainedEnd = BigInt(ENVIRONMENT_OPERATION_OUTPUT_RETAINED_BYTES);
      const persistStart = start < retainedEnd ? start : retainedEnd;
      const persistEnd = end < retainedEnd ? end : retainedEnd;
      const overlaps =
        persistStart >= persistEnd
          ? []
          : this.database
              .prepare(
                `SELECT * FROM environment_operation_output_chunks
           WHERE operation_id = ? AND offset < ? AND end_offset > ? ORDER BY offset`,
              )
              .all(input.operationId, offsetKey(persistEnd), offsetKey(persistStart))
              .map((row) => chunkRowSchema.parse(row));
      for (const existing of overlaps) {
        const existingStart = keyOffset(existing.offset);
        const existingEnd = keyOffset(existing.end_offset);
        const overlapStart = maximumOffset(start, existingStart);
        const overlapEnd = minimumOffset(end, existingEnd);
        const existingData = Buffer.from(existing.data);
        const left = existingData.subarray(
          Number(overlapStart - existingStart),
          Number(overlapEnd - existingStart),
        );
        const right = data.subarray(Number(overlapStart - start), Number(overlapEnd - start));
        if (existing.stream !== input.stream || !left.equals(right)) {
          throw new DeviceFailure(
            DeviceErrorCode.OPERATION_CONFLICT,
            'Operation output conflicts with previously persisted bytes.',
          );
        }
      }

      let nextOffset = keyOffset(operation.next_offset);
      let cursor = maximumOffset(persistStart, nextOffset);
      const segments: Array<{ offset: bigint; data: Buffer }> = [];
      for (const existing of overlaps) {
        const existingStart = keyOffset(existing.offset);
        const existingEnd = keyOffset(existing.end_offset);
        if (existingEnd <= cursor) continue;
        if (existingStart > cursor) {
          const segmentEnd = minimumOffset(existingStart, persistEnd);
          segments.push({
            offset: cursor,
            data: data.subarray(Number(cursor - start), Number(segmentEnd - start)),
          });
        }
        if (existingEnd > cursor) cursor = existingEnd;
        if (cursor >= persistEnd) break;
      }
      if (cursor < persistEnd)
        segments.push({
          offset: cursor,
          data: data.subarray(Number(cursor - start), Number(persistEnd - start)),
        });
      for (const segment of segments) {
        if (segment.data.length === 0) continue;
        const segmentEnd = segment.offset + BigInt(segment.data.length);
        this.database
          .prepare(
            `INSERT INTO environment_operation_output_chunks(operation_id, offset, end_offset, stream, data)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            input.operationId,
            offsetKey(segment.offset),
            offsetKey(segmentEnd),
            input.stream,
            segment.data,
          );
      }

      while (true) {
        const contiguousRow = this.database
          .prepare(
            'SELECT * FROM environment_operation_output_chunks WHERE operation_id = ? AND offset = ?',
          )
          .get(input.operationId, offsetKey(nextOffset));
        if (contiguousRow === undefined) break;
        nextOffset = keyOffset(chunkRowSchema.parse(contiguousRow).end_offset);
      }
      const headTarget =
        operation.result_end_offset === null
          ? null
          : minimumOffset(keyOffset(operation.result_end_offset), retainedEnd);
      const outputComplete =
        operation.result_recorded_at !== null &&
        operation.result_source === 'device' &&
        operation.device_output_complete === 1 &&
        headTarget !== null &&
        nextOffset >= headTarget;
      const outputGap =
        operation.result_recorded_at !== null && headTarget !== null && nextOffset < headTarget;
      this.database
        .prepare(
          `UPDATE environment_operations SET next_offset = ?, output_complete = ?, output_gap = ?,
           updated_at = ? WHERE operation_id = ?`,
        )
        .run(
          offsetKey(nextOffset),
          outputComplete ? 1 : 0,
          outputGap ? 1 : 0,
          this.now().toISOString(),
          input.operationId,
        );
      return nextOffset;
    });
  }

  recordResult(input: EnvironmentOperationResultInput): EnvironmentOperationRecord {
    requiredText(input.operationId, 'operationId', 200);
    if (!Number.isFinite(input.observedAt.getTime())) {
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Environment result time is invalid.',
      );
    }
    return inTransaction(this.database, () => this.persistResult(input));
  }

  private persistResult(input: EnvironmentOperationResultInput): EnvironmentOperationRecord {
    const operation = requireOperation(this.database, input.operationId);
    this.assertTarget(operation, input);
    validateResult(toAction(operation), input.status, input.outcome);
    if (input.outcome.case === 'bash' && input.outcome.value.endOffset !== undefined) {
      offsetKey(input.outcome.value.endOffset);
    }
    const source = input.source ?? 'device';
    const resultFingerprintValue = resultFingerprint(input.status, input.outcome);
    if (operation.result_recorded_at !== null) {
      if (
        operation.result_source !== source ||
        operation.result_fingerprint !== resultFingerprintValue
      ) {
        throw new DeviceFailure(
          DeviceErrorCode.OPERATION_CONFLICT,
          'Environment operation already has a different result.',
          DeviceErrorAction.QUERY_OPERATION,
          input.operationId,
        );
      }
      return toOperation(operation);
    }
    const endOffset =
      input.outcome.case === 'bash'
        ? input.outcome.value.endOffset
        : operation.action === 'bash'
          ? undefined
          : 0n;
    const deviceOutputComplete =
      input.outcome.case === 'bash' ? input.outcome.value.outputComplete : false;
    const nextOffset = keyOffset(operation.next_offset);
    if (endOffset !== undefined && endOffset < nextOffset) {
      throw new DeviceFailure(
        DeviceErrorCode.OPERATION_CONFLICT,
        'Environment result ends before already acknowledged output.',
      );
    }
    if (endOffset !== undefined) {
      const beyond = this.database
        .prepare(
          `SELECT 1 AS present FROM environment_operation_output_chunks
             WHERE operation_id = ? AND end_offset > ? LIMIT 1`,
        )
        .get(input.operationId, offsetKey(endOffset));
      if (beyond !== undefined) {
        throw new DeviceFailure(
          DeviceErrorCode.OPERATION_CONFLICT,
          'Environment result ends before a persisted output fragment.',
        );
      }
    }
    const headTarget =
      endOffset === undefined
        ? undefined
        : minimumOffset(endOffset, BigInt(ENVIRONMENT_OPERATION_OUTPUT_RETAINED_BYTES));
    const outputComplete =
      operation.action !== 'bash' ||
      (source === 'device' &&
        deviceOutputComplete &&
        headTarget !== undefined &&
        nextOffset >= headTarget);
    const outputGap = headTarget !== undefined && nextOffset < headTarget;
    const target: OperationTarget = {
      envId: operation.env_id,
      deviceBindingId: operation.device_binding_id,
      instanceId: operation.target_instance_id,
      ...(operation.binding_version === null
        ? {}
        : { bindingVersion: BigInt(operation.binding_version) }),
    };
    const payload = encodeDaemonMessage({
      payload: {
        case: 'operationResult',
        value: {
          operationId: input.operationId,
          target,
          status: input.status,
          observedAt: timestamp(input.observedAt),
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          outcome: input.outcome,
        },
      },
    });
    const now = this.now().toISOString();
    this.database
      .prepare(
        `UPDATE environment_operations SET status = ?, result_status = ?, result_payload = ?,
           result_fingerprint = ?, device_output_complete = ?, result_end_offset = ?,
           output_complete = ?, output_gap = ?, result_source = ?, result_recorded_at = ?, updated_at = ?
           WHERE operation_id = ?`,
      )
      .run(
        input.status,
        input.status,
        payload,
        resultFingerprintValue,
        deviceOutputComplete ? 1 : 0,
        endOffset === undefined ? null : offsetKey(endOffset),
        outputComplete ? 1 : 0,
        outputGap ? 1 : 0,
        source,
        input.observedAt.toISOString(),
        now,
        input.operationId,
      );
    return toOperation(requireOperation(this.database, input.operationId));
  }

  markPostProcessed(operationId: string): EnvironmentOperationRecord {
    const now = this.now().toISOString();
    this.database
      .prepare(
        `UPDATE environment_operations SET post_processed_at = COALESCE(post_processed_at, ?),
         updated_at = ? WHERE operation_id = ? AND result_recorded_at IS NOT NULL`,
      )
      .run(now, now, operationId);
    return toOperation(requireOperation(this.database, operationId));
  }

  markResultAcknowledged(operationId: string): void {
    const operation = requireOperation(this.database, operationId);
    if (
      operation.result_recorded_at === null ||
      operation.result_source !== 'device' ||
      operation.post_processed_at === null
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.INTERNAL,
        'Environment result was not fully persisted before acknowledgement.',
        DeviceErrorAction.RECONNECT,
        operationId,
      );
    }
    const acknowledgedTarget =
      operation.result_end_offset === null
        ? null
        : minimumOffset(
            keyOffset(operation.result_end_offset),
            BigInt(ENVIRONMENT_OPERATION_OUTPUT_RETAINED_BYTES),
          );
    if (
      operation.output_gap === 1 ||
      (acknowledgedTarget !== null && keyOffset(operation.next_offset) !== acknowledgedTarget)
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Environment output reconciliation is incomplete.',
        DeviceErrorAction.QUERY_OPERATION,
        operationId,
      );
    }
    const updated = this.database
      .prepare(
        `UPDATE environment_operations SET result_acknowledged_at = COALESCE(result_acknowledged_at, ?),
         updated_at = ? WHERE operation_id = ?`,
      )
      .run(this.now().toISOString(), this.now().toISOString(), operationId);
    this.finalizeBashLog(operationId);
    this.bashLogs.delete(operationId);
    if (updated.changes !== 1) {
      throw new DeviceFailure(
        DeviceErrorCode.INTERNAL,
        'Environment result acknowledgement was not saved.',
      );
    }
  }

  listPendingForInstance(
    deviceBindingId: string,
    instanceId: string,
  ): EnvironmentOperationRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM environment_operations WHERE device_binding_id = ? AND target_instance_id = ?
         AND result_acknowledged_at IS NULL ORDER BY created_at, operation_id`,
      )
      .all(deviceBindingId, instanceId)
      .map((row) => toOperation(operationRowSchema.parse(row)));
  }

  listAbandonedInstances(
    deviceBindingId: string,
    instanceId: string,
  ): EnvironmentOperationRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM environment_operations WHERE device_binding_id = ? AND target_instance_id <> ?
         AND result_recorded_at IS NULL ORDER BY created_at, operation_id`,
      )
      .all(deviceBindingId, instanceId)
      .map((row) => toOperation(operationRowSchema.parse(row)));
  }

  markInstanceLost(deviceBindingId: string, instanceId: string): EnvironmentOperationRecord[] {
    const commit = () => {
      const pending = this.listPendingForInstance(deviceBindingId, instanceId);
      const now = this.now();
      for (const operation of pending) {
        if (operation.resultRecordedAt !== undefined) continue;
        const hasFutureChunk =
          this.database
            .prepare(
              `SELECT 1 AS present FROM environment_operation_output_chunks
               WHERE operation_id = ? AND end_offset > ? LIMIT 1`,
            )
            .get(operation.operationId, offsetKey(operation.nextOffset)) !== undefined;
        const outputGap =
          operation.action.case === 'bash' &&
          (operation.outputGap || operation.nextOffset > 0n || hasFutureChunk);
        this.persistResult({
          operationId: operation.operationId,
          envId: operation.envId,
          deviceBindingId: operation.deviceBindingId,
          targetInstanceId: operation.targetInstanceId,
          ...(operation.bindingVersion === undefined
            ? {}
            : { bindingVersion: operation.bindingVersion }),
          status: OperationStatus.UNKNOWN,
          outcome: emptyEnvironmentOutcome(
            operation.action,
            'Daemon instance changed before the operation result was known.',
          ),
          observedAt: now,
          source: 'recovery',
        });
        this.database
          .prepare(
            `UPDATE environment_operations SET output_complete = 0, output_gap = ?,
             post_processed_at = ?, updated_at = ? WHERE operation_id = ?`,
          )
          .run(outputGap ? 1 : 0, now.toISOString(), now.toISOString(), operation.operationId);
      }
      return pending.map((operation) =>
        toOperation(requireOperation(this.database, operation.operationId)),
      );
    };
    return this.database.isTransaction ? commit() : inTransaction(this.database, commit);
  }

  countActiveForBinding(deviceBindingId: string): number {
    return z.object({ count: z.number().int().nonnegative() }).parse(
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM environment_operations
             WHERE device_binding_id = ? AND result_recorded_at IS NULL`,
        )
        .get(deviceBindingId),
    ).count;
  }

  readOutputForTenant(
    tenantId: string,
    operationId: string,
    afterOffset: bigint,
    maximumBytes = 64 * 1024,
  ): EnvironmentOutputRecord[] {
    this.getForTenant(tenantId, operationId);
    offsetKey(afterOffset);
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > 1024 * 1024) {
      throw new DeviceFailure(DeviceErrorCode.INVALID_MESSAGE, 'Output read limit is invalid.');
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM environment_operation_output_chunks
         WHERE operation_id = ? AND end_offset > ? ORDER BY offset`,
      )
      .iterate(operationId, offsetKey(afterOffset));
    const output: EnvironmentOutputRecord[] = [];
    let remaining = maximumBytes;
    for (const row of rows) {
      if (remaining === 0) break;
      const chunk = toChunk(chunkRowSchema.parse(row));
      const start = chunk.offset < afterOffset ? afterOffset : chunk.offset;
      const data = Buffer.from(chunk.data).subarray(Number(start - chunk.offset));
      const selected = data.subarray(0, Math.min(remaining, data.length));
      if (selected.length === 0) continue;
      output.push({
        operationId,
        offset: start,
        endOffset: start + BigInt(selected.length),
        stream: chunk.stream,
        data: selected,
      });
      remaining -= selected.length;
    }
    return output;
  }

  private assertTarget(operation: OperationRow, input: EnvironmentOperationTargetInput): void {
    const bindingVersion =
      operation.binding_version === null ? undefined : BigInt(operation.binding_version);
    if (
      operation.env_id !== input.envId ||
      operation.device_binding_id !== input.deviceBindingId ||
      operation.target_instance_id !== input.targetInstanceId ||
      bindingVersion !== input.bindingVersion
    ) {
      throw new DeviceFailure(
        DeviceErrorCode.PERMISSION_DENIED,
        'Environment operation target does not match its persisted intent.',
      );
    }
  }
}
