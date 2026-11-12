import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Code, createClient, createRouterTransport } from '@connectrpc/connect';
import {
  type Attachment,
  AttachmentService,
  EventService,
  InputMode,
  MessageService,
} from '@kairos/contracts';
import { expect, it } from 'vitest';
import { utf8 } from '../attachments/fixtures.js';
import {
  controlledEnvironmentDependencies,
  createEnvironmentThreadClient,
  seedTestEnvironment,
} from '../integration/environment-fixture.js';
import {
  createTestAuthentication,
  testSessionInterceptor,
} from '../integration/test-authentication.js';
import { RunCoordinator } from '../sessions/runtime.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { registerGuiRoutes } from './connect.js';
import { BashLogReader } from './logs.js';

it('exposes authorized idempotent uploads, downloads and metadata-only snapshots', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'kairos-attachments-api-'));
  const database = openDatabase(':memory:');
  seedTestEnvironment(database, 'owner-1');
  const store = new SessionStore(database);
  const coordinator = new RunCoordinator({
    ...controlledEnvironmentDependencies(store.database, 'owner-1'),
    store,
  });
  const clientsFor = (ownerId: string) => {
    const transport = createRouterTransport(
      (router) =>
        registerGuiRoutes(router, {
          store,
          coordinator,
          logs: new BashLogReader({ store }),
          modelStatus: {
            providerId: '',
            modelId: '',
            contextCapacity: 1,
            outputReserve: 1,
            available: false,
            configurationErrors: [],
          },
          authentication: createTestAuthentication(database, ownerId, `session-${ownerId}`),
        }),
      { transport: { interceptors: [testSessionInterceptor(`session-${ownerId}`)] } },
    );
    return {
      attachments: createClient(AttachmentService, transport),
      threads: createEnvironmentThreadClient(transport),
      messages: createClient(MessageService, transport),
      events: createClient(EventService, transport),
    };
  };
  const owner = clientsFor('owner-1');
  const other = clientsFor('owner-2');
  try {
    const uploaded = await owner.attachments.uploadAttachment({
      clientActionId: 'upload-1',
      fileName: 'note.txt',
      data: utf8('abcdef'),
    });
    const replayed = await owner.attachments.uploadAttachment({
      clientActionId: 'upload-1',
      fileName: 'note.txt',
      data: utf8('abcdef'),
    });
    expect(replayed).toEqual(uploaded);
    await expect(
      owner.attachments.uploadAttachment({
        clientActionId: 'upload-1',
        fileName: 'note.txt',
        data: utf8('x'),
      }),
    ).rejects.toMatchObject({ code: Code.AlreadyExists });
    const attachmentId = uploaded.attachment?.attachmentId;
    if (!attachmentId) throw new Error('Upload did not return an attachment.');
    expect(Object.keys(uploaded.attachment ?? {}).sort()).toEqual([
      '$typeName',
      'attachmentId',
      'createdAt',
      'fileName',
      'mediaType',
      'sha256',
      'sizeBytes',
      'source',
    ]);

    const page = await owner.attachments.downloadAttachment({
      attachmentId,
      offset: 2n,
      limitBytes: 3,
    });
    expect(Buffer.from(page.data).toString()).toBe('cde');
    expect(page.nextOffset).toBe(5n);
    await expect(
      other.attachments.downloadAttachment({ attachmentId, limitBytes: 3 }),
    ).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    await expect(
      owner.attachments.downloadAttachment({ attachmentId, limitBytes: 262_145 }),
    ).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    const emptyPage = await owner.attachments.downloadAttachment({
      attachmentId,
      offset: 6n,
      limitBytes: 3,
    });
    expect(emptyPage.data).toHaveLength(0);
    expect(emptyPage.nextOffset).toBeUndefined();
    for (const offset of [7n, 99n, (1n << 64n) - 1n]) {
      await expect(
        owner.attachments.downloadAttachment({ attachmentId, offset, limitBytes: 3 }),
      ).rejects.toMatchObject({ code: Code.InvalidArgument });
    }

    const created = await owner.threads.createThread({
      clientActionId: 'thread-1',
      title: 'Attachments',
    });
    const threadId = created.thread?.threadId;
    if (!threadId) throw new Error('Thread was not created.');
    const sent = await owner.messages.sendMessage({
      clientActionId: 'send-1',
      threadId,
      text: '',
      mode: InputMode.FOLLOW_UP,
      attachmentIds: [attachmentId],
    });
    expect(sent.inputId).not.toBe('');
    const snapshot = await owner.threads.getThread({ threadId });
    expect(snapshot.snapshot?.inputs[0]?.attachments).toEqual([uploaded.attachment]);
    expect(snapshot.snapshot?.inputs[0]?.attachments[0]).not.toHaveProperty('content');
    expect(snapshot.snapshot?.inputs[0]?.attachments[0]).not.toHaveProperty('data');
    expect(snapshot.snapshot?.inputs[0]?.attachments[0]).not.toHaveProperty('ownerId');
    expect(snapshot.snapshot?.inputs[0]?.attachments[0]).toHaveProperty('sha256');
    let eventAttachments: Attachment[] | undefined;
    for await (const event of owner.events.watchThread({ threadId, afterSeq: 0n })) {
      if (event.payload.case === 'event' && event.payload.value.payload.case === 'inputAccepted') {
        eventAttachments = event.payload.value.payload.value.input?.attachments;
        break;
      }
    }
    expect(eventAttachments).toEqual([uploaded.attachment]);
    expect(
      await owner.attachments.deleteAttachment({ clientActionId: 'delete-linked', attachmentId }),
    ).toMatchObject({ deleted: false });

    const disposable = await owner.attachments.uploadAttachment({
      clientActionId: 'upload-disposable',
      fileName: 'disposable.txt',
      data: utf8('disposable'),
    });
    const disposableId = disposable.attachment?.attachmentId;
    if (!disposableId) throw new Error('Disposable upload did not return an attachment.');
    expect(
      await owner.attachments.deleteAttachment({
        clientActionId: 'delete-disposable',
        attachmentId: disposableId,
      }),
    ).toMatchObject({ deleted: true });
    expect(
      await owner.attachments.deleteAttachment({
        clientActionId: 'delete-disposable',
        attachmentId: disposableId,
      }),
    ).toMatchObject({ deleted: true });
  } finally {
    await coordinator.close();
    database.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
