import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase, SchemaMigrationRequiredError } from './migrations.js';
import { assertServerDatabaseCompatible } from './server-schema.js';

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  try {
    database.exec('PRAGMA busy_timeout = 5000;');
    assertServerDatabaseCompatible(database);
    migrateDatabase(database);
    if (path !== ':memory:') chmodSync(path, 0o600);
    database.exec('PRAGMA journal_mode = WAL;');
    return database;
  } catch (error) {
    database.close();
    if (error instanceof SchemaMigrationRequiredError && path !== ':memory:') {
      const dataDirectory = dirname(path);
      const command = `node apps/server/dist/migrate.js --data-dir ${JSON.stringify(dataDirectory)} --backup-dir ${JSON.stringify(join(dataDirectory, 'backups'))}`;
      throw new Error(`${error.message} Stop Server and run: ${command}`, { cause: error });
    }
    throw error;
  }
}
