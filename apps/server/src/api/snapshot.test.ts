import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Interceptor, type Transport } from '@connectrpc/connect';
import {
  create,
  GetThreadRequestSchema,
  type GetThreadResponse,
  GetThreadResponseSchema,
  InputStatus,
  ThreadService,
  ThreadSnapshotCursorSchema,
  toBinary,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { EnvironmentOperationStore } from '../devices/environment-operation-store.js';
import {
  createTestServer as createServer,
  seedTestSession,
  testSessionInterceptor,
} from '../integration/test-authentication.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { getThreadSnapshot } from './snapshot.js';

const ownerId = 'snapshot-owner';

function fixture() {
  const database = openDatabase(':memory:');
  const now = new Date('2026-11-03T00:00:00.000Z');
  seedTestSession(database, ownerId, 'snapshot-session');
  const store = new SessionStore(database, { clock: () => now });
  const thread = store.createThread({
    ownerId,
    method: 'CreateThread',
    clientActionId: 'create',
    parameters: {},
    title: '分页',
  });
  return { database, store, thread };
}

function send(store: SessionStore, threadId: string, actionId: string, text = '输入') {
  return store.sendMessage({
    ownerId,
    method: 'SendMessage',
    clientActionId: actionId,
    parameters: {},
    threadId,
    text,
    mode: 'follow_up',
  });
}

it('projects a configured main environment that is not ready as unavailable', () => {
  const { database, store } = fixture();
  new EnvironmentOperationStore(database);
  try {
    const thread = store.getOrCreateMainThread(ownerId);
    const request = create(GetThreadRequestSchema, { threadId: thread.threadId });
    const mainEnvironment = { envId: 'main', workspace: '/workspace' };
    const unavailable = getThreadSnapshot(store, ownerId, request, {
      mainEnvironment,
      mainEnvironmentReady: false,
    }).snapshot?.mainEnvironment;
    expect(unavailable).toMatchObject({
      envId: 'main',
      statusReason: '主环境当前不可用。',
    });
    const ready = getThreadSnapshot(store, ownerId, request, {
      mainEnvironment,
      mainEnvironmentReady: true,
    }).snapshot?.mainEnvironment;
    expect(ready?.envId).toBe(unavailable?.envId);
    expect(ready?.statusReason).toBeUndefined();
    expect(database.prepare('SELECT COUNT(*) AS count FROM environment_operations').get()).toEqual({
      count: 0,
    });
  } finally {
    database.close();
  }
});

function appendMessages(store: SessionStore, threadId: string, count: number, size = 100) {
  const sent = send(store, threadId, 'seed-input');
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const message = store.appendModelMessage({
      runId: sent.runId,
      messageId: `message-${index}`,
      ...(index === 0 ? { inputId: sent.input.inputId } : {}),
      message: {
        role: index === 0 ? 'user' : 'assistant',
        content: `${index}:${'m'.repeat(size)}`,
      },
    });
    ids.push(message.messageId);
  }
  return { ids, runId: sent.runId };
}

function readAll(
  store: SessionStore,
  threadId: string,
  options: {
    maxBytes?: number;
    maxRecords?: number;
    limit?: number;
    cursor?: GetThreadResponse['nextCursor'];
  } = {},
) {
  const pages: GetThreadResponse[] = [];
  let cursor = options.cursor;
  do {
    const page = getThreadSnapshot(
      store,
      ownerId,
      create(GetThreadRequestSchema, {
        threadId,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
      options,
    );
    pages.push(page);
    expect(page.hasMore).toBe(page.nextCursor !== undefined);
    expect(toBinary(GetThreadResponseSchema, page).length).toBeLessThanOrEqual(
      options.maxBytes ?? 900 * 1024,
    );
    const count =
      (page.snapshot?.messages.length ?? 0) +
      (page.snapshot?.inputs.length ?? 0) +
      (page.snapshot?.runs.length ?? 0) +
      (page.snapshot?.devices.length ?? 0) +
      (page.snapshot?.recaps.length ?? 0) +
      (page.snapshot?.notifications.length ?? 0);
    expect(count).toBeLessThanOrEqual(options.maxRecords ?? 100);
    cursor = page.nextCursor;
    expect(pages.length).toBeLessThan(100);
  } while (cursor !== undefined);
  return pages;
}

describe('Thread snapshot pages', () => {
  it('keeps a small legacy snapshot complete', () => {
    const { database, store, thread } = fixture();
    try {
      appendMessages(store, thread.threadId, 2);
      const pages = readAll(store, thread.threadId);
      expect(pages).toHaveLength(1);
      expect(pages[0]?.snapshot?.thread?.threadId).toBe(thread.threadId);
      expect(pages[0]?.snapshot?.messages).toHaveLength(2);
      expect(pages[0]?.snapshot?.inputs).toHaveLength(1);
      expect(pages[0]?.snapshot?.runs).toHaveLength(1);
      expect(pages[0]?.hasMore).toBe(false);
    } finally {
      database.close();
    }
  });

  it('returns an empty snapshot without a cursor', () => {
    const { database, store, thread } = fixture();
    try {
      const pages = readAll(store, thread.threadId);
      expect(pages).toHaveLength(1);
      expect(pages[0]?.snapshot?.messages).toEqual([]);
      expect(pages[0]?.snapshot?.inputs).toEqual([]);
      expect(pages[0]?.snapshot?.runs).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('uses row cursors across agents and identical timestamps', () => {
    const { database, store, thread } = fixture();
    try {
      const { runId } = appendMessages(store, thread.threadId, 2);
      for (const agentId of ['subagent-a', 'subagent-b']) {
        const child = store.createChildRun(ownerId, runId, agentId);
        store.appendModelMessage({
          runId: child.runId,
          messageId: `message-${agentId}`,
          message: { role: 'assistant', content: agentId },
        });
      }
      const pages = readAll(store, thread.threadId, { limit: 1, maxRecords: 1 });
      const messages = pages.flatMap((page) => page.snapshot?.messages ?? []);
      const runs = pages.flatMap((page) => page.snapshot?.runs ?? []);
      expect(messages.map((message) => message.messageId)).toEqual([
        'message-0',
        'message-1',
        'message-subagent-a',
        'message-subagent-b',
      ]);
      expect(new Set(messages.map((message) => message.messageId)).size).toBe(4);
      expect(runs).toHaveLength(3);
      expect(new Set(runs.map((run) => run.runId)).size).toBe(3);
      expect(new Set(pages.map((page) => page.throughSeq)).size).toBe(1);
    } finally {
      database.close();
    }
  });

  it('pages valid Recap content with stable cursors and excludes invalid records', () => {
    const { database, store, thread } = fixture();
    try {
      appendMessages(store, thread.threadId, 2);
      for (const recapId of ['recap-a', 'recap-b', 'recap-c']) {
        store.recaps.save({
          recapId,
          threadId: thread.threadId,
          agentId: 'thread',
          sourceMessageSeqs: [recapId === 'recap-c' ? 2 : 1],
          content: `${recapId} 正文`,
        });
      }
      store.recaps.invalidate(thread.threadId, 'thread', 'recap-b', 'source_revised');

      const pages = readAll(store, thread.threadId, { limit: 1, maxRecords: 1 });
      const recaps = pages.flatMap((page) => page.snapshot?.recaps ?? []);
      expect(recaps.map((recap) => recap.recapId)).toEqual(['recap-a', 'recap-c']);
      expect(recaps.map((recap) => recap.content)).toEqual(['recap-a 正文', 'recap-c 正文']);
      expect(new Set(recaps.map((recap) => recap.seq)).size).toBe(2);
      expect(recaps.every((recap) => recap.seq > 0n)).toBe(true);
      expect(new Set(pages.map((page) => page.throughSeq)).size).toBe(1);
    } finally {
      database.close();
    }
  });

  it('rolls back a Recap and its creation event in the same transaction', () => {
    const { database, store, thread } = fixture();
    try {
      appendMessages(store, thread.threadId, 1);
      expect(() =>
        store.transaction(() => {
          store.recaps.save({
            recapId: 'rolled-back',
            threadId: thread.threadId,
            agentId: 'thread',
            sourceMessageSeqs: [1],
            content: '不应提交',
          });
          throw new Error('injected commit failure');
        }),
      ).toThrow('injected commit failure');
      expect(store.recaps.query({ threadId: thread.threadId, agentId: 'thread' })).toEqual([]);
      expect(
        store
          .listEvents(thread.threadId, 0n)
          .filter((event) => event.payload.case === 'recapCreated'),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('excludes later inserts and skips records deleted between pages', () => {
    const { database, store, thread } = fixture();
    try {
      const { runId } = appendMessages(store, thread.threadId, 3);
      const first = getThreadSnapshot(
        store,
        ownerId,
        create(GetThreadRequestSchema, { threadId: thread.threadId, limit: 1 }),
        { maxRecords: 1 },
      );
      expect(first.nextCursor).toBeDefined();
      database.prepare('DELETE FROM context_messages WHERE message_id = ?').run('message-2');
      store.appendModelMessage({
        runId,
        messageId: 'message-later',
        message: { role: 'assistant', content: 'later' },
      });
      const second = getThreadSnapshot(
        store,
        ownerId,
        create(GetThreadRequestSchema, { threadId: thread.threadId, cursor: first.nextCursor }),
        { maxRecords: 1 },
      );
      expect(second.snapshot?.messages.map((message) => message.messageId)).toEqual(['message-1']);
      expect(second.throughSeq).toBe(first.throughSeq);
      expect(second.hasMore).toBe(true);

      const remaining = readAll(store, thread.threadId, {
        limit: 1,
        maxRecords: 1,
        cursor: second.nextCursor,
      });
      expect(
        remaining
          .flatMap((page) => page.snapshot?.messages ?? [])
          .map((message) => message.messageId),
      ).not.toContain('message-later');
      expect(
        store
          .listEvents(thread.threadId, first.throughSeq, 500)
          .some(
            (event) =>
              event.payload.case === 'messageCommitted' &&
              event.payload.value.message.messageId === 'message-later',
          ),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it('returns a terminal empty page when all remaining records are deleted', () => {
    const { database, store, thread } = fixture();
    try {
      appendMessages(store, thread.threadId, 2);
      const first = getThreadSnapshot(
        store,
        ownerId,
        create(GetThreadRequestSchema, { threadId: thread.threadId, limit: 1 }),
        { maxRecords: 1 },
      );
      database.prepare('DELETE FROM context_messages WHERE message_id = ?').run('message-1');
      database.prepare('DELETE FROM inputs WHERE thread_id = ?').run(thread.threadId);
      database
        .prepare('DELETE FROM agent_execution_environments WHERE thread_id = ?')
        .run(thread.threadId);
      database.prepare('DELETE FROM runs WHERE thread_id = ?').run(thread.threadId);
      const second = getThreadSnapshot(
        store,
        ownerId,
        create(GetThreadRequestSchema, { threadId: thread.threadId, cursor: first.nextCursor }),
        { maxRecords: 1 },
      );
      expect(second.snapshot?.messages).toEqual([]);
      expect(second.snapshot?.inputs).toEqual([]);
      expect(second.snapshot?.runs).toEqual([]);
      expect(second.hasMore).toBe(false);
      expect(second.nextCursor).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('enforces byte and record budgets on every page', () => {
    const { database, store, thread } = fixture();
    try {
      appendMessages(store, thread.threadId, 5, 500);
      const pages = readAll(store, thread.threadId, {
        maxBytes: 1200,
        maxRecords: 2,
        limit: 2,
      });
      expect(pages.length).toBeGreaterThan(2);
      expect(pages.flatMap((page) => page.snapshot?.messages ?? [])).toHaveLength(5);
    } finally {
      database.close();
    }
  });

  it('rejects a single record that cannot fit instead of exceeding the budget', () => {
    const { database, store, thread } = fixture();
    try {
      appendMessages(store, thread.threadId, 1, 1000);
      expect(() =>
        getThreadSnapshot(
          store,
          ownerId,
          create(GetThreadRequestSchema, { threadId: thread.threadId }),
          { maxBytes: 300 },
        ),
      ).toThrowError(expect.objectContaining({ code: 'internal' }));
    } finally {
      database.close();
    }
  });

  it('validates cursor ownership and rejects a cursor ahead of the event state', () => {
    const { database, store, thread } = fixture();
    try {
      appendMessages(store, thread.threadId, 2);
      const first = getThreadSnapshot(
        store,
        ownerId,
        create(GetThreadRequestSchema, { threadId: thread.threadId, limit: 1 }),
        { maxRecords: 1 },
      );
      const nextCursor = first.nextCursor;
      if (!nextCursor) throw new Error('Expected another snapshot page.');
      const ahead = create(ThreadSnapshotCursorSchema, {
        ...nextCursor,
        throughSeq: first.throughSeq + 1n,
      });
      expect(() =>
        getThreadSnapshot(
          store,
          ownerId,
          create(GetThreadRequestSchema, { threadId: thread.threadId, cursor: ahead }),
        ),
      ).toThrowError(expect.objectContaining({ code: 'invalid_argument' }));
      expect(() =>
        getThreadSnapshot(
          store,
          'other-owner',
          create(GetThreadRequestSchema, { threadId: thread.threadId }),
        ),
      ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
    } finally {
      database.close();
    }
  });
});

type ConnectTransportFactory = (options: {
  baseUrl: string;
  httpVersion: '1.1';
  interceptors: Interceptor[];
}) => Transport;

const fastifyEntry = createRequire(import.meta.url).resolve('@connectrpc/connect-fastify');
const connectNode = createRequire(fastifyEntry)('@connectrpc/connect-node') as {
  createConnectTransport: ConnectTransportFactory;
};

it('reads a multi-megabyte snapshot through default-limit Connect RPC without loss', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-snapshot-pages-'));
  const database = openDatabase(join(directory, 'server.sqlite'));
  seedTestSession(database, ownerId, 'snapshot-session');
  const seed = new SessionStore(database);
  const thread = seed.createThread({
    ownerId,
    method: 'CreateThread',
    clientActionId: 'create-large',
    parameters: {},
    title: '长会话',
  });
  const sent = send(seed, thread.threadId, 'large-initial');
  for (let index = 0; index < 30; index += 1) {
    seed.appendModelMessage({
      runId: sent.runId,
      messageId: `large-message-${index}`,
      ...(index === 0 ? { inputId: sent.input.inputId } : {}),
      message: {
        role: index === 0 ? 'user' : 'assistant',
        content: 'm'.repeat(40 * 1024),
      },
    });
  }
  for (let index = 0; index < 100; index += 1) {
    send(seed, thread.threadId, `large-queued-${index}`, 'q'.repeat(40 * 1024));
  }
  for (let index = 0; index < 80; index += 1) {
    const child = seed.createChildRun(ownerId, sent.runId, `subagent-${index}`);
    seed.updateRunStatus(child.runId, 'failed', {
      code: 'internal',
      message: 'r'.repeat(16 * 1024),
      retryable: true,
    });
  }

  const server = createServer(database, false, {
    tenantId: ownerId,
  });
  try {
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address() as AddressInfo;
    const transport = connectNode.createConnectTransport({
      baseUrl: `http://127.0.0.1:${address.port}`,
      httpVersion: '1.1',
      interceptors: [testSessionInterceptor()],
    });
    const client = createClient(ThreadService, transport);
    const pages: GetThreadResponse[] = [];
    let cursor: GetThreadResponse['nextCursor'];
    do {
      const page = await client.getThread({
        threadId: thread.threadId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      expect(toBinary(GetThreadResponseSchema, page).length).toBeLessThanOrEqual(1024 * 1024);
      pages.push(page);
      cursor = page.nextCursor;
      expect(page.hasMore).toBe(cursor !== undefined);
      expect(pages.length).toBeLessThan(100);
    } while (cursor);

    const messages = pages.flatMap((page) => page.snapshot?.messages ?? []);
    const inputs = pages.flatMap((page) => page.snapshot?.inputs ?? []);
    const runs = pages.flatMap((page) => page.snapshot?.runs ?? []);
    expect(pages.length).toBeGreaterThan(5);
    expect(messages).toHaveLength(30);
    expect(inputs).toHaveLength(101);
    expect(runs).toHaveLength(81);
    expect(new Set(messages.map((message) => message.messageId)).size).toBe(30);
    expect(new Set(inputs.map((input) => input.inputId)).size).toBe(101);
    expect(new Set(runs.map((run) => run.runId)).size).toBe(81);
    expect(messages.every((message) => message.content.length === 40 * 1024)).toBe(true);
    expect(
      inputs
        .filter((input) => input.status === InputStatus.QUEUED)
        .every((input) => input.text.length === 40 * 1024),
    ).toBe(true);
    expect(new Set(pages.map((page) => page.throughSeq)).size).toBe(1);
  } finally {
    if (database.isOpen) await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
