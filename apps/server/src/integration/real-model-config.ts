export interface RealModelConfig {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  contextWindow: number;
  outputReserve: number;
  requestTimeoutMs: number;
}

export const REAL_MODEL_DEFAULTS = {
  baseUrl: 'https://free-tokens.msh.team/v1',
  modelId: 'coding-model-1102rc2',
  contextWindow: 128_000,
  outputReserve: 512,
  requestTimeoutMs: 120_000,
} as const;

export function readRealModelConfig(environment: NodeJS.ProcessEnv = process.env): RealModelConfig {
  const apiKey = environment.KAIROS_MODEL_API_KEY;
  if (!apiKey) {
    throw new Error('Real model configuration is incomplete: KAIROS_MODEL_API_KEY');
  }
  return {
    baseUrl: environment.KAIROS_MODEL_BASE_URL || REAL_MODEL_DEFAULTS.baseUrl,
    apiKey,
    modelId: environment.KAIROS_MODEL_ID || REAL_MODEL_DEFAULTS.modelId,
    contextWindow: positiveEnvironment(
      environment,
      'KAIROS_MODEL_CONTEXT_WINDOW',
      REAL_MODEL_DEFAULTS.contextWindow,
    ),
    outputReserve: positiveEnvironment(
      environment,
      'KAIROS_MODEL_OUTPUT_RESERVE',
      REAL_MODEL_DEFAULTS.outputReserve,
    ),
    requestTimeoutMs: positiveEnvironment(
      environment,
      'KAIROS_MODEL_REQUEST_TIMEOUT_MS',
      REAL_MODEL_DEFAULTS.requestTimeoutMs,
    ),
  };
}

function positiveEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = Number(environment[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}
