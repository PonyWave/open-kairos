import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { z } from 'zod';

const executeFile = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const reportSchema = z
  .object({
    status: z.literal('failed'),
    checks: z.record(z.string(), z.enum(['passed', 'failed'])),
    failures: z.array(z.string()),
    unverified: z.array(z.string()),
  })
  .passthrough();

it('records Provider startup failure without writing passed or leaking temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-real-recap-lifecycle-'));
  const runtimeDirectory = join(directory, 'runtime');
  const reportPath = join(directory, 'reports', 'startup-failure.json');
  const emptyEnvironment = join(directory, 'empty.env');
  const dummyKey = 'not-a-real-api-key';
  try {
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(emptyEnvironment, '', { mode: 0o600 });
    const failure = await executeFile('bash', ['scripts/real-model.sh', 'recap'], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        KAIROS_MODEL_ENV_FILE: emptyEnvironment,
        KAIROS_RUN_REAL_MODEL: '1',
        KAIROS_MODEL_BASE_URL: 'not-a-url',
        KAIROS_MODEL_API_KEY: dummyKey,
        KAIROS_MODEL_ID: 'lifecycle-regression-model',
        KAIROS_MODEL_CONTEXT_WINDOW: '128000',
        KAIROS_MODEL_OUTPUT_RESERVE: '512',
        KAIROS_MODEL_REQUEST_TIMEOUT_MS: '1000',
        KAIROS_REAL_MODEL_REPORT: reportPath,
        TMPDIR: runtimeDirectory,
      },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeDefined();
    const report = reportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));
    expect(report.status).toBe('failed');
    expect(report.checks).toEqual({});
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('startup:');
    expect(report.failures[0]).toContain('Invalid OpenAI-compatible provider configuration');
    expect(report.unverified).toEqual([
      'real_periodic_prefix_sources_usage_and_context',
      'real_hard_cut_incremental_reuse_fallback_and_budget',
      'provider_cache_read_hit',
    ]);
    expect(JSON.stringify(report)).not.toContain(dummyKey);
    const leftovers = (await readdir(runtimeDirectory)).filter((name) =>
      name.startsWith('kairos-real-periodic-recap-'),
    );
    expect(leftovers).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
