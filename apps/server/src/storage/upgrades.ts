import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { migrationTableNames } from './migrations.js';
import {
  inspectServerDatabase,
  migrateServerDatabase,
  type ServerMigrationInspection,
  type ServerNamespace,
  serverMigrationPlans,
} from './server-schema.js';
import { backupDatabase } from './sqlite-backup.js';
import { inTransaction } from './transaction.js';

const tableNameRowSchema = z.object({ name: z.string() });
const columnRowSchema = z.object({
  name: z.string(),
  notnull: z.number().int(),
  dflt_value: z.unknown().nullable(),
});
const integrityRowSchema = z.object({ integrity_check: z.string() });

interface ColumnDefinition {
  name: string;
  required: boolean;
  hasDefault: boolean;
}

interface NamespaceStatus {
  namespace: ServerNamespace;
  currentVersion: number;
  requiredVersion: number;
}

interface SourceInspection {
  path: string;
  tables: Set<string>;
  namespaces: ServerMigrationInspection[];
  currentColumns: ReadonlyMap<string, readonly ColumnDefinition[]>;
}

export interface DatabaseUpgradeResult {
  status: 'missing' | 'current' | 'migration_required' | 'migrated';
  databasePath: string;
  namespaces: NamespaceStatus[];
  backupPath?: string;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableNames(database: DatabaseSync): Set<string> {
  return new Set(
    z
      .array(tableNameRowSchema)
      .parse(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())
      .map((row) => row.name),
  );
}

function columnDefinitions(
  database: DatabaseSync,
  table: string,
  schema?: 'legacy' | 'main',
): ColumnDefinition[] {
  const prefix = schema === undefined ? '' : `${schema}.`;
  return z
    .array(columnRowSchema)
    .parse(database.prepare(`PRAGMA ${prefix}table_info(${quoteIdentifier(table)})`).all())
    .map((row) => ({
      name: row.name,
      required: row.notnull === 1,
      hasDefault: row.dflt_value !== null,
    }));
}

function currentSchemaColumns(): ReadonlyMap<string, readonly ColumnDefinition[]> {
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  try {
    migrateServerDatabase(database);
    return new Map(
      [...tableNames(database)]
        .filter((table) => table !== 'schema_migrations' && table !== 'sqlite_sequence')
        .map((table) => [table, columnDefinitions(database, table)]),
    );
  } finally {
    database.close();
  }
}

function expectedTables(inspection: ServerMigrationInspection): string[] {
  const plan = serverMigrationPlans.find(
    (candidate) => candidate.namespace === inspection.namespace,
  );
  if (!plan) throw new Error(`Unknown database namespace ${inspection.namespace}.`);
  return [...migrationTableNames(plan.migrations)];
}

function expectedColumns(
  table: string,
  currentColumns: ReadonlyMap<string, readonly ColumnDefinition[]>,
): string[] {
  const columns = new Set((currentColumns.get(table) ?? []).map((column) => column.name));
  if (columns.size === 0) throw new Error(`Current schema does not contain table ${table}.`);
  return [...columns].sort();
}

function assertIntegrity(database: DatabaseSync, schema?: 'main'): void {
  const prefix = schema === undefined ? '' : `${schema}.`;
  const rows = z
    .array(integrityRowSchema)
    .parse(database.prepare(`PRAGMA ${prefix}integrity_check`).all());
  if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
    throw new Error('SQLite integrity_check failed.');
  }
}

function assertForeignKeys(database: DatabaseSync, schema?: 'main'): void {
  const prefix = schema === undefined ? '' : `${schema}.`;
  const violations = database.prepare(`PRAGMA ${prefix}foreign_key_check`).all();
  if (violations.length > 0) {
    throw new Error(`SQLite foreign_key_check reported ${violations.length} violation(s).`);
  }
}

function inspectSource(database: DatabaseSync, path: string): SourceInspection {
  const namespaces = inspectServerDatabase(database);
  const tables = tableNames(database);
  const currentColumns = currentSchemaColumns();
  const knownTables = new Set(currentColumns.keys());
  for (const table of tables) {
    if (table !== 'schema_migrations' && table !== 'sqlite_sequence' && !knownTables.has(table)) {
      throw new Error(`Database contains unsupported application table ${table}.`);
    }
  }
  for (const inspection of namespaces) {
    if (inspection.kind === 'empty') continue;
    if (inspection.currentVersion === 0) {
      throw new Error(`Database schema ${inspection.namespace}/0 has no published table shape.`);
    }
    for (const table of expectedTables(inspection)) {
      if (!tables.has(table)) {
        throw new Error(`Database schema ${inspection.namespace} is missing table ${table}.`);
      }
      const actual = columnDefinitions(database, table)
        .map((column) => column.name)
        .sort();
      const expected = expectedColumns(table, currentColumns);
      if (actual.join('\0') !== expected.join('\0')) {
        throw new Error(
          `Database schema ${inspection.namespace}/${inspection.currentVersion} has an unsupported ${table} shape.`,
        );
      }
    }
  }
  assertIntegrity(database);
  assertForeignKeys(database);
  return { path, tables, namespaces, currentColumns };
}

function statusNamespaces(inspection: SourceInspection): NamespaceStatus[] {
  return inspection.namespaces.map((namespace) => ({
    namespace: namespace.namespace,
    currentVersion: namespace.currentVersion,
    requiredVersion: namespace.requiredVersion,
  }));
}

function missingResult(databasePath: string): DatabaseUpgradeResult {
  return {
    status: 'missing',
    databasePath,
    namespaces: serverMigrationPlans.map((plan) => ({
      namespace: plan.namespace,
      currentVersion: 0,
      requiredVersion: plan.migrations.at(-1)?.version ?? 0,
    })),
  };
}

function requiresUpgrade(inspection: SourceInspection): boolean {
  return inspection.namespaces.some((namespace) => namespace.kind === 'upgrade');
}

interface WorkingCopy {
  directory: string;
  path: string;
}

function createWorkingCopy(databasePath: string): WorkingCopy {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-sqlite-work-'));
  try {
    chmodSync(directory, 0o700);
    const path = join(directory, 'kairos.sqlite');
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${databasePath}${suffix}`;
      if (!existsSync(source)) continue;
      copyFileSync(source, `${path}${suffix}`);
      chmodSync(`${path}${suffix}`, 0o600);
    }
    return { directory, path };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function checkDatabaseFile(databasePath: string): DatabaseUpgradeResult {
  if (!existsSync(databasePath)) return missingResult(databasePath);
  const work = createWorkingCopy(databasePath);
  let database: DatabaseSync | undefined;
  try {
    // SQLite recovery and SHM updates are confined to this disposable copy.
    database = new DatabaseSync(work.path, { enableForeignKeyConstraints: true });
    const inspection = inspectSource(database, work.path);
    return {
      status: requiresUpgrade(inspection) ? 'migration_required' : 'current',
      databasePath,
      namespaces: statusNamespaces(inspection),
    };
  } finally {
    database?.close();
    rmSync(work.directory, { recursive: true, force: true });
  }
}

function copyStandardTable(
  target: DatabaseSync,
  inspection: SourceInspection,
  table: string,
): void {
  const sourceColumns = new Set(
    columnDefinitions(target, table, 'legacy').map((column) => column.name),
  );
  const targetColumns = inspection.currentColumns.get(table);
  if (!targetColumns) throw new Error(`Current schema does not contain table ${table}.`);
  const insertedColumns: string[] = [];
  const selectedExpressions: string[] = [];
  for (const column of targetColumns) {
    if (!sourceColumns.has(column.name)) {
      if (column.required && !column.hasDefault) {
        throw new Error(`Migration for ${table}.${column.name} is not defined.`);
      }
      continue;
    }
    insertedColumns.push(column.name);
    selectedExpressions.push(`source_row.${quoteIdentifier(column.name)}`);
  }
  if (insertedColumns.length === 0) return;
  const sql = `INSERT INTO main.${quoteIdentifier(table)} (${insertedColumns.map(quoteIdentifier).join(', ')})
    SELECT ${selectedExpressions.join(', ')} FROM legacy.${quoteIdentifier(table)} AS source_row`;
  target.prepare(sql).run();
}

function copySourceIntoCurrent(target: DatabaseSync, inspection: SourceInspection): void {
  target.prepare('ATTACH DATABASE ? AS legacy').run(inspection.path);
  try {
    inTransaction(
      target,
      () => {
        target.exec('PRAGMA defer_foreign_keys = ON;');
        for (const table of [...inspection.tables].sort()) {
          if (table === 'schema_migrations' || table === 'sqlite_sequence') continue;
          copyStandardTable(target, inspection, table);
        }
        if (inspection.tables.has('sqlite_sequence')) {
          target.exec(`
          INSERT OR REPLACE INTO main.sqlite_sequence(name, seq)
          SELECT name, seq FROM legacy.sqlite_sequence
        `);
        }
        assertForeignKeys(target, 'main');
        assertIntegrity(target, 'main');
      },
      'DEFERRED',
    );
    target.exec('DETACH DATABASE legacy;');
  } finally {
    if (target.isOpen && target.isTransaction) target.exec('ROLLBACK;');
  }
}

function createSecureEmptyFile(path: string): void {
  closeSync(openSync(path, 'wx', 0o600));
}

function createBackupName(): string {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  return `kairos-pre-migration-${timestamp}-${randomUUID()}.sqlite`;
}

function verifyBackup(path: string): void {
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  try {
    assertIntegrity(database);
    assertForeignKeys(database);
    const journal = z
      .object({ journal_mode: z.string() })
      .parse(database.prepare('PRAGMA journal_mode = DELETE').get());
    if (journal.journal_mode !== 'delete') {
      throw new Error('SQLite backup could not be converted to a self-contained file.');
    }
  } finally {
    database.close();
  }
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function replaceDatabaseFile(databasePath: string, temporaryPath: string): void {
  const directory = dirname(databasePath);
  const rollbackPath = join(directory, `.kairos-migration-${randomUUID()}.original`);
  const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`];
  const movedSidecars: string[] = [];
  let originalMoved = false;
  let replacementMoved = false;
  try {
    for (const sidecar of sidecars) {
      if (!existsSync(sidecar)) continue;
      renameSync(sidecar, `${rollbackPath}${sidecar.slice(databasePath.length)}`);
      movedSidecars.push(sidecar);
    }
    renameSync(databasePath, rollbackPath);
    originalMoved = true;
    renameSync(temporaryPath, databasePath);
    replacementMoved = true;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      if (replacementMoved) rmSync(databasePath, { force: true });
      if (originalMoved) renameSync(rollbackPath, databasePath);
      for (const sidecar of movedSidecars) {
        renameSync(`${rollbackPath}${sidecar.slice(databasePath.length)}`, sidecar);
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Database replacement and rollback both failed.',
      );
    }
    throw error;
  }
  rmSync(rollbackPath, { force: true });
  for (const sidecar of sidecars) {
    rmSync(`${rollbackPath}${sidecar.slice(databasePath.length)}`, { force: true });
  }
}

function sourceRevision(database: DatabaseSync): string {
  const row = z
    .object({ data_version: z.number().int(), schema_version: z.number().int() })
    .parse(database.prepare('SELECT * FROM pragma_data_version, pragma_schema_version').get());
  return `${row.data_version}/${row.schema_version}`;
}

async function backupStableSource(
  source: DatabaseSync,
  databasePath: string,
  backupDirectory: string,
): Promise<{ inspection: SourceInspection; backupPath?: string }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inspection = inspectSource(source, databasePath);
    if (!requiresUpgrade(inspection)) return { inspection };
    const revision = sourceRevision(source);
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const backupPath = join(backupDirectory, createBackupName());
    createSecureEmptyFile(backupPath);
    try {
      await backupDatabase(source, backupPath);
      chmodSync(backupPath, 0o600);
      verifyBackup(backupPath);
      source.exec('BEGIN IMMEDIATE;');
      if (sourceRevision(source) === revision) {
        const lockedInspection = inspectSource(source, databasePath);
        if (requiresUpgrade(lockedInspection)) {
          return { inspection: lockedInspection, backupPath };
        }
      }
      if (source.isTransaction) source.exec('ROLLBACK;');
    } catch (error) {
      if (source.isTransaction) source.exec('ROLLBACK;');
      rmSync(backupPath, { force: true });
      throw error;
    }
    rmSync(backupPath, { force: true });
  }
  throw new Error('Database changed during backup three times; retry after stopping Server.');
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function sourceFileHashes(databasePath: string): Promise<Record<string, string | null>> {
  const hashes: Record<string, string | null> = {};
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${databasePath}${suffix}`;
    hashes[suffix] = existsSync(path) ? await hashFile(path) : null;
  }
  return hashes;
}

async function assertSourceFilesUnchanged(
  databasePath: string,
  expected: Record<string, string | null>,
): Promise<void> {
  const actual = await sourceFileHashes(databasePath);
  for (const suffix of ['', '-wal', '-shm']) {
    if (actual[suffix] !== expected[suffix]) {
      throw new Error(
        'Source database files changed during migration; retry after stopping Server.',
      );
    }
  }
}

export async function upgradeDatabaseFile(options: {
  dataDirectory: string;
  backupDirectory: string;
}): Promise<DatabaseUpgradeResult> {
  const databasePath = join(options.dataDirectory, 'kairos.sqlite');
  if (!existsSync(databasePath)) return missingResult(databasePath);
  const originalHashes = await sourceFileHashes(databasePath);
  const work = createWorkingCopy(databasePath);
  let source: DatabaseSync | undefined;
  let temporaryPath: string | undefined;
  try {
    source = new DatabaseSync(work.path, { enableForeignKeyConstraints: true });
    source.exec('PRAGMA busy_timeout = 5000;');
    const { inspection, backupPath } = await backupStableSource(
      source,
      work.path,
      options.backupDirectory,
    );
    if (!backupPath) {
      return {
        status: 'current',
        databasePath,
        namespaces: statusNamespaces(inspection),
      };
    }

    temporaryPath = join(dirname(databasePath), `.kairos-migration-${randomUUID()}.sqlite`);
    createSecureEmptyFile(temporaryPath);
    const target = new DatabaseSync(temporaryPath, { enableForeignKeyConstraints: true });
    try {
      target.exec('PRAGMA busy_timeout = 5000;');
      migrateServerDatabase(target);
      copySourceIntoCurrent(target, inspection);
      assertForeignKeys(target);
      assertIntegrity(target);
    } finally {
      target.close();
    }
    chmodSync(temporaryPath, 0o600);
    if (source.isTransaction) source.exec('ROLLBACK;');
    source.close();
    await assertSourceFilesUnchanged(databasePath, originalHashes);
    replaceDatabaseFile(databasePath, temporaryPath);
    temporaryPath = undefined;
    return {
      status: 'migrated',
      databasePath,
      namespaces: statusNamespaces(inspection).map((namespace) => ({
        ...namespace,
        currentVersion: namespace.requiredVersion,
      })),
      backupPath,
    };
  } finally {
    if (source?.isOpen) {
      if (source.isTransaction) source.exec('ROLLBACK;');
      source.close();
    }
    if (temporaryPath) rmSync(temporaryPath, { force: true });
    rmSync(work.directory, { recursive: true, force: true });
  }
}
