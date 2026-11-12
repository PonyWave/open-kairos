import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DetailedModelUsage,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from '@kairos/agent-core';
import { RunStatus } from '@kairos/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ContextStore } from '../context/context-store.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { type SqlRecallResult, sqlRecallResultSchema } from '../recall/types.js';
import { RecapStore } from '../recap/recap-store.js';
import { openDatabase } from '../storage/database.js';
import { closeFixture, networkClients, sendMessage } from './delegation-fixture.js';
import { type RealModelConfig, readRealModelConfig } from './real-model-config.js';
import { createTestServer as createServer } from './test-authentication.js';

const enabled = process.env.KAIROS_RUN_REAL_MODEL === '1';
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const ownerId = 'real-sql-recall-acceptance-owner';
const accessToken = 'real-sql-recall-acceptance-token';
const checkName = 'real_recall_sql_current_json_aggregate_sources_and_authorization';
const queryTypes = [
  'multi_keyword',
  'json',
  'aggregate',
  'source_join',
  'authorization_and_stale',
] as const;
type QueryType = (typeof queryTypes)[number];

interface QueryEvidence {
  call_index: number;
  query_types: QueryType[];
  status: 'success' | 'error' | 'missing';
  row_count: number | null;
  truncated: boolean | null;
}

interface AcceptanceReport {
  version: 1;
  status: 'passed' | 'failed';
  model: { providerId: 'openai-compatible'; modelId: string };
  environment: { platform: string; arch: string; node: string };
  command: 'bash scripts/real-model.sh recall';
  checks: Record<string, 'passed' | 'failed'>;
  actual_recall_call_count: number;
  queries: QueryEvidence[];
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  failures: string[];
  unverified: string[];
}

const report: AcceptanceReport = {
  version: 1,
  status: 'failed',
  model: { providerId: 'openai-compatible', modelId: '' },
  environment: { platform: process.platform, arch: process.arch, node: process.version },
  command: 'bash scripts/real-model.sh recall',
  checks: {},
  actual_recall_call_count: 0,
  queries: [],
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  failures: [],
  unverified: [checkName],
};

const observedResults = new Map<QueryType, SqlRecallResult[]>();

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let safe = message;
  for (const [value, replacement] of [
    [process.env.KAIROS_MODEL_API_KEY, '[redacted-api-key]'],
    [process.env.KAIROS_MODEL_BASE_URL, '[redacted-provider-url]'],
  ] as const) {
    if (value) safe = safe.replaceAll(value, replacement);
  }
  return safe.replaceAll(/[\r\n]+/g, ' ').slice(0, 500);
}

function recordFailure(stage: string, error: unknown): void {
  report.status = 'failed';
  report.failures.push(`${stage}: ${safeError(error)}`);
}

function addUsage(usage: DetailedModelUsage): void {
  report.usage.input_tokens += usage.input_tokens;
  report.usage.output_tokens += usage.output_tokens;
  report.usage.total_tokens += usage.total_tokens ?? usage.input_tokens + usage.output_tokens;
}

function trackedProvider(config: RealModelConfig) {
  const source = new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.modelId,
    contextWindow: config.contextWindow,
    outputReserve: config.outputReserve,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      requests.push(structuredClone(request));
      for await (const event of source.stream(request, signal)) {
        if (
          (event.type === 'response' || event.type === 'stream_interrupted') &&
          event.usage !== undefined
        ) {
          addUsage(event.usage);
        }
        yield event;
      }
    },
  };
  return { source, provider, requests };
}

async function startFixture(directory: string, config: RealModelConfig) {
  const tracked = trackedProvider(config);
  const database = openDatabase(join(directory, 'server.sqlite'));
  const server = createServer(database, false, {
    tenantId: ownerId,
    sessionToken: accessToken,
    model: {
      provider: tracked.provider,
      providerId: 'openai-compatible',
      modelId: config.modelId,
      contextWindowTokens: config.contextWindow,
      outputReserveTokens: config.outputReserve,
      countTokens: (request) => tracked.source.estimateRequestTokens(request),
    },
    periodicRecap: { messageThreshold: 1000, responseWindowMs: 600_000 },
    maxStepsPerRun: 12,
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    database,
    server,
    port: address.port,
    baseUrl,
    clients: networkClients(baseUrl, accessToken),
    tracked,
  };
}

type Fixture = Awaited<ReturnType<typeof startFixture>>;

async function waitRun(fixture: Fixture, threadId: string, runId: string): Promise<void> {
  const terminal = [
    RunStatus.COMPLETED,
    RunStatus.FAILED,
    RunStatus.CANCELLED,
    RunStatus.INTERRUPTED,
  ];
  const readRun = async () => {
    const snapshot = await fixture.clients.thread.getThread({ threadId });
    return snapshot.snapshot?.runs.find((candidate) => candidate.runId === runId);
  };
  await vi.waitFor(
    async () => {
      expect(terminal).toContain((await readRun())?.status);
    },
    { timeout: 180_000 },
  );
  const run = await readRun();
  if (run?.status !== RunStatus.COMPLETED) {
    throw new Error(
      `Real Run ended with status ${run?.status ?? 'missing'}, error ${run?.error?.code ?? 'none'}: ${run?.error?.message ?? 'none'}.`,
    );
  }
  expect(run.usage?.inputTokens ?? 0n).toBeGreaterThan(0n);
  expect(run.usage?.outputTokens ?? 0n).toBeGreaterThan(0n);
}

function classifySql(sql: string): QueryType[] {
  const normalized = sql.toLowerCase();
  const types: QueryType[] = [];
  if (normalized.includes('orchid-current') && normalized.includes('velvet-current')) {
    types.push('multi_keyword');
  }
  if (normalized.includes('tool_calls_json')) types.push('json');
  if (normalized.includes('group by')) types.push('aggregate');
  if (
    normalized.includes('from recap') &&
    normalized.includes('json_each') &&
    normalized.includes('join context')
  ) {
    types.push('source_join');
  }
  if (normalized.includes('other-thread-secret') || normalized.includes('old-recap')) {
    types.push('authorization_and_stale');
  }
  return types;
}

const assistantRowSchema = z.object({
  tool_calls_json: z.string(),
});
const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.unknown(),
});
const toolResultRowSchema = z.object({
  content: z.string(),
  tool_status: z.enum(['success', 'error']).nullable(),
});

function collectQueryEvidence(fixture: Fixture, runIds: readonly string[]): void {
  report.queries = [];
  report.actual_recall_call_count = 0;
  observedResults.clear();
  if (runIds.length === 0) return;
  const placeholders = runIds.map(() => '?').join(',');
  const assistants = z.array(assistantRowSchema).parse(
    fixture.database
      .prepare(
        `SELECT tool_calls_json FROM context_messages
         WHERE agent_id = 'thread' AND role = 'assistant'
           AND run_id IN (${placeholders}) AND tool_calls_json IS NOT NULL
         ORDER BY seq`,
      )
      .all(...runIds),
  );
  for (const assistant of assistants) {
    const calls = z.array(toolCallSchema).parse(JSON.parse(assistant.tool_calls_json));
    for (const call of calls) {
      if (call.name !== 'recall') continue;
      const input = z.object({ sql: z.string() }).strict().parse(call.arguments);
      const resultRow = fixture.database
        .prepare(
          `SELECT content, tool_status FROM context_messages
           WHERE agent_id = 'thread' AND role = 'tool' AND tool_call_id = ?
           ORDER BY seq DESC LIMIT 1`,
        )
        .get(call.id);
      const types = classifySql(input.sql);
      const evidence: QueryEvidence = {
        call_index: report.actual_recall_call_count + 1,
        query_types: types,
        status: 'missing',
        row_count: null,
        truncated: null,
      };
      report.actual_recall_call_count += 1;
      if (resultRow !== undefined) {
        const row = toolResultRowSchema.parse(resultRow);
        evidence.status = row.tool_status ?? 'missing';
        if (row.tool_status === 'success') {
          const result = sqlRecallResultSchema.parse(JSON.parse(row.content));
          evidence.row_count = result.rows.length;
          evidence.truncated = result.truncated;
          for (const type of types) {
            const results = observedResults.get(type) ?? [];
            results.push(result);
            observedResults.set(type, results);
          }
        }
      }
      report.queries.push(evidence);
    }
  }
}

function expectSingleResult(type: QueryType): SqlRecallResult {
  const results = observedResults.get(type) ?? [];
  expect(results, `Missing successful ${type} recall query.`).toHaveLength(1);
  const result = results[0];
  if (!result) throw new Error(`Missing ${type} result.`);
  expect(result.truncated).toBe(false);
  return result;
}

function acceptancePrompt(seedMaxSeq: number, assistantSeq: number): string {
  const statements = [
    `SELECT seq, content FROM context
     WHERE seq <= ${seedMaxSeq}
       AND (content LIKE '%ORCHID-CURRENT%' OR content LIKE '%VELVET-CURRENT%')
     ORDER BY seq`,
    `SELECT json_extract(call.value, '$.id') AS call_id,
            json_extract(call.value, '$.arguments.command') AS command
     FROM context AS c, json_each(c.tool_calls_json) AS call
     WHERE c.seq = ${assistantSeq}`,
    `SELECT role, count(*) AS message_count FROM context
     WHERE seq <= ${seedMaxSeq}
       AND (content LIKE '%ORCHID%' OR content LIKE '%VELVET%')
     GROUP BY role ORDER BY role`,
    `SELECT c.seq, c.agent_id, c.content
     FROM recap AS r
     JOIN json_each(r.source_message_seqs) AS source
     JOIN context AS c ON c.seq = source.value
       AND c.thread_id = r.thread_id AND c.agent_id = r.agent_id
     WHERE r.recap_id = 'real-current-recap'
     ORDER BY c.seq`,
    `SELECT
       (SELECT count(*) FROM context
        WHERE seq <= ${seedMaxSeq} AND content LIKE '%ORCHID-OLD%') AS stale_count,
       (SELECT count(*) FROM context
        WHERE seq <= ${seedMaxSeq} AND content LIKE '%OTHER-THREAD-SECRET%') AS cross_thread_count,
       (SELECT count(*) FROM recap WHERE content LIKE '%OLD-RECAP%') AS stale_recap_count`,
  ];
  return [
    'This is a SQL recall acceptance task. You must actually call recall({sql}) once for each of the five SQL statements below, in the given order. Do not answer from the prompt alone and do not use any old recall_context or recall_recap tool.',
    'Each statement must be executed separately as written. After all five tool results arrive, reply only REAL-SQL-RECALL-OK.',
    ...statements.flatMap((statement, index) => [`Statement ${index + 1}:`, statement]),
  ].join('\n\n');
}

describe.skipIf(!enabled)('real SQL recall acceptance', () => {
  afterAll(async () => {
    const reportPath =
      process.env.KAIROS_REAL_MODEL_REPORT ??
      join(repositoryRoot, 'work/sql-recall-real-model-acceptance.json');
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  });

  it('executes multi-keyword, JSON, aggregate, source and authorization queries with the real model', async () => {
    let config: RealModelConfig;
    try {
      config = readRealModelConfig();
    } catch (error) {
      recordFailure('configuration', error);
      throw error;
    }
    report.model.modelId = config.modelId;
    let directory: string | undefined;
    let fixture: Fixture | undefined;
    const runIds: string[] = [];
    try {
      directory = await mkdtemp(join(tmpdir(), 'kairos-real-sql-recall-'));
      fixture = await startFixture(directory, config);
      const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId;
      const otherId = (
        await fixture.clients.thread.createThread({
          clientActionId: 'real-recall-create-other',
          title: 'Real SQL recall other Thread',
        })
      ).thread?.threadId;
      if (!mainId || !otherId) throw new Error('The real recall Threads are missing.');

      const context = new ContextStore(fixture.database);
      const alpha = context.append({
        messageId: 'real-recall-alpha',
        threadId: mainId,
        agentId: 'thread',
        message: { role: 'user', content: 'ORCHID-OLD' },
        createdAt: '2026-11-03T01:00:00.000Z',
      });
      const child = context.append({
        threadId: mainId,
        agentId: 'subagent-real-fixture',
        message: { role: 'user', content: 'INTERLEAVED-CHILD' },
        createdAt: '2026-11-03T01:01:00.000Z',
      });
      const beta = context.append({
        threadId: mainId,
        agentId: 'thread',
        message: { role: 'user', content: 'VELVET-CURRENT' },
        createdAt: '2026-11-03T01:02:00.000Z',
      });
      const assistant = context.append({
        threadId: mainId,
        agentId: 'thread',
        message: {
          role: 'assistant',
          content: 'JSON acceptance tool call',
          tool_calls: [
            {
              id: 'real-json-call',
              name: 'bash',
              arguments: { command: 'printf JSON-724' },
            },
          ],
        },
        createdAt: '2026-11-03T01:03:00.000Z',
      });
      context.append({
        threadId: mainId,
        agentId: 'thread',
        message: {
          role: 'tool',
          content: 'JSON-724 result',
          tool_call_id: 'real-json-call',
          tool_name: 'bash',
          status: 'success',
        },
        createdAt: '2026-11-03T01:04:00.000Z',
      });
      const other = context.append({
        threadId: otherId,
        agentId: 'thread',
        message: { role: 'user', content: 'OTHER-THREAD-SECRET' },
        createdAt: '2026-11-03T01:05:00.000Z',
      });
      const recaps = new RecapStore(fixture.database);
      recaps.save({
        recapId: 'real-old-recap',
        threadId: mainId,
        agentId: 'thread',
        sourceMessageSeqs: [alpha.seq],
        content: 'OLD-RECAP',
        createdAt: '2026-11-03T02:00:00.000Z',
      });
      context.revise({
        threadId: mainId,
        agentId: 'thread',
        seq: alpha.seq,
        content: 'ORCHID-CURRENT',
      });
      recaps.save({
        recapId: 'real-current-recap',
        threadId: mainId,
        agentId: 'thread',
        sourceMessageSeqs: [alpha.seq, beta.seq],
        content: 'CURRENT-RECAP',
        createdAt: '2026-11-03T03:00:00.000Z',
      });
      expect(child.seq).toBeGreaterThan(alpha.seq);
      expect(child.seq).toBeLessThan(beta.seq);
      expect(other.seq).toBeGreaterThan(beta.seq);
      const seedMaxSeq = other.seq;

      const sent = await sendMessage(
        fixture,
        mainId,
        acceptancePrompt(seedMaxSeq, assistant.seq),
        'real-sql-recall-input',
      );
      runIds.push(sent.runId);
      await waitRun(fixture, mainId, sent.runId);
      collectQueryEvidence(fixture, runIds);

      expect(fixture.tracked.requests.length).toBeGreaterThanOrEqual(2);
      const registered = fixture.tracked.requests[0]?.tools ?? [];
      expect(registered.filter((tool) => tool.name === 'recall')).toHaveLength(1);
      expect(registered.some((tool) => tool.name === 'recall_context')).toBe(false);
      expect(registered.some((tool) => tool.name === 'recall_recap')).toBe(false);
      expect(report.actual_recall_call_count).toBe(5);
      for (const type of queryTypes) {
        expect(
          report.queries.filter((query) => query.query_types.includes(type)),
          `The real model did not execute ${type}.`,
        ).toHaveLength(1);
      }
      expect(report.queries.every((query) => query.status === 'success')).toBe(true);
      expect(expectSingleResult('multi_keyword').rows).toEqual([
        [alpha.seq, 'ORCHID-CURRENT'],
        [beta.seq, 'VELVET-CURRENT'],
      ]);
      expect(expectSingleResult('json').rows).toEqual([['real-json-call', 'printf JSON-724']]);
      expect(expectSingleResult('aggregate').rows).toEqual([['user', 2]]);
      expect(expectSingleResult('source_join').rows).toEqual([
        [alpha.seq, 'thread', 'ORCHID-CURRENT'],
        [beta.seq, 'thread', 'VELVET-CURRENT'],
      ]);
      expect(expectSingleResult('authorization_and_stale').rows).toEqual([[0, 1, 0]]);
      expect(report.usage.input_tokens).toBeGreaterThan(0);
      expect(report.usage.output_tokens).toBeGreaterThan(0);
      expect(report.usage.total_tokens).toBe(
        report.usage.input_tokens + report.usage.output_tokens,
      );

      report.checks[checkName] = 'passed';
      report.unverified = report.unverified.filter((candidate) => candidate !== checkName);
      report.status = 'passed';
    } catch (error) {
      report.checks[checkName] = 'failed';
      recordFailure('execution', error);
      throw error;
    } finally {
      if (fixture?.database.isOpen) {
        try {
          collectQueryEvidence(fixture, runIds);
        } catch (error) {
          recordFailure('evidence', error);
        }
        await closeFixture(fixture);
      }
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }, 600_000);
});
