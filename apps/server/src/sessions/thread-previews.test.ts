import { expect, it, vi } from 'vitest';
import { seedLoadedTestWorkspace, seedTestTenant } from '../integration/environment-fixture.js';
import { openDatabase } from '../storage/database.js';
import { SessionStore } from './store.js';
import type { ThreadCardSort } from './thread-previews.js';
import {
  listThreadCallPreviews,
  listThreadCards,
  threadPreviewTextLimit,
} from './thread-previews.js';

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

function createThread(store: SessionStore, id: string, title: string) {
  const thread = store.createThread(action('CreateThread', id, { title }));
  seedLoadedTestWorkspace(store, thread.threadId);
  return thread;
}

function uploadText(store: SessionStore, id: string, fileName: string, body: string) {
  return store.attachments.upload({
    ownerId,
    clientActionId: id,
    fileName,
    declaredMediaType: 'text/plain',
    bytes: new TextEncoder().encode(body),
  }).attachment;
}

function appendDirect(
  store: SessionStore,
  threadId: string,
  id: string,
  question: string,
  answer: string,
) {
  const sent = store.sendMessage(
    action('SendMessage', id, { threadId, text: question, mode: 'follow_up' }),
  );
  const user = store.appendModelMessage({
    runId: sent.runId,
    inputId: sent.input.inputId,
    message: { role: 'user', content: question },
  });
  const assistant = store.appendModelMessage({
    runId: sent.runId,
    message: { role: 'assistant', content: answer },
  });
  return { sent, user, assistant };
}

function collectCardIds(store: SessionStore, sort: ThreadCardSort) {
  const ids: string[] = [];
  let cursor: Parameters<typeof listThreadCards>[2]['cursor'];
  for (let page = 0; page < 10; page += 1) {
    const result = listThreadCards(store, ownerId, {
      sort,
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...result.cards.map((card) => card.thread.threadId));
    if (!result.hasMore || !result.nextCursor) {
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
      return ids;
    }
    cursor = result.nextCursor;
  }
  throw new Error('Thread card pagination did not finish.');
}

it('returns cards for explicit thread ids including workspace mains', () => {
  const { database, store, advance } = fixture();
  try {
    store.getOrCreateMainThread(ownerId);
    const task = createThread(store, 'create-task', '任务话题');
    appendDirect(store, task.threadId, 'send-task', '任务问题', '任务回答');
    const workspace = store.createWorkspace({
      ownerId,
      name: '空间一',
      envId: 'main',
      path: '/srv/one',
    });
    appendDirect(store, workspace.mainThread.threadId, 'send-ws', '空间问题', '空间回答');
    createThread(store, 'create-other', '未请求话题');
    advance(1000);

    const result = listThreadCards(store, ownerId, {
      sort: 'last_message_at',
      limit: 10,
      threadIds: [workspace.mainThread.threadId, task.threadId],
    });
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.cards.map((card) => card.thread.threadId)).toEqual([
      task.threadId,
      workspace.mainThread.threadId,
    ]);
    const mainCard = result.cards.find(
      (card) => card.thread.threadId === workspace.mainThread.threadId,
    );
    expect(mainCard?.thread.threadType).toBe('workspace_main');
    expect(mainCard?.messages.map((message) => message.text)).toEqual(['空间问题', '空间回答']);

    const foreign = listThreadCards(store, 'other-owner', {
      sort: 'last_message_at',
      limit: 10,
      threadIds: [task.threadId],
    });
    expect(foreign.cards).toEqual([]);
  } finally {
    database.close();
  }
});

it('falls back to the send_to_user content when the response text is empty', () => {
  const { database, store } = fixture();
  try {
    store.getOrCreateMainThread(ownerId);
    const thread = createThread(store, 'create-silent', '静默话题');
    const sent = store.sendMessage(
      action('SendMessage', 'send-silent', {
        threadId: thread.threadId,
        text: '开始',
        mode: 'follow_up',
      }),
    );
    store.appendModelMessage({
      runId: sent.runId,
      inputId: sent.input.inputId,
      message: { role: 'user', content: '开始' },
    });
    store.appendModelMessage({
      runId: sent.runId,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'stu-1',
            name: 'send_to_user',
            arguments: { content: '只发给用户的消息', end_turn: true },
          },
        ],
      },
    });
    store.appendModelMessage({
      runId: sent.runId,
      message: {
        role: 'tool',
        content: JSON.stringify({ status: 'sent', content: '只发给用户的消息', end_turn: true }),
        tool_call_id: 'stu-1',
        tool_name: 'send_to_user',
      },
    });
    store.appendModelMessage({
      runId: sent.runId,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'bash-1', name: 'bash', arguments: { command: 'ls' } }],
      },
    });
    store.appendModelMessage({
      runId: sent.runId,
      message: {
        role: 'tool',
        content: '{"status":"completed"}',
        tool_call_id: 'bash-1',
        tool_name: 'bash',
      },
    });
    store.appendModelMessage({
      runId: sent.runId,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'stu-2',
            name: 'send_to_user',
            arguments: { content: '第二条用户消息', end_turn: true },
          },
        ],
      },
    });
    store.appendModelMessage({
      runId: sent.runId,
      message: {
        role: 'tool',
        content: JSON.stringify({ status: 'sent', content: '第二条用户消息', end_turn: true }),
        tool_call_id: 'stu-2',
        tool_name: 'send_to_user',
      },
    });

    const card = listThreadCards(store, ownerId, {
      sort: 'last_message_at',
      limit: 4,
      threadIds: [thread.threadId],
    }).cards[0];
    expect(card?.messages.map((message) => message.text)).toEqual([
      '开始',
      '只发给用户的消息',
      '第二条用户消息',
    ]);
  } finally {
    database.close();
  }
});

it('lists only task cards with stable sorting, bounded text and immutable message times', () => {
  const { database, store, advance } = fixture();
  try {
    store.getOrCreateMainThread(ownerId);
    const first = createThread(store, 'create-first', '第一话题');
    advance(1000);
    const second = createThread(store, 'create-second', '第二话题');
    const third = createThread(store, 'create-third', '第三话题');
    advance(1000);

    let longMessageId = '';
    let lastMessageAt = '';
    for (let index = 1; index <= 4; index += 1) {
      const sent = store.sendMessage(
        action('SendMessage', `send-first-${index}`, {
          threadId: first.threadId,
          text: `问题 ${index}`,
          mode: 'follow_up',
        }),
      );
      store.appendModelMessage({
        runId: sent.runId,
        inputId: sent.input.inputId,
        message: { role: 'user', content: `问题 ${index}` },
      });
      if (index < 4) {
        store.appendModelMessage({
          runId: sent.runId,
          message: { role: 'assistant', content: `回答 ${index}` },
        });
        continue;
      }
      const longText = '长'.repeat(threadPreviewTextLimit + 60);
      const longMessage = store.appendModelMessage({
        runId: sent.runId,
        message: {
          role: 'assistant',
          content: longText,
          content_blocks: [
            { type: 'thinking', block_index: 0, text: 'SECRET_THINKING' },
            { type: 'text', block_index: 1, text: longText },
          ],
          tool_calls: [
            { id: 'card-tool', name: 'read', arguments: { path: 'SECRET_TOOL_ARGUMENT' } },
          ],
        },
      });
      longMessageId = longMessage.messageId;
      lastMessageAt = longMessage.createdAt;
      store.appendModelMessage({
        runId: sent.runId,
        message: {
          role: 'tool',
          content: 'SECRET_TOOL_LOG',
          tool_call_id: 'card-tool',
          tool_name: 'read',
        },
      });
    }
    appendDirect(store, third.threadId, 'send-third', '第三问题', '第三回答');

    expect(collectCardIds(store, 'created_at')).toEqual([
      second.threadId,
      third.threadId,
      first.threadId,
    ]);
    const expectedActivityOrder = [first.threadId, third.threadId, second.threadId];
    expect(collectCardIds(store, 'last_message_at')).toEqual(expectedActivityOrder);
    expect(
      listThreadCards(store, ownerId, { sort: 'last_message_at', limit: 4 }).cards.map(
        (card) => card.thread.threadId,
      ),
    ).toEqual(expectedActivityOrder);
    expect(listThreadCards(store, 'other-owner', { sort: 'created_at', limit: 4 }).cards).toEqual(
      [],
    );

    const initial = listThreadCards(store, ownerId, { sort: 'last_message_at', limit: 4 });
    const firstCard = initial.cards.find((card) => card.thread.threadId === first.threadId);
    const emptyCard = initial.cards.find((card) => card.thread.threadId === second.threadId);
    expect(firstCard?.messages.map((message) => message.text)).toEqual([
      '回答 3',
      '问题 4',
      '长'.repeat(threadPreviewTextLimit),
    ]);
    expect(firstCard?.messages.at(-1)?.textTruncated).toBe(true);
    expect(firstCard?.lastMessageAt).toBe(lastMessageAt);
    expect(firstCard?.sourceCall).toBeNull();
    expect(emptyCard?.lastMessageAt).toBeNull();
    expect(emptyCard?.messages).toEqual([]);
    expect(JSON.stringify(firstCard)).not.toContain('SECRET_THINKING');
    expect(JSON.stringify(firstCard)).not.toContain('SECRET_TOOL_ARGUMENT');
    expect(JSON.stringify(firstCard)).not.toContain('SECRET_TOOL_LOG');

    advance(10_000);
    store.renameThread(
      action('RenameThread', 'rename-first', { threadId: first.threadId, title: '第一话题新名' }),
    );
    store.context.revise({
      threadId: first.threadId,
      agentId: 'thread',
      seq: Number(store.getContextMessage(ownerId, first.threadId, longMessageId).seq),
      content: '修订后的正文',
    });
    const revised = listThreadCards(store, ownerId, { sort: 'last_message_at', limit: 4 });
    const revisedCard = revised.cards.find((card) => card.thread.threadId === first.threadId);
    expect(revisedCard?.thread.title).toBe('第一话题新名');
    expect(revisedCard?.lastMessageAt).toBe(lastMessageAt);
    expect(revisedCard?.messages.at(-1)).toMatchObject({
      text: '修订后的正文',
      textTruncated: false,
    });
    expect(revised.cards.map((card) => card.thread.threadId)).toEqual(expectedActivityOrder);
  } finally {
    database.close();
  }
});

it('projects batched call intervals and exact shared responses across a source Rerun', () => {
  const { database, store } = fixture();
  try {
    const main = store.getOrCreateMainThread(ownerId);
    seedLoadedTestWorkspace(store, main.threadId);
    const task = createThread(store, 'create-target', '委派话题');
    const source = store.sendMessage(
      action('SendMessage', 'source-input', {
        threadId: main.threadId,
        text: '发起话题',
        mode: 'follow_up',
      }),
    );
    const sourceAnchor = store.appendModelMessage({
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
          { id: 'call-1', name: 'thread_call', arguments: { prompt: 'SECRET_PROMPT_1' } },
          { id: 'call-2', name: 'thread_call', arguments: { prompt: 'SECRET_PROMPT_2' } },
          { id: 'call-3', name: 'thread_call', arguments: { prompt: 'SECRET_PROMPT_3' } },
        ],
      },
    });
    const base = {
      ownerId,
      sourceThreadId: main.threadId,
      sourceAgentId: 'thread',
      sourceRunId: source.runId,
      targetThreadId: task.threadId,
      mode: 'follow_up' as const,
    };
    const first = store.acceptThreadCall({
      ...base,
      sourceToolCallId: 'call-1',
      prompt: '第一段委派 prompt',
    });
    const second = store.acceptThreadCall({
      ...base,
      sourceToolCallId: 'call-2',
      prompt: '第二段委派 prompt',
    });
    const third = store.acceptThreadCall({
      ...base,
      sourceToolCallId: 'call-3',
      prompt: '等待消费的 prompt',
    });
    store.appendModelMessage({
      runId: first.runId,
      inputId: first.input.inputId,
      message: { role: 'user', content: first.input.text },
    });
    for (let index = 1; index <= 4; index += 1) {
      store.appendModelMessage({
        runId: first.runId,
        message: { role: 'assistant', content: `第一段回复 ${index}` },
      });
    }
    const callFirst = uploadText(store, 'call-upload-first', 'call-first.txt', 'SECRET_CALL_FIRST');
    const callSecond = uploadText(
      store,
      'call-upload-second',
      'call-second.txt',
      'SECRET_CALL_SECOND',
    );
    const attachmentInput = store.sendMessage(
      action('SendMessage', 'call-attachments', {
        threadId: task.threadId,
        text: '',
        mode: 'follow_up',
        attachmentIds: [callSecond.attachmentId, callFirst.attachmentId],
      }),
    );
    store.appendModelMessage({
      runId: attachmentInput.runId,
      inputId: attachmentInput.input.inputId,
      message: { role: 'user', content: '' },
    });
    store.appendModelMessage({
      runId: second.runId,
      inputId: second.input.inputId,
      message: { role: 'user', content: second.input.text },
    });
    const shared = store.appendModelMessage({
      runId: first.runId,
      message: { role: 'assistant', content: '共享 response' },
    });
    store.recordInteractionResponses({
      runId: first.runId,
      messageId: shared.messageId,
      interactionKeys: [first.interaction],
    });

    const getThread = vi.spyOn(store, 'getThread');
    const initial = listThreadCallPreviews(store, ownerId, [
      second.interaction,
      {
        sourceThreadId: main.threadId,
        sourceAgentId: 'thread',
        sourceToolCallId: 'missing-call',
      },
      first.interaction,
      third.interaction,
    ]);
    expect(getThread).not.toHaveBeenCalled();
    getThread.mockRestore();
    expect(initial.map((preview) => preview.call.delegation.sourceToolCallId)).toEqual([
      'call-2',
      'call-1',
      'call-3',
    ]);
    expect(initial[0]).toMatchObject({ replyCount: 0, replies: [], responseMessageSeq: null });
    expect(initial[1]).toMatchObject({
      replyCount: 6,
      responseMessageSeq: shared.seq,
      call: {
        sourceMessageId: sourceCall.messageId,
        sourceMessageSeq: sourceCall.seq,
      },
    });
    expect(initial[1]?.replies.map((message) => message.text)).toEqual([
      '第一段回复 4',
      '',
      '共享 response',
    ]);
    expect(initial[1]?.replies[1]?.attachments.map((item) => item.attachmentId)).toEqual([
      callSecond.attachmentId,
      callFirst.attachmentId,
    ]);
    expect(initial[1]?.replies[2]?.attachments).toEqual([]);
    expect(initial[2]).toMatchObject({
      status: 'queued',
      replyCount: 0,
      replies: [],
      responseMessageSeq: null,
    });
    expect(JSON.stringify(initial)).not.toContain('SECRET_PROMPT');
    expect(JSON.stringify(initial)).not.toContain('委派 prompt');
    expect(JSON.stringify(initial)).not.toContain('SECRET_CALL_FIRST');
    expect(JSON.stringify(initial)).not.toContain('SECRET_CALL_SECOND');

    store.recordInteractionResponses({
      runId: second.runId,
      messageId: shared.messageId,
      interactionKeys: [second.interaction],
    });
    const sharedPreviews = listThreadCallPreviews(store, ownerId, [
      first.interaction,
      second.interaction,
    ]);
    expect(sharedPreviews[0]?.responseMessageSeq).toBe(shared.seq);
    expect(sharedPreviews[1]).toMatchObject({
      replyCount: 1,
      responseMessageSeq: shared.seq,
    });
    expect(sharedPreviews[1]?.replies.map((message) => message.text)).toEqual(['共享 response']);
    expect(sharedPreviews[1]?.replies[0]?.attachments).toEqual([]);

    const card = listThreadCards(store, ownerId, { sort: 'last_message_at', limit: 4 }).cards[0];
    expect(card?.sourceCall).toMatchObject({
      sourceMessageId: sourceCall.messageId,
      sourceMessageSeq: sourceCall.seq,
      delegation: { sourceToolCallId: 'call-1' },
    });
    expect(card?.lastMessageAt).toBe(shared.createdAt);
    expect(card?.messages.map((message) => message.text)).toEqual([
      '第一段回复 4',
      '',
      '共享 response',
    ]);
    expect(card?.messages[1]?.attachments.map((item) => item.attachmentId)).toEqual([
      callSecond.attachmentId,
      callFirst.attachmentId,
    ]);

    store.updateRunStatus(source.runId, 'completed');
    store.rerun(
      action('Rerun', 'rerun-source', {
        threadId: main.threadId,
        messageId: sourceAnchor.messageId,
      }),
    );
    expect(listThreadCallPreviews(store, ownerId, [first.interaction, second.interaction])).toEqual(
      [],
    );
    expect(listThreadCallPreviews(store, 'other-owner', [first.interaction])).toEqual([]);
    const sourceRerunCard = listThreadCards(store, ownerId, {
      sort: 'last_message_at',
      limit: 4,
    }).cards[0];
    expect(sourceRerunCard?.sourceCall).toBeNull();
  } finally {
    database.close();
  }
});

it('projects attachment-only messages with ordered metadata across revision and rerun', () => {
  const { database, store } = fixture();
  try {
    store.getOrCreateMainThread(ownerId);
    const first = uploadText(store, 'upload-first', 'first.txt', 'SECRET_FIRST_BODY');
    const second = uploadText(store, 'upload-second', 'second.txt', 'SECRET_SECOND_BODY');
    const created = store.createThread(
      action('CreateThread', 'create-with-attachments', {
        title: '附件话题',
        initialText: '',
        initialMode: 'follow_up' as const,
        attachmentIds: [second.attachmentId, first.attachmentId],
      }),
    );
    if (!('input' in created)) throw new Error('Missing initial attachment input.');
    seedLoadedTestWorkspace(store, created.thread.threadId);
    store.agentEnvironments.bindExecutionResources(
      store.getRunById(created.runId),
      store.agentEnvironments.requirePolicy(created.thread.threadId, 'thread'),
    );
    const anchor = store.appendModelMessage({
      runId: created.runId,
      inputId: created.input.inputId,
      message: { role: 'user', content: '' },
    });

    const getThread = vi.spyOn(store, 'getThread');
    const prepare = vi.spyOn(store.database, 'prepare');
    const initial = listThreadCards(store, ownerId, { sort: 'last_message_at', limit: 4 });
    expect(getThread).not.toHaveBeenCalled();
    const attachmentQueries = prepare.mock.calls.filter(([sql]) =>
      sql.includes('context_message_attachments'),
    );
    expect(attachmentQueries).toHaveLength(1);
    expect(attachmentQueries[0]?.[0]).not.toContain('attachment.content');
    getThread.mockRestore();
    prepare.mockRestore();

    const preview = initial.cards[0]?.messages[0];
    expect(preview).toMatchObject({ messageId: anchor.messageId, text: '', textTruncated: false });
    expect(preview?.attachments.map((attachment) => attachment.attachmentId)).toEqual([
      second.attachmentId,
      first.attachmentId,
    ]);
    expect(preview?.attachments[0]).toMatchObject({
      fileName: 'second.txt',
      mediaType: 'text/plain',
      byteSize: second.byteSize,
      sha256: second.sha256,
    });
    expect(JSON.stringify(preview)).not.toContain('SECRET_FIRST_BODY');
    expect(JSON.stringify(preview)).not.toContain('SECRET_SECOND_BODY');
    expect(JSON.stringify(preview)).not.toContain('owner_id');

    store.context.revise({
      threadId: created.thread.threadId,
      agentId: 'thread',
      seq: anchor.seq,
      content: '修订后的附件说明',
    });
    store.updateRunStatus(created.runId, 'completed');
    store.rerun(
      action('Rerun', 'rerun-attachment-anchor', {
        threadId: created.thread.threadId,
        messageId: anchor.messageId,
      }),
    );
    const afterRerunGetThread = vi.spyOn(store, 'getThread');
    const afterRerun = listThreadCards(store, ownerId, { sort: 'last_message_at', limit: 4 });
    expect(afterRerunGetThread).not.toHaveBeenCalled();
    afterRerunGetThread.mockRestore();
    expect(afterRerun.cards[0]?.messages[0]).toMatchObject({
      messageId: anchor.messageId,
      text: '修订后的附件说明',
    });
    expect(afterRerun.cards[0]?.messages[0]?.attachments.map((item) => item.attachmentId)).toEqual([
      second.attachmentId,
      first.attachmentId,
    ]);
  } finally {
    database.close();
  }
});

it('projects exact Subagent call identities with equal prompts, authorization and current-view filtering', async () => {
  const { database, store } = fixture();
  const { listSubagentCallViews } = await import('./thread-previews.js');
  try {
    const main = store.getOrCreateMainThread(ownerId);
    seedLoadedTestWorkspace(store, main.threadId);
    const sent = store.sendMessage(
      action('SendMessage', 'start-agents', {
        threadId: main.threadId,
        text: '并行检查',
        mode: 'follow_up',
      }),
    );
    const anchor = store.appendModelMessage({
      runId: sent.runId,
      inputId: sent.input.inputId,
      message: { role: 'user', content: '并行检查' },
    });
    store.appendModelMessage({
      runId: sent.runId,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'agent-a', name: 'subagent', arguments: { task: '相同任务', mode: 'foreground' } },
          { id: 'agent-b', name: 'subagent', arguments: { task: '相同任务', mode: 'background' } },
        ],
      },
    });
    const keys = ['agent-a', 'agent-b'].map((sourceToolCallId) => ({
      sourceThreadId: main.threadId,
      sourceAgentId: 'thread',
      sourceToolCallId,
    }));
    for (const [index, key] of keys.entries()) {
      const mode = index === 0 ? 'foreground' : 'background';
      store.createSubagentInteraction({
        ownerId,
        ...key,
        sourceRunId: sent.runId,
        targetAgentId: `subagent-${index}`,
        prompt: '相同任务',
        executionMode: mode,
      });
      const run = store.createChildRun(ownerId, sent.runId, `subagent-${index}`, mode);
      store.startSubagentInteraction(ownerId, key, run.runId);
      store.appendModelMessage({
        runId: run.runId,
        message: { role: 'user', content: '相同任务' },
      });
    }
    const views = listSubagentCallViews(store, ownerId, keys);
    expect(views.map((view) => view.agentId)).toEqual(['subagent-0', 'subagent-1']);
    expect(views.map((view) => view.executionMode)).toEqual(['foreground', 'background']);
    expect(new Set(views.map((view) => view.runId)).size).toBe(2);
    expect(() => listSubagentCallViews(store, 'other-owner', keys)).toThrow('owner');
    expect(() =>
      listSubagentCallViews(
        store,
        ownerId,
        Array.from({ length: 101 }, () => ({
          sourceThreadId: main.threadId,
          sourceAgentId: 'thread',
          sourceToolCallId: 'agent-a',
        })),
      ),
    ).toThrow('Too many');
    store.updateRunStatus(sent.runId, 'completed');
    store.rerun(
      action('Rerun', 'branch-agents', { threadId: main.threadId, messageId: anchor.messageId }),
    );
    expect(listSubagentCallViews(store, ownerId, keys)).toEqual([]);
    expect(store.listContext(ownerId, main.threadId, 'subagent-0')).toHaveLength(1);
  } finally {
    database.close();
  }
});
