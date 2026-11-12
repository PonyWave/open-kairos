import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import {
  AttachmentSchema,
  AttachmentSource,
  create,
  DelegationReferenceSchema,
  InputMode,
  InputSchema,
  InputStatus,
  QueueService,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { type ActionCompletionEffects, completeGuiAction } from './action-completion.js';
import { ActionExecutor } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import { ClientActionStore, type StorageLike } from './actions.js';
import { createKairosClients } from './client.js';
import { planComposerSubmission } from './composer-submission.js';
import { loadDraft, newDraft, saveDraft } from './drafts.js';
import { queueDraftRestorePayload, reorderQueuedIds, restoreQueuedDraft } from './queue-draft.js';

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  failDraftWrite = false;
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failDraftWrite && key.startsWith('kairos.message-draft'))
      throw new Error('本地写入失败');
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

function input() {
  return create(InputSchema, {
    inputId: 'queued-1',
    threadId: 'thread-1',
    text: '待编辑的队列内容',
    mode: InputMode.FOLLOW_UP,
    status: InputStatus.QUEUED,
    version: 1n,
    attachments: [
      create(AttachmentSchema, {
        attachmentId: 'file-1',
        fileName: 'notes.txt',
        mediaType: 'text/plain',
        sizeBytes: 12n,
        sha256: 'a'.repeat(64),
        source: AttachmentSource.CLIPBOARD,
      }),
    ],
  });
}
function effects(storage: StorageLike): ActionCompletionEffects {
  return {
    upsertThread: () => {},
    selectThread: () => {},
    completeDraft: () => {},
    closeForm: () => {},
    showNotice: () => {},
    restoreQueueDraft: (restore) =>
      saveDraft(
        storage,
        restore.draftOwner,
        restoreQueuedDraft(loadDraft(storage, restore.draftOwner), restore),
      ),
  };
}

describe('editing queued input through the composer', () => {
  it.each(['response-loss', 'local-write-failure'])(
    'restores text and attachments once after %s, using the original removal id',
    async (failure) => {
      const queued = input(),
        storage = new MemoryStorage();
      const original = { ...newDraft(), text: '输入框中已有的草稿' };
      saveDraft(storage, 'thread-1', original);
      const requestIds: string[] = [];
      let removals = 0;
      const transport = createRouterTransport((router) =>
        router.service(QueueService, {
          removeInput(request) {
            requestIds.push(request.clientActionId);
            if (queued.status === InputStatus.QUEUED) {
              queued.status = InputStatus.CANCELLED;
              removals++;
            }
            if (failure === 'response-loss' && requestIds.length === 1)
              throw new ConnectError('回执丢失', Code.Unavailable);
            return {
              clientActionId: request.clientActionId,
              inputId: queued.inputId,
              queueVersion: 2n,
            };
          },
        }),
      );
      const handlers = createActionHandlers(createKairosClients({ transport }));
      const complete = (record: Parameters<typeof completeGuiAction>[0], result: unknown) =>
        completeGuiAction(record, result, effects(storage));
      const key = 'remove-input:queued-1';
      const payload = {
        threadId: 'thread-1',
        inputId: queued.inputId,
        expectedVersion: '1',
        draftRestore: queueDraftRestorePayload(queued, 'thread-1'),
      };
      const firstStore = new ClientActionStore(storage);
      const executor = new ActionExecutor(firstStore, handlers, complete);
      storage.failDraftWrite = failure === 'local-write-failure';
      await executor.execute(key, 'removeInput', payload);
      expect(executor.state.failures[0]?.outcome).toBe('unknown');
      expect(loadDraft(storage, 'thread-1').text).toBe(original.text);
      const record = firstStore.get(key);
      expect(record).toBeDefined();
      storage.failDraftWrite = false;
      const restoredStore = new ClientActionStore(storage);
      const restored = new ActionExecutor(restoredStore, handlers, complete);
      await restored.retry(key);
      const draft = loadDraft(storage, 'thread-1');
      expect(draft.text).toBe('待编辑的队列内容\n\n输入框中已有的草稿');
      expect(draft.attachments?.map((file) => file.metadata?.attachmentId)).toEqual(['file-1']);
      expect(draft.attachments?.map((file) => file.source)).toEqual(['clipboard']);
      expect(
        planComposerSubmission({
          draftId: draft.id,
          text: draft.text,
          attachments: draft.attachments,
          mode: InputMode.FOLLOW_UP,
          busy: false,
          isTaskDraft: false,
          selectedThreadId: 'thread-1',
          snapshotReady: true,
        }),
      ).toMatchObject({
        kind: 'action',
        payload: { attachmentIds: ['file-1'], clipboardAttachmentIds: ['file-1'] },
      });
      expect(removals).toBe(1);
      expect(new Set(requestIds).size).toBe(1);
      expect(restoredStore.pending()).toEqual([]);
      if (record)
        completeGuiAction(record, { inputId: queued.inputId, queueVersion: 2n }, effects(storage));
      expect(loadDraft(storage, 'thread-1')).toEqual(draft);
    },
  );

  it('keeps delegated inputs out of generic editing', () => {
    expect(() =>
      queueDraftRestorePayload(
        create(InputSchema, {
          ...input(),
          delegation: create(DelegationReferenceSchema, {
            sourceThreadId: 'parent',
            sourceAgentId: 'thread',
            sourceToolCallId: 'call',
          }),
        }),
        'thread-1',
      ),
    ).toThrow('委派输入');
  });

  it('moves a dropped row without dropping or duplicating neighboring inputs', () => {
    expect(reorderQueuedIds(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
    expect(reorderQueuedIds(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(reorderQueuedIds(['a', 'b'], 'missing', 'b')).toEqual(['a', 'b']);
  });
});
