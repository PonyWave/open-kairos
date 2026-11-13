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
import { ThreadSyncManager } from './thread-sync-manager.js';
import * as sync from './use-thread-sync.js';

afterEach(() => vi.restoreAllMocks());

describe('continued Thread calls in the conversation', () => {
  it.each(['compact', 'full'] as const)(
    'keeps the user bubble ordinary and renders every continued call in %s mode',
    (displayMode) => {
      const tasks = ['自我介绍', 'TS 技巧', '排障步骤'].map((title, index) => ({
        id: `task-${index}`,
        title,
        prompt: `继续要求 ${index}`,
      }));
      const thread = create(ThreadSchema, { threadId: 'main-1', title: '主对话' });
      const snapshot = create(ThreadSnapshotSchema, {
        thread,
        messages: [
          create(MessageSchema, {
            messageId: 'user-1',
            threadId: thread.threadId,
            agentId: 'thread',
            runId: 'run-1',
            seq: 1n,
            role: MessageRole.USER,
            content: '再在这几个话题里说点话',
          }),
          create(MessageSchema, {
            messageId: 'assistant-1',
            threadId: thread.threadId,
            agentId: 'thread',
            runId: 'run-1',
            seq: 2n,
            role: MessageRole.ASSISTANT,
            sendToUserEnabled: true,
            toolCalls: tasks.map((task) => ({
              toolCallId: `call-${task.id}`,
              toolName: 'thread_call',
              argumentsJson: JSON.stringify({ thread_id: task.id, prompt: task.prompt }),
            })),
          }),
        ],
      });
      vi.spyOn(sync, 'useThreadSync').mockReturnValue({
        state: {
          snapshot,
          throughSeq: 0n,
          status: 'live',
          error: null,
          transientResponses: [],
          toolProgress: new Map(),
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
          variant: 'main',
          displayMode,
          composerOwner: 'main',
          threadId: thread.threadId,
          thread,
          mainThreadId: thread.threadId,
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
          topicCards: tasks.map((task) => ({
            thread: create(ThreadSchema, { threadId: task.id, title: task.title }),
            replies: [],
            origin: null,
          })),
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
      const user = html.match(/<article[^>]*data-message-id="user-1"[\s\S]*?<\/article>/)?.[0];
      const agent = html
        .match(/<article[^>]*data-message-id="assistant-1"[\s\S]*?<\/article>/g)
        ?.join('');
      expect(user).toBeDefined();
      expect(agent).toBeDefined();
      expect(user).toContain('再在这几个话题里说点话');
      expect(user).toContain('user-message-content');
      expect(user).not.toContain('回复话题');
      expect(user).not.toContain('thread-call-reply');
      expect(user).not.toContain('查看话题');
      expect(user).not.toContain('调用详情');
      expect(agent?.match(/class="delegation-tool thread-call-reply"/g)).toHaveLength(3);
      for (const task of tasks) {
        expect(agent).toContain(task.title);
        expect(agent).toContain(task.prompt);
        expect(agent).toContain(`data-delegation-call-id="call-${task.id}"`);
      }
      expect(agent?.match(/查看话题/g)).toHaveLength(3);
      expect(html.match(/class="message-avatar-container time-left/g)).toHaveLength(1);
      if (displayMode === 'compact') {
        for (const task of tasks)
          expect(html).toContain(`data-display-id="assistant-1:call:call-${task.id}"`);
      }
    },
  );
});
