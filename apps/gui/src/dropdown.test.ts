import { createElement, type ElementType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dropdown, dropdownFocusIndex, dropdownPosition } from './dropdown.js';
import { ThreadListPage } from './thread-list-page.js';

const captured = vi.hoisted(() => ({
  open: false,
  setOpen: vi.fn(),
  elements: [] as { type: string; props: Record<string, unknown> }[],
  effects: [] as (() => (() => void) | undefined)[],
  layoutEffects: [] as (() => (() => void) | undefined)[],
}));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: () => [captured.open, captured.setOpen],
  useEffect: (effect: () => (() => void) | undefined) => captured.effects.push(effect),
  useLayoutEffect: (effect: () => (() => void) | undefined) => captured.layoutEffects.push(effect),
}));

vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));

vi.mock('react/jsx-runtime', async () => {
  const runtime = await vi.importActual<typeof import('react/jsx-runtime')>('react/jsx-runtime');
  function jsx(type: ElementType, props: Record<string, unknown>, key?: string) {
    if (typeof type === 'string') captured.elements.push({ type, props });
    return runtime.jsx(type, props, key);
  }
  function jsxs(type: ElementType, props: Record<string, unknown>, key?: string) {
    if (typeof type === 'string') captured.elements.push({ type, props });
    return runtime.jsxs(type, props, key);
  }
  return { ...runtime, jsx, jsxs };
});

vi.mock('react/jsx-dev-runtime', async () => {
  const runtime =
    await vi.importActual<typeof import('react/jsx-dev-runtime')>('react/jsx-dev-runtime');
  function jsxDEV(
    type: ElementType,
    props: Record<string, unknown>,
    key: string | undefined,
    isStaticChildren: boolean,
    source?: { fileName?: string; lineNumber?: number; columnNumber?: number },
    self?: unknown,
  ) {
    if (typeof type === 'string') captured.elements.push({ type, props });
    return runtime.jsxDEV(type, props, key, isStaticChildren, source, self);
  }
  return { ...runtime, jsxDEV };
});

beforeEach(() => {
  captured.open = false;
  captured.setOpen.mockClear();
  captured.elements = [];
  captured.effects = [];
  captured.layoutEffects = [];
  vi.stubGlobal('document', { body: {} });
});

afterEach(() => vi.unstubAllGlobals());

function element(property: string, value: unknown) {
  const found = captured.elements.find((element) => element.props[property] === value);
  if (!found) throw new Error(`未找到控件：${property}=${value}`);
  return found.props;
}

function invoke(props: Record<string, unknown>, handler: string, ...args: unknown[]) {
  const callback = props[handler];
  if (typeof callback !== 'function') throw new Error(`未找到事件：${handler}`);
  callback(...args);
}

function setRef(props: Record<string, unknown>, target: unknown) {
  const ref = props.ref;
  if (typeof ref !== 'object' || ref === null || !('current' in ref))
    throw new Error('未找到控件引用。');
  ref.current = target;
}

function renderSelect(onSelect = vi.fn(), disabled = false) {
  captured.elements = [];
  captured.effects = [];
  captured.layoutEffects = [];
  const html = renderToStaticMarkup(
    createElement(Dropdown, {
      label: '排序字段',
      trigger: '更新时间',
      value: 'lastMessageAt',
      items: [
        { value: 'lastMessageAt', label: '更新时间' },
        { value: 'createdAt', label: '创建时间' },
      ],
      disabled,
      onSelect,
    }),
  );
  return { html, onSelect };
}

describe('Dropdown controls', () => {
  it('replaces the directory native select with the shared listbox trigger', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadListPage, {
        cards: [],
        sort: 'createdAt',
        mainThreadId: null,
        loading: false,
        error: null,
        hasMore: false,
        onOpen: () => {},
        onSort: () => {},
        onLoadMore: async () => {},
        onReload: async () => {},
        onManageWorkspaces: () => {},
      }),
    );
    expect(html).not.toContain('<select');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('创建时间');
    expect(html).toContain('aria-expanded="false"');
  });

  it('opens from the trigger and publishes the selected value once', () => {
    renderSelect();
    invoke(element('aria-label', '排序字段'), 'onClick');
    expect(captured.setOpen).toHaveBeenLastCalledWith(true);

    captured.open = true;
    const { html, onSelect } = renderSelect();
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-selected="true"');
    const focus = vi.fn();
    setRef(element('aria-label', '排序字段'), { focus });
    invoke(element('aria-selected', false), 'onClick');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('createdAt');
    expect(captured.setOpen).toHaveBeenLastCalledWith(false);
    expect(focus).toHaveBeenCalledOnce();
  });

  it('closes without reloading when selecting the current value', () => {
    captured.open = true;
    const { onSelect } = renderSelect();
    invoke(element('aria-selected', true), 'onClick');
    expect(onSelect).not.toHaveBeenCalled();
    expect(captured.setOpen).toHaveBeenCalledWith(false);
  });

  it('restores trigger focus on Escape and preserves native Tab navigation', () => {
    captured.open = true;
    renderSelect();
    const focus = vi.fn();
    setRef(element('aria-label', '排序字段'), { focus });
    for (const key of ['Escape', 'Tab']) {
      const event = { key, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      invoke(element('role', 'listbox'), 'onKeyDown', event);
      expect(captured.setOpen).toHaveBeenLastCalledWith(false);
      if (key === 'Escape') {
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
      } else {
        expect(event.preventDefault).not.toHaveBeenCalled();
      }
    }
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it('dismisses on outside pointer or focus and removes listeners on cleanup', () => {
    class Target {}
    const inside = new Target();
    const outside = new Target();
    const listeners = new Map<string, (event: { target: Target }) => void>();
    vi.stubGlobal('Node', Target);
    vi.stubGlobal('document', {
      body: {},
      addEventListener: (type: string, callback: (event: { target: Target }) => void) =>
        listeners.set(type, callback),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    captured.open = true;
    renderSelect();
    setRef(element('aria-label', '排序字段'), { contains: () => false });
    setRef(element('role', 'listbox'), { contains: (target: Target) => target === inside });
    const cleanup = captured.effects[0]?.();
    for (const type of ['pointerdown', 'focusin']) {
      captured.setOpen.mockClear();
      listeners.get(type)?.({ target: inside });
      expect(captured.setOpen).not.toHaveBeenCalled();
      listeners.get(type)?.({ target: outside });
      expect(captured.setOpen).toHaveBeenCalledExactlyOnceWith(false);
    }
    cleanup?.();
    expect(listeners.size).toBe(0);
  });

  it('keeps disabled controls closed', () => {
    captured.open = true;
    const { html } = renderSelect(vi.fn(), true);
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="listbox"');
  });

  it('keeps a searchable menu open when its search has no matching options', () => {
    captured.open = true;
    const html = renderToStaticMarkup(
      createElement(Dropdown, {
        label: '时区',
        trigger: 'Asia/Shanghai',
        value: 'Asia/Shanghai',
        items: [],
        header: createElement('input', { type: 'search', 'aria-label': '搜索时区' }),
        onSelect: () => {},
      }),
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="搜索时区"');
    expect(html).toContain('role="listbox"');
  });

  it('sizes the sort list from its trigger without a fixed minimum width', () => {
    const anchor = { top: 100, bottom: 130, left: 200, right: 318, width: 118 };
    const style: Record<string, string> = {};
    vi.stubGlobal('window', {
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    captured.open = true;
    renderSelect();
    setRef(element('aria-label', '排序字段'), { getBoundingClientRect: () => anchor });
    setRef(element('role', 'listbox'), {
      style,
      scrollHeight: 84,
      getBoundingClientRect: () => ({ width: 118, height: 84 }),
      querySelectorAll: () => [],
    });
    const cleanup = captured.layoutEffects[0]?.();
    expect(style.minWidth).toBe('118px');
    expect(style.left).toBe('200px');
    expect(style.top).toBe('136px');
    cleanup?.();
  });
});

describe('Dropdown navigation and placement', () => {
  it('wraps arrow navigation and supports first and last items', () => {
    expect(dropdownFocusIndex('ArrowDown', 2, 3)).toBe(0);
    expect(dropdownFocusIndex('ArrowUp', 0, 3)).toBe(2);
    expect(dropdownFocusIndex('ArrowDown', -1, 3)).toBe(0);
    expect(dropdownFocusIndex('ArrowUp', -1, 3)).toBe(2);
    expect(dropdownFocusIndex('Home', 1, 3)).toBe(0);
    expect(dropdownFocusIndex('End', 1, 3)).toBe(2);
    expect(dropdownFocusIndex('Enter', 1, 3)).toBeNull();
    expect(dropdownFocusIndex('ArrowDown', 0, 0)).toBeNull();
  });

  it('flips a bottom menu above its trigger near the viewport edge', () => {
    const position = dropdownPosition(
      { top: 720, bottom: 750, left: 900, right: 1000 },
      { width: 200, height: 180 },
      { width: 1024, height: 768 },
      'bottom',
      'end',
    );
    expect(position).toEqual({ top: 534, left: 800, maxHeight: 360 });
  });

  it('keeps narrow and tall panels inside the viewport with internal scrolling', () => {
    const position = dropdownPosition(
      { top: 20, bottom: 50, left: 290, right: 320 },
      { width: 252, height: 800 },
      { width: 320, height: 240 },
      'top',
      'start',
    );
    expect(position).toEqual({ top: 56, left: 56, maxHeight: 172 });
  });
});
