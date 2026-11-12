import { createRouterTransport } from '@connectrpc/connect';
import {
  create,
  EnvironmentKind,
  InputMode,
  InputStatus,
  MessageRole,
  MessageSource,
  PlatformLifecycleState,
  RunStatus,
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

function renderConversation({
  state = PlatformLifecycleState.RUNNING,
  mode = 'full',
  queued = false,
}: {
  state?: PlatformLifecycleState;
  mode?: 'compact' | 'full';
  queued?: boolean;
} = {}): string {
  const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
  const noop = () => {};
  const snapshot = create(ThreadSnapshotSchema, {
    thread: { threadId: 'main', title: '主对话' },
    mainEnvironment: {
      envId: 'sandbox',
      kind: EnvironmentKind.PLATFORM_SANDBOX,
      lifecycleState: state,
      recommendedPwd: '/workspace',
    },
    runs: [{ runId: 'run', threadId: 'main', agentId: 'thread', status: RunStatus.QUEUED }],
    messages: [
      {
        messageId: 'input',
        threadId: 'main',
        agentId: 'thread',
        role: MessageRole.USER,
        content: '执行要求',
      },
    ],
    inputs: queued
      ? [
          {
            inputId: 'input-1',
            threadId: 'main',
            text: '等待中的消息',
            mode: InputMode.FOLLOW_UP,
            status: InputStatus.QUEUED,
            source: MessageSource.USER,
            position: 1n,
            version: 1n,
          },
        ]
      : [],
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
  return renderToStaticMarkup(
    createElement(ConversationPane, {
      clients,
      threadSyncManager: new ThreadSyncManager(clients),
      variant: 'main',
      displayMode: mode,
      composerOwner: 'main',
      threadId: 'main',
      thread: snapshot.thread ?? null,
      mainThreadId: 'main',
      draftOwner: 'main',
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
}

describe('sandbox startup in the conversation', () => {
  it('uses the ordinary waiting state for creating and restoring the workspace', () => {
    const ordinary = renderConversation();
    expect(ordinary).toContain('aria-label="停止执行"');
    expect(ordinary).toContain('执行要求');
    for (const state of [
      PlatformLifecycleState.STARTING,
      PlatformLifecycleState.RESUMING,
      PlatformLifecycleState.PAUSED,
    ]) {
      const html = renderConversation({ state });
      expect(html).toBe(ordinary);
      expect(html).not.toContain('平台主环境');
      expect(html).not.toContain('/workspace');
      expect(html).not.toContain('主环境状态');
    }
  });

  it('shows queued input immediately with compact and full pending indicators', () => {
    const compact = renderConversation({ queued: true, mode: 'compact' });
    expect(compact).toContain('等待中的消息');
    expect(compact).toContain('data-pending-input-id="input-1"');
    expect(compact).toContain('pending-agent-bubble');
    expect(compact).toContain('aria-label="Agent 正在输入"');
    expect(compact).not.toContain('pending-agent-spinner');
    expect(compact).toContain('<details class="queue-management">');

    const full = renderConversation({ queued: true, mode: 'full' });
    expect(full).toContain('等待中的消息');
    expect(full).toContain('pending-agent-spinner');
    expect(full).toContain('spinning');
    expect(full).not.toContain('pending-agent-bubble');
  });
});
