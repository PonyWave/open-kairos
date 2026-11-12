import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ModelRequest, ToolCall } from '@kairos/agent-core';
import { expect } from 'vitest';
import { z } from 'zod';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { openDatabase } from '../storage/database.js';
import { networkClients } from './delegation-fixture.js';
import {
  controlledEnvironmentOperations,
  createEnvironmentTestServer as createServer,
  seedTestEnvironment,
} from './environment-fixture.js';

export const periodicOwnerId = 'periodic-recap-acceptance-owner';
export const periodicAccessToken = 'periodic-recap-acceptance-token';
export const periodicModelId = 'periodic-recap-acceptance-model';

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

export type CapturedModelBody = z.infer<typeof capturedBodySchema>;
export type CapturedModelRequest = {
  id: number;
  kind: 'normal' | 'recap';
  raw: string;
  body: CapturedModelBody;
};

export interface ControlledSsePlan {
  kind: 'normal' | 'recap';
  content: string;
  toolCalls?: ToolCall[];
  cachedTokens?: number;
  gate?: Promise<void>;
  httpStatus?: number;
}

function requestKind(body: CapturedModelBody): 'normal' | 'recap' {
  const content = body.messages.at(-1)?.content;
  return typeof content === 'string' && content.startsWith('Kairos internal Recap operation;')
    ? 'recap'
    : 'normal';
}

function data(value: unknown): string {
  return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
}

export class ControlledSseServer {
  readonly requests: CapturedModelRequest[] = [];
  readonly errors: string[] = [];
  readonly #plans: Record<'normal' | 'recap', ControlledSsePlan[]> = {
    normal: [],
    recap: [],
  };
  readonly #server: Server;
  readonly baseUrl: string;

  private constructor(server: Server, port: number) {
    this.#server = server;
    this.baseUrl = `http://127.0.0.1:${port}/v1`;
  }

  static async listen(): Promise<ControlledSseServer> {
    let fixture: ControlledSseServer;
    const server = createHttpServer((request, response) => {
      void fixture.handle(request, response).catch((error: unknown) => {
        fixture.errors.push(error instanceof Error ? error.message : String(error));
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' });
        }
        if (!response.destroyed) {
          response.end(JSON.stringify({ error: { message: 'Controlled SSE failure.' } }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    fixture = new ControlledSseServer(server, address.port);
    return fixture;
  }

  enqueue(plan: ControlledSsePlan): void {
    this.#plans[plan.kind].push(plan);
  }

  byKind(kind: 'normal' | 'recap'): CapturedModelRequest[] {
    return this.requests.filter((request) => request.kind === kind);
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
    this.#server.closeAllConnections();
    await closed;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      throw new Error(`Unexpected model endpoint ${request.method ?? ''} ${request.url ?? ''}.`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = capturedBodySchema.parse(JSON.parse(raw));
    const kind = requestKind(body);
    const captured: CapturedModelRequest = {
      id: this.requests.length + 1,
      kind,
      raw,
      body,
    };
    this.requests.push(captured);
    const plan = this.#plans[kind].shift();
    if (!plan) throw new Error(`No controlled ${kind} response remains.`);
    if (plan.httpStatus !== undefined) {
      response.writeHead(plan.httpStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Controlled HTTP failure.' } }));
      return;
    }
    if (plan.gate) {
      let unblock = () => {};
      const closed = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      response.once('close', unblock);
      await Promise.race([plan.gate, closed]);
      response.off('close', unblock);
      if (response.destroyed) return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    if (plan.content.length > 0) {
      response.write(
        data({ choices: [{ delta: { content: plan.content }, finish_reason: null }] }),
      );
    }
    for (const [index, call] of (plan.toolCalls ?? []).entries()) {
      response.write(
        data({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index,
                    id: call.id,
                    type: 'function',
                    function: {
                      name: call.name,
                      arguments: JSON.stringify(call.arguments),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      );
    }
    response.write(
      data({
        choices: [
          {
            delta: {},
            finish_reason: (plan.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop',
          },
        ],
      }),
    );
    const promptTokens = 100 + captured.id;
    const completionTokens = Math.max(1, plan.content.length);
    response.write(
      data({
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          ...(plan.cachedTokens === undefined
            ? {}
            : { prompt_tokens_details: { cached_tokens: plan.cachedTokens } }),
        },
      }),
    );
    response.end(data('[DONE]'));
  }
}

export interface PeriodicClock {
  now: number;
}

interface FixtureOptions {
  clock: PeriodicClock;
  triggerMessages: number;
  idleAfterMs: number;
  maxMessages: number;
  contextWindowTokens?: number;
  outputReserveTokens?: number;
  countTokens?: (request: ModelRequest) => number;
}

export async function startPeriodicFixture(
  directory: string,
  modelServer: ControlledSseServer,
  options: FixtureOptions,
) {
  const database = openDatabase(join(directory, 'server.sqlite'));
  seedTestEnvironment(database, periodicOwnerId);
  const environmentOperations = controlledEnvironmentOperations(database);
  const contextWindowTokens = options.contextWindowTokens ?? 1000;
  const outputReserveTokens = options.outputReserveTokens ?? 100;
  const provider = new OpenAICompatibleProvider({
    baseUrl: modelServer.baseUrl,
    apiKey: 'controlled-acceptance-key',
    model: periodicModelId,
    contextWindow: contextWindowTokens,
    outputReserve: outputReserveTokens,
    requestTimeoutMs: 5000,
  });
  const server = createServer(database, false, {
    tenantId: periodicOwnerId,
    sessionToken: periodicAccessToken,
    now: () => new Date(options.clock.now),
    model: {
      provider,
      providerId: 'openai-compatible',
      modelId: periodicModelId,
      contextWindowTokens,
      outputReserveTokens,
      countTokens: options.countTokens ?? (() => 100),
    },
    periodicRecap: {
      triggerMessages: options.triggerMessages,
      idleAfterMs: options.idleAfterMs,
      maxMessages: options.maxMessages,
    },
    maxStepsPerRun: 10,
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
    clients: networkClients(baseUrl, periodicAccessToken),
    environmentOperations,
  };
}

export type PeriodicFixture = Awaited<ReturnType<typeof startPeriodicFixture>>;

export async function createPeriodicThread(fixture: PeriodicFixture, actionId: string) {
  const created = await fixture.clients.thread.createThread({
    clientActionId: actionId,
    title: 'Periodic Recap acceptance',
  });
  const threadId = created.thread?.threadId;
  if (!threadId) throw new Error('The periodic Recap Thread was not created.');
  return threadId;
}

export function expectCompletePrefix(
  normal: CapturedModelRequest,
  recap: CapturedModelRequest,
  appendedMessages: number,
): void {
  const prefixLength = normal.body.messages.length;
  expect(recap.body.messages).toHaveLength(prefixLength + appendedMessages);
  const normalPrefix = JSON.stringify(normal.body.messages);
  const recapPrefix = JSON.stringify(recap.body.messages.slice(0, prefixLength));
  expect(Buffer.from(recapPrefix).equals(Buffer.from(normalPrefix))).toBe(true);
  expect(recap.raw).toContain(`"messages":${normalPrefix.slice(0, -1)},`);
  for (const key of ['model', 'tools', 'max_tokens', 'stream', 'stream_options'] as const) {
    expect(JSON.stringify(recap.body[key])).toBe(JSON.stringify(normal.body[key]));
  }
}

export function recapMappings(request: CapturedModelRequest): Array<{
  seq: number;
  message_index: number;
}> {
  const content = request.body.messages.at(-1)?.content;
  if (typeof content !== 'string') throw new Error('The Recap instruction has no text content.');
  const match = content.match(
    /Source Context sequences and their zero-based positions in this request's messages array:\n(\[[^\n]+\])\n/,
  );
  if (!match?.[1]) throw new Error('The Recap instruction has no source mappings.');
  return z
    .array(
      z.object({ seq: z.number().int().positive(), message_index: z.number().int().nonnegative() }),
    )
    .parse(JSON.parse(match[1]));
}

export function expectCleanContext(fixture: PeriodicFixture, recapContent: string): void {
  const rows = z
    .array(z.object({ role: z.string(), content: z.string() }))
    .parse(fixture.database.prepare('SELECT role, content FROM context_messages').all());
  expect(rows.some((row) => row.content.includes('Kairos internal Recap operation;'))).toBe(false);
  expect(rows.some((row) => row.role === 'assistant' && row.content === recapContent)).toBe(false);
}
