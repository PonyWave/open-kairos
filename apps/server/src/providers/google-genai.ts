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
  promptTokenCount: z.number().int().nonnegative().safe().nullish(),
  candidatesTokenCount: z.number().int().nonnegative().safe().nullish(),
  thoughtsTokenCount: z.number().int().nonnegative().safe().nullish(),
  cachedContentTokenCount: z.number().int().nonnegative().safe().nullish(),
});
const partSchema = z.object({
  text: z.string().optional(),
  thought: z.boolean().optional(),
  functionCall: z
    .object({
      id: z.string().nullish(),
      name: z.string().nullish(),
      args: z.unknown().optional(),
    })
    .optional(),
});
const chunkSchema = z.object({
  candidates: z
    .array(
      z.object({
        index: z.number().int().nonnegative().safe().optional(),
        content: z.object({ parts: z.array(partSchema).optional() }).optional(),
        finishReason: z.string().nullish(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().nullish() }).optional(),
  usageMetadata: usageSchema.optional(),
});

type GeminiUsage = z.infer<typeof usageSchema>;

const syntheticCallIdPrefix = 'kairos-gemini-call-';

function isSyntheticCallId(id: string): boolean {
  return id.startsWith(syntheticCallIdPrefix);
}

class GeminiStreamState {
  readonly blocks = new ContentBlocks();
  readonly calls: ToolCallParts[] = [];
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  finishReason?: string;
  done = false;

  mergeUsage(usage: GeminiUsage | undefined): void {
    if (!usage) return;
    if (typeof usage.promptTokenCount === 'number') this.inputTokens = usage.promptTokenCount;
    const output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
    if (
      typeof usage.candidatesTokenCount === 'number' ||
      typeof usage.thoughtsTokenCount === 'number'
    ) {
      this.outputTokens = output;
    }
    if (typeof usage.cachedContentTokenCount === 'number') {
      this.cachedTokens = usage.cachedContentTokenCount;
    }
  }

  usage(): DetailedModelUsage | undefined {
    if (this.inputTokens === undefined || this.outputTokens === undefined) return undefined;
    return {
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      total_tokens: this.inputTokens + this.outputTokens,
      ...(this.cachedTokens === undefined
        ? {}
        : { prompt_tokens_details: { cached_tokens: this.cachedTokens } }),
    };
  }

  addCall(call: NonNullable<z.infer<typeof partSchema>['functionCall']>): void {
    const index = this.calls.length;
    this.calls.push({
      id:
        typeof call.id === 'string' && call.id.length > 0
          ? call.id
          : `${syntheticCallIdPrefix}${index}`,
      name: typeof call.name === 'string' ? call.name : '',
      argumentsText: JSON.stringify(call.args ?? {}),
      label: `${call.name ?? 'unknown'}(${index})`,
      blockIndex: this.blocks.startCall(),
    });
  }

  message() {
    return assistantMessage(this.blocks, this.calls);
  }

  interruption(message: string, usage = this.usage()): ModelEvent {
    return {
      type: 'stream_interrupted',
      error: { code: 'stream_interrupted', message },
      ...(usage === undefined ? {} : { usage }),
    };
  }
}

export type GoogleGenAIProviderConfig = ProviderConfig;

export class GoogleGenAIProvider extends BaseProvider {
  constructor(config: GoogleGenAIProviderConfig, fetchImplementation: typeof fetch = fetch) {
    super(config, fetchImplementation, 'Google GenAI');
  }

  mapMessageIndex(request: ModelRequest, messageIndex: number): number {
    return this.nativeSource(request, messageIndex).messageIndex;
  }

  mapMessageSource(request: ModelRequest, messageIndex: number) {
    return this.nativeSource(request, messageIndex);
  }

  private nativeSource(request: ModelRequest, messageIndex: number) {
    const mapped = serializeGeminiContents(request.messages).indexMap[messageIndex];
    if (!mapped) {
      throw new ProviderError(
        'invalid_request',
        'The source message has no content in the Gemini request.',
      );
    }
    return mapped;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    signal.throwIfAborted();
    this.assertVisionSupport(request);
    const serialized = serializeGeminiContents(request.messages);
    const response = await this.request(
      `/v1beta/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`,
      {
        ...(serialized.system === undefined
          ? {}
          : { systemInstruction: { parts: [{ text: serialized.system }] } }),
        contents: serialized.contents,
        ...(request.tools.length === 0
          ? {}
          : {
              tools: [
                {
                  functionDeclarations: request.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  })),
                },
              ],
            }),
        generationConfig: { maxOutputTokens: this.outputReserve },
      },
      {
        ...(this.apiKey === undefined ? {} : { 'x-goog-api-key': this.apiKey }),
      },
      signal,
    );
    if (!response.body)
      throw new ProviderError('invalid_response', 'The provider response has no body.');

    const state = new GeminiStreamState();
    try {
      for await (const data of readSseData(response.body, signal)) {
        const terminal = yield* this.consume(data, state);
        if (terminal) return;
      }
      if (!state.done) yield* this.finish(state);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      yield state.interruption(`The provider stream was interrupted: ${this.safeMessage(error)}`);
    }
  }

  private *consume(data: string, state: GeminiStreamState): Generator<ModelEvent, boolean> {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      state.done = true;
      yield state.interruption('The provider returned invalid JSON.');
      return true;
    }
    const parsed = chunkSchema.safeParse(value);
    if (!parsed.success) {
      state.done = true;
      yield state.interruption('The provider returned an invalid stream event.');
      return true;
    }
    const chunk = parsed.data;
    try {
      state.mergeUsage(chunk.usageMetadata);
      const blockReason = chunk.promptFeedback?.blockReason;
      if (typeof blockReason === 'string' && blockReason.length > 0) {
        state.done = true;
        yield state.interruption(`The provider blocked the prompt with reason ${blockReason}.`);
        return true;
      }
      for (const candidate of chunk.candidates ?? []) {
        if (candidate.index !== undefined && candidate.index !== 0) continue;
        yield* this.consumeParts(state, candidate.content?.parts ?? []);
        if (typeof candidate.finishReason === 'string' && candidate.finishReason.length > 0) {
          state.finishReason = candidate.finishReason;
        }
      }
      return false;
    } catch (error) {
      state.done = true;
      yield state.interruption(
        `The provider returned an invalid stream event: ${this.safeMessage(error)}`,
      );
      return true;
    }
  }

  private *consumeParts(
    state: GeminiStreamState,
    parts: readonly z.infer<typeof partSchema>[],
  ): Generator<ModelEvent, void> {
    for (const part of parts) {
      if (part.functionCall !== undefined) {
        state.addCall(part.functionCall);
        continue;
      }
      const text = part.text ?? '';
      if (text.length === 0) continue;
      if (part.thought === true) {
        const blockIndex = state.blocks.add('thinking', text);
        yield { type: 'thinking_delta', text, block_index: blockIndex };
      } else {
        const blockIndex = state.blocks.add('text', text);
        yield { type: 'text_delta', text, block_index: blockIndex };
      }
    }
  }

  private *finish(state: GeminiStreamState): Generator<ModelEvent, boolean> {
    state.done = true;
    const reason = state.finishReason;
    const usage = state.usage();
    if (reason === undefined) {
      yield state.interruption('The provider stream did not include a finish reason.', usage);
      return true;
    }
    if (usage === undefined) {
      yield state.interruption('The provider stream did not include complete token usage.');
      return true;
    }
    if (reason !== 'STOP') {
      yield state.interruption(`The provider stopped with reason ${reason}.`, usage);
      return true;
    }
    yield { type: 'response', message: state.message(), usage };
    return true;
  }
}

const incompleteArgumentsField = '_kairos_incomplete_arguments';

interface GeminiSourceIndex {
  messageIndex: number;
  contentBlockIndexes: number[];
}

type GeminiPart = Record<string, unknown>;

function serializeGeminiContents(messages: readonly ModelMessage[]): {
  system?: string;
  contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }>;
  indexMap: Array<GeminiSourceIndex | undefined>;
} {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .filter((content) => content.length > 0)
    .join('\n\n');
  const output: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = [];
  const indexMap: Array<GeminiSourceIndex | undefined> = [];
  const append = (role: 'user' | 'model', parts: GeminiPart[], sourceIndex: number) => {
    if (parts.length === 0) return;
    const previous = output.at(-1);
    const messageIndex = previous?.role === role ? output.length - 1 : output.length;
    const firstContentIndex = previous?.role === role ? previous.parts.length : 0;
    if (previous?.role === role) previous.parts.push(...parts);
    else output.push({ role, parts });
    indexMap[sourceIndex] = {
      messageIndex,
      contentBlockIndexes: parts.map((_, index) => firstContentIndex + index),
    };
  };
  for (const [sourceIndex, message] of messages.entries()) {
    switch (message.role) {
      case 'system':
        break;
      case 'user':
        append('user', geminiContent(message.content, message.content_parts), sourceIndex);
        break;
      case 'assistant': {
        const parts: GeminiPart[] = [
          ...(message.content.length > 0 ? [{ text: message.content }] : []),
          ...(message.tool_calls ?? []).map((call) => ({
            functionCall: {
              ...(isSyntheticCallId(call.id) ? {} : { id: call.id }),
              name: call.name,
              args: call.arguments,
            },
          })),
          ...(message.incomplete_tool_calls ?? []).map((call) => ({
            functionCall: {
              ...(call.id === undefined || isSyntheticCallId(call.id) ? {} : { id: call.id }),
              name: call.name ?? 'unknown',
              args: { [incompleteArgumentsField]: call.arguments_text },
            },
          })),
        ];
        append('model', parts, sourceIndex);
        break;
      }
      case 'tool': {
        const parts: GeminiPart[] = [
          {
            functionResponse: {
              ...(isSyntheticCallId(message.tool_call_id) ? {} : { id: message.tool_call_id }),
              name: message.tool_name,
              response: {
                content: message.content,
                ...(message.status === 'error' ? { is_error: true } : {}),
              },
            },
          },
          ...geminiContent('', message.content_parts),
        ];
        append('user', parts, sourceIndex);
        break;
      }
    }
  }
  return system.length > 0
    ? { system, contents: output, indexMap }
    : { contents: output, indexMap };
}

function geminiContent(
  content: string,
  parts: readonly UserContentBlock[] | undefined,
): GeminiPart[] {
  return [
    ...(content.length > 0 ? [{ text: content }] : []),
    ...(parts ?? []).map((part) => {
      if (part.type === 'attachment') {
        throw new ProviderError(
          'invalid_request',
          'Attachment references must be materialized before dispatch.',
        );
      }
      return part.type === 'text'
        ? { text: part.text }
        : { inlineData: geminiInlineData(part.image_url.url) };
    }),
  ];
}

function geminiInlineData(url: string): Record<string, unknown> {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(url);
  if (!match?.[1] || !match[2]) {
    throw new ProviderError(
      'invalid_request',
      'Gemini supports image input only from base64 data URLs.',
    );
  }
  return { mimeType: match[1], data: match[2] };
}
