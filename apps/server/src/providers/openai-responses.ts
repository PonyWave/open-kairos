import type {
  DetailedModelUsage,
  ModelEvent,
  ModelMessage,
  ModelRequest,
} from '@kairos/agent-core';
import { z } from 'zod';
import { assistantMessage, ContentBlocks, type ToolCallParts } from './assistant-message.js';
import { BaseProvider, isAbortError, type ProviderConfig } from './base.js';
import { ProviderError } from './errors.js';
import { readSseData } from './sse.js';

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().safe(),
  output_tokens: z.number().int().nonnegative().safe(),
  total_tokens: z.number().int().nonnegative().safe().optional(),
  input_tokens_details: z
    .object({ cached_tokens: z.number().int().nonnegative().safe().optional() })
    .nullish(),
});
const itemSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  call_id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.string().nullish(),
});
const responseSchema = z.object({
  status: z.string().optional(),
  usage: usageSchema.nullish(),
  incomplete_details: z.object({ reason: z.string().optional() }).nullish(),
  error: z.object({ message: z.string().optional(), code: z.string().nullish() }).nullish(),
});
const eventSchema = z.object({
  type: z.string(),
  item_id: z.string().optional(),
  output_index: z.number().int().nonnegative().safe().optional(),
  delta: z.unknown().optional(),
  arguments: z.unknown().optional(),
  item: itemSchema.optional(),
  response: responseSchema.optional(),
  message: z.unknown().optional(),
  code: z.string().nullish(),
});

type ResponsesEvent = z.infer<typeof eventSchema>;
type ResponsesItem = z.infer<typeof itemSchema>;

interface PendingCall extends ToolCallParts {
  itemId: string;
  outputIndex: number;
}

class ResponsesStreamState {
  readonly blocks = new ContentBlocks();
  readonly calls = new Map<number, PendingCall>();
  usage?: DetailedModelUsage;
  done = false;

  interruption(message: string, usage = this.usage): ModelEvent {
    return {
      type: 'stream_interrupted',
      error: { code: 'stream_interrupted', message },
      ...(usage === undefined ? {} : { usage }),
    };
  }

  message() {
    return assistantMessage(
      this.blocks,
      [...this.calls.values()].sort((left, right) => left.outputIndex - right.outputIndex),
    );
  }

  callAt(itemId: string | undefined, outputIndex: number): PendingCall | undefined {
    const indexed = this.calls.get(outputIndex);
    if (itemId === undefined) return indexed;
    const byItemId = [...this.calls.values()].find((call) => call.itemId === itemId);
    if (indexed && indexed.itemId !== itemId) {
      throw new Error('The function call item ID does not match its output index.');
    }
    if (byItemId && byItemId.outputIndex !== outputIndex) {
      throw new Error('The function call output index does not match its item ID.');
    }
    return indexed ?? byItemId;
  }

  addItem(item: ResponsesItem, outputIndex: number, final: boolean): void {
    if (item.type !== 'function_call') return;
    const existing = this.calls.get(outputIndex);
    if (existing && item.id !== undefined && existing.itemId !== item.id) {
      throw new Error('The function call item ID changed within one output index.');
    }
    const pending: PendingCall = existing ?? {
      itemId: item.id ?? '',
      outputIndex,
      id: '',
      name: '',
      argumentsText: '',
      label: String(outputIndex),
      blockIndex: this.blocks.startCall(),
    };
    if (item.id !== undefined) pending.itemId = item.id;
    if (item.call_id !== undefined) pending.id = item.call_id;
    if (item.name !== undefined) pending.name = item.name;
    if (final) this.setFinalArguments(pending, item.arguments);
    else if (item.arguments !== undefined && item.arguments !== null) {
      pending.argumentsText = item.arguments;
    }
    this.calls.set(outputIndex, pending);
  }

  appendArguments(call: PendingCall, delta: string): void {
    call.argumentsText += delta;
  }

  setFinalArguments(call: PendingCall, finalArguments: string | null | undefined): void {
    if (finalArguments === undefined || finalArguments === null) return;
    if (!finalArguments.startsWith(call.argumentsText)) {
      throw new Error('Final function call arguments do not match the streamed deltas.');
    }
    call.argumentsText = finalArguments;
  }
}

export type OpenAIResponsesProviderConfig = ProviderConfig;

export class OpenAIResponsesProvider extends BaseProvider {
  constructor(config: OpenAIResponsesProviderConfig, fetchImplementation: typeof fetch = fetch) {
    super(config, fetchImplementation, 'OpenAI Responses');
  }

  mapMessageIndex(request: ModelRequest, messageIndex: number): number {
    const indexes = this.messageItems(request, messageIndex);
    const first = indexes[0];
    if (first === undefined) {
      throw new ProviderError(
        'invalid_request',
        'The source message has no items in the Responses request.',
      );
    }
    return first;
  }

  mapMessageSource(request: ModelRequest, messageIndex: number) {
    return { inputItemIndexes: this.messageItems(request, messageIndex) };
  }

  private messageItems(request: ModelRequest, messageIndex: number): readonly number[] {
    const indexes = serializeResponsesMessages(request.messages).indexMap[messageIndex];
    if (!indexes || indexes.length === 0) {
      throw new ProviderError(
        'invalid_request',
        'The source message has no items in the Responses request.',
      );
    }
    return indexes;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    signal.throwIfAborted();
    this.assertVisionSupport(request);
    const serialized = serializeResponsesMessages(request.messages);
    const response = await this.request(
      '/responses',
      {
        model: this.model,
        ...(serialized.instructions === undefined ? {} : { instructions: serialized.instructions }),
        input: serialized.input,
        tools: request.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        })),
        max_output_tokens: this.outputReserve,
        store: false,
        stream: true,
      },
      this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` },
      signal,
    );
    if (!response.body)
      throw new ProviderError('invalid_response', 'The provider response has no body.');

    const state = new ResponsesStreamState();
    try {
      for await (const data of readSseData(response.body, signal)) {
        const terminal = yield* this.consume(data, state);
        if (terminal) return;
      }
      if (!state.done) {
        yield state.interruption('The provider stream ended before a terminal response event.');
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      yield state.interruption(`The provider stream was interrupted: ${this.safeMessage(error)}`);
    }
  }

  private *consume(data: string, state: ResponsesStreamState): Generator<ModelEvent, boolean> {
    if (data === '[DONE]') {
      yield state.interruption('The provider stream ended before a terminal response event.');
      return true;
    }
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
        case 'response.output_text.delta':
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          const delta = requireString(event.delta, `${event.type}.delta`);
          if (delta.length > 0) {
            const thinking = event.type !== 'response.output_text.delta';
            const blockIndex = state.blocks.add(thinking ? 'thinking' : 'text', delta);
            yield {
              type: thinking ? 'thinking_delta' : 'text_delta',
              text: delta,
              block_index: blockIndex,
            };
          }
          return false;
        }
        case 'response.output_item.added':
          state.addItem(requireItem(event), requireOutputIndex(event), false);
          return false;
        case 'response.output_item.done':
          state.addItem(requireItem(event), requireOutputIndex(event), true);
          return false;
        case 'response.function_call_arguments.delta': {
          const call = requireCall(state, event);
          state.appendArguments(call, requireString(event.delta, `${event.type}.delta`));
          return false;
        }
        case 'response.function_call_arguments.done': {
          const call = requireCall(state, event);
          state.setFinalArguments(call, requireString(event.arguments, `${event.type}.arguments`));
          return false;
        }
        case 'response.completed': {
          state.done = true;
          const usage = responseUsage(event);
          if (!usage) {
            yield state.interruption('The provider stream did not include token usage.');
          } else {
            state.usage = usage;
            yield { type: 'response', message: state.message(), usage };
          }
          return true;
        }
        case 'response.incomplete': {
          state.done = true;
          const usage = responseUsage(event);
          if (usage) state.usage = usage;
          const reason = event.response?.incomplete_details?.reason ?? 'incomplete';
          yield state.interruption(
            `The provider stopped with response status incomplete: ${reason}.`,
            usage,
          );
          return true;
        }
        case 'response.failed': {
          state.done = true;
          const usage = responseUsage(event);
          if (usage) state.usage = usage;
          yield state.interruption(
            this.safeMessage(
              `The provider returned a failed response: ${event.response?.error?.message ?? 'unknown error'}`,
            ),
            usage,
          );
          return true;
        }
        case 'error':
          state.done = true;
          yield state.interruption(
            this.safeMessage(
              `The provider returned an error: ${requireString(event.message, 'error.message')}`,
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
}

function requireItem(event: ResponsesEvent) {
  if (!event.item) throw new Error(`${event.type}.item is missing.`);
  return event.item;
}

function requireOutputIndex(event: ResponsesEvent): number {
  if (event.output_index === undefined) throw new Error(`${event.type}.output_index is missing.`);
  return event.output_index;
}

function requireCall(state: ResponsesStreamState, event: ResponsesEvent): PendingCall {
  const outputIndex = requireOutputIndex(event);
  const call = state.callAt(event.item_id, outputIndex);
  if (!call) throw new Error(`${event.type} refers to an unknown function call item.`);
  return call;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  return value;
}

function responseUsage(event: ResponsesEvent): DetailedModelUsage | undefined {
  const usage = event.response?.usage;
  if (!usage) return undefined;
  const cached = usage.input_tokens_details?.cached_tokens;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
    ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
  };
}

function serializeResponsesMessages(messages: readonly ModelMessage[]): {
  instructions?: string;
  input: Record<string, unknown>[];
  indexMap: number[][];
} {
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .filter((content) => content.length > 0)
    .join('\n\n');
  const input: Record<string, unknown>[] = [];
  const indexMap: number[][] = [];
  for (const [messageIndex, message] of messages.entries()) {
    const firstItemIndex = input.length;
    switch (message.role) {
      case 'system':
        break;
      case 'user': {
        if (message.content_parts === undefined) {
          input.push({ type: 'message', role: 'user', content: message.content });
          break;
        }
        const content: Record<string, unknown>[] = [
          ...(message.content.length > 0 ? [{ type: 'input_text', text: message.content }] : []),
          ...message.content_parts.map((part) => responsesInputPart(part)),
        ];
        input.push({ type: 'message', role: 'user', content });
        break;
      }
      case 'assistant': {
        if (message.content.length > 0) {
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: message.content, annotations: [] }],
          });
        }
        for (const call of message.tool_calls ?? []) {
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          });
        }
        for (const call of message.incomplete_tool_calls ?? []) {
          if (!call.id) {
            throw new ProviderError(
              'invalid_request',
              'Incomplete tool calls must have persisted IDs before dispatch.',
            );
          }
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.name ?? 'unknown',
            arguments: call.arguments_text,
          });
        }
        break;
      }
      case 'tool': {
        const output =
          message.content_parts === undefined
            ? message.content
            : [
                ...(message.content.length > 0
                  ? [{ type: 'input_text', text: message.content }]
                  : []),
                ...message.content_parts.map((part) => responsesInputPart(part)),
              ];
        input.push({ type: 'function_call_output', call_id: message.tool_call_id, output });
        break;
      }
    }
    if (message.role !== 'system') {
      indexMap[messageIndex] = Array.from(
        { length: input.length - firstItemIndex },
        (_, offset) => firstItemIndex + offset,
      );
    }
  }
  return instructions.length > 0 ? { instructions, input, indexMap } : { input, indexMap };
}

function responsesInputPart(part: {
  type: 'text' | 'image_url' | 'attachment';
  text?: string;
  image_url?: { url: string; detail: 'low' };
}): Record<string, unknown> {
  if (part.type === 'attachment') {
    throw new ProviderError(
      'invalid_request',
      'Attachment references must be materialized before dispatch.',
    );
  }
  if (part.type === 'text') return { type: 'input_text', text: part.text ?? '' };
  return {
    type: 'input_image',
    image_url: part.image_url?.url ?? '',
    detail: part.image_url?.detail ?? 'low',
  };
}
