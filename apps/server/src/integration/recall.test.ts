import { mkdtemp, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelProvider, ToolCall } from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import { RunStatus } from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ContextStore } from '../context/context-store.js';
import {
  DEFAULT_SQL_RECALL_LIMITS,
  type SqlRecallLimits,
  sqlRecallResultSchema,
} from '../recall/types.js';
import { RecapStore } from '../recap/recap-store.js';
import { openDatabase } from '../storage/database.js';
import {
  accessToken,
  ControlledProvider,
  closeFixture,
  networkClients,
  ownerId,
  response,
  sendMessage,
  waitRun,
} from './delegation-fixture.js';
import {
  createEnvironmentTestServer as createServer,
  seedTestEnvironment,
} from './environment-fixture.js';

const terminalStatuses = [
  RunStatus.COMPLETED,
  RunStatus.FAILED,
  RunStatus.CANCELLED,
  RunStatus.INTERRUPTED,
];

async function startRecallFixture(
  directory: string,
  provider: ModelProvider,
  limits: Partial<SqlRecallLimits> = {},
) {
  const database = openDatabase(join(directory, 'server.sqlite'));
  seedTestEnvironment(database, ownerId);
  const server = createServer(database, false, {
    tenantId: ownerId,
    sessionToken: accessToken,
    model: {
      provider,
      providerId: 'recall-acceptance-provider',
      modelId: 'recall-acceptance-model',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
    },
    periodicRecap: { messageThreshold: 1000, responseWindowMs: 600_000 },
    sqlRecall: { ...DEFAULT_SQL_RECALL_LIMITS, ...limits },
    maxStepsPerRun: 30,
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    database,
    server,
    port: address.port,
    baseUrl,
    clients: networkClients(baseUrl),
  };
}

type RecallFixture = Awaited<ReturnType<typeof startRecallFixture>>;

function recallCall(id: string, sql: string): ToolCall {
  return { id, name: 'recall', arguments: { sql } };
}

const toolRowSchema = z.object({
  content: z.string(),
  tool_status: z.enum(['success', 'error']).nullable(),
  tool_error_json: z.string().nullable(),
});

function toolRow(fixture: RecallFixture, callId: string, agentId = 'thread') {
  const row = fixture.database
    .prepare(
      `SELECT content, tool_status, tool_error_json FROM context_messages
       WHERE thread_id IN (SELECT thread_id FROM threads)
         AND agent_id = ? AND role = 'tool' AND tool_call_id = ?
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(agentId, callId);
  return toolRowSchema.parse(row);
}

function sqlResult(fixture: RecallFixture, callId: string) {
  const row = toolRow(fixture, callId);
  expect(row.tool_status).toBe('success');
  return sqlRecallResultSchema.parse(JSON.parse(row.content));
}

async function mainThread(fixture: RecallFixture): Promise<string> {
  const thread = (await fixture.clients.thread.getOrCreateMain({})).thread;
  if (!thread) throw new Error('The main Thread is missing.');
  return thread.threadId;
}

async function createTask(fixture: RecallFixture, actionId: string): Promise<string> {
  const created = await fixture.clients.thread.createThread({
    clientActionId: actionId,
    title: 'SQL recall other Thread',
  });
  if (!created.thread) throw new Error('The task Thread is missing.');
  return created.thread.threadId;
}

function sequence(fixture: RecallFixture, content: string): number {
  return z
    .object({ seq: z.number().int().positive() })
    .parse(
      fixture.database
        .prepare('SELECT seq FROM context_messages WHERE content = ? ORDER BY seq LIMIT 1')
        .get(content),
    ).seq;
}

it('accepts the public schema, current view, tool JSON, exact sources and cross-Run scope over HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-recall-schema-'));
  const initialProvider = new ScriptedProvider([response('seed response')]);
  let fixture = await startRecallFixture(directory, initialProvider);
  try {
    const mainId = await mainThread(fixture);
    const taskId = await createTask(fixture, 'recall-create-other');
    const seeded = await sendMessage(fixture, mainId, 'seed run', 'recall-seed-run');
    await waitRun(fixture, mainId, seeded.runId, RunStatus.COMPLETED);

    const context = new ContextStore(fixture.database);
    const alpha = context.append({
      messageId: 'recall-alpha',
      threadId: mainId,
      agentId: 'thread',
      message: { role: 'user', content: 'ORCHID old' },
      createdAt: '2026-11-03T01:00:00.000Z',
    });
    const child = context.append({
      threadId: mainId,
      agentId: 'subagent-fixture',
      message: { role: 'user', content: 'child secret' },
      createdAt: '2026-11-03T01:01:00.000Z',
    });
    const beta = context.append({
      messageId: 'recall-beta',
      threadId: mainId,
      agentId: 'thread',
      message: { role: 'user', content: 'VELVET current' },
      createdAt: '2026-11-03T01:02:00.000Z',
    });
    const assistant = context.append({
      threadId: mainId,
      agentId: 'thread',
      message: {
        role: 'assistant',
        content: 'combined tool calls',
        tool_calls: [
          {
            id: 'json-complete',
            name: 'bash',
            arguments: { command: 'printf JSON-724', cwd: '/tmp' },
          },
        ],
        incomplete_tool_calls: [
          {
            id: 'json-incomplete',
            name: 'bash',
            arguments_text: '{"command":',
            error: 'incomplete acceptance fixture',
          },
        ],
      },
      createdAt: '2026-11-03T01:03:00.000Z',
    });
    const tool = context.append({
      threadId: mainId,
      agentId: 'thread',
      message: {
        role: 'tool',
        content: 'JSON-724 result',
        tool_call_id: 'json-complete',
        tool_name: 'bash',
        status: 'success',
      },
      createdAt: '2026-11-03T01:04:00.000Z',
    });
    const incompleteTool = context.append({
      threadId: mainId,
      agentId: 'thread',
      message: {
        role: 'tool',
        content: 'incomplete call rejected',
        tool_call_id: 'json-incomplete',
        tool_name: 'bash',
        status: 'error',
        error: { code: 'incomplete_call', message: 'incomplete acceptance fixture' },
      },
      createdAt: '2026-11-03T01:05:00.000Z',
    });
    context.append({
      threadId: taskId,
      agentId: 'thread',
      message: { role: 'user', content: 'OTHER-THREAD-SECRET' },
    });

    const recaps = new RecapStore(fixture.database);
    const firstSeq = sequence(fixture, 'seed run');
    recaps.save({
      recapId: 'recap-old',
      threadId: mainId,
      agentId: 'thread',
      sourceMessageSeqs: [firstSeq],
      content: 'old root summary',
      createdAt: '2026-11-03T02:00:00.000Z',
    });
    for (const recapId of ['recap-tie-a', 'recap-tie-z']) {
      recaps.save({
        recapId,
        threadId: mainId,
        agentId: 'thread',
        sourceMessageSeqs: [alpha.seq, beta.seq],
        content: `summary from ${recapId}`,
        createdAt: '2026-11-03T03:00:00.000Z',
      });
    }
    recaps.save({
      recapId: 'recap-child',
      threadId: mainId,
      agentId: 'subagent-fixture',
      sourceMessageSeqs: [child.seq],
      content: 'child summary',
      createdAt: '2026-11-03T04:00:00.000Z',
    });
    const seedMaxSeq = sequence(fixture, 'OTHER-THREAD-SECRET');

    await closeFixture(fixture);
    const provider = new ScriptedProvider([
      response('unused', [
        recallCall(
          'recall-schema',
          'SELECT thread_id, thread_type, title, summary FROM thread ORDER BY thread_id',
        ),
        recallCall(
          'recall-current',
          `SELECT seq, agent_id, role, content, tool_calls_json, tool_result_json, source_json
           FROM context WHERE seq <= ${seedMaxSeq} ORDER BY seq`,
        ),
        recallCall(
          'recall-sources',
          `SELECT c.seq, c.agent_id, c.content FROM recap AS r
           JOIN json_each(r.source_message_seqs) AS source
           JOIN context AS c ON c.seq = source.value
             AND c.thread_id = r.thread_id AND c.agent_id = r.agent_id
           WHERE r.recap_id = 'recap-tie-z' ORDER BY c.seq`,
        ),
        recallCall(
          'recall-cross-run-auth',
          `SELECT
             (SELECT count(*) FROM context WHERE content = 'OTHER-THREAD-SECRET'),
             (SELECT count(*) FROM context WHERE content = 'seed run'),
             (SELECT count(*) FROM recap WHERE content = 'child summary'),
             (SELECT count(*) FROM context WHERE agent_id <> 'thread')`,
        ),
      ]),
      response('schema queries completed'),
      response('unused', [
        recallCall(
          'recall-after-revision',
          `SELECT
             (SELECT content FROM context WHERE seq = ${alpha.seq}),
             (SELECT summary FROM thread),
             (SELECT count(*) FROM context WHERE content IN ('ORCHID old', 'VELVET current')),
             (SELECT count(*) FROM recap WHERE recap_id IN ('recap-tie-a', 'recap-tie-z'))`,
        ),
      ]),
      response('revision queries completed'),
      response('unused', [
        recallCall('recall-task-scope', 'SELECT thread_type, summary FROM thread'),
      ]),
      response('task query completed'),
    ]);
    fixture = await startRecallFixture(directory, provider);

    const queried = await sendMessage(fixture, mainId, 'query public data', 'recall-query-public');
    await waitRun(fixture, mainId, queried.runId, RunStatus.COMPLETED);
    const request = provider.requests[0];
    const recallTools = request?.tools.filter((tool) => tool.name.startsWith('recall')) ?? [];
    expect(recallTools).toHaveLength(1);
    expect(recallTools[0]).toMatchObject({
      name: 'recall',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sql'],
        properties: { sql: { type: 'string', minLength: 1 } },
      },
    });
    expect(request?.tools.some((tool) => tool.name === 'recall_context')).toBe(false);
    expect(request?.tools.some((tool) => tool.name === 'recall_recap')).toBe(false);

    expect(sqlResult(fixture, 'recall-schema').rows).toEqual([
      [mainId, 'main', '主对话', 'summary from recap-tie-z'],
    ]);
    const current = sqlResult(fixture, 'recall-current');
    const currentText = JSON.stringify(current);
    expect(currentText).toContain('seed response');
    expect(currentText).toContain('ORCHID old');
    expect(currentText).not.toContain('OTHER-THREAD-SECRET');
    expect(currentText).not.toContain('child secret');
    expect(current.rows.every((row) => row[1] === 'thread')).toBe(true);
    const assistantRow = current.rows.find((row) => row[0] === assistant.seq);
    const toolRowValue = current.rows.find((row) => row[0] === tool.seq);
    const incompleteToolRow = current.rows.find((row) => row[0] === incompleteTool.seq);
    expect(JSON.parse(assistantRow?.[4] as string)).toEqual([
      {
        id: 'json-complete',
        name: 'bash',
        arguments: { command: 'printf JSON-724', cwd: '/tmp' },
      },
      {
        id: 'json-incomplete',
        name: 'bash',
        arguments_text: '{"command":',
        error: 'incomplete acceptance fixture',
      },
    ]);
    expect(JSON.parse(toolRowValue?.[5] as string)).toEqual({
      tool_call_id: 'json-complete',
      status: 'success',
    });
    expect(JSON.parse(incompleteToolRow?.[5] as string)).toEqual({
      tool_call_id: 'json-incomplete',
      status: 'error',
      error: { code: 'incomplete_call', message: 'incomplete acceptance fixture' },
    });
    expect(sqlResult(fixture, 'recall-sources').rows).toEqual([
      [alpha.seq, 'thread', 'ORCHID old'],
      [beta.seq, 'thread', 'VELVET current'],
    ]);
    expect(sqlResult(fixture, 'recall-cross-run-auth').rows).toEqual([[0, 1, 0, 0]]);
    expect(
      z
        .array(z.object({ agent_id: z.string() }))
        .parse(fixture.database.prepare('SELECT agent_id FROM runs').all())
        .every((run) => run.agent_id === 'thread'),
    ).toBe(true);

    new ContextStore(fixture.database).revise({
      threadId: mainId,
      agentId: 'thread',
      seq: alpha.seq,
      content: 'ORCHID revised current',
    });
    fixture.database
      .prepare('UPDATE context_messages SET superseded_by_run_id = ? WHERE seq = ?')
      .run(queried.runId, beta.seq);
    const revised = await sendMessage(fixture, mainId, 'query revisions', 'recall-query-revisions');
    await waitRun(fixture, mainId, revised.runId, RunStatus.COMPLETED);
    expect(sqlResult(fixture, 'recall-after-revision').rows).toEqual([
      ['ORCHID revised current', 'old root summary', 0, 0],
    ]);
    expect(
      fixture.database.prepare('SELECT content FROM context_messages WHERE seq = ?').get(beta.seq),
    ).toEqual({
      content: 'VELVET current',
    });
    expect(
      fixture.database
        .prepare('SELECT content FROM context_message_revisions WHERE message_seq = ?')
        .all(alpha.seq),
    ).toEqual([{ content: 'ORCHID revised current' }]);

    const taskRun = await sendMessage(fixture, taskId, 'query own scope', 'recall-query-task');
    await waitRun(fixture, taskId, taskRun.runId, RunStatus.COMPLETED);
    expect(sqlResult(fixture, 'recall-task-scope').rows).toEqual([['task', null]]);
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it('rejects writes and expensive SQL while preserving data, bounded results and continuation over HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-recall-limits-'));
  const provider = new ScriptedProvider([
    response('unused', [
      recallCall('deny-insert', "INSERT INTO context(thread_id) VALUES ('forbidden')"),
      recallCall('deny-ddl', 'CREATE TABLE forbidden_recall_table(value TEXT)'),
      recallCall('deny-pragma', 'PRAGMA table_info(context)'),
      recallCall('deny-multi', 'SELECT 1; SELECT 2'),
      recallCall(
        'deny-attach',
        `ATTACH DATABASE '${join(directory, 'attached.sqlite')}' AS forbidden`,
      ),
      recallCall('deny-extension', "SELECT load_extension('/private/forbidden.dylib')"),
      recallCall('deny-sentinel', 'DROP TABLE recall_write_sentinel'),
      recallCall('deny-physical', 'SELECT * FROM context_messages'),
      recallCall('deny-revisions', 'SELECT * FROM context_message_revisions'),
      recallCall('deny-runs', 'SELECT * FROM runs'),
      recallCall('deny-schema', 'SELECT * FROM sqlite_master'),
      recallCall('query-error', 'SELECT missing_column FROM context'),
      recallCall(
        'query-timeout',
        `WITH RECURSIVE series(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM series
        ) SELECT sum(value) FROM series`,
      ),
      recallCall('large-integers', 'SELECT 9223372036854775807, 9007199254740991'),
      recallCall('row-first', 'SELECT seq FROM context WHERE seq <= 4 ORDER BY seq'),
      recallCall('row-rest', 'SELECT seq FROM context WHERE seq > 2 AND seq <= 4 ORDER BY seq'),
      recallCall('cell-first', 'SELECT content, length(content) FROM context WHERE seq = 1'),
      recallCall(
        'cell-rest',
        'SELECT substr(content, 9), length(content) FROM context WHERE seq = 1',
      ),
      recallCall('json-first', 'SELECT tool_calls_json FROM context WHERE seq = 5'),
      recallCall('json-rest', 'SELECT substr(tool_calls_json, 9, 8) FROM context WHERE seq = 5'),
      recallCall(
        'response-limit',
        `WITH RECURSIVE series(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM series WHERE value < 100
        ) SELECT printf('%0300d', value) AS content FROM series ORDER BY value`,
      ),
    ]),
    response('limited queries completed'),
    response('unused', [recallCall('after-timeout', 'SELECT 1 AS alive')]),
    response('server remains responsive'),
  ]);
  const fixture = await startRecallFixture(directory, provider, {
    timeoutMs: 2000,
    maxRows: 2,
    maxCellCharacters: 8,
    maxResponseBytes: 1024,
  });
  try {
    await mainThread(fixture);
    const context = new ContextStore(fixture.database);
    for (const content of ['ABCDEFGHIJKL', 'row two', 'row three', 'row four']) {
      context.append({
        threadId: await mainThread(fixture),
        agentId: 'thread',
        message: { role: 'user', content },
      });
    }
    context.append({
      threadId: await mainThread(fixture),
      agentId: 'thread',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'long-json', name: 'bash', arguments: { command: 'echo 1234567890' } }],
      },
    });
    fixture.database.exec(
      "CREATE TABLE recall_write_sentinel(value TEXT); INSERT INTO recall_write_sentinel VALUES ('unchanged')",
    );
    const schemaBefore = fixture.database
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all();

    const run = await sendMessage(
      fixture,
      await mainThread(fixture),
      'exercise SQL restrictions',
      'recall-restrictions',
    );
    await waitRun(fixture, await mainThread(fixture), run.runId, RunStatus.COMPLETED);

    for (const callId of [
      'deny-insert',
      'deny-ddl',
      'deny-pragma',
      'deny-multi',
      'deny-attach',
      'deny-extension',
      'deny-sentinel',
      'deny-physical',
      'deny-revisions',
      'deny-runs',
      'deny-schema',
      'query-error',
      'query-timeout',
    ]) {
      const row = toolRow(fixture, callId);
      expect(row.tool_status, callId).toBe('error');
      expect(row.content.length, callId).toBeGreaterThan(0);
      expect(row.content, callId).not.toContain('/private/forbidden.dylib');
      expect(row.content, callId).not.toContain('attached.sqlite');
    }
    expect(toolRow(fixture, 'query-timeout').content).toContain('2000 ms');
    expect(sqlResult(fixture, 'large-integers').rows).toEqual([
      ['9223372036854775807', 9007199254740991],
    ]);
    const firstRows = sqlResult(fixture, 'row-first');
    const remainingRows = sqlResult(fixture, 'row-rest');
    expect(firstRows.rows).toEqual([[1], [2]]);
    expect(firstRows.truncation?.reasons).toEqual(['row_limit']);
    expect(remainingRows.rows).toEqual([[3], [4]]);
    expect(remainingRows.truncated).toBe(false);
    expect([...firstRows.rows, ...remainingRows.rows]).toEqual([[1], [2], [3], [4]]);

    const firstCell = sqlResult(fixture, 'cell-first');
    expect(firstCell.columns).toEqual(['content', 'length(content)']);
    expect(firstCell.rows).toEqual([['ABCDEFGH', 12]]);
    expect(firstCell.truncation).toEqual({
      reasons: ['cell_limit'],
      cells: [
        {
          row_index: 0,
          column_index: 0,
          column: 'content',
          original_length: 12,
          next_read_position: 9,
        },
      ],
    });
    expect(sqlResult(fixture, 'cell-rest').rows).toEqual([['IJKL', 12]]);

    const firstJson = sqlResult(fixture, 'json-first');
    expect(firstJson.truncation?.reasons).toEqual(['cell_limit']);
    expect(firstJson.truncation?.cells?.[0]).toMatchObject({
      row_index: 0,
      column_index: 0,
      column: 'tool_calls_json',
    });
    expect(() => JSON.parse(firstJson.rows[0]?.[0] as string)).toThrow();
    const fullJson = z
      .object({ tool_calls_json: z.string() })
      .parse(
        fixture.database
          .prepare('SELECT tool_calls_json FROM context_messages WHERE seq = 5')
          .get(),
      ).tool_calls_json;
    expect(firstJson.rows[0]?.[0]).toBe(fullJson.slice(0, 8));
    expect(sqlResult(fixture, 'json-rest').rows).toEqual([[fullJson.slice(8, 16)]]);

    const bounded = sqlResult(fixture, 'response-limit');
    expect(bounded.truncation?.reasons).toEqual(['cell_limit']);
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(1024);
    expect(
      fixture.database
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all(),
    ).toEqual(schemaBefore);
    expect(fixture.database.prepare('SELECT * FROM recall_write_sentinel').all()).toEqual([
      { value: 'unchanged' },
    ]);
    await expect(stat(join(directory, 'attached.sqlite'))).rejects.toThrow();

    const healthy = await sendMessage(
      fixture,
      await mainThread(fixture),
      'check server health',
      'recall-after-timeout',
    );
    await waitRun(fixture, await mainThread(fixture), healthy.runId, RunStatus.COMPLETED);
    expect(sqlResult(fixture, 'after-timeout').rows).toEqual([[1]]);
    expect(terminalStatuses).toContain(
      (await fixture.clients.thread.getThread({ threadId: await mainThread(fixture) })).snapshot
        ?.runs[0]?.status,
    );
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it('bounds the complete JSON response and keeps the Server responsive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-recall-response-limit-'));
  const provider = new ScriptedProvider([
    response('unused', [
      recallCall(
        'total-response-limit',
        `WITH RECURSIVE series(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM series WHERE value < 100
        ) SELECT printf('%0300d', value) AS content FROM series ORDER BY value`,
      ),
    ]),
    response('response limit completed'),
  ]);
  const fixture = await startRecallFixture(directory, provider, {
    maxResponseBytes: 1024,
    maxCellCharacters: 1000,
  });
  try {
    const mainId = await mainThread(fixture);
    const run = await sendMessage(fixture, mainId, 'limit the response', 'recall-response-limit');
    await waitRun(fixture, mainId, run.runId, RunStatus.COMPLETED);
    const result = sqlResult(fixture, 'total-response-limit');
    expect(result.truncated).toBe(true);
    expect(result.truncation?.reasons).toContain('response_limit');
    expect(result.rows.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1024);
    expect(
      (await fixture.clients.thread.getThread({ threadId: mainId })).snapshot?.thread?.threadId,
    ).toBe(mainId);
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('cancels an executing recall through Connect and releases it for later HTTP queries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-recall-cancel-'));
  const provider = new ControlledProvider();
  const fixture = await startRecallFixture(directory, provider, { timeoutMs: 10_000 });
  try {
    const mainId = await mainThread(fixture);
    provider.respond(
      'user:cancel expensive recall',
      response('unused', [
        recallCall(
          'cancel-recall',
          `WITH RECURSIVE series(value) AS (
            SELECT 1 UNION ALL SELECT value + 1 FROM series
          ) SELECT sum(value) FROM series`,
        ),
      ]),
    );
    provider.register('tool:cancel-recall', response('must not complete'));
    const cancelled = await sendMessage(
      fixture,
      mainId,
      'cancel expensive recall',
      'recall-cancel-run',
    );
    await vi.waitFor(() => {
      expect(
        fixture.database
          .prepare(
            "SELECT count(*) AS count FROM context_tool_calls WHERE call_id = 'cancel-recall'",
          )
          .get(),
      ).toEqual({ count: 1 });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fixture.clients.runs.cancelRun({
      clientActionId: 'recall-cancel-request',
      threadId: mainId,
      runId: cancelled.runId,
      reason: 'SQL recall acceptance cancellation',
    });
    await waitRun(fixture, mainId, cancelled.runId, RunStatus.CANCELLED);
    expect(toolRow(fixture, 'cancel-recall')).toMatchObject({
      tool_status: 'error',
      tool_error_json: expect.stringContaining('cancelled'),
    });

    provider.respond(
      'user:query after cancellation',
      response('unused', [recallCall('after-cancel', 'SELECT 1 AS alive')]),
    );
    provider.respond('tool:after-cancel', response('cancellation released resources'));
    const healthy = await sendMessage(
      fixture,
      mainId,
      'query after cancellation',
      'recall-after-cancel',
    );
    await waitRun(fixture, mainId, healthy.runId, RunStatus.COMPLETED);
    expect(sqlResult(fixture, 'after-cancel').rows).toEqual([[1]]);
    expect(
      (await fixture.clients.thread.getThread({ threadId: mainId })).snapshot?.thread?.threadId,
    ).toBe(mainId);
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
