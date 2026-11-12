import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionMigrations } from '../sessions/migrations.js';
import { openDatabase } from '../storage/database.js';
import { deviceMigrations, environmentOperationMigrations } from '../storage/device-migrations.js';
import { contextRecapMigrations, migrateDatabase } from '../storage/migrations.js';
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

describe('baseline installation', () => {
  it('installs every namespace at its final version on a fresh database', () => {
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
      const expectedVersions: Record<string, number> = {
        context_recap: 2,
        server_runtime: 2,
        devices: 1,
        environment_operations: 1,
      };
      for (const inspection of inspections) {
        expect(inspection.currentVersion).toBe(expectedVersions[inspection.namespace]);
        expect(inspection.requiredVersion).toBe(expectedVersions[inspection.namespace]);
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

describe('migration command on the installed baseline', () => {
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
    expect(
      checked.namespaces.every(
        (namespace) => namespace.currentVersion === namespace.requiredVersion,
      ),
    ).toBe(true);

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

  it('upgrades a v1 database to v2 and preserves existing rows', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'kairos.sqlite');
    const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    migrateDatabase(
      database,
      contextRecapMigrations.filter((migration) => migration.version === 1),
      'context_recap',
    );
    migrateDatabase(
      database,
      sessionMigrations.filter((migration) => migration.version === 1),
      'server_runtime',
    );
    migrateDatabase(database, deviceMigrations, 'devices');
    migrateDatabase(database, environmentOperationMigrations, 'environment_operations');
    database
      .prepare(
        `INSERT INTO context_messages(
          message_id, thread_id, agent_id, role, content, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('legacy-v1-message', 'thread', 'agent', 'user', 'v1 消息', '2026-11-01T00:00:00.000Z');
    database.close();

    const result = await upgradeDatabaseFile({
      dataDirectory,
      backupDirectory: join(dataDirectory, 'backups'),
    });
    expect(result.status).toBe('migrated');
    expect(result.backupPath).toBeDefined();

    const upgraded = openDatabase(databasePath);
    try {
      for (const inspection of inspectServerDatabase(upgraded)) {
        expect(inspection.kind).toBe('current');
        expect(inspection.currentVersion).toBe(inspection.requiredVersion);
      }
      expect(
        upgraded.prepare('SELECT message_id, content, channel_json FROM context_messages').all(),
      ).toEqual([{ message_id: 'legacy-v1-message', content: 'v1 消息', channel_json: null }]);
      expect(
        upgraded
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'channel_deliveries'")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      upgraded.close();
    }
  });
});
