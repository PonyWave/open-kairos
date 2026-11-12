import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RunStatus } from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { closeFixture, deferred, sendMessage, waitRun } from './delegation-fixture.js';
import {
  type ControlledSseServer,
  createPeriodicThread,
  expectCleanContext,
  expectCompletePrefix,
  ControlledSseServer as ModelServer,
  type PeriodicClock,
  type PeriodicFixture,
  recapMappings,
  startPeriodicFixture,
} from './recap-periodic-fixture.js';

const initialTime = Date.parse('2026-11-03T10:00:00.000Z');

async function makeDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kairos-periodic-recap-acceptance-'));
}

async function cleanUp(
  directory: string,
  modelServer: ControlledSseServer,
  fixture: PeriodicFixture | undefined,
): Promise<void> {
  if (fixture) await closeFixture(fixture);
  await modelServer.close();
  expect(modelServer.errors).toEqual([]);
  await rm(directory, { recursive: true, force: true });
}

async function waitRecapCount(fixture: PeriodicFixture, count: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({
        count,
      });
    },
    { timeout: 10_000 },
  );
}

async function waitOperationStatus(
  fixture: PeriodicFixture,
  status: 'running' | 'completed' | 'failed' | 'interrupted',
  count = 1,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        fixture.database
          .prepare('SELECT COUNT(*) AS count FROM recap_generation_operations WHERE status = ?')
          .get(status),
      ).toEqual({ count });
    },
    { timeout: 10_000 },
  );
}

function operationRows(fixture: PeriodicFixture) {
  return z
    .array(
      z.object({
        view_version: z.number().int().nonnegative(),
        source_message_seqs_json: z.string(),
        status: z.enum(['running', 'completed', 'failed', 'interrupted']),
        usage_json: z.string().nullable(),
      }),
    )
    .parse(
      fixture.database
        .prepare(
          `SELECT view_version, source_message_seqs_json, status, usage_json
           FROM recap_generation_operations ORDER BY created_at, rowid`,
        )
        .all(),
    );
}

function recapRows(fixture: PeriodicFixture) {
  return z
    .array(
      z.object({
        recap_id: z.string(),
        source_message_seqs: z.string(),
        content: z.string(),
        validity: z.enum(['valid', 'invalid']),
      }),
    )
    .parse(
      fixture.database
        .prepare(
          'SELECT recap_id, source_message_seqs, content, validity FROM recaps ORDER BY source_seq_start, rowid',
        )
        .all(),
    );
}

it('applies X at the exact message count, preserves request bytes and cache usage, then reuses incremental Recaps during hard cut', async () => {
  const directory = await makeDirectory();
  const modelServer = await ModelServer.listen();
  const clock: PeriodicClock = { now: initialTime };
  let forceHardCut = false;
  let fixture: PeriodicFixture | undefined;
  try {
    modelServer.enqueue({ kind: 'normal', content: 'first answer', cachedTokens: 11 });
    modelServer.enqueue({ kind: 'normal', content: 'second answer', cachedTokens: 12 });
    modelServer.enqueue({ kind: 'recap', content: 'periodic recap', cachedTokens: 13 });
    modelServer.enqueue({ kind: 'recap', content: 'hard cut fallback recap', cachedTokens: 14 });
    modelServer.enqueue({ kind: 'normal', content: 'after hard cut', cachedTokens: 15 });
    fixture = await startPeriodicFixture(directory, modelServer, {
      clock,
      messageThreshold: 4,
      responseWindowMs: 1000,
      countTokens: (request) => {
        if (!forceHardCut) return 100;
        return request.messages.some((message) => message.content === 'first') ? 801 : 800;
      },
    });
    const threadId = await createPeriodicThread(fixture, 'periodic-x-thread');
    const first = await sendMessage(fixture, threadId, 'first', 'periodic-x-first');
    await waitRun(fixture, threadId, first.runId, RunStatus.COMPLETED);
    expect(recapRows(fixture)).toEqual([]);
    expect(modelServer.byKind('recap')).toHaveLength(0);

    const second = await sendMessage(fixture, threadId, 'second', 'periodic-x-second');
    await waitRun(fixture, threadId, second.runId, RunStatus.COMPLETED);
    await waitRecapCount(fixture, 1);
    const normal = modelServer.byKind('normal')[1];
    const periodic = modelServer.byKind('recap')[0];
    if (!normal || !periodic) throw new Error('Expected normal and periodic Recap requests.');
    expectCompletePrefix(normal, periodic, 2);
    expect(periodic.body.messages.at(-2)).toMatchObject({
      role: 'assistant',
      content: 'second answer',
    });
    expect(recapMappings(periodic)).toEqual([
      { seq: 1, message_index: 4 },
      { seq: 2, message_index: 5 },
      { seq: 3, message_index: 6 },
      { seq: 4, message_index: 7 },
    ]);
    expect(recapRows(fixture)).toEqual([
      {
        recap_id: expect.any(String),
        source_message_seqs: '[1,2,3,4]',
        content: 'periodic recap',
        validity: 'valid',
      },
    ]);
    expect(
      fixture.database
        .prepare('SELECT position, message_seq FROM recap_sources ORDER BY position')
        .all(),
    ).toEqual([
      { position: 1, message_seq: 1 },
      { position: 2, message_seq: 2 },
      { position: 3, message_seq: 3 },
      { position: 4, message_seq: 4 },
    ]);
    expect(operationRows(fixture)).toEqual([
      {
        view_version: 0,
        source_message_seqs_json: '[1,2,3,4]',
        status: 'completed',
        usage_json: JSON.stringify({
          input_tokens: 103,
          output_tokens: 14,
          total_tokens: 117,
          prompt_tokens_details: { cached_tokens: 13 },
        }),
      },
    ]);
    expectCleanContext(fixture, 'periodic recap');

    forceHardCut = true;
    const third = await sendMessage(fixture, threadId, 'third', 'periodic-x-hard-cut');
    await waitRun(fixture, threadId, third.runId, RunStatus.COMPLETED);
    await waitRecapCount(fixture, 2);
    const fallback = modelServer.byKind('recap')[1];
    if (!fallback) throw new Error('Expected a hard-cut fallback Recap request.');
    expectCompletePrefix(normal, fallback, 3);
    expect(fallback.body.messages.at(-3)).toMatchObject({
      role: 'assistant',
      content: 'second answer',
    });
    expect(fallback.body.messages.at(-2)).toEqual({ role: 'user', content: 'third' });
    expect(recapMappings(fallback)).toEqual([{ seq: 5, message_index: 8 }]);
    expect(recapRows(fixture).map((recap) => recap.source_message_seqs)).toEqual([
      '[1,2,3,4]',
      '[5]',
    ]);
    const hardCut = z
      .object({
        estimated_input_tokens: z.number(),
        context_window_tokens: z.number(),
        output_reserve_tokens: z.number(),
        read_through_seq: z.number(),
        selected_recap_ids_json: z.string(),
        request_json: z.string(),
      })
      .parse(
        fixture.database
          .prepare(
            `SELECT estimated_input_tokens, context_window_tokens, output_reserve_tokens,
                    read_through_seq, selected_recap_ids_json, request_json
             FROM model_request_records WHERE thread_id = ? AND hard_cut = 1`,
          )
          .get(threadId),
      );
    expect(hardCut).toMatchObject({
      estimated_input_tokens: 800,
      context_window_tokens: 1000,
      output_reserve_tokens: 100,
      read_through_seq: 5,
    });
    expect(hardCut.estimated_input_tokens * 5).toBe(hardCut.context_window_tokens * 4);
    expect(hardCut.estimated_input_tokens + hardCut.output_reserve_tokens).toBeLessThanOrEqual(
      hardCut.context_window_tokens,
    );
    expect(JSON.parse(hardCut.selected_recap_ids_json)).toHaveLength(2);
    const finalRequest = JSON.parse(hardCut.request_json) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(
      finalRequest.messages.filter((message) => message.content.includes('recap_id:')),
    ).toHaveLength(1);
    expect(JSON.stringify(finalRequest)).toContain('periodic recap');
    expect(JSON.stringify(finalRequest)).toContain('hard cut fallback recap');
    expect(JSON.stringify(finalRequest)).not.toContain('Kairos internal Recap operation;');
    expect(modelServer.byKind('normal')).toHaveLength(3);
    expect(modelServer.byKind('recap')).toHaveLength(2);
    expectCleanContext(fixture, 'hard cut fallback recap');
  } finally {
    await cleanUp(directory, modelServer, fixture);
  }
}, 30_000);

it('waits for a long Run tool boundary, single-flights requests and deduplicates after restart', async () => {
  const directory = await makeDirectory();
  const modelServer = await ModelServer.listen();
  const clock: PeriodicClock = { now: initialTime };
  const gate = deferred();
  let fixture: PeriodicFixture | undefined;
  try {
    modelServer.enqueue({ kind: 'normal', content: 'first answer' });
    modelServer.enqueue({
      kind: 'normal',
      content: '',
      toolCalls: [
        {
          id: 'periodic-tool-call',
          name: 'bash',
          arguments: { command: 'sleep 0.3; printf periodic-tool-result' },
        },
      ],
    });
    modelServer.enqueue({ kind: 'normal', content: 'final answer' });
    modelServer.enqueue({
      kind: 'recap',
      content: 'tool group recap',
      cachedTokens: 23,
      gate: gate.promise,
    });
    fixture = await startPeriodicFixture(directory, modelServer, {
      clock,
      messageThreshold: 3,
      responseWindowMs: 1000,
    });
    const threadId = await createPeriodicThread(fixture, 'periodic-tool-thread');
    const first = await sendMessage(fixture, threadId, 'first', 'periodic-tool-first');
    await waitRun(fixture, threadId, first.runId, RunStatus.COMPLETED);
    fixture.environmentOperations.bashDelayMs = 300;
    fixture.environmentOperations.bashOutput = 'periodic-tool-result';
    const second = await sendMessage(fixture, threadId, 'use a tool', 'periodic-tool-second');
    await waitRun(fixture, threadId, second.runId, RunStatus.WAITING);
    expect(modelServer.byKind('recap')).toHaveLength(0);
    expect(recapRows(fixture)).toEqual([]);

    await vi.waitFor(() => expect(modelServer.byKind('recap')).toHaveLength(1));
    await waitRun(fixture, threadId, second.runId, RunStatus.COMPLETED);
    expect(modelServer.byKind('recap')).toHaveLength(1);
    expect(recapRows(fixture)).toEqual([]);
    gate.resolve();
    await waitRecapCount(fixture, 1);
    const normal = modelServer.byKind('normal')[1];
    const recap = modelServer.byKind('recap')[0];
    if (!normal || !recap) throw new Error('Expected tool and Recap requests.');
    expectCompletePrefix(normal, recap, 3);
    expect(recap.body.messages.at(-3)).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'periodic-tool-call',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: 'sleep 0.3; printf periodic-tool-result' }),
          },
        },
      ],
    });
    expect(recap.body.messages.at(-2)).toMatchObject({
      role: 'tool',
      tool_call_id: 'periodic-tool-call',
      content: expect.stringContaining('periodic-tool-result'),
    });
    expect(JSON.stringify(recap.body)).not.toContain('final answer');
    expect(recapMappings(recap)).toEqual([
      { seq: 1, message_index: 4 },
      { seq: 2, message_index: 5 },
      { seq: 3, message_index: 6 },
      { seq: 4, message_index: 7 },
      { seq: 5, message_index: 8 },
    ]);
    expect(recapRows(fixture)[0]?.source_message_seqs).toBe('[1,2,3,4,5]');
    expect(operationRows(fixture)[0]?.usage_json).toContain('"cached_tokens":23');
    expectCleanContext(fixture, 'tool group recap');

    await closeFixture(fixture);
    fixture = await startPeriodicFixture(directory, modelServer, {
      clock,
      messageThreshold: 3,
      responseWindowMs: 1000,
    });
    expect(recapRows(fixture)).toHaveLength(1);
    await closeFixture(fixture);
    expect(modelServer.byKind('recap')).toHaveLength(1);
  } finally {
    await cleanUp(directory, modelServer, fixture);
  }
}, 30_000);

it('keeps normal Runs and Context usable after a periodic Recap failure', async () => {
  const directory = await makeDirectory();
  const modelServer = await ModelServer.listen();
  const clock: PeriodicClock = { now: initialTime };
  let fixture: PeriodicFixture | undefined;
  try {
    modelServer.enqueue({ kind: 'normal', content: 'normal answer' });
    modelServer.enqueue({ kind: 'recap', content: '', httpStatus: 500 });
    modelServer.enqueue({ kind: 'normal', content: 'normal after failure' });
    modelServer.enqueue({ kind: 'recap', content: 'recovered recap' });
    fixture = await startPeriodicFixture(directory, modelServer, {
      clock,
      messageThreshold: 2,
      responseWindowMs: 1000,
    });
    const threadId = await createPeriodicThread(fixture, 'periodic-failure-thread');
    const first = await sendMessage(fixture, threadId, 'first', 'periodic-failure-first');
    await waitRun(fixture, threadId, first.runId, RunStatus.COMPLETED);
    await waitOperationStatus(fixture, 'failed');
    expect(recapRows(fixture)).toEqual([]);
    expectCleanContext(fixture, '');

    const second = await sendMessage(fixture, threadId, 'second', 'periodic-failure-second');
    await waitRun(fixture, threadId, second.runId, RunStatus.COMPLETED);
    await waitRecapCount(fixture, 1);
    expect(operationRows(fixture).map((operation) => operation.status)).toEqual([
      'failed',
      'completed',
    ]);
    expect(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM context_messages').get(),
    ).toEqual({ count: 4 });
    expectCleanContext(fixture, 'recovered recap');
  } finally {
    await cleanUp(directory, modelServer, fixture);
  }
}, 30_000);

it('rejects a delayed Recap after an edit automatically reruns the latest message', async () => {
  const directory = await makeDirectory();
  const modelServer = await ModelServer.listen();
  const clock: PeriodicClock = { now: initialTime };
  const gate = deferred();
  let fixture: PeriodicFixture | undefined;
  try {
    modelServer.enqueue({ kind: 'normal', content: 'answer before edit' });
    modelServer.enqueue({ kind: 'normal', content: 'answer after edit' });
    modelServer.enqueue({ kind: 'recap', content: 'stale edited recap', gate: gate.promise });
    modelServer.enqueue({ kind: 'recap', content: 'current edited recap' });
    fixture = await startPeriodicFixture(directory, modelServer, {
      clock,
      messageThreshold: 2,
      responseWindowMs: 1000,
    });
    const threadId = await createPeriodicThread(fixture, 'periodic-edit-thread');
    const run = await sendMessage(fixture, threadId, 'edit me', 'periodic-edit-input');
    await waitRun(fixture, threadId, run.runId, RunStatus.COMPLETED);
    await vi.waitFor(() => expect(modelServer.byKind('recap')).toHaveLength(1));
    const snapshot = await fixture.clients.thread.getThread({ threadId });
    const anchor = snapshot.snapshot?.messages[0];
    if (!anchor) throw new Error('The source user message is missing.');
    await fixture.clients.messages.reviseMessage({
      clientActionId: 'periodic-edit-revision',
      threadId,
      messageId: anchor.messageId,
      text: 'edited source',
    });
    const rerun = (await fixture.clients.thread.getThread({ threadId })).snapshot?.runs.findLast(
      (candidate) => candidate.rerunFromMessageSeq === anchor.seq,
    );
    if (!rerun) throw new Error('Revision did not start a Rerun.');
    await waitRun(fixture, threadId, rerun.runId, RunStatus.COMPLETED);
    gate.resolve();
    await waitOperationStatus(fixture, 'failed');
    await waitRecapCount(fixture, 1);
    expect(recapRows(fixture)).toEqual([
      {
        recap_id: expect.any(String),
        source_message_seqs: '[1,3]',
        content: 'current edited recap',
        validity: 'valid',
      },
    ]);
    expect(
      fixture.database
        .prepare('SELECT view_version FROM model_input_states WHERE thread_id = ?')
        .get(threadId),
    ).toEqual({ view_version: 1 });
    const current = await fixture.clients.thread.getThread({ threadId });
    expect(current.snapshot?.messages.map((message) => message.content)).toEqual([
      'edited source',
      'answer after edit',
    ]);
    expectCleanContext(fixture, 'stale edited recap');
  } finally {
    await cleanUp(directory, modelServer, fixture);
  }
}, 30_000);

it('rejects a stale Rerun Recap and generates only from the new current view', async () => {
  const directory = await makeDirectory();
  const modelServer = await ModelServer.listen();
  const clock: PeriodicClock = { now: initialTime };
  const gate = deferred();
  let fixture: PeriodicFixture | undefined;
  try {
    modelServer.enqueue({ kind: 'normal', content: 'original answer' });
    modelServer.enqueue({ kind: 'normal', content: 'rerun answer' });
    modelServer.enqueue({ kind: 'recap', content: 'stale rerun recap', gate: gate.promise });
    modelServer.enqueue({ kind: 'recap', content: 'current rerun recap' });
    fixture = await startPeriodicFixture(directory, modelServer, {
      clock,
      messageThreshold: 2,
      responseWindowMs: 1000,
    });
    const threadId = await createPeriodicThread(fixture, 'periodic-rerun-thread');
    const original = await sendMessage(fixture, threadId, 'rerun me', 'periodic-rerun-input');
    await waitRun(fixture, threadId, original.runId, RunStatus.COMPLETED);
    await vi.waitFor(() => expect(modelServer.byKind('recap')).toHaveLength(1));
    const snapshot = await fixture.clients.thread.getThread({ threadId });
    const messageId = snapshot.snapshot?.messages[0]?.messageId;
    if (!messageId) throw new Error('The Rerun source message is missing.');
    const rerun = await fixture.clients.runs.rerun({
      clientActionId: 'periodic-rerun-action',
      threadId,
      messageId,
    });
    await waitRun(fixture, threadId, rerun.runId, RunStatus.COMPLETED);
    gate.resolve();
    await waitRecapCount(fixture, 1);
    await waitOperationStatus(fixture, 'failed');
    await waitOperationStatus(fixture, 'completed');
    const recaps = recapRows(fixture);
    expect(recaps).toHaveLength(1);
    expect(recaps[0]).toMatchObject({
      source_message_seqs: '[1,3]',
      content: 'current rerun recap',
      validity: 'valid',
    });
    const normal = modelServer.byKind('normal')[1];
    const currentRecap = modelServer.byKind('recap')[1];
    if (!normal || !currentRecap) throw new Error('Expected Rerun and current Recap requests.');
    expectCompletePrefix(normal, currentRecap, 2);
    expect(recapMappings(currentRecap)).toEqual([
      { seq: 1, message_index: 4 },
      { seq: 3, message_index: 5 },
    ]);
    expect(JSON.stringify(currentRecap.body)).not.toContain('original answer');
    expect(
      fixture.database
        .prepare('SELECT view_version FROM model_input_states WHERE thread_id = ?')
        .get(threadId),
    ).toEqual({ view_version: 1 });
    expectCleanContext(fixture, 'stale rerun recap');
    expectCleanContext(fixture, 'current rerun recap');
  } finally {
    await cleanUp(directory, modelServer, fixture);
  }
}, 30_000);

it('aborts and waits on close, then recovers the interrupted operation at the inclusive Y boundary', async () => {
  const directory = await makeDirectory();
  const modelServer = await ModelServer.listen();
  const clock: PeriodicClock = { now: initialTime };
  const gate = deferred();
  let fixture: PeriodicFixture | undefined;
  try {
    modelServer.enqueue({ kind: 'normal', content: 'answer before close' });
    modelServer.enqueue({ kind: 'recap', content: 'must not commit', gate: gate.promise });
    fixture = await startPeriodicFixture(directory, modelServer, {
      clock,
      messageThreshold: 2,
      responseWindowMs: 1000,
    });
    const threadId = await createPeriodicThread(fixture, 'periodic-close-thread');
    const run = await sendMessage(fixture, threadId, 'close me', 'periodic-close-input');
    await waitRun(fixture, threadId, run.runId, RunStatus.COMPLETED);
    await vi.waitFor(() => expect(modelServer.byKind('recap')).toHaveLength(1));
    await closeFixture(fixture);
    const check = new DatabaseSync(join(directory, 'server.sqlite'), { readOnly: true });
    try {
      expect(check.prepare('SELECT status FROM recap_generation_operations').get()).toEqual({
        status: 'interrupted',
      });
      expect(check.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 0 });
    } finally {
      check.close();
    }

    clock.now += 1000;
    modelServer.enqueue({ kind: 'recap', content: 'recovered after restart' });
    fixture = await startPeriodicFixture(directory, modelServer, {
      clock,
      messageThreshold: 2,
      responseWindowMs: 1000,
    });
    await waitRecapCount(fixture, 1);
    expect(operationRows(fixture)).toEqual([
      {
        view_version: 0,
        source_message_seqs_json: '[1,2]',
        status: 'completed',
        usage_json: expect.any(String),
      },
    ]);
    expect(modelServer.byKind('recap')).toHaveLength(2);
    expectCleanContext(fixture, 'recovered after restart');
  } finally {
    gate.resolve();
    await cleanUp(directory, modelServer, fixture);
  }
}, 30_000);

it('does not resume periodic generation after the Y window expires', async () => {
  const directory = await makeDirectory();
  const modelServer = await ModelServer.listen();
  const clock: PeriodicClock = { now: initialTime };
  let fixture: PeriodicFixture | undefined;
  try {
    modelServer.enqueue({ kind: 'normal', content: 'old answer' });
    fixture = await startPeriodicFixture(directory, modelServer, {
      clock,
      messageThreshold: 20,
      responseWindowMs: 1000,
    });
    const threadId = await createPeriodicThread(fixture, 'periodic-y-thread');
    const run = await sendMessage(fixture, threadId, 'old response', 'periodic-y-input');
    await waitRun(fixture, threadId, run.runId, RunStatus.COMPLETED);
    await closeFixture(fixture);

    clock.now += 1001;
    fixture = await startPeriodicFixture(directory, modelServer, {
      clock,
      messageThreshold: 2,
      responseWindowMs: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(modelServer.byKind('recap')).toHaveLength(0);
    expect(recapRows(fixture)).toEqual([]);
    expect(operationRows(fixture)).toEqual([]);
  } finally {
    await cleanUp(directory, modelServer, fixture);
  }
}, 30_000);
