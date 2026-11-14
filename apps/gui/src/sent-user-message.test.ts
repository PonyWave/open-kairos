import { create, MessageRole, MessageSchema, ToolResultStatus } from '@kairos/contracts';
import { expect, it } from 'vitest';
import { sentContentFromArguments, sentUserMessage } from './sent-user-message.js';

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
  expect(sent).toEqual({ content: '**完成。**', endTurn: true, deliveries: [] });
});

it('falls back to the tool call arguments when the result omits content', () => {
  const sent = sentUserMessage(
    toolResultMessage({ status: 'sent', message_seq: 2, end_turn: true }),
    sentContentFromArguments(JSON.stringify({ content: '**完成。**', end_turn: true })),
  );
  expect(sent).toEqual({ content: '**完成。**', endTurn: true, deliveries: [] });
});

it('returns null when neither the result nor the arguments carry content', () => {
  expect(sentUserMessage(toolResultMessage({ status: 'sent', end_turn: true }))).toBeNull();
  expect(sentContentFromArguments('{"end_turn":true}')).toBeUndefined();
  expect(sentContentFromArguments('not json')).toBeUndefined();
});

it('parses channel deliveries from the send result', () => {
  const sent = sentUserMessage(
    toolResultMessage({
      status: 'sent',
      content: '同步到 IM。',
      end_turn: true,
      deliveries: [
        { channel: 'feishu', delivery_id: 'd-1', status: 'queued' },
        { channel: 'wechat', delivery_id: 'd-2', status: 'failed', error: '微信渠道未登录。' },
        { channel: 'sms', delivery_id: 'd-3', status: 'queued' },
        { channel: 'wechat', status: 'queued' },
      ],
    }),
  );
  expect(sent?.deliveries).toEqual([
    { channel: 'feishu', deliveryId: 'd-1', status: 'queued' },
    { channel: 'wechat', deliveryId: 'd-2', status: 'failed', error: '微信渠道未登录。' },
  ]);
});

it('returns an empty delivery list for plain sends', () => {
  const sent = sentUserMessage(
    toolResultMessage({ status: 'sent', content: '只有 GUI。', end_turn: false }),
  );
  expect(sent?.deliveries).toEqual([]);
});
