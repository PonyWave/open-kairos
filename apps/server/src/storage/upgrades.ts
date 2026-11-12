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
import { encodeDaemonMessage, isDeviceCapability, OperationStatus } from '@kairos/contracts/device';
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

const zeroOffset = '0'.repeat(20);

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

type SchemaVariant = 'directory_v1' | 'remote' | 'interaction_v8';

interface NamespaceStatus {
  namespace: ServerNamespace;
  currentVersion: number;
  requiredVersion: number;
  variant?: SchemaVariant;
}

interface SourceInspection {
  path: string;
  tables: Set<string>;
  namespaces: Array<ServerMigrationInspection & { variant?: SchemaVariant }>;
  currentColumns: ReadonlyMap<string, readonly ColumnDefinition[]>;
}

export interface DatabaseUpgradeResult {
  status: 'missing' | 'current' | 'migration_required' | 'migrated';
  databasePath: string;
  namespaces: NamespaceStatus[];
  backupPath?: string;
}

const tableIntroductions: Record<ServerNamespace, Readonly<Record<string, number>>> = {
  context_recap: {
    recap_generation_operations: 8,
    attachments: 11,
    context_message_attachments: 11,
    users: 12,
    tenants: 12,
    auth_email_verifications: 12,
    auth_setup_credentials: 12,
    auth_sessions: 12,
    environments: 13,
    environment_pairing_credentials: 13,
    environment_device_bindings: 13,
    agent_environment_policies: 14,
    agent_environment_binding_history: 14,
    agent_environment_message_bindings: 14,
    agent_environment_requests: 14,
    agent_environment_operations: 14,
    environment_favorite_directories: 16,
    user_profiles: 21,
    model_settings: 21,
    model_connections: 21,
    settings_actions: 21,
    run_model_configurations: 21,
    request_model_configurations: 21,
    platform_environments: 19,
    platform_usage_intents: 19,
    platform_lifecycle_intents: 19,
    agent_execution_environments: 19,
  },
  server_runtime: {
    device_tool_calls: 2,
    device_tool_results: 2,
    interactions: 7,
    interaction_deliveries: 7,
    manual_compact_operations: 10,
    input_attachments: 11,
    automations: 13,
    automation_fires: 13,
    thread_notifications: 14,
    workspaces: 16,
  },
  devices: {},
  device_bash: {},
  environment_operations: {
    environment_syncs: 6,
    environment_sync_files: 6,
  },
};

const initialDirectoryOperationColumns = [
  'operation_id',
  'tenant_id',
  'env_id',
  'device_id',
  'device_binding_id',
  'target_instance_id',
  'action',
  'path',
  'load_workspace',
  'delivery_state',
  'status',
  'expires_at',
  'accepted_at',
  'sent_at',
  'result_status',
  'result_outcome_json',
  'result_recorded_at',
  'post_processed_at',
  'result_acknowledged_at',
  'created_at',
  'updated_at',
] as const;

const initialDirectoryOutcomeSchema = z.object({
  normalizedPath: z.string().min(1).max(4096),
  exists: z.boolean(),
  directory: z.boolean(),
  readable: z.boolean(),
  writable: z.boolean(),
  executable: z.boolean(),
  os: z.string().max(100),
  architecture: z.string().max(100),
  capabilities: z.array(z.number().int().refine(isDeviceCapability)).max(16),
  resources: z
    .array(
      z.object({
        path: z.string().min(1).max(512),
        content: z.string().max(64 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(33),
  reason: z.string().min(1).max(500).optional(),
});

const initialDirectoryOperationSchema = z.object({
  operation_id: z.string(),
  tenant_id: z.string(),
  env_id: z.string(),
  device_id: z.string(),
  device_binding_id: z.string(),
  target_instance_id: z.string(),
  action: z.literal('directory_check'),
  path: z.string(),
  load_workspace: z.number().int().min(0).max(1),
  delivery_state: z.enum(['intent', 'sent']),
  status: z.number().int().min(1).max(9),
  expires_at: z.string(),
  accepted_at: z.string().nullable(),
  sent_at: z.string().nullable(),
  result_status: z.nativeEnum(OperationStatus).nullable(),
  result_outcome_json: z.string().nullable(),
  result_recorded_at: z.string().nullable(),
  post_processed_at: z.string().nullable(),
  result_acknowledged_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

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

function environmentVariant(
  database: DatabaseSync,
  inspection: ServerMigrationInspection,
): SchemaVariant | undefined {
  if (inspection.kind === 'empty') return undefined;
  if (inspection.currentVersion === 1) {
    const columns = new Set(
      columnDefinitions(database, 'environment_operations').map((column) => column.name),
    );
    if (columns.has('result_outcome_json')) return 'directory_v1';
    if (columns.has('fingerprint')) return 'remote';
    throw new Error('Database schema environment_operations/1 has an unsupported table shape.');
  }
  return 'remote';
}

function contextVariant(
  database: DatabaseSync,
  inspection: ServerMigrationInspection,
): SchemaVariant | undefined {
  if (inspection.kind === 'empty' || inspection.currentVersion !== 8) return undefined;
  const columns = new Set(
    columnDefinitions(database, 'context_messages').map((column) => column.name),
  );
  if (columns.has('interaction_id')) return 'interaction_v8';
  if (columns.has('delegation_source_thread_id')) return undefined;
  throw new Error('Database schema context_recap/8 has an unsupported context_messages shape.');
}

function expectedTables(
  inspection: ServerMigrationInspection & { variant?: SchemaVariant },
): string[] {
  const plan = serverMigrationPlans.find(
    (candidate) => candidate.namespace === inspection.namespace,
  );
  if (!plan) throw new Error(`Unknown database namespace ${inspection.namespace}.`);
  const introductions = tableIntroductions[inspection.namespace];
  return [...migrationTableNames(plan.migrations)].filter((table) => {
    if (inspection.namespace === 'environment_operations') {
      if (inspection.variant === 'directory_v1') return table === 'environment_operations';
      return (introductions[table] ?? 1) <= inspection.currentVersion;
    }
    if (
      inspection.namespace === 'context_recap' &&
      inspection.currentVersion === 8 &&
      table === 'recap_generation_operations'
    ) {
      return inspection.variant === 'interaction_v8';
    }
    return (introductions[table] ?? 1) <= inspection.currentVersion;
  });
}

function expectedColumns(
  inspection: ServerMigrationInspection & { variant?: SchemaVariant },
  table: string,
  currentColumns: ReadonlyMap<string, readonly ColumnDefinition[]>,
): string[] {
  if (inspection.namespace === 'environment_operations' && inspection.variant === 'directory_v1') {
    return [...initialDirectoryOperationColumns].sort();
  }
  const columns = new Set((currentColumns.get(table) ?? []).map((column) => column.name));
  if (columns.size === 0) throw new Error(`Current schema does not contain table ${table}.`);
  const version = inspection.currentVersion;
  const remove = (names: string[]) => {
    for (const name of names) columns.delete(name);
  };
  if (inspection.namespace === 'context_recap') {
    if (table === 'context_messages') {
      if (version < 23) {
        remove([
          'automation_schedule_id',
          'automation_fire_id',
          'automation_trigger',
          'automation_scheduled_at',
        ]);
      }
      if (version < 8 || (version === 8 && inspection.variant === 'interaction_v8')) {
        remove([
          'delegation_source_thread_id',
          'delegation_source_agent_id',
          'source_tool_call_id',
        ]);
        columns.add('interaction_id');
      }
      if (version < 7) remove(['superseded_by_run_id']);
      if (version < 6) remove(['content_blocks_json', 'response_usage_json']);
      if (version < 5) {
        remove(['source', 'source_input_id', 'source_thread_id', 'source_agent_id']);
        columns.delete('interaction_id');
      }
      if (version < 2) {
        remove(['incomplete_tool_calls_json', 'tool_status', 'tool_error_json']);
      }
    }
    if (table === 'context_tool_calls' && version < 2) {
      remove(['call_type', 'arguments_text', 'call_error']);
    }
    if (table === 'model_input_states' && version < 7) remove(['view_version']);
    if (table === 'model_request_records') {
      if (version < 7) remove(['view_version']);
      if (version < 4) {
        remove(['request_fingerprint', 'pending_context_seqs_json', 'preparation_id', 'hard_cut']);
      }
      if (version < 3) remove(['request_json']);
    }
    if (table === 'recaps' && version < 10) columns.add('title');
    if (table === 'tenants' && version < 13) remove(['default_env_explicit']);
    if (table === 'environments' && version < 16) remove(['auto_detect', 'settings_version']);
    if (table === 'environments' && version < 19) remove(['platform_lifecycle_state']);
    if (table === 'agent_environment_operations' && version < 19) {
      remove(['execution_generation', 'resolved_action_json']);
    }
  }
  if (inspection.namespace === 'server_runtime') {
    if (table === 'threads') {
      if (version < 7) remove(['thread_type']);
      if (version < 13) remove(['automation_only']);
      if (version < 15) remove(['archived_at', 'reset_from_thread_id']);
      if (version < 16) remove(['workspace_id']);
    }
    if (table === 'thread_notifications' && version < 16) remove(['target']);
    if (table === 'automations' && version < 16) remove(['workspace_id']);
    if (table === 'inputs') {
      if (version < 13) {
        remove([
          'automation_schedule_id',
          'automation_fire_id',
          'automation_trigger',
          'automation_scheduled_at',
        ]);
      }
      if (version < 9) {
        remove([
          'delegation_source_thread_id',
          'delegation_source_agent_id',
          'source_tool_call_id',
        ]);
        columns.add('interaction_id');
      }
      if (version < 7) {
        remove(['source', 'source_thread_id', 'source_agent_id']);
        columns.delete('interaction_id');
      }
    }
    if (table === 'runs') {
      if (version < 8) remove(['rerun_from_message_seq', 'superseded_by_run_id', 'usage_reported']);
      if (version < 7) remove(['execution_mode']);
      if (version < 4) remove(['execution_generation', 'cancel_accepted_generation']);
    }
    if (table === 'thread_event_retention' && version < 3) remove(['last_event_seq']);
    if (table === 'server_bash_operations' && version < 3) remove(['content', 'status']);
    if (table === 'device_tool_calls') {
      if (version < 6) remove(['log_synced_offset']);
      if (version < 5) remove(['log_path', 'log_expires_at']);
    }
    if (table === 'interactions' && version < 9) columns.add('interaction_id');
    if (table === 'interaction_deliveries' && version < 9) {
      remove([
        'source_thread_id',
        'source_agent_id',
        'source_tool_call_id',
        'content',
        'context_message_seq',
      ]);
      columns.add('interaction_id');
      columns.add('input_id');
    }
  }
  if (inspection.namespace === 'device_bash' && table === 'device_bash_operations' && version < 2) {
    remove(['post_processed_at']);
  }
  if (
    inspection.namespace === 'context_recap' &&
    table === 'context_message_attachments' &&
    version < 22
  ) {
    remove(['source', 'workspace_required', 'workspace_status', 'env_id', 'path', 'operation_id']);
  }
  if (inspection.namespace === 'server_runtime' && table === 'input_attachments' && version < 12) {
    remove(['source', 'workspace_required', 'workspace_status', 'env_id', 'path', 'operation_id']);
  }
  if (inspection.namespace === 'environment_operations' && table === 'environment_operations') {
    if (version < 5) remove(['binary_content', 'create_parents']);
    if (version < 6) {
      remove([
        'sync_action',
        'sync_offset',
        'transfer_id',
        'total_size',
        'executable',
        'create_directory',
        'conflict_scan',
        'relative_paths_json',
      ]);
    }
  }
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
  const migrations = inspectServerDatabase(database);
  const namespaces = migrations.map((inspection) => {
    if (inspection.namespace === 'context_recap') {
      const variant = contextVariant(database, inspection);
      return variant === undefined ? inspection : { ...inspection, variant };
    }
    if (inspection.namespace !== 'environment_operations') return inspection;
    const variant = environmentVariant(database, inspection);
    return variant === undefined ? inspection : { ...inspection, variant };
  });
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
      const expected = expectedColumns(inspection, table, currentColumns);
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
    ...(namespace.variant === undefined ? {} : { variant: namespace.variant }),
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

function namespaceVersion(
  inspection: SourceInspection,
  namespace: ServerNamespace,
): ServerMigrationInspection & { variant?: SchemaVariant } {
  const result = inspection.namespaces.find((candidate) => candidate.namespace === namespace);
  if (!result) throw new Error(`Missing inspection for ${namespace}.`);
  return result;
}

const agentColumns: Readonly<Record<string, readonly string[]>> = {
  context_messages: ['agent_id', 'source_agent_id', 'delegation_source_agent_id'],
  context_tool_calls: ['agent_id'],
  recaps: ['agent_id'],
  model_input_states: ['agent_id'],
  model_input_recaps: ['agent_id'],
  model_request_records: ['agent_id'],
  context_events: ['agent_id'],
  recap_generation_operations: ['agent_id'],
  runs: ['agent_id'],
  interactions: ['source_agent_id', 'target_agent_id'],
  interaction_deliveries: ['source_agent_id'],
  thread_notifications: ['source_agent_id'],
  inputs: ['source_agent_id', 'delegation_source_agent_id'],
  agent_environment_policies: ['agent_id', 'source_agent_id'],
  agent_environment_binding_history: ['agent_id'],
  agent_environment_message_bindings: ['agent_id'],
  agent_environment_requests: ['agent_id'],
  agent_environment_operations: ['agent_id'],
};

function normalizeAgentExpression(expression: string): string {
  return `CASE WHEN ${expression} = 'main' THEN 'thread' ELSE ${expression} END`;
}

function hasLegacyInteractionMessages(inspection: SourceInspection): boolean {
  const context = namespaceVersion(inspection, 'context_recap');
  return (
    context.currentVersion >= 5 &&
    (context.currentVersion < 8 || context.variant === 'interaction_v8')
  );
}

function sourceColumnOverrides(
  inspection: SourceInspection,
  table: string,
): Record<string, string> {
  const context = namespaceVersion(inspection, 'context_recap');
  const runtime = namespaceVersion(inspection, 'server_runtime');
  const deviceBash = namespaceVersion(inspection, 'device_bash');
  const interactionColumn = (column: string) => {
    if (!inspection.tables.has('interactions')) return 'NULL';
    const expression = `interaction.${column}`;
    return column === 'source_agent_id' ? normalizeAgentExpression(expression) : expression;
  };
  if (table === 'model_request_records' && context.currentVersion < 7) {
    return { view_version: '0' };
  }
  if (table === 'threads' && runtime.currentVersion < 7) {
    return {
      thread_type: `CASE WHEN source_row.seq = (
        SELECT MIN(first_thread.seq) FROM legacy.threads AS first_thread
        WHERE first_thread.owner_id = source_row.owner_id
      ) THEN 'main' ELSE 'task' END`,
    };
  }
  if (table === 'inputs') {
    const overrides: Record<string, string> = {};
    if (runtime.currentVersion < 7) overrides.source = "'user'";
    if (runtime.currentVersion >= 7 && runtime.currentVersion < 9) {
      overrides.delegation_source_thread_id = interactionColumn('source_thread_id');
      overrides.delegation_source_agent_id = interactionColumn('source_agent_id');
      overrides.source_tool_call_id = interactionColumn('source_tool_call_id');
    }
    return overrides;
  }
  if (table === 'context_messages' && hasLegacyInteractionMessages(inspection)) {
    return {
      delegation_source_thread_id: interactionColumn('source_thread_id'),
      delegation_source_agent_id: interactionColumn('source_agent_id'),
      source_tool_call_id: interactionColumn('source_tool_call_id'),
    };
  }
  if (table === 'runs') {
    const overrides: Record<string, string> = {};
    if (runtime.currentVersion < 7) overrides.execution_mode = "'foreground'";
    if (runtime.currentVersion < 8) {
      overrides.usage_reported =
        'CASE WHEN source_row.usage_input_tokens <> 0 OR source_row.usage_output_tokens <> 0 THEN 1 ELSE 0 END';
    }
    return overrides;
  }
  if (table === 'thread_event_retention' && runtime.currentVersion < 3) {
    return {
      last_event_seq: `MAX(
        COALESCE((
          SELECT MAX(event.seq) FROM legacy.thread_events AS event
          WHERE event.thread_id = source_row.thread_id
        ), 0),
        source_row.first_available_seq - 1
      )`,
    };
  }
  if (table === 'device_bash_operations' && deviceBash.currentVersion < 2) {
    return { post_processed_at: 'source_row.result_acknowledged_at' };
  }
  return {};
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
  const overrides = sourceColumnOverrides(inspection, table);
  const insertedColumns: string[] = [];
  const selectedExpressions: string[] = [];
  for (const column of targetColumns) {
    const override = overrides[column.name];
    if (override !== undefined) {
      insertedColumns.push(column.name);
      selectedExpressions.push(override);
    } else if (sourceColumns.has(column.name)) {
      insertedColumns.push(column.name);
      const expression = `source_row.${quoteIdentifier(column.name)}`;
      selectedExpressions.push(
        agentColumns[table]?.includes(column.name)
          ? normalizeAgentExpression(expression)
          : expression,
      );
    } else if (column.required && !column.hasDefault) {
      throw new Error(`Migration for ${table}.${column.name} is not defined.`);
    }
  }
  if (insertedColumns.length === 0) return;
  const needsInteraction =
    (table === 'inputs' &&
      namespaceVersion(inspection, 'server_runtime').currentVersion >= 7 &&
      namespaceVersion(inspection, 'server_runtime').currentVersion < 9) ||
    (table === 'context_messages' && hasLegacyInteractionMessages(inspection));
  const hasInteractions = inspection.tables.has('interactions');
  if (needsInteraction && !hasInteractions && sourceColumns.has('interaction_id')) {
    const orphan = target
      .prepare(
        `SELECT 1 AS present FROM legacy.${quoteIdentifier(table)} WHERE interaction_id IS NOT NULL LIMIT 1`,
      )
      .get();
    if (orphan)
      throw new Error(`Cannot resolve legacy ${table}.interaction_id without interactions.`);
  }
  const join =
    needsInteraction && hasInteractions
      ? ' LEFT JOIN legacy.interactions AS interaction ON interaction.interaction_id = source_row.interaction_id'
      : '';
  const sql = `INSERT INTO main.${quoteIdentifier(table)} (${insertedColumns.map(quoteIdentifier).join(', ')})
    SELECT ${selectedExpressions.join(', ')} FROM legacy.${quoteIdentifier(table)} AS source_row${join}`;
  target.prepare(sql).run();
}

function copyLegacyDeliveries(target: DatabaseSync): void {
  if (!target.prepare('SELECT 1 AS present FROM legacy.interaction_deliveries LIMIT 1').get())
    return;
  const contextTable = target
    .prepare(
      "SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND name = 'context_messages'",
    )
    .get();
  if (!contextTable) {
    throw new Error('Cannot resolve legacy interaction deliveries without context_messages.');
  }
  target.exec(`
    INSERT INTO main.interaction_deliveries (
      source_thread_id, source_agent_id, source_tool_call_id, owner_id, reply_thread_id,
      content, context_message_seq, run_id, status, created_at, updated_at, queued_at, consumed_at
    )
    SELECT
      interaction.source_thread_id,
      CASE WHEN interaction.source_agent_id = 'main' THEN 'thread' ELSE interaction.source_agent_id END,
      interaction.source_tool_call_id,
      source_row.owner_id,
      source_row.reply_thread_id,
      delivery_input.text,
      CASE WHEN source_row.status = 'consumed' THEN (
        SELECT message.seq FROM legacy.context_messages AS message
        WHERE message.source_input_id = source_row.input_id
          AND message.thread_id = source_row.reply_thread_id
          AND message.run_id = source_row.run_id
        ORDER BY message.seq DESC LIMIT 1
      ) ELSE NULL END,
      source_row.run_id,
      source_row.status,
      source_row.created_at,
      source_row.updated_at,
      source_row.queued_at,
      source_row.consumed_at
    FROM legacy.interaction_deliveries AS source_row
    JOIN legacy.interactions AS interaction ON interaction.interaction_id = source_row.interaction_id
    LEFT JOIN legacy.inputs AS delivery_input ON delivery_input.input_id = source_row.input_id
  `);
}

function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, entry]) => !key.startsWith('$') && entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function copyInitialDirectoryOperations(target: DatabaseSync): void {
  const targetColumns = columnDefinitions(target, 'environment_operations').map(
    (column) => column.name,
  );
  const placeholders = targetColumns.map(() => '?').join(', ');
  const insert = target.prepare(
    `INSERT INTO main.environment_operations (${targetColumns.map(quoteIdentifier).join(', ')})
     VALUES (${placeholders})`,
  );
  for (const value of target.prepare('SELECT * FROM legacy.environment_operations').iterate()) {
    const row = initialDirectoryOperationSchema.parse(value);
    const hasResult = row.result_recorded_at !== null;
    if (
      hasResult !== (row.result_outcome_json !== null) ||
      hasResult !== (row.result_status !== null)
    ) {
      throw new Error(`Legacy environment operation ${row.operation_id} has an incomplete result.`);
    }
    const targetReference = {
      envId: row.env_id,
      deviceBindingId: row.device_binding_id,
      instanceId: row.target_instance_id,
    };
    const action = {
      case: 'directoryCheck' as const,
      value: { path: row.path, loadWorkspace: row.load_workspace === 1 },
    };
    const outcome = hasResult
      ? {
          case: 'directoryCheck' as const,
          value: initialDirectoryOutcomeSchema.parse(JSON.parse(row.result_outcome_json ?? 'null')),
        }
      : undefined;
    const resultStatus = row.result_status;
    if (resultStatus !== null && resultStatus < OperationStatus.COMPLETED) {
      throw new Error(
        `Legacy environment operation ${row.operation_id} has a non-terminal result.`,
      );
    }
    const observedAt = hasResult ? new Date(row.result_recorded_at ?? '') : undefined;
    if (observedAt && !Number.isFinite(observedAt.getTime())) {
      throw new Error(
        `Legacy environment operation ${row.operation_id} has an invalid result time.`,
      );
    }
    const resultPayload =
      outcome && resultStatus !== null && observedAt
        ? encodeDaemonMessage({
            payload: {
              case: 'operationResult',
              value: {
                operationId: row.operation_id,
                target: targetReference,
                status: resultStatus,
                observedAt: {
                  seconds: BigInt(Math.floor(observedAt.getTime() / 1000)),
                  nanos: (observedAt.getTime() % 1000) * 1_000_000,
                },
                outcome,
              },
            },
          })
        : null;
    const values: Record<string, string | number | bigint | Uint8Array | null> = {
      operation_id: row.operation_id,
      tenant_id: row.tenant_id,
      env_id: row.env_id,
      device_id: row.device_id,
      device_binding_id: row.device_binding_id,
      target_instance_id: row.target_instance_id,
      binding_version: null,
      action: row.action,
      fingerprint: fingerprint({
        tenantId: row.tenant_id,
        target: targetReference,
        action,
        expiresAt: new Date(row.expires_at).toISOString(),
      }),
      path: row.path,
      cwd: null,
      read_offset: null,
      read_limit: null,
      content: null,
      binary_content: null,
      overwrite: null,
      create_parents: null,
      sync_action: null,
      sync_offset: null,
      transfer_id: null,
      total_size: null,
      executable: null,
      create_directory: null,
      conflict_scan: null,
      relative_paths_json: null,
      old_text: null,
      new_text: null,
      expected_occurrences: null,
      expected_file_version: null,
      command: null,
      timeout_seconds: null,
      load_workspace: row.load_workspace,
      delivery_state: row.delivery_state,
      status: row.status,
      cancel_requested: 0,
      cancel_reason: null,
      next_offset: zeroOffset,
      expires_at: row.expires_at,
      accepted_at: row.accepted_at,
      sent_at: row.sent_at,
      result_status: resultStatus,
      result_payload: resultPayload,
      result_fingerprint:
        outcome && resultStatus !== null ? fingerprint({ status: resultStatus, outcome }) : null,
      device_output_complete: hasResult ? 0 : null,
      result_end_offset: hasResult ? zeroOffset : null,
      output_complete: hasResult ? 1 : 0,
      output_gap: 0,
      result_source: hasResult ? 'device' : null,
      result_recorded_at: row.result_recorded_at,
      post_processed_at: row.post_processed_at,
      result_acknowledged_at: row.result_acknowledged_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    insert.run(
      ...targetColumns.map((column) => {
        const value = values[column];
        if (value === undefined) {
          throw new Error(`Migration for environment_operations.${column} is not defined.`);
        }
        return value;
      }),
    );
  }
}

function normalizeIncompleteToolCallIds(target: DatabaseSync): void {
  const sourceRowSchema = z.object({
    seq: z.number().int().positive().safe(),
    thread_id: z.string(),
    agent_id: z.string(),
    incomplete_tool_calls_json: z.string(),
  });
  const callsSchema = z.array(
    z.object({
      id: z.string().min(1).optional(),
      name: z.string().optional(),
      arguments_text: z.string(),
      error: z.string(),
    }),
  );
  const relationsSchema = z.array(
    z.object({
      call_id: z.string().min(1),
      tool_name: z.string(),
      arguments_text: z.string().nullable(),
      call_error: z.string().nullable(),
      result_seq: z.number().int().positive().safe().nullable(),
    }),
  );
  const relations = target.prepare(
    `SELECT call_id, tool_name, arguments_text, call_error, result_seq
     FROM context_tool_calls WHERE thread_id = ? AND agent_id = ?
       AND assistant_seq = ? AND call_type = 'incomplete' ORDER BY rowid`,
  );
  const update = target.prepare(
    'UPDATE context_messages SET incomplete_tool_calls_json = ? WHERE seq = ?',
  );
  const saveAudit = target.prepare(
    `INSERT INTO context_events(
      event_id, thread_id, agent_id, event_type, payload_json, created_at
    ) VALUES (?, ?, ?, 'incomplete_tool_ids_normalized', ?, ?)`,
  );
  for (const value of target
    .prepare(
      `SELECT seq, thread_id, agent_id, incomplete_tool_calls_json FROM context_messages
       WHERE role = 'assistant' AND incomplete_tool_calls_json IS NOT NULL ORDER BY seq`,
    )
    .iterate()) {
    const row = sourceRowSchema.parse(value);
    const calls = callsSchema.parse(JSON.parse(row.incomplete_tool_calls_json));
    const linked = relationsSchema.parse(relations.all(row.thread_id, row.agent_id, row.seq));
    if (calls.length !== linked.length) {
      throw new Error(`Incomplete tool relations for Context message ${row.seq} are inconsistent.`);
    }
    const remaining = new Set(linked);
    const normalized = calls.map((call, index) => {
      const matches = [...remaining].filter(
        (relation) =>
          relation.tool_name === (call.name ?? 'unknown') &&
          relation.arguments_text === call.arguments_text &&
          relation.call_error === call.error &&
          (call.id === undefined || relation.call_id === call.id),
      );
      const generated = matches.find(
        (relation) => relation.call_id === `incomplete-generated:${row.seq}:${index + 1}`,
      );
      const relation = generated ?? (matches.length === 1 ? matches[0] : undefined);
      if (!relation) {
        throw new Error(`Incomplete tool identity for Context message ${row.seq} is ambiguous.`);
      }
      remaining.delete(relation);
      if (relation.result_seq !== null) {
        const result = target
          .prepare(
            `SELECT 1 AS present FROM context_messages WHERE seq = ? AND role = 'tool'
             AND thread_id = ? AND agent_id = ? AND tool_call_id = ? AND tool_name = ?`,
          )
          .get(
            relation.result_seq,
            row.thread_id,
            row.agent_id,
            relation.call_id,
            relation.tool_name,
          );
        if (result === undefined) {
          throw new Error(`Incomplete tool result for Context message ${row.seq} is inconsistent.`);
        }
      }
      return { ...call, id: relation.call_id };
    });
    if (calls.every((call) => call.id !== undefined)) continue;
    update.run(JSON.stringify(normalized), row.seq);
    saveAudit.run(
      randomUUID(),
      row.thread_id,
      row.agent_id,
      JSON.stringify({
        message_seq: row.seq,
        original_incomplete_tool_calls_json: row.incomplete_tool_calls_json,
        normalized_ids: normalized.map((call) => call.id),
      }),
      new Date().toISOString(),
    );
  }
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
          if (
            table === 'environment_operations' &&
            namespaceVersion(inspection, 'environment_operations').variant === 'directory_v1'
          ) {
            copyInitialDirectoryOperations(target);
          } else if (
            table === 'interaction_deliveries' &&
            namespaceVersion(inspection, 'server_runtime').currentVersion < 9
          ) {
            copyLegacyDeliveries(target);
          } else {
            copyStandardTable(target, inspection, table);
          }
        }
        if (inspection.tables.has('sqlite_sequence')) {
          target.exec(`
          INSERT OR REPLACE INTO main.sqlite_sequence(name, seq)
          SELECT name, seq FROM legacy.sqlite_sequence
        `);
        }
        normalizeIncompleteToolCallIds(target);
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
      namespaces: inspection.namespaces.map((namespace) => ({
        namespace: namespace.namespace,
        currentVersion: namespace.requiredVersion,
        requiredVersion: namespace.requiredVersion,
        ...(namespace.variant === undefined ? {} : { variant: namespace.variant }),
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
