/** Applied only by the unified context_recap schema installation or offline migration. */
export const executionEnvironmentSchema = `
  CREATE TABLE agent_execution_environments (
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    generation INTEGER NOT NULL CHECK(generation > 0),
    owner_id TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(thread_id),
    agent_id TEXT NOT NULL,
    default_env TEXT NOT NULL REFERENCES environments(env_id),
    default_pwd TEXT NOT NULL,
    allowed_env_json TEXT NOT NULL,
    history_id TEXT NOT NULL REFERENCES agent_environment_binding_history(history_id),
    resource_version TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY(run_id, generation)
  );
  CREATE INDEX agent_execution_environments_scope
    ON agent_execution_environments(thread_id, agent_id, run_id, generation);
  ALTER TABLE agent_environment_operations ADD COLUMN execution_generation INTEGER;
  ALTER TABLE agent_environment_operations ADD COLUMN resolved_action_json TEXT;
`;
