import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelEvent, ToolCall } from '@kairos/agent-core';
import { MessageRole, MessageSource, RunStatus } from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import {
  ControlledProvider,
  closeFixture,
  type RevisionFixture,
  response,
  sendMessage,
  startRevisionFixture,
  waitRequest,
  waitRun,
} from './revision-fixture.js';

function usageResponse(
  content: string,
  inputTokens: number,
  outputTokens: number,
  toolCalls?: ToolCall[],
): ModelEvent[] {
  return [
    { type: 'text_delta', text: content },
    {
      type: 'response',
      message: {
        role: 'assistant',
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    },
  ];
}

async function createTask(fixture: RevisionFixture, actionId: string) {
  const created = await fixture.clients.thread.createThread({
    clientActionId: actionId,
    title: 'Response acceptance',
  });
  if (!created.thread) throw new Error('The response acceptance Thread was not created.');
  return created.thread.threadId;
}

async function createMain(fixture: RevisionFixture) {
  const main = await fixture.clients.thread.getOrCreateMain({});
  if (!main.thread) throw new Error('The main Thread was not created.');
  return main.thread.threadId;
}

async function auditContext(fixture: RevisionFixture, threadId: string) {
  return (
    await fixture.clients.context.readContext({
      threadId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 500,
    })
  ).messages;
}

function interactionRow(fixture: RevisionFixture, sourceToolCallId: string) {
  return fixture.database
    .prepare(
      `SELECT source_tool_call_id, status, response_message_seq, target_agent_id
       FROM interactions WHERE source_tool_call_id = ?`,
    )
    .get(sourceToolCallId) as
    | {
        source_tool_call_id: string;
        status: string;
        response_message_seq: number | null;
        target_agent_id: string;
      }
    | undefined;
}

function deliveryRow(fixture: RevisionFixture, interactionId: string) {
  return fixture.database
    .prepare(
      `SELECT source_tool_call_id, content, context_message_seq, run_id, status
       FROM interaction_deliveries WHERE source_tool_call_id = ?`,
    )
    .get(interactionId) as
    | {
        source_tool_call_id: string;
        content: string | null;
        context_message_seq: number | null;
        run_id: string | null;
        status: string;
      }
    | undefined;
}

async function waitInteraction(fixture: RevisionFixture, sourceToolCallId: string, status: string) {
  await vi.waitFor(() => {
    expect(interactionRow(fixture, sourceToolCallId)?.status).toBe(status);
  });
}

it('keeps per-response runId, status and token usage while aggregating Run usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-response-usage-'));
  const provider = new ControlledProvider();
  provider.respond(
    'user:usage question',
    usageResponse('', 10, 1, [
      {
        id: 'usage-recall',
        name: 'recall',
        arguments: { sql: 'SELECT content FROM context WHERE 0' },
      },
    ]),
  );
  provider.respond('tool:usage-recall', usageResponse('usage answer', 20, 2));
  const fixture = await startRevisionFixture(directory, { provider });
  try {
    const threadId = await createTask(fixture, 'create-usage');
    const sent = await sendMessage(fixture, threadId, 'usage question', 'send-usage');
    await waitRun(fixture, threadId, sent.runId, RunStatus.COMPLETED);
    const snapshot = await fixture.clients.thread.getThread({ threadId });
    const responses = snapshot.snapshot?.messages.filter(
      (message) => message.role === MessageRole.ASSISTANT,
    );
    expect(responses).toHaveLength(2);
    expect(responses?.map((message) => message.runId)).toEqual([sent.runId, sent.runId]);
    expect(responses?.map((message) => message.usage)).toMatchObject([
      { inputTokens: 10n, outputTokens: 1n },
      { inputTokens: 20n, outputTokens: 2n },
    ]);
    expect(snapshot.snapshot?.runs.find((run) => run.runId === sent.runId)).toMatchObject({
      status: RunStatus.COMPLETED,
      usage: { inputTokens: 30n, outputTokens: 3n },
    });
    const stored = fixture.database
      .prepare(
        `SELECT seq, run_id, response_usage_json FROM context_messages
         WHERE thread_id = ? AND role = 'assistant' ORDER BY seq`,
      )
      .all(threadId) as Array<{ seq: number; run_id: string; response_usage_json: string }>;
    expect(stored.map((message) => message.run_id)).toEqual([sent.runId, sent.runId]);
    expect(stored.map((message) => JSON.parse(message.response_usage_json))).toEqual([
      { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      { input_tokens: 20, output_tokens: 2, total_tokens: 22 },
    ]);
    const audit = await auditContext(fixture, threadId);
    expect(audit.filter((message) => message.role === MessageRole.TOOL)).toHaveLength(1);
    expect(snapshot.snapshot?.messages.map((message) => message.messageId)).toEqual(
      audit.map((message) => message.messageId),
    );
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('keeps a failed in-place Rerun anchored without inventing an assistant or user message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-response-failed-rerun-'));
  const provider = new ControlledProvider();
  provider.respond('user:rerun anchor', response('old answer'));
  const fixture = await startRevisionFixture(directory, { provider });
  try {
    const threadId = await createTask(fixture, 'create-failed-rerun');
    const original = await sendMessage(fixture, threadId, 'rerun anchor', 'send-rerun-anchor');
    await waitRun(fixture, threadId, original.runId, RunStatus.COMPLETED);
    const anchor = (await fixture.clients.thread.getThread({ threadId })).snapshot?.messages.find(
      (message) => message.role === MessageRole.USER,
    );
    if (!anchor) throw new Error('The Rerun anchor is missing.');
    provider.register('user:rerun anchor', []);
    const rerun = await fixture.clients.runs.rerun({
      clientActionId: 'rerun-fails',
      threadId,
      messageId: anchor.messageId,
    });
    await waitRun(fixture, threadId, rerun.runId, RunStatus.FAILED);

    const failed = await fixture.clients.thread.getThread({ threadId });
    expect(failed.snapshot?.runs.find((run) => run.runId === rerun.runId)).toMatchObject({
      status: RunStatus.FAILED,
      rerunFromMessageSeq: anchor.seq,
      inputIds: [],
    });
    expect(failed.snapshot?.messages.map((message) => message.content)).toEqual(['rerun anchor']);
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE run_id = ? AND role = 'assistant'",
        )
        .get(rerun.runId),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE thread_id = ? AND role = 'user'",
        )
        .get(threadId),
    ).toEqual({ count: 1 });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM inputs WHERE thread_id = ?')
        .get(threadId),
    ).toEqual({ count: 1 });

    provider.register('user:rerun anchor', response('new answer'));
    await fixture.clients.runs.continueRun({
      clientActionId: 'continue-rerun',
      threadId,
      runId: rerun.runId,
    });
    await waitRun(fixture, threadId, rerun.runId, RunStatus.COMPLETED);
    expect(provider.requests.filter((request) => request.key === 'user:rerun anchor')).toHaveLength(
      3,
    );
    const current = await fixture.clients.thread.getThread({ threadId });
    expect(current.snapshot?.messages.map((message) => message.content)).toEqual([
      'rerun anchor',
      'new answer',
    ]);
    const audit = await auditContext(fixture, threadId);
    expect(audit.map((message) => message.content)).toEqual([
      'rerun anchor',
      'old answer',
      'new answer',
    ]);
    expect(audit.find((message) => message.content === 'old answer')?.supersededByRunId).toBe(
      rerun.runId,
    );
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 25_000);

it('suppresses a background response whose source tool call left the current branch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-response-stale-source-'));
  const provider = new ControlledProvider();
  provider.respond(
    'user:stale source',
    response('', [
      {
        id: 'background-stale',
        name: 'subagent',
        arguments: { task: 'stale child task', mode: 'background' },
      },
    ]),
  );
  provider.respond('tool:background-stale', response('stale source accepted'));
  provider.register('user:stale child task', response('stale child answer'));
  const fixture = await startRevisionFixture(directory, { provider });
  try {
    const threadId = await createMain(fixture);
    const source = await sendMessage(fixture, threadId, 'stale source', 'send-stale-source');
    await waitRequest(provider, 'user:stale child task');
    await waitRun(fixture, threadId, source.runId, RunStatus.COMPLETED);
    const interaction = interactionRow(fixture, 'background-stale');
    if (!interaction) throw new Error('The stale background interaction is missing.');

    const anchor = (await fixture.clients.thread.getThread({ threadId })).snapshot?.messages.find(
      (message) => message.content === 'stale source',
    );
    if (!anchor) throw new Error('The stale source anchor is missing.');
    provider.register('user:stale source', response('new source answer'));
    const rerun = await fixture.clients.runs.rerun({
      clientActionId: 'rerun-stale-source',
      threadId,
      messageId: anchor.messageId,
    });
    await waitRun(fixture, threadId, rerun.runId, RunStatus.COMPLETED);
    provider.resolve('user:stale child task');
    await waitInteraction(fixture, 'background-stale', 'completed');
    await vi.waitFor(() => {
      expect(deliveryRow(fixture, interaction.source_tool_call_id)?.status).toBe('superseded');
    });

    expect(interactionRow(fixture, 'background-stale')?.response_message_seq).toEqual(
      expect.any(Number),
    );
    expect(deliveryRow(fixture, interaction.source_tool_call_id)).toMatchObject({
      status: 'superseded',
      context_message_seq: null,
    });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM inputs WHERE source_tool_call_id = ?')
        .get(interaction.source_tool_call_id),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .prepare(
          'SELECT COUNT(*) AS count FROM context_messages WHERE thread_id = ? AND source_tool_call_id = ?',
        )
        .get(threadId, interaction.source_tool_call_id),
    ).toEqual({ count: 0 });
    expect(
      provider.requests.some(
        (request) => request.key === `delivery:${interaction.source_tool_call_id}`,
      ),
    ).toBe(false);
    const current = await fixture.clients.thread.getThread({ threadId });
    const mainMessages = current.snapshot?.messages.filter(
      (message) => message.agentId === 'thread',
    );
    expect(mainMessages?.map((message) => message.content)).not.toContain('stale child answer');
    expect(mainMessages?.map((message) => message.content)).toEqual([
      'stale source',
      'new source answer',
    ]);
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 25_000);

it('delivers a current background source exactly once without an ordinary input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-response-current-source-'));
  const provider = new ControlledProvider();
  provider.respond(
    'user:current source',
    response('', [
      {
        id: 'background-current',
        name: 'subagent',
        arguments: { task: 'current child task', mode: 'background' },
      },
    ]),
  );
  provider.respond('tool:background-current', response('current source accepted'));
  provider.register('user:current child task', response('current child answer'));
  provider.respond('user:later anchor', response('old later answer'));
  let fixture = await startRevisionFixture(directory, { provider });
  try {
    const threadId = await createMain(fixture);
    const source = await sendMessage(fixture, threadId, 'current source', 'send-current-source');
    await waitRequest(provider, 'user:current child task');
    await waitRun(fixture, threadId, source.runId, RunStatus.COMPLETED);
    const interaction = interactionRow(fixture, 'background-current');
    if (!interaction) throw new Error('The current background interaction is missing.');
    const later = await sendMessage(fixture, threadId, 'later anchor', 'send-later-anchor');
    await waitRun(fixture, threadId, later.runId, RunStatus.COMPLETED);
    const laterAnchor = (
      await fixture.clients.thread.getThread({ threadId })
    ).snapshot?.messages.find((message) => message.content === 'later anchor');
    if (!laterAnchor) throw new Error('The later Rerun anchor is missing.');
    provider.register('user:later anchor', response('new later answer'));
    const rerun = await fixture.clients.runs.rerun({
      clientActionId: 'rerun-later-anchor',
      threadId,
      messageId: laterAnchor.messageId,
    });
    await waitRun(fixture, threadId, rerun.runId, RunStatus.COMPLETED);

    provider.register(`delivery:${interaction.source_tool_call_id}`, response('delivery handled'));
    provider.resolve('user:current child task');
    await waitRequest(provider, `delivery:${interaction.source_tool_call_id}`);
    const queuedDelivery = deliveryRow(fixture, interaction.source_tool_call_id);
    if (!queuedDelivery?.run_id) throw new Error('The current response delivery Run is missing.');
    expect(queuedDelivery.content).toContain('current child answer');
    expect(
      fixture.database
        .prepare("SELECT input_id FROM inputs WHERE source = 'subagent_response'")
        .all(),
    ).toEqual([]);

    const deliveryRequest = provider.requests.find(
      (request) => request.key === `delivery:${interaction.source_tool_call_id}`,
    )?.request;
    expect(
      deliveryRequest?.messages.some((message) => message.content === 'new later answer'),
    ).toBe(true);
    expect(JSON.stringify(deliveryRequest)).not.toContain('old later answer');
    expect(
      deliveryRequest?.messages.filter((message) =>
        message.content.includes('current child answer'),
      ),
    ).toHaveLength(1);
    provider.resolve(`delivery:${interaction.source_tool_call_id}`);
    await waitRun(fixture, threadId, queuedDelivery.run_id, RunStatus.COMPLETED);
    await vi.waitFor(() => {
      expect(deliveryRow(fixture, interaction.source_tool_call_id)?.status).toBe('consumed');
    });

    const deliveredRecord = fixture.database
      .prepare(
        `SELECT seq, source, source_tool_call_id, source_thread_id, source_agent_id
         FROM context_messages WHERE seq = ?`,
      )
      .get(queuedDelivery.context_message_seq) as
      | {
          seq: number;
          source: string;
          source_tool_call_id: string;
          source_thread_id: string;
          source_agent_id: string;
        }
      | undefined;
    expect(deliveredRecord).toMatchObject({
      source: 'subagent_response',
      source_tool_call_id: interaction.source_tool_call_id,
      source_thread_id: threadId,
      source_agent_id: interaction.target_agent_id,
    });
    const current = await fixture.clients.thread.getThread({ threadId });
    const deliveredMessages = current.snapshot?.messages.filter(
      (message) => message.delegation?.sourceToolCallId === interaction.source_tool_call_id,
    );
    expect(deliveredMessages).toHaveLength(1);
    expect(deliveredMessages?.[0]).toMatchObject({
      role: MessageRole.USER,
      source: MessageSource.SUBAGENT_RESPONSE,
      sourceThreadId: threadId,
      sourceAgentId: interaction.target_agent_id,
    });
    expect(deliveredMessages?.[0]?.sourceInputId).toBeUndefined();
    expect(
      current.snapshot?.inputs.filter((input) => input.source === MessageSource.SUBAGENT_RESPONSE),
    ).toEqual([]);
    const mainAudit = await auditContext(fixture, threadId);
    expect(
      mainAudit.filter(
        (message) => message.delegation?.sourceToolCallId === interaction.source_tool_call_id,
      ),
    ).toHaveLength(1);
    expect(
      mainAudit.filter(
        (message) =>
          message.role === MessageRole.TOOL && message.toolCallId === 'background-current',
      ),
    ).toHaveLength(1);
    expect(mainAudit.some((message) => message.content === 'current child answer')).toBe(false);

    await closeFixture(fixture);
    const reopenedProvider = new ControlledProvider();
    fixture = await startRevisionFixture(directory, { provider: reopenedProvider });
    const restored = await fixture.clients.thread.getThread({ threadId });
    expect(
      restored.snapshot?.messages.filter(
        (message) => message.delegation?.sourceToolCallId === interaction.source_tool_call_id,
      ),
    ).toHaveLength(1);
    expect(deliveryRow(fixture, interaction.source_tool_call_id)?.status).toBe('consumed');
    expect(reopenedProvider.requests).toHaveLength(0);
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
