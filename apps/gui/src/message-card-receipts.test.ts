import { createRouterTransport } from '@connectrpc/connect';
import { create, MessageRole, MessageSchema } from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createKairosClients } from './client.js';
import { MessageCard } from './message-card.js';
import { projectDelegationReceipts } from './thread-view.js';

describe('delegation acceptance projection', () => {
  it('keeps an accepted receipt in call details instead of duplicating a tool message', () => {
    const message = create(MessageSchema, {
      messageId: 'receipt-1',
      threadId: 'main-1',
      agentId: 'thread',
      role: MessageRole.TOOL,
      toolName: 'thread_call',
      toolCallId: 'call-1',
      content: JSON.stringify({ tool_call_id: 'call-1', thread_id: 'task-1', status: 'accepted' }),
    });
    const html = renderToStaticMarkup(
      createElement(MessageCard, {
        message,
        delegationCall: null,
        clients: createKairosClients({ transport: createRouterTransport(() => {}) }),
        busy: false,
        editing: false,
        streaming: false,
        thinkingExpansionChoices: {},
        receipts: projectDelegationReceipts([message]),
        onThinkingExpansionChange: () => {},
        onStartEditing: () => {},
        onCancelEditing: () => {},
        onRevise: async () => {},
        onRerun: async () => {},
      }),
    );

    expect(html).toBe('');
  });
});
