import { once } from 'node:events';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createClient, type Interceptor, type Transport } from '@connectrpc/connect';
import type { ModelProvider, ModelRequest } from '@kairos/agent-core';
import {
  ContextService,
  EventService,
  InputMode,
  MessageService,
  RunService,
  type RunStatus,
} from '@kairos/contracts';
import { expect, vi } from 'vitest';
import { z } from 'zod';
import { openDatabase } from '../storage/database.js';
import {
  controlledEnvironmentOperations,
  createEnvironmentThreadClient,
  createEnvironmentTestServer as createServer,
  seedTestEnvironment,
} from './environment-fixture.js';
import { testSessionHeaders } from './test-authentication.js';

export const thinkingOwnerId = 'thinking-acceptance-owner';
export const thinkingAccessToken = 'thinking-acceptance-connect-token';
export const thinkingUsage = { input_tokens: 11, output_tokens: 7, total_tokens: 18 };

export interface SseStep {
  data?: unknown;
  gate?: Promise<void>;
  end?: boolean;
}

export type SseScript = readonly SseStep[];

const requestSchema = z
  .object({
    messages: z.array(
      z
        .object({
          role: z.string(),
          content: z.string().nullish(),
        })
        .loose(),
    ),
  })
  .loose();

export type ObservedSseRequest = z.infer<typeof requestSchema>;

export class ControlledSseServer {
  readonly requests: ObservedSseRequest[] = [];
  readonly #server: Server;
  readonly #closing = new AbortController();
  #baseUrl = '';

  constructor(readonly scripts: readonly SseScript[]) {
    this.#server = createHttpServer((request, response) => {
      void this.#handle(request, response).catch(() => response.destroy());
    });
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async listen(): Promise<void> {
    this.#server.listen(0, '127.0.0.1');
    await once(this.#server, 'listening');
    const address = this.#server.address() as AddressInfo;
    this.#baseUrl = `http://127.0.0.1:${address.port}/v1`;
  }

  async close(): Promise<void> {
    this.#closing.abort();
    this.#server.closeAllConnections();
    if (!this.#server.listening) return;
    const closed = once(this.#server, 'close');
    this.#server.close();
    await closed;
  }

  async #handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const index = this.requests.length;
    this.requests.push(requestSchema.parse(JSON.parse(body)));
    const script = this.scripts[index];
    if (!script) {
      response.writeHead(500).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.flushHeaders();
    for (const step of script) {
      if (step.gate) {
        await Promise.race([
          step.gate,
          new Promise<void>((resolve) => {
            this.#closing.signal.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
      }
      if (this.#closing.signal.aborted || response.destroyed) return;
      if (step.end) {
        response.end();
        return;
      }
      if (step.data !== undefined) {
        const data = typeof step.data === 'string' ? step.data : JSON.stringify(step.data);
        response.write(`data: ${data}\n\n`);
      }
    }
    response.end();
  }
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

export function thinkingNetworkClients(baseUrl: string) {
  const authentication: Interceptor = (next) => async (request) => {
    for (const [name, value] of Object.entries(testSessionHeaders(thinkingAccessToken)))
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

interface ThinkingFixtureOptions {
  provider: ModelProvider;
  contextWindowTokens?: number;
  outputReserveTokens?: number;
  countTokens?: (request: ModelRequest) => number;
}

export async function startThinkingFixture(directory: string, options: ThinkingFixtureOptions) {
  const database = openDatabase(join(directory, 'server.sqlite'));
  seedTestEnvironment(database, thinkingOwnerId);
  const environmentOperations = controlledEnvironmentOperations(database);
  const server = createServer(database, false, {
    tenantId: thinkingOwnerId,
    sessionToken: thinkingAccessToken,
    model: {
      provider: options.provider,
      providerId: 'openai-compatible',
      modelId: 'thinking-acceptance-model',
      contextWindowTokens: options.contextWindowTokens ?? 128_000,
      outputReserveTokens: options.outputReserveTokens ?? 4096,
      ...(options.countTokens ? { countTokens: options.countTokens } : {}),
    },
    environmentOperations,
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    database,
    server,
    port: address.port,
    clients: thinkingNetworkClients(baseUrl),
    environmentOperations,
  };
}

export type ThinkingFixture = Awaited<ReturnType<typeof startThinkingFixture>>;

export async function closeThinkingFixture(fixture: ThinkingFixture): Promise<void> {
  if (fixture.database.isOpen) await fixture.server.close();
}

export async function createThinkingThread(fixture: ThinkingFixture, actionId: string) {
  const created = await fixture.clients.thread.createThread({
    clientActionId: actionId,
    title: 'Thinking acceptance',
  });
  if (!created.thread) throw new Error('The Thinking acceptance Thread was not created.');
  return created.thread.threadId;
}

export async function sendThinkingMessage(
  fixture: ThinkingFixture,
  threadId: string,
  actionId: string,
  text = 'Execute the controlled Thinking scenario.',
) {
  await fixture.clients.messages.sendMessage({
    clientActionId: actionId,
    threadId,
    text,
    mode: InputMode.FOLLOW_UP,
  });
  const snapshot = await fixture.clients.thread.getThread({ threadId });
  const run = snapshot.snapshot?.runs
    .filter((candidate) => candidate.parentRunId === undefined)
    .at(-1);
  if (!run) throw new Error('The Thinking acceptance Run was not created.');
  return run.runId;
}

export async function waitThinkingRun(
  fixture: ThinkingFixture,
  threadId: string,
  runId: string,
  status: RunStatus,
) {
  await vi.waitFor(
    async () => {
      const snapshot = await fixture.clients.thread.getThread({ threadId });
      expect(snapshot.snapshot?.runs.find((run) => run.runId === runId)?.status).toBe(status);
    },
    { timeout: 15_000 },
  );
}

export function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function chunk(
  delta: Record<string, unknown>,
  finishReason?: string,
): Record<string, unknown> {
  return {
    id: 'thinking-controlled-response',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
  };
}

export function usageChunk(): Record<string, unknown> {
  return {
    id: 'thinking-controlled-response',
    object: 'chat.completion.chunk',
    choices: [],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}
