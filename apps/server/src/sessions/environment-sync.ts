import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { ToolExecutionResult } from '@kairos/agent-core';
import {
  DEVICE_SYNC_LIMITS,
  DeviceCapability,
  OperationStatus,
  SyncEntryKind,
} from '@kairos/contracts/device';
import { z } from 'zod';
import type { EnvironmentOperationAction } from '../devices/environment-operation-store.js';
import type { EnvironmentStore } from '../devices/environment-store.js';
import type {
  EnvironmentOperationGateway,
  EnvironmentOperationRecord,
} from './environment-runtime.js';
import {
  type EnvironmentSyncConflict,
  type EnvironmentSyncFileInput,
  type EnvironmentSyncFileRecord,
  type EnvironmentSyncRecord,
  type EnvironmentSyncResult,
  EnvironmentSyncStore,
} from './environment-sync-store.js';
import { SessionError } from './errors.js';
import type { RunRecord } from './records.js';
import type { SessionStore } from './store.js';

const syncEntrySchema = z.object({
  relativePath: z.string().min(1).max(4096),
  kind: z.nativeEnum(SyncEntryKind),
  size: z.bigint().nonnegative(),
  sha256: z.string(),
  executable: z.boolean(),
});
const scanOutcomeSchema = z.object({
  path: z.string().min(1).max(4096),
  kind: z.nativeEnum(SyncEntryKind),
  size: z.bigint().nonnegative(),
  sha256: z.string(),
  executable: z.boolean(),
  entries: z.array(syncEntrySchema).max(DEVICE_SYNC_LIMITS.maxEntries),
  conflictScan: z.boolean().optional(),
  reason: z.string().max(1000).optional(),
});
const readOutcomeSchema = z.object({
  path: z.string().min(1).max(4096),
  offset: z.bigint().nonnegative(),
  data: z.instanceof(Uint8Array),
  size: z.bigint().nonnegative(),
  executable: z.boolean(),
  reason: z.string().max(1000).optional(),
});
const writeOutcomeSchema = z.object({
  path: z.string().min(1).max(4096),
  bytesWritten: z.bigint().nonnegative(),
  fileVersion: z.string(),
  nextOffset: z.bigint().nonnegative().optional(),
  transferComplete: z.boolean().optional(),
});

type SyncFailureKind = 'failed' | 'cancelled' | 'unknown';

class SyncFailure extends Error {
  constructor(
    readonly kind: SyncFailureKind,
    message: string,
    readonly path: string,
    readonly fatal = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SyncFailure';
  }
}

export interface EnvironmentSyncHost {
  prepare(input: {
    tenantId: string;
    envId: string;
    operationId: string;
    signal: AbortSignal;
  }): Promise<void>;
  startAndWait(input: {
    operationId: string;
    tenantId: string;
    envId: string;
    bindingVersion: bigint;
    action: EnvironmentOperationAction;
    signal: AbortSignal;
    expiresAt: Date;
  }): Promise<EnvironmentOperationRecord>;
  cancel(
    tenantId: string,
    operationId: string,
    reason: string,
  ): Promise<EnvironmentOperationRecord>;
}

export interface EnvironmentSyncInput {
  sourceEnvId: string;
  sourcePath: string;
  targetEnvId: string;
  targetPath: string;
  onConflict: EnvironmentSyncConflict;
}

export class EnvironmentSyncService {
  readonly syncs: EnvironmentSyncStore;

  constructor(
    private readonly options: {
      store: SessionStore;
      environments: EnvironmentStore;
      operations: EnvironmentOperationGateway;
      host: EnvironmentSyncHost;
      createId?: () => string;
      now?: () => Date;
    },
  ) {
    this.syncs = new EnvironmentSyncStore(options.store.database, options.now);
  }

  recoverInterrupted(): void {
    this.syncs.recoverInterrupted();
  }

  async execute(
    run: RunRecord,
    input: EnvironmentSyncInput,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const existing = this.syncs.find(run.runId, toolCallId);
    if (existing) {
      const result = this.syncs.result(run.ownerId, existing.syncId);
      if (result) return this.toolResult(existing.syncId, result);
      throw new SessionError(
        'operation_unknown',
        'The environment sync is still owned by another execution.',
        { retryable: true },
      );
    }
    requireSyncPath(input.sourcePath, 'source_path');
    requireSyncPath(input.targetPath, 'target_path');
    if (input.sourceEnvId === input.targetEnvId) {
      throw new SessionError(
        'invalid_argument',
        'source_env_id and target_env_id must resolve to different environments.',
      );
    }
    const specification = this.options.store.agentEnvironments.requireExecution(run);
    if (
      !specification.allowedEnv.includes(input.sourceEnvId) ||
      !specification.allowedEnv.includes(input.targetEnvId)
    ) {
      throw new SessionError(
        'permission_denied',
        'The source and target environments must both be authorized for this execution.',
      );
    }
    const syncId = `env-sync:${this.options.createId?.() ?? globalThis.crypto.randomUUID()}`;
    const now = this.options.now?.() ?? new Date();
    const deadlineAt = new Date(now.getTime() + DEVICE_SYNC_LIMITS.syncMilliseconds);
    const policy = this.options.store.agentEnvironments.requirePolicy(run.threadId, run.agentId);
    this.options.store.transaction(() => {
      this.syncs.create({
        syncId,
        tenantId: run.ownerId,
        runId: run.runId,
        toolCallId,
        sourceEnvId: input.sourceEnvId,
        sourcePath: input.sourcePath,
        targetEnvId: input.targetEnvId,
        targetPath: input.targetPath,
        onConflict: input.onConflict,
        deadlineAt,
      });
      this.options.store.agentEnvironments.recordOperationIntent({
        operationId: syncId,
        runId: run.runId,
        toolCallId,
        policy: { ...policy, currentHistoryId: specification.historyId },
        envId: input.targetEnvId,
        action: 'write',
        generation: run.generation,
        resolvedAction: { case: 'envSync', value: input },
      });
    });

    try {
      const result = await this.run(run, syncId, BigInt(policy.bindingVersion), signal);
      return this.toolResult(syncId, result);
    } catch (cause) {
      const failure =
        cause instanceof SyncFailure
          ? cause
          : signal.aborted
            ? new SyncFailure(
                'cancelled',
                'The environment sync was cancelled.',
                input.targetPath,
                true,
                {
                  cause,
                },
              )
            : new SyncFailure(
                'unknown',
                'Environment sync failed without a confirmed result.',
                input.targetPath,
                true,
                { cause },
              );
      if (failure.kind === 'cancelled') {
        const currentSync = this.syncs.get(run.ownerId, syncId);
        const rootDirectoryCreation =
          currentSync.currentOperationId === operationId(syncId, 'mkdir', '.');
        const cancelled = await this.cancelCurrent(run.ownerId, syncId);
        const running = this.syncs.files(syncId).find((file) => file.status === 'running');
        if (running) {
          const copied = confirmedSyncFile(cancelled, running);
          this.syncs.completeFile({
            syncFileId: running.syncFileId,
            status: copied ? 'succeeded' : 'failed',
            ...(copied
              ? { targetSha256: running.sourceSha256, bytesTransferred: running.size }
              : { error: 'The environment sync was cancelled.' }),
          });
        } else if (rootDirectoryCreation) {
          this.syncs.addFailure(syncId, {
            path: currentSync.targetPath,
            reason:
              cancelled === undefined
                ? 'Cancellation could not be confirmed.'
                : 'The environment sync was cancelled.',
          });
        }
        return this.toolResult(syncId, this.syncs.finish(syncId, 'cancelled'));
      }
      const running = this.syncs.files(syncId).find((file) => file.status === 'running');
      if (running) {
        this.syncs.completeFile({
          syncFileId: running.syncFileId,
          status: failure.kind === 'unknown' ? 'unknown' : 'failed',
          error: failure.message,
        });
      } else {
        const recorded = this.syncs
          .files(syncId)
          .some(
            (file) =>
              (file.status === 'failed' || file.status === 'unknown') &&
              file.error === failure.message,
          );
        if (!recorded)
          this.syncs.addFailure(syncId, { path: failure.path, reason: failure.message });
      }
      if (failure.kind === 'unknown') {
        return this.toolResult(syncId, this.syncs.finish(syncId, 'unknown'));
      }
      this.syncs.failUnfinished(
        syncId,
        'The file was not attempted after an earlier sync failure.',
      );
      return this.toolResult(syncId, this.syncs.finish(syncId, this.terminalStatus(syncId)));
    }
  }

  savedResult(runId: string, toolCallId: string): ToolExecutionResult | undefined {
    const sync = this.syncs.find(runId, toolCallId);
    if (!sync) return undefined;
    const result = this.syncs.result(sync.tenantId, sync.syncId);
    return result ? this.toolResult(sync.syncId, result) : undefined;
  }

  private async run(
    run: RunRecord,
    syncId: string,
    bindingVersion: bigint,
    signal: AbortSignal,
  ): Promise<EnvironmentSyncResult> {
    const sync = this.syncs.get(run.ownerId, syncId);
    const source = await this.scan(sync, sync.sourceEnvId, sync.sourcePath, bindingVersion, signal);
    if (source.kind !== SyncEntryKind.FILE && source.kind !== SyncEntryKind.DIRECTORY) {
      throw new SyncFailure(
        'failed',
        'The source must be an existing regular file or directory.',
        sync.sourcePath,
        true,
      );
    }
    const invalidSource = source.entries.find(
      (entry) => entry.kind === SyncEntryKind.SYMLINK || entry.kind === SyncEntryKind.SPECIAL,
    );
    if (invalidSource) {
      throw new SyncFailure(
        'failed',
        'Source directories must not contain symbolic links or special files.',
        posix.join(sync.sourcePath, invalidSource.relativePath),
        true,
      );
    }
    const sourceSizes =
      source.kind === SyncEntryKind.FILE
        ? [source.size]
        : source.entries
            .filter((entry) => entry.kind === SyncEntryKind.FILE)
            .map((entry) => entry.size);
    const sourceBytes = sourceSizes.reduce((total, size) => total + size, 0n);
    if (
      sourceSizes.length > DEVICE_SYNC_LIMITS.maxFiles ||
      sourceSizes.some((size) => size > DEVICE_SYNC_LIMITS.maxFileBytes) ||
      sourceBytes > DEVICE_SYNC_LIMITS.maxTotalBytes
    ) {
      throw new SyncFailure(
        'failed',
        'The source exceeds the environment sync resource limits.',
        sync.sourcePath,
        true,
      );
    }
    const target = await this.scan(
      sync,
      sync.targetEnvId,
      sync.targetPath,
      bindingVersion,
      signal,
      source,
    );
    if (target.conflictScan !== true) {
      throw new SyncFailure(
        'unknown',
        'The target conflict scan mode could not be confirmed.',
        sync.targetPath,
        true,
      );
    }
    if (
      source.kind === SyncEntryKind.DIRECTORY &&
      target.kind !== SyncEntryKind.MISSING &&
      target.kind !== SyncEntryKind.DIRECTORY
    ) {
      throw new SyncFailure(
        'failed',
        'The directory target exists and is not a real directory.',
        sync.targetPath,
        true,
      );
    }

    const files = planFiles(sync, source, target);
    this.options.store.transaction(() => {
      this.syncs.plan({
        syncId,
        sourceKind: source.kind === SyncEntryKind.FILE ? 'file' : 'directory',
        files,
        totalBytes: files.reduce(
          (total, file) => total + (file.kind === 'file' ? file.size : 0n),
          0n,
        ),
      });
      applyConflictPlan(sync, files, target, this.syncs);
    });

    if (source.kind === SyncEntryKind.DIRECTORY && target.kind === SyncEntryKind.MISSING) {
      await this.createDirectory(sync, undefined, sync.targetPath, bindingVersion, signal);
    }
    const failedDirectories = new Set<string>();
    const skippedDirectories = new Set<string>();
    const directories = this.syncs
      .files(syncId)
      .filter((file) => file.kind === 'directory')
      .sort(
        (left, right) => left.relativePath.split('/').length - right.relativePath.split('/').length,
      );
    for (const directory of directories) {
      signal.throwIfAborted();
      const parentFailure = failedDirectory(directory.relativePath, failedDirectories);
      const parentSkipped = failedDirectory(directory.relativePath, skippedDirectories);
      if (parentSkipped) {
        skippedDirectories.add(directory.relativePath);
        this.syncs.completeFile({
          syncFileId: directory.syncFileId,
          status: 'skipped',
          error: 'A parent path is not a directory and was skipped.',
        });
        continue;
      }
      if (directory.status === 'failed' || parentFailure) {
        failedDirectories.add(directory.relativePath);
        this.syncs.completeFile({
          syncFileId: directory.syncFileId,
          status: 'failed',
          error: parentFailure
            ? 'A parent directory could not be created.'
            : 'The target directory conflicts with an existing non-directory entry.',
        });
        this.syncs.addFailure(syncId, {
          path: directory.targetPath,
          reason: 'The target directory could not be created.',
        });
        continue;
      }
      if (directory.status === 'skipped') {
        if (directory.error) skippedDirectories.add(directory.relativePath);
        continue;
      }
      try {
        await this.createDirectory(sync, directory, directory.targetPath, bindingVersion, signal);
      } catch (cause) {
        const failure = asSyncFailure(cause, directory.targetPath);
        if (failure.kind !== 'failed') throw failure;
        failedDirectories.add(directory.relativePath);
        this.syncs.completeFile({
          syncFileId: directory.syncFileId,
          status: 'failed',
          error: failure.message,
        });
        this.syncs.addFailure(syncId, { path: directory.targetPath, reason: failure.message });
        if (failure.fatal) throw failure;
      }
    }

    const filesToCopy = this.syncs.files(syncId).filter((file) => file.kind === 'file');
    for (const file of filesToCopy) {
      signal.throwIfAborted();
      if (file.status === 'skipped' || file.status === 'failed') continue;
      const parentFailure = failedDirectory(file.relativePath, failedDirectories);
      if (parentFailure) {
        this.syncs.completeFile({
          syncFileId: file.syncFileId,
          status: 'failed',
          error: 'A parent directory could not be created.',
        });
        continue;
      }
      if (failedDirectory(file.relativePath, skippedDirectories)) {
        this.syncs.completeFile({
          syncFileId: file.syncFileId,
          status: 'skipped',
          error: 'A parent path is not a directory and was skipped.',
          bytesTransferred: 0n,
        });
        continue;
      }
      const copied = await this.copyFile(sync, file, bindingVersion, signal);
      if (copied === 'unknown') return this.syncs.finish(syncId, 'unknown');
    }
    return this.syncs.finish(syncId, this.terminalStatus(syncId));
  }

  private async scan(
    sync: EnvironmentSyncRecord,
    envId: string,
    path: string,
    bindingVersion: bigint,
    signal: AbortSignal,
    source?: z.infer<typeof scanOutcomeSchema>,
  ): Promise<z.infer<typeof scanOutcomeSchema>> {
    const side = envId === sync.sourceEnvId ? 'source' : 'target';
    const conflict = source !== undefined && side === 'target';
    const operation = await this.operation(sync, {
      operationId: operationId(sync.syncId, `${side}-scan`),
      envId,
      action: {
        case: 'syncScan',
        value: {
          path,
          cwd: '/',
          relativePaths:
            source?.kind === SyncEntryKind.FILE
              ? ['.']
              : (source?.entries.map((entry) => entry.relativePath) ?? []),
          ...(conflict ? { conflictScan: true } : {}),
        },
      },
      bindingVersion,
      signal,
      path,
    });
    return scanOutcomeSchema.parse(outcomeValue(operation, 'syncScan'));
  }

  private async createDirectory(
    sync: EnvironmentSyncRecord,
    file: EnvironmentSyncFileRecord | undefined,
    path: string,
    bindingVersion: bigint,
    signal: AbortSignal,
  ): Promise<void> {
    const id = operationId(sync.syncId, 'mkdir', file?.relativePath ?? '.');
    if (file) this.syncs.startFile(file.syncFileId, id);
    const operation = await this.operation(sync, {
      operationId: id,
      envId: sync.targetEnvId,
      action: {
        case: 'write',
        value: {
          path,
          cwd: '/',
          content: '',
          overwrite: false,
          createParents: true,
          createDirectory: true,
        },
      },
      bindingVersion,
      signal,
      path,
    });
    writeOutcomeSchema.parse(outcomeValue(operation, 'write'));
    if (file) {
      this.syncs.completeFile({
        syncFileId: file.syncFileId,
        status: 'succeeded',
        operationId: id,
      });
    }
  }

  private async copyFile(
    sync: EnvironmentSyncRecord,
    file: EnvironmentSyncFileRecord,
    bindingVersion: bigint,
    signal: AbortSignal,
  ): Promise<'copied' | 'unknown'> {
    const overwrite = file.targetExists && sync.onConflict === 'overwrite';
    try {
      let offset = 0n;
      do {
        this.assertDeadline(sync, file.targetPath);
        let data = new Uint8Array();
        if (file.size > 0n) {
          const readId = operationId(sync.syncId, 'read', file.relativePath, offset);
          if (offset === 0n) this.syncs.startFile(file.syncFileId, readId);
          const read = await this.operation(sync, {
            operationId: readId,
            envId: sync.sourceEnvId,
            action: {
              case: 'syncRead',
              value: {
                path: file.sourcePath,
                cwd: '/',
                offset,
                limit: Number(minBigInt(BigInt(DEVICE_SYNC_LIMITS.chunkBytes), file.size - offset)),
              },
            },
            bindingVersion,
            signal,
            path: file.sourcePath,
          });
          const outcome = readOutcomeSchema.parse(outcomeValue(read, 'syncRead'));
          if (
            outcome.offset !== offset ||
            outcome.size !== file.size ||
            outcome.executable !== file.executable ||
            outcome.data.length === 0
          ) {
            throw new SyncFailure(
              'failed',
              'The source changed or returned an inconsistent chunk.',
              file.sourcePath,
            );
          }
          data = outcome.data;
        }
        const writeId = operationId(sync.syncId, 'write', file.relativePath, offset);
        if (offset === 0n && file.size === 0n) this.syncs.startFile(file.syncFileId, writeId);
        const write = await this.operation(sync, {
          operationId: writeId,
          envId: sync.targetEnvId,
          action: {
            case: 'write',
            value: {
              path: file.targetPath,
              cwd: '/',
              content: '',
              binaryContent: data,
              overwrite,
              createParents: true,
              transferId: file.syncFileId,
              offset,
              totalSize: file.size,
              expectedSha256: file.sourceSha256,
              executable: file.executable,
            },
          },
          bindingVersion,
          signal,
          path: file.targetPath,
        });
        const outcome = writeOutcomeSchema.parse(outcomeValue(write, 'write'));
        offset += BigInt(data.length);
        if (outcome.nextOffset !== offset) {
          throw new SyncFailure(
            'unknown',
            'The target write offset could not be confirmed.',
            file.targetPath,
            true,
          );
        }
        this.syncs.progressFile(file.syncFileId, writeId, offset);
      } while (offset < file.size);
      this.syncs.completeFile({
        syncFileId: file.syncFileId,
        status: 'succeeded',
        targetSha256: file.sourceSha256,
        bytesTransferred: file.size,
      });
      return 'copied';
    } catch (cause) {
      const failure = asSyncFailure(cause, file.targetPath);
      if (failure.kind === 'cancelled') throw failure;
      this.syncs.completeFile({
        syncFileId: file.syncFileId,
        status: failure.kind === 'unknown' ? 'unknown' : 'failed',
        error: failure.message,
      });
      if (failure.kind === 'unknown') return 'unknown';
      if (failure.fatal) throw failure;
      return 'copied';
    }
  }

  private async operation(
    sync: EnvironmentSyncRecord,
    input: {
      operationId: string;
      envId: string;
      action: EnvironmentOperationAction;
      bindingVersion: bigint;
      signal: AbortSignal;
      path: string;
    },
  ): Promise<EnvironmentOperationRecord> {
    if (input.signal.aborted)
      throw new SyncFailure('cancelled', 'The environment sync was cancelled.', input.path, true);
    this.assertDeadline(sync, input.path);
    this.syncs.setOperation(sync.syncId, input.operationId);
    try {
      await this.options.host.prepare({
        tenantId: sync.tenantId,
        envId: input.envId,
        operationId: input.operationId,
        signal: input.signal,
      });
      requireCapabilities(this.options.environments.get(sync.tenantId, input.envId), [
        input.action.case === 'write' ? DeviceCapability.FILE_WRITE : DeviceCapability.FILE_READ,
      ]);
    } catch (cause) {
      if (input.signal.aborted)
        throw new SyncFailure(
          'cancelled',
          'The environment sync was cancelled.',
          input.path,
          true,
          { cause },
        );
      throw new SyncFailure('failed', errorMessage(cause), input.path, false, { cause });
    }
    let operation: EnvironmentOperationRecord;
    try {
      const expiresAt = new Date(
        Math.min(
          (this.options.now?.() ?? new Date()).getTime() + DEVICE_SYNC_LIMITS.operationMilliseconds,
          Date.parse(sync.deadlineAt),
        ),
      );
      operation = await this.options.host.startAndWait({
        operationId: input.operationId,
        tenantId: sync.tenantId,
        envId: input.envId,
        bindingVersion: input.bindingVersion,
        action: input.action,
        signal: input.signal,
        expiresAt,
      });
    } catch (cause) {
      if (input.signal.aborted)
        throw new SyncFailure(
          'cancelled',
          'The environment sync was cancelled.',
          input.path,
          true,
          { cause },
        );
      throw new SyncFailure('unknown', errorMessage(cause), input.path, true, { cause });
    }
    const status = terminal(operation);
    if (status === OperationStatus.COMPLETED) return operation;
    if (status === OperationStatus.CANCELLED && input.signal.aborted) {
      throw new SyncFailure('cancelled', 'The environment sync was cancelled.', input.path, true);
    }
    if (status === OperationStatus.FAILED || status === OperationStatus.CANCELLED) {
      throw new SyncFailure('failed', operationReason(operation), input.path);
    }
    throw new SyncFailure('unknown', operationReason(operation), input.path, true);
  }

  private assertDeadline(sync: EnvironmentSyncRecord, path: string): void {
    if ((this.options.now?.() ?? new Date()).getTime() >= Date.parse(sync.deadlineAt)) {
      throw new SyncFailure(
        'failed',
        'The environment sync exceeded its five-minute deadline.',
        path,
        true,
      );
    }
  }

  private async cancelCurrent(
    tenantId: string,
    syncId: string,
  ): Promise<EnvironmentOperationRecord | undefined> {
    const current = this.syncs.get(tenantId, syncId).currentOperationId;
    if (!current) return undefined;
    try {
      return await this.options.host.cancel(tenantId, current, 'The Agent Run was cancelled.');
    } catch {
      const running = this.syncs.files(syncId).find((file) => file.status === 'running');
      if (running)
        this.syncs.completeFile({
          syncFileId: running.syncFileId,
          status: 'unknown',
          error: 'Cancellation could not be confirmed.',
        });
      return undefined;
    }
  }

  private terminalStatus(syncId: string): 'completed' | 'partial' | 'failed' {
    const syncRow = this.options.store.database
      .prepare('SELECT failures_json FROM environment_syncs WHERE sync_id = ?')
      .get(syncId);
    const structuralFailures = z
      .array(z.unknown())
      .parse(
        JSON.parse(z.object({ failures_json: z.string() }).parse(syncRow).failures_json),
      ).length;
    const files = this.syncs.files(syncId).filter((file) => file.kind === 'file');
    const failed =
      files.filter((file) => file.status === 'failed' || file.status === 'unknown').length +
      structuralFailures;
    if (failed === 0) return 'completed';
    const finished = files.filter(
      (file) => file.status === 'succeeded' || file.status === 'skipped',
    ).length;
    return finished > 0 ? 'partial' : 'failed';
  }

  private toolResult(syncId: string, result: EnvironmentSyncResult): ToolExecutionResult {
    const content = JSON.stringify(result);
    const status = result.status === 'completed' ? 'success' : 'error';
    return {
      content,
      status,
      commit: () => {
        this.options.store.agentEnvironments.recordOperationResult(syncId, content, status);
      },
    };
  }
}

function planFiles(
  sync: EnvironmentSyncRecord,
  source: z.infer<typeof scanOutcomeSchema>,
  target: z.infer<typeof scanOutcomeSchema>,
): EnvironmentSyncFileInput[] {
  if (source.kind === SyncEntryKind.FILE) {
    const targetSha256 = target.kind === SyncEntryKind.FILE ? target.sha256 : '';
    return [
      fileInput(
        sync,
        '.',
        sync.sourcePath,
        sync.targetPath,
        'file',
        source.size,
        source.sha256,
        targetSha256,
        target.kind === SyncEntryKind.FILE,
        source.executable,
      ),
    ];
  }
  return source.entries.map((entry) =>
    fileInput(
      sync,
      entry.relativePath,
      posix.join(sync.sourcePath, entry.relativePath),
      posix.join(sync.targetPath, entry.relativePath),
      entry.kind === SyncEntryKind.DIRECTORY ? 'directory' : 'file',
      entry.size,
      entry.sha256,
      target.entries.find((candidate) => candidate.relativePath === entry.relativePath)?.sha256 ??
        '',
      target.entries.find((candidate) => candidate.relativePath === entry.relativePath)?.kind ===
        SyncEntryKind.FILE,
      entry.executable,
    ),
  );
}

function fileInput(
  sync: EnvironmentSyncRecord,
  relativePath: string,
  sourcePath: string,
  targetPath: string,
  kind: 'file' | 'directory',
  size: bigint,
  sourceSha256: string,
  targetSha256: string,
  targetExists: boolean,
  executable: boolean,
): EnvironmentSyncFileInput {
  return {
    syncFileId: `env-sync-file:${sync.syncId}:${createHash('sha256').update(relativePath).digest('hex').slice(0, 24)}`,
    relativePath,
    sourcePath,
    targetPath,
    kind,
    size,
    sourceSha256,
    targetSha256,
    targetExists,
    executable,
  };
}

function applyConflictPlan(
  sync: EnvironmentSyncRecord,
  files: EnvironmentSyncFileInput[],
  target: z.infer<typeof scanOutcomeSchema>,
  syncs: EnvironmentSyncStore,
): void {
  for (const file of files) {
    const existing =
      sync.sourceKind === 'file'
        ? target.kind === SyncEntryKind.MISSING
          ? undefined
          : { kind: target.kind, sha256: target.sha256 }
        : target.entries.find((entry) => entry.relativePath === file.relativePath);
    if (file.kind === 'directory') {
      if (existing === undefined) {
        syncs.completeFile({ syncFileId: file.syncFileId, status: 'ready' });
      } else if (existing.kind === SyncEntryKind.DIRECTORY) {
        syncs.completeFile({ syncFileId: file.syncFileId, status: 'skipped' });
      } else if (sync.onConflict === 'skip') {
        syncs.completeFile({
          syncFileId: file.syncFileId,
          status: 'skipped',
          error: 'The target path is not a directory and was skipped.',
        });
      } else {
        syncs.completeFile({
          syncFileId: file.syncFileId,
          status: 'failed',
          error: 'The target path is not a directory.',
        });
      }
      continue;
    }
    if (existing === undefined) {
      syncs.completeFile({ syncFileId: file.syncFileId, status: 'ready' });
    } else if (existing.kind !== SyncEntryKind.FILE) {
      syncs.completeFile({
        syncFileId: file.syncFileId,
        status: 'failed',
        error: 'The target exists and is not a regular file.',
      });
    } else if (existing.sha256 === file.sourceSha256) {
      syncs.completeFile({
        syncFileId: file.syncFileId,
        status: 'skipped',
        targetSha256: existing.sha256,
        bytesTransferred: 0n,
      });
    } else if (sync.onConflict === 'skip') {
      syncs.completeFile({
        syncFileId: file.syncFileId,
        status: 'skipped',
        targetSha256: existing.sha256,
        error: 'The target contains different content and was skipped.',
        bytesTransferred: 0n,
      });
    } else if (sync.onConflict === 'fail') {
      syncs.completeFile({
        syncFileId: file.syncFileId,
        status: 'failed',
        targetSha256: existing.sha256,
        error: 'The target contains different content; on_conflict is fail.',
      });
    } else {
      syncs.completeFile({
        syncFileId: file.syncFileId,
        status: 'ready',
        targetSha256: existing.sha256,
      });
    }
  }
}

function confirmedSyncFile(
  operation: EnvironmentOperationRecord | undefined,
  file: EnvironmentSyncFileRecord,
): boolean {
  if (
    file.kind !== 'file' ||
    !operation ||
    operation.action.case !== 'write' ||
    operation.action.value.totalSize !== file.size ||
    terminal(operation) !== OperationStatus.COMPLETED
  ) {
    return false;
  }
  const outcome: unknown = operation.outcome;
  if (
    typeof outcome !== 'object' ||
    outcome === null ||
    !('case' in outcome) ||
    !('value' in outcome)
  ) {
    return false;
  }
  if (outcome.case !== 'write') return false;
  const parsed = writeOutcomeSchema.safeParse(outcome.value);
  return (
    parsed.success &&
    parsed.data.transferComplete === true &&
    parsed.data.nextOffset === file.size &&
    parsed.data.fileVersion === file.sourceSha256
  );
}

function failedDirectory(relativePath: string, failures: ReadonlySet<string>): boolean {
  if (relativePath === '.') return false;
  return [...failures].some((failure) => relativePath.startsWith(`${failure}/`));
}

function operationId(
  syncId: string,
  action: string,
  relativePath?: string,
  offset?: bigint,
): string {
  const suffix =
    relativePath === undefined
      ? ''
      : `:${createHash('sha256').update(relativePath).digest('hex').slice(0, 16)}`;
  const chunk = offset === undefined ? '' : `:${offset.toString()}`;
  return `env-sync-operation:${syncId}:${action}${suffix}${chunk}`;
}

function requireSyncPath(value: string, field: string): void {
  if (
    !value.startsWith('/') ||
    value.length > 4096 ||
    value.includes('\0') ||
    posix.normalize(value) !== value ||
    (value.length > 1 && value.endsWith('/'))
  ) {
    throw new SessionError(
      'invalid_argument',
      `${field} must be a normalized absolute POSIX path.`,
    );
  }
}

function requireCapabilities(
  environment: ReturnType<EnvironmentStore['get']>,
  capabilities: readonly DeviceCapability[],
): void {
  if (!capabilities.every((capability) => environment.grantedCapabilities.includes(capability))) {
    throw new SessionError(
      'permission_denied',
      'The source requires read capability and the target requires read and write capabilities.',
    );
  }
}

function outcomeValue(operation: EnvironmentOperationRecord, expected: string): unknown {
  const outcome = operation.outcome;
  if (typeof outcome === 'object' && outcome !== null && 'case' in outcome && 'value' in outcome) {
    if (outcome.case !== expected)
      throw new SyncFailure(
        'unknown',
        'The environment Operation outcome has the wrong type.',
        '',
        true,
      );
    return outcome.value;
  }
  throw new SyncFailure('unknown', 'The environment Operation outcome is missing.', '', true);
}

function terminal(operation: EnvironmentOperationRecord): OperationStatus | undefined {
  const status = operation.resultStatus ?? operation.status;
  return status >= OperationStatus.COMPLETED && status <= OperationStatus.UNKNOWN
    ? status
    : undefined;
}

function operationReason(operation: EnvironmentOperationRecord): string {
  const outcome = operation.outcome;
  if (typeof outcome === 'object' && outcome !== null && 'value' in outcome) {
    const value: unknown = outcome.value;
    if (
      typeof value === 'object' &&
      value !== null &&
      'reason' in value &&
      typeof value.reason === 'string'
    ) {
      return value.reason;
    }
  }
  return `Environment Operation ended with status ${OperationStatus[terminal(operation) ?? OperationStatus.UNKNOWN].toLowerCase()}.`;
}

function asSyncFailure(cause: unknown, path: string): SyncFailure {
  if (cause instanceof SyncFailure) return cause;
  if (cause instanceof Error && cause.name === 'AbortError') {
    return new SyncFailure('cancelled', 'The environment sync was cancelled.', path, true, {
      cause,
    });
  }
  return new SyncFailure('unknown', errorMessage(cause), path, true, { cause });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
