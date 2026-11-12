import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDatabase } from './database.js';
import { contextRecapMigrations, migrateDatabase } from './migrations.js';
import { serverMigrationPlans } from './server-schema.js';
import { inTransaction } from './transaction.js';
import { upgradeDatabaseFile } from './upgrades.js';

describe('SQLite schema installation', () => {
  it('allows independent business schemas to use their own version', () => {
    const database = openDatabase(':memory:');
    try {
      migrateDatabase(
        database,
        [
          {
            version: 1,
            name: 'sessions_initial',
            sql: 'CREATE TABLE session_example (id TEXT PRIMARY KEY)',
          },
        ],
        'sessions',
      );
      expect(
        database
          .prepare('SELECT namespace, version FROM schema_migrations ORDER BY namespace')
          .all(),
      ).toEqual([
        { namespace: 'context_recap', version: 8 },
        { namespace: 'context_recap', version: 9 },
        { namespace: 'context_recap', version: 10 },
        { namespace: 'context_recap', version: 11 },
        { namespace: 'context_recap', version: 12 },
        { namespace: 'context_recap', version: 13 },
        { namespace: 'context_recap', version: 14 },
        { namespace: 'context_recap', version: 15 },
        { namespace: 'context_recap', version: 16 },
        { namespace: 'context_recap', version: 17 },
        { namespace: 'context_recap', version: 18 },
        { namespace: 'context_recap', version: 19 },
        { namespace: 'context_recap', version: 20 },
        { namespace: 'context_recap', version: 21 },
        { namespace: 'context_recap', version: 22 },
        { namespace: 'context_recap', version: 23 },
        { namespace: 'context_recap', version: 24 },
        { namespace: 'context_recap', version: 25 },
        { namespace: 'sessions', version: 1 },
      ]);
      expect(database.prepare('SELECT COUNT(*) AS count FROM session_example').get()).toEqual({
        count: 0,
      });
      const contextColumns = database.prepare('PRAGMA table_info(context_messages)').all();
      expect(contextColumns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'delegation_source_thread_id' }),
          expect.objectContaining({ name: 'delegation_source_agent_id' }),
          expect.objectContaining({ name: 'source_tool_call_id' }),
        ]),
      );
      expect(contextColumns).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'interaction_id' })]),
      );
      expect(database.prepare('PRAGMA index_info(context_messages_delegation)').all()).toEqual([
        expect.objectContaining({ name: 'delegation_source_thread_id' }),
        expect.objectContaining({ name: 'delegation_source_agent_id' }),
        expect.objectContaining({ name: 'source_tool_call_id' }),
        expect.objectContaining({ name: 'seq' }),
      ]);
      const recapColumns = database.prepare('PRAGMA table_info(recaps)').all();
      expect(recapColumns).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'content' })]),
      );
      expect(recapColumns).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'title' })]),
      );
      const tables = z
        .array(z.object({ name: z.string() }))
        .parse(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())
        .map((row) => row.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          'attachments',
          'context_message_attachments',
          'users',
          'tenants',
          'auth_email_verifications',
          'auth_setup_credentials',
          'auth_sessions',
          'environments',
          'environment_pairing_credentials',
          'environment_device_bindings',
          'agent_environment_policies',
          'agent_environment_binding_history',
          'agent_environment_message_bindings',
          'agent_environment_requests',
          'agent_environment_operations',
        ]),
      );
      expect(database.prepare('PRAGMA table_info(tenants)').all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'default_env_explicit' })]),
      );
      expect(database.prepare('PRAGMA table_info(environments)').all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'device_binding_id' }),
          expect.objectContaining({ name: 'capability_status' }),
          expect.objectContaining({ name: 'directory_status' }),
          expect.objectContaining({ name: 'maintenance_version' }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it('rejects the identity schema before applying environment DDL or DML', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE schema_migrations (
          namespace TEXT NOT NULL,
          version INTEGER NOT NULL,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL,
          PRIMARY KEY(namespace, version)
        );
        CREATE TABLE tenants (
          tenant_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          default_env_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      database
        .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)')
        .run(
          'context_recap',
          12,
          'identity_personal_tenant_sessions_final',
          '2026-11-05T00:00:00.000Z',
        );
      database
        .prepare('INSERT INTO tenants VALUES (?, ?, NULL, ?, ?)')
        .run(
          'legacy-tenant',
          'legacy-user',
          '2026-11-05T00:00:00.000Z',
          '2026-11-05T00:00:00.000Z',
        );

      expect(() => migrateDatabase(database)).toThrow(/requires an explicit upgrade/);
      expect(database.prepare('PRAGMA table_info(tenants)').all()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'default_env_explicit' })]),
      );
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'environments'")
          .get(),
      ).toEqual({ count: 0 });
      expect(database.prepare('SELECT * FROM tenants').all()).toHaveLength(1);
      expect(database.prepare('SELECT namespace, version FROM schema_migrations').all()).toEqual([
        { namespace: 'context_recap', version: 12 },
      ]);
    } finally {
      database.close();
    }
  });

  it('rejects a schema 13 database without changing its file or sentinel rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kairos-sqlite-'));
    const path = join(directory, 'test.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE schema_migrations (
        namespace TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY(namespace, version)
      );
      CREATE TABLE context_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE existing_data (value TEXT NOT NULL);
    `);
    legacy
      .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)')
      .run('context_recap', 13, 'environment_registry_pairing_final', '2026-11-06T00:00:00.000Z');
    legacy
      .prepare(
        'INSERT INTO context_messages(message_id, thread_id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('legacy-message', 'thread', 'agent', 'user', '旧消息', '2026-11-02T00:00:00.000Z');
    legacy.prepare('INSERT INTO existing_data VALUES (?)').run('保留');
    expect(legacy.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'delete' });
    legacy.close();
    chmodSync(path, 0o644);
    const originalPath = realpathSync(path);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    expect(() => openDatabase(path)).toThrow(/requires an explicit upgrade/);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      expect(existsSync(path)).toBe(true);
      expect({
        path: realpathSync(path),
        mode: statSync(path).mode & 0o777,
        journalMode: database.prepare('PRAGMA journal_mode').get(),
      }).toEqual({
        path: originalPath,
        mode: 0o644,
        journalMode: { journal_mode: 'delete' },
      });
      expect(database.prepare('SELECT * FROM existing_data').all()).toEqual([{ value: '保留' }]);
      expect(database.prepare('SELECT message_id, content FROM context_messages').all()).toEqual([
        { message_id: 'legacy-message', content: '旧消息' },
      ]);
      expect(database.prepare('PRAGMA table_info(context_messages)').all()).toHaveLength(7);
      expect(database.prepare('SELECT namespace, version FROM schema_migrations').all()).toEqual([
        { namespace: 'context_recap', version: 13 },
      ]);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects unversioned application tables before creating migration metadata', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('CREATE TABLE context_messages (seq INTEGER PRIMARY KEY, content TEXT)');
      database.prepare('INSERT INTO context_messages(content) VALUES (?)').run('哨兵');
      expect(() => migrateDatabase(database)).toThrow(/requires an explicit upgrade/);
      expect(database.prepare('SELECT * FROM context_messages').all()).toEqual([
        { seq: 1, content: '哨兵' },
      ]);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('reopens committed rows, rolls back failed work and enforces foreign keys', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kairos-sqlite-'));
    const path = join(directory, 'test.sqlite');
    let database = openDatabase(path);
    try {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(database.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
      expect(
        database
          .prepare(
            "SELECT MAX(version) AS version FROM schema_migrations WHERE namespace = 'context_recap'",
          )
          .get(),
      ).toEqual({ version: 25 });
      database
        .prepare(
          `INSERT INTO context_messages(
          message_id, thread_id, agent_id, role, content, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('message-1', 'thread', 'agent', 'user', '预览与日志路径', '2026-11-02T00:00:00.000Z');
      expect(() =>
        inTransaction(database, () => {
          database
            .prepare(
              `INSERT INTO context_messages(
              message_id, thread_id, agent_id, role, content, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run('message-2', 'thread', 'agent', 'user', '未提交', '2026-11-02T00:00:00.000Z');
          database.prepare('INSERT INTO recap_sources VALUES (?, ?, ?)').run('missing', 1, 1);
        }),
      ).toThrow();
      database.close();
      database = openDatabase(path);
      expect(database.prepare('SELECT message_id, content FROM context_messages').all()).toEqual([
        { message_id: 'message-1', content: '预览与日志路径' },
      ]);
      expect(database.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('incomplete tool identity offline migration', () => {
  function legacyDatabase(path: string) {
    const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    for (const plan of serverMigrationPlans) {
      migrateDatabase(
        database,
        plan.namespace === 'context_recap'
          ? contextRecapMigrations.filter((migration) => migration.version <= 17)
          : plan.migrations,
        plan.namespace,
      );
    }
    return database;
  }

  function insertAssistant(database: DatabaseSync, calls: unknown[]) {
    const serialized = JSON.stringify(calls);
    database
      .prepare(
        `INSERT INTO context_messages(
          seq, message_id, thread_id, agent_id, role, content,
          incomplete_tool_calls_json, created_at
        ) VALUES (1, 'assistant', 'thread', 'thread', 'assistant', '', ?, ?)`,
      )
      .run(serialized, '2026-11-08T00:00:00.000Z');
    return serialized;
  }

  function insertRelation(
    database: DatabaseSync,
    callId: string,
    argumentsText: string,
    resultSeq: number | null = null,
  ) {
    database
      .prepare(
        `INSERT INTO context_tool_calls(
          thread_id, agent_id, call_id, assistant_seq, tool_name, arguments_json,
          result_seq, call_type, arguments_text, call_error
        ) VALUES ('thread', 'thread', ?, 1, 'edit', 'null', ?, 'incomplete', ?, 'Invalid JSON.')`,
      )
      .run(callId, resultSeq, argumentsText);
  }

  it('persists exact IDs while preserving tool results and historical request evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kairos-incomplete-migration-'));
    const path = join(directory, 'kairos.sqlite');
    const source = legacyDatabase(path);
    const calls = [
      { name: 'edit', arguments_text: '{one', error: 'Invalid JSON.' },
      { id: 'explicit-call', name: 'edit', arguments_text: '{two', error: 'Invalid JSON.' },
      { name: 'edit', arguments_text: '{three', error: 'Invalid JSON.' },
    ];
    const original = insertAssistant(source, calls);
    source
      .prepare(
        `INSERT INTO context_messages(
          seq, message_id, thread_id, agent_id, role, content,
          tool_call_id, tool_name, tool_status, created_at
        ) VALUES (2, 'result', 'thread', 'thread', 'tool', 'Invalid JSON.',
          'incomplete-1-0', 'edit', 'error', ?)`,
      )
      .run('2026-11-08T00:00:01.000Z');
    insertRelation(source, 'incomplete-1-0', '{one', 2);
    insertRelation(source, 'explicit-call', '{two');
    insertRelation(source, 'incomplete-generated:1:3', '{three');
    const historicalRequest = JSON.stringify({
      messages: [{ role: 'assistant', content: '', incomplete_tool_calls: calls }],
      tools: [],
    });
    for (const status of ['ready', 'completed']) {
      source
        .prepare(
          `INSERT INTO model_request_records(
            request_id, thread_id, agent_id, status, context_window_tokens,
            output_reserve_tokens, read_through_seq, view_version, selected_recap_ids_json,
            context_message_seqs_json, created_at, updated_at, request_json, request_fingerprint
          ) VALUES (?, 'thread', 'thread', ?, 1000, 100, 0, 0, '[]', '[1]', ?, ?, ?, ?)`,
        )
        .run(
          status,
          status,
          '2026-11-08T00:00:00.000Z',
          '2026-11-08T00:00:00.000Z',
          historicalRequest,
          'historical-fingerprint',
        );
    }
    source.close();
    try {
      expect(() => openDatabase(path)).toThrow(/requires an explicit upgrade/);
      const upgraded = await upgradeDatabaseFile({
        dataDirectory: directory,
        backupDirectory: join(directory, 'backups'),
      });
      expect(upgraded.status).toBe('migrated');
      const database = openDatabase(path);
      try {
        expect(
          database
            .prepare('SELECT incomplete_tool_calls_json FROM context_messages WHERE seq = 1')
            .get(),
        ).toEqual({
          incomplete_tool_calls_json: JSON.stringify([
            { ...calls[0], id: 'incomplete-1-0' },
            calls[1],
            { ...calls[2], id: 'incomplete-generated:1:3' },
          ]),
        });
        expect(
          database.prepare('SELECT tool_call_id FROM context_messages WHERE seq = 2').get(),
        ).toEqual({ tool_call_id: 'incomplete-1-0' });
        expect(
          database
            .prepare(
              'SELECT status, request_json, request_fingerprint FROM model_request_records ORDER BY request_id',
            )
            .all(),
        ).toEqual(
          ['completed', 'ready'].map((status) => ({
            status,
            request_json: historicalRequest,
            request_fingerprint: 'historical-fingerprint',
          })),
        );
        const audit = z
          .object({ payload_json: z.string() })
          .parse(
            database
              .prepare(
                "SELECT payload_json FROM context_events WHERE event_type = 'incomplete_tool_ids_normalized'",
              )
              .get(),
          );
        expect(JSON.parse(audit.payload_json)).toEqual({
          message_seq: 1,
          original_incomplete_tool_calls_json: original,
          normalized_ids: ['incomplete-1-0', 'explicit-call', 'incomplete-generated:1:3'],
        });
      } finally {
        database.close();
      }
      expect(
        (
          await upgradeDatabaseFile({
            dataDirectory: directory,
            backupDirectory: join(directory, 'backups'),
          })
        ).status,
      ).toBe('current');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['explicit conflict', 'ambiguous missing IDs'])(
    'rejects %s without replacing the original database',
    async (scenario) => {
      const directory = mkdtempSync(join(tmpdir(), 'kairos-incomplete-invalid-'));
      const path = join(directory, 'kairos.sqlite');
      const source = legacyDatabase(path);
      const call = { name: 'edit', arguments_text: '{', error: 'Invalid JSON.' };
      const original = insertAssistant(
        source,
        scenario === 'explicit conflict' ? [{ ...call, id: 'explicit-id' }] : [call, call],
      );
      insertRelation(source, 'incomplete-1-0', '{');
      if (scenario === 'ambiguous missing IDs') insertRelation(source, 'incomplete-1-1', '{');
      source.close();
      try {
        await expect(
          upgradeDatabaseFile({
            dataDirectory: directory,
            backupDirectory: join(directory, 'backups'),
          }),
        ).rejects.toThrow(/identity .* ambiguous/);
        const unchanged = new DatabaseSync(path, { readOnly: true });
        try {
          expect(
            unchanged.prepare('SELECT incomplete_tool_calls_json FROM context_messages').get(),
          ).toEqual({ incomplete_tool_calls_json: original });
          expect(
            unchanged
              .prepare(
                "SELECT MAX(version) AS version FROM schema_migrations WHERE namespace = 'context_recap'",
              )
              .get(),
          ).toEqual({ version: 17 });
        } finally {
          unchanged.close();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
