import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { AgentLoopError, type ToolExecutionResult } from '@kairos/agent-core';
import { OperationStatus } from '@kairos/contracts/device';
import { z } from 'zod';
import type { AttachmentMetadata } from '../attachments/types.js';
import type { EnvironmentOperationAction } from '../devices/environment-operation-store.js';
import type { EnvironmentStore } from '../devices/environment-store.js';
import type { EnvironmentUse, EnvironmentUseGateway } from '../devices/environment-use.js';
import {
  compareWorkspaceResourceSnapshots,
  createWorkspaceResourceSnapshot,
  WORKSPACE_RESOURCE_LIMITS,
  type WorkspaceResourceSnapshot,
} from '../workspace/index.js';
import { type EnvironmentSyncInput, EnvironmentSyncService } from './environment-sync.js';
import { SessionError } from './errors.js';
import type { RunRecord } from './records.js';
import type { SessionStore } from './store.js';
import type { ReloadResourcesInput, ReloadResourcesResult } from './workspace-resources.js';

export type { EnvironmentOperationAction } from '../devices/environment-operation-store.js';

export interface EnvironmentOperationRecord {
  operationId: string;
  tenantId: string;
  envId: string;
  deviceBindingId: string;
  targetInstanceId: string;
  action: EnvironmentOperationAction;
  status: OperationStatus;
  resultStatus?: OperationStatus;
  outcome?: unknown;
  outputComplete?: boolean;
  postProcessedAt?: string;
  resultSource?: 'device' | 'recovery';
  expiresAt: string;
}

export interface EnvironmentOperationGateway {
  startEnvironmentOperation(input: {
    operationId: string;
    tenantId: string;
    envId: string;
    bindingVersion?: bigint;
    action: EnvironmentOperationAction;
    expiresAt: Date;
  }): Promise<EnvironmentOperationRecord>;
  cancelEnvironmentOperation(input: {
    tenantId: string;
    operationId: string;
    reason: string;
  }): Promise<EnvironmentOperationRecord>;
  getEnvironmentOperation(tenantId: string, operationId: string): EnvironmentOperationRecord;
  readEnvironmentOperationOutput(input: {
    tenantId: string;
    operationId: string;
    offset: bigint;
    limit: number;
  }): { data: Uint8Array; nextOffset: bigint; outputComplete: boolean; outputGap: boolean };
}

const directoryOutcomeSchema = z.object({
  normalizedPath: z.string().min(1).max(4096),
  exists: z.boolean(),
  directory: z.boolean(),
  readable: z.boolean(),
  writable: z.boolean(),
  executable: z.boolean(),
  os: z.string().max(100),
  architecture: z.string().max(100),
  capabilities: z.array(z.number().int()).max(16),
  resources: z
    .array(
      z.object({
        path: z.string().min(1).max(512),
        content: z.string().max(64 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(WORKSPACE_RESOURCE_LIMITS.maxSkills + 1),
  reason: z.string().max(500).optional(),
});
const readOutcomeSchema = z.object({
  path: z.string(),
  content: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextOffset: z.number().int().positive().optional(),
  fileVersion: z.string(),
  truncated: z.boolean(),
});
const readImageOutcomeSchema = z.object({
  path: z.string().min(1).max(4096),
  data: z.instanceof(Uint8Array),
  fileVersion: z.string().regex(/^[a-f0-9]{64}$/),
});
const savedImageContentSchema = z.object({
  outcome: z.object({ attachment_id: z.string().min(1) }),
});
const writeOutcomeSchema = z.object({
  path: z.string(),
  bytesWritten: z.bigint().nonnegative(),
  fileVersion: z.string(),
});
const editOutcomeSchema = z.object({
  path: z.string(),
  replacements: z.number().int().nonnegative(),
  bytesWritten: z.bigint().nonnegative(),
  fileVersion: z.string(),
});
const bashOutcomeSchema = z.object({
  exitCode: z.number().int().optional(),
  outputComplete: z.boolean(),
  endOffset: z.bigint().nonnegative().optional(),
});

export interface EnvironmentRuntimeOptions {
  store: SessionStore;
  environments: EnvironmentStore;
  operations: EnvironmentOperationGateway;
  environmentUse: EnvironmentUseGateway;
  createId?: () => string;
  now?: () => Date;
  bashDefaultTimeoutSeconds?: number;
  bashPreviewBytes?: number;
}

export interface EnvironmentReloadHooks {
  isRootRunActive(threadId: string): boolean;
  isManualCompactionActive(threadId: string): boolean;
  invalidate(threadId: string): void;
  runtimeSpec(
    ownerId: string,
    threadId: string,
  ): { runtimeFingerprint: string; runtimeChanged?: boolean } | undefined;
}

const reloadResultSchema = z.object({
  snapshotId: z.string(),
  changed: z.boolean(),
  resources: z.array(z.string()),
  added: z.array(z.string()),
  updated: z.array(z.string()),
  removed: z.array(z.string()),
  runtimeFingerprint: z.string().optional(),
  runtimeChanged: z.boolean().optional(),
});
const reloadActionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('running') }),
  z.object({ status: z.literal('completed'), result: reloadResultSchema }),
  z.object({
    status: z.enum(['failed', 'interrupted']),
    error: z.object({
      code: z.enum([
        'unauthenticated',
        'permission_denied',
        'version_conflict',
        'action_conflict',
        'device_offline',
        'operation_unknown',
        'recap_invalid',
        'input_too_large',
        'protocol_incompatible',
        'invalid_argument',
        'not_found',
        'failed_precondition',
        'internal',
      ]),
      message: z.string(),
      retryable: z.boolean(),
    }),
  }),
]);

export class AgentEnvironmentRuntime {
  readonly store: SessionStore;
  readonly environments: EnvironmentStore;
  readonly operations: EnvironmentOperationGateway;
  readonly #environmentUse: EnvironmentUseGateway;
  readonly #runUses = new Map<string, EnvironmentUse>();
  readonly #createId: () => string;
  readonly #now: () => Date;
  readonly #bashDefaultTimeoutSeconds: number;
  readonly #bashPreviewBytes: number;
  readonly #reloadActive = new Map<string, Promise<ReloadResourcesResult>>();
  readonly #syncService: EnvironmentSyncService;

  constructor(options: EnvironmentRuntimeOptions) {
    this.store = options.store;
    this.environments = options.environments;
    this.operations = options.operations;
    this.#environmentUse = options.environmentUse;
    this.#createId = options.createId ?? randomId;
    this.#now = options.now ?? (() => new Date());
    this.#bashDefaultTimeoutSeconds = options.bashDefaultTimeoutSeconds ?? 120;
    this.#bashPreviewBytes = options.bashPreviewBytes ?? 16 * 1024;
    this.#syncService = new EnvironmentSyncService({
      store: this.store,
      environments: this.environments,
      operations: this.operations,
      createId: this.#createId,
      now: this.#now,
      host: {
        prepare: (input) => this.#prepareSyncOperation(input),
        startAndWait: (input) => this.#startAndWait(input),
        cancel: (tenantId, operationId, reason) => this.#cancel(tenantId, operationId, reason),
      },
    });
  }

  get bashDefaultTimeoutSeconds(): number {
    return this.#bashDefaultTimeoutSeconds;
  }

  async prepare(run: RunRecord, signal: AbortSignal): Promise<void> {
    const specification = this.store.agentEnvironments.requireExecution(run);
    await this.ensureRunReady(run, signal);
    const policy = this.store.agentEnvironments.requirePolicy(run.threadId, run.agentId);
    this.#requireUsable(run.ownerId, specification.defaultEnv);
    if (specification.resourceVersion !== null) return;
    if (policy.current.resources !== null) {
      this.store.transaction(() =>
        this.store.agentEnvironments.bindExecutionResources(run, policy),
      );
      return;
    }
    const initialToolCallId = `initial:${run.runId}`;
    const existing = this.store.agentEnvironments.findLatestOperation(run.runId, initialToolCallId);
    let existingOperation: EnvironmentOperationRecord | undefined;
    if (existing) {
      try {
        existingOperation = this.operations.getEnvironmentOperation(
          run.ownerId,
          existing.operationId,
        );
      } catch (cause) {
        throw new SessionError(
          'operation_unknown',
          'The initial environment operation could not be recovered.',
          { cause, retryable: true },
        );
      }
      if (existingOperation.action.case !== 'directoryCheck') {
        throw new SessionError('internal', 'The initial environment operation has the wrong type.');
      }
      const status = terminal(existingOperation);
      if (status !== undefined && status !== OperationStatus.COMPLETED) {
        const content = operationFailure(existingOperation);
        this.store.transaction(() => {
          this.store.agentEnvironments.recordOperationResult(
            existing.operationId,
            content,
            'error',
          );
        });
        if (status === OperationStatus.UNKNOWN) {
          throw new SessionError('operation_unknown', content, { retryable: true });
        }
      }
    }
    const checked = await this.#checkDirectory({
      run,
      toolCallId: existingOperation
        ? `${initialToolCallId}:retry:${existingOperation.operationId}`
        : initialToolCallId,
      policy,
      envId: policy.current.envId,
      pwd: policy.current.pwd,
      reason: 'initial',
      signal,
      ...(existingOperation &&
      terminal(existingOperation) !== OperationStatus.FAILED &&
      terminal(existingOperation) !== OperationStatus.CANCELLED &&
      terminal(existingOperation) !== OperationStatus.EXPIRED
        ? { existingOperation }
        : {}),
    });
    if (checked.status === 'error') {
      if (checked.commit) this.store.transaction(checked.commit);
      if (existingOperation && terminal(existingOperation) === OperationStatus.UNKNOWN) {
        throw new SessionError('operation_unknown', checked.content, { retryable: true });
      }
      throw new SessionError('failed_precondition', checked.content, { retryable: true });
    }
    const commit = checked.commit;
    if (!commit)
      throw new SessionError('internal', 'The initial environment check did not commit.');
    this.store.transaction(() => {
      commit();
      this.store.agentEnvironments.bindExecutionResources(
        run,
        this.store.agentEnvironments.requirePolicy(run.threadId, run.agentId),
      );
    });
  }

  async prepareAttachments(run: RunRecord, signal: AbortSignal): Promise<void> {
    const pending = this.store.attachments.listPendingWorkspace(run.threadId, run.agentId);
    if (pending.length === 0) return;
    const specification = this.store.agentEnvironments.requireExecution(run);
    this.#requireUsable(run.ownerId, specification.defaultEnv);
    const bindingVersion = this.store.agentEnvironments.requireHistory(
      specification.historyId,
    ).bindingVersion;
    for (const target of pending) {
      signal.throwIfAborted();
      await this.#prepareAttachment(run, specification, bindingVersion, target, signal);
    }
  }

  async #prepareAttachment(
    run: RunRecord,
    specification: ReturnType<SessionStore['agentEnvironments']['requireExecution']>,
    bindingVersion: number,
    target: {
      messageSeq: number;
      inputId: string | null;
      attachment: AttachmentMetadata;
    },
    signal: AbortSignal,
  ): Promise<void> {
    const expectedPath = workspaceAttachmentPath(specification.defaultPwd, target.attachment);
    if (
      (target.attachment.envId !== undefined &&
        target.attachment.envId !== specification.defaultEnv) ||
      (target.attachment.path !== undefined && target.attachment.path !== expectedPath)
    ) {
      throw new SessionError(
        'failed_precondition',
        'A pending attachment belongs to a different execution environment; it was not moved.',
      );
    }
    const envId = specification.defaultEnv;
    const path = expectedPath;
    const completed = this.store.attachments.findCompletedWorkspace(
      run.ownerId,
      target.attachment.attachmentId,
      envId,
      path,
      specification.defaultPwd,
    );
    if (completed?.operationId !== undefined) {
      this.#stageAttachment(target, envId, path, completed.operationId, 'completed');
      return;
    }
    const content = this.store.attachments.readForWorkspace(
      run.ownerId,
      target.attachment.attachmentId,
    );
    if (
      content.byteSize !== content.bytes.length ||
      createHash('sha256').update(content.bytes).digest('hex') !== content.sha256
    ) {
      throw new SessionError('internal', 'Stored attachment content failed validation.');
    }
    const action = attachmentWriteAction(path, specification.defaultPwd, content);
    let operationId = target.attachment.operationId;
    if (operationId === undefined) {
      operationId = workspaceOperationId(run.runId, target.attachment.attachmentId, envId, path);
      this.#stageAttachment(target, envId, path, operationId, 'pending');
      await this.#writeAttachment({
        run,
        envId,
        bindingVersion,
        operationId,
        action,
        target,
        content,
        signal,
      });
      return;
    }
    let existing: EnvironmentOperationRecord;
    try {
      existing = this.operations.getEnvironmentOperation(run.ownerId, operationId);
    } catch (cause) {
      throw new SessionError(
        'operation_unknown',
        'The attachment write Operation could not be recovered.',
        { cause, retryable: true },
      );
    }
    assertAttachmentWriteOperation(existing, envId, specification.defaultPwd, path);
    const operation = await this.#attachmentOperation({
      run,
      envId,
      bindingVersion,
      operationId,
      action,
      existingOperation: existing,
      signal,
    });
    if (terminal(operation) === OperationStatus.COMPLETED) {
      const outcome = validatedAttachmentWriteOutcome(operation, path, content);
      this.#stageAttachment(target, envId, outcome.path, operationId, 'completed');
      return;
    }
    await this.#recoverAttachmentWrite({
      run,
      envId,
      bindingVersion,
      operation,
      target,
      content,
      signal,
      allowRetry: true,
    });
  }

  async #writeAttachment(input: {
    run: RunRecord;
    envId: string;
    bindingVersion: number;
    operationId: string;
    action: Extract<EnvironmentOperationAction, { case: 'write' }>;
    target: { messageSeq: number; inputId: string | null; attachment: AttachmentMetadata };
    content: ReturnType<SessionStore['attachments']['readForWorkspace']>;
    signal: AbortSignal;
  }): Promise<void> {
    const operation = await this.#attachmentOperation(input);
    if (terminal(operation) === OperationStatus.COMPLETED) {
      const outcome = validatedAttachmentWriteOutcome(
        operation,
        input.action.value.path,
        input.content,
      );
      this.#stageAttachment(
        input.target,
        input.envId,
        outcome.path,
        input.operationId,
        'completed',
      );
      return;
    }
    await this.#recoverAttachmentWrite({ ...input, operation, allowRetry: false });
  }

  async #recoverAttachmentWrite(input: {
    run: RunRecord;
    envId: string;
    bindingVersion: number;
    operation: EnvironmentOperationRecord;
    target: { messageSeq: number; inputId: string | null; attachment: AttachmentMetadata };
    content: ReturnType<SessionStore['attachments']['readForWorkspace']>;
    signal: AbortSignal;
    allowRetry: boolean;
  }): Promise<void> {
    const path = requireAttachmentWriteOperation(input.operation).action.value.path;
    const verification = await this.#verifyAttachment(input);
    if (verification.status === 'completed') {
      this.#stageAttachment(
        input.target,
        input.envId,
        verification.path,
        verification.operationId,
        'completed',
      );
      return;
    }
    if (verification.status === 'changed') {
      throw new SessionError(
        'failed_precondition',
        'The attachment destination contains different content; it was not overwritten.',
      );
    }
    const status = terminal(input.operation);
    if (status === OperationStatus.UNKNOWN || verification.status === 'unknown') {
      throw new SessionError(
        'operation_unknown',
        'The attachment write result and destination content are unknown.',
        { retryable: true },
      );
    }
    if (!input.allowRetry) {
      throw new SessionError(
        'failed_precondition',
        'The attachment write did not complete and the destination is still missing.',
        { retryable: true },
      );
    }
    const operationId = workspaceOperationId(
      input.run.runId,
      input.target.attachment.attachmentId,
      input.envId,
      path,
      input.operation.operationId,
    );
    this.#stageAttachment(input.target, input.envId, path, operationId, 'pending');
    await this.#writeAttachment({
      run: input.run,
      envId: input.envId,
      bindingVersion: input.bindingVersion,
      operationId,
      action: attachmentWriteAction(
        path,
        requireAttachmentWriteOperation(input.operation).action.value.cwd,
        input.content,
      ),
      target: input.target,
      content: input.content,
      signal: input.signal,
    });
  }

  async #verifyAttachment(input: {
    run: RunRecord;
    envId: string;
    bindingVersion: number;
    operation: EnvironmentOperationRecord;
    content: ReturnType<SessionStore['attachments']['readForWorkspace']>;
    signal: AbortSignal;
  }): Promise<{
    status: 'completed' | 'missing' | 'changed' | 'unknown';
    operationId: string;
    path: string;
  }> {
    const operationId = `attachment-verify-${this.#createId()}`;
    const path = requireAttachmentWriteOperation(input.operation).action.value.path;
    const cwd = requireAttachmentWriteOperation(input.operation).action.value.cwd;
    const action: EnvironmentOperationAction =
      input.content.mediaType === 'text/plain'
        ? { case: 'read', value: { path, cwd, offset: 1, limit: 1 } }
        : { case: 'readImage', value: { path, cwd } };
    const operation = await this.#attachmentOperation({
      run: input.run,
      envId: input.envId,
      bindingVersion: input.bindingVersion,
      operationId,
      action,
      signal: input.signal,
    });
    const status = terminal(operation);
    if (status === OperationStatus.UNKNOWN) return { status: 'unknown', operationId, path };
    if (status !== OperationStatus.COMPLETED) return { status: 'missing', operationId, path };
    if (operation.action.case === 'read' && action.case === 'read') {
      const outcome = readOutcomeSchema.parse(outcomeValue(operation, 'read'));
      return {
        status: outcome.fileVersion === input.content.sha256 ? 'completed' : 'changed',
        operationId,
        path: outcome.path,
      };
    }
    if (operation.action.case === 'readImage' && action.case === 'readImage') {
      const outcome = readImageOutcomeSchema.parse(outcomeValue(operation, 'readImage'));
      return {
        status: outcome.fileVersion === input.content.sha256 ? 'completed' : 'changed',
        operationId,
        path: outcome.path,
      };
    }
    throw new SessionError('internal', 'The attachment verification Operation has the wrong type.');
  }

  #stageAttachment(
    target: { messageSeq: number; inputId: string | null; attachment: AttachmentMetadata },
    envId: string,
    path: string,
    operationId: string,
    status: 'pending' | 'completed',
  ): void {
    this.store.transaction(() => {
      this.store.attachments.stageWorkspace({
        messageSeq: target.messageSeq,
        inputId: target.inputId,
        attachmentId: target.attachment.attachmentId,
        envId,
        path,
        operationId,
        status,
      });
    });
  }

  async #attachmentOperation(input: {
    run: RunRecord;
    envId: string;
    bindingVersion: number;
    operationId: string;
    action: EnvironmentOperationAction;
    signal: AbortSignal;
    existingOperation?: EnvironmentOperationRecord;
  }): Promise<EnvironmentOperationRecord> {
    let remoteStarted = input.existingOperation !== undefined;
    try {
      return await this.#startAndWait({
        operationId: input.operationId,
        tenantId: input.run.ownerId,
        envId: input.envId,
        bindingVersion: BigInt(input.bindingVersion),
        action: input.action,
        signal: input.signal,
        onDispatched: () => {
          remoteStarted = true;
        },
        ...(input.existingOperation === undefined
          ? {}
          : { existingOperation: input.existingOperation }),
        expiresAt: new Date(this.#now().getTime() + 30_000),
      });
    } catch (error) {
      if (input.signal.aborted && remoteStarted) {
        await this.#cancel(input.run.ownerId, input.operationId, 'The Agent Run was cancelled.');
      }
      throw error;
    }
  }

  reserveRun(run: RunRecord): void {
    const specification = this.store.agentEnvironments.requireExecution(run);
    const use: EnvironmentUse = {
      tenantId: run.ownerId,
      envId: specification.defaultEnv,
      usageId: `run:${run.runId}:${run.generation}`,
      kind: 'run',
      pwd: specification.defaultPwd,
    };
    this.#environmentUse.reserveUse(use);
    this.#runUses.set(use.usageId, use);
  }

  async ensureRunReady(run: RunRecord, signal: AbortSignal): Promise<void> {
    const use = this.#runUses.get(`run:${run.runId}:${run.generation}`);
    if (use) await this.#environmentUse.ensureReady({ ...use, signal });
    signal.throwIfAborted();
  }

  releaseRun(run: Pick<RunRecord, 'runId' | 'generation'>): void {
    const key = `run:${run.runId}:${run.generation}`;
    const use = this.#runUses.get(key);
    if (!use) return;
    this.#environmentUse.releaseUse(use);
    this.#runUses.delete(key);
  }

  reload(
    input: ReloadResourcesInput,
    hooks: EnvironmentReloadHooks,
  ): Promise<ReloadResourcesResult> {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ threadId: input.threadId }))
      .digest('hex');
    try {
      this.store.transaction(() => {
        this.#readReloadAction(input, fingerprint);
      });
    } catch (error) {
      return Promise.reject(error);
    }
    const key = JSON.stringify([input.ownerId, input.clientActionId]);
    const existing = this.#reloadActive.get(key);
    if (existing) return existing;
    const active = this.#reload(input, hooks).finally(() => {
      if (this.#reloadActive.get(key) === active) this.#reloadActive.delete(key);
    });
    this.#reloadActive.set(key, active);
    return active;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.#reloadActive.values());
  }

  recoverReloads(): void {
    const rows = z
      .array(
        z.object({ owner_id: z.string(), client_action_id: z.string(), response_json: z.string() }),
      )
      .parse(
        this.store.database
          .prepare(
            "SELECT owner_id, client_action_id, response_json FROM client_actions WHERE method = 'ReloadEnvironmentResources' AND json_extract(response_json, '$.status') = 'running'",
          )
          .all(),
      );
    this.store.transaction(() => {
      for (const row of rows) {
        this.store.database
          .prepare(
            `UPDATE client_actions SET response_json = ?
             WHERE owner_id = ? AND client_action_id = ? AND method = 'ReloadEnvironmentResources'
               AND response_json = ?`,
          )
          .run(
            JSON.stringify({
              status: 'interrupted',
              error: {
                code: 'operation_unknown',
                message:
                  'Server restarted during environment resource reload; it was not replayed.',
                retryable: true,
              },
            }),
            row.owner_id,
            row.client_action_id,
            row.response_json,
          );
      }
    });
    this.#syncService.recoverInterrupted();
  }

  async #reload(
    input: ReloadResourcesInput,
    hooks: EnvironmentReloadHooks,
  ): Promise<ReloadResourcesResult> {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ threadId: input.threadId }))
      .digest('hex');
    const operationId = this.#createId();
    let use: EnvironmentUse | undefined;
    const started = this.store.transaction((): { completed?: ReloadResourcesResult } => {
      const existing = this.#readReloadAction(input, fingerprint);
      if (existing?.status === 'completed') return { completed: existing.result };
      if (existing?.status === 'failed' || existing?.status === 'interrupted') {
        throw new SessionError(existing.error.code, existing.error.message, {
          retryable: existing.error.retryable,
          clientActionId: input.clientActionId,
          terminal: true,
        });
      }
      if (existing?.status === 'running') {
        throw new SessionError(
          'operation_unknown',
          'The Server does not own this environment resource reload.',
          { retryable: true, clientActionId: input.clientActionId },
        );
      }
      this.#assertReloadIdle(input, hooks);
      this.store.database
        .prepare(
          `INSERT INTO client_actions(
            owner_id, client_action_id, method, fingerprint, response_json, created_at
          ) VALUES (?, ?, 'ReloadEnvironmentResources', ?, ?, ?)`,
        )
        .run(
          input.ownerId,
          input.clientActionId,
          fingerprint,
          JSON.stringify({
            status: 'running',
            operationId,
            envId: this.store.agentEnvironments.requirePolicy(input.threadId, 'thread').defaultEnv,
            pwd: this.store.agentEnvironments.requirePolicy(input.threadId, 'thread').defaultPwd,
          }),
          this.#now().toISOString(),
        );
      return {};
    });
    if (started.completed) return started.completed;

    try {
      this.store.getThread(input.ownerId, input.threadId);
      const policy = this.store.agentEnvironments.requirePolicy(input.threadId, 'thread');
      const previous = policy.current.resources ?? remoteSnapshot([]);
      const envId = policy.defaultEnv;
      const pwd = policy.defaultPwd;
      if (!envId || !pwd)
        throw new SessionError('failed_precondition', 'The Thread workspace is missing.');
      use = {
        tenantId: input.ownerId,
        envId,
        usageId: `reload:${input.ownerId}:${input.clientActionId}`,
        kind: 'reload',
      };
      this.#environmentUse.reserveUse(use);
      await this.#environmentUse.ensureReady({ ...use, signal: new AbortController().signal });
      this.#requireUsable(input.ownerId, envId, true);
      const operation = await this.#startAndWait({
        operationId,
        tenantId: input.ownerId,
        envId,
        action: { case: 'directoryCheck', value: { path: pwd, loadWorkspace: true } },
        signal: new AbortController().signal,
        expiresAt: new Date(this.#now().getTime() + 30_000),
      });
      if (terminal(operation) !== OperationStatus.COMPLETED)
        throw new SessionError('failed_precondition', operationFailure(operation), {
          retryable: true,
        });
      const outcome = directoryOutcomeSchema.parse(outcomeValue(operation, 'directoryCheck'));
      if (
        !outcome.exists ||
        !outcome.directory ||
        !outcome.readable ||
        !outcome.writable ||
        !outcome.executable
      )
        throw new SessionError(
          'failed_precondition',
          outcome.reason ?? 'The workspace is not usable.',
        );
      const snapshot = remoteSnapshot(outcome.resources);
      return this.store.transaction(() => {
        this.#assertReloadIdle(input, hooks);
        const action = this.#readReloadAction(input, fingerprint);
        if (action?.status !== 'running') {
          throw new SessionError('version_conflict', 'The environment reload action changed.');
        }
        this.store.agentEnvironments.commitResources({
          threadId: input.threadId,
          agentId: 'thread',
          expectedHistoryId: policy.currentHistoryId,
          envId,
          pwd: outcome.normalizedPath,
          snapshot,
          reason: 'reload',
          resultContent: '',
          deviceBindingId: operation.deviceBindingId,
          instanceId: operation.targetInstanceId,
        });
        hooks.invalidate(input.threadId);
        const updated = this.store.agentEnvironments.requirePolicy(input.threadId, 'thread');
        const next = updated.current.resources;
        this.store.recordEvent(input.threadId, {
          case: 'environmentBindingChanged',
          value: { agentId: 'thread', binding: updated.current },
        });
        if (!next) throw new SessionError('internal', 'The reloaded resources are missing.');
        const runtime = hooks.runtimeSpec(input.ownerId, input.threadId);
        const result = reloadResultSchema.parse({
          snapshotId: next.snapshotId,
          changed: previous.snapshotId !== next.snapshotId,
          resources: next.resources.map((resource) => resource.path),
          ...compareWorkspaceResourceSnapshots(previous, next),
          ...(runtime
            ? {
                runtimeFingerprint: runtime.runtimeFingerprint,
                ...(runtime.runtimeChanged === undefined
                  ? {}
                  : { runtimeChanged: runtime.runtimeChanged }),
              }
            : {}),
        });
        const saved = this.store.database
          .prepare(
            `UPDATE client_actions SET response_json = ?
             WHERE owner_id = ? AND client_action_id = ? AND method = 'ReloadEnvironmentResources'
               AND fingerprint = ? AND json_extract(response_json, '$.status') = 'running'`,
          )
          .run(
            JSON.stringify({ status: 'completed', result }),
            input.ownerId,
            input.clientActionId,
            fingerprint,
          );
        if (saved.changes !== 1) {
          throw new SessionError('version_conflict', 'The environment reload action changed.');
        }
        return result;
      });
    } catch (cause) {
      const error =
        cause instanceof SessionError
          ? cause
          : new SessionError('internal', 'Environment resource reload failed.', { cause });
      this.store.transaction(() => {
        this.store.database
          .prepare(
            `UPDATE client_actions SET response_json = ?
             WHERE owner_id = ? AND client_action_id = ? AND method = 'ReloadEnvironmentResources'
               AND fingerprint = ? AND json_extract(response_json, '$.status') = 'running'`,
          )
          .run(
            JSON.stringify({
              status: 'failed',
              error: { code: error.code, message: error.message, retryable: error.retryable },
            }),
            input.ownerId,
            input.clientActionId,
            fingerprint,
          );
      });
      throw new SessionError(error.code, error.message, {
        retryable: error.retryable,
        clientActionId: input.clientActionId,
        terminal: true,
        cause: error,
      });
    } finally {
      if (use) this.#environmentUse.releaseUse(use);
    }
  }

  #assertReloadIdle(input: ReloadResourcesInput, hooks: EnvironmentReloadHooks): void {
    this.store.getThread(input.ownerId, input.threadId);
    if (hooks.isRootRunActive(input.threadId) || this.store.getActiveRun(input.threadId)) {
      throw new SessionError(
        'failed_precondition',
        'Wait for the active root Run to finish first.',
      );
    }
    if (this.store.listQueuedInputs(input.threadId).length > 0) {
      throw new SessionError(
        'failed_precondition',
        'Consume or remove queued inputs before reloading resources.',
      );
    }
    if (hooks.isManualCompactionActive(input.threadId)) {
      throw new SessionError(
        'failed_precondition',
        'Wait for manual compaction to finish before reloading resources.',
      );
    }
  }

  #readReloadAction(input: ReloadResourcesInput, fingerprint: string) {
    const row = z
      .object({ method: z.string(), fingerprint: z.string(), response_json: z.string() })
      .optional()
      .parse(
        this.store.database
          .prepare(
            'SELECT method, fingerprint, response_json FROM client_actions WHERE owner_id = ? AND client_action_id = ?',
          )
          .get(input.ownerId, input.clientActionId),
      );
    if (!row) return undefined;
    if (row.method !== 'ReloadEnvironmentResources' || row.fingerprint !== fingerprint) {
      throw new SessionError(
        'action_conflict',
        'The client action ID was already used with different parameters.',
        { clientActionId: input.clientActionId },
      );
    }
    return reloadActionSchema.parse(JSON.parse(row.response_json));
  }

  instructions(
    ownerId: string,
    threadId: string,
    agentId: string,
    run?: RunRecord,
  ): readonly string[] {
    const thread = this.store.getThread(ownerId, threadId);
    const policy = this.store.agentEnvironments.requirePolicy(threadId, agentId);
    const specification = run ? this.store.agentEnvironments.requireExecution(run) : undefined;
    const binding = specification
      ? this.store.agentEnvironments.requireHistory(specification.historyId)
      : policy.current;
    const resources = binding.resources;
    if (!resources)
      throw new SessionError(
        'failed_precondition',
        'The workspace resources have not been loaded.',
      );
    const effectiveAllowed =
      specification?.allowedEnv ??
      this.environments
        .list(ownerId)
        .environments.filter(
          (environment) =>
            environment.bindingStatus === 'active' &&
            (policy.allowedEnv === null || policy.allowedEnv.includes(environment.envId)),
        )
        .map((environment) => environment.envId)
        .sort();
    const role =
      thread.threadType === 'main' && agentId === 'thread'
        ? 'main_agent'
        : agentId === 'thread'
          ? 'task_thread'
          : 'subagent';
    const defaultEnv = specification?.defaultEnv ?? policy.defaultEnv;
    const defaultPwd = specification?.defaultPwd ?? policy.defaultPwd;
    const instructions = [
      'All Agents load AGENTS.md and Skills from the main environment workspace. Omitting env_id executes a file or command tool in the main environment. The main environment env_id and name are both main. Optional env_id selects an authorized target for that call only and does not change subsequent calls or loaded instructions. Relative paths use the main environment workspace in the main environment and the validated recommended directory in another environment. Task Threads and Subagents inherit or narrow the caller authorization. Read project rules explicitly when working in another environment.',
      `<agent-execution-environment>${jsonStringify({ allowed_env: effectiveAllowed.map((envId) => this.#modelEnvId(ownerId, envId)), main_env: defaultEnv ? this.#modelEnvId(ownerId, defaultEnv) : null, workspace: defaultPwd, resource_version: specification?.resourceVersion ?? binding.resourceVersion, role })}</agent-execution-environment>`,
    ];
    if (role === 'main_agent')
      instructions.push(
        `<authorized-environment-catalog>${this.listForScope(ownerId, effectiveAllowed)}</authorized-environment-catalog>`,
      );
    if (resources.systemInstructions.length > 0) instructions.push(resources.systemInstructions);
    return instructions;
  }

  list(run: RunRecord): string {
    const specification = this.store.agentEnvironments.requireExecution(run);
    return this.listForScope(run.ownerId, specification.allowedEnv);
  }

  private listForScope(ownerId: string, allowedEnv: readonly string[] | null): string {
    const catalog = this.environments.list(ownerId);
    const configuredMain = this.store.agentEnvironments.mainEnvironmentIdFor(ownerId);
    const mainEnv =
      allowedEnv === null || allowedEnv.includes(configuredMain) ? configuredMain : null;
    return jsonStringify({
      environments: catalog.environments
        .filter(
          (environment) =>
            environment.bindingStatus !== 'revoked' &&
            (allowedEnv === null || allowedEnv.includes(environment.envId)),
        )
        .map((environment) => ({
          ...catalogEntry(environment, environment.envId === mainEnv),
          is_main: environment.envId === mainEnv,
        })),
      main_env: mainEnv === null ? null : 'main',
    });
  }

  resolveEnvironmentIds(ownerId: string, envIds: readonly string[]): string[] {
    return envIds.map((envId) => this.#resolveEnvId(ownerId, envId));
  }

  projectEnvironmentIds(ownerId: string, envIds: readonly string[]): string[] {
    return envIds.map((envId) => this.#modelEnvId(ownerId, envId));
  }

  sync(
    run: RunRecord,
    input: Omit<EnvironmentSyncInput, 'sourceEnvId' | 'targetEnvId'> & {
      sourceEnvId: string;
      targetEnvId: string;
    },
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    return this.#syncService.execute(
      run,
      {
        ...input,
        sourceEnvId: this.#resolveEnvId(run.ownerId, input.sourceEnvId),
        targetEnvId: this.#resolveEnvId(run.ownerId, input.targetEnvId),
      },
      toolCallId,
      signal,
    );
  }

  #modelEnvId(ownerId: string, envId: string): string {
    if (envId === this.store.agentEnvironments.mainEnvironmentIdFor(ownerId)) return 'main';
    this.environments.get(ownerId, envId);
    return envId;
  }

  #resolveEnvId(ownerId: string, envId: string): string {
    if (envId !== 'main') return envId;
    return this.store.agentEnvironments.mainEnvironmentIdFor(ownerId);
  }

  async execute(
    run: RunRecord,
    action: Exclude<
      EnvironmentOperationAction,
      { case: 'directoryCheck' | 'directoryList' | 'syncScan' | 'syncRead' }
    >,
    toolCallId: string,
    signal: AbortSignal,
    target: { envId?: string; cwd?: string } = {},
  ): Promise<ToolExecutionResult> {
    const specification = this.store.agentEnvironments.requireExecution(run);
    const envId = target.envId
      ? this.#resolveEnvId(run.ownerId, target.envId)
      : specification.defaultEnv;
    if (envId.trim().length === 0 || !specification.allowedEnv.includes(envId)) {
      throw new SessionError(
        'permission_denied',
        'The target environment is not allowed for this execution.',
      );
    }
    const environment = this.environments.get(run.ownerId, envId);
    if (environment.bindingStatus === 'revoked')
      throw new SessionError('permission_denied', 'The target environment is revoked.');
    if (target.cwd !== undefined) requirePosixPath(target.cwd);
    if ('path' in action.value && action.value.path.includes('\0'))
      throw new SessionError('invalid_argument', 'path must not contain a null character.');
    const operationId = this.#createId();
    let remoteStarted = false;
    let recordedIntent = false;
    let operation: EnvironmentOperationRecord | undefined;
    try {
      signal.throwIfAborted();
      this.#requireUsable(run.ownerId, envId);
      const current = this.environments.get(run.ownerId, envId);
      const cwd =
        target.cwd ??
        (envId === specification.defaultEnv
          ? specification.defaultPwd
          : (current.normalizedPwd ?? current.recommendedPwd));
      requirePosixPath(cwd);
      const resolvedAction = structuredClone(action);
      resolvedAction.value.cwd = cwd;
      if ('path' in resolvedAction.value)
        resolvedAction.value.path = posix.resolve(cwd, resolvedAction.value.path);
      const policy = this.store.agentEnvironments.requirePolicy(run.threadId, run.agentId);
      this.store.transaction(() => {
        this.store.agentEnvironments.recordOperationIntent({
          operationId,
          runId: run.runId,
          toolCallId,
          policy: { ...policy, currentHistoryId: specification.historyId },
          envId,
          action: action.case === 'readImage' ? 'read_image' : action.case,
          generation: run.generation,
          resolvedAction,
        });
      });
      recordedIntent = true;
      signal.throwIfAborted();
      operation = await this.#startAndWait({
        operationId,
        tenantId: run.ownerId,
        envId,
        bindingVersion: BigInt(policy.bindingVersion),
        action: resolvedAction,
        signal,
        onDispatched: () => {
          remoteStarted = true;
        },
        expiresAt: new Date(
          this.#now().getTime() +
            (action.case === 'bash' ? action.value.timeoutSeconds + 30 : 30) * 1000,
        ),
      });
      return await this.#toolResult(run, policy.bindingVersion, operation);
    } catch (error) {
      if (signal.aborted && remoteStarted) {
        operation = await this.#cancel(run.ownerId, operationId, 'The Agent Run was cancelled.');
        return this.#toolResult(
          run,
          this.store.agentEnvironments.requireHistory(specification.historyId).bindingVersion,
          operation,
        );
      }
      if (signal.aborted && !remoteStarted && recordedIntent)
        this.store.transaction(() =>
          this.store.agentEnvironments.discardOperationIntent({
            operationId,
            runId: run.runId,
            toolCallId,
          }),
        );
      throw error;
    }
  }

  readOutput(
    run: RunRecord,
    input: { operationId: string; offset: bigint; limit: number },
  ): string {
    this.store.agentEnvironments.requireOperation(run.threadId, run.agentId, input.operationId);
    const output = this.operations.readEnvironmentOperationOutput({
      tenantId: run.ownerId,
      ...input,
    });
    return jsonStringify({
      operation_id: input.operationId,
      content: Buffer.from(output.data).toString('utf8'),
      next_offset: output.nextOffset.toString(),
      output_complete: output.outputComplete,
      output_gap: output.outputGap,
    });
  }

  async savedResult(runId: string, toolCallId: string): Promise<ToolExecutionResult | undefined> {
    const association = this.store.agentEnvironments.findOperation(runId, toolCallId);
    const saved = this.store.agentEnvironments.savedResult(runId, toolCallId);
    if (saved) {
      return association?.action === 'read_image' ? withSavedImageParts(saved) : saved;
    }
    const synced = this.#syncService.savedResult(runId, toolCallId);
    if (synced) {
      if (synced.status === undefined) {
        throw new SessionError('internal', 'A recovered environment sync requires a final status.');
      }
      this.store.transaction(() => synced.commit?.());
      return { content: synced.content, status: synced.status };
    }
    if (
      !association ||
      !['read', 'read_image', 'write', 'edit', 'bash'].includes(association.action) ||
      association.action === 'directory_check' ||
      association.action === 'env_switch'
    ) {
      return undefined;
    }
    const run = this.store.getRunById(runId);
    const operation = this.operations.getEnvironmentOperation(run.ownerId, association.operationId);
    if (!terminal(operation)) return undefined;
    const result = await this.#toolResult(run, association.bindingVersion, operation);
    this.store.transaction(() => {
      result.commit?.();
    });
    if (result.status === undefined) {
      throw new SessionError('internal', 'A recovered environment result requires a final status.');
    }
    return {
      content: result.content,
      ...(result.content_parts === undefined ? {} : { content_parts: result.content_parts }),
      status: result.status,
    };
  }

  async #toolResult(
    run: RunRecord,
    bindingVersion: number,
    operation: EnvironmentOperationRecord,
  ): Promise<ToolExecutionResult> {
    if (
      operation.action.case === 'readImage' &&
      terminal(operation) === OperationStatus.COMPLETED
    ) {
      return this.#imageResult(run, bindingVersion, operation);
    }
    const content = await this.#operationContent(run, bindingVersion, operation);
    const status = terminal(operation) === OperationStatus.COMPLETED ? 'success' : 'error';
    return {
      content,
      status,
      commit: () => {
        this.store.agentEnvironments.recordOperationResult(operation.operationId, content, status);
      },
    };
  }

  #imageResult(
    run: RunRecord,
    bindingVersion: number,
    operation: EnvironmentOperationRecord,
  ): ToolExecutionResult {
    if (operation.action.case !== 'readImage') {
      throw new SessionError('internal', 'An image read Operation is required.');
    }
    const outcome = readImageOutcomeSchema.parse(outcomeValue(operation, 'readImage'));
    const base = {
      operation_id: operation.operationId,
      status: statusName(terminal(operation)),
      env_id: this.#modelEnvId(run.ownerId, operation.envId),
      binding_version: bindingVersion,
      cwd: operation.action.value.cwd,
    };
    try {
      const attachment = this.store.attachments.createToolImage({
        ownerId: run.ownerId,
        fileName: posix.basename(outcome.path),
        bytes: outcome.data,
        expectedSha256: outcome.fileVersion,
      });
      const content = jsonStringify({
        ...base,
        outcome: {
          path: outcome.path,
          attachment_id: attachment.attachmentId,
          media_type: attachment.mediaType,
          byte_size: attachment.byteSize,
          width: attachment.width,
          height: attachment.height,
          sha256: attachment.sha256,
        },
      });
      return {
        content,
        content_parts: [{ type: 'attachment', attachment_id: attachment.attachmentId }],
        status: 'success',
        commit: () => {
          this.store.agentEnvironments.recordOperationResult(
            operation.operationId,
            content,
            'success',
          );
        },
      };
    } catch (error) {
      const content = jsonStringify({
        ...base,
        outcome: { path: outcome.path },
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        content,
        status: 'error',
        commit: () => {
          this.store.agentEnvironments.recordOperationResult(
            operation.operationId,
            content,
            'error',
          );
        },
      };
    }
  }

  async #checkDirectory(input: {
    run: RunRecord;
    toolCallId: string;
    policy: ReturnType<SessionStore['agentEnvironments']['requirePolicyState']>;
    envId: string;
    pwd: string;
    reason: 'initial' | 'reload';
    signal: AbortSignal;
    existingOperation?: EnvironmentOperationRecord;
  }): Promise<ToolExecutionResult> {
    requirePosixPath(input.pwd);
    this.#requireUsable(input.run.ownerId, input.envId, input.reason === 'reload');
    const operationId = input.existingOperation?.operationId ?? this.#createId();
    let remoteStarted = input.existingOperation !== undefined;
    let recordedIntent = false;
    try {
      input.signal.throwIfAborted();
      if (!input.existingOperation) {
        this.store.transaction(() => {
          this.store.agentEnvironments.recordOperationIntent({
            operationId,
            runId: input.run.runId,
            toolCallId: input.toolCallId,
            policy: input.policy,
            envId: input.envId,
            action: 'directory_check',
            generation: input.run.generation,
            resolvedAction: {
              case: 'directoryCheck',
              value: { path: input.pwd, loadWorkspace: true },
            },
          });
        });
        recordedIntent = true;
      }
      input.signal.throwIfAborted();
      const operation = await this.#startAndWait({
        operationId,
        ...(input.existingOperation ? { existingOperation: input.existingOperation } : {}),
        tenantId: input.run.ownerId,
        envId: input.envId,
        action: {
          case: 'directoryCheck',
          value: { path: input.pwd, loadWorkspace: true },
        },
        signal: input.signal,
        onDispatched: () => {
          remoteStarted = true;
        },
        expiresAt: new Date(this.#now().getTime() + 30_000),
      });
      if (terminal(operation) !== OperationStatus.COMPLETED) {
        const content = operationFailure(operation);
        return {
          content,
          status: 'error',
          commit: () => {
            this.store.agentEnvironments.recordOperationResult(operationId, content, 'error');
          },
        };
      }
      const outcome = directoryOutcomeSchema.parse(outcomeValue(operation, 'directoryCheck'));
      if (
        !outcome.exists ||
        !outcome.directory ||
        !outcome.readable ||
        !outcome.writable ||
        !outcome.executable
      ) {
        throw new SessionError(
          'failed_precondition',
          outcome.reason ?? 'The target directory is not usable.',
        );
      }
      const snapshot = remoteSnapshot(outcome.resources);
      const content = jsonStringify({
        operation_id: operationId,
        status: 'completed',
        env_id: input.envId,
        pwd: outcome.normalizedPath,
        os: outcome.os,
        architecture: outcome.architecture,
        capabilities: outcome.capabilities,
        binding_version: input.policy.bindingVersion,
        resource_version: snapshot.snapshotId,
      });
      return {
        content,
        commit: () => {
          const updated = this.store.agentEnvironments.commitResources({
            runId: input.run.runId,
            operationId,
            expectedHistoryId: input.policy.currentHistoryId,
            envId: input.envId,
            pwd: outcome.normalizedPath,
            snapshot,
            reason: input.reason,
            resultContent: content,
            deviceBindingId: operation.deviceBindingId,
            instanceId: operation.targetInstanceId,
          });
          this.store.recordEvent(input.run.threadId, {
            case: 'environmentBindingChanged',
            value: { agentId: input.run.agentId, binding: updated.current },
          });
        },
      };
    } catch (error) {
      if (input.signal.aborted) {
        if (remoteStarted) {
          await this.#cancel(input.run.ownerId, operationId, 'The Agent Run was cancelled.');
        } else if (recordedIntent) {
          this.store.transaction(() => {
            this.store.agentEnvironments.discardOperationIntent({
              operationId,
              runId: input.run.runId,
              toolCallId: input.toolCallId,
            });
          });
        }
      }
      throw error;
    }
  }

  #requireUsable(ownerId: string, envId: string, readinessOnly = false): void {
    const environment = this.environments.requireReady(ownerId, envId);
    if (!readinessOnly && environment.maintenanceMode !== 'normal') {
      throw new SessionError(
        'failed_precondition',
        'The environment is draining and does not accept new Agent operations.',
      );
    }
  }

  async #prepareSyncOperation(input: {
    tenantId: string;
    envId: string;
    operationId: string;
    signal: AbortSignal;
  }): Promise<void> {
    input.signal.throwIfAborted();
    this.#requireUsable(input.tenantId, input.envId);
  }

  async #startAndWait(input: {
    operationId: string;
    tenantId: string;
    envId: string;
    bindingVersion?: bigint;
    action: EnvironmentOperationAction;
    signal: AbortSignal;
    expiresAt: Date;
    existingOperation?: EnvironmentOperationRecord;
    onDispatched?: () => void;
  }): Promise<EnvironmentOperationRecord> {
    input.signal.throwIfAborted();
    let operation = input.existingOperation;
    if (!operation) {
      input.onDispatched?.();
      operation = await this.operations.startEnvironmentOperation({
        operationId: input.operationId,
        tenantId: input.tenantId,
        envId: input.envId,
        ...(input.bindingVersion === undefined ? {} : { bindingVersion: input.bindingVersion }),
        action: input.action,
        expiresAt: input.expiresAt,
      });
    }
    while (!terminal(operation)) {
      input.signal.throwIfAborted();
      if (this.#now().getTime() >= Date.parse(operation.expiresAt))
        throw new SessionError(
          'operation_unknown',
          'The environment operation expired before its result was confirmed.',
          { retryable: true },
        );
      await delay(10, input.signal);
      operation = this.operations.getEnvironmentOperation(input.tenantId, input.operationId);
    }
    return operation;
  }

  async #cancel(
    tenantId: string,
    operationId: string,
    reason: string,
  ): Promise<EnvironmentOperationRecord> {
    try {
      let operation = await this.operations.cancelEnvironmentOperation({
        tenantId,
        operationId,
        reason,
      });
      while (!terminal(operation)) {
        const expiresAt = Date.parse(operation.expiresAt);
        if (!Number.isFinite(expiresAt) || this.#now().getTime() >= expiresAt) {
          throw new AgentLoopError(
            'operation_unknown',
            'The remote operation cancellation was not confirmed before expiration.',
          );
        }
        await delay(10, new AbortController().signal);
        operation = this.operations.getEnvironmentOperation(tenantId, operationId);
      }
      if (terminal(operation) === OperationStatus.UNKNOWN) {
        throw new AgentLoopError(
          'operation_unknown',
          'The remote operation result is unknown after cancellation.',
        );
      }
      return operation;
    } catch (cause) {
      if (cause instanceof AgentLoopError && cause.code === 'operation_unknown') throw cause;
      throw new AgentLoopError(
        'operation_unknown',
        'The remote operation cancellation could not be confirmed.',
        { cause },
      );
    }
  }

  async #operationContent(
    run: RunRecord,
    bindingVersion: number,
    operation: EnvironmentOperationRecord,
  ): Promise<string> {
    const base = {
      operation_id: operation.operationId,
      status: statusName(terminal(operation)),
      env_id: this.#modelEnvId(run.ownerId, operation.envId),
      binding_version: bindingVersion,
    };
    if (terminal(operation) !== OperationStatus.COMPLETED) {
      return jsonStringify({ ...base, error: 'Environment operation did not complete.' });
    }
    if (operation.action.case === 'read') {
      return jsonStringify({
        ...base,
        cwd: operation.action.value.cwd,
        outcome: readOutcomeSchema.parse(outcomeValue(operation, 'read')),
      });
    }
    if (operation.action.case === 'write') {
      return jsonStringify({
        ...base,
        cwd: operation.action.value.cwd,
        outcome: writeOutcomeSchema.parse(outcomeValue(operation, 'write')),
      });
    }
    if (operation.action.case === 'edit') {
      return jsonStringify({
        ...base,
        cwd: operation.action.value.cwd,
        outcome: editOutcomeSchema.parse(outcomeValue(operation, 'edit')),
      });
    }
    if (operation.action.case !== 'bash') {
      throw new SessionError(
        'internal',
        'A directory check is not a model file or Bash operation.',
      );
    }
    const outcome = bashOutcomeSchema.parse(outcomeValue(operation, 'bash'));
    const preview = this.operations.readEnvironmentOperationOutput({
      tenantId: run.ownerId,
      operationId: operation.operationId,
      offset: 0n,
      limit: this.#bashPreviewBytes,
    });
    return jsonStringify({
      ...base,
      cwd: operation.action.value.cwd,
      outcome,
      output: Buffer.from(preview.data).toString('utf8'),
      next_offset: preview.nextOffset.toString(),
      output_complete: preview.outputComplete,
      output_gap: preview.outputGap,
    });
  }
}

type AttachmentWriteOperation = EnvironmentOperationRecord & {
  action: Extract<EnvironmentOperationAction, { case: 'write' }>;
};

function requireAttachmentWriteOperation(
  operation: EnvironmentOperationRecord,
): AttachmentWriteOperation {
  if (operation.action.case !== 'write') {
    throw new SessionError('internal', 'An attachment write Operation is required.');
  }
  return { ...operation, action: operation.action };
}

function workspaceAttachmentPath(defaultPwd: string, attachment: AttachmentMetadata): string {
  requirePosixPath(defaultPwd);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(attachment.attachmentId)) {
    throw new SessionError('internal', 'The attachment ID cannot form a workspace file name.');
  }
  const extension =
    attachment.mediaType === 'text/plain'
      ? '.txt'
      : attachment.mediaType === 'image/png'
        ? '.png'
        : '.jpg';
  return posix.join(defaultPwd, '.kairos', 'attachments', `${attachment.attachmentId}${extension}`);
}

function workspaceOperationId(
  runId: string,
  attachmentId: string,
  envId: string,
  path: string,
  previousOperationId?: string,
): string {
  const digest = createHash('sha256')
    .update('kairos-workspace-attachment-v1\0')
    .update(
      previousOperationId === undefined
        ? JSON.stringify([runId, attachmentId, envId, path])
        : JSON.stringify([previousOperationId]),
    )
    .digest('hex');
  return `workspace-attachment-${digest}`;
}

function attachmentWriteAction(
  path: string,
  cwd: string,
  content: ReturnType<SessionStore['attachments']['readForWorkspace']>,
): Extract<EnvironmentOperationAction, { case: 'write' }> {
  return {
    case: 'write',
    value: {
      path,
      cwd,
      content:
        content.mediaType === 'text/plain' ? Buffer.from(content.bytes).toString('utf8') : '',
      overwrite: false,
      ...(content.mediaType === 'text/plain' ? {} : { binaryContent: content.bytes }),
      createParents: true,
    },
  };
}

function assertAttachmentWriteOperation(
  operation: EnvironmentOperationRecord,
  envId: string,
  cwd: string,
  path: string,
): void {
  const write = requireAttachmentWriteOperation(operation);
  if (
    operation.envId !== envId ||
    write.action.value.cwd !== cwd ||
    write.action.value.path !== path ||
    write.action.value.overwrite ||
    !write.action.value.createParents
  ) {
    throw new SessionError('internal', 'The attachment write Operation parameters changed.');
  }
}

function validatedAttachmentWriteOutcome(
  operation: EnvironmentOperationRecord,
  path: string,
  content: ReturnType<SessionStore['attachments']['readForWorkspace']>,
): z.infer<typeof writeOutcomeSchema> {
  requireAttachmentWriteOperation(operation);
  const outcome = writeOutcomeSchema.parse(outcomeValue(operation, 'write'));
  requirePosixPath(path);
  requirePosixPath(outcome.path);
  if (outcome.bytesWritten !== BigInt(content.byteSize) || outcome.fileVersion !== content.sha256) {
    throw new SessionError('internal', 'The attachment write result does not match its content.');
  }
  return outcome;
}

function withSavedImageParts(result: { content: string; status: 'success' | 'error' }) {
  if (result.status !== 'success') return result;
  const saved = savedImageContentSchema.parse(JSON.parse(result.content));
  return {
    ...result,
    content_parts: [{ type: 'attachment' as const, attachment_id: saved.outcome.attachment_id }],
  };
}

function catalogEntry(
  environment: ReturnType<EnvironmentStore['get']>,
  main = false,
): Record<string, unknown> {
  return {
    env_id: main ? 'main' : environment.envId,
    name: main ? 'main' : environment.name,
    kind: environment.kind,
    recommended_pwd: environment.recommendedPwd,
    binding_status: environment.bindingStatus,
    connection_status: environment.connectionStatus,
    capability_status: environment.capabilityStatus,
    directory_status: environment.directoryStatus,
    maintenance_mode: environment.maintenanceMode,
    granted_capabilities: environment.grantedCapabilities,
    ready: environment.ready,
  };
}

function outcomeValue(operation: EnvironmentOperationRecord, expected: string): unknown {
  const outcome = operation.outcome;
  if (typeof outcome === 'object' && outcome !== null && 'case' in outcome && 'value' in outcome) {
    if (outcome.case !== expected) {
      throw new SessionError('internal', 'The environment operation outcome has the wrong type.');
    }
    return outcome.value;
  }
  return outcome;
}

function remoteSnapshot(
  resources: readonly { path: string; content: string; sha256: string }[],
): WorkspaceResourceSnapshot {
  const sorted = [...resources].sort((left, right) => left.path.localeCompare(right.path));
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const resource of sorted) {
    const validPath =
      resource.path === 'AGENTS.md' ||
      /^\.agents\/skills\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/SKILL\.md$/.test(resource.path);
    const contentBytes = Buffer.byteLength(resource.content);
    const digest = createHash('sha256').update(resource.content, 'utf8').digest('hex');
    totalBytes += contentBytes;
    if (
      !validPath ||
      seen.has(resource.path) ||
      contentBytes > WORKSPACE_RESOURCE_LIMITS.maxFileBytes ||
      totalBytes > WORKSPACE_RESOURCE_LIMITS.maxTotalBytes ||
      resource.content.includes('\0') ||
      resource.content.trim().length === 0 ||
      digest !== resource.sha256
    ) {
      throw new SessionError('failed_precondition', 'The remote workspace resources are invalid.');
    }
    seen.add(resource.path);
  }
  return createWorkspaceResourceSnapshot(sorted);
}

function terminal(operation: EnvironmentOperationRecord): OperationStatus | undefined {
  const status = operation.resultStatus ?? operation.status;
  return status >= OperationStatus.COMPLETED && status <= OperationStatus.UNKNOWN
    ? status
    : undefined;
}

function statusName(status: OperationStatus | undefined): string {
  return status === undefined ? 'unknown' : (OperationStatus[status] ?? 'unknown').toLowerCase();
}

function operationFailure(operation: EnvironmentOperationRecord): string {
  return jsonStringify({
    operation_id: operation.operationId,
    env_id: operation.envId,
    status: statusName(terminal(operation)),
    error:
      'The environment directory or resource check did not complete; the previous binding was preserved.',
  });
}

function requirePosixPath(value: string): void {
  if (
    !value.startsWith('/') ||
    value.length > 4096 ||
    value.includes('\0') ||
    (value.length > 1 && value.endsWith('/')) ||
    value.includes('//') ||
    value.split('/').some((segment, index) => index > 0 && (segment === '.' || segment === '..'))
  ) {
    throw new SessionError('invalid_argument', 'pwd must be a normalized absolute POSIX path.');
  }
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'bigint' ? entry.toString() : entry,
  );
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    function done() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}
