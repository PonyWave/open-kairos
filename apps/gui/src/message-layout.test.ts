import { createRouterTransport } from '@connectrpc/connect';
import {
  create,
  MessageRole,
  MessageSchema,
  ThreadSchema,
  ThreadSnapshotSchema,
} from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKairosClients } from './client.js';
import { ConversationPane } from './conversation-pane.js';
import { MessageCard } from './message-card.js';
import { ThreadSyncManager } from './thread-sync-manager.js';
import * as sync from './use-thread-sync.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function renderMessage(threadId: string, role = MessageRole.USER): string {
  const message = create(MessageSchema, {
    messageId: `user-${threadId}`,
    threadId,
    agentId: 'thread',
    role,
    content: '直接用户消息',
  });
  return renderToStaticMarkup(
    createElement(MessageCard, {
      message,
      delegationCall: null,
      clients: createKairosClients({ transport: createRouterTransport(() => {}) }),
      busy: false,
      editing: false,
      streaming: false,
      thinkingExpansionChoices: {},
      mainThreadId: 'main-1',
      onThinkingExpansionChange: () => {},
      onStartEditing: () => {},
      onCancelEditing: () => {},
      onRevise: async () => {},
      onRerun: async () => {},
    }),
  );
}

describe('direct user message alignment', () => {
  it('right-aligns users in both the main conversation and topics', () => {
    for (const threadId of ['main-1', 'task-1']) {
      const html = renderMessage(threadId);
      expect(html).toContain('time-right');
      expect(html).toContain('user-message-content');
      expect(html).not.toContain('user-left');
      expect(html.indexOf('user-message-content')).toBeLessThan(html.indexOf('time-right'));
    }
  });

  it('keeps Agent avatars to the left of the body in both conversation types', () => {
    for (const threadId of ['main-1', 'task-1']) {
      const html = renderMessage(threadId, MessageRole.ASSISTANT);
      expect(html).toContain('time-left');
      expect(html).not.toContain('user-message-content');
      expect(html.indexOf('time-left')).toBeLessThan(html.indexOf('message-content'));
    }
  });

  it.each([
    { variant: 'topic', source: 'policy' },
    { variant: 'fullscreen', source: 'policy' },
    { variant: 'topic', source: 'binding' },
    { variant: 'fullscreen', source: 'binding' },
  ] as const)(
    'keeps the $variant title and layout without environment settings from $source',
    ({ variant, source }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 10, 6, 12));
      const thread = create(ThreadSchema, {
        threadId: 'task-1',
        title: '保留话题标题',
        ...(source === 'policy'
          ? {
              environmentPolicy: {
                allowedEnv: ['self-hosted-env'],
                policyVersion: 1n,
              },
              currentBinding: {
                envId: 'historical-binding',
                pwd: '/historical',
                bindingVersion: 1n,
              },
            }
          : { currentBinding: { envId: 'platform-main', pwd: '/workspace', bindingVersion: 1n } }),
      });
      const snapshot = create(ThreadSnapshotSchema, {
        thread,
        messages: [MessageRole.USER, MessageRole.ASSISTANT].map((role) =>
          create(MessageSchema, {
            messageId: `message-${role}`,
            threadId: thread.threadId,
            agentId: 'thread',
            seq: BigInt(role),
            role,
            content: role === MessageRole.USER ? '右侧用户消息' : '左侧 Agent 消息',
            createdAt: {
              seconds: BigInt(new Date(2026, 10, 5, 9, 5).getTime() / 1000),
              nanos: 0,
            },
          }),
        ),
      });
      vi.spyOn(sync, 'useThreadSync').mockReturnValue({
        state: {
          snapshot,
          throughSeq: 0n,
          status: 'live',
          error: null,
          transientResponses: [],
          bashOperations: [],
          hardCuts: [],
          invalidatedRecaps: {},
        },
        reload: async () => {},
      });
      const noop = () => {};
      const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
      const html = renderToStaticMarkup(
        createElement(ConversationPane, {
          clients,
          threadSyncManager: new ThreadSyncManager(clients),
          variant,
          composerOwner: variant,
          threadId: thread.threadId,
          thread,
          mainThreadId: 'main-1',
          draftOwner: thread.threadId,
          actions: {
            busy: false,
            failures: [],
            execute: async () => undefined,
            retry: async () => undefined,
            dismiss: noop,
          },
          drafts: {
            getDraft: () => ({ id: 'draft', text: '' }),
            updateDraft: noop,
            completeDraft: noop,
            removeAttachment: noop,
            restoreQueueDraft: noop,
          },
          topicCards: [],
          previewRevision: 0,
          toolExpansionChoices: {},
          onToolExpansionChange: noop,
          onOpenTopic: noop,
          onOpenDirectory: noop,
          onOpenMain: noop,
          onCloseTopic: noop,
          onShowOrigin: noop,
          showNotice: noop,
        }),
      );
      expect(html).toContain('<h1>保留话题标题</h1>');
      expect(html).toContain('thread-title-mark');
      expect(html).not.toContain('aria-label="任务默认环境"');
      expect(html).not.toContain('self-hosted-env');
      expect(html).not.toContain('/workspace');
      expect(html).not.toContain('historical-binding');
      expect(html).not.toContain('>未配置<');
      expect(html).not.toContain('aria-label="主环境状态"');
      expect(html).toContain('aria-label="编辑话题名称"');
      expect(html.indexOf('</header>')).toBeLessThan(html.indexOf('class="session-scroll"'));
      expect(html).toContain('>昨天</time>');
      expect(html).toContain('昨天 09:05');
      expect(html).toContain('user-message-content');
      expect(html).toContain('time-right');
      expect(html).toContain('time-left');
      expect(html).not.toContain('user-left');
    },
  );
});
