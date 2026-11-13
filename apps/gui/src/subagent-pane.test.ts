import { createRouterTransport } from '@connectrpc/connect';
import {
  create,
  DelegationReferenceSchema,
  MessageRole,
  MessageSchema,
  RunSchema,
  RunStatus,
  SubagentCallViewSchema,
  ThreadSnapshotSchema,
} from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKairosClients } from './client.js';
import { ConversationPane } from './conversation-pane.js';
import { ThreadSyncManager } from './thread-sync-manager.js';
import * as sync from './use-thread-sync.js';

const noop = () => {};
const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
const threadSyncManager = new ThreadSyncManager(clients);
afterEach(() => vi.restoreAllMocks());

describe('read-only Subagent sidebar', () => {
  it('shows its task once, uses outlined avatars and exposes no composer, queue, editing or retry', () => {
    const view = create(SubagentCallViewSchema, {
      threadId: 'main',
      agentId: 'child',
      runId: 'child-run',
      task: 'ONE_TASK_ONLY',
      status: RunStatus.RUNNING,
      call: {
        delegation: {
          sourceThreadId: 'main',
          sourceAgentId: 'thread',
          sourceToolCallId: 'child-call',
        },
        sourceMessageId: 'parent-call',
      },
    });
    const snapshot = create(ThreadSnapshotSchema, {
      thread: { threadId: 'main', title: '主对话' },
      messages: [
        create(MessageSchema, {
          messageId: 'parent-call',
          threadId: 'main',
          agentId: 'thread',
          role: MessageRole.ASSISTANT,
          content: 'ROOT_MUST_NOT_APPEAR',
        }),
        create(MessageSchema, {
          messageId: 'initial',
          threadId: 'main',
          agentId: 'child',
          runId: 'child-run',
          role: MessageRole.USER,
          content: 'ONE_TASK_ONLY',
        }),
        create(MessageSchema, {
          messageId: 'reply',
          threadId: 'main',
          agentId: 'child',
          runId: 'child-run',
          role: MessageRole.ASSISTANT,
          content: 'CHILD_REPLY_ONLY',
        }),
      ],
      runs: [
        create(RunSchema, {
          runId: 'child-run',
          threadId: 'main',
          agentId: 'child',
          parentRunId: 'root-run',
          status: RunStatus.RUNNING,
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
    const render = (subagent: Parameters<typeof ConversationPane>[0]['subagent']) =>
      renderToStaticMarkup(
        createElement(ConversationPane, {
          clients,
          threadSyncManager,
          variant: 'subagent',
          subagent,
          composerOwner: 'subagent',
          threadId: 'main',
          thread: null,
          mainThreadId: 'main',
          draftOwner: 'child',
          actions: {
            busy: false,
            failures: [],
            execute: async () => undefined,
            retry: async () => undefined,
            dismiss: noop,
          },
          drafts: {
            getDraft: () => ({ id: 'draft', text: 'DRAFT_NOT_VISIBLE' }),
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
    const html = render(view);
    expect(html.match(/ONE_TASK_ONLY/g)).toHaveLength(1);
    expect(html).toContain('CHILD_REPLY_ONLY');
    expect(html).toContain('fill="none" stroke="currentColor"');
    expect(html).not.toContain('ROOT_MUST_NOT_APPEAR');
    expect(html).not.toContain('composer');
    expect(html).not.toContain('DRAFT_NOT_VISIBLE');
    expect(html).not.toContain('编辑话题名称');
    expect(html).not.toContain('message-actions');
    const unavailable = render(undefined);
    expect(unavailable).not.toContain('ROOT_MUST_NOT_APPEAR');
    expect(unavailable).not.toContain('CHILD_REPLY_ONLY');
  });
});

describe('side pane origin scrolling', () => {
  const longPrompt = `LONG_PROMPT_START ${'保持完整的长来源消息。'.repeat(200)} LONG_PROMPT_END`;

  const renderSidePane = (variant: 'topic' | 'subagent') => {
    const delegation = create(DelegationReferenceSchema, {
      sourceThreadId: 'main',
      sourceAgentId: 'thread',
      sourceToolCallId: 'source-call',
    });
    const snapshot = create(ThreadSnapshotSchema, {
      thread: { threadId: 'task', title: '侧栏标题' },
      messages: [
        create(MessageSchema, {
          messageId: 'topic-reply',
          threadId: 'task',
          agentId: 'thread',
          role: MessageRole.ASSISTANT,
          content: 'TOPIC_REPLY',
        }),
        create(MessageSchema, {
          messageId: 'subagent-reply',
          threadId: 'task',
          agentId: 'child',
          runId: 'child-run',
          role: MessageRole.ASSISTANT,
          content: 'SUBAGENT_REPLY',
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

    return renderToStaticMarkup(
      createElement(ConversationPane, {
        clients,
        threadSyncManager,
        variant,
        subagent:
          variant === 'subagent'
            ? create(SubagentCallViewSchema, {
                threadId: 'task',
                agentId: 'child',
                runId: 'child-run',
                task: longPrompt,
                status: RunStatus.COMPLETED,
                call: { delegation, sourceMessageId: 'parent-call' },
              })
            : undefined,
        origin:
          variant === 'topic'
            ? { delegation, prompt: longPrompt, sourceMessageId: 'parent-call' }
            : null,
        composerOwner: variant,
        threadId: 'task',
        thread: null,
        mainThreadId: 'main',
        draftOwner: variant,
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
  };

  it.each(['topic', 'subagent'] as const)(
    'keeps the %s header fixed and scrolls the full origin prompt with the message count',
    (variant) => {
      const html = renderSidePane(variant);
      const scrollStart = html.indexOf('<div class="session-scroll"');
      const bodyStart = html.indexOf('<div class="session-body"', scrollStart);
      expect(scrollStart).toBeGreaterThan(-1);
      expect(bodyStart).toBeGreaterThan(scrollStart);

      const fixedContent = html.slice(0, scrollStart);
      expect(fixedContent).toContain('class="workspace-header"');
      expect(fixedContent).not.toContain('class="topic-original"');

      const scrollLead = html.slice(scrollStart, bodyStart);
      expect(scrollLead).toContain('class="topic-original"');
      expect(scrollLead).toContain('class="reply-divider"');
      expect(scrollLead).toContain('1 条消息');
      const origin = html.match(/<button[^>]*class="topic-original"[^>]*>[\s\S]*?<\/button>/)?.[0];
      expect(origin).toContain(longPrompt);
      expect(origin).not.toContain('disabled');
      expect(html.split(longPrompt)).toHaveLength(2);
      expect(html).toContain(variant === 'topic' ? 'TOPIC_REPLY' : 'SUBAGENT_REPLY');
    },
  );
});

describe('conversation history rendering', () => {
  it('renders only the latest ten turns and an earlier-message button', () => {
    const view = create(SubagentCallViewSchema, {
      threadId: 'main',
      agentId: 'child',
      runId: 'child-run',
      task: 'TASK',
      status: RunStatus.COMPLETED,
      call: {
        delegation: {
          sourceThreadId: 'main',
          sourceAgentId: 'thread',
          sourceToolCallId: 'child-call',
        },
        sourceMessageId: 'parent-call',
      },
    });
    const messages = Array.from({ length: 12 }, (_, index) => [
      create(MessageSchema, {
        messageId: `user-${index}`,
        threadId: 'main',
        agentId: 'child',
        role: MessageRole.USER,
        content: `TURN_${index}`,
      }),
      create(MessageSchema, {
        messageId: `reply-${index}`,
        threadId: 'main',
        agentId: 'child',
        role: MessageRole.ASSISTANT,
        content: `REPLY_${index}`,
      }),
    ]).flat();
    const snapshot = create(ThreadSnapshotSchema, {
      thread: { threadId: 'main', title: '主对话' },
      messages,
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

    const html = renderToStaticMarkup(
      createElement(ConversationPane, {
        clients,
        threadSyncManager,
        variant: 'subagent',
        subagent: view,
        composerOwner: 'subagent',
        threadId: 'main',
        thread: null,
        mainThreadId: 'main',
        draftOwner: 'child',
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

    expect(html).toMatch(/<button[^>]*class="earlier-discussions"[^>]*>/);
    expect(html).toContain('较早的消息');
    expect(html).not.toContain('TURN_0</');
    expect(html).not.toContain('TURN_1</');
    expect(html).not.toContain('REPLY_0</');
    expect(html).toContain('TURN_2');
    expect(html).toContain('REPLY_2');
    expect(html).toContain('TURN_11');
    expect(html).toContain('REPLY_11');
  });
});

describe('active conversation message controls', () => {
  it('hides message actions and disables historical retries while sending or running', () => {
    const syncMock = vi.spyOn(sync, 'useThreadSync');
    const render = (status: RunStatus, busy: boolean) => {
      const snapshot = create(ThreadSnapshotSchema, {
        thread: { threadId: 'main', title: '主对话' },
        messages: [
          create(MessageSchema, {
            messageId: 'old-user',
            threadId: 'main',
            agentId: 'thread',
            seq: 1n,
            role: MessageRole.USER,
            sourceInputId: 'old-input',
            content: '旧消息',
          }),
          create(MessageSchema, {
            messageId: 'latest-user',
            threadId: 'main',
            agentId: 'thread',
            seq: 2n,
            role: MessageRole.USER,
            sourceInputId: 'new-input',
            content: '新消息',
          }),
        ],
        runs: [
          create(RunSchema, {
            runId: 'failed-run',
            threadId: 'main',
            agentId: 'thread',
            status: RunStatus.FAILED,
            inputIds: ['old-input'],
            error: { code: 13, message: '历史失败', retryable: true },
          }),
          create(RunSchema, {
            runId: 'new-run',
            threadId: 'main',
            agentId: 'thread',
            status,
            inputIds: ['new-input'],
          }),
        ],
      });
      syncMock.mockReturnValue({
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
      return renderToStaticMarkup(
        createElement(ConversationPane, {
          clients,
          threadSyncManager,
          variant: 'main',
          composerOwner: 'main',
          threadId: 'main',
          thread: null,
          mainThreadId: 'main',
          draftOwner: 'main',
          actions: {
            busy,
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
    };

    const idle = render(RunStatus.COMPLETED, false);
    expect(idle).toContain('message-actions');
    expect(idle).not.toContain('class="text-button failure-retry" disabled=""');

    for (const html of [render(RunStatus.COMPLETED, true), render(RunStatus.RUNNING, false)]) {
      expect(html).toContain('历史失败');
      expect(html).not.toContain('message-actions');
      expect(html).toContain('class="text-button failure-retry" disabled=""');
    }
  });
});
