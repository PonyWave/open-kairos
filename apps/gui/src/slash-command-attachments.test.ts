/// <reference lib="dom" />

import { CompactContextStatus } from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import {
  applyDraftCompletion,
  completeGuiAction,
  type DraftCompletion,
} from './action-completion.js';
import type { ActionKind, ClientActionRecord, StorageLike } from './actions.js';
import type { DraftAttachment, MessageDraft } from './drafts.js';
import { loadDraft, saveDraft } from './drafts.js';

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

function pending(
  id: string,
  status: 'reading' | 'uploading' | 'needs-reselection',
  file?: File,
): DraftAttachment {
  return {
    localId: `local-${id}`,
    actionKey: `upload-${id}`,
    ...(status === 'reading' ? {} : { actionId: `action-${id}` }),
    fileName: `${id}.txt`,
    declaredMediaType: 'text/plain',
    sizeBytes: file?.size ?? 3,
    sha256: 'a'.repeat(64),
    status,
    ...(file === undefined ? {} : { file }),
  };
}

function commandRecord(kind: ActionKind, key: string, draftId: string): ClientActionRecord {
  const command = kind === 'reloadResources' ? '/reload' : '/compact';
  return {
    id: `id-${key}`,
    key,
    kind,
    fingerprint: key,
    payload: { threadId: 'thread-1', draftId, text: command },
  };
}

function commandResult(kind: ActionKind): unknown {
  return kind === 'reloadResources'
    ? {
        $typeName: 'kairos.gui.v1.ReloadResourcesResponse',
        snapshotId: 'snapshot-1',
        changed: false,
        resources: [],
        added: [],
        updated: [],
        removed: [],
      }
    : {
        $typeName: 'kairos.gui.v1.CompactContextResponse',
        operationId: 'compact-1',
        status: CompactContextStatus.NOOP,
        readThroughSeq: 0n,
        recapIds: [],
      };
}

describe('slash command completion with newly added attachments', () => {
  it.each(['reloadResources', 'compactContext'] as const)(
    'preserves reading, uploading and reselection state after %s and a refresh',
    (kind) => {
      const command = kind === 'reloadResources' ? '/reload' : '/compact';
      const file = new File(['new'], 'reading.txt', { type: 'text/plain' });
      const attachments = [
        pending('reading', 'reading', file),
        pending('uploading', 'uploading', file),
        pending('needs', 'needs-reselection'),
      ];
      const draft: MessageDraft = { id: 'draft-1', text: command, attachments };
      let completion: DraftCompletion | undefined;
      completeGuiAction(commandRecord(kind, `command:${kind}`, draft.id), commandResult(kind), {
        upsertThread: () => {},
        selectThread: () => {},
        completeDraft: (input) => {
          completion = input;
        },
        closeForm: () => {},
        showNotice: () => {},
      });

      expect(completion?.attachmentIds).toEqual([]);
      if (!completion) throw new Error('Missing command completion.');
      const completed = applyDraftCompletion(draft, completion);
      if (!completed) throw new Error('Command draft was not completed.');
      expect(completed.id).toBe(draft.id);
      expect(completed.text).toBe('');
      const current = completed.attachments;
      if (!current) throw new Error('Attachments were cleared.');
      expect(current.map((item) => item.status)).toEqual([
        'reading',
        'uploading',
        'needs-reselection',
      ]);
      current.forEach((item, index) => {
        expect(item).toBe(attachments[index]);
      });
      expect(current[0]?.file).toBe(file);
      expect(current[1]?.file).toBe(file);
      expect(current[1]?.actionId).toBe('action-uploading');
      expect(current[2]?.actionId).toBe('action-needs');

      const storage = new MemoryStorage();
      saveDraft(storage, 'thread-1', completed);
      const restored = loadDraft(storage, 'thread-1');
      expect(restored.id).toBe(draft.id);
      expect(restored.text).toBe('');
      expect(restored.attachments?.map((item) => item.status)).toEqual([
        'error',
        'needs-reselection',
        'needs-reselection',
      ]);
      expect(restored.attachments?.[1]?.actionId).toBe('action-uploading');
      expect(restored.attachments?.[2]?.actionId).toBe('action-needs');
      expect(restored.attachments?.every((item) => item.file === undefined)).toBe(true);
    },
  );

  it('treats missing attachmentIds as an empty snapshot for restored commands', () => {
    const file = new File(['new'], 'uploading.txt', { type: 'text/plain' });
    const attachment = pending('uploading', 'uploading', file);
    const completed = applyDraftCompletion(
      { id: 'draft-1', text: '/reload', attachments: [attachment] },
      { threadId: 'thread-1', draftId: 'draft-1', text: '/reload', exactText: true },
    );

    expect(completed?.id).toBe('draft-1');
    expect(completed?.text).toBe('');
    expect(completed?.attachments?.[0]).toBe(attachment);
    expect(completed?.attachments?.[0]?.file).toBe(file);
    expect(completed?.attachments?.[0]?.actionId).toBe('action-uploading');
  });
});
