import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createClient, type Interceptor, type Transport } from '@connectrpc/connect';
import type { ModelProvider, ModelRequest } from '@kairos/agent-core';
import {
  ContextService,
  EventService,
  MessageService,
  QueueService,
  RunService,
} from '@kairos/contracts';
import { openDatabase } from '../storage/database.js';
import {
  createEnvironmentThreadClient,
  createEnvironmentTestServer as createServer,
  seedTestEnvironment,
} from './environment-fixture.js';
import { testSessionHeaders } from './test-authentication.js';

export {
  ControlledProvider,
  closeFixture,
  deferred,
  requestKey,
  response,
  sendMessage,
  usage,
  waitRequest,
  waitRun,
} from './delegation-fixture.js';

export const ownerId = 'revision-acceptance-owner';
export const accessToken = 'revision-acceptance-secret';

type ConnectTransportFactory = (options: {
  baseUrl: string;
  httpVersion: '1.1';
  interceptors: Interceptor[];
}) => Transport;

const fastifyEntry = createRequire(import.meta.url).resolve('@connectrpc/connect-fastify');
const connectNode = createRequire(fastifyEntry)('@connectrpc/connect-node') as {
  createConnectTransport: ConnectTransportFactory;
};

export function revisionNetworkClients(baseUrl: string) {
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
    events: createClient(EventService, transport),
  };
}

interface RevisionFixtureOptions {
  provider: ModelProvider;
  contextWindowTokens?: number;
  outputReserveTokens?: number;
  countTokens?: (request: ModelRequest) => number;
  periodicRecap?: { triggerMessages: number; idleAfterMs: number; maxMessages: number };
}

export async function startRevisionFixture(directory: string, options: RevisionFixtureOptions) {
  const database = openDatabase(join(directory, 'server.sqlite'));
  seedTestEnvironment(database, ownerId);
  const server = createServer(database, false, {
    tenantId: ownerId,
    sessionToken: accessToken,
    model: {
      provider: options.provider,
      providerId: 'revision-acceptance-provider',
      modelId: 'revision-acceptance-model',
      contextWindowTokens: options.contextWindowTokens ?? 128_000,
      outputReserveTokens: options.outputReserveTokens ?? 4096,
      ...(options.countTokens ? { countTokens: options.countTokens } : {}),
    },
    ...(options.periodicRecap ? { periodicRecap: options.periodicRecap } : {}),
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    database,
    server,
    port: address.port,
    baseUrl,
    clients: revisionNetworkClients(baseUrl),
  };
}

export type RevisionFixture = Awaited<ReturnType<typeof startRevisionFixture>>;
