/// <reference lib="dom" />

import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import {
  AttachmentSchema,
  AttachmentService,
  AttachmentSource,
  create,
  InputMode,
  type UploadAttachmentRequest,
  UploadAttachmentResponseSchema,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { applyDraftCompletion } from './action-completion.js';
import type { StorageLike } from './actions.js';
import { AttachmentUploader } from './attachment-upload.js';
import { createKairosClients } from './client.js';
import { planComposerSubmission } from './composer-submission.js';
import { loadDraft, type MessageDraft, newDraft, saveDraft } from './drafts.js';

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
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

function draftAccess(storage: MemoryStorage, owner: string, initial?: MessageDraft) {
  let current = initial ?? loadDraft(storage, owner);
  return {
    getDraft: () => current,
    updateDraft: (next: MessageDraft) => {
      saveDraft(storage, owner, next);
      current = next;
    },
  };
}

function uploadHarness(loseFirstResponse = false) {
  const requests: UploadAttachmentRequest[] = [];
  const accepted = new Map<string, import('@kairos/contracts').UploadAttachmentResponse>();
  let lost = false;
  const transport = createRouterTransport((router) => {
    router.service(AttachmentService, {
      async uploadAttachment(request) {
        requests.push(request);
        const existing = accepted.get(request.clientActionId);
        if (existing) return existing;
        const data = new Uint8Array(request.data);
        const digest = await crypto.subtle.digest('SHA-256', data);
        const sha256 = Array.from(new Uint8Array(digest), (value) =>
          value.toString(16).padStart(2, '0'),
        ).join('');
        const png = data[0] === 0x89 && data[1] === 0x50;
        const jpeg = data[0] === 0xff && data[1] === 0xd8;
        const mediaType = png ? 'image/png' : jpeg ? 'image/jpeg' : 'text/plain';
        const response = create(UploadAttachmentResponseSchema, {
          clientActionId: request.clientActionId,
          attachment: create(AttachmentSchema, {
            attachmentId: `attachment-${accepted.size + 1}`,
            fileName: request.fileName,
            mediaType,
            sizeBytes: BigInt(request.data.length),
            ...(mediaType === 'text/plain' ? {} : { width: 1, height: 1 }),
            sha256,
            createdAt: { seconds: 1n, nanos: 0 },
            source: request.source,
          }),
        });
        accepted.set(request.clientActionId, response);
        if (loseFirstResponse && !lost) {
          lost = true;
          throw new ConnectError('response lost', Code.Unavailable);
        }
        return response;
      },
    });
  });
  return { clients: createKairosClients({ transport }), requests };
}

function file(name: string, body: string): File {
  return new File([body], name, { type: 'text/plain' });
}

describe('AttachmentUploader with generated Connect clients', () => {
  it('uploads a real multi-selection and preserves ordered ids for attachment-only sending', async () => {
    const storage = new MemoryStorage();
    const access = draftAccess(storage, 'main-1');
    const harness = uploadHarness();
    const uploader = new AttachmentUploader(harness.clients, access, {
      composerOwner: 'main',
      threadId: 'thread-1',
    });

    await uploader.addFiles([file('first.txt', 'first body'), file('second.txt', 'second body')]);

    const draft = access.getDraft();
    expect(draft.attachments?.map((item) => item.status)).toEqual(['ready', 'ready']);
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[0]?.data).toBeInstanceOf(Uint8Array);
    const submission = planComposerSubmission({
      draftId: draft.id,
      text: '',
      attachments: draft.attachments,
      mode: InputMode.FOLLOW_UP,
      busy: false,
      isTaskDraft: false,
      selectedThreadId: 'main-1',
      snapshotReady: true,
    });
    expect(submission).toMatchObject({
      kind: 'action',
      actionKind: 'sendMessage',
      payload: {
        text: '',
        attachmentIds: draft.attachments?.map((item) => item.metadata?.attachmentId),
      },
    });
    for (const owner of ['kairos.message-draft.v1.main-1']) {
      expect(storage.values.get(owner)).not.toContain('first body');
      expect(storage.values.get(owner)).not.toContain('second body');
    }
  });

  it('preserves clipboard PNG, JPEG and text sources through restore and submission', async () => {
    const storage = new MemoryStorage();
    const access = draftAccess(storage, 'main-1');
    const harness = uploadHarness();
    const uploader = new AttachmentUploader(harness.clients, access, {
      composerOwner: 'main',
      threadId: 'thread-1',
    });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=',
      'base64',
    );
    await uploader.addFiles(
      [
        new File([png], 'pasted.png', { type: 'image/png' }),
        new File([jpeg], 'pasted.jpg', { type: 'image/jpeg' }),
        file('pasted.txt', 'pasted text'),
      ],
      { source: 'clipboard' },
    );

    expect(harness.requests.map((request) => request.source)).toEqual([
      AttachmentSource.CLIPBOARD,
      AttachmentSource.CLIPBOARD,
      AttachmentSource.CLIPBOARD,
    ]);
    const draft = access.getDraft();
    expect(draft.attachments?.map((item) => item.metadata?.mediaType)).toEqual([
      'image/png',
      'image/jpeg',
      'text/plain',
    ]);
    expect(loadDraft(storage, 'main-1').attachments?.map((item) => item.source)).toEqual([
      'clipboard',
      'clipboard',
      'clipboard',
    ]);
    const submission = planComposerSubmission({
      draftId: draft.id,
      text: '',
      attachments: draft.attachments,
      mode: InputMode.FOLLOW_UP,
      busy: false,
      isTaskDraft: false,
      selectedThreadId: 'main-1',
      snapshotReady: true,
    });
    const attachmentIds = draft.attachments?.map((item) => item.metadata?.attachmentId);
    expect(submission).toMatchObject({
      kind: 'action',
      payload: {
        attachmentIds,
        clipboardAttachmentIds: attachmentIds,
      },
    });
  });

  it('keeps an unknown upload id through command completion, refresh and reselection', async () => {
    const storage = new MemoryStorage();
    const owner = 'main-1';
    const access = draftAccess(storage, owner);
    const harness = uploadHarness(true);
    const original = file('same.txt', 'same body');
    await new AttachmentUploader(harness.clients, access, {
      composerOwner: 'main',
      threadId: 'thread-1',
    }).addFiles([original]);

    const unknown = access.getDraft().attachments?.[0];
    expect(unknown?.status).toBe('unknown');
    expect(unknown?.actionId).toBeDefined();
    expect(storage.values.get(`kairos.message-draft.v1.${owner}`)).not.toContain('same body');

    access.updateDraft({ ...access.getDraft(), text: '/reload' });
    const afterCommand = applyDraftCompletion(access.getDraft(), {
      threadId: owner,
      draftId: access.getDraft().id,
      text: '/reload',
      attachmentIds: [],
      exactText: true,
    });
    if (!afterCommand) throw new Error('Command completion did not apply.');
    expect(afterCommand.text).toBe('');
    expect(afterCommand.attachments?.[0]).toBe(unknown);
    access.updateDraft(afterCommand);

    const restored = loadDraft(storage, owner);
    expect(restored.attachments?.[0]?.status).toBe('needs-reselection');
    expect(restored.attachments?.[0]?.file).toBeUndefined();
    expect(restored.attachments?.[0]?.actionId).toBe(unknown?.actionId);
    const restoredAccess = draftAccess(storage, owner, restored);
    const restoredUploader = new AttachmentUploader(harness.clients, restoredAccess, {
      composerOwner: 'main',
      threadId: 'thread-1',
    });
    const localId = restored.attachments?.[0]?.localId ?? '';
    await expect(
      restoredUploader.reselect(localId, file('same.txt', 'different body')),
    ).rejects.toThrow('不一致');
    expect(harness.requests).toHaveLength(1);

    await restoredUploader.reselect(localId, original);
    expect(restoredAccess.getDraft().attachments?.[0]?.status).toBe('ready');
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]?.clientActionId).toBe(harness.requests[0]?.clientActionId);
  });

  it('isolates simultaneous composer drafts and rejects more than four files locally', async () => {
    const storage = new MemoryStorage();
    const main = draftAccess(storage, 'main-1');
    const topic = draftAccess(storage, 'task-1');
    const harness = uploadHarness();
    const mainUploader = new AttachmentUploader(harness.clients, main, {
      composerOwner: 'main',
      threadId: 'thread-1',
    });
    const topicUploader = new AttachmentUploader(harness.clients, topic, {
      composerOwner: 'topic',
      threadId: 'thread-2',
    });
    await Promise.all([
      mainUploader.addFiles([file('main.txt', 'main body')]),
      topicUploader.addFiles([file('topic.txt', 'topic body')]),
    ]);

    expect(main.getDraft().attachments?.[0]?.fileName).toBe('main.txt');
    expect(topic.getDraft().attachments?.[0]?.fileName).toBe('topic.txt');
    expect(loadDraft(storage, 'main-1').attachments?.[0]?.fileName).toBe('main.txt');
    expect(loadDraft(storage, 'task-1').attachments?.[0]?.fileName).toBe('topic.txt');
    await expect(
      mainUploader.addFiles([
        file('1.txt', '1'),
        file('2.txt', '2'),
        file('3.txt', '3'),
        file('4.txt', '4'),
        file('5.txt', '5'),
      ]),
    ).rejects.toThrow('最多添加 4 个附件');
    expect(harness.requests).toHaveLength(2);
  });

  it('persists confirmed metadata without File bytes', async () => {
    const storage = new MemoryStorage();
    const access = draftAccess(storage, 'main-1');
    const harness = uploadHarness();
    const initial = newDraft();
    access.updateDraft(initial);
    await new AttachmentUploader(harness.clients, access, {
      composerOwner: 'main',
      threadId: 'thread-1',
    }).addFiles([file('a.txt', 'a body')]);

    const restored = loadDraft(storage, 'main-1');
    expect(restored.id).toBe(initial.id);
    expect(restored.attachments?.[0]?.status).toBe('ready');
    expect(restored.attachments?.[0]?.metadata?.sizeBytes).toBe(6n);
    expect(restored.attachments?.[0]?.file).toBeUndefined();
  });

  it('does not start an upload when stopped during file preparation', async () => {
    const storage = new MemoryStorage();
    const access = draftAccess(storage, 'main-a');
    const harness = uploadHarness();
    const original = file('old-account.txt', 'old account body');
    let release: ((bytes: ArrayBuffer) => void) | undefined;
    const pending = new Promise<ArrayBuffer>((resolve) => {
      release = resolve;
    });
    original.arrayBuffer = () => pending;
    const uploader = new AttachmentUploader(harness.clients, access, {
      composerOwner: 'main',
      threadId: 'thread-1',
    });

    const adding = uploader.addFiles([original]);
    uploader.stop();
    release?.(new TextEncoder().encode('old account body').buffer as ArrayBuffer);
    await adding;

    expect(harness.requests).toHaveLength(0);
    expect(access.getDraft().attachments?.[0]?.status).toBe('reading');
  });

  it('aborts an in-flight upload and ignores its late result after stop', async () => {
    const storage = new MemoryStorage();
    const access = draftAccess(storage, 'main-a');
    let signal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const transport = createRouterTransport((router) => {
      router.service(AttachmentService, {
        async uploadAttachment(request, context) {
          signal = context.signal;
          markStarted?.();
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(request.data));
          const sha256 = Array.from(new Uint8Array(digest), (value) =>
            value.toString(16).padStart(2, '0'),
          ).join('');
          return create(UploadAttachmentResponseSchema, {
            clientActionId: request.clientActionId,
            attachment: create(AttachmentSchema, {
              attachmentId: 'late-attachment',
              fileName: request.fileName,
              mediaType: 'text/plain',
              sizeBytes: BigInt(request.data.length),
              sha256,
            }),
          });
        },
      });
    });
    const uploader = new AttachmentUploader(createKairosClients({ transport }), access, {
      composerOwner: 'main',
      threadId: 'thread-1',
    });

    const adding = uploader.addFiles([file('old-account.txt', 'old account body')]);
    await started;
    uploader.stop();
    await adding;

    expect(signal?.aborted).toBe(true);
    expect(access.getDraft().attachments?.[0]?.status).toBe('uploading');
    expect(access.getDraft().attachments?.[0]?.metadata).toBeUndefined();
  });

  it('accepts a new generation after reactivation and ignores the old generation result', async () => {
    const storage = new MemoryStorage();
    const access = draftAccess(storage, 'main-a');
    let requestCount = 0;
    let markStarted: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const firstResult = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const transport = createRouterTransport((router) => {
      router.service(AttachmentService, {
        async uploadAttachment(request) {
          requestCount += 1;
          if (requestCount === 1) {
            markStarted?.();
            await firstResult;
          }
          const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(request.data));
          const sha256 = Array.from(new Uint8Array(digest), (value) =>
            value.toString(16).padStart(2, '0'),
          ).join('');
          return create(UploadAttachmentResponseSchema, {
            clientActionId: request.clientActionId,
            attachment: create(AttachmentSchema, {
              attachmentId: `attachment-${requestCount}`,
              fileName: request.fileName,
              mediaType: 'text/plain',
              sizeBytes: BigInt(request.data.length),
              sha256,
            }),
          });
        },
      });
    });
    const uploader = new AttachmentUploader(createKairosClients({ transport }), access, {
      composerOwner: 'main',
      threadId: 'thread-1',
    });

    const oldUpload = uploader.addFiles([file('old.txt', 'old generation')]);
    await started;
    uploader.stop();
    uploader.activate();
    releaseFirst?.();
    await oldUpload;
    expect(access.getDraft().attachments?.[0]?.status).toBe('uploading');

    await uploader.addFiles([file('new.txt', 'new generation')]);
    expect(requestCount).toBe(2);
    expect(access.getDraft().attachments?.[0]?.status).toBe('uploading');
    expect(access.getDraft().attachments?.[1]?.status).toBe('ready');
    expect(access.getDraft().attachments?.[1]?.metadata?.attachmentId).toBe('attachment-2');
  });
});
