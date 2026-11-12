/// <reference lib="dom" />

import { createRouterTransport } from '@connectrpc/connect';
import { AttachmentSchema, create, type Identity, IdentitySchema } from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountWorkbench } from './App.js';
import { accountScopeKey, scopedStorage } from './account-storage.js';
import { ActionExecutor } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import { type ActionKind, ClientActionStore, type StorageLike } from './actions.js';
import { attachmentMetadata } from './attachments.js';
import { createKairosClients, type KairosClients } from './client.js';
import { type MessageDraft, saveDraft } from './drafts.js';
import type { ActionExecutorView } from './use-action-executor.js';

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const accountA = create(IdentitySchema, {
  userId: 'user-a',
  tenantId: 'tenant-a',
  email: 'a@kairos.local',
  username: '用户 A',
  mainThreadId: 'main-a',
});
const accountB = create(IdentitySchema, {
  userId: 'user-b',
  tenantId: 'tenant-b',
  email: 'b@kairos.local',
  username: '用户 B',
  mainThreadId: 'main-b',
});

function actionView(clients: KairosClients): ActionExecutorView {
  const executor = new ActionExecutor(new ClientActionStore(), createActionHandlers(clients));
  return {
    execute: <T>(key: string, kind: ActionKind, payload: unknown) =>
      executor.execute<T>(key, kind, payload),
    retry: <T>(key: string) => executor.retry<T>(key),
    dismiss: (key) => executor.dismiss(key),
    busy: false,
    failures: [],
  };
}

function draft(id: string, text: string, attachmentId: string, fileName: string): MessageDraft {
  const metadata = attachmentMetadata(
    create(AttachmentSchema, {
      attachmentId,
      fileName,
      mediaType: 'text/plain',
      sizeBytes: 12n,
      sha256: attachmentId.padEnd(64, '0').slice(0, 64),
    }),
  );
  return {
    id,
    text,
    attachments: [
      {
        localId: `local-${attachmentId}`,
        actionKey: `upload-${attachmentId}`,
        actionId: `action-${attachmentId}`,
        fileName,
        declaredMediaType: 'text/plain',
        sizeBytes: 12,
        sha256: metadata.sha256,
        status: 'ready',
        metadata,
      },
    ],
  };
}

describe('authenticated account workbench', () => {
  it('renders the approved main pane with account-scoped identity, drafts and attachments', () => {
    const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
    const storage = new MemoryStorage();
    const storageA = scopedStorage(storage, accountScopeKey(accountA));
    const storageB = scopedStorage(storage, accountScopeKey(accountB));
    saveDraft(storageA, accountA.mainThreadId, draft('draft-a', '账号 A 主草稿', 'a', 'alpha.txt'));
    saveDraft(storageB, accountB.mainThreadId, draft('draft-b', '账号 B 主草稿', 'b', 'beta.txt'));
    const render = (identity: Identity, accountStorage: StorageLike | undefined) =>
      renderToStaticMarkup(
        createElement(AccountWorkbench, {
          identity,
          clients,
          storage: accountStorage,
          actions: actionView(clients),
          registerCompletion: () => {},
          onLogout: async () => {},
        }),
      );

    const htmlA = render(accountA, storageA);
    const htmlB = render(accountB, storageB);
    expect(htmlA).toContain('data-main-mounted="true"');
    expect(htmlA).not.toContain('aria-label="主环境状态"');
    expect(htmlA).not.toContain('平台主环境');
    expect(htmlA).not.toContain('/workspace');
    expect(htmlA).toContain('data-composer-owner="main"');
    expect(htmlA).toContain('session-layout');
    expect(htmlA).not.toContain('class="topbar"');
    expect(htmlA).not.toContain('breadcrumbs');
    expect(htmlA).not.toContain('返回主对话');
    expect(htmlA).toContain('aria-label="打开导航"');
    expect(htmlA).toContain('brand-mark');
    expect(htmlA).toContain('type="file"');
    expect(htmlA).toContain('multiple=""');
    expect(htmlA).toContain('用户 A');
    expect(htmlA).toContain('账号 A 主草稿');
    expect(htmlA).toContain('alpha.txt');
    expect(htmlA).toContain('main-a');
    expect(htmlA).not.toContain('账号 B 主草稿');
    expect(htmlA).not.toContain('beta.txt');

    expect(htmlB).toContain('data-main-mounted="true"');
    expect(htmlB).toContain('用户 B');
    expect(htmlB).toContain('账号 B 主草稿');
    expect(htmlB).toContain('beta.txt');
    expect(htmlB).toContain('main-b');
    expect(htmlB).not.toContain('账号 A 主草稿');
    expect(htmlB).not.toContain('alpha.txt');
  });
});
