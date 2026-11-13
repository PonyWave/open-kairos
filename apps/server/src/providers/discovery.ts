import { ModelApiType } from '@kairos/contracts';
import { z } from 'zod';
import { ProviderError } from './errors.js';

export interface DiscoveredModel {
  modelId: string;
  displayName: string;
}

export interface ModelDiscoveryConfig {
  baseUrl: string;
  apiKey?: string;
}

const MAX_DISCOVERED_MODELS = 1000;
const MAX_MODEL_ID_LENGTH = 200;

const openAiListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) }).loose()),
});
const anthropicListSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string().min(1),
        display_name: z.string().nullish(),
      })
      .loose(),
  ),
});
const geminiListSchema = z.object({
  models: z.array(
    z
      .object({
        name: z.string().min(1),
        displayName: z.string().nullish(),
        supportedGenerationMethods: z.array(z.string()).optional(),
      })
      .loose(),
  ),
});

const errorBodySchema = z.object({
  error: z.object({
    message: z.string().optional(),
  }),
});

function parseList<Schema extends z.ZodType<DiscoveredModel[]>>(
  schema: Schema,
  payload: unknown,
): DiscoveredModel[] {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderError(
      'invalid_response',
      'The provider model list response has an unexpected format.',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function openAiModels(payload: unknown): DiscoveredModel[] {
  return parseList(
    openAiListSchema.transform((body) =>
      body.data.map((model) => ({ modelId: model.id, displayName: '' })),
    ),
    payload,
  );
}

function anthropicModels(payload: unknown): DiscoveredModel[] {
  return parseList(
    anthropicListSchema.transform((body) =>
      body.data.map((model) => ({
        modelId: model.id,
        displayName: typeof model.display_name === 'string' ? model.display_name : '',
      })),
    ),
    payload,
  );
}

function geminiModels(payload: unknown): DiscoveredModel[] {
  return parseList(
    geminiListSchema.transform((body) =>
      body.models
        .filter(
          (model) =>
            model.supportedGenerationMethods === undefined ||
            model.supportedGenerationMethods.includes('generateContent'),
        )
        .map((model) => ({
          modelId: model.name.replace(/^models\//, ''),
          displayName: typeof model.displayName === 'string' ? model.displayName : '',
        })),
    ),
    payload,
  );
}

interface DiscoveryEndpoint {
  path: string;
  headers: (apiKey: string | undefined) => Record<string, string>;
  models: (payload: unknown) => DiscoveredModel[];
}

function endpointFor(apiType: ModelApiType): DiscoveryEndpoint {
  switch (apiType) {
    case ModelApiType.OPENAI_CHAT_COMPLETIONS:
    case ModelApiType.OPENAI_RESPONSES:
      return {
        path: '/models',
        headers: (apiKey) => (apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
        models: openAiModels,
      };
    case ModelApiType.ANTHROPIC_MESSAGES:
      return {
        path: '/v1/models?limit=1000',
        headers: (apiKey) => ({
          'anthropic-version': '2023-06-01',
          ...(apiKey === undefined ? {} : { 'x-api-key': apiKey }),
        }),
        models: anthropicModels,
      };
    case ModelApiType.GOOGLE_GENAI:
      return {
        path: '/v1beta/models?pageSize=1000',
        headers: (apiKey) => (apiKey === undefined ? {} : { 'x-goog-api-key': apiKey }),
        models: geminiModels,
      };
    default:
      throw new ProviderError('invalid_config', `Unsupported model API type: ${String(apiType)}.`);
  }
}

export async function listProviderModels(
  apiType: ModelApiType,
  config: ModelDiscoveryConfig,
  signal: AbortSignal,
  fetchImplementation: typeof fetch = fetch,
): Promise<DiscoveredModel[]> {
  const endpoint = endpointFor(apiType);
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let response: Response;
  try {
    response = await fetchImplementation(`${baseUrl}${endpoint.path}`, {
      method: 'GET',
      headers: { accept: 'application/json', ...endpoint.headers(config.apiKey) },
      signal: requestSignal,
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    const message = error instanceof Error ? error.message : String(error);
    if (requestSignal.aborted) {
      throw new ProviderError('request_timeout', 'The provider model list request timed out.', {
        cause: error,
      });
    }
    throw new ProviderError(
      'request_failed',
      `Provider model list request failed: ${safeMessage(message, config.apiKey)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    let detail = '';
    try {
      const body = errorBodySchema.parse(await response.json());
      detail = body.error.message ? `: ${body.error.message}` : '';
    } catch {
      detail = '';
    }
    throw new ProviderError(
      'http_error',
      safeMessage(`Provider returned HTTP ${response.status}${detail}`, config.apiKey),
      { status: response.status },
    );
  }
  const models = endpoint.models(await response.json());
  const unique = new Map<string, DiscoveredModel>();
  for (const model of models) {
    if (model.modelId.length > MAX_MODEL_ID_LENGTH || /\s/.test(model.modelId)) continue;
    if (!unique.has(model.modelId)) unique.set(model.modelId, model);
  }
  return [...unique.values()].slice(0, MAX_DISCOVERED_MODELS);
}

function safeMessage(message: string, apiKey: string | undefined): string {
  return apiKey ? message.replaceAll(apiKey, '[redacted]') : message;
}
