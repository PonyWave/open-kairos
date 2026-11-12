import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { platformLifecycleStates } from './schema.js';

export const controlEnvironmentSchema = z.object({
  deployment_id: z.string(),
  env_id: z.string(),
  tenant_id: z.string(),
  state: z.enum(platformLifecycleStates),
  sandbox_id: z.string().nullable(),
  batch_uid: z.string().nullable(),
  pod_uid: z.string().nullable(),
  pod_name: z.string().nullable(),
  instance_id: z.string().nullable(),
  runtime_version: z.number().int(),
  current_operation_id: z.string().nullable(),
  snapshot_json: z.string().nullable(),
  previous_snapshot_json: z.string().nullable(),
  preparation_json: z.string().nullable(),
  leaf_json: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  idle_since: z.string().datetime().nullable(),
});
export const controlOperationSchema = z.object({
  operation_id: z.string(),
  deployment_id: z.string(),
  env_id: z.string(),
  kind: z.enum(['create', 'pause', 'resume', 'delete']),
  status: z.enum(['prepared', 'dispatched', 'unknown', 'completed', 'cancelled', 'failed']),
  runtime_version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ControlledEnvironment = z.infer<typeof controlEnvironmentSchema>;
export type PlatformLifecycleOperation = z.infer<typeof controlOperationSchema>;
export const PLATFORM_CONTROL_SCHEMA_VERSION = 2;
export const DEFAULT_PLATFORM_IDLE_TIMEOUT_MS = 3_600_000;

export function platformControlSchemaSQL(version: 1 | 2 = PLATFORM_CONTROL_SCHEMA_VERSION): string {
  return `
PRAGMA user_version=${version};
CREATE TABLE platform_control_meta(id INTEGER PRIMARY KEY CHECK(id=1),cluster_json TEXT NOT NULL,capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 5)${version === 2 ? `,idle_timeout_ms INTEGER NOT NULL DEFAULT ${DEFAULT_PLATFORM_IDLE_TIMEOUT_MS} CHECK(idle_timeout_ms >= 0)` : ''});
CREATE TABLE platform_control_environments(deployment_id TEXT NOT NULL,env_id TEXT NOT NULL,tenant_id TEXT NOT NULL,state TEXT NOT NULL,sandbox_id TEXT,batch_uid TEXT,pod_uid TEXT,pod_name TEXT,instance_id TEXT,runtime_version INTEGER NOT NULL DEFAULT 0,current_operation_id TEXT,snapshot_json TEXT,previous_snapshot_json TEXT,preparation_json TEXT,leaf_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL${version === 2 ? ',idle_since TEXT' : ''},PRIMARY KEY(deployment_id,env_id));
CREATE TABLE platform_control_slots(slot INTEGER PRIMARY KEY,deployment_id TEXT,env_id TEXT,UNIQUE(deployment_id,env_id));
CREATE TABLE platform_control_operations(operation_id TEXT PRIMARY KEY,deployment_id TEXT NOT NULL,env_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,runtime_version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX platform_control_active_operation ON platform_control_operations(deployment_id,env_id) WHERE status IN ('prepared','dispatched','unknown');
CREATE TABLE platform_control_uses(deployment_id TEXT NOT NULL,env_id TEXT NOT NULL,usage_id TEXT NOT NULL,tenant_id TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(deployment_id,env_id,usage_id));
`;
}

function normalizedSchema(database: DatabaseSync): unknown[] {
  return database
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' OR type='index' ORDER BY type,name",
    )
    .all()
    .map((row) => ({
      ...row,
      sql:
        typeof row.sql === 'string' ? row.sql.replaceAll(/\s+/g, '').replaceAll('"', '') : row.sql,
    }));
}

export interface PlatformControlInspection {
  version: 1 | 2;
  capacity: number;
  cluster: string;
  idleTimeoutMs?: number;
}

export function inspectPlatformControlDatabase(
  database: DatabaseSync,
  expectedSchema: DatabaseSync,
): PlatformControlInspection {
  const version = database.prepare('PRAGMA user_version').get()?.user_version;
  if (version !== 1 && version !== PLATFORM_CONTROL_SCHEMA_VERSION)
    throw new Error('Unsupported platform control database version.');
  expectedSchema.exec(platformControlSchemaSQL(version));
  if (
    JSON.stringify(normalizedSchema(database)) !== JSON.stringify(normalizedSchema(expectedSchema))
  )
    throw new Error('Unknown platform control database schema.');
  if (database.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
    throw new Error('Platform control database integrity check failed.');
  if (database.prepare('PRAGMA foreign_key_check').all().length > 0)
    throw new Error('Platform control database foreign key check failed.');
  const rows = database.prepare('SELECT * FROM platform_control_meta').all();
  const meta = z
    .array(
      z.object({
        id: z.literal(1),
        cluster_json: z.string(),
        capacity: z.number().int().min(1).max(5),
      }),
    )
    .length(1)
    .parse(rows)[0];
  if (!meta) throw new Error('Platform control metadata is missing.');
  z.tuple([z.string().min(1), z.string().min(1), z.string().min(1), z.string().min(1)]).parse(
    JSON.parse(meta.cluster_json),
  );
  const slots = z
    .array(
      z.object({
        slot: z.number().int().positive(),
        deployment_id: z.string().nullable(),
        env_id: z.string().nullable(),
      }),
    )
    .parse(database.prepare('SELECT * FROM platform_control_slots ORDER BY slot').all());
  if (
    slots.length !== meta.capacity ||
    slots.some(
      (slot, index) =>
        slot.slot !== index + 1 || (slot.env_id === null) !== (slot.deployment_id === null),
    )
  )
    throw new Error('Platform slot registry is incomplete or inconsistent.');
  const environments = database.prepare('SELECT * FROM platform_control_environments').all();
  for (const environment of environments)
    controlEnvironmentSchema.parse(
      version === 1 ? { ...environment, idle_since: null } : environment,
    );
  for (const operation of database.prepare('SELECT * FROM platform_control_operations').all())
    controlOperationSchema.parse(operation);
  z.array(
    z.object({
      deployment_id: z.string(),
      env_id: z.string(),
      usage_id: z.string(),
      tenant_id: z.string(),
      kind: z.enum(['run', 'operation', 'reload']),
      created_at: z.string(),
    }),
  ).parse(database.prepare('SELECT * FROM platform_control_uses').all());
  return {
    version,
    capacity: meta.capacity,
    cluster: meta.cluster_json,
    ...(version === 2
      ? { idleTimeoutMs: z.number().int().nonnegative().parse(rows[0]?.idle_timeout_ms) }
      : {}),
  };
}
