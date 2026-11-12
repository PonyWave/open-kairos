import { AttachmentSource, type Input } from '@kairos/contracts';
import {
  type DraftAttachment,
  type MessageDraft,
  persistAttachment,
  restoreAttachment,
} from './drafts.js';

export interface QueueDraftRestore {
  draftOwner: string;
  inputId: string;
  text: string;
  attachments: DraftAttachment[];
}

export function queueDraftRestorePayload(input: Input, draftOwner: string) {
  if (input.delegation) throw new Error('委派输入由原调用管理。');
  return {
    draftOwner,
    inputId: input.inputId,
    text: input.text,
    attachments: input.attachments.map((metadata) =>
      persistAttachment({
        localId: `queue:${input.inputId}:${metadata.attachmentId}`,
        actionKey: `queue:${input.inputId}:${metadata.attachmentId}`,
        fileName: metadata.fileName,
        declaredMediaType: metadata.mediaType,
        sizeBytes: Number(metadata.sizeBytes),
        sha256: metadata.sha256,
        source: metadata.source === AttachmentSource.CLIPBOARD ? 'clipboard' : undefined,
        status: 'ready',
        metadata,
      }),
    ),
  };
}

export function parseQueueDraftRestore(value: unknown): QueueDraftRestore {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('队列草稿恢复记录无效。');
  const draftOwner = Reflect.get(value, 'draftOwner');
  const inputId = Reflect.get(value, 'inputId');
  const text = Reflect.get(value, 'text');
  const attachments: unknown = Reflect.get(value, 'attachments');
  if (
    typeof draftOwner !== 'string' ||
    !draftOwner ||
    typeof inputId !== 'string' ||
    !inputId ||
    typeof text !== 'string' ||
    !Array.isArray(attachments)
  )
    throw new Error('队列草稿恢复记录无效。');
  return { draftOwner, inputId, text, attachments: attachments.map(restoreAttachment) };
}

export function restoreQueuedDraft(
  current: MessageDraft,
  restore: QueueDraftRestore,
): MessageDraft {
  if (current.restoredInputIds?.includes(restore.inputId)) return current;
  const attachments = [...(current.attachments ?? [])];
  const ids = new Set(attachments.map((item) => item.metadata?.attachmentId));
  for (const attachment of restore.attachments) {
    if (!ids.has(attachment.metadata?.attachmentId)) {
      attachments.push(attachment);
      ids.add(attachment.metadata?.attachmentId);
    }
  }
  return {
    ...current,
    text: [restore.text, current.text].filter(Boolean).join('\n\n'),
    attachments,
    restoredInputIds: [...(current.restoredInputIds ?? []), restore.inputId],
  };
}

export function reorderQueuedIds(
  ids: readonly string[],
  sourceId: string,
  targetId: string,
): string[] {
  const from = ids.indexOf(sourceId),
    to = ids.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, sourceId);
  return next;
}
