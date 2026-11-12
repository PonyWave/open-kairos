import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { REAL_MODEL_DEFAULTS } from './real-model-config.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

async function readWithEnvFile(
  envFile: string,
  overrides: Record<string, string> = {},
): Promise<unknown> {
  const moduleUrl = new URL('./real-model-config.ts', import.meta.url).href;
  const expression = `
    import { readRealModelConfig } from ${JSON.stringify(moduleUrl)};
    const config = readRealModelConfig();
    const apiKeySource = config.apiKey === 'process-fictional-key'
      ? 'process'
      : config.apiKey === 'env-file-fictional-key'
        ? 'env-file'
        : 'other';
    process.stdout.write(JSON.stringify({
      baseUrl: config.baseUrl,
      modelId: config.modelId,
      contextWindow: config.contextWindow,
      outputReserve: config.outputReserve,
      requestTimeoutMs: config.requestTimeoutMs,
      apiKeySource,
    }));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      `--env-file-if-exists=${envFile}`,
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      expression,
    ],
    {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...overrides,
      },
    },
  );
  return JSON.parse(stdout);
}

it('applies process environment, env-file and test defaults in priority order without model requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-real-model-config-'));
  const envFile = join(directory, 'fictional.env');
  try {
    await writeFile(
      envFile,
      [
        'KAIROS_MODEL_BASE_URL=https://env-file.invalid/v1',
        'KAIROS_MODEL_ID=env-file-model',
        'KAIROS_MODEL_API_KEY=env-file-fictional-key',
        'KAIROS_MODEL_CONTEXT_WINDOW=9000',
        'KAIROS_MODEL_OUTPUT_RESERVE=700',
        'KAIROS_MODEL_REQUEST_TIMEOUT_MS=45000',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    expect(await readWithEnvFile(envFile)).toEqual({
      baseUrl: 'https://env-file.invalid/v1',
      modelId: 'env-file-model',
      contextWindow: 9000,
      outputReserve: 700,
      requestTimeoutMs: 45_000,
      apiKeySource: 'env-file',
    });

    expect(
      await readWithEnvFile(envFile, {
        KAIROS_MODEL_BASE_URL: 'https://process.invalid/v2',
        KAIROS_MODEL_ID: 'process-model',
        KAIROS_MODEL_API_KEY: 'process-fictional-key',
        KAIROS_MODEL_CONTEXT_WINDOW: '64000',
        KAIROS_MODEL_OUTPUT_RESERVE: '4096',
        KAIROS_MODEL_REQUEST_TIMEOUT_MS: '90000',
      }),
    ).toEqual({
      baseUrl: 'https://process.invalid/v2',
      modelId: 'process-model',
      contextWindow: 64_000,
      outputReserve: 4096,
      requestTimeoutMs: 90_000,
      apiKeySource: 'process',
    });

    expect(
      await readWithEnvFile(join(directory, 'missing.env'), {
        KAIROS_MODEL_API_KEY: 'process-fictional-key',
      }),
    ).toEqual({ ...REAL_MODEL_DEFAULTS, apiKeySource: 'process' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
