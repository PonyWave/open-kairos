import { type Attachment, validateAttachment } from '@kairos/contracts';

export const maxAttachmentsPerInput = 4;
export const maxAttachmentBytes = 700_000;
export const maxAttachmentTotalBytes = 2_800_000;
export const maxTextAttachmentBytes = 200_000;
export const maxTextAttachmentTotalBytes = 256 * 1024;
export const attachmentDownloadPageBytes = 256 * 1024;

export type AttachmentMediaType = 'text/plain' | 'image/png' | 'image/jpeg';
export type AttachmentMetadata = Pick<
  Attachment,
  | 'attachmentId'
  | 'fileName'
  | 'mediaType'
  | 'sizeBytes'
  | 'width'
  | 'height'
  | 'sha256'
  | 'createdAt'
>;

export function attachmentMetadata(attachment: Attachment): AttachmentMetadata {
  validateAttachment(attachment);
  return {
    attachmentId: attachment.attachmentId,
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    ...(attachment.width === undefined ? {} : { width: attachment.width }),
    ...(attachment.height === undefined ? {} : { height: attachment.height }),
    sha256: attachment.sha256,
    ...(attachment.createdAt === undefined ? {} : { createdAt: { ...attachment.createdAt } }),
  };
}

export function validateAttachmentLimits(
  attachments: readonly Pick<AttachmentMetadata, 'attachmentId' | 'mediaType' | 'sizeBytes'>[],
): void {
  if (attachments.length > maxAttachmentsPerInput) {
    throw new Error(`每条输入最多包含 ${maxAttachmentsPerInput} 个附件。`);
  }
  if (new Set(attachments.map((item) => item.attachmentId)).size !== attachments.length) {
    throw new Error('同一内容不能重复添加为多个附件。');
  }
  let totalBytes = 0n;
  let textBytes = 0n;
  for (const attachment of attachments) {
    totalBytes += attachment.sizeBytes;
    if (attachment.mediaType === 'text/plain') textBytes += attachment.sizeBytes;
  }
  if (totalBytes > BigInt(maxAttachmentTotalBytes)) {
    throw new Error(`附件总大小不能超过 ${maxAttachmentTotalBytes} 字节。`);
  }
  if (textBytes > BigInt(maxTextAttachmentTotalBytes)) {
    throw new Error(`文本附件总大小不能超过 ${maxTextAttachmentTotalBytes} 字节。`);
  }
}

export function formatAttachmentSize(sizeBytes: bigint | number): string {
  const size = typeof sizeBytes === 'bigint' ? sizeBytes : BigInt(sizeBytes);
  if (size < 1024n) return `${size} 字节`;
  if (size < 1024n * 1024n) return `${(Number(size) / 1024).toFixed(1)} KiB`;
  return `${(Number(size) / (1024 * 1024)).toFixed(1)} MiB`;
}

export function safeAttachmentFileName(fileName: string): string {
  const plain = [...fileName]
    .map((character) => {
      const code = character.charCodeAt(0);
      return character === '/' || character === '\\' || code <= 0x1f || code === 0x7f
        ? '_'
        : character;
    })
    .join('');
  const normalized = plain.replace(/^\.+/, '').trim().slice(0, 255);
  return normalized || 'attachment';
}
