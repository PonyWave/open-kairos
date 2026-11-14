import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type {
  DetailedModelUsage,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ToolCall,
} from '@kairos/agent-core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { DelegationKey } from '../context/types.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import type { InteractionRecord, RunRecord, RunStatus } from '../sessions/records.js';
import { SessionStore } from '../sessions/store.js';
import { systemReminderContent } from '../sessions/system-reminder.js';
import {
  closeFixture,
  deferred,
  type Fixture,
  ownerId,
  sendMessage,
  startFixture,
} from './delegation-fixture.js';
import { type RealModelConfig, readRealModelConfig } from './real-model-config.js';

const execFileAsync = promisify(execFile);
const enabled = process.env.KAIROS_RUN_REAL_MODEL === '1';
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const expectedModelId = 'kimi-k2.8-highspeed';
const resultMarker = 'BACKGROUND_GUIDANCE_CONTROLLED_RESULT';
const syntheticCommand = "printf 'BACKGROUND_GUIDANCE_CONTROLLED_RESULT\\n'";
const terminalStatuses: RunStatus[] = ['completed', 'failed', 'cancelled', 'interrupted'];
const proactiveReadNames = new Set(['thread_read', 'task_output']);
const checkNames = [
  'background_delegation_accepted',
  'source_completed_without_proactive_read_or_wait',
  'controlled_environment_operation',
  'target_completed_with_controlled_result',
  'automatic_delivery_to_following_root_run',
  'following_root_run_response',
] as const;
type CheckName = (typeof checkNames)[number];

interface UsageEvidence {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number | null;
  cache_evidence: 'provider_reported_cached_tokens' | 'provider_omitted_cached_tokens';
}

interface BackgroundGuidanceReport {
  version: 1;
  status: 'passed' | 'failed';
  command: 'bash scripts/real-model.sh background-guidance';
  commit: string;
  model: { providerId: 'openai-compatible'; modelId: string };
  environment: { platform: string; arch: string; node: string };
  temporary_data_directory: 'fresh_empty_mkdtemp';
  execution: {
    fastify: 'real';
    sqlite: 'temporary_file';
    environment_policy: 'explicit_and_enforced_by_server';
    operation_gateway: 'ControlledEnvironmentOperations';
    real_device: false;
  };
  checks: Partial<Record<CheckName, 'passed' | 'failed'>>;
  provider_requests: Array<Record<string, unknown>>;
  tool_calls: Array<Record<string, unknown>>;
  delegation: Record<string, unknown> | null;
  delivery: Record<string, unknown> | null;
  runs: Array<Record<string, unknown>>;
  behavior: {
    background_call_seq: number | null;
    proactive_reads: Array<Record<string, unknown>>;
    wait_ms_values: number[];
    source_finished_before_target: boolean | null;
    target_response_contains_result_marker: boolean;
    following_root_response_present: boolean;
    following_root_response_contains_result_marker: boolean;
  };
  operations: Array<Record<string, unknown>>;
  requests_usage: UsageEvidence[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cached_tokens: number | null;
    cached_token_requests: number;
    requests_without_cached_tokens: number;
  };
  failures: string[];
  unverified: string[];
  cleanup: { server_closed: boolean; temporary_directory_removed: boolean };
}

const report: BackgroundGuidanceReport = {
  version: 1,
  status: 'failed',
  command: 'bash scripts/real-model.sh background-guidance',
  commit: '',
  model: { providerId: 'openai-compatible', modelId: '' },
  environment: { platform: process.platform, arch: process.arch, node: process.version },
  temporary_data_directory: 'fresh_empty_mkdtemp',
  execution: {
    fastify: 'real',
    sqlite: 'temporary_file',
    environment_policy: 'explicit_and_enforced_by_server',
    operation_gateway: 'ControlledEnvironmentOperations',
    real_device: false,
  },
  checks: {},
  provider_requests: [],
  tool_calls: [],
  delegation: null,
  delivery: null,
  runs: [],
  behavior: {
    background_call_seq: null,
    proactive_reads: [],
    wait_ms_values: [],
    source_finished_before_target: null,
    target_response_contains_result_marker: false,
    following_root_response_present: false,
    following_root_response_contains_result_marker: false,
  },
  operations: [],
  requests_usage: [],
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cached_tokens: null,
    cached_token_requests: 0,
    requests_without_cached_tokens: 0,
  },
  failures: [],
  unverified: [...checkNames],
  cleanup: { server_closed: false, temporary_directory_removed: false },
};

interface ObservedRequest {
  request: ModelRequest;
  responseToolCalls: ToolCall[];
  usage: DetailedModelUsage | null;
}

class ObservedProvider implements ModelProvider {
  readonly requests: ObservedRequest[] = [];
  readonly source: OpenAICompatibleProvider;

  constructor(config: RealModelConfig) {
    this.source = new OpenAICompatibleProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.modelId,
      contextWindow: config.contextWindow,
      outputReserve: config.outputReserve,
      requestTimeoutMs: config.requestTimeoutMs,
    });
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const observed: ObservedRequest = {
      request: structuredClone(request),
      responseToolCalls: [],
      usage: null,
    };
    this.requests.push(observed);
    for await (const event of this.source.stream(request, signal)) {
      if (event.type === 'response') {
        observed.responseToolCalls.push(
          ...(event.message.tool_calls ?? []).map((call) => structuredClone(call)),
        );
      }
      if ((event.type === 'response' || event.type === 'stream_interrupted') && event.usage) {
        observed.usage = event.usage;
        recordUsage(event.usage);
      }
      yield event;
    }
  }
}

const storedToolCallSchema = z.object({
  call_id: z.string(),
  tool_name: z.string(),
  arguments_json: z.string(),
  call_type: z.enum(['complete', 'incomplete']),
  run_id: z.string().nullable(),
  assistant_seq: z.number().int().positive(),
  result_status: z.enum(['success', 'error']).nullable(),
  result_content: z.string().nullable(),
});
type StoredToolCall = z.infer<typeof storedToolCallSchema>;

const interactionKeySchema = z.object({
  source_thread_id: z.string(),
  source_agent_id: z.string(),
  source_tool_call_id: z.string(),
});

const scenario: {
  directory?: string;
  fixture?: Fixture;
  store?: SessionStore;
  provider?: ObservedProvider;
  mainId?: string;
  sourceRunId?: string;
  interactionKey?: DelegationKey;
  releaseOperations?: () => void;
} = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [value, replacement] of [
    [process.env.KAIROS_MODEL_API_KEY, '[redacted-api-key]'],
    [process.env.KAIROS_MODEL_BASE_URL, '[redacted-provider-url]'],
    [scenario.directory, '[redacted-temporary-directory]'],
  ] as const) {
    if (value) message = message.replaceAll(value, replacement);
  }
  return message
    .replaceAll(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replaceAll(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

function recordFailure(stage: string, error: unknown): void {
  report.status = 'failed';
  report.failures.push(`${stage}: ${safeError(error)}`);
}

function recordCheck(name: CheckName, passed: boolean, detail: string): void {
  report.checks[name] = passed ? 'passed' : 'failed';
  report.unverified = report.unverified.filter((candidate) => candidate !== name);
  if (!passed) report.failures.push(`${name}: ${detail}`);
}

function usageEvidence(usage: DetailedModelUsage): UsageEvidence {
  const cached = usage.prompt_tokens_details?.cached_tokens;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
    cached_tokens: cached ?? null,
    cache_evidence:
      cached === undefined ? 'provider_omitted_cached_tokens' : 'provider_reported_cached_tokens',
  };
}

function recordUsage(usage: DetailedModelUsage): void {
  const evidence = usageEvidence(usage);
  report.requests_usage.push(evidence);
  report.usage.input_tokens += evidence.input_tokens;
  report.usage.output_tokens += evidence.output_tokens;
  report.usage.total_tokens += evidence.total_tokens;
  if (evidence.cached_tokens === null) report.usage.requests_without_cached_tokens += 1;
  else {
    report.usage.cached_tokens = (report.usage.cached_tokens ?? 0) + evidence.cached_tokens;
    report.usage.cached_token_requests += 1;
  }
}

function environmentPolicySummary(args: Record<string, unknown>): Record<string, unknown> {
  return {
    allowed_env: Array.isArray(args.allowed_env)
      ? args.allowed_env.filter((value): value is string => typeof value === 'string')
      : null,
  };
}

function argumentSummary(call: Pick<ToolCall, 'name' | 'arguments'>): Record<string, unknown> {
  const args = call.arguments;
  const summary: Record<string, unknown> = { argument_keys: Object.keys(args).sort() };
  if (call.name === 'subagent') {
    summary.mode = typeof args.mode === 'string' ? args.mode : null;
    summary.environment_policy = environmentPolicySummary(args);
    if (typeof args.task === 'string') summary.task_sha256 = hash(args.task);
  }
  if (call.name === 'thread_call') {
    summary.creates_thread = args.thread_id === undefined || args.thread_id === '';
    summary.mode = typeof args.mode === 'string' ? args.mode : 'follow_up';
    summary.environment_policy = environmentPolicySummary(args);
    if (typeof args.prompt === 'string') summary.prompt_sha256 = hash(args.prompt);
  }
  if (proactiveReadNames.has(call.name)) {
    summary.target_tool_call_id = typeof args.tool_call_id === 'string' ? args.tool_call_id : null;
    summary.uses_wait_ms = args.wait_ms !== undefined;
    summary.wait_ms = typeof args.wait_ms === 'number' ? args.wait_ms : null;
  }
  if (call.name === 'bash') {
    summary.cwd = typeof args.cwd === 'string' ? args.cwd : null;
    summary.timeoutSeconds = typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : null;
    if (typeof args.command === 'string') {
      summary.command_sha256 = hash(args.command);
      summary.command_matches_fixture = args.command === syntheticCommand;
    }
  }
  return summary;
}

function requestSummary(request: ModelRequest): Record<string, unknown> {
  const first = request.messages[0];
  const last = request.messages.at(-1);
  const title =
    first?.role === 'system' && first.content.startsWith('Generate a concise Thread title');
  const recap =
    last?.role === 'user' && last.content.startsWith('Kairos internal Recap operation;');
  let automaticDelivery = false;
  if (last?.role === 'user') {
    const reminder = systemReminderContent(last.content);
    if (reminder !== undefined) {
      try {
        const value: unknown = JSON.parse(reminder.slice(reminder.indexOf('\n') + 1));
        automaticDelivery =
          isRecord(value) &&
          typeof value.tool_call_id === 'string' &&
          (value.kind === 'thread_call' || value.kind === 'subagent');
      } catch {
        automaticDelivery = false;
      }
    }
  }
  return {
    kind: title ? 'title' : recap ? 'recap' : 'normal',
    actor: title
      ? 'title_generator'
      : recap
        ? 'recap_generator'
        : request.tools.some((tool) => tool.name === 'thread_call')
          ? 'main_root'
          : 'delegated_target',
    trigger: automaticDelivery
      ? 'automatic_delivery'
      : last?.role === 'tool'
        ? 'tool_result'
        : last?.role === 'user'
          ? 'user_input'
          : 'other',
    last_tool_name: last?.role === 'tool' ? last.tool_name : null,
  };
}

function providerRequestEvidence(provider: ObservedProvider): Array<Record<string, unknown>> {
  return provider.requests.map((observed, index) => ({
    index,
    ...requestSummary(observed.request),
    response_tool_calls: observed.responseToolCalls.map((call) => ({
      call_id: call.id,
      name: call.name,
      arguments: argumentSummary(call),
    })),
    usage: observed.usage ? usageEvidence(observed.usage) : null,
  }));
}

function storedToolCalls(fixture: Fixture): StoredToolCall[] {
  return z.array(storedToolCallSchema).parse(
    fixture.database
      .prepare(
        `SELECT c.call_id, c.tool_name, c.arguments_json, c.call_type,
                  a.run_id, a.seq AS assistant_seq,
                  r.tool_status AS result_status, r.content AS result_content
           FROM context_tool_calls c
           JOIN context_messages a ON a.seq = c.assistant_seq
           LEFT JOIN context_messages r ON r.seq = c.result_seq
           ORDER BY a.seq, c.call_id`,
      )
      .all(),
  );
}

function parsedArguments(row: StoredToolCall): Record<string, unknown> {
  if (row.call_type === 'incomplete') return {};
  const value: unknown = JSON.parse(row.arguments_json);
  if (!isRecord(value)) throw new Error(`Tool call ${row.call_id} has invalid arguments.`);
  return value;
}

function receiptSummary(row: StoredToolCall): Record<string, unknown> | null {
  if (row.result_content === null) return null;
  if (row.tool_name !== 'thread_call' && row.tool_name !== 'subagent') return null;
  try {
    const value: unknown = JSON.parse(row.result_content);
    if (!isRecord(value)) return null;
    return {
      status: typeof value.status === 'string' ? value.status : null,
      thread_id: typeof value.thread_id === 'string' ? value.thread_id : null,
    };
  } catch {
    return null;
  }
}

function toolCallEvidence(fixture: Fixture): Array<Record<string, unknown>> {
  return storedToolCalls(fixture).map((row) => ({
    call_id: row.call_id,
    name: row.tool_name,
    run_id: row.run_id,
    message_seq: row.assistant_seq,
    call_type: row.call_type,
    arguments: argumentSummary({ name: row.tool_name, arguments: parsedArguments(row) }),
    result_status: row.result_status,
    receipt: receiptSummary(row),
  }));
}

function sourceInteractions(store: SessionStore, sourceRunId: string): InteractionRecord[] {
  const keys = z.array(interactionKeySchema).parse(
    store.database
      .prepare(
        `SELECT source_thread_id, source_agent_id, source_tool_call_id
           FROM interactions WHERE source_run_id = ? ORDER BY created_at, source_tool_call_id`,
      )
      .all(sourceRunId),
  );
  return keys.map((key) =>
    store.getInteraction(ownerId, {
      sourceThreadId: key.source_thread_id,
      sourceAgentId: key.source_agent_id,
      sourceToolCallId: key.source_tool_call_id,
    }),
  );
}

function interactionReceipt(fixture: Fixture, interaction: InteractionRecord) {
  const row = storedToolCalls(fixture).find(
    (candidate) =>
      candidate.run_id === interaction.sourceRunId &&
      candidate.call_id === interaction.sourceToolCallId,
  );
  return row ? receiptSummary(row) : null;
}

function proactiveReads(fixture: Fixture, sourceRunId: string): StoredToolCall[] {
  return storedToolCalls(fixture).filter(
    (row) => row.run_id === sourceRunId && proactiveReadNames.has(row.tool_name),
  );
}

function responseContent(store: SessionStore, interaction: InteractionRecord): string {
  const response = store.getInteractionResponse(ownerId, interaction);
  return response?.message.role === 'assistant' ? response.message.content : '';
}

function rootResponse(
  store: SessionStore,
  mainId: string,
  runId: string,
  afterSeq: number,
): { present: boolean; containsMarker: boolean } {
  const responses = store.context
    .query({ threadId: mainId, agentId: 'thread', currentOnly: true })
    .filter(
      (message) =>
        message.runId === runId &&
        message.seq > afterSeq &&
        message.message.role === 'assistant' &&
        message.message.content.trim().length > 0,
    );
  return {
    present: responses.length > 0,
    containsMarker: responses.some((message) => message.message.content.includes(resultMarker)),
  };
}

function runRoles(
  run: RunRecord,
  interaction: InteractionRecord | null,
  deliveryRunId: string | null,
) {
  const roles: string[] = [];
  if (run.runId === scenario.sourceRunId) roles.push('source_root');
  if (interaction?.consumedRunId === run.runId) roles.push('delegated_target');
  if (deliveryRunId === run.runId) roles.push('automatic_delivery_root');
  if (roles.length === 0) roles.push(run.parentRunId === null ? 'other_root' : 'other_child');
  return roles;
}

function captureEvidence(): void {
  const { fixture, store, mainId, sourceRunId, interactionKey } = scenario;
  if (scenario.provider) report.provider_requests = providerRequestEvidence(scenario.provider);
  if (!fixture || !store) return;
  report.tool_calls = toolCallEvidence(fixture);
  const operations = fixture.environmentOperations;
  report.operations =
    operations?.started.map((operation) => ({
      operation_id: operation.operationId,
      env_id: operation.envId,
      action: operation.action.case,
      binding_version: operation.bindingVersion?.toString() ?? null,
      command_sha256:
        operation.action.case === 'bash' ? hash(operation.action.value.command) : null,
      command_matches_fixture:
        operation.action.case === 'bash'
          ? operation.action.value.command === syntheticCommand
          : null,
    })) ?? [];
  if (!mainId || !sourceRunId) return;
  const interaction = interactionKey ? store.getInteraction(ownerId, interactionKey) : null;
  const delivery = interaction ? store.getInteractionDelivery(ownerId, interaction) : null;
  const sourceRun = store.getRunById(sourceRunId);
  const targetRunId = interaction?.consumedRunId ?? null;
  const threadIds = new Set([mainId, ...(interaction ? [interaction.targetThreadId] : [])]);
  const runs = [...threadIds].flatMap((threadId) => store.listRuns(ownerId, threadId));
  const uniqueRuns = [...new Map(runs.map((run) => [run.runId, run])).values()].sort((a, b) =>
    a.runId.localeCompare(b.runId),
  );
  report.runs = uniqueRuns.map((run) => ({
    run_id: run.runId,
    thread_id: run.threadId,
    agent_id: run.agentId,
    roles: runRoles(run, interaction, delivery?.runId ?? null),
    status: run.status,
    execution_mode: run.executionMode,
    parent_run_id: run.parentRunId,
    input_count: run.inputIds.length,
    usage: {
      input_tokens: run.usage.inputTokens,
      output_tokens: run.usage.outputTokens,
      reported: run.usageReported,
    },
    finished_at: run.finishedAt,
    error_code: run.error?.code ?? null,
  }));
  if (interaction) {
    const receipt = interactionReceipt(fixture, interaction);
    report.delegation = {
      kind: interaction.kind,
      execution_mode: interaction.executionMode,
      source_tool_call_id: interaction.sourceToolCallId,
      target_thread_id: interaction.targetThreadId,
      target_agent_id: interaction.targetAgentId,
      target_run_id: targetRunId,
      status: interaction.status,
      receipt_status: receipt?.status ?? null,
    };
    report.behavior.background_call_seq =
      storedToolCalls(fixture).find(
        (row) => row.run_id === sourceRunId && row.call_id === interaction.sourceToolCallId,
      )?.assistant_seq ?? null;
    report.behavior.source_finished_before_target =
      sourceRun.finishedAt !== null && interaction.finishedAt !== null
        ? Date.parse(sourceRun.finishedAt) <= Date.parse(interaction.finishedAt)
        : null;
    report.behavior.target_response_contains_result_marker = responseContent(
      store,
      interaction,
    ).includes(resultMarker);
  }
  const reads = proactiveReads(fixture, sourceRunId);
  report.behavior.proactive_reads = reads.map((row) => ({
    call_id: row.call_id,
    name: row.tool_name,
    message_seq: row.assistant_seq,
    arguments: argumentSummary({ name: row.tool_name, arguments: parsedArguments(row) }),
  }));
  report.behavior.wait_ms_values = reads.flatMap((row) => {
    const wait = parsedArguments(row).wait_ms;
    return typeof wait === 'number' ? [wait] : [];
  });
  if (delivery) {
    const injected =
      delivery.contextMessageSeq === null
        ? undefined
        : store.context.get(mainId, 'thread', delivery.contextMessageSeq);
    const following =
      delivery.runId !== null && delivery.contextMessageSeq !== null
        ? rootResponse(store, mainId, delivery.runId, delivery.contextMessageSeq)
        : { present: false, containsMarker: false };
    report.delivery = {
      status: delivery.status,
      run_id: delivery.runId,
      context_message_seq: delivery.contextMessageSeq,
      source: injected?.source ?? null,
      is_following_root_run: delivery.runId !== null && delivery.runId !== sourceRunId,
      content_contains_result_marker: delivery.content?.includes(resultMarker) ?? false,
      persisted_with_consumption: injected?.runId !== null && injected?.runId === delivery.runId,
    };
    report.behavior.following_root_response_present = following.present;
    report.behavior.following_root_response_contains_result_marker = following.containsMarker;
  }
}

async function waitTerminalRun(store: SessionStore, runId: string): Promise<RunRecord> {
  await vi.waitFor(
    () => {
      expect(terminalStatuses).toContain(store.getRunById(runId).status);
    },
    { timeout: 180_000, interval: 100 },
  );
  return store.getRunById(runId);
}

async function runAcceptance(config: RealModelConfig): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-real-background-guidance-'));
  scenario.directory = directory;
  const provider = new ObservedProvider(config);
  scenario.provider = provider;
  const fixture = await startFixture(directory, {
    provider,
    contextWindowTokens: config.contextWindow,
    outputReserveTokens: config.outputReserve,
    countTokens: (request) => provider.source.estimateRequestTokens(request),
  });
  scenario.fixture = fixture;
  const store = new SessionStore(fixture.database);
  scenario.store = store;
  const operations = fixture.environmentOperations;
  if (!operations) throw new Error('The controlled environment Operation gateway is missing.');
  operations.bashOutput = `${resultMarker}\n`;
  const operationGate = deferred();
  scenario.releaseOperations = operationGate.resolve;
  const startOperation = operations.startEnvironmentOperation.bind(operations);
  operations.startEnvironmentOperation = async (input) => {
    if (input.action.case === 'bash') await operationGate.promise;
    return startOperation(input);
  };

  const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
  if (!mainId) throw new Error('The main Thread was not created.');
  scenario.mainId = mainId;
  const prompt = `Delegate exactly one synthetic task in the background, using either one new task Thread or one background Subagent. Use only the authorized environment shown in the catalog. The delegated task must call bash exactly once with env_id env-1 and cwd ${'/srv/one'}, timeoutSeconds 30, and this exact command:\n${syntheticCommand}\nAfter bash returns, the delegated task must reply with only the command's actual stdout. Tell me that the task is running and finish this turn; its completion should come back automatically.`;
  const source = await sendMessage(fixture, mainId, prompt, 'real-background-guidance-source');
  scenario.sourceRunId = source.runId;
  await vi.waitFor(
    () => {
      const interactions = sourceInteractions(store, source.runId);
      if (
        interactions.some((interaction) => interaction.executionMode === 'foreground') ||
        proactiveReads(fixture, source.runId).length > 0
      ) {
        operationGate.resolve();
      }
      expect(terminalStatuses).toContain(store.getRunById(source.runId).status);
    },
    { timeout: 180_000, interval: 100 },
  );
  operationGate.resolve();
  const sourceRun = store.getRunById(source.runId);
  const interactions = sourceInteractions(store, source.runId);
  const backgrounds = interactions.filter(
    (interaction) => interaction.executionMode === 'background',
  );
  const interaction = backgrounds[0];
  const receipt = interaction ? interactionReceipt(fixture, interaction) : null;
  recordCheck(
    'background_delegation_accepted',
    interactions.length === 1 &&
      backgrounds.length === 1 &&
      interaction !== undefined &&
      receipt?.status === 'accepted',
    `Expected exactly one accepted background delegation; observed ${interactions.length} interactions and ${backgrounds.length} background interactions.`,
  );
  if (!interaction) return;
  scenario.interactionKey = interaction;

  const reads = proactiveReads(fixture, source.runId);
  recordCheck(
    'source_completed_without_proactive_read_or_wait',
    sourceRun.status === 'completed' && reads.length === 0,
    `Source Run status was ${sourceRun.status}; proactive read calls were ${reads.map((row) => row.tool_name).join(', ') || 'none'}.`,
  );

  await vi.waitFor(
    () => {
      expect(terminalStatuses).toContain(store.getInteraction(ownerId, interaction).status);
    },
    { timeout: 240_000, interval: 100 },
  );
  const completedInteraction = store.getInteraction(ownerId, interaction);
  const bashOperations = operations.started.filter((operation) => operation.action.case === 'bash');
  const exactOperation =
    bashOperations.length === 1 &&
    bashOperations.every(
      (operation) =>
        operation.envId === 'env-1' &&
        operation.action.case === 'bash' &&
        operation.action.value.command === syntheticCommand &&
        operation.action.value.cwd === '/srv/one' &&
        operation.action.value.timeoutSeconds === 30,
    );
  recordCheck(
    'controlled_environment_operation',
    fixture.realEnvironment === undefined && exactOperation,
    `Expected one exact controlled Bash Operation in ${'env-1'}; observed ${bashOperations.length}.`,
  );
  const targetContent = responseContent(store, completedInteraction);
  recordCheck(
    'target_completed_with_controlled_result',
    completedInteraction.status === 'completed' && targetContent.includes(resultMarker),
    `Target interaction status was ${completedInteraction.status}; controlled result marker presence was ${targetContent.includes(resultMarker)}.`,
  );

  await vi.waitFor(
    () => {
      expect(store.getInteractionDelivery(ownerId, interaction).status).toBe('consumed');
    },
    { timeout: 240_000, interval: 100 },
  );
  const delivery = store.getInteractionDelivery(ownerId, interaction);
  if (delivery.runId === null || delivery.contextMessageSeq === null) {
    throw new Error('The consumed automatic delivery has no root Run or Context sequence.');
  }
  const deliveryRun = await waitTerminalRun(store, delivery.runId);
  const injected = store.context.get(mainId, 'thread', delivery.contextMessageSeq);
  const expectedSource =
    interaction.kind === 'thread_call' ? 'thread_response' : 'subagent_response';
  const responseInputCount = z
    .object({ count: z.number().int().nonnegative() })
    .parse(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM inputs WHERE source IN ('thread_response', 'subagent_response')",
        )
        .get(),
    ).count;
  recordCheck(
    'automatic_delivery_to_following_root_run',
    delivery.runId !== source.runId &&
      deliveryRun.parentRunId === null &&
      deliveryRun.agentId === 'thread' &&
      deliveryRun.threadId === mainId &&
      deliveryRun.inputIds.length === 0 &&
      injected?.runId === delivery.runId &&
      injected.source === expectedSource &&
      injected.delegation?.sourceToolCallId === interaction.sourceToolCallId &&
      delivery.content?.includes(resultMarker) === true &&
      responseInputCount === 0,
    `Delivery Run was ${delivery.runId}; source Run was ${source.runId}; injected source was ${injected?.source ?? 'missing'}; response inputs were ${responseInputCount}.`,
  );
  const following = rootResponse(store, mainId, delivery.runId, delivery.contextMessageSeq);
  recordCheck(
    'following_root_run_response',
    deliveryRun.status === 'completed' && following.present,
    `Automatic delivery root Run status was ${deliveryRun.status}; response presence was ${following.present}.`,
  );
}

describe.skipIf(!enabled)('real background delegation guidance acceptance', () => {
  afterAll(async () => {
    if (scenario.provider) report.provider_requests = providerRequestEvidence(scenario.provider);
    report.status =
      report.failures.length === 0 && report.unverified.length === 0 ? 'passed' : 'failed';
    const reportPath =
      process.env.KAIROS_BACKGROUND_GUIDANCE_REPORT ??
      process.env.KAIROS_REAL_MODEL_REPORT ??
      join(repositoryRoot, 'work/background-guidance-real-model-acceptance.json');
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  });

  it('finishes after background acceptance and replies from an automatically scheduled root Run', async () => {
    try {
      const config = readRealModelConfig();
      report.model.modelId = config.modelId;
      if (config.modelId !== expectedModelId) {
        throw new Error(`Expected ${expectedModelId}, received ${config.modelId}.`);
      }
      report.commit = (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })
      ).stdout.trim();
      await runAcceptance(config);
    } catch (error) {
      recordFailure('scenario', error);
      throw error;
    } finally {
      scenario.releaseOperations?.();
      try {
        captureEvidence();
      } catch (error) {
        recordFailure('evidence', error);
      }
      if (scenario.fixture) {
        try {
          await closeFixture(scenario.fixture);
          report.cleanup.server_closed = true;
        } catch (error) {
          recordFailure('close', error);
        }
      } else report.cleanup.server_closed = true;
      if (scenario.directory) {
        try {
          await rm(scenario.directory, { recursive: true, force: true });
          report.cleanup.temporary_directory_removed = true;
        } catch (error) {
          recordFailure('cleanup', error);
        }
      } else report.cleanup.temporary_directory_removed = true;
    }
    report.status =
      report.failures.length === 0 && report.unverified.length === 0 ? 'passed' : 'failed';
    expect(report.failures).toEqual([]);
    expect(report.unverified).toEqual([]);
  }, 900_000);
});
