import {
  create,
  InputMode,
  InputStatus,
  MessageRole,
  MessageSource,
  ThreadSnapshotSchema,
  ThreadType,
} from '@kairos/contracts';
import { expect, it } from 'vitest';
import { ThreadProjector } from './thread-projection.js';

it.each([MessageSource.CHANNEL, MessageSource.BACKGROUND_TASK])(
  'keeps the main conversation readable when a new source %s arrives',
  (source) => {
    const snapshot = create(ThreadSnapshotSchema, {
      thread: { threadId: 'main', threadType: ThreadType.MAIN },
      messages: [
        {
          messageId: 'old',
          threadId: 'main',
          agentId: 'thread',
          seq: 1n,
          role: MessageRole.USER,
          source: MessageSource.USER,
          content: '已有消息',
        },
        {
          messageId: 'new',
          threadId: 'main',
          agentId: 'thread',
          seq: 2n,
          role: MessageRole.USER,
          source,
          content: '通知',
        },
      ],
      inputs: [
        {
          inputId: 'input',
          threadId: 'main',
          source,
          mode: InputMode.FOLLOW_UP,
          status: InputStatus.QUEUED,
          text: '渠道消息',
        },
      ],
    });
    const projector = new ThreadProjector('main');
    projector.applySnapshot(snapshot, 0n);
    expect(projector.state.snapshot?.messages).toHaveLength(2);
    expect(projector.state.snapshot?.inputs[0]?.source).toBe(source);
  },
);
