import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const builder = join(repository, 'scripts/build-server-release.mjs');
const smoke = join(repository, 'deploy/server-release-smoke.mjs');
const temporary = mkdtempSync(join(tmpdir(), 'kairos-server-release-test-'));
const output = join(temporary, 'output');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repository,
  encoding: 'utf8',
}).trim();
const release = join(output, commit);

function run(script: string, args: string[]) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, npm_config_offline: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

describe('immutable Server/GUI release', () => {
  beforeAll(() => {
    run(builder, ['--output', output, '--allow-dirty']);
  }, 180_000);

  afterAll(() => {
    rmSync(temporary, { recursive: true, force: true });
  });

  it('contains compiled runtime, GUI, resources and immutable source metadata', () => {
    const metadata = JSON.parse(readFileSync(join(release, 'release.json'), 'utf8')) as {
      version: string;
      sourceCommit: string;
      lockfileSha256: string;
    };
    expect(metadata.version).toBe(commit);
    expect(metadata.sourceCommit).toBe(commit);
    expect(metadata.lockfileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readdirSync(join(release, 'gui'))).toContain('index.html');
    expect(readFileSync(join(release, 'workspace/AGENTS.md'), 'utf8')).toContain('# AGENTS.md');
    expect(readFileSync(join(release, 'caddy/Caddyfile'), 'utf8')).toContain('strip_prefix /api');
    const checksums = readFileSync(join(release, 'SHA256SUMS'), 'utf8');
    expect(checksums).toContain('app/apps/server/dist/main.js');
    expect(checksums).toContain('app/packages/contracts/dist/index.js');
    expect(checksums).toContain('app/packages/agent-core/dist/index.js');
    const packagedPaths = checksums
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(66));
    expect(packagedPaths.every((path) => !/(?:^|\/)\.env(?:\.|$)/.test(path))).toBe(true);
    expect(packagedPaths.every((path) => !path.startsWith('app/apps/server/src/'))).toBe(true);
    expect(
      packagedPaths.every((path) => !path.startsWith('app/apps/server/dist/integration/')),
    ).toBe(true);
    expect(
      packagedPaths.every((path) => !path.startsWith('app/apps/server/dist/attachments/fixtures.')),
    ).toBe(true);
    expect(packagedPaths.every((path) => !path.startsWith('reference/'))).toBe(true);
  });

  it('starts the compiled Server in a clean directory and shuts it down', () => {
    const result = JSON.parse(run(smoke, [release])) as {
      cleanDirectory: string;
      compiledServerHealth: { service: string; status: string };
      gracefulShutdown: string;
    };
    expect(result.cleanDirectory).toBe('passed');
    expect(result.compiledServerHealth).toMatchObject({ service: 'kairos-server', status: 'ok' });
    expect(result.gracefulShutdown).toBe('passed');
  }, 60_000);

  it('refuses to overwrite the same commit path', () => {
    expect(() => run(builder, ['--output', output, '--allow-dirty'])).toThrow(
      /Refusing to overwrite immutable release directory/,
    );
  });

  it('rejects modified release content before startup', () => {
    const modified = join(temporary, 'modified');
    cpSync(release, modified, { recursive: true, dereference: false });
    appendFileSync(join(modified, 'gui/index.html'), 'modified');
    expect(() => run(smoke, [modified])).toThrow(/Release checksum mismatch/);
  });
});
