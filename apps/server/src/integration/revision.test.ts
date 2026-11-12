import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Code } from '@connectrpc/connect';
import { InputMode, InputStatus, MessageRole, RunStatus } from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { ContextStore } from '../context/context-store.js';
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

async function createTask(
  fixture: RevisionFixture,
  actionId: string,
  title = 'Revision acceptance',
) {
  const created = await fixture.clients.thread.createThread({ clientActionId: actionId, title });
  if (!created.thread) throw new Error('The revision acceptance Thread was not created.');
  return created.thread.threadId;
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

async function collectEvents(
  fixture: RevisionFixture,
  threadId: string,
  afterSeq: bigint,
  count: number,
) {
  const stream = fixture.clients.events.watchThread({ threadId, afterSeq })[Symbol.asyncIterator]();
  const events = [];
  try {
    while (events.length < count) {
      const item = await stream.next();
      if (item.done) throw new Error('The event stream ended before the expected events arrived.');
      if (item.value.payload.case === 'event') events.push(item.value.payload.value);
    }
  } finally {
    await stream.return?.();
  }
  return events;
}

async function eventCountThrough(
  fixture: RevisionFixture,
  threadId: string,
  afterSeq: bigint,
  throughSeq: bigint,
) {
  let count = 0;
  const stream = fixture.clients.events.watchThread({ threadId, afterSeq })[Symbol.asyncIterator]();
  try {
    while (true) {
      const item = await stream.next();
      if (item.done) throw new Error('The event stream ended before the target cursor.');
      if (item.value.payload.case !== 'event') continue;
      count += 1;
      if (item.value.payload.value.seq === throughSeq) return count;
    }
  } finally {
    await stream.return?.();
  }
}

it('persists no draft and atomically creates, replays and rejects a conflicting first message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-revision-first-input-'));
  const provider = new ControlledProvider();
  provider.respond('user:first input', response('first answer'));
  const fixture = await startRevisionFixture(directory, { provider });
  try {
    for (const table of ['threads', 'inputs', 'runs', 'context_messages', 'thread_events']) {
      expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: table === 'threads' || table === 'thread_events' ? 1 : 0,
      });
    }

    const request = {
      clientActionId: 'create-first',
      title: 'First message',
      initialText: 'first input',
      initialMode: InputMode.FOLLOW_UP,
    };
    const created = await fixture.clients.thread.createThread(request);
    const threadId = created.thread?.threadId ?? '';
    expect(threadId).not.toBe('');
    expect(created.inputId).toBeDefined();
    expect(created.runId).toBeDefined();
    await waitRun(fixture, threadId, created.runId ?? '', RunStatus.COMPLETED);

    const replayed = await fixture.clients.thread.createThread(request);
    expect(replayed.thread?.threadId).toBe(threadId);
    expect(replayed.inputId).toBe(created.inputId);
    expect(replayed.runId).toBe(created.runId);
    await expect(
      fixture.clients.thread.createThread({ ...request, initialText: 'conflicting input' }),
    ).rejects.toMatchObject({ code: Code.AlreadyExists });
    expect(provider.requests).toHaveLength(1);

    const snapshot = await fixture.clients.thread.getThread({ threadId });
    expect(snapshot.snapshot?.messages.map((message) => message.content)).toEqual([
      'first input',
      'first answer',
    ]);
    expect(snapshot.snapshot?.inputs).toHaveLength(1);
    expect(snapshot.snapshot?.runs).toHaveLength(1);
    const persistedEvents = await collectEvents(
      fixture,
      threadId,
      0n,
      await eventCountThrough(fixture, threadId, 0n, snapshot.throughSeq),
    );
    expect(persistedEvents.slice(0, 3).map((event) => event.payload.case)).toEqual([
      'threadCreated',
      'runChanged',
      'inputAccepted',
    ]);
    expect(persistedEvents.filter((event) => event.payload.case === 'threadCreated')).toHaveLength(
      1,
    );
    expect(persistedEvents.filter((event) => event.payload.case === 'inputAccepted')).toHaveLength(
      1,
    );
    const firstUserCommit = persistedEvents.findIndex(
      (event) =>
        event.payload.case === 'messageCommitted' &&
        event.payload.value.message?.content === 'first input',
    );
    const assistantCommit = persistedEvents.findIndex(
      (event) =>
        event.payload.case === 'messageCommitted' &&
        event.payload.value.message?.content === 'first answer',
    );
    expect(firstUserCommit).toBeGreaterThan(1);
    expect(assistantCommit).toBeGreaterThan(firstUserCommit);
    expect(persistedEvents.at(-1)?.seq).toBe(snapshot.throughSeq);
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM client_actions').get()).toEqual({
      count: 1,
    });
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('rolls back the complete first-message creation when its transaction fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-revision-first-rollback-'));
  const provider = new ControlledProvider();
  const fixture = await startRevisionFixture(directory, { provider });
  try {
    fixture.database.exec('DROP TABLE inputs');
    await expect(
      fixture.clients.thread.createThread({
        clientActionId: 'create-rollback',
        title: 'Must roll back',
        initialText: 'first input',
        initialMode: InputMode.FOLLOW_UP,
      }),
    ).rejects.toMatchObject({ code: Code.Internal });
    for (const table of [
      'threads',
      'runs',
      'context_messages',
      'thread_events',
      'client_actions',
    ]) {
      expect(fixture.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: table === 'threads' || table === 'thread_events' ? 1 : 0,
      });
    }
    expect(provider.requests).toHaveLength(0);
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('continues a failed Run with only the latest revision and no repeated unknown-tool round trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-revision-continue-'));
  const provider = new ControlledProvider();
  provider.respond(
    'user:original question',
    response('', [{ id: 'unknown-call', name: 'not_a_tool', arguments: { effect: 'once' } }]),
  );
  provider.respond('tool:unknown-call', []);
  const fixture = await startRevisionFixture(directory, { provider });
  try {
    const threadId = await createTask(fixture, 'create-continue');
    const sent = await sendMessage(fixture, threadId, 'original question', 'send-continue');
    await waitRun(fixture, threadId, sent.runId, RunStatus.FAILED);
    await waitRequest(provider, 'tool:unknown-call');
    const failedRequest = fixture.database
      .prepare(
        `SELECT r.current_request_id, q.view_version, q.status
         FROM runs r JOIN model_request_records q ON q.request_id = r.current_request_id
         WHERE r.run_id = ?`,
      )
      .get(sent.runId) as
      | { current_request_id: string; view_version: number; status: string }
      | undefined;
    expect(failedRequest).toMatchObject({ view_version: 0, status: 'ready' });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM inputs WHERE thread_id = ?')
        .get(threadId),
    ).toEqual({ count: 1 });
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE thread_id = ? AND role = 'user'",
        )
        .get(threadId),
    ).toEqual({ count: 1 });

    const anchor = (await fixture.clients.thread.getThread({ threadId })).snapshot?.messages.find(
      (message) => message.role === MessageRole.USER,
    );
    if (!anchor) throw new Error('The failed Run user anchor is missing.');
    const anchorId = anchor.messageId;
    const context = new ContextStore(fixture.database);
    const firstRevision = context
      .revise({
        threadId,
        agentId: 'thread',
        seq: Number(anchor.seq),
        content: 'intermediate revision',
      })
      .revisions.at(-1)?.revisionId;
    const latestRevision = context
      .revise({
        threadId,
        agentId: 'thread',
        seq: Number(anchor.seq),
        content: 'latest revision',
      })
      .revisions.at(-1)?.revisionId;
    fixture.database
      .prepare(
        `UPDATE model_input_states SET view_version = view_version + 2
         WHERE thread_id = ? AND agent_id = 'thread'`,
      )
      .run(threadId);
    expect(latestRevision).not.toBe(firstRevision);

    provider.register(
      'tool:unknown-call',
      response('', [
        {
          id: 'recall-intermediate-revision',
          name: 'recall',
          arguments: { sql: "SELECT content FROM context WHERE content = 'intermediate revision'" },
        },
      ]),
    );
    provider.respond(
      'tool:recall-intermediate-revision',
      response('', [
        {
          id: 'recall-latest-revision',
          name: 'recall',
          arguments: { sql: "SELECT content FROM context WHERE content = 'latest revision'" },
        },
      ]),
    );
    provider.respond('tool:recall-latest-revision', response('continued answer'));
    provider.resolve('tool:unknown-call');
    const continued = await fixture.clients.runs.continueRun({
      clientActionId: 'continue-failed',
      threadId,
      runId: sent.runId,
    });
    expect(continued.runId).toBe(sent.runId);
    await waitRun(fixture, threadId, sent.runId, RunStatus.COMPLETED);

    const continuedRequests = provider.requests.filter(
      (request) => request.key === 'tool:unknown-call',
    );
    expect(continuedRequests).toHaveLength(2);
    const recovered = continuedRequests[1]?.request;
    expect(
      recovered?.messages.filter((message) => message.content === 'latest revision'),
    ).toHaveLength(1);
    expect(JSON.stringify(recovered)).not.toContain('original question');
    expect(JSON.stringify(recovered)).not.toContain('intermediate revision');
    expect(recovered?.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(recovered?.messages.filter((message) => message.role === 'tool')).toHaveLength(1);
    const unknownResult = recovered?.messages.find((message) => message.role === 'tool');
    expect(unknownResult?.content).toContain('Unknown tool');

    expect(
      provider.requests.filter((request) => request.key === 'user:original question'),
    ).toHaveLength(1);
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM inputs WHERE thread_id = ?')
        .get(threadId),
    ).toEqual({ count: 1 });
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE thread_id = ? AND role = 'user'",
        )
        .get(threadId),
    ).toEqual({ count: 1 });
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_tool_calls WHERE thread_id = ? AND call_id = 'unknown-call' AND result_seq IS NOT NULL",
        )
        .get(threadId),
    ).toEqual({ count: 1 });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM model_request_records WHERE thread_id = ?')
        .get(threadId),
    ).toEqual({ count: 4 });
    const rebuilt = fixture.database
      .prepare(
        `SELECT request_id, status, view_version, request_json FROM model_request_records
         WHERE request_id = ?`,
      )
      .get(failedRequest?.current_request_id ?? '') as
      | { request_id: string; status: string; view_version: number; request_json: string }
      | undefined;
    expect(rebuilt).toMatchObject({ status: 'completed', view_version: 2 });
    expect(rebuilt?.request_json).toContain('latest revision');
    expect(rebuilt?.request_json).not.toContain('original question');
    expect(rebuilt?.request_json).not.toContain('intermediate revision');

    const current = await fixture.clients.thread.getThread({ threadId });
    expect(current.snapshot?.messages.map((message) => message.content)).toEqual([
      'latest revision',
      '',
      expect.stringContaining('Unknown tool'),
      '',
      expect.any(String),
      '',
      expect.any(String),
      'continued answer',
    ]);
    const audit = await auditContext(fixture, threadId);
    const intermediateRecall = audit.find(
      (message) => message.toolCallId === 'recall-intermediate-revision',
    );
    expect(intermediateRecall, 'Intermediate revision recall result is missing.').toBeDefined();
    expect(JSON.parse(intermediateRecall?.content ?? '{}').rows).toEqual([]);
    const latestRecall = audit.find((message) => message.toolCallId === 'recall-latest-revision');
    expect(latestRecall, 'Latest revision recall result is missing.').toBeDefined();
    const latestResult = JSON.parse(latestRecall?.content ?? '{}') as { rows?: string[][] };
    expect(latestResult.rows).toEqual([['latest revision']]);
    const original = audit.find((message) => message.messageId === anchorId);
    expect(original).toMatchObject({
      content: 'original question',
      originalContent: 'original question',
    });
    expect(original?.revisions.map((revision) => revision.text)).toEqual([
      'intermediate revision',
      'latest revision',
    ]);
    expect(
      fixture.database
        .prepare('SELECT content FROM context_messages WHERE message_id = ?')
        .get(anchorId),
    ).toEqual({ content: 'original question' });
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 25_000);

it('applies queue edit, reorder and removal across steer and follow-up boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-revision-queue-'));
  const provider = new ControlledProvider();
  provider.register(
    'user:queue initial',
    response('', [
      {
        id: 'boundary',
        name: 'recall',
        arguments: { sql: "SELECT content FROM context WHERE content = 'no matching history'" },
      },
    ]),
  );
  provider.register('user:steer input', response('steer answer'));
  provider.respond('user:follow-up edited', response('follow-up answer'));
  const fixture = await startRevisionFixture(directory, { provider });
  try {
    const threadId = await createTask(fixture, 'create-queue');
    const sent = await sendMessage(fixture, threadId, 'queue initial', 'send-queue-initial');
    await waitRequest(provider, 'user:queue initial');
    const first = await fixture.clients.messages.sendMessage({
      clientActionId: 'queue-first',
      threadId,
      text: 'follow-up original',
      mode: InputMode.FOLLOW_UP,
    });
    const removed = await fixture.clients.messages.sendMessage({
      clientActionId: 'queue-removed',
      threadId,
      text: 'removed follow-up',
      mode: InputMode.FOLLOW_UP,
    });
    const steer = await fixture.clients.messages.sendMessage({
      clientActionId: 'queue-steer',
      threadId,
      text: 'steer input',
      mode: InputMode.STEER,
    });
    const edited = await fixture.clients.queue.editInput({
      clientActionId: 'queue-edit',
      threadId,
      inputId: first.inputId,
      text: 'follow-up edited',
      expectedVersion: 1n,
    });
    expect(edited.version).toBe(2n);
    await expect(
      fixture.clients.queue.editInput({
        clientActionId: 'queue-stale-edit',
        threadId,
        inputId: first.inputId,
        text: 'stale edit',
        expectedVersion: 1n,
      }),
    ).rejects.toMatchObject({ code: Code.Aborted });
    const reordered = await fixture.clients.queue.reorderInputs({
      clientActionId: 'queue-reorder',
      threadId,
      inputIds: [removed.inputId, first.inputId, steer.inputId],
      expectedVersion: 0n,
    });
    expect(reordered.inputs.map((input) => input.inputId)).toEqual([
      removed.inputId,
      first.inputId,
      steer.inputId,
    ]);
    await fixture.clients.queue.removeInput({
      clientActionId: 'queue-remove',
      threadId,
      inputId: removed.inputId,
      expectedVersion: 1n,
    });

    provider.resolve('user:queue initial');
    await waitRequest(provider, 'user:steer input');
    const steerRequest = provider.requests.find(
      (request) => request.key === 'user:steer input',
    )?.request;
    expect(steerRequest?.messages.some((message) => message.content === 'steer input')).toBe(true);
    expect(steerRequest?.messages.some((message) => message.content === 'follow-up edited')).toBe(
      false,
    );
    provider.resolve('user:steer input');
    await waitRequest(provider, 'user:follow-up edited');
    await waitRun(fixture, threadId, sent.runId, RunStatus.COMPLETED);

    expect(JSON.stringify(provider.requests)).not.toContain('removed follow-up');
    expect(JSON.stringify(provider.requests)).not.toContain('follow-up original');
    const snapshot = await fixture.clients.thread.getThread({ threadId });
    expect(
      snapshot.snapshot?.inputs.find((input) => input.inputId === removed.inputId)?.status,
    ).toBe(InputStatus.CANCELLED);
    for (const inputId of [first.inputId, steer.inputId]) {
      expect(snapshot.snapshot?.inputs.find((input) => input.inputId === inputId)?.status).toBe(
        InputStatus.CONSUMED,
      );
    }
    expect(snapshot.snapshot?.messages.map((message) => message.content)).toEqual([
      'queue initial',
      '',
      expect.any(String),
      'steer input',
      'steer answer',
      'follow-up edited',
      'follow-up answer',
    ]);
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 25_000);

it('reruns only the latest anchor after a hard cut and rejects older anchors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-revision-hard-cut-'));
  const provider = new ControlledProvider();
  provider.respond('user:anchor original', response('old answer'));
  provider.respond('recap:generate', response('stale recap marker'));
  provider.respond('prepared:recap', response('old branch answer'));
  provider.respond('user:unreplaced branch user', response('unreplaced old answer'));
  const fixture = await startRevisionFixture(directory, {
    provider,
    contextWindowTokens: 1000,
    outputReserveTokens: 0,
    countTokens: (request) => {
      const contents = request.messages.map((message) => message.content);
      return contents.includes('old answer') && contents.includes('old branch user') ? 900 : 10;
    },
  });
  try {
    const threadId = await createTask(fixture, 'create-hard-cut-rerun');
    const original = await sendMessage(
      fixture,
      threadId,
      'anchor original',
      'send-hard-cut-anchor',
    );
    await waitRun(fixture, threadId, original.runId, RunStatus.COMPLETED);
    const branch = await sendMessage(fixture, threadId, 'old branch user', 'send-old-branch');
    await waitRun(fixture, threadId, branch.runId, RunStatus.COMPLETED);
    expect(
      fixture.database
        .prepare(
          'SELECT read_through_seq, view_version FROM model_input_states WHERE thread_id = ?',
        )
        .get(threadId),
    ).toEqual({ read_through_seq: 3, view_version: 0 });
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM recaps WHERE thread_id = ? AND validity = 'valid'")
        .get(threadId),
    ).toEqual({ count: 3 });
    const unreplaced = await sendMessage(
      fixture,
      threadId,
      'unreplaced branch user',
      'send-unreplaced-branch',
    );
    await waitRun(fixture, threadId, unreplaced.runId, RunStatus.COMPLETED);
    expect(
      fixture.database
        .prepare('SELECT read_through_seq FROM model_input_states WHERE thread_id = ?')
        .get(threadId),
    ).toEqual({ read_through_seq: 3 });

    const beforeBranchRerun = await fixture.clients.thread.getThread({ threadId });
    const branchAnchor = beforeBranchRerun.snapshot?.messages.find(
      (message) => message.content === 'unreplaced branch user',
    );
    const originalAnchor = beforeBranchRerun.snapshot?.messages.find(
      (message) => message.content === 'anchor original',
    );
    if (!branchAnchor || !originalAnchor) throw new Error('Rerun anchors are missing.');
    expect(branchAnchor.seq).toBeGreaterThan(3n);
    provider.register('user:unreplaced branch user', response('new branch answer'));
    const branchRerun = await fixture.clients.runs.rerun({
      clientActionId: 'rerun-after-read-through',
      threadId,
      messageId: branchAnchor.messageId,
    });
    await waitRun(fixture, threadId, branchRerun.runId, RunStatus.COMPLETED);
    const branchRequests = provider.requests.filter(
      (request) => request.key === 'user:unreplaced branch user',
    );
    expect(branchRequests).toHaveLength(2);
    const branchRerunRequest = branchRequests[1]?.request;
    expect(JSON.stringify(branchRerunRequest)).toContain('stale recap marker');
    expect(branchRerunRequest?.messages.some((message) => message.content === 'old answer')).toBe(
      false,
    );
    expect(JSON.stringify(branchRerunRequest)).not.toContain('unreplaced old answer');
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM inputs WHERE thread_id = ?')
        .get(threadId),
    ).toEqual({ count: 3 });
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE thread_id = ? AND role = 'user'",
        )
        .get(threadId),
    ).toEqual({ count: 3 });

    const branchViewEvents = await collectEvents(
      fixture,
      threadId,
      beforeBranchRerun.throughSeq,
      await eventCountThrough(
        fixture,
        threadId,
        beforeBranchRerun.throughSeq,
        (await fixture.clients.thread.getThread({ threadId })).throughSeq,
      ),
    );
    expect(
      branchViewEvents.some(
        (event) =>
          event.payload.case === 'contextViewChanged' &&
          event.payload.value.anchorMessageSeq === branchAnchor.seq,
      ),
    ).toBe(true);
    const replayedEvents = await collectEvents(
      fixture,
      threadId,
      beforeBranchRerun.throughSeq,
      branchViewEvents.length,
    );
    expect(replayedEvents.map((event) => event.eventId)).toEqual(
      branchViewEvents.map((event) => event.eventId),
    );
    expect(new Set(replayedEvents.map((event) => event.eventId)).size).toBe(replayedEvents.length);

    const beforeRejected = await fixture.clients.thread.getThread({ threadId });
    const runCount = beforeRejected.snapshot?.runs.length;
    const requestCount = provider.requests.length;
    await expect(
      fixture.clients.messages.reviseMessage({
        clientActionId: 'revise-hard-cut-anchor',
        threadId,
        messageId: originalAnchor.messageId,
        text: 'anchor latest',
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect(
      fixture.clients.runs.rerun({
        clientActionId: 'rerun-before-read-through',
        threadId,
        messageId: originalAnchor.messageId,
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });

    expect(provider.requests).toHaveLength(requestCount);
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM context_message_revisions
           WHERE message_seq = ?`,
        )
        .get(Number(originalAnchor.seq)),
    ).toEqual({ count: 0 });
    const current = await fixture.clients.thread.getThread({ threadId });
    expect(current.snapshot?.runs).toHaveLength(runCount ?? 0);
    const currentUsers = current.snapshot?.messages.filter(
      (message) => message.role === MessageRole.USER,
    );
    expect(currentUsers?.map((message) => message.content)).toEqual([
      'anchor original',
      'old branch user',
      'unreplaced branch user',
    ]);
    expect(
      current.snapshot?.messages.some((message) => message.content === 'new branch answer'),
    ).toBe(true);
    expect(
      current.snapshot?.messages.some((message) => message.content === 'unreplaced old answer'),
    ).toBe(false);
    const finalAudit = await auditContext(fixture, threadId);
    expect(
      finalAudit.find((message) => message.messageId === originalAnchor.messageId),
    ).toMatchObject({
      content: 'anchor original',
      originalContent: 'anchor original',
      revisions: [],
    });
    expect(
      finalAudit
        .filter((message) => message.content === 'unreplaced old answer')
        .every((message) => message.supersededByRunId === branchRerun.runId),
    ).toBe(true);
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 35_000);

it('invalidates periodic Recaps on Rerun and revision before Agent recall', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-revision-periodic-recap-'));
  const provider = new ControlledProvider();
  provider.respond('user:periodic anchor', response('periodic old answer'));
  provider.respond('recap:generate', response('periodic stale marker'));
  const fixture = await startRevisionFixture(directory, {
    provider,
    periodicRecap: { triggerMessages: 1, idleAfterMs: 0, maxMessages: 20 },
  });
  try {
    const threadId = await createTask(fixture, 'create-periodic-recap');
    const original = await sendMessage(
      fixture,
      threadId,
      'periodic anchor',
      'send-periodic-anchor',
    );
    await waitRun(fixture, threadId, original.runId, RunStatus.COMPLETED);
    await vi.waitFor(() => {
      expect(
        fixture.database
          .prepare(
            "SELECT COUNT(*) AS count FROM recaps WHERE thread_id = ? AND validity = 'valid'",
          )
          .get(threadId),
      ).toEqual({ count: 1 });
    });
    const firstRecap = fixture.database
      .prepare("SELECT recap_id FROM recaps WHERE thread_id = ? AND validity = 'valid'")
      .get(threadId) as { recap_id: string } | undefined;
    if (!firstRecap) throw new Error('The first periodic Recap is missing.');
    const anchor = (await fixture.clients.thread.getThread({ threadId })).snapshot?.messages.find(
      (message) => message.role === MessageRole.USER,
    );
    if (!anchor) throw new Error('The periodic Rerun anchor is missing.');

    provider.register('user:periodic anchor', response('periodic new answer'));
    const firstRerun = await fixture.clients.runs.rerun({
      clientActionId: 'rerun-periodic-recap',
      threadId,
      messageId: anchor.messageId,
    });
    await waitRun(fixture, threadId, firstRerun.runId, RunStatus.COMPLETED);
    expect(
      fixture.database
        .prepare('SELECT validity, invalidation_reason FROM recaps WHERE recap_id = ?')
        .get(firstRecap.recap_id),
    ).toEqual({ validity: 'invalid', invalidation_reason: 'source_rerun' });
    await vi.waitFor(() => {
      expect(
        fixture.database
          .prepare(
            "SELECT recap_id FROM recaps WHERE thread_id = ? AND validity = 'valid' AND recap_id <> ?",
          )
          .get(threadId, firstRecap.recap_id),
      ).toBeDefined();
    });
    const secondRecap = fixture.database
      .prepare("SELECT recap_id FROM recaps WHERE thread_id = ? AND validity = 'valid'")
      .get(threadId) as { recap_id: string } | undefined;
    if (!secondRecap) throw new Error('The replacement periodic Recap is missing.');

    provider.respond(
      'user:periodic latest',
      response('', [
        {
          id: 'recall-periodic-stale',
          name: 'recall',
          arguments: { sql: "SELECT content FROM recap WHERE content = 'periodic stale marker'" },
        },
      ]),
    );
    provider.respond('tool:recall-periodic-stale', response('periodic current answer'));
    await fixture.clients.messages.reviseMessage({
      clientActionId: 'revise-periodic-recap',
      threadId,
      messageId: anchor.messageId,
      text: 'periodic latest',
    });
    const secondRerun = (
      await fixture.clients.thread.getThread({ threadId })
    ).snapshot?.runs.findLast((run) => run.rerunFromMessageSeq === anchor.seq);
    if (!secondRerun) throw new Error('Revision did not start the periodic Rerun.');
    await waitRun(fixture, threadId, secondRerun.runId, RunStatus.COMPLETED);
    expect(secondRerun.runId).not.toBe(firstRerun.runId);
    expect(
      fixture.database
        .prepare('SELECT validity, invalidation_reason FROM recaps WHERE recap_id = ?')
        .get(secondRecap.recap_id),
    ).toEqual({ validity: 'invalid', invalidation_reason: 'source_revised' });

    const audit = await auditContext(fixture, threadId);
    const recalled = audit.find((message) => message.toolCallId === 'recall-periodic-stale');
    expect(JSON.parse(recalled?.content ?? '{}').rows).toEqual([]);
    const currentRequest = provider.requests.find(
      (request) => request.key === 'user:periodic latest',
    )?.request;
    expect(
      currentRequest?.messages.filter((message) => message.content === 'periodic latest'),
    ).toHaveLength(1);
    expect(JSON.stringify(currentRequest)).not.toContain('periodic anchor');
    expect(JSON.stringify(currentRequest)).not.toContain('periodic old answer');
    expect(JSON.stringify(currentRequest)).not.toContain('periodic new answer');
    expect(JSON.stringify(currentRequest)).not.toContain('periodic stale marker');
    expect(
      fixture.database
        .prepare(
          `SELECT recap_id, validity, invalidation_reason FROM recaps
           WHERE recap_id IN (?, ?) ORDER BY recap_id`,
        )
        .all(firstRecap.recap_id, secondRecap.recap_id),
    ).toEqual(
      expect.arrayContaining([
        {
          recap_id: firstRecap.recap_id,
          validity: 'invalid',
          invalidation_reason: 'source_rerun',
        },
        {
          recap_id: secondRecap.recap_id,
          validity: 'invalid',
          invalidation_reason: 'source_revised',
        },
      ]),
    );
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
