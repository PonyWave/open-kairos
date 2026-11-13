import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GlobAction, GrepAction, ServerMessageInit } from '@kairos/contracts/device';
import { decodeServerMessage, encodeServerMessage, GrepMode } from '@kairos/contracts/device';
import { afterAll, describe, expect, it } from 'vitest';
import { FileOperationCancelled } from './files.js';
import { runRemoteGlob, runRemoteGrep } from './search.js';

type OperationAction = Extract<
  ServerMessageInit['payload'],
  { case: 'operationStart' }
>['value']['action'];

function action(
  kind: 'glob',
  value: Extract<OperationAction, { case: 'glob' }>['value'],
): GlobAction;
function action(
  kind: 'grep',
  value: Extract<OperationAction, { case: 'grep' }>['value'],
): GrepAction;
function action(kind: 'glob' | 'grep', value: unknown): GlobAction | GrepAction {
  const message = decodeServerMessage(
    encodeServerMessage({
      payload: {
        case: 'operationStart',
        value: {
          operationId: 'operation-search',
          requestId: 'request-search',
          target: {
            envId: 'env',
            deviceBindingId: 'binding',
            instanceId: 'instance',
            bindingVersion: 1n,
          },
          expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 60), nanos: 0 },
          action: { case: kind, value } as NonNullable<OperationAction>,
        },
      },
    }),
  );
  if (message.payload.case !== 'operationStart' || message.payload.value.action.case !== kind) {
    throw new Error('Search action fixture is invalid.');
  }
  return message.payload.value.action.value as never;
}

function rgAvailable(): boolean {
  try {
    execFileSync(process.env.KAIROS_RG_PATH ?? 'rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasRg = rgAvailable();
const directory = mkdtempSync(join(tmpdir(), 'kairos-search-test-'));

mkdirSync(join(directory, 'src', 'nested'), { recursive: true });
mkdirSync(join(directory, '.git'), { recursive: true });
writeFileSync(join(directory, 'src', 'alpha.ts'), 'const needle = 1;\nexport { needle };\n');
writeFileSync(join(directory, 'src', 'nested', 'beta.ts'), 'const other = 2;\n');
writeFileSync(join(directory, 'README.md'), 'needle in markdown\n');
writeFileSync(join(directory, '.git', 'ignored.ts'), 'const needle = 3;\n');

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('runRemoteGlob', () => {
  it.skipIf(!hasRg)('matches files by glob and excludes version-control directories', async () => {
    const outcome = await runRemoteGlob(
      action('glob', { pattern: '**/*.ts', path: directory, cwd: directory }),
      new AbortController().signal,
    );
    expect(outcome.path).toBe(realpathSync(directory));
    const files = outcome.files ?? [];
    expect(files.some((file) => file.endsWith('alpha.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('beta.ts'))).toBe(true);
    expect(files.some((file) => file.includes('.git'))).toBe(false);
    expect(outcome.truncated).toBe(false);
  });

  it.skipIf(!hasRg)('applies offset and head limit', async () => {
    const first = await runRemoteGlob(
      action('glob', { pattern: '**/*.ts', path: directory, cwd: directory, headLimit: 1 }),
      new AbortController().signal,
    );
    const second = await runRemoteGlob(
      action('glob', {
        pattern: '**/*.ts',
        path: directory,
        cwd: directory,
        headLimit: 1,
        offset: 1,
      }),
      new AbortController().signal,
    );
    expect(first.files).toHaveLength(1);
    expect(second.files).toHaveLength(1);
    expect(first.files?.[0]).not.toEqual(second.files?.[0]);
    expect(first.truncated).toBe(true);
  });

  it('rejects a missing search path', async () => {
    await expect(
      runRemoteGlob(
        action('glob', { pattern: '*.ts', path: join(directory, 'absent'), cwd: directory }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Search path cannot be inspected.');
  });
});

describe('runRemoteGrep', () => {
  it.skipIf(!hasRg)('returns matching lines with file and line number', async () => {
    const outcome = await runRemoteGrep(
      action('grep', {
        pattern: 'needle',
        path: directory,
        cwd: directory,
        caseInsensitive: false,
        mode: GrepMode.CONTENT,
        lineNumbers: true,
      }),
      new AbortController().signal,
    );
    const matches = outcome.matches ?? [];
    const files = matches.map((match) => match.file ?? '');
    expect(files.some((file) => file.endsWith('alpha.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('README.md'))).toBe(true);
    expect(files.some((file) => file.includes('.git'))).toBe(false);
    const alpha = matches.find((match) => match.file?.endsWith('alpha.ts'));
    expect(alpha?.line).toBe(1);
    expect(alpha?.text).toContain('needle');
  });

  it.skipIf(!hasRg)('lists files with matches', async () => {
    const outcome = await runRemoteGrep(
      action('grep', {
        pattern: 'needle',
        path: directory,
        cwd: directory,
        caseInsensitive: false,
        mode: GrepMode.FILES_WITH_MATCHES,
        lineNumbers: true,
      }),
      new AbortController().signal,
    );
    expect((outcome.files ?? []).some((file) => file.endsWith('alpha.ts'))).toBe(true);
    expect(outcome.matches ?? []).toHaveLength(0);
  });

  it.skipIf(!hasRg)('counts matches per file', async () => {
    const outcome = await runRemoteGrep(
      action('grep', {
        pattern: 'needle',
        path: directory,
        cwd: directory,
        caseInsensitive: false,
        mode: GrepMode.COUNT,
        lineNumbers: true,
      }),
      new AbortController().signal,
    );
    const alpha = (outcome.counts ?? []).find((entry) => entry.file?.endsWith('alpha.ts'));
    expect(alpha?.count).toBe(2n);
  });

  it.skipIf(!hasRg)('filters by include glob and case', async () => {
    const outcome = await runRemoteGrep(
      action('grep', {
        pattern: 'NEEDLE',
        path: directory,
        cwd: directory,
        include: '*.ts',
        caseInsensitive: true,
        mode: GrepMode.FILES_WITH_MATCHES,
        lineNumbers: true,
      }),
      new AbortController().signal,
    );
    const files = outcome.files ?? [];
    expect(files.some((file) => file.endsWith('alpha.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('README.md'))).toBe(false);
  });

  it.skipIf(!hasRg)('returns an empty outcome when nothing matches', async () => {
    const outcome = await runRemoteGrep(
      action('grep', {
        pattern: 'absent-pattern-zzz',
        path: directory,
        cwd: directory,
        caseInsensitive: false,
        mode: GrepMode.CONTENT,
        lineNumbers: true,
      }),
      new AbortController().signal,
    );
    expect(outcome.matches ?? []).toHaveLength(0);
    expect(outcome.truncated).toBe(false);
  });

  it('honours cancellation before start', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runRemoteGrep(
        action('grep', {
          pattern: 'needle',
          path: directory,
          cwd: directory,
          caseInsensitive: false,
          mode: GrepMode.CONTENT,
          lineNumbers: true,
        }),
        controller.signal,
      ),
    ).rejects.toThrow(FileOperationCancelled);
  });
});
