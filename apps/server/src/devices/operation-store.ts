import type { DatabaseSync } from 'node:sqlite';
import {
  type BashStatus,
  DeviceErrorAction,
  DeviceErrorCode,
  type OutputStream,
} from '@kairos/contracts/device';
import { z } from 'zod';
import { deviceBashMigrations } from '../storage/device-migrations.js';
import { migrateDatabase } from '../storage/migrations.js';
import { assertServerDatabaseCompatible } from '../storage/server-schema.js';
import { DeviceFailure } from './errors.js';

export { deviceBashMigrations } from '../storage/device-migrations.js';

const UINT64_KEY_LENGTH = 20;

const operationRowSchema = z.object({
  operation_id: z.string(),
  owner_id: z.string(),
  device_id: z.string(),
  run_id: z.string(),
  command: z.string(),
  cwd: z.string(),
  expires_at: z.string(),
  timeout_seconds: z.number().int().positive(),
  target_instance_id: z.string(),
  delivery_state: z.enum(['intent', 'sent']),
  status: z.number().int().min(1).max(9),
  cancel_requested: z.number().int().min(0).max(1),
  next_offset: z.string().length(UINT64_KEY_LENGTH),
  result_status: z.number().int().min(5).max(9).nullable(),
  exit_code: z.number().int().nullable(),
  device_output_complete: z.number().int().min(0).max(1).nullable(),
  result_end_offset: z.string().length(UINT64_KEY_LENGTH).nullable(),
  output_complete: z.number().int().min(0).max(1),
  output_gap: z.number().int().min(0).max(1),
  result_source: z.enum(['device', 'recovery']).nullable(),
  result_recorded_at: z.string().nullable(),
  result_acknowledged_at: z.string().nullable(),
  post_processed_at: z.string().nullable(),
  accepted_at: z.string().nullable(),
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

export interface BashOperationRecord {
  operationId: string;
  ownerId: string;
  deviceId: string;
  runId: string;
  command: string;
  cwd: string;
  expiresAt: string;
  timeoutSeconds: number;
  targetInstanceId: string;
  deliveryState: 'intent' | 'sent';
  status: BashStatus;
  cancelRequested: boolean;
  nextOffset: bigint;
  resultStatus?: BashStatus;
  exitCode?: number;
  deviceOutputComplete?: boolean;
  endOffset?: bigint;
  outputComplete: boolean;
  outputGap: boolean;
  resultSource?: 'device' | 'recovery';
  resultRecordedAt?: string;
  resultAcknowledgedAt?: string;
  postProcessedAt?: string;
  acceptedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BashOutputRecord {
  operationId: string;
  offset: bigint;
  endOffset: bigint;
  stream: OutputStream.STDOUT | OutputStream.STDERR;
  data: Uint8Array;
}

function offsetKey(offset: bigint): string {
  if (offset < 0n || offset >= 1n << 64n) {
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

function readOperation(database: DatabaseSync, operationId: string): OperationRow | undefined {
  const row = database
    .prepare('SELECT * FROM device_bash_operations WHERE operation_id = ?')
    .get(operationId);
  return row === undefined ? undefined : operationRowSchema.parse(row);
}

function requireOperation(database: DatabaseSync, operationId: string): OperationRow {
  const row = readOperation(database, operationId);
  if (row === undefined) {
    throw new DeviceFailure(
      DeviceErrorCode.OPERATION_UNKNOWN,
      'The Bash operation is unknown.',
      DeviceErrorAction.QUERY_OPERATION,
      operationId,
    );
  }
  return row;
}

function toOperation(row: OperationRow): BashOperationRecord {
  return {
    operationId: row.operation_id,
    ownerId: row.owner_id,
    deviceId: row.device_id,
    runId: row.run_id,
    command: row.command,
    cwd: row.cwd,
    expiresAt: row.expires_at,
    timeoutSeconds: row.timeout_seconds,
    targetInstanceId: row.target_instance_id,
    deliveryState: row.delivery_state,
    status: row.status,
    cancelRequested: row.cancel_requested === 1,
    nextOffset: keyOffset(row.next_offset),
    ...(row.result_status === null ? {} : { resultStatus: row.result_status }),
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
    ...(row.device_output_complete === null
      ? {}
      : { deviceOutputComplete: row.device_output_complete === 1 }),
    ...(row.result_end_offset === null ? {} : { endOffset: keyOffset(row.result_end_offset) }),
    outputComplete: row.output_complete === 1,
    outputGap: row.output_gap === 1,
    ...(row.result_source === null ? {} : { resultSource: row.result_source }),
    ...(row.result_recorded_at === null ? {} : { resultRecordedAt: row.result_recorded_at }),
    ...(row.result_acknowledged_at === null
      ? {}
      : { resultAcknowledgedAt: row.result_acknowledged_at }),
    ...(row.post_processed_at === null ? {} : { postProcessedAt: row.post_processed_at }),
    ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toChunk(row: ChunkRow): BashOutputRecord {
  return {
    operationId: row.operation_id,
    offset: keyOffset(row.offset),
    endOffset: keyOffset(row.end_offset),
    stream: row.stream,
    data: Buffer.from(row.data),
  };
}

export class DeviceBashStore {
  constructor(readonly database: DatabaseSync) {
    assertServerDatabaseCompatible(database);
    migrateDatabase(database, deviceBashMigrations, 'device_bash');
  }

  find(operationId: string): BashOperationRecord | undefined {
    const row = readOperation(this.database, operationId);
    return row === undefined ? undefined : toOperation(row);
  }

  getForOwner(ownerId: string, operationId: string): BashOperationRecord {
    const row = requireOperation(this.database, operationId);
    if (row.owner_id !== ownerId) {
      throw new DeviceFailure(
        DeviceErrorCode.PERMISSION_DENIED,
        'Bash operation is not available.',
      );
    }
    return toOperation(row);
  }

  readOutputForOwner(
    ownerId: string,
    operationId: string,
    afterOffset: bigint,
    maximumChunks = 100,
  ): IterableIterator<BashOutputRecord> {
    this.getForOwner(ownerId, operationId);
    if (!Number.isSafeInteger(maximumChunks) || maximumChunks <= 0 || maximumChunks > 1000) {
      throw new DeviceFailure(DeviceErrorCode.INVALID_MESSAGE, 'Output read limit is invalid.');
    }
    const statement = this.database.prepare(
      `SELECT * FROM device_bash_output_chunks
       WHERE operation_id = ? AND offset >= ? ORDER BY offset LIMIT ?`,
    );
    const key = offsetKey(afterOffset);
    return (function* () {
      for (const row of statement.iterate(operationId, key, maximumChunks)) {
        yield toChunk(chunkRowSchema.parse(row));
      }
    })();
  }
}
