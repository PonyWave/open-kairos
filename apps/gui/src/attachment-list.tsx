import { useEffect, useState } from 'react';
import {
  type AttachmentMetadata,
  formatAttachmentSize,
  safeAttachmentFileName,
} from './attachments.js';
import { BlobUrlLease } from './blob-url-lease.js';
import type { KairosClients } from './client.js';
import { formatClientError } from './errors.js';
import { downloadAttachmentBytes } from './queries.js';

type AttachmentClients = Pick<KairosClients, 'attachments'>;

export function AttachmentMetadataList({
  attachments,
}: {
  attachments: readonly AttachmentMetadata[];
}) {
  if (attachments.length === 0) return null;
  return (
    <span className="attachment-metadata-list">
      {attachments.map((attachment) => (
        <span className="attachment-metadata" key={attachment.attachmentId}>
          <span>{attachment.fileName}</span>
          <span>{attachment.mediaType}</span>
          <span>{formatAttachmentSize(attachment.sizeBytes)}</span>
        </span>
      ))}
    </span>
  );
}

export function AttachmentList({
  attachments,
  clients,
}: {
  attachments: readonly AttachmentMetadata[];
  clients?: AttachmentClients | undefined;
}) {
  if (attachments.length === 0) return null;
  if (!clients) return <AttachmentMetadataList attachments={attachments} />;
  return (
    <ul className="attachment-list" aria-label="消息附件">
      {attachments.map((attachment) => (
        <AttachmentItem key={attachment.attachmentId} attachment={attachment} clients={clients} />
      ))}
    </ul>
  );
}

function AttachmentItem({
  attachment,
  clients,
}: {
  attachment: AttachmentMetadata;
  clients: AttachmentClients;
}) {
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  return (
    <li>
      <div className="attachment-item-heading">
        <strong>{attachment.fileName}</strong>
        <span>{attachment.mediaType}</span>
        <span>{formatAttachmentSize(attachment.sizeBytes)}</span>
        {attachment.width !== undefined && attachment.height !== undefined && (
          <span>
            {attachment.width} × {attachment.height}
          </span>
        )}
      </div>
      <div className="button-row compact">
        <button type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? '收起预览' : '预览'}
        </button>
        <button
          type="button"
          disabled={downloading}
          onClick={() => {
            setDownloading(true);
            setDownloadError(null);
            void downloadAttachmentBytes(clients, attachment)
              .then(({ metadata, bytes }) => {
                saveBlob(
                  new Blob([bytes as BlobPart], { type: metadata.mediaType }),
                  safeAttachmentFileName(metadata.fileName),
                );
              })
              .catch((cause: unknown) => setDownloadError(formatClientError(cause)))
              .finally(() => setDownloading(false));
          }}
        >
          {downloading ? '正在分页下载' : '下载'}
        </button>
      </div>
      {downloadError && <p className="error-text">{downloadError}</p>}
      {expanded && <AttachmentPreview attachment={attachment} clients={clients} />}
    </li>
  );
}

function AttachmentPreview({
  attachment,
  clients,
}: {
  attachment: AttachmentMetadata;
  clients: AttachmentClients;
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'text'; text: string }
    | { status: 'image'; url: string }
  >({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    const lease = new BlobUrlLease();
    setState({ status: 'loading' });
    void downloadAttachmentBytes(clients, attachment, controller.signal)
      .then(({ bytes }) => {
        if (controller.signal.aborted) return;
        if (attachment.mediaType === 'text/plain') {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          setState({ status: 'text', text });
          return;
        }
        const url = lease.replace(new Blob([bytes as BlobPart], { type: attachment.mediaType }));
        if (controller.signal.aborted) {
          lease.revoke();
          return;
        }
        setState({ status: 'image', url });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setState({ status: 'error', message: formatClientError(cause) });
        }
      });
    return () => {
      controller.abort();
      lease.revoke();
    };
  }, [attachment, clients]);

  if (state.status === 'loading') return <p role="status">正在通过 Server 分页读取附件</p>;
  if (state.status === 'error') return <p className="error-text">{state.message}</p>;
  if (state.status === 'text') return <pre className="attachment-text-preview">{state.text}</pre>;
  return <img className="attachment-image-preview" src={state.url} alt={attachment.fileName} />;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
