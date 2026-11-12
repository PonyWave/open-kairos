import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { seedLoadedTestWorkspace, seedTestTenant } from '../integration/environment-fixture.js';
import { openDatabase } from '../storage/database.js';
import { SessionError } from './errors.js';
import type { InteractionRecord } from './records.js';
import { SessionStore } from './store.js';

const ownerId = 'owner-1';

function action<T extends Record<string, unknown>>(
  method: string,
  clientActionId: string,
  parameters: T & { mode?: 'follow_up' | 'steer' },
): T & { ownerId: string; clientActionId: string; method: string; parameters: T } {
  return { ownerId, clientActionId, method, parameters, ...parameters };
}

function fixture() {
  const database = openDatabase(':memory:');
  let now = Date.parse('2026-11-03T00:00:00.000Z');
  const store = new SessionStore(database, { clock: () => new Date(now) });
  seedTestTenant(database, ownerId);
  return {
    database,
    store,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function delegationKey(interaction: InteractionRecord) {
  return {
    sourceThreadId: interaction.sourceThreadId,
    sourceAgentId: interaction.sourceAgentId,
    sourceToolCallId: interaction.sourceToolCallId,
  };
}

function createThread(store: SessionStore, id = 'create-1') {
  const thread = store.createThread(action('CreateThread', id, { title: '会话' }));
  seedLoadedTestWorkspace(store, thread.threadId);
  return thread;
}

it('deduplicates actions across reconstruction and rejects changed parameters', () => {
  const { database, store } = fixture();
  try {
    const created = store.createThread(action('CreateThread', 'create-1', { title: '会话' }));
    const duplicate = store.createThread(action('CreateThread', 'create-1', { title: '会话' }));
    expect(duplicate).toEqual(created);
    expect(() =>
      store.createThread(action('CreateThread', 'create-1', { title: '不同标题' })),
    ).toThrowError(expect.objectContaining({ code: 'action_conflict' }));

    const rebuilt = new SessionStore(database);
    expect(
      rebuilt.createThread(action('CreateThread', 'create-1', { title: '会话' })).threadId,
    ).toBe(created.threadId);
    expect(rebuilt.listEvents(created.threadId, 0n)).toHaveLength(1);
  } finally {
    database.close();
  }
});

it('creates a task Thread and accepts its first input atomically', () => {
  const { database, store } = fixture();
  try {
    const created = store.createThread(
      action('CreateThread', 'create-with-input', {
        title: '首条任务',
        initialText: '第一条输入',
        initialMode: 'follow_up' as const,
      }),
    );
    expect(created.thread.threadType).toBe('task');
    expect(created.input).toMatchObject({
      threadId: created.thread.threadId,
      text: '第一条输入',
      status: 'queued',
    });
    expect(store.getRunById(created.runId).status).toBe('queued');
    expect(
      store.createThread(
        action('CreateThread', 'create-with-input', {
          title: '首条任务',
          initialText: '第一条输入',
          initialMode: 'follow_up' as const,
        }),
      ),
    ).toEqual(created);
    expect(() =>
      store.createThread(
        action('CreateThread', 'create-with-input', {
          title: '首条任务',
          initialText: '不同输入',
          initialMode: 'follow_up' as const,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'action_conflict' }));
    expect(store.listThreads(ownerId, 0n, 10)).toHaveLength(1);
    expect(store.listQueuedInputs(created.thread.threadId)).toHaveLength(1);
  } finally {
    database.close();
  }
});

it('rolls back the Thread when first-input acceptance fails', () => {
  const { database, store } = fixture();
  try {
    database.exec('DROP TABLE inputs');
    expect(() =>
      store.createThread(
        action('CreateThread', 'create-failed', {
          title: '不能半创建',
          initialText: '首条输入',
          initialMode: 'follow_up' as const,
        }),
      ),
    ).toThrow();
    for (const table of ['threads', 'runs', 'client_actions']) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    }
  } finally {
    database.close();
  }
});

it('reruns from the existing user anchor and preserves only the current branch', () => {
  const { database, store } = fixture();
  try {
    const thread = createThread(store);
    const sent = store.sendMessage(
      action('SendMessage', 'send-rerun', {
        threadId: thread.threadId,
        text: '原始问题',
        mode: 'follow_up',
      }),
    );
    const user = store.appendModelMessage({
      runId: sent.runId,
      inputId: sent.input.inputId,
      message: { role: 'user', content: sent.input.text },
    });
    const oldResponse = store.appendModelMessage({
      runId: sent.runId,
      message: { role: 'assistant', content: '旧回答' },
    });
    const recap = store.recaps.save({
      threadId: thread.threadId,
      agentId: 'thread',
      sourceMessageSeqs: [user.seq, oldResponse.seq],
      content: '旧回答摘要',
    });
    store.updateRunStatus(sent.runId, 'completed');

    const rerun = store.rerun(
      action('Rerun', 'rerun-current', {
        threadId: thread.threadId,
        messageId: user.messageId,
      }),
    );
    expect(rerun).toMatchObject({
      rerunFromMessageSeq: user.seq,
      supersededByRunId: null,
      inputIds: [],
    });
    expect(store.listInputs(ownerId, thread.threadId)).toHaveLength(1);
    expect(
      store.context.query({ threadId: thread.threadId, agentId: 'thread', currentOnly: true }),
    ).toHaveLength(1);
    expect(store.getRunById(sent.runId).supersededByRunId).toBe(rerun.runId);
    expect(store.getContextMessage(ownerId, thread.threadId, oldResponse.messageId)).toMatchObject({
      supersededByRunId: rerun.runId,
    });
    expect(store.recaps.get(thread.threadId, 'thread', recap.recapId)?.validity).toBe('invalid');
    expect(
      database
        .prepare(
          'SELECT read_through_seq, view_version FROM model_input_states WHERE thread_id = ? AND agent_id = ?',
        )
        .get(thread.threadId, 'thread'),
    ).toEqual({ read_through_seq: user.seq - 1, view_version: 1 });
    expect(
      store.listEvents(thread.threadId, 0n).some((event) => {
        return (
          event.payload.case === 'contextViewChanged' &&
          event.payload.value.anchorMessageSeq === user.seq
        );
      }),
    ).toBe(true);
    expect(store.listContext(ownerId, thread.threadId, 'thread')).toHaveLength(2);
  } finally {
    database.close();
  }
});

it('edits, removes and reorders only queued inputs with optimistic versions', () => {
  const { database, store } = fixture();
  try {
    const thread = createThread(store);
    const first = store.sendMessage(
      action('SendMessage', 'send-1', {
        threadId: thread.threadId,
        text: '第一',
        mode: 'follow_up',
      }),
    ).input;
    const second = store.sendMessage(
      action('SendMessage', 'send-2', {
        threadId: thread.threadId,
        text: '第二',
        mode: 'steer',
      }),
    ).input;
    const edited = store.editInput(
      action('EditInput', 'edit-1', {
        threadId: thread.threadId,
        inputId: first.inputId,
        text: '第一修订',
        expectedVersion: 1n,
      }),
    );
    expect(edited.version).toBe(2);
    expect(() =>
      store.editInput(
        action('EditInput', 'edit-2', {
          threadId: thread.threadId,
          inputId: first.inputId,
          text: '旧版本',
          expectedVersion: 1n,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'version_conflict' }));

    const reordered = store.reorderInputs(
      action('ReorderInputs', 'reorder-1', {
        threadId: thread.threadId,
        inputIds: [second.inputId, first.inputId],
        expectedVersion: 0n,
      }),
    );
    expect(reordered.inputs.map((input) => input.inputId)).toEqual([second.inputId, first.inputId]);
    const removed = store.removeInput(
      action('RemoveInput', 'remove-1', {
        threadId: thread.threadId,
        inputId: second.inputId,
        expectedVersion: 1n,
      }),
    );
    expect(removed.input.status).toBe('cancelled');
    expect(removed.queueVersion).toBe(2);
    expect(() =>
      store.removeInput(
        action('RemoveInput', 'remove-2', {
          threadId: thread.threadId,
          inputId: second.inputId,
          expectedVersion: 2n,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'failed_precondition' }));
  } finally {
    database.close();
  }
});

it('commits consumed input, Context and persistent events together', () => {
  const { database, store } = fixture();
  try {
    const thread = createThread(store);
    const sent = store.sendMessage(
      action('SendMessage', 'send-1', {
        threadId: thread.threadId,
        text: '执行',
        mode: 'follow_up',
      }),
    );
    const message = store.appendModelMessage({
      runId: sent.runId,
      inputId: sent.input.inputId,
      message: { role: 'user', content: sent.input.text },
    });
    expect(store.getInput(ownerId, sent.input.inputId).status).toBe('consumed');
    expect(store.getRunById(sent.runId).inputIds).toEqual([sent.input.inputId]);
    expect(store.getContextMessage(ownerId, thread.threadId, message.messageId).message).toEqual({
      role: 'user',
      content: '执行',
    });
    expect(store.listEvents(thread.threadId, 0n).at(-1)?.payload.case).toBe('messageCommitted');
  } finally {
    database.close();
  }
});

it('revises the latest user message and atomically starts a Rerun', () => {
  const { database, store } = fixture();
  try {
    const thread = createThread(store);
    const sent = store.sendMessage(
      action('SendMessage', 'send-1', {
        threadId: thread.threadId,
        text: '原文',
        mode: 'follow_up',
      }),
    );
    const message = store.appendModelMessage({
      runId: sent.runId,
      inputId: sent.input.inputId,
      message: { role: 'user', content: '原文' },
    });
    store.recaps.save({
      threadId: thread.threadId,
      agentId: 'thread',
      sourceMessageSeqs: [message.seq],
      content: '原文摘要',
    });
    expect(() =>
      store.reviseMessage(
        action('ReviseMessage', 'revise-active', {
          threadId: thread.threadId,
          messageId: message.messageId,
          text: '活动 Run 不应提交',
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'failed_precondition' }));
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM context_message_revisions').get(),
    ).toEqual({ count: 0 });

    store.updateRunStatus(sent.runId, 'completed');
    const { revision, run } = store.reviseMessage(
      action('ReviseMessage', 'revise-1', {
        threadId: thread.threadId,
        messageId: message.messageId,
        text: '修订',
      }),
    );
    const stored = store.getContextMessage(ownerId, thread.threadId, message.messageId);
    expect(stored.message.content).toBe('原文');
    expect(stored.revisions.at(-1)?.revisionId).toBe(revision.revisionId);
    expect(run).toMatchObject({ rerunFromMessageSeq: message.seq, inputIds: [] });
    expect(store.getRunById(sent.runId).supersededByRunId).toBe(run.runId);
    expect(store.recaps.query({ threadId: thread.threadId, agentId: 'thread' })[0]?.validity).toBe(
      'invalid',
    );
    expect(
      store
        .listEvents(thread.threadId, 0n)
        .some((event) => event.payload.case === 'recapInvalidated'),
    ).toBe(true);
  } finally {
    database.close();
  }
});

it('rejects revision and Rerun for any but the latest direct user message', () => {
  const { database, store } = fixture();
  try {
    const thread = createThread(store);
    const first = store.sendMessage(
      action('SendMessage', 'send-first-user', {
        threadId: thread.threadId,
        text: '第一条',
        mode: 'follow_up',
      }),
    );
    const firstUser = store.appendModelMessage({
      runId: first.runId,
      inputId: first.input.inputId,
      message: { role: 'user', content: '第一条' },
    });
    store.appendModelMessage({
      runId: first.runId,
      message: { role: 'assistant', content: '第一回答' },
    });
    store.updateRunStatus(first.runId, 'completed');
    const second = store.sendMessage(
      action('SendMessage', 'send-second-user', {
        threadId: thread.threadId,
        text: '第二条',
        mode: 'follow_up',
      }),
    );
    store.appendModelMessage({
      runId: second.runId,
      inputId: second.input.inputId,
      message: { role: 'user', content: '第二条' },
    });
    store.appendModelMessage({
      runId: second.runId,
      message: { role: 'assistant', content: '第二回答' },
    });
    store.updateRunStatus(second.runId, 'completed');

    expect(() =>
      store.rerun(
        action('Rerun', 'rerun-older-user', {
          threadId: thread.threadId,
          messageId: firstUser.messageId,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'failed_precondition' }));
    expect(() =>
      store.reviseMessage(
        action('ReviseMessage', 'revise-older-user', {
          threadId: thread.threadId,
          messageId: firstUser.messageId,
          text: '不应保存',
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'failed_precondition' }));
    expect(database.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 2 });
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM context_message_revisions').get(),
    ).toEqual({ count: 0 });
    expect(
      store.context.query({ threadId: thread.threadId, agentId: 'thread', currentOnly: true }),
    ).toHaveLength(4);
  } finally {
    database.close();
  }
});

it('marks old Runs interrupted on recovery without consuming queued inputs', () => {
  const { database, store } = fixture();
  try {
    const thread = createThread(store);
    const sent = store.sendMessage(
      action('SendMessage', 'send-1', {
        threadId: thread.threadId,
        text: '等待执行',
        mode: 'follow_up',
      }),
    );
    store.updateRunStatus(sent.runId, 'running');
    const rebuilt = new SessionStore(database);
    rebuilt.recoverInterrupted();
    expect(rebuilt.getRunById(sent.runId).status).toBe('interrupted');
    expect(rebuilt.getInput(ownerId, sent.input.inputId).status).toBe('queued');
    expect(
      rebuilt.continueRun(
        action('ContinueRun', 'continue-1', { threadId: thread.threadId, runId: sent.runId }),
      ).status,
    ).toBe('queued');
  } finally {
    database.close();
  }
});

it('rolls back input and Run acceptance when event persistence fails', () => {
  const { database, store } = fixture();
  try {
    const thread = createThread(store);
    database.exec('DROP TABLE thread_events');
    expect(() =>
      store.sendMessage(
        action('SendMessage', 'send-1', {
          threadId: thread.threadId,
          text: '不能部分提交',
          mode: 'follow_up',
        }),
      ),
    ).toThrow();
    expect(store.listQueuedInputs(thread.threadId)).toEqual([]);
    expect(store.getActiveRun(thread.threadId)).toBeUndefined();
  } finally {
    database.close();
  }
});

it('expires old event cursors while retaining a recoverable snapshot', () => {
  const { database, store, advance } = fixture();
  try {
    const thread = createThread(store);
    advance(8 * 24 * 60 * 60 * 1000);
    store.renameThread(
      action('RenameThread', 'rename-1', { threadId: thread.threadId, title: '新会话' }),
    );
    store.pruneEvents(thread.threadId);
    expect(store.firstAvailableEventSequence(thread.threadId)).toBe(2);
    expect(store.latestEventSequence(thread.threadId)).toBe(2);
    expect(store.listEvents(thread.threadId, 0n)[0]?.seq).toBe(2);
  } finally {
    database.close();
  }
});

it('validates owner scope for Threads and inputs', () => {
  const { database, store } = fixture();
  try {
    const thread = createThread(store);
    expect(() => store.getThread('other-owner', thread.threadId)).toThrowError(SessionError);
    expect(() => store.listInputs('other-owner', thread.threadId)).toThrowError(
      expect.objectContaining({ code: 'permission_denied' }),
    );
  } finally {
    database.close();
  }
});

it('updates an automatic title only while the default title is unchanged', () => {
  const { database, store } = fixture();
  try {
    const thread = createThread(store);
    const initialSeq = store.latestEventSequence(thread.threadId);
    expect(
      store.renameThreadIfTitle({
        ownerId,
        threadId: thread.threadId,
        expectedTitle: '其他标题',
        title: '自动标题',
      }).title,
    ).toBe('会话');
    expect(store.latestEventSequence(thread.threadId)).toBe(initialSeq);

    expect(
      store.renameThreadIfTitle({
        ownerId,
        threadId: thread.threadId,
        expectedTitle: '会话',
        title: '自动标题',
      }).title,
    ).toBe('自动标题');
    expect(store.latestEventSequence(thread.threadId)).toBe(initialSeq + 1);

    store.renameThread(
      action('RenameThread', 'rename-manual', { threadId: thread.threadId, title: '手动标题' }),
    );
    const manualSeq = store.latestEventSequence(thread.threadId);
    expect(
      store.renameThreadIfTitle({
        ownerId,
        threadId: thread.threadId,
        expectedTitle: '自动标题',
        title: '覆盖标题',
      }).title,
    ).toBe('手动标题');
    expect(store.latestEventSequence(thread.threadId)).toBe(manualSeq);
  } finally {
    database.close();
  }
});

it('replays original receipts after later state changes', () => {
  const { database, store } = fixture();
  try {
    const thread = createThread(store);
    const renamed = store.renameThread(
      action('RenameThread', 'rename-1', { threadId: thread.threadId, title: '首次标题' }),
    );
    store.renameThread(
      action('RenameThread', 'rename-2', { threadId: thread.threadId, title: '后续标题' }),
    );
    expect(store.createThread(action('CreateThread', 'create-1', { title: '会话' })).title).toBe(
      '会话',
    );
    expect(
      store.renameThread(
        action('RenameThread', 'rename-1', { threadId: thread.threadId, title: '首次标题' }),
      ),
    ).toEqual(renamed);

    const sent = store.sendMessage(
      action('SendMessage', 'send-1', {
        threadId: thread.threadId,
        text: '原文',
        mode: 'follow_up',
      }),
    );
    const firstEdit = store.editInput(
      action('EditInput', 'edit-1', {
        threadId: thread.threadId,
        inputId: sent.input.inputId,
        text: '首次编辑',
        expectedVersion: 1n,
      }),
    );
    store.editInput(
      action('EditInput', 'edit-2', {
        threadId: thread.threadId,
        inputId: sent.input.inputId,
        text: '后续编辑',
        expectedVersion: 2n,
      }),
    );
    expect(
      store.editInput(
        action('EditInput', 'edit-1', {
          threadId: thread.threadId,
          inputId: sent.input.inputId,
          text: '首次编辑',
          expectedVersion: 1n,
        }),
      ),
    ).toEqual(firstEdit);

    store.updateRunStatus(sent.runId, 'running');
    const cancelled = store.requestCancelRun(
      action('CancelRun', 'cancel-1', {
        threadId: thread.threadId,
        runId: sent.runId,
        reason: 'stop',
      }),
    );
    store.updateRunStatus(sent.runId, 'cancelled');
    expect(
      store.requestCancelRun(
        action('CancelRun', 'cancel-1', {
          threadId: thread.threadId,
          runId: sent.runId,
          reason: 'stop',
        }),
      ),
    ).toEqual(cancelled);
  } finally {
    database.close();
  }
});

function delegation(store: SessionStore) {
  const main = store.getOrCreateMainThread(ownerId);
  seedLoadedTestWorkspace(store, main.threadId);
  const task = createThread(store);
  const sourceRunId = store.sendMessage(
    action('SendMessage', 'source-run', {
      threadId: main.threadId,
      text: '主任务',
      mode: 'follow_up',
    }),
  ).runId;
  return { main, task, sourceRunId };
}

function completedThreadCall(store: SessionStore) {
  const scope = delegation(store);
  const accepted = store.acceptThreadCall({
    ownerId,
    sourceThreadId: scope.main.threadId,
    sourceAgentId: 'thread',
    sourceRunId: scope.sourceRunId,
    sourceToolCallId: 'thread-call-1',
    targetThreadId: scope.task.threadId,
    prompt: '后台任务',
    mode: 'follow_up',
  });
  store.appendModelMessage({
    runId: accepted.runId,
    inputId: accepted.input.inputId,
    message: { role: 'user', content: accepted.input.text },
  });
  const response = store.appendModelMessage({
    runId: accepted.runId,
    message: { role: 'assistant', content: '后台结果' },
  });
  store.recordInteractionResponses({
    runId: accepted.runId,
    messageId: response.messageId,
    interactionKeys: [accepted.interaction],
  });
  return { ...scope, accepted, response };
}

it('creates a delegated Thread with its first input and deduplicates empty targets', () => {
  const { database, store } = fixture();
  try {
    const scope = delegation(store);
    const base = {
      ownerId,
      sourceThreadId: scope.main.threadId,
      sourceAgentId: 'thread',
      sourceRunId: scope.sourceRunId,
    };
    const first = store.acceptThreadCall({
      ...base,
      sourceToolCallId: 'new-thread-call',
      targetThreadId: '',
      title: '原子任务',
      prompt: '首条委派',
      mode: 'follow_up',
    });
    const target = store.getThread(ownerId, first.interaction.targetThreadId);
    expect(target).toMatchObject({ title: '原子任务', threadType: 'task' });
    expect(first.input).toMatchObject({
      threadId: target.threadId,
      text: '首条委派',
      mode: 'follow_up',
      status: 'queued',
      source: 'thread_call',
      delegation: {
        sourceThreadId: scope.main.threadId,
        sourceAgentId: 'thread',
        sourceToolCallId: 'new-thread-call',
      },
    });
    expect(store.getRunById(first.runId)).toMatchObject({
      threadId: target.threadId,
      status: 'queued',
      executionMode: 'background',
      parentRunId: null,
    });

    const rebuilt = new SessionStore(database);
    expect(
      rebuilt.acceptThreadCall({
        ...base,
        sourceToolCallId: 'new-thread-call',
        title: '原子任务',
        prompt: '首条委派',
        mode: 'follow_up',
      }),
    ).toEqual(first);
    expect(() =>
      rebuilt.acceptThreadCall({
        ...base,
        sourceToolCallId: 'new-thread-call',
        targetThreadId: '',
        title: '不同标题',
        prompt: '首条委派',
        mode: 'follow_up',
      }),
    ).toThrowError(expect.objectContaining({ code: 'action_conflict' }));
    expect(() =>
      rebuilt.acceptThreadCall({
        ...base,
        sourceToolCallId: 'new-thread-call',
        targetThreadId: '',
        title: '原子任务',
        prompt: '不同输入',
        mode: 'follow_up',
      }),
    ).toThrowError(expect.objectContaining({ code: 'action_conflict' }));
    expect(rebuilt.listInputs(ownerId, target.threadId)).toHaveLength(1);

    const continued = rebuilt.acceptThreadCall({
      ...base,
      sourceToolCallId: 'continue-thread-call',
      targetThreadId: target.threadId,
      prompt: '后续委派',
      mode: 'steer',
    });
    expect(continued.runId).toBe(first.runId);
    expect(continued.interaction.targetThreadId).toBe(target.threadId);
    expect(rebuilt.listInputs(ownerId, target.threadId)).toHaveLength(2);

    const defaulted = rebuilt.acceptThreadCall({
      ...base,
      sourceToolCallId: 'default-title-call',
      prompt: '默认标题输入',
      mode: 'follow_up',
    });
    expect(rebuilt.getThread(ownerId, defaulted.interaction.targetThreadId).title).toBe(
      '任务 Thread',
    );
    expect(
      rebuilt.acceptThreadCall({
        ...base,
        sourceToolCallId: 'default-title-call',
        targetThreadId: '',
        title: '任务 Thread',
        prompt: '默认标题输入',
        mode: 'follow_up',
      }),
    ).toEqual(defaulted);
    expect(rebuilt.listThreads(ownerId, 0n, 10)).toHaveLength(4);
  } finally {
    database.close();
  }
});

it('rolls back a new delegated Thread when interaction acceptance fails', () => {
  const { database, store } = fixture();
  try {
    const scope = delegation(store);
    const tables = ['threads', 'inputs', 'runs', 'interactions', 'thread_events'];
    const counts = () =>
      tables.map((table) => database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get());
    const before = counts();
    database.exec(`
      CREATE TRIGGER reject_thread_call_interaction
      BEFORE INSERT ON interactions WHEN NEW.kind = 'thread_call'
      BEGIN
        SELECT RAISE(ABORT, 'forced interaction failure');
      END;
    `);
    expect(() =>
      store.acceptThreadCall({
        ownerId,
        sourceThreadId: scope.main.threadId,
        sourceAgentId: 'thread',
        sourceRunId: scope.sourceRunId,
        sourceToolCallId: 'failed-new-thread-call',
        targetThreadId: '',
        title: '不能半创建',
        prompt: '首条委派',
        mode: 'follow_up',
      }),
    ).toThrow(/forced interaction failure/);
    expect(counts()).toEqual(before);
    expect(store.listThreads(ownerId, 0n, 10).some((thread) => thread.title === '不能半创建')).toBe(
      false,
    );
  } finally {
    database.close();
  }
});

it('converges concurrent main-thread lookups and reconstruction to one ID', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-main-thread-'));
  const path = join(directory, 'test.sqlite');
  const firstDatabase = openDatabase(path);
  const secondDatabase = openDatabase(path);
  try {
    const first = new SessionStore(firstDatabase);
    const second = new SessionStore(secondDatabase);
    seedTestTenant(firstDatabase, ownerId);
    const threads = await Promise.all(
      Array.from({ length: 20 }, (_value, index) =>
        Promise.resolve().then(() =>
          (index % 2 === 0 ? first : second).getOrCreateMainThread(ownerId),
        ),
      ),
    );
    expect(new Set(threads.map((thread) => thread.threadId)).size).toBe(1);
    expect(threads.every((thread) => thread.threadType === 'main')).toBe(true);
    const task = createThread(first);
    expect(task.threadType).toBe('task');
    expect(new SessionStore(firstDatabase).getOrCreateMainThread(ownerId).threadId).toBe(
      threads[0]?.threadId,
    );
    expect(
      firstDatabase
        .prepare(
          "SELECT COUNT(*) AS count FROM threads WHERE owner_id = ? AND thread_type = 'main'",
        )
        .get(ownerId),
    ).toEqual({ count: 1 });
  } finally {
    firstDatabase.close();
    secondDatabase.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('rejects a legacy Session schema before adding types or default Threads', () => {
  const database = openDatabase(':memory:');
  try {
    database.exec(`
      CREATE TABLE threads (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    database
      .prepare(
        'INSERT INTO threads(thread_id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('old-thread', ownerId, '旧会话', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
    database
      .prepare(
        'INSERT INTO schema_migrations(namespace, version, name, applied_at) VALUES (?, ?, ?, ?)',
      )
      .run('server_runtime', 6, 'device_log_sync_offset', '2026-11-02T00:00:00.000Z');
    expect(() => new SessionStore(database)).toThrow(/requires an explicit upgrade/);
    expect(database.prepare('PRAGMA table_info(threads)').all()).toHaveLength(6);
    expect(database.prepare('SELECT thread_id, title FROM threads').all()).toEqual([
      { thread_id: 'old-thread', title: '旧会话' },
    ]);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'interactions'",
        )
        .get(),
    ).toEqual({ count: 0 });
  } finally {
    database.close();
  }
});

it('associates multiple inputs in one Run with their exact responses', () => {
  const { database, store } = fixture();
  try {
    const scope = delegation(store);
    const base = {
      ownerId,
      sourceThreadId: scope.main.threadId,
      sourceAgentId: 'thread',
      sourceRunId: scope.sourceRunId,
      targetThreadId: scope.task.threadId,
    };
    const first = store.acceptThreadCall({
      ...base,
      sourceToolCallId: 'call-1',
      prompt: '第一组',
      mode: 'steer',
    });
    const second = store.acceptThreadCall({
      ...base,
      sourceToolCallId: 'call-2',
      prompt: '第二组',
      mode: 'follow_up',
    });
    const third = store.acceptThreadCall({
      ...base,
      sourceToolCallId: 'call-3',
      prompt: '尚未消费',
      mode: 'follow_up',
    });
    expect(first.runId).toBe(second.runId);
    expect(
      store.acceptThreadCall({
        ...base,
        sourceToolCallId: 'call-1',
        prompt: '第一组',
        mode: 'steer',
      }),
    ).toEqual(first);
    expect(() =>
      store.acceptThreadCall({
        ...base,
        sourceToolCallId: 'call-1',
        prompt: '冲突',
        mode: 'steer',
      }),
    ).toThrowError(expect.objectContaining({ code: 'action_conflict' }));

    for (const accepted of [first, second]) {
      store.appendModelMessage({
        runId: accepted.runId,
        inputId: accepted.input.inputId,
        message: { role: 'user', content: accepted.input.text },
      });
    }
    const firstResponse = store.appendModelMessage({
      runId: first.runId,
      message: { role: 'assistant', content: '第一组结果' },
    });
    store.recordInteractionResponses({
      runId: first.runId,
      messageId: firstResponse.messageId,
      interactionKeys: [first.interaction],
    });
    const secondResponse = store.appendModelMessage({
      runId: first.runId,
      message: { role: 'assistant', content: '第二组结果' },
    });
    expect(() =>
      store.recordInteractionResponses({
        runId: first.runId,
        messageId: secondResponse.messageId,
        interactionKeys: [third.interaction],
      }),
    ).toThrowError(expect.objectContaining({ code: 'failed_precondition' }));
    store.recordInteractionResponses({
      runId: first.runId,
      messageId: secondResponse.messageId,
      interactionKeys: [second.interaction],
    });

    const firstStored = store.getInteraction(ownerId, first.interaction);
    const secondStored = store.getInteraction(ownerId, second.interaction);
    expect(firstStored.responseMessageSeq).toBe(firstResponse.seq);
    expect(secondStored.responseMessageSeq).toBe(secondResponse.seq);
    expect(store.getInteractionResponse(ownerId, firstStored)?.message.content).toBe('第一组结果');
    expect(store.getInteractionResponse(ownerId, secondStored)?.message.content).toBe('第二组结果');
    expect(store.getInteraction(ownerId, third.interaction).responseMessageSeq).toBeNull();
    expect(store.listContext(ownerId, scope.main.threadId)).toEqual([]);
  } finally {
    database.close();
  }
});

it('isolates identical source tool call IDs by source Thread and Agent', () => {
  const { database, store } = fixture();
  try {
    const scope = delegation(store);
    const taskSourceRunId = store.sendMessage(
      action('SendMessage', 'task-source-run', {
        threadId: scope.task.threadId,
        text: '任务来源',
        mode: 'follow_up',
      }),
    ).runId;
    const mainInteraction = store.createSubagentInteraction({
      ownerId,
      sourceThreadId: scope.main.threadId,
      sourceAgentId: 'thread',
      sourceRunId: scope.sourceRunId,
      sourceToolCallId: 'shared-call',
      targetAgentId: 'subagent-main',
      prompt: '主对话委派',
      executionMode: 'background',
    });
    const taskInteraction = store.createSubagentInteraction({
      ownerId,
      sourceThreadId: scope.task.threadId,
      sourceAgentId: 'thread',
      sourceRunId: taskSourceRunId,
      sourceToolCallId: 'shared-call',
      targetAgentId: 'subagent-task',
      prompt: '任务 Thread 委派',
      executionMode: 'background',
    });
    expect(mainInteraction.targetAgentId).toBe('subagent-main');
    expect(taskInteraction.targetAgentId).toBe('subagent-task');
    expect(
      store.getInteractionForSource(ownerId, scope.main.threadId, 'thread', 'shared-call'),
    ).toEqual(mainInteraction);
    expect(
      store.getInteractionForSource(ownerId, scope.task.threadId, 'thread', 'shared-call'),
    ).toEqual(taskInteraction);
    expect(() =>
      store.getInteractionForSource(ownerId, scope.task.threadId, 'subagent-other', 'shared-call'),
    ).toThrowError(expect.objectContaining({ code: 'not_found' }));
    expect(
      store.createSubagentInteraction({
        ownerId,
        sourceThreadId: scope.main.threadId,
        sourceAgentId: 'thread',
        sourceRunId: scope.sourceRunId,
        sourceToolCallId: 'shared-call',
        targetAgentId: 'subagent-main',
        prompt: '主对话委派',
        executionMode: 'background',
      }),
    ).toEqual(mainInteraction);
  } finally {
    database.close();
  }
});

it('rejects general edits and removal for interaction target inputs without diverging state', () => {
  const { database, store } = fixture();
  try {
    const scope = delegation(store);
    const accepted = store.acceptThreadCall({
      ownerId,
      sourceThreadId: scope.main.threadId,
      sourceAgentId: 'thread',
      sourceRunId: scope.sourceRunId,
      sourceToolCallId: 'protected-target',
      targetThreadId: scope.task.threadId,
      prompt: '关联目标输入',
      mode: 'follow_up',
    });
    const edit = action('EditInput', 'protected-target-edit', {
      threadId: scope.task.threadId,
      inputId: accepted.input.inputId,
      text: '不允许的修改',
      expectedVersion: 1n,
    });
    const remove = action('RemoveInput', 'protected-target-remove', {
      threadId: scope.task.threadId,
      inputId: accepted.input.inputId,
      expectedVersion: 1n,
    });
    const attempts = (current: SessionStore) => [
      () => current.editInput(edit),
      () => current.removeInput(remove),
    ];
    for (const attempt of attempts(store)) {
      expect(attempt).toThrowError(expect.objectContaining({ code: 'failed_precondition' }));
    }
    const queueVersion = store.queueVersion(scope.task.threadId);
    const rebuilt = new SessionStore(database);
    for (const attempt of attempts(rebuilt)) {
      expect(attempt).toThrowError(expect.objectContaining({ code: 'failed_precondition' }));
    }
    expect(rebuilt.getInput(ownerId, accepted.input.inputId)).toMatchObject({
      text: '关联目标输入',
      status: 'queued',
      version: 1,
      delegation: delegationKey(accepted.interaction),
    });
    expect(rebuilt.queueVersion(scope.task.threadId)).toBe(queueVersion);
    expect(rebuilt.getInteraction(ownerId, accepted.interaction)).toMatchObject({
      status: 'queued',
      targetInputId: accepted.input.inputId,
      consumedRunId: null,
    });
    rebuilt.appendModelMessage({
      runId: accepted.runId,
      inputId: accepted.input.inputId,
      message: { role: 'user', content: accepted.input.text },
    });
    expect(rebuilt.getInteraction(ownerId, accepted.interaction).consumedRunId).toBe(
      accepted.runId,
    );
  } finally {
    database.close();
  }
});

it('keeps direct response delivery out of the ordinary input queue', () => {
  const { database, store } = fixture();
  try {
    const { main, accepted } = completedThreadCall(store);
    const key = delegationKey(accepted.interaction);
    const inputCount = store.listInputs(ownerId, main.threadId).length;
    const queueVersion = store.queueVersion(main.threadId);
    const delivered = store.enqueueInteractionDelivery({
      ownerId,
      key,
      text: '直接注入的后台结果',
    });
    if (delivered.runId === null) throw new Error('Expected a current interaction delivery.');
    expect(delivered.delivery).toMatchObject({
      content: '直接注入的后台结果',
      contextMessageSeq: null,
      runId: delivered.runId,
      status: 'queued',
    });
    expect(store.listInputs(ownerId, main.threadId)).toHaveLength(inputCount);
    expect(store.queueVersion(main.threadId)).toBe(queueVersion);

    const rebuilt = new SessionStore(database);
    const message = rebuilt.appendInteractionDeliveryMessage({
      runId: delivered.runId,
      key,
      message: { role: 'user', content: '直接注入的后台结果' },
    });
    expect(message.sourceInputId).toBeNull();
    expect(rebuilt.getInteractionDelivery(ownerId, key)).toMatchObject({
      status: 'consumed',
      contextMessageSeq: message.seq,
    });
    expect(rebuilt.listInputs(ownerId, main.threadId)).toHaveLength(inputCount);
    expect(rebuilt.queueVersion(main.threadId)).toBe(queueVersion);
  } finally {
    database.close();
  }
});

it('persists and deduplicates independent response delivery across reconstruction', () => {
  const { database, store } = fixture();
  try {
    const { main, task, accepted, response } = completedThreadCall(store);
    const key = delegationKey(accepted.interaction);
    expect(store.getInteractionResponse(ownerId, key)?.messageId).toBe(response.messageId);
    expect(store.getInteractionDelivery(ownerId, key).status).toBe('pending');
    const delivered = store.enqueueInteractionDelivery({
      ownerId,
      key,
      text: '交付：后台结果',
    });
    if (delivered.runId === null) throw new Error('Expected a current interaction delivery.');
    expect(delivered.delivery).toMatchObject({
      content: '交付：后台结果',
      runId: delivered.runId,
      status: 'queued',
    });
    expect(
      store.enqueueInteractionDelivery({ ownerId, key, text: '交付：后台结果' }),
    ).toMatchObject({
      runId: delivered.runId,
      delivery: { content: '交付：后台结果', status: 'queued' },
    });
    expect(() => store.enqueueInteractionDelivery({ ownerId, key, text: '不同内容' })).toThrowError(
      expect.objectContaining({ code: 'action_conflict' }),
    );

    const rebuilt = new SessionStore(database);
    expect(rebuilt.listUndeliveredInteractionDeliveries(ownerId)).toHaveLength(1);
    const message = rebuilt.appendInteractionDeliveryMessage({
      runId: delivered.runId,
      key,
      message: { role: 'user', content: '交付：后台结果' },
    });
    expect(message.source).toBe('thread_response');
    expect(message.delegation).toEqual(key);
    expect(message.sourceThreadId).toBe(task.threadId);
    expect(message.sourceInputId).toBeNull();
    expect(rebuilt.getInteractionDelivery(ownerId, key)).toMatchObject({
      status: 'consumed',
      contextMessageSeq: message.seq,
    });
    expect(
      rebuilt.appendInteractionDeliveryMessage({
        runId: delivered.runId,
        key,
        message: { role: 'user', content: '交付：后台结果' },
      }).seq,
    ).toBe(message.seq);
    expect(rebuilt.listUndeliveredInteractionDeliveries(ownerId)).toEqual([]);
    expect(rebuilt.listContext(ownerId, main.threadId).map((item) => item.message.content)).toEqual(
      ['交付：后台结果'],
    );
    expect(rebuilt.listContext(ownerId, task.threadId).map((item) => item.message.content)).toEqual(
      ['后台任务', '后台结果'],
    );
  } finally {
    database.close();
  }
});

it('suppresses queued background delivery when its source call is superseded', () => {
  const { database, store } = fixture();
  try {
    const main = store.getOrCreateMainThread(ownerId);
    seedLoadedTestWorkspace(store, main.threadId);
    seedLoadedTestWorkspace(store, main.threadId);
    const task = createThread(store);
    const source = store.sendMessage(
      action('SendMessage', 'background-source', {
        threadId: main.threadId,
        text: '来源问题',
        mode: 'follow_up',
      }),
    );
    const anchor = store.appendModelMessage({
      runId: source.runId,
      inputId: source.input.inputId,
      message: { role: 'user', content: source.input.text },
    });
    store.appendModelMessage({
      runId: source.runId,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'background-call', name: 'thread_call', arguments: {} }],
      },
    });
    const accepted = store.acceptThreadCall({
      ownerId,
      sourceThreadId: main.threadId,
      sourceAgentId: 'thread',
      sourceRunId: source.runId,
      sourceToolCallId: 'background-call',
      targetThreadId: task.threadId,
      prompt: '后台任务',
      mode: 'follow_up',
    });
    store.appendModelMessage({
      runId: accepted.runId,
      inputId: accepted.input.inputId,
      message: { role: 'user', content: accepted.input.text },
    });
    const response = store.appendModelMessage({
      runId: accepted.runId,
      message: { role: 'assistant', content: '后台回答' },
    });
    store.recordInteractionResponses({
      runId: accepted.runId,
      messageId: response.messageId,
      interactionKeys: [accepted.interaction],
    });
    store.updateRunStatus(source.runId, 'completed');
    const inputCount = store.listInputs(ownerId, main.threadId).length;
    const delivered = store.enqueueInteractionDelivery({
      ownerId,
      key: accepted.interaction,
      text: '待交付后台回答',
    });
    if (delivered.runId === null) throw new Error('Expected a queued delivery before Rerun.');
    store.updateRunStatus(delivered.runId, 'failed');

    store.rerun(
      action('Rerun', 'rerun-background-source', {
        threadId: main.threadId,
        messageId: anchor.messageId,
      }),
    );
    expect(store.getInteractionDelivery(ownerId, accepted.interaction).status).toBe('superseded');
    expect(store.listInputs(ownerId, main.threadId)).toHaveLength(inputCount);
    expect(store.getCurrentInteractionResponse(ownerId, accepted.interaction)).toBe(null);
    expect(store.getInteractionResponse(ownerId, accepted.interaction)?.messageId).toBe(
      response.messageId,
    );
    expect(
      store.enqueueInteractionDelivery({
        ownerId,
        key: accepted.interaction,
        text: '待交付后台回答',
      }),
    ).toMatchObject({ runId: null, delivery: { status: 'superseded' } });
    expect(
      store.context.query({ threadId: task.threadId, agentId: 'thread', currentOnly: true }),
    ).toHaveLength(2);
  } finally {
    database.close();
  }
});

it('cancels only the requested input or its actual shared consumption Run', () => {
  const { database, store } = fixture();
  try {
    const scope = delegation(store);
    const base = {
      ownerId,
      sourceThreadId: scope.main.threadId,
      sourceAgentId: 'thread',
      sourceRunId: scope.sourceRunId,
      targetThreadId: scope.task.threadId,
      mode: 'follow_up' as const,
    };
    const queued = store.acceptThreadCall({
      ...base,
      sourceToolCallId: 'queued-call',
      prompt: '排队取消',
    });
    const cancelled = store.requestInteractionCancel({
      ownerId,
      key: queued.interaction,
      reason: '停止排队输入',
    });
    expect(cancelled.interaction.status).toBe('cancelled');
    expect(cancelled.input?.status).toBe('cancelled');
    expect(cancelled.interaction.consumedRunId).toBeNull();
    expect(() => store.getInteraction('other-owner', queued.interaction)).toThrowError(
      expect.objectContaining({ code: 'permission_denied' }),
    );

    const failed = store.acceptThreadCall({
      ...base,
      sourceToolCallId: 'failed-before-consumption',
      prompt: '调度失败',
    });
    const failedInteraction = store.recordInteractionTerminal({
      ownerId,
      key: failed.interaction,
      status: 'failed',
      error: { code: 'internal', message: '调度失败', retryable: true },
    });
    expect(failedInteraction.responseMessageSeq).toBeNull();
    expect(failedInteraction.error?.message).toBe('调度失败');
    expect(store.getInput(ownerId, failed.input.inputId).status).toBe('cancelled');
    expect(store.getInteractionDelivery(ownerId, failedInteraction).status).toBe('pending');

    const first = store.acceptThreadCall({ ...base, sourceToolCallId: 'shared-1', prompt: '一' });
    const second = store.acceptThreadCall({ ...base, sourceToolCallId: 'shared-2', prompt: '二' });
    for (const accepted of [first, second]) {
      store.appendModelMessage({
        runId: accepted.runId,
        inputId: accepted.input.inputId,
        message: { role: 'user', content: accepted.input.text },
      });
    }
    store.updateRunStatus(first.runId, 'running');
    const requested = store.requestInteractionCancel({
      ownerId,
      key: first.interaction,
      reason: '停止共享 Run',
    });
    expect(requested.run?.runId).toBe(first.runId);
    expect(requested.run?.status).toBe('cancel_requested');
    expect(store.getInteraction(ownerId, first.interaction).status).toBe('cancel_requested');
    expect(store.getInteraction(ownerId, second.interaction).status).toBe('cancel_requested');
  } finally {
    database.close();
  }
});

it('marks consumed interactions interrupted on recovery without inventing responses', () => {
  const { database, store } = fixture();
  try {
    const scope = delegation(store);
    const accepted = store.acceptThreadCall({
      ownerId,
      sourceThreadId: scope.main.threadId,
      sourceAgentId: 'thread',
      sourceRunId: scope.sourceRunId,
      sourceToolCallId: 'recover-call',
      targetThreadId: scope.task.threadId,
      prompt: '中断任务',
      mode: 'follow_up',
    });
    store.appendModelMessage({
      runId: accepted.runId,
      inputId: accepted.input.inputId,
      message: { role: 'user', content: accepted.input.text },
    });
    store.updateRunStatus(accepted.runId, 'running');
    const rebuilt = new SessionStore(database);
    rebuilt.recoverInterrupted();
    const recovered = rebuilt.getInteraction(ownerId, accepted.interaction);
    expect(recovered.status).toBe('interrupted');
    expect(recovered.responseMessageSeq).toBeNull();
    expect(recovered.error?.code).toBe('operation_unknown');
    expect(rebuilt.getInteractionDelivery(ownerId, recovered).status).toBe('pending');
  } finally {
    database.close();
  }
});

it('persists Subagent execution mode and only delivers background results', () => {
  const { database, store } = fixture();
  try {
    const { main, sourceRunId } = delegation(store);
    for (const executionMode of ['foreground', 'background'] as const) {
      const interaction = store.createSubagentInteraction({
        ownerId,
        sourceThreadId: main.threadId,
        sourceAgentId: 'thread',
        sourceRunId,
        sourceToolCallId: `subagent-${executionMode}`,
        targetAgentId: `subagent-${executionMode}`,
        prompt: executionMode,
        executionMode,
      });
      expect(
        store.createSubagentInteraction({
          ownerId,
          sourceThreadId: main.threadId,
          sourceAgentId: 'thread',
          sourceRunId,
          sourceToolCallId: `subagent-${executionMode}`,
          targetAgentId: `subagent-retry-${executionMode}`,
          prompt: executionMode,
          executionMode,
        }),
      ).toEqual(interaction);
      const run = store.createChildRun(
        ownerId,
        sourceRunId,
        interaction.targetAgentId,
        executionMode,
      );
      store.startSubagentInteraction(ownerId, interaction, run.runId);
      store.appendModelMessage({
        runId: run.runId,
        message: { role: 'user', content: interaction.prompt },
      });
      const response = store.appendModelMessage({
        runId: run.runId,
        message: { role: 'assistant', content: `${executionMode} 结果` },
      });
      store.recordInteractionResponses({
        runId: run.runId,
        messageId: response.messageId,
        interactionKeys: [interaction],
      });
      if (executionMode === 'foreground') {
        expect(() => store.getInteractionDelivery(ownerId, interaction)).toThrowError(
          expect.objectContaining({ code: 'not_found' }),
        );
      } else {
        expect(store.getInteractionDelivery(ownerId, interaction).status).toBe('pending');
      }
    }
    const pending = store.createSubagentInteraction({
      ownerId,
      sourceThreadId: main.threadId,
      sourceAgentId: 'thread',
      sourceRunId,
      sourceToolCallId: 'subagent-not-started',
      targetAgentId: 'subagent-not-started',
      prompt: '尚未启动',
      executionMode: 'background',
    });
    const cancelled = store.requestInteractionCancel({
      ownerId,
      key: pending,
      reason: '启动前取消',
    });
    expect(cancelled.interaction.status).toBe('cancelled');
    expect(store.getInteractionDelivery(ownerId, pending).status).toBe('pending');
  } finally {
    database.close();
  }
});

it('routes root inputs away from a running background Subagent after its parent finishes', () => {
  const { database, store } = fixture();
  try {
    const { main, sourceRunId } = delegation(store);
    const interaction = store.createSubagentInteraction({
      ownerId,
      sourceThreadId: main.threadId,
      sourceAgentId: 'thread',
      sourceRunId,
      sourceToolCallId: 'background-routing',
      targetAgentId: 'subagent-background',
      prompt: '后台任务',
      executionMode: 'background',
    });
    const childRun = store.createChildRun(
      ownerId,
      sourceRunId,
      interaction.targetAgentId,
      'background',
    );
    store.startSubagentInteraction(ownerId, interaction, childRun.runId);
    store.appendModelMessage({
      runId: childRun.runId,
      message: { role: 'user', content: interaction.prompt },
    });
    store.updateRunStatus(sourceRunId, 'running');

    const steered = store.sendMessage(
      action('SendMessage', 'active-root-steer', {
        threadId: main.threadId,
        text: '活动根 Run 输入',
        mode: 'steer',
      }),
    );
    expect(steered.runId).toBe(sourceRunId);
    store.appendModelMessage({
      runId: sourceRunId,
      inputId: steered.input.inputId,
      message: { role: 'user', content: steered.input.text },
    });

    const response = store.appendModelMessage({
      runId: childRun.runId,
      message: { role: 'assistant', content: '后台结果' },
    });
    store.recordInteractionResponses({
      runId: childRun.runId,
      messageId: response.messageId,
      interactionKeys: [interaction],
    });
    store.updateRunStatus(sourceRunId, 'completed');
    expect(store.getRunById(childRun.runId).status).toBe('running');

    const sent = store.sendMessage(
      action('SendMessage', 'new-root-follow-up', {
        threadId: main.threadId,
        text: '新的用户输入',
        mode: 'follow_up',
      }),
    );
    expect(sent.runId).not.toBe(sourceRunId);
    expect(sent.runId).not.toBe(childRun.runId);
    expect(store.getRunById(sent.runId)).toMatchObject({
      threadId: main.threadId,
      agentId: 'thread',
      parentRunId: null,
      status: 'queued',
    });

    const delivered = store.enqueueInteractionDelivery({
      ownerId,
      key: interaction,
      text: '交付：后台结果',
    });
    if (delivered.runId === null) throw new Error('Expected a current interaction delivery.');
    expect(delivered.runId).toBe(sent.runId);
    expect(delivered.delivery).toMatchObject({
      content: '交付：后台结果',
      runId: sent.runId,
      status: 'queued',
    });
    expect(store.getInteractionDelivery(ownerId, interaction)).toMatchObject({
      replyThreadId: main.threadId,
      content: '交付：后台结果',
      runId: sent.runId,
      status: 'queued',
    });

    const userMessage = store.appendModelMessage({
      runId: sent.runId,
      inputId: sent.input.inputId,
      message: { role: 'user', content: sent.input.text },
    });
    expect(userMessage).toMatchObject({ runId: sent.runId, agentId: 'thread' });
    const deliveredMessage = store.appendInteractionDeliveryMessage({
      runId: sent.runId,
      key: interaction,
      message: { role: 'user', content: '交付：后台结果' },
    });
    expect(deliveredMessage).toMatchObject({
      runId: sent.runId,
      agentId: 'thread',
      source: 'subagent_response',
      sourceThreadId: main.threadId,
      sourceAgentId: interaction.targetAgentId,
      delegation: delegationKey(interaction),
    });
    expect(store.getInteractionDelivery(ownerId, interaction).status).toBe('consumed');
    expect(store.getRunById(childRun.runId).status).toBe('running');
  } finally {
    database.close();
  }
});

it('rolls back Thread-call input and Run when interaction persistence fails', () => {
  const { database, store } = fixture();
  try {
    const scope = delegation(store);
    database.exec('DROP TABLE interactions');
    expect(() =>
      store.acceptThreadCall({
        ownerId,
        sourceThreadId: scope.main.threadId,
        sourceAgentId: 'thread',
        sourceRunId: scope.sourceRunId,
        sourceToolCallId: 'failed-call',
        targetThreadId: scope.task.threadId,
        prompt: '不能部分接受',
        mode: 'follow_up',
      }),
    ).toThrow();
    expect(store.listQueuedInputs(scope.task.threadId)).toEqual([]);
    expect(store.getActiveRun(scope.task.threadId)).toBeUndefined();
  } finally {
    database.close();
  }
});
