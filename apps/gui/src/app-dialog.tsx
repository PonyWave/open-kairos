import { type ReactNode, useEffect, useId, useRef } from 'react';
import { Icon } from './icon.js';

export function AppDialog({
  title,
  subtitle,
  children,
  actions,
  onClose,
  wide = false,
  closeDisabled = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  actions: ReactNode;
  onClose: () => void;
  wide?: boolean;
  closeDisabled?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`device-dialog${wide ? ' device-path-dialog' : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeDisabled) onClose();
      }}
    >
      <div className="device-dialog-head">
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <span className="muted">{subtitle}</span>}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭弹窗"
          disabled={closeDisabled}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="device-dialog-body">{children}</div>
      <div className="device-dialog-actions">{actions}</div>
    </dialog>
  );
}
