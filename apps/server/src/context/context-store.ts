import type { DatabaseSync } from 'node:sqlite';
import type { DetailedModelUsage } from '@kairos/agent-core';
import { z } from 'zod';
import { AttachmentStore } from '../attachments/store.js';
import { channelJsonText, parseChannelJson } from '../channels/reference.js';
import { inTransaction } from '../storage/transaction.js';
import { modelResponseModeEventId, readSendToUserMode } from './output-mode.js';
import type {
  AppendContextMessageInput,
  Clock,
  ContextMessage,
  ContextMessageRevision,
  ContextQuery,
  ToolCallRelation,
} from './types.js';
import {
  ContextError,
  createId,
  isoTime,
  jsonText,
  parseJson,
  parseModelMessage,
  parseResponseUsage,
  requireIdentifier,
  requireSequence,
  systemClock,
} from './types.js';

const contextRowSchema = z.object({
  seq: z.number().int().positive(),
  message_id: z.string(),
  thread_id: z.string(),
  agent_id: z.string(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  content_blocks_json: z.string().nullable(),
  response_usage_json: z.string().nullable(),
  tool_calls_json: z.string().nullable(),
  incomplete_tool_calls_json: z.string().nullable(),
  tool_call_id: z.string().nullable(),
  tool_name: z.string().nullable(),
  tool_status: z.enum(['success', 'error']).nullable(),
  tool_error_json: z.string().nullable(),
  created_at: z.string(),
  run_id: z.string().nullable(),
  superseded_by_run_id: z.string().nullable(),
  source: z
    .enum([
      'user',
      'thread_call',
      'thread_response',
      'subagent_response',
      'automation',
      'thread_notification',
      'channel',
      'background_task',
    ])
    .nullable(),
  delegation_source_thread_id: z.string().nullable(),
  delegation_source_agent_id: z.string().nullable(),
  source_tool_call_id: z.string().nullable(),
  source_input_id: z.string().nullable(),
  source_thread_id: z.string().nullable(),
  source_agent_id: z.string().nullable(),
  automation_schedule_id: z.string().nullable(),
  automation_fire_id: z.string().nullable(),
  automation_trigger: z.enum(['scheduled', 'run_now']).nullable(),
  automation_scheduled_at: z.string().nullable(),
  channel_json: z.string().nullable(),
});

type ContextRow = z.infer<typeof contextRowSchema>;

const revisionRowSchema = z.object({
  revision_id: z.string(),
  revision_number: z.number().int().positive(),
  content: z.string(),
  created_at: z.string(),
  run_id: z.string().nullable(),
});

const toolCallRowSchema = z.object({
  call_id: z.string(),
  tool_name: z.string(),
  assistant_seq: z.number().int().positive(),
  result_seq: z.number().int().positive().nullable(),
  call_type: z.enum(['complete', 'incomplete']),
});

function originalMessage(row: ContextRow) {
  switch (row.role) {
    case 'system':
    case 'user':
      return parseModelMessage({ role: row.role, content: row.content });
    case 'assistant': {
      const contentBlocks =
        row.content_blocks_json === null
          ? undefined
          : parseJson(row.content_blocks_json, 'content_blocks_json');
      const toolCalls =
        row.tool_calls_json === null
          ? undefined
          : parseJson(row.tool_calls_json, 'tool_calls_json');
      const incompleteToolCalls =
        row.incomplete_tool_calls_json === null
          ? undefined
          : parseJson(row.incomplete_tool_calls_json, 'incomplete_tool_calls_json');
      return parseModelMessage({
        role: row.role,
        content: row.content,
        ...(contentBlocks === undefined ? {} : { content_blocks: contentBlocks }),
        ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
        ...(incompleteToolCalls === undefined
          ? {}
          : { incomplete_tool_calls: incompleteToolCalls }),
      });
    }
    case 'tool': {
      const error =
        row.tool_error_json === null
          ? undefined
          : parseJson(row.tool_error_json, 'tool_error_json');
      return parseModelMessage({
        role: row.role,
        content: row.content,
        tool_call_id: row.tool_call_id,
        tool_name: row.tool_name,
        ...(row.tool_status === null ? {} : { status: row.tool_status }),
        ...(error === undefined ? {} : { error }),
      });
    }
  }
}

function likePattern(value: string): string {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

export class ContextStore {
  readonly #database: DatabaseSync;
  readonly #clock: Clock;
  readonly #hasInteractions: boolean;

  constructor(database: DatabaseSync, clock: Clock = systemClock) {
    this.#database = database;
    this.#clock = clock;
    this.#hasInteractions =
      database
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'interactions'",
        )
        .get() !== undefined;
  }

  append(input: AppendContextMessageInput): ContextMessage {
    const threadId = requireIdentifier(input.threadId, 'threadId');
    const agentId = requireIdentifier(input.agentId, 'agentId');
    const message = parseModelMessage(input.message);
    if (message.role === 'user' && message.content_parts !== undefined) {
      throw new ContextError(
        'invalid_message',
        'Context attachments must be persisted through their input association.',
      );
    }
    const messageText = message.content;
    const responseUsage =
      input.responseUsage === undefined ? undefined : parseResponseUsage(input.responseUsage);
    if (responseUsage !== undefined && message.role !== 'assistant') {
      throw new ContextError('invalid_message', 'Response usage belongs to an assistant message.');
    }
    const messageId = requireIdentifier(input.messageId ?? createId(), 'messageId');
    if (message.role === 'assistant' && message.incomplete_tool_calls !== undefined) {
      message.incomplete_tool_calls = message.incomplete_tool_calls.map((call, index) => ({
        ...call,
        id: call.id ?? `incomplete-${messageId}-${index + 1}`,
      }));
    }
    const createdAt = isoTime(input.createdAt, this.#clock);
    const runId = input.runId ?? null;
    if (runId !== null) requireIdentifier(runId, 'runId');
    const delegation = input.delegation ?? null;
    const sourceInputId = input.sourceInputId ?? null;
    const sourceThreadId = input.sourceThreadId ?? null;
    const sourceAgentId = input.sourceAgentId ?? null;
    const automation = input.automation ?? null;
    if (automation !== null) {
      requireIdentifier(automation.scheduleId, 'automation.scheduleId');
      requireIdentifier(automation.fireId, 'automation.fireId');
      isoTime(automation.scheduledAt, this.#clock);
    }
    if (delegation !== null) {
      requireIdentifier(delegation.sourceThreadId, 'delegation.sourceThreadId');
      requireIdentifier(delegation.sourceAgentId, 'delegation.sourceAgentId');
      requireIdentifier(delegation.sourceToolCallId, 'delegation.sourceToolCallId');
    }
    if (sourceInputId !== null) requireIdentifier(sourceInputId, 'sourceInputId');
    if (sourceThreadId !== null) requireIdentifier(sourceThreadId, 'sourceThreadId');
    if (sourceAgentId !== null) requireIdentifier(sourceAgentId, 'sourceAgentId');
    const channel = input.channel ?? null;
    if (channel !== null) {
      if (channel.externalMessageId != null) {
        requireIdentifier(channel.externalMessageId, 'channel.externalMessageId');
      }
      if (channel.deliveryId != null) requireIdentifier(channel.deliveryId, 'channel.deliveryId');
    }

    const append = () => {
      let toolCall: z.infer<typeof toolCallRowSchema> | undefined;
      let supersededByRunId: string | null = null;
      if (message.role === 'tool') {
        const row = this.#database
          .prepare(
            `SELECT call_id, tool_name, assistant_seq, result_seq, call_type
             FROM context_tool_calls
             WHERE thread_id = ? AND agent_id = ? AND call_id = ?`,
          )
          .get(threadId, agentId, message.tool_call_id);
        toolCall = row === undefined ? undefined : toolCallRowSchema.parse(row);
        if (!toolCall) {
          throw new ContextError(
            'tool_call_not_found',
            `Tool call ${message.tool_call_id} does not exist in this context.`,
          );
        }
        if (toolCall.tool_name !== message.tool_name) {
          throw new ContextError(
            'tool_call_name_mismatch',
            `Tool result name does not match call ${message.tool_call_id}.`,
          );
        }
        if (toolCall.result_seq !== null) {
          throw new ContextError(
            'tool_result_exists',
            `Tool call ${message.tool_call_id} already has a final result.`,
          );
        }
        supersededByRunId = z
          .object({ superseded_by_run_id: z.string().nullable() })
          .parse(
            this.#database
              .prepare('SELECT superseded_by_run_id FROM context_messages WHERE seq = ?')
              .get(toolCall.assistant_seq),
          ).superseded_by_run_id;
      }

      const result = this.#database
        .prepare(
          `INSERT INTO context_messages(
            message_id, thread_id, agent_id, role, content, content_blocks_json,
            response_usage_json, tool_calls_json, incomplete_tool_calls_json,
            tool_call_id, tool_name, tool_status, tool_error_json, created_at, run_id,
            superseded_by_run_id, source, delegation_source_thread_id,
            delegation_source_agent_id, source_tool_call_id, source_input_id,
            source_thread_id, source_agent_id, automation_schedule_id, automation_fire_id,
            automation_trigger, automation_scheduled_at, channel_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          threadId,
          agentId,
          message.role,
          messageText,
          message.role === 'assistant' && message.content_blocks !== undefined
            ? jsonText(message.content_blocks, 'content_blocks')
            : null,
          responseUsage === undefined ? null : jsonText(responseUsage, 'response_usage'),
          message.role === 'assistant' && message.tool_calls !== undefined
            ? jsonText(message.tool_calls, 'tool_calls')
            : null,
          message.role === 'assistant' && message.incomplete_tool_calls !== undefined
            ? jsonText(message.incomplete_tool_calls, 'incomplete_tool_calls')
            : null,
          message.role === 'tool' ? message.tool_call_id : null,
          message.role === 'tool' ? message.tool_name : null,
          message.role === 'tool' ? (message.status ?? null) : null,
          message.role === 'tool' && message.error !== undefined
            ? jsonText(message.error, 'tool_error')
            : null,
          createdAt,
          runId,
          supersededByRunId,
          input.source ?? null,
          delegation?.sourceThreadId ?? null,
          delegation?.sourceAgentId ?? null,
          delegation?.sourceToolCallId ?? null,
          sourceInputId,
          sourceThreadId,
          sourceAgentId,
          automation?.scheduleId ?? null,
          automation?.fireId ?? null,
          automation?.trigger ?? null,
          automation?.scheduledAt ?? null,
          channelJsonText(channel),
        );
      const insertedSeq = requireSequence(Number(result.lastInsertRowid), 'seq');

      if (message.role === 'assistant') {
        const insertCall = this.#database.prepare(
          `INSERT INTO context_tool_calls(
            thread_id, agent_id, call_id, assistant_seq, tool_name, arguments_json,
            call_type, arguments_text, call_error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const call of message.tool_calls ?? []) {
          insertCall.run(
            threadId,
            agentId,
            call.id,
            insertedSeq,
            call.name,
            jsonText(call.arguments, 'arguments'),
            'complete',
            null,
            null,
          );
        }
        for (const call of message.incomplete_tool_calls ?? []) {
          if (call.id === undefined) {
            throw new ContextError('invalid_message', 'An incomplete tool call ID is required.');
          }
          insertCall.run(
            threadId,
            agentId,
            call.id,
            insertedSeq,
            call.name ?? 'unknown',
            'null',
            'incomplete',
            call.arguments_text,
            call.error,
          );
        }
      } else if (message.role === 'tool' && toolCall) {
        this.#database
          .prepare(
            `UPDATE context_tool_calls SET result_seq = ?
             WHERE thread_id = ? AND agent_id = ? AND call_id = ?`,
          )
          .run(insertedSeq, threadId, agentId, toolCall.call_id);
      }
      return insertedSeq;
    };
    const seq = this.#database.isTransaction ? append() : inTransaction(this.#database, append);
    const record = this.get(threadId, agentId, seq);
    if (!record) throw new Error(`Inserted context message ${seq} could not be read.`);
    return record;
  }

  revise(input: {
    threadId: string;
    agentId: string;
    seq: number;
    content: string;
    revisionId?: string;
    createdAt?: string;
    runId?: string;
  }): ContextMessage {
    const threadId = requireIdentifier(input.threadId, 'threadId');
    const agentId = requireIdentifier(input.agentId, 'agentId');
    const seq = requireSequence(input.seq, 'seq');
    const revisionId = requireIdentifier(input.revisionId ?? createId(), 'revisionId');
    const createdAt = isoTime(input.createdAt, this.#clock);
    const runId = input.runId ?? null;
    if (!this.get(threadId, agentId, seq)) {
      throw new ContextError('message_not_found', `Context message ${seq} was not found.`);
    }
    inTransaction(this.#database, () => {
      const row = this.#database
        .prepare(
          `SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number
           FROM context_message_revisions WHERE message_seq = ?`,
        )
        .get(seq);
      const revisionNumber = z
        .number()
        .int()
        .positive()
        .parse(z.object({ revision_number: z.unknown() }).parse(row).revision_number);
      this.#database
        .prepare(
          `INSERT INTO context_message_revisions(
            revision_id, message_seq, revision_number, content, created_at, run_id
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(revisionId, seq, revisionNumber, input.content, createdAt, runId);
      this.#database
        .prepare(
          `UPDATE recaps
           SET validity = 'invalid', invalidated_at = ?, invalidation_reason = 'source_revised'
           WHERE validity = 'valid' AND EXISTS (
             SELECT 1 FROM recap_sources
             WHERE recap_sources.recap_id = recaps.recap_id
               AND recap_sources.message_seq = ?
           )`,
        )
        .run(createdAt, seq);
    });
    const record = this.get(threadId, agentId, seq);
    if (!record) throw new Error(`Revised context message ${seq} could not be read.`);
    return record;
  }

  get(threadId: string, agentId: string, seq: number): ContextMessage | undefined {
    requireSequence(seq, 'seq');
    const row = this.#database
      .prepare(
        `SELECT * FROM context_messages
         WHERE thread_id = ? AND agent_id = ? AND seq = ?`,
      )
      .get(threadId, agentId, seq);
    return row === undefined ? undefined : this.#toRecord(contextRowSchema.parse(row));
  }

  setResponseUsage(
    threadId: string,
    agentId: string,
    seq: number,
    usage: DetailedModelUsage,
  ): void {
    requireIdentifier(threadId, 'threadId');
    requireIdentifier(agentId, 'agentId');
    requireSequence(seq, 'seq');
    const parsed = parseResponseUsage(usage);
    const result = this.#database
      .prepare(
        `UPDATE context_messages SET response_usage_json = ?
         WHERE thread_id = ? AND agent_id = ? AND seq = ? AND role = 'assistant'`,
      )
      .run(jsonText(parsed, 'response_usage'), threadId, agentId, seq);
    if (result.changes !== 1) {
      throw new ContextError('message_not_found', `Assistant message ${seq} was not found.`);
    }
  }

  getBySeqs(threadId: string, agentId: string, seqs: readonly number[]): ContextMessage[] {
    if (seqs.length === 0) return [];
    for (const seq of seqs) requireSequence(seq, 'source sequence');
    const placeholders = seqs.map(() => '?').join(',');
    const rows = z.array(contextRowSchema).parse(
      this.#database
        .prepare(
          `SELECT * FROM context_messages
           WHERE thread_id = ? AND agent_id = ? AND seq IN (${placeholders})
           ORDER BY seq`,
        )
        .all(threadId, agentId, ...seqs),
    );
    if (rows.length !== new Set(seqs).size) {
      throw new ContextError('message_not_found', 'One or more source messages were not found.');
    }
    return rows.map((row) => this.#toRecord(row));
  }

  query(query: ContextQuery): ContextMessage[] {
    const threadId = requireIdentifier(query.threadId, 'threadId');
    const agentId = requireIdentifier(query.agentId, 'agentId');
    const clauses = ['context_messages.thread_id = ?', 'context_messages.agent_id = ?'];
    const parameters: (string | number)[] = [threadId, agentId];
    if (query.currentOnly === true) {
      clauses.push('context_messages.superseded_by_run_id IS NULL');
      if (this.#hasInteractions) {
        clauses.push(`(
          context_messages.source IS NULL
          OR context_messages.source NOT IN (
            'thread_response', 'subagent_response', 'thread_notification', 'background_task'
          )
          OR context_messages.source_tool_call_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM context_tool_calls AS source_call
            JOIN context_messages AS source_message
              ON source_message.seq = source_call.assistant_seq
            WHERE source_call.thread_id = context_messages.delegation_source_thread_id
              AND source_call.agent_id = context_messages.delegation_source_agent_id
              AND source_call.call_id = context_messages.source_tool_call_id
              AND source_message.superseded_by_run_id IS NOT NULL
          )
        )`);
      }
    }
    if (query.seq !== undefined) {
      clauses.push('context_messages.seq = ?');
      parameters.push(requireSequence(query.seq, 'seq'));
    }
    if (query.fromSeq !== undefined) {
      clauses.push('context_messages.seq >= ?');
      parameters.push(requireSequence(query.fromSeq, 'fromSeq'));
    }
    if (query.toSeq !== undefined) {
      clauses.push('context_messages.seq <= ?');
      parameters.push(requireSequence(query.toSeq, 'toSeq'));
    }
    if (query.query !== undefined && query.query.length > 0) {
      const pattern = likePattern(query.query);
      if (query.currentOnly === true) {
        clauses.push(`COALESCE((
          SELECT content FROM context_message_revisions
          WHERE context_message_revisions.message_seq = context_messages.seq
          ORDER BY revision_number DESC LIMIT 1
        ), context_messages.content) LIKE ? ESCAPE '\\'`);
        parameters.push(pattern);
      } else {
        clauses.push(`(
          content LIKE ? ESCAPE '\\' OR EXISTS (
            SELECT 1 FROM context_message_revisions
            WHERE context_message_revisions.message_seq = context_messages.seq
              AND context_message_revisions.content LIKE ? ESCAPE '\\'
          )
        )`);
        parameters.push(pattern, pattern);
      }
    }
    let limit = '';
    if (query.limit !== undefined) {
      if (!Number.isSafeInteger(query.limit) || query.limit <= 0) {
        throw new ContextError('invalid_query', 'limit must be a positive safe integer.');
      }
      limit = ' LIMIT ?';
      parameters.push(query.limit);
    }
    const rows = z.array(contextRowSchema).parse(
      this.#database
        .prepare(
          `SELECT context_messages.* FROM context_messages
           WHERE ${clauses.join(' AND ')} ORDER BY context_messages.seq${limit}`,
        )
        .all(...parameters),
    );
    return rows.map((row) => this.#toRecord(row));
  }

  listToolCallRelations(
    threadId: string,
    agentId: string,
    options: { currentOnly?: boolean } = {},
  ): ToolCallRelation[] {
    const currentOnly = options.currentOnly === true;
    return z
      .array(toolCallRowSchema)
      .parse(
        this.#database
          .prepare(
            `SELECT context_tool_calls.call_id, context_tool_calls.tool_name,
                    context_tool_calls.assistant_seq, context_tool_calls.result_seq,
                    context_tool_calls.call_type
             FROM context_tool_calls
             ${
               currentOnly
                 ? `JOIN context_messages AS assistant
                      ON assistant.seq = context_tool_calls.assistant_seq
                     AND assistant.superseded_by_run_id IS NULL
                    LEFT JOIN context_messages AS result
                      ON result.seq = context_tool_calls.result_seq
                     AND result.superseded_by_run_id IS NULL`
                 : ''
             }
             WHERE context_tool_calls.thread_id = ? AND context_tool_calls.agent_id = ?
             ${currentOnly ? 'AND (context_tool_calls.result_seq IS NULL OR result.seq IS NOT NULL)' : ''}
             ORDER BY context_tool_calls.assistant_seq, context_tool_calls.call_id`,
          )
          .all(threadId, agentId),
      )
      .map((row) => ({
        callId: row.call_id,
        toolName: row.tool_name,
        assistantSeq: row.assistant_seq,
        resultSeq: row.result_seq,
        callType: row.call_type,
      }));
  }

  isCurrentToolCall(threadId: string, agentId: string, callId: string): boolean {
    const row = this.#database
      .prepare(
        `SELECT context_messages.superseded_by_run_id
         FROM context_tool_calls
         JOIN context_messages ON context_messages.seq = context_tool_calls.assistant_seq
         WHERE context_tool_calls.thread_id = ? AND context_tool_calls.agent_id = ?
           AND context_tool_calls.call_id = ?`,
      )
      .get(threadId, agentId, callId);
    if (row === undefined) return true;
    return (
      z.object({ superseded_by_run_id: z.string().nullable() }).parse(row).superseded_by_run_id ===
      null
    );
  }

  #toRecord(row: ContextRow): ContextMessage {
    const sendToUserEnabled = this.#messageOutputMode(row);
    const revisions = z
      .array(revisionRowSchema)
      .parse(
        this.#database
          .prepare(
            `SELECT revision_id, revision_number, content, created_at, run_id
           FROM context_message_revisions WHERE message_seq = ? ORDER BY revision_number`,
          )
          .all(row.seq),
      )
      .map(
        (revision): ContextMessageRevision => ({
          revisionId: revision.revision_id,
          revisionNumber: revision.revision_number,
          content: revision.content,
          createdAt: revision.created_at,
          runId: revision.run_id,
        }),
      );
    return {
      seq: row.seq,
      messageId: row.message_id,
      threadId: row.thread_id,
      agentId: row.agent_id,
      createdAt: row.created_at,
      runId: row.run_id,
      ...(sendToUserEnabled === undefined ? {} : { sendToUserEnabled }),
      supersededByRunId: row.superseded_by_run_id,
      source: row.source,
      delegation:
        row.source_tool_call_id === null
          ? null
          : {
              sourceThreadId: requireIdentifier(
                row.delegation_source_thread_id ?? '',
                'delegation_source_thread_id',
              ),
              sourceAgentId: requireIdentifier(
                row.delegation_source_agent_id ?? '',
                'delegation_source_agent_id',
              ),
              sourceToolCallId: row.source_tool_call_id,
            },
      sourceInputId: row.source_input_id,
      sourceThreadId: row.source_thread_id,
      sourceAgentId: row.source_agent_id,
      channel: parseChannelJson(row.channel_json),
      automation:
        row.automation_schedule_id === null ||
        row.automation_fire_id === null ||
        row.automation_trigger === null ||
        row.automation_scheduled_at === null
          ? null
          : {
              scheduleId: row.automation_schedule_id,
              fireId: row.automation_fire_id,
              trigger: row.automation_trigger,
              scheduledAt: row.automation_scheduled_at,
            },
      ...(row.response_usage_json === null
        ? {}
        : {
            responseUsage: parseResponseUsage(
              parseJson(row.response_usage_json, 'response_usage_json'),
            ),
          }),
      ...(() => {
        const attachments = AttachmentStore.listForMessage(this.#database, row.seq);
        return attachments.length > 0 ? { attachments } : {};
      })(),
      message: originalMessage(row),
      revisions,
    };
  }

  #messageOutputMode(row: ContextRow): boolean | undefined {
    let messageId: string;
    if (row.role === 'assistant') messageId = row.message_id;
    else if (row.role === 'tool') {
      const assistant = z
        .object({ message_id: z.string() })
        .optional()
        .parse(
          this.#database
            .prepare(
              `SELECT messages.message_id FROM context_tool_calls AS calls
               JOIN context_messages AS messages ON messages.seq = calls.assistant_seq
               WHERE calls.thread_id = ? AND calls.agent_id = ? AND calls.call_id = ?`,
            )
            .get(row.thread_id, row.agent_id, row.tool_call_id),
        );
      if (assistant === undefined) return undefined;
      messageId = assistant.message_id;
    } else return undefined;
    return readSendToUserMode(
      this.#database,
      modelResponseModeEventId(messageId),
      row.thread_id,
      row.agent_id,
    );
  }
}
