import { DatabaseSync } from 'node:sqlite';
import { projectRecallSnapshot } from './projection.js';
import { installRecallAuthorizer } from './sql-policy.js';
import {
  DEFAULT_SQL_RECALL_LIMITS,
  RecallError,
  type RecallSnapshot,
  type RecallWorkerInput,
  type RecallWorkerResponse,
  recallWorkerInputSchema,
  type SqlRecallCellTruncation,
  type SqlRecallResult,
  type SqlRecallTruncation,
  type SqlRecallValue,
} from './types.js';

if (!process.send) throw new Error('The SQL recall executor requires an IPC channel.');
const onMessage = (message: unknown) => {
  if (isNodeWatchControlMessage(message)) return;
  process.off('message', onMessage);
  let response: RecallWorkerResponse;
  let maxIpcBytes = DEFAULT_SQL_RECALL_LIMITS.maxIpcBytes;
  try {
    const input = recallWorkerInputSchema.parse(message);
    maxIpcBytes = input.limits.maxIpcBytes;
    response = { ok: true, result: executeRecall(input) };
  } catch (error) {
    response = { ok: false, error: processError(error) };
  }
  const boundedResponse =
    messageBytes(response) <= maxIpcBytes
      ? response
      : {
          ok: false as const,
          error: {
            code: 'ipc_limit' as const,
            message: `SQL recall exceeded the ${maxIpcBytes} byte IPC limit.`,
          },
        };
  process.send?.(boundedResponse, (error) => {
    if (error) {
      process.exitCode = 1;
      process.disconnect?.();
    }
  });
};
process.on('message', onMessage);

function isNodeWatchControlMessage(message: unknown): boolean {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return false;
  const entries: [string, unknown][] = Object.entries(message);
  if (entries.length !== 1) return false;
  const [key, value] = entries[0] ?? [];
  return (key === 'watch:import' || key === 'watch:require') && Array.isArray(value);
}

function executeRecall(input: RecallWorkerInput): SqlRecallResult {
  const snapshot = projectSourceSnapshot(input);
  const database = new DatabaseSync(':memory:', {
    allowExtension: false,
    defensive: true,
    limits: { length: input.limits.maxSqliteValueBytes, sqlLength: input.limits.maxIpcBytes },
  });
  try {
    database.exec(`PRAGMA hard_heap_limit = ${input.limits.maxSqliteMemoryBytes}`);
    try {
      populateSnapshot(database, snapshot);
    } catch (error) {
      const resourceError = sqliteResourceError(error, input);
      if (resourceError) throw resourceError;
      throw new RecallError(
        'query_failed',
        'SQL recall could not initialize the authorized snapshot.',
        { cause: error },
      );
    }
    database.exec('PRAGMA query_only = ON');
    const wasDenied = installRecallAuthorizer(database);
    try {
      const statement = database.prepare(input.sql);
      statement.setReadBigInts(true);
      statement.setReturnArrays(true);
      const columns = statement.columns().map((column) => column.name);
      return readRows(statement.iterate(), columns, input);
    } catch (error) {
      if (wasDenied()) {
        throw new RecallError(
          'permission_denied',
          'The SQL operation, function, table or column is not permitted.',
          { cause: error },
        );
      }
      const resourceError = sqliteResourceError(error, input);
      if (resourceError) throw resourceError;
      throw error;
    }
  } finally {
    database.close();
  }
}

function projectSourceSnapshot(input: RecallWorkerInput): RecallSnapshot {
  let source: DatabaseSync;
  try {
    source = new DatabaseSync(input.databasePath, {
      readOnly: true,
      allowExtension: false,
      defensive: true,
      timeout: input.limits.timeoutMs,
    });
  } catch (error) {
    throw new RecallError('query_failed', 'SQL recall could not open the authorized source.', {
      cause: error,
    });
  }
  try {
    source.exec(`PRAGMA hard_heap_limit = ${input.limits.maxSqliteMemoryBytes}`);
    return projectRecallSnapshot(source, input.authorization, input.limits.maxSnapshotBytes);
  } catch (error) {
    if (error instanceof RecallError) throw error;
    const resourceError = sqliteResourceError(error, input);
    if (resourceError) throw resourceError;
    throw new RecallError('query_failed', 'SQL recall could not prepare the authorized snapshot.', {
      cause: error,
    });
  } finally {
    source.close();
  }
}

function populateSnapshot(database: DatabaseSync, snapshot: RecallSnapshot): void {
  database.exec(`
    CREATE TABLE thread (
      thread_id TEXT PRIMARY KEY,
      thread_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      created_at TEXT NOT NULL,
      last_message_at TEXT
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE context (
      seq INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      tool_calls_json TEXT,
      tool_result_json TEXT,
      source_json TEXT,
      attachments_json TEXT
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE recap (
      recap_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source_message_seqs TEXT NOT NULL,
      source_created_at_start TEXT NOT NULL,
      source_created_at_end TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT, WITHOUT ROWID;
  `);
  database.exec('BEGIN');
  try {
    insertRows(database, 'thread', 6, snapshot.thread);
    insertRows(database, 'context', 10, snapshot.context);
    insertRows(database, 'recap', 8, snapshot.recap);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function insertRows(
  database: DatabaseSync,
  table: string,
  columnCount: number,
  rows: readonly (readonly (string | number | bigint | null)[])[],
): void {
  const placeholders = rows[0]?.map(() => '?').join(',') ?? Array(columnCount).fill('?').join(',');
  const statement = database.prepare(`INSERT INTO ${table} VALUES (${placeholders})`);
  for (const row of rows) statement.run(...row);
}

function readRows(
  iterator: IterableIterator<unknown>,
  columns: string[],
  input: RecallWorkerInput,
): SqlRecallResult {
  const rows: SqlRecallValue[][] = [];
  for (const item of iterator) {
    if (!Array.isArray(item)) throw new Error('SQLite returned an invalid row.');
    const cellTruncations: SqlRecallCellTruncation[] = [];
    const row = item.map((value, columnIndex) =>
      resultValue(value, rows.length, columnIndex, columns, input, cellTruncations),
    );
    const candidate: SqlRecallResult = {
      columns,
      rows: [...rows, row],
      ...(cellTruncations.length > 0
        ? {
            truncated: true,
            truncation: { reasons: ['cell_limit'], cells: cellTruncations },
          }
        : { truncated: false }),
    };
    if (responseBytes(candidate) > input.limits.maxResponseBytes) {
      return fitResponse(columns, rows, ['response_limit'], input.limits.maxResponseBytes);
    }
    rows.push(row);
    if (cellTruncations.length > 0) return candidate;
    if (rows.length === input.limits.maxRows) {
      const next = iterator.next();
      if (next.done === true) return completeResponse(columns, rows, input.limits.maxResponseBytes);
      return fitResponse(columns, rows, ['row_limit'], input.limits.maxResponseBytes);
    }
  }
  return completeResponse(columns, rows, input.limits.maxResponseBytes);
}

function completeResponse(
  columns: string[],
  rows: SqlRecallValue[][],
  maxResponseBytes: number,
): SqlRecallResult {
  const result: SqlRecallResult = { columns, rows, truncated: false };
  return responseBytes(result) <= maxResponseBytes
    ? result
    : fitResponse(columns, rows, ['response_limit'], maxResponseBytes);
}

function resultValue(
  value: unknown,
  rowIndex: number,
  columnIndex: number,
  columns: string[],
  input: RecallWorkerInput,
  truncations: SqlRecallCellTruncation[],
): SqlRecallValue {
  if (value === null) return null;
  if (typeof value === 'string') {
    const characters = [...value];
    if (characters.length <= input.limits.maxCellCharacters) return value;
    truncations.push({
      row_index: rowIndex,
      column_index: columnIndex,
      column: columns[columnIndex] ?? '',
      original_length: characters.length,
      next_read_position: input.limits.maxCellCharacters + 1,
    });
    return characters.slice(0, input.limits.maxCellCharacters).join('');
  }
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString(10);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RecallError('invalid_query', 'Non-finite REAL values are not supported.');
    }
    return value;
  }
  throw new RecallError(
    'invalid_query',
    'BLOB result values are not supported; use hex() to return text.',
  );
}

type TruncationReason = SqlRecallTruncation['reasons'][number];

function fitResponse(
  columns: string[],
  rows: SqlRecallValue[][],
  reasons: [TruncationReason, ...TruncationReason[]],
  maxResponseBytes: number,
): SqlRecallResult {
  const fitted = [...rows];
  let result: SqlRecallResult = {
    columns,
    rows: fitted,
    truncated: true,
    truncation: { reasons },
  };
  while (responseBytes(result) > maxResponseBytes && fitted.length > 0) {
    fitted.pop();
    const fittedReasons: TruncationReason[] = [
      ...new Set<TruncationReason>([...reasons, 'response_limit']),
    ];
    result = {
      columns,
      rows: fitted,
      truncated: true,
      truncation: { reasons: fittedReasons },
    };
  }
  if (responseBytes(result) > maxResponseBytes) {
    throw new RecallError(
      'response_limit',
      'The response limit is too small for the selected columns and truncation metadata.',
    );
  }
  return result;
}

function responseBytes(result: SqlRecallResult): number {
  return messageBytes(result);
}

function messageBytes(message: unknown): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

function sqliteResourceError(error: unknown, input: RecallWorkerInput): RecallError | undefined {
  if (!(error instanceof Error) || !('errcode' in error)) return undefined;
  if (error.errcode === 7) {
    return new RecallError(
      'sqlite_memory_limit',
      `SQL recall exceeded the ${input.limits.maxSqliteMemoryBytes} byte SQLite native memory limit.`,
      { cause: error },
    );
  }
  if (error.errcode === 18) {
    return new RecallError(
      'sqlite_value_limit',
      `SQL recall exceeded the ${input.limits.maxSqliteValueBytes} byte SQLite value length limit.`,
      { cause: error },
    );
  }
  return undefined;
}

function processError(error: unknown): Extract<RecallWorkerResponse, { ok: false }>['error'] {
  if (error instanceof RecallError) {
    const code =
      error.code === 'cancelled' || error.code === 'timeout' ? 'query_failed' : error.code;
    return { code, message: error.message };
  }
  if (error instanceof Error) {
    if (error.message.startsWith('no such table:')) {
      return {
        code: 'permission_denied',
        message: 'The SQL operation, function, table or column is not permitted.',
      };
    }
    return { code: 'invalid_query', message: `SQLite rejected the query: ${error.message}` };
  }
  return { code: 'query_failed', message: 'SQL recall failed without a database error.' };
}
