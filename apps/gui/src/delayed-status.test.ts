/// <reference lib="dom" />

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelayedStatus } from './delayed-status.js';

function installReactDomContainer(): HTMLElement {
  const noop = () => {};
  const document = {
    nodeType: 9,
    addEventListener: noop,
    removeEventListener: noop,
    activeElement: null,
  };
  const window = {
    document,
    addEventListener: noop,
    removeEventListener: noop,
    getSelection: () => null,
    HTMLIFrameElement: class {},
    HTMLElement: class {},
  };
  const container = {
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: document,
    addEventListener: noop,
    removeEventListener: noop,
    firstChild: null,
    appendChild: <T>(child: T) => child,
    insertBefore: <T>(child: T) => child,
    removeChild: <T>(child: T) => child,
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('navigator', { userAgent: 'node' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return container as unknown as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const probe = { shown: 0 };
function Probe() {
  probe.shown += 1;
  return null;
}

describe('DelayedStatus', () => {
  it('shows the loading content only after the delay', async () => {
    vi.useFakeTimers();
    const container = installReactDomContainer();
    probe.shown = 0;
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(DelayedStatus, null, createElement(Probe))));
      expect(probe.shown).toBe(0);
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      expect(probe.shown).toBeGreaterThan(0);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('renders nothing when the content resolves before the delay', async () => {
    vi.useFakeTimers();
    const container = installReactDomContainer();
    probe.shown = 0;
    const root = createRoot(container);
    await act(async () => root.render(createElement(DelayedStatus, null, createElement(Probe))));
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    await act(async () => root.unmount());
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(probe.shown).toBe(0);
  });
});
