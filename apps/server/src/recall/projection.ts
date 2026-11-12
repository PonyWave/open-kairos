import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { z } from 'zod';
import { jsonStringByteLength } from './byte-length.js';
import {
  DEFAULT_SQL_RECALL_LIMITS,
  type RecallAuthorization,
  RecallError,
  type RecallScope,
  type RecallSnapshot,
  type RecallSnapshotValue,
  ROOT_AGENT_ID,
} from './types.js';

const scopeRowSchema = z.object({ thread_id: z.string(), agent_id: z.string() });
const threadIdentitySchema = z.object({
  owner_id: z.string(),
  workspace_id: z.string().nullable(),
});
const threadIdRowSchema = z.object({ thread_id: z.string() });
const contextRowSchema = z.object({
  seq: z.bigint().positive(),
  thread_id: z.string(),
  agent_id: z.string(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  created_at: z.string(),
  tool_calls_json: z.string().nullable(),
  tool_result_json: z.string().nullable(),
  source_json: z.string().nullable(),
  attachments_json: z.string().nullable(),
});
const recapRowSchema = z.object({
  recap_id: z.string(),
  thread_id: z.string(),
  agent_id: z.string(),
  content: z.string(),
  source_message_seqs: z.string(),
  source_created_at_start: z.string(),
  source_created_at_end: z.string(),
  created_at: z.string(),
  source_last_seq: z.bigint().positive(),
});
const threadRowSchema = z.object({
  thread_id: z.string(),
  thread_type: z.enum(['main', 'workspace_main', 'task']),
  workspace_id: z.string().nullable(),
  title: z.string(),
  created_at: z.string(),
});

type ContextRow = z.infer<typeof contextRowSchema>;
type RecapRow = z.infer<typeof recapRowSchema>;

const MAX_AUTHORIZATION_RUNS = 10_000;
const MAX_AUTHORIZATION_SCOPES = 10_000;

export function projectRecallSnapshot(
  database: DatabaseSync,
  authorization: RecallAuthorization,
  maxSnapshotBytes = DEFAULT_SQL_RECALL_LIMITS.maxSnapshotBytes,
): RecallSnapshot {
  const project = () => {
    const budget = { usedBytes: 0, maxBytes: maxSnapshotBytes };
    const scopes = authorizedScopes(database, authorization);
    const contextRows: ContextRow[] = [];
    const context: RecallSnapshotValue[][] = [];
    const recapWithSources: Array<{ row: RecapRow; sourceLastSeq: bigint }> = [];
    const recap: RecallSnapshotValue[][] = [];
    for (const scope of scopes) {
      for (const row of projectContext(database, scope)) {
        const values = accountSnapshotRow(budget, contextValues(row));
        contextRows.push(row);
        context.push(values);
      }
      for (const source of projectRecaps(database, scope)) {
        const values = accountSnapshotRow(budget, recapValues(source.row));
        recapWithSources.push(source);
        recap.push(values);
      }
    }
    const thread = projectThreads(database, scopes, contextRows, recapWithSources).map((row) =>
      accountSnapshotRow(budget, row),
    );
    return { thread, context, recap };
  };
  return database.isTransaction ? project() : inReadTransaction(database, project);
}

function authorizedScopes(
  database: DatabaseSync,
  authorization: RecallAuthorization,
): RecallScope[] {
  if (authorization.visibility !== 'self') {
    const elevated = elevatedScopes(database, authorization);
    if (elevated !== undefined) return elevated;
  }
  const allowedAgentIds = new Set([authorization.scope.agentId]);
  if (authorization.includeDescendants) {
    for (const agentId of descendantAgentIds(database, authorization)) allowedAgentIds.add(agentId);
  }
  const authorized = new Map<string, RecallScope>();
  const addScope = (value: unknown) => {
    const row = scopeRowSchema.parse(value);
    const scope = { threadId: row.thread_id, agentId: row.agent_id };
    if (scope.threadId !== authorization.scope.threadId || !allowedAgentIds.has(scope.agentId)) {
      return;
    }
    const key = scopeKey(scope);
    if (!authorized.has(key)) authorized.set(key, scope);
  };
  for (const row of database
    .prepare("SELECT thread_id, 'thread' AS agent_id FROM threads WHERE thread_id = ? ORDER BY seq")
    .iterate(authorization.scope.threadId)) {
    addScope(row);
  }
  for (const table of ['context_messages', 'recaps']) {
    for (const row of database
      .prepare(
        `SELECT DISTINCT thread_id, agent_id
         FROM ${table} WHERE thread_id = ? ORDER BY agent_id`,
      )
      .iterate(authorization.scope.threadId)) {
      addScope(row);
    }
  }
  return [...authorized.values()];
}

function elevatedScopes(
  database: DatabaseSync,
  authorization: RecallAuthorization,
): RecallScope[] | undefined {
  const identity = threadIdentitySchema
    .optional()
    .parse(
      database
        .prepare('SELECT owner_id, workspace_id FROM threads WHERE thread_id = ?')
        .get(authorization.scope.threadId),
    );
  if (!identity) return undefined;
  const threadIds: string[] = [];
  const threadStatement =
    authorization.visibility === 'owner'
      ? database.prepare('SELECT thread_id FROM threads WHERE owner_id = ? ORDER BY seq')
      : database.prepare(
          `SELECT thread_id FROM threads
           WHERE owner_id = ? AND (workspace_id = ? OR thread_id = ?) ORDER BY seq`,
        );
  const threadParameters =
    authorization.visibility === 'owner'
      ? [identity.owner_id]
      : [identity.owner_id, identity.workspace_id, authorization.scope.threadId];
  for (const value of threadStatement.iterate(...threadParameters)) {
    threadIds.push(threadIdRowSchema.parse(value).thread_id);
  }
  const authorized = new Map<string, RecallScope>();
  const addScope = (value: unknown) => {
    const row = scopeRowSchema.parse(value);
    const scope = { threadId: row.thread_id, agentId: row.agent_id };
    const key = scopeKey(scope);
    if (authorized.has(key)) return;
    if (authorized.size >= MAX_AUTHORIZATION_SCOPES) {
      throw new RecallError(
        'authorization_limit',
        `SQL recall authorization exceeded the ${MAX_AUTHORIZATION_SCOPES} scope limit.`,
      );
    }
    authorized.set(key, scope);
  };
  for (const threadId of threadIds) {
    addScope({ thread_id: threadId, agent_id: ROOT_AGENT_ID });
    for (const table of ['context_messages', 'recaps']) {
      for (const row of database
        .prepare(
          `SELECT DISTINCT thread_id, agent_id
           FROM ${table} WHERE thread_id = ? ORDER BY agent_id`,
        )
        .iterate(threadId)) {
        addScope(row);
      }
    }
  }
  return [...authorized.values()];
}

function descendantAgentIds(
  database: DatabaseSync,
  authorization: RecallAuthorization,
): Set<string> {
  const agentIds = new Set<string>();
  const statement = database.prepare(
    `WITH RECURSIVE descendants(run_id, agent_id) AS (
       SELECT run_id, agent_id FROM runs
       WHERE run_id = ? AND thread_id = ? AND agent_id = ?
       UNION
       SELECT child.run_id, child.agent_id FROM runs AS child
       JOIN descendants AS parent ON child.parent_run_id = parent.run_id
       WHERE child.thread_id = ?
     )
     SELECT agent_id FROM descendants LIMIT ?`,
  );
  let count = 0;
  for (const value of statement.iterate(
    authorization.currentRunId,
    authorization.scope.threadId,
    authorization.scope.agentId,
    authorization.scope.threadId,
    MAX_AUTHORIZATION_RUNS + 1,
  )) {
    count += 1;
    if (count > MAX_AUTHORIZATION_RUNS) {
      throw new RecallError(
        'authorization_limit',
        `SQL recall authorization exceeded the ${MAX_AUTHORIZATION_RUNS} Run limit.`,
      );
    }
    const row = z.object({ agent_id: z.string().min(1) }).parse(value);
    agentIds.add(row.agent_id);
  }
  return agentIds;
}

function* projectContext(database: DatabaseSync, scope: RecallScope): Generator<ContextRow> {
  const where = scopeCondition(scope, 'message');
  const toolCalls = `CASE
         WHEN message.tool_calls_json IS NULL AND message.incomplete_tool_calls_json IS NULL
           THEN NULL
         ELSE (
           SELECT json_group_array(json(item.value))
           FROM (
             SELECT 0 AS source_order, complete.key AS item_order, complete.value AS value
             FROM json_each(message.tool_calls_json) AS complete
             UNION ALL
             SELECT 1, incomplete.key, incomplete.value
             FROM json_each(message.incomplete_tool_calls_json) AS incomplete
             ORDER BY source_order, item_order
           ) AS item
         )
       END`;
  const statement = readBigInts(
    database.prepare(
      `SELECT
         message.seq,
         message.thread_id,
         message.agent_id,
         message.role,
         COALESCE((
           SELECT revision.content FROM context_message_revisions AS revision
           WHERE revision.message_seq = message.seq
           ORDER BY revision.revision_number DESC LIMIT 1
         ), message.content) AS content,
         message.created_at,
         ${toolCalls} AS tool_calls_json,
         CASE WHEN message.role = 'tool' THEN json_patch(
           json_patch(
             json_object('tool_call_id', message.tool_call_id),
             CASE WHEN message.tool_status IS NULL THEN '{}'
               ELSE json_object('status', message.tool_status) END
           ),
           CASE WHEN message.tool_error_json IS NULL THEN '{}'
             ELSE json_object('error', json(message.tool_error_json)) END
         ) ELSE NULL END AS tool_result_json,
         CASE WHEN message.source IS NULL THEN NULL ELSE json_patch(
           json_patch(
             json_object('type', message.source),
             CASE WHEN message.source_thread_id IS NULL THEN '{}'
               ELSE json_object('thread_id', message.source_thread_id) END
           ),
           CASE WHEN message.source_agent_id IS NULL THEN '{}'
             ELSE json_object('agent_id', message.source_agent_id) END
         ) END AS source_json,
         CASE WHEN NOT EXISTS (
           SELECT 1 FROM context_message_attachments AS link
           WHERE link.message_seq = message.seq
         ) THEN NULL ELSE (
           SELECT json_group_array(json(item.value)) FROM (
             SELECT json_object(
               'attachment_id', attachment.attachment_id,
               'file_name', attachment.file_name,
               'media_type', attachment.media_type,
               'source', link.source,
               'workspace_required', link.workspace_required,
               'workspace_status', link.workspace_status,
               'path', link.path
             ) AS value
             FROM context_message_attachments AS link
             JOIN attachments AS attachment ON attachment.attachment_id = link.attachment_id
             WHERE link.message_seq = message.seq
             ORDER BY link.position
           ) AS item
         ) END AS attachments_json
       FROM context_messages AS message
       WHERE ${where.sql} AND NOT (${invalidCurrentCondition('message')})
       ORDER BY message.seq`,
    ),
  );
  for (const value of statement.iterate(...where.parameters)) {
    yield contextRowSchema.parse(value);
  }
}

function* projectRecaps(
  database: DatabaseSync,
  scope: RecallScope,
): Generator<{ row: RecapRow; sourceLastSeq: bigint }> {
  const where = scopeCondition(scope, 'recap');
  const statement = readBigInts(
    database.prepare(
      `SELECT
         recap.recap_id,
         recap.thread_id,
         recap.agent_id,
         recap.content,
         (
           SELECT json_group_array(source.message_seq)
           FROM (
             SELECT message_seq FROM recap_sources
             WHERE recap_id = recap.recap_id ORDER BY position
           ) AS source
         ) AS source_message_seqs,
         (
           SELECT MIN(message.created_at) FROM recap_sources AS source
           JOIN context_messages AS message ON message.seq = source.message_seq
           WHERE source.recap_id = recap.recap_id
         ) AS source_created_at_start,
         (
           SELECT MAX(message.created_at) FROM recap_sources AS source
           JOIN context_messages AS message ON message.seq = source.message_seq
           WHERE source.recap_id = recap.recap_id
         ) AS source_created_at_end,
         recap.created_at,
         (
           SELECT message_seq FROM recap_sources
           WHERE recap_id = recap.recap_id ORDER BY position DESC LIMIT 1
         ) AS source_last_seq
       FROM recaps AS recap
       WHERE ${where.sql} AND recap.validity = 'valid'
         AND EXISTS (SELECT 1 FROM recap_sources WHERE recap_id = recap.recap_id)
         AND NOT EXISTS (
           SELECT 1 FROM recap_sources AS source
           LEFT JOIN context_messages AS message
             ON message.seq = source.message_seq
            AND message.thread_id = recap.thread_id
            AND message.agent_id = recap.agent_id
           WHERE source.recap_id = recap.recap_id
             AND (message.seq IS NULL OR ${invalidCurrentCondition('message')})
         )
       ORDER BY recap.created_at, recap.source_seq_end, recap.recap_id`,
    ),
  );
  for (const value of statement.iterate(...where.parameters)) {
    const row = recapRowSchema.parse(value);
    yield { row, sourceLastSeq: row.source_last_seq };
  }
}

function projectThreads(
  database: DatabaseSync,
  scopes: readonly RecallScope[],
  context: readonly ContextRow[],
  recaps: readonly { row: RecapRow; sourceLastSeq: bigint }[],
): RecallSnapshotValue[][] {
  const rows: RecallSnapshotValue[][] = [];
  for (const scope of scopes) {
    if (scope.agentId !== ROOT_AGENT_ID) continue;
    const record = threadRowSchema
      .optional()
      .parse(
        database
          .prepare(
            'SELECT thread_id, thread_type, workspace_id, title, created_at FROM threads WHERE thread_id = ?',
          )
          .get(scope.threadId),
      );
    if (!record) continue;
    const rootKey = scopeKey(scope);
    const lastMessageAt = context
      .filter((row) => scopeKey(row) === rootKey)
      .reduce<string | null>(
        (latest, row) => (latest === null || row.created_at > latest ? row.created_at : latest),
        null,
      );
    const latestRecap = recaps
      .filter(({ row }) => scopeKey(row) === rootKey)
      .sort(compareLatestRecap)[0];
    rows.push([
      record.thread_id,
      record.thread_type,
      record.workspace_id,
      record.title,
      latestRecap?.row.content ?? null,
      record.created_at,
      lastMessageAt,
    ]);
  }
  return rows;
}

function compareLatestRecap(
  left: { row: RecapRow; sourceLastSeq: bigint },
  right: { row: RecapRow; sourceLastSeq: bigint },
): number {
  if (left.row.created_at !== right.row.created_at) {
    return right.row.created_at.localeCompare(left.row.created_at);
  }
  if (left.sourceLastSeq !== right.sourceLastSeq) {
    return left.sourceLastSeq > right.sourceLastSeq ? -1 : 1;
  }
  return right.row.recap_id.localeCompare(left.row.recap_id);
}

function invalidCurrentCondition(alias: string): string {
  return `(${alias}.superseded_by_run_id IS NOT NULL OR (
    ${alias}.source IN ('thread_response', 'subagent_response', 'thread_notification')
    AND ${alias}.source_tool_call_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM context_tool_calls AS source_call
      JOIN context_messages AS source_message
        ON source_message.seq = source_call.assistant_seq
      WHERE source_call.thread_id = ${alias}.delegation_source_thread_id
        AND source_call.agent_id = ${alias}.delegation_source_agent_id
        AND source_call.call_id = ${alias}.source_tool_call_id
        AND source_message.superseded_by_run_id IS NOT NULL
    )
  ))`;
}

function scopeCondition(scope: RecallScope, alias: string): { sql: string; parameters: string[] } {
  return {
    sql: `${alias}.thread_id = ? AND ${alias}.agent_id = ?`,
    parameters: [scope.threadId, scope.agentId],
  };
}

function contextValues(row: ContextRow): RecallSnapshotValue[] {
  return [
    row.seq,
    row.thread_id,
    row.agent_id,
    row.role,
    row.content,
    row.created_at,
    row.tool_calls_json,
    row.tool_result_json,
    row.source_json,
    row.attachments_json,
  ];
}

function recapValues(row: RecapRow): RecallSnapshotValue[] {
  return [
    row.recap_id,
    row.thread_id,
    row.agent_id,
    row.content,
    row.source_message_seqs,
    row.source_created_at_start,
    row.source_created_at_end,
    row.created_at,
  ];
}

function snapshotRowByteLength(row: readonly RecallSnapshotValue[]): number {
  let bytes = 2;
  for (const [index, value] of row.entries()) {
    if (index > 0) bytes += 1;
    if (typeof value === 'string') bytes += jsonStringByteLength(value);
    else if (typeof value === 'bigint') bytes += jsonStringByteLength(value.toString());
    else if (typeof value === 'number') bytes += Buffer.byteLength(String(value), 'utf8');
    else bytes += 4;
  }
  return bytes;
}

function accountSnapshotRow<T extends RecallSnapshotValue[]>(
  budget: { usedBytes: number; maxBytes: number },
  row: T,
): T {
  budget.usedBytes += snapshotRowByteLength(row);
  if (budget.usedBytes > budget.maxBytes) {
    throw new RecallError(
      'snapshot_limit',
      `SQL recall authorized snapshot exceeded the ${budget.maxBytes} byte limit.`,
    );
  }
  return row;
}

function inReadTransaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'SQLite work and rollback both failed.');
      }
    }
    throw error;
  }
}

function scopeKey(scope: {
  threadId?: string;
  agentId?: string;
  thread_id?: string;
  agent_id?: string;
}): string {
  return `${scope.threadId ?? scope.thread_id}\0${scope.agentId ?? scope.agent_id}`;
}

function readBigInts(statement: StatementSync): StatementSync {
  statement.setReadBigInts(true);
  return statement;
}
