import { createRouterTransport } from '@connectrpc/connect';
import {
  ChannelId,
  ChannelReferenceKind,
  create,
  InputMode,
  InputSchema,
  InputStatus,
  MessageRole,
  MessageSchema,
  MessageSource,
  ToolCallSchema,
  ToolResultStatus,
} from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createKairosClients } from './client.js';
import { MessageCard, projectQueuedInputs } from './conversation.js';
import { isDirectUserMessage, isRootAgent } from './labels.js';
import { projectConversation } from './response-projection.js';

const clients = createKairosClients({ transport: createRouterTransport(() => {}) });

function sourceMessage(source: MessageSource) {
  return create(MessageSchema, {
    messageId: `message-${source}`,
    threadId: 'main-1',
    agentId: 'thread',
    seq: 1n,
    role: MessageRole.USER,
    source,
    ...(source === MessageSource.USER
      ? {}
      : {
          delegation: {
            sourceThreadId: 'main-1',
            sourceAgentId: 'thread',
            sourceToolCallId: 'call-1',
          },
        }),
    ...(source === MessageSource.THREAD_RESPONSE ? { sourceThreadId: 'task-1' } : {}),
    content: '机器结果',
  });
}

describe('message provenance components', () => {
  it('labels direct user input separately from Thread and Subagent responses', () => {
    const user = sourceMessage(MessageSource.USER);
    const thread = sourceMessage(MessageSource.THREAD_RESPONSE);
    const subagent = sourceMessage(MessageSource.SUBAGENT_RESPONSE);
    expect(isDirectUserMessage(user)).toBe(true);
    expect(isDirectUserMessage(thread)).toBe(false);
    expect(isDirectUserMessage(subagent)).toBe(false);
  });

  it('offers revision and Rerun only to the latest direct user message from the root Agent', () => {
    const render = (agentId: string, allowActions = true, editing = false) =>
      renderToStaticMarkup(
        createElement(MessageCard, {
          message: create(MessageSchema, {
            messageId: `user-${agentId}`,
            threadId: 'main-1',
            agentId,
            seq: 1n,
            role: MessageRole.USER,
            content: '问题',
          }),
          delegationCall: null,
          clients,
          busy: false,
          editing,
          streaming: false,
          allowActions,
          thinkingExpansionChoices: {},
          onThinkingExpansionChange: () => {},
          onStartEditing: () => {},
          onCancelEditing: () => {},
          onRevise: async () => {},
          onRerun: async () => {},
        }),
      );
    const root = render('thread');
    const older = render('thread', false);
    const child = render('subagent-a');
    const unavailableEditor = render('thread', false, true);

    expect(isRootAgent('thread')).toBe(true);
    expect(isRootAgent('subagent-a')).toBe(false);
    expect(root).toContain('重试');
    expect(root).toContain('编辑');
    expect(older).not.toContain('message-actions');
    expect(older).not.toContain('编辑');
    expect(older).not.toContain('重试');
    expect(child).not.toContain('message-actions');
    expect(child).not.toContain('>修订</button>');
    expect(unavailableEditor).not.toContain('修订消息');
    expect(unavailableEditor).not.toContain('保存');
  });

  it('keeps background responses out of the ordinary follow-up queue projection', () => {
    const input = (inputId: string, source: MessageSource, position: bigint) =>
      create(InputSchema, {
        inputId,
        threadId: 'main-1',
        text: inputId,
        mode: InputMode.FOLLOW_UP,
        status: InputStatus.QUEUED,
        position,
        version: 1n,
        source,
        ...(source === MessageSource.USER
          ? {}
          : {
              delegation: {
                sourceThreadId: 'main-1',
                sourceAgentId: 'thread',
                sourceToolCallId: `call-${inputId}`,
              },
            }),
      });
    const queued = projectQueuedInputs([
      input('thread-response', MessageSource.THREAD_RESPONSE, 1n),
      input('direct-user', MessageSource.USER, 3n),
      input('subagent-response', MessageSource.SUBAGENT_RESPONSE, 2n),
      input('thread-call', MessageSource.THREAD_CALL, 4n),
    ]);

    expect(queued.map((item) => item.inputId)).toEqual(['direct-user', 'thread-call']);
  });

  it('projects a persisted background response as a direct injection at the next model boundary', () => {
    const sourceCall = create(MessageSchema, {
      messageId: 'source-call',
      threadId: 'main-1',
      agentId: 'thread',
      seq: 1n,
      role: MessageRole.ASSISTANT,
      runId: 'run-source',
      toolCalls: [
        create(ToolCallSchema, {
          toolCallId: 'call-background',
          toolName: 'subagent',
          argumentsJson: '{"task":"work","mode":"background"}',
        }),
      ],
    });
    const injected = create(MessageSchema, {
      messageId: 'injected-response',
      threadId: 'main-1',
      agentId: 'thread',
      seq: 2n,
      role: MessageRole.USER,
      source: MessageSource.SUBAGENT_RESPONSE,
      content: '后台执行结果',
      runId: 'run-next-boundary',
      delegation: {
        sourceThreadId: 'main-1',
        sourceAgentId: 'thread',
        sourceToolCallId: 'call-background',
      },
    });
    const directInput = create(InputSchema, {
      inputId: 'direct-user',
      threadId: 'main-1',
      text: '普通用户输入',
      mode: InputMode.FOLLOW_UP,
      status: InputStatus.QUEUED,
      position: 1n,
      version: 1n,
      source: MessageSource.USER,
    });
    const items = projectConversation({
      threadId: 'main-1',
      messages: [sourceCall, injected],
      transientResponses: [],
      runs: [],
    });
    const display = items.find(
      (item) => item.kind === 'message' && item.value.message.messageId === injected.messageId,
    );
    if (display?.kind !== 'message') throw new Error('Missing injected response projection.');
    const html = renderToStaticMarkup(
      createElement(MessageCard, {
        message: display.value.message,
        delegationCall: display.value.delegationCall,
        clients,
        busy: false,
        editing: false,
        streaming: false,
        thinkingExpansionChoices: {},
        onThinkingExpansionChange: () => {},
        onStartEditing: () => {},
        onCancelEditing: () => {},
        onRevise: async () => {},
        onRerun: async () => {},
      }),
    );

    expect(injected.sourceInputId).toBeUndefined();
    expect(injected.runId).not.toBe(sourceCall.runId);
    expect(isDirectUserMessage(injected)).toBe(false);
    expect(display.value.delegationCall?.messageId).toBe('source-call');
    expect(projectQueuedInputs([directInput]).map((item) => item.inputId)).toEqual(['direct-user']);
    expect(html).toBe('');
    expect(injected.content).toBe('后台执行结果');
    expect(html).not.toContain('原工具调用 <code>');
    expect(html).not.toContain('关联调用消息 #');
    expect(html).not.toContain('从此消息重新执行');
    expect(html).not.toContain('>修订</button>');
  });
});

describe('channel message presentation', () => {
  it('renders inbound channel messages with a platform bubble class and corner badge', () => {
    const html = renderToStaticMarkup(
      createElement(MessageCard, {
        message: create(MessageSchema, {
          messageId: 'channel-in-1',
          threadId: 'main-1',
          agentId: 'thread',
          seq: 2n,
          role: MessageRole.USER,
          source: MessageSource.CHANNEL,
          channel: { channel: ChannelId.WECHAT, kind: ChannelReferenceKind.INBOUND },
          content: '来自微信的消息',
        }),
        delegationCall: null,
        clients,
        busy: false,
        editing: false,
        streaming: false,
        thinkingExpansionChoices: {},
        onThinkingExpansionChange: () => {},
        onStartEditing: () => {},
        onCancelEditing: () => {},
        onRevise: async () => {},
        onRerun: async () => {},
      }),
    );
    expect(html).toContain('channel-inbound channel-wechat');
    expect(html).toContain('channel-corner-badge channel-wechat');
    expect(html).toContain('来自微信');
    expect(html).not.toContain('channel-source');
  });

  it('renders delivery badges with a hover error marker for failed channel deliveries', () => {
    const html = renderToStaticMarkup(
      createElement(MessageCard, {
        message: create(MessageSchema, {
          messageId: 'tool-send-1',
          threadId: 'main-1',
          agentId: 'thread',
          seq: 3n,
          role: MessageRole.TOOL,
          toolCallId: 'send-1',
          toolName: 'send_to_user',
          toolStatus: ToolResultStatus.SUCCESS,
          content: JSON.stringify({
            status: 'sent',
            content: '同步到 IM。',
            end_turn: true,
            deliveries: [
              { channel: 'feishu', delivery_id: 'd-1', status: 'queued' },
              {
                channel: 'wechat',
                delivery_id: 'd-2',
                status: 'failed',
                error: '微信渠道未登录。',
              },
            ],
          }),
        }),
        delegationCall: null,
        clients,
        busy: false,
        editing: false,
        streaming: false,
        thinkingExpansionChoices: {},
        onThinkingExpansionChange: () => {},
        onStartEditing: () => {},
        onCancelEditing: () => {},
        onRevise: async () => {},
        onRerun: async () => {},
      }),
    );
    expect(html).toContain('channel-delivery-badge channel-feishu pending');
    expect(html).toContain('channel-delivery-badge channel-wechat failed');
    expect(html).toContain('channel-delivery-info');
    expect(html).toContain('微信渠道未登录。');
    expect(html).not.toContain('data-tip=""');
  });
});

describe('reminder wrappers in user-side display', () => {
  const renderCard = (message: Parameters<typeof MessageCard>[0]['message']) =>
    renderToStaticMarkup(
      createElement(MessageCard, {
        message,
        delegationCall: null,
        clients,
        busy: false,
        editing: false,
        streaming: false,
        thinkingExpansionChoices: {},
        onThinkingExpansionChange: () => {},
        onStartEditing: () => {},
        onCancelEditing: () => {},
        onRevise: async () => {},
        onRerun: async () => {},
      }),
    );

  it('hides leading reminder blocks from displayed user text', () => {
    const html = renderCard(
      create(MessageSchema, {
        messageId: 'automation-1',
        threadId: 'main-1',
        agentId: 'thread',
        seq: 10n,
        role: MessageRole.USER,
        content:
          '<system-reminder>\nKairos Automation trigger; trigger=schedule; schedule_id=s-1; fire_id=f-1; scheduled_at=2026-11-14T09:00:00+08:00; schedule="日报"; coalesced_missed_occurrences=0. This is an Automation input, not a new human instruction.\n</system-reminder>\n\n每天总结 AI 新闻',
      }),
    );
    expect(html).toContain('每天总结 AI 新闻');
    expect(html).not.toContain('Kairos Automation trigger');
    expect(html).not.toContain('system-reminder');
  });

  it('shows the inner response of a thread delivery instead of the reminder wrapper', () => {
    const html = renderCard(
      create(MessageSchema, {
        messageId: 'delivery-1',
        threadId: 'main-1',
        agentId: 'thread',
        seq: 11n,
        role: MessageRole.USER,
        source: MessageSource.THREAD_RESPONSE,
        sourceThreadId: 'task-1',
        delegation: {
          sourceThreadId: 'main-1',
          sourceAgentId: 'thread',
          sourceToolCallId: 'call-1',
        },
        content:
          '<system-reminder>\nA background delegated task reached a terminal state. This is an automatic delivery record, not a user message; use its status, response and error fields and continue the conversation accordingly.\n{"source_thread_id":"task-1","source_agent_id":"thread","tool_call_id":"call-1","kind":"thread_call","status":"completed","response":"调研完成，结论是 A 方案可行。","error":null}\n</system-reminder>',
      }),
    );
    expect(html).toContain('返回结果');
    expect(html).toContain('调研完成，结论是 A 方案可行。');
    expect(html).not.toContain('A background delegated task reached a terminal state');
    expect(html).not.toContain('source_thread_id');
  });

  it('renders background task deliveries as a parsed card without the reminder wrapper', () => {
    const html = renderCard(
      create(MessageSchema, {
        messageId: 'bg-1',
        threadId: 'main-1',
        agentId: 'thread',
        seq: 12n,
        role: MessageRole.USER,
        source: MessageSource.BACKGROUND_TASK,
        content:
          '<system-reminder>\nA background task reached a terminal state. This is an automatic delivery record, not a user message; use its status and result fields and continue the conversation accordingly.\n{"task_id":"task-1","kind":"bash","description":"curl 百度","status":"completed","tool_call_id":"call-2","result":"HTTP 200"}\n</system-reminder>',
      }),
    );
    expect(html).toContain('后台任务：curl 百度');
    expect(html).toContain('HTTP 200');
    expect(html).not.toContain('A background task reached a terminal state');
    expect(html).not.toContain('task_id');
  });
});
