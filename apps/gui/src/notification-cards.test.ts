import {
  create,
  DelegationReferenceSchema,
  MessageRole,
  MessageSchema,
  MessageSource,
  ThreadNotificationSchema,
  ThreadNotificationStatus,
  ToolCallSchema,
} from '@kairos/contracts';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OpenTopicRequest } from './delegation-cards.js';
import { threadColor } from './entity-mark.js';
import { ThreadNotificationCallCard, ThreadNotificationCard } from './notification-cards.js';
import { projectToolItems } from './tool-group-projection.js';

function topicAction(node: ReactNode): (() => void) | null {
  if (!isValidElement<{ children?: ReactNode; className?: string; onClick?: () => void }>(node))
    return null;
  if (node.type === 'button' && node.props.className?.includes('thread-notification-source')) {
    return node.props.onClick ?? null;
  }
  for (const child of Children.toArray(node.props.children)) {
    const action = topicAction(child);
    if (action) return action;
  }
  return null;
}

const delegation = create(DelegationReferenceSchema, {
  sourceThreadId: 'task-1',
  sourceAgentId: 'thread',
  sourceToolCallId: 'notify-1',
});
const body = '请主对话关注 **已经完成** 的检查。';
const mainMessage = create(MessageSchema, {
  messageId: 'main-notification-1',
  threadId: 'main-1',
  agentId: 'thread',
  role: MessageRole.USER,
  source: MessageSource.THREAD_NOTIFICATION,
  sourceThreadId: 'task-1',
  sourceAgentId: 'thread',
  delegation,
  content: JSON.stringify({
    kind: 'thread_notification',
    source_thread_id: 'task-1',
    source_agent_id: 'thread',
    tool_call_id: 'notify-1',
    thread_id: 'task-1',
    message: body,
  }),
});

describe('thread notification cards', () => {
  it('renders the source task avatar and message in main, and locates the exact source call', () => {
    const opened: OpenTopicRequest[] = [];
    const card = ThreadNotificationCard({
      message: mainMessage,
      topicTitle: '行程话题',
      onOpenTopic: (request) => opened.push(request),
    });
    const html = renderToStaticMarkup(card);
    expect(html).toContain('thread-notification');
    expect(html).toContain('行程话题');
    expect(html).toContain('话题通知');
    expect(html).toContain('<strong>已经完成</strong>');
    expect(html).toContain(`data-thread-color="${threadColor('task-1')}"`);
    expect(html).toContain('data-delegation-call-id="notify-1"');
    expect(html).not.toContain('已阅读');
    expect(html).not.toContain('&quot;kind&quot;');
    const action = topicAction(card);
    if (!action) throw new Error('Missing source topic action.');
    action();
    expect(opened).toEqual([{ threadId: 'task-1', invocationId: 'notify-1', origin: null }]);
  });

  it.each([
    [ThreadNotificationStatus.PENDING, '已接受'],
    [ThreadNotificationStatus.QUEUED, '等待注入主对话'],
    [ThreadNotificationStatus.CONSUMED, '已注入主对话'],
    [ThreadNotificationStatus.SUPERSEDED, '来源已失效'],
  ])('renders the task-side weak card with accurate status %s', (status, label) => {
    const call = create(ToolCallSchema, {
      toolCallId: 'notify-1',
      toolName: 'thread_notify',
      argumentsJson: JSON.stringify({ message: body }),
    });
    const notification = create(ThreadNotificationSchema, {
      delegation,
      sourceRunId: 'task-run-1',
      replyThreadId: 'main-1',
      content: body,
      status,
    });
    const html = renderToStaticMarkup(
      createElement(ThreadNotificationCallCard, { call, notification }),
    );
    expect(html).toContain('thread-notify-call');
    expect(html).toContain('给主对话发消息');
    expect(html).toContain(label);
    expect(html).toContain('<strong>已经完成</strong>');
    expect(html).toContain('data-delegation-call-id="notify-1"');
    expect(html).not.toContain('已阅读');
    expect(html).not.toContain('调用详情');
  });

  it('keeps thread_notify outside ordinary tool groups', () => {
    const items = projectToolItems([
      create(ToolCallSchema, { toolCallId: 'read-1', toolName: 'read', argumentsJson: '{}' }),
      create(ToolCallSchema, {
        toolCallId: 'notify-1',
        toolName: 'thread_notify',
        argumentsJson: '{"message":"notice"}',
      }),
      create(ToolCallSchema, { toolCallId: 'read-2', toolName: 'read', argumentsJson: '{}' }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(['ordinary', 'notification', 'ordinary']);
  });
});
