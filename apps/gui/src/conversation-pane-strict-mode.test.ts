/// <reference lib="dom" />

import { createRouterTransport } from '@connectrpc/connect';
import {
  AttachmentSchema,
  AttachmentService,
  create,
  UploadAttachmentResponseSchema,
} from '@kairos/contracts';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import { type ActionKind, ClientActionStore } from './actions.js';
import { AttachmentUploader } from './attachment-upload.js';
import { createKairosClients, type KairosClients } from './client.js';
import { ConversationPane } from './conversation-pane.js';
import { localTaskDraftId, type MessageDraft, newDraft } from './drafts.js';
import { ThreadSyncManager } from './thread-sync-manager.js';
import type { ActionExecutorView } from './use-action-executor.js';
import type { useDrafts } from './use-drafts.js';

vi.mock('react/jsx-runtime', () => ({
  jsx: () => null,
  jsxs: () => null,
  Fragment: Symbol.for('react.fragment'),
}));

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
  const window = {
    document,
    addEventListener: noop,
    removeEventListener: noop,
    getSelection: () => null,
    HTMLIFrameElement: class {},
    HTMLElement: class {},
  };
  const container = element('DIV');
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('navigator', { userAgent: 'node' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return container as unknown as HTMLElement;
}

function actionView(clients: KairosClients): ActionExecutorView {
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ConversationPane StrictMode attachment lifecycle', () => {
  it('uploads after the second effect setup and stops on the real unmount', async () => {
    const requests: string[] = [];
    const transport = createRouterTransport((router) => {
      router.service(AttachmentService, {
        async uploadAttachment(request) {
          requests.push(request.clientActionId);
          const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(request.data));
          const sha256 = Array.from(new Uint8Array(digest), (value) =>
            value.toString(16).padStart(2, '0'),
          ).join('');
          return create(UploadAttachmentResponseSchema, {
            clientActionId: request.clientActionId,
            attachment: create(AttachmentSchema, {
              attachmentId: 'strict-mode-attachment',
              fileName: request.fileName,
              mediaType: 'text/plain',
              sizeBytes: BigInt(request.data.length),
              sha256,
            }),
          });
        },
      });
    });
    const clients = createKairosClients({ transport });
    let currentDraft: MessageDraft = newDraft();
    const drafts: ReturnType<typeof useDrafts> = {
      getDraft: () => currentDraft,
      updateDraft: (_ownerId, next) => {
        currentDraft = next;
      },
      completeDraft: () => {},
      removeAttachment: () => {},
      restoreQueueDraft: () => {},
    };
    let uploader: AttachmentUploader | undefined;
    const activate = AttachmentUploader.prototype.activate;
    const activateSpy = vi
      .spyOn(AttachmentUploader.prototype, 'activate')
      .mockImplementation(function (this: AttachmentUploader) {
        uploader = this;
        activate.call(this);
      });
    const stopSpy = vi.spyOn(AttachmentUploader.prototype, 'stop');
    const container = installReactDomContainer();
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(ConversationPane, {
              clients,
              threadSyncManager: new ThreadSyncManager(clients),
              variant: 'draft',
              composerOwner: 'strict-mode',
              threadId: null,
              thread: null,
              mainThreadId: null,
              draftOwner: localTaskDraftId,
              actions: actionView(clients),
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
            }),
          ),
        );
      });

      expect(activateSpy).toHaveBeenCalledTimes(2);
      if (!uploader) throw new Error('ConversationPane 未创建上传器。');
      const currentUploader: AttachmentUploader = uploader;
      await act(async () => {
        await currentUploader.addFiles([
          new File(['strict mode body'], 'strict-mode.txt', { type: 'text/plain' }),
        ]);
      });

      expect(requests).toHaveLength(1);
      expect(currentDraft.attachments?.[0]?.status).toBe('ready');
      expect(currentDraft.attachments?.[0]?.metadata?.attachmentId).toBe('strict-mode-attachment');
    } finally {
      await act(async () => root.unmount());
    }
    expect(stopSpy).toHaveBeenCalled();
  });
});
