import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { executionEnvironmentSchema } from '../sessions/execution-environment-schema.js';
import { inTransaction } from './transaction.js';

const platformBusinessSchemaSQL = `
CREATE TABLE platform_environments (
  env_id TEXT PRIMARY KEY REFERENCES environments(env_id),
  tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(tenant_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE platform_usage_intents (
  env_id TEXT NOT NULL REFERENCES platform_environments(env_id),
  usage_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  kind TEXT NOT NULL CHECK(kind IN ('run','operation','reload')),
  status TEXT NOT NULL CHECK(status IN ('prepared','reserved','released')),
  operation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(env_id,usage_id)
);
CREATE TABLE platform_lifecycle_intents (
  operation_id TEXT PRIMARY KEY,
  env_id TEXT NOT NULL REFERENCES platform_environments(env_id),
  kind TEXT NOT NULL CHECK(kind IN ('create','pause','resume','delete')),
  status TEXT NOT NULL CHECK(status IN ('prepared','dispatched','unknown','completed','cancelled','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const contextRecapMigrations: readonly Migration[] = [
  {
    version: 8,
    name: 'context_recap_delegation_identity_final',
    sql: `
      CREATE TABLE context_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        content_blocks_json TEXT,
        response_usage_json TEXT,
        tool_calls_json TEXT,
        incomplete_tool_calls_json TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        tool_status TEXT CHECK(tool_status IN ('success', 'error')),
        tool_error_json TEXT,
        created_at TEXT NOT NULL,
        run_id TEXT,
        superseded_by_run_id TEXT,
        source TEXT CHECK(source IN (
          'user', 'thread_call', 'thread_response', 'subagent_response', 'automation',
          'thread_notification'
        )),
        delegation_source_thread_id TEXT,
        delegation_source_agent_id TEXT,
        source_tool_call_id TEXT,
        source_input_id TEXT,
        source_thread_id TEXT,
        source_agent_id TEXT,
        CHECK (
          (
            role IN ('system', 'user')
            AND content_blocks_json IS NULL
            AND response_usage_json IS NULL
            AND tool_calls_json IS NULL
            AND incomplete_tool_calls_json IS NULL
            AND tool_call_id IS NULL
            AND tool_name IS NULL
            AND tool_status IS NULL
            AND tool_error_json IS NULL
          )
          OR (
            role = 'assistant'
            AND tool_call_id IS NULL
            AND tool_name IS NULL
            AND tool_status IS NULL
            AND tool_error_json IS NULL
          )
          OR (
            role = 'tool'
            AND content_blocks_json IS NULL
            AND response_usage_json IS NULL
            AND tool_calls_json IS NULL
            AND incomplete_tool_calls_json IS NULL
            AND tool_call_id IS NOT NULL
            AND tool_name IS NOT NULL
          )
        )
      );

      CREATE UNIQUE INDEX context_messages_owner_seq
        ON context_messages(thread_id, agent_id, seq);
      CREATE INDEX context_messages_owner_created
        ON context_messages(thread_id, agent_id, created_at, seq);
      CREATE INDEX context_messages_delegation
        ON context_messages(
          delegation_source_thread_id, delegation_source_agent_id, source_tool_call_id, seq
        );

      CREATE TABLE context_message_revisions (
        revision_id TEXT PRIMARY KEY,
        message_seq INTEGER NOT NULL REFERENCES context_messages(seq),
        revision_number INTEGER NOT NULL CHECK (revision_number > 0),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        run_id TEXT,
        UNIQUE(message_seq, revision_number)
      );

      CREATE TABLE context_tool_calls (
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        assistant_seq INTEGER NOT NULL REFERENCES context_messages(seq),
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_seq INTEGER REFERENCES context_messages(seq),
        call_type TEXT NOT NULL DEFAULT 'complete'
          CHECK(call_type IN ('complete', 'incomplete')),
        arguments_text TEXT,
        call_error TEXT,
        PRIMARY KEY(thread_id, agent_id, call_id),
        UNIQUE(result_seq)
      );

      CREATE INDEX context_tool_calls_assistant
        ON context_tool_calls(assistant_seq);
      CREATE INDEX context_tool_calls_result
        ON context_tool_calls(result_seq);

      CREATE TABLE recaps (
        recap_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        source_seq_start INTEGER NOT NULL,
        source_seq_end INTEGER NOT NULL,
        source_message_seqs TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        validity TEXT NOT NULL CHECK (validity IN ('valid', 'invalid')),
        invalidated_at TEXT,
        invalidation_reason TEXT,
        UNIQUE(thread_id, agent_id, recap_id)
      );

      CREATE INDEX recaps_owner_validity
        ON recaps(thread_id, agent_id, validity, source_seq_start, source_seq_end);

      CREATE TABLE recap_sources (
        recap_id TEXT NOT NULL REFERENCES recaps(recap_id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position > 0),
        message_seq INTEGER NOT NULL REFERENCES context_messages(seq),
        PRIMARY KEY(recap_id, position),
        UNIQUE(recap_id, message_seq)
      );

      CREATE INDEX recap_sources_message
        ON recap_sources(message_seq, recap_id);

      CREATE TABLE model_input_states (
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        read_through_seq INTEGER NOT NULL DEFAULT 0,
        view_version INTEGER NOT NULL DEFAULT 0 CHECK(view_version >= 0),
        last_request_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(thread_id, agent_id)
      );

      CREATE TABLE model_input_recaps (
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        merge_position INTEGER NOT NULL CHECK(merge_position > 0),
        recap_id TEXT NOT NULL,
        PRIMARY KEY(thread_id, agent_id, merge_position),
        UNIQUE(thread_id, agent_id, recap_id),
        FOREIGN KEY(thread_id, agent_id, recap_id)
          REFERENCES recaps(thread_id, agent_id, recap_id)
      );

      CREATE TABLE model_request_records (
        request_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('preparing', 'ready', 'completed', 'failed', 'cancelled')
        ),
        estimated_input_tokens INTEGER,
        context_window_tokens INTEGER NOT NULL,
        output_reserve_tokens INTEGER NOT NULL,
        read_through_seq INTEGER NOT NULL,
        view_version INTEGER NOT NULL CHECK(view_version >= 0),
        selected_recap_ids_json TEXT NOT NULL,
        context_message_seqs_json TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        request_json TEXT,
        request_fingerprint TEXT,
        pending_context_seqs_json TEXT NOT NULL DEFAULT '[]',
        preparation_id TEXT,
        hard_cut INTEGER CHECK(hard_cut IN (0, 1))
      );

      CREATE INDEX model_request_records_owner_created
        ON model_request_records(thread_id, agent_id, created_at, request_id);

      CREATE TABLE context_events (
        event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX context_events_owner_seq
        ON context_events(thread_id, agent_id, event_seq);
    `,
  },
  {
    version: 9,
    name: 'periodic_recap_generation_operations_final',
    sql: `
      CREATE TABLE recap_generation_operations (
        operation_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        view_version INTEGER NOT NULL CHECK(view_version >= 0),
        source_message_seqs_json TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        instruction_version INTEGER NOT NULL CHECK(instruction_version > 0),
        request_fingerprint TEXT NOT NULL,
        operation_kind TEXT NOT NULL CHECK(operation_kind IN ('periodic')),
        status TEXT NOT NULL CHECK(status IN (
          'running', 'completed', 'failed', 'interrupted'
        )),
        recap_id TEXT REFERENCES recaps(recap_id),
        usage_json TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(status <> 'completed' OR recap_id IS NOT NULL)
      );

      CREATE INDEX recap_generation_operations_owner_status
        ON recap_generation_operations(thread_id, agent_id, status, updated_at);
    `,
  },
  {
    version: 10,
    name: 'recap_content_only_final',
    sql: '-- Recap records contain content and exact sources without a title.',
  },
  {
    version: 11,
    name: 'immutable_attachments_final',
    sql: `
      CREATE TABLE attachments (
        attachment_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        media_type TEXT NOT NULL CHECK(media_type IN ('text/plain', 'image/png', 'image/jpeg')),
        byte_size INTEGER NOT NULL CHECK(byte_size > 0),
        sha256 TEXT NOT NULL,
        content BLOB NOT NULL,
        width INTEGER,
        height INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE(owner_id, sha256),
        CHECK(
          (media_type = 'text/plain' AND width IS NULL AND height IS NULL)
          OR (media_type IN ('image/png', 'image/jpeg') AND width > 0 AND height > 0)
        )
      );

      CREATE TABLE context_message_attachments (
        message_seq INTEGER NOT NULL REFERENCES context_messages(seq) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position > 0),
        attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id),
        PRIMARY KEY(message_seq, position),
        UNIQUE(message_seq, attachment_id)
      );

      CREATE INDEX context_message_attachments_attachment
        ON context_message_attachments(attachment_id, message_seq);
    `,
  },
  {
    version: 12,
    name: 'identity_personal_tenant_sessions_final',
    sql: `
      CREATE TABLE users (
        user_id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        email_verified_at TEXT NOT NULL,
        username TEXT,
        tenant_id TEXT REFERENCES tenants(tenant_id),
        status TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE tenants (
        tenant_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        default_env_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE auth_email_verifications (
        verification_id TEXT PRIMARY KEY,
        client_action_id TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        source_address TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        delivery_status TEXT NOT NULL CHECK(delivery_status IN (
          'pending', 'sent', 'failed', 'not_required'
        )),
        delivery_error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        invalidated_at TEXT
      );
      CREATE INDEX auth_email_verifications_email_created
        ON auth_email_verifications(email, created_at, verification_id);
      CREATE INDEX auth_email_verifications_source_created
        ON auth_email_verifications(source_address, created_at, verification_id);
      CREATE INDEX auth_email_verifications_delivery_created
        ON auth_email_verifications(delivery_status, created_at, verification_id);

      CREATE TABLE auth_setup_credentials (
        credential_id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX auth_setup_credentials_email
        ON auth_setup_credentials(email, created_at, credential_id);

      CREATE TABLE auth_sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(user_id),
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX auth_sessions_user ON auth_sessions(user_id, created_at, session_id);
    `,
  },
  {
    version: 13,
    name: 'environment_registry_pairing_final',
    sql: `
      ALTER TABLE tenants ADD COLUMN default_env_explicit INTEGER NOT NULL DEFAULT 0
        CHECK(default_env_explicit IN (0, 1));

      CREATE TABLE environments (
        env_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('self_hosted_linux', 'self_hosted_macos', 'platform_sandbox')),
        recommended_pwd TEXT NOT NULL,
        binding_status TEXT NOT NULL CHECK(binding_status IN ('pairing', 'active', 'revoked')),
        connection_status TEXT NOT NULL CHECK(connection_status IN ('offline', 'online')),
        capability_status TEXT NOT NULL CHECK(capability_status IN ('pending', 'ready', 'failed')),
        directory_status TEXT NOT NULL CHECK(directory_status IN ('pending', 'ready', 'failed')),
        maintenance_mode TEXT NOT NULL DEFAULT 'normal'
          CHECK(maintenance_mode IN ('normal', 'draining')),
        maintenance_version TEXT NOT NULL DEFAULT '0',
        authorized_capabilities_json TEXT NOT NULL,
        granted_capabilities_json TEXT NOT NULL,
        device_id TEXT,
        device_binding_id TEXT,
        instance_id TEXT,
        daemon_version TEXT,
        os TEXT,
        architecture TEXT,
        status_reason TEXT,
        normalized_pwd TEXT,
        checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        paired_at TEXT,
        revoked_at TEXT,
        last_seen_at TEXT
      );
      CREATE INDEX environments_tenant_created
        ON environments(tenant_id, created_at, env_id);
      CREATE INDEX environments_binding_connection
        ON environments(tenant_id, binding_status, connection_status, env_id);
      CREATE UNIQUE INDEX environments_current_binding
        ON environments(device_binding_id) WHERE device_binding_id IS NOT NULL;

      CREATE TABLE environment_pairing_credentials (
        credential_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        env_id TEXT NOT NULL REFERENCES environments(env_id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK(purpose IN ('daemon_pairing')),
        credential_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        invalidated_at TEXT
      );
      CREATE INDEX environment_pairing_credentials_env
        ON environment_pairing_credentials(env_id, created_at, credential_id);
      CREATE INDEX environment_pairing_credentials_expiry
        ON environment_pairing_credentials(expires_at, credential_id);

      CREATE TABLE environment_device_bindings (
        device_binding_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        env_id TEXT NOT NULL REFERENCES environments(env_id) ON DELETE CASCADE,
        device_id TEXT NOT NULL UNIQUE,
        credential_hash TEXT,
        status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'revoked')),
        granted_capabilities_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        paired_at TEXT NOT NULL,
        revoked_at TEXT,
        last_seen_at TEXT
      );
      CREATE INDEX environment_device_bindings_env
        ON environment_device_bindings(env_id, status, created_at, device_binding_id);
      CREATE INDEX environment_device_bindings_tenant
        ON environment_device_bindings(tenant_id, status, device_binding_id);
    `,
  },
  {
    version: 14,
    name: 'agent_environment_policies_final',
    sql: `
      CREATE TABLE agent_environment_policies (
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        allowed_env_json TEXT,
        default_env TEXT,
        default_pwd TEXT,
        policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version > 0),
        current_history_id TEXT NOT NULL,
        current_env TEXT,
        current_pwd TEXT,
        current_binding_version INTEGER NOT NULL CHECK(current_binding_version >= 0),
        current_resource_version TEXT,
        source_thread_id TEXT,
        source_agent_id TEXT,
        source_tool_call_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(thread_id, agent_id),
        CHECK((default_env IS NULL) = (default_pwd IS NULL)),
        CHECK(
          (current_env IS NULL AND current_pwd IS NULL AND current_resource_version IS NULL)
          OR (current_env IS NOT NULL AND current_pwd IS NOT NULL)
        )
      );
      CREATE INDEX agent_environment_policies_current
        ON agent_environment_policies(thread_id, current_env, current_binding_version);

      CREATE TABLE agent_environment_binding_history (
        history_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        binding_version INTEGER NOT NULL CHECK(binding_version >= 0),
        env_id TEXT,
        pwd TEXT,
        resource_version TEXT,
        resources_json TEXT,
        reason TEXT NOT NULL CHECK(reason IN ('initial', 'switch', 'reload', 'rerun')),
        restored_from_history_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(thread_id, agent_id, history_id),
        CHECK(
          (env_id IS NULL AND pwd IS NULL AND resource_version IS NULL AND resources_json IS NULL)
          OR (
            env_id IS NOT NULL AND pwd IS NOT NULL
            AND (
              (resource_version IS NULL AND resources_json IS NULL)
              OR (resource_version IS NOT NULL AND resources_json IS NOT NULL)
            )
          )
        )
      );
      CREATE INDEX agent_environment_binding_history_owner
        ON agent_environment_binding_history(thread_id, agent_id, binding_version, created_at);
      CREATE INDEX agent_environment_binding_history_message
        ON agent_environment_binding_history(thread_id, agent_id, created_at, history_id);

      CREATE TABLE agent_environment_message_bindings (
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        message_seq INTEGER NOT NULL REFERENCES context_messages(seq) ON DELETE CASCADE,
        history_id TEXT NOT NULL,
        binding_version INTEGER NOT NULL CHECK(binding_version >= 0),
        resource_version TEXT,
        PRIMARY KEY(thread_id, agent_id, message_seq),
        FOREIGN KEY(thread_id, agent_id, history_id)
          REFERENCES agent_environment_binding_history(thread_id, agent_id, history_id)
      );
      CREATE INDEX agent_environment_message_bindings_history
        ON agent_environment_message_bindings(thread_id, agent_id, history_id, message_seq);

      CREATE TABLE agent_environment_requests (
        request_id TEXT PRIMARY KEY REFERENCES model_request_records(request_id),
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        history_id TEXT NOT NULL,
        binding_version INTEGER NOT NULL CHECK(binding_version >= 0),
        resource_version TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(thread_id, agent_id, history_id)
          REFERENCES agent_environment_binding_history(thread_id, agent_id, history_id)
      );
      CREATE INDEX agent_environment_requests_owner
        ON agent_environment_requests(thread_id, agent_id, created_at, request_id);

      CREATE TABLE agent_environment_operations (
        operation_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        tool_call_id TEXT NOT NULL,
        history_id TEXT NOT NULL,
        env_id TEXT NOT NULL,
        binding_version INTEGER NOT NULL CHECK(binding_version >= 0),
        action TEXT NOT NULL CHECK(action IN (
          'read', 'read_image', 'write', 'edit', 'bash', 'directory_check', 'env_switch'
        )),
        result_content TEXT,
        result_status TEXT CHECK(result_status IN ('success', 'error')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, tool_call_id),
        FOREIGN KEY(thread_id, agent_id, history_id)
          REFERENCES agent_environment_binding_history(thread_id, agent_id, history_id)
      );
      CREATE INDEX agent_environment_operations_owner
        ON agent_environment_operations(thread_id, agent_id, created_at, operation_id);
    `,
  },
  {
    version: 15,
    name: 'optional_agent_environment_bindings_final',
    sql: '-- Agent policies support an unbound initial state and tenant-scoped environment access.',
  },
  {
    version: 16,
    name: 'connected_device_management_final',
    sql: `
      ALTER TABLE environments ADD COLUMN auto_detect INTEGER NOT NULL DEFAULT 0
        CHECK(auto_detect IN (0, 1));
      ALTER TABLE environments ADD COLUMN settings_version TEXT NOT NULL DEFAULT '0';
      CREATE TABLE environment_favorite_directories (
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        env_id TEXT NOT NULL REFERENCES environments(env_id),
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, env_id, path)
      );
    `,
  },
  {
    version: 17,
    name: 'agent_image_tool_results_final',
    sql: '-- Agent environment operations accept read_image and reuse Context attachment associations.',
  },
  {
    version: 18,
    name: 'persisted_incomplete_tool_call_identity',
    sql: '-- Explicit offline migration normalizes incomplete tool IDs from their exact relations.',
  },
  {
    version: 19,
    name: 'platform_sandbox_and_fixed_execution_environment',
    sql: `
      ALTER TABLE environments ADD COLUMN platform_lifecycle_state TEXT CHECK(
        platform_lifecycle_state IS NULL OR platform_lifecycle_state IN (
          'uninitialized','starting','running','pausing','paused','resuming','deleting','deleted','error'
        )
      );
      ${platformBusinessSchemaSQL}
      ${executionEnvironmentSchema}
    `,
  },
  {
    version: 20,
    name: 'shared_tenant_sandbox_workspace',
    sql: '-- Offline migration fixes all Agent workspaces to the tenant sandbox and preserves historical execution specifications.',
  },
  {
    version: 21,
    name: 'account_and_model_settings',
    sql: `
      CREATE TABLE user_profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(user_id),
        version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
        avatar_id TEXT,
        avatar_bytes BLOB,
        CHECK((avatar_id IS NULL) = (avatar_bytes IS NULL))
      );
      CREATE TABLE model_settings (
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id),
        version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
        default_model_id TEXT NOT NULL DEFAULT 'platform'
      );
      CREATE TABLE model_connections (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        name TEXT NOT NULL,
        api_type INTEGER NOT NULL CHECK(api_type IN (1, 2, 3)),
        base_url TEXT NOT NULL,
        encrypted_key TEXT,
        models_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        PRIMARY KEY(tenant_id, id)
      );
      CREATE TABLE settings_actions (
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        action_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        PRIMARY KEY(tenant_id, action_id)
      );
      CREATE TABLE run_model_configurations (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        configuration_json TEXT NOT NULL,
        encrypted_key TEXT
      );
      CREATE TABLE request_model_configurations (
        request_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
        configuration_json TEXT NOT NULL
      );
    `,
  },
  {
    version: 22,
    name: 'workspace_attachment_locations',
    sql: `
      ALTER TABLE context_message_attachments ADD COLUMN source TEXT NOT NULL DEFAULT 'file'
        CHECK(source IN ('file', 'clipboard'));
      ALTER TABLE context_message_attachments ADD COLUMN workspace_required INTEGER NOT NULL DEFAULT 0
        CHECK(workspace_required IN (0, 1));
      ALTER TABLE context_message_attachments ADD COLUMN workspace_status TEXT
        CHECK(workspace_status IN ('pending', 'completed'));
      ALTER TABLE context_message_attachments ADD COLUMN env_id TEXT;
      ALTER TABLE context_message_attachments ADD COLUMN path TEXT;
      ALTER TABLE context_message_attachments ADD COLUMN operation_id TEXT;
    `,
  },
  {
    version: 23,
    name: 'automation_context_provenance',
    sql: `
      ALTER TABLE context_messages ADD COLUMN automation_schedule_id TEXT;
      ALTER TABLE context_messages ADD COLUMN automation_fire_id TEXT;
      ALTER TABLE context_messages ADD COLUMN automation_trigger TEXT
        CHECK(automation_trigger IS NULL OR automation_trigger IN ('scheduled', 'run_now'));
      ALTER TABLE context_messages ADD COLUMN automation_scheduled_at TEXT;
    `,
  },
  {
    version: 24,
    name: 'thread_notification_message_source',
    sql: '-- Offline migration rebuilds Context source constraints for task notifications to the main Thread.',
  },
  {
    version: 25,
    name: 'openai_responses_and_anthropic_model_api_types',
    sql: '-- Offline migration rebuilds model_connections with OpenAI Responses and Anthropic Messages API types.',
  },
];

const tableNameRowSchema = z.object({ name: z.string() });
const versionRowSchema = z.object({ version: z.number().int().nonnegative() });

export class SchemaMigrationRequiredError extends Error {
  constructor(
    readonly namespace: string,
    readonly currentVersion: number,
    readonly requiredVersion: number,
  ) {
    super(
      `Database schema ${namespace}/${currentVersion} requires an explicit upgrade to version ${requiredVersion}.`,
    );
    this.name = 'SchemaMigrationRequiredError';
  }
}

export interface MigrationInspection {
  kind: 'empty' | 'current' | 'upgrade';
  currentVersion: number;
  requiredVersion: number;
}

export function inspectMigration(
  database: DatabaseSync,
  migrations: readonly Migration[] = contextRecapMigrations,
  namespace = 'context_recap',
): MigrationInspection {
  const tables = new Set(
    z
      .array(tableNameRowSchema)
      .parse(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())
      .map((row) => row.name),
  );
  const migrationColumns = tables.has('schema_migrations')
    ? new Set(
        z
          .array(tableNameRowSchema)
          .parse(database.prepare('PRAGMA table_info(schema_migrations)').all())
          .map((row) => row.name),
      )
    : new Set<string>();
  const hasNamespacedMigrations = migrationColumns.has('namespace');
  const current = tables.has('schema_migrations')
    ? namespace === 'context_recap' && !hasNamespacedMigrations
      ? versionRowSchema.parse(
          database
            .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
            .get(),
        ).version
      : hasNamespacedMigrations
        ? versionRowSchema.parse(
            database
              .prepare(
                'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE namespace = ?',
              )
              .get(namespace),
          ).version
        : 0
    : 0;
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new Error(`Database schema version ${namespace}/${current} is newer than this Server.`);
  }
  if (current === latest) {
    return { kind: 'current', currentVersion: current, requiredVersion: latest };
  }

  const ownedTables = migrationTableNames(migrations);
  const hasUnversionedTables = [...ownedTables].some((table) => tables.has(table));
  const hasUnversionedApplicationTables =
    !tables.has('schema_migrations') && [...tables].some((table) => table !== 'sqlite_sequence');
  return {
    kind:
      current !== 0 || hasUnversionedTables || hasUnversionedApplicationTables
        ? 'upgrade'
        : 'empty',
    currentVersion: current,
    requiredVersion: latest,
  };
}

export function migrateDatabase(
  database: DatabaseSync,
  migrations: readonly Migration[] = contextRecapMigrations,
  namespace = 'context_recap',
): void {
  const inspection = inspectMigration(database, migrations, namespace);
  if (inspection.kind === 'current') return;
  if (inspection.kind === 'upgrade') {
    throw new SchemaMigrationRequiredError(
      namespace,
      inspection.currentVersion,
      inspection.requiredVersion,
    );
  }

  let previousVersion = 0;
  for (const migration of migrations) {
    if (migration.version <= previousVersion) {
      throw new Error(`Migration ${namespace}/${migration.version} is not ordered.`);
    }
    previousVersion = migration.version;
  }
  inTransaction(database, () => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        namespace TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY(namespace, version)
      );
    `);
    for (const migration of migrations) {
      database.exec(migration.sql);
      database
        .prepare(
          'INSERT INTO schema_migrations(namespace, version, name, applied_at) VALUES (?, ?, ?, ?)',
        )
        .run(namespace, migration.version, migration.name, new Date().toISOString());
    }
  });
}

export function migrationTableNames(migrations: readonly Migration[]): Set<string> {
  const names = new Set<string>();
  const pattern = /(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const migration of migrations) {
    for (const match of migration.sql.matchAll(pattern)) {
      if (match[1]) names.add(match[1]);
    }
  }
  names.delete('schema_migrations');
  names.delete('threads_next');
  return names;
}
