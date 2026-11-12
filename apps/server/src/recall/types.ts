import { z } from 'zod';

export const ROOT_AGENT_ID = 'thread';

export const RECALL_TABLE_COLUMNS = {
  thread: [
    'thread_id',
    'thread_type',
    'workspace_id',
    'title',
    'summary',
    'created_at',
    'last_message_at',
  ],
  context: [
    'seq',
    'thread_id',
    'agent_id',
    'role',
    'content',
    'created_at',
    'tool_calls_json',
    'tool_result_json',
    'source_json',
    'attachments_json',
  ],
  recap: [
    'recap_id',
    'thread_id',
    'agent_id',
    'content',
    'source_message_seqs',
    'source_created_at_start',
    'source_created_at_end',
    'created_at',
  ],
} as const;

export type RecallTableName = keyof typeof RECALL_TABLE_COLUMNS;

export const recallScopeSchema = z
  .object({
    threadId: z.string().min(1).max(200),
    agentId: z.string().min(1).max(200),
  })
  .strict();

export type RecallScope = z.infer<typeof recallScopeSchema>;

export const recallAuthorizationSchema = z
  .object({
    scope: recallScopeSchema,
    currentRunId: z.string().min(1).max(200),
    includeDescendants: z.boolean(),
  })
  .strict();

export type RecallAuthorization = z.infer<typeof recallAuthorizationSchema>;

export const sqlRecallLimitsSchema = z.object({
  timeoutMs: z.number().int().positive().max(60_000),
  maxRows: z.number().int().positive().max(10_000),
  maxCellCharacters: z.number().int().positive().max(1_000_000),
  maxResponseBytes: z
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024),
  maxSnapshotBytes: z
    .number()
    .int()
    .min(1024)
    .max(512 * 1024 * 1024),
  maxJavaScriptHeapMb: z.number().int().min(32).max(4096),
  maxSqliteMemoryBytes: z
    .number()
    .int()
    .min(1024 * 1024)
    .max(512 * 1024 * 1024),
  maxSqliteValueBytes: z
    .number()
    .int()
    .min(1024)
    .max(512 * 1024 * 1024),
  maxConcurrentProcesses: z.number().int().positive().max(32),
  maxIpcBytes: z
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024),
});

export type SqlRecallLimits = z.infer<typeof sqlRecallLimitsSchema>;

export const DEFAULT_SQL_RECALL_LIMITS: SqlRecallLimits = {
  timeoutMs: 2000,
  maxRows: 200,
  maxCellCharacters: 16_384,
  maxResponseBytes: 256 * 1024,
  maxSnapshotBytes: 32 * 1024 * 1024,
  maxJavaScriptHeapMb: 128,
  maxSqliteMemoryBytes: 64 * 1024 * 1024,
  maxSqliteValueBytes: 16 * 1024 * 1024,
  maxConcurrentProcesses: 4,
  maxIpcBytes: 16 * 1024 * 1024,
};

export const sqlRecallCellTruncationSchema = z.object({
  row_index: z.number().int().nonnegative(),
  column_index: z.number().int().nonnegative(),
  column: z.string(),
  original_length: z.number().int().nonnegative(),
  next_read_position: z.number().int().positive(),
});

export const sqlRecallTruncationSchema = z.object({
  reasons: z.array(z.enum(['row_limit', 'cell_limit', 'response_limit'])).min(1),
  cells: z.array(sqlRecallCellTruncationSchema).optional(),
});

export const sqlRecallValueSchema = z.union([z.string(), z.number().finite(), z.null()]);

export const sqlRecallResultSchema = z
  .object({
    columns: z.array(z.string()),
    rows: z.array(z.array(sqlRecallValueSchema)),
    truncated: z.boolean(),
    truncation: sqlRecallTruncationSchema.optional(),
  })
  .superRefine((result, context) => {
    if (result.truncated !== (result.truncation !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'truncated and truncation must agree.',
      });
    }
    if (result.rows.some((row) => row.length !== result.columns.length)) {
      context.addIssue({ code: 'custom', message: 'Every row must match the column count.' });
    }
  });

export type SqlRecallCellTruncation = z.infer<typeof sqlRecallCellTruncationSchema>;
export type SqlRecallTruncation = z.infer<typeof sqlRecallTruncationSchema>;
export type SqlRecallValue = z.infer<typeof sqlRecallValueSchema>;
export type SqlRecallResult = z.infer<typeof sqlRecallResultSchema>;

export type RecallErrorCode =
  | 'invalid_query'
  | 'permission_denied'
  | 'timeout'
  | 'cancelled'
  | 'response_limit'
  | 'snapshot_limit'
  | 'javascript_heap_limit'
  | 'sqlite_memory_limit'
  | 'sqlite_value_limit'
  | 'authorization_limit'
  | 'concurrency_limit'
  | 'ipc_limit'
  | 'query_failed';

export class RecallError extends Error {
  readonly code: RecallErrorCode;

  constructor(code: RecallErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RecallError';
    this.code = code;
  }
}

export const snapshotValueSchema = z.union([z.string(), z.number().finite(), z.bigint(), z.null()]);
export const recallSnapshotSchema = z.object({
  thread: z.array(z.array(snapshotValueSchema)),
  context: z.array(z.array(snapshotValueSchema)),
  recap: z.array(z.array(snapshotValueSchema)),
});

export type RecallSnapshotValue = z.infer<typeof snapshotValueSchema>;
export type RecallSnapshot = z.infer<typeof recallSnapshotSchema>;

export const recallWorkerInputSchema = z.object({
  sql: z.string().min(1),
  limits: sqlRecallLimitsSchema,
  databasePath: z.string().min(1),
  authorization: recallAuthorizationSchema,
});

export type RecallWorkerInput = z.infer<typeof recallWorkerInputSchema>;

export const recallWorkerResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: sqlRecallResultSchema }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum([
        'invalid_query',
        'permission_denied',
        'response_limit',
        'snapshot_limit',
        'javascript_heap_limit',
        'sqlite_memory_limit',
        'sqlite_value_limit',
        'authorization_limit',
        'concurrency_limit',
        'ipc_limit',
        'query_failed',
      ]),
      message: z.string(),
    }),
  }),
]);

export type RecallWorkerResponse = z.infer<typeof recallWorkerResponseSchema>;
