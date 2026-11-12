import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelProvider, ModelRequest } from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import { expect, it, vi } from 'vitest';
import { createServer as createProductionServer } from './app.js';
import { readServerConfig } from './config.js';
import {
  controlledEnvironmentOperations,
  seedTestEnvironment,
  testEnvironmentPolicyInput,
  testEnvironmentPolicyJson,
} from './integration/environment-fixture.js';
import {
  createTestServer as createServer,
  seedTestSession,
  testIdentityOptions,
  testSessionHeaders,
} from './integration/test-authentication.js';
import { SessionStore } from './sessions/store.js';
import { openDatabase } from './storage/database.js';

it('rejects startup without identity authentication before creating business data', () => {
  const database = openDatabase(':memory:');
  try {
    expect(() => createProductionServer(database)).toThrow(
      'Server identity authentication must be configured.',
    );
    expect(
      database.prepare("SELECT name FROM sqlite_schema WHERE name = 'threads'").get(),
    ).toBeUndefined();
  } finally {
    database.close();
  }
});

it('serves the versioned health response and rejects unimplemented routes', async () => {
  const server = createServer(openDatabase(':memory:'));
  try {
    for (const url of ['/health', '/api/health']) {
      const response = await server.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        protocol_version: '1.0',
        service: 'kairos-server',
        status: 'ok',
      });
    }
    const unknown = await server.inject({ method: 'POST', url: '/message.send' });
    expect(unknown.statusCode).toBe(404);
  } finally {
    await server.close();
  }
});

it('serves real Connect JSON routes with authentication and action deduplication', async () => {
  const database = openDatabase(':memory:');
  seedTestEnvironment(database, 'local-user');
  const server = createServer(database, false, { sessionToken: 'secret' });
  const request = {
    method: 'POST' as const,
    url: '/kairos.gui.v1.ThreadService/CreateThread',
    headers: {
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      ...testSessionHeaders('secret'),
    },
    payload: {
      clientActionId: 'create-1',
      title: '会话',
      environmentPolicy: testEnvironmentPolicyJson,
    },
  };
  try {
    const first = await server.inject(request);
    expect(first.statusCode).toBe(200);
    const second = await server.inject(request);
    expect(second.statusCode).toBe(200);
    expect(second.json().thread.threadId).toBe(first.json().thread.threadId);
    expect(first.json().thread.seq).toBe('2');
    const conflict = await server.inject({
      ...request,
      payload: { ...request.payload, title: '不同参数' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('already_exists');
    const unauthenticated = await server.inject({
      ...request,
      headers: { ...request.headers, ...testSessionHeaders('wrong') },
    });
    expect(unauthenticated.statusCode).toBe(401);
    const bearerOnly = await server.inject({
      ...request,
      headers: { ...request.headers, ...testSessionHeaders(''), authorization: 'Bearer secret' },
    });
    expect(bearerOnly.statusCode).toBe(401);
    const model = await server.inject({
      method: 'POST',
      url: '/kairos.gui.v1.ModelService/GetModelStatus',
      headers: request.headers,
      payload: {},
    });
    expect(model.statusCode).toBe(200);
    expect(model.json().available).toBe(false);
    expect(model.body).not.toContain('secret');
  } finally {
    await server.close();
  }
});

it('enforces the configured RPC body limit', async () => {
  const server = createServer(openDatabase(':memory:'), false, { maxRpcBytes: 64 });
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/kairos.gui.v1.ThreadService/CreateThread',
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        ...testSessionHeaders(),
      },
      payload: { clientActionId: 'create-1', title: 'x'.repeat(100) },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().code).toBe('resource_exhausted');
  } finally {
    await server.close();
  }
});

it('marks an active Run interrupted during shutdown and restores it on reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-restart-'));
  const path = join(directory, 'kairos.sqlite');
  const provider: ModelProvider = {
    async *stream(_request, signal) {
      await new Promise<void>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const firstDatabase = openDatabase(path);
  seedTestEnvironment(firstDatabase, 'local-user');
  const first = createServer(firstDatabase, false, {
    model: {
      provider,
      providerId: 'test',
      modelId: 'test',
      contextWindowTokens: 128000,
      outputReserveTokens: 4096,
    },
    environmentOperations: controlledEnvironmentOperations(firstDatabase),
  });
  let runId = '';
  try {
    const created = await first.inject({
      method: 'POST',
      url: '/kairos.gui.v1.ThreadService/CreateThread',
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        ...testSessionHeaders(),
      },
      payload: {
        clientActionId: 'create-1',
        title: '会话',
        environmentPolicy: testEnvironmentPolicyJson,
      },
    });
    const threadId = created.json().thread.threadId as string;
    await first.inject({
      method: 'POST',
      url: '/kairos.gui.v1.MessageService/SendMessage',
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        ...testSessionHeaders(),
      },
      payload: { clientActionId: 'send-1', threadId, text: 'wait', mode: 'INPUT_MODE_FOLLOW_UP' },
    });
    const snapshot = await first.inject({
      method: 'POST',
      url: '/kairos.gui.v1.ThreadService/GetThread',
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        ...testSessionHeaders(),
      },
      payload: { threadId },
    });
    runId = snapshot.json().snapshot.runs[0].runId as string;
  } finally {
    await first.close();
  }
  const second = createServer(openDatabase(path));
  try {
    const database = openDatabase(path);
    const run = database.prepare('SELECT status FROM runs WHERE run_id = ?').get(runId) as {
      status: string;
    };
    expect(run.status).toBe('interrupted');
    database.close();
  } finally {
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps history available and records an unpaired main environment before any Provider request', async () => {
  const database = openDatabase(':memory:');
  const provider = new ScriptedProvider([]);
  const server = createProductionServer(database, false, {
    identity: testIdentityOptions(),
    model: {
      provider,
      providerId: 'test',
      modelId: 'test',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
    },
  });
  seedTestSession(database, 'local-user', 'test-session-token');
  const store = new SessionStore(database);
  const thread = store.getOrCreateMainThread('local-user');
  try {
    await server.ready();
    expect((await server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const response = await server.inject({
      method: 'POST',
      url: '/kairos.gui.v1.MessageService/SendMessage',
      headers: {
        ...testSessionHeaders(),
        'content-type': 'application/json',
        'connect-protocol-version': '1',
      },
      payload: {
        threadId: thread.threadId,
        text: 'retain this input',
        clientActionId: 'missing-platform',
        mode: 'INPUT_MODE_FOLLOW_UP',
      },
    });
    expect(response.statusCode).toBe(200);
    const runId = String(
      store.getInput('local-user', String(response.json().inputId)).consumedRunId,
    );
    await vi.waitFor(() =>
      expect(store.getRunById(runId)).toMatchObject({
        status: 'failed',
        error: { code: 'failed_precondition' },
      }),
    );
    expect(provider.requests).toHaveLength(0);
    expect(
      store.context.query({ threadId: thread.threadId, agentId: 'thread', currentOnly: true }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({ content: 'retain this input' }),
        }),
      ]),
    );
    const snapshot = await server.inject({
      method: 'POST',
      url: '/kairos.gui.v1.ThreadService/GetThread',
      headers: {
        ...testSessionHeaders(),
        'content-type': 'application/json',
        'connect-protocol-version': '1',
      },
      payload: { threadId: thread.threadId },
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().snapshot.mainEnvironment).toMatchObject({
      envId: 'main',
      statusReason: '主环境当前不可用。',
    });
  } finally {
    await server.close();
  }
});

it('reports model configuration state without credentials', async () => {
  const missing = readServerConfig({ KAIROS_DATA_DIR: '/tmp/kairos-test' });
  expect(missing.modelStatus.available).toBe(false);
  const configured = readServerConfig({
    KAIROS_DATA_DIR: '/tmp/kairos-test',
    KAIROS_MODEL_BASE_URL: 'http://localhost:1234/v1',
    KAIROS_MODEL_ID: 'model',
    KAIROS_MODEL_API_KEY: 'secret-key',
  });
  expect(configured.modelStatus.available).toBe(true);
  expect(JSON.stringify(configured.modelStatus)).not.toContain('secret-key');
  const invalid = readServerConfig({
    KAIROS_DATA_DIR: '/tmp/kairos-test',
    KAIROS_MODEL_BASE_URL: 'not-a-url',
    KAIROS_MODEL_ID: 'model',
  });
  expect(invalid.modelStatus.configurationErrors[0]?.code).toBe('invalid_model_configuration');
});

it('restores a persisted delegation delivery on startup without replaying its target Run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-delivery-startup-'));
  const path = join(directory, 'kairos.sqlite');
  const ownerId = 'local-user';
  const setupDatabase = openDatabase(path);
  seedTestEnvironment(setupDatabase, ownerId);
  let mainThreadId = '';
  let interactionId = '';
  try {
    const store = new SessionStore(setupDatabase);
    const main = store.getOrCreateMainThread(ownerId);
    mainThreadId = main.threadId;
    const task = store.createThread({
      ownerId,
      clientActionId: 'create-task',
      method: 'CreateThread',
      parameters: { title: '持久任务', environmentPolicy: testEnvironmentPolicyInput },
      title: '持久任务',
      environmentPolicy: testEnvironmentPolicyInput,
    });
    const source = store.sendMessage({
      ownerId,
      clientActionId: 'source-input',
      method: 'SendMessage',
      parameters: { threadId: main.threadId, text: '主任务', mode: 'follow_up' },
      threadId: main.threadId,
      text: '主任务',
      mode: 'follow_up',
    });
    store.appendModelMessage({
      runId: source.runId,
      inputId: source.input.inputId,
      message: { role: 'user', content: '主任务' },
    });
    store.appendModelMessage({
      runId: source.runId,
      message: { role: 'assistant', content: '主任务已提交' },
    });
    store.updateRunStatus(source.runId, 'completed');
    const accepted = store.acceptThreadCall({
      ownerId,
      sourceThreadId: main.threadId,
      sourceAgentId: 'thread',
      sourceRunId: source.runId,
      sourceToolCallId: 'thread-call',
      targetThreadId: task.threadId,
      prompt: '后台任务',
      mode: 'follow_up',
    });
    interactionId = accepted.interaction.sourceToolCallId;
    store.appendModelMessage({
      runId: accepted.runId,
      inputId: accepted.input.inputId,
      message: { role: 'user', content: '后台任务' },
    });
    const targetResponse = store.appendModelMessage({
      runId: accepted.runId,
      message: { role: 'assistant', content: '后台结果' },
    });
    store.recordInteractionResponses({
      runId: accepted.runId,
      messageId: targetResponse.messageId,
      interactionKeys: [accepted.interaction],
    });
    store.updateRunStatus(accepted.runId, 'completed');
  } finally {
    setupDatabase.close();
  }

  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    async *stream(request) {
      requests.push(structuredClone(request));
      yield {
        type: 'response',
        message: { role: 'assistant', content: '交付已处理' },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
    },
  };
  const serverDatabase = openDatabase(path);
  const server = createServer(serverDatabase, false, {
    environmentOperations: controlledEnvironmentOperations(serverDatabase),
    model: {
      provider,
      providerId: 'test',
      modelId: 'test',
      contextWindowTokens: 128000,
      outputReserveTokens: 4096,
    },
  });
  const inspect = openDatabase(path);
  try {
    await vi.waitFor(() => {
      const delivery = inspect
        .prepare('SELECT status FROM interaction_deliveries WHERE source_tool_call_id = ?')
        .get(interactionId) as { status: string };
      expect(delivery.status).toBe('consumed');
    });
    const delivered = inspect
      .prepare(
        'SELECT run_id, context_message_seq FROM interaction_deliveries WHERE source_tool_call_id = ?',
      )
      .get(interactionId) as { run_id: string; context_message_seq: number };
    expect(
      inspect.prepare('SELECT status FROM runs WHERE run_id = ?').get(delivered.run_id),
    ).toEqual({ status: 'completed' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.at(-1)?.content).toContain('后台结果');
    expect(requests[0]?.messages.some((message) => message.content === '后台任务')).toBe(false);
    const snapshot = await server.inject({
      method: 'POST',
      url: '/kairos.gui.v1.ThreadService/GetThread',
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        ...testSessionHeaders(),
      },
      payload: { threadId: mainThreadId },
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.body).toContain(interactionId);
    expect(snapshot.body).toContain('后台结果');
  } finally {
    inspect.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('passes web search configuration through a real Server tool call without exposing context or credentials', async () => {
  const searchRequests: Array<{
    url: string | undefined;
    headers: import('node:http').IncomingHttpHeaders;
  }> = [];
  const searchServer = createHttpServer((request, response) => {
    searchRequests.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ web: { results: [] } }));
  });
  await new Promise<void>((resolve, reject) => {
    searchServer.once('error', reject);
    searchServer.listen(0, '127.0.0.1', () => resolve());
  });
  const searchPort = (searchServer.address() as AddressInfo).port;
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
  const provider = new ScriptedProvider([
    [
      {
        type: 'response',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'app-web-search', name: 'web_search', arguments: { query: 'public-query' } },
          ],
        },
        usage,
      },
    ],
    [
      {
        type: 'response',
        message: { role: 'assistant', content: 'done' },
        usage,
      },
    ],
  ]);
  const database = openDatabase(':memory:');
  seedTestEnvironment(database, 'local-user');
  const server = createServer(database, false, {
    model: {
      provider,
      providerId: 'test',
      modelId: 'test',
      contextWindowTokens: 128000,
      outputReserveTokens: 4096,
    },
    environmentOperations: controlledEnvironmentOperations(database),
    web: {
      lookup: (hostname) => {
        expect(hostname).toBe('search.test');
        return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
      },
      search: {
        provider: 'brave',
        baseUrl: `http://search.test:${searchPort}/res/v1/web/search`,
        apiKey: 'secret-app-brave-key',
      },
    },
  });
  const headers = {
    'content-type': 'application/json',
    'connect-protocol-version': '1',
    ...testSessionHeaders(),
  };
  try {
    const created = await server.inject({
      method: 'POST',
      url: '/kairos.gui.v1.ThreadService/CreateThread',
      headers,
      payload: {
        clientActionId: 'create-web-task',
        title: 'Web task',
        environmentPolicy: testEnvironmentPolicyJson,
      },
    });
    expect(created.statusCode).toBe(200);
    const threadId = created.json().thread.threadId as string;
    const sent = await server.inject({
      method: 'POST',
      url: '/kairos.gui.v1.MessageService/SendMessage',
      headers,
      payload: {
        clientActionId: 'send-web-task',
        threadId,
        text: 'thread-context-secret-marker',
        mode: 'INPUT_MODE_FOLLOW_UP',
      },
    });
    expect(sent.statusCode).toBe(200);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    expect(searchRequests).toHaveLength(1);
    const searchRequest = searchRequests[0];
    expect(searchRequest?.headers['x-subscription-token']).toBe('secret-app-brave-key');
    expect(searchRequest?.headers.cookie).toBeUndefined();
    expect(JSON.stringify(searchRequest)).not.toContain('thread-context-secret-marker');
    const url = new URL(searchRequest?.url ?? '', 'http://search.test');
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'public-query', count: '5' });
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['web_fetch', 'web_search']),
    );
    expect(JSON.stringify(provider.requests)).not.toContain('secret-app-brave-key');
  } finally {
    await server.close();
    searchServer.closeAllConnections();
    await new Promise<void>((resolve) => searchServer.close(() => resolve()));
  }
});
