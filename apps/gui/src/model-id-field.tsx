import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { dropdownFocusIndex, dropdownPosition } from './dropdown.js';
import { Icon } from './icon.js';

export interface ModelIdOption {
  modelId: string;
  displayName: string;
}

export function ModelIdField({
  label,
  value,
  options,
  onChange,
  invalid = false,
  disabled = false,
}: {
  label: string;
  value: string;
  options: readonly ModelIdOption[];
  onChange: (modelId: string, displayName: string) => void;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const manualRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!panel || !trigger) return;
    function position() {
      if (!panel || !trigger) return;
      const anchor = trigger.getBoundingClientRect();
      panel.style.minWidth = `${Math.min(anchor.width, window.innerWidth - 24)}px`;
      const bounds = panel.getBoundingClientRect();
      const result = dropdownPosition(
        anchor,
        { width: bounds.width, height: Math.max(bounds.height, panel.scrollHeight) },
        { width: window.innerWidth, height: window.innerHeight },
        'bottom',
        'start',
      );
      panel.style.left = `${result.left}px`;
      panel.style.top = `${result.top}px`;
      panel.style.maxHeight = `${result.maxHeight}px`;
    }
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open]);

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

  const normalized = query.trim().toLowerCase();
  const filtered =
    normalized.length === 0
      ? options
      : options.filter(
          (option) =>
            option.modelId.toLowerCase().includes(normalized) ||
            option.displayName.toLowerCase().includes(normalized),
        );
  const manual = query.trim();

  function apply(modelId: string, displayName: string) {
    close(true);
    if (modelId !== value || displayName.length > 0) onChange(modelId, displayName);
  }

  function onListKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      close(true);
      return;
    }
    if (event.key === 'ArrowUp' && document.activeElement === manualRef.current) {
      event.preventDefault();
      const items = enabledOptions(panelRef.current);
      items.at(-1)?.focus();
      return;
    }
    const items = enabledOptions(panelRef.current);
    const active = document.activeElement;
    const current = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
    if (event.key === 'ArrowDown' && current === -1) {
      event.preventDefault();
      items[0]?.focus();
      return;
    }
    const next = dropdownFocusIndex(event.key, current, items.length);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    items[next]?.focus();
  }

  return (
    <div className="dropdown model-id-field">
      <button
        ref={triggerRef}
        id={`${id}-trigger`}
        type="button"
        className="dropdown-trigger settings-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-invalid={invalid}
        disabled={disabled}
        onClick={() => {
          setQuery('');
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setQuery('');
            setOpen(true);
          }
        }}
      >
        <span className={value ? 'model-id-value' : 'model-id-placeholder'}>
          {value || '从列表选择模型'}
        </span>
        <Icon name="down" className="i-sm dropdown-chevron" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="listbox"
            aria-labelledby={`${id}-trigger`}
            className="dropdown-panel model-id-panel"
            onKeyDown={onListKeyDown}
          >
            <div className="model-id-options">
              {filtered.map((option) => (
                <button
                  key={option.modelId}
                  type="button"
                  className="dropdown-item"
                  role="option"
                  aria-selected={option.modelId === value}
                  tabIndex={-1}
                  onClick={() => apply(option.modelId, option.displayName)}
                >
                  <span className="dropdown-item-copy">
                    {option.modelId}
                    {option.displayName && option.displayName !== option.modelId && (
                      <small>{option.displayName}</small>
                    )}
                  </span>
                  <Icon
                    name="check"
                    className={`i-sm dropdown-check${option.modelId === value ? ' selected' : ''}`}
                  />
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="model-id-empty">
                  {options.length === 0 ? '服务未返回模型列表。' : '没有匹配的模型。'}
                </p>
              )}
            </div>
            <div className="model-id-manual">
              <input
                ref={manualRef}
                value={query}
                maxLength={200}
                placeholder="筛选或手动输入模型 ID"
                aria-label="筛选或手动输入模型 ID"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (manual) apply(manual, '');
                  }
                }}
              />
              <button
                type="button"
                className="device-secondary"
                disabled={manual.length === 0}
                onClick={() => apply(manual, '')}
              >
                使用
              </button>
            </div>
          </div>,
          triggerRef.current?.closest('dialog') ?? document.body,
        )}
    </div>
  );
}

function enabledOptions(panel: HTMLElement | null): HTMLButtonElement[] {
  if (!panel) return [];
  return Array.from(panel.querySelectorAll<HTMLButtonElement>('.dropdown-item:not(:disabled)'));
}
