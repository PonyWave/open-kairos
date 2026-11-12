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
import { InputMode, RunStatus } from '@kairos/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { openDatabase } from '../storage/database.js';
import { closeFixture, networkClients } from './delegation-fixture.js';
import { readRealModelConfig } from './real-model-config.js';
import {
  type CapturedModelRequest,
  expectCompletePrefix,
  recapMappings,
} from './recap-periodic-fixture.js';
import { createTestServer as createServer } from './test-authentication.js';

const enabled = process.env.KAIROS_RUN_REAL_MODEL === '1';
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const ownerId = 'real-periodic-recap-acceptance-owner';
const accessToken = 'real-periodic-recap-acceptance-token';

const capturedBodySchema = z
  .object({
    model: z.string(),
    messages: z.array(z.record(z.string(), z.unknown())),
    tools: z.array(z.record(z.string(), z.unknown())),
    max_tokens: z.number().int().positive(),
    stream: z.literal(true),
    stream_options: z.object({ include_usage: z.literal(true) }),
  })
  .passthrough();

type RealCapturedRequest = CapturedModelRequest & {
  estimatedInputTokens?: number;
  usage?: DetailedModelUsage;
};

interface UsageReport {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  cache_reported: boolean;
}

interface AcceptanceReport {
  version: 1;
  status: 'passed' | 'failed';
  model: { providerId: 'openai-compatible'; modelId: string };
  environment: { platform: string; arch: string; node: string };
  command: string;
  checks: Record<string, 'passed' | 'failed'>;
  requests: Array<{
    request_id: string;
    operation: 'normal' | 'periodic_recap' | 'hard_cut_recap';
    message_count: number;
    provider_estimated_input_tokens: number;
    provider_max_tokens: number;
    source_mappings: Array<{ seq: number; message_index: number }>;
    usage: UsageReport;
  }>;
  recaps: Array<{
    recap_id: string;
    operation_id: string;
    source_message_seqs: number[];
    provider_estimated_content_tokens: number;
    view_version: number | null;
  }>;
  hard_cut_budget: {
    context_window_tokens: number;
    output_reserve_tokens: number;
    forced_estimated_input_tokens: number;
    final_estimated_input_tokens: number;
    provider_max_tokens: number;
  } | null;
  usage: UsageReport;
  cache_evidence: 'provider_reported_cached_tokens' | 'prefix_equality_only';
  failures: string[];
  unverified: string[];
}

const report: AcceptanceReport = {
  version: 1,
  status: 'failed',
  model: { providerId: 'openai-compatible', modelId: '' },
  environment: { platform: process.platform, arch: process.arch, node: process.version },
  command: 'bash scripts/real-model.sh recap',
  checks: {},
  requests: [],
  recaps: [],
  hard_cut_budget: null,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
    cache_reported: false,
  },
  cache_evidence: 'prefix_equality_only',
  failures: [],
  unverified: [
    'real_periodic_prefix_sources_usage_and_context',
    'real_hard_cut_incremental_reuse_fallback_and_budget',
    'provider_cache_read_hit',
  ],
};

function safeError(error: unknown): string {
  const secret = process.env.KAIROS_MODEL_API_KEY;
  const message = error instanceof Error ? error.message : String(error);
  return (secret ? message.replaceAll(secret, '[redacted]') : message)
    .replaceAll(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

function recordFailure(stage: string, error: unknown): void {
  report.status = 'failed';
  report.failures.push(`${stage}: ${safeError(error)}`);
}

function usageReport(usage: DetailedModelUsage): UsageReport {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
    cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cache_reported: usage.prompt_tokens_details?.cached_tokens !== undefined,
  };
}

function addUsage(usage: DetailedModelUsage): void {
  report.usage.input_tokens += usage.input_tokens;
  report.usage.output_tokens += usage.output_tokens;
  report.usage.total_tokens += usage.total_tokens ?? usage.input_tokens + usage.output_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined) {
    report.usage.cache_reported = true;
    report.usage.cached_tokens += cached;
  }
}

function assertRecapAcceptanceBudget(contextWindow: number, outputReserve: number): void {
  if (
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isSafeInteger(outputReserve) ||
    outputReserve <= 0 ||
    outputReserve >= contextWindow
  ) {
    throw new Error(
      `Invalid real Recap acceptance fixture budget: contextWindow=${contextWindow}, outputReserve=${outputReserve}.`,
    );
  }
}

function controlledTokenCount(
  request: ModelRequest,
  config: ReturnType<typeof readRealModelConfig>,
  forceHardCut: boolean,
  firstPrompt: string,
  estimatedInputTokens: number,
): number {
  const isRecapGeneration = request.messages
    .at(-1)
    ?.content.startsWith('Kairos internal Recap operation;');
  if (
    forceHardCut &&
    !isRecapGeneration &&
    request.messages.some((message) => message.content === firstPrompt)
  ) {
    return Math.floor((config.contextWindow * 4) / 5) + 1;
  }
  return estimatedInputTokens;
}

function fitsFinalHardCutBudget(
  estimatedInputTokens: number,
  contextWindow: number,
  outputReserve: number,
): boolean {
  return (
    estimatedInputTokens * 5 <= contextWindow * 4 &&
    estimatedInputTokens + outputReserve <= contextWindow
  );
}

function trackedProvider(config: ReturnType<typeof readRealModelConfig>) {
  const requests: RealCapturedRequest[] = [];
  const captureFetch: typeof fetch = (input, init) => {
    if (init?.method === 'POST' && typeof init.body === 'string') {
      const body = capturedBodySchema.parse(JSON.parse(init.body));
      const content = body.messages.at(-1)?.content;
      const kind =
        typeof content === 'string' && content.startsWith('Kairos internal Recap operation;')
          ? 'recap'
          : 'normal';
      requests.push({ id: requests.length + 1, kind, raw: init.body, body });
    }
    return fetch(input, init);
  };
  const source = new OpenAICompatibleProvider(
    {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.modelId,
      contextWindow: config.contextWindow,
      outputReserve: config.outputReserve,
      requestTimeoutMs: config.requestTimeoutMs,
    },
    captureFetch,
  );
  const provider: ModelProvider = {
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      const requestIndex = requests.length;
      const estimatedInputTokens = source.estimateRequestTokens(request);
      try {
        for await (const event of source.stream(request, signal)) {
          if (
            (event.type === 'response' || event.type === 'stream_interrupted') &&
            event.usage !== undefined
          ) {
            const captured = requests[requestIndex];
            if (!captured) throw new Error('The real HTTP request capture is missing.');
            if (captured.usage) throw new Error('The real request reported usage more than once.');
            captured.usage = event.usage;
            addUsage(event.usage);
          }
          yield event;
        }
      } finally {
        const captured = requests[requestIndex];
        if (captured) captured.estimatedInputTokens = estimatedInputTokens;
      }
    },
  };
  return { source, provider, requests };
}

async function startFixture(
  directory: string,
  config: ReturnType<typeof readRealModelConfig>,
  forceHardCut: () => boolean,
  firstPrompt: string,
) {
  assertRecapAcceptanceBudget(config.contextWindow, config.outputReserve);
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
      countTokens: (request) =>
        controlledTokenCount(
          request,
          config,
          forceHardCut(),
          firstPrompt,
          tracked.source.estimateRequestTokens(request),
        ),
    },
    periodicRecap: { messageThreshold: 2, responseWindowMs: 600_000 },
    maxStepsPerRun: 4,
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

async function createThread(fixture: Fixture): Promise<string> {
  const created = await fixture.clients.thread.createThread({
    clientActionId: 'real-periodic-recap-thread',
    title: 'Real periodic Recap acceptance',
  });
  const threadId = created.thread?.threadId;
  if (!threadId) throw new Error('The real periodic Recap Thread was not created.');
  return threadId;
}

async function sendMessage(
  fixture: Fixture,
  threadId: string,
  text: string,
  clientActionId: string,
): Promise<string> {
  const sent = await fixture.clients.messages.sendMessage({
    clientActionId,
    threadId,
    text,
    mode: InputMode.FOLLOW_UP,
  });
  const snapshot = await fixture.clients.thread.getThread({ threadId });
  const run = snapshot.snapshot?.runs.find(
    (candidate) => candidate.parentRunId === undefined && candidate.inputIds.includes(sent.inputId),
  );
  if (!run) throw new Error('The real periodic Recap Run was not created.');
  return run.runId;
}

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

async function waitRecaps(fixture: Fixture, count: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({
        count,
      });
    },
    { timeout: 180_000 },
  );
}

function completeUsage(request: RealCapturedRequest | undefined): DetailedModelUsage {
  if (!request?.usage) throw new Error('The real Provider did not return request usage.');
  expect(Number.isSafeInteger(request.usage.input_tokens)).toBe(true);
  expect(request.usage.input_tokens).toBeGreaterThan(0);
  expect(request.usage.output_tokens).toBeGreaterThan(0);
  expect(request.usage.total_tokens).toBe(request.usage.input_tokens + request.usage.output_tokens);
  return request.usage;
}

function completeEstimate(request: RealCapturedRequest | undefined): number {
  if (request?.estimatedInputTokens === undefined) {
    throw new Error('The real Provider request estimate is missing.');
  }
  expect(Number.isSafeInteger(request.estimatedInputTokens)).toBe(true);
  expect(request.estimatedInputTokens).toBeGreaterThan(0);
  return request.estimatedInputTokens;
}

async function recordCheck(name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.checks[name] = 'passed';
    report.unverified = report.unverified.filter((candidate) => candidate !== name);
  } catch (error) {
    report.checks[name] = 'failed';
    throw error;
  }
}

function recordReportEvidence(fixture: Fixture): void {
  report.requests = fixture.tracked.requests.map((request, index) => ({
    request_id: `request-${String(index + 1).padStart(3, '0')}`,
    operation:
      request.kind === 'normal' ? 'normal' : index === 1 ? 'periodic_recap' : 'hard_cut_recap',
    message_count: request.body.messages.length,
    provider_estimated_input_tokens: completeEstimate(request),
    provider_max_tokens: request.body.max_tokens,
    source_mappings: request.kind === 'recap' ? recapMappings(request) : [],
    usage: usageReport(completeUsage(request)),
  }));
  const recaps = z
    .array(
      z.object({
        content: z.string().min(1),
        source_message_seqs: z.string(),
      }),
    )
    .parse(
      fixture.database
        .prepare('SELECT content, source_message_seqs FROM recaps ORDER BY source_seq_start, rowid')
        .all(),
    );
  const operations = z
    .array(z.object({ view_version: z.number().int().nonnegative() }))
    .parse(
      fixture.database
        .prepare('SELECT view_version FROM recap_generation_operations ORDER BY created_at, rowid')
        .all(),
    );
  report.recaps = recaps.map((recap, index) => ({
    recap_id: `recap-${String(index + 1).padStart(3, '0')}`,
    operation_id:
      index === 0 && operations.length > 0
        ? 'operation-001'
        : `hard-cut-${String(index + 1).padStart(3, '0')}`,
    source_message_seqs: z
      .array(z.number().int().positive())
      .parse(JSON.parse(recap.source_message_seqs)),
    provider_estimated_content_tokens: fixture.tracked.source.estimateTextTokens(recap.content),
    view_version: index === 0 ? (operations[0]?.view_version ?? null) : null,
  }));
  if (report.usage.cached_tokens > 0) {
    report.cache_evidence = 'provider_reported_cached_tokens';
    report.unverified = report.unverified.filter(
      (candidate) => candidate !== 'provider_cache_read_hit',
    );
  }
}

describe('real Recap acceptance budget controls', () => {
  const config: ReturnType<typeof readRealModelConfig> = {
    baseUrl: 'https://controlled.invalid/v1',
    apiKey: 'controlled-test-key',
    modelId: 'controlled-model',
    contextWindow: 128_000,
    outputReserve: 50_000,
    requestTimeoutMs: 120_000,
  };
  const firstPrompt = 'first prompt';

  it('rejects contradictory fixture budgets before starting the Server', () => {
    expect(() => assertRecapAcceptanceBudget(8192, 50_000)).toThrow(
      'Invalid real Recap acceptance fixture budget: contextWindow=8192, outputReserve=50000.',
    );
    expect(() =>
      assertRecapAcceptanceBudget(config.contextWindow, config.outputReserve),
    ).not.toThrow();
  });

  it('forces only the normal request with original history above the 80% threshold', () => {
    const initial: ModelRequest = {
      messages: [
        { role: 'user', content: firstPrompt },
        { role: 'assistant', content: 'first response' },
        { role: 'user', content: 'second prompt' },
      ],
      tools: [],
    };
    const fallback: ModelRequest = {
      messages: [
        { role: 'user', content: firstPrompt },
        { role: 'user', content: 'Kairos internal Recap operation; instruction version 3.' },
      ],
      tools: [],
    };
    expect(controlledTokenCount(initial, config, true, firstPrompt, 100)).toBe(102_401);
    expect(controlledTokenCount(fallback, config, true, firstPrompt, 200)).toBe(200);
    expect(controlledTokenCount(initial, config, false, firstPrompt, 100)).toBe(100);
  });

  it('keeps overlong final estimates visible and rejects both budget violations', () => {
    const finalRequest: ModelRequest = {
      messages: [{ role: 'user', content: 'merged real Recap' }],
      tools: [],
    };
    expect(controlledTokenCount(finalRequest, config, true, firstPrompt, 78_001)).toBe(78_001);
    expect(fitsFinalHardCutBudget(78_000, 128_000, 50_000)).toBe(true);
    expect(fitsFinalHardCutBudget(78_001, 128_000, 50_000)).toBe(false);
    expect(fitsFinalHardCutBudget(801, 1000, 100)).toBe(false);
  });
});

describe.skipIf(!enabled)('real periodic Recap acceptance', () => {
  afterAll(async () => {
    const reportPath =
      process.env.KAIROS_REAL_MODEL_REPORT ??
      join(repositoryRoot, 'work/periodic-recap-real-model-acceptance.json');
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  });

  it('executes periodic generation and hard cut with the real Provider and Connect Server', async () => {
    let config: ReturnType<typeof readRealModelConfig>;
    try {
      config = readRealModelConfig();
    } catch (error) {
      recordFailure('configuration', error);
      throw error;
    }
    report.model.modelId = config.modelId;
    let directory: string | undefined;
    let closableFixture: Fixture | undefined;
    let stage: 'startup' | 'execution' = 'startup';
    let failure: unknown;
    let hasFailure = false;
    let forceHardCut = false;
    const firstPrompt = 'Reply with exactly PERIODIC-REAL-OK. Do not call tools.';
    try {
      directory = await mkdtemp(join(tmpdir(), 'kairos-real-periodic-recap-'));
      const fixture = await startFixture(directory, config, () => forceHardCut, firstPrompt);
      closableFixture = fixture;
      stage = 'execution';
      const threadId = await createThread(fixture);
      const firstRun = await sendMessage(
        fixture,
        threadId,
        firstPrompt,
        'real-periodic-first-input',
      );
      await waitRun(fixture, threadId, firstRun);
      await waitRecaps(fixture, 1);

      await recordCheck('real_periodic_prefix_sources_usage_and_context', async () => {
        const normal = fixture.tracked.requests[0];
        const periodic = fixture.tracked.requests[1];
        if (!normal || !periodic) throw new Error('Expected real normal and periodic requests.');
        expect(normal.kind).toBe('normal');
        expect(periodic.kind).toBe('recap');
        expectCompletePrefix(normal, periodic, 2);
        expect(recapMappings(periodic)).toEqual([
          { seq: 1, message_index: 1 },
          { seq: 2, message_index: 2 },
        ]);
        const periodicUsage = completeUsage(periodic);
        const operation = z
          .object({
            view_version: z.number().int().nonnegative(),
            source_message_seqs_json: z.string(),
            status: z.literal('completed'),
            usage_json: z.string(),
          })
          .parse(
            fixture.database
              .prepare(
                `SELECT view_version, source_message_seqs_json, status, usage_json
                 FROM recap_generation_operations`,
              )
              .get(),
          );
        expect(operation).toEqual({
          view_version: 0,
          source_message_seqs_json: '[1,2]',
          status: 'completed',
          usage_json: JSON.stringify(periodicUsage),
        });
        expect(fixture.database.prepare('SELECT source_message_seqs FROM recaps').get()).toEqual({
          source_message_seqs: '[1,2]',
        });
        const context = z
          .array(z.object({ role: z.string(), content: z.string() }))
          .parse(fixture.database.prepare('SELECT role, content FROM context_messages').all());
        expect(context).toHaveLength(2);
        expect(
          context.some((row) => row.content.includes('Kairos internal Recap operation;')),
        ).toBe(false);
      });

      forceHardCut = true;
      const secondRun = await sendMessage(
        fixture,
        threadId,
        'Reply with exactly HARD-CUT-REAL-OK. Do not call tools.',
        'real-periodic-hard-cut-input',
      );
      await waitRun(fixture, threadId, secondRun);
      await waitRecaps(fixture, 2);

      await recordCheck('real_hard_cut_incremental_reuse_fallback_and_budget', async () => {
        const normal = fixture.tracked.requests[0];
        const fallback = fixture.tracked.requests[2];
        const final = fixture.tracked.requests[3];
        if (!normal || !fallback || !final) {
          throw new Error('Expected real normal, fallback and final requests.');
        }
        expect(fallback.kind).toBe('recap');
        expect(final.kind).toBe('normal');
        expectCompletePrefix(normal, fallback, 3);
        expect(recapMappings(fallback)).toEqual([{ seq: 3, message_index: 3 }]);
        expect(
          z
            .array(z.object({ source_message_seqs: z.string() }))
            .parse(
              fixture.database
                .prepare('SELECT source_message_seqs FROM recaps ORDER BY source_seq_start, rowid')
                .all(),
            ),
        ).toEqual([{ source_message_seqs: '[1,2]' }, { source_message_seqs: '[3]' }]);
        const hardCut = z
          .object({
            estimated_input_tokens: z.number().int().nonnegative(),
            context_window_tokens: z.number().int().positive(),
            output_reserve_tokens: z.number().int().nonnegative(),
            selected_recap_ids_json: z.string(),
            request_json: z.string(),
          })
          .parse(
            fixture.database
              .prepare(
                `SELECT estimated_input_tokens, context_window_tokens, output_reserve_tokens,
                        selected_recap_ids_json, request_json
                 FROM model_request_records WHERE thread_id = ? AND hard_cut = 1`,
              )
              .get(threadId),
          );
        const finalEstimatedInputTokens = completeEstimate(final);
        report.hard_cut_budget = {
          context_window_tokens: hardCut.context_window_tokens,
          output_reserve_tokens: hardCut.output_reserve_tokens,
          forced_estimated_input_tokens: Math.floor((config.contextWindow * 4) / 5) + 1,
          final_estimated_input_tokens: finalEstimatedInputTokens,
          provider_max_tokens: final.body.max_tokens,
        };
        expect(hardCut.context_window_tokens).toBe(config.contextWindow);
        expect(hardCut.output_reserve_tokens).toBe(config.outputReserve);
        expect(hardCut.estimated_input_tokens).toBe(finalEstimatedInputTokens);
        expect(final.body.max_tokens).toBe(config.outputReserve);
        expect(finalEstimatedInputTokens * 5).toBeLessThanOrEqual(config.contextWindow * 4);
        expect(finalEstimatedInputTokens + config.outputReserve).toBeLessThanOrEqual(
          config.contextWindow,
        );
        expect(
          fitsFinalHardCutBudget(
            finalEstimatedInputTokens,
            config.contextWindow,
            config.outputReserve,
          ),
        ).toBe(true);
        expect(JSON.parse(hardCut.selected_recap_ids_json)).toHaveLength(2);
        const finalRequest = z
          .object({ messages: z.array(z.object({ role: z.string(), content: z.string() })) })
          .parse(JSON.parse(hardCut.request_json));
        expect(
          finalRequest.messages.filter((message) => message.content.includes('recap_id:')),
        ).toHaveLength(1);
        expect(JSON.stringify(finalRequest)).not.toContain('Kairos internal Recap operation;');
        expect(final.body.messages).toEqual(finalRequest.messages);
        expect(
          fixture.database.prepare('SELECT COUNT(*) AS count FROM context_messages').get(),
        ).toEqual({ count: 4 });
        expect(
          fixture.database
            .prepare(
              "SELECT COUNT(*) AS count FROM context_messages WHERE content LIKE '%Kairos internal Recap operation;%'",
            )
            .get(),
        ).toEqual({ count: 0 });
        completeUsage(fallback);
        completeUsage(final);
      });
      recordReportEvidence(fixture);
    } catch (error) {
      if (
        closableFixture &&
        report.requests.length === 0 &&
        closableFixture.tracked.requests.length > 0
      ) {
        try {
          recordReportEvidence(closableFixture);
        } catch (evidenceError) {
          recordFailure('evidence', evidenceError);
        }
      }
      recordFailure(stage, error);
      failure = error;
      hasFailure = true;
    } finally {
      if (closableFixture) {
        try {
          await closeFixture(closableFixture);
        } catch (error) {
          recordFailure('close', error);
          if (!hasFailure) {
            failure = error;
            hasFailure = true;
          }
        }
      }
      if (directory) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch (error) {
          recordFailure('cleanup', error);
          if (!hasFailure) {
            failure = error;
            hasFailure = true;
          }
        }
      }
    }
    if (hasFailure) throw failure;
    report.status = 'passed';
  }, 600_000);
});
