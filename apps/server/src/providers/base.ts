import type { ModelProvider, ModelRequest } from '@kairos/agent-core';
import { z } from 'zod';
import { LOW_DETAIL_IMAGE_TOKENS, MAX_MODEL_REQUEST_BYTES } from '../attachments/validation.js';
import { isRecord } from './assistant-message.js';
import { ProviderError } from './errors.js';

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

export type ProviderConfig = z.input<typeof configSchema>;

export interface ModelContextBudget {
  contextWindow: number;
  outputReserve: number;
  maxInputTokens: number;
  estimatedInputTokens: number;
  utilization: number;
  fits: boolean;
}

export interface EstimatingModelProvider extends ModelProvider {
  readonly model: string;
  readonly contextWindow: number;
  readonly outputReserve: number;
  estimateTextTokens(text: string): number;
  estimateRequestTokens(request: ModelRequest): number;
  getContextBudget(request: ModelRequest): ModelContextBudget;
}

const errorBodySchema = z.object({
  error: z.object({
    message: z.string().optional(),
    code: z.union([z.string(), z.number()]).nullish(),
  }),
});

export abstract class BaseProvider implements EstimatingModelProvider {
  readonly model: string;
  readonly contextWindow: number;
  readonly outputReserve: number;
  protected readonly baseUrl: string;
  protected readonly apiKey: string | undefined;
  protected readonly fetch: typeof fetch;
  readonly #requestTimeoutMs: number | undefined;
  readonly #supportsVision: boolean;

  protected constructor(
    config: ProviderConfig,
    fetchImplementation: typeof fetch,
    protocolName: string,
  ) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ProviderError('invalid_config', `Invalid ${protocolName} provider configuration.`, {
        cause: parsed.error,
      });
    }
    this.baseUrl = parsed.data.baseUrl.replace(/\/+$/, '');
    this.apiKey = parsed.data.apiKey;
    this.model = parsed.data.model;
    this.contextWindow = parsed.data.contextWindow;
    this.outputReserve = parsed.data.outputReserve;
    this.#requestTimeoutMs = parsed.data.requestTimeoutMs;
    this.#supportsVision = parsed.data.supportsVision ?? true;
    this.fetch = fetchImplementation;
  }

  abstract stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<import('@kairos/agent-core').ModelEvent>;

  estimateTextTokens(text: string): number {
    let estimate = 0;
    for (const character of text) {
      estimate += (character.codePointAt(0) ?? 0) <= 0x7f ? 0.25 : 1;
    }
    return Math.max(text.length === 0 ? 0 : 1, Math.ceil(estimate));
  }

  estimateRequestTokens(request: ModelRequest): number {
    this.assertVisionSupport(request);
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
    return tokens + 3 + this.estimateTextTokens(JSON.stringify(request.tools));
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

  protected assertVisionSupport(request: ModelRequest): void {
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

  protected async request(
    path: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response> {
    const requestSignal =
      this.#requestTimeoutMs === undefined
        ? signal
        : AbortSignal.any([signal, AbortSignal.timeout(this.#requestTimeoutMs)]);
    try {
      const serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized) > MAX_MODEL_REQUEST_BYTES) {
        throw new ProviderError(
          'request_too_large',
          'The model request exceeds the 16 MiB request byte limit.',
        );
      }
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...headers,
        },
        body: serialized,
        signal: requestSignal,
      });
      if (!response.ok) throw await this.httpError(response);
      if (!response.body)
        throw new ProviderError('invalid_response', 'The provider response has no body.');
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
        `Provider request failed: ${this.safeMessage(error)}`,
        { cause: error },
      );
    }
  }

  protected safeMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return this.apiKey ? message.replaceAll(this.apiKey, '[redacted]') : message;
  }

  private async httpError(response: Response): Promise<ProviderError> {
    let detail = '';
    try {
      const body = errorBodySchema.parse(await response.json());
      detail = body.error.message ? `: ${body.error.message}` : '';
    } catch {
      detail = '';
    }
    return new ProviderError(
      'http_error',
      this.safeMessage(`Provider returned HTTP ${response.status}${detail}`),
      { status: response.status },
    );
  }
}

export function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}
