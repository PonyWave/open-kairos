import { ModelApiType } from '@kairos/contracts';
import { AnthropicMessagesProvider } from './anthropic-messages.js';
import type { EstimatingModelProvider, ProviderConfig } from './base.js';
import { ProviderError } from './errors.js';
import { GoogleGenAIProvider } from './google-genai.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { OpenAIResponsesProvider } from './openai-responses.js';

export function createModelProvider(
  apiType: ModelApiType,
  config: ProviderConfig,
  fetchImplementation: typeof fetch = fetch,
): EstimatingModelProvider {
  switch (apiType) {
    case ModelApiType.OPENAI_CHAT_COMPLETIONS:
      return new OpenAICompatibleProvider(config, fetchImplementation);
    case ModelApiType.OPENAI_RESPONSES:
      return new OpenAIResponsesProvider(config, fetchImplementation);
    case ModelApiType.ANTHROPIC_MESSAGES:
      return new AnthropicMessagesProvider(config, fetchImplementation);
    case ModelApiType.GOOGLE_GENAI:
      return new GoogleGenAIProvider(config, fetchImplementation);
    default:
      throw new ProviderError('invalid_config', `Unsupported model API type: ${String(apiType)}.`);
  }
}

export function providerIdForApiType(apiType: ModelApiType): string {
  switch (apiType) {
    case ModelApiType.OPENAI_CHAT_COMPLETIONS:
      return 'openai-compatible';
    case ModelApiType.OPENAI_RESPONSES:
      return 'openai-responses';
    case ModelApiType.ANTHROPIC_MESSAGES:
      return 'anthropic-messages';
    case ModelApiType.GOOGLE_GENAI:
      return 'google-genai';
    default:
      throw new ProviderError('invalid_config', `Unsupported model API type: ${String(apiType)}.`);
  }
}
