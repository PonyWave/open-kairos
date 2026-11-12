import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextStore } from '../context/context-store.js';
import { RecapStore } from '../recap/recap-store.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { SqlRecallEngine, SqlRecallProcessPool } from './engine.js';
import { projectRecallSnapshot } from './projection.js';
import { RecallError, type SqlRecallLimits } from './types.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(limits: Partial<SqlRecallLimits> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-recall-engine-'));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, 'server.sqlite'));
  new SessionStore(database);
  const insertThread = database.prepare(
    `INSERT INTO threads(thread_id, owner_id, title, thread_type, created_at, updated_at)
     VALUES (?, 'owner', ?, ?, ?, ?)`,
  );
  insertThread.run(
    'thread-main',
    '主对话',
    'main',
    '2026-11-02T00:00:00.000Z',
    '2026-11-02T00:00:00.000Z',
  );
  insertThread.run(
    'thread-other',
    '其他对话',
    'task',
    '2026-11-02T00:00:00.000Z',
    '2026-11-02T00:00:00.000Z',
  );
  const context = new ContextStore(database);
  const recaps = new RecapStore(database);
  const first = context.append({
    threadId: 'thread-main',
    agentId: 'thread',
    runId: 'internal-run',
    message: { role: 'user', content: 'current message' },
    createdAt: '2026-11-02T01:00:00.000Z',
  });
  const assistant = context.append({
    threadId: 'thread-main',
    agentId: 'thread',
    message: {
      role: 'assistant',
      content: 'calls',
      tool_calls: [{ id: 'call-1', name: 'bash', arguments: { command: 'pwd' } }],
      incomplete_tool_calls: [
        { id: 'call-2', name: 'bash', arguments_text: '{"command":', error: 'incomplete' },
      ],
    },
    createdAt: '2026-11-02T02:00:00.000Z',
  });
  const tool = context.append({
    threadId: 'thread-main',
    agentId: 'thread',
    message: {
      role: 'tool',
      content: 'result',
      tool_call_id: 'call-1',
      tool_name: 'bash',
      status: 'error',
      error: { code: 'execution_failed', message: 'failed' },
    },
    createdAt: '2026-11-02T03:00:00.000Z',
  });
  const incompleteTool = context.append({
    threadId: 'thread-main',
    agentId: 'thread',
    message: {
      role: 'tool',
      content: 'incomplete call',
      tool_call_id: 'call-2',
      tool_name: 'bash',
      status: 'error',
      error: { code: 'incomplete_call', message: 'incomplete' },
    },
    createdAt: '2026-11-02T03:30:00.000Z',
  });
  const sourced = context.append({
    threadId: 'thread-main',
    agentId: 'thread',
    source: 'thread_response',
    sourceThreadId: 'thread-other',
    sourceAgentId: 'thread',
    message: { role: 'user', content: 'response source' },
    createdAt: '2026-11-02T04:00:00.000Z',
  });
  context.append({
    threadId: 'thread-main',
    agentId: 'child-agent',
    message: { role: 'user', content: 'child secret' },
  });
  const otherThreadMessage = context.append({
    threadId: 'thread-other',
    agentId: 'thread',
    message: { role: 'user', content: 'other thread secret' },
  });
  recaps.save({
    recapId: 'recap-old',
    threadId: 'thread-main',
    agentId: 'thread',
    sourceMessageSeqs: [first.seq],
    content: 'old summary',
    createdAt: '2026-11-02T05:00:00.000Z',
  });
  recaps.save({
    recapId: 'recap-new',
    threadId: 'thread-main',
    agentId: 'thread',
    sourceMessageSeqs: [first.seq, assistant.seq, tool.seq, incompleteTool.seq],
    content: 'latest summary',
    createdAt: '2026-11-02T06:00:00.000Z',
  });
  recaps.save({
    recapId: 'recap-secret',
    threadId: 'thread-other',
    agentId: 'thread',
    sourceMessageSeqs: [otherThreadMessage.seq],
    content: 'other recap secret',
  });
  const authorization = {
    scope: { threadId: 'thread-main', agentId: 'thread' },
    currentRunId: 'internal-run',
    includeDescendants: false,
  };
  const engine = new SqlRecallEngine(database, authorization, { limits });
  return {
    database,
    context,
    recaps,
    engine,
    authorization,
    first,
    assistant,
    tool,
    incompleteTool,
    sourced,
  };
}

describe('SQL recall projection', () => {
  it('does not treat a different Agent ID as the authorized root Agent', () => {
    const { database, context, recaps, authorization } = fixture();
    try {
      const other = context.append({
        threadId: 'thread-main',
        agentId: 'main',
        message: { role: 'user', content: 'different agent message' },
      });
      recaps.save({
        recapId: 'recap-different-agent',
        threadId: 'thread-main',
        agentId: 'main',
        sourceMessageSeqs: [other.seq],
        content: 'different agent summary',
      });
      const snapshot = projectRecallSnapshot(database, authorization);
      expect(snapshot.context.map((row) => row[0])).not.toContain(BigInt(other.seq));
      expect(snapshot.recap.map((row) => row[0])).not.toContain('recap-different-agent');
      expect(snapshot.thread[0]?.[3]).toBe('latest summary');
    } finally {
      database.close();
    }
  });

  it('projects attachment locations without attachment bodies or data URLs', async () => {
    const { database, engine, first } = fixture();
    try {
      database
        .prepare(
          `INSERT INTO attachments(
            attachment_id, owner_id, file_name, media_type, byte_size, sha256, content,
            width, height, created_at
          ) VALUES ('image-1', 'owner', 'pixel.png', 'image/png', 1, ?, ?, 1, 1, ?)`,
        )
        .run('a'.repeat(64), new Uint8Array([1]), '2026-11-02T00:00:00.000Z');
      database
        .prepare(
          `INSERT INTO context_message_attachments(
            message_seq, position, attachment_id, source, workspace_required, workspace_status,
            env_id, path, operation_id
          ) VALUES (?, 1, 'image-1', 'clipboard', 1, 'completed', 'env-1', ?, 'write-1')`,
        )
        .run(first.seq, '/workspace/.kairos/attachments/image-1.png');
      const result = await engine.execute(
        `SELECT attachments_json FROM context WHERE seq = ${first.seq}`,
      );
      const serialized = result.rows[0]?.[0];
      expect(typeof serialized).toBe('string');
      expect(JSON.parse(String(serialized))).toEqual([
        {
          attachment_id: 'image-1',
          file_name: 'pixel.png',
          media_type: 'image/png',
          source: 'clipboard',
          workspace_required: 1,
          workspace_status: 'completed',
          path: '/workspace/.kairos/attachments/image-1.png',
        },
      ]);
      expect(String(serialized)).not.toContain('base64');
      expect(String(serialized)).not.toContain('data:');
    } finally {
      database.close();
    }
  });

  it('projects only the public schema, target root identity and exact current sources', () => {
    const { database, authorization, first, assistant, tool } = fixture();
    try {
      const snapshot = projectRecallSnapshot(database, authorization);
      expect(snapshot.thread).toEqual([
        [
          'thread-main',
          'main',
          '主对话',
          'latest summary',
          '2026-11-02T00:00:00.000Z',
          '2026-11-02T04:00:00.000Z',
        ],
      ]);
      expect(snapshot.context).toHaveLength(5);
      expect(snapshot.context.every((row) => row.length === 10)).toBe(true);
      expect(snapshot.context[0]?.slice(0, 6)).toEqual([
        BigInt(first.seq),
        'thread-main',
        'thread',
        'user',
        'current message',
        '2026-11-02T01:00:00.000Z',
      ]);
      expect(JSON.parse(snapshot.context[1]?.[6] as string)).toEqual([
        { id: 'call-1', name: 'bash', arguments: { command: 'pwd' } },
        { id: 'call-2', name: 'bash', arguments_text: '{"command":', error: 'incomplete' },
      ]);
      expect(JSON.parse(snapshot.context[2]?.[7] as string)).toEqual({
        tool_call_id: 'call-1',
        status: 'error',
        error: { code: 'execution_failed', message: 'failed' },
      });
      expect(JSON.parse(snapshot.context[4]?.[8] as string)).toEqual({
        type: 'thread_response',
        thread_id: 'thread-other',
        agent_id: 'thread',
      });
      expect(snapshot.recap).toHaveLength(2);
      expect(snapshot.recap[1]).toEqual([
        'recap-new',
        'thread-main',
        'thread',
        'latest summary',
        JSON.stringify([first.seq, assistant.seq, tool.seq, tool.seq + 1]),
        '2026-11-02T01:00:00.000Z',
        '2026-11-02T03:30:00.000Z',
        '2026-11-02T06:00:00.000Z',
      ]);
      const serialized = JSON.stringify(snapshot, (_, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('internal-run');
      expect(serialized).not.toContain('internal new title');
    } finally {
      database.close();
    }
  });

  it('uses revisions, excludes superseded messages and invalidates affected Recaps and summaries', () => {
    const { database, context, recaps, authorization, first, assistant, tool, incompleteTool } =
      fixture();
    try {
      context.revise({
        threadId: 'thread-main',
        agentId: 'thread',
        seq: first.seq,
        content: 'revised current content',
      });
      let snapshot = projectRecallSnapshot(database, authorization);
      expect(snapshot.context[0]?.[4]).toBe('revised current content');
      expect(snapshot.recap).toEqual([]);
      expect(snapshot.thread[0]?.[3]).toBeNull();
      expect(
        JSON.stringify(snapshot, (_, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      ).not.toContain('current message');

      recaps.save({
        recapId: 'recap-tool',
        threadId: 'thread-main',
        agentId: 'thread',
        sourceMessageSeqs: [assistant.seq, tool.seq, incompleteTool.seq],
        content: 'tool summary',
      });
      database
        .prepare('UPDATE context_messages SET superseded_by_run_id = ? WHERE seq = ?')
        .run('rerun-internal', assistant.seq);
      snapshot = projectRecallSnapshot(database, authorization);
      expect(snapshot.context.map((row) => row[0])).not.toContain(BigInt(assistant.seq));
      expect(snapshot.recap).toEqual([]);
      expect(snapshot.thread[0]?.[3]).toBeNull();
    } finally {
      database.close();
    }
  });

  it('reselects thread.summary after the latest Recap is invalidated', () => {
    const { database, recaps, authorization } = fixture();
    try {
      recaps.invalidate('thread-main', 'thread', 'recap-new', 'test');
      const snapshot = projectRecallSnapshot(database, authorization);
      expect(snapshot.thread[0]?.[3]).toBe('old summary');
      expect(snapshot.recap.map((row) => row[0])).toEqual(['recap-old']);
    } finally {
      database.close();
    }
  });
});

describe('SQL recall execution', () => {
  it('applies scope filtering before WITH, JOIN, subquery, JSON and aggregation execution', async () => {
    const { database, engine } = fixture();
    try {
      const result = await engine.execute(`
        WITH summarized AS (
          SELECT thread_id, agent_id, json_array_length(source_message_seqs) AS source_count
          FROM recap WHERE recap_id = 'recap-new'
        )
        SELECT c.agent_id, count(*) AS matched_messages, max(s.source_count) AS source_count
        FROM context AS c
        JOIN summarized AS s ON s.thread_id = c.thread_id AND s.agent_id = c.agent_id
        WHERE c.seq IN (
          SELECT value FROM json_each((SELECT source_message_seqs FROM recap WHERE recap_id = 'recap-new'))
        )
        GROUP BY c.agent_id
      `);
      expect(result).toEqual({
        columns: ['agent_id', 'matched_messages', 'source_count'],
        rows: [['thread', 4, 4]],
        truncated: false,
      });
      expect(JSON.stringify(result)).not.toContain('secret');
    } finally {
      database.close();
    }
  });

  it.each([
    "INSERT INTO context(thread_id) VALUES ('x')",
    'WITH old AS (SELECT * FROM context) DELETE FROM context',
    'CREATE TABLE private_data(value TEXT)',
    'DROP TABLE context',
    'BEGIN TRANSACTION',
    'PRAGMA table_info(context)',
    "ATTACH DATABASE '/private/internal.db' AS private",
    "SELECT load_extension('/private/extension.so')",
    'SELECT * FROM context_messages',
    'SELECT * FROM context_message_revisions',
    'SELECT * FROM runs',
    'SELECT * FROM sqlite_master',
  ])('rejects non-read-only or internal access: %s', async (sql) => {
    const { database, engine } = fixture();
    try {
      const error = await engine.execute(sql).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(RecallError);
      expect(error).toMatchObject({ code: 'permission_denied' });
      expect((error as Error).message).not.toContain('/private/');
    } finally {
      database.close();
    }
  });

  it('rejects multiple statements and reports public query errors', async () => {
    const { database, engine } = fixture();
    try {
      await expect(engine.execute('SELECT 1; SELECT 2')).rejects.toMatchObject({
        code: 'invalid_query',
      });
      await expect(
        engine.execute("SELECT ';' AS value; -- trailing comment"),
      ).resolves.toMatchObject({ rows: [[';']], truncated: false });
      await expect(engine.execute('SELECT missing_column FROM context')).rejects.toMatchObject({
        code: 'invalid_query',
      });
      await expect(engine.execute('   ')).rejects.toMatchObject({ code: 'invalid_query' });
    } finally {
      database.close();
    }
  });

  it('returns large integers losslessly and enforces row limits with stable continuation', async () => {
    const { database, engine } = fixture({ maxRows: 2 });
    try {
      const integers = await engine.execute(
        'SELECT 9223372036854775807 AS large, 9007199254740991 AS safe, count(*) AS contexts FROM context',
      );
      expect(integers.rows).toEqual([['9223372036854775807', 9007199254740991, 5]]);
      const page = await engine.execute('SELECT seq FROM context ORDER BY seq');
      expect(page.rows).toHaveLength(2);
      expect(page.truncation?.reasons).toEqual(['row_limit']);
      const last = page.rows.at(-1)?.[0];
      const remainder = await engine.execute(
        `SELECT seq FROM context WHERE seq > ${last} ORDER BY seq`,
      );
      expect(remainder.rows.length).toBeGreaterThan(0);
      expect(remainder.rows[0]?.[0]).not.toBe(page.rows[0]?.[0]);
    } finally {
      database.close();
    }
  });

  it('marks truncated JSON and reports SQLite-compatible Unicode continuation positions', async () => {
    const { database, context, engine } = fixture({ maxCellCharacters: 4 });
    try {
      const message = context.append({
        threadId: 'thread-main',
        agentId: 'thread',
        message: { role: 'user', content: 'a😀bcde' },
      });
      const json = await engine.execute(
        "SELECT tool_calls_json FROM context WHERE role = 'assistant'",
      );
      expect(json.truncated).toBe(true);
      expect(json.truncation).toMatchObject({
        reasons: ['cell_limit'],
        cells: [{ row_index: 0, column_index: 0, column: 'tool_calls_json' }],
      });
      expect(() => JSON.parse(json.rows[0]?.[0] as string)).toThrow();

      const text = await engine.execute(`SELECT content FROM context WHERE seq = ${message.seq}`);
      expect(text.rows[0]?.[0]).toBe('a😀bc');
      expect(text.truncation?.cells?.[0]).toMatchObject({
        original_length: 6,
        next_read_position: 5,
      });
      const remainder = await engine.execute(
        `SELECT substr(content, 5), length(content) FROM context WHERE seq = ${message.seq}`,
      );
      expect(remainder.rows).toEqual([['de', 6]]);
      expect(remainder.truncated).toBe(false);
    } finally {
      database.close();
    }
  });

  it('keeps the complete JSON response within the configured byte limit', async () => {
    const { database, engine } = fixture({ maxResponseBytes: 1024, maxCellCharacters: 1000 });
    try {
      const result = await engine.execute(`
        WITH RECURSIVE series(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM series WHERE value < 100
        )
        SELECT printf('%0300d', value) AS content FROM series ORDER BY value
      `);
      expect(result.truncated).toBe(true);
      expect(result.truncation?.reasons).toContain('response_limit');
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1024);
    } finally {
      database.close();
    }
  });

  it.each(['WHERE 0', 'LIMIT 0'])(
    'checks column metadata against the response limit for zero rows: %s',
    async (clause) => {
      const { database, engine } = fixture({ maxResponseBytes: 1024 });
      try {
        const alias = 'x'.repeat(4000);
        await expect(engine.execute(`SELECT 1 AS "${alias}" ${clause}`)).rejects.toMatchObject({
          code: 'response_limit',
        });
        expect(engine.activeProcessCount).toBe(0);
      } finally {
        database.close();
      }
    },
  );

  it('completes finite recursive queries and releases the execution process', async () => {
    const { database, engine } = fixture();
    try {
      const result = await engine.execute(`
        WITH RECURSIVE series(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM series WHERE value < 5
        )
        SELECT sum(value) AS total FROM series
      `);
      expect(result.rows).toEqual([[15]]);
      expect(engine.activeProcessCount).toBe(0);
    } finally {
      database.close();
    }
  });

  it('kills an infinite recursive query at the deadline before returning', async () => {
    const { database, engine, authorization } = fixture({ timeoutMs: 100 });
    try {
      await expect(
        engine.execute(`
          WITH RECURSIVE series(value) AS (
            SELECT 1 UNION ALL SELECT value + 1 FROM series
          )
          SELECT sum(value) FROM series
        `),
      ).rejects.toMatchObject({ code: 'timeout' });
      expect(engine.activeProcessCount).toBe(0);
      const recovery = new SqlRecallEngine(database, authorization);
      await expect(recovery.execute('SELECT 1 AS alive')).resolves.toMatchObject({ rows: [[1]] });
      expect(recovery.activeProcessCount).toBe(0);
    } finally {
      database.close();
    }
  });

  it('kills a running query on abort, releases its process and accepts later queries', async () => {
    const { database, engine } = fixture();
    try {
      const controller = new AbortController();
      const running = engine.execute(
        `WITH RECURSIVE series(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM series
        ) SELECT sum(value) FROM series`,
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 50);
      await expect(running).rejects.toMatchObject({ code: 'cancelled' });
      expect(engine.activeProcessCount).toBe(0);
      await expect(engine.execute('SELECT 1 AS alive')).resolves.toMatchObject({
        rows: [[1]],
        truncated: false,
      });
      expect(engine.activeProcessCount).toBe(0);
      await expect(
        engine.execute('SELECT 1', { signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ code: 'cancelled' });
      expect(engine.activeProcessCount).toBe(0);
    } finally {
      database.close();
    }
  });

  it('rejects an oversized authorized snapshot and recovers without exposing source data', async () => {
    const { database, engine, authorization } = fixture({ maxSnapshotBytes: 1024 });
    try {
      const error = await engine.execute('SELECT 1').catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: 'snapshot_limit' });
      expect((error as Error).message).not.toContain('server.sqlite');
      expect((error as Error).message).not.toContain('current message');
      expect(engine.activeProcessCount).toBe(0);
      const recovery = new SqlRecallEngine(database, authorization);
      await expect(recovery.execute('SELECT 1 AS alive')).resolves.toMatchObject({ rows: [[1]] });
      expect(recovery.activeProcessCount).toBe(0);
    } finally {
      database.close();
    }
  });

  it('bounds IPC input and response without retaining a child process', async () => {
    const { database, engine } = fixture({ maxIpcBytes: 1024 });
    try {
      const oversized = `SELECT 1 AS "${'x'.repeat(2048)}"`;
      await expect(engine.execute(oversized)).rejects.toMatchObject({ code: 'ipc_limit' });
      expect(engine.activeProcessCount).toBe(0);
      await expect(engine.execute("SELECT printf('%04000d', 1) AS value")).rejects.toMatchObject({
        code: 'ipc_limit',
      });
      expect(engine.activeProcessCount).toBe(0);
      await expect(engine.execute('SELECT 1 AS alive')).resolves.toMatchObject({ rows: [[1]] });
    } finally {
      database.close();
    }
  });

  it('shares an injected pool without affecting independent Servers', async () => {
    const { database, authorization } = fixture({ timeoutMs: 5000 });
    const processPool = new SqlRecallProcessPool(1);
    const engine = new SqlRecallEngine(database, authorization, {
      limits: { timeoutMs: 5000 },
      processPool,
    });
    const other = new SqlRecallEngine(database, authorization, {
      limits: { timeoutMs: 5000 },
      processPool,
    });
    const independent = new SqlRecallEngine(database, authorization);
    const controller = new AbortController();
    try {
      const running = engine.execute(
        `WITH RECURSIVE series(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM series
        ) SELECT sum(value) FROM series`,
        { signal: controller.signal },
      );
      expect(processPool.activeProcessCount).toBe(1);
      await expect(other.execute('SELECT 1')).rejects.toMatchObject({
        code: 'concurrency_limit',
      });
      await expect(independent.execute('SELECT 1 AS independent')).resolves.toMatchObject({
        rows: [[1]],
      });
      expect(processPool.activeProcessCount).toBe(1);
      expect(independent.activeProcessCount).toBe(0);
      controller.abort();
      await expect(running).rejects.toMatchObject({ code: 'cancelled' });
      expect(processPool.activeProcessCount).toBe(0);
      await expect(other.execute('SELECT 1 AS alive')).resolves.toMatchObject({ rows: [[1]] });
      expect(processPool.activeProcessCount).toBe(0);
    } finally {
      controller.abort();
      database.close();
    }
  });

  it('times out authorized projection before a trivial query and accepts a later query', async () => {
    const limits: Partial<SqlRecallLimits> = {
      timeoutMs: 300,
      maxSnapshotBytes: 256 * 1024 * 1024,
      maxJavaScriptHeapMb: 512,
      maxSqliteMemoryBytes: 128 * 1024 * 1024,
    };
    const { database, engine, authorization } = fixture(limits);
    try {
      insertBulkMessages(database, 200_000, 256, 'projection-timeout');
      await expect(engine.execute('SELECT 1')).rejects.toMatchObject({ code: 'timeout' });
      expect(engine.activeProcessCount).toBe(0);
      const recovery = new SqlRecallEngine(database, authorization, {
        limits: { ...limits, timeoutMs: 10_000 },
      });
      await expect(recovery.execute('SELECT 1 AS alive')).resolves.toMatchObject({ rows: [[1]] });
      expect(recovery.activeProcessCount).toBe(0);
    } finally {
      database.close();
    }
  }, 20_000);

  it('cancels authorized projection and releases the process for a later query', async () => {
    const limits: Partial<SqlRecallLimits> = {
      timeoutMs: 10_000,
      maxSnapshotBytes: 128 * 1024 * 1024,
      maxJavaScriptHeapMb: 512,
    };
    const { database, engine } = fixture(limits);
    const controller = new AbortController();
    try {
      insertBulkMessages(database, 50_000, 256, 'projection-cancel');
      const running = engine.execute('SELECT 1', { signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      await expect(running).rejects.toMatchObject({ code: 'cancelled' });
      expect(engine.activeProcessCount).toBe(0);
      await expect(engine.execute('SELECT 1 AS alive')).resolves.toMatchObject({ rows: [[1]] });
      expect(engine.activeProcessCount).toBe(0);
    } finally {
      controller.abort();
      database.close();
    }
  }, 20_000);

  it('enforces the JavaScript heap limit during projection and recovers after cleanup', async () => {
    const limits: Partial<SqlRecallLimits> = {
      timeoutMs: 10_000,
      maxSnapshotBytes: 512 * 1024 * 1024,
      maxJavaScriptHeapMb: 64,
      maxSqliteMemoryBytes: 512 * 1024 * 1024,
      maxSqliteValueBytes: 2 * 1024 * 1024,
    };
    const { database, engine } = fixture(limits);
    try {
      await expect(engine.execute('SELECT 1 AS alive')).resolves.toMatchObject({ rows: [[1]] });
      insertBulkMessages(database, 96, 1024 * 1024, 'projection-memory');
      const error = await engine.execute('SELECT 1').catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: 'javascript_heap_limit' });
      expect((error as Error).message).not.toContain('server.sqlite');
      expect((error as Error).message).not.toContain('projection-memory');
      expect(engine.activeProcessCount).toBe(0);
      database
        .prepare("DELETE FROM context_messages WHERE message_id LIKE 'projection-memory-%'")
        .run();
      await expect(engine.execute('SELECT 1 AS alive')).resolves.toMatchObject({ rows: [[1]] });
      expect(engine.activeProcessCount).toBe(0);
    } finally {
      database.close();
    }
  }, 30_000);

  it('rejects a 64 MiB SQLite printf intermediate at the native memory limit', async () => {
    const { database, engine } = fixture({
      timeoutMs: 10_000,
      maxSqliteMemoryBytes: 32 * 1024 * 1024,
      maxSqliteValueBytes: 128 * 1024 * 1024,
    });
    try {
      await expect(
        engine.execute("SELECT length(printf('%067108864d', 1)) AS native_length"),
      ).rejects.toMatchObject({
        code: 'sqlite_memory_limit',
        message: expect.stringContaining('SQLite native memory limit'),
      });
      expect(engine.activeProcessCount).toBe(0);
      await expect(engine.execute('SELECT 1 AS alive')).resolves.toMatchObject({ rows: [[1]] });
      expect(engine.activeProcessCount).toBe(0);
    } finally {
      database.close();
    }
  });

  it('rejects SQLite result values before constructing an over-limit string', async () => {
    const { database, engine } = fixture({ maxSqliteValueBytes: 1024 });
    try {
      await expect(
        engine.execute("SELECT length(printf('%02048d', 1)) AS value_length"),
      ).rejects.toMatchObject({ code: 'sqlite_value_limit' });
      expect(engine.activeProcessCount).toBe(0);
      await expect(engine.execute('SELECT 1 AS alive')).resolves.toMatchObject({ rows: [[1]] });
    } finally {
      database.close();
    }
  });
});

function insertBulkMessages(
  database: ReturnType<typeof openDatabase>,
  count: number,
  contentWidth: number,
  prefix: string,
): void {
  database
    .prepare(
      `INSERT INTO context_messages(message_id, thread_id, agent_id, role, content, created_at)
       WITH RECURSIVE series(value) AS (
         SELECT 1 UNION ALL SELECT value + 1 FROM series WHERE value < ?
       )
       SELECT ? || value, 'thread-main', 'thread', 'user',
         printf('%0${contentWidth}d', value), '2026-11-02T07:00:00.000Z'
       FROM series`,
    )
    .run(count, `${prefix}-`);
}
