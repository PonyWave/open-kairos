import {
  ChannelId,
  ChannelReferenceKind,
  create,
  InputSchema,
  InputStatus,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { queuedInputDisplay } from './queue-display.js';

describe('queuedInputDisplay', () => {
  it('shows the channel icon key and strips the inbound prefix', () => {
    const input = create(InputSchema, {
      inputId: 'in-1',
      threadId: 'main-1',
      text: '[来自微信]\n帮我查一下天气',
      status: InputStatus.QUEUED,
      channel: { channel: ChannelId.WECHAT, kind: ChannelReferenceKind.INBOUND },
    });
    expect(queuedInputDisplay(input)).toEqual({ text: '帮我查一下天气', channelKey: 'wechat' });
  });

  it('keeps ordinary text untouched', () => {
    const input = create(InputSchema, {
      inputId: 'in-2',
      threadId: 'main-1',
      text: '[来自微信] 这是我手打的',
      status: InputStatus.QUEUED,
    });
    expect(queuedInputDisplay(input)).toEqual({
      text: '[来自微信] 这是我手打的',
      channelKey: undefined,
    });
  });
});
