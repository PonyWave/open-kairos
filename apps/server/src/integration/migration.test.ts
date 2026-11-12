import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { BashStatus, OperationStatus, OutputStream } from '@kairos/contracts/device';
import { afterEach, describe, expect, it } from 'vitest';
import { deviceMigrations } from '../devices/device-store.js';
import {
  EnvironmentOperationStore,
  environmentOperationMigrations,
} from '../devices/environment-operation-store.js';
import { DeviceBashStore, deviceBashMigrations } from '../devices/operation-store.js';
import { sessionMigrations } from '../sessions/migrations.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { contextRecapMigrations, type Migration, migrateDatabase } from '../storage/migrations.js';
import { migrateServerDatabase } from '../storage/server-schema.js';
import { checkDatabaseFile, upgradeDatabaseFile } from '../storage/upgrades.js';
import { seedTestSession } from './test-authentication.js';

const directories: string[] = [];
const timestamp = '2026-11-01T00:00:00.000Z';
const zeroOffset = '0'.repeat(20);

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'kairos-migration-'));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function install(
  database: DatabaseSync,
  migrations: readonly Migration[],
  namespace: string,
  version: number,
): void {
  migrateDatabase(
    database,
    migrations.filter((migration) => migration.version <= version),
    namespace,
  );
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const contextEarlyMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'context_recap_initial',
    sql: `
      CREATE TABLE context_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        tool_calls_json TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        created_at TEXT NOT NULL,
        run_id TEXT,
        CHECK (
          (role IN ('system', 'user') AND tool_calls_json IS NULL AND tool_call_id IS NULL AND tool_name IS NULL)
          OR (role = 'assistant' AND tool_call_id IS NULL AND tool_name IS NULL)
          OR (role = 'tool' AND tool_calls_json IS NULL AND tool_call_id IS NOT NULL AND tool_name IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX context_messages_owner_seq ON context_messages(thread_id, agent_id, seq);
      CREATE INDEX context_messages_owner_created ON context_messages(thread_id, agent_id, created_at, seq);
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
        PRIMARY KEY(thread_id, agent_id, call_id),
        UNIQUE(result_seq)
      );
      CREATE INDEX context_tool_calls_assistant ON context_tool_calls(assistant_seq);
      CREATE INDEX context_tool_calls_result ON context_tool_calls(result_seq);
      CREATE TABLE recaps (
        recap_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        source_seq_start INTEGER NOT NULL,
        source_seq_end INTEGER NOT NULL,
        source_message_seqs TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        validity TEXT NOT NULL CHECK (validity IN ('valid', 'invalid')),
        invalidated_at TEXT,
        invalidation_reason TEXT,
        UNIQUE(thread_id, agent_id, recap_id)
      );
      CREATE INDEX recaps_owner_validity ON recaps(thread_id, agent_id, validity, source_seq_start, source_seq_end);
      CREATE TABLE recap_sources (
        recap_id TEXT NOT NULL REFERENCES recaps(recap_id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position > 0),
        message_seq INTEGER NOT NULL REFERENCES context_messages(seq),
        PRIMARY KEY(recap_id, position),
        UNIQUE(recap_id, message_seq)
      );
      CREATE INDEX recap_sources_message ON recap_sources(message_seq, recap_id);
      CREATE TABLE model_input_states (
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        read_through_seq INTEGER NOT NULL DEFAULT 0,
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
        FOREIGN KEY(thread_id, agent_id, recap_id) REFERENCES recaps(thread_id, agent_id, recap_id)
      );
      CREATE TABLE model_request_records (
        request_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'completed', 'failed', 'cancelled')),
        estimated_input_tokens INTEGER,
        context_window_tokens INTEGER NOT NULL,
        output_reserve_tokens INTEGER NOT NULL,
        read_through_seq INTEGER NOT NULL,
        selected_recap_ids_json TEXT NOT NULL,
        context_message_seqs_json TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX model_request_records_owner_created ON model_request_records(thread_id, agent_id, created_at, request_id);
      CREATE TABLE context_events (
        event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX context_events_owner_seq ON context_events(thread_id, agent_id, event_seq);
    `,
  },
  {
    version: 2,
    name: 'context_complete_tool_message_fields',
    sql: `
      ALTER TABLE context_messages ADD COLUMN incomplete_tool_calls_json TEXT;
      ALTER TABLE context_messages ADD COLUMN tool_status TEXT CHECK(tool_status IN ('success', 'error'));
      ALTER TABLE context_messages ADD COLUMN tool_error_json TEXT;
      ALTER TABLE context_tool_calls ADD COLUMN call_type TEXT NOT NULL DEFAULT 'complete' CHECK(call_type IN ('complete', 'incomplete'));
      ALTER TABLE context_tool_calls ADD COLUMN arguments_text TEXT;
      ALTER TABLE context_tool_calls ADD COLUMN call_error TEXT;
    `,
  },
  {
    version: 3,
    name: 'model_request_complete_payload',
    sql: 'ALTER TABLE model_request_records ADD COLUMN request_json TEXT;',
  },
  {
    version: 4,
    name: 'model_request_idempotent_preparation',
    sql: `
      ALTER TABLE model_request_records ADD COLUMN request_fingerprint TEXT;
      ALTER TABLE model_request_records ADD COLUMN pending_context_seqs_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE model_request_records ADD COLUMN preparation_id TEXT;
      ALTER TABLE model_request_records ADD COLUMN hard_cut INTEGER CHECK(hard_cut IN (0, 1));
    `,
  },
];

const contextDelegationMigrations: readonly Migration[] = [
  {
    version: 5,
    name: 'context_recap_delegation_final',
    sql: `
      CREATE TABLE context_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        tool_calls_json TEXT,
        incomplete_tool_calls_json TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        tool_status TEXT CHECK(tool_status IN ('success', 'error')),
        tool_error_json TEXT,
        created_at TEXT NOT NULL,
        run_id TEXT,
        source TEXT CHECK(source IN ('user', 'thread_call', 'thread_response', 'subagent_response')),
        interaction_id TEXT,
        source_input_id TEXT,
        source_thread_id TEXT,
        source_agent_id TEXT,
        CHECK (
          (role IN ('system', 'user') AND tool_calls_json IS NULL AND incomplete_tool_calls_json IS NULL
            AND tool_call_id IS NULL AND tool_name IS NULL AND tool_status IS NULL AND tool_error_json IS NULL)
          OR (role = 'assistant' AND tool_call_id IS NULL AND tool_name IS NULL
            AND tool_status IS NULL AND tool_error_json IS NULL)
          OR (role = 'tool' AND tool_calls_json IS NULL AND incomplete_tool_calls_json IS NULL
            AND tool_call_id IS NOT NULL AND tool_name IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX context_messages_owner_seq ON context_messages(thread_id, agent_id, seq);
      CREATE INDEX context_messages_owner_created ON context_messages(thread_id, agent_id, created_at, seq);
      CREATE INDEX context_messages_interaction ON context_messages(interaction_id, seq);
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
        call_type TEXT NOT NULL DEFAULT 'complete' CHECK(call_type IN ('complete', 'incomplete')),
        arguments_text TEXT,
        call_error TEXT,
        PRIMARY KEY(thread_id, agent_id, call_id),
        UNIQUE(result_seq)
      );
      CREATE INDEX context_tool_calls_assistant ON context_tool_calls(assistant_seq);
      CREATE INDEX context_tool_calls_result ON context_tool_calls(result_seq);
      CREATE TABLE recaps (
        recap_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        source_seq_start INTEGER NOT NULL,
        source_seq_end INTEGER NOT NULL,
        source_message_seqs TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        validity TEXT NOT NULL CHECK (validity IN ('valid', 'invalid')),
        invalidated_at TEXT,
        invalidation_reason TEXT,
        UNIQUE(thread_id, agent_id, recap_id)
      );
      CREATE INDEX recaps_owner_validity ON recaps(thread_id, agent_id, validity, source_seq_start, source_seq_end);
      CREATE TABLE recap_sources (
        recap_id TEXT NOT NULL REFERENCES recaps(recap_id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position > 0),
        message_seq INTEGER NOT NULL REFERENCES context_messages(seq),
        PRIMARY KEY(recap_id, position),
        UNIQUE(recap_id, message_seq)
      );
      CREATE INDEX recap_sources_message ON recap_sources(message_seq, recap_id);
      CREATE TABLE model_input_states (
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        read_through_seq INTEGER NOT NULL DEFAULT 0,
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
        FOREIGN KEY(thread_id, agent_id, recap_id) REFERENCES recaps(thread_id, agent_id, recap_id)
      );
      CREATE TABLE model_request_records (
        request_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'completed', 'failed', 'cancelled')),
        estimated_input_tokens INTEGER,
        context_window_tokens INTEGER NOT NULL,
        output_reserve_tokens INTEGER NOT NULL,
        read_through_seq INTEGER NOT NULL,
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
      CREATE INDEX model_request_records_owner_created ON model_request_records(thread_id, agent_id, created_at, request_id);
      CREATE TABLE context_events (
        event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX context_events_owner_seq ON context_events(thread_id, agent_id, event_seq);
    `,
  },
  {
    version: 6,
    name: 'context_recap_thinking_response_final',
    sql: `
      ALTER TABLE context_messages ADD COLUMN content_blocks_json TEXT;
      ALTER TABLE context_messages ADD COLUMN response_usage_json TEXT;
    `,
  },
  {
    version: 7,
    name: 'context_recap_current_view_final',
    sql: `
      ALTER TABLE context_messages ADD COLUMN superseded_by_run_id TEXT;
      ALTER TABLE model_input_states ADD COLUMN view_version INTEGER NOT NULL DEFAULT 0 CHECK(view_version >= 0);
      ALTER TABLE model_request_records ADD COLUMN view_version INTEGER NOT NULL DEFAULT 0 CHECK(view_version >= 0);
    `,
  },
];

const runtimeEarlyMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'server_runtime_initial',
    sql: `
      CREATE TABLE threads (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX threads_owner_seq ON threads(owner_id, seq);
      CREATE TABLE thread_queues (
        thread_id TEXT PRIMARY KEY REFERENCES threads(thread_id) ON DELETE CASCADE,
        queue_version INTEGER NOT NULL DEFAULT 0,
        next_position INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE inputs (
        input_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        text TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('follow_up', 'steer')),
        status TEXT NOT NULL CHECK(status IN ('queued', 'consumed', 'cancelled')),
        position INTEGER NOT NULL CHECK(position > 0),
        version INTEGER NOT NULL CHECK(version > 0),
        consumed_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(thread_id, position)
      );
      CREATE INDEX inputs_thread_status_position ON inputs(thread_id, status, position);
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'waiting', 'cancel_requested', 'completed', 'failed', 'cancelled', 'interrupted')),
        input_ids_json TEXT NOT NULL DEFAULT '[]',
        parent_run_id TEXT REFERENCES runs(run_id),
        error_code TEXT,
        error_message TEXT,
        error_retryable INTEGER CHECK(error_retryable IN (0, 1)),
        usage_input_tokens INTEGER NOT NULL DEFAULT 0,
        usage_output_tokens INTEGER NOT NULL DEFAULT 0,
        current_request_id TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX runs_thread_created ON runs(thread_id, created_at, run_id);
      CREATE INDEX runs_thread_active ON runs(thread_id, status);
      CREATE TABLE client_actions (
        owner_id TEXT NOT NULL,
        client_action_id TEXT NOT NULL,
        method TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, client_action_id)
      );
      CREATE TABLE thread_events (
        event_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK(seq > 0),
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(thread_id, seq)
      );
      CREATE INDEX thread_events_thread_seq ON thread_events(thread_id, seq);
      CREATE TABLE thread_event_retention (
        thread_id TEXT PRIMARY KEY REFERENCES threads(thread_id) ON DELETE CASCADE,
        first_available_seq INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE server_bash_operations (
        operation_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        tool_call_id TEXT NOT NULL,
        log_path TEXT,
        output_complete INTEGER NOT NULL CHECK(output_complete IN (0, 1)),
        end_offset TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, tool_call_id)
      );
      CREATE INDEX server_bash_operations_owner ON server_bash_operations(owner_id, created_at, operation_id);
    `,
  },
  {
    version: 2,
    name: 'device_tool_result_post_processing',
    sql: `
      CREATE TABLE device_tool_calls (
        operation_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        tool_call_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, tool_call_id)
      );
      CREATE INDEX device_tool_calls_owner ON device_tool_calls(owner_id, operation_id);
      CREATE TABLE device_tool_results (
        operation_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        tool_call_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('success', 'error')),
        created_at TEXT NOT NULL,
        UNIQUE(run_id, tool_call_id)
      );
    `,
  },
  {
    version: 3,
    name: 'event_high_water_and_tool_recovery',
    sql: `
      ALTER TABLE thread_event_retention ADD COLUMN last_event_seq INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE server_bash_operations ADD COLUMN content TEXT;
      ALTER TABLE server_bash_operations ADD COLUMN status TEXT CHECK(status IN ('success', 'error'));
    `,
  },
  {
    version: 4,
    name: 'run_execution_generations',
    sql: `
      ALTER TABLE runs ADD COLUMN execution_generation INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE runs ADD COLUMN cancel_accepted_generation INTEGER;
    `,
  },
  {
    version: 5,
    name: 'device_log_recovery_metadata',
    sql: `
      ALTER TABLE device_tool_calls ADD COLUMN log_path TEXT;
      ALTER TABLE device_tool_calls ADD COLUMN log_expires_at TEXT;
    `,
  },
  {
    version: 6,
    name: 'device_log_sync_offset',
    sql: 'ALTER TABLE device_tool_calls ADD COLUMN log_synced_offset TEXT;',
  },
];

const runtimeDelegationMigrations: readonly Migration[] = [
  {
    version: 7,
    name: 'server_runtime_delegation_final',
    sql: `
      CREATE TABLE threads (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        thread_type TEXT NOT NULL CHECK(thread_type IN ('main', 'task')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX threads_owner_seq ON threads(owner_id, seq);
      CREATE UNIQUE INDEX threads_one_main_per_owner ON threads(owner_id) WHERE thread_type = 'main';
      CREATE TABLE thread_queues (
        thread_id TEXT PRIMARY KEY REFERENCES threads(thread_id) ON DELETE CASCADE,
        queue_version INTEGER NOT NULL DEFAULT 0,
        next_position INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE inputs (
        input_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        text TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('follow_up', 'steer')),
        status TEXT NOT NULL CHECK(status IN ('queued', 'consumed', 'cancelled')),
        position INTEGER NOT NULL CHECK(position > 0),
        version INTEGER NOT NULL CHECK(version > 0),
        consumed_run_id TEXT,
        source TEXT NOT NULL CHECK(source IN ('user', 'thread_call', 'thread_response', 'subagent_response')),
        interaction_id TEXT,
        source_thread_id TEXT,
        source_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(thread_id, position)
      );
      CREATE INDEX inputs_thread_status_position ON inputs(thread_id, status, position);
      CREATE UNIQUE INDEX inputs_interaction_source ON inputs(interaction_id, source) WHERE interaction_id IS NOT NULL;
      CREATE INDEX inputs_source ON inputs(source_thread_id, source_agent_id, interaction_id);
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'waiting', 'cancel_requested', 'completed', 'failed', 'cancelled', 'interrupted')),
        execution_mode TEXT NOT NULL CHECK(execution_mode IN ('foreground', 'background')),
        input_ids_json TEXT NOT NULL DEFAULT '[]',
        parent_run_id TEXT REFERENCES runs(run_id),
        error_code TEXT,
        error_message TEXT,
        error_retryable INTEGER CHECK(error_retryable IN (0, 1)),
        usage_input_tokens INTEGER NOT NULL DEFAULT 0,
        usage_output_tokens INTEGER NOT NULL DEFAULT 0,
        current_request_id TEXT,
        execution_generation INTEGER NOT NULL DEFAULT 1,
        cancel_accepted_generation INTEGER,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX runs_thread_created ON runs(thread_id, created_at, run_id);
      CREATE INDEX runs_thread_active ON runs(thread_id, status);
      CREATE TABLE client_actions (
        owner_id TEXT NOT NULL,
        client_action_id TEXT NOT NULL,
        method TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, client_action_id)
      );
      CREATE TABLE thread_events (
        event_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK(seq > 0),
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(thread_id, seq)
      );
      CREATE INDEX thread_events_thread_seq ON thread_events(thread_id, seq);
      CREATE TABLE thread_event_retention (
        thread_id TEXT PRIMARY KEY REFERENCES threads(thread_id) ON DELETE CASCADE,
        first_available_seq INTEGER NOT NULL DEFAULT 1,
        last_event_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE server_bash_operations (
        operation_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        tool_call_id TEXT NOT NULL,
        log_path TEXT,
        output_complete INTEGER NOT NULL CHECK(output_complete IN (0, 1)),
        end_offset TEXT NOT NULL,
        expires_at TEXT,
        content TEXT,
        status TEXT CHECK(status IN ('success', 'error')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, tool_call_id)
      );
      CREATE INDEX server_bash_operations_owner ON server_bash_operations(owner_id, created_at, operation_id);
      CREATE TABLE device_tool_calls (
        operation_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        tool_call_id TEXT NOT NULL,
        log_path TEXT,
        log_expires_at TEXT,
        log_synced_offset TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, tool_call_id)
      );
      CREATE INDEX device_tool_calls_owner ON device_tool_calls(owner_id, operation_id);
      CREATE TABLE device_tool_results (
        operation_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        tool_call_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('success', 'error')),
        created_at TEXT NOT NULL,
        UNIQUE(run_id, tool_call_id)
      );
      CREATE TABLE interactions (
        interaction_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('thread_call', 'subagent')),
        execution_mode TEXT NOT NULL CHECK(execution_mode IN ('foreground', 'background')),
        source_thread_id TEXT NOT NULL REFERENCES threads(thread_id),
        source_agent_id TEXT NOT NULL,
        source_run_id TEXT NOT NULL REFERENCES runs(run_id),
        source_tool_call_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        prompt TEXT NOT NULL,
        target_thread_id TEXT NOT NULL REFERENCES threads(thread_id),
        target_agent_id TEXT NOT NULL,
        reply_thread_id TEXT NOT NULL REFERENCES threads(thread_id),
        target_input_id TEXT REFERENCES inputs(input_id),
        accepted_run_id TEXT REFERENCES runs(run_id),
        consumed_run_id TEXT REFERENCES runs(run_id),
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'waiting', 'cancel_requested', 'completed', 'failed', 'cancelled', 'interrupted')),
        response_message_seq INTEGER REFERENCES context_messages(seq),
        error_code TEXT,
        error_message TEXT,
        error_retryable INTEGER CHECK(error_retryable IN (0, 1)),
        cancel_requested_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(source_thread_id, source_agent_id, source_tool_call_id),
        UNIQUE(target_input_id),
        CHECK(status <> 'completed' OR response_message_seq IS NOT NULL),
        CHECK(status NOT IN ('failed', 'cancelled', 'interrupted') OR response_message_seq IS NULL)
      );
      CREATE INDEX interactions_consumed_run ON interactions(consumed_run_id, interaction_id);
      CREATE INDEX interactions_target ON interactions(target_thread_id, status, interaction_id);
      CREATE INDEX interactions_reply ON interactions(reply_thread_id, status, interaction_id);
      CREATE TABLE interaction_deliveries (
        interaction_id TEXT PRIMARY KEY REFERENCES interactions(interaction_id),
        owner_id TEXT NOT NULL,
        reply_thread_id TEXT NOT NULL REFERENCES threads(thread_id),
        input_id TEXT REFERENCES inputs(input_id),
        run_id TEXT REFERENCES runs(run_id),
        status TEXT NOT NULL CHECK(status IN ('pending', 'queued', 'consumed', 'superseded')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        queued_at TEXT,
        consumed_at TEXT,
        UNIQUE(input_id),
        UNIQUE(run_id, interaction_id)
      );
      CREATE INDEX interaction_deliveries_reply ON interaction_deliveries(reply_thread_id, status, interaction_id);
    `,
  },
  {
    version: 8,
    name: 'server_runtime_current_view_final',
    sql: `
      ALTER TABLE runs ADD COLUMN rerun_from_message_seq INTEGER REFERENCES context_messages(seq);
      ALTER TABLE runs ADD COLUMN superseded_by_run_id TEXT REFERENCES runs(run_id);
      ALTER TABLE runs ADD COLUMN usage_reported INTEGER NOT NULL DEFAULT 0 CHECK(usage_reported IN (0, 1));
    `,
  },
];

const directoryEnvironmentMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'environment_directory_operations_initial',
    sql: `
      CREATE TABLE environment_operations (
        operation_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        env_id TEXT NOT NULL REFERENCES environments(env_id),
        device_id TEXT NOT NULL,
        device_binding_id TEXT NOT NULL REFERENCES environment_device_bindings(device_binding_id),
        target_instance_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action = 'directory_check'),
        path TEXT NOT NULL,
        load_workspace INTEGER NOT NULL CHECK (load_workspace IN (0, 1)),
        delivery_state TEXT NOT NULL CHECK (delivery_state IN ('intent', 'sent')),
        status INTEGER NOT NULL CHECK (status BETWEEN 1 AND 9),
        expires_at TEXT NOT NULL,
        accepted_at TEXT,
        sent_at TEXT,
        result_status INTEGER CHECK (result_status BETWEEN 5 AND 9),
        result_outcome_json TEXT,
        result_recorded_at TEXT,
        post_processed_at TEXT,
        result_acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX environment_operations_instance ON environment_operations(device_binding_id, target_instance_id, result_recorded_at);
      CREATE INDEX environment_operations_environment ON environment_operations(tenant_id, env_id, created_at, operation_id);
    `,
  },
];

function contextMigrations(version: number): readonly Migration[] {
  if (version <= 4) return contextEarlyMigrations;
  if (version <= 7) return contextDelegationMigrations;
  if (version >= 10) return contextRecapMigrations;
  return contextRecapMigrations.slice(0, version - 7).map((migration) => {
    if (migration.version !== 8) return migration;
    return {
      ...migration,
      sql: migration.sql.replace(
        'source_message_seqs TEXT NOT NULL,\n        content TEXT NOT NULL,',
        'source_message_seqs TEXT NOT NULL,\n        title TEXT NOT NULL,\n        content TEXT NOT NULL,',
      ),
    };
  });
}

function runtimeMigrations(version: number): readonly Migration[] {
  if (version <= 6) return runtimeEarlyMigrations;
  if (version <= 8) return runtimeDelegationMigrations;
  return sessionMigrations;
}

function environmentMigrations(version: number | 'directory1'): readonly Migration[] {
  if (version === 'directory1') return directoryEnvironmentMigrations;
  if (version >= 4) return environmentOperationMigrations;
  const remote = environmentOperationMigrations[0];
  if (!remote) throw new Error('Missing remote environment Operation DDL.');
  const historicalSql = remote.sql.replace(", 'read_image'", '');
  if (version === 3) return [{ ...remote, sql: historicalSql }];
  return [
    {
      ...remote,
      version,
      sql: historicalSql.replace(", 'directory_list'", ''),
    },
  ];
}

const periodicRecapGenerationOperationsSql = `
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
    status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'interrupted')),
    recap_id TEXT REFERENCES recaps(recap_id),
    usage_json TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(status <> 'completed' OR recap_id IS NOT NULL)
  );
  CREATE INDEX recap_generation_operations_owner_status
    ON recap_generation_operations(thread_id, agent_id, status, updated_at);
`;

function installInitialContextV1(database: DatabaseSync, namespaced: boolean): void {
  if (namespaced) {
    database.exec(`
      CREATE TABLE schema_migrations (
        namespace TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY(namespace, version)
      );
    `);
  } else {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
  }
  const initial = contextEarlyMigrations[0];
  if (!initial) throw new Error('Missing initial Context DDL.');
  database.exec(initial.sql);
  if (namespaced) {
    database
      .prepare(
        'INSERT INTO schema_migrations(namespace, version, name, applied_at) VALUES (?, ?, ?, ?)',
      )
      .run('context_recap', 1, initial.name, timestamp);
  } else {
    database
      .prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
      .run(1, initial.name, timestamp);
  }
}

function installPeriodicContextV8(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE schema_migrations (
      namespace TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY(namespace, version)
    );
  `);
  for (const migration of contextDelegationMigrations) {
    database.exec(migration.sql);
    if (migration.version === 7) {
      database
        .prepare(
          'INSERT INTO schema_migrations(namespace, version, name, applied_at) VALUES (?, ?, ?, ?)',
        )
        .run('context_recap', 7, migration.name, timestamp);
    }
  }
  database.exec(periodicRecapGenerationOperationsSql);
  database
    .prepare(
      'INSERT INTO schema_migrations(namespace, version, name, applied_at) VALUES (?, ?, ?, ?)',
    )
    .run('context_recap', 8, 'periodic_recap_generation_operations_final', timestamp);
}

interface LegacyVersions {
  context?: number | 'namespaced1' | 'periodic8';
  runtime?: number;
  devices?: number;
  deviceBash?: number;
  environment?: number | 'directory1';
}

function createLegacy(path: string, versions: LegacyVersions): DatabaseSync {
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  if (versions.context === 1) installInitialContextV1(database, false);
  else if (versions.context === 'namespaced1') installInitialContextV1(database, true);
  else if (versions.context === 'periodic8') installPeriodicContextV8(database);
  else if (versions.context)
    install(database, contextMigrations(versions.context), 'context_recap', versions.context);
  if (versions.runtime)
    install(database, runtimeMigrations(versions.runtime), 'server_runtime', versions.runtime);
  if (versions.devices) install(database, deviceMigrations, 'devices', versions.devices);
  if (versions.deviceBash)
    install(database, deviceBashMigrations, 'device_bash', versions.deviceBash);
  if (versions.environment) {
    install(
      database,
      environmentMigrations(versions.environment),
      'environment_operations',
      versions.environment === 'directory1' ? 1 : versions.environment,
    );
  }
  return database;
}

interface PublishedCase {
  label: string;
  namespace: string;
  current: boolean;
  versions: LegacyVersions;
}

const publishedCases: PublishedCase[] = [
  ...Array.from({ length: 25 }, (_, index) => index + 1).map((version) => ({
    label:
      version === 1 ? 'context_recap/1 initial metadata (8e4839a)' : `context_recap/${version}`,
    namespace: 'context_recap',
    current: version === 25,
    versions: { context: version },
  })),
  {
    label: 'context_recap/1 namespaced metadata (847998b)',
    namespace: 'context_recap',
    current: false,
    versions: { context: 'namespaced1' as const },
  },
  {
    label: 'context_recap/8 periodic interaction (ce75c51)',
    namespace: 'context_recap',
    current: false,
    versions: { context: 'periodic8' as const },
  },
  ...Array.from({ length: 16 }, (_, index) => index + 1).map((version) => ({
    label: `server_runtime/${version}`,
    namespace: 'server_runtime',
    current: version === 16,
    versions: { runtime: version, context: 25 },
  })),
  { label: 'devices/1', namespace: 'devices', current: true, versions: { devices: 1 } },
  ...[1, 2].map((version) => ({
    label: `device_bash/${version}`,
    namespace: 'device_bash',
    current: version === 2,
    versions: { deviceBash: version },
  })),
  {
    label: 'environment_operations/1 directory JSON (a7a8fab)',
    namespace: 'environment_operations',
    current: false,
    versions: { environment: 'directory1' as const },
  },
  ...[1, 2, 3, 4, 5, 6].map((version) => ({
    label: `environment_operations/${version} remote`,
    namespace: 'environment_operations',
    current: version === 6,
    versions: { environment: version },
  })),
];

describe('published SQLite schema upgrades', () => {
  it.each(publishedCases)(
    'upgrades $label without rewriting a current database twice',
    async (testCase) => {
      const dataDirectory = directory();
      const databasePath = join(dataDirectory, 'kairos.sqlite');
      createLegacy(databasePath, testCase.versions).close();
      const backupDirectory = join(dataDirectory, 'backups');

      const first = await upgradeDatabaseFile({ dataDirectory, backupDirectory });
      expect(first.status).toBe(testCase.current ? 'current' : 'migrated');
      if (testCase.current) {
        expect(existsSync(backupDirectory)).toBe(false);
      } else {
        expect(first.backupPath && statSync(first.backupPath).mode & 0o777).toBe(0o600);
        expect(readdirSync(backupDirectory)).toHaveLength(1);
      }
      const checked = checkDatabaseFile(databasePath);
      expect(checked.status).toBe('current');
      expect(
        checked.namespaces.find((namespace) => namespace.namespace === testCase.namespace)
          ?.currentVersion,
      ).toBe(
        checked.namespaces.find((namespace) => namespace.namespace === testCase.namespace)
          ?.requiredVersion,
      );

      const hash = fileHash(databasePath);
      const second = await upgradeDatabaseFile({ dataDirectory, backupDirectory });
      expect(second.status).toBe('current');
      expect(fileHash(databasePath)).toBe(hash);
      expect(existsSync(backupDirectory) ? readdirSync(backupDirectory).length : 0).toBe(
        testCase.current ? 0 : 1,
      );
      const reopened = openDatabase(databasePath);
      expect(reopened.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      reopened.close();
    },
  );
});

type SqlValue = string | number | bigint | Uint8Array | null;

function insert(database: DatabaseSync, table: string, values: Record<string, SqlValue>): void {
  const columns = Object.keys(values);
  database
    .prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...Object.values(values));
}

function offset(value: bigint): string {
  return value.toString().padStart(20, '0');
}

describe('SQLite business data preservation', () => {
  it('preserves attachments, identities, Threads, Runs, devices, Operations and output', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'kairos.sqlite');
    const database = createLegacy(databasePath, {
      context: 13,
      runtime: 11,
      devices: 1,
      deviceBash: 1,
      environment: 2,
    });
    insert(database, 'users', {
      user_id: 'user-1',
      email: 'legacy@example.test',
      email_verified_at: timestamp,
      username: 'Legacy',
      tenant_id: null,
      status: 'active',
      created_at: timestamp,
      updated_at: timestamp,
    });
    insert(database, 'tenants', {
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      default_env_id: 'env-1',
      default_env_explicit: 1,
      created_at: timestamp,
      updated_at: timestamp,
    });
    database.prepare('UPDATE users SET tenant_id = ? WHERE user_id = ?').run('tenant-1', 'user-1');
    insert(database, 'threads', {
      seq: 1,
      thread_id: 'main-1',
      owner_id: 'user-1',
      title: '保留对话',
      thread_type: 'main',
      created_at: timestamp,
      updated_at: timestamp,
    });
    insert(database, 'runs', {
      run_id: 'run-1',
      thread_id: 'main-1',
      owner_id: 'user-1',
      agent_id: 'thread',
      status: 'completed',
      execution_mode: 'foreground',
      input_ids_json: '["input-1"]',
      usage_input_tokens: 10,
      usage_output_tokens: 5,
      usage_reported: 1,
      execution_generation: 1,
      created_at: timestamp,
      started_at: timestamp,
      finished_at: timestamp,
    });
    insert(database, 'inputs', {
      input_id: 'input-1',
      thread_id: 'main-1',
      owner_id: 'user-1',
      text: '带附件的消息',
      mode: 'follow_up',
      status: 'consumed',
      position: 1,
      version: 1,
      consumed_run_id: 'run-1',
      source: 'user',
      created_at: timestamp,
      updated_at: timestamp,
    });
    insert(database, 'context_messages', {
      seq: 1,
      message_id: 'message-1',
      thread_id: 'main-1',
      agent_id: 'thread',
      role: 'user',
      content: '带附件的消息',
      created_at: timestamp,
      run_id: 'run-1',
      source: 'user',
      source_input_id: 'input-1',
    });
    insert(database, 'attachments', {
      attachment_id: 'attachment-1',
      owner_id: 'user-1',
      file_name: 'note.txt',
      media_type: 'text/plain',
      byte_size: 5,
      sha256: createHash('sha256').update('hello').digest('hex'),
      content: Buffer.from('hello'),
      created_at: timestamp,
    });
    insert(database, 'input_attachments', {
      input_id: 'input-1',
      position: 1,
      attachment_id: 'attachment-1',
    });
    insert(database, 'context_message_attachments', {
      message_seq: 1,
      position: 1,
      attachment_id: 'attachment-1',
    });
    insert(database, 'devices', {
      device_id: 'device-1',
      owner_id: 'user-1',
      device_name: 'Legacy device',
      account_description: 'legacy account',
      bash_enabled: 1,
      credential_hash: null,
      status: 'active',
      created_at: timestamp,
      updated_at: timestamp,
      paired_at: timestamp,
      last_seen_at: timestamp,
    });
    insert(database, 'device_bash_operations', {
      operation_id: 'device-operation-1',
      owner_id: 'user-1',
      device_id: 'device-1',
      run_id: 'run-1',
      command: 'printf hello',
      cwd: '/tmp',
      expires_at: '2026-11-02T00:00:00.000Z',
      timeout_seconds: 120,
      target_instance_id: 'device-instance-1',
      delivery_state: 'sent',
      status: BashStatus.COMPLETED,
      cancel_requested: 0,
      next_offset: offset(5n),
      result_status: BashStatus.COMPLETED,
      exit_code: 0,
      device_output_complete: 1,
      result_end_offset: offset(5n),
      output_complete: 1,
      output_gap: 0,
      result_source: 'device',
      result_recorded_at: timestamp,
      result_acknowledged_at: timestamp,
      accepted_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    });
    insert(database, 'device_bash_output_chunks', {
      operation_id: 'device-operation-1',
      offset: zeroOffset,
      end_offset: offset(5n),
      stream: OutputStream.STDOUT,
      data: Buffer.from('hello'),
    });
    insert(database, 'environments', {
      env_id: 'env-1',
      tenant_id: 'tenant-1',
      name: 'Legacy environment',
      kind: 'self_hosted_linux',
      recommended_pwd: '/workspace',
      binding_status: 'active',
      connection_status: 'online',
      capability_status: 'ready',
      directory_status: 'ready',
      authorized_capabilities_json: '[]',
      granted_capabilities_json: '[]',
      device_id: 'device-1',
      device_binding_id: 'binding-1',
      instance_id: 'environment-instance-1',
      created_at: timestamp,
      updated_at: timestamp,
      paired_at: timestamp,
    });
    insert(database, 'environment_device_bindings', {
      device_binding_id: 'binding-1',
      tenant_id: 'tenant-1',
      env_id: 'env-1',
      device_id: 'device-1',
      credential_hash: null,
      status: 'active',
      granted_capabilities_json: '[]',
      created_at: timestamp,
      updated_at: timestamp,
      paired_at: timestamp,
    });
    insert(database, 'environment_operations', {
      operation_id: 'environment-operation-1',
      tenant_id: 'tenant-1',
      env_id: 'env-1',
      device_id: 'device-1',
      device_binding_id: 'binding-1',
      target_instance_id: 'environment-instance-1',
      binding_version: '7',
      action: 'bash',
      fingerprint: 'legacy-fingerprint',
      cwd: '/workspace',
      command: 'printf hello',
      timeout_seconds: 120,
      delivery_state: 'sent',
      status: OperationStatus.RUNNING,
      cancel_requested: 0,
      next_offset: offset(5n),
      expires_at: '2026-11-02T00:00:00.000Z',
      created_at: timestamp,
      updated_at: timestamp,
    });
    insert(database, 'environment_operation_output_chunks', {
      operation_id: 'environment-operation-1',
      offset: zeroOffset,
      end_offset: offset(5n),
      stream: OutputStream.STDOUT,
      data: Buffer.from('hello'),
    });
    database.close();

    const backupDirectory = join(dataDirectory, 'backups');
    const result = await upgradeDatabaseFile({ dataDirectory, backupDirectory });
    expect(result.status).toBe('migrated');
    if (!result.backupPath) throw new Error('Migration did not return a backup path.');
    const backup = new DatabaseSync(result.backupPath, { readOnly: true });
    expect(
      backup
        .prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE namespace = ?')
        .get('context_recap'),
    ).toEqual({ version: 13 });
    expect(
      backup.prepare('SELECT content FROM attachments WHERE attachment_id = ?').get('attachment-1'),
    ).toEqual({ content: new Uint8Array([104, 101, 108, 108, 111]) });
    expect(backup.prepare('PRAGMA table_info(device_bash_operations)').all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'post_processed_at' })]),
    );
    backup.close();

    const reopened = openDatabase(databasePath);
    expect(reopened.prepare('SELECT email FROM users WHERE user_id = ?').get('user-1')).toEqual({
      email: 'legacy@example.test',
    });
    expect(reopened.prepare('SELECT title FROM threads WHERE thread_id = ?').get('main-1')).toEqual(
      { title: '保留对话' },
    );
    expect(reopened.prepare('SELECT status FROM runs WHERE run_id = ?').get('run-1')).toEqual({
      status: 'completed',
    });
    expect(
      reopened
        .prepare('SELECT content FROM context_messages WHERE message_id = ?')
        .get('message-1'),
    ).toEqual({ content: '带附件的消息' });
    expect(
      reopened
        .prepare(
          'SELECT COUNT(*) AS count FROM input_attachments JOIN context_message_attachments ON input_attachments.attachment_id = context_message_attachments.attachment_id',
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      reopened
        .prepare(
          `SELECT source, workspace_required, workspace_status, env_id, path, operation_id
           FROM context_message_attachments WHERE attachment_id = 'attachment-1'`,
        )
        .get(),
    ).toEqual({
      source: 'file',
      workspace_required: 0,
      workspace_status: null,
      env_id: null,
      path: null,
      operation_id: null,
    });
    expect(
      reopened.prepare('SELECT binary_content, create_parents FROM environment_operations').get(),
    ).toEqual({ binary_content: null, create_parents: null });
    const deviceOperations = new DeviceBashStore(reopened);
    expect(deviceOperations.find('device-operation-1')).toMatchObject({
      postProcessedAt: timestamp,
      resultAcknowledgedAt: timestamp,
      outputComplete: true,
    });
    expect(
      Array.from(deviceOperations.readOutputForOwner('user-1', 'device-operation-1', 0n))
        .map((chunk) => Buffer.from(chunk.data).toString())
        .join(''),
    ).toBe('hello');
    const environmentOperations = new EnvironmentOperationStore(reopened);
    expect(environmentOperations.find('environment-operation-1')).toMatchObject({
      tenantId: 'tenant-1',
      bindingVersion: 7n,
      nextOffset: 5n,
    });
    expect(
      environmentOperations
        .readOutputForTenant('tenant-1', 'environment-operation-1', 0n)
        .map((chunk) => Buffer.from(chunk.data).toString())
        .join(''),
    ).toBe('hello');
    reopened.close();

    const hash = fileHash(databasePath);
    expect((await upgradeDatabaseFile({ dataDirectory, backupDirectory })).status).toBe('current');
    expect(fileHash(databasePath)).toBe(hash);
    expect(readdirSync(backupDirectory)).toHaveLength(1);
  });
});

function seedDelegation(database: DatabaseSync, includeConsumedMessage: boolean): void {
  for (const thread of [
    { thread_id: 'main-1', title: 'Main', thread_type: 'main' },
    { thread_id: 'task-1', title: 'Task', thread_type: 'task' },
  ]) {
    insert(database, 'threads', {
      ...thread,
      owner_id: 'user-1',
      created_at: timestamp,
      updated_at: timestamp,
    });
    insert(database, 'thread_queues', { thread_id: thread.thread_id, next_position: 2 });
    insert(database, 'thread_event_retention', { thread_id: thread.thread_id });
  }
  for (const run of [
    { run_id: 'source-run', thread_id: 'main-1', agent_id: 'main', execution_mode: 'foreground' },
    {
      run_id: 'target-run',
      thread_id: 'task-1',
      agent_id: 'main',
      execution_mode: 'background',
    },
    { run_id: 'reply-run', thread_id: 'main-1', agent_id: 'main', execution_mode: 'foreground' },
  ]) {
    insert(database, 'runs', {
      ...run,
      owner_id: 'user-1',
      status: 'completed',
      input_ids_json: '[]',
      usage_input_tokens: 0,
      usage_output_tokens: 0,
      execution_generation: 1,
      created_at: timestamp,
      started_at: timestamp,
      finished_at: timestamp,
    });
  }
  insert(database, 'inputs', {
    input_id: 'target-input',
    thread_id: 'task-1',
    owner_id: 'user-1',
    text: ' delegated prompt ',
    mode: 'follow_up',
    status: 'consumed',
    position: 1,
    version: 1,
    consumed_run_id: 'target-run',
    source: 'thread_call',
    interaction_id: 'legacy-interaction',
    source_thread_id: 'main-1',
    source_agent_id: 'main',
    created_at: timestamp,
    updated_at: timestamp,
  });
  insert(database, 'inputs', {
    input_id: 'delivery-input',
    thread_id: 'main-1',
    owner_id: 'user-1',
    text: 'delegated result',
    mode: 'follow_up',
    status: 'consumed',
    position: 1,
    version: 1,
    consumed_run_id: 'reply-run',
    source: 'thread_response',
    interaction_id: 'legacy-interaction',
    source_thread_id: 'task-1',
    source_agent_id: 'main',
    created_at: timestamp,
    updated_at: timestamp,
  });
  insert(database, 'context_messages', {
    seq: 1,
    message_id: 'target-response',
    thread_id: 'task-1',
    agent_id: 'main',
    role: 'assistant',
    content: 'delegated result',
    created_at: timestamp,
    run_id: 'target-run',
  });
  if (includeConsumedMessage) insertConsumedMessage(database);
  insert(database, 'interactions', {
    interaction_id: 'legacy-interaction',
    owner_id: 'user-1',
    kind: 'thread_call',
    execution_mode: 'background',
    source_thread_id: 'main-1',
    source_agent_id: 'main',
    source_run_id: 'source-run',
    source_tool_call_id: 'call-1',
    request_fingerprint: 'fingerprint',
    prompt: 'delegated prompt',
    target_thread_id: 'task-1',
    target_agent_id: 'main',
    reply_thread_id: 'main-1',
    target_input_id: 'target-input',
    accepted_run_id: 'target-run',
    consumed_run_id: 'target-run',
    status: 'completed',
    response_message_seq: 1,
    created_at: timestamp,
    updated_at: timestamp,
    finished_at: timestamp,
  });
  insert(database, 'interaction_deliveries', {
    interaction_id: 'legacy-interaction',
    owner_id: 'user-1',
    reply_thread_id: 'main-1',
    input_id: 'delivery-input',
    run_id: 'reply-run',
    status: 'consumed',
    created_at: timestamp,
    updated_at: timestamp,
    queued_at: timestamp,
    consumed_at: timestamp,
  });
  insert(database, 'context_messages', {
    seq: 3,
    message_id: 'source-assistant',
    thread_id: 'main-1',
    agent_id: 'main',
    role: 'assistant',
    content: '',
    tool_calls_json: '[{"id":"call-1","name":"thread_call","arguments":{}}]',
    created_at: timestamp,
    run_id: 'source-run',
  });
  insert(database, 'context_tool_calls', {
    thread_id: 'main-1',
    agent_id: 'main',
    call_id: 'call-1',
    assistant_seq: 3,
    tool_name: 'thread_call',
    arguments_json: '{}',
    call_type: 'complete',
  });
  insert(database, 'recaps', {
    recap_id: 'recap-1',
    thread_id: 'main-1',
    agent_id: 'main',
    source_seq_start: 3,
    source_seq_end: 3,
    source_message_seqs: '[3]',
    title: 'legacy recap',
    content: 'legacy recap',
    created_at: timestamp,
    validity: 'valid',
  });
  insert(database, 'recap_sources', { recap_id: 'recap-1', position: 1, message_seq: 3 });
  insert(database, 'model_input_states', {
    thread_id: 'main-1',
    agent_id: 'main',
    read_through_seq: 3,
    view_version: 0,
    updated_at: timestamp,
  });
  insert(database, 'model_input_recaps', {
    thread_id: 'main-1',
    agent_id: 'main',
    merge_position: 1,
    recap_id: 'recap-1',
  });
  insert(database, 'model_request_records', {
    request_id: 'request-1',
    thread_id: 'main-1',
    agent_id: 'main',
    status: 'completed',
    context_window_tokens: 1000,
    output_reserve_tokens: 100,
    read_through_seq: 3,
    view_version: 0,
    selected_recap_ids_json: '["recap-1"]',
    context_message_seqs_json: '[3]',
    created_at: timestamp,
    updated_at: timestamp,
  });
  insert(database, 'context_events', {
    event_id: 'context-event-1',
    thread_id: 'main-1',
    agent_id: 'main',
    event_type: 'messageCommitted',
    payload_json: '{}',
    created_at: timestamp,
  });
}

function insertConsumedMessage(database: DatabaseSync): void {
  insert(database, 'context_messages', {
    seq: 2,
    message_id: 'reply-message',
    thread_id: 'main-1',
    agent_id: 'main',
    role: 'user',
    content: 'delegated result',
    created_at: timestamp,
    run_id: 'reply-run',
    source: 'thread_response',
    interaction_id: 'legacy-interaction',
    source_input_id: 'delivery-input',
    source_thread_id: 'task-1',
    source_agent_id: 'main',
  });
}

describe('legacy delegation and recovery upgrades', () => {
  it('maps interaction IDs to delegation triples and exact consumed Context messages', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'kairos.sqlite');
    const database = createLegacy(databasePath, { context: 7, runtime: 8 });
    seedDelegation(database, true);
    database.close();

    expect(
      (
        await upgradeDatabaseFile({
          dataDirectory,
          backupDirectory: join(dataDirectory, 'backups'),
        })
      ).status,
    ).toBe('migrated');
    const reopened = openDatabase(databasePath);
    expect(
      reopened
        .prepare(
          'SELECT delegation_source_thread_id AS sourceThread, delegation_source_agent_id AS sourceAgent, source_tool_call_id AS callId FROM inputs WHERE input_id = ?',
        )
        .get('delivery-input'),
    ).toEqual({ sourceThread: 'main-1', sourceAgent: 'thread', callId: 'call-1' });
    expect(
      reopened
        .prepare(
          'SELECT delegation_source_thread_id AS sourceThread, delegation_source_agent_id AS sourceAgent, source_tool_call_id AS callId FROM context_messages WHERE message_id = ?',
        )
        .get('reply-message'),
    ).toEqual({ sourceThread: 'main-1', sourceAgent: 'thread', callId: 'call-1' });
    for (const table of [
      'context_messages',
      'context_tool_calls',
      'recaps',
      'model_input_states',
      'model_input_recaps',
      'model_request_records',
      'context_events',
      'runs',
    ]) {
      expect(
        reopened.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE agent_id = 'main'`).get(),
      ).toEqual({ count: 0 });
      expect(
        Number(
          reopened.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE agent_id = 'thread'`).get()
            ?.count,
        ),
      ).toBeGreaterThan(0);
    }
    expect(
      reopened
        .prepare(
          "SELECT COUNT(*) AS count FROM interactions WHERE source_agent_id = 'main' OR target_agent_id = 'main'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      reopened
        .prepare(
          "SELECT COUNT(*) AS count FROM interaction_deliveries WHERE source_agent_id = 'main'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      reopened
        .prepare(
          "SELECT COUNT(*) AS count FROM inputs WHERE source_agent_id = 'main' OR delegation_source_agent_id = 'main'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      reopened
        .prepare(
          "SELECT COUNT(*) AS count FROM context_messages WHERE source_agent_id = 'main' OR delegation_source_agent_id = 'main'",
        )
        .get(),
    ).toEqual({ count: 0 });
    const store = new SessionStore(reopened);
    expect(
      store.getInteractionDelivery('user-1', {
        sourceThreadId: 'main-1',
        sourceAgentId: 'thread',
        sourceToolCallId: 'call-1',
      }),
    ).toMatchObject({
      content: 'delegated result',
      contextMessageSeq: 2,
      runId: 'reply-run',
      status: 'consumed',
    });
    seedTestSession(reopened, 'user-1', 'migration-session');
    store.getOrCreateMainThread('user-1');
    const accepted = store.sendMessage({
      ownerId: 'user-1',
      clientActionId: 'post-upgrade-message',
      method: 'SendMessage',
      parameters: { threadId: 'main-1', text: 'after upgrade', mode: 'follow_up' },
      threadId: 'main-1',
      text: 'after upgrade',
      mode: 'follow_up',
    });
    const newRun = store.getRunById(accepted.runId);
    expect(newRun.agentId).toBe('thread');
    expect(
      store.context
        .query({ threadId: newRun.threadId, agentId: newRun.agentId, currentOnly: true })
        .map((message) => message.messageId),
    ).toContain('reply-message');
    expect(store.listRuns('user-1', 'main-1').every((run) => run.agentId === 'thread')).toBe(true);
    expect(store.listRuns('user-1', 'task-1').every((run) => run.agentId === 'thread')).toBe(true);
    reopened.close();
  });

  it('rolls back a failed copy, preserves the original and backup, then retries after repair', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'kairos.sqlite');
    const backupDirectory = join(dataDirectory, 'backups');
    const database = createLegacy(databasePath, { context: 7, runtime: 8 });
    seedDelegation(database, false);
    database.close();
    const originalHash = fileHash(databasePath);

    await expect(upgradeDatabaseFile({ dataDirectory, backupDirectory })).rejects.toThrow();
    expect(fileHash(databasePath)).toBe(originalHash);
    expect(readdirSync(backupDirectory)).toHaveLength(1);
    expect(
      readdirSync(dataDirectory).filter((name) => name.startsWith('.kairos-migration-')),
    ).toEqual([]);
    const original = new DatabaseSync(databasePath, { readOnly: true });
    expect(original.prepare('SELECT COUNT(*) AS count FROM interaction_deliveries').get()).toEqual({
      count: 1,
    });
    expect(
      original
        .prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE namespace = ?')
        .get('server_runtime'),
    ).toEqual({ version: 8 });
    original.close();

    const repair = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    insertConsumedMessage(repair);
    repair.close();
    expect((await upgradeDatabaseFile({ dataDirectory, backupDirectory })).status).toBe('migrated');
    expect(readdirSync(backupDirectory)).toHaveLength(2);
    const upgraded = openDatabase(databasePath);
    expect(
      upgraded.prepare('SELECT content, context_message_seq FROM interaction_deliveries').get(),
    ).toEqual({ content: 'delegated result', context_message_seq: 2 });
    upgraded.close();
  });
});

describe('legacy defaults and directory Operations', () => {
  it('backfills event high water, legacy Run fields and Recap sources', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'kairos.sqlite');
    const database = createLegacy(databasePath, { context: 2, runtime: 2 });
    insert(database, 'threads', {
      seq: 1,
      thread_id: 'main-1',
      owner_id: 'user-1',
      title: 'Legacy',
      created_at: timestamp,
      updated_at: timestamp,
    });
    insert(database, 'inputs', {
      input_id: 'input-1',
      thread_id: 'main-1',
      owner_id: 'user-1',
      text: 'legacy input',
      mode: 'follow_up',
      status: 'consumed',
      position: 1,
      version: 1,
      consumed_run_id: 'run-1',
      created_at: timestamp,
      updated_at: timestamp,
    });
    insert(database, 'runs', {
      run_id: 'run-1',
      thread_id: 'main-1',
      owner_id: 'user-1',
      agent_id: 'thread',
      status: 'completed',
      input_ids_json: '["input-1"]',
      usage_input_tokens: 12,
      usage_output_tokens: 0,
      created_at: timestamp,
      started_at: timestamp,
      finished_at: timestamp,
    });
    insert(database, 'thread_event_retention', {
      thread_id: 'main-1',
      first_available_seq: 3,
    });
    for (const seq of [4, 7]) {
      insert(database, 'thread_events', {
        event_id: `event-${seq}`,
        thread_id: 'main-1',
        seq,
        occurred_at: timestamp,
        payload_json: '{}',
      });
    }
    insert(database, 'context_messages', {
      seq: 1,
      message_id: 'message-1',
      thread_id: 'main-1',
      agent_id: 'thread',
      role: 'user',
      content: 'legacy input',
      created_at: timestamp,
      run_id: 'run-1',
    });
    insert(database, 'recaps', {
      recap_id: 'recap-1',
      thread_id: 'main-1',
      agent_id: 'thread',
      source_seq_start: 1,
      source_seq_end: 1,
      source_message_seqs: '[1]',
      title: 'legacy title',
      content: 'legacy recap',
      created_at: timestamp,
      validity: 'valid',
    });
    insert(database, 'recap_sources', { recap_id: 'recap-1', position: 1, message_seq: 1 });
    insert(database, 'model_request_records', {
      request_id: 'request-1',
      thread_id: 'main-1',
      agent_id: 'thread',
      status: 'completed',
      context_window_tokens: 1000,
      output_reserve_tokens: 100,
      read_through_seq: 1,
      selected_recap_ids_json: '[]',
      context_message_seqs_json: '[1]',
      created_at: timestamp,
      updated_at: timestamp,
    });
    database.close();

    expect(
      (
        await upgradeDatabaseFile({
          dataDirectory,
          backupDirectory: join(dataDirectory, 'backups'),
        })
      ).status,
    ).toBe('migrated');
    const upgraded = openDatabase(databasePath);
    expect(upgraded.prepare('SELECT thread_type FROM threads').get()).toEqual({
      thread_type: 'main',
    });
    expect(upgraded.prepare('SELECT execution_mode, usage_reported FROM runs').get()).toEqual({
      execution_mode: 'foreground',
      usage_reported: 1,
    });
    expect(upgraded.prepare('SELECT source FROM inputs').get()).toEqual({ source: 'user' });
    expect(upgraded.prepare('SELECT last_event_seq FROM thread_event_retention').get()).toEqual({
      last_event_seq: 7,
    });
    expect(upgraded.prepare('SELECT view_version FROM model_request_records').get()).toEqual({
      view_version: 0,
    });
    expect(upgraded.prepare('SELECT content FROM recaps').get()).toEqual({
      content: 'legacy recap',
    });
    expect(upgraded.prepare('SELECT recap_id, message_seq FROM recap_sources').get()).toEqual({
      recap_id: 'recap-1',
      message_seq: 1,
    });
    upgraded.close();
  });

  it('converts directory-only JSON results and fingerprints for the current Operation Store', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'kairos.sqlite');
    const database = createLegacy(databasePath, { context: 13, environment: 'directory1' });
    insert(database, 'tenants', {
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      default_env_id: 'env-1',
      default_env_explicit: 0,
      created_at: timestamp,
      updated_at: timestamp,
    });
    insert(database, 'environments', {
      env_id: 'env-1',
      tenant_id: 'tenant-1',
      name: 'Legacy environment',
      kind: 'self_hosted_linux',
      recommended_pwd: '/workspace',
      binding_status: 'active',
      connection_status: 'online',
      capability_status: 'ready',
      directory_status: 'ready',
      authorized_capabilities_json: '[]',
      granted_capabilities_json: '[]',
      device_id: 'device-1',
      device_binding_id: 'binding-1',
      instance_id: 'instance-1',
      created_at: timestamp,
      updated_at: timestamp,
      paired_at: timestamp,
    });
    insert(database, 'environment_device_bindings', {
      device_binding_id: 'binding-1',
      tenant_id: 'tenant-1',
      env_id: 'env-1',
      device_id: 'device-1',
      credential_hash: null,
      status: 'active',
      granted_capabilities_json: '[]',
      created_at: timestamp,
      updated_at: timestamp,
      paired_at: timestamp,
    });
    insert(database, 'environment_operations', {
      operation_id: 'directory-operation-1',
      tenant_id: 'tenant-1',
      env_id: 'env-1',
      device_id: 'device-1',
      device_binding_id: 'binding-1',
      target_instance_id: 'instance-1',
      action: 'directory_check',
      path: '/workspace',
      load_workspace: 1,
      delivery_state: 'sent',
      status: OperationStatus.COMPLETED,
      expires_at: '2026-11-02T00:00:00.000Z',
      result_status: OperationStatus.COMPLETED,
      result_outcome_json: JSON.stringify({
        normalizedPath: '/workspace',
        exists: true,
        directory: true,
        readable: true,
        writable: true,
        executable: true,
        os: 'linux',
        architecture: 'x86_64',
        capabilities: [],
        resources: [],
      }),
      result_recorded_at: timestamp,
      post_processed_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    });
    database.close();

    expect(
      (
        await upgradeDatabaseFile({
          dataDirectory,
          backupDirectory: join(dataDirectory, 'backups'),
        })
      ).status,
    ).toBe('migrated');
    const upgraded = openDatabase(databasePath);
    const store = new EnvironmentOperationStore(upgraded);
    expect(store.find('directory-operation-1')).toMatchObject({
      action: { case: 'directoryCheck', value: { path: '/workspace', loadWorkspace: true } },
      resultStatus: OperationStatus.COMPLETED,
      outcome: { case: 'directoryCheck', value: { normalizedPath: '/workspace' } },
      outputComplete: true,
      endOffset: 0n,
    });
    expect(
      store.createIntent({
        operationId: 'directory-operation-1',
        tenantId: 'tenant-1',
        envId: 'env-1',
        deviceId: 'device-1',
        deviceBindingId: 'binding-1',
        targetInstanceId: 'instance-1',
        action: { case: 'directoryCheck', value: { path: '/workspace', loadWorkspace: true } },
        expiresAt: new Date('2026-11-02T00:00:00.000Z'),
      }).created,
    ).toBe(false);
    upgraded.close();
  });
});

const migrateEntry = fileURLToPath(new URL('../migrate.ts', import.meta.url));

function runMigrateCli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', migrateEntry, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('SQLite migration command', () => {
  it('reports missing, required and current states with stable exit codes', async () => {
    const dataDirectory = directory();
    const backupDirectory = join(dataDirectory, 'backups');
    const databasePath = join(dataDirectory, 'kairos.sqlite');
    const baseArgs = ['--data-dir', dataDirectory, '--backup-dir', backupDirectory];

    const missing = runMigrateCli([...baseArgs, '--check']);
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({ status: 'missing' });
    expect(existsSync(databasePath)).toBe(false);

    createLegacy(databasePath, { environment: 2 }).close();
    const legacyHash = fileHash(databasePath);
    const required = runMigrateCli([...baseArgs, '--check']);
    expect(required.status).toBe(0);
    expect(JSON.parse(required.stdout)).toMatchObject({ status: 'migration_required' });
    expect(fileHash(databasePath)).toBe(legacyHash);
    expect(existsSync(backupDirectory)).toBe(false);
    expect(() => openDatabase(databasePath)).toThrow(/dist\/migrate\.js.*--data-dir/);
    expect(fileHash(databasePath)).toBe(legacyHash);

    const migrated = runMigrateCli(baseArgs);
    expect(migrated.status).toBe(0);
    expect(JSON.parse(migrated.stdout)).toMatchObject({ status: 'migrated' });
    expect(readdirSync(backupDirectory)).toHaveLength(1);
    const current = runMigrateCli([...baseArgs, '--check']);
    expect(current.status).toBe(0);
    expect(JSON.parse(current.stdout)).toMatchObject({ status: 'current' });
    const noop = runMigrateCli(baseArgs);
    expect(noop.status).toBe(0);
    expect(JSON.parse(noop.stdout)).toMatchObject({ status: 'current' });
    expect(readdirSync(backupDirectory)).toHaveLength(1);

    const newer = new DatabaseSync(databasePath);
    newer
      .prepare(
        `UPDATE schema_migrations SET version = 99
         WHERE namespace = ? AND version = (
           SELECT MAX(version) FROM schema_migrations WHERE namespace = ?
         )`,
      )
      .run('environment_operations', 'environment_operations');
    newer.close();
    const rejected = runMigrateCli([...baseArgs, '--check']);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('newer than this Server');
    expect(readdirSync(backupDirectory)).toHaveLength(1);
  });

  it('does not change the source when the backup destination cannot be created', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'kairos.sqlite');
    createLegacy(databasePath, { environment: 2 }).close();
    const originalHash = fileHash(databasePath);
    const backupDirectory = join(dataDirectory, 'backup-file');
    writeFileSync(backupDirectory, 'not a directory');

    await expect(upgradeDatabaseFile({ dataDirectory, backupDirectory })).rejects.toThrow();
    expect(fileHash(databasePath)).toBe(originalHash);
    expect(checkDatabaseFile(databasePath).status).toBe('migration_required');
    expect(
      readdirSync(dataDirectory).filter((name) => name.startsWith('.kairos-migration-')),
    ).toEqual([]);
  });
});

describe('WAL database backups', () => {
  it('creates one self-contained DELETE-journal backup file', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'kairos.sqlite');
    const database = openDatabase(databasePath);
    new EnvironmentOperationStore(database);
    database.exec(`
      ALTER TABLE environment_operations DROP COLUMN binary_content;
      ALTER TABLE environment_operations DROP COLUMN create_parents;
      ALTER TABLE environment_operations DROP COLUMN sync_action;
      ALTER TABLE environment_operations DROP COLUMN sync_offset;
      ALTER TABLE environment_operations DROP COLUMN transfer_id;
      ALTER TABLE environment_operations DROP COLUMN total_size;
      ALTER TABLE environment_operations DROP COLUMN executable;
      ALTER TABLE environment_operations DROP COLUMN create_directory;
      ALTER TABLE environment_operations DROP COLUMN conflict_scan;
      ALTER TABLE environment_operations DROP COLUMN relative_paths_json;
      DROP TABLE environment_sync_files;
      DROP TABLE environment_syncs;
    `);
    database
      .prepare('DELETE FROM schema_migrations WHERE namespace = ?')
      .run('environment_operations');
    database
      .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)')
      .run(
        'environment_operations',
        2,
        'environment_operations_remote_files_and_bash_final',
        timestamp,
      );
    database.close();

    const backupDirectory = join(dataDirectory, 'backups');
    const result = await upgradeDatabaseFile({ dataDirectory, backupDirectory });
    expect(result.status).toBe('migrated');
    if (!result.backupPath) throw new Error('Migration did not return a backup path.');
    expect(readdirSync(backupDirectory)).toHaveLength(1);
    const backup = new DatabaseSync(result.backupPath, { readOnly: true });
    expect(backup.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(backup.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(
      backup
        .prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE namespace = ?')
        .get('environment_operations'),
    ).toEqual({ version: 2 });
    backup.close();
    expect(readdirSync(backupDirectory)).toHaveLength(1);
  });
});

describe('additional historical schema semantics', () => {
  it('preserves multiple early Threads and maps only the oldest to main', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'kairos.sqlite');
    const database = createLegacy(databasePath, { context: 4, runtime: 1 });
    for (const index of [1, 2]) {
      const threadId = `thread-${index}`;
      insert(database, 'threads', {
        seq: index,
        thread_id: threadId,
        owner_id: 'user-1',
        title: `Legacy ${index}`,
        created_at: timestamp,
        updated_at: timestamp,
      });
      insert(database, 'thread_queues', { thread_id: threadId, next_position: 2 });
      insert(database, 'thread_event_retention', { thread_id: threadId });
      insert(database, 'inputs', {
        input_id: `input-${index}`,
        thread_id: threadId,
        owner_id: 'user-1',
        text: `message ${index}`,
        mode: 'follow_up',
        status: 'consumed',
        position: 1,
        version: 1,
        consumed_run_id: `run-${index}`,
        created_at: timestamp,
        updated_at: timestamp,
      });
      insert(database, 'runs', {
        run_id: `run-${index}`,
        thread_id: threadId,
        owner_id: 'user-1',
        agent_id: 'main',
        status: 'completed',
        input_ids_json: `["input-${index}"]`,
        usage_input_tokens: 0,
        usage_output_tokens: 0,
        created_at: timestamp,
        started_at: timestamp,
        finished_at: timestamp,
      });
      insert(database, 'context_messages', {
        seq: index,
        message_id: `message-${index}`,
        thread_id: threadId,
        agent_id: 'main',
        role: 'user',
        content: `message ${index}`,
        created_at: timestamp,
        run_id: `run-${index}`,
      });
    }
    database.close();

    expect(
      (
        await upgradeDatabaseFile({
          dataDirectory,
          backupDirectory: join(dataDirectory, 'backups'),
        })
      ).status,
    ).toBe('migrated');
    const upgraded = openDatabase(databasePath);
    expect(
      upgraded.prepare('SELECT seq, thread_id, thread_type FROM threads ORDER BY seq').all(),
    ).toEqual([
      { seq: 1, thread_id: 'thread-1', thread_type: 'main' },
      { seq: 2, thread_id: 'thread-2', thread_type: 'task' },
    ]);
    const store = new SessionStore(upgraded);
    seedTestSession(upgraded, 'user-1', 'migration-session');
    store.agentEnvironments.createPolicy({
      ownerId: 'user-1',
      threadId: 'thread-2',
      agentId: 'thread',
    });
    expect(store.getOrCreateMainThread('user-1').threadId).toBe('thread-1');
    for (const index of [1, 2]) {
      expect(store.getRunById(`run-${index}`)).toMatchObject({
        threadId: `thread-${index}`,
        agentId: 'thread',
      });
      expect(store.getInput('user-1', `input-${index}`)).toMatchObject({
        threadId: `thread-${index}`,
        consumedRunId: `run-${index}`,
      });
      expect(
        store.context
          .query({ threadId: `thread-${index}`, agentId: 'thread', currentOnly: true })
          .map((message) => message.messageId),
      ).toEqual([`message-${index}`]);
    }
    const accepted = store.sendMessage({
      ownerId: 'user-1',
      clientActionId: 'new-task-run',
      method: 'SendMessage',
      parameters: { threadId: 'thread-2', text: 'new message', mode: 'follow_up' },
      threadId: 'thread-2',
      text: 'new message',
      mode: 'follow_up',
    });
    const newRun = store.getRunById(accepted.runId);
    expect(newRun).toMatchObject({ threadId: 'thread-2', agentId: 'thread' });
    expect(
      store.context
        .query({ threadId: newRun.threadId, agentId: newRun.agentId, currentOnly: true })
        .map((message) => message.messageId),
    ).toContain('message-2');
    upgraded.close();
  });

  it('preserves periodic Recaps from the ce75c51 context_recap/8 shape', async () => {
    const dataDirectory = directory();
    const databasePath = join(dataDirectory, 'kairos.sqlite');
    const database = createLegacy(databasePath, { context: 'periodic8' });
    insert(database, 'context_messages', {
      seq: 1,
      message_id: 'periodic-message',
      thread_id: 'thread-1',
      agent_id: 'main',
      role: 'user',
      content: 'periodic source',
      created_at: timestamp,
      run_id: 'run-1',
    });
    insert(database, 'recaps', {
      recap_id: 'periodic-recap',
      thread_id: 'thread-1',
      agent_id: 'main',
      source_seq_start: 1,
      source_seq_end: 1,
      source_message_seqs: '[1]',
      title: 'periodic title',
      content: 'periodic recap',
      created_at: timestamp,
      validity: 'valid',
    });
    insert(database, 'recap_sources', {
      recap_id: 'periodic-recap',
      position: 1,
      message_seq: 1,
    });
    insert(database, 'recap_generation_operations', {
      operation_id: 'periodic-operation',
      thread_id: 'thread-1',
      agent_id: 'main',
      view_version: 0,
      source_message_seqs_json: '[1]',
      source_fingerprint: 'source-fingerprint',
      instruction_version: 1,
      request_fingerprint: 'request-fingerprint',
      operation_kind: 'periodic',
      status: 'completed',
      recap_id: 'periodic-recap',
      created_at: timestamp,
      updated_at: timestamp,
    });
    database.close();

    expect(
      (
        await upgradeDatabaseFile({
          dataDirectory,
          backupDirectory: join(dataDirectory, 'backups'),
        })
      ).status,
    ).toBe('migrated');
    const upgraded = openDatabase(databasePath);
    expect(
      upgraded.prepare('SELECT agent_id, status, recap_id FROM recap_generation_operations').get(),
    ).toEqual({
      agent_id: 'thread',
      status: 'completed',
      recap_id: 'periodic-recap',
    });
    const store = new SessionStore(upgraded);
    expect(store.recaps.query({ threadId: 'thread-1', agentId: 'thread' })).toMatchObject([
      { recapId: 'periodic-recap', content: 'periodic recap', sourceMessageSeqs: [1] },
    ]);
    upgraded.close();
  });
});

interface WalSnapshot {
  dataDirectory: string;
  databasePath: string;
  hashes: Record<string, string>;
  temporaryBefore: Set<string>;
}

function createWalSnapshot(environmentVersion: 2 | 4): WalSnapshot {
  const originDirectory = directory();
  const originPath = join(originDirectory, 'origin.sqlite');
  const origin = new DatabaseSync(originPath, { enableForeignKeyConstraints: true });
  origin.exec('PRAGMA journal_mode = WAL;');
  migrateServerDatabase(origin);
  if (environmentVersion === 2) {
    origin.exec(`
      ALTER TABLE environment_operations DROP COLUMN binary_content;
      ALTER TABLE environment_operations DROP COLUMN create_parents;
      ALTER TABLE environment_operations DROP COLUMN sync_action;
      ALTER TABLE environment_operations DROP COLUMN sync_offset;
      ALTER TABLE environment_operations DROP COLUMN transfer_id;
      ALTER TABLE environment_operations DROP COLUMN total_size;
      ALTER TABLE environment_operations DROP COLUMN executable;
      ALTER TABLE environment_operations DROP COLUMN create_directory;
      ALTER TABLE environment_operations DROP COLUMN conflict_scan;
      ALTER TABLE environment_operations DROP COLUMN relative_paths_json;
      DROP TABLE environment_sync_files;
      DROP TABLE environment_syncs;
    `);
    origin
      .prepare('DELETE FROM schema_migrations WHERE namespace = ?')
      .run('environment_operations');
    origin
      .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)')
      .run(
        'environment_operations',
        2,
        'environment_operations_remote_files_and_bash_final',
        timestamp,
      );
  }
  insert(origin, 'context_messages', {
    message_id: 'wal-only-message',
    thread_id: 'thread-1',
    agent_id: 'thread',
    role: 'user',
    content: 'present only after WAL recovery',
    created_at: timestamp,
  });
  expect(existsSync(`${originPath}-wal`)).toBe(true);
  expect(existsSync(`${originPath}-shm`)).toBe(true);
  expect(statSync(`${originPath}-wal`).size).toBeGreaterThan(0);

  const dataDirectory = directory();
  const databasePath = join(dataDirectory, 'kairos.sqlite');
  copyFileSync(originPath, databasePath);
  copyFileSync(`${originPath}-wal`, `${databasePath}-wal`);
  copyFileSync(`${originPath}-shm`, `${databasePath}-shm`);
  const hashes = Object.fromEntries(
    ['', '-wal', '-shm'].map((suffix) => [suffix, fileHash(`${databasePath}${suffix}`)]),
  );
  const temporaryBefore = new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith('kairos-sqlite-work-')),
  );
  origin.close();
  return { dataDirectory, databasePath, hashes, temporaryBefore };
}

function expectWalSnapshotUnchanged(snapshot: WalSnapshot): void {
  for (const suffix of ['', '-wal', '-shm']) {
    expect(fileHash(`${snapshot.databasePath}${suffix}`)).toBe(snapshot.hashes[suffix]);
  }
  const remaining = readdirSync(tmpdir()).filter(
    (name) => name.startsWith('kairos-sqlite-work-') && !snapshot.temporaryBefore.has(name),
  );
  expect(remaining).toEqual([]);
  expect(
    readdirSync(snapshot.dataDirectory).filter((name) => name.startsWith('.kairos-migration-')),
  ).toEqual([]);
}

describe('uncheckpointed WAL source safety', () => {
  it('does not change the main database, WAL or SHM during --check', () => {
    const snapshot = createWalSnapshot(4);
    const backupDirectory = join(snapshot.dataDirectory, 'backups');
    const result = runMigrateCli([
      '--data-dir',
      snapshot.dataDirectory,
      '--backup-dir',
      backupDirectory,
      '--check',
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'current' });
    expectWalSnapshotUnchanged(snapshot);
    expect(existsSync(backupDirectory)).toBe(false);
  });

  it('does not checkpoint or remove WAL files for a current no-op', async () => {
    const snapshot = createWalSnapshot(4);
    const result = await upgradeDatabaseFile({
      dataDirectory: snapshot.dataDirectory,
      backupDirectory: join(snapshot.dataDirectory, 'backups'),
    });

    expect(result.status).toBe('current');
    expectWalSnapshotUnchanged(snapshot);
  });

  it('does not change source files or leave work copies after backup failure', async () => {
    const snapshot = createWalSnapshot(2);
    const backupDirectory = join(snapshot.dataDirectory, 'backup-file');
    writeFileSync(backupDirectory, 'not a directory');

    await expect(
      upgradeDatabaseFile({
        dataDirectory: snapshot.dataDirectory,
        backupDirectory,
      }),
    ).rejects.toThrow();
    expectWalSnapshotUnchanged(snapshot);
    expect(checkDatabaseFile(snapshot.databasePath).status).toBe('migration_required');
    expectWalSnapshotUnchanged(snapshot);
  });
});
