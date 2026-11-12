import type { StorageLike } from './actions.js';
import type { AttachmentMetadata } from './attachments.js';

export const localTaskDraftId = 'local:new-task';

export type DraftAttachmentStatus =
  | 'reading'
  | 'uploading'
  | 'ready'
  | 'unknown'
  | 'needs-reselection'
  | 'deleting'
  | 'error';

export interface DraftAttachment {
  localId: string;
  actionKey: string;
  actionId?: string | undefined;
  fileName: string;
  declaredMediaType: string;
  sizeBytes: number;
  sha256?: string | undefined;
  source?: 'clipboard' | undefined;
  status: DraftAttachmentStatus;
  metadata?: AttachmentMetadata | undefined;
  error?: string | undefined;
  file?: File | undefined;
}

export interface MessageDraft {
  id: string;
  text: string;
  attachments?: DraftAttachment[];
  restoredInputIds?: string[];
}

export function newDraft(): MessageDraft {
  return { id: crypto.randomUUID(), text: '', attachments: [] };
}

export function loadDraft(storage: StorageLike | undefined, threadId: string): MessageDraft {
  const raw = storage?.getItem(draftKey(threadId));
  if (!raw) return newDraft();
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('本地草稿格式无效。');
  }
  const id = Reflect.get(value, 'id');
  const text = Reflect.get(value, 'text');
  if (typeof id !== 'string' || !id || typeof text !== 'string') {
    throw new Error('本地草稿格式无效。');
  }
  const persistedAttachments = Reflect.get(value, 'attachments');
  if (persistedAttachments === undefined)
    return {
      id,
      text,
    };
  if (!Array.isArray(persistedAttachments)) throw new Error('本地草稿附件格式无效。');
  return {
    id,
    text,
    attachments: persistedAttachments.map((item) => restoreAttachment(item)),
    ...(Reflect.get(value, 'restoredInputIds') === undefined
      ? {}
      : { restoredInputIds: restoredInputIds(Reflect.get(value, 'restoredInputIds')) }),
  };
}

export function saveDraft(
  storage: StorageLike | undefined,
  threadId: string,
  draft: MessageDraft,
): void {
  const persisted = {
    id: draft.id,
    text: draft.text,
    ...(draft.restoredInputIds === undefined ? {} : { restoredInputIds: draft.restoredInputIds }),
    ...(draft.attachments === undefined
      ? {}
      : { attachments: draft.attachments.map((item) => persistAttachment(item)) }),
  };
  storage?.setItem(draftKey(threadId), JSON.stringify(persisted));
}

export function clearDraft(storage: StorageLike | undefined, threadId: string): void {
  storage?.removeItem(draftKey(threadId));
}

export function composerInputId({
  composerOwner,
  threadId,
  draftId,
}: {
  composerOwner: string;
  threadId: string;
  draftId: string;
}): string {
  return [composerOwner, threadId, draftId]
    .map((part) => encodeURIComponent(part))
    .join(':')
    .concat(':message-input');
}

export function persistAttachment(item: DraftAttachment): Record<string, unknown> {
  return {
    localId: item.localId,
    actionKey: item.actionKey,
    ...(item.actionId === undefined ? {} : { actionId: item.actionId }),
    fileName: item.fileName,
    declaredMediaType: item.declaredMediaType,
    sizeBytes: item.sizeBytes,
    ...(item.sha256 === undefined ? {} : { sha256: item.sha256 }),
    ...(item.source === undefined ? {} : { source: item.source }),
    status: item.status,
    ...(item.metadata === undefined ? {} : { metadata: persistMetadata(item.metadata) }),
    ...(item.error === undefined ? {} : { error: item.error }),
  };
}

function persistMetadata(metadata: AttachmentMetadata): Record<string, unknown> {
  return {
    attachmentId: metadata.attachmentId,
    fileName: metadata.fileName,
    mediaType: metadata.mediaType,
    sizeBytes: metadata.sizeBytes.toString(),
    ...(metadata.width === undefined ? {} : { width: metadata.width }),
    ...(metadata.height === undefined ? {} : { height: metadata.height }),
    sha256: metadata.sha256,
    ...(metadata.createdAt === undefined
      ? {}
      : {
          createdAt: {
            seconds: metadata.createdAt.seconds.toString(),
            nanos: metadata.createdAt.nanos,
          },
        }),
  };
}

export function restoreAttachment(value: unknown): DraftAttachment {
  const item = record(value);
  const localId = identifier(item.localId);
  const actionKey = identifier(item.actionKey);
  const actionId = optionalIdentifier(item.actionId);
  const fileName = identifier(item.fileName);
  if (typeof item.declaredMediaType !== 'string') invalidAttachment();
  const declaredMediaType = item.declaredMediaType;
  if (!Number.isSafeInteger(item.sizeBytes) || (item.sizeBytes as number) < 0) {
    invalidAttachment();
  }
  const sizeBytes = item.sizeBytes as number;
  if (
    item.sha256 !== undefined &&
    (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))
  ) {
    invalidAttachment();
  }
  const sha256 = item.sha256 as string | undefined;
  if (item.source !== undefined && item.source !== 'clipboard') invalidAttachment();
  const source = item.source as 'clipboard' | undefined;
  const metadata = item.metadata === undefined ? undefined : restoreMetadata(item.metadata);
  const status = item.status;
  if (
    status !== 'reading' &&
    status !== 'uploading' &&
    status !== 'ready' &&
    status !== 'unknown' &&
    status !== 'needs-reselection' &&
    status !== 'deleting' &&
    status !== 'error'
  ) {
    invalidAttachment();
  }
  if (item.error !== undefined && typeof item.error !== 'string') invalidAttachment();
  if ((status === 'ready' || status === 'deleting') && metadata === undefined) {
    invalidAttachment();
  }
  if (status === 'uploading' && actionId === undefined) invalidAttachment();
  if (status === 'needs-reselection' && actionId === undefined) invalidAttachment();
  const base = {
    localId,
    actionKey,
    ...(actionId === undefined ? {} : { actionId }),
    fileName,
    declaredMediaType,
    sizeBytes,
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(source === undefined ? {} : { source }),
    metadata,
    ...(item.error === undefined ? {} : { error: item.error as string }),
  };
  if (status === 'reading') {
    return {
      ...base,
      status: 'error',
      error: '文件读取在刷新前未完成，请移除后重新添加。',
    };
  }
  if (status === 'uploading' || status === 'unknown') {
    return {
      ...base,
      status: 'needs-reselection',
      error: '上传结果尚未确认，请重新选择同一文件以核对。',
    };
  }
  return { ...base, status };
}

function restoreMetadata(value: unknown): AttachmentMetadata {
  const metadata = record(value);
  const attachmentId = identifier(metadata.attachmentId);
  const fileName = identifier(metadata.fileName);
  if (
    metadata.mediaType !== 'text/plain' &&
    metadata.mediaType !== 'image/png' &&
    metadata.mediaType !== 'image/jpeg'
  ) {
    invalidAttachment();
  }
  const mediaType = metadata.mediaType;
  if (typeof metadata.sizeBytes !== 'string' || !/^(0|[1-9][0-9]*)$/.test(metadata.sizeBytes)) {
    invalidAttachment();
  }
  const sizeBytes = BigInt(metadata.sizeBytes as string);
  if (sizeBytes <= 0n) invalidAttachment();
  if (typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
    invalidAttachment();
  }
  const width = optionalDimension(metadata.width);
  const height = optionalDimension(metadata.height);
  if (mediaType === 'text/plain' && (width !== undefined || height !== undefined)) {
    invalidAttachment();
  }
  if (mediaType !== 'text/plain' && (width === undefined || height === undefined)) {
    invalidAttachment();
  }
  let createdAt: AttachmentMetadata['createdAt'];
  if (metadata.createdAt !== undefined) {
    const timestamp = record(metadata.createdAt);
    if (
      typeof timestamp.seconds !== 'string' ||
      !/^-?[0-9]+$/.test(timestamp.seconds) ||
      !Number.isInteger(timestamp.nanos)
    ) {
      invalidAttachment();
    }
    createdAt = {
      $typeName: 'google.protobuf.Timestamp',
      seconds: BigInt(timestamp.seconds as string),
      nanos: timestamp.nanos as number,
    };
  }
  return {
    attachmentId,
    fileName,
    mediaType,
    sizeBytes,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    sha256: metadata.sha256,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

function optionalDimension(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > 0xffffffff) {
    invalidAttachment();
  }
  return value as number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidAttachment();
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value) invalidAttachment();
  return value;
}

function optionalIdentifier(value: unknown): string | undefined {
  return value === undefined ? undefined : identifier(value);
}

function invalidAttachment(): never {
  throw new Error('本地草稿附件格式无效。');
}

function restoredInputIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('本地草稿的队列恢复记录无效。');
  }
  return [...value];
}

function draftKey(threadId: string): string {
  return `kairos.message-draft.v1.${threadId}`;
}
