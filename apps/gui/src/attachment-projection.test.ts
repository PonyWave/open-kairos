import {
  AttachmentSchema,
  create,
  MessageRole,
  MessageSchema,
  ThreadSchema,
  ThreadSnapshotSchema,
  WatchThreadResponseSchema,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { ThreadProjector } from './thread-projection.js';

describe('attachment revision projection', () => {
  it('keeps immutable attachments when only message text is revised', () => {
    const attachment = create(AttachmentSchema, {
      attachmentId: 'attachment-1',
      fileName: 'a.txt',
      mediaType: 'text/plain',
      sizeBytes: 1n,
      sha256: 'a'.repeat(64),
    });
    const message = create(MessageSchema, {
      messageId: 'message-1',
      threadId: 'thread-1',
      agentId: 'thread',
      seq: 1n,
      role: MessageRole.USER,
      content: '原文',
      attachments: [attachment],
    });
    const projector = new ThreadProjector('thread-1');
    projector.applySnapshot(
      create(ThreadSnapshotSchema, {
        thread: create(ThreadSchema, { threadId: 'thread-1', title: '主对话', seq: 1n }),
        messages: [message],
      }),
      0n,
    );
    projector.applyWatchResponse(
      create(WatchThreadResponseSchema, {
        payload: {
          case: 'event',
          value: {
            threadId: 'thread-1',
            eventId: 'event-1',
            seq: 1n,
            payload: {
              case: 'messageRevised',
              value: {
                revision: { revisionId: 'revision-1', messageId: 'message-1', text: '修订' },
              },
            },
          },
        },
      }),
    );

    const revised = projector.state.snapshot?.messages[0];
    expect(revised?.content).toBe('修订');
    expect(revised?.revisionId).toBe('revision-1');
    expect(revised?.attachments).toEqual([attachment]);
  });
});
