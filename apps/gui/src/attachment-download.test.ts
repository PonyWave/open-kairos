/// <reference lib="dom" />

import { createRouterTransport } from '@connectrpc/connect';
import { AttachmentSchema, AttachmentService, create } from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentList } from './attachment-list.js';
import { attachmentMetadata, safeAttachmentFileName } from './attachments.js';
import { BlobUrlLease } from './blob-url-lease.js';
import { createKairosClients } from './client.js';
import { downloadAttachmentBytes } from './queries.js';

const encoder = new TextEncoder();
const metadata = attachmentMetadata(
  create(AttachmentSchema, {
    attachmentId: 'attachment-1',
    fileName: 'note.txt',
    mediaType: 'text/plain',
    sizeBytes: 8n,
    sha256: 'a'.repeat(64),
  }),
);

afterEach(() => vi.restoreAllMocks());

describe('attachment download', () => {
  it('reads real binary Connect pages until the validated final offset', async () => {
    const bytes = encoder.encode('abcdefgh');
    const offsets: bigint[] = [];
    const transport = createRouterTransport((router) => {
      router.service(AttachmentService, {
        downloadAttachment(request) {
          const offset = request.offset ?? 0n;
          offsets.push(offset);
          const start = Number(offset);
          const end = Math.min(start + 3, bytes.length);
          return {
            attachment: metadata,
            data: bytes.slice(start, end),
            ...(end < bytes.length ? { nextOffset: BigInt(end) } : {}),
          };
        },
      });
    });
    const clients = createKairosClients({ transport });

    const downloaded = await downloadAttachmentBytes(clients, metadata);
    expect([...downloaded.bytes]).toEqual([...bytes]);
    expect(offsets).toEqual([0n, 3n, 6n]);
  });

  it('rejects a page that does not advance instead of looping forever', async () => {
    const transport = createRouterTransport((router) => {
      router.service(AttachmentService, {
        downloadAttachment(request) {
          return {
            attachment: metadata,
            data: new Uint8Array(),
            nextOffset: request.offset ?? 0n,
          };
        },
      });
    });
    await expect(
      downloadAttachmentBytes(createKairosClients({ transport }), metadata),
    ).rejects.toThrow('分页没有前进');
  });

  it('renders real metadata without external image URLs or eager previews', () => {
    const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
    const html = renderToStaticMarkup(
      createElement(AttachmentList, { attachments: [metadata], clients }),
    );
    expect(html).toContain('note.txt');
    expect(html).toContain('text/plain');
    expect(html).toContain('8 字节');
    expect(html).toContain('下载');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  it('uses safe download file names', () => {
    expect(safeAttachmentFileName('../..\\\\evil\n.txt')).toBe('_..__evil_.txt');
    expect(safeAttachmentFileName('...')).toBe('attachment');
    expect(safeAttachmentFileName('普通 文本.txt')).toBe('普通 文本.txt');
  });

  it('revokes replaced and released Blob URLs', () => {
    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const lease = new BlobUrlLease();

    expect(lease.replace(new Blob(['first']))).toBe('blob:first');
    expect(lease.replace(new Blob(['second']))).toBe('blob:second');
    lease.revoke();
    lease.revoke();

    expect(revoke.mock.calls).toEqual([['blob:first'], ['blob:second']]);
  });
});
