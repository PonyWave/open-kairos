import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from 'react';
import { Icon } from './icon.js';

const focusableSelector =
  'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

export function dialogTrapIndex(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey'>,
  activeIndex: number,
  count: number,
): number | null {
  if (event.key !== 'Tab' || count === 0) return null;
  if (event.shiftKey && activeIndex === 0) return count - 1;
  if (!event.shiftKey && activeIndex === count - 1) return 0;
  return null;
}

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
  subtitle?: string | undefined;
  children: ReactNode;
  actions: ReactNode;
  onClose: () => void;
  wide?: boolean;
  closeDisabled?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const closedByEscape = useRef(false);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    dialog
      ?.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      ?.focus({ preventScroll: true });
    return () => {
      if (dialog?.open) dialog.close();
      if (!closedByEscape.current && previous instanceof HTMLElement && previous.isConnected)
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
        if (!closeDisabled) {
          closedByEscape.current = true;
          onClose();
        }
      }}
      onKeyDown={(event) => {
        const elements = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(focusableSelector),
        ).filter((element) => element.getClientRects().length > 0);
        const target = dialogTrapIndex(
          event,
          elements.indexOf(document.activeElement as HTMLElement),
          elements.length,
        );
        if (target === null) return;
        event.preventDefault();
        elements[target]?.focus();
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
