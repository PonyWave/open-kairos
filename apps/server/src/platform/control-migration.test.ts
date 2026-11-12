import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import {
  checkPlatformControlDatabaseFile,
  migratePlatformControlDatabaseFile,
} from './control-migration.js';
import { platformControlSchemaSQL } from './control-schema.js';
import { PlatformControlStore } from './control-store.js';

const directories: string[] = [];
const createdAt = '2026-11-08T00:00:00.000Z';
const migratedAt = new Date('2026-11-08T12:00:00.000Z');
const cluster = {
  caSha256: 'a'.repeat(64),
  nodeUid: 'node',
  nodeName: 'kairos-k1',
  namespace: 'opensandbox',
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(version: 1 | 2 = 1, wal = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kairos-control-upgrade-')));
  directories.push(directory);
  const path = join(directory, 'control.sqlite');
  const origin = wal ? join(directory, 'origin.sqlite') : path;
  const database = new DatabaseSync(origin);
  database.exec(platformControlSchemaSQL(version));
  if (wal) database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  database
    .prepare('INSERT INTO platform_control_meta(id,cluster_json,capacity) VALUES (1,?,2)')
    .run(JSON.stringify([cluster.caSha256, cluster.nodeUid, cluster.nodeName, cluster.namespace]));
  for (const [deployment, envId, state, operation] of [
    ['test', 'idle', 'running', null],
    ['prod', 'unknown', 'starting', 'create-unknown'],
  ] as const) {
    database
      .prepare(`INSERT INTO platform_control_environments(
      deployment_id,env_id,tenant_id,state,sandbox_id,runtime_version,current_operation_id,created_at,updated_at
    ) VALUES (?,?,?,?,'sandbox-' || ?,1,?,?,?)`)
      .run(deployment, envId, `tenant-${envId}`, state, envId, operation, createdAt, createdAt);
    database
      .prepare("INSERT INTO platform_control_operations VALUES (?,?,?,'create',?,1,?,?)")
      .run(
        operation ?? 'create-completed',
        deployment,
        envId,
        operation ? 'unknown' : 'completed',
        createdAt,
        createdAt,
      );
  }
  database.exec(
    "INSERT INTO platform_control_slots VALUES (1,'test','idle'),(2,'prod','unknown');",
  );
  database
    .prepare(
      "INSERT INTO platform_control_uses VALUES ('prod','unknown','run','tenant-unknown','run',?)",
    )
    .run(createdAt);
  if (wal) {
    for (const suffix of ['', '-wal', '-shm']) {
      copyFileSync(`${origin}${suffix}`, `${path}${suffix}`);
      chmodSync(`${path}${suffix}`, 0o600);
    }
  }
  database.close();
  chmodSync(path, 0o600);
  return { directory, path, backupDirectory: join(directory, 'backups') };
}

function files(path: string) {
  return ['', '-wal', '-shm'].map((suffix) =>
    existsSync(`${path}${suffix}`) ? readFileSync(`${path}${suffix}`) : null,
  );
}

function noTemporaryFiles(directory: string) {
  expect(
    readdirSync(directory).filter((name) => name.startsWith('.kairos-control-migration-')),
  ).toEqual([]);
}

it('requires explicit migration for legacy control stores and preserves both deployments, unknown operations and slots', async () => {
  const f = fixture();
  const before = files(f.path);
  expect(
    () => new PlatformControlStore({ path: f.path, deploymentId: 'test', cluster, capacity: 2 }),
  ).toThrow('migration is required');
  expect(files(f.path)).toEqual(before);
  expect(await checkPlatformControlDatabaseFile(f.path)).toMatchObject({
    status: 'migration_required',
    currentVersion: 1,
  });
  const result = await migratePlatformControlDatabaseFile({ ...f, now: () => migratedAt });
  expect(result).toMatchObject({ status: 'migrated', currentVersion: 2, requiredVersion: 2 });
  const store = new PlatformControlStore({
    path: f.path,
    deploymentId: 'test',
    cluster,
    capacity: 2,
  });
  try {
    expect(store.get('idle')).toMatchObject({
      state: 'running',
      idle_since: migratedAt.toISOString(),
    });
    expect(store.listAll()).toHaveLength(2);
    expect(
      store.database
        .prepare(
          "SELECT status FROM platform_control_operations WHERE operation_id='create-unknown'",
        )
        .get(),
    ).toMatchObject({ status: 'unknown' });
    expect(
      store.database
        .prepare('SELECT COUNT(*) AS n FROM platform_control_slots WHERE deployment_id IS NOT NULL')
        .get(),
    ).toMatchObject({ n: 2 });
  } finally {
    store.close();
  }
  if (!result.backupPath) throw new Error('Missing migration backup');
  expect(statSync(result.backupPath).mode & 0o777).toBe(0o600);
  const backup = new DatabaseSync(result.backupPath, { readOnly: true });
  try {
    expect(backup.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 });
    expect(backup.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'delete' });
    expect(
      backup.prepare('SELECT COUNT(*) AS n FROM platform_control_environments').get(),
    ).toMatchObject({ n: 2 });
  } finally {
    backup.close();
  }
  expect(existsSync(`${result.backupPath}-wal`)).toBe(false);
  expect(existsSync(`${result.backupPath}-shm`)).toBe(false);
  noTemporaryFiles(f.directory);
});

it.each([1, 2] as const)(
  'keeps all uncheckpointed source files unchanged during check for schema %i',
  async (version) => {
    const f = fixture(version, true);
    const before = files(f.path);
    expect(before[1]?.length).toBeGreaterThan(0);
    const result = await checkPlatformControlDatabaseFile(f.path);
    expect(result.status).toBe(version === 1 ? 'migration_required' : 'current');
    expect(files(f.path)).toEqual(before);
    expect(existsSync(f.backupDirectory)).toBe(false);
    noTemporaryFiles(f.directory);
  },
);

it('rejects legacy startup without changing uncheckpointed main, WAL or SHM', () => {
  const f = fixture(1, true);
  const before = files(f.path);
  expect(
    () => new PlatformControlStore({ path: f.path, deploymentId: 'test', cluster, capacity: 2 }),
  ).toThrow('migration is required');
  expect(files(f.path)).toEqual(before);
});

it('does not touch current source WAL/SHM or create a backup on no-op', async () => {
  const f = fixture(2, true);
  const before = files(f.path);
  expect((await migratePlatformControlDatabaseFile(f)).status).toBe('current');
  expect(files(f.path)).toEqual(before);
  expect(existsSync(f.backupDirectory)).toBe(false);
  noTemporaryFiles(f.directory);
});

it('recovers legacy WAL only on copies and includes WAL-only rows in the replacement and backup', async () => {
  const f = fixture(1, true);
  const result = await migratePlatformControlDatabaseFile({ ...f, now: () => migratedAt });
  expect((await checkPlatformControlDatabaseFile(f.path)).status).toBe('current');
  const database = new DatabaseSync(f.path, { readOnly: true });
  try {
    expect(database.prepare('SELECT COUNT(*) AS n FROM platform_control_uses').get()).toMatchObject(
      { n: 1 },
    );
    expect(
      database
        .prepare("SELECT idle_since FROM platform_control_environments WHERE deployment_id='prod'")
        .get(),
    ).toMatchObject({ idle_since: null });
  } finally {
    database.close();
  }
  expect(result.backupPath).toBeTypeOf('string');
  noTemporaryFiles(f.directory);
});

it('leaves legacy main/WAL/SHM untouched when a backup cannot be created', async () => {
  const f = fixture(1, true);
  const before = files(f.path);
  writeFileSync(f.backupDirectory, 'occupied');
  await expect(migratePlatformControlDatabaseFile(f)).rejects.toThrow();
  expect(files(f.path)).toEqual(before);
  noTemporaryFiles(f.directory);
});

it('rejects a changed current schema instead of accepting the current version as a no-op', async () => {
  const f = fixture(2);
  const database = new DatabaseSync(f.path);
  database.exec('ALTER TABLE platform_control_meta ADD COLUMN unexpected TEXT;');
  database.close();
  const before = files(f.path);
  await expect(migratePlatformControlDatabaseFile(f)).rejects.toThrow(
    'Unknown platform control database schema',
  );
  expect(files(f.path)).toEqual(before);
  expect(existsSync(f.backupDirectory)).toBe(false);
  noTemporaryFiles(f.directory);
});

it('refuses to replace a source changed while its isolated backup is being made', async () => {
  const f = fixture();
  const migrating = migratePlatformControlDatabaseFile(f);
  const source = new DatabaseSync(f.path);
  source
    .prepare("UPDATE platform_control_environments SET error=? WHERE env_id='idle'")
    .run('concurrent write');
  source.close();
  const changed = files(f.path);
  await expect(migrating).rejects.toThrow('database changed');
  expect(files(f.path)).toEqual(changed);
  expect((await checkPlatformControlDatabaseFile(f.path)).status).toBe('migration_required');
  noTemporaryFiles(f.directory);
});

it.each(['future', 'unknown-table', 'corrupt-data', 'corrupt-file'] as const)(
  'rejects %s without changing source files',
  async (scenario) => {
    const f = fixture();
    if (scenario === 'corrupt-file') writeFileSync(f.path, 'not a SQLite database');
    else {
      const database = new DatabaseSync(f.path);
      if (scenario === 'future') database.exec('PRAGMA user_version=99;');
      else if (scenario === 'unknown-table') database.exec('CREATE TABLE unknown(value TEXT);');
      else database.exec("UPDATE platform_control_environments SET state='invalid';");
      database.close();
    }
    const before = files(f.path);
    await expect(migratePlatformControlDatabaseFile(f)).rejects.toThrow();
    expect(files(f.path)).toEqual(before);
    expect(existsSync(f.backupDirectory)).toBe(false);
    noTemporaryFiles(f.directory);
  },
);

it('offers a check-only CLI that does not need a backup directory', () => {
  const f = fixture(1, true);
  const before = files(f.path);
  const checked = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./migrate.ts', import.meta.url)),
      '--path',
      f.path,
      '--check',
    ],
    { encoding: 'utf8' },
  );
  expect(checked.status, checked.stderr).toBe(0);
  expect(JSON.parse(checked.stdout)).toMatchObject({ status: 'migration_required' });
  expect(files(f.path)).toEqual(before);
});
