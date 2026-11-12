import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Code,
  ConnectError,
  createClient,
  createRouterTransport,
  type Interceptor,
} from '@connectrpc/connect';
import type { ModelEvent, ModelProvider, ModelRequest } from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import {
  BashLogService,
  ContentBlockType,
  ContextService,
  ErrorCode,
  ErrorDetailSchema,
  EventService,
  InputMode,
  InputStatus,
  MessageRole,
  MessageService,
  MessageSource,
  ModelService,
  QueueService,
  RecapValidity,
  RunExecutionMode,
  RunService,
  RunStatus,
  ThreadCardSort,
  ThreadService,
  ThreadType,
} from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import type { ModelConfigurationStatus } from '../config.js';
import { controlledEnvironmentDependencies } from '../integration/environment-fixture.js';
import {
  createTestAuthentication,
  testSessionInterceptor,
} from '../integration/test-authentication.js';
import type { RunStatus as StoredRunStatus } from '../sessions/records.js';
import { RunCoordinator } from '../sessions/runtime.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { registerGuiRoutes } from './connect.js';
import { BashLogReader } from './logs.js';

const ownerId = 'owner-1';
const environmentPolicy = {
  allowedEnv: ['env-1'],
  policyVersion: 1n,
};
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const modelStatus: ModelConfigurationStatus = {
  providerId: 'test',
  modelId: 'test-model',
  contextCapacity: 128000,
  outputReserve: 4096,
  available: true,
  configurationErrors: [],
};

function response(text: string): ModelEvent[] {
  return [
    { type: 'text_delta', text },
    { type: 'response', message: { role: 'assistant', content: text }, usage },
  ];
}

function clientsFor(
  store: SessionStore,
  coordinator: RunCoordinator,
  _outputDirectory: string,
  authentication = { ownerId, sessionToken: 'secret' },
  suppliedToken = authentication.sessionToken,
) {
  const authenticationInterceptor: Interceptor = testSessionInterceptor(suppliedToken);
  const transport = createRouterTransport(
    (router) =>
      registerGuiRoutes(router, {
        store,
        coordinator,
        logs: new BashLogReader({ store }),
        modelStatus,
        authentication: createTestAuthentication(
          store.database,
          authentication.ownerId,
          authentication.sessionToken,
        ),
        maxEventQueue: 16,
      }),
    { transport: { interceptors: [authenticationInterceptor] } },
  );
  return {
    thread: createClient(ThreadService, transport),
    messages: createClient(MessageService, transport),
    queue: createClient(QueueService, transport),
    runs: createClient(RunService, transport),
    context: createClient(ContextService, transport),
    bashLogs: createClient(BashLogService, transport),
    model: createClient(ModelService, transport),
    events: createClient(EventService, transport),
  };
}

interface TestFixture {
  database: ReturnType<typeof openDatabase>;
  store: SessionStore;
  coordinator: RunCoordinator;
  clients: ReturnType<typeof clientsFor>;
  outputDirectory: string;
}

async function fixture(provider?: ModelProvider): Promise<TestFixture> {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'kairos-connect-'));
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  const now = new Date().toISOString();
  database
    .prepare(
      'INSERT INTO tenants(tenant_id, user_id, default_env_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
    )
    .run(ownerId, 'user-1', now, now);
  database
    .prepare(
      `INSERT INTO environments(
        env_id, tenant_id, name, kind, recommended_pwd, binding_status, connection_status,
        capability_status, directory_status, authorized_capabilities_json, granted_capabilities_json,
        device_id, device_binding_id, instance_id, normalized_pwd, checked_at,
        created_at, updated_at, paired_at, last_seen_at
      ) VALUES ('env-1', ?, 'env-1', 'self_hosted_linux', '/srv/one', 'active', 'online',
        'ready', 'ready', '[1,2,3,4,5]', '[1,2,3,4,5]', 'device-1', 'binding-1',
        'instance-1', '/srv/one', ?, ?, ?, ?, ?)`,
    )
    .run(ownerId, now, now, now, now, now);
  database
    .prepare(
      `INSERT INTO environment_device_bindings(
        device_binding_id, tenant_id, env_id, device_id, status, granted_capabilities_json,
        created_at, updated_at, paired_at, last_seen_at
      ) VALUES ('binding-1', ?, 'env-1', 'device-1', 'active', '[1,2,3,4,5]', ?, ?, ?, ?)`,
    )
    .run(ownerId, now, now, now, now);
  const coordinator = new RunCoordinator({
    ...controlledEnvironmentDependencies(store.database, ownerId),
    store,
    ...(provider
      ? {
          model: {
            provider,
            providerId: 'test',
            modelId: 'test-model',
            contextWindowTokens: 128000,
            outputReserveTokens: 4096,
          },
        }
      : {}),
  });
  const clients = clientsFor(store, coordinator, outputDirectory);
  return { database, store, coordinator, clients, outputDirectory };
}

async function cleanup(fixture: TestFixture) {
  await fixture.coordinator.close();
  fixture.database.close();
  await rm(fixture.outputDirectory, { recursive: true, force: true });
}

async function waitRun(store: SessionStore, runId: string, status: RunStatus) {
  await vi.waitFor(() => {
    const row = store.getRunById(runId);
    expect(toRunStatus(row.status)).toBe(status);
  });
}

it('reads exact Subagent targets through the GUI contract without exposing a writable conversation', async () => {
  const value = await fixture();
  try {
    const main = value.store.getOrCreateMainThread(ownerId);
    const parameters = {
      threadId: main.threadId,
      text: '创建两个相同任务',
      mode: 'follow_up' as const,
    };
    const sent = value.store.sendMessage({
      ownerId,
      method: 'SendMessage',
      clientActionId: 'subagent-view-source',
      parameters,
      ...parameters,
    });
    value.store.appendModelMessage({
      runId: sent.runId,
      inputId: sent.input.inputId,
      message: { role: 'user', content: parameters.text },
    });
    const source = value.store.appendModelMessage({
      runId: sent.runId,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'sub-view-1',
            name: 'subagent',
            arguments: { task: '相同任务', mode: 'foreground' },
          },
          {
            id: 'sub-view-2',
            name: 'subagent',
            arguments: { task: '相同任务', mode: 'background' },
          },
        ],
      },
    });
    const keys = ['sub-view-1', 'sub-view-2'].map((sourceToolCallId) => ({
      sourceThreadId: main.threadId,
      sourceAgentId: 'thread',
      sourceToolCallId,
    }));
    const expectedRuns: string[] = [];
    for (const [index, key] of keys.entries()) {
      const mode = index === 0 ? 'foreground' : 'background';
      value.store.createSubagentInteraction({
        ownerId,
        ...key,
        sourceRunId: sent.runId,
        targetAgentId: `subagent-view-${index}`,
        prompt: '相同任务',
        executionMode: mode,
      });
      const child = value.store.createChildRun(ownerId, sent.runId, `subagent-view-${index}`, mode);
      expectedRuns.push(child.runId);
      value.store.startSubagentInteraction(ownerId, key, child.runId);
    }
    const response = await value.clients.thread.listSubagentCallViews({ calls: keys });
    expect(response.views.map((view) => view.agentId)).toEqual([
      'subagent-view-0',
      'subagent-view-1',
    ]);
    expect(response.views.map((view) => view.runId)).toEqual(expectedRuns);
    expect(response.views.map((view) => view.call?.sourceMessageId)).toEqual([
      source.messageId,
      source.messageId,
    ]);
    expect(response.views.map((view) => view.executionMode)).toEqual([
      RunExecutionMode.FOREGROUND,
      RunExecutionMode.BACKGROUND,
    ]);
    const snapshot = await value.clients.thread.getThread({ threadId: main.threadId, limit: 100 });
    expect(
      snapshot.snapshot?.runs
        .filter((run) => run.parentRunId === sent.runId)
        .map((run) => run.agentId),
    ).toEqual(['subagent-view-0', 'subagent-view-1']);
    await expect(
      value.clients.thread.listSubagentCallViews({
        calls: Array.from({ length: 101 }, () => ({
          sourceThreadId: main.threadId,
          sourceAgentId: 'thread',
          sourceToolCallId: 'sub-view-1',
        })),
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    const unauthorized = clientsFor(value.store, value.coordinator, value.outputDirectory, {
      ownerId: 'another-owner',
      sessionToken: 'other-secret',
    });
    await expect(unauthorized.thread.listSubagentCallViews({ calls: keys })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
  } finally {
    await cleanup(value);
  }
});

function toRunStatus(status: StoredRunStatus): RunStatus {
  switch (status) {
    case 'queued':
      return RunStatus.QUEUED;
    case 'running':
      return RunStatus.RUNNING;
    case 'waiting':
      return RunStatus.WAITING;
    case 'cancel_requested':
      return RunStatus.CANCEL_REQUESTED;
    case 'completed':
      return RunStatus.COMPLETED;
    case 'failed':
      return RunStatus.FAILED;
    case 'cancelled':
      return RunStatus.CANCELLED;
    case 'interrupted':
      return RunStatus.INTERRUPTED;
  }
}

it('executes generated unary clients with deduplication and persistent snapshots', async () => {
  const provider = new ScriptedProvider([response('answer'), response('rerun answer')]);
  const current = await fixture(provider);
  const { store, clients } = current;
  try {
    const unbound = await clients.thread.createThread({
      clientActionId: 'missing-policy',
      title: 'missing',
    });
    expect(unbound.thread?.environmentPolicy).toBeUndefined();
    expect(unbound.thread?.currentBinding?.pwd).toBe('/workspace');
    expect(unbound.thread?.currentBinding?.envId).toBeTruthy();
    const created = await clients.thread.createThread({
      environmentPolicy,
      clientActionId: 'create-1',
      title: '会话',
    });
    const duplicate = await clients.thread.createThread({
      environmentPolicy,
      clientActionId: 'create-1',
      title: '会话',
    });
    expect(duplicate.thread?.threadId).toBe(created.thread?.threadId);
    await expect(
      clients.thread.createThread({ environmentPolicy, clientActionId: 'create-1', title: '冲突' }),
    ).rejects.toMatchObject({ code: Code.AlreadyExists });
    const threadId = created.thread?.threadId ?? '';
    const sandboxEnvId = created.thread?.currentBinding?.envId;
    expect(created.thread?.environmentPolicy).toMatchObject({
      ...environmentPolicy,
      allowedEnv: [sandboxEnvId, 'env-1'],
    });
    expect(created.thread?.currentBinding).toMatchObject({
      envId: sandboxEnvId,
      pwd: '/workspace',
      bindingVersion: 1n,
    });
    await clients.thread.renameThread({ clientActionId: 'rename-1', threadId, title: '新会话' });
    expect(
      (await clients.thread.listThreads({ afterSeq: 0n, limit: 10 })).threads.find(
        (thread) => thread.threadId === threadId,
      )?.title,
    ).toBe('新会话');

    const sent = await clients.messages.sendMessage({
      clientActionId: 'send-1',
      threadId,
      text: 'question',
      mode: InputMode.FOLLOW_UP,
    });
    const runId = (await clients.thread.getThread({ threadId })).snapshot?.runs[0]?.runId ?? '';
    await waitRun(store, runId, RunStatus.COMPLETED);
    const anchor = (await clients.thread.getThread({ threadId })).snapshot?.messages[0];
    if (!anchor) throw new Error('The revision anchor is missing.');
    const revisionRequest = {
      clientActionId: 'revise-1',
      threadId,
      messageId: anchor.messageId,
      text: 'question revised',
    };
    const revised = await clients.messages.reviseMessage(revisionRequest);
    const replayedRevision = await clients.messages.reviseMessage(revisionRequest);
    expect(replayedRevision).toEqual(revised);
    const rerun = (await clients.thread.getThread({ threadId })).snapshot?.runs.find(
      (run) => run.rerunFromMessageSeq === anchor.seq,
    );
    if (!rerun) throw new Error('Revision did not start a Rerun.');
    await waitRun(store, rerun.runId, RunStatus.COMPLETED);
    await expect(
      clients.runs.continueRun({ clientActionId: 'continue-1', threadId, runId }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });

    const context = await clients.context.readContext({
      threadId,
      agentId: '',
      afterSeq: 0n,
      limit: 100,
    });
    expect(context.messages.some((message) => message.content === 'answer')).toBe(true);
    expect(
      context.messages.some((message) =>
        message.revisions.some((revision) => revision.text === 'question revised'),
      ),
    ).toBe(true);
    const snapshot = await clients.thread.getThread({ threadId });
    expect(snapshot.snapshot?.messages.map((message) => message.content)).toEqual([
      'question revised',
      'rerun answer',
    ]);
    expect(snapshot.snapshot?.inputs.every((input) => input.status === InputStatus.CONSUMED)).toBe(
      true,
    );
    expect(snapshot.throughSeq).toBeGreaterThan(1n);

    const status = await clients.model.getModelStatus({});
    expect(status.available).toBe(true);
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(sent.threadId).toBe(threadId);
  } finally {
    await cleanup(current);
  }
});

it('summarizes the default title from the first prompt without adding title messages to Context', async () => {
  const provider = new ScriptedProvider([response('季度产品规划'), response('首条回答')]);
  const current = await fixture(provider);
  const { store, clients } = current;
  try {
    const created = await clients.thread.createThread({
      environmentPolicy,
      clientActionId: 'create-auto-title',
      title: '新话题',
      autoSummarizeTitle: true,
      initialText: '请帮我制定第三季度产品规划',
      initialMode: InputMode.FOLLOW_UP,
    });
    const threadId = created.thread?.threadId ?? '';
    expect(created.thread?.title).toBe('新话题');
    await waitRun(store, created.runId ?? '', RunStatus.COMPLETED);
    await vi.waitFor(() => {
      expect(store.getThread(ownerId, threadId).title).toBe('季度产品规划');
    });
    await expect(
      clients.thread.createThread({
        environmentPolicy,
        clientActionId: 'create-auto-title',
        title: '新话题',
        autoSummarizeTitle: false,
        initialText: '请帮我制定第三季度产品规划',
        initialMode: InputMode.FOLLOW_UP,
      }),
    ).rejects.toMatchObject({ code: Code.AlreadyExists });

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.tools).toEqual([]);
    expect(provider.requests[0]?.messages[1]?.content).toContain('第三季度产品规划');
    const snapshot = await clients.thread.getThread({ threadId });
    expect(snapshot.snapshot?.thread?.title).toBe('季度产品规划');
    expect(snapshot.snapshot?.messages.map((message) => message.content)).toEqual([
      '请帮我制定第三季度产品规划',
      '首条回答',
    ]);
  } finally {
    await cleanup(current);
  }
});

it('creates a task Thread with its first input in one deduplicated request', async () => {
  const provider = new ScriptedProvider([response('首条回答')]);
  const current = await fixture(provider);
  const { store, clients } = current;
  try {
    const created = await clients.thread.createThread({
      environmentPolicy,
      clientActionId: 'create-first-input',
      title: '首条任务',
      initialText: '首条输入',
      initialMode: InputMode.FOLLOW_UP,
    });
    expect(created.thread?.threadType).toBe(ThreadType.TASK);
    expect(created.inputId).toBeDefined();
    expect(created.runId).toBeDefined();
    await waitRun(store, created.runId ?? '', RunStatus.COMPLETED);
    const replayed = await clients.thread.createThread({
      environmentPolicy,
      clientActionId: 'create-first-input',
      title: '首条任务',
      initialText: '首条输入',
      initialMode: InputMode.FOLLOW_UP,
    });
    expect(replayed.thread?.threadId).toBe(created.thread?.threadId);
    expect(replayed.inputId).toBe(created.inputId);
    expect(replayed.runId).toBe(created.runId);
    expect(provider.requests).toHaveLength(1);
    const snapshot = await clients.thread.getThread({ threadId: created.thread?.threadId ?? '' });
    expect(snapshot.snapshot?.messages.map((message) => message.content)).toEqual([
      '首条输入',
      '首条回答',
    ]);
    expect(snapshot.snapshot?.messages[1]).toMatchObject({
      runId: created.runId,
      usage: { inputTokens: 1n, outputTokens: 1n },
    });
    expect(snapshot.snapshot?.runs[0]?.usage).toMatchObject({
      inputTokens: 1n,
      outputTokens: 1n,
    });
  } finally {
    await cleanup(current);
  }
});

it('gets one main Thread, lists task types and preserves SendMessage acceptance semantics', async () => {
  const current = await fixture();
  const { clients } = current;
  try {
    const main = await clients.thread.getOrCreateMain({});
    const duplicate = await clients.thread.getOrCreateMain({});
    expect(duplicate.thread?.threadId).toBe(main.thread?.threadId);
    expect(main.thread?.threadType).toBe(ThreadType.MAIN);
    const task = await clients.thread.createThread({
      environmentPolicy,
      clientActionId: 'create-task',
      title: '任务',
    });
    expect(task.thread?.threadType).toBe(ThreadType.TASK);
    const firstPage = await clients.thread.listThreads({ afterSeq: 0n, limit: 1 });
    expect(firstPage.threads.map((thread) => thread.threadId)).toEqual([main.thread?.threadId]);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = await clients.thread.listThreads({
      afterSeq: firstPage.nextSeq ?? 0n,
      limit: 10,
    });
    expect(secondPage.threads.map((thread) => thread.threadId)).toEqual([task.thread?.threadId]);

    const request = {
      clientActionId: 'send-task',
      threadId: task.thread?.threadId ?? '',
      text: '直接输入',
      mode: InputMode.FOLLOW_UP,
    };
    const sent = await clients.messages.sendMessage(request);
    expect((await clients.messages.sendMessage(request)).inputId).toBe(sent.inputId);
    await expect(
      clients.messages.sendMessage({ ...request, text: '冲突输入' }),
    ).rejects.toMatchObject({ code: Code.AlreadyExists });
    const snapshot = await clients.thread.getThread({ threadId: request.threadId });
    expect(snapshot.snapshot?.inputs[0]?.source).toBe(MessageSource.USER);
    expect(snapshot.snapshot?.inputs[0]?.delegation).toBeUndefined();
    expect(snapshot.snapshot?.inputs[0]).not.toHaveProperty('interactionId');
    expect(snapshot.snapshot?.runs[0]?.executionMode).toBe(RunExecutionMode.BACKGROUND);
  } finally {
    await cleanup(current);
  }
});

it('serves paginated Thread cards and ordered call previews through generated Connect clients', async () => {
  const current = await fixture();
  const { clients, store } = current;
  try {
    const main = await clients.thread.getOrCreateMain({});
    const firstTask = await clients.thread.createThread({
      environmentPolicy,
      clientActionId: 'create-preview-first',
      title: '委派任务',
    });
    const secondTask = await clients.thread.createThread({
      environmentPolicy,
      clientActionId: 'create-preview-second',
      title: '手动任务',
    });
    const mainId = main.thread?.threadId ?? '';
    const firstTaskId = firstTask.thread?.threadId ?? '';
    const secondTaskId = secondTask.thread?.threadId ?? '';
    const source = store.sendMessage({
      ownerId,
      clientActionId: 'preview-source-input',
      method: 'SendMessage',
      parameters: { threadId: mainId, text: '主任务', mode: 'follow_up' },
      threadId: mainId,
      text: '主任务',
      mode: 'follow_up',
    });
    store.appendModelMessage({
      runId: source.runId,
      inputId: source.input.inputId,
      message: { role: 'user', content: source.input.text },
    });
    const sourceCall = store.appendModelMessage({
      runId: source.runId,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'preview-call-1', name: 'thread_call', arguments: { secret: 'argument' } },
          { id: 'preview-call-2', name: 'thread_call', arguments: { secret: 'argument' } },
        ],
      },
    });
    const base = {
      ownerId,
      sourceThreadId: mainId,
      sourceAgentId: 'thread',
      sourceRunId: source.runId,
      targetThreadId: firstTaskId,
      mode: 'follow_up' as const,
    };
    const first = store.acceptThreadCall({
      ...base,
      sourceToolCallId: 'preview-call-1',
      prompt: '第一段 prompt',
    });
    const second = store.acceptThreadCall({
      ...base,
      sourceToolCallId: 'preview-call-2',
      prompt: '等待中的 prompt',
    });
    store.appendModelMessage({
      runId: first.runId,
      inputId: first.input.inputId,
      message: { role: 'user', content: first.input.text },
    });
    const firstAttachment = store.attachments.upload({
      ownerId,
      clientActionId: 'preview-upload-first',
      fileName: 'first.txt',
      declaredMediaType: 'text/plain',
      bytes: new TextEncoder().encode('SECRET_PREVIEW_FIRST'),
    }).attachment;
    const secondAttachment = store.attachments.upload({
      ownerId,
      clientActionId: 'preview-upload-second',
      fileName: 'second.txt',
      declaredMediaType: 'text/plain',
      bytes: new TextEncoder().encode('SECRET_PREVIEW_SECOND'),
    }).attachment;
    const attachmentInput = store.sendMessage({
      ownerId,
      clientActionId: 'preview-attachments',
      method: 'SendMessage',
      parameters: {
        threadId: firstTaskId,
        text: '',
        mode: 'follow_up',
        attachmentIds: [secondAttachment.attachmentId, firstAttachment.attachmentId],
      },
      threadId: firstTaskId,
      text: '',
      mode: 'follow_up',
      attachmentIds: [secondAttachment.attachmentId, firstAttachment.attachmentId],
    });
    store.appendModelMessage({
      runId: attachmentInput.runId,
      inputId: attachmentInput.input.inputId,
      message: { role: 'user', content: '' },
    });
    const answer = store.appendModelMessage({
      runId: first.runId,
      message: { role: 'assistant', content: '可见回复' },
    });
    store.recordInteractionResponses({
      runId: first.runId,
      messageId: answer.messageId,
      interactionKeys: [first.interaction],
    });
    store.database
      .prepare('UPDATE threads SET created_at = ? WHERE thread_id = ?')
      .run('2026-01-01T00:00:00.000Z', firstTaskId);
    store.database
      .prepare('UPDATE threads SET created_at = ? WHERE thread_id = ?')
      .run('2026-01-02T00:00:00.000Z', secondTaskId);
    store.database
      .prepare('UPDATE context_messages SET created_at = ? WHERE seq = ?')
      .run('2026-01-03T00:00:00.000Z', answer.seq);

    const recent = await clients.thread.listThreadCards({
      sort: ThreadCardSort.LAST_MESSAGE_AT,
      limit: 4,
    });
    expect(recent.cards.map((card) => card.thread?.threadId)).toEqual([firstTaskId, secondTaskId]);
    expect(recent.cards.some((card) => card.thread?.threadId === mainId)).toBe(false);
    expect(recent.cards[0]?.messages.map((message) => message.text)).toEqual(['', '可见回复']);
    expect(recent.cards[0]?.messages[1]).toMatchObject({
      messageId: answer.messageId,
      seq: BigInt(answer.seq),
      role: MessageRole.ASSISTANT,
      textTruncated: false,
      createdAt: { seconds: 1_767_398_400n, nanos: 0 },
    });
    expect(recent.cards[0]?.messages[0]?.attachments.map((item) => item.attachmentId)).toEqual([
      secondAttachment.attachmentId,
      firstAttachment.attachmentId,
    ]);
    expect(recent.cards[0]?.messages[0]?.attachments[0]).toMatchObject({
      fileName: 'second.txt',
      mediaType: 'text/plain',
      sizeBytes: BigInt(secondAttachment.byteSize),
      sha256: secondAttachment.sha256,
    });
    expect(recent.cards[0]?.messages[0]?.attachments[0]).not.toHaveProperty('data');
    expect(recent.cards[0]?.messages[0]?.attachments[0]).not.toHaveProperty('ownerId');
    expect(recent.cards[0]?.messages[0]?.attachments[0]).not.toHaveProperty('content');
    expect(recent.cards[0]?.messages[0]?.attachments[0]).not.toHaveProperty('path');
    expect(recent.cards[0]?.messages[1]).not.toHaveProperty('toolCalls');
    expect(recent.cards[0]?.messages[1]).not.toHaveProperty('contentBlocks');
    expect(recent.cards[0]?.lastMessageAt?.seconds).toBe(1_767_398_400n);
    expect(recent.cards[0]?.sourceCall).toMatchObject({
      sourceMessageId: sourceCall.messageId,
      sourceMessageSeq: BigInt(sourceCall.seq),
      delegation: {
        sourceThreadId: mainId,
        sourceAgentId: 'thread',
        sourceToolCallId: 'preview-call-1',
      },
    });
    expect(recent.cards[1]?.lastMessageAt).toBeUndefined();
    expect(recent.cards[1]?.sourceCall).toBeUndefined();

    const createdFirst = await clients.thread.listThreadCards({
      sort: ThreadCardSort.CREATED_AT,
      limit: 1,
    });
    expect(createdFirst.cards.map((card) => card.thread?.threadId)).toEqual([secondTaskId]);
    expect(createdFirst.hasMore).toBe(true);
    expect(createdFirst.nextCursor).toMatchObject({
      sort: ThreadCardSort.CREATED_AT,
      threadSeq: BigInt(secondTask.thread?.seq ?? 0),
    });
    const createdSecond = await clients.thread.listThreadCards({
      sort: ThreadCardSort.CREATED_AT,
      limit: 1,
      cursor: createdFirst.nextCursor,
    });
    expect(createdSecond.cards.map((card) => card.thread?.threadId)).toEqual([firstTaskId]);
    expect(createdSecond.hasMore).toBe(false);
    expect(createdSecond.nextCursor).toBeUndefined();
    await expect(
      clients.thread.listThreadCards({
        sort: ThreadCardSort.LAST_MESSAGE_AT,
        limit: 1,
        cursor: createdFirst.nextCursor,
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(
      clients.thread.listThreadCards({ sort: ThreadCardSort.CREATED_AT, limit: 0 }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });

    const getThread = vi.spyOn(store, 'getThread');
    const previews = await clients.thread.listThreadCallPreviews({
      calls: [
        second.interaction,
        {
          sourceThreadId: mainId,
          sourceAgentId: 'thread',
          sourceToolCallId: 'missing-call',
        },
        first.interaction,
      ],
    });
    expect(getThread).not.toHaveBeenCalled();
    getThread.mockRestore();
    expect(previews.previews.map((preview) => preview.call?.delegation?.sourceToolCallId)).toEqual([
      'preview-call-2',
      'preview-call-1',
    ]);
    expect(previews.previews[0]).toMatchObject({
      targetThreadId: firstTaskId,
      targetTitle: '委派任务',
      status: RunStatus.QUEUED,
      replyCount: 0n,
      replies: [],
    });
    expect(previews.previews[0]?.responseMessageSeq).toBeUndefined();
    expect(previews.previews[1]).toMatchObject({
      targetThreadId: firstTaskId,
      targetTitle: '委派任务',
      status: RunStatus.COMPLETED,
      replyCount: 2n,
      responseMessageSeq: BigInt(answer.seq),
      call: {
        sourceMessageId: sourceCall.messageId,
        sourceMessageSeq: BigInt(sourceCall.seq),
      },
    });
    expect(previews.previews[1]?.replies.map((reply) => reply.text)).toEqual(['', '可见回复']);
    expect(previews.previews[1]?.replies[0]?.attachments.map((item) => item.attachmentId)).toEqual([
      secondAttachment.attachmentId,
      firstAttachment.attachmentId,
    ]);
    expect((await clients.thread.listThreadCallPreviews({ calls: [] })).previews).toEqual([]);
    await expect(
      clients.thread.listThreadCallPreviews({
        calls: Array.from({ length: 101 }, () => first.interaction),
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
  } finally {
    await cleanup(current);
  }
});

it('converts interaction sources without copying target history into the main Context', async () => {
  const current = await fixture();
  const { clients, store } = current;
  try {
    const main = await clients.thread.getOrCreateMain({});
    const task = await clients.thread.createThread({
      environmentPolicy,
      clientActionId: 'create-task',
      title: '任务',
    });
    const mainId = main.thread?.threadId ?? '';
    const taskId = task.thread?.threadId ?? '';
    const sourceRunId = store.sendMessage({
      ownerId,
      clientActionId: 'source-run',
      method: 'SendMessage',
      parameters: { threadId: mainId, text: '主任务', mode: 'follow_up' },
      threadId: mainId,
      text: '主任务',
      mode: 'follow_up',
    }).runId;
    const accepted = store.acceptThreadCall({
      ownerId,
      sourceThreadId: mainId,
      sourceAgentId: 'thread',
      sourceRunId,
      sourceToolCallId: 'call-1',
      targetThreadId: taskId,
      prompt: '目标 prompt',
      mode: 'follow_up',
    });
    store.appendModelMessage({
      runId: accepted.runId,
      inputId: accepted.input.inputId,
      message: { role: 'user', content: accepted.input.text },
    });
    const response = store.appendModelMessage({
      runId: accepted.runId,
      message: { role: 'assistant', content: '目标内部回复' },
    });
    store.recordInteractionResponses({
      runId: accepted.runId,
      messageId: response.messageId,
      interactionKeys: [accepted.interaction],
    });
    const delivered = store.enqueueInteractionDelivery({
      ownerId,
      key: accepted.interaction,
      text: '明确交付的 response',
    });
    if (delivered.runId === null) throw new Error('Expected a current interaction delivery.');
    store.appendInteractionDeliveryMessage({
      runId: delivered.runId,
      key: accepted.interaction,
      message: { role: 'user', content: '明确交付的 response' },
    });

    const snapshot = await clients.thread.getThread({ threadId: mainId });
    expect(
      snapshot.snapshot?.inputs.filter((item) => item.source === MessageSource.THREAD_RESPONSE),
    ).toEqual([]);
    const message = snapshot.snapshot?.messages.find(
      (item) => item.delegation?.sourceToolCallId === accepted.interaction.sourceToolCallId,
    );
    expect(message?.source).toBe(MessageSource.THREAD_RESPONSE);
    expect(message?.sourceThreadId).toBe(taskId);
    expect(message).not.toHaveProperty('interactionId');
    expect(message?.delegation).toMatchObject({
      sourceThreadId: mainId,
      sourceAgentId: 'thread',
      sourceToolCallId: accepted.interaction.sourceToolCallId,
    });
    expect(message?.content).toBe('明确交付的 response');
    const mainContext = await clients.context.readContext({
      threadId: mainId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 100,
    });
    expect(mainContext.messages.map((item) => item.content)).toEqual(['明确交付的 response']);
    expect(mainContext.messages[0]?.source).toBe(MessageSource.THREAD_RESPONSE);
  } finally {
    await cleanup(current);
  }
});

it('validates queue versions, authentication and named business errors', async () => {
  const current = await fixture();
  const { clients } = current;
  try {
    const threadId =
      (
        await clients.thread.createThread({
          environmentPolicy,
          clientActionId: 'create-1',
          title: '会话',
        })
      ).thread?.threadId ?? '';
    const first = await clients.messages.sendMessage({
      clientActionId: 'send-1',
      threadId,
      text: 'first',
      mode: InputMode.FOLLOW_UP,
    });
    const second = await clients.messages.sendMessage({
      clientActionId: 'send-2',
      threadId,
      text: 'second',
      mode: InputMode.STEER,
    });
    const edited = await clients.queue.editInput({
      clientActionId: 'edit-1',
      threadId,
      inputId: first.inputId,
      text: 'edited',
      expectedVersion: 1n,
    });
    expect(edited.version).toBe(2n);
    await expect(
      clients.queue.editInput({
        clientActionId: 'edit-2',
        threadId,
        inputId: first.inputId,
        text: 'stale',
        expectedVersion: 1n,
      }),
    ).rejects.toMatchObject({ code: Code.Aborted });
    const reordered = await clients.queue.reorderInputs({
      clientActionId: 'reorder-1',
      threadId,
      inputIds: [second.inputId, first.inputId],
      expectedVersion: 0n,
    });
    expect(reordered.inputs.map((input) => input.inputId)).toEqual([second.inputId, first.inputId]);
    await clients.queue.removeInput({
      clientActionId: 'remove-1',
      threadId,
      inputId: second.inputId,
      expectedVersion: 1n,
    });
    await expect(
      clients.messages.sendMessage({
        clientActionId: 'send-3',
        threadId,
        text: 'bad mode',
        mode: InputMode.UNSPECIFIED,
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });

    const wrong = clientsFor(
      current.store,
      current.coordinator,
      current.outputDirectory,
      { ownerId, sessionToken: 'secret' },
      'wrong',
    );
    const error = await wrong.thread
      .listThreads({ afterSeq: 0n, limit: 10 })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ConnectError);
    if (error instanceof ConnectError) {
      expect(error.code).toBe(Code.Unauthenticated);
      expect(error.findDetails(ErrorDetailSchema)[0]?.code).toBe(ErrorCode.UNAUTHENTICATED);
    }
  } finally {
    await cleanup(current);
  }
});

it('reconnects WatchThread without duplicates and keeps Run active after subscription cancellation', async () => {
  const gate = (() => {
    let resolve = () => {};
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  })();
  const provider: ModelProvider = {
    async *stream(_request: ModelRequest, signal: AbortSignal) {
      yield { type: 'thinking_delta', text: 'actual reasoning', block_index: 0 };
      yield { type: 'text_delta', text: 'streamed', block_index: 1 };
      await Promise.race([
        gate.promise,
        new Promise<void>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
      ]);
      yield {
        type: 'response',
        message: {
          role: 'assistant',
          content: 'streamed',
          content_blocks: [
            { type: 'thinking', block_index: 0, text: 'actual reasoning' },
            { type: 'text', block_index: 1, text: 'streamed' },
          ],
        },
        usage,
      };
    },
  };
  const current = await fixture(provider);
  const { clients, store } = current;
  try {
    const threadId =
      (
        await clients.thread.createThread({
          environmentPolicy,
          clientActionId: 'create-1',
          title: '会话',
        })
      ).thread?.threadId ?? '';
    const firstController = new AbortController();
    const first = clients.events
      .watchThread({ threadId, afterSeq: 1n }, { signal: firstController.signal })
      [Symbol.asyncIterator]();
    const pending = first.next();
    await clients.thread.renameThread({ clientActionId: 'rename-1', threadId, title: 'renamed' });
    const renamed = await pending;
    expect(renamed.value?.payload.case).toBe('event');
    let cursor = 1n;
    if (renamed.value?.payload.case === 'event') cursor = renamed.value.payload.value.seq;
    firstController.abort();
    await first.return?.();

    const secondController = new AbortController();
    const second = clients.events
      .watchThread({ threadId, afterSeq: cursor }, { signal: secondController.signal })
      [Symbol.asyncIterator]();
    let nextItem = second.next();
    await clients.thread.renameThread({ clientActionId: 'rename-2', threadId, title: 'listening' });
    const listening = await nextItem;
    expect(listening.value?.payload.case).toBe('event');
    if (listening.value?.payload.case === 'event') cursor = listening.value.payload.value.seq;
    nextItem = second.next();
    await clients.messages.sendMessage({
      clientActionId: 'send-1',
      threadId,
      text: 'question',
      mode: InputMode.FOLLOW_UP,
    });
    let messageId = '';
    const deltas: Array<{
      case: 'textDelta' | 'thinkingDelta';
      messageId: string;
      text: string;
      deltaSeq: bigint;
      blockIndex: number | undefined;
      runId?: string;
    }> = [];
    while (true) {
      const item = await nextItem;
      if (
        item.value?.payload.case === 'textDelta' ||
        item.value?.payload.case === 'thinkingDelta'
      ) {
        const delta = item.value.payload.value;
        messageId = delta.messageId;
        deltas.push({
          case: item.value.payload.case,
          messageId: delta.messageId,
          text: delta.text,
          deltaSeq: delta.deltaSeq,
          blockIndex: delta.blockIndex,
          ...(item.value.payload.case === 'thinkingDelta' ? { runId: delta.runId } : {}),
        });
        if (item.value.payload.case === 'textDelta') break;
      }
      if (item.value?.payload.case === 'event') cursor = item.value.payload.value.seq;
      nextItem = second.next();
    }
    expect(deltas).toEqual([
      {
        case: 'thinkingDelta',
        messageId,
        text: 'actual reasoning',
        deltaSeq: 1n,
        blockIndex: 0,
        runId: expect.any(String),
      },
      {
        case: 'textDelta',
        messageId,
        text: 'streamed',
        deltaSeq: 2n,
        blockIndex: 1,
      },
    ]);
    secondController.abort();
    await second.return?.();
    const runId = (await clients.thread.getThread({ threadId })).snapshot?.runs[0]?.runId ?? '';
    expect((await clients.thread.getThread({ threadId })).snapshot?.runs[0]?.status).not.toBe(
      RunStatus.CANCELLED,
    );
    gate.resolve();
    await waitRun(store, runId, RunStatus.COMPLETED);

    const third = clients.events
      .watchThread({ threadId, afterSeq: cursor })
      [Symbol.asyncIterator]();
    let committedId = '';
    while (true) {
      const item = await third.next();
      if (item.value?.payload.case === 'event') {
        const event = item.value.payload.value;
        if (
          event.payload.case === 'messageCommitted' &&
          event.payload.value.message?.role === MessageRole.ASSISTANT
        ) {
          committedId = event.payload.value.message.messageId;
          break;
        }
      }
    }
    expect(committedId).toBe(messageId);
    const restored = await clients.context.readContext({
      threadId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 100,
    });
    const authoritative = restored.messages.find((message) => message.messageId === messageId);
    expect(authoritative?.content).toBe('streamed');
    expect(authoritative?.contentBlocks).toMatchObject([
      { type: ContentBlockType.THINKING, blockIndex: 0, text: 'actual reasoning' },
      { type: ContentBlockType.TEXT, blockIndex: 1, text: 'streamed' },
    ]);
    const snapshot = await clients.thread.getThread({ threadId });
    expect(
      snapshot.snapshot?.messages.find((message) => message.messageId === messageId)?.contentBlocks,
    ).toEqual(authoritative?.contentBlocks);
    await third.return?.();
  } finally {
    gate.resolve();
    await cleanup(current);
  }
});

it('pages Server Bash logs by offset and reports expiration', async () => {
  const current = await fixture();
  const { clients, store, outputDirectory } = current;
  try {
    const threadId =
      (
        await clients.thread.createThread({
          environmentPolicy,
          clientActionId: 'create-1',
          title: '会话',
        })
      ).thread?.threadId ?? '';
    await clients.messages.sendMessage({
      clientActionId: 'send-1',
      threadId,
      text: 'queued',
      mode: InputMode.FOLLOW_UP,
    });
    const runId =
      store.getActiveRun(threadId)?.runId ?? store.listRuns(ownerId, threadId)[0]?.runId ?? '';
    const logPath = join(outputDirectory, 'operation.log');
    await writeFile(logPath, '0123456789');
    store.recordServerBashOperation({
      operationId: 'server-operation',
      runId,
      toolCallId: 'call-1',
      logPath,
      outputComplete: true,
      endOffset: 10n,
      expiresAt: null,
    });
    const first = await clients.bashLogs.readBashLog({
      operationId: 'server-operation',
      offset: 0n,
      limitBytes: 4,
    });
    expect(Buffer.from(first.chunks[0]?.data ?? []).toString()).toBe('0123');
    expect(first.nextOffset).toBe(4n);
    const second = await clients.bashLogs.readBashLog({
      operationId: 'server-operation',
      offset: first.nextOffset,
      limitBytes: 4,
    });
    expect(Buffer.from(second.chunks[0]?.data ?? []).toString()).toBe('4567');
    expect(second.nextOffset).toBe(8n);
    const third = await clients.bashLogs.readBashLog({
      operationId: 'server-operation',
      offset: second.nextOffset,
      limitBytes: 4,
    });
    expect(Buffer.from(third.chunks[0]?.data ?? []).toString()).toBe('89');
    expect(third.nextOffset).toBeUndefined();
    const run = store.getRunById(runId);
    store.recordServerBashOperation({
      operationId: 'server-operation',
      runId: run.runId,
      toolCallId: 'call-1',
      logPath,
      outputComplete: true,
      endOffset: 10n,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    expect(
      (
        await clients.bashLogs.readBashLog({
          operationId: 'server-operation',
          offset: 0n,
          limitBytes: 4,
        })
      ).expired,
    ).toBe(true);
  } finally {
    await cleanup(current);
  }
});

it('rejects an expired event cursor and recovers from a fresh snapshot', async () => {
  const current = await fixture();
  const { clients, store, database } = current;
  try {
    const threadId =
      (
        await clients.thread.createThread({
          environmentPolicy,
          clientActionId: 'create-1',
          title: '会话',
        })
      ).thread?.threadId ?? '';
    await clients.thread.renameThread({ clientActionId: 'rename-1', threadId, title: '新会话' });
    store.transaction(() => {
      database.prepare('DELETE FROM thread_events WHERE thread_id = ? AND seq = 1').run(threadId);
      database
        .prepare('UPDATE thread_event_retention SET first_available_seq = 2 WHERE thread_id = ?')
        .run(threadId);
    });
    const expired = clients.events.watchThread({ threadId, afterSeq: 0n })[Symbol.asyncIterator]();
    await expect(expired.next()).rejects.toMatchObject({ code: Code.OutOfRange });
    const snapshot = await clients.thread.getThread({ threadId });
    expect(snapshot.throughSeq).toBe(2n);
    const recovered = clients.events
      .watchThread({ threadId, afterSeq: 1n })
      [Symbol.asyncIterator]();
    const event = await recovered.next();
    expect(event.value?.payload.case).toBe('event');
    if (event.value?.payload.case === 'event') expect(event.value.payload.value.seq).toBe(2n);
    await recovered.return?.();
  } finally {
    await cleanup(current);
  }
});

it('keeps the event high water after every persisted event expires', async () => {
  const current = await fixture();
  const { clients, store, database } = current;
  try {
    const threadId =
      (
        await clients.thread.createThread({
          environmentPolicy,
          clientActionId: 'create-1',
          title: '会话',
        })
      ).thread?.threadId ?? '';
    store.transaction(() => {
      database.prepare('DELETE FROM thread_events WHERE thread_id = ?').run(threadId);
      database
        .prepare('UPDATE thread_event_retention SET first_available_seq = 2 WHERE thread_id = ?')
        .run(threadId);
    });
    expect((await clients.thread.getThread({ threadId })).throughSeq).toBe(1n);
    const watching = clients.events.watchThread({ threadId, afterSeq: 1n })[Symbol.asyncIterator]();
    const pending = watching.next();
    await clients.thread.renameThread({ clientActionId: 'rename-1', threadId, title: '新事件' });
    const event = await pending;
    expect(event.value?.payload.case).toBe('event');
    if (event.value?.payload.case === 'event') expect(event.value.payload.value.seq).toBe(2n);
    await watching.return?.();
  } finally {
    await cleanup(current);
  }
});

it('does not abort a new execution generation when replaying an old CancelRun', async () => {
  let providerCalls = 0;
  let providerAborts = 0;
  let releaseSecond = () => {};
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const provider: ModelProvider = {
    async *stream(_request, signal) {
      providerCalls += 1;
      const attempt = providerCalls;
      if (attempt > 2) throw new Error('Unexpected model attempt.');
      await Promise.race([
        attempt === 2 ? secondGate : new Promise<void>(() => {}),
        new Promise<void>((_, reject) => {
          const abort = () => {
            providerAborts += 1;
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
      yield* response('continued');
    },
  };
  const current = await fixture(provider);
  const { clients, store } = current;
  try {
    const threadId =
      (
        await clients.thread.createThread({
          environmentPolicy,
          clientActionId: 'create-1',
          title: '会话',
        })
      ).thread?.threadId ?? '';
    await clients.messages.sendMessage({
      clientActionId: 'send-1',
      threadId,
      text: 'question',
      mode: InputMode.FOLLOW_UP,
    });
    const runId = (await clients.thread.getThread({ threadId })).snapshot?.runs[0]?.runId ?? '';
    await vi.waitFor(() => expect(providerCalls).toBe(1));
    const request = { clientActionId: 'cancel-1', threadId, runId, reason: 'stop' };
    const firstReceipt = await clients.runs.cancelRun(request);
    expect(firstReceipt.status).toBe(RunStatus.CANCEL_REQUESTED);
    const inFlightReplay = await clients.runs.cancelRun(request);
    expect(inFlightReplay.status).toBe(firstReceipt.status);
    await waitRun(store, runId, RunStatus.CANCELLED);
    expect(providerAborts).toBe(1);

    await clients.runs.continueRun({ clientActionId: 'continue-1', threadId, runId });
    await vi.waitFor(() => expect(providerCalls).toBe(2));
    expect(store.getRunById(runId).generation).toBe(2);
    expect(store.getRunById(runId).cancelAcceptedGeneration).toBeNull();
    const oldReplay = await clients.runs.cancelRun(request);
    expect(oldReplay.status).toBe(firstReceipt.status);
    expect(providerAborts).toBe(1);
    expect(store.getRunById(runId).status).not.toBe('cancelled');
    releaseSecond();
    await waitRun(store, runId, RunStatus.COMPLETED);
    expect(providerAborts).toBe(1);
  } finally {
    releaseSecond();
    await cleanup(current);
  }
});

it('pages Recaps with a unique cursor across equal sources and agents', async () => {
  const current = await fixture();
  const { clients, store } = current;
  try {
    const threadId =
      (
        await clients.thread.createThread({
          environmentPolicy,
          clientActionId: 'create-1',
          title: '会话',
        })
      ).thread?.threadId ?? '';
    await clients.messages.sendMessage({
      clientActionId: 'send-1',
      threadId,
      text: 'source',
      mode: InputMode.FOLLOW_UP,
    });
    const runId = store.listRuns(ownerId, threadId)[0]?.runId ?? '';
    const input = store.listInputs(ownerId, threadId)[0];
    if (!input) throw new Error('Source input is missing.');
    const source = store.appendModelMessage({
      runId,
      inputId: input.inputId,
      message: { role: 'user', content: 'source' },
    });
    for (const recapId of ['recap-a', 'recap-b']) {
      store.recaps.save({
        recapId,
        threadId,
        agentId: 'thread',
        sourceMessageSeqs: [source.seq],
        content: recapId,
      });
    }
    const child = store.createChildRun(ownerId, runId, 'subagent-pagination');
    const childSource = store.appendModelMessage({
      runId: child.runId,
      message: { role: 'user', content: 'child source' },
    });
    store.recaps.save({
      recapId: 'recap-child',
      threadId,
      agentId: child.agentId,
      sourceMessageSeqs: [childSource.seq],
      content: 'child',
    });

    const first = await clients.context.readRecaps({
      threadId,
      agentId: '',
      afterSeq: 0n,
      limit: 1,
    });
    expect(first.recaps.map((recap) => recap.recapId)).toEqual(['recap-a']);
    expect(first.hasMore).toBe(true);
    const second = await clients.context.readRecaps({
      threadId,
      agentId: '',
      afterSeq: first.nextSeq ?? 0n,
      limit: 1,
    });
    expect(second.recaps.map((recap) => recap.recapId)).toEqual(['recap-b']);
    expect(second.hasMore).toBe(true);
    const third = await clients.context.readRecaps({
      threadId,
      agentId: '',
      afterSeq: second.nextSeq ?? 0n,
      limit: 1,
    });
    expect(third.recaps.map((recap) => recap.recapId)).toEqual(['recap-child']);
    expect(third.hasMore).toBe(false);
    for (const recap of [...first.recaps, ...second.recaps, ...third.recaps]) {
      expect(recap).not.toHaveProperty('title');
      expect(recap.content).not.toBe('');
      expect(recap.sourceMessageSeqs.length).toBeGreaterThan(0);
    }
    expect(second.recaps[0]?.sourceSeqStart).toBe(first.recaps[0]?.sourceSeqStart);
    expect(second.nextSeq).not.toBe(first.nextSeq);
    expect(
      (
        await clients.context.readRecaps({
          threadId,
          agentId: '',
          afterSeq: 9_007_199_254_740_993n,
          limit: 10,
        })
      ).recaps,
    ).toEqual([]);
    const snapshot = await clients.thread.getThread({ threadId, limit: 100 });
    expect(snapshot.snapshot?.recaps.map((recap) => recap.recapId)).toEqual([
      'recap-a',
      'recap-b',
      'recap-child',
    ]);
    expect(snapshot.snapshot?.recaps.map((recap) => recap.content)).toEqual([
      'recap-a',
      'recap-b',
      'child',
    ]);
    expect(snapshot.snapshot?.recaps.every((recap) => recap.validity === RecapValidity.VALID)).toBe(
      true,
    );
    const created = store
      .listEvents(threadId, 0n)
      .filter((event) => event.payload.case === 'recapCreated');
    expect(created).toHaveLength(3);
    expect(created[0]?.payload).toMatchObject({
      case: 'recapCreated',
      value: { recap: { recapId: 'recap-a', content: 'recap-a' } },
    });
    const streamed: Array<{ recapId: string; content: string; seq: bigint }> = [];
    for await (const item of clients.events.watchThread({ threadId, afterSeq: 0n })) {
      if (item.payload.case !== 'event' || item.payload.value.payload.case !== 'recapCreated') {
        continue;
      }
      const recap = item.payload.value.payload.value.recap;
      if (!recap) throw new Error('Recap 创建事件缺少正文。');
      streamed.push(recap);
      if (streamed.length === 3) break;
    }
    expect(streamed.map((recap) => recap.recapId)).toEqual(['recap-a', 'recap-b', 'recap-child']);
    expect(streamed.map((recap) => recap.content)).toEqual(['recap-a', 'recap-b', 'child']);
    expect(streamed.every((recap) => recap.seq > 0n)).toBe(true);
    expect(streamed.map((recap) => recap.seq)).toEqual(
      [...streamed.map((recap) => recap.seq)].sort((left, right) => (left < right ? -1 : 1)),
    );
  } finally {
    await cleanup(current);
  }
});
