import type {
  AssistantMessage,
  ContentBlock,
  IncompleteToolCall,
  ToolCall,
} from '@kairos/agent-core';

export interface ToolCallParts {
  id: string;
  name: string;
  argumentsText: string;
  label: string;
  blockIndex: number;
}

export class ContentBlocks {
  readonly #blocks: ContentBlock[] = [];
  #startNewBlock = false;

  add(type: ContentBlock['type'], text: string): number {
    const previous = this.#blocks.at(-1);
    if (!this.#startNewBlock && previous?.type === type) {
      previous.text += text;
      return previous.block_index;
    }
    this.#startNewBlock = false;
    const block: ContentBlock = { type, block_index: this.#blocks.length, text };
    this.#blocks.push(block);
    return block.block_index;
  }

  startCall(): number {
    this.#startNewBlock = true;
    return this.#blocks.length;
  }

  values(): ContentBlock[] {
    return this.#blocks.map((block) => ({ ...block }));
  }
}

export function assistantMessage(
  blocks: ContentBlocks,
  pendingCalls: readonly ToolCallParts[],
): AssistantMessage {
  const contentBlocks = blocks.values();
  const complete: ToolCall[] = [];
  const incomplete: IncompleteToolCall[] = [];
  for (const call of pendingCalls) {
    const base = {
      ...(call.id.length > 0 ? { id: call.id } : {}),
      ...(call.name.length > 0 ? { name: call.name } : {}),
    };
    if (call.id.length === 0 || call.name.length === 0) {
      incomplete.push({
        ...base,
        arguments_text: call.argumentsText,
        error: `Tool call ${call.label} is missing a required id or function name.`,
      });
      continue;
    }
    try {
      const argumentsValue: unknown = JSON.parse(call.argumentsText);
      if (!isRecord(argumentsValue)) throw new Error('Arguments must be a JSON object.');
      complete.push({
        id: call.id,
        name: call.name,
        arguments: argumentsValue,
        block_index: call.blockIndex,
      });
    } catch (error) {
      incomplete.push({
        ...base,
        arguments_text: call.argumentsText,
        error: `Tool call arguments are incomplete or invalid: ${errorMessage(error)}`,
      });
    }
  }
  return {
    role: 'assistant',
    content: contentBlocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(''),
    ...(contentBlocks.length > 0 ? { content_blocks: contentBlocks } : {}),
    ...(complete.length > 0 ? { tool_calls: complete } : {}),
    ...(incomplete.length > 0 ? { incomplete_tool_calls: incomplete } : {}),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
