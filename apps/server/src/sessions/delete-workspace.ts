import type { DatabaseSync } from 'node:sqlite';
import { SessionError } from './errors.js';

// The caller has checked ownership and holds the write transaction. Keep the thread
// set intact until all dependent records are removed. No device or filesystem operations.
export function deleteWorkspaceRecords(
  db: DatabaseSync,
  ownerId: string,
  workspaceId: string,
): void {
  const ids = 'SELECT thread_id FROM threads WHERE owner_id = $owner AND workspace_id = $space';
  const params = { owner: ownerId, space: workspaceId };
  const threads = `(${ids})`;
  const runs = `(SELECT run_id FROM runs WHERE thread_id IN ${threads})`;
  const messages = `(SELECT seq FROM context_messages WHERE thread_id IN ${threads})`;
  const requests = `(SELECT request_id FROM model_request_records WHERE thread_id IN ${threads})`;
  const linked = `source_thread_id IN ${threads} OR target_thread_id IN ${threads} OR reply_thread_id IN ${threads}`;
  const schedules = `(SELECT schedule_id FROM automations WHERE owner_id = $owner AND (workspace_id = $space OR target_thread_id IN ${threads}))`;
  const query = (sql: string) => db.prepare(sql).get(params);
  if (
    query(`SELECT 1 FROM runs WHERE thread_id IN ${threads} AND status IN ('queued','running','waiting','cancel_requested')
      UNION ALL SELECT 1 FROM background_tasks WHERE thread_id IN ${threads} AND status = 'running'
      UNION ALL SELECT 1 FROM manual_compact_operations WHERE thread_id IN ${threads} AND status = 'running'
      UNION ALL SELECT 1 FROM interactions WHERE (${linked}) AND status IN ('queued','running','waiting','cancel_requested') LIMIT 1`)
  ) {
    throw new SessionError(
      'failed_precondition',
      '工作空间仍有任务正在执行。请先停止任务或等待其完成，再删除工作空间。',
    );
  }
  if (
    query(
      `SELECT 1 FROM automations WHERE schedule_id IN ${schedules} AND deleted_at IS NULL LIMIT 1`,
    )
  ) {
    throw new SessionError(
      'failed_precondition',
      '有定时任务使用这个工作空间或其中的对话。请先修改执行目标或删除该定时任务，再删除工作空间。',
    );
  }
  // Keep unrelated schedules and their execution history. A deleted conversation can
  // no longer be opened from a past fire.
  const exec = (sql: string) => db.prepare(sql).run(params);
  exec(
    `UPDATE automation_fires SET target_thread_id=NULL, input_id=NULL, accepted_run_id=NULL, consumed_run_id=NULL WHERE target_thread_id IN ${threads}`,
  );
  exec(`DELETE FROM automation_fires WHERE schedule_id IN ${schedules}`);
  exec(`DELETE FROM automations WHERE schedule_id IN ${schedules}`);
  exec(
    `DELETE FROM interaction_deliveries WHERE (source_thread_id,source_agent_id,source_tool_call_id) IN (SELECT source_thread_id,source_agent_id,source_tool_call_id FROM interactions WHERE ${linked})`,
  );
  exec(`DELETE FROM interactions WHERE ${linked}`);
  exec(
    `DELETE FROM thread_notifications WHERE source_thread_id IN ${threads} OR reply_thread_id IN ${threads}`,
  );
  exec(`DELETE FROM run_model_configurations WHERE run_id IN ${runs}`);
  exec(`DELETE FROM request_model_configurations WHERE request_id IN ${requests}`);
  exec(`DELETE FROM context_message_revisions WHERE message_seq IN ${messages}`);
  for (const table of [
    'agent_execution_environments',
    'agent_environment_requests',
    'agent_environment_operations',
    'agent_environment_message_bindings',
    'server_bash_operations',
    'model_input_recaps',
    'recap_generation_operations',
    'model_input_states',
    'model_request_records',
    'context_events',
    'context_tool_calls',
    'recaps',
  ])
    exec(`DELETE FROM ${table} WHERE thread_id IN ${threads}`);
  // Other conversations may have historical parent pointers into this workspace.
  exec(
    `UPDATE runs SET parent_run_id = NULL WHERE parent_run_id IN ${runs} AND thread_id NOT IN ${threads}`,
  );
  exec(`UPDATE runs SET rerun_from_message_seq = NULL WHERE thread_id IN ${threads}`);
  exec(`DELETE FROM runs WHERE thread_id IN ${threads}`);
  exec(`DELETE FROM context_messages WHERE thread_id IN ${threads}`);
  exec(`DELETE FROM threads WHERE owner_id = $owner AND workspace_id = $space`);
  exec('DELETE FROM workspaces WHERE tenant_id = $owner AND workspace_id = $space');
}
