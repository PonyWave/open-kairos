import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Code } from '@connectrpc/connect';
import type { ModelEvent, ModelProvider, ModelRequest } from '@kairos/agent-core';
import {
  InputMode,
  MessageRole,
  MessageSource,
  RunExecutionMode,
  RunStatus,
  ThreadType,
} from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { AgentEnvironmentRuntime } from '../sessions/environment-runtime.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import {
  accessToken,
  ControlledProvider,
  closeFixture,
  type Fixture,
  networkClients,
  ownerId,
  response,
  sendMessage,
  startFixture,
  waitRequest,
  waitRun,
} from './delegation-fixture.js';
import {
  ControlledEnvironmentUseGateway,
  seedTestEnvironment,
  startRealEnvironmentServer,
} from './environment-fixture.js';

const processEntry = fileURLToPath(new URL('./delegation-process.ts', import.meta.url));

type ContextMessage = Awaited<
  ReturnType<Fixture['clients']['context']['readContext']>
>['messages'][number];

function toolMessage(messages: ContextMessage[], callId: string): ContextMessage {
  const message = messages.find(
    (candidate) => candidate.role === MessageRole.TOOL && candidate.toolCallId === callId,
  );
  if (!message) {
    const detail = JSON.stringify(
      messages.map((candidate) => ({
        role: candidate.role,
        content: candidate.content,
        toolCallId: candidate.toolCallId,
        toolCalls: candidate.toolCalls,
      })),
    );
    throw new Error(`Tool result ${callId} is missing: ${detail}`);
  }
  return message;
}

function parsedTool(messages: ContextMessage[], callId: string): Record<string, unknown> {
  return JSON.parse(toolMessage(messages, callId).content) as Record<string, unknown>;
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

async function mainContext(fixture: Fixture, threadId: string, agentId = 'thread') {
  return (
    await fixture.clients.context.readContext({
      threadId,
      agentId,
      afterSeq: 0n,
      limit: 500,
    })
  ).messages;
}

function interactionRow(database: Fixture['database'], toolCallId: string) {
  return database
    .prepare(
      `SELECT source_tool_call_id, status, consumed_run_id, response_message_seq, error_code
       FROM interactions WHERE source_tool_call_id = ?`,
    )
    .get(toolCallId) as
    | {
        source_tool_call_id: string;
        status: string;
        consumed_run_id: string | null;
        response_message_seq: number | null;
        error_code: string | null;
      }
    | undefined;
}

function deliveryRow(database: Fixture['database'], toolCallId: string) {
  return database
    .prepare(
      `SELECT source_tool_call_id, content, context_message_seq, run_id, status
       FROM interaction_deliveries WHERE source_tool_call_id = ?`,
    )
    .get(toolCallId) as
    | {
        source_tool_call_id: string;
        content: string | null;
        context_message_seq: number | null;
        run_id: string | null;
        status: string;
      }
    | undefined;
}

async function waitDelivery(
  database: Fixture['database'],
  toolCallId: string,
  status: 'pending' | 'queued' | 'consumed',
) {
  await vi.waitFor(
    () => {
      expect(deliveryRow(database, toolCallId)?.status).toBe(status);
    },
    { timeout: 10_000 },
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

class CloseTrackingProvider implements ModelProvider {
  readonly controlled = new ControlledProvider();
  activeRequests = 0;

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.activeRequests += 1;
    try {
      yield* this.controlled.stream(request, signal);
    } finally {
      this.activeRequests -= 1;
    }
  }
}

it('REQ-01/REQ-05 keeps one main entry and pages every persistent Thread over Connect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-network-main-'));
  const provider = new ControlledProvider();
  provider.respond('user:direct prompt', response('direct response'));
  provider.register('user:active prompt', response('active response'));
  const fixture = await startFixture(directory, { provider });
  let activeRunId = '';
  try {
    const secondClients = networkClients(fixture.baseUrl);
    const mains = await Promise.all([
      ...Array.from({ length: 12 }, () => fixture.clients.thread.getOrCreateMain({})),
      ...Array.from({ length: 12 }, () => secondClients.thread.getOrCreateMain({})),
    ]);
    const mainId = mains[0]?.thread?.threadId ?? '';
    expect(mainId).not.toBe('');
    expect(new Set(mains.map((item) => item.thread?.threadId))).toEqual(new Set([mainId]));
    expect(mains.every((item) => item.thread?.threadType === ThreadType.MAIN)).toBe(true);
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM threads WHERE thread_type = 'main'")
        .get(),
    ).toEqual({ count: 1 });
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM threads').get()).toEqual({
      count: 1,
    });

    const taskIds: string[] = [];
    for (const [index, title] of ['直接任务', '非活跃任务', '活跃任务'].entries()) {
      const created = await fixture.clients.thread.createThread({
        clientActionId: `create-task-${index}`,
        title,
      });
      expect(created.thread?.threadType).toBe(ThreadType.TASK);
      taskIds.push(created.thread?.threadId ?? '');
    }
    const [directId, inactiveId, activeId] = taskIds;
    if (!directId || !inactiveId || !activeId) throw new Error('Task Threads are missing.');

    const active = await sendMessage(fixture, activeId, 'active prompt', 'send-active');
    activeRunId = active.runId;
    await waitRequest(provider, 'user:active prompt');
    const directRequest = {
      clientActionId: 'send-direct',
      threadId: directId,
      text: 'direct prompt',
      mode: InputMode.FOLLOW_UP,
    };
    const sent = await fixture.clients.messages.sendMessage(directRequest);
    const duplicate = await secondClients.messages.sendMessage(directRequest);
    expect(duplicate.inputId).toBe(sent.inputId);
    const directSnapshot = await fixture.clients.thread.getThread({ threadId: directId });
    const directRun = directSnapshot.snapshot?.runs
      .filter((run) => run.parentRunId === undefined)
      .at(-1);
    if (!directRun) throw new Error('Direct input Run is missing.');
    await waitRun(fixture, directId, directRun.runId, RunStatus.COMPLETED);

    const listed: string[] = [];
    let afterSeq = 0n;
    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      const page = await secondClients.thread.listThreads({ afterSeq, limit: 1 });
      listed.push(...page.threads.map((thread) => thread.threadId));
      if (page.threads[0]?.threadId === mainId) {
        expect(page.threads[0]?.threadType).toBe(ThreadType.MAIN);
      } else {
        expect(page.threads[0]?.threadType).toBe(ThreadType.TASK);
      }
      if (!page.hasMore) break;
      afterSeq = page.nextSeq ?? 0n;
    }
    expect(listed).toEqual([mainId, directId, inactiveId, activeId]);
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM runs WHERE thread_id = ?')
        .get(inactiveId),
    ).toEqual({ count: 0 });
    expect(
      (await fixture.clients.thread.getThread({ threadId: directId })).snapshot?.thread?.threadId,
    ).toBe(directId);
    expect((await secondClients.thread.getOrCreateMain({})).thread?.threadId).toBe(mainId);

    provider.resolve('user:active prompt');
    await waitRun(fixture, activeId, active.runId, RunStatus.COMPLETED);
    const reconnected = await secondClients.thread.getThread({ threadId: directId });
    expect(reconnected.snapshot?.messages.map((message) => message.content)).toEqual([
      'direct prompt',
      'direct response',
    ]);
    expect(reconnected.snapshot?.inputs).toHaveLength(1);
    expect(reconnected.snapshot?.inputs[0]?.source).toBe(MessageSource.USER);
    expect(reconnected.snapshot?.runs[0]?.executionMode).toBe(RunExecutionMode.BACKGROUND);
    expect(reconnected.snapshot?.runs[0]?.status).toBe(RunStatus.COMPLETED);
    expect((await mainContext(fixture, mainId)).map((message) => message.content)).not.toContain(
      'direct prompt',
    );
    expect((await mainContext(fixture, mainId)).map((message) => message.content)).not.toContain(
      'direct response',
    );
    const activeRequest = provider.requests.find((request) => request.key === 'user:active prompt');
    expect(activeRequest?.request.tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        'thread_list',
        'thread_create',
        'thread_call',
        'thread_read',
        'thread_cancel',
      ]),
    );

    const unauthenticated = networkClients(fixture.baseUrl, 'wrong-token');
    await expect(unauthenticated.thread.getOrCreateMain({})).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    await expect(unauthenticated.thread.getThread({ threadId: directId })).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
  } finally {
    if (activeRunId) provider.resolve('user:active prompt');
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('REQ-05 creates a Thread with its first call and resumes it across main Runs with exact deliveries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-network-thread-runs-'));
  const provider = new ControlledProvider();
  provider.respond(
    'user:create task',
    response('', [
      {
        id: 'call-first',
        name: 'thread_call',
        arguments: { thread_id: '', title: '跨 Run 任务', prompt: 'prompt one' },
      },
    ]),
  );
  provider.register('tool:call-first', response('unused'));
  provider.register('user:prompt one', response('response one'));
  const fixture = await startFixture(directory, { provider });
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const first = await sendMessage(fixture, mainId, 'create task', 'send-create');
    await waitRequest(provider, 'user:prompt one');
    const task = fixture.database
      .prepare("SELECT thread_id FROM threads WHERE title = '跨 Run 任务'")
      .get() as { thread_id: string } | undefined;
    const taskId = task?.thread_id ?? '';
    expect(taskId).not.toBe('');
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM threads').get()).toEqual({
      count: 2,
    });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM inputs WHERE thread_id = ?')
        .get(taskId),
    ).toEqual({ count: 1 });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM runs WHERE thread_id = ?')
        .get(taskId),
    ).toEqual({ count: 1 });
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM interactions').get()).toEqual({
      count: 1,
    });
    const targetInput = fixture.database
      .prepare(
        `SELECT input_id, source_tool_call_id, consumed_run_id, source, source_thread_id, mode
         FROM inputs WHERE thread_id = ?`,
      )
      .get(taskId) as
      | {
          input_id: string;
          source_tool_call_id: string;
          consumed_run_id: string;
          source: string;
          source_thread_id: string;
          mode: string;
        }
      | undefined;
    const firstToolCallId = targetInput?.source_tool_call_id ?? '';
    expect(targetInput).toMatchObject({
      source: 'thread_call',
      source_thread_id: mainId,
      mode: 'follow_up',
    });
    expect(firstToolCallId).not.toBe('');
    expect(interactionRow(fixture.database, firstToolCallId)?.status).toBe('running');
    const targetSnapshot = await fixture.clients.thread.getThread({ threadId: taskId });
    expect(targetSnapshot.snapshot?.runs[0]?.executionMode).toBe(RunExecutionMode.BACKGROUND);

    provider.resolve('user:prompt one');
    await vi.waitFor(() => {
      expect(interactionRow(fixture.database, firstToolCallId)).toMatchObject({
        status: 'completed',
        response_message_seq: expect.any(Number),
      });
    });
    await waitDelivery(fixture.database, firstToolCallId, 'queued');
    const responseJoin = fixture.database
      .prepare(
        `SELECT i.response_message_seq, m.content, d.content AS delivery_content,
                d.run_id, d.status AS delivery_status
         FROM interactions i
         JOIN context_messages m ON m.seq = i.response_message_seq
         JOIN interaction_deliveries d
           ON d.source_thread_id = i.source_thread_id
          AND d.source_agent_id = i.source_agent_id
          AND d.source_tool_call_id = i.source_tool_call_id
         WHERE i.source_tool_call_id = ?`,
      )
      .get(firstToolCallId) as Record<string, unknown> | undefined;
    expect(responseJoin).toMatchObject({
      content: 'response one',
      delivery_status: 'queued',
      run_id: first.runId,
    });
    expect(responseJoin?.delivery_content).toContain('response one');
    expect(
      fixture.database
        .prepare(
          "SELECT source FROM inputs WHERE source IN ('thread_response', 'subagent_response')",
        )
        .all(),
    ).toEqual([]);
    expect(provider.requests.some((request) => request.key === `delivery:${firstToolCallId}`)).toBe(
      false,
    );

    provider.register(
      'tool:call-first',
      response('', [
        {
          id: 'read-first',
          name: 'thread_read',
          arguments: { tool_call_id: firstToolCallId },
        },
      ]),
    );
    provider.respond('tool:read-first', response('first main response'));
    provider.respond(`delivery:${firstToolCallId}`, response('first delivery handled'));
    provider.resolve('tool:call-first');
    await waitRun(fixture, mainId, first.runId, RunStatus.COMPLETED);
    await waitDelivery(fixture.database, firstToolCallId, 'consumed');
    const firstMainContext = await mainContext(fixture, mainId);
    expect(parsedTool(firstMainContext, 'call-first')).toEqual({
      tool_call_id: firstToolCallId,
      thread_id: taskId,
      status: 'accepted',
      automatic_delivery: true,
      next_step: expect.stringMatching(
        /Accepted is not completion.*finish this turn.*injected automatically.*no status read or wait_ms/,
      ),
    });
    expect(parsedTool(firstMainContext, 'read-first')).toMatchObject({
      tool_call_id: firstToolCallId,
      status: 'completed',
      response: 'response one',
      timed_out: false,
    });
    expect(
      firstMainContext.filter(
        (message) => message.role === MessageRole.TOOL && message.toolCallId === 'call-first',
      ),
    ).toHaveLength(1);
    const firstMainSnapshot = await fixture.clients.thread.getThread({ threadId: mainId });
    const deliveredMessage = firstMainSnapshot.snapshot?.messages.find(
      (message) => message.delegation?.sourceToolCallId === firstToolCallId,
    );
    expect(deliveredMessage).toMatchObject({
      source: MessageSource.THREAD_RESPONSE,
      sourceThreadId: taskId,
      role: MessageRole.USER,
    });
    expect(deliveredMessage?.content).toContain('response one');
    expect(firstMainSnapshot.snapshot?.messages.map((message) => message.content)).not.toContain(
      'response one',
    );

    provider.respond(
      'user:continue task',
      response('', [{ id: 'list-cross', name: 'thread_list', arguments: { limit: 10 } }]),
    );
    provider.register(
      'tool:list-cross',
      response('', [
        {
          id: 'call-second',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'prompt two', mode: 'steer' },
        },
      ]),
    );
    provider.respond('tool:call-second', response('second main response'));
    provider.register('user:prompt two', response('response two'));
    const second = await sendMessage(fixture, mainId, 'continue task', 'send-continue');
    provider.resolve('tool:list-cross');
    await waitRequest(provider, 'user:prompt two');
    const secondToolCallId = (
      fixture.database
        .prepare(
          "SELECT source_tool_call_id FROM inputs WHERE thread_id = ? AND text = 'prompt two'",
        )
        .get(taskId) as { source_tool_call_id: string } | undefined
    )?.source_tool_call_id;
    if (!secondToolCallId) throw new Error('Second interaction is missing.');
    expect(secondToolCallId).not.toBe(firstToolCallId);
    await waitRun(fixture, mainId, second.runId, RunStatus.COMPLETED);
    expect(interactionRow(fixture.database, secondToolCallId)?.status).toBe('running');
    provider.respond(`delivery:${secondToolCallId}`, response('second delivery handled'));
    provider.resolve('user:prompt two');
    await waitDelivery(fixture.database, secondToolCallId, 'consumed');
    const secondDelivery = deliveryRow(fixture.database, secondToolCallId);
    const idleDeliveryRunId = secondDelivery?.run_id;
    if (!idleDeliveryRunId) {
      throw new Error(`Idle delivery Run is missing: ${JSON.stringify(secondDelivery)}`);
    }
    expect(idleDeliveryRunId).not.toBe(second.runId);
    await waitRun(fixture, mainId, idleDeliveryRunId, RunStatus.COMPLETED);

    const continuedRequest = provider.requests.find((request) => request.key === 'user:prompt two');
    expect(
      continuedRequest?.request.messages
        .filter((message) => message.role !== 'system')
        .map((message) => message.content),
    ).toEqual(['prompt one', 'response one', 'prompt two']);
    expect(interactionRow(fixture.database, firstToolCallId)?.consumed_run_id).not.toBe(
      interactionRow(fixture.database, secondToolCallId)?.consumed_run_id,
    );
    const listed = parsedTool(await mainContext(fixture, mainId), 'list-cross');
    expect(listed.threads).toEqual([
      expect.objectContaining({ thread_id: taskId, title: '跨 Run 任务', thread_type: 'task' }),
    ]);
    const targetMessages = await mainContext(fixture, taskId);
    expect(targetMessages.map((message) => message.content)).toEqual([
      'prompt one',
      'response one',
      'prompt two',
      'response two',
    ]);
    expect(
      targetMessages.filter((message) => message.source === MessageSource.THREAD_CALL),
    ).toHaveLength(2);
    expect(provider.requests.filter((request) => request.key === 'user:prompt one')).toHaveLength(
      1,
    );
    expect(provider.requests.filter((request) => request.key === 'user:prompt two')).toHaveLength(
      1,
    );
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('REQ-05 preserves background progress, tool boundaries and cancellation at minimum resource limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-network-resources-'));
  const provider = new ControlledProvider();
  const fixture = await startFixture(directory, {
    provider,
    maxActiveThreads: 1,
    maxConcurrentModelRequests: 2,
    realEnvironment: true,
  });
  const started = join(directory, 'background-started.txt');
  const released = join(directory, 'background-release.txt');
  const finished = join(directory, 'background-finished.txt');
  const cancelStarted = join(directory, 'cancel-started.txt');
  const cancelReleased = join(directory, 'cancel-release.txt');
  const cancelFinished = join(directory, 'cancel-finished.txt');
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const taskId =
      (
        await fixture.clients.thread.createThread({
          clientActionId: 'create-resource-task',
          title: '资源任务',
        })
      ).thread?.threadId ?? '';

    provider.respond(
      'user:nested outer',
      response('', [
        {
          id: 'nested-parent',
          name: 'subagent',
          arguments: { task: 'nested child', mode: 'foreground' },
        },
      ]),
    );
    provider.respond(
      'user:nested child',
      response('', [
        {
          id: 'nested-background',
          name: 'subagent',
          arguments: { task: 'forbidden nested background', mode: 'background' },
        },
      ]),
    );
    provider.respond('tool:nested-background', response('nested child complete'));
    provider.respond('tool:nested-parent', response('nested parent complete'));
    const nested = await sendMessage(fixture, mainId, 'nested outer', 'send-nested');
    await waitRun(fixture, mainId, nested.runId, RunStatus.COMPLETED);
    const nestedContext = await mainContext(fixture, mainId);
    expect(parsedTool(nestedContext, 'nested-parent')).toMatchObject({
      status: 'completed',
      result: 'nested child complete',
    });
    const nestedChild = fixture.database
      .prepare('SELECT run_id, agent_id, execution_mode FROM runs WHERE parent_run_id = ?')
      .get(nested.runId) as
      | { run_id: string; agent_id: string; execution_mode: string }
      | undefined;
    expect(nestedChild?.execution_mode).toBe('foreground');
    if (!nestedChild) throw new Error('Foreground Subagent is missing.');
    const nestedChildContext = await mainContext(fixture, mainId, nestedChild.agent_id);
    expect(toolMessage(nestedChildContext, 'nested-background').content).toContain(
      'Unknown tool: subagent.',
    );
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM interactions WHERE prompt = 'forbidden nested background'",
        )
        .get(),
    ).toEqual({ count: 0 });

    provider.respond(
      'user:start background',
      response('', [
        {
          id: 'bg-create',
          name: 'subagent',
          arguments: { task: 'bg work', mode: 'background' },
        },
      ]),
    );
    provider.register('tool:bg-create', response('unused'));
    provider.respond(
      'user:bg work',
      response('', [
        {
          id: 'bg-bash',
          name: 'bash',
          arguments: {
            env_id: fixture.realEnvironment?.envId,
            command: `printf 'started' > ${shellQuote(started)}; while [ ! -f ${shellQuote(released)} ]; do sleep 0.05; done; printf 'finished' > ${shellQuote(finished)}`,
            cwd: directory,
            timeoutSeconds: 30,
          },
        },
      ]),
    );
    provider.respond('tool:bg-bash', response('background response'));
    const background = await sendMessage(fixture, mainId, 'start background', 'send-background');
    await waitRequest(provider, 'tool:bg-create');
    await vi.waitFor(async () => {
      expect(await readFile(started, 'utf8')).toBe('started');
    });
    const backgroundToolCallId = (
      fixture.database
        .prepare(
          "SELECT source_tool_call_id FROM interactions WHERE source_tool_call_id = 'bg-create'",
        )
        .get() as { source_tool_call_id: string } | undefined
    )?.source_tool_call_id;
    if (!backgroundToolCallId) throw new Error('Background interaction is missing.');
    expect(parsedTool(await mainContext(fixture, mainId), 'bg-create')).toEqual({
      tool_call_id: backgroundToolCallId,
      status: 'accepted',
      automatic_delivery: true,
      next_step: expect.stringMatching(
        /Accepted is not completion.*finish this turn.*injected automatically.*no status read or wait_ms/,
      ),
    });
    const backgroundChild = fixture.database
      .prepare('SELECT run_id, agent_id, status FROM runs WHERE parent_run_id = ?')
      .get(background.runId) as { run_id: string; agent_id: string; status: string } | undefined;
    if (!backgroundChild) throw new Error('Background child Run is missing.');
    const sourceCancellation = await fixture.clients.runs.cancelRun({
      clientActionId: 'cancel-background-source',
      threadId: mainId,
      runId: background.runId,
      reason: 'stop caller only',
    });
    expect(sourceCancellation.status).toBe(RunStatus.CANCEL_REQUESTED);
    await waitRun(fixture, mainId, background.runId, RunStatus.CANCELLED);
    expect(
      fixture.database
        .prepare('SELECT status FROM runs WHERE run_id = ?')
        .get(backgroundChild.run_id),
    ).toEqual({ status: 'waiting' });

    const beforePageClose = await fixture.clients.thread.getThread({ threadId: mainId });
    const pageController = new AbortController();
    const pageWatch = fixture.clients.events
      .watchThread(
        { threadId: mainId, afterSeq: beforePageClose.throughSeq },
        { signal: pageController.signal },
      )
      [Symbol.asyncIterator]();
    const closedPage = pageWatch.next().then(
      () => {
        throw new Error('Closing a Thread page unexpectedly produced an event.');
      },
      () => undefined,
    );
    pageController.abort();
    await pageWatch.return?.();
    await closedPage;
    expect(
      fixture.database
        .prepare('SELECT status FROM runs WHERE run_id = ?')
        .get(backgroundChild.run_id),
    ).toEqual({ status: 'waiting' });
    expect(
      (await fixture.clients.thread.getThread({ threadId: mainId })).snapshot?.runs.find(
        (run) => run.runId === backgroundChild.run_id,
      )?.status,
    ).toBe(RunStatus.WAITING);

    provider.respond(
      'user:main continues',
      response('', [
        {
          id: 'bg-status',
          name: 'task_output',
          arguments: { task_id: backgroundToolCallId, wait_ms: 20 },
        },
      ]),
    );
    provider.respond('tool:bg-status', response('main continued'));
    const continued = await sendMessage(fixture, mainId, 'main continues', 'send-main-continues');
    await waitRun(fixture, mainId, continued.runId, RunStatus.COMPLETED);
    const backgroundStatus = parsedTool(await mainContext(fixture, mainId), 'bg-status');
    expect(backgroundStatus).toMatchObject({
      tool_call_id: backgroundToolCallId,
      response: null,
      timed_out: true,
      automatic_delivery: true,
      next_step: expect.stringMatching(
        /target was not cancelled.*Do not repeat short waits or poll.*finish this turn.*injected automatically/,
      ),
    });
    expect(['running', 'waiting']).toContain(backgroundStatus.status);
    expect(
      fixture.database
        .prepare('SELECT status FROM runs WHERE run_id = ?')
        .get(backgroundChild.run_id),
    ).toEqual({ status: 'waiting' });

    provider.respond(
      'user:queue task',
      response('', [
        {
          id: 'queue-call',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'queued prompt' },
        },
      ]),
    );
    provider.respond('tool:queue-call', response('task queued'));
    provider.respond('user:queued prompt', response('queued response'));
    const queued = await sendMessage(fixture, mainId, 'queue task', 'send-queue-task');
    await waitRun(fixture, mainId, queued.runId, RunStatus.COMPLETED);
    const queuedToolCallId = (
      fixture.database
        .prepare(
          "SELECT source_tool_call_id FROM inputs WHERE thread_id = ? AND text = 'queued prompt'",
        )
        .get(taskId) as { source_tool_call_id: string } | undefined
    )?.source_tool_call_id;
    if (!queuedToolCallId) throw new Error('Queued Thread interaction is missing.');
    expect(interactionRow(fixture.database, queuedToolCallId)?.status).toBe('queued');
    expect(provider.requests.some((request) => request.key === 'user:queued prompt')).toBe(false);
    expect(
      provider.requests
        .filter(
          (request) => request.key.startsWith('user:bg work') || request.key === 'tool:bg-bash',
        )
        .every((request) =>
          request.request.messages.every(
            (message) => message.content !== 'main continues' && message.content !== 'queue task',
          ),
        ),
    ).toBe(true);

    provider.respond(`delivery:${backgroundToolCallId}`, response('background delivered'));
    provider.respond(`delivery:${queuedToolCallId}`, response('queued task delivered'));
    await writeFile(released, 'released');
    await vi.waitFor(async () => {
      expect(await readFile(finished, 'utf8')).toBe('finished');
    });
    await waitDelivery(fixture.database, backgroundToolCallId, 'consumed');
    await waitDelivery(fixture.database, queuedToolCallId, 'consumed');
    expect(interactionRow(fixture.database, backgroundToolCallId)).toMatchObject({
      status: 'completed',
      response_message_seq: expect.any(Number),
    });
    expect(interactionRow(fixture.database, queuedToolCallId)).toMatchObject({
      status: 'completed',
      response_message_seq: expect.any(Number),
    });
    expect(
      provider.requests.filter((request) => request.key === 'user:queued prompt'),
    ).toHaveLength(1);
    const deliveredInputs = fixture.database
      .prepare(
        `SELECT source_tool_call_id, source FROM context_messages
         WHERE source_tool_call_id IN (?, ?) AND source IN ('thread_response', 'subagent_response')
         ORDER BY source`,
      )
      .all(backgroundToolCallId, queuedToolCallId);
    expect(deliveredInputs).toEqual([
      { source_tool_call_id: backgroundToolCallId, source: 'subagent_response' },
      { source_tool_call_id: queuedToolCallId, source: 'thread_response' },
    ]);
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM context_messages WHERE tool_call_id = 'bg-create'")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      (await fixture.clients.thread.listThreads({ afterSeq: 0n, limit: 10 })).threads,
    ).toHaveLength(2);

    provider.respond(
      'user:invalid delegation',
      response('', [
        {
          id: 'invalid-mode',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'invalid foreground', mode: 'foreground' },
        },
        { id: 'invalid-subagent', name: 'subagent', arguments: { task: 'missing mode' } },
      ]),
    );
    provider.respond('tool:invalid-mode', response('invalid calls handled'));
    provider.respond('tool:invalid-subagent', response('invalid calls handled'));
    const invalid = await sendMessage(fixture, mainId, 'invalid delegation', 'send-invalid');
    await waitRun(fixture, mainId, invalid.runId, RunStatus.COMPLETED);
    for (const callId of ['invalid-mode', 'invalid-subagent']) {
      expect(
        fixture.database
          .prepare('SELECT tool_status FROM context_messages WHERE tool_call_id = ?')
          .get(callId),
      ).toEqual({ tool_status: 'error' });
    }
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM interactions WHERE prompt = 'invalid foreground'")
        .get(),
    ).toEqual({ count: 0 });

    provider.respond(
      'user:start cancel background',
      response('', [
        {
          id: 'cancel-bg-create',
          name: 'subagent',
          arguments: { task: 'cancel bg work', mode: 'background' },
        },
      ]),
    );
    provider.register('tool:cancel-bg-create', response('unused'));
    provider.respond(
      'user:cancel bg work',
      response('', [
        {
          id: 'cancel-bg-bash',
          name: 'bash',
          arguments: {
            env_id: fixture.realEnvironment?.envId,
            command: `printf 'started' > ${shellQuote(cancelStarted)}; while [ ! -f ${shellQuote(cancelReleased)} ]; do sleep 0.05; done; printf 'finished' > ${shellQuote(cancelFinished)}`,
            cwd: directory,
            timeoutSeconds: 30,
          },
        },
      ]),
    );
    const cancelBackground = await sendMessage(
      fixture,
      mainId,
      'start cancel background',
      'send-cancel-background',
    );
    await vi.waitFor(async () => {
      expect(await readFile(cancelStarted, 'utf8')).toBe('started');
    });
    await waitRequest(provider, 'tool:cancel-bg-create');
    const cancelToolCallId = (
      fixture.database
        .prepare(
          "SELECT source_tool_call_id FROM interactions WHERE source_tool_call_id = 'cancel-bg-create'",
        )
        .get() as { source_tool_call_id: string } | undefined
    )?.source_tool_call_id;
    if (!cancelToolCallId) throw new Error('Cancellation interaction is missing.');
    provider.register(
      'tool:cancel-bg-create',
      response('', [
        {
          id: 'cancel-bg-stop',
          name: 'task_stop',
          arguments: { task_id: cancelToolCallId },
        },
      ]),
    );
    provider.respond('tool:cancel-bg-stop', response('background cancellation handled'));
    provider.respond(`delivery:${cancelToolCallId}`, response('cancellation delivered'));
    provider.resolve('tool:cancel-bg-create');
    await waitRun(fixture, mainId, cancelBackground.runId, RunStatus.COMPLETED);
    await waitDelivery(fixture.database, cancelToolCallId, 'consumed');
    expect(parsedTool(await mainContext(fixture, mainId), 'cancel-bg-stop').status).toSatisfy(
      (status) => status === 'cancel_requested' || status === 'cancelled',
    );
    expect(interactionRow(fixture.database, cancelToolCallId)).toMatchObject({
      status: 'cancelled',
      response_message_seq: null,
    });
    const cancelledDelivery = deliveryRow(fixture.database, cancelToolCallId);
    expect(cancelledDelivery?.content).toContain('"status":"cancelled"');
    expect(cancelledDelivery?.content).toContain('"response":null');
    await expect(readFile(cancelFinished, 'utf8')).rejects.toThrow();
  } finally {
    await writeFile(released, 'cleanup').catch(() => {});
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);

it('REQ-05 takes over queued follow-ups after targeted shared-Run cancellation without replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-network-shared-cancel-'));
  const provider = new ControlledProvider();
  const fixture = await startFixture(directory, { provider });
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const taskId =
      (
        await fixture.clients.thread.createThread({
          clientActionId: 'create-shared-task',
          title: '共享 Run 取消',
        })
      ).thread?.threadId ?? '';
    provider.respond(
      'user:shared cancellation',
      response('', [
        {
          id: 'call-first',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'first prompt' },
        },
      ]),
    );
    provider.register(
      'tool:call-first',
      response('', [
        {
          id: 'call-second',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'second prompt' },
        },
        {
          id: 'call-third',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'third prompt' },
        },
        {
          id: 'call-fourth',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'fourth prompt' },
        },
      ]),
    );
    for (const callId of ['call-second', 'call-third', 'call-fourth']) {
      provider.register(`tool:${callId}`, response('unused'));
    }
    provider.register('user:first prompt', response('must not complete'));
    provider.respond('user:second prompt', response('second response'));
    provider.respond('user:third prompt', response('must not start'));
    provider.respond('user:fourth prompt', response('fourth response'));
    provider.respond('tool:cancel-first', response('targeted cancellations handled'));
    provider.respond('tool:cancel-third', response('targeted cancellations handled'));

    const source = await sendMessage(fixture, mainId, 'shared cancellation', 'send-shared');
    await waitRequest(provider, 'user:first prompt');
    provider.resolve('tool:call-first');
    await vi.waitFor(() => {
      expect(
        fixture.database
          .prepare(
            "SELECT COUNT(*) AS count FROM inputs WHERE thread_id = ? AND source = 'thread_call'",
          )
          .get(taskId),
      ).toEqual({ count: 4 });
    });
    const ids = Object.fromEntries(
      (
        fixture.database
          .prepare(
            'SELECT text, source_tool_call_id FROM inputs WHERE thread_id = ? ORDER BY position',
          )
          .all(taskId) as Array<{ text: string; source_tool_call_id: string }>
      ).map((input) => [input.text.split(' ')[0], input.source_tool_call_id]),
    );
    const firstId = ids.first;
    const secondId = ids.second;
    const thirdId = ids.third;
    const fourthId = ids.fourth;
    if (!firstId || !secondId || !thirdId || !fourthId) {
      throw new Error('Shared-Run interaction IDs are missing.');
    }
    const cancellations = response('', [
      { id: 'cancel-first', name: 'thread_cancel', arguments: { tool_call_id: firstId } },
      { id: 'cancel-third', name: 'thread_cancel', arguments: { tool_call_id: thirdId } },
    ]);
    for (const callId of ['call-second', 'call-third', 'call-fourth']) {
      provider.register(`tool:${callId}`, cancellations);
    }
    for (const toolCallId of [firstId, secondId, thirdId, fourthId]) {
      provider.respond(`delivery:${toolCallId}`, response('delivery handled'));
    }
    provider.resolve('tool:call-first');
    await vi.waitFor(() => {
      expect(
        provider.requests.some((request) =>
          ['tool:call-second', 'tool:call-third', 'tool:call-fourth'].includes(request.key),
        ),
      ).toBe(true);
    });
    for (const callId of ['call-second', 'call-third', 'call-fourth']) {
      provider.resolve(`tool:${callId}`);
    }
    await waitRun(fixture, mainId, source.runId, RunStatus.COMPLETED);
    for (const toolCallId of [firstId, secondId, thirdId, fourthId]) {
      await waitDelivery(fixture.database, toolCallId, 'consumed');
    }

    const firstInteraction = interactionRow(fixture.database, firstId);
    const secondInteraction = interactionRow(fixture.database, secondId);
    const thirdInteraction = interactionRow(fixture.database, thirdId);
    const fourthInteraction = interactionRow(fixture.database, fourthId);
    expect(firstInteraction).toMatchObject({ status: 'cancelled', response_message_seq: null });
    expect(thirdInteraction).toMatchObject({
      status: 'cancelled',
      consumed_run_id: null,
      response_message_seq: null,
    });
    expect(secondInteraction).toMatchObject({
      status: 'completed',
      response_message_seq: expect.any(Number),
    });
    expect(fourthInteraction).toMatchObject({
      status: 'completed',
      response_message_seq: expect.any(Number),
    });
    expect(secondInteraction?.consumed_run_id).toBe(fourthInteraction?.consumed_run_id);
    expect(secondInteraction?.consumed_run_id).not.toBe(firstInteraction?.consumed_run_id);
    if (!firstInteraction?.consumed_run_id || !secondInteraction?.consumed_run_id) {
      throw new Error('Shared-Run consumption evidence is missing.');
    }
    expect(
      fixture.database
        .prepare('SELECT status FROM runs WHERE run_id = ?')
        .get(firstInteraction.consumed_run_id),
    ).toEqual({ status: 'cancelled' });
    expect(
      fixture.database
        .prepare('SELECT status, parent_run_id FROM runs WHERE run_id = ?')
        .get(secondInteraction.consumed_run_id),
    ).toEqual({ status: 'completed', parent_run_id: null });
    expect(provider.requests.filter((request) => request.key === 'user:first prompt')).toHaveLength(
      1,
    );
    expect(
      provider.requests.filter((request) => request.key === 'user:second prompt'),
    ).toHaveLength(1);
    expect(provider.requests.some((request) => request.key === 'user:third prompt')).toBe(false);
    expect(
      provider.requests.filter((request) => request.key === 'user:fourth prompt'),
    ).toHaveLength(1);

    const targetMessages = await mainContext(fixture, taskId);
    expect(targetMessages.map((message) => message.content)).toEqual([
      'first prompt',
      'second prompt',
      'second response',
      'fourth prompt',
      'fourth response',
    ]);
    const targetSnapshot = await fixture.clients.thread.getThread({ threadId: taskId });
    expect(
      targetSnapshot.snapshot?.runs.filter((run) => run.parentRunId === undefined),
    ).toHaveLength(2);
    const mainMessages = await mainContext(fixture, mainId);
    for (const callId of ['call-first', 'call-second', 'call-third', 'call-fourth']) {
      expect(parsedTool(mainMessages, callId).status).toBe('accepted');
      expect(
        mainMessages.filter(
          (message) => message.role === MessageRole.TOOL && message.toolCallId === callId,
        ),
      ).toHaveLength(1);
    }
    const mainSnapshot = await fixture.clients.thread.getThread({ threadId: mainId });
    for (const toolCallId of [firstId, secondId, thirdId, fourthId]) {
      const messages = mainSnapshot.snapshot?.messages.filter(
        (message) => message.delegation?.sourceToolCallId === toolCallId,
      );
      expect(messages).toHaveLength(1);
      expect(messages?.[0]?.source).toBe(MessageSource.THREAD_RESPONSE);
      expect(messages?.[0]?.role).toBe(MessageRole.USER);
    }
    const cancelledDelivery = mainSnapshot.snapshot?.messages.find(
      (message) => message.delegation?.sourceToolCallId === thirdId,
    );
    expect(cancelledDelivery?.content).toContain('"status":"cancelled"');
    expect(cancelledDelivery?.content).toContain('"response":null');
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('REQ-05 waits for exact Thread and Subagent results within the 30000 ms boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-network-read-waits-'));
  const provider = new ControlledProvider();
  const fixture = await startFixture(directory, { provider });
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const taskId =
      (
        await fixture.clients.thread.createThread({
          clientActionId: 'create-read-wait-task',
          title: '读取等待任务',
        })
      ).thread?.threadId ?? '';
    provider.respond(
      'user:thread wait start',
      response('', [
        {
          id: 'thread-wait-call',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'thread wait prompt' },
        },
      ]),
    );
    provider.register('tool:thread-wait-call', response('unused'));
    provider.register('user:thread wait prompt', response('thread wait response'));
    const threadSource = await sendMessage(
      fixture,
      mainId,
      'thread wait start',
      'send-thread-wait',
    );
    await waitRequest(provider, 'user:thread wait prompt');
    const threadToolCallId = (
      fixture.database
        .prepare(
          "SELECT source_tool_call_id FROM inputs WHERE thread_id = ? AND text = 'thread wait prompt'",
        )
        .get(taskId) as { source_tool_call_id: string } | undefined
    )?.source_tool_call_id;
    if (!threadToolCallId) throw new Error('Thread wait interaction is missing.');
    provider.respond(`delivery:${threadToolCallId}`, response('thread wait delivered'));
    provider.register(
      'tool:thread-wait-call',
      response('', [
        {
          id: 'thread-read-timeout',
          name: 'thread_read',
          arguments: { tool_call_id: threadToolCallId, wait_ms: 20 },
        },
      ]),
    );
    provider.respond('tool:thread-read-timeout', response('thread timeout handled'));
    provider.resolve('tool:thread-wait-call');
    await waitRun(fixture, mainId, threadSource.runId, RunStatus.COMPLETED);
    expect(parsedTool(await mainContext(fixture, mainId), 'thread-read-timeout')).toMatchObject({
      tool_call_id: threadToolCallId,
      status: 'running',
      response: null,
      timed_out: true,
      automatic_delivery: true,
      next_step: expect.stringMatching(
        /target was not cancelled.*Do not repeat short waits or poll.*finish this turn.*injected automatically/,
      ),
    });
    expect(interactionRow(fixture.database, threadToolCallId)).toMatchObject({
      status: 'running',
      response_message_seq: null,
    });
    expect(
      provider.requests.filter((request) => request.key === 'user:thread wait prompt'),
    ).toHaveLength(1);

    provider.respond(
      'user:thread wait finish',
      response('', [
        {
          id: 'thread-read-finish',
          name: 'thread_read',
          arguments: { tool_call_id: threadToolCallId, wait_ms: 30_000 },
        },
      ]),
    );
    provider.respond('tool:thread-read-finish', response('thread wait finished'));
    const threadFinish = await sendMessage(
      fixture,
      mainId,
      'thread wait finish',
      'send-thread-finish',
    );
    await vi.waitFor(() => {
      expect(
        fixture.database
          .prepare('SELECT call_id FROM context_tool_calls WHERE call_id = ?')
          .get('thread-read-finish'),
      ).toBeDefined();
    });
    setTimeout(() => provider.resolve('user:thread wait prompt'), 50);
    await waitRun(fixture, mainId, threadFinish.runId, RunStatus.COMPLETED);
    await waitDelivery(fixture.database, threadToolCallId, 'consumed');
    const threadFinishContext = await mainContext(fixture, mainId);
    expect(parsedTool(threadFinishContext, 'thread-read-finish')).toMatchObject({
      tool_call_id: threadToolCallId,
      status: 'completed',
      response: 'thread wait response',
      timed_out: false,
    });
    const threadReadCall = threadFinishContext
      .flatMap((message) => message.toolCalls)
      .find((call) => call.toolCallId === 'thread-read-finish');
    expect(JSON.parse(threadReadCall?.argumentsJson ?? '{}')).toMatchObject({ wait_ms: 30_000 });
    expect(interactionRow(fixture.database, threadToolCallId)).toMatchObject({
      status: 'completed',
      response_message_seq: expect.any(Number),
    });

    provider.respond(
      'user:subagent wait start',
      response('', [
        {
          id: 'subagent-wait-create',
          name: 'subagent',
          arguments: { task: 'subagent wait work', mode: 'background' },
        },
      ]),
    );
    provider.register('tool:subagent-wait-create', response('unused'));
    provider.register('user:subagent wait work', response('subagent wait response'));
    const subagentSource = await sendMessage(
      fixture,
      mainId,
      'subagent wait start',
      'send-subagent-wait',
    );
    await waitRequest(provider, 'user:subagent wait work');
    const subagentToolCallId = (
      fixture.database
        .prepare(
          "SELECT source_tool_call_id FROM interactions WHERE source_tool_call_id = 'subagent-wait-create'",
        )
        .get() as { source_tool_call_id: string } | undefined
    )?.source_tool_call_id;
    if (!subagentToolCallId) throw new Error('Subagent wait interaction is missing.');
    provider.respond(`delivery:${subagentToolCallId}`, response('subagent wait delivered'));
    provider.register(
      'tool:subagent-wait-create',
      response('', [
        {
          id: 'subagent-status-finish',
          name: 'task_output',
          arguments: { task_id: subagentToolCallId, wait_ms: 30_000 },
        },
      ]),
    );
    provider.respond('tool:subagent-status-finish', response('subagent wait finished'));
    provider.resolve('tool:subagent-wait-create');
    await vi.waitFor(() => {
      expect(
        fixture.database
          .prepare('SELECT call_id FROM context_tool_calls WHERE call_id = ?')
          .get('subagent-status-finish'),
      ).toBeDefined();
    });
    setTimeout(() => provider.resolve('user:subagent wait work'), 50);
    await waitRun(fixture, mainId, subagentSource.runId, RunStatus.COMPLETED);
    await waitDelivery(fixture.database, subagentToolCallId, 'consumed');
    const subagentFinishContext = await mainContext(fixture, mainId);
    expect(parsedTool(subagentFinishContext, 'subagent-status-finish')).toMatchObject({
      tool_call_id: subagentToolCallId,
      status: 'completed',
      response: 'subagent wait response',
      timed_out: false,
    });
    const subagentStatusCall = subagentFinishContext
      .flatMap((message) => message.toolCalls)
      .find((call) => call.toolCallId === 'subagent-status-finish');
    expect(JSON.parse(subagentStatusCall?.argumentsJson ?? '{}')).toMatchObject({
      wait_ms: 30_000,
    });
    expect(interactionRow(fixture.database, subagentToolCallId)).toMatchObject({
      status: 'completed',
      response_message_seq: expect.any(Number),
    });

    provider.respond(
      'user:invalid waits',
      response('', [
        {
          id: 'thread-read-over',
          name: 'thread_read',
          arguments: { tool_call_id: threadToolCallId, wait_ms: 30_001 },
        },
        {
          id: 'subagent-status-over',
          name: 'task_output',
          arguments: { task_id: subagentToolCallId, wait_ms: 30_001 },
        },
      ]),
    );
    provider.respond('tool:thread-read-over', response('invalid waits handled'));
    provider.respond('tool:subagent-status-over', response('invalid waits handled'));
    const invalid = await sendMessage(fixture, mainId, 'invalid waits', 'send-invalid-waits');
    await waitRun(fixture, mainId, invalid.runId, RunStatus.COMPLETED);
    for (const callId of ['thread-read-over', 'subagent-status-over']) {
      const stored = fixture.database
        .prepare('SELECT tool_status, tool_error_json FROM context_messages WHERE tool_call_id = ?')
        .get(callId) as { tool_status: string; tool_error_json: string } | undefined;
      expect(stored?.tool_status).toBe('error');
      expect(stored?.tool_error_json).toContain('invalid_arguments');
    }
    expect(
      provider.requests.filter((request) => request.key === 'user:thread wait prompt'),
    ).toHaveLength(1);
    expect(
      provider.requests.filter((request) => request.key === 'user:subagent wait work'),
    ).toHaveLength(1);
    expect(interactionRow(fixture.database, threadToolCallId)?.status).toBe('completed');
    expect(interactionRow(fixture.database, subagentToolCallId)?.status).toBe('completed');
  } finally {
    provider.resolve('user:thread wait prompt');
    provider.resolve('user:subagent wait work');
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('REQ-05 cancels a foreground Subagent with its caller and persists the actual terminal states', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-network-foreground-cancel-'));
  const provider = new ControlledProvider();
  provider.respond(
    'user:foreground cancellation',
    response('', [
      {
        id: 'foreground-cancel-create',
        name: 'subagent',
        arguments: { task: 'foreground cancel work', mode: 'foreground' },
      },
    ]),
  );
  provider.register('user:foreground cancel work', response('must not complete'));
  const fixture = await startFixture(directory, { provider });
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const parent = await sendMessage(
      fixture,
      mainId,
      'foreground cancellation',
      'send-foreground-cancellation',
    );
    await waitRequest(provider, 'user:foreground cancel work');
    const child = fixture.database
      .prepare('SELECT run_id, agent_id, execution_mode FROM runs WHERE parent_run_id = ?')
      .get(parent.runId) as
      | { run_id: string; agent_id: string; execution_mode: string }
      | undefined;
    if (!child) throw new Error('Foreground cancellation child is missing.');
    expect(child.execution_mode).toBe('foreground');
    const toolCallId = (
      fixture.database
        .prepare(
          "SELECT source_tool_call_id FROM interactions WHERE source_tool_call_id = 'foreground-cancel-create'",
        )
        .get() as { source_tool_call_id: string } | undefined
    )?.source_tool_call_id;
    if (!toolCallId) throw new Error('Foreground cancellation interaction is missing.');
    const receipt = await fixture.clients.runs.cancelRun({
      clientActionId: 'cancel-foreground-parent',
      threadId: mainId,
      runId: parent.runId,
      reason: 'cancel caller and foreground child',
    });
    expect(receipt.status).toBe(RunStatus.CANCEL_REQUESTED);
    await waitRun(fixture, mainId, parent.runId, RunStatus.CANCELLED);
    await waitRun(fixture, mainId, child.run_id, RunStatus.CANCELLED);
    expect(interactionRow(fixture.database, toolCallId)).toMatchObject({
      status: 'cancelled',
      response_message_seq: null,
    });
    expect(
      provider.requests.filter((request) => request.key === 'user:foreground cancel work'),
    ).toHaveLength(1);
    expect((await mainContext(fixture, mainId, child.agent_id)).map((m) => m.content)).toEqual([
      'foreground cancel work',
    ]);
    const snapshot = await fixture.clients.thread.getThread({ threadId: mainId });
    expect(snapshot.snapshot?.runs.find((run) => run.runId === parent.runId)?.status).toBe(
      RunStatus.CANCELLED,
    );
    expect(snapshot.snapshot?.runs.find((run) => run.runId === child.run_id)?.status).toBe(
      RunStatus.CANCELLED,
    );
    expect(snapshot.snapshot?.messages.map((message) => message.content)).not.toContain(
      'must not complete',
    );
  } finally {
    provider.resolve('user:foreground cancel work');
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('REQ-05 isolates target tools, temporary Subagents and hard cuts while reusing target Recap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-network-target-recap-'));
  const provider = new ControlledProvider();
  const longPrompt = `target original ${'x'.repeat(1200)}`;
  provider.respond('recap:generate', response('TARGET_RECAP_SECRET'));
  provider.respond(
    'prepared:recap',
    response('', [
      {
        id: 'target-bash-one',
        name: 'bash',
        arguments: { command: "printf 'INTERNAL_TOOL_SECRET'", cwd: directory },
      },
    ]),
  );
  provider.respond(
    'tool:target-bash-one',
    response('', [
      {
        id: 'target-child',
        name: 'subagent',
        arguments: { task: 'INTERNAL_CHILD_TASK_SECRET', mode: 'foreground' },
      },
    ]),
  );
  provider.respond('user:INTERNAL_CHILD_TASK_SECRET', response('INTERNAL_CHILD_RESPONSE_SECRET'));
  provider.respond(
    'tool:target-child',
    response('', [
      {
        id: 'target-bash-two',
        name: 'bash',
        arguments: { command: "printf 'INTERNAL_SECOND_TOOL_SECRET'", cwd: directory },
      },
    ]),
  );
  provider.register('tool:target-bash-two', response('TARGET_FINAL_RESPONSE'));
  const fixture = await startFixture(directory, {
    provider,
    contextWindowTokens: 1000,
    outputReserveTokens: 100,
    countTokens: (request) =>
      request.messages.some((message) => message.content === longPrompt) ? 1000 : 10,
  });
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const taskId =
      (
        await fixture.clients.thread.createThread({
          clientActionId: 'create-recap-target',
          title: '硬切目标任务',
        })
      ).thread?.threadId ?? '';
    provider.respond(
      'user:boundary call',
      response('', [
        {
          id: 'boundary-call',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: longPrompt },
        },
      ]),
    );
    provider.respond('tool:boundary-call', response('boundary source complete'));
    const firstSource = await sendMessage(fixture, mainId, 'boundary call', 'send-boundary-call');
    await waitRequest(provider, 'tool:target-bash-two');
    const firstToolCallId = (
      fixture.database
        .prepare('SELECT source_tool_call_id FROM inputs WHERE thread_id = ? AND text = ?')
        .get(taskId, longPrompt) as { source_tool_call_id: string } | undefined
    )?.source_tool_call_id;
    if (!firstToolCallId) throw new Error('Hard-cut interaction is missing.');
    provider.respond(`delivery:${firstToolCallId}`, response('hard-cut response delivered'));
    provider.resolve('tool:target-bash-two');
    await waitRun(fixture, mainId, firstSource.runId, RunStatus.COMPLETED);
    await waitDelivery(fixture.database, firstToolCallId, 'consumed');

    const generatedTarget = provider.requests.find((request) => request.key === 'recap:generate');
    const preparedTarget = provider.requests.find((request) => request.key === 'prepared:recap');
    expect(generatedTarget?.request.messages.slice(0, -1)).toEqual([
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('You are Kairos'),
      }),
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining(
          'All Agents load AGENTS.md and Skills from the main environment workspace',
        ),
      }),
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('<agent-execution-environment>'),
      }),
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('<workspace-resource path="AGENTS.md">'),
      }),
      { role: 'user', content: longPrompt },
    ]);
    expect(generatedTarget?.request.messages.at(-1)).toEqual({
      role: 'user',
      content: expect.stringContaining('Kairos internal Recap operation; instruction version 4'),
    });
    const targetSource = fixture.database
      .prepare(
        'SELECT seq FROM context_messages WHERE thread_id = ? AND agent_id = ? AND content = ?',
      )
      .get(taskId, 'thread', longPrompt) as { seq: number };
    expect(generatedTarget?.request.messages.at(-1)?.content).toContain(
      `[{"seq":${targetSource.seq},"message_index":4}]`,
    );
    expect(generatedTarget?.request.tools).toEqual(preparedTarget?.request.tools);
    expect(preparedTarget).toBeDefined();
    expect(
      preparedTarget?.request.messages.filter((message) =>
        message.content.includes('TARGET_RECAP_SECRET'),
      ),
    ).toHaveLength(1);
    expect(preparedTarget?.request.messages.some((message) => message.content === longPrompt)).toBe(
      false,
    );
    expect(provider.requests.filter((request) => request.key === 'recap:generate')).toHaveLength(1);
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM recaps WHERE thread_id = ? AND agent_id = ?')
        .get(taskId, 'thread'),
    ).toEqual({ count: 1 });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM recaps WHERE thread_id = ?')
        .get(mainId),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .prepare(
          'SELECT COUNT(*) AS count FROM model_request_records WHERE thread_id = ? AND hard_cut = 1',
        )
        .get(taskId),
    ).toEqual({ count: 1 });
    const targetRecaps = await fixture.clients.context.readRecaps({
      threadId: taskId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 10,
    });
    expect(targetRecaps.recaps).toHaveLength(1);
    expect(targetRecaps.recaps[0]?.content).toBe('TARGET_RECAP_SECRET');
    expect(
      (
        await fixture.clients.context.readRecaps({
          threadId: mainId,
          agentId: 'thread',
          afterSeq: 0n,
          limit: 10,
        })
      ).recaps,
    ).toEqual([]);

    const targetMessages = await mainContext(fixture, taskId);
    expect(targetMessages.map((message) => message.content)).toContain(longPrompt);
    expect(targetMessages.map((message) => message.content)).toContain('TARGET_FINAL_RESPONSE');
    expect(serialize(targetMessages)).toContain('INTERNAL_TOOL_SECRET');
    expect(serialize(targetMessages)).toContain('INTERNAL_CHILD_RESPONSE_SECRET');
    const targetRoot = fixture.database
      .prepare(
        `SELECT r.run_id, r.agent_id FROM runs r
         JOIN inputs i ON i.consumed_run_id = r.run_id
         WHERE i.source_tool_call_id = ?`,
      )
      .get(firstToolCallId) as { run_id: string; agent_id: string } | undefined;
    if (!targetRoot) throw new Error('Hard-cut target root is missing.');
    const temporaryChild = fixture.database
      .prepare('SELECT run_id, agent_id FROM runs WHERE parent_run_id = ?')
      .get(targetRoot.run_id) as { run_id: string; agent_id: string } | undefined;
    if (!temporaryChild) throw new Error('Target temporary Subagent is missing.');
    expect(
      (await mainContext(fixture, taskId, temporaryChild.agent_id)).map((m) => m.content),
    ).toEqual(['INTERNAL_CHILD_TASK_SECRET', 'INTERNAL_CHILD_RESPONSE_SECRET']);
    expect(
      (await fixture.clients.thread.listThreads({ afterSeq: 0n, limit: 10 })).threads,
    ).toHaveLength(2);

    const forbiddenInternalMarkers = [
      'INTERNAL_TOOL_SECRET',
      'INTERNAL_SECOND_TOOL_SECRET',
      'INTERNAL_CHILD_TASK_SECRET',
      'INTERNAL_CHILD_RESPONSE_SECRET',
      'TARGET_RECAP_SECRET',
    ];
    const firstMainRequests = provider.requests.filter((request) =>
      ['user:boundary call', 'tool:boundary-call', `delivery:${firstToolCallId}`].includes(
        request.key,
      ),
    );
    expect(firstMainRequests).toHaveLength(3);
    for (const marker of forbiddenInternalMarkers) {
      expect(serialize(firstMainRequests)).not.toContain(marker);
      expect(serialize(await mainContext(fixture, mainId))).not.toContain(marker);
    }
    expect(parsedTool(await mainContext(fixture, mainId), 'boundary-call')).toMatchObject({
      tool_call_id: firstToolCallId,
      status: 'accepted',
    });
    const firstDelivery = (
      await fixture.clients.thread.getThread({ threadId: mainId })
    ).snapshot?.messages.filter(
      (message) => message.delegation?.sourceToolCallId === firstToolCallId,
    );
    expect(firstDelivery).toHaveLength(1);
    expect(firstDelivery?.[0]?.source).toBe(MessageSource.THREAD_RESPONSE);
    expect(firstDelivery?.[0]?.content).toContain('TARGET_FINAL_RESPONSE');

    provider.respond(
      'user:second boundary',
      response('', [
        {
          id: 'second-boundary-call',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'second target prompt' },
        },
      ]),
    );
    provider.respond('tool:second-boundary-call', response('second source complete'));
    provider.register('user:second target prompt', response('SECOND_TARGET_RESPONSE'));
    const secondSource = await sendMessage(
      fixture,
      mainId,
      'second boundary',
      'send-second-boundary',
    );
    await waitRequest(provider, 'user:second target prompt');
    const secondToolCallId = (
      fixture.database
        .prepare(
          "SELECT source_tool_call_id FROM inputs WHERE thread_id = ? AND text = 'second target prompt'",
        )
        .get(taskId) as { source_tool_call_id: string } | undefined
    )?.source_tool_call_id;
    if (!secondToolCallId) throw new Error('Second hard-cut interaction is missing.');
    provider.respond(`delivery:${secondToolCallId}`, response('second hard-cut delivered'));
    provider.resolve('user:second target prompt');
    await waitRun(fixture, mainId, secondSource.runId, RunStatus.COMPLETED);
    await waitDelivery(fixture.database, secondToolCallId, 'consumed');
    const continuedTarget = provider.requests.find(
      (request) => request.key === 'user:second target prompt',
    );
    expect(
      continuedTarget?.request.messages.filter((message) =>
        message.content.includes('TARGET_RECAP_SECRET'),
      ),
    ).toHaveLength(1);
    expect(
      continuedTarget?.request.messages.some((message) => message.content === longPrompt),
    ).toBe(false);
    expect(continuedTarget?.request.messages.at(-1)?.content).toBe('second target prompt');
    expect(provider.requests.filter((request) => request.key === 'recap:generate')).toHaveLength(1);
    expect(interactionRow(fixture.database, secondToolCallId)?.consumed_run_id).not.toBe(
      interactionRow(fixture.database, firstToolCallId)?.consumed_run_id,
    );
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM recaps WHERE thread_id = ?')
        .get(taskId),
    ).toEqual({ count: 1 });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM runs WHERE thread_id = ? AND parent_run_id IS NULL')
        .get(taskId),
    ).toEqual({ count: 2 });
    const secondMainRequests = provider.requests.filter((request) =>
      [
        'user:second boundary',
        'tool:second-boundary-call',
        `delivery:${secondToolCallId}`,
      ].includes(request.key),
    );
    expect(secondMainRequests).toHaveLength(3);
    for (const marker of forbiddenInternalMarkers) {
      expect(JSON.stringify(secondMainRequests)).not.toContain(marker);
    }
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('REQ-05 waits for registered background execution during close and releases its live instance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-network-normal-close-'));
  const provider = new CloseTrackingProvider();
  provider.controlled.respond(
    'user:close background',
    response('', [
      {
        id: 'close-bg-create',
        name: 'subagent',
        arguments: { task: 'close bg work', mode: 'background' },
      },
    ]),
  );
  provider.controlled.respond('tool:close-bg-create', response('close parent complete'));
  provider.controlled.register('user:close bg work', response('must not replay'));
  let fixture = await startFixture(directory, { provider });
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const parent = await sendMessage(fixture, mainId, 'close background', 'send-close-background');
    await waitRequest(provider.controlled, 'user:close bg work');
    await waitRun(fixture, mainId, parent.runId, RunStatus.COMPLETED);
    expect(provider.activeRequests).toBe(1);
    const toolCallId = (
      fixture.database
        .prepare(
          "SELECT source_tool_call_id FROM interactions WHERE source_tool_call_id = 'close-bg-create'",
        )
        .get() as { source_tool_call_id: string } | undefined
    )?.source_tool_call_id;
    if (!toolCallId) throw new Error('Normal-close interaction is missing.');
    const childRunId = (
      fixture.database
        .prepare('SELECT run_id FROM runs WHERE parent_run_id = ?')
        .get(parent.runId) as { run_id: string } | undefined
    )?.run_id;
    if (!childRunId) throw new Error('Normal-close child Run is missing.');

    await fixture.server.close();
    expect(provider.activeRequests).toBe(0);
    const persisted = new DatabaseSync(join(directory, 'server.sqlite'), { readOnly: true });
    try {
      expect(persisted.prepare('SELECT status FROM runs WHERE run_id = ?').get(childRunId)).toEqual(
        { status: 'interrupted' },
      );
      expect(
        persisted
          .prepare(
            'SELECT status, response_message_seq FROM interactions WHERE source_tool_call_id = ?',
          )
          .get(toolCallId),
      ).toEqual({ status: 'interrupted', response_message_seq: null });
      expect(
        persisted
          .prepare("SELECT COUNT(*) AS count FROM context_messages WHERE content = 'close bg work'")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      persisted.close();
    }

    provider.controlled.resolve('user:close bg work');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(provider.activeRequests).toBe(0);
    expect(
      provider.controlled.requests.filter((request) => request.key === 'user:close bg work'),
    ).toHaveLength(1);

    const reopenedProvider = new ControlledProvider();
    reopenedProvider.respond(`delivery:${toolCallId}`, response('normal close delivered'));
    fixture = await startFixture(directory, { provider: reopenedProvider });
    await waitDelivery(fixture.database, toolCallId, 'consumed');
    expect(reopenedProvider.requests.some((request) => request.key === 'user:close bg work')).toBe(
      false,
    );
    expect(
      reopenedProvider.requests.filter((request) => request.key === `delivery:${toolCallId}`),
    ).toHaveLength(1);
    const snapshot = await fixture.clients.thread.getThread({ threadId: mainId });
    expect(snapshot.snapshot?.runs.find((run) => run.runId === childRunId)?.status).toBe(
      RunStatus.INTERRUPTED,
    );
    const delivered = snapshot.snapshot?.messages.filter(
      (message) => message.delegation?.sourceToolCallId === toolCallId,
    );
    expect(delivered).toHaveLength(1);
    expect(delivered?.[0]?.source).toBe(MessageSource.SUBAGENT_RESPONSE);
    expect(delivered?.[0]?.content).toContain('"status":"interrupted"');
    expect(delivered?.[0]?.content).toContain('"response":null');
    expect(snapshot.snapshot?.messages.map((message) => message.content)).not.toContain(
      'must not replay',
    );
  } finally {
    provider.controlled.resolve('user:close bg work');
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

class DelegationServerProcess {
  readonly requests: Array<{ key: string; request: ModelRequest }> = [];
  readonly #registrations = new Map<string, ModelEvent[]>();
  readonly #resolved = new Set<string>();
  readonly #registeredIds = new Set<string>();
  #child: ChildProcess | undefined;
  #port = 0;
  #output = '';

  constructor(readonly directory: string) {}

  get clients() {
    if (this.#port === 0) throw new Error(`Server process is not listening: ${this.#output}`);
    return networkClients(`http://127.0.0.1:${this.#port}`);
  }

  async start(): Promise<void> {
    if (this.#child) throw new Error('Server process is already running.');
    this.#port = 0;
    const database = openDatabase(join(this.directory, 'server.sqlite'));
    seedTestEnvironment(database, ownerId);
    database.close();
    const child = spawn(process.execPath, ['--import', 'tsx', processEntry], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        KAIROS_DELEGATION_TEST_DIRECTORY: this.directory,
        KAIROS_DELEGATION_TEST_RESPONSES: JSON.stringify(
          [...this.#registrations].map(([key, events]) => ({ key, events })),
        ),
        KAIROS_DELEGATION_TEST_RESOLVED: JSON.stringify([...this.#resolved]),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.#child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => {
      this.#output += text;
    });
    child.stderr?.on('data', (text: string) => {
      this.#output += text;
    });
    child.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const type = Reflect.get(message, 'type');
      if (type === 'ready') {
        const port = Reflect.get(message, 'port');
        if (typeof port === 'number') this.#port = port;
      } else if (type === 'registered') {
        const registrationId = Reflect.get(message, 'registrationId');
        if (typeof registrationId === 'string') this.#registeredIds.add(registrationId);
      } else if (type === 'request') {
        const key = Reflect.get(message, 'key');
        const request = Reflect.get(message, 'request');
        if (typeof key === 'string') {
          this.requests.push({ key, request: request as ModelRequest });
        }
      }
    });
    await vi.waitFor(
      () => {
        if (this.#port === 0) throw new Error(`Server is not ready: ${this.#output}`);
      },
      { timeout: 10_000 },
    );
    for (const [key, events] of this.#registrations) await this.#sendRegistration(key, events);
    for (const key of this.#resolved) child.send({ type: 'resolve', key });
  }

  async register(key: string, events: ModelEvent[]): Promise<void> {
    this.#registrations.set(key, events);
    if (this.#child && this.#port !== 0) await this.#sendRegistration(key, events);
  }

  async respond(key: string, events: ModelEvent[]): Promise<void> {
    await this.register(key, events);
    this.resolve(key);
  }

  resolve(key: string): void {
    if (!this.#registrations.has(key)) throw new Error(`No response registered for ${key}.`);
    this.#resolved.add(key);
    this.#child?.send({ type: 'resolve', key });
  }

  async #sendRegistration(key: string, events: ModelEvent[]): Promise<void> {
    const child = this.#child;
    if (!child) throw new Error('Server process is not running.');
    const registrationId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      child.send({ type: 'register', registrationId, key, events }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await vi.waitFor(
      () => {
        if (!this.#registeredIds.has(registrationId)) {
          throw new Error(`Registration ${key} was not acknowledged: ${this.#output}`);
        }
      },
      { timeout: 10_000 },
    );
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#child = undefined;
    this.#port = 0;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async waitRequest(key: string, count = 1): Promise<void> {
    await vi.waitFor(
      () => {
        const actual = this.requests.filter((request) => request.key === key).length;
        if (actual < count) {
          throw new Error(
            `Expected ${count} requests for ${key}, received ${actual}: ${this.#output}`,
          );
        }
      },
      { timeout: 10_000 },
    );
  }

  read<T>(work: (database: DatabaseSync) => T): T {
    const database = new DatabaseSync(join(this.directory, 'server.sqlite'), { readOnly: true });
    try {
      return work(database);
    } finally {
      database.close();
    }
  }
}

async function sendProcessMessage(
  server: DelegationServerProcess,
  threadId: string,
  text: string,
  actionId: string,
) {
  const sent = await server.clients.messages.sendMessage({
    clientActionId: actionId,
    threadId,
    text,
    mode: InputMode.FOLLOW_UP,
  });
  const snapshot = await server.clients.thread.getThread({ threadId });
  const run = snapshot.snapshot?.runs
    .filter((candidate) => candidate.parentRunId === undefined)
    .at(-1);
  if (!run) throw new Error('Process input has no root Run.');
  return { inputId: sent.inputId, runId: run.runId };
}

async function waitProcessRun(
  server: DelegationServerProcess,
  threadId: string,
  runId: string,
  status: RunStatus,
) {
  await vi.waitFor(
    async () => {
      const snapshot = await server.clients.thread.getThread({ threadId });
      const run = snapshot.snapshot?.runs.find((candidate) => candidate.runId === runId);
      if (run?.status !== status) {
        throw new Error(
          `Expected ${runId} status ${status}: ${JSON.stringify(run, (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString() : value,
          )}; requests=${server.requests.map((request) => request.key).join(',')}`,
        );
      }
    },
    { timeout: 10_000 },
  );
}

function processInteraction(server: DelegationServerProcess, toolCallId: string) {
  return server.read((database) =>
    database
      .prepare(
        `SELECT status, consumed_run_id, response_message_seq, error_code FROM interactions
         WHERE source_tool_call_id = ?`,
      )
      .get(toolCallId),
  ) as
    | {
        status: string;
        consumed_run_id: string | null;
        response_message_seq: number | null;
        error_code: string | null;
      }
    | undefined;
}

function processDelivery(server: DelegationServerProcess, toolCallId: string) {
  return server.read((database) =>
    database
      .prepare(
        `SELECT content, context_message_seq, run_id, status FROM interaction_deliveries
         WHERE source_tool_call_id = ?`,
      )
      .get(toolCallId),
  ) as
    | {
        content: string | null;
        context_message_seq: number | null;
        run_id: string | null;
        status: string;
      }
    | undefined;
}

async function waitProcessDelivery(
  server: DelegationServerProcess,
  toolCallId: string,
  status: 'pending' | 'queued' | 'consumed',
) {
  await vi.waitFor(
    () => {
      expect(processDelivery(server, toolCallId)?.status).toBe(status);
    },
    { timeout: 10_000 },
  );
}

it('REQ-05 restores saved and missing responses after a real Server crash without duplicate delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-network-process-delivery-'));
  const server = new DelegationServerProcess(directory);
  try {
    await server.start();
    const mainId = (await server.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const taskId =
      (
        await server.clients.thread.createThread({
          clientActionId: 'create-process-task',
          title: '进程恢复任务',
        })
      ).thread?.threadId ?? '';
    await server.respond(
      'user:restart call',
      response('', [
        {
          id: 'restart-call',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'restart prompt' },
        },
      ]),
    );
    await server.register('tool:restart-call', response('unused'));
    await server.respond('user:restart prompt', response('persisted response'));
    const source = await sendProcessMessage(server, mainId, 'restart call', 'send-restart-call');
    await server.waitRequest('user:restart prompt');
    const firstToolCallId = server.read(
      (database) =>
        (
          database
            .prepare(
              "SELECT source_tool_call_id FROM inputs WHERE thread_id = ? AND text = 'restart prompt'",
            )
            .get(taskId) as { source_tool_call_id: string } | undefined
        )?.source_tool_call_id,
    );
    if (!firstToolCallId) throw new Error('Persisted interaction is missing.');
    await vi.waitFor(() => {
      expect(processInteraction(server, firstToolCallId)).toMatchObject({
        status: 'completed',
        response_message_seq: expect.any(Number),
      });
    });
    await waitProcessDelivery(server, firstToolCallId, 'queued');
    await server.respond(`delivery:${firstToolCallId}`, response('restored delivery handled'));
    const beforeCrash = server.read((database) => ({
      prompts: database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE thread_id = ? AND content = 'restart prompt'",
        )
        .get(taskId),
      responses: database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE thread_id = ? AND content = 'persisted response'",
        )
        .get(taskId),
      deliveries: database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE source_tool_call_id = ? AND source = 'thread_response'",
        )
        .get(firstToolCallId),
    }));
    expect(beforeCrash).toEqual({
      prompts: { count: 1 },
      responses: { count: 1 },
      deliveries: { count: 0 },
    });

    await server.stop();
    expect(processInteraction(server, firstToolCallId)?.status).toBe('completed');
    expect(processDelivery(server, firstToolCallId)?.status).toBe('queued');
    await server.restart();
    await waitProcessDelivery(server, firstToolCallId, 'consumed');
    expect(processInteraction(server, firstToolCallId)?.status).toBe('completed');
    expect(server.requests.filter((request) => request.key === 'user:restart prompt')).toHaveLength(
      1,
    );
    expect(server.requests.filter((request) => request.key === 'user:restart call')).toHaveLength(
      1,
    );
    expect(
      server.requests.filter((request) => request.key === `delivery:${firstToolCallId}`),
    ).toHaveLength(1);
    expect(
      server.read((database) =>
        database.prepare('SELECT status FROM runs WHERE run_id = ?').get(source.runId),
      ),
    ).toEqual({ status: 'interrupted' });
    const restoredDelivery = processDelivery(server, firstToolCallId);
    const restoredRunId = restoredDelivery?.run_id;
    if (!restoredRunId) throw new Error('Restored delivery Run is missing.');
    await waitProcessRun(server, mainId, restoredRunId, RunStatus.COMPLETED);
    expect(restoredRunId).not.toBe(source.runId);
    const restoredSnapshot = await server.clients.thread.getThread({ threadId: mainId });
    const restoredMessages = restoredSnapshot.snapshot?.messages.filter(
      (message) => message.delegation?.sourceToolCallId === firstToolCallId,
    );
    expect(restoredMessages).toHaveLength(1);
    expect(restoredMessages?.[0]?.source).toBe(MessageSource.THREAD_RESPONSE);
    expect(restoredMessages?.[0]?.content).toContain('persisted response');

    await server.respond(
      'user:interrupt call',
      response('', [
        {
          id: 'interrupt-call',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'interrupt prompt' },
        },
      ]),
    );
    await server.respond('tool:interrupt-call', response('interrupt source complete'));
    await server.register('user:interrupt prompt', response('must not persist'));
    const interruptedSource = await sendProcessMessage(
      server,
      mainId,
      'interrupt call',
      'send-interrupt-call',
    );
    await server.waitRequest('user:interrupt prompt');
    await waitProcessRun(server, mainId, interruptedSource.runId, RunStatus.COMPLETED);
    const interruptedToolCallId = server.read(
      (database) =>
        (
          database
            .prepare(
              "SELECT source_tool_call_id FROM inputs WHERE thread_id = ? AND text = 'interrupt prompt'",
            )
            .get(taskId) as { source_tool_call_id: string } | undefined
        )?.source_tool_call_id,
    );
    if (!interruptedToolCallId) throw new Error('Interrupted interaction is missing.');
    expect(processInteraction(server, interruptedToolCallId)).toMatchObject({
      status: 'running',
      response_message_seq: null,
    });
    await server.respond(`delivery:${interruptedToolCallId}`, response('interruption delivered'));

    await server.stop();
    await server.restart();
    await waitProcessDelivery(server, interruptedToolCallId, 'consumed');
    expect(processDelivery(server, firstToolCallId)?.status).toBe('consumed');
    expect(
      server.read((database) =>
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM context_messages WHERE source_tool_call_id = ? AND source = 'thread_response'",
          )
          .get(firstToolCallId),
      ),
    ).toEqual({ count: 1 });
    expect(
      server.requests.filter((request) => request.key === `delivery:${firstToolCallId}`),
    ).toHaveLength(1);
    const consumedAfterRestart = await server.clients.thread.getThread({ threadId: mainId });
    const consumedMessages = consumedAfterRestart.snapshot?.messages.filter(
      (message) => message.delegation?.sourceToolCallId === firstToolCallId,
    );
    expect(consumedMessages).toHaveLength(1);
    expect(consumedMessages?.[0]?.source).toBe(MessageSource.THREAD_RESPONSE);
    expect(consumedMessages?.[0]?.content).toContain('persisted response');
    const targetAfterConsumedRestart = await server.clients.thread.getThread({ threadId: taskId });
    expect(
      targetAfterConsumedRestart.snapshot?.messages.filter(
        (message) =>
          message.content === 'restart prompt' || message.content === 'persisted response',
      ),
    ).toHaveLength(2);
    expect(processInteraction(server, interruptedToolCallId)).toMatchObject({
      status: 'interrupted',
      response_message_seq: null,
      error_code: 'operation_unknown',
    });
    expect(
      server.requests.filter((request) => request.key === 'user:interrupt prompt'),
    ).toHaveLength(1);
    expect(
      server.requests.filter((request) => request.key === `delivery:${interruptedToolCallId}`),
    ).toHaveLength(1);
    expect(
      server.read((database) =>
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM context_messages WHERE content = 'must not persist'",
          )
          .get(),
      ),
    ).toEqual({ count: 0 });
    const interruptedDelivery = processDelivery(server, interruptedToolCallId);
    expect(interruptedDelivery?.content).toContain('"status":"interrupted"');
    expect(interruptedDelivery?.content).toContain('"response":null');
    expect(
      server.read((database) =>
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM context_messages WHERE source_tool_call_id = ? AND source = 'thread_response'",
          )
          .get(interruptedToolCallId),
      ),
    ).toEqual({ count: 1 });
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);

it('REQ-05 resumes a persisted response whose delivery is still pending without duplication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-network-process-pending-'));
  const server = new DelegationServerProcess(directory);
  try {
    await server.start();
    const mainId = (await server.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const taskId =
      (
        await server.clients.thread.createThread({
          clientActionId: 'create-pending-task',
          title: 'pending 恢复任务',
        })
      ).thread?.threadId ?? '';
    await server.respond(
      'user:pending call',
      response('', [
        {
          id: 'pending-call',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'pending prompt' },
        },
      ]),
    );
    await server.register('tool:pending-call', response('unused'));
    await server.respond('user:pending prompt', response('pending response'));
    await sendProcessMessage(server, mainId, 'pending call', 'send-pending-call');
    await server.waitRequest('user:pending prompt');
    const toolCallId = server.read(
      (database) =>
        (
          database
            .prepare(
              "SELECT source_tool_call_id FROM inputs WHERE thread_id = ? AND text = 'pending prompt'",
            )
            .get(taskId) as { source_tool_call_id: string } | undefined
        )?.source_tool_call_id,
    );
    if (!toolCallId) throw new Error('Pending interaction is missing.');
    await waitProcessDelivery(server, toolCallId, 'queued');
    await server.respond(`delivery:${toolCallId}`, response('pending delivery handled'));

    const writable = new DatabaseSync(join(directory, 'server.sqlite'), {
      enableForeignKeyConstraints: true,
    });
    try {
      writable.exec('PRAGMA busy_timeout = 5000; BEGIN;');
      writable
        .prepare(
          `UPDATE interaction_deliveries
           SET status = 'pending', content = NULL, context_message_seq = NULL,
               run_id = NULL, queued_at = NULL
           WHERE source_tool_call_id = ?`,
        )
        .run(toolCallId);
      writable.exec('COMMIT;');
    } catch (error) {
      writable.exec('ROLLBACK;');
      throw error;
    } finally {
      writable.close();
    }
    expect(processInteraction(server, toolCallId)).toMatchObject({
      status: 'completed',
      response_message_seq: expect.any(Number),
    });
    expect(processDelivery(server, toolCallId)).toMatchObject({
      status: 'pending',
      content: null,
      context_message_seq: null,
      run_id: null,
    });
    const pendingCounts = server.read((database) => ({
      prompts: database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE thread_id = ? AND content = 'pending prompt'",
        )
        .get(taskId),
      responses: database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE thread_id = ? AND content = 'pending response'",
        )
        .get(taskId),
      deliveryInputs: database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE source_tool_call_id = ? AND source = 'thread_response'",
        )
        .get(toolCallId),
    }));
    expect(pendingCounts).toEqual({
      prompts: { count: 1 },
      responses: { count: 1 },
      deliveryInputs: { count: 0 },
    });
    expect(server.requests.filter((request) => request.key === 'user:pending prompt')).toHaveLength(
      1,
    );
    expect(server.requests.some((request) => request.key === `delivery:${toolCallId}`)).toBe(false);
    const pendingSnapshot = await server.clients.thread.getThread({ threadId: mainId });
    expect(
      pendingSnapshot.snapshot?.messages.filter(
        (message) => message.delegation?.sourceToolCallId === toolCallId,
      ),
    ).toEqual([]);

    await server.stop();
    expect(processDelivery(server, toolCallId)?.status).toBe('pending');
    await server.restart();
    await waitProcessDelivery(server, toolCallId, 'consumed');
    const restoredCounts = server.read((database) => ({
      prompts: database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE thread_id = ? AND content = 'pending prompt'",
        )
        .get(taskId),
      responses: database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE thread_id = ? AND content = 'pending response'",
        )
        .get(taskId),
      deliveryInputs: database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE source_tool_call_id = ? AND source = 'thread_response'",
        )
        .get(toolCallId),
    }));
    expect(restoredCounts).toEqual({
      prompts: { count: 1 },
      responses: { count: 1 },
      deliveryInputs: { count: 1 },
    });
    expect(server.requests.filter((request) => request.key === 'user:pending prompt')).toHaveLength(
      1,
    );
    expect(
      server.requests.filter((request) => request.key === `delivery:${toolCallId}`),
    ).toHaveLength(1);
    const restoredSnapshot = await server.clients.thread.getThread({ threadId: mainId });
    const restoredMessages = restoredSnapshot.snapshot?.messages.filter(
      (message) => message.delegation?.sourceToolCallId === toolCallId,
    );
    expect(restoredMessages).toHaveLength(1);
    expect(restoredMessages?.[0]?.source).toBe(MessageSource.THREAD_RESPONSE);
    expect(restoredMessages?.[0]?.content).toContain('pending response');
    const restoredTarget = await server.clients.thread.getThread({ threadId: taskId });
    expect(
      restoredTarget.snapshot?.messages.filter(
        (message) => message.content === 'pending prompt' || message.content === 'pending response',
      ),
    ).toHaveLength(2);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);

it('REQ-05 requires explicit recovery for an unknown Bash and never repeats its side effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-network-process-bash-'));
  const executions = join(directory, 'executions.txt');
  const pidPath = join(directory, 'bash.pid');
  const release = join(directory, 'release-bash.txt');
  const provider = new ControlledProvider();
  const options = {
    ownerId,
    accessToken,
    model: {
      provider,
      providerId: 'delegation-recovery-provider',
      modelId: 'delegation-recovery-model',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
    },
    outputDirectory: join(directory, 'outputs'),
  };
  let fixture = await startRealEnvironmentServer(directory, options);
  let bashPid = 0;
  try {
    const taskId =
      (
        await fixture.clients.thread.createThread({
          clientActionId: 'create-crash-bash-task',
          title: 'crash recovery task',
        })
      ).thread?.threadId ?? '';
    await provider.respond(
      'user:crash bash',
      response('', [
        {
          id: 'crash-bash',
          name: 'bash',
          arguments: {
            env_id: fixture.envId,
            command: `printf 'execution\\n' >> ${shellQuote(executions)}; printf '%s' "$$" > ${shellQuote(pidPath)}; while [ ! -f ${shellQuote(release)} ]; do sleep 0.05; done; printf 'late\\n' >> ${shellQuote(executions)}`,
            cwd: directory,
            timeoutSeconds: 30,
          },
        },
      ]),
    );
    await provider.respond('tool:crash-bash', response('recovered without replay'));
    const accepted = await fixture.clients.messages.sendMessage({
      clientActionId: 'send-crash-bash',
      threadId: taskId,
      text: 'crash bash',
      mode: InputMode.FOLLOW_UP,
    });
    const acceptedSnapshot = await fixture.clients.thread.getThread({ threadId: taskId });
    const runId = acceptedSnapshot.snapshot?.runs
      .filter((run) => run.parentRunId === undefined)
      .at(-1)?.runId;
    if (!runId) throw new Error('The crash Bash Run is missing.');
    expect(accepted.inputId).not.toBe('');
    await vi.waitFor(async () => {
      expect(await readFile(executions, 'utf8')).toBe('execution\n');
      bashPid = Number(await readFile(pidPath, 'utf8'));
      expect(Number.isSafeInteger(bashPid) && bashPid > 0).toBe(true);
    });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM server_bash_operations WHERE run_id = ?')
        .get(runId),
    ).toEqual({ count: 0 });
    const envId = fixture.envId;

    await fixture.daemon.stop();
    fixture.channel.close();
    fixture.server.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      fixture.server.server.close((error) => (error ? reject(error) : resolve()));
    });
    await fixture.server.close();
    if (bashPid > 0) {
      try {
        process.kill(-bashPid, 'SIGKILL');
      } catch (error) {
        if (Reflect.get(error as object, 'code') !== 'ESRCH') throw error;
      }
    }

    fixture = await startRealEnvironmentServer(directory, { ...options, existingEnvId: envId });
    expect(provider.requests.filter((request) => request.key === 'user:crash bash')).toHaveLength(
      1,
    );
    expect(provider.requests.some((request) => request.key === 'tool:crash-bash')).toBe(false);
    expect(await readFile(executions, 'utf8')).toBe('execution\n');
    const interrupted = await fixture.clients.thread.getThread({ threadId: taskId });
    expect(interrupted.snapshot?.runs.find((run) => run.runId === runId)?.status).toBe(
      RunStatus.INTERRUPTED,
    );
    const environmentRuntime = new AgentEnvironmentRuntime({
      store: new SessionStore(fixture.database),
      environments: fixture.environments,
      operations: fixture.channel,
      environmentUse: new ControlledEnvironmentUseGateway(fixture.database),
    });
    const recovered = await environmentRuntime.savedResult(runId, 'crash-bash');
    expect(recovered).toMatchObject({ status: 'error' });
    expect(recovered?.content).toContain('"status":"unknown"');

    await fixture.clients.runs.continueRun({
      clientActionId: 'continue-crash-bash',
      threadId: taskId,
      runId,
    });
    await vi.waitFor(
      async () => {
        const snapshot = await fixture.clients.thread.getThread({ threadId: taskId });
        expect(snapshot.snapshot?.runs.find((run) => run.runId === runId)?.status).toBe(
          RunStatus.COMPLETED,
        );
      },
      { timeout: 10_000 },
    );
    expect(provider.requests.filter((request) => request.key === 'user:crash bash')).toHaveLength(
      1,
    );
    expect(provider.requests.filter((request) => request.key === 'tool:crash-bash')).toHaveLength(
      1,
    );
    expect(await readFile(executions, 'utf8')).toBe('execution\n');
    expect(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM server_bash_operations').get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM environment_operations WHERE action = 'bash'")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_environment_operations WHERE result_status = 'error'",
        )
        .get(),
    ).toEqual({ count: 1 });
    const recoveredContext = await fixture.clients.context.readContext({
      threadId: taskId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 100,
    });
    expect(recoveredContext.messages.map((message) => message.content)).toContain(
      'The remote operation cancellation could not be confirmed.',
    );
    expect(recoveredContext.messages.map((message) => message.content)).toContain(
      'recovered without replay',
    );
  } finally {
    await fixture.close();
    if (bashPid > 0) {
      try {
        process.kill(-bashPid, 'SIGKILL');
      } catch {
        // The explicitly stopped Bash process group may already be gone.
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);
