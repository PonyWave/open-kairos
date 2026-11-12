/// <reference lib="dom" />

import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import {
  AttachmentSchema,
  AttachmentService,
  create,
  type DeleteAttachmentResponse,
  DeleteAttachmentResponseSchema,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { completeGuiAction } from './action-completion.js';
import { ActionExecutor } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import { ClientActionStore, type StorageLike } from './actions.js';
import { attachmentMetadata } from './attachments.js';
import { createKairosClients } from './client.js';
import { type MessageDraft, newDraft, saveDraft } from './drafts.js';

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

const metadata = attachmentMetadata(
  create(AttachmentSchema, {
    attachmentId: 'attachment-1',
    fileName: 'a.txt',
    mediaType: 'text/plain',
    sizeBytes: 1n,
    sha256: 'a'.repeat(64),
  }),
);

function deleteHarness(deleted: boolean) {
  const ids: string[] = [];
  const accepted = new Map<string, DeleteAttachmentResponse>();
  const transport = createRouterTransport((router) => {
    router.service(AttachmentService, {
      deleteAttachment(request) {
        ids.push(request.clientActionId);
        const existing = accepted.get(request.clientActionId);
        if (existing) return existing;
        const response = create(DeleteAttachmentResponseSchema, {
          clientActionId: request.clientActionId,
          attachmentId: request.attachmentId,
          deleted,
        });
        accepted.set(request.clientActionId, response);
        if (ids.length === 1) throw new ConnectError('response lost', Code.Unavailable);
        return response;
      },
    });
  });
  return { handlers: createActionHandlers(createKairosClients({ transport })), ids };
}

function readyDraft(): MessageDraft {
  return {
    ...newDraft(),
    attachments: [
      {
        localId: 'local-1',
        actionKey: 'upload-1',
        actionId: 'upload-action-1',
        fileName: 'a.txt',
        declaredMediaType: 'text/plain',
        sizeBytes: 1,
        sha256: 'a'.repeat(64),
        status: 'deleting',
        metadata,
      },
    ],
  };
}

describe('DeleteAttachment action completion', () => {
  it.each([true, false])(
    'keeps the original id after response loss and removes only the draft reference (deleted=%s)',
    async (deleted) => {
      const storage = new MemoryStorage();
      const draft = readyDraft();
      const other = readyDraft();
      saveDraft(storage, 'main-1', draft);
      saveDraft(storage, 'task-1', other);
      const harness = deleteHarness(deleted);
      const store = new ClientActionStore(storage);
      const notices: string[] = [];
      const executor = new ActionExecutor(store, harness.handlers, (record, result) => {
        completeGuiAction(record, result, {
          upsertThread: () => {},
          selectThread: () => {},
          completeDraft: () => {},
          removeDraftAttachment: ({ draftOwner, draftId, localId, attachmentId }) => {
            const current = draftOwner === 'main-1' ? draft : other;
            if (current.id !== draftId) return;
            current.attachments = (current.attachments ?? []).filter(
              (item) => item.localId !== localId || item.metadata?.attachmentId !== attachmentId,
            );
            saveDraft(storage, draftOwner, current);
          },
          closeForm: () => {},
          showNotice: (message) => notices.push(message),
        });
      });
      const key = `delete-attachment:main:main-1:${draft.id}:local-1`;
      const payload = {
        draftOwner: 'main-1',
        composerOwner: 'main',
        threadId: 'main-1',
        draftId: draft.id,
        localId: 'local-1',
        attachmentId: metadata.attachmentId,
      };

      await executor.execute(key, 'deleteAttachment', payload);
      expect(draft.attachments).toHaveLength(1);
      expect(store.pending()).toHaveLength(1);
      await executor.retry(key);

      expect(draft.attachments).toEqual([]);
      expect(other.attachments).toHaveLength(1);
      expect(harness.ids).toHaveLength(2);
      expect(harness.ids[0]).toBe(harness.ids[1]);
      expect(store.pending()).toEqual([]);
      expect(notices).toEqual([]);
    },
  );
});
