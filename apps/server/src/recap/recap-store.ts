import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ContextStore } from '../context/context-store.js';
import type { Clock, ContextMessage } from '../context/types.js';
import {
  createId,
  isoTime,
  jsonText,
  parseJson,
  requireIdentifier,
  requireSequence,
  systemClock,
} from '../context/types.js';
import { inTransaction } from '../storage/transaction.js';
import type { Recap, RecapQuery, SaveRecapInput } from './types.js';
import { RecapError } from './types.js';

const recapRowSchema = z.object({
  recap_id: z.string(),
  thread_id: z.string(),
  agent_id: z.string(),
  source_seq_start: z.number().int().positive(),
  source_seq_end: z.number().int().positive(),
  source_message_seqs: z.string(),
  content: z.string(),
  created_at: z.string(),
  validity: z.enum(['valid', 'invalid']),
  invalidated_at: z.string().nullable(),
  invalidation_reason: z.string().nullable(),
});

type RecapRow = z.infer<typeof recapRowSchema>;

function likePattern(value: string): string {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function sourceSequences(row: RecapRow): number[] {
  return z
    .array(z.number().int().positive())
    .parse(parseJson(row.source_message_seqs, 'source_message_seqs'));
}

function sourceTimeRange(sources: readonly ContextMessage[]): { start: string; end: string } {
  const times = sources.map((source) => source.createdAt).sort();
  const start = times[0];
  const end = times.at(-1);
  if (!start || !end) throw new RecapError('invalid_recap', 'Recap sources are missing.');
  return { start, end };
}

export class RecapStore {
  readonly #database: DatabaseSync;
  readonly #context: ContextStore;
  readonly #clock: Clock;
  readonly #onSaved: (recap: Recap) => void;

  constructor(
    database: DatabaseSync,
    clock: Clock = systemClock,
    onSaved: (recap: Recap) => void = () => {},
  ) {
    this.#database = database;
    this.#context = new ContextStore(database, clock);
    this.#clock = clock;
    this.#onSaved = onSaved;
  }

  prepare(input: SaveRecapInput): Recap {
    return this.#prepare(input);
  }

  save(input: SaveRecapInput): Recap {
    const recaps = this.saveMany([input]);
    const recap = recaps[0];
    if (!recap) throw new Error(`Inserted recap ${input.recapId ?? ''} could not be read.`);
    return recap;
  }

  saveMany(
    inputs: readonly SaveRecapInput[],
    commit: () => void = () => {},
    beforeInsert: () => void = () => {},
  ): Recap[] {
    const save = () => {
      const recaps = inputs.map((input) => this.#prepare(input));
      beforeInsert();
      for (const recap of recaps) {
        this.#insert(recap);
        this.#onSaved(recap);
      }
      commit();
      return recaps;
    };
    return this.#database.isTransaction ? save() : inTransaction(this.#database, save);
  }

  get(threadId: string, agentId: string, recapId: string): Recap | undefined {
    const row = this.#database
      .prepare('SELECT * FROM recaps WHERE thread_id = ? AND agent_id = ? AND recap_id = ?')
      .get(threadId, agentId, recapId);
    return row === undefined ? undefined : this.#toRecord(recapRowSchema.parse(row));
  }

  query(query: RecapQuery): Recap[] {
    const threadId = requireIdentifier(query.threadId, 'threadId');
    const agentId = requireIdentifier(query.agentId, 'agentId');
    const clauses = ['recaps.thread_id = ?', 'recaps.agent_id = ?'];
    const parameters: (string | number)[] = [threadId, agentId];
    if (query.recapId !== undefined) {
      clauses.push('recaps.recap_id = ?');
      parameters.push(requireIdentifier(query.recapId, 'recapId'));
    }
    if (query.validity !== undefined) {
      clauses.push('recaps.validity = ?');
      parameters.push(query.validity);
    }
    if (query.query !== undefined && query.query.length > 0) {
      const pattern = likePattern(query.query);
      clauses.push("recaps.content LIKE ? ESCAPE '\\'");
      parameters.push(pattern);
    }
    if (query.fromSeq !== undefined || query.toSeq !== undefined) {
      const conditions = ['recap_sources.recap_id = recaps.recap_id'];
      if (query.fromSeq !== undefined) {
        conditions.push('recap_sources.message_seq >= ?');
        parameters.push(requireSequence(query.fromSeq, 'fromSeq'));
      }
      if (query.toSeq !== undefined) {
        conditions.push('recap_sources.message_seq <= ?');
        parameters.push(requireSequence(query.toSeq, 'toSeq'));
      }
      clauses.push(`EXISTS (
        SELECT 1 FROM recap_sources WHERE ${conditions.join(' AND ')}
      )`);
    }
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0)) {
      throw new RecapError('invalid_recap', 'limit must be a positive safe integer.');
    }
    if (query.offset !== undefined && (!Number.isSafeInteger(query.offset) || query.offset < 0)) {
      throw new RecapError('invalid_recap', 'offset must be a non-negative safe integer.');
    }
    const limit = query.limit === undefined ? '' : ' LIMIT ?';
    if (query.limit !== undefined) parameters.push(query.limit);
    const offset = query.offset === undefined ? '' : ' OFFSET ?';
    if (query.offset !== undefined) {
      if (query.limit === undefined)
        throw new RecapError('invalid_recap', 'offset requires limit.');
      parameters.push(query.offset);
    }
    const rows = z.array(recapRowSchema).parse(
      this.#database
        .prepare(
          `SELECT recaps.* FROM recaps WHERE ${clauses.join(' AND ')}
           ORDER BY recaps.source_seq_start, recaps.source_seq_end, recaps.recap_id${limit}${offset}`,
        )
        .all(...parameters),
    );
    return rows.map((row) => this.#toRecord(row));
  }

  invalidate(threadId: string, agentId: string, recapId: string, reason: string): Recap {
    requireIdentifier(reason, 'reason');
    const invalidatedAt = isoTime(undefined, this.#clock);
    const result = this.#database
      .prepare(
        `UPDATE recaps SET validity = 'invalid', invalidated_at = ?, invalidation_reason = ?
         WHERE thread_id = ? AND agent_id = ? AND recap_id = ?`,
      )
      .run(invalidatedAt, reason, threadId, agentId, recapId);
    if (result.changes === 0) {
      throw new RecapError('recap_not_found', `Recap ${recapId} was not found.`);
    }
    const recap = this.get(threadId, agentId, recapId);
    if (!recap) throw new Error(`Invalidated recap ${recapId} could not be read.`);
    return recap;
  }

  #prepare(input: SaveRecapInput): Recap {
    const threadId = requireIdentifier(input.threadId, 'threadId');
    const agentId = requireIdentifier(input.agentId, 'agentId');
    const recapId = requireIdentifier(input.recapId ?? createId(), 'recapId');
    if (input.content.trim().length === 0) {
      throw new RecapError('invalid_recap', 'Recap content must not be empty.');
    }
    if (input.sourceMessageSeqs.length === 0) {
      throw new RecapError('invalid_recap', 'A recap must have at least one source message.');
    }
    let previous = 0;
    for (const seq of input.sourceMessageSeqs) {
      requireSequence(seq, 'source sequence');
      if (seq <= previous) {
        throw new RecapError(
          'invalid_recap',
          'Recap source sequences must be strictly increasing and unique.',
        );
      }
      previous = seq;
    }
    const sources = this.#context.getBySeqs(threadId, agentId, input.sourceMessageSeqs);
    this.#validateToolRoundTrips(threadId, agentId, sources);
    const createdAt = isoTime(input.createdAt, this.#clock);
    const first = sources[0];
    const last = sources.at(-1);
    if (!first || !last) throw new RecapError('invalid_recap', 'Recap sources are missing.');
    const timeRange = sourceTimeRange(sources);
    return {
      recapId,
      threadId,
      agentId,
      sourceSeqStart: first.seq,
      sourceSeqEnd: last.seq,
      sourceMessageSeqs: [...input.sourceMessageSeqs],
      sourceCreatedAtStart: timeRange.start,
      sourceCreatedAtEnd: timeRange.end,
      content: input.content,
      createdAt,
      validity: 'valid',
      invalidatedAt: null,
      invalidationReason: null,
    };
  }

  #validateToolRoundTrips(
    threadId: string,
    agentId: string,
    sources: readonly ContextMessage[],
  ): void {
    const included = new Set(sources.map((source) => source.seq));
    const sourceBySeq = new Map(sources.map((source) => [source.seq, source]));
    const relations = this.#context.listToolCallRelations(threadId, agentId);
    for (const relation of relations) {
      const hasAssistant = included.has(relation.assistantSeq);
      const hasResult = relation.resultSeq !== null && included.has(relation.resultSeq);
      if (!hasAssistant && !hasResult) continue;
      if (!hasAssistant || relation.resultSeq === null || !hasResult) {
        throw new RecapError(
          'incomplete_tool_round_trip',
          `Recap sources must include the complete tool round trip for ${relation.callId}.`,
        );
      }
      const assistant = sourceBySeq.get(relation.assistantSeq)?.message;
      if (assistant?.role === 'assistant') {
        for (const call of assistant.tool_calls ?? []) {
          const other = relations.find(
            (candidate) =>
              candidate.assistantSeq === relation.assistantSeq && candidate.callId === call.id,
          );
          if (!other?.resultSeq || !included.has(other.resultSeq)) {
            throw new RecapError(
              'incomplete_tool_round_trip',
              `Recap sources must include every result for assistant message ${relation.assistantSeq}.`,
            );
          }
        }
      }
    }
  }

  #insert(recap: Recap): void {
    this.#database
      .prepare(
        `INSERT INTO recaps(
          recap_id, thread_id, agent_id, source_seq_start, source_seq_end,
          source_message_seqs, content, created_at, validity,
          invalidated_at, invalidation_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        recap.recapId,
        recap.threadId,
        recap.agentId,
        recap.sourceSeqStart,
        recap.sourceSeqEnd,
        jsonText(recap.sourceMessageSeqs, 'sourceMessageSeqs'),
        recap.content,
        recap.createdAt,
        recap.validity,
        recap.invalidatedAt,
        recap.invalidationReason,
      );
    const insertSource = this.#database.prepare(
      'INSERT INTO recap_sources(recap_id, position, message_seq) VALUES (?, ?, ?)',
    );
    recap.sourceMessageSeqs.forEach((seq, index) => {
      insertSource.run(recap.recapId, index + 1, seq);
    });
  }

  #toRecord(row: RecapRow): Recap {
    const parsedSources = sourceSequences(row);
    const related = z
      .array(z.object({ message_seq: z.number().int().positive() }))
      .parse(
        this.#database
          .prepare('SELECT message_seq FROM recap_sources WHERE recap_id = ? ORDER BY position')
          .all(row.recap_id),
      )
      .map((source) => source.message_seq);
    if (jsonText(parsedSources, 'sourceMessageSeqs') !== jsonText(related, 'sourceMessageSeqs')) {
      throw new RecapError('invalid_recap', `Recap ${row.recap_id} has inconsistent sources.`);
    }
    const sources = this.#context.getBySeqs(row.thread_id, row.agent_id, parsedSources);
    const first = sources[0];
    const last = sources.at(-1);
    if (!first || !last || first.seq !== row.source_seq_start || last.seq !== row.source_seq_end) {
      throw new RecapError('invalid_recap', `Recap ${row.recap_id} has an invalid source range.`);
    }
    const timeRange = sourceTimeRange(sources);
    return {
      recapId: row.recap_id,
      threadId: row.thread_id,
      agentId: row.agent_id,
      sourceSeqStart: row.source_seq_start,
      sourceSeqEnd: row.source_seq_end,
      sourceMessageSeqs: parsedSources,
      sourceCreatedAtStart: timeRange.start,
      sourceCreatedAtEnd: timeRange.end,
      content: row.content,
      createdAt: row.created_at,
      validity: row.validity,
      invalidatedAt: row.invalidated_at,
      invalidationReason: row.invalidation_reason,
    };
  }
}
