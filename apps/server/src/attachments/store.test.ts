import { describe, expect, it } from 'vitest';
import { seedTestSession } from '../integration/test-authentication.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { jpegBytes, pngBytes, sizedJpegBytes, utf8 } from './fixtures.js';
import { validateAttachmentBytes } from './validation.js';

const ownerId = 'owner-1';

function fixture() {
  const database = openDatabase(':memory:');
  seedTestSession(database, ownerId, 'attachment-session');
  const store = new SessionStore(database);
  return { database, store };
}

function upload(
  store: SessionStore,
  actionId: string,
  fileName: string,
  bytes: Uint8Array,
  owner = ownerId,
) {
  return store.attachments.upload({ ownerId: owner, clientActionId: actionId, fileName, bytes })
    .attachment;
}

function createThread(store: SessionStore) {
  return store.createThread({
    ownerId,
    clientActionId: 'create-thread',
    method: 'CreateThread',
    parameters: { title: 'Attachments' },
    title: 'Attachments',
  });
}

it('validates content instead of file extensions and deduplicates immutable bytes', () => {
  const { database, store } = fixture();
  try {
    const first = upload(store, 'upload-1', 'notes.png', utf8('unique attachment text'));
    expect(first.mediaType).toBe('text/plain');
    expect(upload(store, 'upload-1', 'notes.png', utf8('unique attachment text'))).toEqual(first);
    expect(upload(store, 'upload-2', 'renamed.txt', utf8('unique attachment text'))).toEqual(first);
    const rebuilt = new SessionStore(database);
    expect(upload(rebuilt, 'upload-1', 'notes.png', utf8('unique attachment text'))).toEqual(first);
    expect(() => upload(store, 'upload-1', 'notes.png', utf8('different'))).toThrowError(
      expect.objectContaining({ code: 'action_conflict' }),
    );
    expect(database.prepare('SELECT COUNT(*) AS count FROM attachments').get()).toEqual({
      count: 1,
    });
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    const hinted = store.attachments.upload({
      ownerId,
      clientActionId: 'upload-hinted',
      fileName: 'hint.txt',
      declaredMediaType: 'image/png',
      bytes: utf8('hinted text'),
    }).attachment;
    expect(hinted.mediaType).toBe('text/plain');
    expect(() =>
      store.attachments.upload({
        ownerId,
        clientActionId: 'upload-invalid-mime',
        fileName: 'invalid.txt',
        declaredMediaType: 'invalid',
        bytes: utf8('invalid'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_argument' }));

    const other = upload(
      store,
      'other-upload',
      'other.txt',
      utf8('unique attachment text'),
      'owner-2',
    );
    expect(other.attachmentId).not.toBe(first.attachmentId);
    expect(() =>
      store.attachments.download({ ownerId, attachmentId: other.attachmentId, limitBytes: 10 }),
    ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
    expect(() => store.attachments.selectForInput(ownerId, [other.attachmentId])).toThrowError(
      expect.objectContaining({ code: 'permission_denied' }),
    );

    expect(upload(store, 'png', 'actually-jpeg.png', pngBytes)).toMatchObject({
      mediaType: 'image/png',
      width: 1,
      height: 1,
      byteSize: pngBytes.length,
    });
    expect(upload(store, 'jpeg', 'actually-png.jpg', jpegBytes)).toMatchObject({
      mediaType: 'image/jpeg',
      width: 1,
      height: 1,
      byteSize: jpegBytes.length,
    });
    expect(() => upload(store, 'bad-png', 'bad.png', pngBytes.subarray(0, -1))).toThrowError(
      expect.objectContaining({ code: 'invalid_argument' }),
    );
    expect(() =>
      upload(store, 'bad-jpeg', 'bad.jpg', Uint8Array.from([0xff, 0xd8, 0x00])),
    ).toThrowError(expect.objectContaining({ code: 'invalid_argument' }));
    expect(() => upload(store, 'bad-utf8', 'bad.txt', Uint8Array.from([0xc3, 0x28]))).toThrowError(
      expect.objectContaining({ code: 'invalid_argument' }),
    );
    expect(() => upload(store, 'nul', 'nul.txt', utf8('a\0b'))).toThrowError(
      expect.objectContaining({ code: 'invalid_argument' }),
    );
  } finally {
    database.close();
  }
});

it('enforces single-file, text-total and attachment-count limits', () => {
  const { database, store } = fixture();
  try {
    expect(() => upload(store, 'too-large', 'large.txt', utf8('a'.repeat(200_001)))).toThrowError(
      expect.objectContaining({ code: 'input_too_large' }),
    );
    const first = upload(store, 'text-1', 'one.txt', utf8('a'.repeat(200_000)));
    const second = upload(store, 'text-2', 'two.txt', utf8('b'.repeat(200_000)));
    expect(() =>
      store.attachments.selectForInput(ownerId, [first.attachmentId, second.attachmentId]),
    ).toThrowError(expect.objectContaining({ code: 'input_too_large' }));

    const largeImages = Array.from({ length: 4 }, (_, index) => {
      const bytes = sizedJpegBytes(700_000);
      bytes[100 + index] = index + 1;
      return upload(store, `image-${index}`, `${index}.jpg`, bytes);
    });
    expect(largeImages.reduce((total, attachment) => total + attachment.byteSize, 0)).toBe(
      2_800_000,
    );
    expect(
      store.attachments.selectForInput(
        ownerId,
        largeImages.map((attachment) => attachment.attachmentId),
      ),
    ).toHaveLength(4);
    expect(() =>
      store.attachments.selectForInput(ownerId, [
        ...largeImages.map((attachment) => attachment.attachmentId),
        first.attachmentId,
      ]),
    ).toThrowError(expect.objectContaining({ code: 'input_too_large' }));
    expect(() =>
      store.attachments.selectForInput(ownerId, [first.attachmentId, first.attachmentId]),
    ).toThrowError(expect.objectContaining({ code: 'invalid_argument' }));
  } finally {
    database.close();
  }
});

it('pages downloads, preserves associations and rolls back failed sends', () => {
  const { database, store } = fixture();
  try {
    const attachment = upload(store, 'download', 'page.txt', utf8('abcdef'));
    const first = store.attachments.download({
      ownerId,
      attachmentId: attachment.attachmentId,
      offset: 1n,
      limitBytes: 3,
    });
    expect(Buffer.from(first.data).toString()).toBe('bcd');
    expect(first.nextOffset).toBe(4n);
    const last = store.attachments.download({
      ownerId,
      attachmentId: attachment.attachmentId,
      offset: first.nextOffset,
      limitBytes: 3,
    });
    expect(Buffer.from(last.data).toString()).toBe('ef');
    expect(last.nextOffset).toBeUndefined();
    expect(
      store.attachments.download({
        ownerId,
        attachmentId: attachment.attachmentId,
        offset: 6n,
        limitBytes: 3,
      }).data,
    ).toHaveLength(0);
    for (const offset of [7n, 99n, (1n << 64n) - 1n]) {
      expect(() =>
        store.attachments.download({
          ownerId,
          attachmentId: attachment.attachmentId,
          offset,
          limitBytes: 3,
        }),
      ).toThrowError(expect.objectContaining({ code: 'invalid_argument' }));
    }

    const thread = createThread(store);
    const sent = store.sendMessage({
      ownerId,
      clientActionId: 'send-1',
      method: 'SendMessage',
      parameters: {
        threadId: thread.threadId,
        text: '',
        mode: 'follow_up',
        attachmentIds: [attachment.attachmentId],
      },
      threadId: thread.threadId,
      text: '',
      mode: 'follow_up',
      attachmentIds: [attachment.attachmentId],
    });
    expect(sent.input.attachments).toEqual([
      { ...attachment, workspaceRequired: true, workspaceStatus: 'pending' },
    ]);
    expect(
      store.attachments.remove({
        ownerId,
        clientActionId: 'delete-linked',
        attachmentId: attachment.attachmentId,
      }),
    ).toEqual({ attachmentId: attachment.attachmentId, deleted: false });

    const edited = store.editInput({
      ownerId,
      clientActionId: 'edit-1',
      method: 'EditInput',
      parameters: {},
      threadId: thread.threadId,
      inputId: sent.input.inputId,
      text: 'edited',
      expectedVersion: 1n,
    });
    expect(edited.attachments).toEqual([
      { ...attachment, workspaceRequired: true, workspaceStatus: 'pending' },
    ]);
    const emptied = store.editInput({
      ownerId,
      clientActionId: 'edit-2',
      method: 'EditInput',
      parameters: {},
      threadId: thread.threadId,
      inputId: sent.input.inputId,
      text: '',
      expectedVersion: 2n,
    });
    expect(emptied.attachments).toEqual([
      { ...attachment, workspaceRequired: true, workspaceStatus: 'pending' },
    ]);

    const other = upload(store, 'other-owner', 'other.txt', utf8('other'), 'owner-2');
    expect(() =>
      store.sendMessage({
        ownerId,
        clientActionId: 'send-denied',
        method: 'SendMessage',
        parameters: {},
        threadId: thread.threadId,
        text: 'denied',
        mode: 'follow_up',
        attachmentIds: [other.attachmentId],
      }),
    ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM inputs WHERE text = ?').get('denied'),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM client_actions WHERE client_action_id = 'send-denied'",
        )
        .get(),
    ).toEqual({ count: 0 });
  } finally {
    database.close();
  }
});

it('rejects malformed image structures and oversized RPC uploads', () => {
  const database = openDatabase(':memory:');
  seedTestSession(database, ownerId, 'attachment-session');
  const store = new SessionStore(database, { maxRpcBytes: 4096 });
  try {
    expect(validateAttachmentBytes(sizedJpegBytes(700_000))).toMatchObject({
      mediaType: 'image/jpeg',
      width: 1,
      height: 1,
    });
    expect(() => upload(store, 'rpc-limit', 'large.txt', utf8('a'.repeat(3000)))).toThrowError(
      expect.objectContaining({ code: 'input_too_large' }),
    );
  } finally {
    database.close();
  }
});

it('preserves the model message text while linking its input attachments', () => {
  const { database, store } = fixture();
  try {
    const attachment = upload(store, 'upload-model-text', 'note.txt', utf8('attachment'));
    const thread = createThread(store);
    const sent = store.sendMessage({
      ownerId,
      clientActionId: 'send-model-text',
      method: 'SendMessage',
      parameters: {},
      threadId: thread.threadId,
      text: 'queue text',
      mode: 'follow_up',
      attachmentIds: [attachment.attachmentId],
    });
    const content = 'm'.repeat(40 * 1024);
    const message = store.appendModelMessage({
      runId: sent.runId,
      inputId: sent.input.inputId,
      message: {
        role: 'user',
        content,
        content_parts: [{ type: 'attachment', attachment_id: attachment.attachmentId }],
      },
    });
    expect(message.message.content).toBe(content);
    expect(message.attachments).toEqual([
      { ...attachment, workspaceRequired: true, workspaceStatus: 'pending' },
    ]);
  } finally {
    database.close();
  }
});

it('creates authorized tool images and materializes them only for model requests', () => {
  const { database, store } = fixture();
  try {
    expect(() =>
      store.attachments.createToolImage({
        ownerId,
        fileName: 'wrong.png',
        bytes: pngBytes,
        expectedSha256: 'a'.repeat(64),
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_argument' }));
    expect(() =>
      store.attachments.createToolImage({
        ownerId,
        fileName: 'text.png',
        bytes: utf8('not an image'),
        expectedSha256: '5464533c9647b67eb320c40ccc5959537c09102ae75388f6a7675b433e745c9d',
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_argument' }));

    const image = store.attachments.createToolImage({
      ownerId,
      fileName: 'pixel.png',
      bytes: pngBytes,
      expectedSha256: '6b7fa434f92a8b80aab02d9bf1a12e49ffcae424e4013a1c4f68b67e3d2bbcd0',
    });
    expect(image).toMatchObject({
      fileName: 'pixel.png',
      mediaType: 'image/png',
      width: 1,
      height: 1,
      byteSize: pngBytes.length,
    });
    const content = JSON.stringify({ attachment_id: image.attachmentId });
    const request = {
      tools: [],
      messages: [
        {
          role: 'tool' as const,
          content,
          content_parts: [{ type: 'attachment' as const, attachment_id: image.attachmentId }],
          tool_call_id: 'image-call',
          tool_name: 'read_image',
        },
      ],
    };
    expect(JSON.stringify(request)).not.toContain('base64');
    const materialized = store.attachments.materializeRequest(request);
    const tool = materialized.messages[0];
    expect(tool?.role).toBe('tool');
    if (tool?.role !== 'tool') throw new Error('Tool message is missing.');
    expect(tool.content).toBe(content);
    expect(tool.content_parts?.[0]).toEqual({ type: 'text', text: 'Attachment: pixel.png' });
    expect(tool.content_parts?.[1]).toMatchObject({
      type: 'image_url',
      image_url: { detail: 'low' },
    });
    expect(
      database
        .prepare(
          'SELECT media_type, width, height, sha256 FROM attachments WHERE attachment_id = ?',
        )
        .get(image.attachmentId),
    ).toMatchObject({ media_type: 'image/png', width: 1, height: 1 });
  } finally {
    database.close();
  }
});

describe('channel attachments', () => {
  it('stores arbitrary bytes as octet-stream and selects them for channel input', () => {
    const { database, store } = fixture();
    try {
      const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0x01]);
      const uploaded = store.attachments.uploadChannel({
        ownerId: 'owner',
        fileName: '报告.pdf',
        bytes: pdf,
      });
      expect(uploaded.mediaType).toBe('application/octet-stream');
      expect(uploaded.source).toBe('channel');
      const selected = store.attachments.selectForChannelInput('owner', [uploaded.attachmentId]);
      expect(selected).toHaveLength(1);
      expect(selected[0]?.source).toBe('channel');
      expect(() =>
        store.attachments.selectForChannelInput('other', [uploaded.attachmentId]),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it('detects png and text content for channel attachments', () => {
    const { database, store } = fixture();
    try {
      const png = store.attachments.uploadChannel({
        ownerId: 'owner',
        fileName: 'photo',
        bytes: pngBytes,
      });
      expect(png.mediaType).toBe('image/png');
      expect(png.width).toBeGreaterThan(0);
      const text = store.attachments.uploadChannel({
        ownerId: 'owner',
        fileName: 'notes',
        bytes: new TextEncoder().encode('你好，世界'),
      });
      expect(text.mediaType).toBe('text/plain');
    } finally {
      database.close();
    }
  });
});
