import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelRequest } from '@kairos/agent-core';
import { ModelApiType } from '@kairos/contracts';
import { z } from 'zod';
import { DEFAULT_MEMORY_INDEX_MAX_BYTES, type MemoryConfiguration } from './memory/index.js';
import { loadMcpServerConfigs, type McpServerConfig } from './mcp/config.js';
import type { EstimatingModelProvider } from './providers/base.js';
import { createModelProvider, providerIdForApiType } from './providers/factory.js';
import { DEFAULT_SQL_RECALL_LIMITS, type SqlRecallLimits } from './recall/types.js';
import type { PeriodicRecapConfiguration } from './recap/periodic.js';
import { modelFetch } from './settings/model-network.js';
import {
  DEFAULT_WEB_FETCH_LIMITS,
  DEFAULT_WEB_SEARCH_LIMITS,
  type WebToolOptions,
} from './tools/web.js';

export { DEFAULT_SQL_RECALL_LIMITS } from './recall/types.js';

export const DEFAULT_PERIODIC_RECAP_CONFIGURATION: PeriodicRecapConfiguration = {
  triggerMessages: 10,
  idleAfterMs: 180_000,
  maxMessages: 20,
};

function readTrustedProxies(value: string | undefined): string[] {
  if (value === undefined) return [];
  const proxies = value.split(',').map((entry) => entry.trim());
  for (const proxy of proxies) {
    const separator = proxy.indexOf('/');
    const address = separator === -1 ? proxy : proxy.slice(0, separator);
    const version = isIP(address);
    if (version === 0) {
      throw new Error(
        'KAIROS_TRUSTED_PROXIES must contain comma-separated IPv4/IPv6 addresses or CIDR ranges.',
      );
    }
    if (separator === -1) continue;
    const prefix = proxy.slice(separator + 1);
    const maximum = version === 4 ? 32 : 128;
    if (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > maximum) {
      throw new Error(
        'KAIROS_TRUSTED_PROXIES CIDR prefixes must be positive and within the address family limit.',
      );
    }
  }
  return [...new Set(proxies)];
}

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  KAIROS_HOST: z.string().min(1).default('127.0.0.1'),
  KAIROS_TRUSTED_PROXIES: z.string().optional().transform(readTrustedProxies),
  KAIROS_PORT: z.coerce.number().int().min(1).max(65535).default(4317),
  KAIROS_DATA_DIR: z
    .string()
    .refine(isAbsolute, 'KAIROS_DATA_DIR must be an absolute path.')
    .default(join(homedir(), '.kairos', '.data')),
  KAIROS_LOG_DIR: z
    .string()
    .refine(isAbsolute, 'KAIROS_LOG_DIR must be an absolute path.')
    .optional(),
  KAIROS_AUTH_SECRET: z.string().min(32).optional(),
  KAIROS_AUTH_ENABLED: z.enum(['true', 'false']).default('true'),
  KAIROS_MAIN_ENV_ID: z.string().optional(),
  KAIROS_MAIN_WORKSPACE: z.string().optional(),
  KAIROS_PUBLIC_ORIGIN: z.string().optional(),
  KAIROS_DAEMON_RELEASE_DIR: z
    .string()
    .refine(isAbsolute, 'KAIROS_DAEMON_RELEASE_DIR must be an absolute path.')
    .optional(),
  KAIROS_MAX_RPC_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024)
    .default(1024 * 1024),
  KAIROS_MAX_EVENT_QUEUE: z.coerce.number().int().positive().max(10_000).default(256),
  KAIROS_MAX_ACTIVE_THREADS: z.coerce.number().int().positive().max(100).default(2),
  KAIROS_MAX_CONCURRENT_MODEL_REQUESTS: z.coerce.number().int().positive().max(100).default(4),
  KAIROS_MAX_STEPS_PER_RUN: z.coerce.number().int().positive().max(1000).default(30),
  KAIROS_MEMORY_DIR: z
    .string()
    .refine(isAbsolute, 'KAIROS_MEMORY_DIR must be an absolute path.')
    .optional(),
  KAIROS_MEMORY_INDEX_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(1024 * 1024)
    .default(DEFAULT_MEMORY_INDEX_MAX_BYTES),
  KAIROS_MEMORY_DREAM_ENABLED: z.enum(['true', 'false']).default('true'),
  KAIROS_RECAP_PERIODIC_TRIGGER_MESSAGES: z.coerce
    .number()
    .int()
    .positive()
    .safe()
    .default(DEFAULT_PERIODIC_RECAP_CONFIGURATION.triggerMessages),
  KAIROS_RECAP_PERIODIC_IDLE_AFTER_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .safe()
    .default(DEFAULT_PERIODIC_RECAP_CONFIGURATION.idleAfterMs),
  KAIROS_RECAP_PERIODIC_MAX_MESSAGES: z.coerce
    .number()
    .int()
    .positive()
    .safe()
    .default(DEFAULT_PERIODIC_RECAP_CONFIGURATION.maxMessages),
  KAIROS_RECALL_SQL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(60_000)
    .default(DEFAULT_SQL_RECALL_LIMITS.timeoutMs),
  KAIROS_RECALL_SQL_MAX_ROWS: z.coerce
    .number()
    .int()
    .positive()
    .max(10_000)
    .default(DEFAULT_SQL_RECALL_LIMITS.maxRows),
  KAIROS_RECALL_SQL_MAX_CELL_CHARACTERS: z.coerce
    .number()
    .int()
    .positive()
    .max(1_000_000)
    .default(DEFAULT_SQL_RECALL_LIMITS.maxCellCharacters),
  KAIROS_RECALL_SQL_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .default(DEFAULT_SQL_RECALL_LIMITS.maxResponseBytes),
  KAIROS_RECALL_SQL_MAX_SNAPSHOT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(512 * 1024 * 1024)
    .default(DEFAULT_SQL_RECALL_LIMITS.maxSnapshotBytes),
  KAIROS_RECALL_SQL_MAX_JAVASCRIPT_HEAP_MB: z.coerce
    .number()
    .int()
    .min(32)
    .max(4096)
    .default(DEFAULT_SQL_RECALL_LIMITS.maxJavaScriptHeapMb),
  KAIROS_RECALL_SQL_MAX_SQLITE_MEMORY_BYTES: z.coerce
    .number()
    .int()
    .min(1024 * 1024)
    .max(512 * 1024 * 1024)
    .default(DEFAULT_SQL_RECALL_LIMITS.maxSqliteMemoryBytes),
  KAIROS_RECALL_SQL_MAX_SQLITE_VALUE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(512 * 1024 * 1024)
    .default(DEFAULT_SQL_RECALL_LIMITS.maxSqliteValueBytes),
  KAIROS_RECALL_SQL_MAX_CONCURRENT_PROCESSES: z.coerce
    .number()
    .int()
    .positive()
    .max(32)
    .default(DEFAULT_SQL_RECALL_LIMITS.maxConcurrentProcesses),
  KAIROS_RECALL_SQL_MAX_IPC_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .default(DEFAULT_SQL_RECALL_LIMITS.maxIpcBytes),
  KAIROS_MODEL_API_TYPE: z
    .enum(['openai_chat_completions', 'openai_responses', 'anthropic_messages'])
    .default('openai_chat_completions'),
  KAIROS_MODEL_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const url = new URL(entry);
          if (!['http:', 'https:'].includes(url.protocol) || url.origin !== entry)
            throw new Error('KAIROS_MODEL_ALLOWED_ORIGINS must contain exact HTTP(S) origins.');
          return entry;
        }),
    ),
  KAIROS_MODEL_SUPPORTS_VISION: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  KAIROS_WEB_FETCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(120_000)
    .default(DEFAULT_WEB_FETCH_LIMITS.timeoutMs),
  KAIROS_WEB_FETCH_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .default(DEFAULT_WEB_FETCH_LIMITS.maxResponseBytes),
  KAIROS_WEB_FETCH_MAX_TEXT_CHARACTERS: z.coerce
    .number()
    .int()
    .min(100)
    .max(1_000_000)
    .default(DEFAULT_WEB_FETCH_LIMITS.maxTextCharacters),
  KAIROS_WEB_FETCH_MAX_REDIRECTS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10)
    .default(DEFAULT_WEB_FETCH_LIMITS.maxRedirects),
  KAIROS_MCP_CONFIG: z.string().min(1).optional(),
  KAIROS_WEB_SEARCH_PROVIDER: z.enum(['searxng', 'brave']).optional(),
  KAIROS_WEB_SEARCH_SEARXNG_URL: z.string().min(1).optional(),
  KAIROS_WEB_SEARCH_BRAVE_URL: z.string().min(1).optional(),
  KAIROS_WEB_SEARCH_BRAVE_API_KEY: z.string().min(1).optional(),
  KAIROS_WEB_SEARCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(120_000)
    .default(DEFAULT_WEB_SEARCH_LIMITS.timeoutMs),
  KAIROS_WEB_SEARCH_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .default(DEFAULT_WEB_SEARCH_LIMITS.maxResponseBytes),
  KAIROS_WEB_SEARCH_MAX_REQUESTS_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .max(10_000)
    .default(DEFAULT_WEB_SEARCH_LIMITS.maxRequestsPerMinute),
});

export interface ModelConfigurationStatus {
  providerId: string;
  modelId: string;
  contextCapacity: number;
  outputReserve: number;
  available: boolean;
  configurationErrors: Array<{ code: string; message: string }>;
}

export interface ServerModelConfiguration {
  configurationId: string;
  provider: EstimatingModelProvider;
  status: ModelConfigurationStatus;
  countTokens: (request: ModelRequest) => number;
}

function readModelConfiguration(
  environment: NodeJS.ProcessEnv,
  supportsVision: boolean | undefined,
  apiType: ModelApiType,
  allowedOrigins: readonly string[] | undefined,
): {
  model?: ServerModelConfiguration;
  status: ModelConfigurationStatus;
} {
  const providerId = providerIdForApiType(apiType);
  const configured = [
    'KAIROS_MODEL_API_TYPE',
    'KAIROS_MODEL_BASE_URL',
    'KAIROS_MODEL_API_KEY',
    'KAIROS_MODEL_ID',
    'KAIROS_MODEL_CONTEXT_WINDOW',
    'KAIROS_MODEL_OUTPUT_RESERVE',
    'KAIROS_MODEL_REQUEST_TIMEOUT_MS',
    'KAIROS_MODEL_SUPPORTS_VISION',
  ].some((name) => environment[name] !== undefined && environment[name] !== '');
  if (!configured) {
    return {
      status: {
        providerId: '',
        modelId: '',
        contextCapacity: 1,
        outputReserve: 1,
        available: false,
        configurationErrors: [
          { code: 'model_not_configured', message: 'Model provider is not configured.' },
        ],
      },
    };
  }
  const missing = [
    ['KAIROS_MODEL_BASE_URL', environment.KAIROS_MODEL_BASE_URL],
    ['KAIROS_MODEL_ID', environment.KAIROS_MODEL_ID],
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    return {
      status: {
        providerId,
        modelId: environment.KAIROS_MODEL_ID ?? '',
        contextCapacity: 1,
        outputReserve: 1,
        available: false,
        configurationErrors: missing.map(([name]) => ({
          code: 'missing_setting',
          message: `${name} is required.`,
        })),
      },
    };
  }
  try {
    const provider = createModelProvider(
      apiType,
      {
        baseUrl: environment.KAIROS_MODEL_BASE_URL ?? '',
        model: environment.KAIROS_MODEL_ID ?? '',
        ...(environment.KAIROS_MODEL_API_KEY ? { apiKey: environment.KAIROS_MODEL_API_KEY } : {}),
        contextWindow: Number(environment.KAIROS_MODEL_CONTEXT_WINDOW ?? 128_000),
        outputReserve: Number(environment.KAIROS_MODEL_OUTPUT_RESERVE ?? 4096),
        ...(environment.KAIROS_MODEL_REQUEST_TIMEOUT_MS
          ? { requestTimeoutMs: Number(environment.KAIROS_MODEL_REQUEST_TIMEOUT_MS) }
          : {}),
        ...(supportsVision === undefined ? {} : { supportsVision }),
      },
      modelFetch(allowedOrigins ?? []),
    );
    const status: ModelConfigurationStatus = {
      providerId,
      modelId: provider.model,
      contextCapacity: provider.contextWindow,
      outputReserve: provider.outputReserve,
      available: true,
      configurationErrors: [],
    };
    return {
      model: {
        configurationId: createHash('sha256')
          .update(
            JSON.stringify({
              baseUrl: environment.KAIROS_MODEL_BASE_URL,
              modelId: provider.model,
              context: provider.contextWindow,
              output: provider.outputReserve,
              vision: supportsVision,
              ...(apiType === ModelApiType.OPENAI_CHAT_COMPLETIONS ? {} : { apiType }),
            }),
          )
          .digest('hex'),
        provider,
        status,
        countTokens: (request) => provider.estimateRequestTokens(request),
      },
      status,
    };
  } catch {
    return {
      status: {
        providerId,
        modelId: environment.KAIROS_MODEL_ID ?? '',
        contextCapacity: 1,
        outputReserve: 1,
        available: false,
        configurationErrors: [
          {
            code: 'invalid_model_configuration',
            message: 'Model URL, context capacity, output reserve or timeout is invalid.',
          },
        ],
      },
    };
  }
}

export function readPeriodicRecapConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PeriodicRecapConfiguration {
  const config = environmentSchema.parse(environment);
  return {
    triggerMessages: config.KAIROS_RECAP_PERIODIC_TRIGGER_MESSAGES,
    idleAfterMs: config.KAIROS_RECAP_PERIODIC_IDLE_AFTER_MS,
    maxMessages: config.KAIROS_RECAP_PERIODIC_MAX_MESSAGES,
  };
}

export function readSqlRecallConfig(environment: NodeJS.ProcessEnv = process.env): SqlRecallLimits {
  const config = environmentSchema.parse(environment);
  return {
    timeoutMs: config.KAIROS_RECALL_SQL_TIMEOUT_MS,
    maxRows: config.KAIROS_RECALL_SQL_MAX_ROWS,
    maxCellCharacters: config.KAIROS_RECALL_SQL_MAX_CELL_CHARACTERS,
    maxResponseBytes: config.KAIROS_RECALL_SQL_MAX_RESPONSE_BYTES,
    maxSnapshotBytes: config.KAIROS_RECALL_SQL_MAX_SNAPSHOT_BYTES,
    maxJavaScriptHeapMb: config.KAIROS_RECALL_SQL_MAX_JAVASCRIPT_HEAP_MB,
    maxSqliteMemoryBytes: config.KAIROS_RECALL_SQL_MAX_SQLITE_MEMORY_BYTES,
    maxSqliteValueBytes: config.KAIROS_RECALL_SQL_MAX_SQLITE_VALUE_BYTES,
    maxConcurrentProcesses: config.KAIROS_RECALL_SQL_MAX_CONCURRENT_PROCESSES,
    maxIpcBytes: config.KAIROS_RECALL_SQL_MAX_IPC_BYTES,
  };
}

export function readMcpConfig(environment: NodeJS.ProcessEnv = process.env): McpServerConfig[] {
  const config = environmentSchema.parse(environment);
  if (config.KAIROS_MCP_CONFIG === undefined) return [];
  return loadMcpServerConfigs(config.KAIROS_MCP_CONFIG);
}

export function readWebConfig(environment: NodeJS.ProcessEnv = process.env): WebToolOptions {
  const config = environmentSchema.parse(environment);
  const web: WebToolOptions = {
    fetch: {
      timeoutMs: config.KAIROS_WEB_FETCH_TIMEOUT_MS,
      maxResponseBytes: config.KAIROS_WEB_FETCH_MAX_RESPONSE_BYTES,
      maxTextCharacters: config.KAIROS_WEB_FETCH_MAX_TEXT_CHARACTERS,
      maxRedirects: config.KAIROS_WEB_FETCH_MAX_REDIRECTS,
    },
    searchLimits: {
      timeoutMs: config.KAIROS_WEB_SEARCH_TIMEOUT_MS,
      maxResponseBytes: config.KAIROS_WEB_SEARCH_MAX_RESPONSE_BYTES,
      maxRequestsPerMinute: config.KAIROS_WEB_SEARCH_MAX_REQUESTS_PER_MINUTE,
    },
  };
  const provider = config.KAIROS_WEB_SEARCH_PROVIDER;
  const searxngUrl = config.KAIROS_WEB_SEARCH_SEARXNG_URL;
  const braveUrl = config.KAIROS_WEB_SEARCH_BRAVE_URL;
  const braveApiKey = config.KAIROS_WEB_SEARCH_BRAVE_API_KEY;
  if (!provider) {
    if (searxngUrl || braveUrl || braveApiKey) {
      throw new Error(
        'KAIROS_WEB_SEARCH_PROVIDER is required when a search endpoint or credential is configured.',
      );
    }
    return web;
  }
  if (provider === 'searxng') {
    if (!searxngUrl) {
      throw new Error('KAIROS_WEB_SEARCH_SEARXNG_URL is required for SearXNG.');
    }
    if (braveUrl || braveApiKey) {
      throw new Error('Brave settings cannot be combined with the SearXNG provider.');
    }
    return {
      ...web,
      search: {
        provider,
        baseUrl: readWebSearchUrl(searxngUrl, provider),
      },
    };
  }
  if (!braveApiKey?.trim()) {
    throw new Error('KAIROS_WEB_SEARCH_BRAVE_API_KEY is required for Brave.');
  }
  if (searxngUrl) {
    throw new Error('SearXNG settings cannot be combined with the Brave provider.');
  }
  return {
    ...web,
    search: {
      provider,
      baseUrl: readWebSearchUrl(
        braveUrl ?? 'https://api.search.brave.com/res/v1/web/search',
        provider,
      ),
      apiKey: braveApiKey,
    },
  };
}

function readWebSearchUrl(value: string, provider: 'searxng' | 'brave'): string {
  const variable =
    provider === 'searxng' ? 'KAIROS_WEB_SEARCH_SEARXNG_URL' : 'KAIROS_WEB_SEARCH_BRAVE_URL';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} must be a valid HTTP(S) search endpoint.`);
  }
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (provider === 'brave' && url.protocol !== 'https:' && !isLoopbackHost(hostname))
  ) {
    throw new Error(
      `${variable} must not contain credentials, query or fragment; Brave requires HTTPS except on loopback.`,
    );
  }
  return url.toString();
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host.toLowerCase() === 'localhost';
}

function readPublicOrigin(configured: string): string {
  const url = new URL(configured);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'http:' && url.protocol !== 'https:')
  ) {
    throw new Error(
      'KAIROS_PUBLIC_ORIGIN must be an HTTP(S) origin without a path or credentials.',
    );
  }
  return url.origin;
}

function readMainEnvironmentConfiguration(
  envId: string | undefined,
  workspace: string | undefined,
) {
  const resolvedEnvId = envId ?? 'main';
  if (!/^[0-9A-Za-z._:-]{1,200}$/.test(resolvedEnvId)) {
    throw new Error('KAIROS_MAIN_ENV_ID must be a valid environment identifier.');
  }
  const resolvedWorkspace = workspace ?? process.cwd();
  if (!isAbsolute(resolvedWorkspace)) {
    throw new Error('KAIROS_MAIN_WORKSPACE must be an absolute path.');
  }
  return { envId: resolvedEnvId, workspace: resolvedWorkspace };
}

export function readServerConfig(environment: NodeJS.ProcessEnv = process.env) {
  const config = environmentSchema.parse(environment);
  const mainEnvironment = readMainEnvironmentConfiguration(
    config.KAIROS_MAIN_ENV_ID,
    config.KAIROS_MAIN_WORKSPACE,
  );
  const modelApiType = {
    openai_chat_completions: ModelApiType.OPENAI_CHAT_COMPLETIONS,
    openai_responses: ModelApiType.OPENAI_RESPONSES,
    anthropic_messages: ModelApiType.ANTHROPIC_MESSAGES,
  }[config.KAIROS_MODEL_API_TYPE];
  const model = readModelConfiguration(
    environment,
    config.KAIROS_MODEL_SUPPORTS_VISION,
    modelApiType,
    config.KAIROS_MODEL_ALLOWED_ORIGINS,
  );
  return {
    host: config.KAIROS_HOST,
    port: config.KAIROS_PORT,
    trustedProxies: config.KAIROS_TRUSTED_PROXIES ?? [],
    dataDirectory: config.KAIROS_DATA_DIR,
    mainEnvironment,
    daemonReleaseDirectory:
      config.KAIROS_DAEMON_RELEASE_DIR ??
      fileURLToPath(new URL('../../../dist/releases', import.meta.url)),
    auth: {
      enabled: config.KAIROS_AUTH_ENABLED === 'true',
      secret: config.KAIROS_AUTH_SECRET,
      allowedOrigin: config.KAIROS_PUBLIC_ORIGIN
        ? readPublicOrigin(config.KAIROS_PUBLIC_ORIGIN)
        : null,
      secureCookies: config.KAIROS_PUBLIC_ORIGIN?.startsWith('https:') ?? false,
    },
    maxRpcBytes: config.KAIROS_MAX_RPC_BYTES,
    maxEventQueue: config.KAIROS_MAX_EVENT_QUEUE,
    maxActiveThreads: config.KAIROS_MAX_ACTIVE_THREADS,
    maxConcurrentModelRequests: config.KAIROS_MAX_CONCURRENT_MODEL_REQUESTS,
    maxStepsPerRun: config.KAIROS_MAX_STEPS_PER_RUN,
    memory: {
      directory: config.KAIROS_MEMORY_DIR ?? join(homedir(), '.kairos', 'memory'),
      indexMaxBytes: config.KAIROS_MEMORY_INDEX_MAX_BYTES,
    } satisfies MemoryConfiguration,
    log: {
      directory: config.KAIROS_LOG_DIR ?? join(homedir(), '.kairos', 'log'),
    },
    memoryDreamEnabled: config.KAIROS_MEMORY_DREAM_ENABLED === 'true',
    periodicRecap: readPeriodicRecapConfig(environment),
    sqlRecall: readSqlRecallConfig(environment),
    web: readWebConfig(environment),
    mcp: readMcpConfig(environment),
    model: model.model,
    modelStatus: model.status,
    modelAllowedOrigins: config.KAIROS_MODEL_ALLOWED_ORIGINS,
  };
}
