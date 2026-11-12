/** Installed only by the coordinated business database migration. */
export const platformBusinessSchemaSQL = `
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

export const platformLifecycleStates = [
  'uninitialized',
  'starting',
  'running',
  'pausing',
  'paused',
  'resuming',
  'deleting',
  'deleted',
  'error',
] as const;
export type PlatformLifecycleState = (typeof platformLifecycleStates)[number];
