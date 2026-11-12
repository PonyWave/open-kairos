import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { DelegationKey } from '../context/types.js';
import {
  ensureMainEnvironment,
  type MainEnvironmentConfiguration,
  mainEnvironmentIdFor,
} from '../devices/main-environment.js';
import type { WorkspaceResourceSnapshot } from '../workspace/index.js';
import { requireText, SessionError } from './errors.js';
import type { RunRecord } from './records.js';

export interface EnvironmentPolicyInput {
  allowedEnv: readonly string[];
}

export interface AgentEnvironmentBinding {
  historyId: string;
  threadId: string;
  agentId: string;
  envId: string;
  pwd: string;
  bindingVersion: number;
  resourceVersion: string | null;
  resources: WorkspaceResourceSnapshot | null;
}

export interface UnboundAgentEnvironmentBinding {
  historyId: string;
  threadId: string;
  agentId: string;
  envId: null;
  pwd: null;
  bindingVersion: number;
  resourceVersion: null;
  resources: null;
}

export type AgentEnvironmentBindingState = AgentEnvironmentBinding | UnboundAgentEnvironmentBinding;

interface AgentEnvironmentPolicyBase {
  threadId: string;
  agentId: string;
  allowedEnv: readonly string[] | null;
  defaultEnv: string | null;
  defaultPwd: string | null;
  policyVersion: number;
  currentHistoryId: string;
  bindingVersion: number;
  delegation: DelegationKey | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentEnvironmentPolicy extends AgentEnvironmentPolicyBase {
  current: AgentEnvironmentBinding;
}

export interface UnboundAgentEnvironmentPolicy extends AgentEnvironmentPolicyBase {
  current: null;
}

export type AgentEnvironmentPolicyState = AgentEnvironmentPolicy | UnboundAgentEnvironmentPolicy;

export type ExplicitAgentEnvironmentPolicy = AgentEnvironmentPolicy & EnvironmentPolicyInput;

export function isExplicitEnvironmentPolicy(
  policy: AgentEnvironmentPolicyState,
): policy is ExplicitAgentEnvironmentPolicy {
  return (
    policy.current !== null &&
    policy.allowedEnv !== null &&
    policy.defaultEnv !== null &&
    policy.defaultPwd !== null
  );
}

export interface AgentExecutionEnvironment extends EnvironmentPolicyInput {
  defaultEnv: string;
  defaultPwd: string;
  runId: string;
  generation: number;
  ownerId: string;
  threadId: string;
  agentId: string;
  historyId: string;
  resourceVersion: string | null;
}

export interface AgentEnvironmentOperation {
  operationId: string;
  threadId: string;
  agentId: string;
  runId: string;
  toolCallId: string;
  historyId: string;
  envId: string;
  bindingVersion: number;
  action: 'read' | 'read_image' | 'write' | 'edit' | 'bash' | 'directory_check' | 'env_switch';
  resultContent: string | null;
  resultStatus: 'success' | 'error' | null;
}

const resourceSnapshotSchema = z.object({
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  systemInstructions: z.string(),
  resources: z.array(
    z.object({
      path: z.string().min(1),
      content: z.string(),
    }),
  ),
});

const policyRowSchema = z.object({
  thread_id: z.string(),
  agent_id: z.string(),
  allowed_env_json: z.string().nullable(),
  default_env: z.string().nullable(),
  default_pwd: z.string().nullable(),
  policy_version: z.number().int().positive(),
  current_history_id: z.string(),
  current_env: z.string().nullable(),
  current_pwd: z.string().nullable(),
  current_binding_version: z.number().int().nonnegative(),
  current_resource_version: z.string().nullable(),
  source_thread_id: z.string().nullable(),
  source_agent_id: z.string().nullable(),
  source_tool_call_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const historyRowSchema = z.object({
  history_id: z.string(),
  thread_id: z.string(),
  agent_id: z.string(),
  binding_version: z.number().int().nonnegative(),
  env_id: z.string().nullable(),
  pwd: z.string().nullable(),
  resource_version: z.string().nullable(),
  resources_json: z.string().nullable(),
  reason: z.enum(['initial', 'switch', 'reload', 'rerun']),
  restored_from_history_id: z.string().nullable(),
  created_at: z.string(),
});

const operationRowSchema = z.object({
  operation_id: z.string(),
  thread_id: z.string(),
  agent_id: z.string(),
  run_id: z.string(),
  tool_call_id: z.string(),
  history_id: z.string(),
  env_id: z.string(),
  binding_version: z.number().int().nonnegative(),
  action: z.enum(['read', 'read_image', 'write', 'edit', 'bash', 'directory_check', 'env_switch']),
  result_content: z.string().nullable(),
  result_status: z.enum(['success', 'error']).nullable(),
});

export interface CommitEnvironmentResourcesInput {
  runId?: string;
  threadId?: string;
  agentId?: string;
  operationId?: string;
  expectedHistoryId: string;
  envId: string;
  pwd: string;
  snapshot: WorkspaceResourceSnapshot;
  reason: 'initial' | 'reload';
  resultContent: string;
  deviceBindingId: string;
  instanceId: string;
}

export class AgentEnvironmentStore {
  readonly #createId: () => string;
  readonly #now: () => Date;
  readonly #mainEnvironment: MainEnvironmentConfiguration;

  constructor(
    readonly database: DatabaseSync,
    options: {
      createId?: () => string;
      now?: () => Date;
      mainEnvironment?: MainEnvironmentConfiguration;
    } = {},
  ) {
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#mainEnvironment = options.mainEnvironment ?? {
      envId: 'main',
      workspace: '/workspace',
    };
  }

  get mainEnvironment(): MainEnvironmentConfiguration {
    return this.#mainEnvironment;
  }

  mainEnvironmentIdFor(ownerId: string): string {
    return mainEnvironmentIdFor(this.database, this.#mainEnvironment, ownerId);
  }

  isMainEnvironment(envId: string, pwd: string, ownerId?: string): boolean {
    if (this.#mainEnvironment.workspace !== pwd) return false;
    if (ownerId !== undefined) return envId === this.mainEnvironmentIdFor(ownerId);
    return envId === this.#mainEnvironment.envId;
  }

  createPolicy(input: {
    ownerId: string;
    threadId: string;
    agentId: string;
    policy?: EnvironmentPolicyInput | undefined;
    parentRun?: RunRecord | undefined;
    delegation?: DelegationKey | undefined;
  }): AgentEnvironmentPolicyState {
    const parent = input.parentRun ? this.captureExecution(input.parentRun) : undefined;
    const policy = this.#normalizePolicy(input.ownerId, input.policy, parent);
    if (this.getPolicy(input.threadId, input.agentId)) {
      throw new SessionError('action_conflict', 'The Agent environment policy already exists.');
    }
    const now = this.#now().toISOString();
    const historyId = this.#createId();
    const bindingVersion = 1;
    const inheritedResources =
      parent?.defaultEnv === policy.defaultEnv && parent.defaultPwd === policy.defaultPwd
        ? this.requireHistory(parent.historyId).resources
        : null;
    this.database
      .prepare(
        `INSERT INTO agent_environment_binding_history(
          history_id, thread_id, agent_id, binding_version, env_id, pwd, reason, created_at, resource_version, resources_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'initial', ?, ?, ?)`,
      )
      .run(
        historyId,
        input.threadId,
        input.agentId,
        bindingVersion,
        policy.defaultEnv,
        policy.defaultPwd,
        now,
        inheritedResources?.snapshotId ?? null,
        inheritedResources ? JSON.stringify(inheritedResources) : null,
      );
    this.database
      .prepare(
        `INSERT INTO agent_environment_policies(
          thread_id, agent_id, allowed_env_json, default_env, default_pwd, policy_version,
          current_history_id, current_env, current_pwd, current_binding_version,
          current_resource_version, source_thread_id, source_agent_id, source_tool_call_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.threadId,
        input.agentId,
        policy.allowedEnv === null ? null : JSON.stringify(policy.allowedEnv),
        policy.defaultEnv,
        policy.defaultPwd,
        historyId,
        policy.defaultEnv,
        policy.defaultPwd,
        bindingVersion,
        inheritedResources?.snapshotId ?? null,
        input.delegation?.sourceThreadId ?? null,
        input.delegation?.sourceAgentId ?? null,
        input.delegation?.sourceToolCallId ?? null,
        now,
        now,
      );
    return this.requirePolicyState(input.threadId, input.agentId);
  }

  getPolicy(threadId: string, agentId: string): AgentEnvironmentPolicyState | undefined {
    const row = this.database
      .prepare('SELECT * FROM agent_environment_policies WHERE thread_id = ? AND agent_id = ?')
      .get(threadId, agentId);
    if (row === undefined) return undefined;
    const parsed = policyRowSchema.parse(row);
    const current = this.requireHistory(parsed.current_history_id);
    if (
      current.threadId !== threadId ||
      current.agentId !== agentId ||
      current.bindingVersion !== parsed.current_binding_version ||
      current.envId !== parsed.current_env ||
      current.pwd !== parsed.current_pwd ||
      current.resourceVersion !== parsed.current_resource_version
    ) {
      throw new SessionError('internal', 'The current Agent environment binding is inconsistent.');
    }
    const base = {
      threadId,
      agentId,
      allowedEnv:
        parsed.allowed_env_json === null
          ? null
          : z.array(z.string()).parse(JSON.parse(parsed.allowed_env_json)),
      defaultEnv: parsed.default_env,
      defaultPwd: parsed.default_pwd,
      policyVersion: parsed.policy_version,
      currentHistoryId: parsed.current_history_id,
      bindingVersion: parsed.current_binding_version,
      delegation:
        parsed.source_tool_call_id === null
          ? null
          : {
              sourceThreadId: parsed.source_thread_id ?? '',
              sourceAgentId: parsed.source_agent_id ?? '',
              sourceToolCallId: parsed.source_tool_call_id,
            },
      createdAt: parsed.created_at,
      updatedAt: parsed.updated_at,
    };
    if (current.envId === null) return { ...base, current: null };
    return { ...base, current };
  }

  requirePolicyState(threadId: string, agentId: string): AgentEnvironmentPolicyState {
    const policy = this.getPolicy(threadId, agentId);
    if (!policy) {
      throw new SessionError(
        'failed_precondition',
        'This Agent has no environment policy and cannot execute environment work.',
      );
    }
    return policy;
  }

  requirePolicy(threadId: string, agentId: string): AgentEnvironmentPolicy {
    const policy = this.requirePolicyState(threadId, agentId);
    if (policy.current === null) {
      throw new SessionError('failed_precondition', 'The Agent workspace is missing.');
    }
    return policy;
  }

  requireHistory(historyId: string): AgentEnvironmentBindingState {
    const row = this.database
      .prepare('SELECT * FROM agent_environment_binding_history WHERE history_id = ?')
      .get(historyId);
    if (row === undefined) {
      throw new SessionError('internal', 'The Agent environment binding history is missing.');
    }
    return toBindingState(historyRowSchema.parse(row));
  }

  recordMessageBinding(
    threadId: string,
    agentId: string,
    messageSeq: number,
    run?: RunRecord,
  ): void {
    const policy = this.getPolicy(threadId, agentId);
    if (!policy)
      throw new SessionError('failed_precondition', 'The Agent environment policy is missing.');
    const execution = run ? this.requireExecution(run) : undefined;
    this.database
      .prepare(
        `INSERT INTO agent_environment_message_bindings(
          thread_id, agent_id, message_seq, history_id, binding_version, resource_version
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        agentId,
        messageSeq,
        execution?.historyId ?? policy.currentHistoryId,
        execution ? this.requireHistory(execution.historyId).bindingVersion : policy.bindingVersion,
        execution?.resourceVersion ?? policy.current?.resourceVersion ?? null,
      );
  }

  recordRequestBinding(
    requestId: string,
    threadId: string,
    agentId: string,
    run?: RunRecord,
  ): void {
    const policy = this.getPolicy(threadId, agentId);
    if (!policy)
      throw new SessionError('failed_precondition', 'The Agent environment policy is missing.');
    const execution = run ? this.requireExecution(run) : undefined;
    this.database
      .prepare(
        `INSERT INTO agent_environment_requests(
          request_id, thread_id, agent_id, history_id, binding_version, resource_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET
          history_id = excluded.history_id,
          binding_version = excluded.binding_version,
          resource_version = excluded.resource_version
        WHERE agent_environment_requests.history_id = excluded.history_id`,
      )
      .run(
        requestId,
        threadId,
        agentId,
        execution?.historyId ?? policy.currentHistoryId,
        execution ? this.requireHistory(execution.historyId).bindingVersion : policy.bindingVersion,
        execution?.resourceVersion ?? policy.current?.resourceVersion ?? null,
        this.#now().toISOString(),
      );
  }

  restoreForRerun(
    threadId: string,
    agentId: string,
    messageSeq: number,
  ): AgentEnvironmentPolicyState | undefined {
    const current = this.getPolicy(threadId, agentId);
    if (!current) return undefined;
    const row = z
      .object({ history_id: z.string() })
      .optional()
      .parse(
        this.database
          .prepare(
            `SELECT history_id FROM agent_environment_message_bindings
             WHERE thread_id = ? AND agent_id = ? AND message_seq <= ?
             ORDER BY message_seq DESC LIMIT 1`,
          )
          .get(threadId, agentId, messageSeq),
      );
    if (!row) {
      throw new SessionError(
        'failed_precondition',
        'The environment binding before this message cannot be determined.',
      );
    }
    const historical = this.requireHistory(row.history_id);
    if (historical.envId !== current.defaultEnv || historical.pwd !== current.current?.pwd) {
      throw new SessionError(
        'failed_precondition',
        'The historical workspace does not match the default workspace.',
      );
    }
    if (
      historical.envId !== null &&
      (historical.resourceVersion === null || historical.resources === null)
    ) {
      throw new SessionError(
        'failed_precondition',
        'The historical environment resource version cannot be determined.',
      );
    }
    const bindingVersion = current.bindingVersion + 1;
    if (!Number.isSafeInteger(bindingVersion)) {
      throw new SessionError('version_conflict', 'The Agent binding version is exhausted.');
    }
    const now = this.#now().toISOString();
    const historyId = this.#createId();
    this.#insertHistory({
      historyId,
      threadId,
      agentId,
      bindingVersion,
      envId: historical.envId,
      pwd: historical.pwd,
      snapshot: historical.resources,
      reason: 'rerun',
      restoredFromHistoryId: historical.historyId,
      now,
    });
    this.#updateCurrent({
      threadId,
      agentId,
      historyId,
      envId: historical.envId,
      pwd: historical.pwd,
      bindingVersion,
      resourceVersion: historical.resourceVersion,
      now,
    });
    return this.requirePolicyState(threadId, agentId);
  }

  recordOperationIntent(input: {
    operationId: string;
    runId: string;
    toolCallId: string;
    policy: AgentEnvironmentPolicyState;
    envId?: string;
    action: AgentEnvironmentOperation['action'];
    generation?: number;
    resolvedAction?: unknown;
  }): void {
    const envId = input.envId ?? input.policy.current?.envId;
    if (envId === undefined) {
      throw new SessionError(
        'failed_precondition',
        'An environment target is required for this operation.',
      );
    }
    const existing = this.database
      .prepare(
        'SELECT operation_id FROM agent_environment_operations WHERE run_id = ? AND tool_call_id = ?',
      )
      .get(input.runId, input.toolCallId);
    if (existing !== undefined) {
      throw new SessionError(
        'action_conflict',
        'The tool call already has an environment operation.',
      );
    }
    const now = this.#now().toISOString();
    this.database
      .prepare(
        `INSERT INTO agent_environment_operations(
          operation_id, thread_id, agent_id, run_id, tool_call_id, history_id, env_id,
          binding_version, action, created_at, updated_at, execution_generation, resolved_action_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.operationId,
        input.policy.threadId,
        input.policy.agentId,
        input.runId,
        input.toolCallId,
        input.policy.currentHistoryId,
        envId,
        input.policy.bindingVersion,
        input.action,
        now,
        now,
        input.generation ?? null,
        input.resolvedAction === undefined ? null : JSON.stringify(input.resolvedAction),
      );
  }

  requireOperation(
    threadId: string,
    agentId: string,
    operationId: string,
  ): AgentEnvironmentOperation {
    const row = this.database
      .prepare('SELECT * FROM agent_environment_operations WHERE operation_id = ?')
      .get(operationId);
    if (row === undefined) {
      throw new SessionError('not_found', 'Environment operation output was not found.');
    }
    const operation = toOperation(operationRowSchema.parse(row));
    if (operation.threadId !== threadId || operation.agentId !== agentId) {
      throw new SessionError(
        'permission_denied',
        'Environment operation output is not available to this Agent.',
      );
    }
    return operation;
  }

  findOperation(runId: string, toolCallId: string): AgentEnvironmentOperation | undefined {
    const row = this.database
      .prepare('SELECT * FROM agent_environment_operations WHERE run_id = ? AND tool_call_id = ?')
      .get(runId, toolCallId);
    return row === undefined ? undefined : toOperation(operationRowSchema.parse(row));
  }

  discardOperationIntent(input: { operationId: string; runId: string; toolCallId: string }): void {
    const deleted = this.database
      .prepare(
        `DELETE FROM agent_environment_operations
         WHERE operation_id = ? AND run_id = ? AND tool_call_id = ?
           AND result_content IS NULL AND result_status IS NULL`,
      )
      .run(input.operationId, input.runId, input.toolCallId);
    if (deleted.changes !== 1) {
      throw new SessionError('internal', 'The unstarted Agent environment operation is missing.');
    }
  }

  findLatestOperation(
    runId: string,
    toolCallIdPrefix: string,
  ): AgentEnvironmentOperation | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM agent_environment_operations
         WHERE run_id = ? AND tool_call_id GLOB ?
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(runId, `${toolCallIdPrefix}*`);
    return row === undefined ? undefined : toOperation(operationRowSchema.parse(row));
  }

  savedResult(
    runId: string,
    toolCallId: string,
  ): { content: string; status: 'success' | 'error' } | undefined {
    const row = z
      .object({
        result_content: z.string().nullable(),
        result_status: z.enum(['success', 'error']).nullable(),
      })
      .optional()
      .parse(
        this.database
          .prepare(
            'SELECT result_content, result_status FROM agent_environment_operations WHERE run_id = ? AND tool_call_id = ?',
          )
          .get(runId, toolCallId),
      );
    if (!row || row.result_content === null || row.result_status === null) return undefined;
    return { content: row.result_content, status: row.result_status };
  }

  recordOperationResult(operationId: string, content: string, status: 'success' | 'error'): void {
    const updated = this.database
      .prepare(
        `UPDATE agent_environment_operations SET result_content = ?, result_status = ?, updated_at = ?
         WHERE operation_id = ?`,
      )
      .run(content, status, this.#now().toISOString(), operationId);
    if (updated.changes !== 1) {
      throw new SessionError('internal', 'The Agent environment operation is missing.');
    }
  }

  commitResources(input: CommitEnvironmentResourcesInput): AgentEnvironmentPolicy {
    const run =
      input.runId === undefined
        ? { thread_id: input.threadId ?? '', agent_id: input.agentId ?? '', status: 'idle' }
        : z
            .object({ thread_id: z.string(), agent_id: z.string(), status: z.string() })
            .parse(
              this.database
                .prepare('SELECT thread_id,agent_id,status FROM runs WHERE run_id = ?')
                .get(input.runId),
            );
    if (input.runId === undefined && input.reason !== 'reload')
      throw new SessionError('internal', 'Only resource reload may commit without a Run.');
    if (
      input.reason === 'reload'
        ? run.status === 'cancel_requested'
        : ['cancel_requested', 'cancelled', 'failed', 'interrupted', 'completed'].includes(
            run.status,
          )
    ) {
      throw new SessionError(
        'cancelled' === run.status ? 'operation_unknown' : 'version_conflict',
        'The Run changed before the environment binding could be committed.',
      );
    }
    const policy = this.requirePolicyState(run.thread_id, run.agent_id);
    if (policy.currentHistoryId !== input.expectedHistoryId) {
      throw new SessionError(
        'version_conflict',
        'The Agent environment binding changed during the directory check.',
      );
    }
    if (input.reason === 'initial') {
      if (!policy.current) {
        throw new SessionError(
          'internal',
          'The initial environment check requires an initial binding.',
        );
      }
      if (policy.current.resourceVersion !== null) {
        throw new SessionError(
          'version_conflict',
          'The initial environment resources were already committed.',
        );
      }
    }
    const environment = z
      .object({
        binding_status: z.string(),
        connection_status: z.string(),
        capability_status: z.string(),
        directory_status: z.string(),
        maintenance_mode: z.string(),
        device_binding_id: z.string().nullable(),
        instance_id: z.string().nullable(),
      })
      .parse(
        this.database
          .prepare(
            `SELECT binding_status, connection_status, capability_status, directory_status,
                    maintenance_mode, device_binding_id, instance_id
             FROM environments WHERE env_id = ?`,
          )
          .get(input.envId),
      );
    if (
      environment.binding_status !== 'active' ||
      environment.connection_status !== 'online' ||
      environment.capability_status !== 'ready' ||
      environment.directory_status !== 'ready' ||
      (input.reason !== 'reload' && environment.maintenance_mode !== 'normal') ||
      environment.device_binding_id !== input.deviceBindingId ||
      environment.instance_id !== input.instanceId
    ) {
      throw new SessionError(
        'version_conflict',
        'The environment authorization, readiness or instance changed during the directory check.',
      );
    }
    if (policy.current?.envId !== input.envId) {
      throw new SessionError(
        'version_conflict',
        'The default workspace changed during the directory check.',
      );
    }
    const bindingVersion = policy.bindingVersion;
    if (!Number.isSafeInteger(bindingVersion)) {
      throw new SessionError('version_conflict', 'The Agent binding version is exhausted.');
    }
    const now = this.#now().toISOString();
    const historyId = this.#createId();
    this.#insertHistory({
      historyId,
      threadId: policy.threadId,
      agentId: policy.agentId,
      bindingVersion,
      envId: input.envId,
      pwd: input.pwd,
      snapshot: input.snapshot,
      reason: input.reason,
      now,
    });
    this.#updateCurrent({
      threadId: policy.threadId,
      agentId: policy.agentId,
      historyId,
      envId: input.envId,
      pwd: input.pwd,
      bindingVersion,
      resourceVersion: input.snapshot.snapshotId,
      now,
    });
    if (input.operationId !== undefined)
      this.recordOperationResult(input.operationId, input.resultContent, 'success');
    return this.requirePolicy(policy.threadId, policy.agentId);
  }

  #normalizePolicy(
    ownerId: string,
    requested: EnvironmentPolicyInput | undefined,
    parent: { allowedEnv: readonly string[] | null } | undefined,
  ): { allowedEnv: readonly string[] | null; defaultEnv: string; defaultPwd: string } {
    ensureMainEnvironment(this.database, ownerId, this.#mainEnvironment, this.#now());
    const defaultEnv = this.mainEnvironmentIdFor(ownerId);
    const defaultPwd = this.#mainEnvironment.workspace;
    const requestedScope = requested?.allowedEnv ?? parent?.allowedEnv ?? null;
    if (
      requested !== undefined &&
      (requested.allowedEnv.length === 0 ||
        requested.allowedEnv.length > 32 ||
        new Set(requested.allowedEnv).size !== requested.allowedEnv.length)
    ) {
      throw new SessionError(
        'invalid_argument',
        'allowed_env must contain between 1 and 32 distinct environments.',
      );
    }
    for (const envId of requestedScope ?? []) {
      requireText(envId, 'allowed_env', 200);
      if (parent?.allowedEnv && envId !== defaultEnv && !parent.allowedEnv.includes(envId)) {
        throw new SessionError(
          'permission_denied',
          'A child Agent cannot expand its parent environment authorization.',
        );
      }
      if (envId !== defaultEnv && !this.#isActive(ownerId, envId)) {
        throw new SessionError(
          'permission_denied',
          'allowed_env contains an environment that is not active for this tenant.',
        );
      }
    }
    const allowedEnv =
      requestedScope === null ? null : [...new Set([defaultEnv, ...requestedScope])];
    if (requested !== undefined && allowedEnv !== null && allowedEnv.length > 32)
      throw new SessionError(
        'invalid_argument',
        'allowed_env together with the required main environment may contain at most 32 distinct environments.',
      );
    return { allowedEnv, defaultEnv, defaultPwd };
  }

  captureExecution(run: RunRecord): AgentExecutionEnvironment {
    const existing = this.getExecution(run.runId, run.generation);
    if (existing) return existing;
    const policy = this.requirePolicy(run.threadId, run.agentId);
    if (!policy.defaultEnv || !policy.defaultPwd) {
      throw new SessionError('failed_precondition', 'The Agent workspace is missing.');
    }
    const allowedEnv = this.database
      .prepare(
        "SELECT env_id FROM environments WHERE tenant_id = ? AND binding_status = 'active' ORDER BY env_id",
      )
      .all(run.ownerId)
      .map((row) => z.object({ env_id: z.string() }).parse(row).env_id)
      .filter((id) => policy.allowedEnv === null || policy.allowedEnv.includes(id));
    if (!allowedEnv.includes(policy.defaultEnv)) {
      allowedEnv.push(policy.defaultEnv);
    }
    this.database
      .prepare(`INSERT INTO agent_execution_environments(
      run_id,generation,owner_id,thread_id,agent_id,default_env,default_pwd,allowed_env_json,history_id,resource_version,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        run.runId,
        run.generation,
        run.ownerId,
        run.threadId,
        run.agentId,
        policy.defaultEnv,
        policy.defaultPwd,
        JSON.stringify(allowedEnv),
        policy.currentHistoryId,
        policy.current.resourceVersion,
        this.#now().toISOString(),
      );
    return this.requireExecution(run);
  }

  getExecution(runId: string, generation: number): AgentExecutionEnvironment | undefined {
    const raw = this.database
      .prepare('SELECT * FROM agent_execution_environments WHERE run_id = ? AND generation = ?')
      .get(runId, generation);
    if (!raw) return undefined;
    const row = z
      .object({
        run_id: z.string(),
        generation: z.number(),
        owner_id: z.string(),
        thread_id: z.string(),
        agent_id: z.string(),
        default_env: z.string(),
        default_pwd: z.string(),
        allowed_env_json: z.string(),
        history_id: z.string(),
        resource_version: z.string().nullable(),
      })
      .parse(raw);
    return {
      runId: row.run_id,
      generation: row.generation,
      ownerId: row.owner_id,
      threadId: row.thread_id,
      agentId: row.agent_id,
      defaultEnv: row.default_env,
      defaultPwd: row.default_pwd,
      allowedEnv: z.array(z.string()).parse(JSON.parse(row.allowed_env_json)),
      historyId: row.history_id,
      resourceVersion: row.resource_version,
    };
  }

  requireExecution(run: Pick<RunRecord, 'runId' | 'generation'>): AgentExecutionEnvironment {
    const execution = this.getExecution(run.runId, run.generation);
    if (!execution)
      throw new SessionError(
        'failed_precondition',
        'The execution environment specification is missing.',
      );
    return execution;
  }

  bindExecutionResources(run: RunRecord, policy: AgentEnvironmentPolicy): void {
    const updated = this.database
      .prepare(`UPDATE agent_execution_environments SET history_id = ?, resource_version = ?
      WHERE run_id = ? AND generation = ? AND default_env = ? AND default_pwd = ? AND resource_version IS NULL`)
      .run(
        policy.currentHistoryId,
        policy.current.resourceVersion,
        run.runId,
        run.generation,
        policy.defaultEnv,
        policy.defaultPwd,
      );
    if (updated.changes !== 1)
      throw new SessionError(
        'version_conflict',
        'Execution resources were already fixed or its default directory changed.',
      );
  }

  #isActive(ownerId: string, envId: string): boolean {
    return (
      this.database
        .prepare(
          "SELECT 1 AS present FROM environments WHERE tenant_id = ? AND env_id = ? AND binding_status = 'active'",
        )
        .get(ownerId, envId) !== undefined
    );
  }

  #insertHistory(input: {
    historyId: string;
    threadId: string;
    agentId: string;
    bindingVersion: number;
    envId: string | null;
    pwd: string | null;
    snapshot: WorkspaceResourceSnapshot | null;
    reason: 'initial' | 'switch' | 'reload' | 'rerun';
    restoredFromHistoryId?: string;
    now: string;
  }): void {
    if (
      (input.envId === null) !== (input.pwd === null) ||
      (input.envId === null) === (input.snapshot !== null)
    ) {
      throw new SessionError('internal', 'The Agent environment binding state is inconsistent.');
    }
    const snapshot = input.snapshot === null ? null : resourceSnapshotSchema.parse(input.snapshot);
    this.database
      .prepare(
        `INSERT INTO agent_environment_binding_history(
          history_id, thread_id, agent_id, binding_version, env_id, pwd, resource_version,
          resources_json, reason, restored_from_history_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.historyId,
        input.threadId,
        input.agentId,
        input.bindingVersion,
        input.envId,
        input.pwd,
        snapshot?.snapshotId ?? null,
        snapshot === null ? null : JSON.stringify(snapshot),
        input.reason,
        input.restoredFromHistoryId ?? null,
        input.now,
      );
  }

  #updateCurrent(input: {
    threadId: string;
    agentId: string;
    historyId: string;
    envId: string | null;
    pwd: string | null;
    bindingVersion: number;
    resourceVersion: string | null;
    now: string;
  }): void {
    const updated = this.database
      .prepare(
        `UPDATE agent_environment_policies SET
          current_history_id = ?, current_env = ?, current_pwd = ?,
          current_binding_version = ?, current_resource_version = ?, updated_at = ?
         WHERE thread_id = ? AND agent_id = ?`,
      )
      .run(
        input.historyId,
        input.envId,
        input.pwd,
        input.bindingVersion,
        input.resourceVersion,
        input.now,
        input.threadId,
        input.agentId,
      );
    if (updated.changes !== 1) {
      throw new SessionError('internal', 'The Agent environment policy is missing.');
    }
  }
}

function toBindingState(row: z.infer<typeof historyRowSchema>): AgentEnvironmentBindingState {
  const base = {
    historyId: row.history_id,
    threadId: row.thread_id,
    agentId: row.agent_id,
    bindingVersion: row.binding_version,
  };
  const resources =
    row.resources_json === null
      ? null
      : resourceSnapshotSchema.parse(JSON.parse(row.resources_json));
  if (row.env_id === null || row.pwd === null) {
    if (
      row.env_id !== null ||
      row.pwd !== null ||
      row.resource_version !== null ||
      resources !== null
    ) {
      throw new SessionError('internal', 'The unbound environment history is inconsistent.');
    }
    return { ...base, envId: null, pwd: null, resourceVersion: null, resources: null };
  }
  return {
    ...base,
    envId: row.env_id,
    pwd: row.pwd,
    bindingVersion: row.binding_version,
    resourceVersion: row.resource_version,
    resources,
  };
}

function toOperation(row: z.infer<typeof operationRowSchema>): AgentEnvironmentOperation {
  return {
    operationId: row.operation_id,
    threadId: row.thread_id,
    agentId: row.agent_id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    historyId: row.history_id,
    envId: row.env_id,
    bindingVersion: row.binding_version,
    action: row.action,
    resultContent: row.result_content,
    resultStatus: row.result_status,
  };
}
