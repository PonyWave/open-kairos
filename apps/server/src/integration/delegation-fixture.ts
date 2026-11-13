import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createClient, type Interceptor, type Transport } from '@connectrpc/connect';
import type { ModelEvent, ModelProvider, ModelRequest, ToolCall } from '@kairos/agent-core';
import {
  ContextService,
  EventService,
  InputMode,
  MessageService,
  RunService,
  type RunStatus,
} from '@kairos/contracts';
import { vi } from 'vitest';
import { stripMessageMeta } from '../context/model-input.js';
import { systemReminderContent } from '../sessions/system-reminder.js';
import { openDatabase } from '../storage/database.js';
import {
  type ControlledEnvironmentOperations,
  controlledEnvironmentOperations,
  createEnvironmentThreadClient,
  createEnvironmentTestServer as createServer,
  seedTestEnvironment,
  startRealEnvironmentServer,
  testEnvironmentPolicyInput,
} from './environment-fixture.js';
import { testSessionHeaders } from './test-authentication.js';

export const ownerId = 'delegation-acceptance-owner';
export const accessToken = 'delegation-acceptance-secret';
export const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };

type ConnectTransportFactory = (options: {
  baseUrl: string;
  httpVersion: '1.1';
  interceptors: Interceptor[];
}) => Transport;

const fastifyEntry = createRequire(import.meta.url).resolve('@connectrpc/connect-fastify');
const connectNode = createRequire(fastifyEntry)('@connectrpc/connect-node') as {
  createConnectTransport: ConnectTransportFactory;
};

export function networkClients(baseUrl: string, token = accessToken) {
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
    events: createClient(EventService, transport),
  };
}

export function response(content: string, toolCalls?: ToolCall[]): ModelEvent[] {
  const environmentToolCalls = toolCalls?.map((call) => {
    const createsThread =
      call.name === 'thread_call' &&
      (call.arguments.thread_id === undefined || call.arguments.thread_id === '');
    if (call.name !== 'thread_create' && call.name !== 'subagent' && !createsThread) return call;
    return {
      ...call,
      arguments: {
        allowed_env: [...testEnvironmentPolicyInput.allowedEnv],
        ...call.arguments,
      },
    };
  });
  return [
    { type: 'text_delta', text: content },
    {
      type: 'response',
      message: {
        role: 'assistant',
        content,
        ...(environmentToolCalls ? { tool_calls: environmentToolCalls } : {}),
      },
      usage,
    },
  ];
}

export function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export function requestKey(request: ModelRequest): string {
  const last = request.messages.at(-1);
  const content = last === undefined ? undefined : stripMessageMeta(last.content);
  if (last?.role === 'user' && content?.startsWith('Kairos internal Recap operation;')) {
    return 'recap:generate';
  }
  if (last?.role === 'tool') return `tool:${last.tool_call_id}`;
  if (last?.role === 'user' && content !== undefined) {
    if (content.startsWith('recap_id:')) return 'prepared:recap';
    const reminder = systemReminderContent(content);
    if (reminder !== undefined) {
      try {
        const parsed: unknown = JSON.parse(reminder.slice(reminder.indexOf('\n') + 1));
        if (typeof parsed === 'object' && parsed !== null) {
          const toolCallId = Reflect.get(parsed, 'tool_call_id');
          const kind = Reflect.get(parsed, 'kind');
          if (typeof toolCallId === 'string' && kind === 'thread_notification') {
            return `notification:${toolCallId}`;
          }
          if (typeof toolCallId === 'string' && (kind === 'thread_call' || kind === 'subagent')) {
            return `delivery:${toolCallId}`;
          }
        }
      } catch {
        // A system reminder without a delivery payload is ordinary user text.
      }
    }
    return `user:${content}`;
  }
  return last?.role ?? 'empty';
}

export class ControlledProvider implements ModelProvider {
  readonly requests: Array<{ key: string; request: ModelRequest }> = [];
  readonly #responses = new Map<string, ModelEvent[]>();
  readonly #gates = new Map<string, ReturnType<typeof deferred>>();
  environmentPolicy = testEnvironmentPolicyInput;

  register(key: string, events: ModelEvent[]): void {
    this.#responses.set(key, events);
    if (!this.#gates.has(key)) this.#gates.set(key, deferred());
  }

  respond(key: string, events: ModelEvent[]): void {
    this.register(key, events);
    this.resolve(key);
  }

  resolve(key: string): void {
    const gate = this.#gates.get(key);
    if (!gate) throw new Error(`No response gate registered for ${key}.`);
    gate.resolve();
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const key = requestKey(request);
    this.requests.push({ key, request: structuredClone(request) });
    const events = this.#responses.get(key);
    const gate = this.#gates.get(key);
    if (!events || !gate) throw new Error(`No controlled response registered for ${key}.`);
    await Promise.race([
      gate.promise,
      new Promise<void>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
    signal.throwIfAborted();
    const current = this.#responses.get(key);
    if (!current) throw new Error(`No controlled response registered for ${key}.`);
    if (current.length === 0) throw new Error(`Controlled model failure for ${key}.`);
    for (const event of this.#withEnvironmentPolicy(current)) yield event;
  }

  #withEnvironmentPolicy(events: ModelEvent[]): ModelEvent[] {
    return events.map((event) => {
      if (event.type !== 'response' || !event.message.tool_calls) return event;
      return {
        ...event,
        message: {
          ...event.message,
          tool_calls: event.message.tool_calls.map((call) => {
            const createsThread =
              call.name === 'thread_call' &&
              (call.arguments.thread_id === undefined || call.arguments.thread_id === '');
            if (call.name !== 'thread_create' && call.name !== 'subagent' && !createsThread) {
              return call;
            }
            return {
              ...call,
              arguments: {
                ...call.arguments,
                allowed_env: [...this.environmentPolicy.allowedEnv],
              },
            };
          }),
        },
      };
    });
  }
}

interface FixtureOptions {
  provider: ModelProvider;
  maxActiveThreads?: number;
  maxConcurrentModelRequests?: number;
  contextWindowTokens?: number;
  outputReserveTokens?: number;
  countTokens?: (request: ModelRequest) => number;
  realEnvironment?: boolean;
}

export async function startFixture(directory: string, options: FixtureOptions): Promise<Fixture> {
  if (options.realEnvironment) {
    const fixture = await startRealEnvironmentServer(directory, {
      ownerId,
      accessToken,
      model: {
        provider: options.provider,
        providerId: 'delegation-acceptance-provider',
        modelId: 'delegation-acceptance-model',
        contextWindowTokens: options.contextWindowTokens ?? 128_000,
        outputReserveTokens: options.outputReserveTokens ?? 4096,
        ...(options.countTokens ? { countTokens: options.countTokens } : {}),
      },
      ...(options.maxActiveThreads === undefined
        ? {}
        : { maxActiveThreads: options.maxActiveThreads }),
      ...(options.maxConcurrentModelRequests === undefined
        ? {}
        : { maxConcurrentModelRequests: options.maxConcurrentModelRequests }),
    });
    if (options.provider instanceof ControlledProvider) {
      options.provider.environmentPolicy = {
        allowedEnv: [fixture.envId],
      };
    }
    const address = fixture.server.server.address() as AddressInfo;
    return {
      database: fixture.database,
      server: fixture.server,
      port: address.port,
      baseUrl: fixture.baseUrl,
      clients: fixture.clients,
      realEnvironment: fixture,
    };
  }
  const database = openDatabase(join(directory, 'server.sqlite'));
  seedTestEnvironment(database, ownerId);
  const environmentOperations = controlledEnvironmentOperations(database);
  const server = createServer(database, false, {
    tenantId: ownerId,
    sessionToken: accessToken,
    model: {
      provider: options.provider,
      providerId: 'delegation-acceptance-provider',
      modelId: 'delegation-acceptance-model',
      contextWindowTokens: options.contextWindowTokens ?? 128_000,
      outputReserveTokens: options.outputReserveTokens ?? 4096,
      ...(options.countTokens ? { countTokens: options.countTokens } : {}),
    },
    environmentOperations,
    ...(options.maxActiveThreads === undefined
      ? {}
      : { maxActiveThreads: options.maxActiveThreads }),
    ...(options.maxConcurrentModelRequests === undefined
      ? {}
      : { maxConcurrentModelRequests: options.maxConcurrentModelRequests }),
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
    environmentOperations,
  };
}

export interface Fixture {
  database: ReturnType<typeof openDatabase>;
  server: ReturnType<typeof createServer>;
  port: number;
  baseUrl: string;
  clients: ReturnType<typeof networkClients>;
  environmentOperations?: ControlledEnvironmentOperations;
  realEnvironment?: Awaited<ReturnType<typeof startRealEnvironmentServer>>;
}

export async function closeFixture(fixture: Fixture) {
  if (fixture.realEnvironment) await fixture.realEnvironment.close();
  else if (fixture.database.isOpen) await fixture.server.close();
}

export async function sendMessage(
  fixture: Fixture,
  threadId: string,
  text: string,
  actionId: string,
  mode: InputMode = InputMode.FOLLOW_UP,
) {
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
  if (!run) throw new Error('The accepted input has no root Run.');
  return { inputId: sent.inputId, runId: run.runId };
}

export async function waitRun(
  fixture: Fixture,
  threadId: string,
  runId: string,
  status: RunStatus,
) {
  await vi.waitFor(
    async () => {
      const snapshot = await fixture.clients.thread.getThread({ threadId });
      const run = snapshot.snapshot?.runs.find((candidate) => candidate.runId === runId);
      expectRunStatus(
        run?.status,
        status,
        JSON.stringify(run, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      );
    },
    { timeout: 10_000 },
  );
}

function expectRunStatus(actual: RunStatus | undefined, expected: RunStatus, detail: string) {
  if (actual !== expected)
    throw new Error(`Expected Run status ${expected}, received ${actual}: ${detail}`);
}

export async function waitRequest(provider: ControlledProvider, key: string, count = 1) {
  await vi.waitFor(
    () => {
      const actual = provider.requests.filter((request) => request.key === key).length;
      if (actual < count)
        throw new Error(`Expected ${count} requests for ${key}, received ${actual}.`);
    },
    { timeout: 10_000 },
  );
}
