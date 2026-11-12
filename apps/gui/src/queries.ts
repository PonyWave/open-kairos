import {
  create,
  DownloadAttachmentRequestSchema,
  validateDownloadAttachmentResponse,
} from '@kairos/contracts';
import {
  type AttachmentMetadata,
  attachmentDownloadPageBytes,
  attachmentMetadata,
} from './attachments.js';
import type { KairosClients } from './client.js';

export async function downloadAttachmentBytes(
  clients: Pick<KairosClients, 'attachments'>,
  expected: AttachmentMetadata,
  signal?: AbortSignal,
): Promise<{ metadata: AttachmentMetadata; bytes: Uint8Array }> {
  let offset = 0n;
  let metadata = expected;
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const request = create(DownloadAttachmentRequestSchema, {
      attachmentId: expected.attachmentId,
      offset,
      limitBytes: attachmentDownloadPageBytes,
    });
    const response = await clients.attachments.downloadAttachment(
      request,
      signal === undefined ? {} : { signal },
    );
    validateDownloadAttachmentResponse(response, request);
    if (!response.attachment) throw new Error('DownloadAttachment 缺少附件元数据。');
    const currentMetadata = attachmentMetadata(response.attachment);
    if (
      currentMetadata.fileName !== expected.fileName ||
      currentMetadata.mediaType !== expected.mediaType ||
      currentMetadata.sizeBytes !== expected.sizeBytes ||
      currentMetadata.sha256 !== expected.sha256
    ) {
      throw new Error('DownloadAttachment 返回的附件元数据与当前记录不一致。');
    }
    metadata = currentMetadata;
    if (response.data.length === 0 && response.nextOffset !== undefined) {
      throw new Error('DownloadAttachment 分页没有前进。');
    }
    chunks.push(response.data);
    received += response.data.length;
    if (received > Number(expected.sizeBytes)) throw new Error('附件正文超过元数据大小。');
    if (response.nextOffset === undefined) break;
    offset = response.nextOffset;
  }
  if (offset + BigInt(chunks.at(-1)?.length ?? 0) !== expected.sizeBytes) {
    throw new Error('附件正文未完整下载。');
  }
  const bytes = new Uint8Array(received);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.length;
  }
  return { metadata, bytes };
}
