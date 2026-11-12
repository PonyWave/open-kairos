import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase } from '../storage/sqlite-backup.js';
import { inTransaction } from '../storage/transaction.js';
import {
  assertControlSourcePath as assertSourcePath,
  assertControlSourceUnchanged as assertUnchanged,
  inspectControlDatabase as inspect,
  inspectPlatformControlFile,
  controlSourceRevision as sourceRevision,
  controlFileSuffixes as suffixes,
  createControlWorkingCopy as workingCopy,
} from './control-files.js';
import {
  DEFAULT_PLATFORM_IDLE_TIMEOUT_MS,
  PLATFORM_CONTROL_SCHEMA_VERSION,
  type PlatformControlInspection,
} from './control-schema.js';

export interface PlatformControlMigrationResult {
  status: 'current' | 'migration_required' | 'migrated';
  databasePath: string;
  currentVersion: number;
  requiredVersion: number;
  backupPath?: string;
}

function result(
  databasePath: string,
  inspection: PlatformControlInspection,
): PlatformControlMigrationResult {
  return {
    status:
      inspection.version === PLATFORM_CONTROL_SCHEMA_VERSION ? 'current' : 'migration_required',
    databasePath,
    currentVersion: inspection.version,
    requiredVersion: PLATFORM_CONTROL_SCHEMA_VERSION,
  };
}

/** SQLite recovery is confined to a disposable copy, including for checks and no-ops. */
export async function checkPlatformControlDatabaseFile(
  path: string,
): Promise<PlatformControlMigrationResult> {
  return result(path, inspectPlatformControlFile(path));
}

function verifyBackup(path: string): void {
  const database = new DatabaseSync(path);
  try {
    inspect(database);
    if (database.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete')
      throw new Error('Platform control backup could not be made self-contained.');
  } finally {
    database.close();
  }
  for (const suffix of ['-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
}

function replaceSource(path: string, target: string): void {
  const original = join(dirname(path), `.kairos-control-migration-${randomUUID()}.original`);
  const moved: string[] = [];
  let mainMoved = false;
  let targetMoved = false;
  try {
    for (const suffix of ['-wal', '-shm']) {
      if (!existsSync(`${path}${suffix}`)) continue;
      renameSync(`${path}${suffix}`, `${original}${suffix}`);
      moved.push(suffix);
    }
    renameSync(path, original);
    mainMoved = true;
    renameSync(target, path);
    targetMoved = true;
  } catch (error) {
    try {
      if (targetMoved) rmSync(path, { force: true });
      if (mainMoved) renameSync(original, path);
      for (const suffix of moved) renameSync(`${original}${suffix}`, `${path}${suffix}`);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Control database replacement and rollback failed.',
      );
    }
    throw error;
  }
  rmSync(original, { force: true });
  for (const suffix of moved) rmSync(`${original}${suffix}`, { force: true });
}

/** All deployments sharing this file must be stopped before invoking migration. */
export async function migratePlatformControlDatabaseFile(options: {
  path: string;
  backupDirectory: string;
  now?: () => Date;
}): Promise<PlatformControlMigrationResult> {
  const { path, backupDirectory } = options;
  assertSourcePath(path);
  if (!isAbsolute(backupDirectory)) throw new Error('An absolute backup directory is required.');
  const original = sourceRevision(path);
  const work = workingCopy(path);
  let source: DatabaseSync | undefined;
  let targetPath: string | undefined;
  try {
    assertUnchanged(path, original);
    source = new DatabaseSync(work.path);
    const inspection = inspect(source);
    if (inspection.version === PLATFORM_CONTROL_SCHEMA_VERSION) {
      assertUnchanged(path, original);
      return result(path, inspection);
    }

    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const backupPath = join(
      backupDirectory,
      `platform-control-pre-migration-${randomUUID()}.sqlite`,
    );
    closeSync(openSync(backupPath, 'wx', 0o600));
    try {
      await backupDatabase(source, backupPath);
      chmodSync(backupPath, 0o600);
      verifyBackup(backupPath);
    } catch (error) {
      for (const suffix of suffixes) rmSync(`${backupPath}${suffix}`, { force: true });
      throw error;
    }

    targetPath = join(dirname(path), `.kairos-control-migration-${randomUUID()}.sqlite`);
    copyFileSync(backupPath, targetPath, constants.COPYFILE_EXCL);
    chmodSync(targetPath, 0o600);
    const target = new DatabaseSync(targetPath);
    try {
      inTransaction(target, () => {
        target.exec('ALTER TABLE platform_control_environments ADD COLUMN idle_since TEXT;');
        target.exec(
          `ALTER TABLE platform_control_meta ADD COLUMN idle_timeout_ms INTEGER NOT NULL DEFAULT ${DEFAULT_PLATFORM_IDLE_TIMEOUT_MS} CHECK(idle_timeout_ms >= 0);`,
        );
        target
          .prepare(
            `UPDATE platform_control_environments SET idle_since=?
             WHERE state='running' AND current_operation_id IS NULL AND NOT EXISTS (
               SELECT 1 FROM platform_control_uses u
               WHERE u.deployment_id=platform_control_environments.deployment_id
                 AND u.env_id=platform_control_environments.env_id
             )`,
          )
          .run((options.now?.() ?? new Date()).toISOString());
        target.exec(`PRAGMA user_version=${PLATFORM_CONTROL_SCHEMA_VERSION};`);
        inspect(target);
      });
    } finally {
      target.close();
    }
    source.close();
    assertUnchanged(path, original);
    replaceSource(path, targetPath);
    targetPath = undefined;
    return {
      status: 'migrated',
      databasePath: path,
      currentVersion: PLATFORM_CONTROL_SCHEMA_VERSION,
      requiredVersion: PLATFORM_CONTROL_SCHEMA_VERSION,
      backupPath,
    };
  } finally {
    if (source?.isOpen) source.close();
    if (targetPath)
      for (const suffix of suffixes) rmSync(`${targetPath}${suffix}`, { force: true });
    rmSync(work.directory, { recursive: true, force: true });
  }
}
