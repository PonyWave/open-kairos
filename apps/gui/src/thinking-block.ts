import { ContentBlockType, type Message, MessageRole } from '@kairos/contracts';
import { createElement, Fragment, type ReactElement } from 'react';
import { Icon } from './icon.js';
import { SafeMarkdown } from './safe-markdown.js';
import {
  isThinkingBlockExpanded,
  type ThinkingExpansionChoices,
  thinkingBlockKey,
} from './thinking-expansion.js';

interface ThinkingBlockProps {
  text: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  active?: boolean;
}

interface MessageContentProps {
  message: Message;
  streaming: boolean;
  choices: ThinkingExpansionChoices;
  hiddenThinkingBlockIndexes?: ReadonlySet<number> | undefined;
  onThinkingExpansionChange: (messageId: string, blockIndex: number, expanded: boolean) => void;
}

export function ThinkingBlock({
  text,
  expanded,
  onExpandedChange,
  active = false,
}: ThinkingBlockProps): ReactElement | null {
  if (!text.trim()) return null;
  return createElement(
    'section',
    { className: `thinking-block tool-operation${active ? ' running' : ''}` },
    createElement(
      'button',
      {
        type: 'button',
        className: 'thinking-toggle',
        'aria-label': expanded ? '收起思考过程' : '展开思考过程',
        'aria-expanded': expanded,
        onClick: () => onExpandedChange(!expanded),
      },
      createElement(Icon, { name: 'spark', className: 'i-sm' }),
      createElement('span', null, active ? '思考中' : '思考过程'),
      createElement(Icon, {
        name: active ? 'spinner' : 'chevron',
        className: `i-sm${active ? ' spinning' : ''}${expanded && !active ? ' expanded-chevron' : ''}`,
      }),
    ),
    expanded
      ? createElement(
          'div',
          { className: 'thinking-detail tool-operation-detail' },
          createElement(SafeMarkdown, null, text),
        )
      : null,
  );
}

function MessageContentBlocks({
  message,
  streaming,
  choices,
  hiddenThinkingBlockIndexes,
  onThinkingExpansionChange,
}: MessageContentProps): ReactElement {
  const blocks = [...message.contentBlocks]
    .filter(
      (block) =>
        block.text.trim().length > 0 &&
        (block.type !== ContentBlockType.THINKING ||
          !hiddenThinkingBlockIndexes?.has(block.blockIndex)),
    )
    .sort((left, right) => left.blockIndex - right.blockIndex);
  return createElement(
    Fragment,
    null,
    ...blocks.map((block) => {
      const key = thinkingBlockKey(message.messageId, block.blockIndex);
      if (block.type === ContentBlockType.THINKING) {
        const active = streaming && blocks.at(-1)?.blockIndex === block.blockIndex;
        const expanded = isThinkingBlockExpanded(choices, message.messageId, block.blockIndex);
        return createElement(
          Fragment,
          { key },
          createElement(ThinkingBlock, {
            text: block.text,
            expanded,
            active,
            onExpandedChange: (next) =>
              onThinkingExpansionChange(message.messageId, block.blockIndex, next),
          }),
        );
      }
      if (block.type === ContentBlockType.TEXT) {
        return createElement(SafeMarkdown, { key: key }, block.text);
      }
      return null;
    }),
  );
}

export function MessageContent(props: MessageContentProps): ReactElement {
  if (props.message.role === MessageRole.ASSISTANT && props.message.contentBlocks.length > 0) {
    return createElement(MessageContentBlocks, props);
  }
  return createElement(SafeMarkdown, null, props.message.content);
}
