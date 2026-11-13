import type { Migration } from './migrations.js';

export const deviceMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'devices_v1_baseline',
    sql: `
CREATE TABLE device_pairing_credentials (
        device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
        credential_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
CREATE TABLE devices (
        device_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        account_description TEXT NOT NULL,
        bash_enabled INTEGER NOT NULL CHECK (bash_enabled IN (0, 1)),
        credential_hash TEXT,
        status TEXT NOT NULL CHECK (status IN ('pairing', 'active', 'revoked')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        paired_at TEXT,
        revoked_at TEXT,
        last_seen_at TEXT
      );
CREATE INDEX device_pairing_expiry ON device_pairing_credentials(expires_at);
CREATE INDEX devices_owner_status ON devices(owner_id, status, device_id);
    `,
  },
];

export const environmentOperationMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'environment_operations_v1_baseline',
    sql: `
CREATE TABLE environment_operation_output_chunks (
        operation_id TEXT NOT NULL REFERENCES environment_operations(operation_id) ON DELETE CASCADE,
        offset TEXT NOT NULL,
        end_offset TEXT NOT NULL,
        stream INTEGER NOT NULL CHECK (stream IN (1, 2)),
        data BLOB NOT NULL,
        PRIMARY KEY(operation_id, offset)
      );
CREATE TABLE environment_operations (
        operation_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        env_id TEXT NOT NULL REFERENCES environments(env_id),
        device_id TEXT NOT NULL,
        device_binding_id TEXT NOT NULL REFERENCES environment_device_bindings(device_binding_id),
        target_instance_id TEXT NOT NULL,
        binding_version TEXT,
        action TEXT NOT NULL CHECK (action IN ('read', 'read_image', 'write', 'edit', 'bash', 'directory_check', 'directory_list')),
        fingerprint TEXT NOT NULL,
        path TEXT,
        cwd TEXT,
        read_offset INTEGER,
        read_limit INTEGER,
        content TEXT,
        overwrite INTEGER CHECK (overwrite IN (0, 1)),
        old_text TEXT,
        new_text TEXT,
        expected_occurrences INTEGER,
        expected_file_version TEXT,
        command TEXT,
        timeout_seconds INTEGER,
        load_workspace INTEGER CHECK (load_workspace IN (0, 1)),
        delivery_state TEXT NOT NULL CHECK (delivery_state IN ('intent', 'sent')),
        status INTEGER NOT NULL CHECK (status BETWEEN 1 AND 9),
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
        cancel_reason TEXT,
        next_offset TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        accepted_at TEXT,
        sent_at TEXT,
        result_status INTEGER CHECK (result_status BETWEEN 5 AND 9),
        result_payload BLOB,
        result_fingerprint TEXT,
        device_output_complete INTEGER CHECK (device_output_complete IN (0, 1)),
        result_end_offset TEXT,
        output_complete INTEGER NOT NULL DEFAULT 0 CHECK (output_complete IN (0, 1)),
        output_gap INTEGER NOT NULL DEFAULT 0 CHECK (output_gap IN (0, 1)),
        result_source TEXT CHECK (result_source IN ('device', 'recovery')),
        result_recorded_at TEXT,
        post_processed_at TEXT,
        result_acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , binary_content BLOB, create_parents INTEGER
        CHECK(create_parents IN (0, 1)), sync_action TEXT
        CHECK(sync_action IN ('sync_scan', 'sync_read', 'sync_write', 'sync_directory')), sync_offset TEXT, transfer_id TEXT, total_size TEXT, executable INTEGER
        CHECK(executable IN (0, 1)), create_directory INTEGER
        CHECK(create_directory IN (0, 1)), conflict_scan INTEGER
        CHECK(conflict_scan IN (0, 1)), relative_paths_json TEXT, search_action TEXT
        CHECK(search_action IN ('glob', 'grep')), pattern TEXT, include_glob TEXT, grep_mode TEXT
        CHECK(grep_mode IN ('content', 'files_with_matches', 'count')), case_insensitive INTEGER
        CHECK(case_insensitive IN (0, 1)), line_numbers INTEGER
        CHECK(line_numbers IN (0, 1)), search_offset INTEGER, search_limit INTEGER);
CREATE TABLE environment_sync_files (
        sync_file_id TEXT PRIMARY KEY,
        sync_id TEXT NOT NULL REFERENCES environment_syncs(sync_id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('file', 'directory')),
        size TEXT NOT NULL DEFAULT '0',
        source_sha256 TEXT NOT NULL DEFAULT '',
        target_sha256 TEXT NOT NULL DEFAULT '',
        target_exists INTEGER NOT NULL DEFAULT 0 CHECK(target_exists IN (0, 1)),
        executable INTEGER NOT NULL DEFAULT 0 CHECK(executable IN (0, 1)),
        status TEXT NOT NULL CHECK(status IN (
          'pending', 'ready', 'running', 'succeeded', 'skipped', 'failed', 'unknown'
        )),
        operation_id TEXT,
        error TEXT,
        bytes_transferred TEXT NOT NULL DEFAULT '0',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(sync_id, relative_path)
      );
CREATE TABLE environment_syncs (
        sync_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        source_env_id TEXT NOT NULL REFERENCES environments(env_id),
        target_env_id TEXT NOT NULL REFERENCES environments(env_id),
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        on_conflict TEXT NOT NULL CHECK(on_conflict IN ('fail', 'skip', 'overwrite')),
        status TEXT NOT NULL CHECK(status IN (
          'running', 'completed', 'partial', 'failed', 'cancelled', 'unknown'
        )),
        source_kind TEXT CHECK(source_kind IN ('file', 'directory')),
        file_count INTEGER NOT NULL DEFAULT 0 CHECK(file_count >= 0),
        total_bytes TEXT NOT NULL DEFAULT '0',
        succeeded INTEGER NOT NULL DEFAULT 0 CHECK(succeeded >= 0),
        skipped INTEGER NOT NULL DEFAULT 0 CHECK(skipped >= 0),
        failed INTEGER NOT NULL DEFAULT 0 CHECK(failed >= 0),
        failures_json TEXT NOT NULL DEFAULT '[]',
        current_operation_id TEXT,
        deadline_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(run_id, tool_call_id)
      );
CREATE INDEX environment_operation_output_range
        ON environment_operation_output_chunks(operation_id, end_offset, offset);
CREATE INDEX environment_operations_environment
        ON environment_operations(tenant_id, env_id, created_at, operation_id);
CREATE INDEX environment_operations_instance
        ON environment_operations(device_binding_id, target_instance_id, result_recorded_at);
CREATE INDEX environment_sync_files_status
        ON environment_sync_files(sync_id, status, relative_path);
CREATE INDEX environment_syncs_tenant_status
        ON environment_syncs(tenant_id, status, updated_at);
    `,
  },
];
