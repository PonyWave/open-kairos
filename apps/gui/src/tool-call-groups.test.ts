import { createRouterTransport } from '@connectrpc/connect';
import {
  ContentBlockSchema,
  ContentBlockType,
  create,
  MessageRole,
  MessageSchema,
  ToolCallSchema,
  ToolResultStatus,
} from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createKairosClients } from './client.js';
import { MessageCard } from './message-card.js';
import { withThinkingBlockExpanded } from './thinking-expansion.js';
import { ToolOperationGroup } from './tool-call-groups.js';
import { projectToolItems, projectToolOutcomes } from './tool-group-projection.js';

const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
const calls = [
  create(ToolCallSchema, { toolCallId: 'read-1', toolName: 'read', argumentsJson: '{"path":"a"}' }),
  create(ToolCallSchema, {
    toolCallId: 'write-1',
    toolName: 'write',
    argumentsJson: '{"path":"b"}',
  }),
  create(ToolCallSchema, { toolCallId: 'read-2', toolName: 'read', argumentsJson: '{"path":"c"}' }),
  create(ToolCallSchema, {
    toolCallId: 'bash-1',
    toolName: 'bash',
    argumentsJson: '{"command":"pwd"}',
  }),
  create(ToolCallSchema, {
    toolCallId: 'recall-1',
    toolName: 'recall',
    argumentsJson: '{"sql":"select 1"}',
  }),
];
const message = create(MessageSchema, {
  messageId: 'response-1',
  threadId: 'main-1',
  agentId: 'thread',
  role: MessageRole.ASSISTANT,
  toolCalls: calls,
});
const resultMessages = [
  create(MessageSchema, {
    messageId: 'result-read-1',
    threadId: 'main-1',
    agentId: 'thread',
    role: MessageRole.TOOL,
    toolName: 'read',
    toolStatus: ToolResultStatus.SUCCESS,
    toolCallId: 'read-1',
    content: JSON.stringify({
      path: 'a',
      content: '真实读取结果',
      start_line: 1,
      end_line: 1,
      has_more: false,
    }),
  }),
  create(MessageSchema, {
    messageId: 'result-write-1',
    threadId: 'main-1',
    agentId: 'thread',
    role: MessageRole.TOOL,
    toolName: 'write',
    toolStatus: ToolResultStatus.ERROR,
    toolCallId: 'write-1',
    content: JSON.stringify({ status: 'failed', error: '真实失败' }),
  }),
  create(MessageSchema, {
    messageId: 'result-bash-1',
    threadId: 'main-1',
    agentId: 'thread',
    role: MessageRole.TOOL,
    toolName: 'bash',
    toolStatus: ToolResultStatus.SUCCESS,
    toolCallId: 'bash-1',
    content: JSON.stringify({
      status: 'completed',
      output: '缺口预览',
      output_complete: false,
      truncated: true,
    }),
  }),
  create(MessageSchema, {
    messageId: 'result-recall-1',
    threadId: 'main-1',
    agentId: 'thread',
    role: MessageRole.TOOL,
    toolName: 'recall',
    toolStatus: ToolResultStatus.SUCCESS,
    toolCallId: 'recall-1',
    content: JSON.stringify({ output: '真实召回结果' }),
  }),
];
const outcomes = projectToolOutcomes(resultMessages);

function render(expanded: boolean) {
  return renderToStaticMarkup(
    createElement(ToolOperationGroup, {
      message,
      calls,
      outcomes,
      streaming: true,
      clients,
      choices: expanded ? { 'group:response-1:read-1': true } : {},
      onExpandedChange: () => {},
    }),
  );
}

describe('ordinary tool group rendering', () => {
  it('folds two or more calls by default with first-seen names and counts', () => {
    const html = render(false);

    expect(html).toContain('tool-group-chips');
    expect(html).toContain('<code>read</code><span class="tool-chip-count">×2</span>');
    expect(html).toContain('<code>write</code><span class="tool-chip-count">×1</span>');
    expect(html).toContain('<code>bash</code><span class="tool-chip-count">×1</span>');
    expect(html).toContain('等 4 个工具');
    expect(html).not.toContain('<code>recall</code><span class="tool-chip-count">');
    expect(html).toContain('包含失败调用');
    expect(html).not.toContain('open=""');
    expect(html).toContain('data-operation="group:response-1:read-1"');
  });

  it('expands in original call order with persisted states and real results', () => {
    const html = render(true);
    const ids = ['read-1', 'write-1', 'read-2', 'bash-1', 'recall-1'];
    const positions = ids.map((id) => html.indexOf(`data-tool-call-id="${id}"`));

    expect(html).toContain('open=""');
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(html).toContain('真实读取结果');
    expect(html).toContain('真实失败');
    expect(html).toContain('真实召回结果');
    expect(html).toContain('缺口预览');
    expect(html).toContain('输出不完整');
    expect(html).toContain('执行中');
    expect(html).toContain('结果待核对');
    expect(html).toContain('包含失败调用');

    const rerendered = render(true);
    expect(rerendered).toContain('open=""');
    expect(rerendered.indexOf('data-tool-call-id="read-1"')).toBe(positions[0]);
  });

  it('keeps one ordinary call without Thinking as the original operation line', () => {
    const call = calls[0];
    if (!call) throw new Error('Missing read call.');
    const html = renderToStaticMarkup(
      createElement(ToolOperationGroup, {
        message,
        calls: [call],
        outcomes: new Map(),
        streaming: false,
        clients,
        choices: {},
        onExpandedChange: () => {},
      }),
    );

    expect(html).toContain('data-operation="call:response-1:read-1"');
    expect(html).not.toContain('tool-group');
    expect(html).not.toContain('Thinking');
    expect(html).not.toContain('open=""');
  });

  it('renders a plain text read error as a failed operation', () => {
    const call = calls[0];
    if (!call) throw new Error('Missing read call.');
    const failure = create(MessageSchema, {
      messageId: 'read-error',
      role: MessageRole.TOOL,
      toolName: 'read',
      toolCallId: call.toolCallId,
      content: '文件不存在。',
      toolStatus: ToolResultStatus.ERROR,
      toolError: { code: 'execution_failed', message: '文件不存在。' },
    });
    const html = renderToStaticMarkup(
      createElement(ToolOperationGroup, {
        message,
        calls: [call],
        outcomes: projectToolOutcomes([failure]),
        streaming: false,
        clients,
        choices: {},
        onExpandedChange: () => {},
      }),
    );
    expect(html).toContain('class="tool-operation failed"');
    expect(html).toContain('失败');
    expect(html).toContain('文件不存在。');
    expect(html).not.toContain('>完成<');
  });
});

describe('mixed Thinking and tool capsule rendering', () => {
  const mixedGroupId = 'group:mixed-response:thinking:0';

  function requireBashCall() {
    const call = calls[3];
    if (!call) throw new Error('Missing bash call.');
    return call;
  }

  function mixedMessage() {
    return create(MessageSchema, {
      ...message,
      messageId: 'mixed-response',
      contentBlocks: [
        create(ContentBlockSchema, {
          type: ContentBlockType.THINKING,
          blockIndex: 0,
          text: '第一段完整思考',
        }),
        create(ContentBlockSchema, {
          type: ContentBlockType.THINKING,
          blockIndex: 1,
          text: '第二段流式思考',
        }),
      ],
      toolCalls: [requireBashCall()],
    });
  }

  function renderMixed(
    streaming: boolean,
    thinkingChoices = {},
    groupExpanded: boolean | null = true,
  ) {
    const mixed = mixedMessage();
    const group = projectToolItems(mixed.toolCalls, {
      contentBlocks: mixed.contentBlocks,
      messageId: mixed.messageId,
      streaming,
    })[0];
    if (group?.kind !== 'ordinary') throw new Error('Missing mixed render group.');
    return renderToStaticMarkup(
      createElement(ToolOperationGroup, {
        message: mixed,
        calls: group.calls,
        operations: group.operations,
        outcomes,
        streaming,
        clients,
        choices: {
          ...(groupExpanded === null ? {} : { [mixedGroupId]: groupExpanded }),
          'call:mixed-response:bash-1': true,
        },
        onExpandedChange: () => {},
        thinkingExpansionChoices: thinkingChoices,
        onThinkingExpansionChange: () => {},
      }),
    );
  }

  it('shows Thinking, tool names and descriptions with independent expanded details', () => {
    const thinkingChoices = withThinkingBlockExpanded({}, 'mixed-response', 0, true);
    const html = renderMixed(false, thinkingChoices);

    expect(html).toContain(`data-operation="${mixedGroupId}"`);
    expect(html).toContain('<code>Thinking</code><span class="tool-chip-count">×2</span>');
    expect(html).toContain('<code>bash</code><span class="tool-chip-count">×1</span>');
    expect(html).toContain('bash pwd');
    expect(html).toContain('第一段完整思考');
    expect(html).not.toContain('第二段流式思考');
    expect(html).toContain('{&quot;command&quot;:&quot;pwd&quot;}');
    expect(html).toContain('缺口预览');
    expect(html.indexOf('第一段完整思考')).toBeLessThan(html.indexOf('data-tool-call-id="bash-1"'));
  });

  it('keeps active capsules and every Thinking detail collapsed without explicit choices', () => {
    const streamingHtml = renderMixed(true, {}, null);
    expect(streamingHtml).not.toContain(`data-operation="${mixedGroupId}" open=""`);
    expect(streamingHtml).not.toContain('第二段流式思考');
    expect(streamingHtml).not.toContain('第一段完整思考');
    expect(streamingHtml).toContain('思考中');

    const manuallyExpandedHtml = renderMixed(true, {}, true);
    expect(manuallyExpandedHtml).toContain(`data-operation="${mixedGroupId}" open=""`);
    expect(manuallyExpandedHtml).not.toContain('第二段流式思考');
    expect(manuallyExpandedHtml).not.toContain('第一段完整思考');

    const thinkingChoices = withThinkingBlockExpanded({}, 'mixed-response', 1, true);
    const expandedThinkingHtml = renderMixed(true, thinkingChoices, true);
    expect(expandedThinkingHtml).toContain('第二段流式思考');
    expect(expandedThinkingHtml).not.toContain('第一段完整思考');

    const restoredHtml = renderMixed(false, thinkingChoices, true);
    expect(restoredHtml).toContain(`data-operation="${mixedGroupId}" open=""`);
    expect(restoredHtml).toContain('第二段流式思考');
    expect(restoredHtml).not.toContain('思考中');
  });

  it('renders standalone Thinking as the original expandable line', () => {
    const thinkingMessage = create(MessageSchema, {
      ...message,
      messageId: 'thinking-response',
      contentBlocks: [
        create(ContentBlockSchema, {
          type: ContentBlockType.THINKING,
          blockIndex: 0,
          text: '独立单行思考',
        }),
      ],
      toolCalls: [],
    });
    const group = projectToolItems([], {
      contentBlocks: thinkingMessage.contentBlocks,
      messageId: thinkingMessage.messageId,
      streaming: true,
    })[0];
    if (group?.kind !== 'ordinary') throw new Error('Missing standalone Thinking group.');
    const renderThinking = (thinkingExpanded: boolean) =>
      renderToStaticMarkup(
        createElement(ToolOperationGroup, {
          message: thinkingMessage,
          calls: group.calls,
          operations: group.operations,
          outcomes: new Map(),
          streaming: true,
          clients,
          choices: {},
          onExpandedChange: () => {},
          thinkingExpansionChoices: thinkingExpanded
            ? withThinkingBlockExpanded({}, thinkingMessage.messageId, 0, true)
            : {},
          onThinkingExpansionChange: () => {},
        }),
      );

    const collapsed = renderThinking(false);
    expect(collapsed).toContain('class="thinking-block tool-operation running"');
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).not.toContain('tool-group');
    expect(collapsed).not.toContain('独立单行思考');
    const expanded = renderThinking(true);
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('独立单行思考');
    expect(expanded).not.toContain('tool-group');
  });

  it('folds two Thinking operations into a collapsed capsule', () => {
    const thinkingMessage = create(MessageSchema, {
      ...message,
      messageId: 'two-thinking-response',
      contentBlocks: [
        create(ContentBlockSchema, {
          type: ContentBlockType.THINKING,
          blockIndex: 0,
          text: '第一段',
        }),
        create(ContentBlockSchema, {
          type: ContentBlockType.THINKING,
          blockIndex: 1,
          text: '第二段',
        }),
      ],
      toolCalls: [],
    });
    const group = projectToolItems([], {
      contentBlocks: thinkingMessage.contentBlocks,
      messageId: thinkingMessage.messageId,
      streaming: false,
    })[0];
    if (group?.kind !== 'ordinary') throw new Error('Missing two-Thinking group.');
    const html = renderToStaticMarkup(
      createElement(ToolOperationGroup, {
        message: thinkingMessage,
        calls: group.calls,
        operations: group.operations,
        outcomes: new Map(),
        streaming: false,
        clients,
        choices: {},
        onExpandedChange: () => {},
      }),
    );

    expect(html).toContain('data-operation="group:two-thinking-response:thinking:0"');
    expect(html).toContain('<code>Thinking</code><span class="tool-chip-count">×2</span>');
    expect(html).not.toContain('open=""');
  });

  it('renders text and expanded operations in actual output order', () => {
    const orderedMessage = create(MessageSchema, {
      ...message,
      messageId: 'ordered-response',
      content: '正文之前正文之后',
      contentBlocks: [
        create(ContentBlockSchema, {
          type: ContentBlockType.TEXT,
          blockIndex: 0,
          text: '正文之前',
        }),
        create(ContentBlockSchema, {
          type: ContentBlockType.THINKING,
          blockIndex: 1,
          text: '第一段有序思考',
        }),
        create(ContentBlockSchema, {
          type: ContentBlockType.THINKING,
          blockIndex: 2,
          text: '第二段有序思考',
        }),
        create(ContentBlockSchema, {
          type: ContentBlockType.TEXT,
          blockIndex: 3,
          text: '正文之后',
        }),
      ],
      toolCalls: [
        create(ToolCallSchema, {
          toolCallId: 'read-ordered',
          toolName: 'read',
          argumentsJson: '{}',
          blockIndex: 2,
        }),
        create(ToolCallSchema, {
          toolCallId: 'bash-ordered',
          toolName: 'bash',
          argumentsJson: '{}',
          blockIndex: 3,
        }),
      ],
    });
    let thinkingChoices = withThinkingBlockExpanded({}, orderedMessage.messageId, 1, true);
    thinkingChoices = withThinkingBlockExpanded(thinkingChoices, orderedMessage.messageId, 2, true);
    const html = renderToStaticMarkup(
      createElement(MessageCard, {
        message: orderedMessage,
        delegationCall: null,
        clients,
        busy: false,
        editing: false,
        streaming: false,
        thinkingExpansionChoices: thinkingChoices,
        toolExpansionChoices: { 'group:ordered-response:thinking:1': true },
        toolOutcomes: new Map(),
        onThinkingExpansionChange: () => {},
        onStartEditing: () => {},
        onCancelEditing: () => {},
        onRevise: async () => {},
        onRerun: async () => {},
      }),
    );
    const markers = [
      '正文之前',
      '第一段有序思考',
      'data-tool-call-id="read-ordered"',
      '第二段有序思考',
      'data-tool-call-id="bash-ordered"',
      '正文之后',
    ];
    const positions = markers.map((marker) => html.indexOf(marker));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('keeps one Thinking before response text as a single line', () => {
    const thinkingMessage = create(MessageSchema, {
      ...message,
      messageId: 'single-thinking-response',
      content: '后续正文',
      contentBlocks: [
        create(ContentBlockSchema, {
          type: ContentBlockType.THINKING,
          blockIndex: 0,
          text: '唯一思考',
        }),
        create(ContentBlockSchema, {
          type: ContentBlockType.TEXT,
          blockIndex: 1,
          text: '后续正文',
        }),
      ],
      toolCalls: [],
    });
    const html = renderToStaticMarkup(
      createElement(MessageCard, {
        message: thinkingMessage,
        delegationCall: null,
        clients,
        busy: false,
        editing: false,
        streaming: false,
        thinkingExpansionChoices: withThinkingBlockExpanded({}, thinkingMessage.messageId, 0, true),
        toolOutcomes: new Map(),
        onThinkingExpansionChange: () => {},
        onStartEditing: () => {},
        onCancelEditing: () => {},
        onRevise: async () => {},
        onRerun: async () => {},
      }),
    );

    expect(html).not.toContain('tool-group');
    expect(html.indexOf('唯一思考')).toBeLessThan(html.indexOf('后续正文'));
  });

  it('renders merged Thinking only in the capsule and removes empty continuation cards', () => {
    let thinkingChoices = withThinkingBlockExpanded({}, 'mixed-response', 0, true);
    thinkingChoices = withThinkingBlockExpanded(thinkingChoices, 'mixed-response', 1, true);
    const props = {
      message: mixedMessage(),
      delegationCall: null,
      clients,
      busy: false,
      editing: false,
      streaming: false,
      thinkingExpansionChoices: thinkingChoices,
      toolOutcomes: outcomes,
      toolExpansionChoices: { [mixedGroupId]: true },
      onThinkingExpansionChange: () => {},
      onStartEditing: () => {},
      onCancelEditing: () => {},
      onRevise: async () => {},
      onRerun: async () => {},
    };
    const html = renderToStaticMarkup(createElement(MessageCard, props));

    expect(html.split('第一段完整思考')).toHaveLength(2);
    expect(html.split('第二段流式思考')).toHaveLength(2);
    expect(html).toContain(`data-operation="${mixedGroupId}"`);

    const continuation = renderToStaticMarkup(
      createElement(MessageCard, {
        ...props,
        toolItems: [],
        mergedThinkingBlockIndexes: new Set([0, 1]),
      }),
    );
    expect(continuation).toBe('');
  });
});
