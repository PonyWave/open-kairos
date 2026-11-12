/// <reference lib="dom" />

import { act, createElement, StrictMode, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationHistoryLoadingMinMs } from './conversation-history-loader.js';
import { conversationWheelGestureIdleMs } from './conversation-scroll.js';
import { useConversationScroll } from './use-conversation-scroll.js';

function installReactDomContainer(): HTMLElement {
  const noop = () => {};
  const element = (nodeName: string, namespaceURI = 'http://www.w3.org/1999/xhtml') => ({
    nodeType: 1,
    nodeName,
    tagName: nodeName,
    namespaceURI,
    ownerDocument: document,
    addEventListener: noop,
    removeEventListener: noop,
    setAttribute: noop,
    setAttributeNS: noop,
    removeAttribute: noop,
    removeAttributeNS: noop,
    style: {},
    firstChild: null,
    appendChild: <T>(child: T) => child,
    insertBefore: <T>(child: T) => child,
    removeChild: <T>(child: T) => child,
  });
  const document = {
    nodeType: 9,
    addEventListener: noop,
    removeEventListener: noop,
    activeElement: null,
    createElement: (nodeName: string) => element(nodeName),
    createElementNS: (namespaceURI: string, nodeName: string) => element(nodeName, namespaceURI),
    createTextNode: (nodeValue: string) => ({ nodeType: 3, nodeValue, ownerDocument: document }),
    createComment: (nodeValue: string) => ({ nodeType: 8, nodeValue, ownerDocument: document }),
  };
  const window = Object.assign(new EventTarget(), {
    document,
    getSelection: () => null,
    HTMLIFrameElement: class {},
    HTMLElement: class {},
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('navigator', { userAgent: 'node' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return element('DIV') as unknown as HTMLElement;
}

class ScrollElement extends EventTarget {
  scrollTop = 0;
  scrollHeight = 1200;
  clientHeight = 400;
  dataset: Record<string, string> = {};
  parentElement: ScrollElement | null = null;
  offset = 0;
  anchor: ScrollElement | null = null;
  getBoundingClientRect() {
    const top = this.offset - (this.parentElement?.scrollTop ?? 0);
    return { top, bottom: top + this.clientHeight };
  }
  querySelectorAll() {
    return this.anchor ? [this.anchor] : [];
  }
}

interface ScrollModel {
  viewport: ScrollElement;
  message: ScrollElement;
  index: number;
  ready: boolean;
  visible?: boolean;
  displayMode?: string;
  latest?: ReturnType<typeof useConversationScroll>;
}

function ScrollProbe({ model }: { model: ScrollModel }) {
  const [hiddenIndex, setIndex] = useState(30);
  const index = model.ready ? hiddenIndex : 0;
  const onLoadEarlier = useCallback(() => {
    if (index === 0) return false;
    setIndex((current) => Math.max(0, current - 10));
    return true;
  }, [index]);
  const scroll = useConversationScroll(model.ready && model.visible !== false, onLoadEarlier, {
    key: 'thread',
    startIndex: index,
    ...(model.displayMode === undefined ? {} : { displayMode: model.displayMode }),
  });
  scroll.viewportRef.current = model.viewport as unknown as HTMLDivElement;
  scroll.contentRef.current = model.viewport as unknown as HTMLDivElement;
  if (index !== model.index) {
    const shift = model.ready ? ((30 - index) / 10) * 600 : 0;
    model.viewport.scrollHeight = 1200 + shift;
    model.message.offset = 80 + shift;
    model.index = index;
  }
  model.latest = scroll;
  return null;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function fixture(options: { strict?: boolean; ready?: boolean } = {}) {
  vi.useFakeTimers();
  const root = createRoot(installReactDomContainer());
  const viewport = new ScrollElement();
  const message = new ScrollElement();
  message.offset = 80;
  message.clientHeight = 100;
  message.parentElement = viewport;
  viewport.anchor = message;
  vi.stubGlobal('Element', ScrollElement);
  vi.stubGlobal('HTMLElement', ScrollElement);
  vi.stubGlobal('getComputedStyle', () => ({
    overflowY: 'visible',
    overscrollBehaviorY: 'auto',
    lineHeight: '20px',
  }));
  const model: ScrollModel = { viewport, message, index: 30, ready: options.ready ?? true };
  let mount = 0;
  async function render() {
    const probe = createElement(ScrollProbe, { model, key: mount });
    await act(async () =>
      root.render(options.strict ? createElement(StrictMode, null, probe) : probe),
    );
  }
  await render();
  function read() {
    if (!model.latest) throw new Error('滚动 Hook 尚未挂载。');
    return model.latest;
  }
  async function wheel(deltaY = -50, deltaMode = 0) {
    await act(async () => {
      viewport.dispatchEvent(
        Object.assign(new Event('wheel'), { deltaY, deltaMode, ctrlKey: false, shiftKey: false }),
      );
    });
  }
  async function advance(ms: number) {
    await act(async () => vi.advanceTimersByTime(ms));
  }
  return {
    viewport,
    message,
    read,
    wheel,
    advance,
    changeDisplay: async (mode: string, visible: boolean) => {
      model.displayMode = mode;
      model.visible = visible;
      await render();
    },
    index: () => model.index,
    ready: async () => {
      model.ready = true;
      await render();
    },
    refresh: async () => {
      mount += 1;
      model.ready = false;
      await render();
      model.ready = true;
      await render();
    },
    close: () => act(async () => root.unmount()),
  };
}

describe('conversation scroll event integration', () => {
  it('restores the reading anchor after changing display mode while the conversation is hidden', async () => {
    const view = await fixture();
    try {
      await view.changeDisplay('full', true);
      view.message.offset = 680;
      view.viewport.scrollTop = 600;
      view.read().pauseFollowing();
      view.viewport.dispatchEvent(new Event('scroll'));
      await view.changeDisplay('full', false);
      view.message.offset = 380;
      view.viewport.scrollHeight = 900;
      await view.changeDisplay('compact', false);
      await view.changeDisplay('compact', true);
      expect(view.viewport.scrollTop).toBe(300);
      expect(view.message.getBoundingClientRect().top).toBe(80);
      expect(view.index()).toBe(30);
      expect(view.viewport.dataset.followBottom).toBe('false');
    } finally {
      await view.close();
    }
  });

  it.each([
    ['pixels', 0, 1],
    ['lines', 1, 20],
    ['pages', 2, 400],
  ] as const)('loads on a renewed upward push during momentum in %s', async (_name, mode, unit) => {
    const view = await fixture();
    try {
      const wheel = async (magnitude: number) => {
        await view.advance(16);
        await view.wheel(-magnitude / unit, mode);
      };
      await wheel(80);
      view.viewport.scrollTop = 0;
      view.viewport.dispatchEvent(new Event('scroll'));
      for (const magnitude of [60, 40, 20, 10, 4, 2, 1, 2, 1]) await wheel(magnitude);
      expect(view.read().loadingEarlier).toBe(false);

      await wheel(4);
      await wheel(5);
      expect(view.read().loadingEarlier).toBe(true);
      for (const magnitude of [4, 2, 1, 20, 10, 4, 2, 1]) await wheel(magnitude);
      expect(view.read().loadingEarlier).toBe(true);
      for (let frame = 0; frame < 15; frame++) await wheel(frame % 3 === 1 ? 2 : 1);
      expect(view.index()).toBe(20);
      expect(view.viewport.scrollTop).toBe(600);

      view.viewport.scrollTop = 0;
      for (const magnitude of [1, 2, 1]) await wheel(magnitude);
      expect(view.read().loadingEarlier).toBe(false);
      await wheel(24);
      expect(view.read().loadingEarlier).toBe(true);
      await view.advance(conversationHistoryLoadingMinMs);
      expect(view.index()).toBe(10);
      expect(view.viewport.scrollTop).toBe(600);
    } finally {
      await view.close();
    }
  });

  it('loads repeatedly after a cold mount and fresh data under StrictMode', async () => {
    const view = await fixture({ strict: true, ready: false });
    try {
      view.viewport.scrollTop = 0;
      await view.wheel();
      expect(view.read().loadingEarlier).toBe(false);
      await view.ready();
      view.viewport.scrollTop = 0;
      await view.wheel();
      expect(view.read().loadingEarlier).toBe(true);
      await view.advance(conversationHistoryLoadingMinMs);
      expect(view.index()).toBe(20);

      await view.refresh();
      view.viewport.scrollTop = 0;
      await view.wheel();
      expect(view.read().loadingEarlier).toBe(true);
      await view.advance(conversationHistoryLoadingMinMs);
      expect(view.index()).toBe(20);
      view.viewport.scrollTop = 0;
      await view.wheel();
      expect(view.read().loadingEarlier).toBe(true);
      await view.advance(conversationHistoryLoadingMinMs);
      expect(view.index()).toBe(10);
    } finally {
      await view.close();
    }
  });
  it('loads from a fresh wheel gesture, keeps loading visible and restores the reading position', async () => {
    const view = await fixture();
    try {
      await view.wheel();
      view.viewport.scrollTop = 0;
      view.viewport.dispatchEvent(new Event('scroll'));
      await view.wheel();
      expect(view.read().loadingEarlier).toBe(false);

      await view.advance(conversationWheelGestureIdleMs);
      await view.wheel();
      expect(view.read().loadingEarlier).toBe(true);
      await view.advance(conversationHistoryLoadingMinMs - 1);
      expect(view.index()).toBe(30);
      await view.advance(1);
      expect(view.index()).toBe(20);
      expect(view.read().loadingEarlier).toBe(false);
      expect(view.viewport.scrollTop).toBe(600);

      view.viewport.scrollTop = 0;
      await view.wheel();
      expect(view.read().loadingEarlier).toBe(true);
      await view.advance(conversationHistoryLoadingMinMs);
      expect(view.index()).toBe(10);
      expect(view.viewport.scrollTop).toBe(600);
    } finally {
      await view.close();
    }
  });

  it('loads at a fractional top boundary after the previous gesture ends', async () => {
    const view = await fixture();
    try {
      await view.wheel();
      view.viewport.scrollTop = 0.4;
      view.viewport.dispatchEvent(new Event('scroll'));
      await view.advance(conversationWheelGestureIdleMs);
      await view.wheel();
      expect(view.read().loadingEarlier).toBe(true);
      await view.advance(conversationHistoryLoadingMinMs);
      expect(view.index()).toBe(20);
      expect(view.viewport.scrollTop).toBeCloseTo(600.4);
    } finally {
      await view.close();
    }
  });
});
