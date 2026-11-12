import type {
  DetailedModelUsage,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  UserContentBlock,
} from '@kairos/agent-core';
import { z } from 'zod';
import { assistantMessage, ContentBlocks, type ToolCallParts } from './assistant-message.js';
import { BaseProvider, isAbortError, type ProviderConfig } from './base.js';
import { ProviderError } from './errors.js';
import { readSseData } from './sse.js';

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().safe().nullish(),
  output_tokens: z.number().int().nonnegative().safe().nullish(),
  cache_read_input_tokens: z.number().int().nonnegative().safe().nullish(),
  cache_creation_input_tokens: z.number().int().nonnegative().safe().nullish(),
});
const blockSchema = z.object({
  type: z.string(),
  text: z.unknown().optional(),
  thinking: z.unknown().optional(),
  data: z.unknown().optional(),
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  input: z.unknown().optional(),
});
const eventSchema = z.object({
  type: z.string(),
  index: z.number().int().nonnegative().safe().optional(),
  content_block: blockSchema.optional(),
  delta: z
    .object({
      type: z.string().optional(),
      text: z.unknown().optional(),
      thinking: z.unknown().optional(),
      partial_json: z.unknown().optional(),
      signature: z.unknown().optional(),
      stop_reason: z.string().nullish(),
    })
    .optional(),
  message: z.object({ usage: usageSchema.optional() }).optional(),
  usage: usageSchema.optional(),
  error: z.object({ message: z.unknown().optional() }).optional(),
});

type AnthropicEvent = z.infer<typeof eventSchema>;
type AnthropicBlock = z.infer<typeof blockSchema>;
type AnthropicUsage = z.infer<typeof usageSchema>;

interface PendingAnthropicCall extends ToolCallParts {
  index: number;
  initialInput: unknown;
  hasInitialInput: boolean;
  sawArgumentDelta: boolean;
}

class AnthropicStreamState {
  readonly blocks = new ContentBlocks();
  readonly calls = new Map<number, PendingAnthropicCall>();
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  stopReason?: string;
  done = false;

  mergeUsage(usage: AnthropicUsage | undefined): void {
    if (!usage) return;
    if (typeof usage.input_tokens === 'number') this.inputTokens = usage.input_tokens;
    if (typeof usage.output_tokens === 'number') this.outputTokens = usage.output_tokens;
    if (typeof usage.cache_read_input_tokens === 'number') {
      this.cachedTokens = usage.cache_read_input_tokens;
    }
    if (typeof usage.cache_creation_input_tokens === 'number') {
      this.cacheCreationTokens = usage.cache_creation_input_tokens;
    }
  }

  usage(): DetailedModelUsage | undefined {
    if (this.inputTokens === undefined || this.outputTokens === undefined) return undefined;
    const input = this.inputTokens + (this.cachedTokens ?? 0) + (this.cacheCreationTokens ?? 0);
    return {
      input_tokens: input,
      output_tokens: this.outputTokens,
      total_tokens: input + this.outputTokens,
      ...(this.cachedTokens === undefined
        ? {}
        : { prompt_tokens_details: { cached_tokens: this.cachedTokens } }),
    };
  }

  startTool(index: number, block: AnthropicBlock): void {
    this.calls.set(index, {
      index,
      id: typeof block.id === 'string' ? block.id : '',
      name: typeof block.name === 'string' ? block.name : '',
      argumentsText: '',
      label: String(index),
      blockIndex: this.blocks.startCall(),
      initialInput: block.input,
      hasInitialInput: block.input !== undefined,
      sawArgumentDelta: false,
    });
  }

  appendArguments(index: number, partial: string): void {
    const call = this.calls.get(index);
    if (!call) throw new Error('The tool input delta refers to an unknown content block.');
    call.sawArgumentDelta = true;
    call.argumentsText += partial;
  }

  finishCalls(): void {
    for (const call of this.calls.values()) {
      if (!call.sawArgumentDelta && call.hasInitialInput) {
        call.argumentsText = JSON.stringify(call.initialInput);
      }
    }
  }

  message() {
    this.finishCalls();
    return assistantMessage(
      this.blocks,
      [...this.calls.values()].sort((left, right) => left.index - right.index),
    );
  }

  interruption(message: string, usage = this.usage()): ModelEvent {
    return {
      type: 'stream_interrupted',
      error: { code: 'stream_interrupted', message },
      ...(usage === undefined ? {} : { usage }),
    };
  }
}

export type AnthropicMessagesProviderConfig = ProviderConfig;

export class AnthropicMessagesProvider extends BaseProvider {
  constructor(config: AnthropicMessagesProviderConfig, fetchImplementation: typeof fetch = fetch) {
    super(config, fetchImplementation, 'Anthropic Messages');
  }

  mapMessageIndex(request: ModelRequest, messageIndex: number): number {
    return this.nativeSource(request, messageIndex).messageIndex;
  }

  mapMessageSource(request: ModelRequest, messageIndex: number) {
    return this.nativeSource(request, messageIndex);
  }

  private nativeSource(request: ModelRequest, messageIndex: number) {
    const mapped = serializeAnthropicMessages(request.messages).indexMap[messageIndex];
    if (!mapped) {
      throw new ProviderError(
        'invalid_request',
        'The source message has no content in the Anthropic request.',
      );
    }
    return mapped;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    signal.throwIfAborted();
    this.assertVisionSupport(request);
    const serialized = serializeAnthropicMessages(request.messages);
    const response = await this.request(
      '/v1/messages',
      {
        model: this.model,
        max_tokens: this.outputReserve,
        ...(serialized.system === undefined ? {} : { system: serialized.system }),
        messages: serialized.messages,
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
        stream: true,
      },
      {
        'anthropic-version': '2023-06-01',
        ...(this.apiKey === undefined ? {} : { 'x-api-key': this.apiKey }),
      },
      signal,
    );
    if (!response.body)
      throw new ProviderError('invalid_response', 'The provider response has no body.');

    const state = new AnthropicStreamState();
    try {
      for await (const data of readSseData(response.body, signal)) {
        const terminal = yield* this.consume(data, state);
        if (terminal) return;
      }
      if (!state.done) yield state.interruption('The provider stream ended before message_stop.');
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      yield state.interruption(`The provider stream was interrupted: ${this.safeMessage(error)}`);
    }
  }

  private *consume(data: string, state: AnthropicStreamState): Generator<ModelEvent, boolean> {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      yield state.interruption('The provider returned invalid JSON.');
      return true;
    }
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success) {
      yield state.interruption('The provider returned an invalid stream event.');
      return true;
    }
    const event = parsed.data;
    try {
      switch (event.type) {
        case 'message_start':
          state.mergeUsage(event.message?.usage);
          return false;
        case 'message_delta':
          state.mergeUsage(event.usage);
          if (event.delta?.stop_reason !== undefined && event.delta.stop_reason !== null) {
            state.stopReason = event.delta.stop_reason;
          }
          return false;
        case 'content_block_start':
          return yield* this.startBlock(state, requireIndex(event), requireBlock(event));
        case 'content_block_delta':
          return yield* this.deltaBlock(state, requireIndex(event), event.delta);
        case 'message_stop': {
          state.done = true;
          const usage = state.usage();
          if (!usage) {
            yield state.interruption('The provider stream did not include complete token usage.');
            return true;
          }
          if (!state.stopReason) {
            yield state.interruption('The provider stream did not include a stop reason.', usage);
            return true;
          }
          if (['max_tokens', 'refusal', 'pause_turn'].includes(state.stopReason)) {
            yield state.interruption(
              `The provider stopped with reason ${state.stopReason}.`,
              usage,
            );
            return true;
          }
          if (!['end_turn', 'stop_sequence', 'tool_use'].includes(state.stopReason)) {
            yield state.interruption(
              `The provider stopped with unknown reason ${state.stopReason}.`,
              usage,
            );
            return true;
          }
          yield { type: 'response', message: state.message(), usage };
          return true;
        }
        case 'error':
          state.done = true;
          yield state.interruption(
            this.safeMessage(
              `The provider returned an error: ${requireString(event.error?.message, 'error.message')}`,
            ),
          );
          return true;
        default:
          return false;
      }
    } catch (error) {
      state.done = true;
      yield state.interruption(
        `The provider returned an invalid stream event: ${this.safeMessage(error)}`,
      );
      return true;
    }
  }

  private *startBlock(
    state: AnthropicStreamState,
    index: number,
    block: AnthropicBlock,
  ): Generator<ModelEvent, boolean> {
    if (block.type === 'tool_use') {
      if (block.id !== undefined && typeof block.id !== 'string') {
        throw new Error('tool_use.id must be a string.');
      }
      if (block.name !== undefined && typeof block.name !== 'string') {
        throw new Error('tool_use.name must be a string.');
      }
      state.startTool(index, block);
    } else if (block.type === 'text') {
      const text =
        block.text === undefined ? '' : requireString(block.text, 'content_block_start.text');
      if (text.length > 0) {
        const blockIndex = state.blocks.add('text', text);
        yield { type: 'text_delta', text, block_index: blockIndex };
      }
    } else if (block.type === 'thinking') {
      const thinking =
        block.thinking === undefined
          ? ''
          : requireString(block.thinking, 'content_block_start.thinking');
      if (thinking.length > 0) {
        const blockIndex = state.blocks.add('thinking', thinking);
        yield { type: 'thinking_delta', text: thinking, block_index: blockIndex };
      }
    }
    return false;
  }

  private *deltaBlock(
    state: AnthropicStreamState,
    index: number,
    delta: AnthropicEvent['delta'],
  ): Generator<ModelEvent, boolean> {
    if (!delta) throw new Error('content_block_delta.delta is missing.');
    if (delta.type === 'text_delta') {
      const text = requireString(delta.text, 'text_delta.text');
      if (text.length > 0) {
        const blockIndex = state.blocks.add('text', text);
        yield { type: 'text_delta', text, block_index: blockIndex };
      }
    } else if (delta.type === 'thinking_delta') {
      const thinking = requireString(delta.thinking, 'thinking_delta.thinking');
      if (thinking.length > 0) {
        const blockIndex = state.blocks.add('thinking', thinking);
        yield { type: 'thinking_delta', text: thinking, block_index: blockIndex };
      }
    } else if (delta.type === 'input_json_delta') {
      state.appendArguments(
        index,
        requireString(delta.partial_json, 'input_json_delta.partial_json'),
      );
    }
    return false;
  }
}

function requireIndex(event: AnthropicEvent): number {
  if (event.index === undefined) throw new Error(`${event.type}.index is missing.`);
  return event.index;
}

function requireBlock(event: AnthropicEvent): AnthropicBlock {
  if (!event.content_block) throw new Error(`${event.type}.content_block is missing.`);
  return event.content_block;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  return value;
}

const incompleteArgumentsField = '_kairos_incomplete_arguments';

interface AnthropicSourceIndex {
  messageIndex: number;
  contentBlockIndexes: number[];
}

function serializeAnthropicMessages(messages: readonly ModelMessage[]): {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: Record<string, unknown>[] }>;
  indexMap: Array<AnthropicSourceIndex | undefined>;
} {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .filter((content) => content.length > 0)
    .join('\n\n');
  const output: Array<{ role: 'user' | 'assistant'; content: Record<string, unknown>[] }> = [];
  const indexMap: Array<AnthropicSourceIndex | undefined> = [];
  const append = (
    role: 'user' | 'assistant',
    content: Record<string, unknown>[],
    sourceIndex: number,
  ) => {
    if (content.length === 0) return;
    const previous = output.at(-1);
    const messageIndex = previous?.role === role ? output.length - 1 : output.length;
    const firstContentIndex = previous?.role === role ? previous.content.length : 0;
    if (previous?.role === role) previous.content.push(...content);
    else output.push({ role, content });
    indexMap[sourceIndex] = {
      messageIndex,
      contentBlockIndexes: content.map((_, index) => firstContentIndex + index),
    };
  };
  for (const [sourceIndex, message] of messages.entries()) {
    switch (message.role) {
      case 'system':
        break;
      case 'user':
        append('user', anthropicContent(message.content, message.content_parts), sourceIndex);
        break;
      case 'assistant': {
        const content: Record<string, unknown>[] = [
          ...(message.content.length > 0 ? [{ type: 'text', text: message.content }] : []),
          ...(message.tool_calls ?? []).map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.arguments,
          })),
          ...(message.incomplete_tool_calls ?? []).map((call) => {
            if (!call.id) {
              throw new ProviderError(
                'invalid_request',
                'Incomplete tool calls must have persisted IDs before dispatch.',
              );
            }
            return {
              type: 'tool_use',
              id: call.id,
              name: call.name ?? 'unknown',
              input: { [incompleteArgumentsField]: call.arguments_text },
            };
          }),
        ];
        append('assistant', content, sourceIndex);
        break;
      }
      case 'tool': {
        const content: Record<string, unknown> = {
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: anthropicContent(message.content, message.content_parts),
          ...(message.status === 'error' ? { is_error: true } : {}),
        };
        append('user', [content], sourceIndex);
        break;
      }
    }
  }
  return system.length > 0
    ? { system, messages: output, indexMap }
    : { messages: output, indexMap };
}

function anthropicContent(
  content: string,
  parts: readonly UserContentBlock[] | undefined,
): Record<string, unknown>[] {
  return [
    ...(content.length > 0 ? [{ type: 'text', text: content }] : []),
    ...(parts ?? []).map((part) => {
      if (part.type === 'attachment') {
        throw new ProviderError(
          'invalid_request',
          'Attachment references must be materialized before dispatch.',
        );
      }
      return part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'image', source: anthropicImageSource(part.image_url.url) };
    }),
  ];
}

function anthropicImageSource(url: string): Record<string, unknown> {
  if (url.startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg));base64,(.+)$/s.exec(url);
    if (!match?.[1] || !match[2]) {
      throw new ProviderError('invalid_request', 'The image data URL is invalid or unsupported.');
    }
    return { type: 'base64', media_type: match[1], data: match[2] };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderError('invalid_request', 'The image URL is invalid.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ProviderError(
      'invalid_request',
      'The image URL must use HTTP(S) or a supported data URL.',
    );
  }
  return { type: 'url', url };
}
