import { Icon } from './icon.js';

export function FailureNotice({
  message,
  label = '执行失败',
  busy = false,
  onRetry,
  onDismiss,
}: {
  message: string;
  label?: string;
  busy?: boolean;
  onRetry?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  return (
    <div className="failure-notice" role="status">
      <button
        type="button"
        className="icon-button failure-details"
        aria-label={`${label}：${message}`}
      >
        <Icon name="alert" className="i-sm" />
        <span className="failure-tooltip" role="tooltip">
          {message}
        </span>
      </button>
      {onRetry && (
        <button
          type="button"
          className="text-button failure-retry"
          disabled={busy}
          onClick={onRetry}
        >
          <Icon name="retry" className="i-sm" />
          重试
        </button>
      )}
      {onDismiss && (
        <button type="button" className="icon-button" aria-label="关闭提示" onClick={onDismiss}>
          <Icon name="close" className="i-sm" />
        </button>
      )}
    </div>
  );
}
