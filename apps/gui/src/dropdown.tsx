import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icon.js';

interface DropdownItem<Value extends string> {
  value: Value;
  label: ReactNode;
  icon?: IconName;
  description?: string;
  section?: string;
  disabled?: boolean;
}

export function Dropdown<Value extends string>({
  label,
  trigger,
  items,
  onSelect,
  value,
  header,
  className = '',
  triggerClassName = '',
  panelClassName = '',
  placement = 'bottom',
  align = 'start',
  disabled = false,
}: {
  label: string;
  trigger: ReactNode;
  items: readonly DropdownItem<Value>[];
  onSelect: (value: Value) => void;
  value?: Value;
  header?: ReactNode;
  className?: string;
  triggerClassName?: string;
  panelClassName?: string;
  placement?: 'top' | 'bottom';
  align?: 'start' | 'end';
  disabled?: boolean;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<'first' | 'last' | 'selected'>('selected');
  const [open, setOpen] = useState(false);
  const unavailable = disabled || (!header && !items.some((item) => !item.disabled));
  const selecting = value !== undefined;
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    if (unavailable) {
      close();
      return;
    }
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!panel || !trigger) return;
    function position() {
      if (!panel || !trigger) return;
      const anchor = trigger.getBoundingClientRect();
      panel.style.minWidth = `${Math.min(anchor.width, window.innerWidth - 24)}px`;
      const result = dropdownPosition(
        anchor,
        { width: panel.offsetWidth, height: Math.max(panel.offsetHeight, panel.scrollHeight) },
        { width: window.innerWidth, height: window.innerHeight },
        placement,
        align,
      );
      panel.style.left = `${result.left}px`;
      panel.style.top = `${result.top}px`;
      panel.style.maxHeight = `${result.maxHeight}px`;
      panel.dataset.side = result.top >= anchor.bottom ? 'bottom' : 'top';
    }
    position();
    const options = enabledItems(panel);
    const selected = options.find((item) => item.getAttribute('aria-selected') === 'true');
    const first = initialFocus.current === 'last' ? options.at(-1) : options[0];
    (initialFocus.current === 'selected' ? (selected ?? first) : first)?.focus({
      preventScroll: true,
    });
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, unavailable, placement, align, close]);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: Event) {
      if (
        event.target instanceof Node &&
        !triggerRef.current?.contains(event.target) &&
        !panelRef.current?.contains(event.target)
      )
        close();
    }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [open, close]);

  function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      // 先恢复触发按钮的焦点，再由浏览器按页面顺序处理 Tab。
      close(true);
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const options = enabledItems(panel);
    const active = document.activeElement;
    const current = active instanceof HTMLButtonElement ? options.indexOf(active) : -1;
    const next = dropdownFocusIndex(event.key, current, options.length);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    options[next]?.focus();
  }

  const panelProps = {
    ref: panelRef,
    id,
    'aria-labelledby': `${id}-trigger`,
    className: `dropdown-panel ${panelClassName}`,
    'data-align': align,
    onKeyDown: onPanelKeyDown,
  };
  const content = open && (
    <>
      {header && <div className="dropdown-header">{header}</div>}
      {items.map((item, index) => {
        const itemProps = {
          type: 'button' as const,
          className: 'dropdown-item',
          tabIndex: -1,
          disabled: item.disabled,
          onClick: () => {
            close(true);
            if (item.value !== value) onSelect(item.value);
          },
        };
        const copy = (
          <>
            {item.icon && <Icon name={item.icon} className="i-sm" />}
            <span className="dropdown-item-copy">
              {item.label}
              {item.description && <small>{item.description}</small>}
            </span>
          </>
        );
        return (
          <div key={item.value} role="presentation">
            {item.section && item.section !== items[index - 1]?.section && (
              <div className="dropdown-section" role="presentation">
                {item.section}
              </div>
            )}
            {selecting ? (
              <button {...itemProps} role="option" aria-selected={item.value === value}>
                {copy}
                <Icon
                  name="check"
                  className={`i-sm dropdown-check${item.value === value ? ' selected' : ''}`}
                />
              </button>
            ) : (
              <button {...itemProps} role="menuitem">
                {copy}
              </button>
            )}
          </div>
        );
      })}
    </>
  );

  return (
    <div className={`dropdown ${className}`}>
      <button
        ref={triggerRef}
        id={`${id}-trigger`}
        type="button"
        className={`dropdown-trigger ${triggerClassName}`}
        aria-label={label}
        aria-haspopup={selecting ? 'listbox' : 'menu'}
        aria-expanded={open && !unavailable}
        aria-controls={open && !unavailable ? id : undefined}
        disabled={unavailable}
        onClick={() => {
          initialFocus.current = 'selected';
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            initialFocus.current = selecting
              ? 'selected'
              : event.key === 'ArrowUp'
                ? 'last'
                : 'first';
            setOpen(true);
          }
        }}
      >
        {trigger}
      </button>
      {open &&
        !unavailable &&
        createPortal(
          selecting ? (
            <div {...panelProps} role="listbox">
              {content}
            </div>
          ) : (
            <div {...panelProps} role="menu">
              {content}
            </div>
          ),
          triggerRef.current?.closest('dialog') ?? document.body,
        )}
    </div>
  );
}

function enabledItems(panel: HTMLElement): HTMLButtonElement[] {
  return Array.from(panel.querySelectorAll<HTMLButtonElement>('.dropdown-item:not(:disabled)'));
}

export function dropdownFocusIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export function dropdownPosition(
  anchor: { top: number; bottom: number; left: number; right: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  placement: 'top' | 'bottom',
  align: 'start' | 'end',
): { top: number; left: number; maxHeight: number } {
  const margin = 12;
  const gap = 6;
  const above = Math.max(0, anchor.top - gap - margin);
  const below = Math.max(0, viewport.height - anchor.bottom - gap - margin);
  const height = Math.min(panel.height, 360);
  const preferred = placement === 'top' ? above : below;
  const opposite = placement === 'top' ? below : above;
  const side =
    preferred >= height || preferred >= opposite
      ? placement
      : placement === 'top'
        ? 'bottom'
        : 'top';
  const maxHeight = Math.min(360, side === 'top' ? above : below);
  return {
    top: Math.max(
      margin,
      side === 'top' ? anchor.top - gap - Math.min(height, maxHeight) : anchor.bottom + gap,
    ),
    left: Math.max(
      margin,
      Math.min(
        align === 'end' ? anchor.right - panel.width : anchor.left,
        viewport.width - panel.width - margin,
      ),
    ),
    maxHeight,
  };
}
