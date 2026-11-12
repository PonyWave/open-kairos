import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { type AddressInfo, connect as connectTcp, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createClient, type Interceptor, type Transport } from '@connectrpc/connect';
import type { ModelEvent, ModelProvider, ModelRequest, ToolCall } from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import {
  BashLogService,
  ContextService,
  EventService,
  InputMode,
  MessageService,
  QueueService,
  RunService,
  RunStatus,
} from '@kairos/contracts';
import { OperationStatus } from '@kairos/contracts/device';
import { expect, it, vi } from 'vitest';
import { EnvironmentStore } from '../devices/environment-store.js';
import { openDatabase } from '../storage/database.js';
import {
  createEnvironmentThreadClient,
  createEnvironmentTestServer as createServer,
  seedTestEnvironment,
  startRealEnvironmentServer,
} from './environment-fixture.js';
import { testSessionHeaders } from './test-authentication.js';

const ownerId = 'acceptance-owner';
const accessToken = 'acceptance-secret';
const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const execFileAsync = promisify(execFile);

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
    thread: createEnvironmentThreadClient(transport),
    messages: createClient(MessageService, transport),
    queue: createClient(QueueService, transport),
    runs: createClient(RunService, transport),
    context: createClient(ContextService, transport),
    logs: createClient(BashLogService, transport),
    events: createClient(EventService, transport),
  };
}

function response(content: string, toolCalls?: ToolCall[]): ModelEvent[] {
  return [
    { type: 'text_delta', text: content },
    {
      type: 'response',
      message: {
        role: 'assistant',
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      usage,
    },
  ];
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class GatedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  readonly gates: Array<ReturnType<typeof deferred>>;

  constructor(readonly responses: ModelEvent[][]) {
    this.gates = responses.map(() => deferred());
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const index = this.requests.length;
    this.requests.push(structuredClone(request));
    const gate = this.gates[index];
    const events = this.responses[index];
    if (!gate || !events) throw new Error('No gated response remains.');
    await Promise.race([
      gate.promise,
      new Promise<void>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
    signal.throwIfAborted();
    for (const event of events) yield event;
  }
}

class CallbackProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];

  constructor(
    readonly callback: (
      request: ModelRequest,
      index: number,
    ) => ModelEvent[] | Promise<ModelEvent[]>,
  ) {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    signal.throwIfAborted();
    const index = this.requests.length;
    this.requests.push(structuredClone(request));
    for (const event of await this.callback(request, index)) {
      signal.throwIfAborted();
      yield event;
    }
  }
}

interface FixtureOptions {
  provider: ModelProvider;
  contextWindowTokens?: number;
  outputReserveTokens?: number;
  countTokens?: (request: ModelRequest) => number;
  realEnvironment?: boolean;
}

async function startFixture(directory: string, options: FixtureOptions): Promise<Fixture> {
  if (options.realEnvironment) {
    const fixture = await startRealEnvironmentServer(directory, {
      ownerId,
      accessToken,
      model: {
        provider: options.provider,
        providerId: 'acceptance-provider',
        modelId: 'acceptance-model',
        contextWindowTokens: options.contextWindowTokens ?? 128_000,
        outputReserveTokens: options.outputReserveTokens ?? 4096,
        ...(options.countTokens ? { countTokens: options.countTokens } : {}),
      },
    });
    const address = fixture.server.server.address() as AddressInfo;
    return {
      database: fixture.database,
      server: fixture.server,
      port: address.port,
      clients: fixture.clients,
      realEnvironment: fixture,
    };
  }
  const database = openDatabase(join(directory, 'server.sqlite'));
  seedTestEnvironment(database, ownerId);
  const server = createServer(database, false, {
    tenantId: ownerId,
    sessionToken: accessToken,
    model: {
      provider: options.provider,
      providerId: 'acceptance-provider',
      modelId: 'acceptance-model',
      contextWindowTokens: options.contextWindowTokens ?? 128_000,
      outputReserveTokens: options.outputReserveTokens ?? 4096,
      ...(options.countTokens ? { countTokens: options.countTokens } : {}),
    },
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    database,
    server,
    port: address.port,
    clients: networkClients(baseUrl),
  };
}

interface Fixture {
  database: ReturnType<typeof openDatabase>;
  server: ReturnType<typeof createServer>;
  port: number;
  clients: ReturnType<typeof networkClients>;
  realEnvironment?: Awaited<ReturnType<typeof startRealEnvironmentServer>>;
}

async function closeFixture(fixture: Fixture) {
  if (fixture.realEnvironment) await fixture.realEnvironment.close();
  else if (fixture.database.isOpen) await fixture.server.close();
}

async function createThread(fixture: Fixture, title: string, actionId: string) {
  const created = await fixture.clients.thread.createThread({ clientActionId: actionId, title });
  if (!created.thread) throw new Error('The acceptance Thread was not created.');
  return created.thread.threadId;
}

async function sendMessage(
  fixture: Fixture,
  threadId: string,
  text: string,
  actionId: string,
  mode: InputMode = InputMode.FOLLOW_UP,
) {
  await fixture.clients.messages.sendMessage({ clientActionId: actionId, threadId, text, mode });
  const snapshot = await fixture.clients.thread.getThread({ threadId });
  const run = snapshot.snapshot?.runs
    .filter((candidate) => candidate.parentRunId === undefined)
    .at(-1);
  if (!run) throw new Error('The acceptance Run was not created.');
  return run.runId;
}

async function waitRun(fixture: Fixture, threadId: string, runId: string, status: RunStatus) {
  await vi.waitFor(
    async () => {
      const snapshot = await fixture.clients.thread.getThread({ threadId });
      const run = snapshot.snapshot?.runs.find((candidate) => candidate.runId === runId);
      const detail = JSON.stringify(run, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      expect(run?.status, detail).toBe(status);
    },
    { timeout: 10_000 },
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface DaemonProcess {
  child: ChildProcess;
  output: () => string;
}

async function startDaemon(
  fixture: Fixture,
  identityDirectory: string,
  pairingCredential: string,
  connection: { envId: string; serverUrl?: string; extraCaCerts?: string },
): Promise<DaemonProcess> {
  let output = '';
  const identityPath = join(identityDirectory, 'identity.json');
  const environment = {
    ...process.env,
    KAIROS_DEVICE_IDENTITY_PATH: identityPath,
    ...(connection.extraCaCerts ? { NODE_EXTRA_CA_CERTS: connection.extraCaCerts } : {}),
  };
  const serverUrl = connection.serverUrl ?? `ws://127.0.0.1:${fixture.port}/devices/wss`;
  await execFileAsync(
    process.execPath,
    [
      '--import',
      'tsx',
      join(repositoryRoot, 'apps/daemon/src/main.ts'),
      'pair-once',
      '--env-id',
      connection.envId,
      '--server-url',
      serverUrl,
      '--directory',
      '/tmp',
      '--device-name',
      'acceptance-mac-device',
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
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (text: string) => {
    output += text;
  });
  child.stderr?.on('data', (text: string) => {
    output += text;
  });
  child.once('exit', (code, signal) => {
    if (code !== 0 && signal === null) output += `\nDaemon exited with code ${code}.\n`;
  });
  return { child, output: () => output };
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

async function waitDeviceActive(fixture: Fixture, envId: string, daemon: DaemonProcess) {
  await vi.waitFor(
    () => {
      const device = new EnvironmentStore(fixture.database).get(ownerId, envId);
      expect(device.connectionStatus, daemon.output()).toBe('online');
      expect(device.ready, daemon.output()).toBe(true);
    },
    { timeout: 10_000 },
  );
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else files.push(relative(directory, path));
  }
  return files.sort();
}

function toolResultField(request: ModelRequest, toolName: string, field: string): string {
  const message = request.messages.find(
    (candidate) => candidate.role === 'tool' && candidate.tool_name === toolName,
  );
  if (message?.role !== 'tool') throw new Error(`Missing ${toolName} tool result.`);
  const parsed: unknown = JSON.parse(message.content);
  if (typeof parsed !== 'object' || parsed === null || !(field in parsed)) {
    throw new Error(`Missing ${field} in ${toolName} tool result.`);
  }
  const value = parsed[field as keyof typeof parsed];
  if (typeof value !== 'string') throw new Error(`${field} is not a string.`);
  return value;
}

it('AT-02/AT-12 uses real Connect streams for message control and reconnection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-acceptance-messages-'));
  const provider = new GatedProvider([
    response('first answer'),
    response('steer answer'),
    response('follow-up answer'),
  ]);
  const fixture = await startFixture(directory, { provider });
  try {
    const threadId = await createThread(fixture, '消息控制', 'create-message-thread');
    const runId = await sendMessage(fixture, threadId, 'initial', 'send-initial');
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    await fixture.clients.messages.sendMessage({
      clientActionId: 'send-steer',
      threadId,
      text: 'steer input',
      mode: InputMode.STEER,
    });
    await fixture.clients.messages.sendMessage({
      clientActionId: 'send-follow-up',
      threadId,
      text: 'follow-up input',
      mode: InputMode.FOLLOW_UP,
    });

    const beforeWatch = await fixture.clients.thread.getThread({ threadId });
    const cursor = beforeWatch.throughSeq;
    const controller = new AbortController();
    const firstWatch = fixture.clients.events
      .watchThread({ threadId, afterSeq: cursor }, { signal: controller.signal })
      [Symbol.asyncIterator]();
    const firstItem = firstWatch.next();
    provider.gates[0]?.resolve();
    await firstItem;
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    expect(
      provider.requests[1]?.messages.some((message) => message.content === 'steer input'),
    ).toBe(true);
    expect(
      provider.requests[1]?.messages.some((message) => message.content === 'follow-up input'),
    ).toBe(false);
    controller.abort();
    await firstWatch.return?.();

    provider.gates[1]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(3));
    expect(
      provider.requests[2]?.messages.some((message) => message.content === 'follow-up input'),
    ).toBe(true);
    provider.gates[2]?.resolve();
    await waitRun(fixture, threadId, runId, RunStatus.COMPLETED);

    const secondWatch = fixture.clients.events
      .watchThread({ threadId, afterSeq: cursor })
      [Symbol.asyncIterator]();
    const eventSequences = new Set<bigint>();
    let finalCommitted = false;
    while (!finalCommitted) {
      const item = await secondWatch.next();
      if (item.done) throw new Error('The event stream ended before the final message.');
      if (item.value.payload.case !== 'event') continue;
      const event = item.value.payload.value;
      expect(eventSequences.has(event.seq)).toBe(false);
      eventSequences.add(event.seq);
      finalCommitted =
        event.payload.case === 'messageCommitted' &&
        event.payload.value.message?.content === 'follow-up answer';
    }
    await secondWatch.return?.();

    const snapshot = await fixture.clients.thread.getThread({ threadId });
    expect(snapshot.snapshot?.runs.find((run) => run.runId === runId)?.status).toBe(
      RunStatus.COMPLETED,
    );
    expect(snapshot.snapshot?.messages.map((message) => message.content)).toEqual([
      'initial',
      'first answer',
      'steer input',
      'steer answer',
      'follow-up input',
      'follow-up answer',
    ]);
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('AT-07/AT-09/AT-10 preserves hard-cut evidence and recalls it after Server restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-acceptance-recap-'));
  const original = `original-marker ${'x'.repeat(10_000)}`;
  const provider = new ScriptedProvider([
    response('short recap of original-marker'),
    response('', [
      {
        id: 'recall-original',
        name: 'recall',
        arguments: {
          sql: "SELECT substr(content, 1, 30) AS content FROM context WHERE content LIKE '%original-marker%' LIMIT 5",
        },
      },
    ]),
    response('', [
      {
        id: 'recall-summary',
        name: 'recall',
        arguments: { sql: "SELECT content FROM recap WHERE content LIKE '%short recap%'" },
      },
    ]),
    response('recap of Context recall'),
    response('recap of Recap recall'),
    response('recall complete'),
  ]);
  let fixture = await startFixture(directory, {
    provider,
    contextWindowTokens: 10_000,
    outputReserveTokens: 100,
    countTokens: (request) =>
      request.messages.reduce((total, message) => total + message.content.length, 0),
  });
  try {
    const threadId = await createThread(fixture, '硬切与召回', 'create-recap-thread');
    const runId = await sendMessage(fixture, threadId, original, 'send-original');
    try {
      await waitRun(fixture, threadId, runId, RunStatus.COMPLETED);
    } catch (error) {
      const evidence = {
        messages: fixture.database
          .prepare('SELECT seq, role, LENGTH(content) AS length FROM context_messages ORDER BY seq')
          .all(),
        requests: fixture.database
          .prepare(
            'SELECT request_id, status, estimated_input_tokens, read_through_seq, error_code, error_message FROM model_request_records',
          )
          .all(),
        states: fixture.database.prepare('SELECT * FROM model_input_states').all(),
        recaps: fixture.database
          .prepare('SELECT recap_id, validity, source_message_seqs FROM recaps')
          .all(),
      };
      throw new Error(JSON.stringify(evidence), { cause: error });
    }

    const recapRequest = provider.requests[0];
    const prepared = provider.requests[1];
    expect(recapRequest?.messages.slice(0, -1)).toEqual([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('You are Kairos'),
      }),
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining(
          'All Agents load AGENTS.md and Skills from the main environment workspace',
        ),
      }),
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('<agent-execution-environment>'),
      }),
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('<workspace-resource path="AGENTS.md">'),
      }),
      { role: 'user', content: original },
    ]);
    expect(recapRequest?.messages.at(-1)).toEqual({
      role: 'user',
      content: expect.stringContaining('Kairos internal Recap operation; instruction version 4'),
    });
    expect(recapRequest?.messages.at(-1)?.content).toContain('[{"seq":1,"message_index":4}]');
    expect(recapRequest?.tools).toEqual(prepared?.tools);
    expect(prepared?.messages.some((message) => message.content === original)).toBe(false);
    expect(
      prepared?.messages.filter((message) =>
        message.content.includes('short recap of original-marker'),
      ),
    ).toHaveLength(1);
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({
      count: 1,
    });
    expect(
      fixture.database.prepare('SELECT content FROM context_messages WHERE seq = 1').get(),
    ).toEqual({ content: original });
    const context = await fixture.clients.context.readContext({
      threadId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 100,
    });
    expect(context.messages.filter((message) => message.toolName === 'recall')).toHaveLength(2);
    expect(context.messages.some((message) => message.toolName === 'recall_context')).toBe(false);
    expect(context.messages.some((message) => message.toolName === 'recall_recap')).toBe(false);

    await closeFixture(fixture);
    const reopenedProvider = new ScriptedProvider([response('after reopen')]);
    fixture = await startFixture(directory, {
      provider: reopenedProvider,
      contextWindowTokens: 1200,
      outputReserveTokens: 100,
      countTokens: () => 10,
    });
    const reopened = await fixture.clients.thread.getThread({ threadId });
    expect(reopened.snapshot?.messages[0]?.content).toBe(original);
    expect(reopened.snapshot?.runs.find((run) => run.runId === runId)?.status).toBe(
      RunStatus.COMPLETED,
    );
    const nextRunId = await sendMessage(fixture, threadId, 'new request', 'send-after-reopen');
    await waitRun(fixture, threadId, nextRunId, RunStatus.COMPLETED);
    expect(
      reopenedProvider.requests[0]?.messages.some((message) => message.content === original),
    ).toBe(false);
    expect(reopenedProvider.requests[0]?.messages[4]?.content).toContain(
      'short recap of original-marker',
    );
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('AT-04/AT-11 overlaps Subagents and propagates parent cancellation through Connect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-acceptance-subagents-'));
  const provider = new GatedProvider([
    response('', [
      {
        id: 'child-1',
        name: 'subagent',
        arguments: { task: 'child task one', mode: 'foreground' },
      },
      {
        id: 'child-2',
        name: 'subagent',
        arguments: { task: 'child task two', mode: 'foreground' },
      },
    ]),
    response('child one answer'),
    response('child two answer'),
    response('parent answer'),
  ]);
  const fixture = await startFixture(directory, { provider });
  try {
    const threadId = await createThread(fixture, '并行子任务', 'create-subagent-thread');
    const parentRunId = await sendMessage(fixture, threadId, 'parent task', 'send-parent');
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    provider.gates[0]?.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(3));
    const snapshot = await fixture.clients.thread.getThread({ threadId });
    const children = snapshot.snapshot?.runs.filter((run) => run.parentRunId === parentRunId) ?? [];
    expect(children).toHaveLength(2);
    const firstChild = children[0];
    const secondChild = children[1];
    if (!firstChild || !secondChild) throw new Error('Child Runs are missing.');
    const firstAgentId = snapshot.snapshot?.messages.find(
      (message) => message.content === 'child task one',
    )?.agentId;
    const secondAgentId = snapshot.snapshot?.messages.find(
      (message) => message.content === 'child task two',
    )?.agentId;
    expect(firstAgentId).toBeTruthy();
    expect(secondAgentId).toBeTruthy();

    provider.gates[2]?.resolve();
    await waitRun(fixture, threadId, secondChild.runId, RunStatus.COMPLETED);
    const receipt = await fixture.clients.runs.cancelRun({
      clientActionId: 'cancel-parent',
      threadId,
      runId: parentRunId,
      reason: 'acceptance cancellation',
    });
    expect(receipt.status).toBe(RunStatus.CANCEL_REQUESTED);
    await waitRun(fixture, threadId, parentRunId, RunStatus.CANCELLED);
    await waitRun(fixture, threadId, firstChild.runId, RunStatus.CANCELLED);
    await waitRun(fixture, threadId, secondChild.runId, RunStatus.COMPLETED);

    const firstContext = await fixture.clients.context.readContext({
      threadId,
      agentId: firstAgentId ?? '',
      afterSeq: 0n,
      limit: 100,
    });
    const secondContext = await fixture.clients.context.readContext({
      threadId,
      agentId: secondAgentId ?? '',
      afterSeq: 0n,
      limit: 100,
    });
    expect(firstContext.messages.map((message) => message.content)).toEqual(['child task one']);
    expect(secondContext.messages.map((message) => message.content)).toEqual([
      'child task two',
      'child two answer',
    ]);
    const parentContext = await fixture.clients.context.readContext({
      threadId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 100,
    });
    const toolResults = parentContext.messages.filter((message) => message.role === 4);
    expect(toolResults.map((message) => message.toolCallId)).toEqual(['child-1', 'child-2']);
    expect(toolResults.map((message) => JSON.parse(message.content).status)).toEqual([
      'cancelled',
      'completed',
    ]);
    expect(JSON.parse(toolResults[1]?.content ?? '{}').result).toBe('child two answer');
    expect(provider.requests).toHaveLength(3);
  } finally {
    for (const gate of provider.gates) gate.resolve();
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('AT-04/AT-13/AT-14/AT-16 runs a real Daemon, cancels Bash and pages logs offline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-acceptance-device-'));
  const workDirectory = directory;
  const effect = join(workDirectory, 'device-effect.txt');
  const cancelStarted = join(workDirectory, 'cancel-started.txt');
  const cancelFinished = join(workDirectory, 'cancel-finished.txt');
  let stopForOfflineRead: (() => Promise<void>) | undefined;
  let targetEnvId = '';
  const provider = new CallbackProvider(async (request, index) => {
    if (index === 0) {
      return response('', [
        {
          id: 'large-device-output',
          name: 'bash',
          arguments: {
            env_id: targetEnvId,
            command: `for ((i=0; i<1400; i+=1)); do printf '01234567890123456789012345678901234567890123456789\\n'; done; printf 'HIDDEN_MARKER\\n'; printf 'device-effect' > ${shellQuote(effect)}`,
            cwd: workDirectory,
            timeoutSeconds: 30,
          },
        },
      ]);
    }
    if (index === 1) return response('device output complete');
    if (index === 2) {
      return response('', [
        {
          id: 'cancel-device-command',
          name: 'bash',
          arguments: {
            env_id: targetEnvId,
            command: `printf 'started' > ${shellQuote(cancelStarted)}; sleep 30; printf 'finished' > ${shellQuote(cancelFinished)}`,
            cwd: workDirectory,
            timeoutSeconds: 60,
          },
        },
      ]);
    }
    if (index === 3) {
      if (!stopForOfflineRead) throw new Error('The real Daemon stop hook is missing.');
      await stopForOfflineRead();
      const operationId = toolResultField(request, 'bash', 'operation_id');
      return response('', [
        {
          id: 'grep-offline-log',
          name: 'read_output',
          arguments: { operation_id: operationId, offset: 65536, limit: 16384 },
        },
      ]);
    }
    if (index === 4) return response('offline log retrieved');
    throw new Error(`Unexpected device test model request ${index}.`);
  });
  const fixture = await startFixture(directory, { provider, realEnvironment: true });
  const environment = fixture.realEnvironment;
  if (!environment) throw new Error('The real environment fixture is required.');
  targetEnvId = environment.envId;
  const daemon = environment.daemon;
  stopForOfflineRead = () => daemon.stop();
  const identityDirectory = environment.identityDirectory;
  try {
    const threadId = await createThread(fixture, '真实设备', 'create-device-thread');

    const firstRunId = await sendMessage(fixture, threadId, 'large output', 'send-large-output');
    await waitRun(fixture, threadId, firstRunId, RunStatus.COMPLETED);
    expect(await readFile(effect, 'utf8')).toBe('device-effect');
    const firstContext = await fixture.clients.context.readContext({
      threadId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 100,
    });
    const deviceResult = firstContext.messages.find((message) => message.toolName === 'bash');
    expect(deviceResult?.content).toContain('"next_offset":"16384"');
    expect(deviceResult?.content).not.toContain('HIDDEN_MARKER');
    const parsedResult: unknown = JSON.parse(deviceResult?.content ?? '{}');
    if (typeof parsedResult !== 'object' || parsedResult === null) {
      throw new Error('Device tool result is not an object.');
    }
    const operationId = Reflect.get(parsedResult, 'operation_id') as unknown;
    if (typeof operationId !== 'string') {
      throw new Error('Device tool result is missing its operation ID.');
    }

    const cancelRunId = await sendMessage(fixture, threadId, 'cancel command', 'send-cancel');
    await vi.waitFor(async () => {
      expect(await readFile(cancelStarted, 'utf8')).toBe('started');
    });
    const receipt = await fixture.clients.runs.cancelRun({
      clientActionId: 'cancel-device-run',
      threadId,
      runId: cancelRunId,
      reason: 'stop real device Bash',
    });
    expect(receipt.status).toBe(RunStatus.CANCEL_REQUESTED);
    await waitRun(fixture, threadId, cancelRunId, RunStatus.CANCELLED);
    expect(
      fixture.database
        .prepare(
          `SELECT status FROM environment_operations
           WHERE action = 'bash' AND status IN (?, ?)`,
        )
        .all(OperationStatus.CANCELLED, OperationStatus.CANCEL_REQUESTED),
    ).toEqual([{ status: OperationStatus.CANCELLED }]);
    await expect(readFile(cancelFinished, 'utf8')).rejects.toThrow();

    const offlineRunId = await sendMessage(fixture, threadId, 'read offline log', 'send-offline');
    await waitRun(fixture, threadId, offlineRunId, RunStatus.COMPLETED);
    const finalContext = await fixture.clients.context.readContext({
      threadId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 100,
    });
    expect(
      finalContext.messages.find((message) => message.toolCallId === 'grep-offline-log')?.content,
    ).toContain('HIDDEN_MARKER');

    const pages: Buffer[] = [];
    let offset = 0n;
    let outputComplete = false;
    for (let index = 0; index < 1000; index += 1) {
      const page = environment.channel.readEnvironmentOperationOutput({
        tenantId: ownerId,
        operationId,
        offset,
        limit: 4096,
      });
      expect(page.outputGap).toBe(false);
      const data = Buffer.from(page.data);
      pages.push(data);
      outputComplete = page.outputComplete;
      offset = page.nextOffset;
      if (data.byteLength === 0) break;
      if (index === 999) throw new Error('Device log pagination did not finish.');
    }
    expect(outputComplete).toBe(true);
    const output = Buffer.concat(pages).toString('utf8');
    expect(output).toContain('HIDDEN_MARKER');
    expect(output.length).toBeGreaterThan(16 * 1024);
    const operations = fixture.database
      .prepare(
        "SELECT operation_id, status FROM environment_operations WHERE action = 'bash' ORDER BY created_at",
      )
      .all() as Array<{ operation_id: string; status: number }>;
    expect(operations.find((operation) => operation.operation_id === operationId)?.status).toBe(
      OperationStatus.COMPLETED,
    );
    expect(operations).toHaveLength(2);
    expect(operations.some((operation) => operation.status === OperationStatus.CANCELLED)).toBe(
      true,
    );
    expect(await filesUnder(identityDirectory)).toEqual(['identity.json']);
  } finally {
    await daemon.stop();
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('AT-15 does not repeat device side effects after a Daemon instance restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-acceptance-restart-'));
  const executions = join(directory, 'executions.txt');
  let targetEnvId = '';
  const provider = new CallbackProvider((_request, index) => {
    if (index === 0) {
      return response('', [
        {
          id: 'restart-device-command',
          name: 'bash',
          arguments: {
            env_id: targetEnvId,
            command: `printf 'execution\\n' >> ${shellQuote(executions)}; sleep 2`,
            cwd: directory,
            timeoutSeconds: 1,
          },
        },
      ]);
    }
    if (index === 1) return response('restart reconciled');
    throw new Error(`Unexpected restart test model request ${index}.`);
  });
  const fixture = await startFixture(directory, { provider, realEnvironment: true });
  const environment = fixture.realEnvironment;
  if (!environment) throw new Error('The real environment fixture is required.');
  targetEnvId = environment.envId;
  const daemon = environment.daemon;
  const identityDirectory = environment.identityDirectory;
  try {
    const threadId = await createThread(fixture, '设备重启', 'create-restart-thread');
    const runStartedAt = Date.now();
    const runId = await sendMessage(fixture, threadId, 'restart during Bash', 'send-restart');
    await vi.waitFor(async () => {
      expect(await readFile(executions, 'utf8')).toBe('execution\n');
    });

    await daemon.stop('SIGKILL');
    await daemon.start();
    await vi.waitFor(
      () => {
        const operation = fixture.database
          .prepare(
            `SELECT operation_id, status, result_source, result_recorded_at, post_processed_at
             FROM environment_operations WHERE status = ? AND result_source = 'recovery'`,
          )
          .get(OperationStatus.UNKNOWN) as
          | {
              operation_id: string;
              status: number;
              result_source: string;
              result_recorded_at: string | null;
              post_processed_at: string | null;
            }
          | undefined;
        if (!operation) throw new Error('Recovery operation was not persisted.');
        expect(operation, daemon.output()).toMatchObject({
          status: OperationStatus.UNKNOWN,
          result_source: 'recovery',
          result_recorded_at: expect.any(String),
          post_processed_at: expect.any(String),
        });
      },
      { timeout: 10_000 },
    );
    await waitRun(fixture, threadId, runId, RunStatus.COMPLETED);
    expect(Date.now() - runStartedAt).toBeLessThan(6000);
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_environment_operations WHERE result_status = 'error'",
        )
        .get(),
    ).toEqual({ count: 1 });
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(await readFile(executions, 'utf8')).toBe('execution\n');
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM environment_operations WHERE action = 'bash'")
        .get(),
    ).toEqual({ count: 1 });
    expect(await filesUnder(identityDirectory)).toEqual(['identity.json']);
  } finally {
    await daemon.stop();
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(process.platform !== 'darwin')(
  'AT-13 establishes an authenticated Daemon connection through real WSS',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kairos-acceptance-wss-'));
    const identityDirectory = join(directory, 'daemon');
    const keyPath = join(directory, 'wss-key.pem');
    const certificatePath = join(directory, 'wss-cert.pem');
    const fixture = await startFixture(directory, { provider: new ScriptedProvider([]) });
    const tunnels = new Set<Socket>();
    let proxy: ReturnType<typeof createTlsServer> | undefined;
    let daemon: DaemonProcess | undefined;
    try {
      await execFileAsync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certificatePath,
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ]);
      const [key, cert] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);
      const tlsProxy = createTlsServer({ key, cert }, (socket) => {
        const upstream = connectTcp(fixture.port, '127.0.0.1');
        tunnels.add(socket);
        tunnels.add(upstream);
        socket.on('close', () => {
          tunnels.delete(socket);
          upstream.destroy();
        });
        upstream.on('close', () => {
          tunnels.delete(upstream);
          socket.destroy();
        });
        socket.on('error', () => socket.destroy());
        upstream.on('error', () => upstream.destroy());
        socket.pipe(upstream).pipe(socket);
      });
      proxy = tlsProxy;
      await new Promise<void>((resolve) => tlsProxy.listen(0, '127.0.0.1', resolve));
      const address = tlsProxy.address() as AddressInfo;
      const serverUrl = `wss://127.0.0.1:${address.port}/devices/wss`;
      const paired = new EnvironmentStore(fixture.database).register({
        tenantId: ownerId,
        clientActionId: 'pair-wss-device',
        name: 'acceptance-wss-device',
        recommendedPwd: '/tmp',
        kind: 'self_hosted_macos',
      });
      const envId = paired.environment.envId;
      daemon = await startDaemon(fixture, identityDirectory, paired.pairingCredential, {
        envId,
        serverUrl,
        extraCaCerts: certificatePath,
      });
      await waitDeviceActive(fixture, envId, daemon);
      const identityPath = join(identityDirectory, 'identity.json');
      await vi.waitFor(async () => {
        expect(await readFile(identityPath, 'utf8')).toContain('"serverUrl"');
      });
      const identity: unknown = JSON.parse(await readFile(identityPath, 'utf8'));
      expect(Reflect.get(identity as object, 'serverUrl')).toBe(serverUrl);
      expect(await filesUnder(identityDirectory)).toEqual(['identity.json']);
      expect(new EnvironmentStore(fixture.database).get(ownerId, envId)).toMatchObject({
        bindingStatus: 'active',
        connectionStatus: 'online',
        ready: true,
      });
    } finally {
      if (daemon) await stopDaemon(daemon);
      for (const socket of tunnels) socket.destroy();
      const currentProxy = proxy;
      if (currentProxy?.listening) {
        await new Promise<void>((resolve, reject) => {
          currentProxy.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await closeFixture(fixture);
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
