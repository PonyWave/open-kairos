import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { SessionError } from '../sessions/errors.js';
import { inTransaction } from '../storage/transaction.js';
import type { PlatformUse } from './contracts.js';
import { inspectPlatformControlFile } from './control-files.js';
import {
  type ControlledEnvironment,
  controlEnvironmentSchema,
  controlOperationSchema,
  DEFAULT_PLATFORM_IDLE_TIMEOUT_MS,
  PLATFORM_CONTROL_SCHEMA_VERSION,
  type PlatformLifecycleOperation,
  platformControlSchemaSQL,
} from './control-schema.js';

export interface PlatformClusterIdentity {
  caSha256: string;
  nodeUid: string;
  nodeName: string;
  namespace: string;
}
export interface ControlStoreOptions {
  path: string;
  deploymentId: string;
  cluster: PlatformClusterIdentity;
  capacity: number;
  idleTimeoutMs?: number;
  now?: () => Date;
}
export type { ControlledEnvironment, PlatformLifecycleOperation } from './control-schema.js';

function stableCluster(value: PlatformClusterIdentity): string {
  return JSON.stringify([value.caSha256, value.nodeUid, value.nodeName, value.namespace]);
}
function validateOptions(options: ControlStoreOptions): void {
  if (
    !isAbsolute(options.path) ||
    options.path !== realpathSync(options.path) ||
    !Number.isSafeInteger(options.capacity) ||
    options.capacity < 1 ||
    options.capacity > 5 ||
    (options.idleTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 0)) ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(options.deploymentId)
  )
    throw new Error('Platform control database configuration is invalid.');
}

/** Administrative initialization only; Server construction never invokes this. */
export function initializePlatformControlDatabase(
  options: Omit<ControlStoreOptions, 'deploymentId'>,
): void {
  if (
    !isAbsolute(options.path) ||
    existsSync(options.path) ||
    !Number.isSafeInteger(options.capacity) ||
    options.capacity < 1 ||
    options.capacity > 5 ||
    (options.idleTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 0))
  )
    throw new Error(
      'A new explicit platform control database path and capacity 1..5 are required.',
    );
  closeSync(openSync(options.path, 'wx', 0o600));
  const db = new DatabaseSync(options.path);
  try {
    inTransaction(db, () => {
      db.exec(platformControlSchemaSQL());
      db.prepare(
        'INSERT INTO platform_control_meta(id,cluster_json,capacity,idle_timeout_ms) VALUES (1,?,?,?)',
      ).run(
        stableCluster(options.cluster),
        options.capacity,
        options.idleTimeoutMs ?? DEFAULT_PLATFORM_IDLE_TIMEOUT_MS,
      );
      for (let slot = 1; slot <= options.capacity; slot++)
        db.prepare('INSERT INTO platform_control_slots(slot) VALUES (?)').run(slot);
    });
    db.exec('PRAGMA journal_mode=WAL');
  } finally {
    db.close();
  }
  chmodSync(options.path, 0o600);
}

export class PlatformControlStore {
  readonly database: DatabaseSync;
  readonly #identity: { dev: number; ino: number };
  constructor(readonly options: ControlStoreOptions) {
    validateOptions(options);
    const info = lstatSync(options.path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error('Platform control database must be an existing private regular file.');
    this.#identity = { dev: info.dev, ino: info.ino };
    const inspection = inspectPlatformControlFile(options.path, { requireStableSource: false });
    if (inspection.version !== PLATFORM_CONTROL_SCHEMA_VERSION)
      throw new Error(
        'Platform control database migration is required; stop all Servers using this file and run platform/migrate.js.',
      );
    if (inspection.idleTimeoutMs !== (options.idleTimeoutMs ?? DEFAULT_PLATFORM_IDLE_TIMEOUT_MS))
      throw new Error('Platform idle timeout does not match the shared control database.');
    this.database = new DatabaseSync(options.path, { enableForeignKeyConstraints: true });
    try {
      this.database.exec('PRAGMA busy_timeout=1000');
      this.assertIdentity();
      const version = this.database.prepare('PRAGMA user_version').get();
      const meta = this.database
        .prepare('SELECT cluster_json,capacity FROM platform_control_meta WHERE id=1')
        .get();
      const integrity = this.database.prepare('PRAGMA quick_check').get();
      if (
        version?.user_version !== PLATFORM_CONTROL_SCHEMA_VERSION ||
        meta?.cluster_json !== stableCluster(options.cluster) ||
        meta?.capacity !== options.capacity ||
        integrity?.quick_check !== 'ok'
      )
        throw new Error(
          'Platform control database version, cluster, capacity or integrity does not match.',
        );
      const count = this.database.prepare('SELECT COUNT(*) AS n FROM platform_control_slots').get();
      if (count?.n !== options.capacity) throw new Error('Platform slot registry is incomplete.');
    } catch (error) {
      this.database.close();
      throw error;
    }
  }
  assertIdentity(): void {
    const current = lstatSync(this.options.path);
    if (
      current.dev !== this.#identity.dev ||
      current.ino !== this.#identity.ino ||
      !current.isFile()
    )
      throw new Error(
        'Platform control database file was replaced or removed; allocation is disabled.',
      );
  }
  close(): void {
    this.database.close();
  }
  get(envId: string): ControlledEnvironment | undefined {
    this.assertIdentity();
    const row = this.database
      .prepare('SELECT * FROM platform_control_environments WHERE deployment_id=? AND env_id=?')
      .get(this.options.deploymentId, envId);
    return row === undefined ? undefined : controlEnvironmentSchema.parse(row);
  }
  list(): ControlledEnvironment[] {
    this.assertIdentity();
    return this.database
      .prepare('SELECT * FROM platform_control_environments WHERE deployment_id=?')
      .all(this.options.deploymentId)
      .map((row) => controlEnvironmentSchema.parse(row));
  }
  listAll(): ControlledEnvironment[] {
    this.assertIdentity();
    return this.database
      .prepare('SELECT * FROM platform_control_environments')
      .all()
      .map((row) => controlEnvironmentSchema.parse(row));
  }
  operation(id: string): PlatformLifecycleOperation {
    const row = this.database
      .prepare('SELECT * FROM platform_control_operations WHERE deployment_id=? AND operation_id=?')
      .get(this.options.deploymentId, id);
    return controlOperationSchema.parse(row);
  }
  useCount(envId: string): number {
    return z
      .object({ n: z.number() })
      .parse(
        this.database
          .prepare(
            'SELECT COUNT(*) AS n FROM platform_control_uses WHERE deployment_id=? AND env_id=?',
          )
          .get(this.options.deploymentId, envId),
      ).n;
  }
  uses(): PlatformUse[] {
    this.assertIdentity();
    return this.database
      .prepare(
        'SELECT tenant_id,env_id,usage_id,kind FROM platform_control_uses WHERE deployment_id=?',
      )
      .all(this.options.deploymentId)
      .map((row) => {
        const value = z
          .object({
            tenant_id: z.string(),
            env_id: z.string(),
            usage_id: z.string(),
            kind: z.enum(['run', 'operation', 'reload']),
          })
          .parse(row);
        return {
          tenantId: value.tenant_id,
          envId: value.env_id,
          usageId: value.usage_id,
          kind: value.kind,
        };
      });
  }
  reserve(input: PlatformUse): ControlledEnvironment {
    this.assertIdentity();
    return inTransaction(this.database, () => {
      const now = this.#now().toISOString();
      let env = this.get(input.envId);
      if (env && env.tenant_id !== input.tenantId)
        throw new SessionError('permission_denied', 'Platform environment tenant does not match.');
      if (!env) {
        this.database
          .prepare(
            `INSERT INTO platform_control_environments(deployment_id,env_id,tenant_id,state,created_at,updated_at) VALUES (?,?,?,'uninitialized',?,?)`,
          )
          .run(this.options.deploymentId, input.envId, input.tenantId, now, now);
        env = this.get(input.envId);
      }
      if (!env) throw new Error('Platform environment insert failed.');
      if (['deleted', 'deleting'].includes(env.state))
        throw new SessionError(
          'failed_precondition',
          'The platform environment requires lifecycle reconciliation.',
        );
      if (env.state === 'error') {
        const previous = this.database
          .prepare(
            'SELECT 1 FROM platform_control_uses WHERE deployment_id=? AND env_id=? AND usage_id=?',
          )
          .get(this.options.deploymentId, input.envId, input.usageId);
        if (previous || !env.current_operation_id)
          throw new SessionError(
            'sandbox_unavailable',
            'A new explicit use is required to retry platform preparation.',
          );
        const operation = this.operation(env.current_operation_id);
        if (operation.kind === 'create' && operation.status === 'prepared') {
          const preparation = env.preparation_json ? JSON.parse(env.preparation_json) : undefined;
          if (preparation && typeof preparation === 'object')
            this.update(input.envId, {
              preparation_json: JSON.stringify({ ...preparation, retryRequested: true }),
            });
        }
        this.update(input.envId, {
          state:
            operation.kind === 'create'
              ? 'starting'
              : operation.kind === 'resume'
                ? 'resuming'
                : operation.kind === 'pause'
                  ? 'pausing'
                  : 'deleting',
          error: null,
        });
        env = this.get(input.envId);
        if (!env) throw new Error('Platform retry identity disappeared.');
      }
      const slot = this.database
        .prepare('SELECT slot FROM platform_control_slots WHERE deployment_id=? AND env_id=?')
        .get(this.options.deploymentId, input.envId);
      if (!slot) {
        const free = this.database
          .prepare(
            'SELECT slot FROM platform_control_slots WHERE deployment_id IS NULL ORDER BY slot LIMIT 1',
          )
          .get();
        if (!free)
          throw new SessionError(
            'sandbox_capacity_exhausted',
            '当前 sandbox 均被占用，暂时无法启动环境，请稍后重试。',
          );
        this.database
          .prepare(
            'UPDATE platform_control_slots SET deployment_id=?,env_id=? WHERE slot=? AND deployment_id IS NULL',
          )
          .run(
            this.options.deploymentId,
            input.envId,
            z.object({ slot: z.number().int() }).parse(free).slot,
          );
      }
      const existing = this.database
        .prepare(
          'SELECT tenant_id,kind FROM platform_control_uses WHERE deployment_id=? AND env_id=? AND usage_id=?',
        )
        .get(this.options.deploymentId, input.envId, input.usageId);
      if (existing && (existing.tenant_id !== input.tenantId || existing.kind !== input.kind))
        throw new SessionError('action_conflict', 'Platform use identity conflicts.');
      this.database
        .prepare('INSERT OR IGNORE INTO platform_control_uses VALUES (?,?,?,?,?,?)')
        .run(
          this.options.deploymentId,
          input.envId,
          input.usageId,
          input.tenantId,
          input.kind,
          now,
        );
      if (env.state === 'pausing' && env.current_operation_id) {
        const cancelled = this.database
          .prepare(
            `UPDATE platform_control_operations SET status='cancelled',updated_at=? WHERE operation_id=? AND status='prepared'`,
          )
          .run(now, env.current_operation_id);
        if (cancelled.changes === 1)
          this.update(input.envId, { state: 'running', current_operation_id: null });
      }
      this.update(input.envId, { idle_since: null });
      env = this.get(input.envId);
      if (env && (env.state === 'uninitialized' || env.state === 'paused'))
        this.prepare(input.envId, env.state === 'uninitialized' ? 'create' : 'resume');
      const reserved = this.get(input.envId);
      if (!reserved) throw new Error('Platform reservation disappeared.');
      return reserved;
    });
  }
  release(input: PlatformUse): void {
    this.assertIdentity();
    inTransaction(this.database, () => {
      this.database
        .prepare(
          'DELETE FROM platform_control_uses WHERE deployment_id=? AND env_id=? AND usage_id=? AND tenant_id=? AND kind=?',
        )
        .run(this.options.deploymentId, input.envId, input.usageId, input.tenantId, input.kind);
      const env = this.get(input.envId);
      if (env?.state === 'running' && this.useCount(input.envId) === 0 && env.idle_since === null)
        this.update(input.envId, { idle_since: this.#now().toISOString() });
    });
  }
  prepareIdlePause(envId: string): string | undefined {
    this.assertIdentity();
    return inTransaction(this.database, () => {
      const env = this.get(envId);
      if (env?.state !== 'running' || env.current_operation_id) return undefined;
      if (this.useCount(envId) > 0) {
        if (env.idle_since !== null) this.update(envId, { idle_since: null });
        return undefined;
      }
      const now = this.#now();
      if (env.idle_since === null) {
        this.update(envId, { idle_since: now.toISOString() });
        return undefined;
      }
      if (
        now.getTime() - Date.parse(env.idle_since) <
        (this.options.idleTimeoutMs ?? DEFAULT_PLATFORM_IDLE_TIMEOUT_MS)
      )
        return undefined;
      return this.prepare(envId, 'pause');
    });
  }
  #now(): Date {
    return this.options.now?.() ?? new Date();
  }
  prepare(envId: string, kind: PlatformLifecycleOperation['kind']): string {
    const env = this.get(envId);
    if (!env) throw new Error('Platform environment is missing.');
    if (env.current_operation_id) return env.current_operation_id;
    const id = randomUUID();
    const now = this.#now().toISOString();
    const runtime = env.runtime_version + (kind === 'create' || kind === 'resume' ? 1 : 0);
    this.database
      .prepare(`INSERT INTO platform_control_operations VALUES (?,?,?,?,'prepared',?,?,?)`)
      .run(id, this.options.deploymentId, envId, kind, runtime, now, now);
    this.update(envId, {
      current_operation_id: id,
      runtime_version: runtime,
      state:
        kind === 'create'
          ? 'starting'
          : kind === 'resume'
            ? 'resuming'
            : kind === 'pause'
              ? 'pausing'
              : 'deleting',
    });
    if (kind === 'create' || kind === 'resume') this.update(envId, { idle_since: null });
    if (kind === 'pause')
      this.update(envId, {
        previous_snapshot_json: env.snapshot_json ?? env.previous_snapshot_json,
        snapshot_json: null,
      });
    return id;
  }
  claim(id: string): boolean {
    this.assertIdentity();
    return (
      this.database
        .prepare(
          `UPDATE platform_control_operations SET status='dispatched',updated_at=? WHERE operation_id=? AND deployment_id=? AND status='prepared'`,
        )
        .run(this.#now().toISOString(), id, this.options.deploymentId).changes === 1
    );
  }
  claimPreparation(envId: string): boolean {
    this.assertIdentity();
    return (
      this.database
        .prepare(
          'UPDATE platform_control_environments SET preparation_json=? WHERE deployment_id=? AND env_id=? AND preparation_json IS NULL',
        )
        .run(
          JSON.stringify({ stage: 'credential_pending', physical: [] }),
          this.options.deploymentId,
          envId,
        ).changes === 1
    );
  }
  markOperation(id: string, status: PlatformLifecycleOperation['status']): void {
    this.database
      .prepare(
        'UPDATE platform_control_operations SET status=?,updated_at=? WHERE operation_id=? AND deployment_id=?',
      )
      .run(status, this.#now().toISOString(), id, this.options.deploymentId);
  }
  update(
    envId: string,
    values: Partial<
      Pick<
        ControlledEnvironment,
        | 'state'
        | 'sandbox_id'
        | 'batch_uid'
        | 'pod_uid'
        | 'pod_name'
        | 'instance_id'
        | 'runtime_version'
        | 'current_operation_id'
        | 'snapshot_json'
        | 'previous_snapshot_json'
        | 'preparation_json'
        | 'leaf_json'
        | 'error'
        | 'idle_since'
      >
    >,
  ): void {
    this.assertIdentity();
    const entries = Object.entries(values);
    if (!entries.length) return;
    this.database
      .prepare(
        `UPDATE platform_control_environments SET ${entries.map(([name]) => `${name}=?`).join(',')},updated_at=? WHERE deployment_id=? AND env_id=?`,
      )
      .run(
        ...entries.map(([, value]) => value ?? null),
        this.#now().toISOString(),
        this.options.deploymentId,
        envId,
      );
  }
  complete(
    envId: string,
    operationId: string,
    values: Parameters<PlatformControlStore['update']>[1],
  ): void {
    inTransaction(this.database, () => {
      const env = this.get(envId);
      if (env?.current_operation_id !== operationId)
        throw new Error('Lifecycle operation CAS conflict.');
      this.markOperation(operationId, 'completed');
      this.update(envId, { ...values, current_operation_id: null, error: null });
      if (values.state === 'paused') {
        this.update(envId, { idle_since: null });
        if (this.useCount(envId) > 0) this.prepare(envId, 'resume');
        else
          this.database
            .prepare(
              'UPDATE platform_control_slots SET deployment_id=NULL,env_id=NULL WHERE deployment_id=? AND env_id=?',
            )
            .run(this.options.deploymentId, envId);
      } else if (
        values.state === 'running' &&
        this.useCount(envId) === 0 &&
        env?.idle_since === null
      )
        this.update(envId, { idle_since: this.#now().toISOString() });
    });
  }
  associateCreatedSandbox(input: {
    envId: string;
    operationId: string;
    runtimeVersion: number;
    sandboxId: string;
    batchUid?: string;
  }): void {
    inTransaction(this.database, () => {
      const env = this.get(input.envId);
      const operation = this.operation(input.operationId);
      if (
        env?.state !== 'starting' ||
        env.current_operation_id !== input.operationId ||
        env.runtime_version !== input.runtimeVersion ||
        operation.env_id !== input.envId ||
        operation.runtime_version !== input.runtimeVersion ||
        operation.kind !== 'create' ||
        !['dispatched', 'unknown'].includes(operation.status) ||
        (env.sandbox_id !== null && env.sandbox_id !== input.sandboxId) ||
        (input.batchUid !== undefined && env.batch_uid !== null && env.batch_uid !== input.batchUid)
      )
        throw new SessionError(
          'permission_denied',
          'The original dispatched create association changed.',
        );
      this.update(input.envId, {
        sandbox_id: input.sandboxId,
        ...(input.batchUid === undefined ? {} : { batch_uid: input.batchUid }),
      });
    });
  }
  bindRuntime(
    envId: string,
    pod: { uid: string; name: string; batchUid: string },
    instanceId: string,
    expectedVersion: number,
    expectedPauseOperationId?: string,
  ): void {
    inTransaction(this.database, () => {
      const env = this.get(envId);
      if (expectedPauseOperationId !== undefined) {
        const pause = env?.current_operation_id
          ? this.operation(env.current_operation_id)
          : undefined;
        if (
          env?.state !== 'pausing' ||
          env.current_operation_id !== expectedPauseOperationId ||
          env.runtime_version !== expectedVersion ||
          !env.sandbox_id ||
          env.batch_uid !== pod.batchUid ||
          env.pod_uid !== pod.uid ||
          env.pod_name !== pod.name ||
          env.instance_id !== instanceId ||
          pause?.kind !== 'pause' ||
          pause.env_id !== envId ||
          pause.runtime_version !== expectedVersion ||
          !['prepared', 'dispatched', 'unknown'].includes(pause.status)
        )
          throw new SessionError(
            'permission_denied',
            'A pausing platform runtime can only reconnect its unchanged recorded instance.',
          );
        return;
      }
      if (
        !env ||
        env.runtime_version !== expectedVersion ||
        !['starting', 'resuming', 'running'].includes(env.state) ||
        (env.pod_uid &&
          env.pod_uid === pod.uid &&
          env.instance_id &&
          env.instance_id !== instanceId)
      )
        throw new SessionError(
          'permission_denied',
          'Platform runtime version cannot be replaced by this hello.',
        );
      this.update(envId, {
        pod_uid: pod.uid,
        pod_name: pod.name,
        batch_uid: pod.batchUid,
        instance_id: instanceId,
      });
    });
  }
}
