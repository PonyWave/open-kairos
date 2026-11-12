/// <reference lib="dom" />

import { createRouterTransport } from '@connectrpc/connect';
import {
  create,
  InputMode,
  ThreadSchema,
  ThreadSnapshotSchema,
  ThreadType,
} from '@kairos/contracts';
import { act, createElement, Fragment, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKairosClients } from './client.js';
import { ConversationPane } from './conversation-pane.js';
import { ThreadSyncManager } from './thread-sync-manager.js';
import type { ActionExecutorView } from './use-action-executor.js';
import type { useDrafts } from './use-drafts.js';
import * as sync from './use-thread-sync.js';

const controls = vi.hoisted(() => ({
  send: undefined as unknown,
  dialog: undefined as unknown,
}));

vi.mock('./composer.js', () => ({
  Composer: (props: { onSend: (mode: InputMode) => Promise<void> }) => {
    controls.send = props.onSend;
    return null;
  },
}));

vi.mock('./app-dialog.js', () => ({
  AppDialog: (props: unknown) => {
    controls.dialog = props;
    return null;
  },
}));

vi.mock('./attachment-upload.js', () => ({
  AttachmentUploader: class {
    activate() {}
    stop() {}
  },
}));

vi.mock('./use-conversation-scroll.js', () => ({
  useConversationScroll: () => ({
    viewportRef: { current: null },
    contentRef: { current: null },
    followAfterSend: () => {},
    pauseFollowing: () => {},
    loadEarlier: () => false,
    loadingEarlier: false,
  }),
}));

interface DialogProps {
  title: string;
  children: ReactNode;
  actions: ReactElement<{ children: ReactNode }>;
  onClose: () => void;
}

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
    dataset: {},
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

function view() {
  const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
  const snapshot = create(ThreadSnapshotSchema, {
    thread: create(ThreadSchema, {
      threadId: 'main-new',
      title: '主对话',
      threadType: ThreadType.MAIN,
      newConversation: true,
      seq: 2n,
    }),
  });
  vi.spyOn(sync, 'useThreadSync').mockReturnValue({
    state: {
      snapshot,
      throughSeq: 0n,
      status: 'live',
      error: null,
      transientResponses: [],
      bashOperations: [],
      hardCuts: [],
      invalidatedRecaps: {},
    },
    reload: async () => {},
  });
  const actions: ActionExecutorView = {
    execute: vi.fn(async () => undefined),
    retry: async () => undefined,
    dismiss: () => {},
    busy: false,
    failures: [],
  };
  const drafts: ReturnType<typeof useDrafts> = {
    getDraft: () => ({ id: 'draft-new', text: '/new', attachments: [] }),
    updateDraft: () => {},
    completeDraft: () => {},
    removeAttachment: () => {},
    restoreQueueDraft: () => {},
  };
  return {
    props: {
      clients,
      threadSyncManager: new ThreadSyncManager(clients),
      variant: 'main' as const,
      composerOwner: 'main',
      threadId: 'main-new',
      thread: snapshot.thread ?? null,
      mainThreadId: 'main-new',
      draftOwner: 'main-new',
      actions,
      drafts,
      topicCards: [],
      previewRevision: 0,
      toolExpansionChoices: {},
      onToolExpansionChange: () => {},
      onOpenTopic: () => {},
      onOpenDirectory: () => {},
      onOpenMain: () => {},
      onCloseTopic: () => {},
      onShowOrigin: () => {},
      showNotice: () => {},
    },
    actions,
  };
}

afterEach(() => {
  controls.send = undefined;
  controls.dialog = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('new main conversation', () => {
  it('shows the persistent marker at the top of the new main snapshot', () => {
    const { props } = view();
    const html = renderToStaticMarkup(createElement(ConversationPane, props));
    expect(html).toContain('class="chat-date new-conversation-marker"');
    expect(html).toContain('<span>已开始新对话</span>');
    expect(html.indexOf('new-conversation-marker')).toBeLessThan(
      html.indexOf('conversation-empty'),
    );
  });

  it('requires confirmation before executing startNewMain', async () => {
    const { props, actions } = view();
    const container = installReactDomContainer();
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(ConversationPane, props));
      });
      const send = controls.send as (mode: InputMode) => Promise<void>;
      await act(async () => {
        await send(InputMode.FOLLOW_UP);
      });

      expect(actions.execute).not.toHaveBeenCalled();
      const dialog = controls.dialog as DialogProps;
      expect(dialog.title).toBe('开始新对话');
      const warning = renderToStaticMarkup(createElement(Fragment, null, dialog.children));
      expect(warning).toContain('上下文将被清空，无法恢复');
      expect(warning).toContain('recall 也无法查询之前的内容');
      const buttons = dialog.actions.props.children as Array<
        ReactElement<{ onClick: () => void; children: ReactNode; className?: string }>
      >;
      expect(buttons[0]?.props.children).toBe('取消');
      expect(buttons[0]?.props.className).toBe('device-secondary');
      expect(buttons[1]?.props.children).toBe('清空并开始新对话');
      expect(buttons[1]?.props.className).toBe('device-primary device-danger');

      controls.dialog = undefined;
      await act(async () => {
        buttons[1]?.props.onClick();
      });
      expect(actions.execute).toHaveBeenCalledWith(
        'slash-command:new:main-new:draft-new',
        'startNewMain',
        { threadId: 'main-new', draftId: 'draft-new', text: '/new' },
      );
      expect(controls.dialog).toBeUndefined();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
