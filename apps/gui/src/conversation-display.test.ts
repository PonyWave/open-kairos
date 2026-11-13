import { createRouterTransport } from '@connectrpc/connect';
import {
  ContentBlockSchema,
  ContentBlockType,
  create,
  type Message,
  MessageRole,
  MessageSchema,
  MessageSource,
  RunSchema,
  RunStatus,
  ToolCallSchema,
  ToolResultStatus,
} from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { scopedStorage } from './account-storage.js';
import type { StorageLike } from './actions.js';
import { createKairosClients } from './client.js';
import { loadConversationDisplay, saveConversationDisplay } from './conversation-display.js';
import { projectConversationDisplay } from './conversation-display-projection.js';
import {
  conversationHistoryStartIndex,
  conversationTurnStarts,
  initialHiddenTurnCount,
} from './conversation-history.js';
import { MessageCard } from './message-card.js';
import { type ConversationItem, projectConversation } from './response-projection.js';
import { sentUserMessage } from './sent-user-message.js';
import { SentUserMessageCard } from './sent-user-message-card.js';
import { ConversationDisplaySettings, settingsSectionFromLocation } from './settings-page.js';
import { projectAssociatedToolResultIds, projectToolOutcomes } from './tool-group-projection.js';
import { workbenchLocation } from './workbench-navigation.js';

const threadId = 'main';
const runId = 'run';

function message(id: string, role: MessageRole, overrides: Partial<Message> = {}): Message {
  return Object.assign(
    create(MessageSchema, {
      messageId: id,
      threadId,
      agentId: 'thread',
      runId,
      role,
      content: id,
    }),
    overrides,
  );
}

function sendResult(id = 'sent', overrides: Partial<Message> = {}): Message {
  return message(id, MessageRole.TOOL, {
    toolName: 'send_to_user',
    toolCallId: 'send-1',
    toolStatus: ToolResultStatus.SUCCESS,
    content: JSON.stringify({ status: 'sent', content: '**正式回复**', end_turn: true }),
    sendToUserEnabled: true,
    ...overrides,
  });
}

function call(id: string, name: string, input = {}): Message['toolCalls'][number] {
  return create(ToolCallSchema, {
    toolCallId: id,
    toolName: name,
    argumentsJson: JSON.stringify(input),
  });
}

function render(items: readonly ConversationItem[], messages: Message[]): string {
  const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
  const outcomes = projectToolOutcomes(messages);
  const associated = projectAssociatedToolResultIds(messages, outcomes);
  return items
    .map((item) =>
      item.kind === 'message'
        ? renderToStaticMarkup(
            createElement(MessageCard, {
              ...item.value,
              clients,
              busy: false,
              editing: false,
              thinkingExpansionChoices: {},
              toolExpansionChoices: {},
              toolOutcomes: outcomes,
              associatedToolResultIds: associated,
              mainThreadId: threadId,
              onThinkingExpansionChange: () => {},
              onStartEditing: () => {},
              onCancelEditing: () => {},
              onRevise: async () => {},
              onRerun: async () => {},
            }),
          )
        : '',
    )
    .join('');
}

function operationContents(items: readonly ConversationItem[]): string[] {
  return items.flatMap((item) =>
    item.kind === 'message'
      ? (item.value.toolItems ?? []).flatMap((tool) =>
          tool.kind === 'ordinary'
            ? tool.operations.map((operation) =>
                operation.kind === 'thinking' ? operation.text : operation.call.toolCallId,
              )
            : [],
        )
      : [],
  );
}

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe('conversation display settings', () => {
  it('defaults to compact and persists a separate preference for each account', () => {
    const local = new MemoryStorage();
    const first = scopedStorage(local, 'first');
    const second = scopedStorage(local, 'second');
    expect(loadConversationDisplay(first)).toEqual({ mode: 'compact', error: null });
    expect(saveConversationDisplay(first, 'full')).toEqual({ mode: 'full', error: null });
    expect(loadConversationDisplay(first).mode).toBe('full');
    expect(loadConversationDisplay(second).mode).toBe('compact');
    saveConversationDisplay(second, 'compact');
    expect(loadConversationDisplay(first).mode).toBe('full');
    expect([...local.values.keys()]).toEqual([
      'kairos.account.v1.first.kairos.conversation-display.v1',
      'kairos.account.v1.second.kairos.conversation-display.v1',
    ]);
  });

  it('reports storage failures while applying the selection only to the current account session', () => {
    const unavailable: StorageLike = {
      getItem: () => {
        throw new Error('read denied');
      },
      setItem: () => {
        throw new Error('write denied');
      },
      removeItem: () => {},
    };
    expect(loadConversationDisplay(unavailable)).toMatchObject({
      mode: 'compact',
      error: expect.stringContaining('无法读取'),
    });
    expect(saveConversationDisplay(unavailable, 'full')).toMatchObject({
      mode: 'full',
      error: expect.stringContaining('无法保存'),
    });
    expect(saveConversationDisplay(undefined, 'full').error).toContain('无法保存');
    expect(loadConversationDisplay(new MemoryStorage()).mode).toBe('compact');
  });

  it('provides a canonical display settings location and selected radio options', () => {
    expect(settingsSectionFromLocation('?view=settings&section=display')).toBe('display');
    expect(workbenchLocation('settings', null, threadId, 'display')).toBe(
      '?view=settings&section=display',
    );
    for (const mode of ['compact', 'full'] as const) {
      const html = renderToStaticMarkup(
        createElement(ConversationDisplaySettings, { mode, error: null, onChange: () => {} }),
      );
      expect(html).toContain('主对话展示模式');
      expect(html).toContain('精简视图');
      expect(html).toContain('完整视图');
      expect(html.match(/<input[^>]*checked=""[^>]*>/)?.[0]).toContain(`value="${mode}"`);
      expect(html).not.toContain('send_to_user');
    }
    const failed = renderToStaticMarkup(
      createElement(ConversationDisplaySettings, {
        mode: 'full',
        error: '无法保存显示设置',
        onChange: () => {},
      }),
    );
    expect(failed).toContain('role="alert"');
  });
});

describe('sent user messages', () => {
  it('gives consecutive sends one bubble each in both views while keeping every message paragraph together', () => {
    const contents = ['开始执行。\n\n正在检查现有配置。', '检查完成。\n\n修改已保存。'];
    for (const compact of [true, false]) {
      const html = contents
        .map((content, index) =>
          renderToStaticMarkup(
            createElement(SentUserMessageCard, {
              message: sendResult(`sent-${index}`, { toolCallId: `send-${index}` }),
              sent: { content, endTurn: index === 1, deliveries: [] },
              compact,
              continuation: index > 0,
            }),
          ),
        )
        .join('');
      expect(html.match(/data-user-message-call-id="send-[01]"/g)).toHaveLength(2);
      expect(html.match(/<article\b/g)).toHaveLength(2);
      expect(html.match(/<p>/g)).toHaveLength(4);
      expect(html.match(/class="sent-message-bubble"/g)).toHaveLength(2);
      expect(html).not.toContain('发送详情');
      if (compact) {
        expect(html).toContain(
          '<div class="sent-message-bubble"><div class="markdown"><p>开始执行。</p>\n<p>正在检查现有配置。</p></div></div>',
        );
        expect(html).not.toContain('回复用户');
      } else {
        expect(html).toContain(
          '<div class="sent-message-bubble"><span class="sent-message-tag">回复用户</span><div class="markdown"><p>开始执行。</p>\n<p>正在检查现有配置。</p></div></div>',
        );
      }
    }
  });

  it('accepts only a successful persisted send result', () => {
    const result = sendResult();
    expect(sentUserMessage(result)).toEqual({
      content: '**正式回复**',
      endTurn: true,
      deliveries: [],
    });
    const projected = projectConversation({
      threadId,
      messages: [result],
      runs: [],
      transientResponses: [],
    });
    const html = render(projectConversationDisplay(projected, [], 'compact'), [result]);
    expect(html).toContain('<strong>正式回复</strong>');
    expect(html).toContain('data-message-id="sent"');
    expect(html).not.toContain('发送详情');
    expect(html).not.toContain('回复用户');
    expect(html).not.toContain('tool-result');
    const fullHtml = render(projectConversationDisplay(projected, [], 'full'), [result]);
    expect(fullHtml).toContain('<strong>正式回复</strong>');
    expect(fullHtml).toContain('sent-message-bubble');
    expect(fullHtml).toContain('sent-message-tag');
    expect(fullHtml).toContain('回复用户');
    expect(fullHtml).not.toContain('发送详情');
    expect(fullHtml).not.toContain('tool-result');
  });

  it.each([
    { toolStatus: ToolResultStatus.UNSPECIFIED },
    { toolStatus: ToolResultStatus.ERROR },
    { role: MessageRole.ASSISTANT },
    { agentId: 'subagent' },
    { supersededByRunId: 'new-branch' },
    { toolCallId: '' },
    { content: '{partial' },
    { content: JSON.stringify({ status: 'sent', content: '', end_turn: true }) },
    { content: JSON.stringify({ status: 'sent', content: '正文', end_turn: 'true' }) },
    { content: JSON.stringify({ status: 'pending', content: '正文', end_turn: true }) },
  ])('does not expose an unconfirmed or invalid result: %j', (changes) => {
    expect(sentUserMessage(sendResult('result', changes))).toBeNull();
  });

  it('renders send_to_user as a bubble card in both views and keeps it out of the tool group', () => {
    const messages = [
      message('read', MessageRole.ASSISTANT, {
        content: '',
        sendToUserEnabled: true,
        toolCalls: [call('read-1', 'read')],
      }),
      message('read-result', MessageRole.TOOL, {
        toolName: 'read',
        toolCallId: 'read-1',
        content: 'read result',
        toolStatus: ToolResultStatus.SUCCESS,
        sendToUserEnabled: true,
      }),
      message('send', MessageRole.ASSISTANT, {
        content: '',
        sendToUserEnabled: true,
        toolCalls: [call('send-1', 'send_to_user', { content: '**正式回复**', end_turn: false })],
      }),
      sendResult('sent', {
        content: JSON.stringify({
          status: 'sent',
          content: '**正式回复**',
          end_turn: true,
          deliveries: [{ channel: 'feishu', delivery_id: 'd-1', status: 'queued' }],
        }),
      }),
      message('bash', MessageRole.ASSISTANT, {
        content: '',
        sendToUserEnabled: true,
        toolCalls: [call('bash-1', 'bash')],
      }),
    ];
    const projected = projectConversation({ threadId, messages, runs: [], transientResponses: [] });
    const full = projectConversationDisplay(projected, [], 'full');
    const html = render(full, messages);
    expect(html).toContain('sent-user-message');
    expect(html).toContain('data-user-message-call-id="send-1"');
    expect(html).toContain('<strong>正式回复</strong>');
    expect(html).toContain('sent-message-bubble');
    expect(html).toContain('回复用户');
    expect(html).not.toContain('发送详情');
    expect(html).toContain('channel-delivery-badge channel-feishu');
    expect(html).not.toContain('data-tool-call-id="send-1"');
    expect(html).toContain('data-message-id="read"');
    expect(html).not.toContain('data-message-id="send"');
    expect(html).toContain('data-message-id="sent"');
    const first = full.find((item) => item.key === 'read');
    const last = full.find((item) => item.key === 'bash');
    expect(
      first?.kind === 'message' &&
        first.value.toolItems?.[0]?.kind === 'ordinary' &&
        first.value.toolItems[0].calls.map((item) => item.toolCallId),
    ).toEqual(['read-1', 'bash-1']);
    expect(last?.kind === 'message' && last.value.toolItems).toEqual([]);
    expect(full.find((item) => item.key === 'sent')).toMatchObject({
      value: { sentMessage: { content: '**正式回复**', endTurn: true } },
    });

    const compactHtml = render(projectConversationDisplay(projected, [], 'compact'), messages);
    expect(compactHtml).toContain('data-user-message-call-id="send-1"');
    expect(compactHtml).toContain('<strong>正式回复</strong>');
    expect(compactHtml).toContain('channel-delivery-badge channel-feishu');
    expect(compactHtml).not.toContain('发送详情');
    expect(compactHtml).not.toContain('回复用户');
    expect(compactHtml).not.toContain('data-tool-call-id="send-1"');
  });
});

describe('compact conversation projection', () => {
  it.each([
    { earlier: undefined, later: true },
    { earlier: false, later: true },
    { earlier: true, later: false },
  ])('keeps persisted operation groups separate across output modes: %j', ({ earlier, later }) => {
    const messages = [
      message('earlier', MessageRole.ASSISTANT, {
        content: '',
        sendToUserEnabled: earlier,
        toolCalls: [call('earlier-read', 'read')],
        contentBlocks: [
          create(ContentBlockSchema, { type: ContentBlockType.THINKING, text: 'earlier thinking' }),
        ],
      }),
      message('later', MessageRole.ASSISTANT, {
        content: '',
        sendToUserEnabled: later,
        toolCalls: [call('later-read', 'read')],
        contentBlocks: [
          create(ContentBlockSchema, { type: ContentBlockType.THINKING, text: 'later thinking' }),
        ],
      }),
    ];
    const items = projectConversation({ threadId, messages, runs: [], transientResponses: [] });
    const compact = projectConversationDisplay(items, [], 'compact');
    const html = render(compact, messages);
    const privateName = earlier ? 'earlier' : 'later';
    const publicName = earlier ? 'later' : 'earlier';
    expect(operationContents(compact)).not.toContain(`${privateName} thinking`);
    expect(html).not.toContain(`${privateName}-read`);
    expect(operationContents(compact)).toContain(`${publicName} thinking`);
    expect(html).toContain(`${publicName}-read`);
  });

  it.each([true, false])(
    'keeps a streaming operation separate from a previous generation with another mode: %s',
    (streamMode) => {
      const previous = message('previous', MessageRole.ASSISTANT, {
        content: '',
        sendToUserEnabled: !streamMode,
        toolCalls: [call('old-read', 'read')],
        contentBlocks: [
          create(ContentBlockSchema, {
            type: ContentBlockType.THINKING,
            text: 'previous thinking',
          }),
        ],
      });
      const run = create(RunSchema, {
        runId,
        threadId,
        agentId: 'thread',
        status: RunStatus.RUNNING,
        sendToUserEnabled: streamMode,
      });
      const items = projectConversation({
        threadId,
        messages: [previous],
        runs: [run],
        transientResponses: [
          {
            messageId: 'stream',
            runId,
            deltaSeq: 1n,
            contentBlocks: [
              create(ContentBlockSchema, {
                type: ContentBlockType.THINKING,
                text: 'stream thinking',
              }),
            ],
          },
        ],
      });
      const compact = projectConversationDisplay(items, [run], 'compact');
      const html = render(compact, [previous]);
      expect(operationContents(compact)).not.toContain(
        streamMode ? 'stream thinking' : 'previous thinking',
      );
      expect(operationContents(compact)).toContain(
        streamMode ? 'previous thinking' : 'stream thinking',
      );
      expect(html).toContain(`data-message-id="${streamMode ? 'previous' : 'stream'}"`);
    },
  );

  it.each([true, false])(
    'orders a send and thread call by their persisted results (send first: %s)',
    (sendFirst) => {
      const send = call('send-1', 'send_to_user', { content: '开始处理', end_turn: false });
      const task = call('task-1', 'thread_call', { prompt: '调查', title: '任务' });
      const source = message('source', MessageRole.ASSISTANT, {
        content: '',
        sendToUserEnabled: true,
        toolCalls: sendFirst ? [send, task] : [task, send],
      });
      const sent = sendResult();
      const receipt = message('receipt', MessageRole.TOOL, {
        toolName: 'thread_call',
        toolCallId: 'task-1',
        toolStatus: ToolResultStatus.SUCCESS,
        sendToUserEnabled: true,
        content: JSON.stringify({ status: 'accepted', thread_id: 'task', tool_call_id: 'task-1' }),
      });
      const messages = [source, ...(sendFirst ? [sent, receipt] : [receipt, sent])];
      const items = projectConversation({ threadId, messages, runs: [], transientResponses: [] });
      const compact = projectConversationDisplay(items, [], 'compact');
      expect(compact.map((item) => item.key)).toEqual(
        sendFirst ? ['sent', 'source:call:task-1'] : ['source:call:task-1', 'sent'],
      );
      const card = compact.find((item) => item.key === 'source:call:task-1');
      expect(card?.kind === 'message' && card.value.message.messageId).toBe('source');
    },
  );

  it('defers a card without a receipt until its preceding send result is known', () => {
    const source = message('source', MessageRole.ASSISTANT, {
      content: '',
      sendToUserEnabled: true,
      toolCalls: [call('send-1', 'send_to_user'), call('task-1', 'thread_call')],
    });
    const project = (messages: Message[]) =>
      projectConversationDisplay(
        projectConversation({ threadId, messages, runs: [], transientResponses: [] }),
        [],
        'compact',
      );
    expect(project([source])).toEqual([]);
    expect(project([source, sendResult()]).map((item) => item.key)).toEqual([
      'sent',
      'source:call:task-1',
    ]);
    const failed = sendResult('failed', {
      toolStatus: ToolResultStatus.ERROR,
      content: '发送失败',
    });
    expect(project([source, failed]).map((item) => item.key)).toEqual([
      'failed',
      'source:call:task-1',
    ]);
    expect(
      project([source, sendResult('unknown', { toolStatus: ToolResultStatus.UNSPECIFIED })]),
    ).toEqual([]);
    source.toolCalls.reverse();
    expect(project([source]).map((item) => item.key)).toEqual(['source:call:task-1']);
  });

  it('keeps direct user input and thread cards while hiding private text, thinking, ordinary tools and injections', () => {
    const messages = [
      message('user', MessageRole.USER, { source: MessageSource.USER }),
      message('private', MessageRole.ASSISTANT, {
        content: 'private body',
        sendToUserEnabled: true,
        contentBlocks: [
          create(ContentBlockSchema, { type: ContentBlockType.THINKING, text: 'private thinking' }),
          create(ContentBlockSchema, {
            type: ContentBlockType.TEXT,
            blockIndex: 1,
            text: 'private body',
          }),
        ],
        toolCalls: [
          call('read', 'read'),
          call('task', 'thread_call', { title: '任务标题', prompt: '调查要求' }),
          call('subagent', 'subagent'),
        ],
      }),
      message('ordinary-result', MessageRole.TOOL, {
        toolName: 'read',
        toolCallId: 'read',
        toolStatus: ToolResultStatus.SUCCESS,
        sendToUserEnabled: true,
        content: 'private tool result',
      }),
      sendResult(),
      message('background', MessageRole.USER, {
        source: MessageSource.THREAD_RESPONSE,
        sourceThreadId: 'task',
        content: 'private background result',
      }),
      message('notification', MessageRole.USER, {
        source: MessageSource.THREAD_NOTIFICATION,
        sourceThreadId: 'task',
        content: 'private notification',
      }),
    ];
    const items = projectConversation({ threadId, messages, runs: [], transientResponses: [] });
    const compact = projectConversationDisplay(items, [], 'compact');
    expect(compact.map((item) => item.key)).toEqual(['user', 'private:call:task', 'sent']);
    const html = render(compact, messages);
    expect(html).toContain('user-message-content');
    expect(html).toContain('data-delegation="task"');
    expect(html).toContain('正式回复');
    for (const content of [
      'private body',
      'private thinking',
      'private tool result',
      'private background result',
      'private notification',
    ])
      expect(html).not.toContain(content);
    expect(html).not.toContain('调用详情');
    expect(html).not.toContain('Thinking');
    expect(html).not.toContain('子代理');
  });

  it('uses each persisted message mode rather than the current Run mode for legacy content', () => {
    const run = create(RunSchema, {
      runId,
      threadId,
      agentId: 'thread',
      status: RunStatus.COMPLETED,
      sendToUserEnabled: true,
    });
    const messages = [
      message('legacy', MessageRole.ASSISTANT),
      message('new-private', MessageRole.ASSISTANT, { sendToUserEnabled: true }),
    ];
    const items = projectConversation({ threadId, messages, runs: [run], transientResponses: [] });
    expect(projectConversationDisplay(items, [run], 'compact').map((item) => item.key)).toEqual([
      'legacy',
    ]);
    expect(projectConversationDisplay(items, [run], 'full').map((item) => item.key)).toEqual([
      'legacy',
      'new-private',
    ]);
  });

  it('hides streaming private text only after the Run has an explicit send mode', () => {
    const run = create(RunSchema, {
      runId,
      threadId,
      agentId: 'thread',
      status: RunStatus.RUNNING,
      sendToUserEnabled: true,
    });
    const items = projectConversation({
      threadId,
      messages: [],
      runs: [run],
      transientResponses: [
        {
          messageId: 'stream',
          runId,
          deltaSeq: 1n,
          contentBlocks: [
            create(ContentBlockSchema, { type: ContentBlockType.TEXT, text: 'private stream' }),
          ],
        },
      ],
    });
    expect(projectConversationDisplay(items, [run], 'compact')).toEqual([]);
    expect(projectConversationDisplay(items, [], 'compact').map((item) => item.key)).toEqual([
      'stream',
    ]);
  });

  it('reports a completed direct reply without a send, including another input in the same Run', () => {
    const run = create(RunSchema, {
      runId,
      threadId,
      agentId: 'thread',
      status: RunStatus.COMPLETED,
      sendToUserEnabled: true,
    });
    const messages = [
      message('first', MessageRole.USER, { source: MessageSource.USER }),
      sendResult(),
      message('second', MessageRole.USER, { source: MessageSource.USER }),
      message('private', MessageRole.ASSISTANT, { sendToUserEnabled: true }),
    ];
    const items = projectConversation({ threadId, messages, runs: [run], transientResponses: [] });
    expect(projectConversationDisplay(items, [run], 'compact').map((item) => item.key)).toEqual([
      'first',
      'sent',
      'second',
      'missing-user-reply:second',
    ]);
    const background = projectConversation({
      threadId,
      messages: messages.slice(-1),
      runs: [run],
      transientResponses: [],
    });
    expect(projectConversationDisplay(background, [run], 'compact')).toEqual([]);
  });

  it('retains failed Run controls and an explicit send failure without showing its draft as a sent message', () => {
    const run = create(RunSchema, {
      runId,
      threadId,
      agentId: 'thread',
      status: RunStatus.FAILED,
      sendToUserEnabled: true,
    });
    const result = sendResult('failed', {
      toolStatus: ToolResultStatus.ERROR,
      content: '发送失败',
    });
    const messages = [
      message('user', MessageRole.USER, { source: MessageSource.USER }),
      message('private', MessageRole.ASSISTANT, { sendToUserEnabled: true }),
      result,
    ];
    const items = projectConversation({ threadId, messages, runs: [run], transientResponses: [] });
    const compact = projectConversationDisplay(items, [run], 'compact');
    expect(compact.map((item) => item.key)).toEqual(['user', 'failed', `run-outcome:${runId}`]);
    expect(render(compact, messages)).toContain('回复发送失败');
    expect(render(compact, messages)).not.toContain('正式回复');
  });

  it('keeps the same loaded turn range when switching modes and deduplicates repeated send results', () => {
    const messages = Array.from({ length: 12 }, (_, index) => [
      message(`user-${index}`, MessageRole.USER, { source: MessageSource.USER }),
      message(`private-${index}`, MessageRole.ASSISTANT, { sendToUserEnabled: true }),
      sendResult(`sent-${index}`, { toolCallId: `call-${index}` }),
    ]).flat();
    const items = projectConversation({ threadId, messages, runs: [], transientResponses: [] });
    const starts = conversationTurnStarts(items);
    const start = conversationHistoryStartIndex(starts, initialHiddenTurnCount(starts.length));
    const loaded = items.slice(start);
    const compact = projectConversationDisplay(loaded, [], 'compact');
    const full = projectConversationDisplay(loaded, [], 'full');
    expect(compact[0]?.key).toBe('user-2');
    expect(full[0]?.key).toBe('user-2');
    expect(conversationTurnStarts(compact)).toHaveLength(10);
    expect(conversationTurnStarts(full)).toHaveLength(10);
    const duplicated = projectConversationDisplay([...loaded, ...loaded.slice(-1)], [], 'compact');
    expect(duplicated.filter((item) => item.key === 'sent-11')).toHaveLength(1);
    const duplicatedFull = projectConversationDisplay([...loaded, ...loaded.slice(-1)], [], 'full');
    expect(duplicatedFull.filter((item) => item.key === 'sent-11')).toHaveLength(1);
  });
});
