import type { AttachmentMetadata } from '../attachments/types.js';
import type {
  AutomationReference,
  ChannelReference,
  ContextMessage,
  DelegationKey,
  MessageSource,
} from '../context/types.js';
import type { DeviceRecord } from '../devices/device-store.js';
import type { EnvironmentRecord } from '../devices/environment-store.js';
import type { Recap } from '../recap/types.js';
import type {
  AgentEnvironmentBinding,
  ExplicitAgentEnvironmentPolicy,
} from './environment-policies.js';
import type { SessionErrorCode } from './errors.js';

export type { MessageSource } from '../context/types.js';

export type ThreadType = 'main' | 'workspace_main' | 'task';
export type RunExecutionMode = 'foreground' | 'background';

export interface ThreadRecord {
  threadId: string;
  ownerId: string;
  title: string;
  threadType: ThreadType;
  workspaceId?: string | null | undefined;
  automationOnly: boolean;
  seq: number;
  environmentPolicy?: ExplicitAgentEnvironmentPolicy | undefined;
  currentBinding?: AgentEnvironmentBinding | undefined;
  newConversation?: boolean | undefined;
  archivedAt?: string | null | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRecord {
  description: string;
  hidden: boolean;
  workspaceId: string;
  tenantId: string;
  name: string;
  envId: string;
  path: string;
  createdAt: string;
}

export type InputMode = 'follow_up' | 'steer';
export type InputStatus = 'queued' | 'consumed' | 'cancelled';

export interface InputRecord {
  inputId: string;
  threadId: string;
  ownerId: string;
  text: string;
  mode: InputMode;
  status: InputStatus;
  position: number;
  version: number;
  consumedRunId: string | null;
  source: MessageSource;
  delegation: DelegationKey | null;
  sourceThreadId: string | null;
  sourceAgentId: string | null;
  automation: AutomationReference | null;
  channel: ChannelReference | null;
  attachments?: readonly AttachmentMetadata[] | undefined;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface RunError {
  code: SessionErrorCode;
  message: string;
  retryable: boolean;
}

export interface RunRecord {
  runId: string;
  threadId: string;
  ownerId: string;
  agentId: string;
  status: RunStatus;
  executionMode: RunExecutionMode;
  inputIds: string[];
  parentRunId: string | null;
  rerunFromMessageSeq: number | null;
  supersededByRunId: string | null;
  error: RunError | null;
  usage: { inputTokens: number; outputTokens: number };
  usageReported: boolean;
  currentRequestId: string | null;
  generation: number;
  cancelAcceptedGeneration: number | null;
  sendToUserEnabled?: boolean | undefined;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type InteractionKind = 'thread_call' | 'subagent';

export interface InteractionRecord extends DelegationKey {
  ownerId: string;
  kind: InteractionKind;
  executionMode: RunExecutionMode;
  sourceRunId: string;
  requestFingerprint: string;
  prompt: string;
  targetThreadId: string;
  targetAgentId: string;
  replyThreadId: string;
  targetInputId: string | null;
  acceptedRunId: string | null;
  consumedRunId: string | null;
  status: RunStatus;
  responseMessageSeq: number | null;
  error: RunError | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type InteractionDeliveryStatus = 'pending' | 'queued' | 'consumed' | 'superseded';

export interface InteractionDeliveryRecord extends DelegationKey {
  ownerId: string;
  replyThreadId: string;
  content: string | null;
  contextMessageSeq: number | null;
  runId: string | null;
  status: InteractionDeliveryStatus;
  createdAt: string;
  updatedAt: string;
  queuedAt: string | null;
  consumedAt: string | null;
}

export type ThreadNotificationStatus = 'pending' | 'queued' | 'consumed' | 'superseded';

export interface ThreadNotificationRecord extends DelegationKey {
  ownerId: string;
  sourceRunId: string;
  replyThreadId: string;
  target: 'workspace' | 'global';
  content: string;
  deliveryContent: string;
  contextMessageSeq: number | null;
  runId: string | null;
  status: ThreadNotificationStatus;
  createdAt: string;
  updatedAt: string;
  queuedAt: string | null;
  consumedAt: string | null;
}

export interface ToolProgressAuthorization {
  serverName: string;
  authorizationUrl: string;
  expiresAt: string;
}

export interface ToolProgressRecord {
  threadId: string;
  agentId: string;
  runId: string;
  toolCallId: string;
  text: string;
  authorization?: ToolProgressAuthorization;
}

export type BackgroundTaskKind = 'bash' | 'subagent';
export type BackgroundTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'unknown';
export type BackgroundTaskDeliveryStatus = 'pending' | 'queued' | 'consumed';

export interface BackgroundTaskRecord {
  taskId: string;
  ownerId: string;
  threadId: string;
  agentId: string;
  runId: string;
  sourceToolCallId: string;
  kind: BackgroundTaskKind;
  description: string;
  operationId: string | null;
  status: BackgroundTaskStatus;
  resultText: string | null;
  deliveryContent: string | null;
  deliveryRunId: string | null;
  deliveryStatus: BackgroundTaskDeliveryStatus;
  contextMessageSeq: number | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  consumedAt: string | null;
}

export interface MessageRevisionRecord {
  revisionId: string;
  messageId: string;
  text: string;
  previousRevisionId?: string;
  createdAt: string;
}

export type ThreadEventPayload =
  | { case: 'mainEnvironmentChanged'; value: EnvironmentRecord }
  | { case: 'threadCreated'; value: { thread: ThreadRecord } }
  | { case: 'threadRenamed'; value: { thread: ThreadRecord } }
  | { case: 'inputAccepted'; value: { input: InputRecord } }
  | { case: 'inputEdited'; value: { input: InputRecord } }
  | { case: 'inputRemoved'; value: { input: InputRecord; queueVersion: number } }
  | {
      case: 'inputsReordered';
      value: { inputs: InputRecord[]; queueVersion: number };
    }
  | { case: 'messageCommitted'; value: { message: ContextMessage } }
  | {
      case: 'messageRevised';
      value: { messageId: string; revision: MessageRevisionRecord };
    }
  | { case: 'runChanged'; value: { run: RunRecord } }
  | { case: 'threadNotificationChanged'; value: { notification: ThreadNotificationRecord } }
  | {
      case: 'contextViewChanged';
      value: { agentId: string; viewVersion: number; anchorMessageSeq: number | null };
    }
  | { case: 'hardCutStarted'; value: { runId: string; operationId?: string } }
  | {
      case: 'hardCutCompleted';
      value: {
        runId: string;
        operationId?: string;
        replacedSourceSeqs: number[];
        recapIds: string[];
        injectedMessageCount: number;
      };
    }
  | {
      case: 'hardCutFailed';
      value: { runId: string; operationId?: string; error: RunError };
    }
  | { case: 'recapCreated'; value: { recap: Recap } }
  | { case: 'recapInvalidated'; value: { recapId: string; reason: string } }
  | { case: 'deviceChanged'; value: { device: DeviceRecord } }
  | {
      case: 'environmentBindingChanged';
      value: { agentId: string; binding: AgentEnvironmentBinding | null };
    };

export interface ThreadEventRecord {
  eventId: string;
  threadId: string;
  seq: number;
  occurredAt: string;
  payload: ThreadEventPayload;
}

export interface TextDeltaRecord {
  threadId: string;
  messageId: string;
  deltaSeq: number;
  text: string;
  blockIndex?: number;
  runId?: string;
  agentId?: string;
}

export interface ThinkingDeltaRecord extends TextDeltaRecord {
  thinking: true;
  blockIndex: number;
  runId: string;
}

export type StreamDeltaRecord = TextDeltaRecord | ThinkingDeltaRecord;

export interface ServerBashOperationRecord {
  operationId: string;
  ownerId: string;
  threadId: string;
  runId: string;
  toolCallId: string;
  logPath: string | null;
  outputComplete: boolean;
  endOffset: bigint;
  expiresAt: string | null;
  content: string | null;
  status: 'success' | 'error' | null;
  createdAt: string;
  updatedAt: string;
}
