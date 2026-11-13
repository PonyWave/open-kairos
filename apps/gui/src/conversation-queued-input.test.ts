import { createRouterTransport } from '@connectrpc/connect';
import {
  create,
  InputMode,
  InputStatus,
  MessageRole,
  MessageSource,
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
  mode = 'full',
  queued = false,
}: {
  mode?: 'compact' | 'full';
  queued?: boolean;
} = {}): string {
  const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
  const noop = () => {};
  const snapshot = create(ThreadSnapshotSchema, {
    thread: { threadId: 'main', title: '主对话' },
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

describe('queued input in the conversation', () => {
  it('shows queued input immediately with compact and full pending indicators', () => {
    const compact = renderConversation({ queued: true, mode: 'compact' });
    expect(compact).toContain('等待中的消息');
    expect(compact).toContain('data-pending-input-id="input-1"');
    expect(compact).toContain('pending-agent-bubble');
    expect(compact).toContain('aria-label="Agent 正在输入"');
    expect(compact).not.toContain('pending-agent-spinner');
    expect(compact).toContain('<details class="queue-management" open="">');
    expect(compact).toContain('排队消息（1 条）');

    const full = renderConversation({ queued: true, mode: 'full' });
    expect(full).toContain('等待中的消息');
    expect(full).toContain('pending-agent-spinner');
    expect(full).toContain('spinning');
    expect(full).not.toContain('pending-agent-bubble');
  });
});
