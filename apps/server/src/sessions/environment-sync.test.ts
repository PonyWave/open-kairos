import { createHash } from 'node:crypto';
import { OperationStatus, SyncEntryKind } from '@kairos/contracts/device';
import { expect, it, vi } from 'vitest';
import { EnvironmentOperationStore } from '../devices/environment-operation-store.js';
import { EnvironmentStore } from '../devices/environment-store.js';
import {
  ControlledEnvironmentUseGateway,
  seedReadyMainEnvironment,
  seedTestEnvironment,
} from '../integration/environment-fixture.js';
import { openDatabase } from '../storage/database.js';
import {
  AgentEnvironmentRuntime,
  type EnvironmentOperationAction,
  type EnvironmentOperationGateway,
  type EnvironmentOperationRecord,
} from './environment-runtime.js';
import { SessionStore } from './store.js';

class DeferredSyncOperations implements EnvironmentOperationGateway {
  readonly started: Array<{
    operationId: string;
    envId: string;
    action: EnvironmentOperationAction;
  }> = [];
  readonly cancelled: string[] = [];
  readonly #operations = new Map<string, EnvironmentOperationRecord>();
  #deferredOperationId: string | undefined;
  #writeCount = 0;
  deferWrites = 0;
  unknownNestedDirectory = false;
  deferNestedDirectory = false;
  deferRootDirectory = false;
  failCancellation = false;

  constructor(private readonly environments: EnvironmentStore) {}

  async startEnvironmentOperation(input: {
    operationId: string;
    tenantId: string;
    envId: string;
    bindingVersion?: bigint;
    action: EnvironmentOperationAction;
    expiresAt: Date;
  }): Promise<EnvironmentOperationRecord> {
    this.started.push({
      operationId: input.operationId,
      envId: input.envId,
      action: structuredClone(input.action),
    });
    const chunked = input.action.case === 'write' && input.action.value.transferId !== undefined;
    if (chunked) this.#writeCount += 1;
    const nestedDirectory =
      input.action.case === 'write' &&
      input.action.value.createDirectory === true &&
      input.action.value.path === '/target/nested';
    const rootDirectory =
      input.action.case === 'write' &&
      input.action.value.createDirectory === true &&
      input.action.value.path === '/target';
    const deferred =
      (this.deferNestedDirectory && nestedDirectory) ||
      (this.deferRootDirectory && rootDirectory) ||
      (chunked && this.deferWrites > 0 && this.#writeCount > this.deferWrites);
    const unknownDirectory = this.unknownNestedDirectory && nestedDirectory;
    if (deferred) this.#deferredOperationId = input.operationId;
    const operation: EnvironmentOperationRecord = {
      operationId: input.operationId,
      tenantId: input.tenantId,
      envId: input.envId,
      deviceBindingId: this.environments.get(input.tenantId, input.envId).deviceBindingId ?? '',
      targetInstanceId: this.environments.get(input.tenantId, input.envId).instanceId ?? '',
      action: structuredClone(input.action),
      status: deferred
        ? OperationStatus.RUNNING
        : unknownDirectory
          ? OperationStatus.UNKNOWN
          : OperationStatus.COMPLETED,
      outputComplete: true,
      postProcessedAt: new Date().toISOString(),
      resultSource: 'device',
      ...(deferred
        ? {}
        : {
            resultStatus: unknownDirectory ? OperationStatus.UNKNOWN : OperationStatus.COMPLETED,
            outcome: unknownDirectory
              ? this.emptyOutcome(input.action)
              : this.outcome(input.envId, input.action),
          }),
      expiresAt: input.expiresAt.toISOString(),
    };
    this.#operations.set(input.operationId, operation);
    return operation;
  }

  async cancelEnvironmentOperation(input: {
    tenantId: string;
    operationId: string;
    reason: string;
  }): Promise<EnvironmentOperationRecord> {
    this.cancelled.push(input.operationId);
    if (this.failCancellation) throw new Error('Cancellation confirmation failed.');
    const operation = this.#operations.get(input.operationId);
    if (!operation) throw new Error('Unknown operation.');
    operation.status = OperationStatus.CANCELLED;
    operation.resultStatus = OperationStatus.CANCELLED;
    operation.outcome = this.emptyOutcome(operation.action);
    return operation;
  }

  completeDeferred(status: OperationStatus): void {
    if (!this.#deferredOperationId) throw new Error('No deferred Operation exists.');
    const operation = this.#operations.get(this.#deferredOperationId);
    if (!operation) throw new Error('The deferred Operation is missing.');
    operation.status = status;
    operation.resultStatus = status;
    operation.outcome =
      status === OperationStatus.COMPLETED
        ? this.outcome(operation.envId, operation.action)
        : this.emptyOutcome(operation.action);
  }

  getEnvironmentOperation(tenantId: string, operationId: string): EnvironmentOperationRecord {
    const operation = this.#operations.get(operationId);
    if (!operation || operation.tenantId !== tenantId) throw new Error('Unknown operation.');
    return operation;
  }

  readEnvironmentOperationSpill(): { data: Uint8Array; truncated: boolean } | undefined {
    return undefined;
  }

  readEnvironmentOperationOutput() {
    return { data: new Uint8Array(), nextOffset: 0n, outputComplete: true, outputGap: false };
  }

  private outcome(envId: string, action: EnvironmentOperationAction) {
    if (action.case === 'syncScan') {
      if (envId === 'env-2') {
        return {
          case: 'syncScan',
          value: {
            path: action.value.path,
            kind:
              this.unknownNestedDirectory || this.deferNestedDirectory
                ? SyncEntryKind.DIRECTORY
                : SyncEntryKind.MISSING,
            size: 0n,
            sha256: '',
            executable: false,
            conflictScan: true,
            entries: [],
          },
        };
      }
      return {
        case: 'syncScan',
        value: {
          path: action.value.path,
          kind: SyncEntryKind.DIRECTORY,
          size: 0n,
          sha256: '',
          executable: false,
          conflictScan: false,
          entries:
            this.unknownNestedDirectory || this.deferNestedDirectory
              ? [
                  {
                    relativePath: 'nested',
                    kind: SyncEntryKind.DIRECTORY,
                    size: 0n,
                    sha256: '',
                    executable: false,
                  },
                  {
                    relativePath: 'nested/a.txt',
                    kind: SyncEntryKind.FILE,
                    size: 1n,
                    sha256: createHash('sha256').update('a').digest('hex'),
                    executable: false,
                  },
                ]
              : ['a.txt', 'b.txt'].map((relativePath) => ({
                  relativePath,
                  kind: SyncEntryKind.FILE,
                  size: 1n,
                  sha256: createHash('sha256')
                    .update(relativePath[0] ?? '')
                    .digest('hex'),
                  executable: false,
                })),
        },
      };
    }
    if (action.case === 'syncRead') {
      return {
        case: 'syncRead',
        value: {
          path: action.value.path,
          offset: action.value.offset,
          data: new TextEncoder().encode(action.value.path.includes('a.txt') ? 'a' : 'b'),
          size: 1n,
          executable: false,
        },
      };
    }
    if (action.case === 'write') {
      return {
        case: 'write',
        value: {
          path: action.value.path,
          bytesWritten: BigInt(action.value.binaryContent?.length ?? 0),
          fileVersion: action.value.expectedSha256 ?? '',
          nextOffset: (action.value.offset ?? 0n) + BigInt(action.value.binaryContent?.length ?? 0),
          transferComplete: true,
        },
      };
    }
    throw new Error(`Unexpected ${action.case} Operation.`);
  }

  private emptyOutcome(action: EnvironmentOperationAction) {
    if (action.case === 'write') {
      return {
        case: 'write',
        value: { path: action.value.path, bytesWritten: 0n, fileVersion: '' },
      };
    }
    if (action.case === 'syncRead') {
      return {
        case: 'syncRead',
        value: {
          path: action.value.path,
          offset: action.value.offset,
          data: new Uint8Array(),
          size: 0n,
          executable: false,
        },
      };
    }
    if (action.case === 'syncScan') {
      return {
        case: 'syncScan',
        value: {
          path: action.value.path,
          kind: SyncEntryKind.MISSING,
          size: 0n,
          sha256: '',
          executable: false,
          entries: [],
        },
      };
    }
    throw new Error(`Unexpected ${action.case} Operation.`);
  }
}

function fixture() {
  const database = openDatabase(':memory:');
  new EnvironmentOperationStore(database);
  const store = new SessionStore(database);
  const environments = new EnvironmentStore(database);
  seedTestEnvironment(database, 'tenant-1', 'env-1', '/source');
  seedTestEnvironment(database, 'tenant-1', 'env-2', '/target');
  const operations = new DeferredSyncOperations(environments);
  const task = store.createThread({
    ownerId: 'tenant-1',
    clientActionId: `create-${globalThis.crypto.randomUUID()}`,
    method: 'CreateThread',
    parameters: {},
    title: 'sync recovery',
    initialText: 'sync',
    initialMode: 'follow_up',
    environmentPolicy: { allowedEnv: ['env-1', 'env-2'] },
  });
  const runtime = new AgentEnvironmentRuntime({
    store,
    environments,
    operations,
    environmentUse: new ControlledEnvironmentUseGateway(database),
  });
  return { database, store, environments, operations, runtime, run: store.getRunById(task.runId) };
}

const input = {
  sourceEnvId: 'env-1',
  sourcePath: '/source',
  targetEnvId: 'env-2',
  targetPath: '/target',
  onConflict: 'fail' as const,
};

it('persists completed files and reports the current file when a later write is cancelled', async () => {
  const { database, store, operations, runtime, run } = fixture();
  try {
    operations.deferWrites = 1;
    const controller = new AbortController();
    const pending = runtime.sync(run, input, 'cancel-sync', controller.signal);
    await vi.waitFor(() =>
      expect(
        operations.started.filter(
          (entry) => entry.action.case === 'write' && entry.action.value.transferId !== undefined,
        ),
      ).toHaveLength(2),
    );
    controller.abort();
    const result = await pending;
    expect(JSON.parse(result.content)).toMatchObject({
      status: 'cancelled',
      succeeded: 1,
      skipped: 0,
      failed: 1,
    });
    expect(JSON.parse(result.content).failures[0].path).toBe('/target/b.txt');
    expect(operations.cancelled).toHaveLength(1);
    expect(
      database
        .prepare(
          "SELECT status, succeeded, failed FROM environment_syncs WHERE tool_call_id = 'cancel-sync'",
        )
        .get(),
    ).toMatchObject({ status: 'cancelled', succeeded: 1, failed: 1 });
    expect(store.agentEnvironments.findOperation(run.runId, 'cancel-sync')).toMatchObject({
      action: 'write',
    });
  } finally {
    database.close();
  }
});

it('marks an interrupted sync unknown and recovers its result without replaying writes', async () => {
  const { database, operations, runtime, run } = fixture();
  try {
    operations.deferWrites = 1;
    const pending = runtime.sync(run, input, 'restart-sync', new AbortController().signal);
    await vi.waitFor(() =>
      expect(
        operations.started.filter(
          (entry) => entry.action.case === 'write' && entry.action.value.transferId !== undefined,
        ),
      ).toHaveLength(2),
    );
    const beforeRecovery = operations.started.length;
    const recoveredRuntime = new AgentEnvironmentRuntime({
      store: runtime.store,
      environments: runtime.environments,
      operations,
      environmentUse: new ControlledEnvironmentUseGateway(database),
    });
    recoveredRuntime.recoverReloads();
    expect(operations.started).toHaveLength(beforeRecovery);
    const recovered = await recoveredRuntime.savedResult(run.runId, 'restart-sync');
    expect(JSON.parse(recovered?.content ?? '{}')).toMatchObject({
      status: 'unknown',
      succeeded: 1,
      skipped: 0,
      failed: 2,
    });
    expect(operations.started).toHaveLength(beforeRecovery);
    expect(
      database
        .prepare("SELECT status FROM environment_sync_files WHERE relative_path = 'b.txt'")
        .get(),
    ).toMatchObject({ status: 'unknown' });
    operations.completeDeferred(OperationStatus.UNKNOWN);
    await pending;
  } finally {
    database.close();
  }
});

it('routes env_sync through the main alias while auditing the real environment ID', async () => {
  const { database, store, operations, runtime, run } = fixture();
  try {
    seedReadyMainEnvironment(database, 'tenant-1', 'main', '/workspace');
    const result = await runtime.sync(
      run,
      { ...input, sourceEnvId: 'main' },
      'sandbox-sync',
      new AbortController().signal,
    );
    const sandboxId = store.agentEnvironments.requireExecution(run).defaultEnv;
    expect(JSON.parse(result.content)).toMatchObject({
      status: 'completed',
      succeeded: 2,
      skipped: 0,
      failed: 0,
    });
    expect(operations.started[0]?.envId).toBe(sandboxId);
    expect(
      database
        .prepare(
          "SELECT source_env_id, target_env_id FROM environment_syncs WHERE tool_call_id = 'sandbox-sync'",
        )
        .get(),
    ).toEqual({ source_env_id: sandboxId, target_env_id: 'env-2' });
  } finally {
    database.close();
  }
});

it('records an unknown nested directory creation and persists the same failure result', async () => {
  const { database, store, operations, runtime, run } = fixture();
  try {
    operations.unknownNestedDirectory = true;
    const reason = 'Environment Operation ended with status unknown.';
    const expected = {
      status: 'unknown',
      succeeded: 0,
      skipped: 0,
      failed: 1,
      failures: [{ path: '/target/nested', reason }],
    };
    const result = await runtime.sync(
      run,
      input,
      'unknown-directory-sync',
      new AbortController().signal,
    );
    expect(JSON.parse(result.content)).toEqual(expected);
    expect(result.content).not.toContain('operation_id');
    expect(
      operations.started
        .filter((entry) => entry.action.case === 'write' && entry.action.value.createDirectory)
        .map((entry) => (entry.action.case === 'write' ? entry.action.value.path : '')),
    ).toEqual(['/target/nested']);
    expect(
      operations.started.filter(
        (entry) => entry.action.case === 'write' && entry.action.value.transferId !== undefined,
      ),
    ).toEqual([]);
    expect(
      database
        .prepare(
          "SELECT relative_path, kind, status, error FROM environment_sync_files WHERE relative_path = 'nested'",
        )
        .get(),
    ).toEqual({ relative_path: 'nested', kind: 'directory', status: 'unknown', error: reason });
    expect(
      database
        .prepare(
          "SELECT status, succeeded, skipped, failed, failures_json FROM environment_syncs WHERE tool_call_id = 'unknown-directory-sync'",
        )
        .get(),
    ).toEqual({
      status: 'unknown',
      succeeded: 0,
      skipped: 0,
      failed: 1,
      failures_json: JSON.stringify(expected.failures),
    });
    result.commit?.();
    expect(store.agentEnvironments.savedResult(run.runId, 'unknown-directory-sync')).toEqual({
      content: result.content,
      status: 'error',
    });
  } finally {
    database.close();
  }
});

it.each([
  {
    name: 'confirmed',
    confirmationFails: false,
    directoryStatus: 'failed',
    reason: 'The environment sync was cancelled.',
  },
  {
    name: 'unconfirmed',
    confirmationFails: true,
    directoryStatus: 'unknown',
    reason: 'Cancellation could not be confirmed.',
  },
])(
  'records nested directory cancellation with $name cancellation confirmation',
  async ({ confirmationFails, directoryStatus, reason }) => {
    const { database, store, operations, runtime, run } = fixture();
    try {
      operations.deferNestedDirectory = true;
      operations.failCancellation = confirmationFails;
      const toolCallId = `cancel-directory-${confirmationFails}`;
      const controller = new AbortController();
      const pending = runtime.sync(run, input, toolCallId, controller.signal);
      await vi.waitFor(() =>
        expect(
          operations.started.some(
            (entry) =>
              entry.action.case === 'write' &&
              entry.action.value.createDirectory === true &&
              entry.action.value.path === '/target/nested',
          ),
        ).toBe(true),
      );
      controller.abort();
      const result = await pending;
      const expected = {
        status: 'cancelled',
        succeeded: 0,
        skipped: 0,
        failed: 1,
        failures: [{ path: '/target/nested', reason }],
      };
      expect(JSON.parse(result.content)).toEqual(expected);
      expect(result.content).not.toContain('operation_id');
      expect(operations.cancelled).toHaveLength(1);
      expect(
        operations.started
          .filter((entry) => entry.action.case === 'write' && entry.action.value.createDirectory)
          .map((entry) => (entry.action.case === 'write' ? entry.action.value.path : '')),
      ).toEqual(['/target/nested']);
      expect(
        operations.started.filter(
          (entry) => entry.action.case === 'write' && entry.action.value.transferId !== undefined,
        ),
      ).toEqual([]);
      expect(
        database
          .prepare(
            "SELECT relative_path, kind, status, error FROM environment_sync_files WHERE relative_path = 'nested'",
          )
          .get(),
      ).toEqual({
        relative_path: 'nested',
        kind: 'directory',
        status: directoryStatus,
        error: reason,
      });
      expect(
        database
          .prepare(
            'SELECT status, succeeded, skipped, failed, failures_json FROM environment_syncs WHERE tool_call_id = ?',
          )
          .get(toolCallId),
      ).toEqual({
        status: 'cancelled',
        succeeded: 0,
        skipped: 0,
        failed: 1,
        failures_json: JSON.stringify(expected.failures),
      });
      result.commit?.();
      expect(store.agentEnvironments.savedResult(run.runId, toolCallId)).toEqual({
        content: result.content,
        status: 'error',
      });
    } finally {
      database.close();
    }
  },
);

it.each([
  {
    name: 'confirmed',
    confirmationFails: false,
    reason: 'The environment sync was cancelled.',
  },
  {
    name: 'unconfirmed',
    confirmationFails: true,
    reason: 'Cancellation could not be confirmed.',
  },
])(
  'records root directory cancellation with $name cancellation confirmation',
  async ({ confirmationFails, reason }) => {
    const { database, store, operations, runtime, run } = fixture();
    try {
      operations.deferRootDirectory = true;
      operations.failCancellation = confirmationFails;
      const toolCallId = `cancel-root-directory-${confirmationFails}`;
      const controller = new AbortController();
      const pending = runtime.sync(run, input, toolCallId, controller.signal);
      await vi.waitFor(() =>
        expect(
          operations.started.some(
            (entry) =>
              entry.action.case === 'write' &&
              entry.action.value.createDirectory === true &&
              entry.action.value.path === '/target',
          ),
        ).toBe(true),
      );
      controller.abort();
      const result = await pending;
      const expected = {
        status: 'cancelled',
        succeeded: 0,
        skipped: 0,
        failed: 1,
        failures: [{ path: '/target', reason }],
      };
      expect(JSON.parse(result.content)).toEqual(expected);
      expect(result.content).not.toContain('operation_id');
      expect(operations.cancelled).toHaveLength(1);
      expect(
        operations.started
          .filter((entry) => entry.action.case === 'write' && entry.action.value.createDirectory)
          .map((entry) => (entry.action.case === 'write' ? entry.action.value.path : '')),
      ).toEqual(['/target']);
      expect(
        operations.started.filter(
          (entry) => entry.action.case === 'write' && entry.action.value.transferId !== undefined,
        ),
      ).toEqual([]);
      expect(
        database
          .prepare(
            'SELECT relative_path, kind, status, error FROM environment_sync_files ORDER BY relative_path',
          )
          .all(),
      ).toEqual([
        { relative_path: 'a.txt', kind: 'file', status: 'ready', error: null },
        { relative_path: 'b.txt', kind: 'file', status: 'ready', error: null },
      ]);
      expect(
        database
          .prepare(
            'SELECT status, succeeded, skipped, failed, failures_json FROM environment_syncs WHERE tool_call_id = ?',
          )
          .get(toolCallId),
      ).toEqual({
        status: 'cancelled',
        succeeded: 0,
        skipped: 0,
        failed: 1,
        failures_json: JSON.stringify(expected.failures),
      });
      result.commit?.();
      expect(store.agentEnvironments.savedResult(run.runId, toolCallId)).toEqual({
        content: result.content,
        status: 'error',
      });
    } finally {
      database.close();
    }
  },
);
