import type { DatabaseSync } from 'node:sqlite';
import { DEVICE_SYNC_LIMITS } from '@kairos/contracts/device';
import { z } from 'zod';
import { SessionError } from './errors.js';

export type EnvironmentSyncStatus =
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'unknown';
export type EnvironmentSyncConflict = 'fail' | 'skip' | 'overwrite';
export type EnvironmentSyncFileStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'succeeded'
  | 'skipped'
  | 'failed'
  | 'unknown';

export interface EnvironmentSyncFailure {
  path: string;
  reason: string;
}

export interface EnvironmentSyncResult {
  status: Exclude<EnvironmentSyncStatus, 'running'>;
  succeeded: number;
  skipped: number;
  failed: number;
  failures: EnvironmentSyncFailure[];
}

export interface EnvironmentSyncFileInput {
  syncFileId: string;
  relativePath: string;
  sourcePath: string;
  targetPath: string;
  kind: 'file' | 'directory';
  size: bigint;
  sourceSha256: string;
  targetSha256: string;
  targetExists: boolean;
  executable: boolean;
}

export interface EnvironmentSyncFileRecord extends EnvironmentSyncFileInput {
  syncId: string;
  status: EnvironmentSyncFileStatus;
  operationId?: string;
  error?: string;
  bytesTransferred: bigint;
}

export interface EnvironmentSyncRecord {
  syncId: string;
  tenantId: string;
  runId: string;
  toolCallId: string;
  sourceEnvId: string;
  targetEnvId: string;
  sourcePath: string;
  targetPath: string;
  onConflict: EnvironmentSyncConflict;
  status: EnvironmentSyncStatus;
  sourceKind?: 'file' | 'directory';
  fileCount: number;
  totalBytes: bigint;
  succeeded: number;
  skipped: number;
  failed: number;
  failures: EnvironmentSyncFailure[];
  currentOperationId?: string;
  deadlineAt: string;
}

const failureSchema = z.object({ path: z.string().max(4096), reason: z.string().max(1000) });
const syncRowSchema = z.object({
  sync_id: z.string(),
  tenant_id: z.string(),
  run_id: z.string(),
  tool_call_id: z.string(),
  source_env_id: z.string(),
  target_env_id: z.string(),
  source_path: z.string(),
  target_path: z.string(),
  on_conflict: z.enum(['fail', 'skip', 'overwrite']),
  status: z.enum(['running', 'completed', 'partial', 'failed', 'cancelled', 'unknown']),
  source_kind: z.enum(['file', 'directory']).nullable(),
  file_count: z.number().int().nonnegative(),
  total_bytes: z.string(),
  succeeded: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failures_json: z.string(),
  current_operation_id: z.string().nullable(),
  deadline_at: z.string(),
});
const fileRowSchema = z.object({
  sync_file_id: z.string(),
  sync_id: z.string(),
  relative_path: z.string(),
  source_path: z.string(),
  target_path: z.string(),
  kind: z.enum(['file', 'directory']),
  size: z.string(),
  source_sha256: z.string(),
  target_sha256: z.string(),
  target_exists: z.number().int().min(0).max(1),
  executable: z.number().int().min(0).max(1),
  status: z.enum(['pending', 'ready', 'running', 'succeeded', 'skipped', 'failed', 'unknown']),
  operation_id: z.string().nullable(),
  error: z.string().nullable(),
  bytes_transferred: z.string(),
});

function toSync(row: z.infer<typeof syncRowSchema>): EnvironmentSyncRecord {
  return {
    syncId: row.sync_id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    sourceEnvId: row.source_env_id,
    targetEnvId: row.target_env_id,
    sourcePath: row.source_path,
    targetPath: row.target_path,
    onConflict: row.on_conflict,
    status: row.status,
    ...(row.source_kind === null ? {} : { sourceKind: row.source_kind }),
    fileCount: row.file_count,
    totalBytes: BigInt(row.total_bytes),
    succeeded: row.succeeded,
    skipped: row.skipped,
    failed: row.failed,
    failures: z.array(failureSchema).parse(JSON.parse(row.failures_json)),
    ...(row.current_operation_id === null ? {} : { currentOperationId: row.current_operation_id }),
    deadlineAt: row.deadline_at,
  };
}

function toFile(row: z.infer<typeof fileRowSchema>): EnvironmentSyncFileRecord {
  return {
    syncFileId: row.sync_file_id,
    syncId: row.sync_id,
    relativePath: row.relative_path,
    sourcePath: row.source_path,
    targetPath: row.target_path,
    kind: row.kind,
    size: BigInt(row.size),
    sourceSha256: row.source_sha256,
    targetSha256: row.target_sha256,
    targetExists: row.target_exists === 1,
    executable: row.executable === 1,
    status: row.status,
    ...(row.operation_id === null ? {} : { operationId: row.operation_id }),
    ...(row.error === null ? {} : { error: row.error }),
    bytesTransferred: BigInt(row.bytes_transferred),
  };
}

export class EnvironmentSyncStore {
  constructor(
    readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: {
    syncId: string;
    tenantId: string;
    runId: string;
    toolCallId: string;
    sourceEnvId: string;
    targetEnvId: string;
    sourcePath: string;
    targetPath: string;
    onConflict: EnvironmentSyncConflict;
    deadlineAt: Date;
  }): void {
    const now = this.now().toISOString();
    this.database
      .prepare(
        `INSERT INTO environment_syncs(
          sync_id, tenant_id, run_id, tool_call_id, source_env_id, target_env_id,
          source_path, target_path, on_conflict, status, deadline_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        input.syncId,
        input.tenantId,
        input.runId,
        input.toolCallId,
        input.sourceEnvId,
        input.targetEnvId,
        input.sourcePath,
        input.targetPath,
        input.onConflict,
        input.deadlineAt.toISOString(),
        now,
        now,
      );
  }

  find(runId: string, toolCallId: string): EnvironmentSyncRecord | undefined {
    if (!hasSyncTables(this.database)) return undefined;
    const row = this.database
      .prepare('SELECT * FROM environment_syncs WHERE run_id = ? AND tool_call_id = ?')
      .get(runId, toolCallId);
    return row === undefined ? undefined : toSync(syncRowSchema.parse(row));
  }

  get(tenantId: string, syncId: string): EnvironmentSyncRecord {
    const row = this.database
      .prepare('SELECT * FROM environment_syncs WHERE sync_id = ? AND tenant_id = ?')
      .get(syncId, tenantId);
    if (row === undefined) throw new SessionError('not_found', 'The environment sync is unknown.');
    return toSync(syncRowSchema.parse(row));
  }

  plan(input: {
    syncId: string;
    sourceKind: 'file' | 'directory';
    files: EnvironmentSyncFileInput[];
    totalBytes: bigint;
  }): void {
    const now = this.now().toISOString();
    const fileCount = input.files.filter((file) => file.kind === 'file').length;
    this.database
      .prepare(
        `UPDATE environment_syncs SET source_kind = ?, file_count = ?, total_bytes = ?, updated_at = ?
         WHERE sync_id = ? AND status = 'running'`,
      )
      .run(input.sourceKind, fileCount, input.totalBytes.toString(), now, input.syncId);
    const insert = this.database.prepare(
      `INSERT INTO environment_sync_files(
        sync_file_id, sync_id, relative_path, source_path, target_path, kind, size,
        source_sha256, target_sha256, target_exists, executable, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    );
    for (const file of input.files) {
      insert.run(
        file.syncFileId,
        input.syncId,
        file.relativePath,
        file.sourcePath,
        file.targetPath,
        file.kind,
        file.size.toString(),
        file.sourceSha256,
        file.targetSha256,
        file.targetExists ? 1 : 0,
        file.executable ? 1 : 0,
        now,
        now,
      );
    }
  }

  files(syncId: string): EnvironmentSyncFileRecord[] {
    return this.database
      .prepare('SELECT * FROM environment_sync_files WHERE sync_id = ? ORDER BY relative_path')
      .all(syncId)
      .map((row) => toFile(fileRowSchema.parse(row)));
  }

  file(syncFileId: string): EnvironmentSyncFileRecord {
    const row = this.database
      .prepare('SELECT * FROM environment_sync_files WHERE sync_file_id = ?')
      .get(syncFileId);
    if (row === undefined)
      throw new SessionError('not_found', 'The environment sync file is unknown.');
    return toFile(fileRowSchema.parse(row));
  }

  setOperation(syncId: string, operationId: string | null): void {
    this.database
      .prepare(
        'UPDATE environment_syncs SET current_operation_id = ?, updated_at = ? WHERE sync_id = ?',
      )
      .run(operationId, this.now().toISOString(), syncId);
  }

  startFile(syncFileId: string, operationId: string): void {
    this.database
      .prepare(
        `UPDATE environment_sync_files SET status = 'running', operation_id = ?, error = NULL, updated_at = ?
         WHERE sync_file_id = ?`,
      )
      .run(operationId, this.now().toISOString(), syncFileId);
  }

  progressFile(syncFileId: string, operationId: string, bytesTransferred: bigint): void {
    this.database
      .prepare(
        `UPDATE environment_sync_files SET operation_id = ?, bytes_transferred = ?, updated_at = ?
         WHERE sync_file_id = ? AND status = 'running'`,
      )
      .run(operationId, bytesTransferred.toString(), this.now().toISOString(), syncFileId);
  }

  completeFile(input: {
    syncFileId: string;
    status: 'ready' | 'succeeded' | 'skipped' | 'failed' | 'unknown';
    operationId?: string;
    targetSha256?: string;
    error?: string;
    bytesTransferred?: bigint;
  }): void {
    this.database
      .prepare(
        `UPDATE environment_sync_files SET status = ?, operation_id = COALESCE(?, operation_id),
         target_sha256 = COALESCE(?, target_sha256), error = ?,
         bytes_transferred = COALESCE(?, bytes_transferred), updated_at = ?
         WHERE sync_file_id = ?`,
      )
      .run(
        input.status,
        input.operationId ?? null,
        input.targetSha256 ?? null,
        input.error ?? null,
        input.bytesTransferred?.toString() ?? null,
        this.now().toISOString(),
        input.syncFileId,
      );
  }

  failUnfinished(syncId: string, reason: string): void {
    this.database
      .prepare(
        `UPDATE environment_sync_files SET status = 'failed', error = ?, updated_at = ?
         WHERE sync_id = ? AND status IN ('pending', 'ready')`,
      )
      .run(reason, this.now().toISOString(), syncId);
  }

  addFailure(syncId: string, failure: EnvironmentSyncFailure): void {
    const sync = this.get(
      z
        .object({ tenant_id: z.string() })
        .parse(
          this.database
            .prepare('SELECT tenant_id FROM environment_syncs WHERE sync_id = ?')
            .get(syncId),
        ).tenant_id,
      syncId,
    );
    const failures = [...sync.failures, failureSchema.parse(failure)];
    this.database
      .prepare('UPDATE environment_syncs SET failures_json = ?, updated_at = ? WHERE sync_id = ?')
      .run(JSON.stringify(failures), this.now().toISOString(), syncId);
  }

  finish(syncId: string, status: Exclude<EnvironmentSyncStatus, 'running'>): EnvironmentSyncResult {
    const syncRow = this.database
      .prepare('SELECT tenant_id FROM environment_syncs WHERE sync_id = ?')
      .get(syncId);
    const tenantId = z.object({ tenant_id: z.string() }).parse(syncRow).tenant_id;
    const sync = this.get(tenantId, syncId);
    if (sync.status !== 'running') {
      return {
        status: sync.status,
        succeeded: sync.succeeded,
        skipped: sync.skipped,
        failed: sync.failed,
        failures: sync.failures,
      };
    }
    const entries = this.files(syncId);
    const files = entries.filter((file) => file.kind === 'file');
    const succeeded = files.filter((file) => file.status === 'succeeded').length;
    const skipped = files.filter((file) => file.status === 'skipped').length;
    const recordedFailurePaths = new Set(sync.failures.map((failure) => failure.path));
    const directoryFailures = entries
      .filter(
        (file) =>
          file.kind === 'directory' &&
          (file.status === 'failed' || file.status === 'unknown') &&
          !recordedFailurePaths.has(file.targetPath),
      )
      .map((file) => ({
        path: file.targetPath,
        reason:
          file.error ??
          (file.status === 'unknown'
            ? 'The directory result is unknown.'
            : 'The directory failed.'),
      }));
    const failures = [
      ...sync.failures,
      ...directoryFailures,
      ...files
        .filter((file) => file.status === 'failed' || file.status === 'unknown')
        .map((file) => ({
          path: file.targetPath,
          reason:
            file.error ??
            (file.status === 'unknown' ? 'The file result is unknown.' : 'The file failed.'),
        })),
    ];
    const failed =
      files.filter((file) => file.status === 'failed' || file.status === 'unknown').length +
      sync.failures.length +
      directoryFailures.length;
    const bounded = boundedFailures(failures);
    const now = this.now().toISOString();
    this.database
      .prepare(
        `UPDATE environment_syncs SET status = ?, succeeded = ?, skipped = ?, failed = ?,
         failures_json = ?, current_operation_id = NULL, updated_at = ?, finished_at = ?
         WHERE sync_id = ?`,
      )
      .run(status, succeeded, skipped, failed, JSON.stringify(bounded), now, now, syncId);
    return { status, succeeded, skipped, failed, failures: bounded };
  }

  result(tenantId: string, syncId: string): EnvironmentSyncResult | undefined {
    const sync = this.get(tenantId, syncId);
    if (sync.status === 'running') return undefined;
    return {
      status: sync.status,
      succeeded: sync.succeeded,
      skipped: sync.skipped,
      failed: sync.failed,
      failures: sync.failures,
    };
  }

  recoverInterrupted(): string[] {
    if (!hasSyncTables(this.database)) return [];
    const rows = z
      .array(z.object({ sync_id: z.string(), target_path: z.string() }))
      .parse(
        this.database
          .prepare("SELECT sync_id, target_path FROM environment_syncs WHERE status = 'running'")
          .all(),
      );
    const recovered: string[] = [];
    for (const row of rows) {
      const now = this.now().toISOString();
      this.database
        .prepare(
          `UPDATE environment_sync_files SET status = 'unknown', error = ?, updated_at = ?
           WHERE sync_id = ? AND status IN ('pending', 'ready', 'running')`,
        )
        .run(
          'Server restarted before this file result was confirmed; it was not replayed.',
          now,
          row.sync_id,
        );
      this.addFailure(row.sync_id, {
        path: row.target_path,
        reason: 'Server restarted during environment sync; unfinished writes were not replayed.',
      });
      this.finish(row.sync_id, 'unknown');
      recovered.push(row.sync_id);
    }
    return recovered;
  }
}

function hasSyncTables(database: DatabaseSync): boolean {
  return (
    database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'environment_syncs'",
      )
      .get() !== undefined
  );
}

function boundedFailures(failures: EnvironmentSyncFailure[]): EnvironmentSyncFailure[] {
  const bounded: EnvironmentSyncFailure[] = [];
  for (const [index, failure] of failures.entries()) {
    const remaining = failures.length - index;
    const candidate = [...bounded, failure];
    if (Buffer.byteLength(JSON.stringify(candidate)) <= DEVICE_SYNC_LIMITS.responseBytes) {
      bounded.push(failure);
      continue;
    }
    const omitted = {
      path: '',
      reason: `${remaining} additional failure(s) were omitted from the bounded response.`,
    };
    while (
      bounded.length > 0 &&
      Buffer.byteLength(JSON.stringify([...bounded, omitted])) > DEVICE_SYNC_LIMITS.responseBytes
    ) {
      bounded.pop();
    }
    bounded.push(omitted);
    break;
  }
  return bounded;
}
