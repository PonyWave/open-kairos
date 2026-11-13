import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DetailedModelUsage,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from '@kairos/agent-core';
import { CompactContextStatus, RunStatus } from '@kairos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import {
  closeSlashFixture,
  createSlashThread,
  type SlashFixture,
  sendSlashMessage,
  startSlashFixture,
  systemText,
  waitSlashRun,
} from './compact-fixture.js';
import { type RealModelConfig, readRealModelConfig } from './real-model-config.js';

const enabled = process.env.KAIROS_RUN_REAL_MODEL === '1';
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const reloadCheck = 'real_workspace_reload_agents_and_skill';
const compactCheck = 'real_manual_compact_and_following_request';

interface RequestUsage {
  kind: 'normal' | 'recap';
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number | null;
  cache_evidence: 'provider_reported_cached_tokens' | 'provider_omitted_cached_tokens';
}

interface SlashAcceptanceReport {
  version: 1;
  status: 'passed' | 'failed';
  model: { providerId: 'openai-compatible'; modelId: string };
  environment: { platform: string; arch: string; node: string };
  command: 'bash scripts/real-model.sh slash-commands';
  temporary_workspace: true;
  checks: Record<string, 'passed' | 'failed'>;
  requests: RequestUsage[];
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  resource_snapshots: { v1: string; v2: string } | null;
  manual_compaction: {
    status: 'changed';
    read_through_seq: number;
    recap_count: number;
    below_automatic_threshold: boolean;
  } | null;
  evidence: {
    reloaded_agents_in_next_request: boolean;
    reloaded_skill_in_next_request: boolean;
    model_used_reloaded_resources: boolean;
    original_context_preserved: boolean;
    original_input_replaced_in_next_request: boolean;
    following_request_used_recaps: boolean;
    following_request_used_v2_resources: boolean;
    no_new_input_or_run_from_compact: boolean;
  };
  failures: string[];
  unverified: string[];
}

const report: SlashAcceptanceReport = {
  version: 1,
  status: 'failed',
  model: { providerId: 'openai-compatible', modelId: '' },
  environment: { platform: process.platform, arch: process.arch, node: process.version },
  command: 'bash scripts/real-model.sh slash-commands',
  temporary_workspace: true,
  checks: {},
  requests: [],
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  resource_snapshots: null,
  manual_compaction: null,
  evidence: {
    reloaded_agents_in_next_request: false,
    reloaded_skill_in_next_request: false,
    model_used_reloaded_resources: false,
    original_context_preserved: false,
    original_input_replaced_in_next_request: false,
    following_request_used_recaps: false,
    following_request_used_v2_resources: false,
    no_new_input_or_run_from_compact: false,
  },
  failures: [],
  unverified: [reloadCheck, compactCheck],
};

function requestKind(request: ModelRequest): 'normal' | 'recap' {
  const last = request.messages.at(-1);
  return last?.role === 'user' && last.content.startsWith('Kairos internal Recap operation;')
    ? 'recap'
    : 'normal';
}

function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [value, replacement] of [
    [process.env.KAIROS_MODEL_API_KEY, '[redacted-api-key]'],
    [process.env.KAIROS_MODEL_BASE_URL, '[redacted-provider-url]'],
    [process.env.KAIROS_MODEL_ID, '[redacted-model-id]'],
    [process.env.KAIROS_SLASH_TEST_DIRECTORY, '[redacted-temporary-directory]'],
  ] as const) {
    if (value) message = message.replaceAll(value, replacement);
  }
  return message.replaceAll(/[\r\n]+/g, ' ').slice(0, 500);
}

function recordFailure(stage: string, error: unknown): void {
  report.status = 'failed';
  report.failures.push(`${stage}: ${safeError(error)}`);
}

function recordUsage(kind: 'normal' | 'recap', usage: DetailedModelUsage): void {
  const total = usage.total_tokens ?? usage.input_tokens + usage.output_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  report.requests.push({
    kind,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: total,
    cached_tokens: cached ?? null,
    cache_evidence:
      cached === undefined ? 'provider_omitted_cached_tokens' : 'provider_reported_cached_tokens',
  });
  report.usage.input_tokens += usage.input_tokens;
  report.usage.output_tokens += usage.output_tokens;
  report.usage.total_tokens += total;
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
  const requests: Array<{ kind: 'normal' | 'recap'; request: ModelRequest }> = [];
  const provider: ModelProvider = {
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      const kind = requestKind(request);
      requests.push({ kind, request: structuredClone(request) });
      for await (const event of source.stream(request, signal)) {
        if (
          (event.type === 'response' || event.type === 'stream_interrupted') &&
          event.usage !== undefined
        ) {
          recordUsage(kind, event.usage);
        }
        yield event;
      }
    },
  };
  return { source, provider, requests };
}

type RealSlashFixture = SlashFixture & {
  tracked: ReturnType<typeof trackedProvider>;
};

async function startRealFixture(
  directory: string,
  workspace: string,
  config: RealModelConfig,
): Promise<RealSlashFixture> {
  const tracked = trackedProvider(config);
  const fixture = await startSlashFixture(directory, {
    provider: tracked.provider,
    providerId: 'openai-compatible',
    modelId: config.modelId,
    contextWindowTokens: config.contextWindow,
    outputReserveTokens: config.outputReserve,
    countTokens: (request) => tracked.source.estimateRequestTokens(request),
    workspaceDirectory: workspace,
    periodicRecap: { triggerMessages: 1000, idleAfterMs: 0, maxMessages: 20 },
  });
  return { ...fixture, tracked };
}

const realState: {
  directory?: string;
  workspace?: string;
  fixture?: RealSlashFixture;
  threadId?: string;
  firstRunId?: string;
  originalPrompt?: string;
  v1SnapshotId?: string;
  v2SnapshotId?: string;
  countsBeforeCompact?: { inputs: number; runs: number; context: number };
} = {};

function requiredState() {
  if (
    !realState.fixture ||
    !realState.threadId ||
    !realState.firstRunId ||
    !realState.originalPrompt ||
    !realState.v2SnapshotId ||
    !realState.countsBeforeCompact
  ) {
    throw new Error('The real workspace reload check did not initialize compact acceptance state.');
  }
  return realState as typeof realState & {
    fixture: RealSlashFixture;
    threadId: string;
    firstRunId: string;
    originalPrompt: string;
    v2SnapshotId: string;
    countsBeforeCompact: { inputs: number; runs: number; context: number };
  };
}

async function runReloadCheck(config: RealModelConfig): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-real-slash-commands-'));
  const workspace = join(directory, 'safe-workspace');
  realState.directory = directory;
  realState.workspace = workspace;
  process.env.KAIROS_SLASH_TEST_DIRECTORY = directory;
  await mkdir(join(workspace, '.agents', 'skills', 'acceptance'), { recursive: true });
  await mkdir(join(workspace, '.kairos'), { recursive: true });
  await writeFile(join(workspace, '.kairos', 'AGENTS.md'), 'Version 1 acceptance resource.');
  await writeFile(
    join(workspace, '.agents', 'skills', 'acceptance', 'SKILL.md'),
    'Version 1 acceptance Skill.',
  );
  const fixture = await startRealFixture(directory, workspace, config);
  realState.fixture = fixture;
  const threadId = await createSlashThread(fixture, 'real-slash-command-thread');
  realState.threadId = threadId;
  const initial = await fixture.clients.workspace.reloadResources({
    threadId,
    clientActionId: 'real-slash-initial-v1',
  });
  realState.v1SnapshotId = initial.snapshotId;
  await writeFile(
    join(workspace, '.kairos', 'AGENTS.md'),
    'When the user requests the workspace acceptance response, reply exactly RELOAD-V2-AGENTS-OK and include the Skill marker.',
  );
  await writeFile(
    join(workspace, '.agents', 'skills', 'acceptance', 'SKILL.md'),
    'For the workspace acceptance response, append exactly RELOAD-V2-SKILL-OK. Do not call tools.',
  );
  const reloaded = await fixture.clients.workspace.reloadResources({
    threadId,
    clientActionId: 'real-slash-reload-v2',
  });
  expect(reloaded.changed).toBe(true);
  expect(reloaded.resources).toEqual(['.agents/skills/acceptance/SKILL.md', 'AGENTS.md']);
  expect(reloaded.updated).toEqual(['.agents/skills/acceptance/SKILL.md', 'AGENTS.md']);
  expect(reloaded.snapshotId).not.toBe(initial.snapshotId);
  realState.v2SnapshotId = reloaded.snapshotId;
  report.resource_snapshots = { v1: initial.snapshotId, v2: reloaded.snapshotId };
  const originalPrompt =
    'Request the workspace acceptance response from the current AGENTS and Skill resources. Reply only with their two required markers.';
  realState.originalPrompt = originalPrompt;
  const first = await sendSlashMessage(
    fixture,
    threadId,
    originalPrompt,
    'real-slash-reloaded-input',
  );
  realState.firstRunId = first.runId;
  await waitSlashRun(fixture, threadId, first.runId, RunStatus.COMPLETED, 180_000);
  const normalRequest = fixture.tracked.requests.find((request) => request.kind === 'normal');
  if (!normalRequest) throw new Error('The real reloaded resource request is missing.');
  const instructions = systemText(normalRequest.request);
  report.evidence.reloaded_agents_in_next_request = instructions.includes('RELOAD-V2-AGENTS-OK');
  report.evidence.reloaded_skill_in_next_request = instructions.includes('RELOAD-V2-SKILL-OK');
  expect(report.evidence.reloaded_agents_in_next_request).toBe(true);
  expect(report.evidence.reloaded_skill_in_next_request).toBe(true);
  expect(instructions).not.toContain('Version 1 acceptance resource.');
  expect(instructions).not.toContain('Version 1 acceptance Skill.');
  const snapshot = await fixture.clients.thread.getThread({ threadId });
  const response = snapshot.snapshot?.messages.find(
    (message) => message.runId === first.runId && message.role === 3,
  );
  report.evidence.model_used_reloaded_resources =
    response?.content.includes('RELOAD-V2-AGENTS-OK') === true &&
    response.content.includes('RELOAD-V2-SKILL-OK');
  expect(report.evidence.model_used_reloaded_resources).toBe(true);
  realState.countsBeforeCompact = {
    inputs: snapshot.snapshot?.inputs.length ?? 0,
    runs: snapshot.snapshot?.runs.length ?? 0,
    context: snapshot.snapshot?.messages.length ?? 0,
  };
  report.checks[reloadCheck] = 'passed';
  report.unverified = report.unverified.filter((check) => check !== reloadCheck);
}

async function runCompactCheck(): Promise<void> {
  const state = requiredState();
  const { fixture, threadId, originalPrompt, countsBeforeCompact } = state;
  const compacted = await fixture.clients.context.compactContext({
    threadId,
    clientActionId: 'real-slash-manual-compact',
  });
  expect(compacted.status).toBe(CompactContextStatus.CHANGED);
  expect(compacted.recapIds.length).toBeGreaterThan(0);
  const afterCompact = await fixture.clients.thread.getThread({ threadId });
  const currentCounts = {
    inputs: afterCompact.snapshot?.inputs.length ?? 0,
    runs: afterCompact.snapshot?.runs.length ?? 0,
    context: afterCompact.snapshot?.messages.length ?? 0,
  };
  report.evidence.no_new_input_or_run_from_compact =
    currentCounts.inputs === countsBeforeCompact.inputs &&
    currentCounts.runs === countsBeforeCompact.runs &&
    currentCounts.context === countsBeforeCompact.context;
  expect(report.evidence.no_new_input_or_run_from_compact).toBe(true);
  const operation = z
    .object({
      estimated_input_tokens: z.number(),
      context_window_tokens: z.number(),
      hard_cut: z.number(),
    })
    .parse(
      fixture.database
        .prepare(
          `SELECT estimated_input_tokens, context_window_tokens, hard_cut
           FROM model_request_records WHERE request_id = ?`,
        )
        .get(compacted.operationId),
    );
  report.manual_compaction = {
    status: 'changed',
    read_through_seq: Number(compacted.readThroughSeq),
    recap_count: compacted.recapIds.length,
    below_automatic_threshold:
      operation.estimated_input_tokens * 5 <= operation.context_window_tokens * 4,
  };
  expect(operation.hard_cut).toBe(1);
  expect(report.manual_compaction.below_automatic_threshold).toBe(true);
  const audit = await fixture.clients.context.readContext({
    threadId,
    agentId: 'thread',
    afterSeq: 0n,
    limit: 100,
  });
  report.evidence.original_context_preserved = audit.messages.some(
    (message) => message.content === originalPrompt,
  );
  expect(report.evidence.original_context_preserved).toBe(true);
  const second = await sendSlashMessage(
    fixture,
    threadId,
    'Reply exactly POST-COMPACT-OK. Do not call tools.',
    'real-slash-after-compact',
  );
  await waitSlashRun(fixture, threadId, second.runId, RunStatus.COMPLETED, 180_000);
  const normalRequests = fixture.tracked.requests.filter((request) => request.kind === 'normal');
  const following = normalRequests.at(-1)?.request;
  if (!following) throw new Error('The real post-compact request is missing.');
  report.evidence.original_input_replaced_in_next_request = !following.messages.some(
    (message) => message.content === originalPrompt,
  );
  report.evidence.following_request_used_recaps = compacted.recapIds.every((recapId) =>
    following.messages.some((message) => message.content.includes(recapId)),
  );
  const followingSystem = systemText(following);
  report.evidence.following_request_used_v2_resources =
    followingSystem.includes('RELOAD-V2-AGENTS-OK') &&
    followingSystem.includes('RELOAD-V2-SKILL-OK');
  expect(report.evidence.original_input_replaced_in_next_request).toBe(true);
  expect(report.evidence.following_request_used_recaps).toBe(true);
  expect(report.evidence.following_request_used_v2_resources).toBe(true);
  expect(fixture.tracked.requests.filter((request) => request.kind === 'recap')).toHaveLength(2);
  const finalSnapshot = await fixture.clients.thread.getThread({ threadId });
  const finalResponse = finalSnapshot.snapshot?.messages.find(
    (message) => message.runId === second.runId && message.role === 3,
  );
  expect(finalResponse?.content).toContain('POST-COMPACT-OK');
  expect(report.usage.input_tokens).toBeGreaterThan(0);
  expect(report.usage.output_tokens).toBeGreaterThan(0);
  expect(report.usage.total_tokens).toBe(report.usage.input_tokens + report.usage.output_tokens);
  expect(report.requests).toHaveLength(4);
  report.checks[compactCheck] = 'passed';
  report.unverified = report.unverified.filter((check) => check !== compactCheck);
  report.status = 'passed';
}

describe.skipIf(!enabled)('real slash command acceptance', () => {
  let config: RealModelConfig;

  beforeAll(async () => {
    try {
      config = readRealModelConfig();
      report.model.modelId = config.modelId;
      await runReloadCheck(config);
    } catch (error) {
      report.checks[reloadCheck] = 'failed';
      recordFailure('reload', error);
      throw error;
    }
  }, 240_000);

  afterAll(async () => {
    try {
      if (realState.fixture) await closeSlashFixture(realState.fixture);
    } catch (error) {
      recordFailure('close', error);
    }
    if (realState.directory) await rm(realState.directory, { recursive: true, force: true });
    delete process.env.KAIROS_SLASH_TEST_DIRECTORY;
    const reportPath =
      process.env.KAIROS_REAL_MODEL_REPORT ??
      join(repositoryRoot, 'work/slash-commands-real-model-acceptance.json');
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  });

  it('verifies reloaded AGENTS and Skill resources in the next real model request', () => {
    expect(report.checks[reloadCheck]).toBe('passed');
  });

  it('manually compacts below the automatic threshold and completes a normal following request', async () => {
    try {
      await runCompactCheck();
    } catch (error) {
      report.checks[compactCheck] = 'failed';
      recordFailure('compact', error);
      throw error;
    }
  }, 360_000);
});
