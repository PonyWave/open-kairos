import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createClient, type Interceptor, type Transport } from '@connectrpc/connect';
import {
  AgentLoop,
  type ModelEvent,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelUsage,
} from '@kairos/agent-core';
import {
  ContextService,
  EventService,
  InputMode,
  MessageService,
  QueueService,
  RunService,
  RunStatus,
  ThreadService,
} from '@kairos/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { EnvironmentOperationStore } from '../devices/environment-operation-store.js';
import { EnvironmentStore } from '../devices/environment-store.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { openDatabase } from '../storage/database.js';
import { type RealModelConfig, readRealModelConfig } from './real-model-config.js';
import { runSubagentDelegationDemo, runThreadDelegationDemo } from './real-model-delegation.js';
import { createTestServer as createServer, testSessionHeaders } from './test-authentication.js';

const enabled = process.env.KAIROS_RUN_REAL_MODEL === '1';
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const ownerId = 'real-model-acceptance-owner';
const accessToken = 'real-model-acceptance-connect-token';
const execFileAsync = promisify(execFile);
const terminalStatuses = [
  RunStatus.COMPLETED,
  RunStatus.FAILED,
  RunStatus.CANCELLED,
  RunStatus.INTERRUPTED,
];

interface AcceptanceReport {
  version: 1;
  status: 'passed' | 'failed';
  model: { providerId: 'openai-compatible'; modelId: string };
  environment: { platform: string; arch: string; node: string };
  command: string;
  checks: Record<string, 'passed' | 'failed'>;
  usage: Required<ModelUsage>;
  hard_cut_budgets: Array<{
    estimated_input_tokens: number;
    context_window_tokens: number;
    output_reserve_tokens: number;
    provider_max_tokens: number;
  }>;
  hard_cut_failures: Array<{
    estimated_input_tokens: number | null;
    context_window_tokens: number;
    output_reserve_tokens: number;
    provider_max_tokens: number;
    error_code: string | null;
  }>;
  original_recall_budget: {
    context_window_tokens: number;
    output_reserve_tokens: number;
    provider_max_tokens: number;
  } | null;
  failures: string[];
  unverified: string[];
}

const report: AcceptanceReport = {
  version: 1,
  status: 'passed',
  model: { providerId: 'openai-compatible', modelId: '' },
  environment: { platform: process.platform, arch: process.arch, node: process.version },
  command: 'pnpm test:real-model',
  checks: {},
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  hard_cut_budgets: [],
  hard_cut_failures: [],
  original_recall_budget: null,
  failures: [],
  unverified: [
    'provider_text_stream_and_usage',
    'provider_complete_tool_call',
    'provider_incomplete_output_not_executed',
    'provider_cancellation',
    'real_connect_daemon_bash_logs_steer_stop_reconnect',
    'real_automatic_hard_cut_and_original_recall',
    'real_thread_delegation_context_and_delivery',
    'real_subagent_modes_status_and_cancellation',
  ],
};

function loadReportConfig(): RealModelConfig {
  try {
    return readRealModelConfig();
  } catch (error) {
    report.status = 'failed';
    report.failures.push(`configuration: ${safeError(error)}`);
    throw error;
  }
}

function addUsage(usage: ModelUsage): void {
  report.usage.input_tokens += usage.input_tokens;
  report.usage.output_tokens += usage.output_tokens;
  report.usage.total_tokens += usage.total_tokens ?? usage.input_tokens + usage.output_tokens;
}

function trackedProvider(config: RealModelConfig, outputReserve = config.outputReserve) {
  const source = new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.modelId,
    contextWindow: config.contextWindow,
    outputReserve,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const observedTypes: ModelEvent['type'][] = [];
  const provider: ModelProvider = {
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      for await (const event of source.stream(request, signal)) {
        observedTypes.push(event.type);
        if (event.type === 'response' || event.type === 'stream_interrupted') {
          if (event.usage) addUsage(event.usage);
        }
        yield event;
      }
    },
  };
  return { source, provider, observedTypes };
}

async function collect(
  provider: ModelProvider,
  request: ModelRequest,
  signal = new AbortController().signal,
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of provider.stream(request, signal)) events.push(event);
  return events;
}

type ResponseEvent = Extract<ModelEvent, { type: 'response' }>;

function completeResponse(events: readonly ModelEvent[]): ResponseEvent {
  const terminal = events.at(-1);
  if (terminal?.type === 'stream_interrupted') {
    throw new Error(`Provider stream interrupted: ${terminal.error.code}`);
  }
  if (terminal?.type !== 'response') throw new Error('Provider returned no complete response.');
  return terminal;
}

function checkUsage(usage: ModelUsage): void {
  expect(Number.isSafeInteger(usage.input_tokens)).toBe(true);
  expect(Number.isSafeInteger(usage.output_tokens)).toBe(true);
  expect(usage.input_tokens).toBeGreaterThan(0);
  expect(usage.output_tokens).toBeGreaterThan(0);
  if (usage.total_tokens !== undefined) {
    expect(usage.total_tokens).toBe(usage.input_tokens + usage.output_tokens);
  }
}

async function recordCheck(name: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
    report.checks[name] = 'passed';
    report.unverified = report.unverified.filter((candidate) => candidate !== name);
  } catch (error) {
    report.checks[name] = 'failed';
    report.status = 'failed';
    report.failures.push(`${name}: ${safeError(error)}`);
    throw error;
  }
}

function safeError(error: unknown): string {
  const secret = process.env.KAIROS_MODEL_API_KEY;
  const message = error instanceof Error ? error.message : String(error);
  return (secret ? message.replaceAll(secret, '[redacted]') : message)
    .replaceAll(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

type ConnectTransportFactory = (options: {
  baseUrl: string;
  httpVersion: '1.1';
  interceptors: Interceptor[];
}) => Transport;

const fastifyEntry = createRequire(import.meta.url).resolve('@connectrpc/connect-fastify');
const connectNode = createRequire(fastifyEntry)('@connectrpc/connect-node') as {
  createConnectTransport: ConnectTransportFactory;
};

function networkClients(baseUrl: string) {
  const authentication: Interceptor = (next) => async (request) => {
    for (const [name, value] of Object.entries(testSessionHeaders(accessToken)))
      request.header.set(name, value);
    return next(request);
  };
  const transport = connectNode.createConnectTransport({
    baseUrl,
    httpVersion: '1.1',
    interceptors: [authentication],
  });
  return {
    thread: createClient(ThreadService, transport),
    messages: createClient(MessageService, transport),
    queue: createClient(QueueService, transport),
    runs: createClient(RunService, transport),
    context: createClient(ContextService, transport),
    events: createClient(EventService, transport),
  };
}

function assertAcceptanceBudget(contextWindow: number, outputReserve: number): void {
  if (
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isSafeInteger(outputReserve) ||
    outputReserve <= 0 ||
    outputReserve >= contextWindow
  ) {
    throw new Error(
      `Invalid real model acceptance fixture budget: contextWindow=${contextWindow}, outputReserve=${outputReserve}.`,
    );
  }
}

function withAcceptanceBudget(
  config: RealModelConfig,
  contextWindow: number,
  outputReserve: number,
): RealModelConfig {
  assertAcceptanceBudget(contextWindow, outputReserve);
  return { ...config, contextWindow, outputReserve };
}

async function startFixture(directory: string, config: RealModelConfig) {
  assertAcceptanceBudget(config.contextWindow, config.outputReserve);
  const database = openDatabase(join(directory, 'server.sqlite'));
  const tracked = trackedProvider(config);
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
    maxStepsPerRun: 12,
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address() as AddressInfo;
  return {
    database,
    server,
    port: address.port,
    clients: networkClients(`http://127.0.0.1:${address.port}`),
    tracked,
  };
}

type Fixture = Awaited<ReturnType<typeof startFixture>>;

async function closeFixture(fixture: Fixture): Promise<void> {
  if (fixture.database.isOpen) await fixture.server.close();
}

async function createThread(
  fixture: Fixture,
  actionId: string,
  environmentPolicy?: {
    allowedEnv: string[];
    policyVersion: bigint;
  },
): Promise<string> {
  const created = await fixture.clients.thread.createThread({
    clientActionId: actionId,
    title: 'Real model acceptance',
    ...(environmentPolicy ? { environmentPolicy } : {}),
  });
  if (!created.thread) throw new Error('The real model acceptance Thread was not created.');
  return created.thread.threadId;
}

async function sendMessage(
  fixture: Fixture,
  threadId: string,
  text: string,
  actionId: string,
  mode: InputMode = InputMode.FOLLOW_UP,
): Promise<{ runId: string; inputId: string }> {
  const sent = await fixture.clients.messages.sendMessage({
    clientActionId: actionId,
    threadId,
    text,
    mode,
  });
  const snapshot = await fixture.clients.thread.getThread({ threadId });
  const run = snapshot.snapshot?.runs
    .filter((candidate) => candidate.parentRunId === undefined)
    .at(-1);
  if (!run) throw new Error('The real model acceptance Run was not created.');
  return { runId: run.runId, inputId: sent.inputId };
}

function runSnapshot(fixture: Fixture, threadId: string, runId: string) {
  return fixture.clients.thread.getThread({ threadId }).then((snapshot) => {
    const run = snapshot.snapshot?.runs.find((candidate) => candidate.runId === runId);
    if (!run) throw new Error('The requested Run is missing from the snapshot.');
    return run;
  });
}

async function waitRun(
  fixture: Fixture,
  threadId: string,
  runId: string,
  status: RunStatus,
  timeout = 180_000,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const run = await runSnapshot(fixture, threadId, runId);
      expect(run.status).toBe(status);
    },
    { timeout },
  );
}

async function waitCompleted(fixture: Fixture, threadId: string, runId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const run = await runSnapshot(fixture, threadId, runId);
      expect(terminalStatuses).toContain(run.status);
    },
    { timeout: 180_000 },
  );
  const run = await runSnapshot(fixture, threadId, runId);
  if (run.status !== RunStatus.COMPLETED) {
    throw new Error(
      `Run ended with status ${run.status}, error ${run.error?.code ?? 'none'}: ${run.error?.message ?? 'none'}.`,
    );
  }
  expect(run.usage?.inputTokens ?? 0n).toBeGreaterThan(0n);
  expect(run.usage?.outputTokens ?? 0n).toBeGreaterThan(0n);
}

interface ToolResultRow {
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  content: string;
}

function toolResults(
  fixture: Fixture,
  threadId: string,
  runId: string,
  toolName?: string,
): ToolResultRow[] {
  const rows = fixture.database
    .prepare(
      `SELECT run_id, tool_call_id, tool_name, content FROM context_messages
       WHERE thread_id = ? AND run_id = ? AND role = 'tool'
       ORDER BY seq`,
    )
    .all(threadId, runId);
  const results: ToolResultRow[] = [];
  for (const row of rows) {
    if (
      typeof row.run_id !== 'string' ||
      typeof row.tool_call_id !== 'string' ||
      typeof row.tool_name !== 'string' ||
      typeof row.content !== 'string' ||
      (toolName !== undefined && row.tool_name !== toolName)
    ) {
      continue;
    }
    results.push({
      run_id: row.run_id,
      tool_call_id: row.tool_call_id,
      tool_name: row.tool_name,
      content: row.content,
    });
  }
  return results;
}

async function runForTool(
  fixture: Fixture,
  threadId: string,
  actionId: string,
  prompt: string,
  toolName: string,
): Promise<{ runId: string; result: ToolResultRow }> {
  let nextPrompt = prompt;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { runId } = await sendMessage(fixture, threadId, nextPrompt, `${actionId}-${attempt}`);
    await waitCompleted(fixture, threadId, runId);
    const result = toolResults(fixture, threadId, runId, toolName)[0];
    if (result) return { runId, result };
    nextPrompt = `${prompt}\nThe previous response did not call ${toolName}. Call ${toolName} now with the requested arguments.`;
  }
  throw new Error(`Model behavior: ${toolName} was not called after two attempts.`);
}

function parsedToolContent(row: ToolResultRow): Record<string, unknown> {
  const value: unknown = JSON.parse(row.content);
  if (!isRecord(value)) throw new Error(`${row.tool_name} returned a non-object result.`);
  return value;
}

interface DaemonProcess {
  child: ChildProcess;
}

async function startDaemon(
  fixture: Fixture,
  identityDirectory: string,
  pairingCredential: string,
  envId: string,
  workspace: string,
): Promise<DaemonProcess> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    KAIROS_DEVICE_IDENTITY_PATH: join(identityDirectory, 'identity.json'),
  };
  delete environment.KAIROS_MODEL_API_KEY;
  await execFileAsync(
    process.execPath,
    [
      '--import',
      'tsx',
      join(repositoryRoot, 'apps/daemon/src/main.ts'),
      'pair-once',
      '--env-id',
      envId,
      '--server-url',
      `ws://127.0.0.1:${fixture.port}/devices/wss`,
      '--directory',
      workspace,
      '--device-name',
      'real-model-acceptance-mac-device',
    ],
    {
      cwd: repositoryRoot,
      env: { ...environment, KAIROS_DEVICE_PAIRING_CREDENTIAL: pairingCredential },
    },
  );
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(repositoryRoot, 'apps/daemon/src/main.ts')],
    {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.resume();
  child.stderr?.resume();
  return { child };
}

async function stopDaemon(daemon: DaemonProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) return;
  const exited = once(daemon.child, 'exit');
  const forced = setTimeout(() => daemon.child.kill('SIGKILL'), 3000);
  forced.unref();
  daemon.child.kill(signal);
  await exited;
  clearTimeout(forced);
}

async function waitDeviceActive(fixture: Fixture, envId: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(new EnvironmentStore(fixture.database).get(ownerId, envId).ready).toBe(true);
    },
    { timeout: 15_000 },
  );
}

async function waitForEffect(
  fixture: Fixture,
  threadId: string,
  runId: string,
  path: string,
  expected: string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const content = await readFile(path, 'utf8').catch(() => undefined);
      if (content === expected) return;
      const run = await runSnapshot(fixture, threadId, runId);
      if (terminalStatuses.includes(run.status)) {
        throw new Error(`Run reached status ${run.status} before the expected Bash side effect.`);
      }
      expect(content).toBe(expected);
    },
    { timeout: 180_000 },
  );
}

async function readCompleteLog(fixture: Fixture, operationId: string): Promise<Buffer> {
  const pages: Buffer[] = [];
  const store = new EnvironmentOperationStore(fixture.database);
  const operation = store.getForTenant(ownerId, operationId);
  expect(operation.outputComplete).toBe(true);
  expect(operation.outputGap).toBe(false);
  let offset = 0n;
  for (let index = 0; index < 1000; index += 1) {
    const chunks = store.readOutputForTenant(ownerId, operationId, offset, 4096);
    pages.push(...chunks.map((chunk) => Buffer.from(chunk.data)));
    const nextOffset = chunks.at(-1)?.endOffset ?? offset;
    if (nextOffset === operation.nextOffset) return Buffer.concat(pages);
    if (nextOffset <= offset) throw new Error('Bash output pagination made no progress.');
    offset = nextOffset;
  }
  throw new Error('Bash log pagination did not finish.');
}

async function runConnectedDemo(config: RealModelConfig): Promise<void> {
  expect(process.platform).toBe('darwin');
  const directory = await mkdtemp(join(tmpdir(), 'kairos-real-model-connect-'));
  const fixture = await startFixture(directory, config);
  let daemon: DaemonProcess | undefined;
  try {
    const paired = new EnvironmentStore(fixture.database).register({
      tenantId: ownerId,
      clientActionId: 'real-pair-device',
      name: 'real-model-acceptance-mac-device',
      recommendedPwd: directory,
      kind: 'self_hosted_macos',
    });
    const envId = paired.environment.envId;
    daemon = await startDaemon(
      fixture,
      join(directory, 'daemon'),
      paired.pairingCredential,
      envId,
      directory,
    );
    await waitDeviceActive(fixture, envId);
    const threadId = await createThread(fixture, 'real-connect-thread', {
      allowedEnv: [envId],
      policyVersion: 1n,
    });

    const started = join(directory, 'device-started.txt');
    const effect = join(directory, 'device-effect.txt');
    const command = `printf started > ${shellQuote(started)}; sleep 2; printf 'HIDDEN_MARKER\\n'; for ((i=0; i<1400; i+=1)); do printf '01234567890123456789012345678901234567890123456789\\n'; done; printf device-effect > ${shellQuote(effect)}`;
    const devicePrompt = `Call bash exactly once with env_id ${envId} and cwd ${directory}, timeoutSeconds 60, and this exact command:\n${command}\nDo not call another tool before this command finishes.`;
    const deviceRun = await runForTool(
      fixture,
      threadId,
      'real-device-output',
      devicePrompt,
      'bash',
    );
    expect(await readFile(effect, 'utf8')).toBe('device-effect');
    const deviceResult = parsedToolContent(deviceRun.result);
    expect(deviceResult.status).toBe('completed');
    expect(typeof deviceResult.output).toBe('string');
    expect(Buffer.byteLength(String(deviceResult.output))).toBeLessThan(70_000);
    const operationId = deviceResult.operation_id;
    if (typeof operationId !== 'string') {
      throw new Error('Environment Bash result is missing its operation ID.');
    }
    const pagedLog = await readCompleteLog(fixture, operationId);
    expect(pagedLog.toString('utf8').includes('HIDDEN_MARKER')).toBe(true);
    expect(pagedLog.length).toBeGreaterThan(Buffer.byteLength(String(deviceResult.output)));

    const logRun = await runForTool(
      fixture,
      threadId,
      'real-server-log-search',
      `Call read_output exactly once with operation_id ${operationId}, offset 0 and limit 100, then report its actual result.`,
      'read_output',
    );
    expect(logRun.result.content.includes('HIDDEN_MARKER')).toBe(true);

    const steerStarted = join(directory, 'steer-started.txt');
    const steerEffect = join(directory, 'steer-effect.txt');
    const steerCommand = `printf started > ${shellQuote(steerStarted)}; sleep 4; printf steer-effect > ${shellQuote(steerEffect)}`;
    const beforeWatch = await fixture.clients.thread.getThread({ threadId });
    const cursor = beforeWatch.throughSeq;
    const controller = new AbortController();
    const firstWatch = fixture.clients.events
      .watchThread({ threadId, afterSeq: cursor }, { signal: controller.signal })
      [Symbol.asyncIterator]();
    const firstItem = firstWatch.next();
    const steerRun = await sendMessage(
      fixture,
      threadId,
      `Call bash exactly once with env_id ${envId} and cwd ${directory}, timeoutSeconds 30, and this exact command:\n${steerCommand}`,
      'real-steer-run',
    );
    await firstItem;
    await waitForEffect(fixture, threadId, steerRun.runId, steerStarted, 'started');
    const supplement = await sendMessage(
      fixture,
      threadId,
      'The supplement was delivered while Bash was running. After the current tool result, reply briefly without calling more tools.',
      'real-steer-input',
      InputMode.STEER,
    );
    expect(supplement.runId).toBe(steerRun.runId);
    controller.abort();
    await firstWatch.return?.();

    const secondWatch = fixture.clients.events
      .watchThread({ threadId, afterSeq: cursor })
      [Symbol.asyncIterator]();
    let expectedSequence = cursor + 1n;
    let reconnectedTerminal = false;
    while (!reconnectedTerminal) {
      const item = await secondWatch.next();
      if (item.done) throw new Error('Reconnected event stream ended before a terminal Run event.');
      if (item.value.payload.case !== 'event') continue;
      const event = item.value.payload.value;
      expect(event.seq).toBe(expectedSequence);
      expectedSequence += 1n;
      if (
        event.payload.case === 'runChanged' &&
        event.payload.value.run?.runId === steerRun.runId &&
        terminalStatuses.includes(event.payload.value.run.status)
      ) {
        reconnectedTerminal = true;
      }
    }
    await secondWatch.return?.();
    await waitCompleted(fixture, threadId, steerRun.runId);
    expect(await readFile(steerEffect, 'utf8')).toBe('steer-effect');
    const supplementRow = fixture.database
      .prepare('SELECT status, consumed_run_id FROM inputs WHERE input_id = ?')
      .get(supplement.inputId);
    expect(isRecord(supplementRow) && supplementRow.status === 'consumed').toBe(true);
    expect(isRecord(supplementRow) && supplementRow.consumed_run_id === steerRun.runId).toBe(true);

    const cancelStarted = join(directory, 'cancel-started.txt');
    const cancelFinished = join(directory, 'cancel-finished.txt');
    const cancelCommand = `printf started > ${shellQuote(cancelStarted)}; sleep 30; printf finished > ${shellQuote(cancelFinished)}`;
    const cancelRun = await sendMessage(
      fixture,
      threadId,
      `Call bash exactly once with env_id ${envId} and cwd ${directory}, timeoutSeconds 60, and this exact command:\n${cancelCommand}`,
      'real-cancel-run',
    );
    await waitForEffect(fixture, threadId, cancelRun.runId, cancelStarted, 'started');
    const receipt = await fixture.clients.runs.cancelRun({
      clientActionId: 'real-cancel-request',
      threadId,
      runId: cancelRun.runId,
      reason: 'real model acceptance stop',
    });
    expect(receipt.status).toBe(RunStatus.CANCEL_REQUESTED);
    await waitRun(fixture, threadId, cancelRun.runId, RunStatus.CANCELLED);
    await expect(readFile(cancelFinished, 'utf8')).rejects.toThrow();
  } finally {
    if (daemon) await stopDaemon(daemon);
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}

async function runHardCutDemo(config: RealModelConfig): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-real-model-hard-cut-'));
  const hardCutConfig = withAcceptanceBudget(config, 8192, 4096);
  let activeFixture = await startFixture(directory, hardCutConfig);
  expect(activeFixture.tracked.source.contextWindow).toBe(8192);
  expect(activeFixture.tracked.source.outputReserve).toBe(4096);
  try {
    const threadId = await createThread(activeFixture, 'real-hard-cut-thread');
    const marker = `KAIROS-REAL-RECALL-${Date.now()}`;
    const original = `${marker}\nRemember this marker for a later original-Context recall. Reply briefly and do not call tools.\n${'Public acceptance filler. '.repeat(1000)}`;
    const initial = await sendMessage(activeFixture, threadId, original, 'real-hard-cut-original');
    try {
      await waitCompleted(activeFixture, threadId, initial.runId);
    } catch (error) {
      const failedRequests = z
        .array(
          z.object({
            estimated_input_tokens: z.number().int().nonnegative().nullable(),
            context_window_tokens: z.number().int().positive(),
            output_reserve_tokens: z.number().int().positive(),
            error_code: z.string().nullable(),
          }),
        )
        .parse(
          activeFixture.database
            .prepare(
              `SELECT estimated_input_tokens, context_window_tokens, output_reserve_tokens, error_code
               FROM model_request_records WHERE thread_id = ? AND status = 'failed'`,
            )
            .all(threadId),
        );
      report.hard_cut_failures = failedRequests.map((request) => ({
        ...request,
        provider_max_tokens: activeFixture.tracked.source.outputReserve,
      }));
      throw error;
    }
    const hardCuts = z
      .array(
        z.object({
          estimated_input_tokens: z.number().int().nonnegative(),
          context_window_tokens: z.number().int().positive(),
          output_reserve_tokens: z.number().int().positive(),
        }),
      )
      .parse(
        activeFixture.database
          .prepare(
            `SELECT estimated_input_tokens, context_window_tokens, output_reserve_tokens
             FROM model_request_records WHERE thread_id = ? AND hard_cut = 1`,
          )
          .all(threadId),
      );
    expect(hardCuts.length).toBeGreaterThan(0);
    for (const hardCut of hardCuts) {
      expect(hardCut.context_window_tokens).toBe(8192);
      expect(hardCut.output_reserve_tokens).toBe(4096);
      expect(hardCut.estimated_input_tokens * 5).toBeLessThanOrEqual(
        hardCut.context_window_tokens * 4,
      );
      expect(hardCut.estimated_input_tokens + hardCut.output_reserve_tokens).toBeLessThanOrEqual(
        hardCut.context_window_tokens,
      );
    }
    report.hard_cut_budgets = hardCuts.map((hardCut) => ({
      ...hardCut,
      provider_max_tokens: activeFixture.tracked.source.outputReserve,
    }));
    const originalRow = activeFixture.database
      .prepare("SELECT content FROM context_messages WHERE thread_id = ? AND role = 'user'")
      .get(threadId);
    expect(isRecord(originalRow) && originalRow.content === original).toBe(true);
    const recaps = activeFixture.database
      .prepare("SELECT recap_id FROM recaps WHERE thread_id = ? AND validity = 'valid'")
      .all(threadId);
    expect(recaps.length).toBeGreaterThan(0);

    await closeFixture(activeFixture);
    activeFixture = await startFixture(directory, config);
    expect(activeFixture.tracked.source.contextWindow).toBe(config.contextWindow);
    expect(activeFixture.tracked.source.outputReserve).toBe(config.outputReserve);
    report.original_recall_budget = {
      context_window_tokens: config.contextWindow,
      output_reserve_tokens: config.outputReserve,
      provider_max_tokens: activeFixture.tracked.source.outputReserve,
    };
    const recall = await runForTool(
      activeFixture,
      threadId,
      'real-original-recall',
      `Call recall exactly once with SQL SELECT content FROM context WHERE content LIKE '%${marker}%' LIMIT 5. Use the returned original Context in your answer.`,
      'recall',
    );
    expect(recall.result.content.includes(marker)).toBe(true);
  } finally {
    await closeFixture(activeFixture);
    await rm(directory, { recursive: true, force: true });
  }
}

describe('real model acceptance fixture budgets', () => {
  const config: RealModelConfig = {
    baseUrl: 'https://controlled.invalid/v1',
    apiKey: 'controlled-test-key',
    modelId: 'controlled-model',
    contextWindow: 128_000,
    outputReserve: 50_000,
    requestTimeoutMs: 120_000,
  };

  it('uses an independent feasible hard-cut budget without changing the loaded config', () => {
    const hardCutConfig = withAcceptanceBudget(config, 8192, 4096);
    expect(hardCutConfig).toEqual({ ...config, contextWindow: 8192, outputReserve: 4096 });
    expect(hardCutConfig).not.toBe(config);
    expect(config.contextWindow).toBe(128_000);
    expect(config.outputReserve).toBe(50_000);
  });

  it('rejects a fixture budget that cannot fit any input', () => {
    expect(() => withAcceptanceBudget(config, 8192, 50_000)).toThrow(
      'Invalid real model acceptance fixture budget: contextWindow=8192, outputReserve=50000.',
    );
  });
});

describe.skipIf(!enabled)('real model acceptance', () => {
  afterAll(async () => {
    const reportPath =
      process.env.KAIROS_REAL_MODEL_REPORT ??
      join(repositoryRoot, 'work/real-model-acceptance.json');
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  });

  it('AT-05 uses the actual OpenAI-compatible Provider for streams, tools, incomplete output, usage and cancellation', async () => {
    const config = loadReportConfig();
    report.model.modelId = config.modelId;

    await recordCheck('provider_text_stream_and_usage', async () => {
      const tracked = trackedProvider(config);
      const events = await collect(tracked.provider, {
        messages: [
          {
            role: 'user',
            content:
              'Write two short sentences about a public landmark. Do not call tools and do not ask a follow-up question.',
          },
        ],
        tools: [],
      });
      const deltas = events.filter((event) => event.type === 'text_delta');
      expect(deltas.length).toBeGreaterThan(0);
      const response = completeResponse(events);
      expect(response.message.content.length).toBeGreaterThan(0);
      expect(response.message.content === deltas.map((event) => event.text).join('')).toBe(true);
      checkUsage(response.usage);
    });

    await recordCheck('provider_complete_tool_call', async () => {
      const tracked = trackedProvider(config);
      const request: ModelRequest = {
        messages: [
          {
            role: 'user',
            content:
              "Call acceptance_lookup exactly once with value 'alpha'. Do not answer with plain text.",
          },
        ],
        tools: [
          {
            name: 'acceptance_lookup',
            description: 'Return a synthetic acceptance value.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              required: ['value'],
              properties: { value: { type: 'string', enum: ['alpha'] } },
            },
          },
        ],
      };
      let response: ResponseEvent | undefined;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        response = completeResponse(await collect(tracked.provider, request));
        const call = response.message.tool_calls?.find(
          (candidate) => candidate.name === 'acceptance_lookup',
        );
        if (call && call.arguments.value === 'alpha') {
          expect(call.id.length).toBeGreaterThan(0);
          checkUsage(response.usage);
          return;
        }
      }
      throw new Error('Model behavior: the requested complete tool call was not returned.');
    });

    await recordCheck('provider_incomplete_output_not_executed', async () => {
      const prompts = [
        'Call acceptance_payload exactly once with a payload containing at least 200 repetitions of the word data.',
        'You must call acceptance_payload immediately and exactly once. Do not write normal text. Set payload to the word data repeated at least 200 times. Do not stop before making the tool call.',
      ];
      let executions = 0;
      const saved: ModelMessage[] = [];
      const observedTypes: ModelEvent['type'][] = [];
      let result: Awaited<ReturnType<AgentLoop['run']>> | undefined;
      for (const [index, prompt] of prompts.entries()) {
        const tracked = trackedProvider(config, 16);
        const loop = new AgentLoop({
          provider: tracked.provider,
          persistence: {
            saveMessage: async (message) => {
              saved.push(message);
            },
            saveToolCall: async () => undefined,
          },
          tools: [
            {
              name: 'acceptance_payload',
              description: 'Accept a long synthetic payload.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['payload'],
                properties: { payload: { type: 'string', minLength: 200 } },
              },
              validate: (value) => value,
              execute: async () => {
                executions += 1;
                return 'executed';
              },
            },
          ],
        });
        result = await loop.run(prompt);
        observedTypes.push(...tracked.observedTypes);
        if (
          result.status === 'interrupted' &&
          tracked.observedTypes.includes('stream_interrupted')
        ) {
          break;
        }
        const canRetry =
          index === 0 &&
          result.status === 'completed' &&
          executions === 0 &&
          !saved.some((message) => message.role === 'tool');
        if (canRetry) continue;
        throw new Error(`Model behavior: incomplete output check ended with ${result.status}.`);
      }
      if (!result) throw new Error('The incomplete output check did not run.');
      expect(result.status).toBe('interrupted');
      expect(observedTypes).toContain('stream_interrupted');
      expect(executions).toBe(0);
      expect(saved.some((message) => message.role === 'tool')).toBe(false);
      checkUsage(result.usage);
    });

    await recordCheck('provider_cancellation', async () => {
      const tracked = trackedProvider(config, 4096);
      const controller = new AbortController();
      let sawText = false;
      let cancellation: unknown;
      try {
        for await (const event of tracked.provider.stream(
          {
            messages: [
              {
                role: 'user',
                content: '用两句话介绍公共汽车，不要使用工具。',
              },
            ],
            tools: [],
          },
          controller.signal,
        )) {
          if (event.type !== 'text_delta') continue;
          sawText = true;
          controller.abort(
            new DOMException('Real Provider acceptance cancellation.', 'AbortError'),
          );
        }
      } catch (error) {
        cancellation = error;
      }
      expect(sawText).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(cancellation instanceof DOMException && cancellation.name === 'AbortError').toBe(true);
    });
  }, 600_000);

  it('demonstrates real Server, Connect and macOS Daemon flows including hard cut and original recall', async () => {
    const config = loadReportConfig();
    report.model.modelId = config.modelId;
    await recordCheck('real_connect_daemon_bash_logs_steer_stop_reconnect', async () => {
      await runConnectedDemo(config);
    });
    await recordCheck('real_automatic_hard_cut_and_original_recall', async () => {
      await runHardCutDemo(config);
    });
  }, 900_000);

  it('demonstrates real Thread delegation, cross-Run Context and asynchronous delivery', async () => {
    const config = loadReportConfig();
    report.model.modelId = config.modelId;
    await recordCheck('real_thread_delegation_context_and_delivery', async () => {
      await runThreadDelegationDemo(config, addUsage);
    });
  }, 900_000);

  it('demonstrates real foreground and background Subagent results and cancellation', async () => {
    const config = loadReportConfig();
    report.model.modelId = config.modelId;
    await recordCheck('real_subagent_modes_status_and_cancellation', async () => {
      await runSubagentDelegationDemo(config, addUsage);
    });
  }, 900_000);
});
