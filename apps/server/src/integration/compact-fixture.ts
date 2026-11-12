import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  type Code,
  ConnectError,
  createClient,
  type Interceptor,
  type Transport,
} from '@connectrpc/connect';
import type {
  DetailedModelUsage,
  ModelEvent,
  ModelProvider,
  ModelRequest,
} from '@kairos/agent-core';
import {
  ContextService,
  ErrorDetailSchema,
  EventService,
  InputMode,
  MessageService,
  ModelService,
  type PersistedThreadEvent,
  RunService,
  type RunStatus,
  WorkspaceService,
} from '@kairos/contracts';
import { expect, vi } from 'vitest';
import { openDatabase } from '../storage/database.js';
import type { WorkspaceResourceSource } from './environment-fixture.js';
import {
  controlledEnvironmentOperations,
  createEnvironmentThreadClient,
  createEnvironmentTestServer as createServer,
  seedTestEnvironment,
} from './environment-fixture.js';
import { testSessionHeaders } from './test-authentication.js';
import { WorkspaceResourceLoader } from './workspace-resource-loader.js';

export const slashOwnerId = 'slash-command-acceptance-owner';
export const slashAccessToken = 'slash-command-acceptance-token';

type ConnectTransportFactory = (options: {
  baseUrl: string;
  httpVersion: '1.1';
  interceptors: Interceptor[];
}) => Transport;

const fastifyEntry = createRequire(import.meta.url).resolve('@connectrpc/connect-fastify');
const connectNode = createRequire(fastifyEntry)('@connectrpc/connect-node') as {
  createConnectTransport: ConnectTransportFactory;
};

export function slashNetworkClients(baseUrl: string, token = slashAccessToken) {
  const authentication: Interceptor = (next) => async (request) => {
    for (const [name, value] of Object.entries(testSessionHeaders(token)))
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
    runs: createClient(RunService, transport),
    context: createClient(ContextService, transport),
    workspace: createClient(WorkspaceService, transport),
    model: createClient(ModelService, transport),
    events: createClient(EventService, transport),
  };
}

export function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export async function expectSlashError(
  operation: Promise<unknown>,
  code: Code,
): Promise<ConnectError> {
  const error = await operation.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(ConnectError);
  if (!(error instanceof ConnectError))
    throw new Error('The operation did not fail with ConnectError.');
  expect(error.code).toBe(code);
  return error;
}

export function slashErrorTerminal(error: ConnectError): boolean | undefined {
  return error.findDetails(ErrorDetailSchema)[0]?.terminal;
}

export interface ControlledModelPlan {
  kind: 'normal' | 'recap';
  content: string;
  gate?: Promise<void>;
  failure?: string;
  cachedTokens?: number;
}

export interface CapturedSlashRequest {
  id: number;
  kind: 'normal' | 'recap';
  request: ModelRequest;
}

function requestKind(request: ModelRequest): 'normal' | 'recap' {
  const last = request.messages.at(-1);
  return last?.role === 'user' && last.content.startsWith('Kairos internal Recap operation;')
    ? 'recap'
    : 'normal';
}

export class ControlledSlashProvider implements ModelProvider {
  readonly requests: CapturedSlashRequest[] = [];
  readonly #plans: Record<'normal' | 'recap', ControlledModelPlan[]> = {
    normal: [],
    recap: [],
  };

  enqueue(plan: ControlledModelPlan): void {
    this.#plans[plan.kind].push(plan);
  }

  byKind(kind: 'normal' | 'recap'): CapturedSlashRequest[] {
    return this.requests.filter((request) => request.kind === kind);
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const kind = requestKind(request);
    const captured: CapturedSlashRequest = {
      id: this.requests.length + 1,
      kind,
      request: structuredClone(request),
    };
    this.requests.push(captured);
    const plan = this.#plans[kind].shift();
    if (!plan) throw new Error(`No controlled ${kind} response remains.`);
    if (plan.gate) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        void plan.gate?.then(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        });
      });
    }
    signal.throwIfAborted();
    if (plan.failure) throw new Error(plan.failure);
    const promptTokensDetails =
      plan.cachedTokens === undefined
        ? {}
        : { prompt_tokens_details: { cached_tokens: plan.cachedTokens } };
    const usage: DetailedModelUsage = {
      input_tokens: 100 + captured.id,
      output_tokens: Math.max(1, plan.content.length),
      total_tokens: 100 + captured.id + Math.max(1, plan.content.length),
      ...promptTokensDetails,
    };
    if (plan.content.length > 0) yield { type: 'text_delta', text: plan.content };
    yield {
      type: 'response',
      message: { role: 'assistant', content: plan.content },
      usage,
    };
  }
}

export class CountingWorkspaceLoader implements WorkspaceResourceSource {
  calls = 0;
  readonly #loader: WorkspaceResourceLoader;

  constructor(workspaceDirectory: string) {
    this.#loader = new WorkspaceResourceLoader(workspaceDirectory);
  }

  async load() {
    this.calls += 1;
    return this.#loader.load();
  }
}

interface SlashFixtureOptions {
  provider: ModelProvider;
  providerId?: string;
  modelId?: string;
  contextWindowTokens?: number;
  outputReserveTokens?: number;
  countTokens?: (request: ModelRequest) => number | Promise<number>;
  workspaceDirectory: string;
  workspaceResourceLoader?: WorkspaceResourceSource;
  periodicRecap?: { triggerMessages: number; idleAfterMs: number; maxMessages: number };
  now?: () => Date;
}

export async function startSlashFixture(directory: string, options: SlashFixtureOptions) {
  const database = openDatabase(join(directory, 'server.sqlite'));
  seedTestEnvironment(database, slashOwnerId);
  const workspaceResourceLoader =
    options.workspaceResourceLoader ?? new CountingWorkspaceLoader(options.workspaceDirectory);
  const environmentOperations = controlledEnvironmentOperations(database, () =>
    workspaceResourceLoader.load(),
  );
  const server = createServer(database, false, {
    tenantId: slashOwnerId,
    sessionToken: slashAccessToken,
    model: {
      provider: options.provider,
      providerId: options.providerId ?? 'slash-controlled-provider',
      modelId: options.modelId ?? 'slash-controlled-model',
      contextWindowTokens: options.contextWindowTokens ?? 1000,
      outputReserveTokens: options.outputReserveTokens ?? 100,
      countTokens: options.countTokens ?? (() => 100),
    },
    workspaceDirectory: options.workspaceDirectory,
    workspaceResourceLoader,
    periodicRecap: options.periodicRecap ?? {
      triggerMessages: 1000,
      idleAfterMs: 0,
      maxMessages: 20,
    },
    maxStepsPerRun: 12,
    ...(options.now ? { now: options.now } : {}),
    environmentOperations,
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    database,
    server,
    port: address.port,
    baseUrl,
    clients: slashNetworkClients(baseUrl),
    workspaceResourceLoader,
    environmentOperations,
  };
}

export type SlashFixture = Awaited<ReturnType<typeof startSlashFixture>>;

export async function closeSlashFixture(fixture: SlashFixture): Promise<void> {
  if (fixture.database.isOpen) await fixture.server.close();
}

export async function crashSlashFixture(fixture: SlashFixture): Promise<void> {
  fixture.server.server.closeAllConnections();
  if (fixture.server.server.listening) {
    await new Promise<void>((resolve, reject) => {
      fixture.server.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (fixture.database.isOpen) fixture.database.close();
}

export async function createSlashThread(
  fixture: SlashFixture,
  clientActionId: string,
  title = 'Slash command acceptance',
): Promise<string> {
  const created = await fixture.clients.thread.createThread({ clientActionId, title });
  const threadId = created.thread?.threadId;
  if (!threadId) throw new Error('The slash command Thread was not created.');
  return threadId;
}

export async function sendSlashMessage(
  fixture: SlashFixture,
  threadId: string,
  text: string,
  clientActionId: string,
  mode: InputMode = InputMode.FOLLOW_UP,
) {
  const sent = await fixture.clients.messages.sendMessage({
    clientActionId,
    threadId,
    text,
    mode,
  });
  const snapshot = await fixture.clients.thread.getThread({ threadId });
  const run = snapshot.snapshot?.runs
    .filter((candidate) => candidate.parentRunId === undefined)
    .at(-1);
  if (!run) throw new Error('The accepted slash command input has no root Run.');
  return { inputId: sent.inputId, runId: run.runId };
}

export async function waitSlashRun(
  fixture: SlashFixture,
  threadId: string,
  runId: string,
  status: RunStatus,
  timeout = 10_000,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const snapshot = await fixture.clients.thread.getThread({ threadId });
      const run = snapshot.snapshot?.runs.find((candidate) => candidate.runId === runId);
      const detail = JSON.stringify(run, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      expect(run?.status, detail).toBe(status);
    },
    { timeout },
  );
}

export async function waitSlashRequests(
  provider: ControlledSlashProvider,
  kind: 'normal' | 'recap',
  count: number,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(provider.byKind(kind)).toHaveLength(count);
    },
    { timeout: 10_000 },
  );
}

export async function readSlashEvents(
  fixture: SlashFixture,
  threadId: string,
  throughSeq?: bigint,
): Promise<PersistedThreadEvent[]> {
  const target = throughSeq ?? (await fixture.clients.thread.getThread({ threadId })).throughSeq;
  if (target === 0n) return [];
  const stream = fixture.clients.events
    .watchThread({ threadId, afterSeq: 0n })
    [Symbol.asyncIterator]();
  const events: PersistedThreadEvent[] = [];
  try {
    while (true) {
      const item = await stream.next();
      if (item.done) throw new Error('The slash event stream ended before the target cursor.');
      if (item.value.payload.case !== 'event') continue;
      const event = item.value.payload.value;
      events.push(event);
      if (event.seq === target) return events;
    }
  } finally {
    await stream.return?.();
  }
}

export function systemText(request: ModelRequest): string {
  return request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
}

export function tableCounts(fixture: SlashFixture, threadId: string) {
  const count = (table: string) => {
    const row = fixture.database
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE thread_id = ?`)
      .get(threadId);
    expect(row).toMatchObject({ count: expect.any(Number) });
    return (row as { count: number }).count;
  };
  return {
    inputs: count('inputs'),
    runs: count('runs'),
    context: count('context_messages'),
    recaps: count('recaps'),
    events: count('thread_events'),
  };
}
