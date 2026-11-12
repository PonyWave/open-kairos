import { useCallback, useRef, useState } from 'react';
import type { DraftCompletion } from './action-completion.js';
import { applyDraftCompletion } from './action-completion.js';
import type { StorageLike } from './actions.js';
import { clearDraft, loadDraft, type MessageDraft, saveDraft } from './drafts.js';
import { type QueueDraftRestore, restoreQueuedDraft } from './queue-draft.js';

export function useDrafts(storage: StorageLike | undefined) {
  const cache = useRef(new Map<string, MessageDraft>());
  const [, setRevision] = useState(0);

  const getDraft = useCallback(
    (ownerId: string): MessageDraft => {
      const cached = cache.current.get(ownerId);
      if (cached) return cached;
      const draft = loadDraft(storage, ownerId);
      cache.current.set(ownerId, draft);
      return draft;
    },
    [storage],
  );

  const updateDraft = useCallback(
    (ownerId: string, draft: MessageDraft) => {
      saveDraft(storage, ownerId, draft);
      cache.current.set(ownerId, draft);
      setRevision((value) => value + 1);
    },
    [storage],
  );

  const completeDraft = useCallback(
    (completion: DraftCompletion) => {
      const current = getDraft(completion.threadId);
      const completed = applyDraftCompletion(current, completion);
      if (!completed) return;
      if (completed.id === current.id) saveDraft(storage, completion.threadId, completed);
      else clearDraft(storage, completion.threadId);
      cache.current.set(completion.threadId, completed);
      setRevision((value) => value + 1);
    },
    [getDraft, storage],
  );

  const removeAttachment = useCallback(
    ({
      draftOwner,
      draftId,
      localId,
      attachmentId,
    }: {
      draftOwner: string;
      draftId: string;
      localId: string;
      attachmentId: string;
    }) => {
      const current = getDraft(draftOwner);
      if (current.id !== draftId) return;
      const found = (current.attachments ?? []).some(
        (item) => item.localId === localId && item.metadata?.attachmentId === attachmentId,
      );
      if (!found) return;
      const next = {
        ...current,
        attachments: (current.attachments ?? []).filter((item) => item.localId !== localId),
      };
      saveDraft(storage, draftOwner, next);
      cache.current.set(draftOwner, next);
      setRevision((value) => value + 1);
    },
    [getDraft, storage],
  );

  const restoreQueueDraft = useCallback(
    (restore: QueueDraftRestore) => {
      const current = getDraft(restore.draftOwner);
      const next = restoreQueuedDraft(current, restore);
      if (next !== current) updateDraft(restore.draftOwner, next);
    },
    [getDraft, updateDraft],
  );

  return { getDraft, updateDraft, completeDraft, removeAttachment, restoreQueueDraft };
}
