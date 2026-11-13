import { ModelApiType } from '@kairos/contracts';
import { describe, expect, it, vi } from 'vitest';
import { listProviderModels } from './discovery.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('listProviderModels', () => {
  it('lists OpenAI-compatible models with a Bearer key', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-mini', extra: true }] }),
      );
    const models = await listProviderModels(
      ModelApiType.OPENAI_CHAT_COMPLETIONS,
      { baseUrl: 'https://openai.example/v1/', apiKey: 'secret-openai-key' },
      new AbortController().signal,
      fetchMock,
    );
    expect(models).toEqual([
      { modelId: 'gpt-5.5', displayName: '' },
      { modelId: 'gpt-5.5-mini', displayName: '' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://openai.example/v1/models');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-openai-key' });
  });

  it('lists OpenAI Responses models without a key', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-5.5' }] }));
    const models = await listProviderModels(
      ModelApiType.OPENAI_RESPONSES,
      { baseUrl: 'https://openai.example/v1' },
      new AbortController().signal,
      fetchMock,
    );
    expect(models).toEqual([{ modelId: 'gpt-5.5', displayName: '' }]);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).not.toHaveProperty('authorization');
  });

  it('lists Anthropic models with display names', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [
          { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' },
          { id: 'claude-haiku-4-5', display_name: null },
        ],
        has_more: false,
      }),
    );
    const models = await listProviderModels(
      ModelApiType.ANTHROPIC_MESSAGES,
      { baseUrl: 'https://anthropic.example', apiKey: 'secret-anthropic-key' },
      new AbortController().signal,
      fetchMock,
    );
    expect(models).toEqual([
      { modelId: 'claude-opus-4-7', displayName: 'Claude Opus 4.7' },
      { modelId: 'claude-haiku-4-5', displayName: '' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://anthropic.example/v1/models?limit=1000');
    expect(init?.headers).toMatchObject({
      'x-api-key': 'secret-anthropic-key',
      'anthropic-version': '2023-06-01',
    });
  });

  it('lists Gemini models that support generateContent', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        models: [
          {
            name: 'models/gemini-3-pro',
            displayName: 'Gemini 3 Pro',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          {
            name: 'models/text-embedding-004',
            displayName: 'Embedding',
            supportedGenerationMethods: ['embedContent'],
          },
          { name: 'models/gemini-3-flash' },
        ],
      }),
    );
    const models = await listProviderModels(
      ModelApiType.GOOGLE_GENAI,
      { baseUrl: 'https://gemini.example', apiKey: 'secret-gemini-key' },
      new AbortController().signal,
      fetchMock,
    );
    expect(models).toEqual([
      { modelId: 'gemini-3-pro', displayName: 'Gemini 3 Pro' },
      { modelId: 'gemini-3-flash', displayName: '' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://gemini.example/v1beta/models?pageSize=1000');
    expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'secret-gemini-key' });
  });

  it('drops duplicate, oversized and whitespace ids', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [
          { id: 'dup' },
          { id: 'dup' },
          { id: 'has space' },
          { id: 'x'.repeat(201) },
          { id: 'ok' },
        ],
      }),
    );
    const models = await listProviderModels(
      ModelApiType.OPENAI_CHAT_COMPLETIONS,
      { baseUrl: 'https://openai.example/v1' },
      new AbortController().signal,
      fetchMock,
    );
    expect(models.map((model) => model.modelId)).toEqual(['dup', 'ok']);
  });

  it('reports HTTP errors with the provider message and a redacted key', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: { message: 'bad key secret-openai-key' } }, 401));
    await expect(
      listProviderModels(
        ModelApiType.OPENAI_CHAT_COMPLETIONS,
        { baseUrl: 'https://openai.example/v1', apiKey: 'secret-openai-key' },
        new AbortController().signal,
        fetchMock,
      ),
    ).rejects.toThrow('Provider returned HTTP 401: bad key [redacted]');
  });

  it('reports unexpected payloads and network failures', async () => {
    const invalid = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ models: {} }));
    await expect(
      listProviderModels(
        ModelApiType.GOOGLE_GENAI,
        { baseUrl: 'https://gemini.example' },
        new AbortController().signal,
        invalid,
      ),
    ).rejects.toThrow('The provider model list response has an unexpected format.');
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection refused'));
    await expect(
      listProviderModels(
        ModelApiType.OPENAI_CHAT_COMPLETIONS,
        { baseUrl: 'https://openai.example/v1' },
        new AbortController().signal,
        failing,
      ),
    ).rejects.toThrow('Provider model list request failed: connection refused');
  });

  it('rejects unsupported API types', async () => {
    await expect(
      listProviderModels(
        ModelApiType.UNSPECIFIED,
        { baseUrl: 'https://openai.example/v1' },
        new AbortController().signal,
        vi.fn<typeof fetch>(),
      ),
    ).rejects.toThrow('Unsupported model API type');
  });
});
