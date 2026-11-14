import { useEffect, useState } from 'react';
import {
  type AttachmentMetadata,
  formatAttachmentSize,
  safeAttachmentFileName,
} from './attachments.js';
import { BlobUrlLease } from './blob-url-lease.js';
import type { KairosClients } from './client.js';
import { formatClientError } from './errors.js';
import { Icon, type IconName } from './icon.js';
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (attachments.length === 0) return null;
  if (!clients) return <AttachmentMetadataList attachments={attachments} />;
  const expanded = attachments.find((attachment) => attachment.attachmentId === expandedId);
  return (
    <div className="attachment-list">
      <ul className="attachment-row" aria-label="消息附件">
        {attachments.map((attachment) => (
          <AttachmentCard
            key={attachment.attachmentId}
            attachment={attachment}
            clients={clients}
            expanded={expandedId === attachment.attachmentId}
            onTogglePreview={() =>
              setExpandedId((current) =>
                current === attachment.attachmentId ? null : attachment.attachmentId,
              )
            }
          />
        ))}
      </ul>
      {expanded && (
        <div className="attachment-preview-panel">
          <div className="attachment-preview-heading">
            <strong>{expanded.fileName}</strong>
            <button
              type="button"
              className="icon-button"
              aria-label={`关闭 ${expanded.fileName} 预览`}
              onClick={() => setExpandedId(null)}
            >
              <Icon name="close" className="i-sm" />
            </button>
          </div>
          <AttachmentPreview attachment={expanded} clients={clients} />
        </div>
      )}
    </div>
  );
}

function attachmentIcon(attachment: AttachmentMetadata): IconName {
  const type = attachment.mediaType.toLowerCase();
  const name = attachment.fileName.toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type === 'text/csv' || /\.(csv|tsv|xlsx?)$/.test(name)) return 'table';
  if (/\.(zip|tgz|tar|gz|7z|rar)$/.test(name) || type.includes('zip') || type.includes('tar')) {
    return 'archive';
  }
  if (
    /\.(ts|tsx|js|jsx|py|go|rs|java|c|h|cpp|sh|css|html|xml|ya?ml|toml|json|sql)$/.test(name) ||
    type === 'application/json' ||
    type.includes('javascript')
  ) {
    return 'code';
  }
  if (type.startsWith('text/')) return 'files';
  return 'clip';
}

function AttachmentCard({
  attachment,
  clients,
  expanded,
  onTogglePreview,
}: {
  attachment: AttachmentMetadata;
  clients: AttachmentClients;
  expanded: boolean;
  onTogglePreview: () => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  return (
    <li
      className={`attachment-card${expanded ? ' expanded' : ''}`}
      title={`${attachment.fileName} · ${attachment.mediaType}`}
    >
      <span className="attachment-card-icon" aria-hidden="true">
        <Icon name={attachmentIcon(attachment)} />
      </span>
      <span className="attachment-card-text">
        <strong>{attachment.fileName}</strong>
        <small>
          {formatAttachmentSize(attachment.sizeBytes)}
          {attachment.width !== undefined && attachment.height !== undefined
            ? ` · ${attachment.width} × ${attachment.height}`
            : ''}
        </small>
      </span>
      <span className="attachment-card-actions">
        <button
          type="button"
          className="icon-button"
          aria-label={expanded ? `收起 ${attachment.fileName} 预览` : `预览 ${attachment.fileName}`}
          aria-expanded={expanded}
          onClick={onTogglePreview}
        >
          <Icon name="eye" className="i-sm" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={`下载 ${attachment.fileName}`}
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
          <Icon
            name={downloading ? 'spinner' : 'download'}
            className={`i-sm${downloading ? ' spinning' : ''}`}
          />
        </button>
      </span>
      {downloadError && (
        <p className="error-text" role="alert">
          {downloadError}
        </p>
      )}
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
