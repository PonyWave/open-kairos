import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ContextStore } from '../context/context-store.js';
import type { Clock, ContextMessage } from '../context/types.js';
import { isoTime, jsonText, parseJson, systemClock } from '../context/types.js';
import { inTransaction } from '../storage/transaction.js';
import type { GeneratedRecapContent } from './generation.js';
import type { RecapGenerationInput } from './generation-types.js';
import { RecapStore } from './recap-store.js';
import type { Recap } from './types.js';

const operationRowSchema = z.object({
  operation_id: z.string(),
  thread_id: z.string(),
  agent_id: z.string(),
  view_version: z.number().int().nonnegative(),
  source_message_seqs_json: z.string(),
  source_fingerprint: z.string(),
  instruction_version: z.number().int().positive(),
  request_fingerprint: z.string(),
  operation_kind: z.literal('periodic'),
  status: z.enum(['running', 'completed', 'failed', 'interrupted']),
  recap_id: z.string().nullable(),
});

type OperationRow = z.infer<typeof operationRowSchema>;

export interface RecapGenerationOperationInput {
  generation: RecapGenerationInput;
  sourceFingerprint: string;
  instructionVersion: number;
  requestFingerprint: string;
}

export type BeginRecapGenerationResult =
  | { status: 'started'; operationId: string }
  | { status: 'running'; operationId: string }
  | { status: 'completed'; operationId: string; recap: Recap };

function contextFingerprint(message: ContextMessage): unknown {
  return {
    message: message.message,
    createdAt: message.createdAt,
    supersededByRunId: message.supersededByRunId,
    revisions: message.revisions.map((revision) => ({
      revisionId: revision.revisionId,
      revisionNumber: revision.revisionNumber,
      content: revision.content,
      createdAt: revision.createdAt,
      runId: revision.runId,
    })),
  };
}

export function fingerprintRecapSources(sources: readonly ContextMessage[]): string {
  return createHash('sha256')
    .update(jsonText(sources.map(contextFingerprint), 'Recap source fingerprint'))
    .digest('hex');
}

export function recapGenerationOperationId(input: RecapGenerationOperationInput): string {
  const key = jsonText(
    {
      threadId: input.generation.threadId,
      agentId: input.generation.agentId,
      viewVersion: input.generation.viewVersion,
      sourceMessageSeqs: input.generation.sourceMessageSeqs,
      sourceFingerprint: input.sourceFingerprint,
      instructionVersion: input.instructionVersion,
      operationKind: input.generation.trigger,
    },
    'Recap generation operation key',
  );
  return `recap-generation:${createHash('sha256').update(key).digest('hex')}`;
}

export class RecapGenerationOperationStore {
  readonly #database: DatabaseSync;
  readonly #context: ContextStore;
  readonly #recaps: RecapStore;
  readonly #clock: Clock;

  constructor(
    database: DatabaseSync,
    clock: Clock = systemClock,
    recaps: RecapStore = new RecapStore(database, clock),
  ) {
    this.#database = database;
    this.#context = new ContextStore(database, clock);
    this.#recaps = recaps;
    this.#clock = clock;
  }

  begin(input: RecapGenerationOperationInput): BeginRecapGenerationResult {
    const operationId = recapGenerationOperationId(input);
    return inTransaction(this.#database, () => {
      const existing = this.#get(operationId);
      if (existing) {
        this.#assertSameOperation(existing, input);
        if (existing.status === 'running') return { status: 'running', operationId };
        if (existing.status === 'completed' && existing.recap_id !== null) {
          const recap = this.#recaps.get(existing.thread_id, existing.agent_id, existing.recap_id);
          if (recap?.validity === 'valid') return { status: 'completed', operationId, recap };
        }
        this.#database
          .prepare(
            `UPDATE recap_generation_operations
             SET status = 'running', recap_id = NULL, usage_json = NULL,
                 error_message = NULL, updated_at = ?
             WHERE operation_id = ?`,
          )
          .run(isoTime(undefined, this.#clock), operationId);
        return { status: 'started', operationId };
      }
      const now = isoTime(undefined, this.#clock);
      this.#database
        .prepare(
          `INSERT INTO recap_generation_operations(
            operation_id, thread_id, agent_id, view_version, source_message_seqs_json,
            source_fingerprint, instruction_version, request_fingerprint, operation_kind,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(
          operationId,
          input.generation.threadId,
          input.generation.agentId,
          input.generation.viewVersion,
          jsonText(input.generation.sourceMessageSeqs, 'sourceMessageSeqs'),
          input.sourceFingerprint,
          input.instructionVersion,
          input.requestFingerprint,
          input.generation.trigger,
          now,
          now,
        );
      return { status: 'started', operationId };
    });
  }

  complete(input: RecapGenerationOperationInput, output: GeneratedRecapContent): Recap {
    const operationId = recapGenerationOperationId(input);
    return inTransaction(this.#database, () => {
      const operation = this.#get(operationId);
      if (operation?.status !== 'running') {
        throw new Error(`Recap generation operation ${operationId} is not running.`);
      }
      this.#assertSameOperation(operation, input);
      this.#assertSourcesCurrent(input);
      const now = isoTime(undefined, this.#clock);
      const recap = this.#recaps.save({
        threadId: input.generation.threadId,
        agentId: input.generation.agentId,
        sourceMessageSeqs: input.generation.sourceMessageSeqs,
        content: output.content,
        createdAt: now,
      });
      const result = this.#database
        .prepare(
          `UPDATE recap_generation_operations
           SET status = 'completed', recap_id = ?, usage_json = ?,
               error_message = NULL, updated_at = ?
           WHERE operation_id = ? AND status = 'running'`,
        )
        .run(recap.recapId, jsonText(output.usage, 'Recap generation usage'), now, operationId);
      if (result.changes !== 1) {
        throw new Error(`Recap generation operation ${operationId} changed before completion.`);
      }
      return recap;
    });
  }

  fail(
    input: RecapGenerationOperationInput,
    error: unknown,
    status: 'failed' | 'interrupted' = 'failed',
  ): void {
    const operationId = recapGenerationOperationId(input);
    const message = error instanceof Error ? error.message : String(error);
    this.#database
      .prepare(
        `UPDATE recap_generation_operations
         SET status = ?, error_message = ?, updated_at = ?
         WHERE operation_id = ? AND status = 'running' AND request_fingerprint = ?`,
      )
      .run(
        status,
        message.slice(0, 4000),
        isoTime(undefined, this.#clock),
        operationId,
        input.requestFingerprint,
      );
  }

  recoverInterrupted(): void {
    this.#database
      .prepare(
        `UPDATE recap_generation_operations SET status = 'interrupted', updated_at = ?
         WHERE status = 'running'`,
      )
      .run(isoTime(undefined, this.#clock));
  }

  #get(operationId: string): OperationRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT operation_id, thread_id, agent_id, view_version, source_message_seqs_json,
                source_fingerprint, instruction_version, request_fingerprint, operation_kind,
                status, recap_id
         FROM recap_generation_operations WHERE operation_id = ?`,
      )
      .get(operationId);
    return row === undefined ? undefined : operationRowSchema.parse(row);
  }

  #assertSameOperation(row: OperationRow, input: RecapGenerationOperationInput): void {
    const sourceMessageSeqs = z
      .array(z.number().int().positive())
      .parse(parseJson(row.source_message_seqs_json, 'source_message_seqs_json'));
    if (
      row.thread_id !== input.generation.threadId ||
      row.agent_id !== input.generation.agentId ||
      row.view_version !== input.generation.viewVersion ||
      row.source_fingerprint !== input.sourceFingerprint ||
      row.instruction_version !== input.instructionVersion ||
      row.operation_kind !== input.generation.trigger ||
      jsonText(sourceMessageSeqs, 'sourceMessageSeqs') !==
        jsonText(input.generation.sourceMessageSeqs, 'sourceMessageSeqs') ||
      row.request_fingerprint !== input.requestFingerprint
    ) {
      throw new Error(`Recap generation operation ${row.operation_id} has conflicting parameters.`);
    }
  }

  #assertSourcesCurrent(input: RecapGenerationOperationInput): void {
    const state = z
      .object({ view_version: z.number().int().nonnegative() })
      .optional()
      .parse(
        this.#database
          .prepare(
            'SELECT view_version FROM model_input_states WHERE thread_id = ? AND agent_id = ?',
          )
          .get(input.generation.threadId, input.generation.agentId),
      );
    if ((state?.view_version ?? 0) !== input.generation.viewVersion) {
      throw new Error('The Context view changed during Recap generation.');
    }
    const current = this.#context.query({
      threadId: input.generation.threadId,
      agentId: input.generation.agentId,
      currentOnly: true,
    });
    const bySeq = new Map(current.map((message) => [message.seq, message]));
    const sources = input.generation.sourceMessageSeqs.map((seq) => {
      const source = bySeq.get(seq);
      if (!source) throw new Error(`Recap source message ${seq} is no longer current.`);
      return source;
    });
    if (fingerprintRecapSources(sources) !== input.sourceFingerprint) {
      throw new Error('A Recap source changed during generation.');
    }
  }
}
