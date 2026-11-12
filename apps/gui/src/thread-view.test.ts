import {
  create,
  MessageRole,
  MessageSchema,
  MessageSource,
  ToolCallSchema,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { isContinuedDelegation, previewSender, projectDelegationReceipts } from './thread-view.js';

describe('delegation view projections', () => {
  it('uses only persisted tool receipts for target and acceptance state', () => {
    const messages = [
      create(MessageSchema, {
        messageId: 'receipt-1',
        threadId: 'main-1',
        agentId: 'thread',
        role: MessageRole.TOOL,
        toolName: 'thread_call',
        toolCallId: 'call-1',
        content: JSON.stringify({
          tool_call_id: 'call-1',
          thread_id: 'task-1',
          status: 'accepted',
        }),
      }),
      create(MessageSchema, {
        messageId: 'other-tool',
        threadId: 'main-1',
        agentId: 'thread',
        role: MessageRole.TOOL,
        toolName: 'bash',
        toolCallId: 'call-2',
        content: JSON.stringify({ tool_call_id: 'call-2', thread_id: 'fake', status: 'accepted' }),
      }),
    ];

    const receipts = projectDelegationReceipts(messages);
    expect(receipts.get('call-1')).toEqual({ status: 'accepted', threadId: 'task-1' });
    expect(receipts.has('call-2')).toBe(false);
  });

  it('distinguishes continued calls from first-message creation', () => {
    const call = (argumentsJson: string) =>
      create(ToolCallSchema, { toolCallId: 'call-1', toolName: 'thread_call', argumentsJson });
    expect(isContinuedDelegation(call('{"thread_id":"task-1","prompt":"继续"}'))).toBe(true);
    expect(isContinuedDelegation(call('{"thread_id":"","prompt":"首条"}'))).toBe(false);
    expect(isContinuedDelegation(call('{"prompt":"首条"}'))).toBe(false);
  });

  it('does not treat a Thread response as a direct user message', () => {
    const response = create(MessageSchema, {
      role: MessageRole.USER,
      source: MessageSource.THREAD_RESPONSE,
    });
    expect(response.source).toBe(MessageSource.THREAD_RESPONSE);
  });

  it('uses generic role labels instead of a fixed account name', () => {
    expect(previewSender({ role: MessageRole.USER, source: MessageSource.USER })).toEqual({
      label: '用户',
      user: true,
    });
    expect(
      previewSender({ role: MessageRole.USER, source: MessageSource.THREAD_RESPONSE }),
    ).toEqual({ label: 'Kairos', user: false });
  });
});
