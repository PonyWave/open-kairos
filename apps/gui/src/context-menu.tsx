import { useEffect, useRef } from 'react';
import { Icon, type IconName } from './icon.js';

export interface ContextMenuItem {
  key: string;
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: readonly ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  const menuWidth = 200;
  const menuHeight = items.length * 34 + 12;
  const left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8));
  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left, top }}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className={`context-menu-item${item.danger ? ' danger' : ''}`}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.icon && <Icon name={item.icon} className="i-sm" />}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
