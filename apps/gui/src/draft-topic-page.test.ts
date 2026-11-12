import { createRouterTransport } from '@connectrpc/connect';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { createKairosClients } from './client.js';
import { ConversationPane } from './conversation-pane.js';
import { localTaskDraftId } from './drafts.js';
import { ThreadSyncManager } from './thread-sync-manager.js';
import type { ActionExecutorView } from './use-action-executor.js';
import type { useDrafts } from './use-drafts.js';

it('renders a full draft page with a colored mark and a fixed default title', () => {
  const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
  const actions: ActionExecutorView = {
    execute: async () => undefined,
    retry: async () => undefined,
    dismiss: () => {},
    busy: false,
    failures: [],
  };
  const drafts: ReturnType<typeof useDrafts> = {
    getDraft: () => ({ id: 'draft-1', text: '', attachments: [] }),
    updateDraft: () => {},
    completeDraft: () => {},
    removeAttachment: () => {},
    restoreQueueDraft: () => {},
  };
  const html = renderToStaticMarkup(
    createElement(ConversationPane, {
      clients,
      threadSyncManager: new ThreadSyncManager(clients),
      variant: 'draft',
      composerOwner: 'draft',
      threadId: null,
      thread: null,
      mainThreadId: 'main-1',
      draftOwner: localTaskDraftId,
      actions,
      drafts,
      topicCards: [],
      previewRevision: 0,
      toolExpansionChoices: {},
      onToolExpansionChange: () => {},
      onOpenTopic: () => {},
      onOpenDirectory: () => {},
      onOpenMain: () => {},
      onCloseTopic: () => {},
      onShowOrigin: () => {},
      showNotice: () => {},
    }),
  );

  expect(html).toContain('conversation-draft');
  expect(html).toContain('<h1>新话题</h1>');
  expect(html).toContain(`data-thread-id="${localTaskDraftId}"`);
  expect(html).toContain('data-thread-color=');
  expect(html).toContain('data-composer-owner="draft"');
  expect(html).not.toContain('<dialog');
  expect(html).not.toContain('aria-label="话题名称"');
});
