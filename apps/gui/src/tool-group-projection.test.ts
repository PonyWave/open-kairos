import {
  ContentBlockSchema,
  ContentBlockType,
  create,
  MessageRole,
  MessageSchema,
  ToolCallSchema,
  ToolResultStatus,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import {
  projectAssociatedToolResultIds,
  projectToolItems,
  projectToolOutcomes,
  toolGroupState,
  toolOperationState,
  withToolExpanded,
} from './tool-group-projection.js';

function call(id: string, name: string, blockIndex?: number) {
  return create(ToolCallSchema, {
    toolCallId: id,
    toolName: name,
    argumentsJson: `{"id":"${id}"}`,
    ...(blockIndex === undefined ? {} : { blockIndex }),
  });
}

describe('ordinary tool grouping projection', () => {
  it('groups consecutive ordinary calls and splits groups at delegation cards', () => {
    const items = projectToolItems([
      call('read-1', 'read'),
      call('write-1', 'write'),
      call('read-2', 'read'),
      call('thread-1', 'thread_call'),
      call('bash-1', 'bash'),
      call('recall-1', 'recall'),
    ]);

    expect(items.map((item) => item.kind)).toEqual(['ordinary', 'delegation', 'ordinary']);
    expect(items[0]?.kind === 'ordinary' && items[0].calls.map((call) => call.toolCallId)).toEqual([
      'read-1',
      'write-1',
      'read-2',
    ]);
    expect(items[2]?.kind === 'ordinary' && items[2].calls.map((call) => call.toolCallId)).toEqual([
      'bash-1',
      'recall-1',
    ]);
  });

  it('keeps response boundaries and continued delegation boundaries intact', () => {
    const items = projectToolItems([
      call('read-1', 'read'),
      call('thread-1', 'thread_call'),
      call('write-1', 'write'),
    ]);
    expect(items.map((item) => item.kind)).toEqual(['ordinary', 'delegation', 'ordinary']);
    expect(items[0]?.kind === 'ordinary' && items[0].calls).toHaveLength(1);
    expect(items[2]?.kind === 'ordinary' && items[2].calls).toHaveLength(1);
  });

  it('associates only current ordinary tool results and preserves result states', () => {
    const source = create(MessageSchema, {
      messageId: 'source-1',
      threadId: 'main-1',
      agentId: 'thread',
      role: MessageRole.ASSISTANT,
      toolCalls: [call('read-1', 'read'), call('thread-1', 'thread_call')],
    });
    const result = create(MessageSchema, {
      messageId: 'result-1',
      threadId: 'main-1',
      agentId: 'thread',
      role: MessageRole.TOOL,
      toolStatus: ToolResultStatus.SUCCESS,
      toolName: 'read',
      toolCallId: 'read-1',
      content: JSON.stringify({
        path: 'a',
        content: '真实输出',
        start_line: 1,
        end_line: 1,
        has_more: false,
      }),
    });
    const failed = create(MessageSchema, {
      ...result,
      messageId: 'result-2',
      toolCallId: 'bash-1',
      toolName: 'bash',
      toolStatus: ToolResultStatus.ERROR,
      content: JSON.stringify({ status: 'failed', exit_code: 7, output: '失败' }),
    });
    const outcomes = projectToolOutcomes([source, result, failed]);

    expect([...projectAssociatedToolResultIds([source, result], outcomes)]).toEqual(['read-1']);
    expect(outcomes.get('read-1')?.result.output).toContain('真实输出');
    expect(toolOperationState(call('read-1', 'read'), outcomes.get('read-1'), false)).toBe(
      'succeeded',
    );
    expect(toolOperationState(call('bash-1', 'bash'), outcomes.get('bash-1'), false)).toBe(
      'failed',
    );
    expect(toolOperationState(call('unknown-1', 'read'), undefined, false)).toBe('unknown');
    expect(toolOperationState(call('running-1', 'read'), undefined, true)).toBe('running');
    expect(toolGroupState([call('read-1', 'read'), call('bash-1', 'bash')], outcomes, false)).toBe(
      'failed',
    );
  });

  it('retains independent expansion records when another group changes', () => {
    const expanded = withToolExpanded({}, 'group:a', true);
    const updated = withToolExpanded(expanded, 'group:b', true);
    const closed = withToolExpanded(updated, 'group:b', false);

    expect(closed['group:a']).toBe(true);
    expect(closed['group:b']).toBe(false);
    expect(withToolExpanded(closed, 'group:a', true)['group:a']).toBe(true);
  });

  it('uses persisted tool failure and cancellation when the result body is plain text', () => {
    const messages = [
      create(MessageSchema, {
        messageId: 'failed-read',
        role: MessageRole.TOOL,
        toolName: 'read',
        toolCallId: 'read-failed',
        content: '文件不存在。',
        toolStatus: ToolResultStatus.ERROR,
        toolError: { code: 'execution_failed', message: '文件不存在。' },
      }),
      create(MessageSchema, {
        messageId: 'cancelled-edit',
        role: MessageRole.TOOL,
        toolName: 'edit',
        toolCallId: 'edit-cancelled',
        content: 'Tool execution was cancelled.',
        toolStatus: ToolResultStatus.ERROR,
        toolError: { code: 'cancelled', message: 'Tool execution was cancelled.' },
      }),
      create(MessageSchema, {
        messageId: 'unverified-result',
        role: MessageRole.TOOL,
        toolName: 'read',
        toolCallId: 'read-unverified',
        content: '历史结果没有明确状态。',
      }),
    ];
    const outcomes = projectToolOutcomes(messages);
    expect(
      toolOperationState(call('read-failed', 'read'), outcomes.get('read-failed'), false),
    ).toBe('failed');
    expect(
      toolOperationState(call('edit-cancelled', 'edit'), outcomes.get('edit-cancelled'), false),
    ).toBe('cancelled');
    expect(
      toolOperationState(call('read-unverified', 'read'), outcomes.get('read-unverified'), false),
    ).toBe('unknown');
    expect(
      toolGroupState(
        [call('read-unverified', 'read'), call('read-failed', 'read')],
        outcomes,
        false,
      ),
    ).toBe('failed');
  });
});

describe('mixed Thinking and ordinary tool projection', () => {
  const contentBlocks = [
    create(ContentBlockSchema, {
      type: ContentBlockType.THINKING,
      blockIndex: 0,
      text: '第一段思考',
    }),
    create(ContentBlockSchema, { type: ContentBlockType.TEXT, blockIndex: 1, text: '正文' }),
    create(ContentBlockSchema, {
      type: ContentBlockType.THINKING,
      blockIndex: 2,
      text: '第二段思考',
    }),
  ];

  it('keeps content block and call order inside a single mixed group', () => {
    const items = projectToolItems([call('read-1', 'read'), call('bash-1', 'bash')], {
      contentBlocks,
      messageId: 'message-1',
      streaming: true,
    });
    const group = items[0];
    if (group?.kind !== 'ordinary') throw new Error('Missing mixed ordinary group.');

    expect(items).toHaveLength(1);
    expect(
      group.operations.map((operation) =>
        operation.kind === 'thinking'
          ? `thinking:${operation.blockIndex}`
          : `call:${operation.call.toolCallId}`,
      ),
    ).toEqual(['thinking:0', 'thinking:2', 'call:read-1', 'call:bash-1']);
    expect(
      group.operations.map((operation) =>
        operation.kind === 'thinking' ? operation.active : false,
      ),
    ).toEqual([false, true, false, false]);
  });

  it('interleaves Thinking and calls by their content block cursors', () => {
    const orderedBlocks = [
      create(ContentBlockSchema, { type: ContentBlockType.TEXT, blockIndex: 0, text: '前文' }),
      create(ContentBlockSchema, {
        type: ContentBlockType.THINKING,
        blockIndex: 1,
        text: '思考一',
      }),
      create(ContentBlockSchema, {
        type: ContentBlockType.THINKING,
        blockIndex: 2,
        text: '思考二',
      }),
      create(ContentBlockSchema, { type: ContentBlockType.TEXT, blockIndex: 3, text: '后文' }),
    ];
    const items = projectToolItems([call('read-1', 'read', 2), call('bash-1', 'bash', 3)], {
      contentBlocks: orderedBlocks,
      messageId: 'ordered-message',
    });
    const group = items[0];
    if (group?.kind !== 'ordinary') throw new Error('Missing ordered mixed group.');

    expect(items).toHaveLength(1);
    expect(group.blockIndex).toBe(3);
    expect(
      group.operations.map((operation) =>
        operation.kind === 'thinking'
          ? `thinking:${operation.blockIndex}`
          : `call:${operation.call.toolCallId}`,
      ),
    ).toEqual(['thinking:1', 'call:read-1', 'thinking:2', 'call:bash-1']);
  });

  it('splits execution groups at response text and keeps send_to_user ordinary', () => {
    const blocks = [
      create(ContentBlockSchema, { type: ContentBlockType.TEXT, blockIndex: 0, text: '前文' }),
      create(ContentBlockSchema, {
        type: ContentBlockType.THINKING,
        blockIndex: 1,
        text: '思考一',
      }),
      create(ContentBlockSchema, { type: ContentBlockType.TEXT, blockIndex: 2, text: '中间正文' }),
      create(ContentBlockSchema, {
        type: ContentBlockType.THINKING,
        blockIndex: 3,
        text: '思考二',
      }),
      create(ContentBlockSchema, { type: ContentBlockType.TEXT, blockIndex: 4, text: '后文' }),
    ];
    const items = projectToolItems([call('read-1', 'read', 2), call('send-1', 'send_to_user', 4)], {
      contentBlocks: blocks,
      messageId: 'segmented-message',
    });

    expect(items.map((item) => item.kind)).toEqual(['ordinary', 'ordinary']);
    expect(items.map((item) => item.blockIndex)).toEqual([2, 4]);
    expect(
      items.map((item) =>
        item.kind === 'ordinary' ? item.operations.map((operation) => operation.id) : [],
      ),
    ).toEqual([
      ['thinking:1', 'read-1'],
      ['thinking:3', 'send-1'],
    ]);
  });

  it('uses conservative legacy ordering when any call lacks a cursor', () => {
    const items = projectToolItems([call('read-1', 'read', 1), call('bash-1', 'bash')], {
      contentBlocks,
      messageId: 'legacy-message',
    });
    const group = items[0];
    if (group?.kind !== 'ordinary') throw new Error('Missing legacy mixed group.');

    expect(group.blockIndex).toBeUndefined();
    expect(group.operations.map((operation) => operation.id)).toEqual([
      'thinking:0',
      'thinking:2',
      'read-1',
      'bash-1',
    ]);
  });

  it('keeps delegation, Subagent and thread_notify as separate boundaries', () => {
    const items = projectToolItems(
      [
        call('read-1', 'read'),
        call('subagent-1', 'subagent'),
        call('write-1', 'write'),
        call('thread-1', 'thread_call'),
        call('bash-1', 'bash'),
        call('notify-1', 'thread_notify'),
        call('recall-1', 'recall'),
      ],
      { contentBlocks, messageId: 'message-1' },
    );

    expect(items.map((item) => item.kind)).toEqual([
      'ordinary',
      'subagent',
      'ordinary',
      'delegation',
      'ordinary',
      'notification',
      'ordinary',
    ]);
    const first = items[0];
    if (first?.kind !== 'ordinary') throw new Error('Missing first ordinary group.');
    expect(first.operations.filter((operation) => operation.kind === 'thinking')).toHaveLength(2);
    for (const item of items.slice(1)) {
      if (item.kind === 'ordinary') {
        expect(item.operations.every((operation) => operation.kind === 'call')).toBe(true);
      }
    }
  });

  it('projects Thinking without tools as a capsule with a stable Thinking-first identity', () => {
    const thinkingOnly = projectToolItems([], {
      contentBlocks: contentBlocks.filter((block) => block.type === ContentBlockType.THINKING),
      messageId: 'message-1',
      streaming: true,
    });
    const group = thinkingOnly[0];
    if (group?.kind !== 'ordinary') throw new Error('Missing Thinking-only group.');
    expect(thinkingOnly).toHaveLength(1);
    expect(group.id).toBe('thinking:0');
    expect(group.calls).toEqual([]);
    expect(group.operations.map((operation) => operation.kind)).toEqual(['thinking', 'thinking']);
    expect(group.operations.map((operation) => operation.messageId)).toEqual([
      'message-1',
      'message-1',
    ]);

    const withLaterTool = projectToolItems([call('read-1', 'read')], {
      contentBlocks: contentBlocks.filter((block) => block.type === ContentBlockType.THINKING),
      messageId: 'message-1',
      streaming: true,
    })[0];
    if (withLaterTool?.kind !== 'ordinary') throw new Error('Missing mixed group.');
    expect(withLaterTool.id).toBe(group.id);
    expect(withLaterTool.operations.map((operation) => operation.kind)).toEqual([
      'thinking',
      'thinking',
      'call',
    ]);

    expect(projectToolItems([], { messageId: 'empty-message' })).toEqual([]);
  });
});
