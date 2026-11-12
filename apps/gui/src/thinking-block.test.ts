import {
  type ContentBlock,
  ContentBlockType,
  create,
  type Message,
  MessageRole,
  MessageSchema,
} from '@kairos/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageContent } from './thinking-block.js';
import {
  isThinkingBlockExpanded,
  type ThinkingExpansionChoices,
  withThinkingBlockExpanded,
} from './thinking-expansion.js';

function assistantMessage(
  contentBlocks: readonly Pick<ContentBlock, 'type' | 'blockIndex' | 'text'>[],
  content = '',
): Message {
  return create(MessageSchema, {
    messageId: 'message-1',
    threadId: 'thread-1',
    agentId: 'thread',
    seq: 1n,
    role: MessageRole.ASSISTANT,
    content,
    contentBlocks: [...contentBlocks],
  });
}

function renderMessage(
  message: Message,
  streaming = false,
  thinkingExpansionChoices: ThinkingExpansionChoices = {},
): string {
  return renderToStaticMarkup(
    createElement(MessageContent, {
      message,
      streaming,
      choices: thinkingExpansionChoices,
      onThinkingExpansionChange: () => {},
    }),
  );
}

describe('ThinkingBlock message rendering', () => {
  const blocks = [
    { type: ContentBlockType.TEXT, blockIndex: 3, text: '最终正文' },
    { type: ContentBlockType.THINKING, blockIndex: 2, text: '第二段**思考**' },
    { type: ContentBlockType.TEXT, blockIndex: 1, text: '首段正文' },
    { type: ContentBlockType.THINKING, blockIndex: 0, text: '第一段**思考**' },
  ];

  it('collapses completed and active Thinking details by default', () => {
    const html = renderMessage(assistantMessage(blocks), true);
    expect(html).toContain('首段正文');
    expect(html).toContain('最终正文');
    expect(html).not.toContain('第一段');
    expect(html).not.toContain('第二段');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    const active = renderMessage(
      assistantMessage(blocks.filter((block) => block.blockIndex < 3)),
      true,
    );
    expect(active).not.toContain('第二段');
    expect(active).not.toContain('第一段');
    expect(active).toContain('思考中');
    expect(active.match(/aria-expanded="false"/g)).toHaveLength(2);
  });

  it('collapses historical Thinking blocks by default without discarding text blocks', () => {
    const html = renderMessage(assistantMessage(blocks));

    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(html).not.toContain('第一段');
    expect(html).not.toContain('第二段');
    expect(html.indexOf('首段正文')).toBeLessThan(html.indexOf('最终正文'));
  });

  it('preserves explicit user choices when streaming becomes historical', () => {
    const collapsed = withThinkingBlockExpanded({}, 'message-1', 0, false);
    const expanded = withThinkingBlockExpanded(collapsed, 'message-1', 0, true);

    expect(isThinkingBlockExpanded(collapsed, 'message-1', 0)).toBe(false);
    expect(isThinkingBlockExpanded(expanded, 'message-1', 0)).toBe(true);
    expect(isThinkingBlockExpanded(collapsed, 'message-1', 2)).toBe(false);
    expect(renderMessage(assistantMessage(blocks), true, collapsed)).not.toContain('第一段');
    expect(renderMessage(assistantMessage(blocks), false, expanded)).toContain('第一段');
  });

  it('renders Thinking-only responses and omits empty Thinking placeholders', () => {
    const thinkingOnly = assistantMessage([
      { type: ContentBlockType.THINKING, blockIndex: 0, text: '仅思考内容' },
    ]);
    const emptyThinking = assistantMessage([
      { type: ContentBlockType.THINKING, blockIndex: 0, text: '  ' },
      { type: ContentBlockType.TEXT, blockIndex: 1, text: '只有正文' },
    ]);

    expect(renderMessage(thinkingOnly, true)).not.toContain('仅思考内容');
    const expanded = withThinkingBlockExpanded({}, 'message-1', 0, true);
    expect(renderMessage(thinkingOnly, true, expanded)).toContain('仅思考内容');
    expect(renderMessage(emptyThinking, true)).not.toContain('thinking-block');
    expect(renderMessage(emptyThinking, true)).toContain('只有正文');
    expect(renderMessage(assistantMessage([], '旧消息正文'))).not.toContain('thinking-block');
    expect(renderMessage(assistantMessage([], '旧消息正文'))).toContain('旧消息正文');
  });

  it('uses SafeMarkdown for Thinking content', () => {
    const malicious = assistantMessage([
      {
        type: ContentBlockType.THINKING,
        blockIndex: 0,
        text: '**安全文本** <img src=x onerror=alert(1)> [恶意链接](javascript:alert(1))',
      },
    ]);
    const expanded = withThinkingBlockExpanded({}, 'message-1', 0, true);
    const html = renderMessage(malicious, true, expanded);

    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror=');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<strong>安全文本</strong>');
  });
});
