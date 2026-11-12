import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  inspectPlatformControlDatabase,
  type PlatformControlInspection,
} from './control-schema.js';

export const controlFileSuffixes = ['', '-wal', '-shm'] as const;

export function inspectControlDatabase(database: DatabaseSync): PlatformControlInspection {
  const expected = new DatabaseSync(':memory:');
  try {
    return inspectPlatformControlDatabase(database, expected);
  } finally {
    expected.close();
  }
}

export function assertControlSourcePath(path: string): void {
  if (!isAbsolute(path) || realpathSync(path) !== path)
    throw new Error(
      'Platform control database path must be absolute and resolve without symlinks.',
    );
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error('Platform control database must be an existing private regular file.');
}

export function controlSourceRevision(path: string): string {
  return JSON.stringify(
    controlFileSuffixes.map((suffix) => {
      const file = `${path}${suffix}`;
      if (!existsSync(file)) return null;
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error('Platform control database sidecars must be regular files.');
      return {
        dev: info.dev,
        ino: info.ino,
        hash: createHash('sha256').update(readFileSync(file)).digest('hex'),
      };
    }),
  );
}

export function assertControlSourceUnchanged(path: string, expected: string): void {
  if (controlSourceRevision(path) !== expected)
    throw new Error(
      'Platform control database changed; stop all Servers using this file and retry.',
    );
}

export function createControlWorkingCopy(path: string): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-control-migration-'));
  try {
    chmodSync(directory, 0o700);
    const target = join(directory, 'control.sqlite');
    for (const suffix of controlFileSuffixes) {
      if (!existsSync(`${path}${suffix}`)) continue;
      copyFileSync(`${path}${suffix}`, `${target}${suffix}`, constants.COPYFILE_EXCL);
      chmodSync(`${target}${suffix}`, 0o600);
    }
    return { directory, path: target };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Even a read-only SQLite connection can update SHM; preflight opens only this copy. */
export function inspectPlatformControlFile(
  path: string,
  options: { requireStableSource?: boolean } = {},
): PlatformControlInspection {
  assertControlSourcePath(path);
  const original = options.requireStableSource === false ? undefined : controlSourceRevision(path);
  const work = createControlWorkingCopy(path);
  let database: DatabaseSync | undefined;
  try {
    if (original !== undefined) assertControlSourceUnchanged(path, original);
    database = new DatabaseSync(work.path);
    const inspection = inspectControlDatabase(database);
    if (original !== undefined) assertControlSourceUnchanged(path, original);
    return inspection;
  } finally {
    database?.close();
    rmSync(work.directory, { recursive: true, force: true });
  }
}
