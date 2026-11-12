import { applyDraftCompletion, type DraftCompletion } from './action-completion.js';
import type { StorageLike } from './actions.js';
import { clearDraft, loadDraft, saveDraft } from './drafts.js';

export function clearSubmittedDraft(
  storage: StorageLike | undefined,
  completion: DraftCompletion,
): boolean {
  const current = loadDraft(storage, completion.threadId);
  const completed = applyDraftCompletion(current, completion);
  if (!completed) return false;
  if (completed.id === current.id) saveDraft(storage, completion.threadId, completed);
  else clearDraft(storage, completion.threadId);
  return true;
}
