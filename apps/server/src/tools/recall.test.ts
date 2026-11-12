import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@kairos/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { seedTestSession } from '../integration/test-authentication.js';
import { RecallError, SqlRecallEngine, type SqlRecallResult } from '../recall/index.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { createRecallTool } from './recall.js';

const scope = { threadId: 'thread-main', agentId: 'thread' };

async function execute<T>(
  tool: AgentTool<T>,
  input: unknown,
  signal = new AbortController().signal,
): Promise<string> {
  const result = await tool.execute(await tool.validate(input), {
    call: { id: 'call-recall', name: tool.name, arguments: {} },
    signal,
  });
  return typeof result === 'string' ? result : result.content;
}

describe('recall tool', () => {
  it('registers one strict SQL input and documents the schema and current scope', async () => {
    const result: SqlRecallResult = {
      columns: ['content'],
      rows: [['authorized']],
      truncated: true,
      truncation: {
        reasons: ['cell_limit'],
        cells: [
          {
            row_index: 0,
            column_index: 0,
            column: 'content',
            original_length: 20,
            next_read_position: 11,
          },
        ],
      },
    };
    const engine = { execute: vi.fn(async () => result) };
    const tool = createRecallTool({ engine, scope });
    const controller = new AbortController();

    expect(tool.name).toBe('recall');
    expect(tool.description).toContain('thread-main');
    expect(tool.description).toContain('Current Agent ID: "thread"');
    for (const field of [
      'thread_id',
      'summary',
      'tool_calls_json',
      'tool_result_json',
      'source_json',
      'source_message_seqs',
      'arguments_text',
      'attachments_json',
      'workspace_status',
      'json_each',
      'read_image',
      'sandbox path',
    ]) {
      expect(tool.description).toContain(field);
    }
    expect(tool.description).toContain(
      'Nullable columns are thread.summary, thread.last_message_at, context.tool_calls_json, context.tool_result_json, context.source_json and context.attachments_json.',
    );
    expect(tool.description).toContain('read({path}) for text/plain');
    expect(tool.description).toContain(
      'read_image({path}) for image/png or image/jpeg without env_id',
    );
    expect(tool.parameters).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['sql'],
      properties: { sql: { type: 'string', minLength: 1 } },
    });

    const output = await execute(
      tool,
      { sql: 'SELECT content FROM context ORDER BY seq' },
      controller.signal,
    );
    expect(engine.execute).toHaveBeenCalledWith('SELECT content FROM context ORDER BY seq', {
      signal: controller.signal,
    });
    expect(JSON.parse(output)).toEqual(result);
    await expect(execute(tool, { sql: 'SELECT 1', limit: 1 })).rejects.toThrow();
    expect(engine.execute).toHaveBeenCalledTimes(1);
  });

  it('preserves engine errors and their causes', async () => {
    const cause = new Error('SQLite detail');
    const failure = new RecallError('query_failed', 'SQL recall failed safely.', { cause });
    const tool = createRecallTool({
      engine: { execute: vi.fn(async () => Promise.reject(failure)) },
      scope,
    });

    const error = await execute(tool, { sql: 'SELECT 1' }).catch((reason: unknown) => reason);
    expect(error).toBe(failure);
    expect(error).toMatchObject({ code: 'query_failed', cause });
  });

  it('maps engine cancellation to the active AbortSignal reason', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Run cancelled', 'AbortError');
    const tool = createRecallTool({
      engine: {
        execute: vi.fn(async (_sql, { signal }) => {
          controller.abort(reason);
          expect(signal).toBe(controller.signal);
          throw new RecallError('cancelled', 'SQL recall was cancelled.');
        }),
      },
      scope,
    });

    await expect(execute(tool, { sql: 'SELECT 1' }, controller.signal)).rejects.toBe(reason);
  });

  it('executes a real query through the M60 engine', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kairos-recall-tool-'));
    const database = openDatabase(join(directory, 'server.sqlite'));
    try {
      seedTestSession(database, 'recall-tool-owner', 'recall-tool-session');
      const thread = new SessionStore(database).getOrCreateMainThread('recall-tool-owner');
      const engine = new SqlRecallEngine(database, {
        scope: { threadId: thread.threadId, agentId: 'thread' },
        currentRunId: 'recall-tool-run',
        includeDescendants: false,
      });
      const tool = createRecallTool({ engine, scope });
      const result = JSON.parse(await execute(tool, { sql: 'SELECT 1 AS value' }));
      expect(result).toEqual({ columns: ['value'], rows: [[1]], truncated: false });
      expect(engine.activeProcessCount).toBe(0);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
