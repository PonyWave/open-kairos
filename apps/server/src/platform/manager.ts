import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { type EnvironmentRecord, EnvironmentStore } from '../devices/environment-store.js';
import { SessionError } from '../sessions/errors.js';
import {
  AbsentBootstrapAttemptError,
  type KubeObject,
  kubeObjectSchema,
  type PlatformBackend,
  platformClaimName,
} from './backend.js';
import type { PlatformUse, PlatformUseGateway } from './contracts.js';
import {
  type ControlledEnvironment,
  type ControlStoreOptions,
  PlatformControlStore,
} from './control-store.js';
import { platformNetworkRole } from './network-policy.js';
import type { PlatformPhysicalObserver } from './physical-observer.js';
import { physicalEvidenceSchema } from './physical-observer.js';

export interface PlatformHelloInput {
  tenantId: string;
  envId: string;
  instanceId: string;
  podName: string;
  podUid: string;
  deviceBindingId?: string;
  controlOnly: boolean;
  signal: AbortSignal;
}
export interface PlatformHelloAuthorization {
  runtimeVersion: number;
  previousInstanceGone: boolean;
}
export interface PlatformHelloAuthorizer {
  authorizeHello(input: PlatformHelloInput): Promise<PlatformHelloAuthorization>;
}
export interface PlatformWorkspaceGateway {
  ensureWorkspaceReady(input: {
    tenantId: string;
    envId: string;
    pwd: '/workspace';
    signal: AbortSignal;
  }): Promise<void>;
}
export interface PlatformManagerOptions extends ControlStoreOptions {
  backend: PlatformBackend;
  physicalObserver: PlatformPhysicalObserver;
  operations: PlatformWorkspaceGateway;
  preparationTimeoutMs?: number;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
  onEnvironmentChange?: (environment: EnvironmentRecord) => void;
  sharedReleaseClaim?: string;
}
const imageSchema = z.object({
  containerName: z.string(),
  imageUri: z.string(),
  imageDigest: z.string(),
});
const snapshotEvidenceSchema = z.object({
  uid: z.string(),
  sourcePodUid: z.string(),
  sourceInstanceId: z.string().nullable(),
  images: z.array(imageSchema),
  jobs: z.array(
    z.object({ uid: z.string(), podUid: z.string(), physical: physicalEvidenceSchema }),
  ),
  sourcePhysical: physicalEvidenceSchema,
});
const preparationSchema = z.object({
  stage: z.enum(['credential_pending', 'dispatched', 'completed']),
  job: kubeObjectSchema.optional(),
  physical: z.array(physicalEvidenceSchema),
  attemptId: z.string().optional(),
  attemptNumber: z.number().int().min(0).max(3).default(0),
  bootstrapSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  replacesSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  retryRequested: z.boolean().optional(),
  replacesSha256s: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .max(3)
    .optional(),
  retiredAttempts: z.array(z.unknown()).default([]),
  pendingRetry: z
    .object({
      attemptId: z.string(),
      attemptNumber: z.number().int().positive().max(3),
      replacesSha256: z.string().optional(),
      replacesSha256s: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(3)
        .optional(),
    })
    .optional(),
});
type SnapshotEvidence = z.infer<typeof snapshotEvidenceSchema>;
function owned(resource: KubeObject, uid: string): boolean {
  return resource.metadata.ownerReferences?.some((owner) => owner.uid === uid) ?? false;
}
function phase(resource: KubeObject): string | undefined {
  return typeof resource.status?.phase === 'string' ? resource.status.phase : undefined;
}

export class PlatformManager implements PlatformUseGateway, PlatformHelloAuthorizer {
  readonly control: PlatformControlStore;
  readonly #environments: EnvironmentStore;
  readonly #controller = new AbortController();
  readonly #tasks = new Map<string, Promise<void>>();
  readonly #options: PlatformManagerOptions;
  readonly #startup = Promise.withResolvers<{ ok: true } | { ok: false; error: unknown }>();
  #startPromise: Promise<void> | undefined;
  #started = false;
  #closing = false;
  #recoveryTask: Promise<void> | undefined;
  constructor(
    readonly database: DatabaseSync,
    options: PlatformManagerOptions,
  ) {
    this.#options = options;
    this.control = new PlatformControlStore(options);
    this.#environments = new EnvironmentStore(database);
  }
  reserveUse(input: PlatformUse): void {
    this.#assertOwned(input);
    if (!this.#started || this.#closing)
      throw new SessionError(
        'sandbox_unavailable',
        'Platform manager has not completed lifecycle reconciliation.',
      );
    const now = this.#now().toISOString();
    this.database
      .prepare(
        `INSERT INTO platform_usage_intents(env_id,usage_id,tenant_id,kind,status,created_at,updated_at) VALUES (?,?,?,?,'prepared',?,?) ON CONFLICT(env_id,usage_id) DO NOTHING`,
      )
      .run(input.envId, input.usageId, input.tenantId, input.kind, now, now);
    const priorOperation = this.control.get(input.envId)?.current_operation_id;
    this.control.reserve(input);
    if (priorOperation) this.#mirrorOperation(input.envId, priorOperation);
    this.database
      .prepare(
        `UPDATE platform_usage_intents SET status='reserved',updated_at=? WHERE env_id=? AND usage_id=? AND tenant_id=? AND kind=?`,
      )
      .run(now, input.envId, input.usageId, input.tenantId, input.kind);
    this.#sync(input.envId);
    this.#schedule(input.envId);
  }
  releaseUse(input: PlatformUse): void {
    this.#assertOwned(input);
    this.control.release(input);
    this.database
      .prepare(
        `UPDATE platform_usage_intents SET status='released',updated_at=? WHERE env_id=? AND usage_id=? AND tenant_id=? AND kind=?`,
      )
      .run(this.#now().toISOString(), input.envId, input.usageId, input.tenantId, input.kind);
    this.#sync(input.envId);
    this.#schedule(input.envId);
  }
  async ensureReady(input: PlatformUse & { signal: AbortSignal }): Promise<void> {
    this.#assertOwned(input);
    if (!this.#started || this.#closing)
      throw new SessionError(
        'sandbox_unavailable',
        'Platform lifecycle reconciliation is not ready.',
      );
    const registered = this.database
      .prepare(
        `SELECT status FROM platform_usage_intents WHERE env_id=? AND usage_id=? AND tenant_id=? AND kind=?`,
      )
      .get(input.envId, input.usageId, input.tenantId, input.kind);
    if (registered?.status !== 'reserved')
      throw new SessionError('sandbox_unavailable', 'Platform use has no durable reservation.');
    const deadline = Date.now() + (this.#options.preparationTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      input.signal.throwIfAborted();
      this.#controller.signal.throwIfAborted();
      this.#schedule(input.envId);
      const env = this.control.get(input.envId);
      if (env?.state === 'running') {
        await this.#options.operations.ensureWorkspaceReady({
          tenantId: input.tenantId,
          envId: input.envId,
          pwd: '/workspace',
          signal: input.signal,
        });
        this.#environments.requireReady(input.tenantId, input.envId);
        return;
      }
      if (env?.state === 'error')
        throw new SessionError(
          'sandbox_unavailable',
          'Platform environment preparation failed; lifecycle reconciliation is required.',
          { cause: new Error(env.error ?? 'Platform lifecycle reconciliation failed.') },
        );
      await delay(this.#options.pollIntervalMs ?? 500, undefined, { signal: input.signal });
    }
    throw new SessionError(
      'sandbox_unavailable',
      'Platform environment preparation exceeded its deadline.',
    );
  }
  start(): Promise<void> {
    if (!this.#startPromise) {
      this.#startPromise = this.#start().then(
        () => {
          this.#startup.resolve({ ok: true });
        },
        (error: unknown) => {
          this.#started = false;
          this.#startup.resolve({ ok: false, error });
          throw error;
        },
      );
    }
    return this.#startPromise;
  }
  async #start(): Promise<void> {
    this.#controller.signal.throwIfAborted();
    await this.#options.backend.verify(this.#controller.signal);
    this.#controller.signal.throwIfAborted();
    const controlled = this.control.listAll();
    const batches = await this.#options.backend.listBatches(this.#controller.signal);
    this.#controller.signal.throwIfAborted();
    for (const batch of batches) {
      if (!batch.metadata.labels?.['kairos.io/deployment']) {
        if (phase(batch) !== 'Paused')
          throw new Error('An unassociated active BatchSandbox blocks new allocation.');
        continue;
      }
      if (
        !controlled.some(
          (env) =>
            env.deployment_id === batch.metadata.labels?.['kairos.io/deployment'] &&
            (env.sandbox_id === batch.metadata.name ||
              env.current_operation_id === batch.metadata.labels?.['kairos.io/create-operation']),
        )
      )
        throw new Error('An unassociated managed BatchSandbox blocks new allocation.');
    }
    const pods = await this.#options.backend.listPods(this.#controller.signal);
    const bootstrapJobs = await this.#options.backend.listJobs(this.#controller.signal);
    const nativeSnapshots = await this.#options.backend.listSnapshots(this.#controller.signal);
    this.#controller.signal.throwIfAborted();
    for (const pod of pods.filter(
      (value) =>
        !['Succeeded', 'Failed'].includes(phase(value) ?? '') &&
        !batches.some(
          (batch) =>
            owned(value, batch.metadata.uid) &&
            controlled.some(
              (env) =>
                env.sandbox_id === batch.metadata.name && env.batch_uid === batch.metadata.uid,
            ),
        ),
    )) {
      const job = bootstrapJobs.find((value) => owned(pod, value.metadata.uid));
      const nativeSnapshot = job
        ? nativeSnapshots.find((snapshot) => owned(job, snapshot.metadata.uid))
        : undefined;
      const nativeBatch = nativeSnapshot
        ? batches.find((batch) => owned(nativeSnapshot, batch.metadata.uid))
        : undefined;
      if (
        nativeBatch &&
        controlled.some(
          (env) =>
            env.sandbox_id === nativeBatch.metadata.name &&
            env.batch_uid === nativeBatch.metadata.uid &&
            env.current_operation_id,
        )
      )
        continue;
      if (
        !job ||
        !controlled.some(
          (env) =>
            env.deployment_id === job.metadata.labels?.['kairos.io/deployment'] &&
            (env.current_operation_id === job.metadata.labels?.['kairos.io/bootstrap-operation'] ||
              (env.preparation_json &&
                preparationSchema.parse(JSON.parse(env.preparation_json)).job?.metadata.uid ===
                  job.metadata.uid)),
        )
      )
        throw new Error('An unassociated managed business Pod blocks new allocation.');
    }
    for (const env of controlled.filter(
      (value) => value.deployment_id === this.#options.deploymentId && value.preparation_json,
    )) {
      const saved = preparationSchema.parse(JSON.parse(env.preparation_json ?? 'null'));
      if (
        saved.stage === 'completed' &&
        saved.job &&
        bootstrapJobs.some((job) => job.metadata.uid === saved.job?.metadata.uid)
      ) {
        for (const evidence of saved.physical)
          if (!(await this.#options.physicalObserver.exited(evidence)))
            throw new Error('A completed bootstrap helper is still physically active.');
        const operationId = saved.job.metadata.labels?.['kairos.io/bootstrap-operation'];
        if (!operationId) throw new Error('Saved bootstrap helper operation identity is missing.');
        await this.#options.backend.cleanupBootstrap(
          { job: saved.job, envId: env.env_id, operationId },
          this.#controller.signal,
        );
      }
    }
    await this.#recoverUses(true);
    this.#controller.signal.throwIfAborted();
    this.#started = true;
    this.#recoveryTask = (async () => {
      while (!this.#controller.signal.aborted) {
        await delay(1000, undefined, { signal: this.#controller.signal });
        await this.#recoverUses();
      }
    })().catch((error) => {
      if (!this.#closing) {
        this.#started = false;
        this.#options.onError?.(error);
      }
    });
    for (const env of this.control.list()) {
      if (env.state === 'error' && env.current_operation_id) {
        const op = this.control.operation(env.current_operation_id);
        this.control.update(env.env_id, {
          state:
            op.kind === 'create'
              ? 'starting'
              : op.kind === 'pause'
                ? 'pausing'
                : op.kind === 'resume'
                  ? 'resuming'
                  : 'deleting',
          error: null,
        });
      }
      this.#sync(env.env_id);
      this.#schedule(env.env_id);
    }
  }
  async close(): Promise<void> {
    this.#closing = true;
    this.#controller.abort();
    await Promise.allSettled([
      ...(this.#startPromise ? [this.#startPromise] : []),
      ...this.#tasks.values(),
      ...(this.#recoveryTask ? [this.#recoveryTask] : []),
    ]);
    this.control.close();
  }
  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }
  #assertOwned(input: PlatformUse): void {
    const env = this.#environments.get(input.tenantId, input.envId);
    if (env.kind !== 'platform_sandbox')
      throw new SessionError(
        'permission_denied',
        'Lifecycle capacity is only available to platform environments.',
      );
  }
  #sync(envId: string): void {
    const env = this.control.get(envId);
    if (!env) return;
    const changed = this.database
      .prepare(
        "UPDATE environments SET platform_lifecycle_state=?,status_reason=?,updated_at=? WHERE env_id=? AND tenant_id=? AND kind='platform_sandbox' AND (platform_lifecycle_state IS NOT ? OR status_reason IS NOT ?)",
      )
      .run(
        env.state,
        env.error,
        this.#now().toISOString(),
        envId,
        env.tenant_id,
        env.state,
        env.error,
      );
    if (changed.changes === 1)
      this.#options.onEnvironmentChange?.(this.#environments.get(env.tenant_id, envId));
    if (env.current_operation_id) this.#mirrorOperation(envId, env.current_operation_id);
  }
  #mirrorOperation(envId: string, operationId: string): void {
    const op = this.control.operation(operationId);
    this.database
      .prepare(
        `INSERT INTO platform_lifecycle_intents(operation_id,env_id,kind,status,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at`,
      )
      .run(op.operation_id, envId, op.kind, op.status, op.created_at, op.updated_at);
  }
  #complete(
    envId: string,
    operationId: string,
    values: Parameters<PlatformControlStore['complete']>[2],
  ): void {
    this.control.complete(envId, operationId, values);
    this.#mirrorOperation(envId, operationId);
    this.#sync(envId);
  }
  #schedule(envId: string): void {
    if (!this.#started || this.#closing || this.#tasks.has(envId)) return;
    const task = this.#drive(envId)
      .catch((error) => {
        const env = this.control.get(envId);
        if (env?.current_operation_id) {
          const operation = this.control.operation(env.current_operation_id);
          if (operation.status === 'dispatched')
            this.control.markOperation(env.current_operation_id, 'unknown');
        }
        if (!this.#closing) {
          this.control.update(envId, {
            state: 'error',
            error: 'Platform environment preparation failed; lifecycle reconciliation is required.',
          });
          this.#sync(envId);
          this.#options.onError?.(error);
        }
      })
      .finally(() => {
        this.#tasks.delete(envId);
        if (!this.#closing) {
          const current = this.control.get(envId);
          if (current?.state !== 'error' && current?.current_operation_id)
            queueMicrotask(() => this.#schedule(envId));
        }
      });
    this.#tasks.set(envId, task);
  }
  async #drive(envId: string): Promise<void> {
    const signal = this.#controller.signal;
    while (!signal.aborted) {
      let env = this.control.get(envId);
      if (!env) return;
      if (env.state === 'error') return;
      if (!env.current_operation_id) {
        if (env.state === 'running' && this.control.useCount(envId) === 0) {
          if (this.#hasUnsettledOperations(env)) {
            if (env.idle_since !== null) this.control.update(envId, { idle_since: null });
            return;
          }
          this.control.prepareIdlePause(envId);
          env = this.control.get(envId);
        }
        if (!env?.current_operation_id) return;
      }
      const operation = this.control.operation(env.current_operation_id);
      this.#sync(envId);
      if (operation.kind === 'pause' && operation.status === 'prepared') {
        if (this.#hasUnsettledOperations(env)) {
          await delay(this.#options.pollIntervalMs ?? 500, undefined, { signal });
          continue;
        }
      }
      if (operation.kind === 'create' && operation.status === 'prepared') {
        await this.#prepareCreate(env, operation.operation_id, signal);
      }
      if (operation.status === 'prepared' && this.control.claim(operation.operation_id)) {
        this.#sync(envId);
        if (operation.kind === 'create') {
          const id = await this.#options.backend.create(
            {
              envId,
              tenantId: env.tenant_id,
              operationId: operation.operation_id,
            },
            signal,
          );
          this.control.associateCreatedSandbox({
            envId,
            operationId: operation.operation_id,
            runtimeVersion: operation.runtime_version,
            sandboxId: id,
          });
        } else {
          if (!env.sandbox_id)
            throw new Error('Lifecycle operation is missing its original sandbox ID.');
          await this.#options.backend.change(env.sandbox_id, operation.kind, signal);
        }
      }
      env = this.control.get(envId);
      if (!env) return;
      if (env.current_operation_id !== operation.operation_id) continue;
      if (!env.sandbox_id) {
        const matches = (await this.#options.backend.listBatches(signal)).filter(
          (batch) =>
            batch.metadata.labels?.['kairos.io/deployment'] === this.#options.deploymentId &&
            batch.metadata.labels?.['kairos.io/env'] === envId &&
            batch.metadata.labels?.['kairos.io/create-operation'] === operation.operation_id,
        );
        if (matches.length > 1) throw new Error('Multiple BatchSandboxes match one create intent.');
        const matched = matches[0];
        if (!matched) {
          await delay(this.#options.pollIntervalMs ?? 500, undefined, { signal });
          continue;
        }
        this.control.associateCreatedSandbox({
          envId,
          operationId: operation.operation_id,
          runtimeVersion: operation.runtime_version,
          sandboxId: matched.metadata.name,
          batchUid: matched.metadata.uid,
        });
        env = this.control.get(envId);
      }
      if (!env?.sandbox_id) throw new Error('Original platform environment identity disappeared.');
      const batch = await this.#options.backend.getBatch(env.sandbox_id, signal);
      if (!batch)
        throw new Error('The original BatchSandbox is missing; it will not be recreated.');
      this.#validateBatch(env, batch);
      if (operation.kind === 'pause') {
        if (await this.#pauseComplete(env, batch, signal)) {
          this.#complete(envId, operation.operation_id, {
            state: 'paused',
            instance_id: null,
            pod_uid: null,
            pod_name: null,
          });
          this.#sync(envId);
          continue;
        }
      } else if (operation.kind === 'create' || operation.kind === 'resume') {
        const pods = (await this.#options.backend.listPods(signal)).filter((pod) =>
          owned(pod, batch.metadata.uid),
        );
        if (pods.length > 1)
          throw new Error('Multiple business Pods occupy one platform environment.');
        const pod = pods[0];
        if (pod) {
          const physical = await this.#options.physicalObserver.observe(pod.metadata.uid);
          if (physical) this.control.update(envId, { leaf_json: JSON.stringify(physical) });
        }
        const current = this.control.get(envId);
        if (
          pod &&
          phase(pod) === 'Running' &&
          current?.pod_uid === pod.metadata.uid &&
          current.instance_id
        ) {
          const record = this.#environments.get(env.tenant_id, envId);
          if (record.connectionStatus === 'online') {
            this.#complete(envId, operation.operation_id, {
              state: 'running',
              batch_uid: batch.metadata.uid,
            });
            this.#sync(envId);
            continue;
          }
        }
      }
      if (phase(batch) === 'Failed')
        throw new Error('The platform BatchSandbox failed; reservation is retained.');
      await delay(this.#options.pollIntervalMs ?? 500, undefined, { signal });
    }
  }
  #hasUnsettledOperations(env: ControlledEnvironment): boolean {
    const active = this.database
      .prepare(
        `SELECT COUNT(*) AS n FROM environment_operations WHERE tenant_id=? AND env_id=? AND (status IN (1,2,3,4) OR (result_source='device' AND (result_recorded_at IS NULL OR post_processed_at IS NULL OR output_complete=0)))`,
      )
      .get(env.tenant_id, env.env_id);
    return active?.n !== 0;
  }
  async #prepareCreate(
    env: ControlledEnvironment,
    operationId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let evidence = preparationSchema.parse(
      env.preparation_json
        ? JSON.parse(env.preparation_json)
        : { stage: 'credential_pending', physical: [] },
    );
    if (evidence.pendingRetry && evidence.job) {
      for (const physical of evidence.physical)
        if (!(await this.#options.physicalObserver.exited(physical)))
          throw new Error('Retired bootstrap cleanup has not physically completed.');
      await this.#options.backend.cleanupBootstrap(
        { job: evidence.job, envId: env.env_id, operationId },
        signal,
      );
      evidence = preparationSchema.parse({
        stage: 'credential_pending',
        physical: [],
        ...evidence.pendingRetry,
        retiredAttempts: evidence.retiredAttempts,
      });
      this.control.update(env.env_id, { preparation_json: JSON.stringify(evidence) });
    }
    if (evidence.stage === 'completed') return;
    if (
      evidence.job &&
      typeof evidence.job.status?.succeeded === 'number' &&
      evidence.job.status.succeeded > 0 &&
      evidence.physical.length
    ) {
      let exited = true;
      for (const physical of evidence.physical)
        if (!(await this.#options.physicalObserver.exited(physical))) exited = false;
      if (exited) {
        await this.#options.backend.cleanupBootstrap(
          { job: evidence.job, envId: env.env_id, operationId },
          signal,
        );
        this.control.update(env.env_id, {
          preparation_json: JSON.stringify({ ...evidence, stage: 'completed' }),
        });
        return;
      }
    }
    await this.#options.backend.prepareStorage(env.env_id, signal);
    let credential: string | undefined;
    if (!env.preparation_json && !this.control.claimPreparation(env.env_id)) return;
    if (evidence.stage === 'credential_pending') {
      credential = this.#environments.pairing.reissueUnusedInitialization(
        env.tenant_id,
        env.env_id,
      ).pairingCredential;
      evidence.bootstrapSha256 = this.#options.backend.bootstrapHash({
        envId: env.env_id,
        operationId,
        ...(evidence.attemptId ? { attemptId: evidence.attemptId } : {}),
        ...(evidence.replacesSha256 ? { replacesSha256: evidence.replacesSha256 } : {}),
        ...(evidence.replacesSha256s ? { replacesSha256s: evidence.replacesSha256s } : {}),
        pairingCredential: credential,
      });
      evidence.stage = 'dispatched';
      this.control.update(env.env_id, { preparation_json: JSON.stringify(evidence) });
    }
    for (;;) {
      let result: Awaited<ReturnType<PlatformBackend['prepareBootstrap']>>;
      try {
        result = await this.#options.backend.prepareBootstrap(
          {
            envId: env.env_id,
            operationId,
            ...(evidence.attemptId ? { attemptId: evidence.attemptId } : {}),
            ...(evidence.replacesSha256 ? { replacesSha256: evidence.replacesSha256 } : {}),
            ...(evidence.replacesSha256s ? { replacesSha256s: evidence.replacesSha256s } : {}),
            ...(credential ? { pairingCredential: credential } : {}),
          },
          signal,
        );
      } catch (error) {
        if (
          !(error instanceof AbsentBootstrapAttemptError) ||
          !evidence.retryRequested ||
          evidence.job ||
          evidence.attemptNumber >= 3
        )
          throw error;
        const current = this.control.get(env.env_id);
        if (
          !current ||
          current.sandbox_id ||
          this.control.operation(operationId).status !== 'prepared' ||
          (await this.#options.backend.listBatches(signal)).some(
            (batch) =>
              batch.metadata.labels?.['kairos.io/env'] === env.env_id ||
              batch.metadata.labels?.['kairos.io/create-operation'] === operationId,
          )
        )
          throw new Error('An uncertain business create blocks missing-helper preparation retry.');
        const predecessors = [
          ...new Set([
            ...(evidence.replacesSha256s ?? []),
            ...(evidence.bootstrapSha256 ? [evidence.bootstrapSha256] : []),
          ]),
        ];
        evidence = preparationSchema.parse({
          stage: 'credential_pending',
          physical: [],
          attemptId: randomUUID(),
          attemptNumber: evidence.attemptNumber + 1,
          replacesSha256s: predecessors,
          retiredAttempts: [
            ...evidence.retiredAttempts,
            {
              helperName: error.helperName,
              confirmedAbsent: true,
              attemptId: evidence.attemptId ?? operationId,
            },
          ],
        });
        this.control.update(env.env_id, { preparation_json: JSON.stringify(evidence) });
        credential = this.#environments.pairing.reissueUnusedInitialization(
          env.tenant_id,
          env.env_id,
        ).pairingCredential;
        evidence.bootstrapSha256 = this.#options.backend.bootstrapHash({
          envId: env.env_id,
          operationId,
          ...(evidence.attemptId ? { attemptId: evidence.attemptId } : {}),
          ...(evidence.replacesSha256s ? { replacesSha256s: evidence.replacesSha256s } : {}),
          pairingCredential: credential,
        });
        evidence.stage = 'dispatched';
        this.control.update(env.env_id, { preparation_json: JSON.stringify(evidence) });
        continue;
      }
      credential = undefined;
      if (
        evidence.job &&
        (evidence.job.metadata.uid !== result.job.metadata.uid ||
          evidence.job.metadata.name !== result.job.metadata.name)
      )
        throw new Error('The original bootstrap Job UID changed; preparation cannot be replayed.');
      evidence.job = result.job;
      for (const pod of result.pods) {
        if (evidence.physical.some((value) => value.podUid === pod.metadata.uid)) continue;
        const physical = await this.#options.physicalObserver.observe(pod.metadata.uid);
        if (physical) evidence.physical.push(physical);
      }
      this.control.update(env.env_id, { preparation_json: JSON.stringify(evidence) });
      const status = z
        .object({ succeeded: z.number().optional(), failed: z.number().optional() })
        .parse(result.job.status ?? {});
      if (status.failed) {
        if (!evidence.retryRequested || evidence.attemptNumber >= 3)
          throw new Error(
            'Platform bootstrap helper failed; a bounded explicit preparation retry is required.',
          );
        const current = this.control.get(env.env_id);
        if (
          !current ||
          current.sandbox_id ||
          current.current_operation_id !== operationId ||
          this.control.operation(operationId).status !== 'prepared'
        )
          throw new Error('A dispatched or changed create cannot retry its preparation.');
        const batches = await this.#options.backend.listBatches(signal);
        if (
          batches.some(
            (batch) =>
              batch.metadata.labels?.['kairos.io/env'] === env.env_id ||
              batch.metadata.labels?.['kairos.io/create-operation'] === operationId,
          )
        )
          throw new Error('A possible business create already exists; helper retry is blocked.');
        if (
          result.job.metadata.labels?.['kairos.io/bootstrap-operation'] !== operationId ||
          result.job.metadata.labels?.['kairos.io/env'] !== env.env_id ||
          result.job.metadata.labels?.['kairos.io/deployment'] !== this.#options.deploymentId ||
          result.job.spec?.backoffLimit !== 0 ||
          result.pods.length !== 1
        )
          throw new Error(
            'The original failed helper identity or final retry policy cannot be verified.',
          );
        const retired = [];
        for (const pod of result.pods) {
          if (
            !owned(pod, result.job.metadata.uid) ||
            pod.spec?.nodeName !== this.#options.cluster.nodeName ||
            !['Failed', 'Succeeded'].includes(phase(pod) ?? '')
          )
            throw new Error('A failed helper Pod has not reached a trusted terminal state.');
          const statuses = z
            .array(
              z.object({ state: z.object({ terminated: z.object({ exitCode: z.number() }) }) }),
            )
            .min(1)
            .parse(pod.status?.containerStatuses);
          if (!statuses.length) throw new Error('Failed helper container termination is missing.');
          const observed = evidence.physical.find((value) => value.podUid === pod.metadata.uid);
          if (observed) {
            if (!(await this.#options.physicalObserver.exited(observed)))
              throw new Error('The failed helper still has physical processes.');
            retired.push(observed);
          } else {
            if (!this.#options.physicalObserver.retiredHelper)
              throw new Error('Retired helper scope verification is unavailable.');
            retired.push(await this.#options.physicalObserver.retiredHelper(pod.metadata.uid));
          }
        }
        // Save the exact retired attempt before deleting it or issuing a replacement credential.
        const prior = {
          job: result.job,
          pods: result.pods.map((pod) => ({ name: pod.metadata.name, uid: pod.metadata.uid })),
          physical: retired,
          bootstrapSha256: evidence.bootstrapSha256 ?? null,
          attemptId: evidence.attemptId ?? operationId,
        };
        evidence.retiredAttempts.push(prior);
        evidence.pendingRetry = {
          attemptId: randomUUID(),
          attemptNumber: evidence.attemptNumber + 1,
          ...(evidence.bootstrapSha256 ? { replacesSha256: evidence.bootstrapSha256 } : {}),
          replacesSha256s: [
            ...new Set([
              ...(evidence.replacesSha256s ?? []),
              ...(evidence.bootstrapSha256 ? [evidence.bootstrapSha256] : []),
            ]),
          ],
        };
        this.control.update(env.env_id, { preparation_json: JSON.stringify(evidence) });
        await this.#options.backend.cleanupBootstrap(
          { job: result.job, envId: env.env_id, operationId },
          signal,
        );
        evidence = preparationSchema.parse({
          stage: 'credential_pending',
          physical: [],
          ...evidence.pendingRetry,
          retiredAttempts: evidence.retiredAttempts,
        });
        this.control.update(env.env_id, { preparation_json: JSON.stringify(evidence) });
        credential = this.#environments.pairing.reissueUnusedInitialization(
          env.tenant_id,
          env.env_id,
        ).pairingCredential;
        evidence.bootstrapSha256 = this.#options.backend.bootstrapHash({
          envId: env.env_id,
          operationId,
          ...(evidence.attemptId ? { attemptId: evidence.attemptId } : {}),
          pairingCredential: credential,
          ...(evidence.replacesSha256 ? { replacesSha256: evidence.replacesSha256 } : {}),
          ...(evidence.replacesSha256s ? { replacesSha256s: evidence.replacesSha256s } : {}),
        });
        evidence.stage = 'dispatched';
        this.control.update(env.env_id, { preparation_json: JSON.stringify(evidence) });
        continue;
      }
      if (evidence.physical.length)
        await this.#options.backend.acknowledgeBootstrap({ job: result.job, operationId }, signal);
      if (status.succeeded) {
        if (!evidence.physical.length)
          throw new Error('Bootstrap helper physical evidence was not observed.');
        let exited = true;
        for (const physical of evidence.physical)
          if (!(await this.#options.physicalObserver.exited(physical))) exited = false;
        if (exited) {
          await this.#options.backend.cleanupBootstrap(
            { job: result.job, envId: env.env_id, operationId },
            signal,
          );
          evidence.stage = 'completed';
          this.control.update(env.env_id, { preparation_json: JSON.stringify(evidence) });
          return;
        }
      }
      await delay(this.#options.pollIntervalMs ?? 500, undefined, { signal });
    }
  }
  #validateBatch(env: ControlledEnvironment, batch: KubeObject): void {
    if (env.batch_uid && env.batch_uid !== batch.metadata.uid)
      throw new Error('BatchSandbox UID changed.');
    if (
      batch.metadata.labels?.['kairos.io/deployment'] !== this.#options.deploymentId ||
      batch.metadata.labels?.['kairos.io/env'] !== env.env_id ||
      batch.spec?.replicas !== 1 ||
      batch.spec.expireTime ||
      batch.spec.poolRef
    )
      throw new Error('BatchSandbox identity or lifecycle specification is invalid.');
  }
  async #pauseComplete(
    env: ControlledEnvironment,
    batch: KubeObject,
    signal: AbortSignal,
  ): Promise<boolean> {
    const [allSnapshots, allJobs, pods] = await Promise.all([
      this.#options.backend.listSnapshots(signal),
      this.#options.backend.listJobs(signal),
      this.#options.backend.listPods(signal),
    ]);
    const snapshots = allSnapshots.filter((snapshot) => owned(snapshot, batch.metadata.uid));
    if (snapshots.length !== 1) return false;
    const snapshot = snapshots[0];
    if (!snapshot) return false;
    if (phase(snapshot) === 'Failed')
      throw new Error('Native pause snapshot failed; reservation is retained.');
    let evidence: SnapshotEvidence | undefined = env.snapshot_json
      ? snapshotEvidenceSchema.parse(JSON.parse(env.snapshot_json))
      : undefined;
    if (evidence?.uid !== snapshot.metadata.uid) {
      if (!env.leaf_json || !env.pod_uid)
        throw new Error('Pause source physical evidence is missing.');
      evidence = {
        uid: snapshot.metadata.uid,
        sourcePodUid: env.pod_uid,
        sourceInstanceId: env.instance_id,
        images: [],
        jobs: [],
        sourcePhysical: physicalEvidenceSchema.parse(JSON.parse(env.leaf_json)),
      };
    }
    const jobs = allJobs.filter((job) => owned(job, snapshot.metadata.uid));
    for (const job of jobs) {
      for (const pod of pods.filter((pod) => owned(pod, job.metadata.uid))) {
        if (evidence.jobs.some((value) => value.podUid === pod.metadata.uid)) continue;
        const physical = await this.#options.physicalObserver.observe(pod.metadata.uid);
        if (physical)
          evidence.jobs.push({ uid: job.metadata.uid, podUid: pod.metadata.uid, physical });
      }
    }
    if (phase(snapshot) === 'Succeed')
      evidence.images = z.array(imageSchema).parse(snapshot.status?.containers);
    this.control.update(env.env_id, { snapshot_json: JSON.stringify(evidence) });
    for (const job of jobs) {
      if (typeof job.status?.failed === 'number' && job.status.failed > 0)
        throw new Error(
          'Snapshot observation worker failed before a recoverable pause was confirmed.',
        );
      for (const pod of pods.filter((value) => owned(value, job.metadata.uid))) {
        if (
          evidence.jobs.some((value) => value.podUid === pod.metadata.uid) &&
          pod.metadata.annotations?.['kairos.io/physical-observed'] !== pod.metadata.uid
        )
          await this.#options.backend.acknowledgeSnapshotPod(
            {
              snapshotUid: snapshot.metadata.uid,
              jobUid: job.metadata.uid,
              podUid: pod.metadata.uid,
              podName: pod.metadata.name,
            },
            signal,
          );
      }
    }
    if (
      phase(snapshot) !== 'Succeed' ||
      phase(batch) !== 'Paused' ||
      pods.some((pod) => owned(pod, batch.metadata.uid))
    )
      return false;
    if (!evidence.jobs.length)
      throw new Error(
        'Snapshot workers were not physically observed; capacity cannot be released.',
      );
    for (const image of evidence.images)
      await this.#options.backend.verifyManifest(image.imageUri, image.imageDigest, signal);
    if (!(await this.#options.physicalObserver.exited(evidence.sourcePhysical))) return false;
    for (const job of evidence.jobs)
      if (!(await this.#options.physicalObserver.exited(job.physical))) return false;
    this.control.update(env.env_id, {
      previous_snapshot_json: env.previous_snapshot_json ?? env.snapshot_json,
      snapshot_json: JSON.stringify(evidence),
    });
    return true;
  }
  async authorizeHello(input: PlatformHelloInput): Promise<PlatformHelloAuthorization> {
    const signal = AbortSignal.any([
      input.signal,
      this.#controller.signal,
      AbortSignal.timeout(Math.min(this.#options.preparationTimeoutMs ?? 30_000, 30_000)),
    ]);
    signal.throwIfAborted();
    if (this.#closing || input.controlOnly)
      throw new SessionError(
        'permission_denied',
        'Platform execution requires its foreground runtime connection.',
      );
    const startup = await new Promise<{ ok: true } | { ok: false; error: unknown }>(
      (resolve, reject) => {
        const abort = () => {
          signal.removeEventListener('abort', abort);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        void this.#startup.promise.then((result) => {
          signal.removeEventListener('abort', abort);
          resolve(result);
        });
        if (signal.aborted) abort();
      },
    );
    signal.throwIfAborted();
    if (!startup.ok)
      throw new SessionError('permission_denied', 'Platform lifecycle startup failed.', {
        cause: startup.error,
      });
    if (!this.#started || this.#closing)
      throw new SessionError(
        'permission_denied',
        'Platform lifecycle reconciliation is not ready.',
      );
    let env = this.control.get(input.envId);
    if (
      !env ||
      env.tenant_id !== input.tenantId ||
      !['starting', 'resuming', 'running', 'pausing'].includes(env.state)
    )
      throw new SessionError(
        'permission_denied',
        'No active platform start intent authorizes this hello.',
      );
    const reconnectingPause = env.state === 'pausing';
    if (reconnectingPause) {
      const record = this.#environments.get(input.tenantId, input.envId);
      const pause = env.current_operation_id
        ? this.control.operation(env.current_operation_id)
        : undefined;
      if (
        !input.deviceBindingId ||
        input.deviceBindingId !== record.deviceBindingId ||
        !env.sandbox_id ||
        !env.batch_uid ||
        !env.leaf_json ||
        env.pod_uid !== input.podUid ||
        env.pod_name !== input.podName ||
        env.instance_id !== input.instanceId ||
        pause?.kind !== 'pause' ||
        pause.env_id !== input.envId ||
        pause.runtime_version !== env.runtime_version ||
        !['prepared', 'dispatched', 'unknown'].includes(pause.status)
      )
        throw new SessionError(
          'permission_denied',
          'A pausing platform only authorizes its recorded existing bound runtime.',
        );
    }
    let allPods = await this.#options.backend.listPods(signal);
    if (!env.sandbox_id) {
      const operation = env.current_operation_id
        ? this.control.operation(env.current_operation_id)
        : undefined;
      if (
        env.state !== 'starting' ||
        operation?.kind !== 'create' ||
        operation.env_id !== input.envId ||
        operation.runtime_version !== env.runtime_version ||
        !['dispatched', 'unknown'].includes(operation.status)
      )
        throw new SessionError('permission_denied', 'No dispatched create authorizes this Pod.');
      const reported = allPods.filter(
        (pod) => pod.metadata.uid === input.podUid && pod.metadata.name === input.podName,
      );
      const owners = reported[0]?.metadata.ownerReferences?.filter(
        (owner) => owner.kind === 'BatchSandbox',
      );
      if (reported.length !== 1 || owners?.length !== 1)
        throw new SessionError(
          'permission_denied',
          'Platform Pod has no unique BatchSandbox owner.',
        );
      const owner = owners[0];
      const batches = (await this.#options.backend.listBatches(signal)).filter(
        (batch) =>
          batch.metadata.labels?.['kairos.io/deployment'] === this.#options.deploymentId &&
          batch.metadata.labels?.['kairos.io/env'] === input.envId &&
          batch.metadata.labels?.['kairos.io/create-operation'] === operation.operation_id,
      );
      const created = batches[0];
      if (
        batches.length !== 1 ||
        !created ||
        !owner ||
        created.metadata.uid !== owner.uid ||
        created.metadata.name !== owner.name ||
        created.metadata.deletionTimestamp
      )
        throw new SessionError(
          'permission_denied',
          'Platform Pod does not belong to the unique original create.',
        );
      this.#validateBatch(env, created);
      signal.throwIfAborted();
      this.control.associateCreatedSandbox({
        envId: input.envId,
        operationId: operation.operation_id,
        runtimeVersion: env.runtime_version,
        sandboxId: created.metadata.name,
        batchUid: created.metadata.uid,
      });
      env = this.control.get(input.envId);
    }
    if (!env?.sandbox_id)
      throw new SessionError('permission_denied', 'Platform create association disappeared.');
    const initialBatch = await this.#options.backend.getBatch(env.sandbox_id, signal);
    if (!initialBatch)
      throw new SessionError('permission_denied', 'Platform BatchSandbox is missing.');
    let batch: KubeObject = initialBatch;
    this.#validateBatch(env, batch);
    let pods: KubeObject[];
    for (;;) {
      signal.throwIfAborted();
      pods = allPods.filter((pod) => owned(pod, batch.metadata.uid));
      if (pods.length !== 1)
        throw new SessionError(
          'permission_denied',
          pods.length === 0
            ? 'Platform BatchSandbox has no owner Pod.'
            : 'Platform BatchSandbox has multiple owner Pods.',
        );
      const pod = pods[0];
      if (!pod || pod.metadata.uid !== input.podUid || pod.metadata.name !== input.podName)
        throw new SessionError(
          'permission_denied',
          'Platform Pod UID or name changed during authorization.',
        );
      if (
        !pod.metadata.ownerReferences?.some(
          (owner) =>
            owner.uid === batch.metadata.uid &&
            owner.name === batch.metadata.name &&
            owner.kind === 'BatchSandbox',
        )
      )
        throw new SessionError(
          'permission_denied',
          'Platform Pod BatchSandbox owner changed during authorization.',
        );
      if (pod.metadata.deletionTimestamp)
        throw new SessionError(
          'permission_denied',
          'Platform Pod is being deleted during authorization.',
        );
      const observedPhase = phase(pod);
      if (observedPhase === 'Running') break;
      if (observedPhase === 'Failed' || observedPhase === 'Succeeded')
        throw new SessionError(
          'permission_denied',
          `Platform Pod reached terminal phase ${observedPhase} before authorization.`,
        );
      if (observedPhase !== 'Pending')
        throw new SessionError(
          'permission_denied',
          'Platform Pod phase is Unknown or invalid during authorization.',
        );
      const current = this.control.get(input.envId);
      if (
        current?.runtime_version !== env.runtime_version ||
        current.current_operation_id !== env.current_operation_id
      )
        throw new SessionError(
          'permission_denied',
          'Platform runtime version changed during authorization.',
        );
      await delay(Math.min(this.#options.pollIntervalMs ?? 200, 200), undefined, { signal });
      const refreshed = await this.#options.backend.getBatch(env.sandbox_id, signal);
      if (!refreshed || refreshed.metadata.deletionTimestamp)
        throw new SessionError(
          'permission_denied',
          'Platform BatchSandbox disappeared or is being deleted.',
        );
      this.#validateBatch(env, refreshed);
      batch = refreshed;
      allPods = await this.#options.backend.listPods(signal);
    }
    const authorizedPod = pods[0];
    if (!authorizedPod)
      throw new SessionError('permission_denied', 'Platform owner Pod disappeared.');
    const spec = z
      .object({
        nodeName: z.string(),
        hostNetwork: z.boolean().optional(),
        hostPID: z.boolean().optional(),
        hostIPC: z.boolean().optional(),
        securityContext: z.object({
          runAsUser: z.number(),
          runAsGroup: z.number(),
          runAsNonRoot: z.boolean(),
        }),
        volumes: z.array(
          z.object({
            name: z.string(),
            hostPath: z.unknown().optional(),
            secret: z.unknown().optional(),
            projected: z.unknown().optional(),
            persistentVolumeClaim: z
              .object({ claimName: z.string(), readOnly: z.boolean().optional() })
              .optional(),
          }),
        ),
        containers: z.array(
          z.object({
            name: z.string(),
            securityContext: z.object({
              privileged: z.boolean().optional(),
              allowPrivilegeEscalation: z.boolean(),
              capabilities: z.object({
                drop: z.array(z.string()),
                add: z.array(z.string()).optional(),
              }),
            }),
            volumeMounts: z.array(
              z.object({
                name: z.string(),
                mountPath: z.string(),
                readOnly: z.boolean().optional(),
              }),
            ),
          }),
        ),
        automountServiceAccountToken: z.boolean(),
      })
      .parse(authorizedPod.spec);
    if (authorizedPod.metadata.labels?.[platformNetworkRole] !== 'tenant')
      throw new SessionError(
        'permission_denied',
        'Platform Pod is missing its enforced tenant network role.',
      );
    if (spec.automountServiceAccountToken)
      throw new SessionError(
        'permission_denied',
        'Platform workload unexpectedly mounts Kubernetes credentials.',
      );
    if (
      spec.nodeName !== this.#options.cluster.nodeName ||
      spec.hostNetwork ||
      spec.hostPID ||
      spec.hostIPC ||
      spec.securityContext.runAsUser !== 1000 ||
      spec.securityContext.runAsGroup !== 1000 ||
      !spec.securityContext.runAsNonRoot ||
      spec.containers.some(
        (container) =>
          container.securityContext.privileged ||
          container.securityContext.allowPrivilegeEscalation ||
          !container.securityContext.capabilities.drop.includes('ALL') ||
          (container.securityContext.capabilities.add?.length ?? 0) > 0,
      ) ||
      spec.volumes.some((volume) => volume.hostPath || volume.secret || volume.projected)
    )
      throw new SessionError(
        'permission_denied',
        'Platform workload contains an unexpected node or management volume.',
      );
    const daemon = spec.containers.find((container) => container.name === 'sandbox');
    if (!daemon)
      throw new SessionError('permission_denied', 'Platform foreground container is missing.');
    for (const kind of ['workspace', 'home', 'identity'] as const) {
      const claim = platformClaimName(this.#options.deploymentId, input.envId, kind);
      const volume = spec.volumes.find(
        (volume) => volume.persistentVolumeClaim?.claimName === claim,
      );
      const mountPath =
        kind === 'workspace'
          ? '/workspace'
          : kind === 'home'
            ? '/home/agent'
            : '/var/lib/kairos-identity';
      if (
        !volume ||
        volume.persistentVolumeClaim?.readOnly ||
        !daemon.volumeMounts.some(
          (mount) => mount.name === volume.name && mount.mountPath === mountPath && !mount.readOnly,
        )
      )
        throw new SessionError('permission_denied', 'Platform Pod PVC ownership does not match.');
    }
    const program = spec.volumes.find(
      (volume) => volume.persistentVolumeClaim?.claimName === this.#options.sharedReleaseClaim,
    );
    if (
      !this.#options.sharedReleaseClaim ||
      !program ||
      !daemon.volumeMounts.some(
        (mount) =>
          mount.name === program.name &&
          mount.mountPath === '/opt/kairos-program' &&
          mount.readOnly,
      )
    )
      throw new SessionError(
        'permission_denied',
        'The configured shared program PVC is not mounted read-only.',
      );
    const expectedClaims = new Set([
      ...(['workspace', 'home', 'identity'] as const).map((kind) =>
        platformClaimName(this.#options.deploymentId, input.envId, kind),
      ),
      this.#options.sharedReleaseClaim,
    ]);
    if (
      spec.volumes.some(
        (volume) =>
          volume.persistentVolumeClaim &&
          !expectedClaims.has(volume.persistentVolumeClaim.claimName),
      )
    )
      throw new SessionError('permission_denied', 'Platform Pod includes another environment PVC.');
    let previousInstanceGone = false;
    if (env.pod_uid && env.pod_uid !== input.podUid) {
      if (
        pods.some((pod) => pod.metadata.uid === env.pod_uid) ||
        !env.leaf_json ||
        !(await this.#options.physicalObserver.exited(
          physicalEvidenceSchema.parse(JSON.parse(env.leaf_json)),
        ))
      )
        throw new SessionError(
          'permission_denied',
          'The previous platform runtime has not physically exited.',
        );
      previousInstanceGone = true;
    }
    signal.throwIfAborted();
    if (reconnectingPause) {
      const previous = physicalEvidenceSchema.parse(JSON.parse(env.leaf_json ?? 'null'));
      const current = await this.#options.physicalObserver.observe(input.podUid);
      if (
        previous.podUid !== input.podUid ||
        !current ||
        previous.path !== current.path ||
        previous.inode !== current.inode ||
        previous.device !== current.device ||
        JSON.stringify(previous.scope) !== JSON.stringify(current.scope) ||
        (await this.#options.physicalObserver.exited(previous))
      )
        throw new SessionError(
          'permission_denied',
          'The recorded pausing Pod physical scope changed or exited.',
        );
      signal.throwIfAborted();
    }
    this.control.bindRuntime(
      input.envId,
      { uid: input.podUid, name: input.podName, batchUid: batch.metadata.uid },
      input.instanceId,
      env.runtime_version,
      reconnectingPause ? (env.current_operation_id ?? undefined) : undefined,
    );
    if (!reconnectingPause) this.#schedule(input.envId);
    return { runtimeVersion: env.runtime_version, previousInstanceGone };
  }
  async #recoverUses(startup = false): Promise<void> {
    const local = this.database
      .prepare('SELECT env_id,usage_id,tenant_id,kind,status FROM platform_usage_intents')
      .all()
      .map((row) =>
        z
          .object({
            env_id: z.string(),
            usage_id: z.string(),
            tenant_id: z.string(),
            kind: z.enum(['run', 'operation', 'reload']),
            status: z.enum(['prepared', 'reserved', 'released']),
          })
          .parse(row),
      );
    const controlled = this.control.uses();
    const uses = new Map(controlled.map((use) => [`${use.envId}\0${use.usageId}`, use]));
    for (const intent of local)
      if (intent.status !== 'released')
        uses.set(`${intent.env_id}\0${intent.usage_id}`, {
          tenantId: intent.tenant_id,
          envId: intent.env_id,
          usageId: intent.usage_id,
          kind: intent.kind,
        });
    for (const input of uses.values()) {
      const intent = local.find(
        (row) => row.env_id === input.envId && row.usage_id === input.usageId,
      );
      let released = intent?.status === 'released';
      if (input.kind === 'run') {
        const identity = /^run:([^:]+):([1-9][0-9]*)$/.exec(input.usageId);
        if (identity) {
          const run = this.database
            .prepare('SELECT owner_id,status,execution_generation FROM runs WHERE run_id=?')
            .get(identity[1] ?? '');
          released ||=
            !!run &&
            run.owner_id === input.tenantId &&
            (run.execution_generation !== Number(identity[2]) ||
              ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(run.status)));
        }
      } else if (input.kind === 'reload') {
        const prefix = `reload:${input.tenantId}:`;
        if (input.usageId.startsWith(prefix)) {
          const action = this.database
            .prepare(
              'SELECT method,response_json FROM client_actions WHERE owner_id=? AND client_action_id=?',
            )
            .get(input.tenantId, input.usageId.slice(prefix.length));
          if (
            action?.method === 'ReloadEnvironmentResources' &&
            typeof action.response_json === 'string'
          ) {
            const status = z
              .object({ status: z.string() })
              .parse(JSON.parse(action.response_json)).status;
            released ||= ['completed', 'failed', 'interrupted'].includes(status);
          }
        }
      } else if (input.kind === 'operation' && input.usageId.startsWith('operation:')) {
        const operation = this.database
          .prepare(
            'SELECT status,target_instance_id,result_source,result_recorded_at,output_complete,post_processed_at FROM environment_operations WHERE operation_id=? AND tenant_id=?',
          )
          .get(input.usageId.slice('operation:'.length), input.tenantId);
        if (!operation && startup && intent) released = true;
        if (operation?.result_recorded_at && operation.post_processed_at) {
          if (operation.result_source === 'device' && operation.output_complete === 1)
            released = true;
          else if (operation.result_source === 'recovery') {
            const env = this.control.get(input.envId);
            const observations = [];
            if (env && env.instance_id === operation.target_instance_id && env.leaf_json)
              observations.push(physicalEvidenceSchema.parse(JSON.parse(env.leaf_json)));
            for (const raw of [env?.snapshot_json, env?.previous_snapshot_json])
              if (raw) {
                const snapshot = snapshotEvidenceSchema.parse(JSON.parse(raw));
                if (snapshot.sourceInstanceId === operation.target_instance_id)
                  observations.push(snapshot.sourcePhysical);
              }
            for (const evidence of observations)
              if (await this.#options.physicalObserver.exited(evidence)) released = true;
          }
        }
      }
      if (released) {
        this.control.release(input);
        if (intent)
          this.database
            .prepare(
              "UPDATE platform_usage_intents SET status='released',updated_at=? WHERE env_id=? AND usage_id=?",
            )
            .run(this.#now().toISOString(), input.envId, input.usageId);
        this.#sync(input.envId);
        this.#schedule(input.envId);
      } else if (
        startup &&
        intent?.status === 'reserved' &&
        !controlled.some((use) => use.envId === input.envId && use.usageId === input.usageId)
      ) {
        // A local accepted reference cannot silently disappear from the shared authority.
        this.control.reserve(input);
      }
    }
    // Idle deadlines are durable; this sweep also covers startup with no remaining uses.
    for (const env of this.control.list()) {
      if (env.state === 'running' && this.control.useCount(env.env_id) === 0)
        this.#schedule(env.env_id);
    }
  }
}
