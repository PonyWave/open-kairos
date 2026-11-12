import { createRouterTransport } from '@connectrpc/connect';
import {
  create,
  type Message,
  MessageRole,
  MessageSchema,
  ToolCallSchema,
  ToolResultErrorSchema,
  ToolResultStatus,
} from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createKairosClients } from './client.js';
import { MessageCard } from './message-card.js';
import { ToolOperationGroup } from './tool-call-groups.js';
import { projectAssociatedToolResultIds, projectToolOutcomes } from './tool-group-projection.js';

const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
const readCall = create(ToolCallSchema, {
  toolCallId: 'read-1',
  toolName: 'thread_read',
  argumentsJson: '{"tool_call_id":"call-1"}',
});
const source = create(MessageSchema, {
  messageId: 'source-read',
  threadId: 'main-1',
  agentId: 'thread',
  role: MessageRole.ASSISTANT,
  toolCalls: [readCall],
});
const readResult = create(MessageSchema, {
  messageId: 'result-read-1',
  threadId: 'main-1',
  agentId: 'thread',
  role: MessageRole.TOOL,
  toolName: 'thread_read',
  toolCallId: 'read-1',
  content: JSON.stringify({
    tool_call_id: 'call-1',
    status: 'completed',
    response: 'task response',
    timed_out: false,
  }),
});
const orphanResult = create(MessageSchema, {
  messageId: 'result-orphan',
  threadId: 'main-1',
  agentId: 'thread',
  role: MessageRole.TOOL,
  toolName: 'thread_read',
  toolCallId: 'missing-result',
  content: JSON.stringify({
    tool_call_id: 'call-1',
    status: 'completed',
    response: 'orphan response',
    timed_out: false,
  }),
});

function renderResultCard(message: Message, outcomes: ReturnType<typeof projectToolOutcomes>) {
  return renderToStaticMarkup(
    createElement(MessageCard, {
      message,
      delegationCall: null,
      clients,
      busy: false,
      editing: false,
      streaming: false,
      thinkingExpansionChoices: {},
      toolOutcomes: outcomes,
      associatedToolResultIds: projectAssociatedToolResultIds([source], outcomes),
      onThinkingExpansionChange: () => {},
      onStartEditing: () => {},
      onCancelEditing: () => {},
      onRevise: async () => {},
      onRerun: async () => {},
    }),
  );
}

describe('structured tool result association', () => {
  it('uses the current thread_read id in details and keeps the original delegation id as business data', () => {
    const outcomes = projectToolOutcomes([readResult, orphanResult]);

    expect(outcomes.has('read-1')).toBe(true);
    expect(outcomes.has('missing-result')).toBe(true);
    expect(outcomes.has('call-1')).toBe(false);
    expect([...projectAssociatedToolResultIds([source], outcomes)]).toEqual(['read-1']);

    const html = renderToStaticMarkup(
      createElement(ToolOperationGroup, {
        message: source,
        calls: [readCall],
        outcomes,
        streaming: false,
        clients,
        choices: { 'call:source-read:read-1': true },
        onExpandedChange: () => {},
      }),
    );
    expect(html).toContain('data-tool-call-id="read-1"');
    expect(html).toContain('call-1');
    expect(html).not.toContain('<dt>原工具调用</dt>');
    expect(html).toContain('task response');
    expect(html).not.toContain('工具结果待核对');
  });

  it('hides only an associated result and retains an unassociated independent ToolResultCard', () => {
    const outcomes = projectToolOutcomes([readResult, orphanResult]);

    expect(renderResultCard(readResult, outcomes)).toBe('');
    const orphan = renderResultCard(orphanResult, outcomes);
    expect(orphan).toContain('tool-result');
    expect(orphan).toContain('orphan response');
    expect(JSON.parse(orphanResult.content).tool_call_id).toBe('call-1');
    expect(orphan).not.toContain('<dt>原工具调用</dt>');
  });

  it('keeps an incomplete call error visible when no complete source ToolCall was persisted', () => {
    const incomplete = create(MessageSchema, {
      messageId: 'incomplete-result',
      threadId: 'main-1',
      agentId: 'thread',
      role: MessageRole.TOOL,
      toolName: 'read',
      toolCallId: 'incomplete-read',
      content: 'Tool arguments were incomplete.',
      toolStatus: ToolResultStatus.ERROR,
      toolError: { code: 'incomplete_call', message: 'Tool arguments were incomplete.' },
    });
    const outcomes = projectToolOutcomes([incomplete]);
    const html = renderResultCard(incomplete, outcomes);
    expect(projectAssociatedToolResultIds([source], outcomes).has('incomplete-read')).toBe(false);
    expect(html).toContain('tool-result');
    expect(html).toContain('Tool arguments were incomplete.');
  });

  it('shows the terminal failure of an independent result with empty original error text', () => {
    const failure = create(MessageSchema, {
      ...orphanResult,
      content: '',
      toolStatus: ToolResultStatus.ERROR,
      toolError: create(ToolResultErrorSchema, { code: 'execution_failed', message: '' }),
    });
    const html = renderResultCard(failure, projectToolOutcomes([failure]));

    expect(html).toContain('失败');
    expect(html).not.toContain('>完成<');
    expect(failure.content).toBe('');
    expect(failure.toolError?.message).toBe('');
  });
});
