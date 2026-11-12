import { create, MessageRole, MessageSchema, ToolResultStatus } from '@kairos/contracts';
import { expect, it } from 'vitest';
import { sentUserMessage } from './sent-user-message.js';

function toolResultMessage(content: unknown) {
  return create(MessageSchema, {
    messageId: 'tool-1',
    threadId: 'main',
    agentId: 'thread',
    role: MessageRole.TOOL,
    toolCallId: 'send-1',
    toolName: 'send_to_user',
    toolStatus: ToolResultStatus.SUCCESS,
    content: JSON.stringify(content),
  });
}

it('renders a normal send_to_user result as a message bubble', () => {
  const sent = sentUserMessage(
    toolResultMessage({ status: 'sent', content: '**完成。**', end_turn: true }),
  );
  expect(sent).toEqual({ content: '**完成。**', endTurn: true });
});

it('does not render a redelivery result as a new bubble', () => {
  const sent = sentUserMessage(
    toolResultMessage({
      status: 'sent',
      redelivered: true,
      delivery: { channel: 'feishu', delivery_id: 'd-1', status: 'queued' },
      end_turn: false,
    }),
  );
  expect(sent).toBeNull();
});
