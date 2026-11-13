import { z } from 'zod';
import { type AttachmentMetadata, attachmentMediaTypeSchema } from '../attachments/types.js';
import { parseChannelJson } from '../channels/reference.js';
import type { ChannelReference, DelegationKey, MessageSource } from '../context/types.js';
import { SessionError } from './errors.js';
import type { InteractionRecord, RunStatus, ThreadRecord } from './records.js';
import type { SessionStore } from './store.js';

export const threadPreviewTextLimit = 240;
export const threadCallPreviewBatchLimit = 100;

export type ThreadCardSort = 'last_message_at' | 'created_at';

export interface ThreadCardCursor {
  sort: ThreadCardSort;
  sortAt: string;
  threadSeq: bigint;
}

export interface ThreadMessagePreviewProjection {
  messageId: string;
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  textTruncated: boolean;
  createdAt: string;
  source: MessageSource | null;
  sourceThreadId: string | null;
  channel: ChannelReference | null;
  attachments: AttachmentMetadata[];
}

export interface ThreadCallReferenceProjection {
  delegation: DelegationKey;
  sourceMessageId: string;
  sourceMessageSeq: number;
}

export interface ThreadCardProjection {
  thread: ThreadRecord;
  lastMessageAt: string | null;
  messages: ThreadMessagePreviewProjection[];
  sourceCall: ThreadCallReferenceProjection | null;
}

export interface ThreadCallPreviewProjection {
  call: ThreadCallReferenceProjection;
  targetThreadId: string;
  targetTitle: string;
  status: RunStatus;
  replyCount: number;
  replies: ThreadMessagePreviewProjection[];
  responseMessageSeq: number | null;
}

const messageSourceSchema = z.enum([
  'user',
  'thread_call',
  'thread_response',
  'subagent_response',
  'automation',
  'thread_notification',
  'channel',
]);
const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'cancel_requested',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
const threadRowSchema = z.object({
  seq: z.number().int().positive(),
  thread_id: z.string(),
  owner_id: z.string(),
  title: z.string(),
  thread_type: z.enum(['main', 'task']),
  automation_only: z.number().int().min(0).max(1),
  created_at: z.string(),
  updated_at: z.string(),
});
const cardRowSchema = threadRowSchema.extend({
  last_message_at: z.string().nullable(),
  sort_at: z.string(),
});
const messageRowSchema = z.object({
  thread_id: z.string(),
  agent_id: z.string(),
  message_id: z.string(),
  seq: z.number().int().positive(),
  role: z.enum(['user', 'assistant']),
  source: messageSourceSchema.nullable(),
  source_thread_id: z.string().nullable(),
  channel_json: z.string().nullable(),
  created_at: z.string(),
  text: z.string(),
  text_truncated: z
    .number()
    .int()
    .min(0)
    .max(1)
    .transform((value) => value === 1),
});
const attachmentMessageRowSchema = messageRowSchema.extend({
  attachment_position: z.number().int().positive().nullable(),
  attachment_id: z.string().nullable(),
  file_name: z.string().nullable(),
  media_type: attachmentMediaTypeSchema.nullable(),
  byte_size: z.number().int().positive().safe().nullable(),
  width: z.number().int().positive().safe().nullable(),
  height: z.number().int().positive().safe().nullable(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  attachment_created_at: z.string().nullable(),
});
const sourceRowSchema = z.object({
  thread_id: z.string(),
  source_thread_id: z.string(),
  source_agent_id: z.string(),
  source_tool_call_id: z.string(),
  source_message_id: z.string(),
  source_message_seq: z.number().int().positive(),
});
const callRowSchema = z.object({
  source_thread_id: z.string(),
  source_agent_id: z.string(),
  source_tool_call_id: z.string(),
  source_message_id: z.string(),
  source_message_seq: z.number().int().positive(),
  target_thread_id: z.string(),
  target_agent_id: z.string(),
  target_title: z.string(),
  target_input_id: z.string().nullable(),
  status: runStatusSchema,
  response_message_seq: z.number().int().positive().nullable(),
});
const targetRelationRowSchema = z.object({
  source_thread_id: z.string(),
  source_agent_id: z.string(),
  source_tool_call_id: z.string(),
  target_thread_id: z.string(),
  target_agent_id: z.string(),
  target_input_id: z.string().nullable(),
  prompt_seq: z.number().int().positive().nullable(),
  response_message_seq: z.number().int().positive().nullable(),
});

type MessageRow = z.infer<typeof messageRowSchema> & { attachments: AttachmentMetadata[] };
type AttachmentMessageRow = z.infer<typeof attachmentMessageRowSchema>;
type CallRow = z.infer<typeof callRowSchema>;

function currentMessageWhere(alias: string): string {
  return `${alias}.superseded_by_run_id IS NULL AND (
    ${alias}.source IS NULL OR ${alias}.source NOT IN (
      'thread_response', 'subagent_response', 'thread_notification'
    )
    OR ${alias}.source_tool_call_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM context_tool_calls AS source_call
      JOIN context_messages AS source_message
        ON source_message.seq = source_call.assistant_seq
      WHERE source_call.thread_id = ${alias}.delegation_source_thread_id
        AND source_call.agent_id = ${alias}.delegation_source_agent_id
        AND source_call.call_id = ${alias}.source_tool_call_id
        AND source_message.superseded_by_run_id IS NOT NULL
    )
  )`;
}

function displayMessageWhere(alias: string): string {
  return `${alias}.role IN ('user', 'assistant')
    AND (${alias}.source IS NULL OR ${alias}.source <> 'thread_call')`;
}

function currentText(alias: string): string {
  return `COALESCE((
    SELECT revision.content FROM context_message_revisions AS revision
    WHERE revision.message_seq = ${alias}.seq
    ORDER BY revision.revision_number DESC LIMIT 1
  ), ${alias}.content)`;
}

function previewColumns(alias: string): string {
  const text = currentText(alias);
  return `${alias}.thread_id, ${alias}.agent_id, ${alias}.message_id, ${alias}.seq,
    ${alias}.role, ${alias}.source, ${alias}.source_thread_id, ${alias}.channel_json, ${alias}.created_at,
    substr(${text}, 1, ${threadPreviewTextLimit}) AS text,
    (length(${text}) > ${threadPreviewTextLimit}) AS text_truncated`;
}

function attachmentColumns(): string {
  return `message_attachment.position AS attachment_position,
    attachment.attachment_id, attachment.file_name, attachment.media_type, attachment.byte_size,
    attachment.width, attachment.height, attachment.sha256,
    attachment.created_at AS attachment_created_at`;
}

function attachmentJoins(messageAlias: string): string {
  return `LEFT JOIN context_message_attachments AS message_attachment
      ON message_attachment.message_seq = ${messageAlias}.seq
    LEFT JOIN attachments AS attachment
      ON attachment.attachment_id = message_attachment.attachment_id`;
}

function toThread(row: z.infer<typeof threadRowSchema>): ThreadRecord {
  return {
    threadId: row.thread_id,
    ownerId: row.owner_id,
    title: row.title,
    threadType: row.thread_type,
    automationOnly: row.automation_only === 1,
    seq: row.seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageRows(rows: readonly AttachmentMessageRow[]): MessageRow[] {
  const result = new Map<number, MessageRow>();
  for (const row of rows) {
    const message = result.get(row.seq) ?? { ...row, attachments: [] };
    result.set(row.seq, message);
    if (row.attachment_id === null) {
      if (row.attachment_position !== null) invalidAttachmentRow();
      continue;
    }
    if (row.attachment_position !== message.attachments.length + 1) invalidAttachmentRow();
    message.attachments.push({
      attachmentId: row.attachment_id,
      fileName: requiredAttachmentField(row.file_name),
      mediaType: requiredAttachmentField(row.media_type),
      byteSize: requiredAttachmentField(row.byte_size),
      ...(row.width === null ? {} : { width: row.width }),
      ...(row.height === null ? {} : { height: row.height }),
      sha256: requiredAttachmentField(row.sha256),
      createdAt: requiredAttachmentField(row.attachment_created_at),
    });
    if (message.attachments.length > 4) invalidAttachmentRow();
  }
  return [...result.values()];
}

function requiredAttachmentField<T>(value: T | null): T {
  return value === null ? invalidAttachmentRow() : value;
}

function invalidAttachmentRow(): never {
  throw new SessionError('internal', 'Stored preview attachment metadata is invalid.');
}

function toMessage(row: MessageRow): ThreadMessagePreviewProjection {
  return {
    messageId: row.message_id,
    seq: row.seq,
    role: row.role,
    text: row.text,
    textTruncated: row.text_truncated,
    createdAt: row.created_at,
    source: row.source,
    sourceThreadId: row.source_thread_id,
    channel: parseChannelJson(row.channel_json),
    attachments: row.attachments,
  };
}

function delegationKey(row: {
  source_thread_id: string;
  source_agent_id: string;
  source_tool_call_id: string;
}): DelegationKey {
  return {
    sourceThreadId: row.source_thread_id,
    sourceAgentId: row.source_agent_id,
    sourceToolCallId: row.source_tool_call_id,
  };
}

function keyOf(key: DelegationKey): string {
  return JSON.stringify([key.sourceThreadId, key.sourceAgentId, key.sourceToolCallId]);
}

function targetKey(threadId: string, agentId: string): string {
  return JSON.stringify([threadId, agentId]);
}

function placeholders(length: number): string {
  return Array.from({ length }, () => '?').join(',');
}

export function listThreadCards(
  store: SessionStore,
  ownerId: string,
  input: { sort: ThreadCardSort; limit: number; cursor?: ThreadCardCursor },
): { cards: ThreadCardProjection[]; nextCursor: ThreadCardCursor | null; hasMore: boolean } {
  if (input.cursor && input.cursor.sort !== input.sort) {
    throw new SessionError('invalid_argument', 'The Thread card cursor sort does not match.');
  }
  if (
    input.cursor &&
    (input.cursor.threadSeq <= 0n || input.cursor.threadSeq > BigInt(Number.MAX_SAFE_INTEGER))
  ) {
    throw new SessionError('invalid_argument', 'The Thread card cursor is not valid.');
  }
  const lastMessageAt = `(
    SELECT latest.created_at FROM context_messages AS latest
    WHERE latest.thread_id = threads.thread_id AND latest.agent_id = 'thread'
      AND ${currentMessageWhere('latest')} AND ${displayMessageWhere('latest')}
    ORDER BY latest.seq DESC LIMIT 1
  )`;
  const sortAt =
    input.sort === 'created_at'
      ? 'threads.created_at'
      : `COALESCE(${lastMessageAt}, threads.created_at)`;
  const parameters: Array<string | number> = [ownerId];
  const cursorWhere = input.cursor ? 'WHERE sort_at < ? OR (sort_at = ? AND seq > ?)' : '';
  if (input.cursor) {
    parameters.push(input.cursor.sortAt, input.cursor.sortAt, Number(input.cursor.threadSeq));
  }
  parameters.push(input.limit + 1);
  const rows = z.array(cardRowSchema).parse(
    store.database
      .prepare(
        `SELECT * FROM (
          SELECT threads.*, ${lastMessageAt} AS last_message_at, ${sortAt} AS sort_at
          FROM threads WHERE threads.owner_id = ? AND threads.thread_type = 'task'
            AND threads.automation_only = 0
        ) AS card_rows
        ${cursorWhere}
        ORDER BY sort_at DESC, seq ASC LIMIT ?`,
      )
      .all(...parameters),
  );
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const threadIds = page.map((row) => row.thread_id);
  const messages = listCardMessages(store, threadIds);
  const sources = listCardSources(store, threadIds);
  const last = page.at(-1);
  return {
    cards: page.map((row) => ({
      thread: toThread(row),
      lastMessageAt: row.last_message_at,
      messages: messages.get(row.thread_id) ?? [],
      sourceCall: sources.get(row.thread_id) ?? null,
    })),
    nextCursor:
      hasMore && last
        ? { sort: input.sort, sortAt: last.sort_at, threadSeq: BigInt(last.seq) }
        : null,
    hasMore,
  };
}

function listCardMessages(
  store: SessionStore,
  threadIds: readonly string[],
): ReadonlyMap<string, ThreadMessagePreviewProjection[]> {
  const result = new Map<string, ThreadMessagePreviewProjection[]>();
  if (threadIds.length === 0) return result;
  const rows = z.array(attachmentMessageRowSchema).parse(
    store.database
      .prepare(
        `WITH ranked AS (
          SELECT ${previewColumns('cm')},
            ROW_NUMBER() OVER (PARTITION BY cm.thread_id ORDER BY cm.seq DESC) AS preview_position
          FROM context_messages AS cm
          WHERE cm.thread_id IN (${placeholders(threadIds.length)}) AND cm.agent_id = 'thread'
            AND ${currentMessageWhere('cm')} AND ${displayMessageWhere('cm')}
        )
        SELECT ranked.*, ${attachmentColumns()} FROM ranked
        ${attachmentJoins('ranked')}
        WHERE preview_position <= 3
        ORDER BY thread_id, seq, message_attachment.position`,
      )
      .all(...threadIds),
  );
  for (const row of messageRows(rows)) {
    const messages = result.get(row.thread_id) ?? [];
    messages.push(toMessage(row));
    result.set(row.thread_id, messages);
  }
  return result;
}

function listCardSources(
  store: SessionStore,
  threadIds: readonly string[],
): ReadonlyMap<string, ThreadCallReferenceProjection> {
  const result = new Map<string, ThreadCallReferenceProjection>();
  if (threadIds.length === 0) return result;
  const rows = z.array(sourceRowSchema).parse(
    store.database
      .prepare(
        `WITH first_messages AS (
          SELECT cm.thread_id, cm.seq, cm.source, cm.delegation_source_thread_id,
            cm.delegation_source_agent_id, cm.source_tool_call_id,
            ROW_NUMBER() OVER (PARTITION BY cm.thread_id ORDER BY cm.seq) AS first_position
          FROM context_messages AS cm
          WHERE cm.thread_id IN (${placeholders(threadIds.length)}) AND cm.agent_id = 'thread'
            AND ${currentMessageWhere('cm')}
        )
        SELECT first_messages.thread_id,
          first_messages.delegation_source_thread_id AS source_thread_id,
          first_messages.delegation_source_agent_id AS source_agent_id,
          first_messages.source_tool_call_id,
          source_message.message_id AS source_message_id,
          source_message.seq AS source_message_seq
        FROM first_messages
        JOIN context_tool_calls AS original_call
          ON original_call.thread_id = first_messages.delegation_source_thread_id
         AND original_call.agent_id = first_messages.delegation_source_agent_id
         AND original_call.call_id = first_messages.source_tool_call_id
         AND original_call.tool_name = 'thread_call'
        JOIN context_messages AS source_message
          ON source_message.seq = original_call.assistant_seq
         AND source_message.superseded_by_run_id IS NULL
        WHERE first_messages.first_position = 1 AND first_messages.source = 'thread_call'`,
      )
      .all(...threadIds),
  );
  for (const row of rows) {
    result.set(row.thread_id, {
      delegation: delegationKey(row),
      sourceMessageId: row.source_message_id,
      sourceMessageSeq: row.source_message_seq,
    });
  }
  return result;
}

export function listThreadCallPreviews(
  store: SessionStore,
  ownerId: string,
  calls: readonly DelegationKey[],
): ThreadCallPreviewProjection[] {
  if (calls.length > threadCallPreviewBatchLimit) {
    throw new SessionError(
      'invalid_argument',
      `A call preview request can contain at most ${threadCallPreviewBatchLimit} calls.`,
    );
  }
  if (calls.length === 0) return [];
  const conditions = calls.map(
    () =>
      '(interactions.source_thread_id = ? AND interactions.source_agent_id = ? AND interactions.source_tool_call_id = ?)',
  );
  const parameters: string[] = [ownerId];
  for (const call of calls) {
    parameters.push(call.sourceThreadId, call.sourceAgentId, call.sourceToolCallId);
  }
  const rows = z.array(callRowSchema).parse(
    store.database
      .prepare(
        `SELECT interactions.source_thread_id, interactions.source_agent_id,
          interactions.source_tool_call_id, source_message.message_id AS source_message_id,
          source_message.seq AS source_message_seq, interactions.target_thread_id,
          interactions.target_agent_id, target.title AS target_title,
          interactions.target_input_id, interactions.status, interactions.response_message_seq
        FROM interactions
        JOIN threads AS target
          ON target.thread_id = interactions.target_thread_id
         AND target.owner_id = interactions.owner_id
        JOIN context_tool_calls AS original_call
          ON original_call.thread_id = interactions.source_thread_id
         AND original_call.agent_id = interactions.source_agent_id
         AND original_call.call_id = interactions.source_tool_call_id
         AND original_call.tool_name = 'thread_call'
        JOIN context_messages AS source_message
          ON source_message.seq = original_call.assistant_seq
         AND source_message.superseded_by_run_id IS NULL
        WHERE interactions.owner_id = ? AND interactions.kind = 'thread_call'
          AND (${conditions.join(' OR ')})`,
      )
      .all(...parameters),
  );
  const interactions = new Map(rows.map((row) => [keyOf(delegationKey(row)), row]));
  const targetIds = [...new Set(rows.map((row) => row.target_thread_id))];
  const relations = listTargetRelations(store, ownerId, targetIds);
  const candidates = listCallMessages(store, rows, relations);
  return calls.flatMap((key) => {
    const interaction = interactions.get(keyOf(key));
    if (!interaction) return [];
    return [projectCall(interaction, relations, candidates.get(keyOf(key)) ?? [])];
  });
}

interface TargetRelation {
  key: string;
  targetKey: string;
  targetInputId: string | null;
  promptSeq: number | null;
  responseMessageSeq: number | null;
}

function listTargetRelations(
  store: SessionStore,
  ownerId: string,
  targetIds: readonly string[],
): readonly TargetRelation[] {
  if (targetIds.length === 0) return [];
  return z
    .array(targetRelationRowSchema)
    .parse(
      store.database
        .prepare(
          `SELECT interactions.source_thread_id, interactions.source_agent_id,
          interactions.source_tool_call_id, interactions.target_thread_id,
          interactions.target_agent_id, interactions.target_input_id,
          prompt.seq AS prompt_seq, interactions.response_message_seq
        FROM interactions
        LEFT JOIN context_messages AS prompt
          ON prompt.thread_id = interactions.target_thread_id
         AND prompt.agent_id = interactions.target_agent_id
         AND prompt.source_input_id = interactions.target_input_id
         AND prompt.source = 'thread_call'
         AND prompt.superseded_by_run_id IS NULL
        WHERE interactions.owner_id = ? AND interactions.kind = 'thread_call'
          AND interactions.target_thread_id IN (${placeholders(targetIds.length)})`,
        )
        .all(ownerId, ...targetIds),
    )
    .map((row) => ({
      key: keyOf(delegationKey(row)),
      targetKey: targetKey(row.target_thread_id, row.target_agent_id),
      targetInputId: row.target_input_id,
      promptSeq: row.prompt_seq,
      responseMessageSeq: row.response_message_seq,
    }));
}

function listCallMessages(
  store: SessionStore,
  calls: readonly CallRow[],
  relations: readonly TargetRelation[],
): ReadonlyMap<string, MessageRow[]> {
  const relationMap = new Map(relations.map((relation) => [relation.key, relation]));
  const prompts = new Map<string, number[]>();
  const responseSeqs = new Map<string, Set<number>>();
  for (const relation of relations) {
    if (relation.promptSeq !== null) {
      const values = prompts.get(relation.targetKey) ?? [];
      values.push(relation.promptSeq);
      prompts.set(relation.targetKey, values);
    }
    if (relation.responseMessageSeq !== null) {
      const values = responseSeqs.get(relation.targetKey) ?? new Set<number>();
      values.add(relation.responseMessageSeq);
      responseSeqs.set(relation.targetKey, values);
    }
  }
  for (const values of prompts.values()) values.sort((left, right) => left - right);

  const ranges: string[] = [];
  const parameters: Array<string | number> = [];
  for (const call of calls) {
    const relation = relationMap.get(keyOf(delegationKey(call)));
    if (!relation || relation.promptSeq === null) continue;
    const nextPrompt = (prompts.get(relation.targetKey) ?? []).find(
      (seq) => seq > (relation.promptSeq ?? 0),
    );
    ranges.push(
      `(cm.thread_id = ? AND cm.agent_id = ? AND cm.seq > ?${nextPrompt === undefined ? '' : ' AND cm.seq < ?'})`,
    );
    parameters.push(call.target_thread_id, call.target_agent_id, relation.promptSeq);
    if (nextPrompt !== undefined) parameters.push(nextPrompt);
    if (call.response_message_seq !== null) {
      ranges.push('(cm.thread_id = ? AND cm.agent_id = ? AND cm.seq = ?)');
      parameters.push(call.target_thread_id, call.target_agent_id, call.response_message_seq);
    }
  }
  const result = new Map<string, MessageRow[]>();
  if (ranges.length === 0) return result;
  const rows = messageRows(
    z.array(attachmentMessageRowSchema).parse(
      store.database
        .prepare(
          `SELECT ${previewColumns('cm')}, ${attachmentColumns()} FROM context_messages AS cm
          ${attachmentJoins('cm')}
          WHERE (${ranges.join(' OR ')})
            AND ${currentMessageWhere('cm')} AND ${displayMessageWhere('cm')}
          ORDER BY cm.seq, message_attachment.position`,
        )
        .all(...parameters),
    ),
  );
  for (const call of calls) {
    const key = keyOf(delegationKey(call));
    const relation = relationMap.get(key);
    if (!relation || relation.promptSeq === null) continue;
    const target = targetKey(call.target_thread_id, call.target_agent_id);
    const nextPrompt = (prompts.get(target) ?? []).find((seq) => seq > (relation.promptSeq ?? 0));
    const registeredResponses = responseSeqs.get(target) ?? new Set<number>();
    const messages = new Map<number, MessageRow>();
    for (const row of rows) {
      if (row.thread_id !== call.target_thread_id || row.agent_id !== call.target_agent_id)
        continue;
      const inInterval =
        row.seq > relation.promptSeq && (nextPrompt === undefined || row.seq < nextPrompt);
      const isExactResponse = row.seq === call.response_message_seq;
      if (
        (inInterval && (!registeredResponses.has(row.seq) || isExactResponse)) ||
        isExactResponse
      ) {
        messages.set(row.seq, row);
      }
    }
    result.set(key, [...messages.values()]);
  }
  return result;
}

function projectCall(
  call: CallRow,
  relations: readonly TargetRelation[],
  messages: readonly MessageRow[],
): ThreadCallPreviewProjection {
  const key = keyOf(delegationKey(call));
  const relation = relations.find((item) => item.key === key);
  const hasBoundary = relation?.promptSeq !== null && relation?.promptSeq !== undefined;
  const ordered = hasBoundary ? [...messages].sort((left, right) => left.seq - right.seq) : [];
  const hasResponse =
    hasBoundary &&
    call.response_message_seq !== null &&
    ordered.some((message) => message.seq === call.response_message_seq);
  return {
    call: {
      delegation: delegationKey(call),
      sourceMessageId: call.source_message_id,
      sourceMessageSeq: call.source_message_seq,
    },
    targetThreadId: call.target_thread_id,
    targetTitle: call.target_title,
    status: call.status,
    replyCount: ordered.length,
    replies: ordered.slice(-3).map(toMessage),
    responseMessageSeq: hasResponse ? call.response_message_seq : null,
  };
}

export function listSubagentCallViews(
  store: SessionStore,
  ownerId: string,
  calls: readonly DelegationKey[],
) {
  if (calls.length > threadCallPreviewBatchLimit)
    throw new SessionError('invalid_argument', 'Too many Subagent calls.');
  return calls.flatMap((key) => {
    store.getThread(ownerId, key.sourceThreadId);
    const source = store.context
      .query({ threadId: key.sourceThreadId, agentId: key.sourceAgentId, currentOnly: true })
      .find(
        (message) =>
          message.message.role === 'assistant' &&
          message.message.tool_calls?.some(
            (call) => call.id === key.sourceToolCallId && call.name === 'subagent',
          ),
      );
    if (!source) return [];
    let interaction: InteractionRecord;
    try {
      interaction = store.getInteraction(ownerId, key);
    } catch (cause) {
      if (cause instanceof SessionError && cause.code === 'not_found') return [];
      throw cause;
    }
    if (interaction.kind !== 'subagent') return [];
    return [
      {
        call: { delegation: key, sourceMessageId: source.messageId, sourceMessageSeq: source.seq },
        threadId: interaction.targetThreadId,
        agentId: interaction.targetAgentId,
        runId: interaction.acceptedRunId,
        task: interaction.prompt,
        status: interaction.status,
        executionMode: interaction.executionMode,
      },
    ];
  });
}
