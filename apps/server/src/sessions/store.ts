import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  type AttachmentMetadata,
  AttachmentStore,
  attachmentMetadataSchema,
} from '../attachments/index.js';
import {
  channelJsonText,
  channelReferenceSchema,
  parseChannelJson,
} from '../channels/reference.js';
import { ContextStore } from '../context/context-store.js';
import {
  modelExecutionModeEventId,
  modelResponseModeEventId,
  readSendToUserMode,
  requestUsesSendToUser,
} from '../context/output-mode.js';
import {
  type AutomationReference,
  type ChannelReference,
  type Clock,
  type ContextMessage,
  type DelegationKey,
  isoTime,
  systemClock,
} from '../context/types.js';
import type { DeviceRecord } from '../devices/device-store.js';
import { DeviceStore } from '../devices/device-store.js';
import type { EnvironmentRecord } from '../devices/environment-store.js';
import type { MainEnvironmentConfiguration } from '../devices/main-environment.js';
import { RecapStore } from '../recap/recap-store.js';
import type { Recap } from '../recap/types.js';
import { migrateDatabase } from '../storage/migrations.js';
import { assertServerDatabaseCompatible } from '../storage/server-schema.js';
import { inTransaction } from '../storage/transaction.js';
import { deleteArchivedThreadRecords, deleteWorkspaceRecords } from './delete-workspace.js';
import {
  AgentEnvironmentStore,
  type EnvironmentPolicyInput,
  isExplicitEnvironmentPolicy,
} from './environment-policies.js';
import { requireText, SessionError } from './errors.js';
import { sessionMigrations } from './migrations.js';
import type {
  BackgroundTaskKind,
  BackgroundTaskRecord,
  BackgroundTaskStatus,
  InputMode,
  InputRecord,
  InteractionDeliveryRecord,
  InteractionRecord,
  MessageRevisionRecord,
  MessageSource,
  RunError,
  RunExecutionMode,
  RunRecord,
  RunStatus,
  ServerBashOperationRecord,
  StreamDeltaRecord,
  TextDeltaRecord,
  ThreadEventPayload,
  ThreadEventRecord,
  ThreadNotificationRecord,
  ThreadRecord,
  ToolProgressRecord,
  WorkspaceRecord,
} from './records.js';
import { threadNotificationDeliveryText } from './thread-notifications.js';

const maxBufferedStreamDeltaTextLength = 256 * 1024;

const messageSourceSchema = z.enum([
  'user',
  'thread_call',
  'thread_response',
  'subagent_response',
  'automation',
  'thread_notification',
  'channel',
]);
const automationReferenceSchema = z.object({
  scheduleId: z.string(),
  fireId: z.string(),
  trigger: z.enum(['scheduled', 'run_now']),
  scheduledAt: z.string(),
});
const delegationKeySchema = z.object({
  sourceThreadId: z.string(),
  sourceAgentId: z.string(),
  sourceToolCallId: z.string(),
});
const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'cancel_requested',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
const runErrorSchema = z.object({
  code: z.enum([
    'unauthenticated',
    'permission_denied',
    'version_conflict',
    'action_conflict',
    'device_offline',
    'operation_unknown',
    'recap_invalid',
    'input_too_large',
    'protocol_incompatible',
    'invalid_argument',
    'not_found',
    'failed_precondition',
    'internal',
  ]),
  message: z.string(),
  retryable: z.boolean(),
});
const threadRowSchema = z.object({
  seq: z.number().int().positive(),
  thread_id: z.string(),
  owner_id: z.string(),
  title: z.string(),
  thread_type: z.enum(['main', 'workspace_main', 'task']),
  workspace_id: z.string().nullable(),
  automation_only: z.number().int().min(0).max(1),
  archived_at: z.string().nullable(),
  reset_from_thread_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const workspaceRowSchema = z.object({
  description: z.string(),
  hidden: z.number().int().min(0).max(1),
  workspace_id: z.string(),
  tenant_id: z.string(),
  name: z.string(),
  env_id: z.string(),
  path: z.string(),
  created_at: z.string(),
});
const inputRowSchema = z.object({
  input_id: z.string(),
  thread_id: z.string(),
  owner_id: z.string(),
  text: z.string(),
  mode: z.enum(['follow_up', 'steer']),
  status: z.enum(['queued', 'consumed', 'cancelled']),
  position: z.number().int().positive(),
  version: z.number().int().positive(),
  consumed_run_id: z.string().nullable(),
  source: messageSourceSchema,
  delegation_source_thread_id: z.string().nullable(),
  delegation_source_agent_id: z.string().nullable(),
  source_tool_call_id: z.string().nullable(),
  source_thread_id: z.string().nullable(),
  source_agent_id: z.string().nullable(),
  automation_schedule_id: z.string().nullable(),
  automation_fire_id: z.string().nullable(),
  automation_trigger: z.enum(['scheduled', 'run_now']).nullable(),
  automation_scheduled_at: z.string().nullable(),
  channel_json: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const runRowSchema = z.object({
  run_id: z.string(),
  thread_id: z.string(),
  owner_id: z.string(),
  agent_id: z.string(),
  status: runStatusSchema,
  execution_mode: z.enum(['foreground', 'background']),
  input_ids_json: z.string(),
  parent_run_id: z.string().nullable(),
  rerun_from_message_seq: z.number().int().positive().nullable(),
  superseded_by_run_id: z.string().nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  error_retryable: z.number().int().min(0).max(1).nullable(),
  usage_input_tokens: z.number().int().nonnegative(),
  usage_output_tokens: z.number().int().nonnegative(),
  usage_reported: z.number().int().min(0).max(1),
  current_request_id: z.string().nullable(),
  execution_generation: z.number().int().positive(),
  cancel_accepted_generation: z.number().int().positive().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});
const interactionRowSchema = z.object({
  owner_id: z.string(),
  kind: z.enum(['thread_call', 'subagent']),
  execution_mode: z.enum(['foreground', 'background']),
  source_thread_id: z.string(),
  source_agent_id: z.string(),
  source_run_id: z.string(),
  source_tool_call_id: z.string(),
  request_fingerprint: z.string(),
  prompt: z.string(),
  target_thread_id: z.string(),
  target_agent_id: z.string(),
  reply_thread_id: z.string(),
  target_input_id: z.string().nullable(),
  accepted_run_id: z.string().nullable(),
  consumed_run_id: z.string().nullable(),
  status: runStatusSchema,
  response_message_seq: z.number().int().positive().nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  error_retryable: z.number().int().min(0).max(1).nullable(),
  cancel_requested_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable(),
});
const deliveryRowSchema = z.object({
  source_thread_id: z.string(),
  source_agent_id: z.string(),
  source_tool_call_id: z.string(),
  owner_id: z.string(),
  reply_thread_id: z.string(),
  content: z.string().nullable(),
  context_message_seq: z.number().int().positive().nullable(),
  run_id: z.string().nullable(),
  status: z.enum(['pending', 'queued', 'consumed', 'superseded']),
  created_at: z.string(),
  updated_at: z.string(),
  queued_at: z.string().nullable(),
  consumed_at: z.string().nullable(),
});
const threadNotificationRowSchema = z.object({
  source_thread_id: z.string(),
  source_agent_id: z.string(),
  source_tool_call_id: z.string(),
  owner_id: z.string(),
  source_run_id: z.string(),
  reply_thread_id: z.string(),
  target: z.enum(['workspace', 'global']),
  content: z.string(),
  delivery_content: z.string(),
  context_message_seq: z.number().int().positive().nullable(),
  run_id: z.string().nullable(),
  status: z.enum(['pending', 'queued', 'consumed', 'superseded']),
  created_at: z.string(),
  updated_at: z.string(),
  queued_at: z.string().nullable(),
  consumed_at: z.string().nullable(),
});
const backgroundTaskRowSchema = z.object({
  task_id: z.string(),
  owner_id: z.string(),
  thread_id: z.string(),
  agent_id: z.string(),
  run_id: z.string(),
  source_tool_call_id: z.string(),
  kind: z.enum(['bash', 'subagent']),
  description: z.string(),
  operation_id: z.string().nullable(),
  status: z.enum(['running', 'completed', 'failed', 'timed_out', 'killed', 'unknown']),
  result_text: z.string().nullable(),
  delivery_content: z.string().nullable(),
  delivery_run_id: z.string().nullable(),
  delivery_status: z.enum(['pending', 'queued', 'consumed']),
  context_message_seq: z.number().int().positive().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  ended_at: z.string().nullable(),
  consumed_at: z.string().nullable(),
});
const queueRowSchema = z.object({
  queue_version: z.number().int().nonnegative(),
  next_position: z.number().int().positive(),
});
const eventRowSchema = z.object({
  event_id: z.string(),
  thread_id: z.string(),
  seq: z.number().int().positive(),
  occurred_at: z.string(),
  payload_json: z.string(),
});
const actionRowSchema = z.object({
  method: z.string(),
  fingerprint: z.string(),
  response_json: z.string(),
});
const serverBashRowSchema = z.object({
  operation_id: z.string(),
  owner_id: z.string(),
  thread_id: z.string(),
  run_id: z.string(),
  tool_call_id: z.string(),
  log_path: z.string().nullable(),
  output_complete: z.number().int().min(0).max(1),
  end_offset: z.string(),
  expires_at: z.string().nullable(),
  content: z.string().nullable(),
  status: z.enum(['success', 'error']).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const payloadEnvelopeSchema = z.object({ case: z.string(), value: z.unknown() });
const eventPayloadCases = new Set<ThreadEventPayload['case']>([
  'threadCreated',
  'threadRenamed',
  'inputAccepted',
  'inputEdited',
  'inputRemoved',
  'inputsReordered',
  'messageCommitted',
  'messageRevised',
  'runChanged',
  'threadNotificationChanged',
  'contextViewChanged',
  'hardCutStarted',
  'hardCutCompleted',
  'hardCutFailed',
  'recapCreated',
  'recapInvalidated',
  'deviceChanged',
  'environmentBindingChanged',
  'mainEnvironmentChanged',
]);
const environmentBindingResponseSchema = z.object({
  historyId: z.string(),
  threadId: z.string(),
  agentId: z.string(),
  envId: z.string(),
  pwd: z.string(),
  bindingVersion: z.number().int().positive(),
  resourceVersion: z.string().nullable(),
  resources: z
    .object({
      snapshotId: z.string(),
      systemInstructions: z.string(),
      resources: z.array(z.object({ path: z.string(), content: z.string() })).readonly(),
    })
    .nullable(),
});
const environmentPolicyResponseSchema = z.object({
  threadId: z.string(),
  agentId: z.string(),
  allowedEnv: z.array(z.string()).readonly(),
  defaultEnv: z.string(),
  defaultPwd: z.string(),
  policyVersion: z.number().int().positive(),
  currentHistoryId: z.string(),
  bindingVersion: z.number().int().nonnegative(),
  current: environmentBindingResponseSchema,
  delegation: delegationKeySchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const threadResponseSchema = z.object({
  threadId: z.string(),
  ownerId: z.string(),
  title: z.string(),
  threadType: z.enum(['main', 'workspace_main', 'task']),
  workspaceId: z.string().nullable().optional(),
  automationOnly: z.boolean(),
  seq: z.number().int().positive(),
  environmentPolicy: environmentPolicyResponseSchema.optional(),
  currentBinding: environmentBindingResponseSchema.optional(),
  newConversation: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const inputResponseSchema = z.object({
  inputId: z.string(),
  threadId: z.string(),
  ownerId: z.string(),
  text: z.string(),
  mode: z.enum(['follow_up', 'steer']),
  status: z.enum(['queued', 'consumed', 'cancelled']),
  position: z.number().int().positive(),
  version: z.number().int().positive(),
  consumedRunId: z.string().nullable(),
  source: messageSourceSchema,
  delegation: delegationKeySchema.nullable(),
  sourceThreadId: z.string().nullable(),
  sourceAgentId: z.string().nullable(),
  automation: automationReferenceSchema.nullable(),
  channel: channelReferenceSchema.nullable().default(null),
  attachments: z.array(attachmentMetadataSchema).readonly().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const runResponseSchema = z.object({
  runId: z.string(),
  threadId: z.string(),
  ownerId: z.string(),
  agentId: z.string(),
  status: runStatusSchema,
  executionMode: z.enum(['foreground', 'background']),
  inputIds: z.array(z.string()),
  parentRunId: z.string().nullable(),
  rerunFromMessageSeq: z.number().int().positive().nullable(),
  supersededByRunId: z.string().nullable(),
  error: runErrorSchema.nullable(),
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }),
  usageReported: z.boolean(),
  currentRequestId: z.string().nullable(),
  generation: z.number().int().positive().default(1),
  cancelAcceptedGeneration: z.number().int().positive().nullable().default(null),
  sendToUserEnabled: z.boolean().optional(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
const sendResponseSchema = z.object({ input: inputResponseSchema, runId: z.string() });
const automationAcceptResponseSchema = z.object({
  thread: threadResponseSchema,
  input: inputResponseSchema,
  runId: z.string(),
});
const removeResponseSchema = z.object({
  input: inputResponseSchema,
  queueVersion: z.number().int().nonnegative(),
});
const reorderResponseSchema = z.object({
  inputs: z.array(inputResponseSchema),
  queueVersion: z.number().int().nonnegative(),
});
const reviseResponseSchema = z
  .object({
    revisionId: z.string(),
    messageId: z.string(),
    text: z.string(),
    previousRevisionId: z.string().optional(),
    createdAt: z.string(),
  })
  .transform((revision): MessageRevisionRecord => {
    const { previousRevisionId, ...base } = revision;
    return {
      ...base,
      ...(previousRevisionId === undefined ? {} : { previousRevisionId }),
    };
  });
const reviseAndRerunResponseSchema = z.object({
  revision: reviseResponseSchema,
  run: runResponseSchema,
});

export interface ActionInput {
  ownerId: string;
  clientActionId: string;
  method: string;
  parameters: unknown;
}

export interface AcceptThreadCallInput {
  ownerId: string;
  sourceThreadId: string;
  sourceAgentId: string;
  sourceRunId: string;
  sourceToolCallId: string;
  targetThreadId?: string | undefined;
  title?: string | undefined;
  environmentPolicy?: EnvironmentPolicyInput | undefined;
  workspaceId?: string | undefined;
  prompt: string;
  mode: InputMode;
}

export interface AcceptedThreadCall {
  interaction: InteractionRecord;
  input: InputRecord;
  runId: string;
}

export interface AcceptThreadNotificationInput {
  ownerId: string;
  sourceThreadId: string;
  sourceAgentId: string;
  sourceRunId: string;
  sourceToolCallId: string;
  content: string;
  target?: 'workspace' | 'global' | undefined;
}

export interface AcceptedThreadNotification {
  notification: ThreadNotificationRecord;
  runId: string | null;
}

export interface CreateSubagentInteractionInput {
  ownerId: string;
  sourceThreadId: string;
  sourceAgentId: string;
  sourceRunId: string;
  sourceToolCallId: string;
  targetAgentId: string;
  prompt: string;
  executionMode: RunExecutionMode;
  environmentPolicy?: EnvironmentPolicyInput | undefined;
}

interface PendingNotification {
  kind: 'event';
  value: ThreadEventRecord;
}

export interface SnapshotCollectionPosition {
  afterRowid: bigint;
  maxRowid: bigint;
}

export interface ThreadSnapshotPosition {
  messages: SnapshotCollectionPosition;
  inputs: SnapshotCollectionPosition;
  runs: SnapshotCollectionPosition;
  devices: SnapshotCollectionPosition;
  recaps: SnapshotCollectionPosition;
  notifications: SnapshotCollectionPosition;
}

export interface SnapshotRecord<T> {
  cursor: bigint;
  value: T;
}

export interface SessionStoreOptions {
  clock?: Clock;
  createId?: () => string;
  eventRetentionMs?: number;
  maxInputBytes?: number;
  maxMessageBytes?: number;
  maxQueuedInputs?: number;
  maxRpcBytes?: number;
  mainEnvironment?: MainEnvironmentConfiguration;
}

export class SessionStore {
  readonly database: DatabaseSync;
  readonly context: ContextStore;
  readonly recaps: RecapStore;
  readonly devices: DeviceStore;
  readonly attachments: AttachmentStore;
  readonly agentEnvironments: AgentEnvironmentStore;
  readonly #clock: Clock;
  readonly #createId: () => string;
  readonly #eventRetentionMs: number;
  readonly #maxInputBytes: number;
  readonly #maxMessageBytes: number;
  readonly #maxQueuedInputs: number;
  readonly #listeners = new Map<
    string,
    Set<(event: ThreadEventRecord | TextDeltaRecord | ToolProgressRecord) => void>
  >();
  readonly #pendingNotifications: PendingNotification[] = [];
  readonly #streamDeltaBuffers = new Map<
    string,
    { deltas: StreamDeltaRecord[]; textLength: number; overflowed: boolean }
  >();
  #transactionDepth = 0;
  #flushScheduled = false;

  constructor(database: DatabaseSync, options: SessionStoreOptions = {}) {
    this.database = database;
    this.#clock = options.clock ?? systemClock;
    this.#createId = options.createId ?? randomUUID;
    this.#eventRetentionMs = options.eventRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
    this.#maxInputBytes = options.maxInputBytes ?? 100_000;
    this.#maxMessageBytes = options.maxMessageBytes ?? 900_000;
    this.#maxQueuedInputs = options.maxQueuedInputs ?? 100;
    assertServerDatabaseCompatible(database);
    migrateDatabase(database, sessionMigrations, 'server_runtime');
    this.attachments = new AttachmentStore(database, {
      clock: this.#clock,
      createId: this.#createId,
      ...(options.maxRpcBytes === undefined ? {} : { maxRpcBytes: options.maxRpcBytes }),
      runAction: (action, schema, work) => this.#action(action, schema, work),
    });
    this.context = new ContextStore(database, this.#clock);
    this.recaps = new RecapStore(database, this.#clock, (recap) => {
      this.transaction(() => {
        this.#insertEvent(recap.threadId, { case: 'recapCreated', value: { recap } });
      });
    });
    this.devices = new DeviceStore(database);
    this.agentEnvironments = new AgentEnvironmentStore(database, {
      createId: this.#createId,
      now: () => this.#clock(),
      ...(options.mainEnvironment ? { mainEnvironment: options.mainEnvironment } : {}),
    });
  }

  transaction<T>(work: () => T): T {
    const ownsTransaction = !this.database.isTransaction;
    this.#transactionDepth += 1;
    try {
      const result = ownsTransaction ? inTransaction(this.database, work) : work();
      this.#transactionDepth -= 1;
      if (ownsTransaction && this.#transactionDepth === 0) this.flushNotifications();
      else if (!ownsTransaction) this.scheduleFlush();
      return result;
    } catch (error) {
      this.#transactionDepth = Math.max(0, this.#transactionDepth - 1);
      if (ownsTransaction && this.#transactionDepth === 0) this.#pendingNotifications.length = 0;
      throw error;
    }
  }

  runAction<T>(action: ActionInput, responseSchema: z.ZodType<T>, work: () => T): T {
    return this.#action(action, responseSchema, work);
  }

  subscribe(
    threadId: string,
    listener: (event: ThreadEventRecord | TextDeltaRecord | ToolProgressRecord) => void,
  ): () => void {
    const listeners = this.#listeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(threadId);
    };
  }

  getMcpOAuthCredentials(
    credentialKey: string,
  ): { accessToken: string; refreshToken: string; expiresAt: string | null } | undefined {
    const row = this.database
      .prepare('SELECT * FROM mcp_oauth_credentials WHERE credential_key = ?')
      .get(credentialKey);
    if (row === undefined) return undefined;
    const parsed = z
      .object({
        access_token: z.string(),
        refresh_token: z.string(),
        expires_at: z.string().nullable(),
      })
      .parse(row);
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresAt: parsed.expires_at,
    };
  }

  saveMcpOAuthCredentials(input: {
    credentialKey: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: string | null;
  }): void {
    const now = isoTime(undefined, this.#clock);
    this.database
      .prepare(
        `INSERT INTO mcp_oauth_credentials(credential_key, access_token, refresh_token, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(credential_key) DO UPDATE SET access_token = excluded.access_token,
           refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      )
      .run(input.credentialKey, input.accessToken, input.refreshToken, input.expiresAt, now, now);
  }

  deleteMcpOAuthCredentials(credentialKey: string): void {
    this.database
      .prepare('DELETE FROM mcp_oauth_credentials WHERE credential_key = ?')
      .run(credentialKey);
  }

  publishToolProgress(progress: ToolProgressRecord): void {
    this.#notify(progress);
  }

  publishTextDelta(delta: TextDeltaRecord): void {
    if (!Number.isSafeInteger(delta.deltaSeq) || delta.deltaSeq <= 0) {
      throw new SessionError('internal', 'Text delta sequence must be positive.');
    }
    this.#bufferStreamDelta(delta);
    this.#notify(delta);
  }

  bufferedStreamDeltas(threadId: string): readonly StreamDeltaRecord[] {
    return [...(this.#streamDeltaBuffers.get(threadId)?.deltas ?? [])];
  }

  #bufferStreamDelta(delta: StreamDeltaRecord): void {
    let buffer = this.#streamDeltaBuffers.get(delta.threadId);
    if (!buffer) {
      buffer = { deltas: [], textLength: 0, overflowed: false };
      this.#streamDeltaBuffers.set(delta.threadId, buffer);
    }
    if (buffer.overflowed) return;
    buffer.deltas.push(delta);
    buffer.textLength += delta.text.length;
    if (buffer.textLength > maxBufferedStreamDeltaTextLength) {
      buffer.deltas = [];
      buffer.textLength = 0;
      buffer.overflowed = true;
    }
  }

  #clearStreamDeltaBuffer(
    threadId: string,
    predicate: (delta: StreamDeltaRecord) => boolean,
  ): void {
    const buffer = this.#streamDeltaBuffers.get(threadId);
    if (!buffer) return;
    buffer.deltas = buffer.deltas.filter((delta) => !predicate(delta));
    buffer.textLength = buffer.deltas.reduce((total, delta) => total + delta.text.length, 0);
    if (buffer.deltas.length === 0) buffer.overflowed = false;
  }

  flushNotifications(): void {
    this.#flushScheduled = false;
    const pending = this.#pendingNotifications.splice(0);
    if (!this.database.isOpen) return;
    for (const notification of pending) {
      const persisted = this.database
        .prepare('SELECT 1 AS present FROM thread_events WHERE event_id = ?')
        .get(notification.value.eventId);
      if (persisted !== undefined) this.#notify(notification.value);
    }
  }

  publishMainEnvironment(tenantId: string, environment: EnvironmentRecord): void {
    if (
      environment.tenantId !== tenantId ||
      this.agentEnvironments.mainEnvironmentIdFor(tenantId) !== environment.envId
    ) {
      throw new SessionError(
        'permission_denied',
        'The environment is not the main environment of this tenant.',
      );
    }
    this.transaction(() => {
      const row = this.database
        .prepare(
          "SELECT thread_id FROM threads WHERE owner_id = ? AND thread_type = 'main' AND archived_at IS NULL",
        )
        .get(tenantId);
      if (!row) return;
      this.#insertEvent(z.object({ thread_id: z.string() }).parse(row).thread_id, {
        case: 'mainEnvironmentChanged',
        value: environment,
      });
    });
  }

  createThread(
    action: ActionInput & {
      title: string;
      initialText: string;
      initialMode: InputMode;
      attachmentIds?: readonly string[];
      clipboardAttachmentIds?: readonly string[];
      environmentPolicy?: EnvironmentPolicyInput | undefined;
    },
  ): { thread: ThreadRecord; input: InputRecord; runId: string };
  createThread(
    action: ActionInput & {
      title: string;
      initialText?: undefined;
      initialMode?: undefined;
      attachmentIds?: undefined;
      clipboardAttachmentIds?: undefined;
      environmentPolicy?: EnvironmentPolicyInput | undefined;
      workspaceId?: string | undefined;
    },
  ): ThreadRecord;
  createThread(
    action: ActionInput & {
      title: string;
      initialText?: string | undefined;
      initialMode?: InputMode | undefined;
      attachmentIds?: readonly string[] | undefined;
      clipboardAttachmentIds?: readonly string[] | undefined;
      environmentPolicy?: EnvironmentPolicyInput | undefined;
      workspaceId?: string | undefined;
    },
  ): ThreadRecord | { thread: ThreadRecord; input: InputRecord; runId: string };
  createThread(
    action: ActionInput & {
      title: string;
      initialText?: string | undefined;
      initialMode?: InputMode | undefined;
      attachmentIds?: readonly string[] | undefined;
      clipboardAttachmentIds?: readonly string[] | undefined;
      environmentPolicy?: EnvironmentPolicyInput | undefined;
      workspaceId?: string | undefined;
    },
  ): ThreadRecord | { thread: ThreadRecord; input: InputRecord; runId: string } {
    const title = requireText(action.title, 'title', 200);
    const attachmentIds = action.attachmentIds ?? [];
    if (
      action.initialText === undefined &&
      attachmentIds.length === 0 &&
      (action.clipboardAttachmentIds?.length ?? 0) > 0
    ) {
      throw new SessionError(
        'invalid_argument',
        'Clipboard attachment IDs must reference the selected attachments.',
      );
    }
    const hasInitialInput = action.initialText !== undefined || attachmentIds.length > 0;
    const initialText = hasInitialInput
      ? requireText(action.initialText ?? '', 'initialText', 1_000_000, {
          allowEmpty: attachmentIds.length > 0,
          maximumBytes: this.#maxInputBytes,
        })
      : undefined;
    if (hasInitialInput && action.initialMode !== 'follow_up' && action.initialMode !== 'steer') {
      throw new SessionError('invalid_argument', 'Initial input mode is not supported.');
    }
    if (!hasInitialInput && action.initialMode !== undefined) {
      throw new SessionError('invalid_argument', 'Initial input text is required with its mode.');
    }
    const withInput = z.object({
      thread: threadResponseSchema,
      input: inputResponseSchema,
      runId: z.string(),
    });
    return this.#action(action, z.union([threadResponseSchema, withInput]), () => {
      const thread = this.#insertThread(
        action.ownerId,
        'task',
        title,
        action.environmentPolicy,
        undefined,
        undefined,
        false,
        undefined,
        action.workspaceId,
      );
      if (!hasInitialInput) return thread;
      if (initialText === undefined || action.initialMode === undefined) {
        throw new SessionError('invalid_argument', 'Initial input mode is not supported.');
      }
      const attachments = this.attachments.selectForInput(
        action.ownerId,
        attachmentIds,
        action.clipboardAttachmentIds ?? [],
      );
      const run = this.#insertRun(action.ownerId, thread.threadId, 'thread');
      const input = this.#insertInput(
        action.ownerId,
        thread.threadId,
        initialText,
        action.initialMode,
        {},
        attachments,
      );
      return { thread, input, runId: run.runId };
    });
  }

  createWorkspace(input: {
    ownerId: string;
    name: string;
    envId: string;
    path: string;
    description?: string;
  }): {
    workspace: WorkspaceRecord;
    mainThread: ThreadRecord;
  } {
    const name = requireText(input.name, 'name', 200);
    const description = requireText(input.description?.trim() ?? '', 'description', 2000, {
      allowEmpty: true,
    });
    const envId = requireText(input.envId, 'envId', 200);
    const path = requireText(input.path, 'path', 4096);
    if (!path.startsWith('/')) {
      throw new SessionError('invalid_argument', 'The workspace path must be absolute.');
    }
    return this.transaction(() => {
      const duplicate = this.database
        .prepare(
          'SELECT workspace_id FROM workspaces WHERE tenant_id = ? AND env_id = ? AND path = ?',
        )
        .get(input.ownerId, envId, path);
      if (duplicate !== undefined) {
        throw new SessionError(
          'action_conflict',
          'A workspace already exists for this device and directory.',
        );
      }
      const workspaceId = this.#createId();
      const now = isoTime(undefined, this.#clock);
      this.database
        .prepare(
          `INSERT INTO workspaces(workspace_id, tenant_id, name, env_id, path, created_at, description)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(workspaceId, input.ownerId, name, envId, path, now, description);
      const mainThread = this.#insertThread(
        input.ownerId,
        'workspace_main',
        name,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        workspaceId,
      );
      return { workspace: this.getWorkspace(input.ownerId, workspaceId), mainThread };
    });
  }

  getWorkspace(ownerId: string, workspaceId: string): WorkspaceRecord {
    return this.#toWorkspace(this.#ownedWorkspace(ownerId, workspaceId));
  }

  listWorkspaces(ownerId: string): WorkspaceRecord[] {
    return this.database
      .prepare('SELECT * FROM workspaces WHERE tenant_id = ? ORDER BY created_at, workspace_id')
      .all(ownerId)
      .map((row) => this.#toWorkspace(workspaceRowSchema.parse(row)));
  }

  workspaceMainThreadId(ownerId: string, workspaceId: string): string | undefined {
    this.#ownedWorkspace(ownerId, workspaceId);
    const row = this.database
      .prepare(
        "SELECT thread_id FROM threads WHERE workspace_id = ? AND thread_type = 'workspace_main' AND archived_at IS NULL",
      )
      .get(workspaceId);
    return row === undefined ? undefined : z.object({ thread_id: z.string() }).parse(row).thread_id;
  }

  renameWorkspace(input: { ownerId: string; workspaceId: string; name: string }): WorkspaceRecord {
    return this.updateWorkspace(input);
  }

  updateWorkspace(input: {
    ownerId: string;
    workspaceId: string;
    name?: string;
    description?: string;
    hidden?: boolean;
  }): WorkspaceRecord {
    return this.transaction(() => {
      const current = this.getWorkspace(input.ownerId, input.workspaceId);
      const name =
        input.name === undefined ? current.name : requireText(input.name.trim(), 'name', 200);
      const description =
        input.description === undefined
          ? current.description
          : requireText(input.description.trim(), 'description', 2000, { allowEmpty: true });
      this.database
        .prepare(
          'UPDATE workspaces SET name = ?, description = ?, hidden = ? WHERE workspace_id = ? AND tenant_id = ?',
        )
        .run(
          name,
          description,
          Number(input.hidden ?? current.hidden),
          input.workspaceId,
          input.ownerId,
        );
      if (name !== current.name) {
        const mainId = this.workspaceMainThreadId(input.ownerId, input.workspaceId);
        if (mainId) this.#updateThreadTitle(input.ownerId, mainId, name);
      }
      return this.getWorkspace(input.ownerId, input.workspaceId);
    });
  }

  deleteWorkspace(action: ActionInput & { workspaceId: string }): { workspaceId: string } {
    return this.#action(action, z.object({ workspaceId: z.string() }), () => {
      this.#ownedWorkspace(action.ownerId, action.workspaceId);
      deleteWorkspaceRecords(this.database, action.ownerId, action.workspaceId);
      return { workspaceId: action.workspaceId };
    });
  }

  #workspaceMainThread(ownerId: string, sourceThreadId: string): ThreadRecord {
    const source = this.getThread(ownerId, sourceThreadId);
    if (source.workspaceId === null || source.workspaceId === undefined) {
      throw new SessionError(
        'failed_precondition',
        'A temporary conversation has no workspace main; notify the global main instead.',
      );
    }
    const row = this.database
      .prepare(
        "SELECT * FROM threads WHERE workspace_id = ? AND thread_type = 'workspace_main' AND archived_at IS NULL",
      )
      .get(source.workspaceId);
    if (row === undefined) {
      throw new SessionError('internal', 'The workspace main conversation is missing.');
    }
    return this.#toThread(threadRowSchema.parse(row));
  }

  #ownedWorkspace(ownerId: string, workspaceId: string): z.infer<typeof workspaceRowSchema> {
    const row = this.database
      .prepare('SELECT * FROM workspaces WHERE workspace_id = ?')
      .get(workspaceId);
    if (row === undefined) {
      throw new SessionError('not_found', 'The workspace was not found.');
    }
    const workspace = workspaceRowSchema.parse(row);
    if (workspace.tenant_id !== ownerId) {
      throw new SessionError('permission_denied', 'The workspace belongs to another tenant.');
    }
    return workspace;
  }

  #toWorkspace(row: z.infer<typeof workspaceRowSchema>): WorkspaceRecord {
    return {
      workspaceId: row.workspace_id,
      description: row.description,
      hidden: row.hidden === 1,
      tenantId: row.tenant_id,
      name: row.name,
      envId: row.env_id,
      path: row.path,
      createdAt: row.created_at,
    };
  }

  getOrCreateMainThread(ownerId: string): ThreadRecord {
    requireText(ownerId, 'ownerId', 200);
    return this.transaction(() => {
      const existing = this.database
        .prepare(
          "SELECT thread_id FROM threads WHERE owner_id = ? AND thread_type = 'main' AND archived_at IS NULL",
        )
        .get(ownerId);
      if (existing !== undefined) {
        const { thread_id: threadId } = z.object({ thread_id: z.string() }).parse(existing);
        if (!this.agentEnvironments.getPolicy(threadId, 'thread')) {
          this.agentEnvironments.createPolicy({ ownerId, threadId, agentId: 'thread' });
        }
        return this.getThread(ownerId, threadId);
      }
      return this.#insertThread(ownerId, 'main', '主对话');
    });
  }

  startNewMain(action: ActionInput & { threadId: string }): ThreadRecord {
    return this.#action(action, threadResponseSchema, () => {
      const current = this.getThread(action.ownerId, action.threadId);
      if (
        (current.threadType !== 'main' && current.threadType !== 'workspace_main') ||
        current.archivedAt
      ) {
        throw new SessionError(
          'failed_precondition',
          'Only the current main conversation can be replaced.',
        );
      }
      if (this.getActiveRun(current.threadId)) {
        throw new SessionError(
          'failed_precondition',
          'Wait for the active root Run to finish first.',
        );
      }
      if (this.listQueuedInputs(current.threadId).length > 0) {
        throw new SessionError(
          'failed_precondition',
          'Consume or remove queued inputs before starting a new conversation.',
        );
      }
      const backgroundOperation = this.database
        .prepare(
          `SELECT 'manual_compact' AS kind FROM manual_compact_operations
           WHERE thread_id = ? AND status = 'running'
           UNION ALL
           SELECT 'periodic_recap' AS kind FROM recap_generation_operations
           WHERE thread_id = ? AND agent_id = 'thread' AND status = 'running'
           LIMIT 1`,
        )
        .get(current.threadId, current.threadId);
      if (backgroundOperation !== undefined) {
        throw new SessionError(
          'failed_precondition',
          'Wait for Context maintenance to finish before starting a new conversation.',
        );
      }
      const now = isoTime(undefined, this.#clock);
      const archived = this.database
        .prepare(
          'UPDATE threads SET archived_at = ?, updated_at = ? WHERE thread_id = ? AND archived_at IS NULL',
        )
        .run(now, now, current.threadId);
      if (archived.changes !== 1) {
        throw new SessionError('version_conflict', 'The current main conversation has changed.');
      }
      return this.#insertThread(
        action.ownerId,
        current.threadType,
        current.threadType === 'workspace_main' ? current.title : '主对话',
        undefined,
        undefined,
        undefined,
        false,
        current.threadId,
        current.threadType === 'workspace_main' ? (current.workspaceId ?? undefined) : undefined,
      );
    });
  }

  getThread(ownerId: string, threadId: string): ThreadRecord {
    const row = this.database.prepare('SELECT * FROM threads WHERE thread_id = ?').get(threadId);
    if (row === undefined) throw new SessionError('not_found', 'Thread was not found.');
    const thread = this.#toThread(threadRowSchema.parse(row));
    if (thread.ownerId !== ownerId) {
      throw new SessionError('permission_denied', 'Thread is not available to this owner.');
    }
    return thread;
  }

  listThreads(
    ownerId: string,
    afterSeq: bigint,
    limit: number,
    threadType?: ThreadRecord['threadType'],
    workspaceId?: string | null,
  ): ThreadRecord[] {
    if (afterSeq > BigInt(Number.MAX_SAFE_INTEGER)) return [];
    const conditions = ['owner_id = ?', 'seq > ?', 'automation_only = 0', 'archived_at IS NULL'];
    const parameters: Array<string | number> = [ownerId, Number(afterSeq)];
    if (threadType !== undefined) {
      conditions.push('thread_type = ?');
      parameters.push(threadType);
    }
    if (workspaceId === null) {
      conditions.push('workspace_id IS NULL');
    } else if (workspaceId !== undefined) {
      conditions.push('workspace_id = ?');
      parameters.push(workspaceId);
    }
    parameters.push(limit);
    const rows = this.database
      .prepare(`SELECT * FROM threads WHERE ${conditions.join(' AND ')} ORDER BY seq LIMIT ?`)
      .all(...parameters);
    return rows.map((row) => this.#toThread(threadRowSchema.parse(row)));
  }

  getThreadSnapshotBounds(ownerId: string, threadId: string): ThreadSnapshotPosition {
    this.getThread(ownerId, threadId);
    const bound = (row: unknown) =>
      z.object({ max_rowid: z.number().int().nonnegative() }).parse(row).max_rowid;
    return {
      messages: {
        afterRowid: 0n,
        maxRowid: BigInt(
          bound(
            this.database
              .prepare(
                'SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM context_messages WHERE thread_id = ?',
              )
              .get(threadId),
          ),
        ),
      },
      inputs: {
        afterRowid: 0n,
        maxRowid: BigInt(
          bound(
            this.database
              .prepare(
                'SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM inputs WHERE thread_id = ?',
              )
              .get(threadId),
          ),
        ),
      },
      runs: {
        afterRowid: 0n,
        maxRowid: BigInt(
          bound(
            this.database
              .prepare('SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM runs WHERE thread_id = ?')
              .get(threadId),
          ),
        ),
      },
      devices: {
        afterRowid: 0n,
        maxRowid: BigInt(
          bound(
            this.database
              .prepare(
                'SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM devices WHERE owner_id = ?',
              )
              .get(ownerId),
          ),
        ),
      },
      recaps: {
        afterRowid: 0n,
        maxRowid: BigInt(
          bound(
            this.database
              .prepare(
                'SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM recaps WHERE thread_id = ?',
              )
              .get(threadId),
          ),
        ),
      },
      notifications: {
        afterRowid: 0n,
        maxRowid: BigInt(
          bound(
            this.database
              .prepare(
                `SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM thread_notifications
                 WHERE owner_id = ? AND source_thread_id = ? AND source_agent_id = 'thread'`,
              )
              .get(ownerId, threadId),
          ),
        ),
      },
    };
  }

  listThreadSnapshotMessages(
    ownerId: string,
    threadId: string,
    position: SnapshotCollectionPosition,
    limit: number,
  ): SnapshotRecord<ContextMessage>[] {
    this.getThread(ownerId, threadId);
    const range = snapshotRange(position);
    if (!range) return [];
    const rows = z
      .array(
        z.object({
          snapshot_cursor: z.number().int().positive(),
          agent_id: z.string(),
          seq: z.number().int().positive(),
        }),
      )
      .parse(
        this.database
          .prepare(
            `SELECT rowid AS snapshot_cursor, agent_id, seq FROM context_messages
             WHERE thread_id = ? AND superseded_by_run_id IS NULL
               AND (
                 source IS NULL OR source NOT IN (
                   'thread_response', 'subagent_response', 'thread_notification'
                 )
                 OR source_tool_call_id IS NULL OR NOT EXISTS (
                   SELECT 1 FROM context_tool_calls AS source_call
                   JOIN context_messages AS source_message
                     ON source_message.seq = source_call.assistant_seq
                   WHERE source_call.thread_id = context_messages.delegation_source_thread_id
                     AND source_call.agent_id = context_messages.delegation_source_agent_id
                     AND source_call.call_id = context_messages.source_tool_call_id
                     AND source_message.superseded_by_run_id IS NOT NULL
                 )
               )
               AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`,
          )
          .all(threadId, range.after, range.maximum, limit),
      );
    return rows.map((row) => {
      const message = this.context.get(threadId, row.agent_id, row.seq);
      if (!message) throw new SessionError('internal', 'Stored Context message is missing.');
      return { cursor: BigInt(row.snapshot_cursor), value: message };
    });
  }

  listThreadSnapshotInputs(
    ownerId: string,
    threadId: string,
    position: SnapshotCollectionPosition,
    limit: number,
  ): SnapshotRecord<InputRecord>[] {
    this.getThread(ownerId, threadId);
    const range = snapshotRange(position);
    if (!range) return [];
    const rows = z
      .array(inputRowSchema.extend({ snapshot_cursor: z.number().int().positive() }))
      .parse(
        this.database
          .prepare(
            'SELECT rowid AS snapshot_cursor, * FROM inputs WHERE thread_id = ? AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?',
          )
          .all(threadId, range.after, range.maximum, limit),
      );
    return rows.map((row) => ({
      cursor: BigInt(row.snapshot_cursor),
      value: this.#toInput(inputRowSchema.parse(row)),
    }));
  }

  listThreadSnapshotRuns(
    ownerId: string,
    threadId: string,
    position: SnapshotCollectionPosition,
    limit: number,
  ): SnapshotRecord<RunRecord>[] {
    this.getThread(ownerId, threadId);
    const range = snapshotRange(position);
    if (!range) return [];
    const rows = z
      .array(runRowSchema.extend({ snapshot_cursor: z.number().int().positive() }))
      .parse(
        this.database
          .prepare(
            'SELECT rowid AS snapshot_cursor, * FROM runs WHERE thread_id = ? AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?',
          )
          .all(threadId, range.after, range.maximum, limit),
      );
    return rows.map((row) => ({
      cursor: BigInt(row.snapshot_cursor),
      value: this.#toRun(runRowSchema.parse(row)),
    }));
  }

  listThreadSnapshotDevices(
    ownerId: string,
    threadId: string,
    position: SnapshotCollectionPosition,
    limit: number,
  ): SnapshotRecord<DeviceRecord>[] {
    this.getThread(ownerId, threadId);
    const range = snapshotRange(position);
    if (!range) return [];
    const rows = z
      .array(
        z.object({
          snapshot_cursor: z.number().int().positive(),
          device_id: z.string(),
        }),
      )
      .parse(
        this.database
          .prepare(
            'SELECT rowid AS snapshot_cursor, device_id FROM devices WHERE owner_id = ? AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?',
          )
          .all(ownerId, range.after, range.maximum, limit),
      );
    return rows.map((row) => ({
      cursor: BigInt(row.snapshot_cursor),
      value: this.devices.getForOwner(ownerId, row.device_id),
    }));
  }

  listThreadSnapshotRecaps(
    ownerId: string,
    threadId: string,
    position: SnapshotCollectionPosition,
    limit: number,
  ): SnapshotRecord<Recap>[] {
    this.getThread(ownerId, threadId);
    const range = snapshotRange(position);
    if (!range) return [];
    const rows = z
      .array(
        z.object({
          snapshot_cursor: z.number().int().positive(),
          recap_id: z.string(),
          agent_id: z.string(),
        }),
      )
      .parse(
        this.database
          .prepare(
            `SELECT rowid AS snapshot_cursor, recap_id, agent_id FROM recaps
             WHERE thread_id = ? AND validity = 'valid' AND rowid > ? AND rowid <= ?
             ORDER BY rowid LIMIT ?`,
          )
          .all(threadId, range.after, range.maximum, limit),
      );
    return rows.flatMap((row) => {
      const recap = this.recaps.get(threadId, row.agent_id, row.recap_id);
      if (recap?.validity !== 'valid') return [];
      return [{ cursor: BigInt(row.snapshot_cursor), value: recap }];
    });
  }

  renameThread(action: ActionInput & { threadId: string; title: string }): ThreadRecord {
    const title = requireText(action.title, 'title', 200);
    return this.#action(action, threadResponseSchema, () => {
      this.getThread(action.ownerId, action.threadId);
      this.#updateThreadTitle(action.ownerId, action.threadId, title);
      return this.getThread(action.ownerId, action.threadId);
    });
  }

  renameThreadIfTitle(input: {
    ownerId: string;
    threadId: string;
    expectedTitle: string;
    title: string;
  }): ThreadRecord {
    const title = requireText(input.title, 'title', 200);
    requireText(input.expectedTitle, 'expectedTitle', 200);
    return this.transaction(() => {
      const current = this.getThread(input.ownerId, input.threadId);
      if (current.title !== input.expectedTitle) return current;
      this.#updateThreadTitle(input.ownerId, input.threadId, title);
      return this.getThread(input.ownerId, input.threadId);
    });
  }

  archiveThread(action: ActionInput & { threadId: string }): ThreadRecord {
    return this.#action(action, threadResponseSchema, () => {
      const current = this.getThread(action.ownerId, action.threadId);
      if (current.threadType !== 'task') {
        throw new SessionError('failed_precondition', 'Only task conversations can be archived.');
      }
      if (current.archivedAt) {
        throw new SessionError('failed_precondition', 'The conversation is already archived.');
      }
      if (this.getActiveRun(current.threadId)) {
        throw new SessionError(
          'failed_precondition',
          'Wait for the active root Run to finish first.',
        );
      }
      if (this.listQueuedInputs(current.threadId).length > 0) {
        throw new SessionError(
          'failed_precondition',
          'Consume or remove queued inputs before archiving.',
        );
      }
      const backgroundOperation = this.database
        .prepare(
          `SELECT 'manual_compact' AS kind FROM manual_compact_operations
           WHERE thread_id = ? AND status = 'running'
           UNION ALL
           SELECT 'periodic_recap' AS kind FROM recap_generation_operations
           WHERE thread_id = ? AND agent_id = 'thread' AND status = 'running'
           LIMIT 1`,
        )
        .get(current.threadId, current.threadId);
      if (backgroundOperation !== undefined) {
        throw new SessionError(
          'failed_precondition',
          'Wait for Context maintenance to finish before archiving.',
        );
      }
      const now = isoTime(undefined, this.#clock);
      this.database
        .prepare(
          'UPDATE threads SET archived_at = ?, updated_at = ? WHERE thread_id = ? AND archived_at IS NULL',
        )
        .run(now, now, current.threadId);
      const archived = this.getThread(action.ownerId, action.threadId);
      this.#insertEvent(current.threadId, { case: 'threadRenamed', value: { thread: archived } });
      return archived;
    });
  }

  restoreThread(action: ActionInput & { threadId: string }): ThreadRecord {
    return this.#action(action, threadResponseSchema, () => {
      const current = this.getThread(action.ownerId, action.threadId);
      if (current.threadType !== 'task' || !current.archivedAt) {
        throw new SessionError(
          'failed_precondition',
          'Only archived task conversations can be restored.',
        );
      }
      const now = isoTime(undefined, this.#clock);
      this.database
        .prepare('UPDATE threads SET archived_at = NULL, updated_at = ? WHERE thread_id = ?')
        .run(now, current.threadId);
      const restored = this.getThread(action.ownerId, action.threadId);
      this.#insertEvent(current.threadId, { case: 'threadRenamed', value: { thread: restored } });
      return restored;
    });
  }

  deleteArchivedThread(action: ActionInput & { threadId: string }): { threadId: string } {
    return this.#action(action, z.object({ threadId: z.string() }), () => {
      const current = this.getThread(action.ownerId, action.threadId);
      if (current.threadType !== 'task' || !current.archivedAt) {
        throw new SessionError(
          'failed_precondition',
          'Only archived task conversations can be deleted.',
        );
      }
      deleteArchivedThreadRecords(this.database, action.ownerId, action.threadId);
      return { threadId: action.threadId };
    });
  }

  listArchivedThreads(ownerId: string, afterSeq: bigint, limit: number): ThreadRecord[] {
    if (afterSeq > BigInt(Number.MAX_SAFE_INTEGER)) return [];
    const rows = this.database
      .prepare(
        `SELECT * FROM threads
         WHERE owner_id = ? AND seq > ? AND thread_type = 'task' AND automation_only = 0
           AND archived_at IS NOT NULL
         ORDER BY seq LIMIT ?`,
      )
      .all(ownerId, Number(afterSeq), limit);
    return rows.map((row) => this.#toThread(threadRowSchema.parse(row)));
  }

  sendMessage(
    action: ActionInput & {
      threadId: string;
      text: string;
      mode: InputMode;
      attachmentIds?: readonly string[];
      clipboardAttachmentIds?: readonly string[];
    },
  ): {
    input: InputRecord;
    runId: string;
  } {
    const attachmentIds = action.attachmentIds ?? [];
    const text = requireText(action.text, 'text', 1_000_000, {
      allowEmpty: attachmentIds.length > 0,
      maximumBytes: this.#maxInputBytes,
    });
    if (action.mode !== 'follow_up' && action.mode !== 'steer') {
      throw new SessionError('invalid_argument', 'Input mode is not supported.');
    }
    return this.#action(action, sendResponseSchema, () => {
      const thread = this.getThread(action.ownerId, action.threadId);
      if (thread.archivedAt) {
        throw new SessionError(
          'failed_precondition',
          'The archived main conversation cannot accept new input.',
        );
      }
      if (thread.automationOnly) {
        throw new SessionError(
          'failed_precondition',
          'An automation_only Thread accepts input only from its Automation.',
        );
      }
      this.agentEnvironments.requirePolicy(thread.threadId, 'thread');
      this.#assertQueueCapacity(action.threadId, 1);
      const active = this.getActiveRun(action.threadId);
      if (active?.status === 'cancel_requested') {
        throw new SessionError(
          'failed_precondition',
          'Cannot submit input after cancellation was requested.',
        );
      }
      const attachments = this.attachments.selectForInput(
        action.ownerId,
        attachmentIds,
        action.clipboardAttachmentIds ?? [],
      );
      const run = active ?? this.#insertRun(action.ownerId, action.threadId, 'thread');
      const input = this.#insertInput(
        action.ownerId,
        action.threadId,
        text,
        action.mode,
        {},
        attachments,
      );
      return { input, runId: run.runId };
    });
  }

  acceptChannelInput(
    action: ActionInput & {
      text: string;
      channel: ChannelReference;
      attachmentIds?: readonly string[];
    },
  ): { thread: ThreadRecord; input: InputRecord; runId: string } {
    const text = requireText(action.text, 'text', 1_000_000, {
      allowEmpty: (action.attachmentIds?.length ?? 0) > 0,
      maximumBytes: this.#maxInputBytes,
    });
    if (action.channel.externalMessageId != null) {
      requireText(action.channel.externalMessageId, 'channel.externalMessageId', 200);
    }
    return this.#action(action, automationAcceptResponseSchema, () => {
      const thread = this.getOrCreateMainThread(action.ownerId);
      this.agentEnvironments.requirePolicy(thread.threadId, 'thread');
      this.#assertQueueCapacity(thread.threadId, 1);
      const active = this.getActiveRun(thread.threadId);
      if (active?.status === 'cancel_requested') {
        throw new SessionError(
          'failed_precondition',
          'Cannot submit channel input after cancellation was requested.',
        );
      }
      const attachments = this.attachments.selectForChannelInput(
        action.ownerId,
        action.attachmentIds ?? [],
      );
      const run = active ?? this.#insertRun(action.ownerId, thread.threadId, 'thread');
      const input = this.#insertInput(
        action.ownerId,
        thread.threadId,
        text,
        'steer',
        {
          source: 'channel',
          channel: action.channel,
        },
        attachments,
      );
      return { thread, input, runId: run.runId };
    });
  }

  acceptAutomationInput(
    action: ActionInput & {
      targetKind: 'main' | 'existing_thread' | 'new_task' | 'new_automation_only';
      threadId?: string | undefined;
      title?: string | undefined;
      prompt: string;
      environmentPolicy?: EnvironmentPolicyInput | undefined;
      workspaceId?: string | undefined;
      automation: AutomationReference;
    },
  ): { thread: ThreadRecord; input: InputRecord; runId: string } {
    const prompt = requireText(action.prompt, 'prompt', 1_000_000, {
      maximumBytes: this.#maxInputBytes,
    });
    return this.#action(action, automationAcceptResponseSchema, () => {
      let thread: ThreadRecord;
      if (action.targetKind === 'main') {
        thread = this.getOrCreateMainThread(action.ownerId);
      } else if (action.targetKind === 'existing_thread') {
        thread = this.getThread(action.ownerId, action.threadId ?? '');
        if (thread.threadType !== 'task' || thread.automationOnly) {
          throw new SessionError(
            'failed_precondition',
            'An existing Automation target must be a normal persistent task Thread.',
          );
        }
      } else {
        thread = this.#insertThread(
          action.ownerId,
          'task',
          requireText(action.title ?? '', 'title', 200),
          action.environmentPolicy,
          undefined,
          undefined,
          action.targetKind === 'new_automation_only',
          undefined,
          action.workspaceId,
        );
      }
      this.agentEnvironments.requirePolicy(thread.threadId, 'thread');
      this.#assertQueueCapacity(thread.threadId, 1);
      const active = this.getActiveRun(thread.threadId);
      if (active?.status === 'cancel_requested') {
        throw new SessionError(
          'failed_precondition',
          'Cannot submit Automation input after cancellation was requested.',
        );
      }
      const run = active ?? this.#insertRun(action.ownerId, thread.threadId, 'thread');
      const input = this.#insertInput(action.ownerId, thread.threadId, prompt, 'follow_up', {
        source: 'automation',
        automation: action.automation,
      });
      return { thread, input, runId: run.runId };
    });
  }

  rerun(action: ActionInput & { threadId: string; messageId: string }): RunRecord {
    return this.#action(action, runResponseSchema, () => this.#rerunFromMessage(action));
  }

  #rerunFromMessage(action: ActionInput & { threadId: string; messageId: string }): RunRecord {
    if (this.getActiveRun(action.threadId)) {
      throw new SessionError('failed_precondition', 'Wait for the active Run to finish first.');
    }
    const message = this.#latestDirectUserMessage(
      action.ownerId,
      action.threadId,
      action.messageId,
    );
    const restored = this.agentEnvironments.restoreForRerun(
      action.threadId,
      message.agentId,
      message.seq,
    );
    if (restored) {
      this.#insertEvent(action.threadId, {
        case: 'environmentBindingChanged',
        value: { agentId: message.agentId, binding: restored.current },
      });
    }
    const run = this.#insertRun(
      action.ownerId,
      action.threadId,
      'thread',
      undefined,
      undefined,
      message.seq,
    );
    const now = isoTime(undefined, this.#clock);
    const affected = this.recaps
      .query({ threadId: action.threadId, agentId: message.agentId, validity: 'valid' })
      .filter((recap) => recap.sourceMessageSeqs.some((seq) => seq >= message.seq));
    this.database
      .prepare(
        `UPDATE context_messages SET superseded_by_run_id = ?
         WHERE thread_id = ? AND agent_id = ? AND seq > ? AND superseded_by_run_id IS NULL
           AND NOT (
             source IN ('thread_response', 'subagent_response', 'thread_notification') AND EXISTS (
               SELECT 1 FROM context_tool_calls AS source_call
               JOIN context_messages AS source_message
                 ON source_message.seq = source_call.assistant_seq
               WHERE source_call.thread_id = context_messages.delegation_source_thread_id
                   AND source_call.agent_id = context_messages.delegation_source_agent_id
                   AND source_call.call_id = context_messages.source_tool_call_id
                 AND source_message.superseded_by_run_id IS NULL
                 AND (
                   source_message.thread_id <> context_messages.thread_id
                   OR source_message.agent_id <> context_messages.agent_id
                   OR source_message.seq <= ?
                 )
             )
           )`,
      )
      .run(run.runId, action.threadId, message.agentId, message.seq, message.seq);
    this.database
      .prepare(
        `UPDATE runs SET superseded_by_run_id = ?
         WHERE thread_id = ? AND agent_id = 'thread' AND parent_run_id IS NULL
           AND run_id <> ? AND superseded_by_run_id IS NULL
           AND (
             (? IS NOT NULL AND rowid >= (SELECT rowid FROM runs WHERE run_id = ?))
             OR EXISTS (
               SELECT 1 FROM context_messages
               WHERE context_messages.run_id = runs.run_id
                 AND context_messages.superseded_by_run_id = ?
             )
           )`,
      )
      .run(run.runId, action.threadId, run.runId, message.runId, message.runId, run.runId);
    this.database
      .prepare(
        `UPDATE recaps SET validity = 'invalid', invalidated_at = ?,
           invalidation_reason = 'source_rerun'
         WHERE thread_id = ? AND agent_id = ? AND validity = 'valid' AND EXISTS (
           SELECT 1 FROM recap_sources
           WHERE recap_sources.recap_id = recaps.recap_id AND recap_sources.message_seq >= ?
         )`,
      )
      .run(now, action.threadId, message.agentId, message.seq);
    this.database
      .prepare(
        `INSERT INTO model_input_states(
           thread_id, agent_id, read_through_seq, view_version, updated_at
         ) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(thread_id, agent_id) DO UPDATE SET
           read_through_seq = MIN(model_input_states.read_through_seq, excluded.read_through_seq),
           view_version = model_input_states.view_version + 1,
           updated_at = excluded.updated_at`,
      )
      .run(action.threadId, message.agentId, message.seq - 1, now);
    this.database
      .prepare(
        `DELETE FROM model_input_recaps
         WHERE thread_id = ? AND agent_id = ? AND recap_id IN (
           SELECT recap_id FROM recap_sources WHERE message_seq >= ?
         )`,
      )
      .run(action.threadId, message.agentId, message.seq);
    this.#supersedeInvalidInteractionDeliveries(run.runId, now);
    this.#supersedeInvalidThreadNotifications(run.runId, now);
    for (const oldRun of this.database
      .prepare('SELECT * FROM runs WHERE superseded_by_run_id = ? ORDER BY created_at, rowid')
      .all(run.runId)
      .map((row) => this.#toRun(runRowSchema.parse(row)))) {
      this.#insertEvent(oldRun.threadId, { case: 'runChanged', value: { run: oldRun } });
    }
    for (const recap of affected) {
      this.#insertEvent(action.threadId, {
        case: 'recapInvalidated',
        value: { recapId: recap.recapId, reason: 'source_rerun' },
      });
    }
    const viewVersion = this.#viewVersion(action.threadId, message.agentId);
    this.#insertEvent(action.threadId, {
      case: 'contextViewChanged',
      value: { agentId: message.agentId, viewVersion, anchorMessageSeq: message.seq },
    });
    return this.getRunById(run.runId);
  }

  moveInputToNewRun(ownerId: string, inputId: string): RunRecord {
    return this.transaction(() => {
      const input = this.getInput(ownerId, inputId);
      if (input.status !== 'queued') {
        throw new SessionError('version_conflict', 'The input was already consumed or removed.');
      }
      const run = this.#insertRun(ownerId, input.threadId, 'thread');
      return run;
    });
  }

  getInput(ownerId: string, inputId: string): InputRecord {
    const row = this.database.prepare('SELECT * FROM inputs WHERE input_id = ?').get(inputId);
    if (row === undefined) throw new SessionError('not_found', 'Input was not found.');
    const input = this.#toInput(inputRowSchema.parse(row));
    if (input.ownerId !== ownerId) {
      throw new SessionError('permission_denied', 'Input is not available to this owner.');
    }
    return input;
  }

  listInputs(ownerId: string, threadId: string): InputRecord[] {
    this.getThread(ownerId, threadId);
    return this.database
      .prepare('SELECT * FROM inputs WHERE thread_id = ? ORDER BY position')
      .all(threadId)
      .map((row) => this.#toInput(inputRowSchema.parse(row)));
  }

  listQueuedInputs(threadId: string): InputRecord[] {
    return this.database
      .prepare("SELECT * FROM inputs WHERE thread_id = ? AND status = 'queued' ORDER BY position")
      .all(threadId)
      .map((row) => this.#toInput(inputRowSchema.parse(row)));
  }

  editInput(
    action: ActionInput & {
      threadId: string;
      inputId: string;
      text: string;
      expectedVersion: bigint;
    },
  ): InputRecord {
    const text = requireText(action.text, 'text', 1_000_000, {
      allowEmpty: true,
      maximumBytes: this.#maxInputBytes,
    });
    return this.#action(action, inputResponseSchema, () => {
      const input = this.#ownedThreadInput(action.ownerId, action.threadId, action.inputId);
      if ((input.attachments?.length ?? 0) === 0 && text.trim().length === 0) {
        throw new SessionError('invalid_argument', 'text must not be empty without attachments.');
      }
      this.#assertInputHasNoInteraction(input, 'edited');
      if (input.status !== 'queued') {
        throw new SessionError('failed_precondition', 'Only a queued input can be edited.');
      }
      if (BigInt(input.version) !== action.expectedVersion) {
        throw new SessionError('version_conflict', 'Input version has changed.');
      }
      this.database
        .prepare(
          'UPDATE inputs SET text = ?, version = version + 1, updated_at = ? WHERE input_id = ? AND version = ?',
        )
        .run(text, isoTime(undefined, this.#clock), input.inputId, input.version);
      const updated = this.getInput(action.ownerId, input.inputId);
      this.#insertEvent(input.threadId, { case: 'inputEdited', value: { input: updated } });
      return updated;
    });
  }

  removeInput(
    action: ActionInput & {
      threadId: string;
      inputId: string;
      expectedVersion: bigint;
    },
  ): { input: InputRecord; queueVersion: number } {
    return this.#action(action, removeResponseSchema, () => {
      const input = this.#ownedThreadInput(action.ownerId, action.threadId, action.inputId);
      this.#assertInputHasNoInteraction(input, 'removed');
      if (input.status !== 'queued') {
        throw new SessionError('failed_precondition', 'Only a queued input can be removed.');
      }
      if (BigInt(input.version) !== action.expectedVersion) {
        throw new SessionError('version_conflict', 'Input version has changed.');
      }
      const queueVersion = this.#nextQueueVersion(
        input.threadId,
        this.#queue(input.threadId).queue_version,
      );
      this.database
        .prepare(
          "UPDATE inputs SET status = 'cancelled', version = version + 1, updated_at = ? WHERE input_id = ? AND version = ?",
        )
        .run(isoTime(undefined, this.#clock), input.inputId, input.version);
      const updated = this.getInput(action.ownerId, input.inputId);
      this.#insertEvent(input.threadId, {
        case: 'inputRemoved',
        value: { input: updated, queueVersion },
      });
      return { input: updated, queueVersion };
    });
  }

  reorderInputs(
    action: ActionInput & { threadId: string; inputIds: string[]; expectedVersion: bigint },
  ): { inputs: InputRecord[]; queueVersion: number } {
    if (new Set(action.inputIds).size !== action.inputIds.length) {
      throw new SessionError('invalid_argument', 'Input IDs must not contain duplicates.');
    }
    return this.#action(action, reorderResponseSchema, () => {
      const thread = this.getThread(action.ownerId, action.threadId);
      if (thread.automationOnly) {
        throw new SessionError(
          'failed_precondition',
          'An automation_only Thread queue cannot be reordered through the general queue API.',
        );
      }
      const queue = this.#queue(action.threadId);
      if (BigInt(queue.queue_version) !== action.expectedVersion) {
        throw new SessionError('version_conflict', 'Queue version has changed.');
      }
      const queued = this.listQueuedInputs(action.threadId);
      const expected = new Set(queued.map((input) => input.inputId));
      if (
        expected.size !== action.inputIds.length ||
        action.inputIds.some((inputId) => !expected.has(inputId))
      ) {
        throw new SessionError(
          'failed_precondition',
          'Reorder must list every currently queued input exactly once.',
        );
      }
      const queueVersion = this.#nextQueueVersion(action.threadId, queue.queue_version);
      let position = queue.next_position;
      const now = isoTime(undefined, this.#clock);
      for (const inputId of action.inputIds) {
        this.database
          .prepare('UPDATE inputs SET position = ?, updated_at = ? WHERE input_id = ?')
          .run(position, now, inputId);
        position += 1;
      }
      this.database
        .prepare('UPDATE thread_queues SET next_position = ? WHERE thread_id = ?')
        .run(position, action.threadId);
      const inputs = this.listQueuedInputs(action.threadId);
      this.#insertEvent(action.threadId, {
        case: 'inputsReordered',
        value: { inputs, queueVersion },
      });
      return { inputs, queueVersion };
    });
  }

  reviseMessage(
    action: ActionInput & {
      threadId: string;
      messageId: string;
      text: string;
      expectedRevisionId?: string;
    },
  ): { revision: MessageRevisionRecord; run: RunRecord } {
    const text = requireText(action.text, 'text', 1_000_000, {
      allowEmpty: true,
      maximumBytes: this.#maxInputBytes,
    });
    return this.#action(action, reviseAndRerunResponseSchema, () => {
      const message = this.#latestDirectUserMessage(
        action.ownerId,
        action.threadId,
        action.messageId,
      );
      if (this.getActiveRun(action.threadId)) {
        throw new SessionError('failed_precondition', 'Wait for the active Run to finish first.');
      }
      const previous = message.revisions.at(-1);
      if (
        action.expectedRevisionId !== undefined &&
        action.expectedRevisionId !== previous?.revisionId
      ) {
        throw new SessionError('version_conflict', 'Message revision has changed.');
      }
      const revisionId = this.#createId();
      const now = isoTime(undefined, this.#clock);
      const affected = this.recaps
        .query({ threadId: action.threadId, agentId: message.agentId, validity: 'valid' })
        .filter((recap) => recap.sourceMessageSeqs.includes(message.seq));
      this.database
        .prepare(
          `INSERT INTO context_message_revisions(
            revision_id, message_seq, revision_number, content, created_at, run_id
          ) VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(revisionId, message.seq, (previous?.revisionNumber ?? 0) + 1, text, now);
      this.database
        .prepare(
          `UPDATE recaps
           SET validity = 'invalid', invalidated_at = ?, invalidation_reason = 'source_revised'
           WHERE validity = 'valid' AND EXISTS (
             SELECT 1 FROM recap_sources
             WHERE recap_sources.recap_id = recaps.recap_id
               AND recap_sources.message_seq = ?
           )`,
        )
        .run(now, message.seq);
      const revision: MessageRevisionRecord = {
        revisionId,
        messageId: action.messageId,
        text,
        ...(previous === undefined ? {} : { previousRevisionId: previous.revisionId }),
        createdAt: now,
      };
      this.#insertEvent(action.threadId, {
        case: 'messageRevised',
        value: { messageId: action.messageId, revision },
      });
      for (const recap of affected) {
        this.#insertEvent(action.threadId, {
          case: 'recapInvalidated',
          value: { recapId: recap.recapId, reason: 'source_revised' },
        });
      }
      const run = this.#rerunFromMessage(action);
      return { revision, run };
    });
  }

  #latestDirectUserMessage(ownerId: string, threadId: string, messageId: string): ContextMessage {
    const message = this.getContextMessage(ownerId, threadId, messageId);
    const direct =
      message.source === undefined || message.source === null || message.source === 'user';
    const latest = this.context
      .query({ threadId, agentId: 'thread', currentOnly: true })
      .filter(
        (candidate) =>
          candidate.message.role === 'user' &&
          (candidate.source === undefined ||
            candidate.source === null ||
            candidate.source === 'user'),
      )
      .at(-1);
    if (
      message.agentId !== 'thread' ||
      message.message.role !== 'user' ||
      !direct ||
      (message.supersededByRunId !== null && message.supersededByRunId !== undefined) ||
      latest?.messageId !== message.messageId
    ) {
      throw new SessionError(
        'failed_precondition',
        'Only the latest current Thread root Agent direct user message can be revised or rerun.',
      );
    }
    return message;
  }

  getContextMessage(ownerId: string, threadId: string, messageId: string): ContextMessage {
    this.getThread(ownerId, threadId);
    const row = z
      .object({ agent_id: z.string(), seq: z.number().int().positive() })
      .optional()
      .parse(
        this.database
          .prepare(
            'SELECT agent_id, seq FROM context_messages WHERE thread_id = ? AND message_id = ?',
          )
          .get(threadId, messageId),
      );
    if (!row) throw new SessionError('not_found', 'Context message was not found.');
    const message = this.context.get(threadId, row.agent_id, row.seq);
    if (!message) throw new SessionError('not_found', 'Context message was not found.');
    return message;
  }

  listContext(ownerId: string, threadId: string, agentId?: string): ContextMessage[] {
    this.getThread(ownerId, threadId);
    const rows = z
      .array(z.object({ agent_id: z.string(), seq: z.number().int().positive() }))
      .parse(
        agentId === undefined || agentId === ''
          ? this.database
              .prepare(
                'SELECT agent_id, seq FROM context_messages WHERE thread_id = ? ORDER BY seq',
              )
              .all(threadId)
          : this.database
              .prepare(
                'SELECT agent_id, seq FROM context_messages WHERE thread_id = ? AND agent_id = ? ORDER BY seq',
              )
              .all(threadId, agentId),
      );
    return rows.map((row) => {
      const message = this.context.get(threadId, row.agent_id, row.seq);
      if (!message) throw new SessionError('internal', 'Stored Context message is missing.');
      return message;
    });
  }

  listRecaps(
    ownerId: string,
    threadId: string,
    agentId?: string,
  ): Array<Recap & { cursor: number }> {
    this.getThread(ownerId, threadId);
    const records =
      agentId !== undefined && agentId !== ''
        ? this.recaps.query({ threadId, agentId })
        : z
            .array(z.object({ agent_id: z.string() }))
            .parse(
              this.database
                .prepare(
                  'SELECT DISTINCT agent_id FROM recaps WHERE thread_id = ? ORDER BY agent_id',
                )
                .all(threadId),
            )
            .flatMap((agent) => this.recaps.query({ threadId, agentId: agent.agent_id }));
    const cursors = new Map(
      z
        .array(z.object({ recap_id: z.string(), cursor: z.number().int().positive() }))
        .parse(
          this.database
            .prepare('SELECT recap_id, rowid AS cursor FROM recaps WHERE thread_id = ?')
            .all(threadId),
        )
        .map((row) => [row.recap_id, row.cursor]),
    );
    return records
      .map((recap) => {
        const cursor = cursors.get(recap.recapId);
        if (cursor === undefined) {
          throw new SessionError('internal', 'Stored Recap cursor is missing.');
        }
        return { ...recap, cursor };
      })
      .sort((left, right) => left.cursor - right.cursor);
  }

  appendModelMessage(input: {
    runId: string;
    messageId?: string;
    message: Parameters<ContextStore['append']>[0]['message'];
    inputId?: string;
    responseUsage?: Parameters<ContextStore['append']>[0]['responseUsage'];
    attachmentIds?: readonly string[];
  }): ContextMessage {
    if (Buffer.byteLength(JSON.stringify(input.message)) > this.#maxMessageBytes) {
      throw new SessionError('input_too_large', 'Model message exceeds the configured byte limit.');
    }
    return this.transaction(() => {
      const run = this.getRunById(input.runId);
      const sourceInput =
        input.inputId === undefined ? undefined : this.#consumeInput(run, input.inputId);
      const storedMessage: Parameters<ContextStore['append']>[0]['message'] =
        input.message.role === 'user' && input.message.content_parts !== undefined
          ? { role: 'user', content: input.message.content }
          : input.message;
      let record = this.context.append({
        threadId: run.threadId,
        agentId: run.agentId,
        runId: run.runId,
        ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
        ...(sourceInput === undefined
          ? {}
          : {
              source: sourceInput.source,
              sourceInputId: sourceInput.inputId,
              ...(sourceInput.delegation === null ? {} : { delegation: sourceInput.delegation }),
              ...(sourceInput.sourceThreadId === null
                ? {}
                : { sourceThreadId: sourceInput.sourceThreadId }),
              ...(sourceInput.sourceAgentId === null
                ? {}
                : { sourceAgentId: sourceInput.sourceAgentId }),
              ...(sourceInput.automation === null ? {} : { automation: sourceInput.automation }),
              ...(sourceInput.channel === null ? {} : { channel: sourceInput.channel }),
            }),
        message: storedMessage,
        ...(input.responseUsage === undefined ? {} : { responseUsage: input.responseUsage }),
      });
      if (sourceInput !== undefined && input.message.role === 'user') {
        this.attachments.linkMessageFromInput(record.seq, sourceInput.inputId);
        record = this.context.get(run.threadId, run.agentId, record.seq) ?? record;
      }
      if (input.attachmentIds !== undefined && input.attachmentIds.length > 0) {
        this.attachments.linkMessage(record.seq, run.ownerId, input.attachmentIds);
        record = this.context.get(run.threadId, run.agentId, record.seq) ?? record;
      }
      this.agentEnvironments.recordMessageBinding(run.threadId, run.agentId, record.seq, run);
      if (input.message.role === 'user' && run.currentRequestId !== null) {
        this.database
          .prepare('UPDATE runs SET current_request_id = NULL WHERE run_id = ?')
          .run(run.runId);
      }
      if (input.message.role === 'assistant' && run.currentRequestId !== null) {
        const sendToUserEnabled = requestUsesSendToUser(this.database, run.currentRequestId);
        this.#recordOutputModeEvent(
          run,
          modelResponseModeEventId(record.messageId),
          'model_response_mode',
          {
            message_seq: record.seq,
            request_id: run.currentRequestId,
            send_to_user_enabled: sendToUserEnabled,
          },
        );
        record = { ...record, sendToUserEnabled };
        const request = z
          .object({ preparation_id: z.string().nullable() })
          .optional()
          .parse(
            this.database
              .prepare('SELECT preparation_id FROM model_request_records WHERE request_id = ?')
              .get(run.currentRequestId),
          );
        if (!request?.preparation_id) {
          throw new SessionError('internal', 'The completed model request has no preparation ID.');
        }
        const completed = this.database
          .prepare(
            "UPDATE model_request_records SET status = 'completed', updated_at = ? WHERE request_id = ? AND preparation_id = ? AND status = 'ready'",
          )
          .run(isoTime(undefined, this.#clock), run.currentRequestId, request.preparation_id);
        if (completed.changes !== 1) {
          throw new SessionError('internal', 'The completed model request state changed.');
        }
        this.database
          .prepare('UPDATE runs SET current_request_id = NULL WHERE run_id = ?')
          .run(run.runId);
      }
      if (record.supersededByRunId === null) {
        this.#insertEvent(run.threadId, { case: 'messageCommitted', value: { message: record } });
      }
      return record;
    });
  }

  appendInteractionDeliveryMessage(input: {
    runId: string;
    key: DelegationKey;
    message: { role: 'user'; content: string };
  }): ContextMessage {
    return this.transaction(() => {
      const run = this.getRunById(input.runId);
      if (run.agentId !== 'thread' || run.parentRunId !== null) {
        throw new SessionError(
          'failed_precondition',
          'A delivery can only be injected into a persistent Thread root Run.',
        );
      }
      const interaction = this.getInteraction(run.ownerId, input.key);
      const delivery = this.getInteractionDelivery(run.ownerId, input.key);
      if (delivery.content !== input.message.content) {
        throw new SessionError('action_conflict', 'The injected delivery content does not match.');
      }
      if (delivery.status === 'consumed') {
        if (delivery.runId !== run.runId || delivery.contextMessageSeq === null) {
          throw new SessionError('internal', 'The consumed delivery state is inconsistent.');
        }
        const existing = this.context.get(
          delivery.replyThreadId,
          run.agentId,
          delivery.contextMessageSeq,
        );
        if (!existing || existing.message.content !== input.message.content) {
          throw new SessionError('internal', 'The consumed delivery Context is missing.');
        }
        return existing;
      }
      if (delivery.status !== 'queued' || delivery.runId !== run.runId) {
        throw new SessionError(
          'failed_precondition',
          'The delivery is not queued for this root Run.',
        );
      }
      const record = this.context.append({
        threadId: delivery.replyThreadId,
        agentId: run.agentId,
        runId: run.runId,
        source: interaction.kind === 'thread_call' ? 'thread_response' : 'subagent_response',
        delegation: input.key,
        sourceThreadId: interaction.targetThreadId,
        sourceAgentId: interaction.targetAgentId,
        message: input.message,
      });
      this.agentEnvironments.recordMessageBinding(run.threadId, run.agentId, record.seq, run);
      const now = isoTime(undefined, this.#clock);
      const consumed = this.database
        .prepare(
          `UPDATE interaction_deliveries SET status = 'consumed', context_message_seq = ?,
           consumed_at = ?, updated_at = ?
           WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?
             AND run_id = ? AND status = 'queued'`,
        )
        .run(
          record.seq,
          now,
          now,
          input.key.sourceThreadId,
          input.key.sourceAgentId,
          input.key.sourceToolCallId,
          run.runId,
        );
      if (consumed.changes !== 1) {
        throw new SessionError(
          'internal',
          'The interaction delivery state changed during injection.',
        );
      }
      if (record.supersededByRunId === null) {
        this.#insertEvent(run.threadId, { case: 'messageCommitted', value: { message: record } });
      }
      return record;
    });
  }

  getRun(ownerId: string, threadId: string, runId: string): RunRecord {
    this.getThread(ownerId, threadId);
    const run = this.getRunById(runId);
    if (run.threadId !== threadId || run.ownerId !== ownerId) {
      throw new SessionError('permission_denied', 'Run is not available to this owner.');
    }
    return run;
  }

  getRunById(runId: string): RunRecord {
    const row = this.database.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
    if (row === undefined) throw new SessionError('not_found', 'Run was not found.');
    return this.#toRun(runRowSchema.parse(row));
  }

  listRuns(ownerId: string, threadId: string): RunRecord[] {
    this.getThread(ownerId, threadId);
    return this.database
      .prepare('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at, rowid')
      .all(threadId)
      .map((row) => this.#toRun(runRowSchema.parse(row)));
  }

  getActiveRun(threadId: string): RunRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM runs
         WHERE thread_id = ? AND parent_run_id IS NULL AND agent_id = 'thread'
           AND status IN ('queued', 'running', 'waiting', 'cancel_requested')
         ORDER BY created_at, rowid LIMIT 1`,
      )
      .get(threadId);
    return row === undefined ? undefined : this.#toRun(runRowSchema.parse(row));
  }

  createChildRun(
    ownerId: string,
    parentRunId: string,
    agentId: string,
    executionMode: RunExecutionMode = 'foreground',
    environmentPolicy?: EnvironmentPolicyInput,
  ): RunRecord {
    return this.transaction(() => {
      const parent = this.getRun(ownerId, this.getRunById(parentRunId).threadId, parentRunId);
      if (parent.agentId !== 'thread' && !parent.agentId.startsWith('subagent-')) {
        throw new SessionError('failed_precondition', 'Invalid parent agent.');
      }
      if (this.agentEnvironments.getPolicy(parent.threadId, agentId)) {
        const running = this.listRuns(ownerId, parent.threadId).some(
          (run) => run.agentId === agentId && !isTerminalStatus(run.status),
        );
        if (running) {
          throw new SessionError(
            'failed_precondition',
            'A running Subagent cannot start another Run.',
          );
        }
      } else {
        this.#createSubagentPolicy(parent.ownerId, parent, agentId, environmentPolicy);
      }
      const run = this.#insertRun(
        parent.ownerId,
        parent.threadId,
        agentId,
        parent.runId,
        executionMode,
      );
      this.updateRunStatus(run.runId, 'running');
      return this.getRunById(run.runId);
    });
  }

  continueRun(action: ActionInput & { threadId: string; runId: string }): RunRecord {
    return this.#action(action, runResponseSchema, () => {
      const run = this.getRun(action.ownerId, action.threadId, action.runId);
      if (run.supersededByRunId !== null) {
        throw new SessionError('failed_precondition', 'A superseded Run cannot continue.');
      }
      if (!['failed', 'cancelled', 'interrupted'].includes(run.status)) {
        throw new SessionError(
          'failed_precondition',
          'Only a failed, cancelled or interrupted Run can continue.',
        );
      }
      const active = this.getActiveRun(action.threadId);
      if (active) {
        throw new SessionError('failed_precondition', 'Another Run is already active.');
      }
      this.#invalidateUndispatchedModelRequests(
        run.threadId,
        (runId) => runId !== run.runId,
        'Rebuilt for explicit Continue before Provider dispatch.',
      );
      this.database
        .prepare(
          "UPDATE runs SET status = 'queued', error_code = NULL, error_message = NULL, error_retryable = NULL, finished_at = NULL, execution_generation = execution_generation + 1, cancel_accepted_generation = NULL WHERE run_id = ?",
        )
        .run(run.runId);
      const updated = this.getRunById(run.runId);
      this.agentEnvironments.captureExecution(updated);
      this.#insertEvent(run.threadId, { case: 'runChanged', value: { run: updated } });
      return updated;
    });
  }

  requestCancelRun(
    action: ActionInput & { threadId: string; runId: string; reason: string },
  ): RunRecord {
    requireText(action.reason, 'reason', 1000);
    return this.#action(action, runResponseSchema, () => {
      const run = this.getRun(action.ownerId, action.threadId, action.runId);
      return this.#requestRunCancellation(run);
    });
  }

  updateRunStatus(runId: string, status: RunStatus, error?: RunError): RunRecord {
    return this.transaction(() => {
      const run = this.getRunById(runId);
      const now = isoTime(undefined, this.#clock);
      const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
      this.database
        .prepare(
          `UPDATE runs SET status = ?, error_code = ?, error_message = ?, error_retryable = ?,
           started_at = CASE WHEN ? IN ('running', 'waiting', 'cancel_requested') THEN COALESCE(started_at, ?) ELSE started_at END,
           finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE run_id = ?`,
        )
        .run(
          status,
          error?.code ?? null,
          error?.message ?? null,
          error === undefined ? null : error.retryable ? 1 : 0,
          status,
          now,
          terminal ? 1 : 0,
          now,
          runId,
        );
      const updated = this.getRunById(runId);
      if (
        updated.status !== run.status ||
        updated.error?.message !== run.error?.message ||
        updated.startedAt !== run.startedAt ||
        updated.finishedAt !== run.finishedAt
      ) {
        this.#insertEvent(run.threadId, { case: 'runChanged', value: { run: updated } });
      }
      return updated;
    });
  }

  updateRunUsage(runId: string, inputTokens: number, outputTokens: number): RunRecord {
    if (
      !Number.isSafeInteger(inputTokens) ||
      !Number.isSafeInteger(outputTokens) ||
      inputTokens < 0 ||
      outputTokens < 0
    ) {
      throw new SessionError('internal', 'Model usage must be non-negative safe integers.');
    }
    return this.transaction(() => {
      this.database
        .prepare(
          'UPDATE runs SET usage_input_tokens = ?, usage_output_tokens = ?, usage_reported = 1 WHERE run_id = ?',
        )
        .run(inputTokens, outputTokens, runId);
      const run = this.getRunById(runId);
      this.#insertEvent(run.threadId, { case: 'runChanged', value: { run } });
      return run;
    });
  }

  setCurrentRequestId(runId: string, requestId: string): void {
    this.transaction(() => {
      this.database
        .prepare('UPDATE runs SET current_request_id = ? WHERE run_id = ?')
        .run(requestId, runId);
    });
  }

  recordModelRequestPrepared(runId: string, requestId: string): void {
    this.transaction(() => this.#recordModelRequestEvidence(runId, requestId, 'prepared'));
  }

  recordModelRequestDispatched(runId: string, requestId: string): void {
    this.transaction(() => this.#recordModelRequestEvidence(runId, requestId, 'dispatched'));
  }

  #recordModelRequestEvidence(
    runId: string,
    requestId: string,
    evidence: 'prepared' | 'dispatched',
  ): void {
    const run = this.getRunById(runId);
    if (run.currentRequestId !== requestId) {
      throw new SessionError('version_conflict', 'The current model request changed.');
    }
    const request = z
      .object({
        thread_id: z.string(),
        agent_id: z.string(),
        status: z.enum(['preparing', 'ready', 'completed', 'failed', 'cancelled']),
      })
      .optional()
      .parse(
        this.database
          .prepare(
            'SELECT thread_id, agent_id, status FROM model_request_records WHERE request_id = ?',
          )
          .get(requestId),
      );
    if (
      !request ||
      request.thread_id !== run.threadId ||
      request.agent_id !== run.agentId ||
      request.status !== 'ready'
    ) {
      throw new SessionError('version_conflict', 'The model request is not ready for dispatch.');
    }
    const eventType = `model_request_${evidence}`;
    const payload = JSON.stringify({ request_id: requestId });
    const existing = this.database
      .prepare(
        `SELECT event_seq FROM context_events
         WHERE thread_id = ? AND agent_id = ? AND event_type = ? AND payload_json = ?`,
      )
      .get(run.threadId, run.agentId, eventType, payload);
    const modeEventId = modelExecutionModeEventId(run.runId, run.generation);
    const previousMode = readSendToUserMode(this.database, modeEventId, run.threadId, run.agentId);
    const enabled = requestUsesSendToUser(this.database, requestId);
    if (previousMode !== undefined && previousMode !== enabled) {
      throw new SessionError('version_conflict', 'The execution output mode changed.');
    }
    if (previousMode === undefined) {
      this.#recordOutputModeEvent(run, modeEventId, 'model_output_mode', {
        request_id: requestId,
        send_to_user_enabled: enabled,
      });
      this.#insertEvent(run.threadId, {
        case: 'runChanged',
        value: { run: this.getRunById(runId) },
      });
    }
    if (existing !== undefined) return;
    if (evidence === 'prepared') {
      this.agentEnvironments.recordRequestBinding(requestId, run.threadId, run.agentId, run);
    }
    this.database
      .prepare(
        `INSERT INTO context_events(
          event_id, thread_id, agent_id, event_type, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#createId(),
        run.threadId,
        run.agentId,
        eventType,
        payload,
        isoTime(undefined, this.#clock),
      );
  }

  #recordOutputModeEvent(
    run: RunRecord,
    eventId: string,
    eventType: 'model_output_mode' | 'model_response_mode',
    payload: { request_id: string; send_to_user_enabled: boolean; message_seq?: number },
  ): void {
    this.database
      .prepare(
        `INSERT INTO context_events(
          event_id, thread_id, agent_id, event_type, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        run.threadId,
        run.agentId,
        eventType,
        JSON.stringify({ run_id: run.runId, generation: run.generation, ...payload }),
        isoTime(undefined, this.#clock),
      );
  }

  invalidateModelRequestsForReload(
    threadId: string,
    isRunActive: (runId: string) => boolean,
  ): void {
    this.#invalidateUndispatchedModelRequests(
      threadId,
      isRunActive,
      'Invalidated by workspace resource reload before Provider dispatch.',
    );
  }

  #invalidateUndispatchedModelRequests(
    threadId: string,
    isRunActive: (runId: string) => boolean,
    reason: string,
  ): void {
    this.transaction(() => {
      const rows = z
        .array(
          z.object({
            run_id: z.string(),
            run_agent_id: z.string(),
            current_request_id: z.string(),
            request_thread_id: z.string(),
            request_agent_id: z.string(),
            request_status: z.enum(['preparing', 'ready', 'completed', 'failed', 'cancelled']),
          }),
        )
        .parse(
          this.database
            .prepare(
              `SELECT runs.run_id, runs.agent_id AS run_agent_id, runs.current_request_id,
                 requests.thread_id AS request_thread_id, requests.agent_id AS request_agent_id,
                 requests.status AS request_status
               FROM runs
               JOIN model_request_records AS requests
                 ON requests.request_id = runs.current_request_id
               WHERE runs.thread_id = ? AND runs.current_request_id IS NOT NULL
               ORDER BY runs.created_at, runs.rowid`,
            )
            .all(threadId),
        );
      for (const row of rows) {
        if (isRunActive(row.run_id)) continue;
        if (row.request_thread_id !== threadId || row.request_agent_id !== row.run_agent_id) {
          throw new SessionError('internal', 'The current model request owner is inconsistent.');
        }
        const manual = this.database
          .prepare('SELECT operation_id FROM manual_compact_operations WHERE operation_id = ?')
          .get(row.current_request_id);
        if (manual !== undefined || row.request_status === 'completed') continue;

        const payload = JSON.stringify({ request_id: row.current_request_id });
        const evidence = (eventType: 'model_request_prepared' | 'model_request_dispatched') =>
          this.database
            .prepare(
              `SELECT event_seq FROM context_events
               WHERE thread_id = ? AND agent_id = ? AND event_type = ? AND payload_json = ?`,
            )
            .get(threadId, row.request_agent_id, eventType, payload) !== undefined;
        const canCancelPreparing = row.request_status === 'preparing';
        const canCancelReady =
          row.request_status === 'ready' &&
          evidence('model_request_prepared') &&
          !evidence('model_request_dispatched');
        const canClearAssociation = ['failed', 'cancelled'].includes(row.request_status);
        if (!canCancelPreparing && !canCancelReady && !canClearAssociation) continue;

        if (canCancelPreparing || canCancelReady) {
          const cancelled = this.database
            .prepare(
              `UPDATE model_request_records SET status = 'cancelled', error_code = 'cancelled',
               error_message = ?, updated_at = ?
               WHERE request_id = ? AND status = ?`,
            )
            .run(
              reason,
              isoTime(undefined, this.#clock),
              row.current_request_id,
              row.request_status,
            );
          if (cancelled.changes !== 1) {
            throw new SessionError(
              'version_conflict',
              'The model request changed before rebuilding.',
            );
          }
        }
        const cleared = this.database
          .prepare(
            'UPDATE runs SET current_request_id = NULL WHERE run_id = ? AND current_request_id = ?',
          )
          .run(row.run_id, row.current_request_id);
        if (cleared.changes !== 1) {
          throw new SessionError(
            'version_conflict',
            'The current model request changed before rebuilding.',
          );
        }
      }
    });
  }

  recordEvent(threadId: string, payload: ThreadEventPayload): ThreadEventRecord {
    return this.transaction(() => this.#insertEvent(threadId, payload));
  }

  queueVersion(threadId: string): number {
    return this.#queue(threadId).queue_version;
  }

  latestEventSequence(threadId: string): number {
    const row = z
      .object({ last_event_seq: z.number().int().nonnegative() })
      .parse(
        this.database
          .prepare('SELECT last_event_seq FROM thread_event_retention WHERE thread_id = ?')
          .get(threadId),
      );
    return row.last_event_seq;
  }

  firstAvailableEventSequence(threadId: string): number {
    const row = z
      .object({ first_available_seq: z.number().int().positive() })
      .parse(
        this.database
          .prepare('SELECT first_available_seq FROM thread_event_retention WHERE thread_id = ?')
          .get(threadId),
      );
    return row.first_available_seq;
  }

  listEvents(threadId: string, afterSeq: bigint, limit = 500): ThreadEventRecord[] {
    if (afterSeq > BigInt(Number.MAX_SAFE_INTEGER)) return [];
    const rows = this.database
      .prepare(
        'SELECT event_id, thread_id, seq, occurred_at, payload_json FROM thread_events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      )
      .all(threadId, Number(afterSeq), limit);
    return rows.map((row) => this.#toEvent(eventRowSchema.parse(row)));
  }

  pruneEvents(threadId: string): void {
    const cutoff = new Date(this.#clock().getTime() - this.#eventRetentionMs).toISOString();
    this.transaction(() => {
      const expired = z
        .array(z.object({ seq: z.number().int().positive() }))
        .parse(
          this.database
            .prepare(
              'SELECT seq FROM thread_events WHERE thread_id = ? AND occurred_at < ? ORDER BY seq',
            )
            .all(threadId, cutoff),
        );
      if (expired.length === 0) return;
      this.database
        .prepare('DELETE FROM thread_events WHERE thread_id = ? AND occurred_at < ?')
        .run(threadId, cutoff);
      const firstAvailable = (expired.at(-1)?.seq ?? 0) + 1;
      this.database
        .prepare(
          'UPDATE thread_event_retention SET first_available_seq = MAX(first_available_seq, ?) WHERE thread_id = ?',
        )
        .run(firstAvailable, threadId);
    });
  }

  acceptThreadCall(input: AcceptThreadCallInput): AcceptedThreadCall {
    const prompt = requireText(input.prompt, 'prompt', 1_000_000, {
      maximumBytes: this.#maxInputBytes,
    });
    if (input.mode !== 'follow_up' && input.mode !== 'steer') {
      throw new SessionError('invalid_argument', 'Input mode is not supported.');
    }
    const requestedTargetThreadId = input.targetThreadId ?? '';
    if (
      requestedTargetThreadId !== '' &&
      (input.title !== undefined || input.environmentPolicy || input.workspaceId !== undefined)
    ) {
      throw new SessionError(
        'invalid_argument',
        'An existing Thread call accepts only thread_id, prompt and mode.',
      );
    }
    const title =
      input.title === undefined
        ? requestedTargetThreadId === ''
          ? '任务 Thread'
          : undefined
        : requireText(input.title, 'title', 200);
    const requestFingerprint = interactionFingerprint({
      targetThreadId: requestedTargetThreadId,
      ...(title === undefined ? {} : { title }),
      ...(input.environmentPolicy ? { environmentPolicy: input.environmentPolicy } : {}),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      prompt,
      mode: input.mode,
    });
    return this.transaction(() => {
      const existing = this.#findSourceInteraction(input);
      if (existing) {
        if (existing.kind !== 'thread_call' || existing.requestFingerprint !== requestFingerprint) {
          throw new SessionError(
            'action_conflict',
            'The source tool call ID was already used with different parameters.',
          );
        }
        if (!existing.targetInputId || !existing.acceptedRunId) {
          throw new SessionError('internal', 'The accepted Thread call is incomplete.');
        }
        return {
          interaction: existing,
          input: this.getInput(input.ownerId, existing.targetInputId),
          runId: existing.acceptedRunId,
        };
      }
      this.#assertInteractionSource(input);
      const sourceThread = this.getThread(input.ownerId, input.sourceThreadId);
      if (sourceThread.threadType !== 'main' && sourceThread.threadType !== 'workspace_main') {
        throw new SessionError(
          'permission_denied',
          'Thread calls require a main or workspace main root Agent.',
        );
      }
      const sourceWorkspaceId =
        sourceThread.threadType === 'workspace_main' ? sourceThread.workspaceId : null;
      if (
        sourceWorkspaceId !== null &&
        input.workspaceId !== undefined &&
        input.workspaceId !== sourceWorkspaceId
      ) {
        throw new SessionError(
          'permission_denied',
          'A workspace main can only create Threads in its own workspace.',
        );
      }
      const delegation = {
        sourceThreadId: input.sourceThreadId,
        sourceAgentId: input.sourceAgentId,
        sourceToolCallId: input.sourceToolCallId,
      };
      const target =
        requestedTargetThreadId === ''
          ? this.#insertThread(
              input.ownerId,
              'task',
              title ?? '任务 Thread',
              input.environmentPolicy,
              delegation,
              this.getRunById(input.sourceRunId),
              false,
              undefined,
              sourceWorkspaceId ?? input.workspaceId,
            )
          : this.getThread(input.ownerId, requestedTargetThreadId);
      if (
        (target.threadType !== 'task' && target.threadType !== 'workspace_main') ||
        target.automationOnly
      ) {
        throw new SessionError(
          'failed_precondition',
          'Thread calls require a normal persistent task Thread or a workspace main.',
        );
      }
      if (sourceWorkspaceId !== null && target.workspaceId !== sourceWorkspaceId) {
        throw new SessionError(
          'permission_denied',
          'A workspace main can only call Threads in its own workspace.',
        );
      }
      this.agentEnvironments.requirePolicy(target.threadId, 'thread');
      this.#assertQueueCapacity(target.threadId, 1);
      const active = this.getActiveRun(target.threadId);
      if (active?.status === 'cancel_requested') {
        throw new SessionError(
          'failed_precondition',
          'Cannot submit input after cancellation was requested.',
        );
      }
      const run = active ?? this.#insertRun(input.ownerId, target.threadId, 'thread');
      const targetInput = this.#insertInput(input.ownerId, target.threadId, prompt, input.mode, {
        source: 'thread_call',
        delegation,
        sourceThreadId: input.sourceThreadId,
        sourceAgentId: input.sourceAgentId,
      });
      const interaction = this.#insertInteraction({
        ...delegation,
        ownerId: input.ownerId,
        kind: 'thread_call',
        executionMode: 'background',
        sourceRunId: input.sourceRunId,
        requestFingerprint,
        prompt,
        targetThreadId: target.threadId,
        targetAgentId: 'thread',
        replyThreadId: input.sourceThreadId,
        targetInputId: targetInput.inputId,
        acceptedRunId: run.runId,
      });
      return { interaction, input: targetInput, runId: run.runId };
    });
  }

  createSubagentInteraction(input: CreateSubagentInteractionInput): InteractionRecord {
    const prompt = requireText(input.prompt, 'task', 1_000_000, {
      maximumBytes: this.#maxInputBytes,
    });
    const targetAgentId = requireText(input.targetAgentId, 'targetAgentId', 200);
    if (!targetAgentId.startsWith('subagent-')) {
      throw new SessionError('invalid_argument', 'A Subagent requires a temporary agent ID.');
    }
    const requestFingerprint = interactionFingerprint({
      prompt,
      executionMode: input.executionMode,
      ...(input.environmentPolicy ? { environmentPolicy: input.environmentPolicy } : {}),
    });
    return this.transaction(() => {
      const existing = this.#findSourceInteraction(input);
      if (existing) {
        if (existing.kind !== 'subagent' || existing.requestFingerprint !== requestFingerprint) {
          throw new SessionError(
            'action_conflict',
            'The source tool call ID was already used with different parameters.',
          );
        }
        return existing;
      }
      this.#assertInteractionSource(input);
      const interaction = this.#insertInteraction({
        ownerId: input.ownerId,
        kind: 'subagent',
        executionMode: input.executionMode,
        sourceThreadId: input.sourceThreadId,
        sourceAgentId: input.sourceAgentId,
        sourceRunId: input.sourceRunId,
        sourceToolCallId: input.sourceToolCallId,
        requestFingerprint,
        prompt,
        targetThreadId: input.sourceThreadId,
        targetAgentId,
        replyThreadId: input.sourceThreadId,
        targetInputId: null,
        acceptedRunId: null,
      });
      if (!this.agentEnvironments.getPolicy(input.sourceThreadId, targetAgentId)) {
        this.#createSubagentPolicy(
          input.ownerId,
          this.getRunById(input.sourceRunId),
          targetAgentId,
          input.environmentPolicy,
          interaction,
        );
      }
      return interaction;
    });
  }

  startSubagentInteraction(ownerId: string, key: DelegationKey, runId: string): InteractionRecord {
    return this.transaction(() => {
      const interaction = this.getInteraction(ownerId, key);
      if (isTerminalStatus(interaction.status)) {
        throw new SessionError(
          'failed_precondition',
          'A terminal Subagent cannot start a new Run.',
        );
      }
      const run = this.getRunById(runId);
      if (
        interaction.kind !== 'subagent' ||
        run.parentRunId !== interaction.sourceRunId ||
        run.threadId !== interaction.targetThreadId ||
        run.agentId !== interaction.targetAgentId ||
        run.executionMode !== interaction.executionMode
      ) {
        throw new SessionError(
          'failed_precondition',
          'The Subagent Run does not match its interaction.',
        );
      }
      if (interaction.consumedRunId !== null && interaction.consumedRunId !== run.runId) {
        throw new SessionError(
          'version_conflict',
          'The interaction already has a consumption Run.',
        );
      }
      const status = interaction.status === 'cancel_requested' ? 'cancel_requested' : 'running';
      this.database
        .prepare(
          `UPDATE interactions SET accepted_run_id = ?, consumed_run_id = ?, status = ?, updated_at = ?
           WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
        )
        .run(
          run.runId,
          run.runId,
          status,
          isoTime(undefined, this.#clock),
          key.sourceThreadId,
          key.sourceAgentId,
          key.sourceToolCallId,
        );
      return this.getInteraction(ownerId, key);
    });
  }

  getInteraction(ownerId: string, key: DelegationKey): InteractionRecord {
    const row = this.database
      .prepare(
        `SELECT * FROM interactions
         WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
      )
      .get(key.sourceThreadId, key.sourceAgentId, key.sourceToolCallId);
    if (row === undefined) throw new SessionError('not_found', 'Interaction was not found.');
    const interaction = this.#toInteraction(interactionRowSchema.parse(row));
    if (interaction.ownerId !== ownerId) {
      throw new SessionError('permission_denied', 'Interaction is not available to this owner.');
    }
    return interaction;
  }

  getInteractionForSource(
    ownerId: string,
    sourceThreadId: string,
    sourceAgentId: string,
    sourceToolCallId: string,
  ): InteractionRecord {
    return this.getInteraction(ownerId, { sourceThreadId, sourceAgentId, sourceToolCallId });
  }

  getInteractionResponse(ownerId: string, key: DelegationKey): ContextMessage | null {
    const interaction = this.getInteraction(ownerId, key);
    if (interaction.responseMessageSeq === null) return null;
    const response = this.context.get(
      interaction.targetThreadId,
      interaction.targetAgentId,
      interaction.responseMessageSeq,
    );
    if (!response) throw new SessionError('internal', 'The interaction response is missing.');
    return response;
  }

  getCurrentInteractionResponse(ownerId: string, key: DelegationKey): ContextMessage | null {
    const interaction = this.getInteraction(ownerId, key);
    if (
      !this.context.isCurrentToolCall(
        interaction.sourceThreadId,
        interaction.sourceAgentId,
        interaction.sourceToolCallId,
      )
    ) {
      return null;
    }
    return this.getInteractionResponse(ownerId, key);
  }

  recordInteractionResponses(input: {
    runId: string;
    messageId: string;
    interactionKeys: DelegationKey[];
  }): InteractionRecord[] {
    if (
      input.interactionKeys.length === 0 ||
      new Set(input.interactionKeys.map(delegationMapKey)).size !== input.interactionKeys.length
    ) {
      throw new SessionError(
        'invalid_argument',
        'A response boundary requires distinct delegation keys.',
      );
    }
    return this.transaction(() => {
      const run = this.getRunById(input.runId);
      const message = this.getContextMessage(run.ownerId, run.threadId, input.messageId);
      if (
        message.runId !== run.runId ||
        message.agentId !== run.agentId ||
        message.message.role !== 'assistant' ||
        (message.message.tool_calls?.length ?? 0) > 0 ||
        (message.message.incomplete_tool_calls?.length ?? 0) > 0
      ) {
        throw new SessionError(
          'failed_precondition',
          'An interaction response must be a final assistant message from its consumption Run.',
        );
      }
      return input.interactionKeys.map((key) => {
        const interaction = this.getInteraction(run.ownerId, key);
        if (
          interaction.consumedRunId !== run.runId ||
          interaction.targetThreadId !== run.threadId ||
          interaction.targetAgentId !== run.agentId
        ) {
          throw new SessionError(
            'failed_precondition',
            'The interaction was not consumed by this Run and agent.',
          );
        }
        if (interaction.responseMessageSeq !== null) {
          if (
            interaction.responseMessageSeq === message.seq &&
            interaction.status === 'completed'
          ) {
            return interaction;
          }
          throw new SessionError('version_conflict', 'The interaction already has a response.');
        }
        if (isTerminalStatus(interaction.status)) {
          throw new SessionError(
            'failed_precondition',
            'A terminal interaction cannot receive a later response.',
          );
        }
        const now = isoTime(undefined, this.#clock);
        this.database
          .prepare(
            `UPDATE interactions SET status = 'completed', response_message_seq = ?,
             error_code = NULL, error_message = NULL, error_retryable = NULL,
             updated_at = ?, finished_at = ?
             WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
          )
          .run(message.seq, now, now, key.sourceThreadId, key.sourceAgentId, key.sourceToolCallId);
        const completed = this.getInteraction(run.ownerId, key);
        this.#ensureInteractionDelivery(completed);
        return completed;
      });
    });
  }

  recordInteractionTerminal(input: {
    ownerId: string;
    key: DelegationKey;
    status: 'failed' | 'cancelled' | 'interrupted';
    error?: RunError;
  }): InteractionRecord {
    if (input.status !== 'cancelled' && input.error === undefined) {
      throw new SessionError(
        'invalid_argument',
        'A failed or interrupted interaction needs an error.',
      );
    }
    return this.transaction(() => {
      const interaction = this.getInteraction(input.ownerId, input.key);
      return this.#finishInteraction(interaction, input.status, input.error);
    });
  }

  acceptThreadNotification(input: AcceptThreadNotificationInput): AcceptedThreadNotification {
    const content = requireText(input.content, 'message', 20_000, {
      maximumBytes: this.#maxInputBytes,
    });
    const key = {
      sourceThreadId: input.sourceThreadId,
      sourceAgentId: input.sourceAgentId,
      sourceToolCallId: input.sourceToolCallId,
    };
    return this.transaction(() => {
      const existing = this.#findThreadNotification(key);
      if (existing) {
        if (
          existing.ownerId !== input.ownerId ||
          existing.sourceRunId !== input.sourceRunId ||
          existing.content !== content
        ) {
          throw new SessionError(
            'action_conflict',
            'The source tool call ID was already used with different parameters.',
          );
        }
        return { notification: existing, runId: existing.runId };
      }
      this.#assertThreadNotificationSource(input);
      const target = input.target ?? 'global';
      const replyThread =
        target === 'workspace'
          ? this.#workspaceMainThread(input.ownerId, input.sourceThreadId)
          : this.getOrCreateMainThread(input.ownerId);
      const now = isoTime(undefined, this.#clock);
      this.database
        .prepare(
          `INSERT INTO thread_notifications(
            source_thread_id, source_agent_id, source_tool_call_id, owner_id, source_run_id,
            reply_thread_id, target, content, delivery_content, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          key.sourceThreadId,
          key.sourceAgentId,
          key.sourceToolCallId,
          input.ownerId,
          input.sourceRunId,
          replyThread.threadId,
          target,
          content,
          threadNotificationDeliveryText(key, content),
          now,
          now,
        );
      const pending = this.getThreadNotification(input.ownerId, key);
      this.#insertThreadNotificationEvent(pending);
      const queued = this.enqueueThreadNotification({ ownerId: input.ownerId, key });
      return { notification: queued.notification, runId: queued.runId };
    });
  }

  getThreadNotification(ownerId: string, key: DelegationKey): ThreadNotificationRecord {
    const notification = this.#findThreadNotification(key);
    if (!notification) throw new SessionError('not_found', 'Thread notification was not found.');
    if (notification.ownerId !== ownerId) {
      throw new SessionError(
        'permission_denied',
        'Thread notification is not available to this owner.',
      );
    }
    return notification;
  }

  findThreadNotificationForToolResult(
    sourceRunId: string,
    sourceToolCallId: string,
  ): ThreadNotificationRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM thread_notifications
         WHERE source_run_id = ? AND source_tool_call_id = ?`,
      )
      .get(sourceRunId, sourceToolCallId);
    return row === undefined
      ? undefined
      : this.#toThreadNotification(threadNotificationRowSchema.parse(row));
  }

  listUndeliveredThreadNotifications(ownerId: string): ThreadNotificationRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM thread_notifications
         WHERE owner_id = ? AND status IN ('pending', 'queued')
         ORDER BY created_at, source_thread_id, source_agent_id, source_tool_call_id`,
      )
      .all(ownerId)
      .map((row) => this.#toThreadNotification(threadNotificationRowSchema.parse(row)));
  }

  listThreadNotificationsForRun(runId: string): ThreadNotificationRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM thread_notifications
         WHERE run_id = ? AND status = 'queued'
         ORDER BY created_at, source_thread_id, source_agent_id, source_tool_call_id`,
      )
      .all(runId)
      .map((row) => this.#toThreadNotification(threadNotificationRowSchema.parse(row)));
  }

  listThreadSnapshotNotifications(
    ownerId: string,
    threadId: string,
    position: SnapshotCollectionPosition,
    limit: number,
  ): SnapshotRecord<ThreadNotificationRecord>[] {
    this.getThread(ownerId, threadId);
    const range = snapshotRange(position);
    if (!range) return [];
    const rows = z
      .array(threadNotificationRowSchema.extend({ snapshot_cursor: z.number().int().positive() }))
      .parse(
        this.database
          .prepare(
            `SELECT rowid AS snapshot_cursor, * FROM thread_notifications
             WHERE owner_id = ? AND source_thread_id = ? AND source_agent_id = 'thread'
               AND rowid > ? AND rowid <= ?
             ORDER BY rowid LIMIT ?`,
          )
          .all(ownerId, threadId, range.after, range.maximum, limit),
      );
    return rows.map((row) => ({
      cursor: BigInt(row.snapshot_cursor),
      value: this.#toThreadNotification(threadNotificationRowSchema.parse(row)),
    }));
  }

  enqueueThreadNotification(input: { ownerId: string; key: DelegationKey }): {
    notification: ThreadNotificationRecord;
    runId: string | null;
  } {
    return this.transaction(() => {
      const current = this.getThreadNotification(input.ownerId, input.key);
      const expectedContent = threadNotificationDeliveryText(input.key, current.content);
      if (current.deliveryContent !== expectedContent) {
        throw new SessionError('internal', 'The thread notification content is inconsistent.');
      }
      if (current.status === 'consumed') {
        return { notification: current, runId: current.runId };
      }
      const sourceCurrent = this.context.isCurrentToolCall(
        current.sourceThreadId,
        current.sourceAgentId,
        current.sourceToolCallId,
      );
      if (current.status === 'superseded' || !sourceCurrent) {
        if (current.status !== 'superseded') {
          this.database
            .prepare(
              `UPDATE thread_notifications SET status = 'superseded', updated_at = ?
               WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
            )
            .run(
              isoTime(undefined, this.#clock),
              input.key.sourceThreadId,
              input.key.sourceAgentId,
              input.key.sourceToolCallId,
            );
          this.#insertThreadNotificationEvent(this.getThreadNotification(input.ownerId, input.key));
        }
        return { notification: this.getThreadNotification(input.ownerId, input.key), runId: null };
      }
      const replyThread = this.getThread(input.ownerId, current.replyThreadId);
      if (replyThread.threadType !== 'main' && replyThread.threadType !== 'workspace_main') {
        throw new SessionError(
          'internal',
          'The thread notification target is not a main conversation.',
        );
      }
      const run =
        this.getActiveRun(replyThread.threadId) ??
        this.#insertRun(input.ownerId, replyThread.threadId, 'thread');
      const now = isoTime(undefined, this.#clock);
      this.database
        .prepare(
          `UPDATE thread_notifications SET status = 'queued', run_id = ?,
           queued_at = COALESCE(queued_at, ?), updated_at = ?
           WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?
             AND status IN ('pending', 'queued')`,
        )
        .run(
          run.runId,
          now,
          now,
          input.key.sourceThreadId,
          input.key.sourceAgentId,
          input.key.sourceToolCallId,
        );
      const queued = this.getThreadNotification(input.ownerId, input.key);
      if (
        queued.status !== current.status ||
        queued.runId !== current.runId ||
        queued.updatedAt !== current.updatedAt
      ) {
        this.#insertThreadNotificationEvent(queued);
      }
      return { notification: queued, runId: run.runId };
    });
  }

  appendThreadNotificationMessage(input: {
    runId: string;
    key: DelegationKey;
    message: { role: 'user'; content: string };
  }): ContextMessage {
    return this.transaction(() => {
      const run = this.getRunById(input.runId);
      if (run.agentId !== 'thread' || run.parentRunId !== null) {
        throw new SessionError(
          'failed_precondition',
          'A notification can only be injected into a persistent Thread root Run.',
        );
      }
      const notification = this.getThreadNotification(run.ownerId, input.key);
      if (
        notification.replyThreadId !== run.threadId ||
        notification.deliveryContent !== input.message.content
      ) {
        throw new SessionError('action_conflict', 'The injected notification does not match.');
      }
      if (notification.status === 'consumed') {
        if (notification.runId !== run.runId || notification.contextMessageSeq === null) {
          throw new SessionError('internal', 'The consumed notification state is inconsistent.');
        }
        const existing = this.context.get(
          notification.replyThreadId,
          run.agentId,
          notification.contextMessageSeq,
        );
        if (!existing || existing.message.content !== input.message.content) {
          throw new SessionError('internal', 'The consumed notification Context is missing.');
        }
        return existing;
      }
      if (notification.status !== 'queued' || notification.runId !== run.runId) {
        throw new SessionError(
          'failed_precondition',
          'The notification is not queued for this root Run.',
        );
      }
      const record = this.context.append({
        threadId: notification.replyThreadId,
        agentId: run.agentId,
        runId: run.runId,
        source: 'thread_notification',
        delegation: input.key,
        sourceThreadId: notification.sourceThreadId,
        sourceAgentId: notification.sourceAgentId,
        message: input.message,
      });
      this.agentEnvironments.recordMessageBinding(run.threadId, run.agentId, record.seq, run);
      const now = isoTime(undefined, this.#clock);
      const consumed = this.database
        .prepare(
          `UPDATE thread_notifications SET status = 'consumed', context_message_seq = ?,
           consumed_at = ?, updated_at = ?
           WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?
             AND run_id = ? AND status = 'queued'`,
        )
        .run(
          record.seq,
          now,
          now,
          input.key.sourceThreadId,
          input.key.sourceAgentId,
          input.key.sourceToolCallId,
          run.runId,
        );
      if (consumed.changes !== 1) {
        throw new SessionError('internal', 'The notification state changed during injection.');
      }
      if (record.supersededByRunId === null) {
        this.#insertEvent(run.threadId, { case: 'messageCommitted', value: { message: record } });
      }
      this.#insertThreadNotificationEvent(this.getThreadNotification(run.ownerId, input.key));
      return record;
    });
  }

  #findThreadNotification(key: DelegationKey): ThreadNotificationRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM thread_notifications
         WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
      )
      .get(key.sourceThreadId, key.sourceAgentId, key.sourceToolCallId);
    return row === undefined
      ? undefined
      : this.#toThreadNotification(threadNotificationRowSchema.parse(row));
  }

  #assertThreadNotificationSource(input: AcceptThreadNotificationInput): void {
    requireText(input.sourceAgentId, 'sourceAgentId', 200);
    requireText(input.sourceToolCallId, 'sourceToolCallId', 200);
    if (input.sourceAgentId !== 'thread') {
      throw new SessionError(
        'permission_denied',
        'thread_notify requires a persistent task Thread root Agent.',
      );
    }
    const sourceThread = this.getThread(input.ownerId, input.sourceThreadId);
    const allowedSource =
      (sourceThread.threadType === 'task' && !sourceThread.automationOnly) ||
      sourceThread.threadType === 'workspace_main';
    if (!allowedSource) {
      throw new SessionError(
        'permission_denied',
        'thread_notify requires a normal persistent task Thread or workspace main root Agent.',
      );
    }
    const sourceRun = this.getRunById(input.sourceRunId);
    if (
      sourceRun.ownerId !== input.ownerId ||
      sourceRun.threadId !== input.sourceThreadId ||
      sourceRun.agentId !== input.sourceAgentId ||
      sourceRun.parentRunId !== null
    ) {
      throw new SessionError('permission_denied', 'The source Run does not match the caller.');
    }
    const call = z.object({ tool_name: z.string() }).parse(
      this.database
        .prepare(
          `SELECT tool_name FROM context_tool_calls
             WHERE thread_id = ? AND agent_id = ? AND call_id = ?`,
        )
        .get(input.sourceThreadId, input.sourceAgentId, input.sourceToolCallId),
    );
    if (call.tool_name !== 'thread_notify') {
      throw new SessionError(
        'permission_denied',
        'The notification source is not a persisted thread_notify tool call.',
      );
    }
  }

  #insertThreadNotificationEvent(notification: ThreadNotificationRecord): void {
    this.#insertEvent(notification.sourceThreadId, {
      case: 'threadNotificationChanged',
      value: { notification },
    });
  }

  getInteractionDelivery(ownerId: string, key: DelegationKey): InteractionDeliveryRecord {
    const row = this.database
      .prepare(
        `SELECT * FROM interaction_deliveries
         WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
      )
      .get(key.sourceThreadId, key.sourceAgentId, key.sourceToolCallId);
    if (row === undefined)
      throw new SessionError('not_found', 'Interaction delivery was not found.');
    const delivery = this.#toDelivery(deliveryRowSchema.parse(row));
    if (delivery.ownerId !== ownerId) {
      throw new SessionError(
        'permission_denied',
        'Interaction delivery is not available to this owner.',
      );
    }
    return delivery;
  }

  listUndeliveredInteractionDeliveries(ownerId: string): InteractionDeliveryRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM interaction_deliveries
         WHERE owner_id = ? AND status IN ('pending', 'queued')
         ORDER BY created_at, source_thread_id, source_agent_id, source_tool_call_id`,
      )
      .all(ownerId)
      .map((row) => this.#toDelivery(deliveryRowSchema.parse(row)));
  }

  createBackgroundTask(input: {
    taskId: string;
    ownerId: string;
    threadId: string;
    agentId: string;
    runId: string;
    sourceToolCallId: string;
    kind: BackgroundTaskKind;
    description: string;
    operationId?: string;
  }): BackgroundTaskRecord {
    const description = requireText(input.description, 'description', 2000);
    return this.transaction(() => {
      const now = isoTime(undefined, this.#clock);
      this.database
        .prepare(
          `INSERT INTO background_tasks(
            task_id, owner_id, thread_id, agent_id, run_id, source_tool_call_id, kind,
            description, operation_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(
          input.taskId,
          input.ownerId,
          input.threadId,
          input.agentId,
          input.runId,
          input.sourceToolCallId,
          input.kind,
          description,
          input.operationId ?? null,
          now,
          now,
        );
      return this.getBackgroundTask(input.ownerId, input.taskId);
    });
  }

  getBackgroundTask(ownerId: string, taskId: string): BackgroundTaskRecord {
    const row = this.database
      .prepare('SELECT * FROM background_tasks WHERE task_id = ?')
      .get(taskId);
    if (row === undefined) {
      throw new SessionError('not_found', 'The background task was not found.');
    }
    const task = this.#toBackgroundTask(backgroundTaskRowSchema.parse(row));
    if (task.ownerId !== ownerId) {
      throw new SessionError('not_found', 'The background task was not found.');
    }
    return task;
  }

  listBackgroundTasks(
    ownerId: string,
    threadId: string,
    agentId: string,
    limit = 50,
  ): BackgroundTaskRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM background_tasks
         WHERE owner_id = ? AND thread_id = ? AND agent_id = ?
         ORDER BY created_at DESC, task_id DESC LIMIT ?`,
      )
      .all(ownerId, threadId, agentId, limit)
      .map((row) => this.#toBackgroundTask(backgroundTaskRowSchema.parse(row)));
  }

  listRunningBackgroundTasks(): BackgroundTaskRecord[] {
    return this.database
      .prepare("SELECT * FROM background_tasks WHERE status = 'running' ORDER BY created_at")
      .all()
      .map((row) => this.#toBackgroundTask(backgroundTaskRowSchema.parse(row)));
  }

  completeBackgroundTask(input: {
    taskId: string;
    status: Exclude<BackgroundTaskStatus, 'running'>;
    resultText: string;
  }): BackgroundTaskRecord {
    return this.transaction(() => {
      const now = isoTime(undefined, this.#clock);
      this.database
        .prepare(
          `UPDATE background_tasks SET status = ?, result_text = ?, ended_at = ?, updated_at = ?
           WHERE task_id = ? AND status = 'running'`,
        )
        .run(input.status, input.resultText, now, now, input.taskId);
      const row = this.database
        .prepare('SELECT * FROM background_tasks WHERE task_id = ?')
        .get(input.taskId);
      if (row === undefined) {
        throw new SessionError('not_found', 'The background task was not found.');
      }
      return this.#toBackgroundTask(backgroundTaskRowSchema.parse(row));
    });
  }

  markBackgroundTaskKilled(taskId: string): BackgroundTaskRecord {
    return this.transaction(() => {
      const now = isoTime(undefined, this.#clock);
      this.database
        .prepare(
          `UPDATE background_tasks SET status = 'killed', ended_at = COALESCE(ended_at, ?),
           updated_at = ? WHERE task_id = ? AND status = 'running'`,
        )
        .run(now, now, taskId);
      const row = this.database
        .prepare('SELECT * FROM background_tasks WHERE task_id = ?')
        .get(taskId);
      if (row === undefined) {
        throw new SessionError('not_found', 'The background task was not found.');
      }
      return this.#toBackgroundTask(backgroundTaskRowSchema.parse(row));
    });
  }

  enqueueBackgroundTaskDelivery(input: { ownerId: string; taskId: string; text: string }): {
    task: BackgroundTaskRecord;
    runId: string | null;
  } {
    const text = requireText(input.text, 'text', 1_000_000, {
      maximumBytes: this.#maxInputBytes,
    });
    return this.transaction(() => {
      const task = this.getBackgroundTask(input.ownerId, input.taskId);
      if (task.status === 'running') {
        throw new SessionError(
          'failed_precondition',
          'Only a terminal background task can be delivered.',
        );
      }
      if (task.deliveryStatus === 'consumed') {
        return { task, runId: task.deliveryRunId };
      }
      if (task.deliveryContent !== null && task.deliveryContent !== text) {
        throw new SessionError(
          'action_conflict',
          'The background task delivery was already created with different content.',
        );
      }
      const replyThread = this.getThread(input.ownerId, task.threadId);
      const run =
        this.getActiveRun(replyThread.threadId) ??
        this.#insertRun(input.ownerId, replyThread.threadId, 'thread');
      const now = isoTime(undefined, this.#clock);
      this.database
        .prepare(
          `UPDATE background_tasks SET delivery_status = 'queued', delivery_content = ?,
           delivery_run_id = ?, updated_at = ?
           WHERE task_id = ? AND delivery_status IN ('pending', 'queued')`,
        )
        .run(text, run.runId, now, input.taskId);
      return { task: this.getBackgroundTask(input.ownerId, input.taskId), runId: run.runId };
    });
  }

  listBackgroundSubagentInteractions(
    ownerId: string,
    threadId: string,
    agentId: string,
    limit: number,
  ): InteractionRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM interactions
         WHERE owner_id = ? AND source_thread_id = ? AND source_agent_id = ?
           AND kind = 'subagent' AND execution_mode = 'background'
         ORDER BY created_at DESC, source_tool_call_id DESC LIMIT ?`,
      )
      .all(ownerId, threadId, agentId, limit)
      .map((row) => this.#toInteraction(interactionRowSchema.parse(row)));
  }

  listBackgroundTaskDeliveriesForRun(runId: string): BackgroundTaskRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM background_tasks
         WHERE delivery_run_id = ? AND delivery_status = 'queued'
         ORDER BY created_at, task_id`,
      )
      .all(runId)
      .map((row) => this.#toBackgroundTask(backgroundTaskRowSchema.parse(row)));
  }

  listUndeliveredBackgroundTaskDeliveries(ownerId: string): BackgroundTaskRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM background_tasks
         WHERE owner_id = ? AND status <> 'running' AND delivery_status <> 'consumed'
         ORDER BY created_at, task_id`,
      )
      .all(ownerId)
      .map((row) => this.#toBackgroundTask(backgroundTaskRowSchema.parse(row)));
  }

  appendBackgroundTaskDeliveryMessage(input: {
    runId: string;
    taskId: string;
    message: { role: 'user'; content: string };
  }): ContextMessage {
    return this.transaction(() => {
      const run = this.getRunById(input.runId);
      if (run.agentId !== 'thread' || run.parentRunId !== null) {
        throw new SessionError(
          'failed_precondition',
          'A background task delivery can only be injected into a persistent Thread root Run.',
        );
      }
      const task = this.getBackgroundTask(run.ownerId, input.taskId);
      if (task.deliveryContent !== input.message.content) {
        throw new SessionError(
          'action_conflict',
          'The injected background task delivery content does not match.',
        );
      }
      if (task.deliveryStatus === 'consumed') {
        if (task.deliveryRunId !== run.runId || task.contextMessageSeq === null) {
          throw new SessionError('internal', 'The consumed delivery state is inconsistent.');
        }
        const existing = this.context.get(task.threadId, 'thread', task.contextMessageSeq);
        if (!existing || existing.message.content !== input.message.content) {
          throw new SessionError('internal', 'The consumed delivery Context is missing.');
        }
        return existing;
      }
      if (task.deliveryStatus !== 'queued' || task.deliveryRunId !== run.runId) {
        throw new SessionError(
          'failed_precondition',
          'The background task delivery is not queued for this root Run.',
        );
      }
      const record = this.context.append({
        threadId: task.threadId,
        agentId: 'thread',
        runId: run.runId,
        source: 'background_task',
        delegation: {
          sourceThreadId: task.threadId,
          sourceAgentId: task.agentId,
          sourceToolCallId: task.sourceToolCallId,
        },
        sourceThreadId: task.threadId,
        sourceAgentId: task.agentId,
        message: input.message,
      });
      this.agentEnvironments.recordMessageBinding(run.threadId, run.agentId, record.seq, run);
      const now = isoTime(undefined, this.#clock);
      const consumed = this.database
        .prepare(
          `UPDATE background_tasks SET delivery_status = 'consumed', context_message_seq = ?,
           consumed_at = ?, updated_at = ?
           WHERE task_id = ? AND delivery_run_id = ? AND delivery_status = 'queued'`,
        )
        .run(record.seq, now, now, input.taskId, run.runId);
      if (consumed.changes !== 1) {
        throw new SessionError(
          'internal',
          'The background task delivery state changed during injection.',
        );
      }
      if (record.supersededByRunId === null) {
        this.#insertEvent(run.threadId, { case: 'messageCommitted', value: { message: record } });
      }
      return record;
    });
  }

  listInteractionDeliveriesForRun(runId: string): InteractionDeliveryRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM interaction_deliveries
         WHERE run_id = ? AND status = 'queued'
         ORDER BY created_at, source_thread_id, source_agent_id, source_tool_call_id`,
      )
      .all(runId)
      .map((row) => this.#toDelivery(deliveryRowSchema.parse(row)));
  }

  enqueueInteractionDelivery(input: { ownerId: string; key: DelegationKey; text: string }): {
    delivery: InteractionDeliveryRecord;
    runId: string | null;
  } {
    const text = requireText(input.text, 'text', 1_000_000, {
      maximumBytes: this.#maxInputBytes,
    });
    return this.transaction(() => {
      const interaction = this.getInteraction(input.ownerId, input.key);
      if (interaction.executionMode !== 'background' || !isTerminalStatus(interaction.status)) {
        throw new SessionError(
          'failed_precondition',
          'Only a terminal background interaction can be delivered.',
        );
      }
      const current = this.getInteractionDelivery(input.ownerId, input.key);
      if (current.content !== null && current.content !== text) {
        throw new SessionError(
          'action_conflict',
          'The interaction delivery was already created with different content.',
        );
      }
      if (current.status === 'consumed') {
        return { delivery: current, runId: current.runId };
      }
      const sourceCurrent = this.context.isCurrentToolCall(
        interaction.sourceThreadId,
        interaction.sourceAgentId,
        interaction.sourceToolCallId,
      );
      if (current.status === 'superseded' || !sourceCurrent) {
        const now = isoTime(undefined, this.#clock);
        if (current.status !== 'superseded') {
          this.database
            .prepare(
              `UPDATE interaction_deliveries SET status = 'superseded', updated_at = ?
               WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
            )
            .run(
              now,
              input.key.sourceThreadId,
              input.key.sourceAgentId,
              input.key.sourceToolCallId,
            );
        }
        return { delivery: this.getInteractionDelivery(input.ownerId, input.key), runId: null };
      }
      const replyThread = this.getThread(input.ownerId, interaction.replyThreadId);
      const run =
        this.getActiveRun(replyThread.threadId) ??
        this.#insertRun(input.ownerId, replyThread.threadId, 'thread');
      const now = isoTime(undefined, this.#clock);
      this.database
        .prepare(
          `UPDATE interaction_deliveries SET status = 'queued', content = ?, run_id = ?,
           queued_at = COALESCE(queued_at, ?), updated_at = ?
           WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?
             AND status IN ('pending', 'queued')`,
        )
        .run(
          text,
          run.runId,
          now,
          now,
          input.key.sourceThreadId,
          input.key.sourceAgentId,
          input.key.sourceToolCallId,
        );
      return {
        delivery: this.getInteractionDelivery(input.ownerId, input.key),
        runId: run.runId,
      };
    });
  }

  requestInteractionCancel(input: { ownerId: string; key: DelegationKey; reason: string }): {
    interaction: InteractionRecord;
    run: RunRecord | null;
    input: InputRecord | null;
  } {
    requireText(input.reason, 'reason', 1000);
    return this.transaction(() => {
      const current = this.getInteraction(input.ownerId, input.key);
      if (isTerminalStatus(current.status)) {
        return {
          interaction: current,
          run: current.consumedRunId === null ? null : this.getRunById(current.consumedRunId),
          input:
            current.targetInputId === null
              ? null
              : this.getInput(input.ownerId, current.targetInputId),
        };
      }
      const now = isoTime(undefined, this.#clock);
      this.database
        .prepare(
          `UPDATE interactions SET status = 'cancel_requested',
           cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ?
           WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
        )
        .run(
          now,
          now,
          input.key.sourceThreadId,
          input.key.sourceAgentId,
          input.key.sourceToolCallId,
        );
      let targetInput =
        current.targetInputId === null ? null : this.getInput(input.ownerId, current.targetInputId);
      let run: RunRecord | null = null;
      if (targetInput?.status === 'queued') {
        const queueVersion = this.#nextQueueVersion(
          targetInput.threadId,
          this.#queue(targetInput.threadId).queue_version,
        );
        this.database
          .prepare(
            "UPDATE inputs SET status = 'cancelled', version = version + 1, updated_at = ? WHERE input_id = ?",
          )
          .run(now, targetInput.inputId);
        targetInput = this.getInput(input.ownerId, targetInput.inputId);
        this.#insertEvent(targetInput.threadId, {
          case: 'inputRemoved',
          value: { input: targetInput, queueVersion },
        });
        this.#finishInteraction(this.getInteraction(input.ownerId, input.key), 'cancelled');
      } else if (current.consumedRunId !== null) {
        run = this.getRunById(current.consumedRunId);
        if (isTerminalStatus(run.status)) {
          this.#finishInteraction(this.getInteraction(input.ownerId, input.key), 'cancelled');
        } else {
          run = this.#requestRunCancellation(run);
        }
      } else {
        this.#finishInteraction(this.getInteraction(input.ownerId, input.key), 'cancelled');
      }
      return {
        interaction: this.getInteraction(input.ownerId, input.key),
        run,
        input: targetInput,
      };
    });
  }

  recoverInterrupted(): RunRecord[] {
    return this.transaction(() => {
      const rows = this.database
        .prepare(
          "SELECT run_id FROM runs WHERE status IN ('queued', 'running', 'waiting', 'cancel_requested') ORDER BY created_at, rowid",
        )
        .all();
      const ids = z.array(z.object({ run_id: z.string() })).parse(rows);
      const recovered: RunRecord[] = [];
      for (const { run_id: runId } of ids) {
        const error = {
          code: 'operation_unknown' as const,
          message: 'Server restarted while this Run was active; reconciliation is required.',
          retryable: true,
        };
        recovered.push(this.updateRunStatus(runId, 'interrupted', error));
        const interactions = this.database
          .prepare('SELECT * FROM interactions WHERE consumed_run_id = ?')
          .all(runId)
          .map((row) => this.#toInteraction(interactionRowSchema.parse(row)));
        for (const interaction of interactions) {
          if (!isTerminalStatus(interaction.status)) {
            this.#finishInteraction(interaction, 'interrupted', error);
          }
        }
      }
      return recovered;
    });
  }

  recordServerBashOperation(input: {
    operationId: string;
    runId: string;
    toolCallId: string;
    logPath: string | null;
    outputComplete: boolean;
    endOffset: bigint;
    expiresAt: string | null;
    content?: string;
    status?: 'success' | 'error';
  }): ServerBashOperationRecord {
    return this.transaction(() => {
      const run = this.getRunById(input.runId);
      const now = isoTime(undefined, this.#clock);
      this.database
        .prepare(
          `INSERT INTO server_bash_operations(
            operation_id, owner_id, thread_id, run_id, tool_call_id, log_path,
            output_complete, end_offset, expires_at, content, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(operation_id) DO UPDATE SET
            log_path = excluded.log_path, output_complete = excluded.output_complete,
            end_offset = excluded.end_offset, expires_at = excluded.expires_at,
            content = excluded.content, status = excluded.status,
            updated_at = excluded.updated_at`,
        )
        .run(
          input.operationId,
          run.ownerId,
          run.threadId,
          run.runId,
          input.toolCallId,
          input.logPath,
          input.outputComplete ? 1 : 0,
          input.endOffset.toString(),
          input.expiresAt,
          input.content ?? null,
          input.status ?? null,
          now,
          now,
        );
      return this.getServerBashOperation(run.ownerId, input.operationId);
    });
  }

  getServerBashOperation(ownerId: string, operationId: string): ServerBashOperationRecord {
    const row = this.database
      .prepare('SELECT * FROM server_bash_operations WHERE operation_id = ?')
      .get(operationId);
    if (row === undefined) throw new SessionError('not_found', 'Bash operation was not found.');
    const operation = this.#toServerBashOperation(serverBashRowSchema.parse(row));
    if (operation.ownerId !== ownerId) {
      throw new SessionError('permission_denied', 'Bash operation is not available to this owner.');
    }
    return operation;
  }

  #findSourceInteraction(input: {
    ownerId: string;
    sourceThreadId: string;
    sourceAgentId: string;
    sourceToolCallId: string;
  }): InteractionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM interactions
         WHERE owner_id = ? AND source_thread_id = ? AND source_agent_id = ?
           AND source_tool_call_id = ?`,
      )
      .get(input.ownerId, input.sourceThreadId, input.sourceAgentId, input.sourceToolCallId);
    return row === undefined ? undefined : this.#toInteraction(interactionRowSchema.parse(row));
  }

  #assertInteractionSource(
    input: {
      ownerId: string;
      sourceThreadId: string;
      sourceAgentId: string;
      sourceRunId: string;
      sourceToolCallId: string;
    },
    requiredThreadType?: ThreadRecord['threadType'],
  ): void {
    requireText(input.sourceAgentId, 'sourceAgentId', 200);
    requireText(input.sourceToolCallId, 'sourceToolCallId', 200);
    if (input.sourceAgentId !== 'thread') {
      throw new SessionError('permission_denied', 'Only a persistent root Agent can delegate.');
    }
    const sourceThread = this.getThread(input.ownerId, input.sourceThreadId);
    if (requiredThreadType !== undefined && sourceThread.threadType !== requiredThreadType) {
      throw new SessionError(
        'permission_denied',
        'This Thread cannot manage the requested interaction.',
      );
    }
    const sourceRun = this.getRunById(input.sourceRunId);
    if (
      sourceRun.ownerId !== input.ownerId ||
      sourceRun.threadId !== input.sourceThreadId ||
      sourceRun.agentId !== input.sourceAgentId
    ) {
      throw new SessionError('permission_denied', 'The source Run does not match the caller.');
    }
  }

  #createSubagentPolicy(
    ownerId: string,
    parentRun: RunRecord,
    targetAgentId: string,
    environmentPolicy?: EnvironmentPolicyInput,
    delegation?: DelegationKey,
  ): void {
    this.agentEnvironments.requirePolicy(parentRun.threadId, parentRun.agentId);
    this.agentEnvironments.createPolicy({
      ownerId,
      threadId: parentRun.threadId,
      agentId: targetAgentId,
      ...(environmentPolicy ? { policy: environmentPolicy } : {}),
      parentRun,
      ...(delegation ? { delegation } : {}),
    });
  }

  #insertInteraction(input: {
    ownerId: string;
    kind: InteractionRecord['kind'];
    executionMode: RunExecutionMode;
    sourceThreadId: string;
    sourceAgentId: string;
    sourceRunId: string;
    sourceToolCallId: string;
    requestFingerprint: string;
    prompt: string;
    targetThreadId: string;
    targetAgentId: string;
    replyThreadId: string;
    targetInputId: string | null;
    acceptedRunId: string | null;
  }): InteractionRecord {
    const now = isoTime(undefined, this.#clock);
    this.database
      .prepare(
        `INSERT INTO interactions(
          owner_id, kind, execution_mode, source_thread_id, source_agent_id,
          source_run_id, source_tool_call_id, request_fingerprint, prompt, target_thread_id,
          target_agent_id, reply_thread_id, target_input_id, accepted_run_id, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        input.ownerId,
        input.kind,
        input.executionMode,
        input.sourceThreadId,
        input.sourceAgentId,
        input.sourceRunId,
        input.sourceToolCallId,
        input.requestFingerprint,
        input.prompt,
        input.targetThreadId,
        input.targetAgentId,
        input.replyThreadId,
        input.targetInputId,
        input.acceptedRunId,
        now,
        now,
      );
    return this.getInteraction(input.ownerId, input);
  }

  #finishInteraction(
    interaction: InteractionRecord,
    status: 'failed' | 'cancelled' | 'interrupted',
    error?: RunError,
  ): InteractionRecord {
    if (isTerminalStatus(interaction.status)) {
      if (interaction.status === status) return interaction;
      throw new SessionError(
        'failed_precondition',
        'The interaction already has a terminal state.',
      );
    }
    const now = isoTime(undefined, this.#clock);
    if (interaction.targetInputId !== null) {
      const targetInput = this.getInput(interaction.ownerId, interaction.targetInputId);
      if (targetInput.status === 'queued') {
        const queueVersion = this.#nextQueueVersion(
          targetInput.threadId,
          this.#queue(targetInput.threadId).queue_version,
        );
        this.database
          .prepare(
            "UPDATE inputs SET status = 'cancelled', version = version + 1, updated_at = ? WHERE input_id = ?",
          )
          .run(now, targetInput.inputId);
        this.#insertEvent(targetInput.threadId, {
          case: 'inputRemoved',
          value: {
            input: this.getInput(interaction.ownerId, targetInput.inputId),
            queueVersion,
          },
        });
      }
    }
    this.database
      .prepare(
        `UPDATE interactions SET status = ?, response_message_seq = NULL,
         error_code = ?, error_message = ?, error_retryable = ?, updated_at = ?, finished_at = ?
         WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
      )
      .run(
        status,
        error?.code ?? null,
        error?.message ?? null,
        error === undefined ? null : error.retryable ? 1 : 0,
        now,
        now,
        interaction.sourceThreadId,
        interaction.sourceAgentId,
        interaction.sourceToolCallId,
      );
    const finished = this.getInteraction(interaction.ownerId, interaction);
    this.#ensureInteractionDelivery(finished);
    return finished;
  }

  #ensureInteractionDelivery(interaction: InteractionRecord): void {
    if (interaction.executionMode !== 'background') return;
    if (!isTerminalStatus(interaction.status)) {
      throw new SessionError('internal', 'A delivery requires a terminal interaction.');
    }
    const now = isoTime(undefined, this.#clock);
    this.database
      .prepare(
        `INSERT INTO interaction_deliveries(
          source_thread_id, source_agent_id, source_tool_call_id,
          owner_id, reply_thread_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(source_thread_id, source_agent_id, source_tool_call_id) DO NOTHING`,
      )
      .run(
        interaction.sourceThreadId,
        interaction.sourceAgentId,
        interaction.sourceToolCallId,
        interaction.ownerId,
        interaction.replyThreadId,
        now,
        now,
      );
    const delivery = this.getInteractionDelivery(interaction.ownerId, interaction);
    if (delivery.replyThreadId !== interaction.replyThreadId) {
      throw new SessionError('internal', 'The interaction delivery target changed.');
    }
  }

  #requestRunCancellation(run: RunRecord): RunRecord {
    if (isTerminalStatus(run.status)) {
      this.database
        .prepare('UPDATE runs SET cancel_accepted_generation = ? WHERE run_id = ?')
        .run(run.generation, run.runId);
      return this.getRunById(run.runId);
    }
    const status: RunStatus = run.status === 'queued' ? 'cancelled' : 'cancel_requested';
    const now = isoTime(undefined, this.#clock);
    this.database
      .prepare(
        "UPDATE runs SET status = ?, cancel_accepted_generation = ?, finished_at = CASE WHEN ? = 'cancelled' THEN ? ELSE finished_at END WHERE run_id = ?",
      )
      .run(status, run.generation, status, now, run.runId);
    const updated = this.getRunById(run.runId);
    this.#insertEvent(run.threadId, { case: 'runChanged', value: { run: updated } });
    const interactions = this.database
      .prepare('SELECT * FROM interactions WHERE consumed_run_id = ?')
      .all(run.runId)
      .map((row) => this.#toInteraction(interactionRowSchema.parse(row)));
    for (const interaction of interactions) {
      if (isTerminalStatus(interaction.status)) continue;
      if (status === 'cancelled') {
        this.#finishInteraction(interaction, 'cancelled');
      } else {
        this.database
          .prepare(
            `UPDATE interactions SET status = 'cancel_requested',
             cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ?
             WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
          )
          .run(
            now,
            now,
            interaction.sourceThreadId,
            interaction.sourceAgentId,
            interaction.sourceToolCallId,
          );
      }
    }
    return this.getRunById(run.runId);
  }

  #action<T>(action: ActionInput, responseSchema: z.ZodType<T>, work: () => T): T {
    requireText(action.clientActionId, 'clientActionId', 200);
    requireText(action.ownerId, 'ownerId', 200);
    requireText(action.method, 'method', 100);
    const fingerprint = createHash('sha256').update(canonicalJson(action.parameters)).digest('hex');
    return this.transaction(() => {
      const row = this.database
        .prepare(
          'SELECT method, fingerprint, response_json FROM client_actions WHERE owner_id = ? AND client_action_id = ?',
        )
        .get(action.ownerId, action.clientActionId);
      if (row !== undefined) {
        const existing = actionRowSchema.parse(row);
        if (existing.method !== action.method || existing.fingerprint !== fingerprint) {
          throw new SessionError(
            'action_conflict',
            'The client action ID was already used with different parameters.',
            { clientActionId: action.clientActionId },
          );
        }
        return responseSchema.parse(parseJson(existing.response_json));
      }
      const response = work();
      this.database
        .prepare(
          'INSERT INTO client_actions(owner_id, client_action_id, method, fingerprint, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          action.ownerId,
          action.clientActionId,
          action.method,
          fingerprint,
          JSON.stringify(response),
          isoTime(undefined, this.#clock),
        );
      return response;
    });
  }

  #insertThread(
    ownerId: string,
    threadType: ThreadRecord['threadType'],
    title: string,
    environmentPolicy?: EnvironmentPolicyInput,
    delegation?: DelegationKey,
    parentRun?: RunRecord,
    automationOnly = false,
    resetFromThreadId?: string,
    workspaceId?: string,
  ): ThreadRecord {
    const now = isoTime(undefined, this.#clock);
    const threadId = this.#createId();
    const workspace =
      workspaceId === undefined ? undefined : this.#ownedWorkspace(ownerId, workspaceId);
    this.database
      .prepare(
        `INSERT INTO threads(
          thread_id, owner_id, title, thread_type, workspace_id, automation_only, reset_from_thread_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        ownerId,
        title,
        threadType,
        workspaceId ?? null,
        automationOnly ? 1 : 0,
        resetFromThreadId ?? null,
        now,
        now,
      );
    this.database
      .prepare(
        'INSERT INTO thread_queues(thread_id, queue_version, next_position) VALUES (?, 0, 1)',
      )
      .run(threadId);
    this.database
      .prepare('INSERT INTO thread_event_retention(thread_id, first_available_seq) VALUES (?, 1)')
      .run(threadId);
    this.agentEnvironments.createPolicy({
      ownerId,
      threadId,
      agentId: 'thread',
      ...(environmentPolicy ? { policy: environmentPolicy } : {}),
      ...(parentRun ? { parentRun } : {}),
      ...(delegation ? { delegation } : {}),
      ...(workspace ? { workspace: { envId: workspace.env_id, path: workspace.path } } : {}),
    });
    const thread = this.getThread(ownerId, threadId);
    this.#insertEvent(threadId, { case: 'threadCreated', value: { thread } });
    return thread;
  }

  #updateThreadTitle(ownerId: string, threadId: string, title: string): void {
    this.database
      .prepare('UPDATE threads SET title = ?, updated_at = ? WHERE thread_id = ? AND owner_id = ?')
      .run(title, isoTime(undefined, this.#clock), threadId, ownerId);
    const thread = this.getThread(ownerId, threadId);
    this.#insertEvent(threadId, { case: 'threadRenamed', value: { thread } });
  }

  #insertRun(
    ownerId: string,
    threadId: string,
    agentId: string,
    parentRunId?: string,
    executionMode?: RunExecutionMode,
    rerunFromMessageSeq?: number,
  ): RunRecord {
    const runId = this.#createId();
    const now = isoTime(undefined, this.#clock);
    const mode =
      executionMode ??
      (parentRunId !== undefined || this.getThread(ownerId, threadId).threadType === 'main'
        ? 'foreground'
        : 'background');
    this.database
      .prepare(
        `INSERT INTO runs(
          run_id, thread_id, owner_id, agent_id, status, execution_mode, input_ids_json,
          parent_run_id, rerun_from_message_seq, usage_input_tokens, usage_output_tokens,
          usage_reported, created_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, '[]', ?, ?, 0, 0, 0, ?)`,
      )
      .run(
        runId,
        threadId,
        ownerId,
        agentId,
        mode,
        parentRunId ?? null,
        rerunFromMessageSeq ?? null,
        now,
      );
    const run = this.getRunById(runId);
    this.agentEnvironments.captureExecution(run);
    this.#insertEvent(threadId, { case: 'runChanged', value: { run } });
    return run;
  }

  #viewVersion(threadId: string, agentId: string): number {
    return z
      .object({ view_version: z.number().int().nonnegative() })
      .parse(
        this.database
          .prepare(
            'SELECT view_version FROM model_input_states WHERE thread_id = ? AND agent_id = ?',
          )
          .get(threadId, agentId),
      ).view_version;
  }

  #supersedeInvalidInteractionDeliveries(supersededByRunId: string, now: string): void {
    const rows = z
      .array(
        z.object({
          owner_id: z.string(),
          source_thread_id: z.string(),
          source_agent_id: z.string(),
          source_tool_call_id: z.string(),
        }),
      )
      .parse(
        this.database
          .prepare(
            `SELECT DISTINCT interactions.owner_id, interactions.source_thread_id,
                    interactions.source_agent_id, interactions.source_tool_call_id
             FROM interactions
             JOIN context_tool_calls AS source_call
               ON source_call.thread_id = interactions.source_thread_id
              AND source_call.agent_id = interactions.source_agent_id
              AND source_call.call_id = interactions.source_tool_call_id
             JOIN context_messages AS source_message
               ON source_message.seq = source_call.assistant_seq
             JOIN interaction_deliveries AS delivery
               ON delivery.source_thread_id = interactions.source_thread_id
              AND delivery.source_agent_id = interactions.source_agent_id
              AND delivery.source_tool_call_id = interactions.source_tool_call_id
             WHERE source_message.superseded_by_run_id = ?
               AND delivery.status IN ('pending', 'queued')`,
          )
          .all(supersededByRunId),
      );
    for (const row of rows) {
      const key = {
        sourceThreadId: row.source_thread_id,
        sourceAgentId: row.source_agent_id,
        sourceToolCallId: row.source_tool_call_id,
      };
      this.database
        .prepare(
          `UPDATE interaction_deliveries SET status = 'superseded', updated_at = ?
           WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
        )
        .run(now, key.sourceThreadId, key.sourceAgentId, key.sourceToolCallId);
    }
  }

  #supersedeInvalidThreadNotifications(supersededByRunId: string, now: string): void {
    const rows = z
      .array(
        z.object({
          owner_id: z.string(),
          source_thread_id: z.string(),
          source_agent_id: z.string(),
          source_tool_call_id: z.string(),
        }),
      )
      .parse(
        this.database
          .prepare(
            `SELECT DISTINCT notification.owner_id, notification.source_thread_id,
                    notification.source_agent_id, notification.source_tool_call_id
             FROM thread_notifications AS notification
             JOIN context_tool_calls AS source_call
               ON source_call.thread_id = notification.source_thread_id
              AND source_call.agent_id = notification.source_agent_id
              AND source_call.call_id = notification.source_tool_call_id
             JOIN context_messages AS source_message
               ON source_message.seq = source_call.assistant_seq
             WHERE source_message.superseded_by_run_id = ?
               AND notification.status IN ('pending', 'queued')`,
          )
          .all(supersededByRunId),
      );
    for (const row of rows) {
      const key = {
        sourceThreadId: row.source_thread_id,
        sourceAgentId: row.source_agent_id,
        sourceToolCallId: row.source_tool_call_id,
      };
      this.database
        .prepare(
          `UPDATE thread_notifications SET status = 'superseded', updated_at = ?
           WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?
             AND status IN ('pending', 'queued')`,
        )
        .run(now, key.sourceThreadId, key.sourceAgentId, key.sourceToolCallId);
      this.#insertThreadNotificationEvent(this.getThreadNotification(row.owner_id, key));
    }
  }

  #insertInput(
    ownerId: string,
    threadId: string,
    text: string,
    mode: InputMode,
    metadata: {
      source?: MessageSource;
      delegation?: DelegationKey;
      sourceThreadId?: string;
      sourceAgentId?: string;
      automation?: AutomationReference;
      channel?: ChannelReference;
    } = {},
    attachments: readonly AttachmentMetadata[] = [],
  ): InputRecord {
    const queue = this.#queue(threadId);
    const inputId = this.#createId();
    const now = isoTime(undefined, this.#clock);
    this.database
      .prepare(
        `INSERT INTO inputs(
          input_id, thread_id, owner_id, text, mode, status, position, version,
          source, delegation_source_thread_id, delegation_source_agent_id, source_tool_call_id,
          source_thread_id, source_agent_id, automation_schedule_id, automation_fire_id,
          automation_trigger, automation_scheduled_at, channel_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        inputId,
        threadId,
        ownerId,
        text,
        mode,
        queue.next_position,
        metadata.source ?? 'user',
        metadata.delegation?.sourceThreadId ?? null,
        metadata.delegation?.sourceAgentId ?? null,
        metadata.delegation?.sourceToolCallId ?? null,
        metadata.sourceThreadId ?? null,
        metadata.sourceAgentId ?? null,
        metadata.automation?.scheduleId ?? null,
        metadata.automation?.fireId ?? null,
        metadata.automation?.trigger ?? null,
        metadata.automation?.scheduledAt ?? null,
        channelJsonText(metadata.channel),
        now,
        now,
      );
    this.database
      .prepare('UPDATE thread_queues SET next_position = next_position + 1 WHERE thread_id = ?')
      .run(threadId);
    this.attachments.linkInput(inputId, attachments);
    const input = this.getInput(ownerId, inputId);
    this.#insertEvent(threadId, { case: 'inputAccepted', value: { input } });
    return input;
  }

  #consumeInput(run: RunRecord, inputId: string): InputRecord {
    const input = this.getInput(run.ownerId, inputId);
    if (input.threadId !== run.threadId || input.status !== 'queued') {
      throw new SessionError('version_conflict', 'The input is no longer queued.');
    }
    const now = isoTime(undefined, this.#clock);
    this.database
      .prepare(
        "UPDATE inputs SET status = 'consumed', consumed_run_id = ?, updated_at = ? WHERE input_id = ? AND status = 'queued'",
      )
      .run(run.runId, now, inputId);
    const consumed = this.getInput(run.ownerId, inputId);
    if (!run.inputIds.includes(inputId)) {
      const inputIds = [...run.inputIds, inputId];
      this.database
        .prepare('UPDATE runs SET input_ids_json = ? WHERE run_id = ?')
        .run(JSON.stringify(inputIds), run.runId);
      this.#insertEvent(run.threadId, {
        case: 'runChanged',
        value: { run: this.getRunById(run.runId) },
      });
    }
    if (input.delegation !== null) {
      if (input.source === 'thread_response' || input.source === 'subagent_response') {
        throw new SessionError(
          'failed_precondition',
          'A background delivery must be injected directly, not consumed as a queued input.',
        );
      }
      const key = input.delegation;
      const interaction = this.getInteraction(run.ownerId, key);
      if (isTerminalStatus(interaction.status)) {
        throw new SessionError('version_conflict', 'A terminal interaction cannot consume input.');
      }
      if (interaction.targetInputId !== input.inputId) {
        throw new SessionError('internal', 'The interaction input association is inconsistent.');
      }
      if (interaction.consumedRunId !== null && interaction.consumedRunId !== run.runId) {
        throw new SessionError('internal', 'The interaction was already consumed by another Run.');
      }
      const status = interaction.status === 'cancel_requested' ? 'cancel_requested' : 'running';
      this.database
        .prepare(
          `UPDATE interactions SET consumed_run_id = ?, status = ?, updated_at = ?
           WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
        )
        .run(run.runId, status, now, key.sourceThreadId, key.sourceAgentId, key.sourceToolCallId);
    }
    this.#insertEvent(run.threadId, { case: 'inputEdited', value: { input: consumed } });
    return consumed;
  }

  #ownedThreadInput(ownerId: string, threadId: string, inputId: string): InputRecord {
    this.getThread(ownerId, threadId);
    const input = this.getInput(ownerId, inputId);
    if (input.threadId !== threadId) {
      throw new SessionError('permission_denied', 'Input does not belong to this Thread.');
    }
    return input;
  }

  #assertInputHasNoInteraction(input: InputRecord, operation: 'edited' | 'removed'): void {
    if (input.automation !== null) {
      throw new SessionError(
        'failed_precondition',
        `An Automation input cannot be ${operation} through the general queue API.`,
      );
    }
    if (input.delegation !== null) {
      throw new SessionError(
        'failed_precondition',
        `An interaction-linked input cannot be ${operation} through the general queue API.`,
      );
    }
  }

  #queue(threadId: string): z.infer<typeof queueRowSchema> {
    return queueRowSchema.parse(
      this.database
        .prepare('SELECT queue_version, next_position FROM thread_queues WHERE thread_id = ?')
        .get(threadId),
    );
  }

  #nextQueueVersion(threadId: string, expectedVersion: number): number {
    const updated = this.database
      .prepare(
        'UPDATE thread_queues SET queue_version = queue_version + 1 WHERE thread_id = ? AND queue_version = ? RETURNING queue_version',
      )
      .get(threadId, expectedVersion);
    return z.object({ queue_version: z.number().int().nonnegative() }).parse(updated).queue_version;
  }

  #assertQueueCapacity(threadId: string, additional: number): void {
    const row = z
      .object({ count: z.number().int().nonnegative() })
      .parse(
        this.database
          .prepare("SELECT COUNT(*) AS count FROM inputs WHERE thread_id = ? AND status = 'queued'")
          .get(threadId),
      );
    if (row.count + additional > this.#maxQueuedInputs) {
      throw new SessionError('input_too_large', 'The Thread input queue is full.');
    }
  }

  #insertEvent(threadId: string, payload: ThreadEventPayload): ThreadEventRecord {
    const seq = this.latestEventSequence(threadId) + 1;
    const event: ThreadEventRecord = {
      eventId: this.#createId(),
      threadId,
      seq,
      occurredAt: isoTime(undefined, this.#clock),
      payload,
    };
    this.database
      .prepare(
        'INSERT INTO thread_events(event_id, thread_id, seq, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(event.eventId, threadId, seq, event.occurredAt, canonicalJson(payload));
    this.database
      .prepare('UPDATE thread_event_retention SET last_event_seq = ? WHERE thread_id = ?')
      .run(seq, threadId);
    this.#pendingNotifications.push({ kind: 'event', value: event });
    return event;
  }

  #notify(event: ThreadEventRecord | TextDeltaRecord | ToolProgressRecord): void {
    if ('seq' in event) {
      if (event.payload.case === 'messageCommitted') {
        const messageId = event.payload.value.message.messageId;
        this.#clearStreamDeltaBuffer(event.threadId, (delta) => delta.messageId === messageId);
      } else if (
        event.payload.case === 'runChanged' &&
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(event.payload.value.run.status)
      ) {
        const runId = event.payload.value.run.runId;
        this.#clearStreamDeltaBuffer(event.threadId, (delta) => delta.runId === runId);
      }
    }
    for (const listener of [...(this.#listeners.get(event.threadId) ?? [])]) listener(event);
  }

  #toThread(row: z.infer<typeof threadRowSchema>): ThreadRecord {
    const environmentPolicy = this.agentEnvironments.getPolicy(row.thread_id, 'thread');
    return {
      threadId: row.thread_id,
      ownerId: row.owner_id,
      title: row.title,
      threadType: row.thread_type,
      workspaceId: row.workspace_id,
      automationOnly: row.automation_only === 1,
      newConversation: row.reset_from_thread_id !== null,
      archivedAt: row.archived_at,
      seq: row.seq,
      ...(environmentPolicy && isExplicitEnvironmentPolicy(environmentPolicy)
        ? { environmentPolicy }
        : {}),
      ...(environmentPolicy?.current ? { currentBinding: environmentPolicy.current } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #toInput(row: z.infer<typeof inputRowSchema>): InputRecord {
    const attachments = this.attachments.listForInput(row.input_id);
    return {
      inputId: row.input_id,
      threadId: row.thread_id,
      ownerId: row.owner_id,
      text: row.text,
      mode: row.mode,
      status: row.status,
      position: row.position,
      version: row.version,
      consumedRunId: row.consumed_run_id,
      source: row.source,
      delegation:
        row.source_tool_call_id === null
          ? null
          : {
              sourceThreadId: requireText(
                row.delegation_source_thread_id ?? '',
                'delegation_source_thread_id',
                200,
              ),
              sourceAgentId: requireText(
                row.delegation_source_agent_id ?? '',
                'delegation_source_agent_id',
                200,
              ),
              sourceToolCallId: row.source_tool_call_id,
            },
      sourceThreadId: row.source_thread_id,
      sourceAgentId: row.source_agent_id,
      channel: parseChannelJson(row.channel_json),
      automation:
        row.automation_schedule_id === null ||
        row.automation_fire_id === null ||
        row.automation_trigger === null ||
        row.automation_scheduled_at === null
          ? null
          : {
              scheduleId: row.automation_schedule_id,
              fireId: row.automation_fire_id,
              trigger: row.automation_trigger,
              scheduledAt: row.automation_scheduled_at,
            },
      ...(attachments.length > 0 ? { attachments } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #toRun(row: z.infer<typeof runRowSchema>): RunRecord {
    const sendToUserEnabled = readSendToUserMode(
      this.database,
      modelExecutionModeEventId(row.run_id, row.execution_generation),
      row.thread_id,
      row.agent_id,
    );
    const errorCode = z
      .enum([
        'unauthenticated',
        'permission_denied',
        'version_conflict',
        'action_conflict',
        'device_offline',
        'operation_unknown',
        'recap_invalid',
        'input_too_large',
        'protocol_incompatible',
        'invalid_argument',
        'not_found',
        'failed_precondition',
        'internal',
      ])
      .nullable()
      .parse(row.error_code);
    return {
      runId: row.run_id,
      threadId: row.thread_id,
      ownerId: row.owner_id,
      agentId: row.agent_id,
      status: row.status,
      executionMode: row.execution_mode,
      inputIds: z.array(z.string()).parse(parseJson(row.input_ids_json)),
      parentRunId: row.parent_run_id,
      rerunFromMessageSeq: row.rerun_from_message_seq,
      supersededByRunId: row.superseded_by_run_id,
      error:
        errorCode === null
          ? null
          : {
              code: errorCode,
              message: row.error_message ?? 'Run failed.',
              retryable: row.error_retryable === 1,
            },
      usage: {
        inputTokens: row.usage_input_tokens,
        outputTokens: row.usage_output_tokens,
      },
      usageReported: row.usage_reported === 1,
      currentRequestId: row.current_request_id,
      generation: row.execution_generation,
      cancelAcceptedGeneration: row.cancel_accepted_generation,
      ...(sendToUserEnabled === undefined ? {} : { sendToUserEnabled }),
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  #toInteraction(row: z.infer<typeof interactionRowSchema>): InteractionRecord {
    const errorCode = runErrorSchema.shape.code.nullable().parse(row.error_code);
    return {
      ownerId: row.owner_id,
      kind: row.kind,
      executionMode: row.execution_mode,
      sourceThreadId: row.source_thread_id,
      sourceAgentId: row.source_agent_id,
      sourceRunId: row.source_run_id,
      sourceToolCallId: row.source_tool_call_id,
      requestFingerprint: row.request_fingerprint,
      prompt: row.prompt,
      targetThreadId: row.target_thread_id,
      targetAgentId: row.target_agent_id,
      replyThreadId: row.reply_thread_id,
      targetInputId: row.target_input_id,
      acceptedRunId: row.accepted_run_id,
      consumedRunId: row.consumed_run_id,
      status: row.status,
      responseMessageSeq: row.response_message_seq,
      error:
        errorCode === null
          ? null
          : {
              code: errorCode,
              message: row.error_message ?? 'Interaction failed.',
              retryable: row.error_retryable === 1,
            },
      cancelRequestedAt: row.cancel_requested_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
    };
  }

  #toBackgroundTask(row: z.infer<typeof backgroundTaskRowSchema>): BackgroundTaskRecord {
    return {
      taskId: row.task_id,
      ownerId: row.owner_id,
      threadId: row.thread_id,
      agentId: row.agent_id,
      runId: row.run_id,
      sourceToolCallId: row.source_tool_call_id,
      kind: row.kind,
      description: row.description,
      operationId: row.operation_id,
      status: row.status,
      resultText: row.result_text,
      deliveryContent: row.delivery_content,
      deliveryRunId: row.delivery_run_id,
      deliveryStatus: row.delivery_status,
      contextMessageSeq: row.context_message_seq,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      endedAt: row.ended_at,
      consumedAt: row.consumed_at,
    };
  }

  #toThreadNotification(
    row: z.infer<typeof threadNotificationRowSchema>,
  ): ThreadNotificationRecord {
    return {
      sourceThreadId: row.source_thread_id,
      sourceAgentId: row.source_agent_id,
      sourceToolCallId: row.source_tool_call_id,
      ownerId: row.owner_id,
      sourceRunId: row.source_run_id,
      replyThreadId: row.reply_thread_id,
      target: row.target,
      content: row.content,
      deliveryContent: row.delivery_content,
      contextMessageSeq: row.context_message_seq,
      runId: row.run_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      queuedAt: row.queued_at,
      consumedAt: row.consumed_at,
    };
  }

  #toDelivery(row: z.infer<typeof deliveryRowSchema>): InteractionDeliveryRecord {
    return {
      sourceThreadId: row.source_thread_id,
      sourceAgentId: row.source_agent_id,
      sourceToolCallId: row.source_tool_call_id,
      ownerId: row.owner_id,
      replyThreadId: row.reply_thread_id,
      content: row.content,
      contextMessageSeq: row.context_message_seq,
      runId: row.run_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      queuedAt: row.queued_at,
      consumedAt: row.consumed_at,
    };
  }

  #toEvent(row: z.infer<typeof eventRowSchema>): ThreadEventRecord {
    const envelope = payloadEnvelopeSchema.parse(parseJson(row.payload_json));
    if (!eventPayloadCases.has(envelope.case as ThreadEventPayload['case'])) {
      throw new SessionError('internal', 'Stored Thread event payload is unsupported.');
    }
    return {
      eventId: row.event_id,
      threadId: row.thread_id,
      seq: row.seq,
      occurredAt: row.occurred_at,
      payload: envelope as ThreadEventPayload,
    };
  }

  #toServerBashOperation(row: z.infer<typeof serverBashRowSchema>): ServerBashOperationRecord {
    return {
      operationId: row.operation_id,
      ownerId: row.owner_id,
      threadId: row.thread_id,
      runId: row.run_id,
      toolCallId: row.tool_call_id,
      logPath: row.log_path,
      outputComplete: row.output_complete === 1,
      endOffset: BigInt(row.end_offset),
      expiresAt: row.expires_at,
      content: row.content,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => this.flushNotifications());
  }
}

function delegationMapKey(key: DelegationKey): string {
  return JSON.stringify([key.sourceThreadId, key.sourceAgentId, key.sourceToolCallId]);
}

function interactionFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function isTerminalStatus(status: RunStatus): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
}

function snapshotRange(
  position: SnapshotCollectionPosition,
): { after: number; maximum: number } | undefined {
  const maximumSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (position.afterRowid >= position.maxRowid || position.afterRowid > maximumSafe) {
    return undefined;
  }
  let maximum = position.maxRowid;
  if (maximum > maximumSafe) maximum = maximumSafe;
  return { after: Number(position.afterRowid), maximum: Number(maximum) };
}

function canonicalJson(value: unknown): string {
  const normalized = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalized);
    if (typeof item === 'object' && item !== null) {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalized(entry)]),
      );
    }
    if (typeof item === 'bigint') return item.toString();
    return item;
  };
  return JSON.stringify(normalized(value));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new SessionError('internal', 'Stored JSON data is invalid.', { cause: error });
  }
}
