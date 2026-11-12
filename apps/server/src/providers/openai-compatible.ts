import type {
  AssistantMessage,
  ContentBlock,
  DetailedModelUsage,
  IncompleteToolCall,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ToolCall,
} from '@kairos/agent-core';
import { z } from 'zod';
import { LOW_DETAIL_IMAGE_TOKENS, MAX_MODEL_REQUEST_BYTES } from '../attachments/validation.js';
import { ProviderError } from './errors.js';

export type { ProviderErrorCode } from './errors.js';
export { ProviderError } from './errors.js';

const configSchema = z
  .object({
    baseUrl: z.string().url(),
    apiKey: z.string().min(1).optional(),
    model: z.string().min(1),
    contextWindow: z.number().int().positive().safe(),
    outputReserve: z.number().int().positive().safe(),
    requestTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
    supportsVision: z.boolean().optional(),
  })
  .strict()
  .refine((config) => config.outputReserve < config.contextWindow, {
    message: 'outputReserve must be smaller than contextWindow.',
  });

export type OpenAICompatibleProviderConfig = z.input<typeof configSchema>;

export interface ModelContextBudget {
  contextWindow: number;
  outputReserve: number;
  maxInputTokens: number;
  estimatedInputTokens: number;
  utilization: number;
  fits: boolean;
}

interface OpenAIToolCall {
  index: number;
  id?: string | undefined;
  function?:
    | {
        name?: string | undefined;
        arguments?: string | undefined;
      }
    | undefined;
}

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().safe(),
  completion_tokens: z.number().int().nonnegative().safe(),
  total_tokens: z.number().int().nonnegative().safe(),
  prompt_tokens_details: z
    .object({ cached_tokens: z.number().int().nonnegative().safe().optional() })
    .optional(),
});
const chunkSchema = z.object({
  choices: z.array(
    z.object({
      delta: z.object({
        content: z.string().nullish(),
        reasoning_content: z.unknown().optional(),
        reasoning: z.unknown().optional(),
        reasoning_text: z.unknown().optional(),
        tool_calls: z
          .array(
            z.object({
              index: z.number().int().nonnegative().safe(),
              id: z.string().optional(),
              type: z.literal('function').optional(),
              function: z
                .object({ name: z.string().optional(), arguments: z.string().optional() })
                .optional(),
            }),
          )
          .optional(),
      }),
      finish_reason: z.string().nullish(),
    }),
  ),
  usage: usageSchema.nullish(),
  error: z
    .object({ message: z.string(), code: z.union([z.string(), z.number()]).nullish() })
    .optional(),
});
const errorBodySchema = z.object({
  error: z.object({
    message: z.string().optional(),
    code: z.union([z.string(), z.number()]).nullish(),
  }),
});

type OpenAIChunk = z.infer<typeof chunkSchema>;

interface PendingToolCall {
  id: string;
  name: string;
  argumentsText: string;
  blockIndex: number;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly model: string;
  readonly contextWindow: number;
  readonly outputReserve: number;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #requestTimeoutMs: number | undefined;
  readonly #supportsVision: boolean;
  readonly #fetch: typeof fetch;

  constructor(config: OpenAICompatibleProviderConfig, fetchImplementation: typeof fetch = fetch) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ProviderError(
        'invalid_config',
        'Invalid OpenAI-compatible provider configuration.',
        {
          cause: parsed.error,
        },
      );
    }
    this.#baseUrl = parsed.data.baseUrl.replace(/\/+$/, '');
    this.#apiKey = parsed.data.apiKey;
    this.model = parsed.data.model;
    this.contextWindow = parsed.data.contextWindow;
    this.outputReserve = parsed.data.outputReserve;
    this.#requestTimeoutMs = parsed.data.requestTimeoutMs;
    this.#supportsVision = parsed.data.supportsVision ?? true;
    this.#fetch = fetchImplementation;
  }

  mapMessageIndex(request: ModelRequest, messageIndex: number): number {
    const mapped = serializeOpenAIMessages(request.messages).indexMap[messageIndex];
    if (mapped === undefined) {
      throw new ProviderError(
        'invalid_request',
        'The source message index is outside the request.',
      );
    }
    return mapped;
  }

  estimateTextTokens(text: string): number {
    let estimate = 0;
    for (const character of text) {
      estimate += (character.codePointAt(0) ?? 0) <= 0x7f ? 0.25 : 1;
    }
    return Math.max(text.length === 0 ? 0 : 1, Math.ceil(estimate));
  }

  estimateRequestTokens(request: ModelRequest): number {
    this.#assertVisionSupport(request);
    let tokens = 0;
    for (const message of request.messages) {
      tokens += 4 + this.estimateTextTokens(message.content);
      if (message.role === 'user' || message.role === 'tool') {
        for (const part of message.content_parts ?? []) {
          if (part.type === 'text') tokens += this.estimateTextTokens(part.text);
          else if (part.type === 'image_url') tokens += LOW_DETAIL_IMAGE_TOKENS;
          else {
            throw new ProviderError(
              'invalid_request',
              'Attachment references must be materialized before token estimation.',
            );
          }
        }
      }
      if (message.role === 'assistant') {
        tokens += this.estimateTextTokens(
          JSON.stringify({
            tool_calls: (message.tool_calls ?? []).map((call) => ({
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            })),
            incomplete_tool_calls: message.incomplete_tool_calls ?? [],
          }),
        );
      }
      if (message.role === 'tool') {
        tokens +=
          this.estimateTextTokens(message.tool_call_id) +
          this.estimateTextTokens(message.tool_name);
      }
    }
    tokens += this.estimateToolResultImageInstructionTokens(request.messages);
    tokens += 3 + this.estimateTextTokens(JSON.stringify(request.tools));
    return tokens;
  }

  private estimateToolResultImageInstructionTokens(messages: readonly ModelMessage[]): number {
    let tokens = 0;
    let runHasImages = false;
    for (const message of messages) {
      if (message.role !== 'tool') {
        runHasImages = false;
        continue;
      }
      if ((message.content_parts?.length ?? 0) === 0) continue;
      if (!runHasImages) {
        tokens += 4 + this.estimateTextTokens(toolResultImageInstruction);
        runHasImages = true;
      }
      tokens += this.estimateTextTokens(`Tool result ${message.tool_call_id}:`);
    }
    return tokens;
  }

  #assertVisionSupport(request: ModelRequest): void {
    if (this.#supportsVision) return;
    const hasImage = request.messages.some(
      (message) =>
        (message.role === 'user' || message.role === 'tool') &&
        (message.content_parts ?? []).some((part) => part.type === 'image_url'),
    );
    if (hasImage) {
      throw new ProviderError(
        'invalid_request',
        'The configured model does not support image input.',
      );
    }
  }

  getContextBudget(request: ModelRequest): ModelContextBudget {
    const estimatedInputTokens = this.estimateRequestTokens(request);
    const maxInputTokens = this.contextWindow - this.outputReserve;
    return {
      contextWindow: this.contextWindow,
      outputReserve: this.outputReserve,
      maxInputTokens,
      estimatedInputTokens,
      utilization: estimatedInputTokens / this.contextWindow,
      fits: estimatedInputTokens <= maxInputTokens,
    };
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    signal.throwIfAborted();
    const response = await this.#request(request, signal);
    if (!response.body) {
      throw new ProviderError('invalid_response', 'The provider response has no body.');
    }

    const state = new StreamState();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = extractEvents(buffer);
        buffer = parsed.remainder;
        for (const data of parsed.events) {
          const terminal = yield* this.#consumeData(data, state);
          if (terminal) return;
        }
      }
      buffer += decoder.decode();
      const final = extractEvents(`${buffer}\n\n`);
      for (const data of final.events) {
        const terminal = yield* this.#consumeData(data, state);
        if (terminal) return;
      }
      if (!state.done) {
        yield state.interruption('The provider stream ended before [DONE].');
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      yield state.interruption(`The provider stream was interrupted: ${this.#safeMessage(error)}`);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async #request(request: ModelRequest, signal: AbortSignal): Promise<Response> {
    this.#assertVisionSupport(request);
    const requestSignal =
      this.#requestTimeoutMs === undefined
        ? signal
        : AbortSignal.any([signal, AbortSignal.timeout(this.#requestTimeoutMs)]);
    try {
      const body = JSON.stringify({
        model: this.model,
        messages: serializeOpenAIMessages(request.messages).messages,
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        max_tokens: this.outputReserve,
        stream: true,
        stream_options: { include_usage: true },
      });
      if (Buffer.byteLength(body) > MAX_MODEL_REQUEST_BYTES) {
        throw new ProviderError(
          'request_too_large',
          'The model request exceeds the 16 MiB request byte limit.',
        );
      }
      const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(this.#apiKey === undefined ? {} : { authorization: `Bearer ${this.#apiKey}` }),
        },
        body,
        signal: requestSignal,
      });
      if (!response.ok) throw await this.#httpError(response);
      return response;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (requestSignal.aborted) {
        throw new ProviderError('request_timeout', 'The provider request timed out.', {
          cause: error,
        });
      }
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        'request_failed',
        `Provider request failed: ${this.#safeMessage(error)}`,
        {
          cause: error,
        },
      );
    }
  }

  async #httpError(response: Response): Promise<ProviderError> {
    let detail = '';
    try {
      const body = errorBodySchema.parse(await response.json());
      detail = body.error.message ? `: ${body.error.message}` : '';
    } catch {
      detail = '';
    }
    return new ProviderError(
      'http_error',
      this.#safeMessage(`Provider returned HTTP ${response.status}${detail}`),
      { status: response.status },
    );
  }

  *#consumeData(data: string, state: StreamState): Generator<ModelEvent, boolean> {
    if (data === '[DONE]') {
      state.done = true;
      if (!state.usage) {
        yield state.interruption('The provider stream did not include token usage.');
      } else if (state.finishReason === 'length' || state.finishReason === 'content_filter') {
        yield state.interruption(
          `The provider stopped with finish reason ${state.finishReason}.`,
          state.usage,
        );
      } else {
        yield {
          type: 'response',
          message: state.message(),
          usage: state.usage,
        };
      }
      return true;
    }

    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      yield state.interruption('The provider returned invalid JSON.');
      return true;
    }
    const parsed = chunkSchema.safeParse(value);
    if (!parsed.success) {
      yield state.interruption('The provider returned an invalid stream chunk.');
      return true;
    }
    const chunk: OpenAIChunk = parsed.data;
    if (chunk.error) {
      yield state.interruption(
        this.#safeMessage(`The provider returned an error: ${chunk.error.message}`),
      );
      return true;
    }
    if (chunk.usage) state.usage = toUsage(chunk.usage);
    for (const choice of chunk.choices) {
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        state.finishReason = choice.finish_reason;
      }
      let reasoning: string | undefined;
      try {
        reasoning = state.reasoning(choice.delta);
      } catch {
        yield state.interruption('The provider returned an invalid reasoning field.');
        return true;
      }
      if (reasoning) {
        const blockIndex = state.addBlock('thinking', reasoning);
        yield { type: 'thinking_delta', text: reasoning, block_index: blockIndex };
      }
      if (choice.delta.content) {
        const blockIndex = state.addBlock('text', choice.delta.content);
        yield { type: 'text_delta', text: choice.delta.content, block_index: blockIndex };
      }
      for (const call of choice.delta.tool_calls ?? []) state.addToolCall(call);
    }
    return false;
  }

  #safeMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return this.#apiKey ? message.replaceAll(this.#apiKey, '[redacted]') : message;
  }
}

const reasoningAliases = ['reasoning_content', 'reasoning', 'reasoning_text'] as const;
type ReasoningAlias = (typeof reasoningAliases)[number];

class StreamState {
  usage?: DetailedModelUsage;
  finishReason?: string;
  done = false;
  readonly #calls = new Map<number, PendingToolCall>();
  readonly #blocks: ContentBlock[] = [];
  #reasoningAlias: ReasoningAlias | undefined;
  #startNewBlock = false;

  reasoning(delta: OpenAIChunk['choices'][number]['delta']): string | undefined {
    for (const alias of reasoningAliases) {
      const value = delta[alias];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw new Error(`Invalid ${alias}.`);
      }
    }
    if (this.#reasoningAlias === undefined) {
      this.#reasoningAlias = reasoningAliases.find((alias) => {
        const value = delta[alias];
        return typeof value === 'string' && value.length > 0;
      });
    }
    if (this.#reasoningAlias === undefined) return undefined;
    const value = delta[this.#reasoningAlias];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  addBlock(type: ContentBlock['type'], text: string): number {
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

  addToolCall(call: OpenAIToolCall): void {
    const pending = this.#calls.get(call.index) ?? {
      id: '',
      name: '',
      argumentsText: '',
      blockIndex: this.startCall(),
    };
    if (call.id !== undefined) pending.id += call.id;
    if (call.function?.name !== undefined) pending.name += call.function.name;
    if (call.function?.arguments !== undefined) pending.argumentsText += call.function.arguments;
    this.#calls.set(call.index, pending);
  }

  message(): AssistantMessage {
    const complete: ToolCall[] = [];
    const incomplete: IncompleteToolCall[] = [];
    for (const [index, call] of [...this.#calls.entries()].sort(
      ([left], [right]) => left - right,
    )) {
      const base = {
        ...(call.id.length > 0 ? { id: call.id } : {}),
        ...(call.name.length > 0 ? { name: call.name } : {}),
      };
      if (call.id.length === 0 || call.name.length === 0) {
        incomplete.push({
          ...base,
          arguments_text: call.argumentsText,
          error: `Tool call ${index} is missing a required id or function name.`,
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
      content: this.#blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(''),
      ...(this.#blocks.length > 0
        ? { content_blocks: this.#blocks.map((block) => ({ ...block })) }
        : {}),
      ...(complete.length > 0 ? { tool_calls: complete } : {}),
      ...(incomplete.length > 0 ? { incomplete_tool_calls: incomplete } : {}),
    };
  }

  interruption(message: string, usage = this.usage): ModelEvent {
    return {
      type: 'stream_interrupted',
      error: { code: 'stream_interrupted', message },
      ...(usage === undefined ? {} : { usage }),
    };
  }
}

function extractEvents(buffer: string): { events: string[]; remainder: string } {
  const pendingCR = buffer.endsWith('\r');
  const input = pendingCR ? buffer.slice(0, -1) : buffer;
  const normalized = input.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const parts = normalized.split('\n\n');
  const remainder = `${parts.pop() ?? ''}${pendingCR ? '\r' : ''}`;
  const events = parts
    .map((part) =>
      part
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n'),
    )
    .filter((data) => data.length > 0);
  return { events, remainder };
}

const toolResultImageInstruction = 'Image content from preceding tool results.';

function serializeOpenAIMessages(messages: readonly ModelMessage[]): {
  messages: Record<string, unknown>[];
  indexMap: number[];
} {
  const output: Record<string, unknown>[] = [];
  const indexMap: number[] = [];
  const pendingImages: Array<{ callId: string; parts: Record<string, unknown>[] }> = [];
  const flushImages = () => {
    if (pendingImages.length === 0) return;
    const content: Record<string, unknown>[] = [{ type: 'text', text: toolResultImageInstruction }];
    for (const pending of pendingImages) {
      content.push({ type: 'text', text: `Tool result ${pending.callId}:` }, ...pending.parts);
    }
    output.push({ role: 'user', content });
    pendingImages.length = 0;
  };

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === 'tool') {
      output.push(toOpenAIMessage(message));
      indexMap[messageIndex] = output.length - 1;
      const parts = (message.content_parts ?? []).map((part): Record<string, unknown> => {
        if (part.type === 'attachment') {
          throw new ProviderError(
            'invalid_request',
            'Attachment references must be materialized before dispatch.',
          );
        }
        return part.type === 'text'
          ? { type: 'text', text: part.text }
          : { type: 'image_url', image_url: part.image_url };
      });
      if (parts.length > 0) pendingImages.push({ callId: message.tool_call_id, parts });
      continue;
    }
    flushImages();
    output.push(toOpenAIMessage(message));
    indexMap[messageIndex] = output.length - 1;
  }
  flushImages();
  return { messages: output, indexMap };
}

function toOpenAIMessage(message: ModelMessage): Record<string, unknown> {
  switch (message.role) {
    case 'system':
      return { role: message.role, content: message.content };
    case 'user': {
      if (message.content_parts === undefined) {
        return { role: message.role, content: message.content };
      }
      const parts = message.content_parts.map((part): Record<string, unknown> => {
        if (part.type === 'attachment') {
          throw new ProviderError(
            'invalid_request',
            'Attachment references must be materialized before dispatch.',
          );
        }
        return part.type === 'text'
          ? { type: 'text', text: part.text }
          : { type: 'image_url', image_url: part.image_url };
      });
      return {
        role: message.role,
        content: [
          ...(message.content.length > 0 ? [{ type: 'text', text: message.content }] : []),
          ...parts,
        ],
      };
    }
    case 'assistant': {
      const complete = (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }));
      const incomplete = (message.incomplete_tool_calls ?? []).map((call) => {
        if (call.id === undefined || call.id.length === 0) {
          throw new ProviderError(
            'invalid_request',
            'Incomplete tool calls must have persisted IDs before dispatch.',
          );
        }
        return {
          id: call.id,
          type: 'function',
          function: { name: call.name ?? 'unknown', arguments: call.arguments_text },
        };
      });
      const toolCalls = [...complete, ...incomplete];
      return {
        role: 'assistant',
        content: message.content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    }
    case 'tool':
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.tool_call_id,
        name: message.tool_name,
      };
  }
}

function toUsage(usage: z.infer<typeof usageSchema>): DetailedModelUsage {
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(cachedTokens === undefined
      ? {}
      : { prompt_tokens_details: { cached_tokens: cachedTokens } }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
