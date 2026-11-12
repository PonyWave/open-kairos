import {
  create,
  MessageRole,
  MessageSchema,
  MessageSource,
  ToolCallSchema,
} from '@kairos/contracts';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DelegationCallCard,
  type OpenTopicRequest,
  ThreadDeliveryCard,
} from './delegation-cards.js';
import { threadColor } from './entity-mark.js';
import type { ThreadCallView } from './thread-view.js';

const source = create(MessageSchema, {
  messageId: 'source-1',
  threadId: 'main-1',
  agentId: 'thread',
  seq: 1n,
  role: MessageRole.ASSISTANT,
  toolCalls: [
    create(ToolCallSchema, {
      toolCallId: 'call-1',
      toolName: 'thread_call',
      argumentsJson: '{"thread_id":"","prompt":"整理行程"}',
    }),
  ],
});

const preview: ThreadCallView = {
  target: { threadId: 'task-1', title: '杭州行程' },
  replyCount: 5n,
  replies: [
    {
      messageId: 'reply-1',
      threadId: 'task-1',
      seq: 2n,
      role: MessageRole.USER,
      source: MessageSource.THREAD_CALL,
      sourceThreadId: 'main-1',
      content: '主对话要求',
      truncated: false,
    },
    {
      messageId: 'reply-2',
      threadId: 'task-1',
      seq: 3n,
      role: MessageRole.ASSISTANT,
      content: '话题回复',
      truncated: true,
    },
  ],
};

function topicAction(node: ReactNode): (() => void) | null {
  if (!isValidElement<{ children?: ReactNode; className?: string; onClick?: () => void }>(node))
    return null;
  if (node.type === 'button' && node.props.className === 'text-button thread-call-open')
    return node.props.onClick ?? null;
  for (const child of Children.toArray(node.props.children)) {
    const action = topicAction(child);
    if (action) return action;
  }
  return null;
}

describe('delegation entry components', () => {
  it('renders a continued Agent call with its current prompt and a compact topic entry', () => {
    const call = create(ToolCallSchema, {
      toolCallId: 'continue-1',
      toolName: 'thread_call',
      argumentsJson: JSON.stringify({ thread_id: 'task-1', prompt: '补充 **最新时间**' }),
    });
    const html = renderToStaticMarkup(
      createElement(DelegationCallCard, {
        message: source,
        call,
        receipt: { status: 'accepted', threadId: 'task-1' },
        preview,
        onOpenTopic: () => {},
      }),
    );

    expect(html).toContain('thread-call-reply');
    expect(html).toContain('回复话题');
    expect(html).toContain('杭州行程');
    expect(html).toContain('<strong>最新时间</strong>');
    expect(html).toContain('查看话题');
    expect(html).toContain('data-delegation-call-id="continue-1"');
    expect(html).not.toContain('已接受');
    expect(html).not.toContain('调用详情');
    expect(html).not.toContain('更早的');
    expect(html).not.toContain('话题回复');
  });

  it('opens each continued call by its own delegation triple before its receipt arrives', () => {
    const opened: OpenTopicRequest[] = [];
    for (const id of ['first', 'second']) {
      const call = create(ToolCallSchema, {
        toolCallId: `call-${id}`,
        toolName: 'thread_call',
        argumentsJson: JSON.stringify({ thread_id: `task-${id}`, prompt: '相同的继续要求' }),
      });
      const card = DelegationCallCard({
        message: source,
        call,
        topicTitle: `话题 ${id}`,
        onOpenTopic: (request) => opened.push(request),
      });
      const action = topicAction(card);
      if (!action) throw new Error('查看话题入口未渲染。');
      action();
      expect(opened.at(-1)).toEqual({
        threadId: `task-${id}`,
        invocationId: `call-${id}`,
        origin: {
          delegation: {
            $typeName: 'kairos.gui.v1.DelegationReference',
            sourceThreadId: source.threadId,
            sourceAgentId: source.agentId,
            sourceToolCallId: `call-${id}`,
          },
          prompt: '相同的继续要求',
          sourceMessageId: source.messageId,
        },
      });
    }
    expect(opened).toHaveLength(2);
  });

  it('renders real call data, earlier count and stable source colors', () => {
    const call = source.toolCalls[0];
    if (!call) throw new Error('missing call');
    const html = renderToStaticMarkup(
      createElement(DelegationCallCard, {
        message: source,
        call,
        receipt: { status: 'accepted', threadId: 'task-1' },
        preview,
        mainThreadId: 'main-1',
        onOpenTopic: () => {},
      }),
    );

    expect(html).toContain('更早的 3 条消息');
    expect(html).toContain('整理行程');
    expect(html).toContain('已接受');
    expect(html).toContain('杭州行程');
    expect(html).toContain(`data-thread-color="${threadColor('task-1')}"`);
    expect(html).toContain('entity-main');
    expect(html).toContain('话题回复…');
  });

  it('opens a persisted background result separately from the acceptance receipt', () => {
    const response = create(MessageSchema, {
      messageId: 'delivery-1',
      threadId: 'main-1',
      agentId: 'thread',
      role: MessageRole.USER,
      source: MessageSource.THREAD_RESPONSE,
      sourceThreadId: 'task-1',
      content: '实际返回结果',
    });
    const html = renderToStaticMarkup(
      createElement(ThreadDeliveryCard, {
        message: response,
        topicTitle: '杭州行程',
        origin: null,
        onOpenTopic: () => {},
      }),
    );
    expect(html).toContain('杭州行程 返回结果');
    expect(html).toContain('实际返回结果');
    expect(html).toContain('查看话题');
    expect(html).not.toContain('accepted');
  });
});
