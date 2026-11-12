import { createHash, randomUUID } from 'node:crypto';
import type { ModelRequest } from '@kairos/agent-core';
import { z } from 'zod';
import { HardCutError, type ModelInputService } from '../context/model-input-service.js';
import type { Clock } from '../context/types.js';
import { isoTime, jsonText, parseJson, systemClock } from '../context/types.js';
import type { Recap } from '../recap/types.js';
import type { SessionErrorCode } from './errors.js';
import { requireText, SessionError } from './errors.js';
import type { RunError } from './records.js';
import type { SessionStore } from './store.js';

export interface ManualCompactInput {
  ownerId: string;
  threadId: string;
  clientActionId: string;
}

export interface ManualCompactResult {
  operationId: string;
  status: 'changed' | 'noop';
  readThroughSeq: number;
  recapIds: string[];
}

interface ManualCompactModel {
  contextWindowTokens: number;
  outputReserveTokens: number;
}

interface ManualCompactionOptions {
  store: SessionStore;
  modelInputs: ModelInputService;
  model?: ManualCompactModel;
  systemInstructions: (ownerId: string, threadId: string) => readonly string[];
  toolsForThread: (ownerId: string, threadId: string) => ModelRequest['tools'];
  isThreadActive: (threadId: string) => boolean;
  isPeriodicRecapActive: (threadId: string, agentId: string) => boolean;
  createId?: () => string;
  clock?: Clock;
}

interface ManualCompactOperation {
  operationId: string;
  ownerId: string;
  clientActionId: string;
  threadId: string;
  status: 'running' | 'changed' | 'noop' | 'failed' | 'interrupted';
  readThroughSeq: number | null;
  recapIds: string[];
  error: RunError | null;
  accepted?: boolean;
  systemInstructions?: readonly string[];
}

interface ActiveCompaction {
  threadId: string;
  controller: AbortController;
  promise: Promise<ManualCompactResult>;
}

const errorCodeSchema = z.enum([
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
]);
const operationRowSchema = z.object({
  operation_id: z.string(),
  owner_id: z.string(),
  client_action_id: z.string(),
  thread_id: z.string(),
  status: z.enum(['running', 'changed', 'noop', 'failed', 'interrupted']),
  read_through_seq: z.number().int().nonnegative().nullable(),
  recap_ids_json: z.string(),
  error_code: errorCodeSchema.nullable(),
  error_message: z.string().nullable(),
  error_retryable: z.number().int().min(0).max(1).nullable(),
});
const actionRowSchema = z.object({ method: z.string(), fingerprint: z.string() });
const resultSchema = z.object({
  operationId: z.string(),
  status: z.enum(['changed', 'noop']),
  readThroughSeq: z.number().int().nonnegative(),
  recapIds: z.array(z.string()),
});

function canonicalJson(value: unknown): string {
  const normalized = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalized);
    if (typeof item === 'object' && item !== null) {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalized(entry)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalized(value));
}

function sameSequences(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class ManualCompactionService {
  readonly #store: SessionStore;
  readonly #modelInputs: ModelInputService;
  readonly #model: ManualCompactModel | undefined;
  readonly #systemInstructions: (ownerId: string, threadId: string) => readonly string[];
  readonly #toolsForThread: (ownerId: string, threadId: string) => ModelRequest['tools'];
  readonly #isThreadActive: (threadId: string) => boolean;
  readonly #isPeriodicRecapActive: (threadId: string, agentId: string) => boolean;
  readonly #createId: () => string;
  readonly #clock: Clock;
  readonly #active = new Map<string, ActiveCompaction>();
  #closing = false;

  constructor(options: ManualCompactionOptions) {
    this.#store = options.store;
    this.#modelInputs = options.modelInputs;
    this.#model = options.model;
    this.#systemInstructions = options.systemInstructions;
    this.#toolsForThread = options.toolsForThread;
    this.#isThreadActive = options.isThreadActive;
    this.#isPeriodicRecapActive = options.isPeriodicRecapActive;
    this.#createId = options.createId ?? randomUUID;
    this.#clock = options.clock ?? systemClock;
  }

  async compact(input: ManualCompactInput): Promise<ManualCompactResult> {
    requireText(input.ownerId, 'ownerId', 200);
    requireText(input.threadId, 'threadId', 200);
    requireText(input.clientActionId, 'clientActionId', 200);
    const operation = this.#store.transaction(() => this.#begin(input));
    if (operation.status === 'changed' || operation.status === 'noop') {
      return Promise.resolve(this.#result(operation));
    }
    if (operation.status === 'failed' || operation.status === 'interrupted') {
      return Promise.reject(this.#storedError(operation));
    }
    const existing = this.#active.get(operation.operationId);
    if (existing) return existing.promise;
    if (operation.accepted !== true) {
      return Promise.reject(
        new SessionError('operation_unknown', 'The Server does not own this manual compaction.', {
          retryable: true,
        }),
      );
    }
    if (this.#closing) {
      return Promise.reject(
        new SessionError('operation_unknown', 'The Server does not own this manual compaction.', {
          retryable: true,
        }),
      );
    }
    const controller = new AbortController();
    const active: ActiveCompaction = {
      threadId: operation.threadId,
      controller,
      promise: Promise.resolve({
        operationId: '',
        status: 'noop',
        readThroughSeq: 0,
        recapIds: [],
      }),
    };
    active.promise = this.#execute(operation, controller.signal).finally(() => {
      if (this.#active.get(operation.operationId) === active) {
        this.#active.delete(operation.operationId);
      }
    });
    this.#active.set(operation.operationId, active);
    return active.promise;
  }

  isActive(threadId: string): boolean {
    return (
      [...this.#active.values()].some((active) => active.threadId === threadId) ||
      this.#hasRunningCompaction(threadId)
    );
  }

  recoverInterrupted(): void {
    this.#store.transaction(() => {
      const rows = z
        .array(z.object({ operation_id: z.string() }))
        .parse(
          this.#store.database
            .prepare("SELECT operation_id FROM manual_compact_operations WHERE status = 'running'")
            .all(),
        );
      for (const row of rows) {
        const operation = this.#getOperation(row.operation_id);
        const error: RunError = {
          code: 'operation_unknown',
          message: 'Server restarted while manual compaction was active; it was not replayed.',
          retryable: true,
        };
        this.#recordFailure(operation, error, 'interrupted');
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    const active = [...this.#active.values()];
    for (const execution of active) {
      execution.controller.abort(new DOMException('Server is shutting down.', 'AbortError'));
    }
    await Promise.allSettled(active.map((execution) => execution.promise));
  }

  #begin(input: ManualCompactInput): ManualCompactOperation {
    const fingerprint = createHash('sha256')
      .update(canonicalJson({ threadId: input.threadId }))
      .digest('hex');
    const action = actionRowSchema
      .optional()
      .parse(
        this.#store.database
          .prepare(
            'SELECT method, fingerprint FROM client_actions WHERE owner_id = ? AND client_action_id = ?',
          )
          .get(input.ownerId, input.clientActionId),
      );
    if (action) {
      if (action.method !== 'CompactContext' || action.fingerprint !== fingerprint) {
        throw new SessionError(
          'action_conflict',
          'The client action ID was already used with different parameters.',
          { clientActionId: input.clientActionId },
        );
      }
      const existing = this.#getOperationByAction(input.ownerId, input.clientActionId);
      if (!existing) {
        throw new SessionError('internal', 'The manual compaction action has no operation record.');
      }
      return existing;
    }
    if (this.#closing) {
      throw new SessionError('operation_unknown', 'Server is shutting down.', { retryable: true });
    }
    this.#store.getThread(input.ownerId, input.threadId);
    if (this.#isThreadActive(input.threadId) || this.#store.getActiveRun(input.threadId)) {
      throw new SessionError(
        'failed_precondition',
        'Wait for the active root Run to finish first.',
      );
    }
    if (this.#store.listQueuedInputs(input.threadId).length > 0) {
      throw new SessionError(
        'failed_precondition',
        'Consume or remove queued inputs before compacting.',
      );
    }
    if (
      this.#isPeriodicRecapActive(input.threadId, 'thread') ||
      this.#hasRunningRecap(input.threadId)
    ) {
      throw new SessionError(
        'failed_precondition',
        'Wait for periodic Recap generation to finish first.',
      );
    }
    if (this.#hasRunningCompaction(input.threadId)) {
      throw new SessionError('failed_precondition', 'Another manual compaction is already active.');
    }
    const relations = this.#store.context.listToolCallRelations(input.threadId, 'thread', {
      currentOnly: true,
    });
    if (relations.some((relation) => relation.resultSeq === null)) {
      throw new SessionError(
        'failed_precondition',
        'Finish every tool round trip before manual compaction.',
      );
    }

    const operationId = this.#createId();
    const now = isoTime(undefined, this.#clock);
    const noop = this.#noopResult(input.threadId, operationId);
    if (noop) {
      this.#insertOperation(input, operationId, 'noop', now, noop);
      this.#insertAction(input, fingerprint, noop, now);
      return this.#getOperation(operationId);
    }
    if (!this.#model) {
      throw new SessionError('failed_precondition', 'Model configuration is unavailable.');
    }
    this.#insertOperation(input, operationId, 'running', now);
    this.#insertAction(input, fingerprint, { operationId, status: 'running' }, now);
    this.#store.recordEvent(input.threadId, {
      case: 'hardCutStarted',
      value: { runId: '', operationId },
    });
    return {
      ...this.#getOperation(operationId),
      accepted: true,
      systemInstructions: this.#systemInstructions(input.ownerId, input.threadId),
    };
  }

  async #execute(
    operation: ManualCompactOperation,
    signal: AbortSignal,
  ): Promise<ManualCompactResult> {
    const model = this.#model;
    const systemInstructions = operation.systemInstructions;
    if (!model || !systemInstructions) {
      throw new SessionError('internal', 'Manual compaction has no fixed model configuration.');
    }
    try {
      const prepared = await this.#modelInputs.prepare({
        requestId: operation.operationId,
        threadId: operation.threadId,
        agentId: 'thread',
        systemInstructions,
        tools: this.#toolsForThread(operation.ownerId, operation.threadId),
        contextWindowTokens: model.contextWindowTokens,
        outputReserveTokens: model.outputReserveTokens,
        hardCutMode: 'manual',
        signal,
        onCommitted: (committed) => {
          const result = resultSchema.parse({
            operationId: operation.operationId,
            status: 'changed',
            readThroughSeq: committed.readThroughSeq,
            recapIds: [...committed.selectedRecapIds],
          });
          this.#store.transaction(() => {
            this.#store.agentEnvironments.recordRequestBinding(
              operation.operationId,
              operation.threadId,
              'thread',
            );
            const current = this.#getOperation(operation.operationId);
            if (current.status !== 'running') {
              throw new SessionError('version_conflict', 'The manual compaction state changed.');
            }
            const now = isoTime(undefined, this.#clock);
            const updated = this.#store.database
              .prepare(
                `UPDATE manual_compact_operations SET status = 'changed', read_through_seq = ?,
                 recap_ids_json = ?, error_code = NULL, error_message = NULL,
                 error_retryable = NULL, updated_at = ?, finished_at = ?
                 WHERE operation_id = ? AND status = 'running'`,
              )
              .run(
                result.readThroughSeq,
                jsonText(result.recapIds, 'recapIds'),
                now,
                now,
                operation.operationId,
              );
            if (updated.changes !== 1) {
              throw new SessionError('version_conflict', 'The manual compaction state changed.');
            }
            this.#updateActionResponse(operation, result);
            const replacedSourceSeqs = this.#store.context
              .query({ threadId: operation.threadId, agentId: 'thread', currentOnly: true })
              .filter((message) => message.seq <= result.readThroughSeq)
              .map((message) => message.seq);
            this.#store.recordEvent(operation.threadId, {
              case: 'hardCutCompleted',
              value: {
                runId: '',
                operationId: operation.operationId,
                replacedSourceSeqs,
                recapIds: result.recapIds,
                injectedMessageCount: 1,
              },
            });
          });
        },
      });
      if (!prepared.hardCut) {
        throw new SessionError('internal', 'Manual compaction did not produce a hard cut.');
      }
      return this.#result(this.#getOperation(operation.operationId));
    } catch (cause) {
      const interrupted = this.#closing || signal.aborted;
      const error = this.#sessionError(cause, interrupted);
      let recorded: boolean;
      try {
        recorded = this.#store.transaction(() =>
          this.#recordFailure(
            this.#getOperation(operation.operationId),
            {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
            },
            interrupted ? 'interrupted' : 'failed',
          ),
        );
      } catch (receiptError) {
        throw new SessionError('internal', 'The manual compaction failure could not be recorded.', {
          cause: new AggregateError([error, receiptError], 'Manual compaction and receipt failed.'),
          clientActionId: operation.clientActionId,
        });
      }
      if (recorded) throw this.#storedError(this.#getOperation(operation.operationId));
      throw error;
    }
  }

  #noopResult(threadId: string, operationId: string): ManualCompactResult | undefined {
    const state = this.#modelInputs.getState(threadId, 'thread');
    const snapshot = this.#store.context.query({ threadId, agentId: 'thread', currentOnly: true });
    if (snapshot.some((message) => message.seq > state.readThroughSeq)) return undefined;
    const selected = state.selectedRecapIds.map((recapId) =>
      this.#store.recaps.get(threadId, 'thread', recapId),
    );
    if (selected.some((recap) => recap === undefined)) return undefined;
    const recaps = selected.filter((recap): recap is Recap => recap !== undefined);
    const currentSeqs = new Set(snapshot.map((message) => message.seq));
    if (
      recaps.some(
        (recap) =>
          recap.validity !== 'valid' ||
          recap.sourceMessageSeqs.some((seq) => !currentSeqs.has(seq)),
      )
    ) {
      return undefined;
    }
    const covered = recaps
      .flatMap((recap) => [...recap.sourceMessageSeqs])
      .sort((left, right) => left - right);
    const expected = snapshot.map((message) => message.seq);
    if (new Set(covered).size !== covered.length || !sameSequences(covered, expected)) {
      return undefined;
    }
    return {
      operationId,
      status: 'noop',
      readThroughSeq: state.readThroughSeq,
      recapIds: [...state.selectedRecapIds],
    };
  }

  #hasRunningCompaction(threadId: string): boolean {
    return (
      this.#store.database
        .prepare(
          "SELECT 1 AS present FROM manual_compact_operations WHERE thread_id = ? AND status = 'running' LIMIT 1",
        )
        .get(threadId) !== undefined
    );
  }

  #hasRunningRecap(threadId: string): boolean {
    return (
      this.#store.database
        .prepare(
          `SELECT 1 AS present FROM recap_generation_operations
           WHERE thread_id = ? AND agent_id = 'thread' AND status = 'running' LIMIT 1`,
        )
        .get(threadId) !== undefined
    );
  }

  #insertOperation(
    input: ManualCompactInput,
    operationId: string,
    status: 'running' | 'noop',
    now: string,
    result?: ManualCompactResult,
  ): void {
    this.#store.database
      .prepare(
        `INSERT INTO manual_compact_operations(
          operation_id, owner_id, client_action_id, thread_id, status,
          read_through_seq, recap_ids_json, created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operationId,
        input.ownerId,
        input.clientActionId,
        input.threadId,
        status,
        result?.readThroughSeq ?? null,
        jsonText(result?.recapIds ?? [], 'recapIds'),
        now,
        now,
        status === 'noop' ? now : null,
      );
  }

  #insertAction(
    input: ManualCompactInput,
    fingerprint: string,
    response: unknown,
    now: string,
  ): void {
    this.#store.database
      .prepare(
        `INSERT INTO client_actions(
          owner_id, client_action_id, method, fingerprint, response_json, created_at
        ) VALUES (?, ?, 'CompactContext', ?, ?, ?)`,
      )
      .run(input.ownerId, input.clientActionId, fingerprint, JSON.stringify(response), now);
  }

  #updateActionResponse(operation: ManualCompactOperation, response: unknown): void {
    const result = this.#store.database
      .prepare(
        `UPDATE client_actions SET response_json = ?
         WHERE owner_id = ? AND client_action_id = ? AND method = 'CompactContext'`,
      )
      .run(JSON.stringify(response), operation.ownerId, operation.clientActionId);
    if (result.changes !== 1) {
      throw new SessionError('internal', 'The manual compaction client action is missing.');
    }
  }

  #recordFailure(
    operation: ManualCompactOperation,
    error: RunError,
    status: 'failed' | 'interrupted',
  ): boolean {
    if (operation.status !== 'running') return false;
    const now = isoTime(undefined, this.#clock);
    const result = this.#store.database
      .prepare(
        `UPDATE manual_compact_operations SET status = ?, error_code = ?, error_message = ?,
         error_retryable = ?, updated_at = ?, finished_at = ?
         WHERE operation_id = ? AND status = 'running'`,
      )
      .run(
        status,
        error.code,
        error.message,
        error.retryable ? 1 : 0,
        now,
        now,
        operation.operationId,
      );
    if (result.changes !== 1) {
      throw new SessionError('internal', 'The manual compaction failure could not be recorded.');
    }
    this.#updateActionResponse(operation, {
      operationId: operation.operationId,
      status,
      error,
    });
    this.#store.recordEvent(operation.threadId, {
      case: 'hardCutFailed',
      value: { runId: '', operationId: operation.operationId, error },
    });
    return true;
  }

  #getOperationByAction(
    ownerId: string,
    clientActionId: string,
  ): ManualCompactOperation | undefined {
    const row = z
      .object({ operation_id: z.string() })
      .optional()
      .parse(
        this.#store.database
          .prepare(
            'SELECT operation_id FROM manual_compact_operations WHERE owner_id = ? AND client_action_id = ?',
          )
          .get(ownerId, clientActionId),
      );
    return row ? this.#getOperation(row.operation_id) : undefined;
  }

  #getOperation(operationId: string): ManualCompactOperation {
    const row = operationRowSchema
      .optional()
      .parse(
        this.#store.database
          .prepare('SELECT * FROM manual_compact_operations WHERE operation_id = ?')
          .get(operationId),
      );
    if (!row) throw new SessionError('internal', 'The manual compaction operation is missing.');
    return {
      operationId: row.operation_id,
      ownerId: row.owner_id,
      clientActionId: row.client_action_id,
      threadId: row.thread_id,
      status: row.status,
      readThroughSeq: row.read_through_seq,
      recapIds: z
        .array(z.string())
        .parse(parseJson(row.recap_ids_json, 'manual compact recap_ids_json')),
      error:
        row.error_code === null
          ? null
          : {
              code: row.error_code,
              message: row.error_message ?? 'Manual compaction failed.',
              retryable: row.error_retryable === 1,
            },
    };
  }

  #result(operation: ManualCompactOperation): ManualCompactResult {
    if (
      (operation.status !== 'changed' && operation.status !== 'noop') ||
      operation.readThroughSeq === null
    ) {
      throw new SessionError('internal', 'The manual compaction has no complete response.');
    }
    return resultSchema.parse({
      operationId: operation.operationId,
      status: operation.status,
      readThroughSeq: operation.readThroughSeq,
      recapIds: operation.recapIds,
    });
  }

  #storedError(operation: ManualCompactOperation): SessionError {
    if (!operation.error) {
      return new SessionError('internal', 'The manual compaction has no stored failure.');
    }
    return new SessionError(operation.error.code, operation.error.message, {
      retryable: operation.error.retryable,
      clientActionId: operation.clientActionId,
      terminal: true,
    });
  }

  #sessionError(cause: unknown, interrupted: boolean): SessionError {
    if (interrupted) {
      return new SessionError(
        'operation_unknown',
        'Server shut down during manual compaction; the operation was interrupted.',
        { retryable: true, cause },
      );
    }
    if (cause instanceof SessionError) return cause;
    if (cause instanceof HardCutError) {
      const code: SessionErrorCode =
        cause.code === 'request_conflict'
          ? 'action_conflict'
          : cause.code === 'source_changed' || cause.code === 'concurrent_modification'
            ? 'version_conflict'
            : cause.code === 'storage_failed'
              ? 'internal'
              : cause.code === 'invalid_request'
                ? 'invalid_argument'
                : cause.code === 'unfinished_tool_round_trip' || cause.code === 'cancelled'
                  ? 'failed_precondition'
                  : 'recap_invalid';
      return new SessionError(code, cause.message, {
        retryable: code === 'internal' || code === 'recap_invalid' || code === 'version_conflict',
        cause,
      });
    }
    return new SessionError(
      'internal',
      `Manual compaction failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
