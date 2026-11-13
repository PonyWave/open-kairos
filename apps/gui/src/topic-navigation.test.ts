/// <reference lib="dom" />

import { createRouterTransport } from '@connectrpc/connect';
import { create, type Identity, IdentitySchema } from '@kairos/contracts';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountWorkbench } from './App.js';
import { ActionExecutor } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import { type ActionKind, ClientActionStore, type StorageLike } from './actions.js';
import { createKairosClients } from './client.js';
import type { ActionExecutorView } from './use-action-executor.js';

interface StubOrigin {
  delegation: {
    sourceThreadId: string;
    sourceAgentId: string;
    sourceToolCallId: string;
  };
  prompt: string | null;
  sourceMessageId: string | null;
}

interface StubPaneProps {
  variant: string;
  threadId: string | null;
  hidden?: boolean;
  highlightedCallId?: string | null;
  onOpenTopic: (request: {
    threadId: string;
    invocationId: string | null;
    origin: StubOrigin | null;
  }) => void;
  onShowOrigin: (threadId: string, origin: StubOrigin) => void;
}

function delegationOrigin(sourceThreadId: string, sourceToolCallId: string): StubOrigin {
  return {
    delegation: { sourceThreadId, sourceAgentId: 'agent-1', sourceToolCallId },
    prompt: '原始请求',
    sourceMessageId: 'message-1',
  };
}

const stubPanes = vi.hoisted(() => ({ mounted: new Map<string, unknown>() }));

vi.mock('./conversation-pane.js', async () => {
  const { useEffect } = await import('react');
  return {
    ConversationPane: (props: StubPaneProps) => {
      useEffect(() => {
        const key = `${props.variant}:${props.threadId ?? 'none'}`;
        stubPanes.mounted.set(key, props);
        return () => {
          stubPanes.mounted.delete(key);
        };
      });
      return null;
    },
  };
});

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const identity: Identity = create(IdentitySchema, {
  userId: 'user-a',
  tenantId: 'tenant-a',
  email: 'a@kairos.local',
  username: '用户 A',
  mainThreadId: 'main-a',
});

function pane(key: string): StubPaneProps | undefined {
  return stubPanes.mounted.get(key) as StubPaneProps | undefined;
}

function actionView(clients: ReturnType<typeof createKairosClients>): ActionExecutorView {
  const executor = new ActionExecutor(new ClientActionStore(), createActionHandlers(clients));
  return {
    execute: <T>(key: string, kind: ActionKind, payload: unknown) =>
      executor.execute<T>(key, kind, payload),
    retry: <T>(key: string) => executor.retry<T>(key),
    dismiss: (key) => executor.dismiss(key),
    busy: false,
    failures: [],
  };
}

function installAppDom(initialSearch: string): HTMLElement {
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
    focus: noop,
    style: {},
    dataset: {},
    firstChild: null,
    appendChild: <T>(child: T) => child,
    insertBefore: <T>(child: T) => child,
    removeChild: <T>(child: T) => child,
  });
  const document: Record<string, unknown> = {
    nodeType: 9,
    addEventListener: noop,
    removeEventListener: noop,
    activeElement: null,
    createElement: (nodeName: string) => element(nodeName),
    createElementNS: (namespaceURI: string, nodeName: string) => element(nodeName, namespaceURI),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: document,
    }),
    createComment: (nodeValue: string) => ({
      nodeType: 8,
      nodeValue,
      ownerDocument: document,
    }),
  };
  document.documentElement = element('HTML');
  let search = initialSearch;
  let historyState: unknown = null;
  const applyUrl = (url?: string | URL | null) => {
    if (typeof url !== 'string') return;
    const queryIndex = url.indexOf('?');
    search = queryIndex >= 0 ? url.slice(queryIndex) : '';
  };
  const history = {
    get state() {
      return historyState;
    },
    replaceState(state: unknown, _title: string, url?: string | URL | null) {
      historyState = state;
      applyUrl(url);
    },
    pushState(state: unknown, _title: string, url?: string | URL | null) {
      historyState = state;
      applyUrl(url);
    },
    go: noop,
  };
  const location = {
    pathname: '/',
    get search() {
      return search;
    },
    get href() {
      return `http://kairos.local/${search}`;
    },
  };
  const windowTarget = Object.assign(new EventTarget(), {
    document,
    history,
    location,
    getSelection: () => null,
    HTMLIFrameElement: class {},
    HTMLElement: class {},
    matchMedia: () => ({
      matches: false,
      media: '',
      addEventListener: noop,
      removeEventListener: noop,
    }),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      globalThis.setTimeout(() => callback(0), 0),
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('navigator', { userAgent: 'node' });
  vi.stubGlobal('requestAnimationFrame', windowTarget.requestAnimationFrame.bind(windowTarget));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return element('DIV') as unknown as HTMLElement;
}

async function renderWorkbench(initialSearch: string) {
  const container = installAppDom(initialSearch);
  const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(AccountWorkbench, {
        identity,
        clients,
        storage: new MemoryStorage(),
        actions: actionView(clients),
        registerCompletion: () => {},
        onLogout: async () => {},
        serverHealth: 'ready',
      }),
    );
  });
  return root;
}

afterEach(() => {
  stubPanes.mounted.clear();
  vi.unstubAllGlobals();
});

describe('topic side pane navigation', () => {
  it('keeps the open workspace main conversation when a topic opens from it', async () => {
    const root = await renderWorkbench('?view=thread&thread=ws-main-1');
    try {
      expect(pane('fullscreen:ws-main-1')).toBeDefined();
      expect(pane('main:main-a')?.hidden).toBe(true);
      expect([...stubPanes.mounted.keys()].filter((key) => key.startsWith('topic:'))).toEqual([]);

      const fullscreen = pane('fullscreen:ws-main-1');
      await act(async () => {
        fullscreen?.onOpenTopic({ threadId: 'topic-1', invocationId: 'call-1', origin: null });
      });

      expect(pane('fullscreen:ws-main-1')).toBeDefined();
      expect(pane('topic:topic-1')).toBeDefined();
      expect(pane('main:main-a')?.hidden).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('locates a topic back to the workspace main conversation that started it', async () => {
    const root = await renderWorkbench('');
    try {
      const origin = delegationOrigin('ws-main-1', 'call-9');
      const main = pane('main:main-a');
      expect(main?.hidden).toBe(false);
      await act(async () => {
        main?.onOpenTopic({ threadId: 'topic-1', invocationId: 'call-9', origin });
      });
      expect(pane('topic:topic-1')).toBeDefined();

      const topic = pane('topic:topic-1');
      await act(async () => {
        topic?.onShowOrigin('topic-1', origin);
      });

      expect(pane('fullscreen:ws-main-1')).toBeDefined();
      expect(pane('fullscreen:ws-main-1')?.highlightedCallId).toBe('call-9');
      expect(pane('main:main-a')?.hidden).toBe(true);
      expect(pane('topic:topic-1')).toBeDefined();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('locates a topic back to the global main conversation that started it', async () => {
    const root = await renderWorkbench('?view=thread&thread=ws-main-1');
    try {
      const origin = delegationOrigin('main-a', 'call-7');
      const fullscreen = pane('fullscreen:ws-main-1');
      await act(async () => {
        fullscreen?.onOpenTopic({ threadId: 'topic-1', invocationId: 'call-7', origin });
      });
      expect(pane('topic:topic-1')).toBeDefined();

      const topic = pane('topic:topic-1');
      await act(async () => {
        topic?.onShowOrigin('topic-1', origin);
      });

      expect(pane('fullscreen:ws-main-1')).toBeUndefined();
      expect(pane('main:main-a')?.hidden).toBe(false);
      expect(pane('main:main-a')?.highlightedCallId).toBe('call-7');
      expect(pane('topic:topic-1')).toBeDefined();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('returns to the main conversation when a topic opens from the draft page', async () => {
    const root = await renderWorkbench('?view=draft');
    try {
      const draft = pane('draft:none');
      expect(draft).toBeDefined();

      await act(async () => {
        draft?.onOpenTopic({ threadId: 'topic-1', invocationId: null, origin: null });
      });

      expect(pane('draft:none')).toBeUndefined();
      expect(pane('main:main-a')?.hidden).toBe(false);
      expect(pane('topic:topic-1')).toBeDefined();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
