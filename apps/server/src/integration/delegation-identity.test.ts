import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  create,
  DelegationReferenceSchema,
  type GetThreadResponse,
  InputMode,
  MessageRole,
  MessageSource,
  RunStatus,
  toBinary,
} from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { stripMessageMeta } from '../context/model-input.js';
import { SessionStore } from '../sessions/store.js';
import { systemReminderContent } from '../sessions/system-reminder.js';
import {
  ControlledProvider,
  closeFixture,
  type Fixture,
  ownerId,
  response,
  sendMessage,
  startFixture,
  waitRequest,
  waitRun,
} from './delegation-fixture.js';

type ContextMessage = Awaited<
  ReturnType<Fixture['clients']['context']['readContext']>
>['messages'][number];

interface InteractionRow {
  source_thread_id: string;
  source_agent_id: string;
  source_tool_call_id: string;
  source_run_id: string;
  target_thread_id: string;
  target_agent_id: string;
  reply_thread_id: string;
  target_input_id: string | null;
  accepted_run_id: string | null;
  consumed_run_id: string | null;
  status: string;
  response_message_seq: number | null;
}

interface DeliveryRow {
  source_thread_id: string;
  source_agent_id: string;
  source_tool_call_id: string;
  content: string | null;
  context_message_seq: number | null;
  run_id: string | null;
  status: string;
}

async function readContext(fixture: Fixture, threadId: string, agentId = 'thread') {
  return (
    await fixture.clients.context.readContext({
      threadId,
      agentId,
      afterSeq: 0n,
      limit: 500,
    })
  ).messages;
}

function toolResult(messages: ContextMessage[], callId: string) {
  const message = messages.find(
    (candidate) => candidate.role === MessageRole.TOOL && candidate.toolCallId === callId,
  );
  if (!message) throw new Error(`Tool result ${callId} is missing.`);
  return JSON.parse(message.content) as Record<string, unknown>;
}

function interaction(
  fixture: Fixture,
  sourceThreadId: string,
  sourceToolCallId: string,
  sourceAgentId = 'thread',
) {
  return fixture.database
    .prepare(
      `SELECT source_thread_id, source_agent_id, source_tool_call_id, source_run_id,
              target_thread_id, target_agent_id, reply_thread_id, target_input_id,
              accepted_run_id, consumed_run_id, status, response_message_seq
       FROM interactions
       WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
    )
    .get(sourceThreadId, sourceAgentId, sourceToolCallId) as InteractionRow | undefined;
}

function delivery(
  fixture: Fixture,
  sourceThreadId: string,
  sourceToolCallId: string,
  sourceAgentId = 'thread',
) {
  return fixture.database
    .prepare(
      `SELECT source_thread_id, source_agent_id, source_tool_call_id, content,
              context_message_seq, run_id, status
       FROM interaction_deliveries
       WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
    )
    .get(sourceThreadId, sourceAgentId, sourceToolCallId) as DeliveryRow | undefined;
}

async function waitDelivery(
  fixture: Fixture,
  sourceThreadId: string,
  sourceToolCallId: string,
  status: DeliveryRow['status'],
) {
  await vi.waitFor(
    () => {
      expect(delivery(fixture, sourceThreadId, sourceToolCallId)?.status).toBe(status);
    },
    { timeout: 10_000 },
  );
}

function deliveredMessages(snapshot: GetThreadResponse, sourceToolCallId: string) {
  return (
    snapshot.snapshot?.messages.filter(
      (message) => message.delegation?.sourceToolCallId === sourceToolCallId,
    ) ?? []
  );
}

it('REQ-05 keeps original tool_call_id triples isolated across shared and later Runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-delegation-identity-runs-'));
  const provider = new ControlledProvider();
  provider.respond(
    'user:multi delegate',
    response('', [
      {
        id: 'multi-a',
        name: 'thread_call',
        arguments: { thread_id: '', prompt: 'target first' },
      },
      {
        id: 'multi-b',
        name: 'thread_call',
        arguments: { thread_id: '', prompt: 'target second' },
      },
    ]),
  );
  provider.register('user:target first', response('first late response'));
  provider.register('user:target second', response('cancelled response must not persist'));
  provider.respond('tool:multi-a', response('source Run complete'));
  provider.respond('tool:multi-b', response('source Run complete'));
  provider.respond('delivery:multi-a', response('late delivery handled'));
  provider.respond('delivery:multi-b', response('cancel delivery handled'));
  const fixture = await startFixture(directory, { provider });
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const taskId =
      (
        await fixture.clients.thread.createThread({
          clientActionId: 'create-identity-target',
          title: '原调用关联目标',
        })
      ).thread?.threadId ?? '';
    provider.register(
      'user:multi delegate',
      response('', [
        {
          id: 'multi-a',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'target first' },
        },
        {
          id: 'multi-b',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'target second' },
        },
      ]),
    );
    provider.resolve('user:multi delegate');

    const source = await sendMessage(fixture, mainId, 'multi delegate', 'send-multi-delegate');
    await waitRequest(provider, 'user:target first');
    await waitRun(fixture, mainId, source.runId, RunStatus.COMPLETED);
    const first = interaction(fixture, mainId, 'multi-a');
    const second = interaction(fixture, mainId, 'multi-b');
    expect(first).toMatchObject({
      source_agent_id: 'thread',
      source_run_id: source.runId,
      target_thread_id: taskId,
      reply_thread_id: mainId,
      status: 'running',
      response_message_seq: null,
    });
    expect(second).toMatchObject({
      source_agent_id: 'thread',
      source_run_id: source.runId,
      target_thread_id: taskId,
      accepted_run_id: first?.accepted_run_id,
      status: 'queued',
      response_message_seq: null,
    });
    expect(first?.accepted_run_id).not.toBeNull();

    const sourceContext = await readContext(fixture, mainId);
    expect(toolResult(sourceContext, 'multi-a')).toEqual({
      tool_call_id: 'multi-a',
      thread_id: taskId,
      status: 'accepted',
      automatic_delivery: true,
      next_step: expect.stringMatching(
        /Accepted is not completion.*finish this turn.*injected automatically.*no status read or wait_ms/,
      ),
    });
    expect(toolResult(sourceContext, 'multi-b')).toEqual({
      tool_call_id: 'multi-b',
      thread_id: taskId,
      status: 'accepted',
      automatic_delivery: true,
      next_step: expect.stringMatching(
        /Accepted is not completion.*finish this turn.*injected automatically.*no status read or wait_ms/,
      ),
    });

    const store = new SessionStore(fixture.database);
    const duplicate = store.acceptThreadCall({
      ownerId,
      sourceThreadId: mainId,
      sourceAgentId: 'thread',
      sourceRunId: source.runId,
      sourceToolCallId: 'multi-a',
      targetThreadId: taskId,
      prompt: 'target first',
      mode: 'follow_up',
    });
    expect(duplicate.interaction).toMatchObject({
      sourceToolCallId: 'multi-a',
      targetInputId: first?.target_input_id,
      acceptedRunId: first?.accepted_run_id,
    });
    expect(() =>
      store.acceptThreadCall({
        ownerId,
        sourceThreadId: mainId,
        sourceAgentId: 'thread',
        sourceRunId: source.runId,
        sourceToolCallId: 'multi-a',
        targetThreadId: taskId,
        prompt: 'changed parameters',
        mode: 'follow_up',
      }),
    ).toThrowError(expect.objectContaining({ code: 'action_conflict' }));
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM inputs WHERE thread_id = ? AND source = 'thread_call'",
        )
        .get(taskId),
    ).toEqual({ count: 2 });

    provider.respond(
      'user:cross Run controls',
      response('', [
        {
          id: 'read-original-a',
          name: 'thread_read',
          arguments: { tool_call_id: 'multi-a', wait_ms: 20 },
        },
        {
          id: 'cancel-original-b',
          name: 'thread_cancel',
          arguments: { tool_call_id: 'multi-b' },
        },
      ]),
    );
    provider.respond('tool:read-original-a', response('cross Run controls complete'));
    provider.respond('tool:cancel-original-b', response('cross Run controls complete'));
    const controls = await sendMessage(
      fixture,
      mainId,
      'cross Run controls',
      'send-cross-run-controls',
    );
    await waitRun(fixture, mainId, controls.runId, RunStatus.COMPLETED);
    const controlContext = await readContext(fixture, mainId);
    expect(toolResult(controlContext, 'read-original-a')).toMatchObject({
      tool_call_id: 'multi-a',
      status: 'running',
      response: null,
      timed_out: true,
    });
    expect(toolResult(controlContext, 'cancel-original-b')).toEqual({
      tool_call_id: 'multi-b',
      status: 'cancelled',
    });
    expect(interaction(fixture, mainId, 'multi-a')?.status).toBe('running');
    expect(interaction(fixture, mainId, 'multi-b')).toMatchObject({
      status: 'cancelled',
      consumed_run_id: null,
      response_message_seq: null,
    });
    expect(provider.requests.some((request) => request.key === 'user:target second')).toBe(false);

    provider.resolve('user:target first');
    await waitDelivery(fixture, mainId, 'multi-a', 'consumed');
    await waitDelivery(fixture, mainId, 'multi-b', 'consumed');
    const lateDelivery = delivery(fixture, mainId, 'multi-a');
    expect(lateDelivery?.run_id).not.toBe(source.runId);
    expect(lateDelivery?.run_id).not.toBe(controls.runId);
    if (!lateDelivery?.run_id) throw new Error('Late delivery Run is missing.');
    await waitRun(fixture, mainId, lateDelivery.run_id, RunStatus.COMPLETED);
    const completedFirst = interaction(fixture, mainId, 'multi-a');
    expect(completedFirst).toMatchObject({
      status: 'completed',
      response_message_seq: expect.any(Number),
    });
    const responseSeq = completedFirst?.response_message_seq;
    if (responseSeq === null || responseSeq === undefined) {
      throw new Error('The completed interaction has no response sequence.');
    }
    const targetResponse = fixture.database
      .prepare('SELECT thread_id, agent_id, content FROM context_messages WHERE seq = ?')
      .get(responseSeq);
    expect(targetResponse).toEqual({
      thread_id: taskId,
      agent_id: 'thread',
      content: 'first late response',
    });
    expect(interaction(fixture, mainId, 'multi-b')?.response_message_seq).toBeNull();
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE content = 'cancelled response must not persist'",
        )
        .get(),
    ).toEqual({ count: 0 });

    const mainSnapshot = await fixture.clients.thread.getThread({ threadId: mainId });
    for (const [callId, content, sourceType] of [
      ['multi-a', 'first late response', MessageSource.THREAD_RESPONSE],
      ['multi-b', '"status":"cancelled"', MessageSource.THREAD_RESPONSE],
    ] as const) {
      const messages = deliveredMessages(mainSnapshot, callId);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: MessageRole.USER,
        source: sourceType,
        sourceThreadId: taskId,
        delegation: {
          sourceThreadId: mainId,
          sourceAgentId: 'thread',
          sourceToolCallId: callId,
        },
      });
      expect(messages[0]).not.toHaveProperty('interactionId');
      expect(messages[0]?.content).toContain(content);
    }
    expect(
      mainSnapshot.snapshot?.inputs.filter(
        (input) =>
          input.source === MessageSource.THREAD_RESPONSE ||
          input.source === MessageSource.SUBAGENT_RESPONSE,
      ),
    ).toEqual([]);
    expect(
      sourceContext.filter(
        (message) => message.role === MessageRole.TOOL && message.toolCallId === 'multi-a',
      ),
    ).toHaveLength(1);
  } finally {
    provider.resolve('user:target first');
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('REQ-05 isolates identical Subagent call IDs across GUI, Provider, SQLite and Protobuf', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-delegation-identity-sources-'));
  const provider = new ControlledProvider();
  provider.respond(
    'user:main same ID',
    response('', [
      {
        id: 'shared-subagent-call',
        name: 'subagent',
        arguments: { task: 'main child work', mode: 'background' },
      },
    ]),
  );
  provider.respond(
    'user:task same ID',
    response('', [
      {
        id: 'shared-subagent-call',
        name: 'subagent',
        arguments: { task: 'task child work', mode: 'background' },
      },
    ]),
  );
  provider.register('user:main child work', response('main child response'));
  provider.register('user:task child work', response('task child response'));
  provider.respond('tool:shared-subagent-call', response('source accepted'));
  provider.respond('delivery:shared-subagent-call', response('delivery handled'));
  let fixture = await startFixture(directory, { provider });
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const taskId =
      (
        await fixture.clients.thread.createThread({
          clientActionId: 'create-second-delegation-source',
          title: '第二委派来源',
        })
      ).thread?.threadId ?? '';
    const mainSource = await sendMessage(fixture, mainId, 'main same ID', 'send-main-same-id');
    await waitRequest(provider, 'user:main child work');
    const taskSource = await sendMessage(fixture, taskId, 'task same ID', 'send-task-same-id');
    await waitRequest(provider, 'user:task child work');
    await waitRun(fixture, mainId, mainSource.runId, RunStatus.COMPLETED);
    await waitRun(fixture, taskId, taskSource.runId, RunStatus.COMPLETED);

    const mainInteraction = interaction(fixture, mainId, 'shared-subagent-call');
    const taskInteraction = interaction(fixture, taskId, 'shared-subagent-call');
    expect(mainInteraction).toMatchObject({
      source_agent_id: 'thread',
      source_run_id: mainSource.runId,
      target_thread_id: mainId,
      reply_thread_id: mainId,
      status: 'running',
    });
    expect(taskInteraction).toMatchObject({
      source_agent_id: 'thread',
      source_run_id: taskSource.runId,
      target_thread_id: taskId,
      reply_thread_id: taskId,
      status: 'running',
    });
    expect(mainInteraction?.target_agent_id).toMatch(/^subagent-/);
    expect(taskInteraction?.target_agent_id).toMatch(/^subagent-/);
    expect(mainInteraction?.target_agent_id).not.toBe(taskInteraction?.target_agent_id);
    const mainAgentId = mainInteraction?.target_agent_id ?? '';
    const taskAgentId = taskInteraction?.target_agent_id ?? '';

    provider.resolve('user:main child work');
    await waitDelivery(fixture, mainId, 'shared-subagent-call', 'consumed');
    const mainDelivery = delivery(fixture, mainId, 'shared-subagent-call');
    if (!mainDelivery?.run_id) throw new Error('Main Subagent delivery Run is missing.');
    await waitRun(fixture, mainId, mainDelivery.run_id, RunStatus.COMPLETED);
    expect(interaction(fixture, mainId, 'shared-subagent-call')).toMatchObject({
      status: 'completed',
      response_message_seq: expect.any(Number),
    });
    expect(interaction(fixture, taskId, 'shared-subagent-call')?.status).toBe('running');
    expect(delivery(fixture, taskId, 'shared-subagent-call')).toBeUndefined();

    const mainSnapshot = await fixture.clients.thread.getThread({ threadId: mainId });
    const mainMessages = deliveredMessages(mainSnapshot, 'shared-subagent-call');
    expect(mainMessages).toHaveLength(1);
    expect(mainMessages[0]).toMatchObject({
      role: MessageRole.USER,
      source: MessageSource.SUBAGENT_RESPONSE,
      sourceThreadId: mainId,
      sourceAgentId: mainAgentId,
      delegation: {
        sourceThreadId: mainId,
        sourceAgentId: 'thread',
        sourceToolCallId: 'shared-subagent-call',
      },
    });
    expect(mainMessages[0]).not.toHaveProperty('interactionId');
    expect(mainMessages[0]?.content).toContain('main child response');
    expect(mainMessages[0]?.content).not.toContain('task child response');
    expect(mainMessages[0]?.sourceInputId).toBeUndefined();
    expect(
      mainSnapshot.snapshot?.inputs.filter(
        (input) => input.source === MessageSource.SUBAGENT_RESPONSE,
      ),
    ).toEqual([]);
    if (!mainInteraction) throw new Error('Main interaction is missing.');
    const reference = mainMessages[0]?.delegation;
    if (!reference) throw new Error('GUI DelegationReference is missing.');
    expect(toBinary(DelegationReferenceSchema, reference)).toEqual(
      toBinary(
        DelegationReferenceSchema,
        create(DelegationReferenceSchema, {
          sourceThreadId: mainInteraction.source_thread_id,
          sourceAgentId: mainInteraction.source_agent_id,
          sourceToolCallId: mainInteraction.source_tool_call_id,
        }),
      ),
    );

    const mainRootContext = await readContext(fixture, mainId);
    const taskRootContext = await readContext(fixture, taskId);
    expect(toolResult(mainRootContext, 'shared-subagent-call')).toEqual({
      tool_call_id: 'shared-subagent-call',
      agent_id: expect.any(String),
      status: 'accepted',
      automatic_delivery: true,
      next_step: expect.stringMatching(
        /Accepted is not completion.*finish this turn.*injected automatically.*no status read or wait_ms/,
      ),
    });
    expect(toolResult(taskRootContext, 'shared-subagent-call')).toEqual({
      tool_call_id: 'shared-subagent-call',
      agent_id: expect.any(String),
      status: 'accepted',
      automatic_delivery: true,
      next_step: expect.stringMatching(
        /Accepted is not completion.*finish this turn.*injected automatically.*no status read or wait_ms/,
      ),
    });
    expect(
      mainRootContext.filter(
        (message) =>
          message.role === MessageRole.TOOL && message.toolCallId === 'shared-subagent-call',
      ),
    ).toHaveLength(1);
    expect(
      taskRootContext.filter(
        (message) =>
          message.role === MessageRole.TOOL && message.toolCallId === 'shared-subagent-call',
      ),
    ).toHaveLength(1);
    expect(
      (await readContext(fixture, mainId, mainAgentId)).map((message) => message.content),
    ).toEqual(['main child work', 'main child response']);
    expect(
      (await readContext(fixture, taskId, taskAgentId)).map((message) => message.content),
    ).toEqual(['task child work']);
    const deliveryRequests = provider.requests.filter(
      (request) => request.key === 'delivery:shared-subagent-call',
    );
    expect(deliveryRequests).toHaveLength(1);
    const deliveryReminder = systemReminderContent(
      stripMessageMeta(deliveryRequests[0]?.request.messages.at(-1)?.content ?? ''),
    );
    const providerDelivery = JSON.parse(
      deliveryReminder === undefined
        ? '{}'
        : deliveryReminder.slice(deliveryReminder.indexOf('\n') + 1),
    ) as Record<string, unknown>;
    expect(providerDelivery).toMatchObject({
      source_thread_id: mainId,
      source_agent_id: 'thread',
      tool_call_id: 'shared-subagent-call',
      agent_id: mainAgentId,
      status: 'completed',
      response: 'main child response',
    });
    const mainChildRequest = provider.requests.find(
      (request) => request.key === 'user:main child work',
    );
    const taskChildRequest = provider.requests.find(
      (request) => request.key === 'user:task child work',
    );
    expect(JSON.stringify(mainChildRequest?.request.messages)).not.toContain('task child work');
    expect(JSON.stringify(taskChildRequest?.request.messages)).not.toContain('main child work');
    expect(
      (await fixture.clients.thread.listThreads({ afterSeq: 0n, limit: 10 })).threads.map(
        (thread) => thread.threadId,
      ),
    ).toEqual([mainId, taskId]);

    const consumedContextSeq = mainDelivery.context_message_seq;
    const consumedRunId = mainDelivery.run_id;
    await closeFixture(fixture);
    const persisted = new DatabaseSync(join(directory, 'server.sqlite'), { readOnly: true });
    try {
      expect(
        persisted
          .prepare(
            `SELECT status, response_message_seq FROM interactions
             WHERE source_thread_id = ? AND source_agent_id = 'thread'
               AND source_tool_call_id = 'shared-subagent-call'`,
          )
          .get(taskId),
      ).toEqual({ status: 'interrupted', response_message_seq: null });
      expect(
        persisted
          .prepare(
            `SELECT status, context_message_seq, run_id FROM interaction_deliveries
             WHERE source_thread_id = ? AND source_agent_id = 'thread'
               AND source_tool_call_id = 'shared-subagent-call'`,
          )
          .get(mainId),
      ).toEqual({
        status: 'consumed',
        context_message_seq: consumedContextSeq,
        run_id: consumedRunId,
      });
    } finally {
      persisted.close();
    }

    const restartedProvider = new ControlledProvider();
    restartedProvider.respond(
      'delivery:shared-subagent-call',
      response('restart delivery handled'),
    );
    fixture = await startFixture(directory, { provider: restartedProvider });
    await waitDelivery(fixture, taskId, 'shared-subagent-call', 'consumed');
    const restartedTaskDelivery = delivery(fixture, taskId, 'shared-subagent-call');
    if (!restartedTaskDelivery?.run_id) throw new Error('Restarted Task delivery Run is missing.');
    await waitRun(fixture, taskId, restartedTaskDelivery.run_id, RunStatus.COMPLETED);
    expect(restartedTaskDelivery.run_id).not.toBe(taskSource.runId);
    expect(restartedTaskDelivery.content).toContain('"status":"interrupted"');
    expect(restartedTaskDelivery.content).toContain('"response":null');
    expect(
      restartedProvider.requests.filter(
        (request) => request.key === 'delivery:shared-subagent-call',
      ),
    ).toHaveLength(1);
    expect(
      restartedProvider.requests.some(
        (request) =>
          request.key === 'user:main child work' || request.key === 'user:task child work',
      ),
    ).toBe(false);
    expect(
      provider.requests.filter((request) => request.key === 'delivery:shared-subagent-call'),
    ).toHaveLength(1);
    expect(delivery(fixture, mainId, 'shared-subagent-call')).toMatchObject({
      status: 'consumed',
      context_message_seq: consumedContextSeq,
      run_id: consumedRunId,
    });
    expect(
      deliveredMessages(
        await fixture.clients.thread.getThread({ threadId: mainId }),
        'shared-subagent-call',
      ),
    ).toHaveLength(1);
    const taskMessages = deliveredMessages(
      await fixture.clients.thread.getThread({ threadId: taskId }),
      'shared-subagent-call',
    );
    expect(taskMessages).toHaveLength(1);
    expect(taskMessages[0]?.delegation).toMatchObject({
      sourceThreadId: taskId,
      sourceAgentId: 'thread',
      sourceToolCallId: 'shared-subagent-call',
    });
    expect(taskMessages[0]?.content).not.toContain('main child response');

    await closeFixture(fixture);
    const quietProvider = new ControlledProvider();
    fixture = await startFixture(directory, { provider: quietProvider });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(quietProvider.requests).toEqual([]);
    expect(
      deliveredMessages(
        await fixture.clients.thread.getThread({ threadId: mainId }),
        'shared-subagent-call',
      ),
    ).toHaveLength(1);
    expect(
      deliveredMessages(
        await fixture.clients.thread.getThread({ threadId: taskId }),
        'shared-subagent-call',
      ),
    ).toHaveLength(1);
  } finally {
    provider.resolve('user:main child work');
    provider.resolve('user:task child work');
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);

it('REQ-05 persists busy direct injection before ordinary follow_up without a queue input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-delegation-identity-busy-'));
  const provider = new ControlledProvider();
  const observations: Array<{
    status: string;
    contextMessageSeq: number | null;
    persistedSeq: number | undefined;
    runId: string | null;
  }> = [];
  let currentFixture: Fixture | undefined;
  const observingProvider = {
    async *stream(request: Parameters<ControlledProvider['stream']>[0], signal: AbortSignal) {
      const last = request.messages.at(-1);
      if (
        last?.role === 'user' &&
        last.content.includes('"tool_call_id":"busy-call"') &&
        currentFixture
      ) {
        const deliveryText = systemReminderContent(stripMessageMeta(last.content));
        if (deliveryText === undefined) {
          throw new Error('Delegation delivery is not wrapped as a system reminder.');
        }
        const parsed: unknown = JSON.parse(deliveryText.slice(deliveryText.indexOf('\n') + 1));
        if (typeof parsed !== 'object' || parsed === null) {
          throw new Error('Delegation delivery is not an object.');
        }
        const sourceThreadId = Reflect.get(parsed, 'source_thread_id');
        const sourceAgentId = Reflect.get(parsed, 'source_agent_id');
        const sourceToolCallId = Reflect.get(parsed, 'tool_call_id');
        const kind = Reflect.get(parsed, 'kind');
        if (
          typeof sourceThreadId !== 'string' ||
          typeof sourceAgentId !== 'string' ||
          sourceToolCallId !== 'busy-call' ||
          kind !== 'thread_call'
        ) {
          throw new Error('Delegation delivery identity is invalid.');
        }
        const row = currentFixture.database
          .prepare(
            `SELECT status, context_message_seq, run_id FROM interaction_deliveries
             WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
          )
          .get(sourceThreadId, sourceAgentId, sourceToolCallId) as
          | { status: string; context_message_seq: number | null; run_id: string | null }
          | undefined;
        const persisted =
          row?.context_message_seq === null || row?.context_message_seq === undefined
            ? undefined
            : (currentFixture.database
                .prepare('SELECT seq FROM context_messages WHERE seq = ?')
                .get(row.context_message_seq) as { seq: number } | undefined);
        if (row) {
          observations.push({
            status: row.status,
            contextMessageSeq: row.context_message_seq,
            persistedSeq: persisted?.seq,
            runId: row.run_id,
          });
        }
      }
      yield* provider.stream(request, signal);
    },
  };
  const fixture = await startFixture(directory, { provider: observingProvider });
  currentFixture = fixture;
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const taskId =
      (
        await fixture.clients.thread.createThread({
          clientActionId: 'create-busy-target',
          title: '忙时注入目标',
        })
      ).thread?.threadId ?? '';
    provider.respond(
      'user:busy delegation',
      response('', [
        {
          id: 'busy-call',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'busy target' },
        },
      ]),
    );
    provider.register('user:busy target', response('busy target response'));
    provider.respond('tool:busy-call', response('delegation source complete'));
    provider.register('user:busy root', response('busy root response'));
    provider.respond('delivery:busy-call', response('injection handled'));
    provider.respond('user:ordinary follow-up', response('ordinary follow-up handled'));

    const source = await sendMessage(fixture, mainId, 'busy delegation', 'send-busy-delegation');
    await waitRequest(provider, 'user:busy target');
    await waitRun(fixture, mainId, source.runId, RunStatus.COMPLETED);
    const busy = await sendMessage(fixture, mainId, 'busy root', 'send-busy-root');
    await waitRequest(provider, 'user:busy root');
    const ordinary = await fixture.clients.messages.sendMessage({
      clientActionId: 'send-ordinary-follow-up',
      threadId: mainId,
      text: 'ordinary follow-up',
      mode: InputMode.FOLLOW_UP,
    });
    expect(ordinary.inputId).not.toBe('');
    const inputsBefore = (await fixture.clients.thread.getThread({ threadId: mainId })).snapshot
      ?.inputs.length;

    provider.resolve('user:busy target');
    await waitDelivery(fixture, mainId, 'busy-call', 'queued');
    expect(delivery(fixture, mainId, 'busy-call')).toMatchObject({
      run_id: busy.runId,
      context_message_seq: null,
    });
    expect(provider.requests.some((request) => request.key === 'delivery:busy-call')).toBe(false);
    expect(provider.requests.some((request) => request.key === 'user:ordinary follow-up')).toBe(
      false,
    );
    const beforeRelease = await fixture.clients.thread.getThread({ threadId: mainId });
    expect(beforeRelease.snapshot?.inputs).toHaveLength(inputsBefore ?? 0);
    expect(
      beforeRelease.snapshot?.inputs.filter(
        (input) => input.source === MessageSource.THREAD_RESPONSE,
      ),
    ).toEqual([]);
    expect(deliveredMessages(beforeRelease, 'busy-call')).toEqual([]);

    provider.resolve('user:busy root');
    await waitRun(fixture, mainId, busy.runId, RunStatus.COMPLETED);
    await waitDelivery(fixture, mainId, 'busy-call', 'consumed');
    const requestKeys = provider.requests.map((request) => request.key);
    const busyIndex = requestKeys.indexOf('user:busy root');
    const deliveryIndex = requestKeys.indexOf('delivery:busy-call');
    const ordinaryIndex = requestKeys.indexOf('user:ordinary follow-up');
    expect(busyIndex).toBeGreaterThanOrEqual(0);
    expect(deliveryIndex).toBeGreaterThan(busyIndex);
    expect(ordinaryIndex).toBeGreaterThan(deliveryIndex);
    expect(requestKeys.filter((key) => key === 'user:busy root')).toHaveLength(1);
    expect(requestKeys.filter((key) => key === 'delivery:busy-call')).toHaveLength(1);
    expect(requestKeys.filter((key) => key === 'user:ordinary follow-up')).toHaveLength(1);
    const deliveryRequest = provider.requests[deliveryIndex];
    expect(JSON.stringify(deliveryRequest?.request.messages)).not.toContain('ordinary follow-up');
    const ordinaryRequest = provider.requests[ordinaryIndex];
    expect(stripMessageMeta(ordinaryRequest?.request.messages.at(-1)?.content ?? '')).toBe(
      'ordinary follow-up',
    );
    expect(
      ordinaryRequest?.request.messages.map((message) => stripMessageMeta(message.content)),
    ).toContain(delivery(fixture, mainId, 'busy-call')?.content);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      status: 'consumed',
      contextMessageSeq: expect.any(Number),
      persistedSeq: expect.any(Number),
      runId: busy.runId,
    });
    expect(observations[0]?.persistedSeq).toBe(observations[0]?.contextMessageSeq);
    const joined = fixture.database
      .prepare(
        `SELECT d.status, d.context_message_seq, d.run_id, m.seq, m.run_id AS context_run_id,
                m.source, m.delegation_source_thread_id, m.delegation_source_agent_id,
                m.source_tool_call_id, m.source_input_id
         FROM interaction_deliveries d
         JOIN context_messages m ON m.seq = d.context_message_seq
         WHERE d.source_thread_id = ? AND d.source_agent_id = 'thread'
           AND d.source_tool_call_id = 'busy-call'`,
      )
      .get(mainId);
    expect(joined).toEqual({
      status: 'consumed',
      context_message_seq: observations[0]?.contextMessageSeq,
      run_id: busy.runId,
      seq: observations[0]?.contextMessageSeq,
      context_run_id: busy.runId,
      source: 'thread_response',
      delegation_source_thread_id: mainId,
      delegation_source_agent_id: 'thread',
      source_tool_call_id: 'busy-call',
      source_input_id: null,
    });
    const after = await fixture.clients.thread.getThread({ threadId: mainId });
    expect(after.snapshot?.inputs).toHaveLength(inputsBefore ?? 0);
    expect(
      after.snapshot?.inputs.filter((input) => input.source === MessageSource.THREAD_RESPONSE),
    ).toEqual([]);
    expect(deliveredMessages(after, 'busy-call')).toHaveLength(1);
    const rootContext = await readContext(fixture, mainId);
    expect(
      rootContext.filter(
        (message) => message.role === MessageRole.TOOL && message.toolCallId === 'busy-call',
      ),
    ).toHaveLength(1);
  } finally {
    provider.resolve('user:busy target');
    provider.resolve('user:busy root');
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('REQ-05 consumes delivery only with Context and does not repeat it after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-delegation-identity-recovery-'));
  const provider = new ControlledProvider();
  let fixture = await startFixture(directory, { provider });
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const taskId =
      (
        await fixture.clients.thread.createThread({
          clientActionId: 'create-recovery-target',
          title: '重启交付目标',
        })
      ).thread?.threadId ?? '';
    provider.respond(
      'user:recovery delegation',
      response('', [
        {
          id: 'recovery-call',
          name: 'thread_call',
          arguments: { thread_id: taskId, prompt: 'recovery target' },
        },
      ]),
    );
    provider.register('tool:recovery-call', response('source response before failed injection'));
    provider.respond('user:recovery target', response('persisted target response'));

    const source = await sendMessage(
      fixture,
      mainId,
      'recovery delegation',
      'send-recovery-delegation',
    );
    await waitRequest(provider, 'tool:recovery-call');
    await vi.waitFor(() => {
      expect(interaction(fixture, mainId, 'recovery-call')).toMatchObject({
        status: 'completed',
        response_message_seq: expect.any(Number),
      });
      expect(delivery(fixture, mainId, 'recovery-call')).toMatchObject({
        status: 'queued',
        run_id: source.runId,
        context_message_seq: null,
      });
    });
    expect(provider.requests.some((request) => request.key === 'delivery:recovery-call')).toBe(
      false,
    );
    const inputCount = (await fixture.clients.thread.getThread({ threadId: mainId })).snapshot
      ?.inputs.length;
    fixture.database.exec(`
      CREATE TRIGGER fail_identity_delivery BEFORE INSERT ON context_messages
      WHEN NEW.source = 'thread_response'
      BEGIN SELECT RAISE(FAIL, 'injected identity delivery storage failure'); END;
    `);
    provider.resolve('tool:recovery-call');
    await waitRun(fixture, mainId, source.runId, RunStatus.FAILED);
    expect(delivery(fixture, mainId, 'recovery-call')).toMatchObject({
      status: 'queued',
      run_id: source.runId,
      context_message_seq: null,
    });
    expect(delivery(fixture, mainId, 'recovery-call')?.content).toContain(
      'persisted target response',
    );
    expect(provider.requests.some((request) => request.key === 'delivery:recovery-call')).toBe(
      false,
    );
    expect(
      deliveredMessages(
        await fixture.clients.thread.getThread({ threadId: mainId }),
        'recovery-call',
      ),
    ).toEqual([]);
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE source_tool_call_id = 'recovery-call' AND source = 'thread_response'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM inputs WHERE source IN ('thread_response', 'subagent_response')",
        )
        .get(),
    ).toEqual({ count: 0 });
    fixture.database.exec('DROP TRIGGER fail_identity_delivery');
    await closeFixture(fixture);

    const restartedProvider = new ControlledProvider();
    restartedProvider.respond('delivery:recovery-call', response('recovered delivery handled'));
    fixture = await startFixture(directory, { provider: restartedProvider });
    await waitDelivery(fixture, mainId, 'recovery-call', 'consumed');
    const recovered = delivery(fixture, mainId, 'recovery-call');
    expect(recovered).toMatchObject({
      status: 'consumed',
      context_message_seq: expect.any(Number),
    });
    expect(recovered?.run_id).not.toBe(source.runId);
    if (!recovered?.run_id || recovered.context_message_seq === null) {
      throw new Error('Recovered delivery evidence is missing.');
    }
    await waitRun(fixture, mainId, recovered.run_id, RunStatus.COMPLETED);
    const recoveredJoin = fixture.database
      .prepare(
        `SELECT d.status, d.run_id, d.context_message_seq, m.seq, m.run_id AS context_run_id,
                m.source, m.delegation_source_thread_id, m.delegation_source_agent_id,
                m.source_tool_call_id, m.source_input_id, m.content
         FROM interaction_deliveries d
         JOIN context_messages m ON m.seq = d.context_message_seq
         WHERE d.source_thread_id = ? AND d.source_agent_id = 'thread'
           AND d.source_tool_call_id = 'recovery-call'`,
      )
      .get(mainId) as
      | {
          status: string;
          run_id: string;
          context_message_seq: number;
          seq: number;
          context_run_id: string;
          source: string;
          delegation_source_thread_id: string;
          delegation_source_agent_id: string;
          source_tool_call_id: string;
          source_input_id: string | null;
          content: string;
        }
      | undefined;
    expect(recoveredJoin).toMatchObject({
      status: 'consumed',
      run_id: recovered.run_id,
      context_message_seq: recovered.context_message_seq,
      seq: recovered.context_message_seq,
      context_run_id: recovered.run_id,
      source: 'thread_response',
      delegation_source_thread_id: mainId,
      delegation_source_agent_id: 'thread',
      source_tool_call_id: 'recovery-call',
      source_input_id: null,
    });
    expect(recoveredJoin?.content).toContain('persisted target response');
    expect(restartedProvider.requests.map((request) => request.key)).toEqual([
      'delivery:recovery-call',
    ]);
    expect(
      restartedProvider.requests.some((request) => request.key === 'user:recovery target'),
    ).toBe(false);
    const recoveredSnapshot = await fixture.clients.thread.getThread({ threadId: mainId });
    expect(deliveredMessages(recoveredSnapshot, 'recovery-call')).toHaveLength(1);
    expect(recoveredSnapshot.snapshot?.inputs).toHaveLength(inputCount ?? 0);
    expect(
      recoveredSnapshot.snapshot?.inputs.filter(
        (input) => input.source === MessageSource.THREAD_RESPONSE,
      ),
    ).toEqual([]);

    await closeFixture(fixture);
    const quietProvider = new ControlledProvider();
    fixture = await startFixture(directory, { provider: quietProvider });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(quietProvider.requests).toEqual([]);
    expect(delivery(fixture, mainId, 'recovery-call')).toMatchObject({
      status: 'consumed',
      run_id: recovered.run_id,
      context_message_seq: recovered.context_message_seq,
    });
    expect(
      deliveredMessages(
        await fixture.clients.thread.getThread({ threadId: mainId }),
        'recovery-call',
      ),
    ).toHaveLength(1);
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);
