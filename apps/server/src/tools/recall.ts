import type { AgentTool } from '@kairos/agent-core';
import { z } from 'zod';
import {
  RECALL_TABLE_COLUMNS,
  RecallError,
  type RecallScope,
  type SqlRecallResult,
} from '../recall/index.js';

const recallInputSchema = z.object({ sql: z.string().min(1) }).strict();

type RecallInput = z.infer<typeof recallInputSchema>;

export interface SqlRecallExecutor {
  execute(sql: string, options: { signal?: AbortSignal }): Promise<SqlRecallResult>;
}

export interface RecallToolOptions {
  engine: SqlRecallExecutor;
  scope: RecallScope;
}

export function createRecallTool(options: RecallToolOptions): AgentTool<RecallInput> {
  return {
    name: 'recall',
    description: recallDescription(options.scope),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sql'],
      properties: { sql: { type: 'string', minLength: 1 } },
    },
    validate: (value) => recallInputSchema.parse(value),
    async execute(input, { signal }) {
      try {
        const result = await options.engine.execute(input.sql, { signal });
        return JSON.stringify(result);
      } catch (error) {
        if (signal.aborted && error instanceof RecallError && error.code === 'cancelled') {
          throw signal.reason;
        }
        throw error;
      }
    },
  };
}

function recallDescription(scope: RecallScope): string {
  const schema = Object.entries(RECALL_TABLE_COLUMNS)
    .map(([table, columns]) => `${table}(${columns.join(', ')})`)
    .join('\n');
  return [
    'Execute one read-only SQLite SQL query over the authorized current view. Only the thread, context and recap tables below are available; internal database tables are not accessible.',
    `Current Thread ID: ${JSON.stringify(scope.threadId)}. Current Agent ID: ${JSON.stringify(scope.agentId)}. The Server determines which authorized scopes are visible; SQL does not change the authorization boundary.`,
    `Table schema:\n${schema}`,
    'Types: seq is INTEGER; all other columns are TEXT. Nullable columns are thread.summary, thread.last_message_at, context.tool_calls_json, context.tool_result_json, context.source_json and context.attachments_json.',
    'JSON TEXT fields: context.tool_calls_json is an array containing complete calls ({id,name,arguments}) and incomplete calls ({id,name,arguments_text,error}); context.tool_result_json is an object with tool_call_id and optional status and error; context.source_json contains the input source type and optional source thread_id and agent_id; recap.source_message_seqs is a JSON array of exact source message sequences; context.attachments_json is null or an array of attachment objects ({attachment_id,file_name,media_type,source,workspace_required,workspace_status,path}). Use json_each(context.attachments_json) to inspect attachments. For an attachment whose workspace_status is completed, call read({path}) for text/plain and read_image({path}) for image/png or image/jpeg without env_id to read the original file at that sandbox path. Attachment bodies are not included.',
    'Results contain columns, rows, truncated and optional truncation metadata. JSON columns remain JSON strings. Use length(), substr() and stable ordering to continue after truncation; SQLite string positions are one-based.',
  ].join('\n\n');
}
