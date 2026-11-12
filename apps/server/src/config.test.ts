import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERIODIC_RECAP_CONFIGURATION,
  DEFAULT_SQL_RECALL_LIMITS,
  readPeriodicRecapConfig,
  readServerConfig,
  readSqlRecallConfig,
  readWebConfig,
} from './config.js';
import { DEFAULT_WEB_FETCH_LIMITS, DEFAULT_WEB_SEARCH_LIMITS } from './tools/web.js';

describe('model vision configuration', () => {
  const modelEnvironment = {
    KAIROS_MODEL_BASE_URL: 'http://localhost:1234/v1',
    KAIROS_MODEL_ID: 'model-test',
  };
  const imageRequest = {
    messages: [
      {
        role: 'user' as const,
        content: '',
        content_parts: [
          {
            type: 'image_url' as const,
            image_url: { url: 'data:image/png;base64,AQID', detail: 'low' as const },
          },
        ],
      },
    ],
    tools: [],
  };

  it('defaults to vision support and passes an explicit false value to the Provider', () => {
    const defaults = readServerConfig(modelEnvironment);
    expect(defaults.modelStatus.available).toBe(true);
    expect(() => defaults.model?.provider.estimateRequestTokens(imageRequest)).not.toThrow();

    const disabled = readServerConfig({
      ...modelEnvironment,
      KAIROS_MODEL_SUPPORTS_VISION: 'false',
    });
    expect(disabled.modelStatus.available).toBe(true);
    expect(() => disabled.model?.provider.estimateRequestTokens(imageRequest)).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('treats the vision setting as model configuration presence', () => {
    const status = readServerConfig({ KAIROS_MODEL_SUPPORTS_VISION: 'false' }).modelStatus;
    expect(status.available).toBe(false);
    expect(status.configurationErrors).toEqual([
      { code: 'missing_setting', message: 'KAIROS_MODEL_BASE_URL is required.' },
      { code: 'missing_setting', message: 'KAIROS_MODEL_ID is required.' },
    ]);
  });

  it.each(['', '1', '0', 'TRUE', 'False', 'yes', 'no', 'on', 'off'])(
    'rejects a non-strict vision boolean: %s',
    (value) => {
      expect(() =>
        readServerConfig({ ...modelEnvironment, KAIROS_MODEL_SUPPORTS_VISION: value }),
      ).toThrow(/KAIROS_MODEL_SUPPORTS_VISION/);
    },
  );
});

describe('model API type configuration', () => {
  const modelEnvironment = {
    KAIROS_MODEL_BASE_URL: 'http://localhost:1234/v1',
    KAIROS_MODEL_ID: 'model-test',
  };

  it('defaults to Chat Completions with the legacy configuration ID and supports the two native types', () => {
    const legacy = readServerConfig(modelEnvironment);
    const explicitLegacy = readServerConfig({
      ...modelEnvironment,
      KAIROS_MODEL_API_TYPE: 'openai_chat_completions',
    });
    expect(explicitLegacy.model?.configurationId).toBe(legacy.model?.configurationId);
    expect(legacy.model?.provider.constructor.name).toBe('OpenAICompatibleProvider');
    const responses = readServerConfig({
      ...modelEnvironment,
      KAIROS_MODEL_API_TYPE: 'openai_responses',
    });
    expect(responses.model?.provider.constructor.name).toBe('OpenAIResponsesProvider');
    expect(responses.modelStatus.providerId).toBe('openai-responses');
    expect(responses.model?.configurationId).not.toBe(legacy.model?.configurationId);
    const anthropic = readServerConfig({
      ...modelEnvironment,
      KAIROS_MODEL_API_TYPE: 'anthropic_messages',
    });
    expect(anthropic.model?.provider.constructor.name).toBe('AnthropicMessagesProvider');
    expect(anthropic.modelStatus.providerId).toBe('anthropic-messages');
  });

  it.each(['google-genai', 'google', 'kimi', 'opencode', 'anthropic', 'openai', ''])(
    'rejects an unimplemented or brand API type: %s',
    (value) => {
      expect(() => readServerConfig({ ...modelEnvironment, KAIROS_MODEL_API_TYPE: value })).toThrow(
        /KAIROS_MODEL_API_TYPE/,
      );
    },
  );

  it('uses the restricted model fetch for platform providers', async () => {
    const provider = readServerConfig(modelEnvironment).model?.provider;
    if (!provider) throw new Error('Missing platform provider.');
    const next = provider
      .stream(
        { messages: [{ role: 'user', content: 'hello' }], tools: [] },
        new AbortController().signal,
      )
      [Symbol.asyncIterator]()
      .next();
    await expect(next).rejects.toMatchObject({
      code: 'request_failed',
      cause: { code: 'permission_denied' },
    });
  });
});

describe('main environment configuration', () => {
  it('defaults to the main alias and the current directory and reads explicit values', () => {
    expect(readServerConfig({}).mainEnvironment).toEqual({
      envId: 'main',
      workspace: process.cwd(),
    });
    expect(readServerConfig({ KAIROS_MAIN_ENV_ID: 'cvm-device' }).mainEnvironment).toEqual({
      envId: 'cvm-device',
      workspace: process.cwd(),
    });
    expect(
      readServerConfig({
        KAIROS_MAIN_ENV_ID: 'cvm-device',
        KAIROS_MAIN_WORKSPACE: '/srv/kairos',
      }).mainEnvironment,
    ).toEqual({ envId: 'cvm-device', workspace: '/srv/kairos' });
  });

  it.each([
    { KAIROS_MAIN_ENV_ID: '' },
    { KAIROS_MAIN_ENV_ID: 'contains space' },
    { KAIROS_MAIN_WORKSPACE: 'relative/path' },
  ])('rejects invalid main environment configuration: %o', (environment) => {
    expect(() => readServerConfig(environment)).toThrow(/KAIROS_MAIN/);
  });
});

describe('trusted proxy configuration', () => {
  it('defaults to no trusted proxies and reads explicit IP and CIDR entries', () => {
    expect(readServerConfig({}).trustedProxies).toEqual([]);
    expect(
      readServerConfig({
        KAIROS_TRUSTED_PROXIES: '127.0.0.1, ::1, 10.20.0.0/16, 2001:db8::/32, 127.0.0.1',
      }).trustedProxies,
    ).toEqual(['127.0.0.1', '::1', '10.20.0.0/16', '2001:db8::/32']);
  });

  it.each([
    '',
    ' ',
    'true',
    'false',
    '*',
    'any',
    'localhost',
    '127.0.0.1,',
    '127.0.0.1,,10.0.0.1',
    '0.0.0.0/0',
    '::/0',
    '127.0.0.1/33',
    '::1/129',
    '127.0.0.1/-1',
    '127.0.0.1/1.5',
    '127.0.0.1/24/1',
    '999.1.1.1',
    '127.0.0.1 10.0.0.1',
  ])('rejects an invalid trusted proxy list: %s', (value) => {
    expect(() => readServerConfig({ KAIROS_TRUSTED_PROXIES: value })).toThrow(
      /KAIROS_TRUSTED_PROXIES/,
    );
  });
});

describe('periodic Recap configuration', () => {
  it('uses centralized defaults and reads environment overrides', () => {
    expect(DEFAULT_PERIODIC_RECAP_CONFIGURATION).toEqual({
      messageThreshold: 20,
      responseWindowMs: 600_000,
    });
    expect(readServerConfig({ KAIROS_DATA_DIR: '/tmp/kairos-test' }).periodicRecap).toEqual({
      messageThreshold: 20,
      responseWindowMs: 600_000,
    });
    expect(
      readPeriodicRecapConfig({
        KAIROS_RECAP_PERIODIC_MESSAGE_THRESHOLD: '25',
        KAIROS_RECAP_PERIODIC_RESPONSE_WINDOW_MS: '300000',
      }),
    ).toEqual({ messageThreshold: 25, responseWindowMs: 300_000 });
  });

  it.each([
    { KAIROS_RECAP_PERIODIC_MESSAGE_THRESHOLD: '0' },
    { KAIROS_RECAP_PERIODIC_MESSAGE_THRESHOLD: '1.5' },
    { KAIROS_RECAP_PERIODIC_RESPONSE_WINDOW_MS: '-1' },
    { KAIROS_RECAP_PERIODIC_RESPONSE_WINDOW_MS: 'not-a-number' },
  ])('rejects invalid runtime values: %o', (environment) => {
    expect(() => readPeriodicRecapConfig(environment)).toThrow();
  });
});

describe('SQL recall configuration', () => {
  it('uses centralized defaults and reads environment overrides', () => {
    expect(readSqlRecallConfig({})).toEqual(DEFAULT_SQL_RECALL_LIMITS);
    expect(readServerConfig({}).sqlRecall).toEqual(DEFAULT_SQL_RECALL_LIMITS);
    expect(
      readSqlRecallConfig({
        KAIROS_RECALL_SQL_TIMEOUT_MS: '3000',
        KAIROS_RECALL_SQL_MAX_ROWS: '50',
        KAIROS_RECALL_SQL_MAX_CELL_CHARACTERS: '8000',
        KAIROS_RECALL_SQL_MAX_RESPONSE_BYTES: '131072',
        KAIROS_RECALL_SQL_MAX_SNAPSHOT_BYTES: '2097152',
        KAIROS_RECALL_SQL_MAX_JAVASCRIPT_HEAP_MB: '64',
        KAIROS_RECALL_SQL_MAX_SQLITE_MEMORY_BYTES: '33554432',
        KAIROS_RECALL_SQL_MAX_SQLITE_VALUE_BYTES: '1048576',
        KAIROS_RECALL_SQL_MAX_CONCURRENT_PROCESSES: '2',
        KAIROS_RECALL_SQL_MAX_IPC_BYTES: '4194304',
      }),
    ).toEqual({
      timeoutMs: 3000,
      maxRows: 50,
      maxCellCharacters: 8000,
      maxResponseBytes: 131_072,
      maxSnapshotBytes: 2_097_152,
      maxJavaScriptHeapMb: 64,
      maxSqliteMemoryBytes: 33_554_432,
      maxSqliteValueBytes: 1_048_576,
      maxConcurrentProcesses: 2,
      maxIpcBytes: 4_194_304,
    });
  });

  it.each([
    { KAIROS_RECALL_SQL_TIMEOUT_MS: '0' },
    { KAIROS_RECALL_SQL_MAX_ROWS: '1.5' },
    { KAIROS_RECALL_SQL_MAX_CELL_CHARACTERS: '-1' },
    { KAIROS_RECALL_SQL_MAX_RESPONSE_BYTES: '1023' },
    { KAIROS_RECALL_SQL_MAX_RESPONSE_BYTES: 'not-a-number' },
    { KAIROS_RECALL_SQL_MAX_SNAPSHOT_BYTES: '1023' },
    { KAIROS_RECALL_SQL_MAX_JAVASCRIPT_HEAP_MB: '31' },
    { KAIROS_RECALL_SQL_MAX_SQLITE_MEMORY_BYTES: '1023' },
    { KAIROS_RECALL_SQL_MAX_SQLITE_VALUE_BYTES: '1023' },
    { KAIROS_RECALL_SQL_MAX_CONCURRENT_PROCESSES: '0' },
    { KAIROS_RECALL_SQL_MAX_IPC_BYTES: '1023' },
  ])('rejects invalid runtime values: %o', (environment) => {
    expect(() => readSqlRecallConfig(environment)).toThrow();
  });
});

describe('web tool configuration', () => {
  it('defaults to fetch-only operation with centralized limits', () => {
    expect(readWebConfig({})).toEqual({
      fetch: DEFAULT_WEB_FETCH_LIMITS,
      searchLimits: DEFAULT_WEB_SEARCH_LIMITS,
    });
    expect(readServerConfig({}).web).toEqual({
      fetch: DEFAULT_WEB_FETCH_LIMITS,
      searchLimits: DEFAULT_WEB_SEARCH_LIMITS,
    });
  });

  it('reads independent fetch and search limits', () => {
    const config = readWebConfig({
      KAIROS_WEB_FETCH_TIMEOUT_MS: '5000',
      KAIROS_WEB_FETCH_MAX_RESPONSE_BYTES: '4096',
      KAIROS_WEB_FETCH_MAX_TEXT_CHARACTERS: '500',
      KAIROS_WEB_FETCH_MAX_REDIRECTS: '2',
      KAIROS_WEB_SEARCH_TIMEOUT_MS: '3000',
      KAIROS_WEB_SEARCH_MAX_RESPONSE_BYTES: '8192',
      KAIROS_WEB_SEARCH_MAX_REQUESTS_PER_MINUTE: '7',
    });
    expect(config.fetch).toEqual({
      timeoutMs: 5000,
      maxResponseBytes: 4096,
      maxTextCharacters: 500,
      maxRedirects: 2,
    });
    expect(config.searchLimits).toEqual({
      timeoutMs: 3000,
      maxResponseBytes: 8192,
      maxRequestsPerMinute: 7,
    });
    expect(config.search).toBeUndefined();
  });

  it('reads a controlled SearXNG endpoint without adding credentials', () => {
    const config = readWebConfig({
      KAIROS_WEB_SEARCH_PROVIDER: 'searxng',
      KAIROS_WEB_SEARCH_SEARXNG_URL: 'http://127.0.0.1:8080/search',
    });
    expect(config.search).toEqual({
      provider: 'searxng',
      baseUrl: 'http://127.0.0.1:8080/search',
    });
    expect(config.search && 'apiKey' in config.search).toBe(false);
  });

  it('uses the official Brave endpoint by default and keeps the key out of public model status', () => {
    const environment = {
      KAIROS_WEB_SEARCH_PROVIDER: 'brave',
      KAIROS_WEB_SEARCH_BRAVE_API_KEY: 'secret-brave-key',
    };
    expect(readWebConfig(environment).search).toEqual({
      provider: 'brave',
      baseUrl: 'https://api.search.brave.com/res/v1/web/search',
      apiKey: 'secret-brave-key',
    });
    expect(JSON.stringify(readServerConfig(environment).modelStatus)).not.toContain(
      'secret-brave-key',
    );
  });

  it('allows a Brave-compatible loopback fixture without relaxing remote HTTP', () => {
    expect(
      readWebConfig({
        KAIROS_WEB_SEARCH_PROVIDER: 'brave',
        KAIROS_WEB_SEARCH_BRAVE_API_KEY: 'fixture-key',
        KAIROS_WEB_SEARCH_BRAVE_URL: 'http://127.0.0.1:8080/search',
      }).search,
    ).toMatchObject({ baseUrl: 'http://127.0.0.1:8080/search' });
    expect(() =>
      readWebConfig({
        KAIROS_WEB_SEARCH_PROVIDER: 'brave',
        KAIROS_WEB_SEARCH_BRAVE_API_KEY: 'secret',
        KAIROS_WEB_SEARCH_BRAVE_URL: 'http://search.example.com/search',
      }),
    ).toThrow(/Brave requires HTTPS/);
  });

  it.each([
    { KAIROS_WEB_SEARCH_SEARXNG_URL: 'http://127.0.0.1:8080/search' },
    { KAIROS_WEB_SEARCH_PROVIDER: 'searxng' },
    { KAIROS_WEB_SEARCH_PROVIDER: 'brave' },
    {
      KAIROS_WEB_SEARCH_PROVIDER: 'searxng',
      KAIROS_WEB_SEARCH_SEARXNG_URL: 'file:///tmp/search',
    },
    {
      KAIROS_WEB_SEARCH_PROVIDER: 'searxng',
      KAIROS_WEB_SEARCH_SEARXNG_URL: 'https://user:secret@example.com/search',
    },
    {
      KAIROS_WEB_SEARCH_PROVIDER: 'searxng',
      KAIROS_WEB_SEARCH_SEARXNG_URL: 'https://example.com/search?q=unexpected',
    },
    {
      KAIROS_WEB_SEARCH_PROVIDER: 'searxng',
      KAIROS_WEB_SEARCH_SEARXNG_URL: 'https://example.com/search',
      KAIROS_WEB_SEARCH_BRAVE_API_KEY: 'unexpected',
    },
    {
      KAIROS_WEB_SEARCH_PROVIDER: 'brave',
      KAIROS_WEB_SEARCH_BRAVE_API_KEY: 'secret',
      KAIROS_WEB_SEARCH_SEARXNG_URL: 'https://example.com/search',
    },
    { KAIROS_WEB_SEARCH_PROVIDER: 'unknown' },
    { KAIROS_WEB_FETCH_TIMEOUT_MS: '0' },
    { KAIROS_WEB_FETCH_MAX_RESPONSE_BYTES: '1023' },
    { KAIROS_WEB_FETCH_MAX_TEXT_CHARACTERS: '99' },
    { KAIROS_WEB_FETCH_MAX_REDIRECTS: '-1' },
    { KAIROS_WEB_SEARCH_TIMEOUT_MS: '0' },
    { KAIROS_WEB_SEARCH_MAX_RESPONSE_BYTES: '1023' },
    { KAIROS_WEB_SEARCH_MAX_REQUESTS_PER_MINUTE: '0' },
  ])('rejects invalid or incomplete web configuration: %o', (environment) => {
    expect(() => readWebConfig(environment)).toThrow();
  });
});
