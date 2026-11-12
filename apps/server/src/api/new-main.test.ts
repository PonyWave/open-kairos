import { Code, createClient, createRouterTransport } from '@connectrpc/connect';
import type { ModelProvider, ModelRequest } from '@kairos/agent-core';
import {
  AuthService,
  ContextService,
  EventService,
  InputMode,
  MessageService,
  ThreadService,
  ThreadType,
} from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import {
  controlledEnvironmentDependencies,
  seedTestEnvironment,
} from '../integration/environment-fixture.js';
import {
  createTestAuthentication,
  testSessionInterceptor,
} from '../integration/test-authentication.js';
import { projectRecallSnapshot } from '../recall/projection.js';
import { RunCoordinator } from '../sessions/runtime.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { registerGuiRoutes } from './connect.js';
import { BashLogReader } from './logs.js';

const ownerId = 'local-user';

function fixture() {
  const database = openDatabase(':memory:');
  seedTestEnvironment(database, ownerId);
  const store = new SessionStore(database);
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    async *stream(request) {
      requests.push(structuredClone(request));
      yield {
        type: 'response',
        message: { role: 'assistant', content: '新对话回复' },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
    },
  };
  const coordinator = new RunCoordinator({
    ...controlledEnvironmentDependencies(database, ownerId),
    store,
    model: {
      provider,
      providerId: 'test',
      modelId: 'test-model',
      contextWindowTokens: 1000,
      outputReserveTokens: 0,
      countTokens: () => 100,
    },
  });
  const transport = createRouterTransport(
    (router) =>
      registerGuiRoutes(router, {
        store,
        coordinator,
        logs: new BashLogReader({ store }),
        modelStatus: {
          providerId: 'test',
          modelId: 'test-model',
          contextCapacity: 1000,
          outputReserve: 1,
          available: true,
          configurationErrors: [],
        },
        authentication: createTestAuthentication(database, ownerId),
      }),
    { transport: { interceptors: [testSessionInterceptor()] } },
  );
  return {
    database,
    store,
    coordinator,
    requests,
    threads: createClient(ThreadService, transport),
    messages: createClient(MessageService, transport),
    context: createClient(ContextService, transport),
    events: createClient(EventService, transport),
    auth: createClient(AuthService, transport),
  };
}

async function cleanup(current: ReturnType<typeof fixture>) {
  await current.coordinator.close();
  current.database.close();
}

it('starts an empty main conversation and excludes archived content from recall and later model input', async () => {
  const current = fixture();
  try {
    const previous = current.store.getOrCreateMainThread(ownerId);
    const oldMessage = current.store.context.append({
      threadId: previous.threadId,
      agentId: 'thread',
      message: { role: 'user', content: 'old-context-secret' },
    });
    current.store.recaps.save({
      recapId: 'old-recap',
      threadId: previous.threadId,
      agentId: 'thread',
      sourceMessageSeqs: [oldMessage.seq],
      content: '旧对话摘要',
    });
    const request = { threadId: previous.threadId, clientActionId: 'new-main-1' };

    const started = await current.threads.startNewMain(request);
    const currentThread = started.thread;
    expect(currentThread).toBeDefined();
    expect(currentThread?.threadId).not.toBe(previous.threadId);
    expect(currentThread?.threadType).toBe(ThreadType.MAIN);
    expect(currentThread?.newConversation).toBe(true);
    expect(await current.threads.startNewMain(request)).toEqual(started);
    expect(current.store.getOrCreateMainThread(ownerId).threadId).toBe(currentThread?.threadId);
    expect(
      current.store.listThreads(ownerId, 0n, 100, 'main').map((thread) => thread.threadId),
    ).toEqual([currentThread?.threadId]);
    expect((await current.auth.getCurrentIdentity({})).identity?.mainThreadId).toBe(
      currentThread?.threadId,
    );

    const newThreadId = currentThread?.threadId ?? '';
    expect(current.store.listContext(ownerId, previous.threadId, 'thread')).toHaveLength(1);
    expect(current.store.listRecaps(ownerId, previous.threadId, 'thread')).toHaveLength(1);
    expect(current.store.listContext(ownerId, newThreadId, 'thread')).toEqual([]);
    expect(current.store.listRecaps(ownerId, newThreadId, 'thread')).toEqual([]);
    const recall = projectRecallSnapshot(current.database, {
      scope: { threadId: newThreadId, agentId: 'thread' },
      currentRunId: 'no-active-run',
      includeDescendants: false,
    });
    expect(recall.context).toEqual([]);
    expect(recall.recap).toEqual([]);
    expect(recall.thread[0]?.[0]).toBe(newThreadId);
    expect(recall.thread[0]?.[4]).toBeNull();
    expect(recall.thread[0]?.[6]).toBeNull();

    const emptySnapshot = await current.threads.getThread({ threadId: newThreadId, limit: 100 });
    expect(emptySnapshot.snapshot?.thread?.newConversation).toBe(true);
    expect(emptySnapshot.snapshot?.messages).toEqual([]);
    expect(emptySnapshot.snapshot?.recaps).toEqual([]);
    await expect(
      current.threads.getThread({ threadId: previous.threadId, limit: 100 }),
    ).rejects.toMatchObject({ code: Code.NotFound });
    await expect(
      current.context.readContext({ threadId: previous.threadId, agentId: 'thread', limit: 100 }),
    ).rejects.toMatchObject({ code: Code.NotFound });
    await expect(
      current.context.readRecaps({ threadId: previous.threadId, agentId: 'thread', limit: 100 }),
    ).rejects.toMatchObject({ code: Code.NotFound });
    const archivedEvents = current.events
      .watchThread({
        threadId: previous.threadId,
        afterSeq: 0n,
      })
      [Symbol.asyncIterator]();
    await expect(archivedEvents.next()).rejects.toMatchObject({ code: Code.NotFound });
    await archivedEvents.return?.();
    await expect(
      current.messages.sendMessage({
        threadId: previous.threadId,
        clientActionId: 'archived-send',
        text: '不应发送',
        mode: InputMode.FOLLOW_UP,
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect(
      current.threads.startNewMain({ threadId: newThreadId, clientActionId: 'new-main-1' }),
    ).rejects.toMatchObject({ code: Code.AlreadyExists });

    await current.messages.sendMessage({
      threadId: newThreadId,
      clientActionId: 'new-main-first-message',
      text: '只保留这条新消息',
      mode: InputMode.FOLLOW_UP,
    });
    await vi.waitFor(() => {
      expect(current.store.listRuns(ownerId, newThreadId).at(-1)?.status).toBe('completed');
    });
    expect(current.requests).toHaveLength(1);
    const modelInput = JSON.stringify(current.requests[0]?.messages);
    expect(modelInput).toContain('只保留这条新消息');
    expect(modelInput).not.toContain('old-context-secret');
    expect(modelInput).not.toContain('旧对话摘要');
    expect(modelInput).not.toContain('/new');
    const snapshot = await current.threads.getThread({ threadId: newThreadId, limit: 100 });
    expect(snapshot.snapshot?.messages.map((message) => message.content)).toEqual([
      '只保留这条新消息',
      '新对话回复',
    ]);
    expect(snapshot.snapshot?.thread?.newConversation).toBe(true);
  } finally {
    await cleanup(current);
  }
});

it('rejects task Threads and an active main Run without archiving the current main', async () => {
  const current = fixture();
  try {
    const main = current.store.getOrCreateMainThread(ownerId);
    const task = current.store.createThread({
      ownerId,
      method: 'CreateThread',
      clientActionId: 'new-main-task',
      parameters: { title: '任务' },
      title: '任务',
    });
    await expect(
      current.threads.startNewMain({
        threadId: task.threadId,
        clientActionId: 'new-main-task-rejected',
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });

    current.store.sendMessage({
      ownerId,
      method: 'SendMessage',
      clientActionId: 'new-main-active-input',
      parameters: { threadId: main.threadId, text: '活动输入', mode: 'follow_up' },
      threadId: main.threadId,
      text: '活动输入',
      mode: 'follow_up',
      attachmentIds: [],
      clipboardAttachmentIds: [],
    });
    await expect(
      current.threads.startNewMain({
        threadId: main.threadId,
        clientActionId: 'new-main-active-rejected',
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(current.store.getOrCreateMainThread(ownerId).threadId).toBe(main.threadId);
    expect(current.store.getThread(ownerId, main.threadId).archivedAt).toBeNull();
    expect(current.store.listThreads(ownerId, 0n, 100, 'main')).toHaveLength(1);
  } finally {
    await cleanup(current);
  }
});
