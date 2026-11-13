import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Code } from '@connectrpc/connect';
import { CompactContextStatus, RecapValidity, RunStatus } from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { stripMessageMeta } from '../context/model-input.js';
import {
  ControlledSlashProvider,
  closeSlashFixture,
  createSlashThread,
  deferred,
  expectSlashError,
  readSlashEvents,
  type SlashFixture,
  sendSlashMessage,
  slashErrorTerminal,
  startSlashFixture,
  tableCounts,
  waitSlashRequests,
  waitSlashRun,
} from './compact-fixture.js';

async function makeDirectory(): Promise<{ directory: string; workspace: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-compact-network-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'AGENTS.md'), 'Controlled compact workspace.');
  return { directory, workspace };
}

async function cleanUp(directory: string, fixture: SlashFixture | undefined): Promise<void> {
  if (fixture) await closeSlashFixture(fixture);
  await rm(directory, { recursive: true, force: true });
}

function requestRecord(fixture: SlashFixture, requestId: string) {
  return z
    .object({
      request_id: z.string(),
      status: z.string(),
      estimated_input_tokens: z.number().nullable(),
      context_window_tokens: z.number(),
      output_reserve_tokens: z.number(),
      read_through_seq: z.number(),
      selected_recap_ids_json: z.string(),
      request_json: z.string().nullable(),
      hard_cut: z.number().nullable(),
    })
    .parse(
      fixture.database
        .prepare(
          `SELECT request_id, status, estimated_input_tokens, context_window_tokens,
                  output_reserve_tokens, read_through_seq, selected_recap_ids_json,
                  request_json, hard_cut
           FROM model_request_records WHERE request_id = ?`,
        )
        .get(requestId),
    );
}

it('manually compacts below 80%, reuses and merges Recaps, and preserves audit and GUI history', async () => {
  const { directory, workspace } = await makeDirectory();
  const provider = new ControlledSlashProvider();
  provider.enqueue({ kind: 'normal', content: 'first answer' });
  provider.enqueue({ kind: 'recap', content: 'first user recap' });
  provider.enqueue({ kind: 'recap', content: 'first answer recap' });
  provider.enqueue({ kind: 'normal', content: 'second answer' });
  provider.enqueue({ kind: 'recap', content: 'second user recap' });
  provider.enqueue({ kind: 'recap', content: 'second answer recap' });
  provider.enqueue({ kind: 'normal', content: 'after merged compact' });
  const fixture = await startSlashFixture(directory, { provider, workspaceDirectory: workspace });
  try {
    const threadId = await createSlashThread(fixture, 'network-compact-create');
    const first = await sendSlashMessage(fixture, threadId, 'first original', 'network-first');
    await waitSlashRun(fixture, threadId, first.runId, RunStatus.COMPLETED);
    const countsBeforeCompact = tableCounts(fixture, threadId);

    const changed = await fixture.clients.context.compactContext({
      threadId,
      clientActionId: 'network-compact-low-usage',
    });
    expect(changed.status).toBe(CompactContextStatus.CHANGED);
    expect(changed.readThroughSeq).toBe(2n);
    expect(changed.recapIds).toHaveLength(2);
    expect(provider.byKind('recap')).toHaveLength(2);
    expect(tableCounts(fixture, threadId)).toEqual({
      ...countsBeforeCompact,
      recaps: countsBeforeCompact.recaps + 2,
      events: countsBeforeCompact.events + 4,
    });
    const prepared = requestRecord(fixture, changed.operationId);
    expect(prepared).toMatchObject({
      request_id: changed.operationId,
      status: 'ready',
      estimated_input_tokens: 100,
      context_window_tokens: 1000,
      output_reserve_tokens: 100,
      read_through_seq: 2,
      hard_cut: 1,
    });
    expect((prepared.estimated_input_tokens ?? 1000) * 5).toBeLessThan(
      prepared.context_window_tokens * 4,
    );
    expect(JSON.parse(prepared.selected_recap_ids_json)).toEqual(changed.recapIds);
    expect(prepared.request_json).toContain('first user recap');
    expect(prepared.request_json).toContain('first answer recap');

    const events = await readSlashEvents(fixture, threadId);
    expect(events.slice(-4).map((event) => event.payload.case)).toEqual([
      'hardCutStarted',
      'recapCreated',
      'recapCreated',
      'hardCutCompleted',
    ]);
    expect(events.filter((event) => event.payload.case === 'hardCutStarted')).toHaveLength(1);
    expect(events.filter((event) => event.payload.case === 'recapCreated')).toHaveLength(2);
    expect(events.filter((event) => event.payload.case === 'hardCutCompleted')).toHaveLength(1);
    expect(events.slice(-3, -1).map((event) => event.payload)).toMatchObject([
      { case: 'recapCreated', value: { recap: { content: 'first user recap' } } },
      { case: 'recapCreated', value: { recap: { content: 'first answer recap' } } },
    ]);
    expect(events.at(-4)?.payload).toMatchObject({
      case: 'hardCutStarted',
      value: { runId: '', operationId: changed.operationId },
    });
    expect(events.at(-1)?.payload).toMatchObject({
      case: 'hardCutCompleted',
      value: {
        runId: '',
        operationId: changed.operationId,
        replacedSourceSeqs: [1n, 2n],
        recapIds: changed.recapIds,
        injectedMessageCount: 1,
      },
    });
    const audit = await fixture.clients.context.readContext({
      threadId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 100,
    });
    expect(audit.messages.map((message) => message.content)).toEqual([
      'first original',
      'first answer',
    ]);
    expect(
      audit.messages.some((message) =>
        message.content.includes('Kairos internal Recap operation;'),
      ),
    ).toBe(false);
    const gui = await fixture.clients.thread.getThread({ threadId });
    expect(gui.snapshot?.messages.map((message) => message.content)).toEqual([
      'first original',
      'first answer',
    ]);
    expect(gui.snapshot?.recaps.map((recap) => recap.content)).toEqual([
      'first user recap',
      'first answer recap',
    ]);

    const second = await sendSlashMessage(fixture, threadId, 'second original', 'network-second');
    await waitSlashRun(fixture, threadId, second.runId, RunStatus.COMPLETED);
    const secondRecap = provider
      .byKind('normal')[1]
      ?.request.messages.find((message) => message.content.includes('recap_id:'));
    expect(secondRecap?.role).toBe('user');
    expect(secondRecap?.content).toContain('first user recap');
    expect(secondRecap?.content).toContain('first answer recap');
    const merged = await fixture.clients.context.compactContext({
      threadId,
      clientActionId: 'network-compact-merge',
    });
    expect(merged.status).toBe(CompactContextStatus.CHANGED);
    expect(merged.readThroughSeq).toBe(4n);
    expect(merged.recapIds).toHaveLength(4);
    expect(merged.recapIds.slice(0, 2)).toEqual(changed.recapIds);
    expect(provider.byKind('recap')).toHaveLength(4);
    const recaps = await fixture.clients.context.readRecaps({
      threadId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 100,
    });
    expect(recaps.recaps.map((recap) => recap.sourceMessageSeqs)).toEqual([[1n], [2n], [3n], [4n]]);
    expect(recaps.recaps.every((recap) => recap.validity === RecapValidity.VALID)).toBe(true);
    expect(
      fixture.database
        .prepare(
          'SELECT merge_position, recap_id FROM model_input_recaps WHERE thread_id = ? ORDER BY merge_position',
        )
        .all(threadId),
    ).toEqual(
      merged.recapIds.map((recapId, index) => ({ merge_position: index + 1, recap_id: recapId })),
    );

    const eventCount = tableCounts(fixture, threadId).events;
    const noop = await fixture.clients.context.compactContext({
      threadId,
      clientActionId: 'network-compact-noop',
    });
    expect(noop.status).toBe(CompactContextStatus.NOOP);
    expect(noop.operationId).not.toBe(merged.operationId);
    expect(noop.readThroughSeq).toBe(merged.readThroughSeq);
    expect(noop.recapIds).toEqual(merged.recapIds);
    expect(provider.requests).toHaveLength(6);
    expect(tableCounts(fixture, threadId).events).toBe(eventCount);
    expect(
      await fixture.clients.context.compactContext({
        threadId,
        clientActionId: 'network-compact-noop',
      }),
    ).toEqual(noop);

    const third = await sendSlashMessage(fixture, threadId, 'after compact', 'network-after');
    await waitSlashRun(fixture, threadId, third.runId, RunStatus.COMPLETED);
    const next = provider.byKind('normal')[2]?.request;
    const nextRecap = next?.messages.find((message) => message.content.includes('recap_id:'));
    expect(nextRecap?.role).toBe('user');
    for (const content of [
      'first user recap',
      'first answer recap',
      'second user recap',
      'second answer recap',
    ]) {
      expect(nextRecap?.content).toContain(content);
    }
    expect(next?.messages.filter((message) => message.content.includes('recap_id:'))).toHaveLength(
      1,
    );
    expect(next?.messages.some((message) => message.content === 'first original')).toBe(false);
    expect(stripMessageMeta(String(next?.messages.at(-1)?.content))).toBe('after compact');
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM context_messages WHERE thread_id = ?')
        .get(threadId),
    ).toEqual({ count: 6 });
  } finally {
    await cleanUp(directory, fixture);
  }
}, 30_000);

it('rejects busy compaction without cancellation and deduplicates concurrent and conflicting actions', async () => {
  const { directory, workspace } = await makeDirectory();
  const provider = new ControlledSlashProvider();
  const normalGate = deferred();
  const recapGate = deferred();
  provider.enqueue({ kind: 'normal', content: 'busy answer', gate: normalGate.promise });
  provider.enqueue({ kind: 'recap', content: 'dedup user recap', gate: recapGate.promise });
  provider.enqueue({ kind: 'recap', content: 'dedup answer recap', gate: recapGate.promise });
  const fixture = await startSlashFixture(directory, { provider, workspaceDirectory: workspace });
  try {
    const emptyThreadId = await createSlashThread(fixture, 'network-empty-thread');
    const empty = await fixture.clients.context.compactContext({
      threadId: emptyThreadId,
      clientActionId: 'network-empty-compact',
    });
    expect(empty).toMatchObject({ status: CompactContextStatus.NOOP, readThroughSeq: 0n });
    expect(provider.requests).toHaveLength(0);
    expect(tableCounts(fixture, emptyThreadId)).toMatchObject({
      inputs: 0,
      runs: 0,
      context: 0,
      recaps: 0,
      events: 1,
    });

    const threadId = await createSlashThread(fixture, 'network-busy-thread');
    const running = await sendSlashMessage(fixture, threadId, 'busy input', 'network-busy-input');
    await waitSlashRequests(provider, 'normal', 1);
    const busyError = await expectSlashError(
      fixture.clients.context.compactContext({
        threadId,
        clientActionId: 'network-compact-busy',
      }),
      Code.FailedPrecondition,
    );
    expect(slashErrorTerminal(busyError)).toBeUndefined();
    const active = await fixture.clients.thread.getThread({ threadId });
    expect(active.snapshot?.runs.find((run) => run.runId === running.runId)?.status).toBe(
      RunStatus.RUNNING,
    );
    expect(provider.byKind('recap')).toHaveLength(0);
    normalGate.resolve();
    await waitSlashRun(fixture, threadId, running.runId, RunStatus.COMPLETED);

    const request = { threadId, clientActionId: 'network-compact-duplicate' };
    const first = fixture.clients.context.compactContext(request);
    const duplicate = fixture.clients.context.compactContext(request);
    await waitSlashRequests(provider, 'recap', 1);
    await expect(
      fixture.clients.context.compactContext({
        threadId,
        clientActionId: 'network-compact-concurrent-other',
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    const otherThreadId = await createSlashThread(fixture, 'network-other-thread');
    await expect(
      fixture.clients.context.compactContext({
        threadId: otherThreadId,
        clientActionId: request.clientActionId,
      }),
    ).rejects.toMatchObject({ code: Code.AlreadyExists });
    await expect(fixture.clients.workspace.reloadResources(request)).rejects.toMatchObject({
      code: Code.AlreadyExists,
    });
    recapGate.resolve();
    const [changed, replayedConcurrently] = await Promise.all([first, duplicate]);
    expect(replayedConcurrently).toEqual(changed);
    expect(changed.status).toBe(CompactContextStatus.CHANGED);
    expect(provider.byKind('recap')).toHaveLength(2);
    expect(await fixture.clients.context.compactContext(request)).toEqual(changed);
    expect(provider.byKind('recap')).toHaveLength(2);
    expect(
      (await fixture.clients.thread.getThread({ threadId })).snapshot?.runs.find(
        (run) => run.runId === running.runId,
      )?.status,
    ).toBe(RunStatus.COMPLETED);
  } finally {
    normalGate.resolve();
    recapGate.resolve();
    await cleanUp(directory, fixture);
  }
}, 30_000);

it('rolls back a Recap storage failure, persists the error, and allows a new action to recover', async () => {
  const { directory, workspace } = await makeDirectory();
  const provider = new ControlledSlashProvider();
  provider.enqueue({ kind: 'normal', content: 'answer before failure' });
  provider.enqueue({ kind: 'recap', content: 'rejected user recap' });
  provider.enqueue({ kind: 'recap', content: 'rejected answer recap' });
  provider.enqueue({ kind: 'recap', content: 'recovered user recap' });
  provider.enqueue({ kind: 'recap', content: 'recovered answer recap' });
  const fixture = await startSlashFixture(directory, { provider, workspaceDirectory: workspace });
  try {
    const threadId = await createSlashThread(fixture, 'network-failure-thread');
    const original = await sendSlashMessage(
      fixture,
      threadId,
      'original survives failure',
      'network-failure-input',
    );
    await waitSlashRun(fixture, threadId, original.runId, RunStatus.COMPLETED);
    fixture.database.exec(
      "CREATE TRIGGER reject_network_recap BEFORE INSERT ON recaps BEGIN SELECT RAISE(ABORT, 'injected network recap failure'); END",
    );
    const request = { threadId, clientActionId: 'network-compact-storage-failure' };
    const failure = await expectSlashError(
      fixture.clients.context.compactContext(request),
      Code.Internal,
    );
    expect(slashErrorTerminal(failure)).toBe(true);
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({
      count: 0,
    });
    expect(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM model_input_recaps').get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .prepare(
          'SELECT read_through_seq, view_version FROM model_input_states WHERE thread_id = ?',
        )
        .get(threadId),
    ).toEqual({ read_through_seq: 0, view_version: 0 });
    const failed = z
      .object({ operation_id: z.string(), status: z.literal('failed') })
      .parse(
        fixture.database
          .prepare(
            "SELECT operation_id, status FROM manual_compact_operations WHERE client_action_id = 'network-compact-storage-failure'",
          )
          .get(),
      );
    const events = await readSlashEvents(fixture, threadId);
    expect(events.slice(-2).map((event) => event.payload.case)).toEqual([
      'hardCutStarted',
      'hardCutFailed',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      case: 'hardCutFailed',
      value: { operationId: failed.operation_id, runId: '' },
    });
    const replayedFailure = await expectSlashError(
      fixture.clients.context.compactContext(request),
      Code.Internal,
    );
    expect(slashErrorTerminal(replayedFailure)).toBe(true);
    expect(provider.byKind('recap')).toHaveLength(2);
    expect(
      (
        await fixture.clients.context.readContext({
          threadId,
          agentId: 'thread',
          afterSeq: 0n,
          limit: 100,
        })
      ).messages.map((message) => message.content),
    ).toEqual(['original survives failure', 'answer before failure']);

    fixture.database.exec('DROP TRIGGER reject_network_recap');
    const recovered = await fixture.clients.context.compactContext({
      threadId,
      clientActionId: 'network-compact-storage-recovered',
    });
    expect(recovered.status).toBe(CompactContextStatus.CHANGED);
    expect(recovered.recapIds).toHaveLength(2);
    expect(provider.byKind('recap')).toHaveLength(4);
    expect(
      fixture.database
        .prepare('SELECT read_through_seq FROM model_input_states WHERE thread_id = ?')
        .get(threadId),
    ).toEqual({ read_through_seq: 2 });
  } finally {
    await cleanUp(directory, fixture);
  }
}, 30_000);

it('finishes a disconnected RPC and recovers an interrupted compaction without replaying generation', async () => {
  const { directory, workspace } = await makeDirectory();
  const provider = new ControlledSlashProvider();
  const disconnectedGate = deferred();
  const interruptedGate = deferred();
  provider.enqueue({ kind: 'normal', content: 'disconnect answer' });
  provider.enqueue({
    kind: 'recap',
    content: 'disconnect user recap',
    gate: disconnectedGate.promise,
  });
  provider.enqueue({
    kind: 'recap',
    content: 'disconnect answer recap',
    gate: disconnectedGate.promise,
  });
  provider.enqueue({ kind: 'normal', content: 'after disconnect' });
  provider.enqueue({
    kind: 'recap',
    content: 'interrupted user recap',
    gate: interruptedGate.promise,
  });
  provider.enqueue({
    kind: 'recap',
    content: 'interrupted answer recap',
    gate: interruptedGate.promise,
  });
  let fixture = await startSlashFixture(directory, { provider, workspaceDirectory: workspace });
  const restartedProvider = new ControlledSlashProvider();
  restartedProvider.enqueue({ kind: 'recap', content: 'restarted user recap' });
  restartedProvider.enqueue({ kind: 'recap', content: 'restarted answer recap' });
  try {
    const threadId = await createSlashThread(fixture, 'network-disconnect-thread');
    const initial = await sendSlashMessage(
      fixture,
      threadId,
      'disconnect original',
      'network-disconnect-input',
    );
    await waitSlashRun(fixture, threadId, initial.runId, RunStatus.COMPLETED);
    const request = { threadId, clientActionId: 'network-compact-disconnect' };
    const controller = new AbortController();
    const disconnected = fixture.clients.context.compactContext(request, {
      signal: controller.signal,
    });
    await waitSlashRequests(provider, 'recap', 1);
    controller.abort();
    await expect(disconnected).rejects.toMatchObject({ code: Code.Canceled });
    expect(
      fixture.database
        .prepare(
          "SELECT status FROM manual_compact_operations WHERE client_action_id = 'network-compact-disconnect'",
        )
        .get(),
    ).toEqual({ status: 'running' });
    disconnectedGate.resolve();
    await vi.waitFor(() => {
      expect(
        fixture.database
          .prepare(
            "SELECT status FROM manual_compact_operations WHERE client_action_id = 'network-compact-disconnect'",
          )
          .get(),
      ).toEqual({ status: 'changed' });
    });
    const replayed = await fixture.clients.context.compactContext(request);
    expect(replayed.status).toBe(CompactContextStatus.CHANGED);
    expect(provider.byKind('recap')).toHaveLength(2);

    const second = await sendSlashMessage(
      fixture,
      threadId,
      'before interrupted compact',
      'network-before-interrupted',
    );
    await waitSlashRun(fixture, threadId, second.runId, RunStatus.COMPLETED);
    const interruptedRequest = { threadId, clientActionId: 'network-compact-interrupted' };
    const interrupted = fixture.clients.context.compactContext(interruptedRequest);
    await waitSlashRequests(provider, 'recap', 3);
    fixture.server.server.closeAllConnections();
    const closing = closeSlashFixture(fixture);
    const transportFailure = await expectSlashError(interrupted, Code.Aborted);
    expect(slashErrorTerminal(transportFailure)).toBeUndefined();
    await closing;

    fixture = await startSlashFixture(directory, {
      provider: restartedProvider,
      workspaceDirectory: workspace,
    });
    expect(restartedProvider.requests).toHaveLength(0);
    const interruptedFailure = await expectSlashError(
      fixture.clients.context.compactContext(interruptedRequest),
      Code.FailedPrecondition,
    );
    expect(slashErrorTerminal(interruptedFailure)).toBe(true);
    expect(restartedProvider.requests).toHaveLength(0);
    const retried = await fixture.clients.context.compactContext({
      threadId,
      clientActionId: 'network-compact-after-restart',
    });
    expect(retried.status).toBe(CompactContextStatus.CHANGED);
    expect(retried.readThroughSeq).toBe(4n);
    expect(restartedProvider.byKind('recap')).toHaveLength(2);
    expect(
      z
        .array(z.object({ status: z.string() }))
        .parse(
          fixture.database
            .prepare(
              'SELECT status FROM manual_compact_operations WHERE thread_id = ? ORDER BY created_at, operation_id',
            )
            .all(threadId),
        ),
    ).toEqual([{ status: 'changed' }, { status: 'interrupted' }, { status: 'changed' }]);
  } finally {
    disconnectedGate.resolve();
    interruptedGate.resolve();
    await closeSlashFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('rejects a stale compact after a Connect revision and compacts only the rerun view', async () => {
  const { directory, workspace } = await makeDirectory();
  const provider = new ControlledSlashProvider();
  const gate = deferred();
  provider.enqueue({ kind: 'normal', content: 'answer before revision' });
  provider.enqueue({ kind: 'normal', content: 'answer after revision' });
  provider.enqueue({ kind: 'recap', content: 'stale user recap', gate: gate.promise });
  provider.enqueue({ kind: 'recap', content: 'stale answer recap', gate: gate.promise });
  const fixture = await startSlashFixture(directory, { provider, workspaceDirectory: workspace });
  try {
    const threadId = await createSlashThread(fixture, 'network-revision-thread');
    const original = await sendSlashMessage(
      fixture,
      threadId,
      'original before revision',
      'network-revision-input',
    );
    await waitSlashRun(fixture, threadId, original.runId, RunStatus.COMPLETED);
    const running = fixture.clients.context.compactContext({
      threadId,
      clientActionId: 'network-compact-revision-stale',
    });
    await waitSlashRequests(provider, 'recap', 1);
    const snapshot = await fixture.clients.thread.getThread({ threadId });
    const anchor = snapshot.snapshot?.messages[0];
    if (!anchor) throw new Error('The compact revision source is missing.');
    await fixture.clients.messages.reviseMessage({
      clientActionId: 'network-revise-during-compact',
      threadId,
      messageId: anchor.messageId,
      text: 'current revised source',
    });
    gate.resolve();
    await expect(running).rejects.toMatchObject({ code: Code.Aborted });
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({
      count: 0,
    });
    expect(
      fixture.database
        .prepare(
          'SELECT read_through_seq, view_version FROM model_input_states WHERE thread_id = ?',
        )
        .get(threadId),
    ).toEqual({ read_through_seq: 0, view_version: 1 });
    expect(
      fixture.database
        .prepare('SELECT content FROM context_message_revisions WHERE message_seq = 1')
        .get(),
    ).toEqual({ content: 'current revised source' });
    const rerun = (await fixture.clients.thread.getThread({ threadId })).snapshot?.runs.findLast(
      (run) => run.rerunFromMessageSeq === anchor.seq,
    );
    if (!rerun) throw new Error('Revision did not start a Rerun.');
    await waitSlashRun(fixture, threadId, rerun.runId, RunStatus.COMPLETED);

    const recapCountBeforeCurrent = provider.byKind('recap').length;
    provider.enqueue({ kind: 'recap', content: 'revised user recap' });
    provider.enqueue({ kind: 'recap', content: 'revised answer recap' });
    const current = await fixture.clients.context.compactContext({
      threadId,
      clientActionId: 'network-compact-revision-current',
    });
    expect(current.status).toBe(CompactContextStatus.CHANGED);
    const recapRequests = provider.byKind('recap').slice(recapCountBeforeCurrent);
    expect(recapRequests).toHaveLength(2);
    expect(JSON.stringify(recapRequests)).toContain('current revised source');
    expect(JSON.stringify(recapRequests)).not.toContain('original before revision');
    expect(
      (await fixture.clients.thread.getThread({ threadId })).snapshot?.messages.map(
        (message) => message.content,
      ),
    ).toEqual(['current revised source', 'answer after revision']);
  } finally {
    gate.resolve();
    await cleanUp(directory, fixture);
  }
}, 30_000);

it('invalidates compacted Recaps on Rerun and generates replacements only from the new branch', async () => {
  const { directory, workspace } = await makeDirectory();
  const provider = new ControlledSlashProvider();
  provider.enqueue({ kind: 'normal', content: 'superseded answer' });
  provider.enqueue({ kind: 'recap', content: 'old user recap' });
  provider.enqueue({ kind: 'recap', content: 'old answer recap' });
  provider.enqueue({ kind: 'normal', content: 'rerun answer' });
  provider.enqueue({ kind: 'recap', content: 'rerun user recap' });
  provider.enqueue({ kind: 'recap', content: 'rerun answer recap' });
  const fixture = await startSlashFixture(directory, { provider, workspaceDirectory: workspace });
  try {
    const threadId = await createSlashThread(fixture, 'network-rerun-thread');
    const original = await sendSlashMessage(
      fixture,
      threadId,
      'rerun source',
      'network-rerun-input',
    );
    await waitSlashRun(fixture, threadId, original.runId, RunStatus.COMPLETED);
    const compacted = await fixture.clients.context.compactContext({
      threadId,
      clientActionId: 'network-compact-before-rerun',
    });
    expect(compacted.status).toBe(CompactContextStatus.CHANGED);
    const snapshot = await fixture.clients.thread.getThread({ threadId });
    const messageId = snapshot.snapshot?.messages[0]?.messageId;
    if (!messageId) throw new Error('The Rerun anchor is missing.');
    const rerun = await fixture.clients.runs.rerun({
      clientActionId: 'network-rerun-action',
      threadId,
      messageId,
    });
    await waitSlashRun(fixture, threadId, rerun.runId, RunStatus.COMPLETED);
    const invalid = await fixture.clients.context.readRecaps({
      threadId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 100,
    });
    expect(invalid.recaps.map((recap) => recap.validity)).toEqual([
      RecapValidity.INVALID,
      RecapValidity.INVALID,
    ]);
    expect(
      fixture.database
        .prepare(
          'SELECT read_through_seq, view_version FROM model_input_states WHERE thread_id = ?',
        )
        .get(threadId),
    ).toEqual({ read_through_seq: 0, view_version: 1 });
    expect(
      (
        await fixture.clients.context.readContext({
          threadId,
          agentId: 'thread',
          afterSeq: 0n,
          limit: 100,
        })
      ).messages.map((message) => message.content),
    ).toEqual(['rerun source', 'superseded answer', 'rerun answer']);

    const current = await fixture.clients.context.compactContext({
      threadId,
      clientActionId: 'network-compact-after-rerun',
    });
    expect(current.status).toBe(CompactContextStatus.CHANGED);
    expect(current.recapIds).toHaveLength(2);
    expect(current.recapIds).not.toEqual(compacted.recapIds);
    const currentRequests = provider.byKind('recap').slice(2);
    expect(currentRequests).toHaveLength(2);
    expect(JSON.stringify(currentRequests)).not.toContain('superseded answer');
    const recaps = await fixture.clients.context.readRecaps({
      threadId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 100,
    });
    expect(recaps.recaps.map((recap) => [recap.sourceMessageSeqs, recap.validity])).toEqual([
      [[1n], RecapValidity.INVALID],
      [[2n], RecapValidity.INVALID],
      [[1n], RecapValidity.VALID],
      [[3n], RecapValidity.VALID],
    ]);
    expect(
      (await fixture.clients.thread.getThread({ threadId })).snapshot?.messages.map(
        (message) => message.content,
      ),
    ).toEqual(['rerun source', 'rerun answer']);
  } finally {
    await cleanUp(directory, fixture);
  }
}, 30_000);

it('keeps normal requests unchanged below and at 80%, and auto-compacts only above 80%', async () => {
  const { directory, workspace } = await makeDirectory();
  const provider = new ControlledSlashProvider();
  provider.enqueue({ kind: 'normal', content: 'below answer' });
  provider.enqueue({ kind: 'normal', content: 'exact answer' });
  for (let index = 1; index <= 5; index += 1) {
    provider.enqueue({ kind: 'recap', content: `automatic recap ${index}` });
  }
  provider.enqueue({ kind: 'normal', content: 'above answer' });
  const fixture = await startSlashFixture(directory, {
    provider,
    workspaceDirectory: workspace,
    countTokens: (request) => {
      if (
        request.messages.some(
          (message) => stripMessageMeta(String(message.content)) === 'boundary above',
        )
      )
        return 801;
      if (
        request.messages.some(
          (message) => stripMessageMeta(String(message.content)) === 'boundary exact',
        )
      )
        return 800;
      if (
        request.messages.some(
          (message) => stripMessageMeta(String(message.content)) === 'boundary below',
        )
      )
        return 799;
      return 100;
    },
  });
  try {
    const threadId = await createSlashThread(fixture, 'network-boundary-thread');
    const results = [];
    for (const [text, actionId] of [
      ['boundary below', 'network-boundary-below'],
      ['boundary exact', 'network-boundary-exact'],
      ['boundary above', 'network-boundary-above'],
    ] as const) {
      const sent = await sendSlashMessage(fixture, threadId, text, actionId);
      await waitSlashRun(fixture, threadId, sent.runId, RunStatus.COMPLETED);
      results.push(sent);
    }
    expect(results).toHaveLength(3);
    expect(provider.byKind('normal')).toHaveLength(3);
    expect(provider.byKind('recap')).toHaveLength(5);
    const records = z
      .array(
        z.object({
          estimated_input_tokens: z.number(),
          hard_cut: z.number(),
          read_through_seq: z.number(),
        }),
      )
      .parse(
        fixture.database
          .prepare(
            `SELECT estimated_input_tokens, hard_cut, read_through_seq
             FROM model_request_records WHERE thread_id = ? ORDER BY created_at, rowid`,
          )
          .all(threadId),
      );
    expect(records).toEqual([
      { estimated_input_tokens: 799, hard_cut: 0, read_through_seq: 0 },
      { estimated_input_tokens: 800, hard_cut: 0, read_through_seq: 0 },
      { estimated_input_tokens: 100, hard_cut: 1, read_through_seq: 5 },
    ]);
    expect(records[1]?.estimated_input_tokens).toBe(800);
    expect(records[2]?.estimated_input_tokens).toBe(100);
    const above = provider.byKind('normal')[2]?.request;
    const automaticRecap = above?.messages.find((message) => message.content.includes('recap_id:'));
    for (let index = 1; index <= 5; index += 1) {
      expect(automaticRecap?.content).toContain(`automatic recap ${index}`);
    }
    expect(above?.messages.some((message) => message.content === 'boundary above')).toBe(false);
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM context_messages WHERE thread_id = ?')
        .get(threadId),
    ).toEqual({ count: 6 });
  } finally {
    await cleanUp(directory, fixture);
  }
}, 30_000);
