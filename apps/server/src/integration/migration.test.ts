import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../storage/database.js';
import { inspectServerDatabase, migrateServerDatabase } from '../storage/server-schema.js';
import { checkDatabaseFile, upgradeDatabaseFile } from '../storage/upgrades.js';

const directories: string[] = [];

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'kairos-migration-'));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fileHash(path: string): string {
  return createHash('sha256').update(require('node:fs').readFileSync(path)).digest('hex');
}

describe('v1 baseline installation', () => {
  it('installs every namespace at version 1 on a fresh database', () => {
    const database = openDatabase(':memory:');
    try {
      migrateServerDatabase(database);
      const inspections = inspectServerDatabase(database);
      expect(inspections.map((inspection) => inspection.namespace).sort()).toEqual([
        'context_recap',
        'devices',
        'environment_operations',
        'server_runtime',
      ]);
      for (const inspection of inspections) {
        expect(inspection.currentVersion).toBe(1);
        expect(inspection.requiredVersion).toBe(1);
        expect(inspection.kind).toBe('current');
      }
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'device_bash_operations'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'platform_environments'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM pragma_table_info('environments') WHERE name = 'platform_lifecycle_state'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('is idempotent on an already installed database', () => {
    const database = openDatabase(':memory:');
    try {
      migrateServerDatabase(database);
      migrateServerDatabase(database);
      for (const inspection of inspectServerDatabase(database)) {
        expect(inspection.kind).toBe('current');
      }
    } finally {
      database.close();
    }
  });
});

describe('migration command on the v1 baseline', () => {
  it('reports missing databases without creating files', async () => {
    const dataDirectory = directory();
    const result = await upgradeDatabaseFile({
      dataDirectory,
      backupDirectory: join(dataDirectory, 'backups'),
    });
    expect(result.status).toBe('missing');
    expect(existsSync(join(dataDirectory, 'kairos.sqlite'))).toBe(false);
    expect(checkDatabaseFile(join(dataDirectory, 'kairos.sqlite')).status).toBe('missing');
  });

  it('reports current databases without backups or modifications', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'kairos.sqlite');
    const database = openDatabase(databasePath);
    migrateServerDatabase(database);
    database.close();
    const hash = fileHash(databasePath);

    const checked = checkDatabaseFile(databasePath);
    expect(checked.status).toBe('current');
    expect(checked.namespaces.every((namespace) => namespace.currentVersion === 1)).toBe(true);

    const result = await upgradeDatabaseFile({
      dataDirectory,
      backupDirectory: join(dataDirectory, 'backups'),
    });
    expect(result.status).toBe('current');
    expect(result.backupPath).toBeUndefined();
    expect(existsSync(join(dataDirectory, 'backups'))).toBe(false);
    expect(fileHash(databasePath)).toBe(hash);
  });

  it('rejects databases newer than this Server', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'kairos.sqlite');
    const database = openDatabase(databasePath);
    database
      .prepare(
        "INSERT INTO schema_migrations(namespace, version, name, applied_at) VALUES ('context_recap', 99, 'future', '2026-01-01T00:00:00.000Z')",
      )
      .run();
    database.close();
    expect(() => checkDatabaseFile(databasePath)).toThrowError(/newer than this Server/);
    await expect(
      upgradeDatabaseFile({ dataDirectory, backupDirectory: join(dataDirectory, 'backups') }),
    ).rejects.toThrowError(/newer than this Server/);
  });

  it('rejects databases with unversioned application tables', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'kairos.sqlite');
    const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    database.exec('CREATE TABLE legacy_data(id TEXT PRIMARY KEY);');
    database.close();
    expect(() => checkDatabaseFile(databasePath)).toThrowError(
      /unsupported application table legacy_data/,
    );
    await expect(
      upgradeDatabaseFile({ dataDirectory, backupDirectory: join(dataDirectory, 'backups') }),
    ).rejects.toThrowError(/unsupported application table legacy_data/);
  });
});
