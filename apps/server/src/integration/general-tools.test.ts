import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelProvider } from '@kairos/agent-core';
import { InputMode, MessageRole, RunStatus } from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { pngBytes } from '../attachments/fixtures.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { ControlledProvider, response } from './delegation-fixture.js';
import { startRealEnvironmentServer } from './environment-fixture.js';

const ownerId = 'general-tools-owner';
const accessToken = 'general-tools-access-token';
const generalTools = ['web_fetch', 'web_search', 'read_image', 'browser'];

type Fixture = Awaited<ReturnType<typeof startRealEnvironmentServer>>;
type ContextMessages = Awaited<
  ReturnType<Fixture['clients']['context']['readContext']>
>['messages'];

async function startWebFixture() {
  const requests: Array<{ url: string; headers: Record<string, unknown> }> = [];
  let markSlowStarted = () => {};
  let markSlowClosed = () => {};
  const slowStarted = new Promise<void>((resolve) => {
    markSlowStarted = resolve;
  });
  const slowClosed = new Promise<void>((resolve) => {
    markSlowClosed = resolve;
  });
  const server = createHttpServer((request, response) => {
    const url = request.url ?? '';
    requests.push({ url, headers: { ...request.headers } });
    if (url === '/article') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <html><head><title>M148 fixture</title></head><body>
        <article><h1>M148 fixture</h1><p>M148_FETCH_FIXTURE</p>
        <p>Second paragraph with enough readable article text for static extraction.</p>
        </article></body></html>`);
      return;
    }
    if (url.startsWith('/search?')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          results: [
            {
              title: 'M148 search fixture',
              url: 'https://example.com/m148',
              content: 'M148_SEARCH_FIXTURE',
            },
          ],
        }),
      );
      return;
    }
    if (url === '/slow') {
      markSlowStarted();
      request.once('close', () => markSlowClosed());
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('missing');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    slowStarted,
    slowClosed,
    articleUrl: `http://public.test:${port}/article`,
    slowUrl: `http://public.test:${port}/slow`,
    searchUrl: `http://search.test:${port}/search`,
    blockedUrl: `http://blocked.test:${port}/blocked`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type WebFixture = Awaited<ReturnType<typeof startWebFixture>>;

async function startFixture(
  directory: string,
  provider: ModelProvider,
  web: WebFixture,
  existingEnvId?: string,
) {
  const fixture = await startRealEnvironmentServer(directory, {
    ownerId,
    accessToken,
    ...(existingEnvId === undefined ? {} : { existingEnvId }),
    model: {
      provider,
      providerId: 'general-tools-test',
      modelId: 'general-tools-test-model',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
    },
    web: {
      allowedPrivateAddresses: ['127.0.0.1'],
      lookup: (hostname) => {
        if (hostname === 'blocked.test') {
          return Promise.resolve([{ address: '10.0.0.8', family: 4 }]);
        }
        if (hostname !== 'public.test' && hostname !== 'search.test') {
          throw new Error(`Unexpected test hostname: ${hostname}`);
        }
        return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
      },
      search: { provider: 'searxng', baseUrl: web.searchUrl },
      searchLimits: { maxRequestsPerMinute: 20 },
    },
  });
  if (provider instanceof ControlledProvider) {
    provider.environmentPolicy = fixture.environmentPolicy;
  }
  await writeFile(join(fixture.workspace, 'm148.png'), pngBytes);
  return fixture;
}

async function sendRoot(fixture: Fixture, threadId: string, text: string, actionId: string) {
  const sent = await fixture.clients.messages.sendMessage({
    clientActionId: actionId,
    threadId,
    text,
    mode: InputMode.FOLLOW_UP,
  });
  const snapshot = await fixture.clients.thread.getThread({ threadId });
  const run = snapshot.snapshot?.runs.find(
    (candidate) => candidate.parentRunId === undefined && candidate.inputIds.includes(sent.inputId),
  );
  if (!run) throw new Error('The accepted general-tools input has no root Run.');
  return run.runId;
}

async function waitRun(fixture: Fixture, runId: string, expected: RunStatus) {
  await vi.waitFor(
    () => {
      const row = z
        .object({ status: z.string(), error_message: z.string().nullable() })
        .parse(
          fixture.database
            .prepare('SELECT status, error_message FROM runs WHERE run_id = ?')
            .get(runId),
        );
      const expectedStatus =
        expected === RunStatus.COMPLETED
          ? 'completed'
          : expected === RunStatus.CANCELLED
            ? 'cancelled'
            : (() => {
                throw new Error(`Unsupported expected Run status: ${expected}`);
              })();
      if (row.status !== expectedStatus) {
        throw new Error(
          `Expected Run ${expectedStatus}, received ${row.status}: ${row.error_message}`,
        );
      }
    },
    { timeout: 15_000 },
  );
}

function registerActor(provider: ControlledProvider, actor: string, envId?: string) {
  provider.respond(
    `tool:${actor}-fetch`,
    response('', [
      { id: `${actor}-search`, name: 'web_search', arguments: { query: 'M148 controlled query' } },
    ]),
  );
  provider.respond(
    `tool:${actor}-search`,
    response('', [
      {
        id: `${actor}-image`,
        name: 'read_image',
        arguments: { path: 'm148.png', ...(envId ? { env_id: envId } : {}) },
      },
    ]),
  );
  provider.respond(
    `tool:${actor}-image`,
    response('', [{ id: `${actor}-browser`, name: 'browser', arguments: { action: 'close' } }]),
  );
  provider.respond(`tool:${actor}-browser`, response(`${actor} general tools complete`));
}

async function readContext(fixture: Fixture, threadId: string, agentId: string) {
  return (
    await fixture.clients.context.readContext({
      threadId,
      agentId,
      afterSeq: 0n,
      limit: 200,
    })
  ).messages;
}

function toolContent(messages: ContextMessages, callId: string): Record<string, unknown> {
  const message = messages.find(
    (candidate) => candidate.role === MessageRole.TOOL && candidate.toolCallId === callId,
  );
  if (!message) throw new Error(`Missing persisted tool result ${callId}.`);
  return z.record(z.string(), z.unknown()).parse(JSON.parse(message.content));
}

async function verifyActor(
  fixture: Fixture,
  provider: ControlledProvider,
  threadId: string,
  agentId: string,
  actor: string,
) {
  const initial = provider.requests.find(
    (request) => request.key === `user:${actor} general tools`,
  );
  expect(initial?.request.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(generalTools),
  );
  expect(initial?.request.tools.map((tool) => tool.name)).not.toContain('device_screenshot');

  const messages = await readContext(fixture, threadId, agentId);
  expect(toolContent(messages, `${actor}-fetch`)).toMatchObject({
    status: 200,
    title: 'M148 fixture',
    text: expect.stringContaining('M148_FETCH_FIXTURE'),
  });
  expect(toolContent(messages, `${actor}-search`)).toMatchObject({
    query: 'M148 controlled query',
    results: [{ title: 'M148 search fixture', url: 'https://example.com/m148' }],
  });
  const image = z
    .record(z.string(), z.unknown())
    .parse(toolContent(messages, `${actor}-image`).outcome);
  expect(image).toMatchObject({ media_type: 'image/png', width: 1, height: 1 });
  const attachmentId = z.string().parse(image.attachment_id);
  expect(toolContent(messages, `${actor}-browser`)).toMatchObject({
    status: 'ok',
    action: 'close',
    closed: true,
  });

  const rows = z
    .array(
      z.object({
        call_id: z.string(),
        result_seq: z.number().int().positive().nullable(),
        tool_status: z.string(),
      }),
    )
    .parse(
      fixture.database
        .prepare(
          `SELECT calls.call_id, calls.result_seq, messages.tool_status
           FROM context_tool_calls AS calls
           JOIN context_messages AS messages ON messages.seq = calls.result_seq
           WHERE calls.thread_id = ? AND calls.agent_id = ? AND calls.call_id LIKE ?`,
        )
        .all(threadId, agentId, `${actor}-%`),
    );
  expect(rows).toEqual(
    expect.arrayContaining(
      ['fetch', 'search', 'image', 'browser'].map((suffix) => ({
        call_id: `${actor}-${suffix}`,
        result_seq: expect.any(Number),
        tool_status: 'success',
      })),
    ),
  );
  const imageLink = z
    .object({
      attachment_id: z.string(),
      media_type: z.string(),
      content: z.instanceof(Uint8Array),
    })
    .parse(
      fixture.database
        .prepare(
          `SELECT links.attachment_id, attachments.media_type, attachments.content
           FROM context_tool_calls AS calls
           JOIN context_message_attachments AS links ON links.message_seq = calls.result_seq
           JOIN attachments ON attachments.attachment_id = links.attachment_id
           WHERE calls.thread_id = ? AND calls.agent_id = ? AND calls.call_id = ?`,
        )
        .get(threadId, agentId, `${actor}-image`),
    );
  expect(imageLink.attachment_id).toBe(attachmentId);
  expect(imageLink.media_type).toBe('image/png');
  expect(Buffer.from(imageLink.content).equals(pngBytes)).toBe(true);

  const imageRequest = provider.requests.find((request) => request.key === `tool:${actor}-image`);
  const projectedTool = imageRequest?.request.messages.find(
    (message) => message.role === 'tool' && message.tool_call_id === `${actor}-image`,
  );
  if (projectedTool?.role !== 'tool')
    throw new Error('The projected image tool result is missing.');
  expect(projectedTool.content_parts).toEqual([
    { type: 'text', text: 'Attachment: m148.png' },
    {
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${pngBytes.toString('base64')}`,
        detail: 'low',
      },
    },
  ]);
  expect(
    imageRequest?.request.messages.filter(
      (message) =>
        message.role === 'user' &&
        (message.content_parts ?? []).some((part) => part.type === 'image_url'),
    ),
  ).toEqual([]);
  const storedRequests = z.array(z.object({ request_json: z.string().nullable() })).parse(
    fixture.database
      .prepare(
        `SELECT request_json FROM model_request_records
           WHERE thread_id = ? AND agent_id = ? AND request_json IS NOT NULL`,
      )
      .all(threadId, agentId),
  );
  expect(storedRequests.some((request) => request.request_json?.includes(attachmentId))).toBe(true);
  expect(JSON.stringify(storedRequests)).not.toContain(';base64,');
}

it('main Thread reaches all four general tools and restores their records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-general-main-'));
  const web = await startWebFixture();
  const provider = new ControlledProvider();
  let fixture = await startFixture(directory, provider, web);
  try {
    registerActor(provider, 'main', fixture.envId);
    provider.respond(
      'user:main general tools',
      response('', [{ id: 'main-fetch', name: 'web_fetch', arguments: { url: web.articleUrl } }]),
    );
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const runId = await sendRoot(fixture, mainId, 'main general tools', 'main-general-tools');
    await waitRun(fixture, runId, RunStatus.COMPLETED);
    await verifyActor(fixture, provider, mainId, 'thread', 'main');

    await writeFile(join(fixture.workspace, '..', 'outside.png'), pngBytes);
    provider.respond(
      'user:main web and file checks',
      response('', [
        { id: 'main-blocked-fetch', name: 'web_fetch', arguments: { url: web.blockedUrl } },
      ]),
    );
    provider.respond(
      'tool:main-blocked-fetch',
      response('', [
        {
          id: 'main-existing-outside-image',
          name: 'read_image',
          arguments: { env_id: fixture.envId, path: '../outside.png' },
        },
      ]),
    );
    provider.respond(
      'tool:main-existing-outside-image',
      response('', [
        {
          id: 'main-missing-outside-image',
          name: 'read_image',
          arguments: { env_id: fixture.envId, path: '../missing-outside.png' },
        },
      ]),
    );
    provider.respond('tool:main-missing-outside-image', response('web and file checks complete'));
    const permissionRun = await sendRoot(
      fixture,
      mainId,
      'main web and file checks',
      'main-web-and-file-checks',
    );
    await waitRun(fixture, permissionRun, RunStatus.COMPLETED);
    const permissionMessages = await readContext(fixture, mainId, 'thread');
    expect(toolContent(permissionMessages, 'main-blocked-fetch')).toMatchObject({
      error: { code: 'blocked_address' },
    });
    expect(web.requests.some((request) => request.url === '/blocked')).toBe(false);
    expect(toolContent(permissionMessages, 'main-existing-outside-image').outcome).toMatchObject({
      attachment_id: expect.any(String),
      media_type: 'image/png',
      width: 1,
      height: 1,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(toolContent(permissionMessages, 'main-missing-outside-image')).toHaveProperty('error');
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM attachments WHERE file_name = ?')
        .get('missing-outside.png'),
    ).toEqual({ count: 0 });
    const articleRequest = web.requests.find((request) => request.url === '/article');
    expect(articleRequest?.headers).not.toHaveProperty('cookie');
    expect(articleRequest?.headers).not.toHaveProperty('authorization');
    const searchRequest = web.requests.find((request) => request.url.startsWith('/search?'));
    const searchUrl = new URL(searchRequest?.url ?? '', 'http://search.test');
    expect(Object.fromEntries(searchUrl.searchParams)).toEqual({
      q: 'M148 controlled query',
      format: 'json',
    });
    expect(JSON.stringify(searchRequest)).not.toContain('main general tools');

    await fixture.close();
    fixture = await startFixture(directory, new ControlledProvider(), web, fixture.envId);
    const recovered = await readContext(fixture, mainId, 'thread');
    expect(toolContent(recovered, 'main-fetch')).toMatchObject({
      text: expect.stringContaining('M148_FETCH_FIXTURE'),
    });
    expect(toolContent(recovered, 'main-image').outcome).toHaveProperty('attachment_id');
    expect(toolContent(recovered, 'main-browser')).toMatchObject({ closed: true });
  } finally {
    if (fixture.database.isOpen) await fixture.close();
    await web.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);

it('persistent task Thread reaches the same four tools through Connect and the real Daemon', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-general-task-'));
  const web = await startWebFixture();
  const provider = new ControlledProvider();
  const fixture = await startFixture(directory, provider, web);
  try {
    provider.respond(
      'user:task general tools',
      response('', [{ id: 'task-fetch', name: 'web_fetch', arguments: { url: web.articleUrl } }]),
    );
    registerActor(provider, 'task', fixture.envId);
    const created = await fixture.clients.thread.createThread({
      clientActionId: 'create-general-task',
      title: 'M148 task',
      initialText: 'task general tools',
      initialMode: InputMode.FOLLOW_UP,
      environmentPolicy: fixture.environmentPolicy,
    });
    if (!created.thread || !created.runId) throw new Error('The task Run was not created.');
    await waitRun(fixture, created.runId, RunStatus.COMPLETED);
    await verifyActor(fixture, provider, created.thread.threadId, 'thread', 'task');
  } finally {
    if (fixture.database.isOpen) await fixture.close();
    await web.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('foreground Subagent reaches the same four tools without gaining Router delegation tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-general-subagent-'));
  const web = await startWebFixture();
  const provider = new ControlledProvider();
  const fixture = await startFixture(directory, provider, web);
  try {
    provider.respond(
      'user:parent general tools',
      response('', [
        {
          id: 'spawn-child',
          name: 'subagent',
          arguments: { task: 'subagent general tools', mode: 'foreground' },
        },
      ]),
    );
    provider.respond(
      'user:subagent general tools',
      response('', [
        { id: 'subagent-fetch', name: 'web_fetch', arguments: { url: web.articleUrl } },
      ]),
    );
    registerActor(provider, 'subagent', fixture.envId);
    provider.respond('tool:spawn-child', response('parent general tools complete'));
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const runId = await sendRoot(fixture, mainId, 'parent general tools', 'parent-general-tools');
    await waitRun(fixture, runId, RunStatus.COMPLETED);
    const interaction = z
      .object({ target_agent_id: z.string(), target_thread_id: z.string(), status: z.string() })
      .parse(
        fixture.database
          .prepare(
            `SELECT target_agent_id, target_thread_id, status FROM interactions
             WHERE source_tool_call_id = 'spawn-child'`,
          )
          .get(),
      );
    expect(interaction).toMatchObject({ target_thread_id: mainId, status: 'completed' });
    await verifyActor(fixture, provider, mainId, interaction.target_agent_id, 'subagent');
    const childInitial = provider.requests.find(
      (request) => request.key === 'user:subagent general tools',
    );
    expect(childInitial?.request.tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['thread_call', 'thread_read', 'thread_cancel']),
    );
    const parentMessages = await readContext(fixture, mainId, 'thread');
    expect(toolContent(parentMessages, 'spawn-child')).toMatchObject({
      status: 'completed',
      result: 'subagent general tools complete',
    });
  } finally {
    if (fixture.database.isOpen) await fixture.close();
    await web.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('cancels an in-flight web fetch and persists the cancelled tool outcome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-general-cancel-'));
  const web = await startWebFixture();
  const provider = new ControlledProvider();
  const fixture = await startFixture(directory, provider, web);
  try {
    provider.respond(
      'user:cancel general fetch',
      response('', [{ id: 'cancel-fetch', name: 'web_fetch', arguments: { url: web.slowUrl } }]),
    );
    provider.register('tool:cancel-fetch', response('must not complete'));
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const runId = await sendRoot(fixture, mainId, 'cancel general fetch', 'cancel-general-fetch');
    await web.slowStarted;
    const receipt = await fixture.clients.runs.cancelRun({
      clientActionId: 'cancel-general-fetch-request',
      threadId: mainId,
      runId,
      reason: 'M148 cancellation acceptance',
    });
    expect(receipt.status).toBe(RunStatus.CANCEL_REQUESTED);
    await waitRun(fixture, runId, RunStatus.CANCELLED);
    await web.slowClosed;
    const cancelled = z
      .object({ tool_status: z.string(), tool_error_json: z.string().nullable() })
      .parse(
        fixture.database
          .prepare(
            `SELECT messages.tool_status, messages.tool_error_json
             FROM context_tool_calls AS calls
             JOIN context_messages AS messages ON messages.seq = calls.result_seq
             WHERE calls.call_id = 'cancel-fetch'`,
          )
          .get(),
      );
    expect(cancelled.tool_status).toBe('error');
    expect(cancelled.tool_error_json).toContain('cancelled');
    expect(provider.requests.some((request) => request.key === 'tool:cancel-fetch')).toBe(false);

    provider.respond(
      'user:fetch after cancellation',
      response('', [
        { id: 'healthy-fetch', name: 'web_fetch', arguments: { url: web.articleUrl } },
      ]),
    );
    provider.respond('tool:healthy-fetch', response('healthy after cancellation'));
    const healthyRun = await sendRoot(
      fixture,
      mainId,
      'fetch after cancellation',
      'fetch-after-cancellation',
    );
    await waitRun(fixture, healthyRun, RunStatus.COMPLETED);
    expect(
      toolContent(await readContext(fixture, mainId, 'thread'), 'healthy-fetch'),
    ).toMatchObject({ text: expect.stringContaining('M148_FETCH_FIXTURE') });
  } finally {
    if (fixture.database.isOpen) await fixture.close();
    await web.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

function data(value: unknown): string {
  return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return { choices: [{ delta, finish_reason: finishReason }] };
}

function usage() {
  return {
    choices: [],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

function streamResponse(events: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

it('keeps OpenAI image projection at the request layer without adding internal Context messages', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let imageEnvId = '';
  const responses = () => [
    [
      data(
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: 'projection-image',
                type: 'function',
                function: {
                  name: 'read_image',
                  arguments: JSON.stringify({ env_id: imageEnvId, path: 'm148.png' }),
                },
              },
            ],
          },
          'tool_calls',
        ),
      ),
      data(usage()),
      data('[DONE]'),
    ],
    [data(chunk({ content: 'projection complete' }, 'stop')), data(usage()), data('[DONE]')],
  ];
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
    bodies.push(z.record(z.string(), z.unknown()).parse(JSON.parse(String(init?.body))));
    const events = responses()[bodies.length - 1];
    if (!events) throw new Error('Unexpected OpenAI projection request.');
    return Promise.resolve(streamResponse(events));
  });
  const provider = new OpenAICompatibleProvider(
    {
      baseUrl: 'https://model.test/v1',
      model: 'projection-test',
      contextWindow: 128_000,
      outputReserve: 4096,
      supportsVision: true,
    },
    fetchMock,
  );
  const directory = await mkdtemp(join(tmpdir(), 'kairos-general-projection-'));
  const web = await startWebFixture();
  const fixture = await startFixture(directory, provider, web);
  try {
    imageEnvId = fixture.envId;
    const created = await fixture.clients.thread.createThread({
      clientActionId: 'create-projection-task',
      title: 'M148 projection',
      initialText: 'projection task',
      initialMode: InputMode.FOLLOW_UP,
      environmentPolicy: fixture.environmentPolicy,
    });
    if (!created.thread || !created.runId) throw new Error('The projection Run was not created.');
    await waitRun(fixture, created.runId, RunStatus.COMPLETED);
    expect(bodies).toHaveLength(2);
    const secondMessages = z.array(z.record(z.string(), z.unknown())).parse(bodies[1]?.messages);
    const toolIndex = secondMessages.findIndex((message) => message.role === 'tool');
    expect(toolIndex).toBeGreaterThan(0);
    expect(secondMessages[toolIndex]).toMatchObject({
      role: 'tool',
      tool_call_id: 'projection-image',
      name: 'read_image',
    });
    expect(secondMessages[toolIndex + 1]?.role).toBe('user');
    expect(JSON.stringify(secondMessages[toolIndex])).not.toContain('image_url');
    expect(JSON.stringify(secondMessages[toolIndex + 1])).toContain(
      `data:image/png;base64,${pngBytes.toString('base64')}`,
    );

    const internal = await readContext(fixture, created.thread.threadId, 'thread');
    expect(internal.map((message) => message.role)).toEqual([
      MessageRole.USER,
      MessageRole.ASSISTANT,
      MessageRole.TOOL,
      MessageRole.ASSISTANT,
    ]);
    expect(internal.map((message) => Number(message.seq))).toEqual([1, 2, 3, 4]);
    expect(toolContent(internal, 'projection-image').outcome).toHaveProperty('attachment_id');
    const stored = z
      .array(z.object({ request_json: z.string().nullable() }))
      .parse(
        fixture.database
          .prepare('SELECT request_json FROM model_request_records WHERE request_json IS NOT NULL')
          .all(),
      );
    expect(JSON.stringify(stored)).not.toContain(';base64,');
    expect(JSON.stringify(stored)).not.toContain('Image content from preceding tool results.');
  } finally {
    if (fixture.database.isOpen) await fixture.close();
    await web.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
