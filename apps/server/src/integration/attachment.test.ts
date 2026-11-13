import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Code, createClient, type Interceptor, type Transport } from '@connectrpc/connect';
import type { ModelEvent, ModelProvider, ModelRequest } from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import {
  AttachmentService,
  ContextService,
  InputMode,
  MessageRole,
  MessageService,
  RunService,
  ThreadCardSort,
} from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { jpegBytes, pngBytes, utf8 } from '../attachments/fixtures.js';
import { stripMessageMeta } from '../context/model-input.js';
import { openDatabase } from '../storage/database.js';
import {
  ControlledProvider,
  response as controlledResponse,
  waitRequest,
} from './delegation-fixture.js';
import {
  createEnvironmentThreadClient,
  createEnvironmentTestServer as createServer,
  seedTestEnvironment,
} from './environment-fixture.js';
import { testSessionHeaders } from './test-authentication.js';

const ownerId = 'attachment-integration-owner';
const accessToken = 'attachment-integration-secret';
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

type ConnectTransportFactory = (options: {
  baseUrl: string;
  httpVersion: '1.1';
  interceptors: Interceptor[];
}) => Transport;

const fastifyEntry = createRequire(import.meta.url).resolve('@connectrpc/connect-fastify');
const connectNode = createRequire(fastifyEntry)('@connectrpc/connect-node') as {
  createConnectTransport: ConnectTransportFactory;
};

function response(text: string): ModelEvent[] {
  return [
    { type: 'text_delta', text },
    { type: 'response', message: { role: 'assistant', content: text }, usage },
  ];
}

function clients(baseUrl: string) {
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
    attachments: createClient(AttachmentService, transport),
    threads: createEnvironmentThreadClient(transport),
    messages: createClient(MessageService, transport),
    runs: createClient(RunService, transport),
    context: createClient(ContextService, transport),
  };
}

async function start(
  directory: string,
  provider: ModelProvider,
  options: { counts?: number[] } = {},
) {
  const counts = options.counts ?? [100];
  let countIndex = 0;
  const database = openDatabase(join(directory, 'server.sqlite'));
  seedTestEnvironment(database, ownerId);
  const server = createServer(database, false, {
    tenantId: ownerId,
    sessionToken: accessToken,
    model: {
      provider,
      providerId: 'attachment-test',
      modelId: 'attachment-test-model',
      contextWindowTokens: 1000,
      outputReserveTokens: 100,
      countTokens: () => counts[Math.min(countIndex++, counts.length - 1)] ?? 100,
    },
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address() as AddressInfo;
  return { database, server, clients: clients(`http://127.0.0.1:${address.port}`) };
}

type Fixture = Awaited<ReturnType<typeof start>>;

async function waitStatus(database: Fixture['database'], runId: string, status: string) {
  await vi.waitFor(
    () => {
      const row = z
        .object({ status: z.string() })
        .parse(database.prepare('SELECT status FROM runs WHERE run_id = ?').get(runId));
      expect(row.status).toBe(status);
    },
    { timeout: 5000 },
  );
}

async function sendRoot(
  fixture: Fixture,
  threadId: string,
  text: string,
  clientActionId: string,
): Promise<string> {
  const sent = await fixture.clients.messages.sendMessage({
    clientActionId,
    threadId,
    text,
    mode: InputMode.FOLLOW_UP,
  });
  const snapshot = await fixture.clients.threads.getThread({ threadId });
  const run = snapshot.snapshot?.runs.find(
    (candidate) => candidate.parentRunId === undefined && candidate.inputIds.includes(sent.inputId),
  );
  if (!run) throw new Error('The accepted input has no root Run.');
  return run.runId;
}

async function waitDelivery(database: Fixture['database'], toolCallId: string): Promise<void> {
  await vi.waitFor(
    () => {
      const row = z
        .object({ status: z.string() })
        .parse(
          database
            .prepare('SELECT status FROM interaction_deliveries WHERE source_tool_call_id = ?')
            .get(toolCallId),
        );
      expect(row.status).toBe('consumed');
    },
    { timeout: 5000 },
  );
}

async function upload(
  fixture: Fixture,
  clientActionId: string,
  fileName: string,
  data: Uint8Array,
) {
  const response = await fixture.clients.attachments.uploadAttachment({
    clientActionId,
    fileName,
    data,
  });
  if (!response.attachment) throw new Error('Upload returned no attachment.');
  return response.attachment;
}

function imageParts(request: ModelRequest | undefined) {
  return request?.messages.flatMap((message) =>
    message.role === 'user'
      ? (message.content_parts ?? []).filter((part) => part.type === 'image_url')
      : [],
  );
}

it('sends stored text and images, preserves history and inherits attachments on rerun', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-attachment-runtime-'));
  const provider = new ScriptedProvider([response('first answer'), response('rerun answer')]);
  let fixture = await start(directory, provider);
  try {
    const text = await upload(fixture, 'upload-text', 'note.txt', utf8('UNIQUE_ATTACHMENT_TEXT'));
    const png = await upload(fixture, 'upload-png', 'pixel.png', pngBytes);
    const jpeg = await upload(fixture, 'upload-jpeg', 'pixel.jpg', jpegBytes);
    const created = await fixture.clients.threads.createThread({
      clientActionId: 'create-with-attachments',
      title: 'Attachments',
      initialText: '',
      initialMode: InputMode.FOLLOW_UP,
      initialAttachmentIds: [text.attachmentId, png.attachmentId, jpeg.attachmentId],
    });
    if (!created.runId || !created.thread) throw new Error('The attachment Run was not created.');
    const threadId = created.thread.threadId;
    await waitStatus(fixture.database, created.runId, 'completed');

    const firstUser = provider.requests[0]?.messages.find(
      (message) => message.role === 'user' && message.content_parts !== undefined,
    );
    expect(firstUser?.role).toBe('user');
    expect(stripMessageMeta(String(firstUser?.content))).toBe('');
    if (firstUser?.role !== 'user') throw new Error('The multimodal user message is missing.');
    const textPath = `/workspace/.kairos/attachments/${text.attachmentId}.txt`;
    const pngPath = `/workspace/.kairos/attachments/${png.attachmentId}.png`;
    const jpegPath = `/workspace/.kairos/attachments/${jpeg.attachmentId}.jpg`;
    expect(firstUser.content_parts).toEqual([
      {
        type: 'text',
        text: `Attachment: note.txt\nOriginal sandbox file: ${textPath}\nUse read with this path and omit env_id to read the original file later.`,
      },
      { type: 'text', text: 'UNIQUE_ATTACHMENT_TEXT' },
      {
        type: 'text',
        text: `Attachment: pixel.png\nOriginal sandbox file: ${pngPath}\nUse read_image with this path and omit env_id to read the original file later.`,
      },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${pngBytes.toString('base64')}`, detail: 'low' },
      },
      {
        type: 'text',
        text: `Attachment: pixel.jpg\nOriginal sandbox file: ${jpegPath}\nUse read_image with this path and omit env_id to read the original file later.`,
      },
      {
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${jpegBytes.toString('base64')}`, detail: 'low' },
      },
    ]);
    const storedRequest = z
      .object({ request_json: z.string() })
      .parse(
        fixture.database
          .prepare("SELECT request_json FROM model_request_records WHERE status = 'completed'")
          .get(),
      );
    expect(storedRequest.request_json).toContain(text.attachmentId);
    expect(storedRequest.request_json).not.toContain('UNIQUE_ATTACHMENT_TEXT');
    expect(storedRequest.request_json).not.toContain('base64,');
    const storedAttachments = z
      .array(
        z.object({
          attachment_id: z.string(),
          media_type: z.string(),
          content: z.instanceof(Uint8Array),
        }),
      )
      .parse(
        fixture.database
          .prepare(
            `SELECT attachment_id, media_type, content FROM attachments
             WHERE attachment_id IN (?, ?, ?) ORDER BY created_at, attachment_id`,
          )
          .all(text.attachmentId, png.attachmentId, jpeg.attachmentId),
      );
    expect(storedAttachments).toHaveLength(3);
    for (const [attachmentId, mediaType, bytes] of [
      [text.attachmentId, 'text/plain', utf8('UNIQUE_ATTACHMENT_TEXT')],
      [png.attachmentId, 'image/png', pngBytes],
      [jpeg.attachmentId, 'image/jpeg', jpegBytes],
    ] as const) {
      const stored = storedAttachments.find((row) => row.attachment_id === attachmentId);
      expect(stored?.media_type).toBe(mediaType);
      expect(Buffer.from(stored?.content ?? []).equals(bytes)).toBe(true);
    }

    const snapshot = await fixture.clients.threads.getThread({ threadId });
    const user = snapshot.snapshot?.messages.find((message) => message.role === MessageRole.USER);
    expect(user?.attachments.map((attachment) => attachment.attachmentId)).toEqual([
      text.attachmentId,
      png.attachmentId,
      jpeg.attachmentId,
    ]);
    expect(snapshot.snapshot?.inputs[0]?.attachments).toHaveLength(3);
    expect(user?.attachments[0]).not.toHaveProperty('content');
    expect(user?.attachments[0]).not.toHaveProperty('ownerId');
    if (!user) throw new Error('The committed user message is missing.');
    const inputId = snapshot.snapshot?.inputs[0]?.inputId;
    if (!inputId) throw new Error('The committed attachment Input is missing.');
    const attachmentIds = [text.attachmentId, png.attachmentId, jpeg.attachmentId];
    const inputLinks = z
      .array(z.object({ attachment_id: z.string() }))
      .parse(
        fixture.database
          .prepare(
            'SELECT attachment_id FROM input_attachments WHERE input_id = ? ORDER BY position',
          )
          .all(inputId),
      );
    expect(inputLinks.map((link) => link.attachment_id)).toEqual(attachmentIds);
    const contextLinks = z.array(z.object({ attachment_id: z.string() })).parse(
      fixture.database
        .prepare(
          `SELECT attachment_id FROM context_message_attachments
             WHERE message_seq = ? ORDER BY position`,
        )
        .all(Number(user.seq)),
    );
    expect(contextLinks.map((link) => link.attachment_id)).toEqual(attachmentIds);
    const workspaceLinks = z
      .array(
        z.object({
          attachment_id: z.string(),
          source: z.string(),
          workspace_status: z.string(),
          env_id: z.string(),
          path: z.string(),
          operation_id: z.string(),
        }),
      )
      .parse(
        fixture.database
          .prepare(
            `SELECT attachment_id, source, workspace_status, env_id, path, operation_id
             FROM context_message_attachments WHERE message_seq = ? ORDER BY position`,
          )
          .all(Number(user.seq)),
      );
    expect(workspaceLinks).toEqual([
      {
        attachment_id: text.attachmentId,
        source: 'file',
        workspace_status: 'completed',
        env_id: expect.any(String),
        path: textPath,
        operation_id: expect.any(String),
      },
      {
        attachment_id: png.attachmentId,
        source: 'file',
        workspace_status: 'completed',
        env_id: expect.any(String),
        path: pngPath,
        operation_id: expect.any(String),
      },
      {
        attachment_id: jpeg.attachmentId,
        source: 'file',
        workspace_status: 'completed',
        env_id: expect.any(String),
        path: jpegPath,
        operation_id: expect.any(String),
      },
    ]);
    const downloaded = await fixture.clients.attachments.downloadAttachment({
      attachmentId: png.attachmentId,
      limitBytes: 262_144,
    });
    expect(Buffer.from(downloaded.data).equals(pngBytes)).toBe(true);

    await fixture.clients.messages.reviseMessage({
      clientActionId: 'revise-attachment',
      threadId: user.threadId,
      messageId: user.messageId,
      text: 'latest question',
    });
    const rerun = (
      await fixture.clients.threads.getThread({ threadId: user.threadId })
    ).snapshot?.runs.find((run) => run.rerunFromMessageSeq === user.seq);
    if (!rerun) throw new Error('Revision did not start the attachment Rerun.');
    await waitStatus(fixture.database, rerun.runId, 'completed');
    const rerunUser = provider.requests[1]?.messages.find(
      (message) =>
        message.role === 'user' && stripMessageMeta(String(message.content)) === 'latest question',
    );
    expect(stripMessageMeta(String(rerunUser?.content))).toBe('latest question');
    expect(imageParts(provider.requests[1])).toHaveLength(2);

    const audit = await fixture.clients.context.readContext({
      threadId: user.threadId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 100,
    });
    expect(
      audit.messages.find((message) => message.messageId === user.messageId)?.attachments,
    ).toHaveLength(3);

    await fixture.server.close();
    const recoveredProvider = new ScriptedProvider([]);
    fixture = await start(directory, recoveredProvider);
    const recovered = await fixture.clients.threads.getThread({ threadId: user.threadId });
    expect(
      recovered.snapshot?.messages.find((message) => message.messageId === user.messageId)
        ?.attachments,
    ).toHaveLength(3);
    const recoveredBytes = await fixture.clients.attachments.downloadAttachment({
      attachmentId: text.attachmentId,
      limitBytes: 262_144,
    });
    expect(Buffer.from(recoveredBytes.data).toString()).toBe('UNIQUE_ATTACHMENT_TEXT');
  } finally {
    if (fixture.database.isOpen) await fixture.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('materializes the same immutable image in recap generation without storing base64', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-attachment-recap-'));
  const provider = new ScriptedProvider([response('image summary'), response('final answer')]);
  const fixture = await start(directory, provider, { counts: [901, 100] });
  try {
    const png = await upload(fixture, 'upload-recap-png', 'pixel.png', pngBytes);
    const created = await fixture.clients.threads.createThread({
      clientActionId: 'create-recap-attachment',
      title: 'Attachment recap',
      initialText: 'describe the image',
      initialMode: InputMode.FOLLOW_UP,
      initialAttachmentIds: [png.attachmentId],
    });
    if (!created.runId) throw new Error('The recap Run was not created.');
    await waitStatus(fixture.database, created.runId, 'completed');
    expect(provider.requests).toHaveLength(2);
    expect(imageParts(provider.requests[0])).toEqual([
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${pngBytes.toString('base64')}`, detail: 'low' },
      },
    ]);
    expect(provider.requests[0]?.messages.at(-1)).toMatchObject({ role: 'user' });
    expect(provider.requests[0]?.messages.at(-1)?.content).toContain(
      'Kairos internal Recap operation',
    );
    expect(imageParts(provider.requests[1])).toHaveLength(0);
    expect(
      provider.requests[1]?.messages.some((message) => message.content.includes('image summary')),
    ).toBe(true);
    const storedRequest = z
      .object({ request_json: z.string() })
      .parse(
        fixture.database
          .prepare("SELECT request_json FROM model_request_records WHERE status = 'completed'")
          .get(),
      );
    expect(storedRequest.request_json).not.toContain('base64,');
  } finally {
    if (fixture.database.isOpen) await fixture.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('fails before dispatch when a stored attachment is missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-attachment-missing-'));
  const provider = new ScriptedProvider([]);
  const fixture = await start(directory, provider);
  try {
    const text = await upload(fixture, 'upload-missing', 'missing.txt', utf8('missing bytes'));
    fixture.database.exec('PRAGMA foreign_keys = OFF');
    fixture.database.exec(`
      CREATE TRIGGER remove_attachment_before_prepare
      AFTER INSERT ON model_request_records
      BEGIN
        DELETE FROM attachments WHERE attachment_id = '${text.attachmentId.replaceAll("'", "''")}';
      END;
    `);
    const created = await fixture.clients.threads.createThread({
      clientActionId: 'create-missing-attachment',
      title: 'Missing attachment',
      initialText: 'must not dispatch',
      initialMode: InputMode.FOLLOW_UP,
      initialAttachmentIds: [text.attachmentId],
    });
    if (!created.runId) throw new Error('The missing-attachment Run was not created.');
    await waitStatus(fixture.database, created.runId, 'failed');
    expect(provider.requests).toHaveLength(0);
    const request = z
      .object({ status: z.string(), request_json: z.string().nullable() })
      .parse(
        fixture.database.prepare('SELECT status, request_json FROM model_request_records').get(),
      );
    expect(request).toEqual({ status: 'failed', request_json: null });
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_events WHERE event_type = 'model_request_dispatched'",
        )
        .get(),
    ).toEqual({ count: 0 });
  } finally {
    if (fixture.database.isOpen) await fixture.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('accepts CreateThread with only attachment IDs and validates the initial mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-attachment-create-'));
  const provider = new ScriptedProvider([
    response('first attachment'),
    response('second attachment'),
  ]);
  const fixture = await start(directory, provider);
  try {
    const text = await upload(fixture, 'upload-create-only', 'only.txt', utf8('attachment only'));
    const created = await fixture.clients.threads.createThread({
      clientActionId: 'create-only-attachment',
      title: 'Only attachment',
      initialMode: InputMode.FOLLOW_UP,
      initialAttachmentIds: [text.attachmentId],
    });
    if (!created.runId || !created.thread)
      throw new Error('Attachment-only input was not accepted.');
    await waitStatus(fixture.database, created.runId, 'completed');
    const snapshot = await fixture.clients.threads.getThread({ threadId: created.thread.threadId });
    expect(snapshot.snapshot?.inputs[0]?.text).toBe('');
    expect(
      snapshot.snapshot?.inputs[0]?.attachments.map((attachment) => attachment.attachmentId),
    ).toEqual([text.attachmentId]);

    const threadCount = z
      .object({ count: z.number().int().nonnegative() })
      .parse(fixture.database.prepare('SELECT COUNT(*) AS count FROM threads').get()).count;
    await expect(
      fixture.clients.threads.createThread({
        clientActionId: 'create-missing-mode',
        title: 'Missing mode',
        initialAttachmentIds: [text.attachmentId],
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM threads').get()).toEqual({
      count: threadCount,
    });

    const explicit = await fixture.clients.threads.createThread({
      clientActionId: 'create-explicit-empty-text',
      title: 'Explicit empty text',
      initialText: '',
      initialMode: InputMode.FOLLOW_UP,
      initialAttachmentIds: [text.attachmentId],
    });
    if (!explicit.runId || !explicit.thread)
      throw new Error('Explicit empty text was not accepted.');
    await waitStatus(fixture.database, explicit.runId, 'completed');
    const explicitSnapshot = await fixture.clients.threads.getThread({
      threadId: explicit.thread.threadId,
    });
    expect(explicitSnapshot.snapshot?.inputs[0]?.text).toBe('');
    expect(explicitSnapshot.snapshot?.inputs[0]?.attachments).toHaveLength(1);
  } finally {
    if (fixture.database.isOpen) await fixture.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('paginates sorted cards and isolates replies by their exact thread_call interval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-attachment-workbench-'));
  const provider = new ControlledProvider();
  provider.respond(
    'user:create card',
    controlledResponse('', [
      {
        id: 'card-call-one',
        name: 'thread_call',
        arguments: {
          thread_id: '',
          title: 'Delegated card',
          prompt: 'first card prompt',
          mode: 'follow_up',
        },
      },
    ]),
  );
  provider.register('tool:card-call-one', controlledResponse('unused'));
  provider.register('user:first card prompt', controlledResponse('first card answer'));
  const fixture = await start(directory, provider);
  try {
    const mainId = (await fixture.clients.threads.getOrCreateMain({})).thread?.threadId ?? '';
    expect(mainId).not.toBe('');
    const firstMainRunId = await sendRoot(fixture, mainId, 'create card', 'send-create-card');
    await waitRequest(provider, 'user:first card prompt');
    const firstInteraction = z
      .object({ target_thread_id: z.string(), status: z.string() })
      .parse(
        fixture.database
          .prepare(
            'SELECT target_thread_id, status FROM interactions WHERE source_tool_call_id = ?',
          )
          .get('card-call-one'),
      );
    const taskId = firstInteraction.target_thread_id;
    expect(firstInteraction.status).toBe('running');
    provider.respond('delivery:card-call-one', controlledResponse('first delivery handled'));
    provider.resolve('user:first card prompt');
    await vi.waitFor(() => {
      const row = z
        .object({ status: z.string() })
        .parse(
          fixture.database
            .prepare('SELECT status FROM interactions WHERE source_tool_call_id = ?')
            .get('card-call-one'),
        );
      expect(row.status).toBe('completed');
    });
    provider.respond('tool:card-call-one', controlledResponse('first main response'));
    await waitStatus(fixture.database, firstMainRunId, 'completed');
    await waitDelivery(fixture.database, 'card-call-one');

    provider.respond(
      'user:continue card',
      controlledResponse('', [
        {
          id: 'card-call-two',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'second card prompt', mode: 'follow_up' },
        },
      ]),
    );
    provider.respond('tool:card-call-two', controlledResponse('second main response'));
    provider.register('user:second card prompt', controlledResponse('second card answer'));
    provider.respond('delivery:card-call-two', controlledResponse('second delivery handled'));
    await sendRoot(fixture, mainId, 'continue card', 'send-continue-card');
    await waitRequest(provider, 'user:second card prompt');
    provider.resolve('user:second card prompt');
    await waitDelivery(fixture.database, 'card-call-two');

    const text = await upload(
      fixture,
      'upload-standalone-card',
      'standalone.txt',
      utf8('STANDALONE_ATTACHMENT_BODY'),
    );
    provider.respond('user:standalone card prompt', controlledResponse('standalone card answer'));
    const standalone = await fixture.clients.threads.createThread({
      clientActionId: 'create-standalone-card',
      title: 'Standalone card',
      initialText: 'standalone card prompt',
      initialMode: InputMode.FOLLOW_UP,
      initialAttachmentIds: [text.attachmentId],
    });
    if (!standalone.runId || !standalone.thread) {
      throw new Error('The standalone attachment card was not created.');
    }
    const standaloneId = standalone.thread.threadId;
    await waitStatus(fixture.database, standalone.runId, 'completed');

    const reference = (sourceToolCallId: string) => ({
      sourceThreadId: mainId,
      sourceAgentId: 'thread',
      sourceToolCallId,
    });
    const previews = await fixture.clients.threads.listThreadCallPreviews({
      calls: [reference('card-call-two'), reference('missing-call'), reference('card-call-one')],
    });
    expect(previews.previews.map((preview) => preview.call?.delegation?.sourceToolCallId)).toEqual([
      'card-call-two',
      'card-call-one',
    ]);
    expect(previews.previews[0]).toMatchObject({
      targetThreadId: taskId,
      targetTitle: 'Delegated card',
      replyCount: 1n,
    });
    expect(previews.previews[1]).toMatchObject({
      targetThreadId: taskId,
      targetTitle: 'Delegated card',
      replyCount: 1n,
    });
    expect(previews.previews[0]?.replies.map((reply) => reply.text)).toEqual([
      'second card answer',
    ]);
    expect(previews.previews[1]?.replies.map((reply) => reply.text)).toEqual(['first card answer']);
    expect(previews.previews[0]?.responseMessageSeq).not.toBe(
      previews.previews[1]?.responseMessageSeq,
    );

    fixture.database
      .prepare('UPDATE threads SET created_at = ? WHERE thread_id = ?')
      .run('2026-01-01T00:00:00.000Z', taskId);
    fixture.database
      .prepare('UPDATE threads SET created_at = ? WHERE thread_id = ?')
      .run('2026-01-03T00:00:00.000Z', standaloneId);
    fixture.database
      .prepare('UPDATE context_messages SET created_at = ? WHERE thread_id = ?')
      .run('2026-01-04T00:00:00.000Z', taskId);
    fixture.database
      .prepare('UPDATE context_messages SET created_at = ? WHERE thread_id = ?')
      .run('2026-01-02T00:00:00.000Z', standaloneId);

    const createdFirst = await fixture.clients.threads.listThreadCards({
      sort: ThreadCardSort.CREATED_AT,
      limit: 1,
    });
    expect(createdFirst.cards.map((card) => card.thread?.threadId)).toEqual([standaloneId]);
    expect(createdFirst.hasMore).toBe(true);
    const createdSecond = await fixture.clients.threads.listThreadCards({
      sort: ThreadCardSort.CREATED_AT,
      limit: 1,
      cursor: createdFirst.nextCursor,
    });
    expect(createdSecond.cards.map((card) => card.thread?.threadId)).toEqual([taskId]);
    expect(createdSecond.hasMore).toBe(false);
    expect(createdSecond.nextCursor).toBeUndefined();

    const recentFirst = await fixture.clients.threads.listThreadCards({
      sort: ThreadCardSort.LAST_MESSAGE_AT,
      limit: 1,
    });
    expect(recentFirst.cards.map((card) => card.thread?.threadId)).toEqual([taskId]);
    expect(recentFirst.hasMore).toBe(true);
    expect(recentFirst.cards[0]?.sourceCall?.delegation?.sourceToolCallId).toBe('card-call-one');
    expect(recentFirst.cards[0]?.messages.map((message) => message.text)).toEqual([
      'first card answer',
      'second card answer',
    ]);
    const recentSecond = await fixture.clients.threads.listThreadCards({
      sort: ThreadCardSort.LAST_MESSAGE_AT,
      limit: 1,
      cursor: recentFirst.nextCursor,
    });
    expect(recentSecond.cards.map((card) => card.thread?.threadId)).toEqual([standaloneId]);
    expect(recentSecond.cards[0]?.messages.map((message) => message.text)).toEqual([
      'standalone card prompt',
      'standalone card answer',
    ]);
    expect(recentSecond.cards[0]?.messages[0]).not.toHaveProperty('content');
    expect(recentSecond.cards[0]?.messages[0]?.attachments).toHaveLength(1);
    expect(recentSecond.cards[0]?.messages[0]?.attachments[0]).toMatchObject({
      attachmentId: text.attachmentId,
      fileName: 'standalone.txt',
      mediaType: 'text/plain',
      sizeBytes: BigInt(utf8('STANDALONE_ATTACHMENT_BODY').length),
    });
    expect(recentSecond.cards[0]?.messages[0]?.attachments[0]).not.toHaveProperty('content');
    expect(recentSecond.hasMore).toBe(false);
  } finally {
    if (fixture.database.isOpen) await fixture.server.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
