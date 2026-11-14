import type { Migration } from '../storage/migrations.js';

export const sessionMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'server_runtime_v1_baseline',
    sql: `
CREATE TABLE automation_fires (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        fire_id TEXT NOT NULL UNIQUE,
        schedule_id TEXT NOT NULL REFERENCES automations(schedule_id),
        owner_id TEXT NOT NULL,
        trigger_source TEXT NOT NULL CHECK(trigger_source IN ('scheduled', 'run_now')),
        schedule_version INTEGER NOT NULL CHECK(schedule_version > 0),
        scheduled_at TEXT NOT NULL,
        actual_at TEXT NOT NULL,
        coalesced_count INTEGER NOT NULL CHECK(coalesced_count >= 0),
        prompt TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK(target_kind IN (
          'main', 'existing_thread', 'new_task', 'new_automation_only'
        )),
        target_thread_id TEXT REFERENCES threads(thread_id),
        input_id TEXT UNIQUE REFERENCES inputs(input_id),
        accepted_run_id TEXT REFERENCES runs(run_id),
        consumed_run_id TEXT REFERENCES runs(run_id),
        status TEXT NOT NULL CHECK(status IN (
          'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'
        )),
        error_code TEXT,
        error_message TEXT,
        error_retryable INTEGER CHECK(error_retryable IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
CREATE TABLE automations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('cron', 'once')),
        cron_expression TEXT,
        time_zone TEXT NOT NULL,
        run_at TEXT,
        target_kind TEXT NOT NULL CHECK(target_kind IN (
          'main', 'existing_thread', 'new_task', 'new_automation_only'
        )),
        target_thread_id TEXT REFERENCES threads(thread_id),
        environment_policy_json TEXT,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        version INTEGER NOT NULL CHECK(version > 0),
        cursor_at TEXT,
        next_fire_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT, workspace_id TEXT REFERENCES workspaces(workspace_id),
        CHECK(
          (schedule_kind = 'cron' AND cron_expression IS NOT NULL AND run_at IS NULL)
          OR (schedule_kind = 'once' AND cron_expression IS NULL AND run_at IS NOT NULL)
        ),
        CHECK(
          (target_kind = 'existing_thread' AND target_thread_id IS NOT NULL)
          OR (target_kind <> 'existing_thread' AND target_thread_id IS NULL)
        )
      );
CREATE TABLE client_actions (
        owner_id TEXT NOT NULL,
        client_action_id TEXT NOT NULL,
        method TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, client_action_id)
      );
CREATE TABLE input_attachments (
        input_id TEXT NOT NULL REFERENCES inputs(input_id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position > 0),
        attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id), source TEXT NOT NULL DEFAULT 'file'
        CHECK(source IN ('file', 'clipboard')), workspace_required INTEGER NOT NULL DEFAULT 0
        CHECK(workspace_required IN (0, 1)), workspace_status TEXT
        CHECK(workspace_status IN ('pending', 'completed')), env_id TEXT, path TEXT, operation_id TEXT,
        PRIMARY KEY(input_id, position),
        UNIQUE(input_id, attachment_id)
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
        source TEXT NOT NULL CHECK(source IN (
          'user', 'thread_call', 'thread_response', 'subagent_response', 'automation'
        )),
        delegation_source_thread_id TEXT,
        delegation_source_agent_id TEXT,
        source_tool_call_id TEXT,
        source_thread_id TEXT,
        source_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, automation_schedule_id TEXT, automation_fire_id TEXT, automation_trigger TEXT
        CHECK(automation_trigger IS NULL OR automation_trigger IN ('scheduled', 'run_now')), automation_scheduled_at TEXT,
        UNIQUE(thread_id, position),
        CHECK(
          (delegation_source_thread_id IS NULL AND delegation_source_agent_id IS NULL AND source_tool_call_id IS NULL)
          OR (delegation_source_thread_id IS NOT NULL AND delegation_source_agent_id IS NOT NULL AND source_tool_call_id IS NOT NULL)
        )
      );
CREATE TABLE interaction_deliveries (
        source_thread_id TEXT NOT NULL,
        source_agent_id TEXT NOT NULL,
        source_tool_call_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        reply_thread_id TEXT NOT NULL REFERENCES threads(thread_id),
        content TEXT,
        context_message_seq INTEGER REFERENCES context_messages(seq),
        run_id TEXT REFERENCES runs(run_id),
        status TEXT NOT NULL CHECK(status IN ('pending', 'queued', 'consumed', 'superseded')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        queued_at TEXT,
        consumed_at TEXT,
        PRIMARY KEY(source_thread_id, source_agent_id, source_tool_call_id),
        FOREIGN KEY(source_thread_id, source_agent_id, source_tool_call_id)
          REFERENCES interactions(source_thread_id, source_agent_id, source_tool_call_id),
        UNIQUE(run_id, source_thread_id, source_agent_id, source_tool_call_id),
        CHECK(status <> 'consumed' OR context_message_seq IS NOT NULL),
        CHECK(status = 'consumed' OR context_message_seq IS NULL)
      );
CREATE TABLE interactions (
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
        status TEXT NOT NULL CHECK(status IN (
          'queued', 'running', 'waiting', 'cancel_requested',
          'completed', 'failed', 'cancelled', 'interrupted'
        )),
        response_message_seq INTEGER REFERENCES context_messages(seq),
        error_code TEXT,
        error_message TEXT,
        error_retryable INTEGER CHECK(error_retryable IN (0, 1)),
        cancel_requested_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY(source_thread_id, source_agent_id, source_tool_call_id),
        UNIQUE(target_input_id),
        CHECK(status <> 'completed' OR response_message_seq IS NOT NULL),
        CHECK(status NOT IN ('failed', 'cancelled', 'interrupted') OR response_message_seq IS NULL)
      );
CREATE TABLE manual_compact_operations (
        operation_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        client_action_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN (
          'running', 'changed', 'noop', 'failed', 'interrupted'
        )),
        read_through_seq INTEGER,
        recap_ids_json TEXT NOT NULL DEFAULT '[]',
        error_code TEXT,
        error_message TEXT,
        error_retryable INTEGER CHECK(error_retryable IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(owner_id, client_action_id),
        CHECK(status IN ('running', 'failed', 'interrupted') OR read_through_seq IS NOT NULL),
        CHECK(status NOT IN ('failed', 'interrupted') OR error_message IS NOT NULL)
      );
CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'queued', 'running', 'waiting', 'cancel_requested',
          'completed', 'failed', 'cancelled', 'interrupted'
        )),
        execution_mode TEXT NOT NULL CHECK(execution_mode IN ('foreground', 'background')),
        input_ids_json TEXT NOT NULL DEFAULT '[]',
        parent_run_id TEXT REFERENCES runs(run_id),
        rerun_from_message_seq INTEGER REFERENCES context_messages(seq),
        superseded_by_run_id TEXT REFERENCES runs(run_id),
        error_code TEXT,
        error_message TEXT,
        error_retryable INTEGER CHECK(error_retryable IN (0, 1)),
        usage_input_tokens INTEGER NOT NULL DEFAULT 0,
        usage_output_tokens INTEGER NOT NULL DEFAULT 0,
        usage_reported INTEGER NOT NULL DEFAULT 0 CHECK(usage_reported IN (0, 1)),
        current_request_id TEXT,
        execution_generation INTEGER NOT NULL DEFAULT 1,
        cancel_accepted_generation INTEGER,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
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
CREATE TABLE thread_event_retention (
        thread_id TEXT PRIMARY KEY REFERENCES threads(thread_id) ON DELETE CASCADE,
        first_available_seq INTEGER NOT NULL DEFAULT 1,
        last_event_seq INTEGER NOT NULL DEFAULT 0
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
CREATE TABLE thread_notifications (
        source_thread_id TEXT NOT NULL REFERENCES threads(thread_id),
        source_agent_id TEXT NOT NULL,
        source_tool_call_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        source_run_id TEXT NOT NULL REFERENCES runs(run_id),
        reply_thread_id TEXT NOT NULL REFERENCES threads(thread_id),
        content TEXT NOT NULL,
        delivery_content TEXT NOT NULL,
        context_message_seq INTEGER REFERENCES context_messages(seq),
        run_id TEXT REFERENCES runs(run_id),
        status TEXT NOT NULL CHECK(status IN ('pending', 'queued', 'consumed', 'superseded')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        queued_at TEXT,
        consumed_at TEXT, target TEXT NOT NULL DEFAULT 'global'
        CHECK(target IN ('workspace', 'global')),
        PRIMARY KEY(source_thread_id, source_agent_id, source_tool_call_id),
        FOREIGN KEY(source_thread_id, source_agent_id, source_tool_call_id)
          REFERENCES context_tool_calls(thread_id, agent_id, call_id),
        UNIQUE(run_id, source_thread_id, source_agent_id, source_tool_call_id),
        CHECK(status <> 'consumed' OR context_message_seq IS NOT NULL),
        CHECK(status = 'consumed' OR context_message_seq IS NULL)
      );
CREATE TABLE thread_queues (
        thread_id TEXT PRIMARY KEY REFERENCES threads(thread_id) ON DELETE CASCADE,
        queue_version INTEGER NOT NULL DEFAULT 0,
        next_position INTEGER NOT NULL DEFAULT 1
      );
CREATE TABLE "threads" (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        thread_type TEXT NOT NULL CHECK(thread_type IN ('main', 'workspace_main', 'task')),
        workspace_id TEXT REFERENCES workspaces(workspace_id),
        automation_only INTEGER NOT NULL DEFAULT 0 CHECK(automation_only IN (0, 1)),
        archived_at TEXT,
        reset_from_thread_id TEXT REFERENCES threads(thread_id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(thread_type <> 'workspace_main' OR workspace_id IS NOT NULL)
      );
CREATE TABLE workspaces (
        workspace_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        env_id TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tenant_id, env_id, path)
      );
CREATE INDEX automation_fires_active ON automation_fires(status, schedule_id);
CREATE INDEX automation_fires_schedule_seq ON automation_fires(schedule_id, seq);
CREATE INDEX automation_fires_target ON automation_fires(schedule_id, target_thread_id);
CREATE UNIQUE INDEX automation_one_active_fire ON automation_fires(schedule_id)
        WHERE status IN ('queued', 'running');
CREATE UNIQUE INDEX automation_scheduled_occurrence
        ON automation_fires(schedule_id, scheduled_at) WHERE trigger_source = 'scheduled';
CREATE INDEX automations_due ON automations(enabled, deleted_at, next_fire_at);
CREATE INDEX automations_owner_seq ON automations(owner_id, seq);
CREATE INDEX input_attachments_attachment
        ON input_attachments(attachment_id, input_id);
CREATE UNIQUE INDEX inputs_delegation_source
        ON inputs(delegation_source_thread_id, delegation_source_agent_id, source_tool_call_id, source)
        WHERE source_tool_call_id IS NOT NULL;
CREATE INDEX inputs_source
        ON inputs(delegation_source_thread_id, delegation_source_agent_id, source_tool_call_id);
CREATE INDEX inputs_thread_status_position
        ON inputs(thread_id, status, position);
CREATE INDEX interaction_deliveries_reply
        ON interaction_deliveries(reply_thread_id, status, source_thread_id, source_agent_id, source_tool_call_id);
CREATE INDEX interactions_consumed_run
        ON interactions(consumed_run_id, source_thread_id, source_agent_id, source_tool_call_id);
CREATE INDEX interactions_reply
        ON interactions(reply_thread_id, status, source_thread_id, source_agent_id, source_tool_call_id);
CREATE INDEX interactions_target
        ON interactions(target_thread_id, status, source_thread_id, source_agent_id, source_tool_call_id);
CREATE INDEX manual_compact_operations_thread_status
        ON manual_compact_operations(thread_id, status, updated_at);
CREATE INDEX runs_thread_active ON runs(thread_id, status);
CREATE INDEX runs_thread_created ON runs(thread_id, created_at, run_id);
CREATE INDEX server_bash_operations_owner
        ON server_bash_operations(owner_id, created_at, operation_id);
CREATE INDEX thread_events_thread_seq ON thread_events(thread_id, seq);
CREATE INDEX thread_notifications_reply
        ON thread_notifications(reply_thread_id, status, created_at, source_tool_call_id);
CREATE INDEX thread_notifications_source_run
        ON thread_notifications(source_run_id, source_tool_call_id);
CREATE UNIQUE INDEX threads_one_main_per_owner
        ON threads(owner_id) WHERE thread_type = 'main' AND archived_at IS NULL;
CREATE UNIQUE INDEX threads_one_workspace_main_per_workspace
        ON threads(workspace_id) WHERE thread_type = 'workspace_main';
CREATE INDEX threads_owner_seq ON threads(owner_id, seq);
CREATE TABLE background_tasks (
        task_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        source_tool_call_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('bash', 'subagent')),
        description TEXT NOT NULL,
        operation_id TEXT,
        status TEXT NOT NULL CHECK(status IN (
          'running', 'completed', 'failed', 'timed_out', 'killed', 'unknown'
        )),
        result_text TEXT,
        delivery_content TEXT,
        delivery_run_id TEXT,
        delivery_status TEXT NOT NULL DEFAULT 'pending'
          CHECK(delivery_status IN ('pending', 'queued', 'consumed')),
        context_message_seq INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT,
        consumed_at TEXT
      );
CREATE INDEX background_tasks_owner
        ON background_tasks(thread_id, agent_id, created_at, task_id);
CREATE INDEX background_tasks_delivery
        ON background_tasks(delivery_run_id, delivery_status);
CREATE TABLE mcp_oauth_credentials (
        credential_key TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL DEFAULT '',
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'channel_integration',
    foreignKeysOff: true,
    sql: `
CREATE TABLE inputs_next (
        input_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        text TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('follow_up', 'steer')),
        status TEXT NOT NULL CHECK(status IN ('queued', 'consumed', 'cancelled')),
        position INTEGER NOT NULL CHECK(position > 0),
        version INTEGER NOT NULL CHECK(version > 0),
        consumed_run_id TEXT,
        source TEXT NOT NULL CHECK(source IN (
          'user', 'thread_call', 'thread_response', 'subagent_response', 'automation',
          'channel'
        )),
        delegation_source_thread_id TEXT,
        delegation_source_agent_id TEXT,
        source_tool_call_id TEXT,
        source_thread_id TEXT,
        source_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, automation_schedule_id TEXT, automation_fire_id TEXT, automation_trigger TEXT
        CHECK(automation_trigger IS NULL OR automation_trigger IN ('scheduled', 'run_now')), automation_scheduled_at TEXT,
        channel_json TEXT,
        UNIQUE(thread_id, position),
        CHECK(
          (delegation_source_thread_id IS NULL AND delegation_source_agent_id IS NULL AND source_tool_call_id IS NULL)
          OR (delegation_source_thread_id IS NOT NULL AND delegation_source_agent_id IS NOT NULL AND source_tool_call_id IS NOT NULL)
        )
      );
INSERT INTO inputs_next (
        input_id, thread_id, owner_id, text, mode, status, position, version, consumed_run_id,
        source, delegation_source_thread_id, delegation_source_agent_id, source_tool_call_id,
        source_thread_id, source_agent_id, created_at, updated_at, automation_schedule_id,
        automation_fire_id, automation_trigger, automation_scheduled_at, channel_json
      )
      SELECT
        input_id, thread_id, owner_id, text, mode, status, position, version, consumed_run_id,
        source, delegation_source_thread_id, delegation_source_agent_id, source_tool_call_id,
        source_thread_id, source_agent_id, created_at, updated_at, automation_schedule_id,
        automation_fire_id, automation_trigger, automation_scheduled_at, NULL
      FROM inputs;
DROP TABLE inputs;
ALTER TABLE inputs_next RENAME TO inputs;
CREATE UNIQUE INDEX inputs_delegation_source
        ON inputs(delegation_source_thread_id, delegation_source_agent_id, source_tool_call_id, source)
        WHERE source_tool_call_id IS NOT NULL;
CREATE INDEX inputs_source
        ON inputs(delegation_source_thread_id, delegation_source_agent_id, source_tool_call_id);
CREATE INDEX inputs_thread_status_position
        ON inputs(thread_id, status, position);
CREATE TABLE channel_states (
        tenant_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('wechat', 'feishu')),
        status TEXT NOT NULL CHECK(status IN (
          'unconfigured', 'pending_login', 'pending_binding', 'active', 'error'
        )),
        account_label TEXT NOT NULL DEFAULT '',
        external_user_id TEXT,
        encrypted_credentials TEXT,
        context_token TEXT,
        inbound_cursor TEXT NOT NULL DEFAULT '',
        pairing_code TEXT,
        status_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, channel)
      );
CREATE TABLE channel_inbound_events (
        tenant_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('wechat', 'feishu')),
        external_message_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, channel, external_message_id)
      );
CREATE TABLE channel_deliveries (
        delivery_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('wechat', 'feishu')),
        message_id TEXT,
        tool_call_id TEXT,
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'delivering', 'succeeded', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
        last_error_code TEXT,
        last_error_message TEXT,
        last_error_retryable INTEGER CHECK(last_error_retryable IN (0, 1)),
        next_attempt_at TEXT,
        notified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE INDEX channel_deliveries_due ON channel_deliveries(status, next_attempt_at);
CREATE INDEX channel_deliveries_owner ON channel_deliveries(owner_id, created_at, delivery_id);
    `,
  },
  {
    version: 3,
    name: 'workspace_details_and_sidebar_visibility',
    sql: `
ALTER TABLE workspaces ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE workspaces ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1));
    `,
  },
  {
    version: 4,
    name: 'workspace_main_reset_allows_archived_predecessor',
    sql: `
DROP INDEX threads_one_workspace_main_per_workspace;
CREATE UNIQUE INDEX threads_one_workspace_main_per_workspace
        ON threads(workspace_id) WHERE thread_type = 'workspace_main' AND archived_at IS NULL;
    `,
  },
  {
    version: 5,
    name: 'channel_attachment_source',
    foreignKeysOff: true,
    sql: `
CREATE TABLE input_attachments_next (
        input_id TEXT NOT NULL REFERENCES inputs(input_id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position > 0),
        attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id), source TEXT NOT NULL DEFAULT 'file'
        CHECK(source IN ('file', 'clipboard', 'channel')), workspace_required INTEGER NOT NULL DEFAULT 0
        CHECK(workspace_required IN (0, 1)), workspace_status TEXT
        CHECK(workspace_status IN ('pending', 'completed')), env_id TEXT, path TEXT, operation_id TEXT,
        PRIMARY KEY(input_id, position),
        UNIQUE(input_id, attachment_id)
      );
INSERT INTO input_attachments_next (
        input_id, position, attachment_id, source, workspace_required, workspace_status,
        env_id, path, operation_id
      )
      SELECT
        input_id, position, attachment_id, source, workspace_required, workspace_status,
        env_id, path, operation_id
      FROM input_attachments;
DROP TABLE input_attachments;
ALTER TABLE input_attachments_next RENAME TO input_attachments;
CREATE INDEX input_attachments_attachment
        ON input_attachments(attachment_id, input_id);
    `,
  },
  {
    version: 6,
    name: 'channel_message_map',
    sql: `
CREATE TABLE channel_message_map (
        tenant_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('wechat', 'feishu')),
        external_message_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        input_id TEXT,
        message_seq INTEGER,
        excerpt TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, channel, external_message_id)
      );
CREATE INDEX channel_message_map_inbound
        ON channel_message_map(tenant_id, channel, direction, created_at);
    `,
  },
  {
    version: 7,
    name: 'channel_delivery_attachments',
    sql: `
ALTER TABLE channel_deliveries ADD COLUMN attachment_ids_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 8,
    name: 'channel_delivery_notice_kind',
    sql: `
ALTER TABLE channel_deliveries ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'
        CHECK(kind IN ('message', 'failure_notice'));
ALTER TABLE channel_deliveries ADD COLUMN dedup_key TEXT;
CREATE UNIQUE INDEX channel_deliveries_dedup
        ON channel_deliveries(owner_id, dedup_key) WHERE dedup_key IS NOT NULL;
    `,
  },
];
