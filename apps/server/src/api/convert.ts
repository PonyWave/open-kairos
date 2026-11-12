import {
  AttachmentSource,
  AutomationTrigger,
  BashOperationStatus,
  ContentBlockType,
  EnvironmentBindingStatus,
  EnvironmentCapability,
  EnvironmentCapabilityStatus,
  EnvironmentConnectionStatus,
  EnvironmentDirectoryStatus,
  EnvironmentKind,
  EnvironmentMaintenanceMode,
  ErrorCode,
  InputMode,
  InputStatus,
  MessageRole,
  MessageSource,
  PlatformLifecycleState,
  RecapValidity,
  RunExecutionMode,
  RunStatus,
  ThreadCardSort,
  ThreadNotificationStatus,
  ThreadType,
  ToolResultStatus,
} from '@kairos/contracts';
import { DeviceCapability } from '@kairos/contracts/device';
import type { AttachmentMetadata } from '../attachments/types.js';
import type { AutomationReference, ContextMessage } from '../context/types.js';
import type { DeviceRecord } from '../devices/device-store.js';
import type { EnvironmentRecord } from '../devices/environment-store.js';
import type { BashOperationRecord } from '../devices/operation-store.js';
import type { Recap as RecapRecord } from '../recap/types.js';
import type {
  AgentEnvironmentBinding,
  ExplicitAgentEnvironmentPolicy,
} from '../sessions/environment-policies.js';
import type { SessionErrorCode } from '../sessions/errors.js';
import type {
  InputRecord,
  MessageRevisionRecord,
  RunError,
  RunRecord,
  StreamDeltaRecord,
  TextDeltaRecord,
  ThinkingDeltaRecord,
  ThreadEventRecord,
  ThreadNotificationRecord,
  ThreadRecord,
} from '../sessions/records.js';
import type {
  ThreadCallPreviewProjection,
  ThreadCallReferenceProjection,
  ThreadCardCursor,
  ThreadCardProjection,
  ThreadMessagePreviewProjection,
} from '../sessions/thread-previews.js';

export function timestamp(value: string) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('Stored timestamp is invalid.');
  return {
    seconds: BigInt(Math.floor(milliseconds / 1000)),
    nanos: (milliseconds % 1000) * 1_000_000,
  };
}

export function toAttachment(record: AttachmentMetadata) {
  return {
    attachmentId: record.attachmentId,
    fileName: record.fileName,
    mediaType: record.mediaType,
    sizeBytes: BigInt(record.byteSize),
    ...(record.width === undefined ? {} : { width: record.width }),
    ...(record.height === undefined ? {} : { height: record.height }),
    sha256: record.sha256,
    createdAt: timestamp(record.createdAt),
    source: record.source === 'clipboard' ? AttachmentSource.CLIPBOARD : AttachmentSource.FILE,
    ...(record.workspaceStatus === 'completed' && record.path !== undefined
      ? { path: record.path }
      : {}),
  };
}

function toMessageSource(source: NonNullable<InputRecord['source']>): MessageSource {
  switch (source) {
    case 'user':
      return MessageSource.USER;
    case 'thread_call':
      return MessageSource.THREAD_CALL;
    case 'thread_response':
      return MessageSource.THREAD_RESPONSE;
    case 'subagent_response':
      return MessageSource.SUBAGENT_RESPONSE;
    case 'automation':
      return MessageSource.AUTOMATION;
    case 'thread_notification':
      return MessageSource.THREAD_NOTIFICATION;
  }
}

function toAutomationReference(record: AutomationReference) {
  return {
    scheduleId: record.scheduleId,
    fireId: record.fireId,
    trigger: record.trigger === 'run_now' ? AutomationTrigger.RUN_NOW : AutomationTrigger.SCHEDULED,
    scheduledAt: timestamp(record.scheduledAt),
  };
}

export function toEnvironmentPolicy(record: ExplicitAgentEnvironmentPolicy) {
  return {
    allowedEnv: [...record.allowedEnv],
    policyVersion: BigInt(record.policyVersion),
  };
}

export function toAgentEnvironmentBinding(record: AgentEnvironmentBinding) {
  return {
    envId: record.envId,
    pwd: record.pwd,
    bindingVersion: BigInt(record.bindingVersion),
    ...(record.resourceVersion === null ? {} : { resourceVersion: record.resourceVersion }),
  };
}

export function toThread(record: ThreadRecord) {
  return {
    threadId: record.threadId,
    title: record.title,
    threadType: record.threadType === 'main' ? ThreadType.MAIN : ThreadType.TASK,
    automationOnly: record.automationOnly,
    ...(record.newConversation === true ? { newConversation: true } : {}),
    seq: BigInt(record.seq),
    ...(record.environmentPolicy
      ? { environmentPolicy: toEnvironmentPolicy(record.environmentPolicy) }
      : {}),
    ...(record.currentBinding
      ? { currentBinding: toAgentEnvironmentBinding(record.currentBinding) }
      : {}),
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt),
  };
}

export function toThreadMessagePreview(record: ThreadMessagePreviewProjection) {
  return {
    messageId: record.messageId,
    seq: BigInt(record.seq),
    role: record.role === 'user' ? MessageRole.USER : MessageRole.ASSISTANT,
    text: record.text,
    textTruncated: record.textTruncated,
    createdAt: timestamp(record.createdAt),
    ...(record.source === null ? {} : { source: toMessageSource(record.source) }),
    ...(record.sourceThreadId === null ? {} : { sourceThreadId: record.sourceThreadId }),
    attachments: record.attachments.map(toAttachment),
  };
}

export function toThreadCallReference(record: ThreadCallReferenceProjection) {
  return {
    delegation: toDelegation(record.delegation),
    sourceMessageId: record.sourceMessageId,
    sourceMessageSeq: BigInt(record.sourceMessageSeq),
  };
}

export function toThreadCard(record: ThreadCardProjection) {
  return {
    thread: toThread(record.thread),
    ...(record.lastMessageAt === null ? {} : { lastMessageAt: timestamp(record.lastMessageAt) }),
    messages: record.messages.map(toThreadMessagePreview),
    ...(record.sourceCall === null ? {} : { sourceCall: toThreadCallReference(record.sourceCall) }),
  };
}

export function toThreadCardCursor(record: ThreadCardCursor) {
  return {
    sort: record.sort === 'created_at' ? ThreadCardSort.CREATED_AT : ThreadCardSort.LAST_MESSAGE_AT,
    sortAt: timestamp(record.sortAt),
    threadSeq: record.threadSeq,
  };
}

export function toThreadCallPreview(record: ThreadCallPreviewProjection) {
  return {
    call: toThreadCallReference(record.call),
    targetThreadId: record.targetThreadId,
    targetTitle: record.targetTitle,
    status: toRunStatus(record.status),
    replyCount: BigInt(record.replyCount),
    replies: record.replies.map(toThreadMessagePreview),
    ...(record.responseMessageSeq === null
      ? {}
      : { responseMessageSeq: BigInt(record.responseMessageSeq) }),
  };
}

function toDelegation(key: NonNullable<InputRecord['delegation']>) {
  return {
    sourceThreadId: key.sourceThreadId,
    sourceAgentId: key.sourceAgentId,
    sourceToolCallId: key.sourceToolCallId,
  };
}

export function toInput(record: InputRecord) {
  return {
    inputId: record.inputId,
    threadId: record.threadId,
    text: record.text,
    mode: record.mode === 'steer' ? InputMode.STEER : InputMode.FOLLOW_UP,
    status:
      record.status === 'queued'
        ? InputStatus.QUEUED
        : record.status === 'consumed'
          ? InputStatus.CONSUMED
          : InputStatus.CANCELLED,
    position: BigInt(record.position),
    version: BigInt(record.version),
    source: toMessageSource(record.source),
    ...(record.delegation === null ? {} : { delegation: toDelegation(record.delegation) }),
    ...(record.sourceThreadId === null ? {} : { sourceThreadId: record.sourceThreadId }),
    ...(record.sourceAgentId === null ? {} : { sourceAgentId: record.sourceAgentId }),
    ...(record.automation === null ? {} : { automation: toAutomationReference(record.automation) }),
    attachments: (record.attachments ?? []).map(toAttachment),
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt),
  };
}

const errorCodes: Record<SessionErrorCode, ErrorCode> = {
  unauthenticated: ErrorCode.UNAUTHENTICATED,
  permission_denied: ErrorCode.PERMISSION_DENIED,
  version_conflict: ErrorCode.VERSION_CONFLICT,
  action_conflict: ErrorCode.ACTION_CONFLICT,
  device_offline: ErrorCode.DEVICE_OFFLINE,
  operation_unknown: ErrorCode.OPERATION_UNKNOWN,
  recap_invalid: ErrorCode.RECAP_INVALID,
  input_too_large: ErrorCode.INPUT_TOO_LARGE,
  protocol_incompatible: ErrorCode.PROTOCOL_INCOMPATIBLE,
  invalid_argument: ErrorCode.INVALID_ARGUMENT,
  not_found: ErrorCode.NOT_FOUND,
  failed_precondition: ErrorCode.FAILED_PRECONDITION,
  internal: ErrorCode.INTERNAL,
  sandbox_capacity_exhausted: ErrorCode.SANDBOX_CAPACITY_EXHAUSTED,
  sandbox_unavailable: ErrorCode.SANDBOX_UNAVAILABLE,
};

export function toErrorDetail(error: RunError & { terminal?: boolean }, clientActionId?: string) {
  return {
    code: errorCodes[error.code],
    message: error.message,
    retryable: error.retryable,
    ...(clientActionId === undefined ? {} : { clientActionId }),
    ...(error.terminal === undefined ? {} : { terminal: error.terminal }),
  };
}

export function toRun(record: RunRecord) {
  return {
    runId: record.runId,
    threadId: record.threadId,
    agentId: record.agentId,
    ...(record.sendToUserEnabled === undefined
      ? {}
      : { sendToUserEnabled: record.sendToUserEnabled }),
    status: toRunStatus(record.status),
    executionMode:
      record.executionMode === 'background'
        ? RunExecutionMode.BACKGROUND
        : RunExecutionMode.FOREGROUND,
    inputIds: record.inputIds,
    ...(record.parentRunId === null ? {} : { parentRunId: record.parentRunId }),
    ...(record.rerunFromMessageSeq === null
      ? {}
      : { rerunFromMessageSeq: BigInt(record.rerunFromMessageSeq) }),
    ...(record.supersededByRunId === null ? {} : { supersededByRunId: record.supersededByRunId }),
    ...(record.error ? { error: toErrorDetail(record.error) } : {}),
    ...(record.usageReported
      ? {
          usage: {
            inputTokens: BigInt(record.usage.inputTokens),
            outputTokens: BigInt(record.usage.outputTokens),
          },
        }
      : {}),
    createdAt: timestamp(record.createdAt),
    ...(record.startedAt ? { startedAt: timestamp(record.startedAt) } : {}),
    ...(record.finishedAt ? { finishedAt: timestamp(record.finishedAt) } : {}),
  };
}

export function toRunStatus(status: RunRecord['status']): RunStatus {
  switch (status) {
    case 'queued':
      return RunStatus.QUEUED;
    case 'running':
      return RunStatus.RUNNING;
    case 'waiting':
      return RunStatus.WAITING;
    case 'cancel_requested':
      return RunStatus.CANCEL_REQUESTED;
    case 'completed':
      return RunStatus.COMPLETED;
    case 'failed':
      return RunStatus.FAILED;
    case 'cancelled':
      return RunStatus.CANCELLED;
    case 'interrupted':
      return RunStatus.INTERRUPTED;
  }
}

export function toThreadNotification(record: ThreadNotificationRecord) {
  return {
    delegation: toDelegation(record),
    sourceRunId: record.sourceRunId,
    replyThreadId: record.replyThreadId,
    content: record.content,
    status:
      record.status === 'pending'
        ? ThreadNotificationStatus.PENDING
        : record.status === 'queued'
          ? ThreadNotificationStatus.QUEUED
          : record.status === 'consumed'
            ? ThreadNotificationStatus.CONSUMED
            : ThreadNotificationStatus.SUPERSEDED,
    ...(record.contextMessageSeq === null
      ? {}
      : { contextMessageSeq: BigInt(record.contextMessageSeq) }),
    ...(record.runId === null ? {} : { runId: record.runId }),
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt),
    ...(record.consumedAt === null ? {} : { consumedAt: timestamp(record.consumedAt) }),
  };
}

function originalMessageContent(record: ContextMessage): string {
  if (typeof record.message.content !== 'string') {
    throw new Error('Stored Context message content is not text.');
  }
  return record.message.content;
}

export function toCurrentMessage(record: ContextMessage) {
  const latest = record.revisions.at(-1);
  const originalContent = originalMessageContent(record);
  return {
    messageId: record.messageId,
    threadId: record.threadId,
    agentId: record.agentId,
    seq: BigInt(record.seq),
    role:
      record.message.role === 'system'
        ? MessageRole.SYSTEM
        : record.message.role === 'user'
          ? MessageRole.USER
          : record.message.role === 'assistant'
            ? MessageRole.ASSISTANT
            : MessageRole.TOOL,
    content: latest?.content ?? originalContent,
    contentBlocks:
      record.message.role === 'assistant'
        ? (record.message.content_blocks ?? []).map((block) => ({
            type: block.type === 'thinking' ? ContentBlockType.THINKING : ContentBlockType.TEXT,
            blockIndex: block.block_index,
            text: block.text,
          }))
        : [],
    toolCalls:
      record.message.role === 'assistant'
        ? (record.message.tool_calls ?? []).map((call) => ({
            toolCallId: call.id,
            toolName: call.name,
            argumentsJson: JSON.stringify(call.arguments),
            ...(call.block_index === undefined ? {} : { blockIndex: call.block_index }),
          }))
        : [],
    toolCallId: record.message.role === 'tool' ? record.message.tool_call_id : '',
    toolName: record.message.role === 'tool' ? record.message.tool_name : '',
    ...(record.message.role === 'tool'
      ? {
          toolStatus:
            record.message.status === 'success'
              ? ToolResultStatus.SUCCESS
              : record.message.status === 'error'
                ? ToolResultStatus.ERROR
                : ToolResultStatus.UNSPECIFIED,
          ...(record.message.error === undefined
            ? {}
            : {
                toolError: {
                  code: record.message.error.code,
                  message: record.message.error.message,
                },
              }),
        }
      : {}),
    attachments: (record.attachments ?? []).map(toAttachment),
    createdAt: timestamp(record.createdAt),
    ...(latest ? { revisionId: latest.revisionId } : {}),
    ...(record.runId === null ? {} : { runId: record.runId }),
    ...(record.sendToUserEnabled === undefined
      ? {}
      : { sendToUserEnabled: record.sendToUserEnabled }),
    ...(record.responseUsage === undefined
      ? {}
      : {
          usage: {
            inputTokens: BigInt(record.responseUsage.input_tokens),
            outputTokens: BigInt(record.responseUsage.output_tokens),
          },
        }),
    ...(record.source === null || record.source === undefined
      ? {}
      : { source: toMessageSource(record.source) }),
    ...(record.delegation === null || record.delegation === undefined
      ? {}
      : { delegation: toDelegation(record.delegation) }),
    ...(record.sourceInputId === null || record.sourceInputId === undefined
      ? {}
      : { sourceInputId: record.sourceInputId }),
    ...(record.sourceThreadId === null || record.sourceThreadId === undefined
      ? {}
      : { sourceThreadId: record.sourceThreadId }),
    ...(record.sourceAgentId === null || record.sourceAgentId === undefined
      ? {}
      : { sourceAgentId: record.sourceAgentId }),
    ...(record.automation === null || record.automation === undefined
      ? {}
      : { automation: toAutomationReference(record.automation) }),
  };
}

export function toAuditMessage(record: ContextMessage) {
  return {
    ...toCurrentMessage(record),
    content: originalMessageContent(record),
    originalContent: originalMessageContent(record),
    ...(record.supersededByRunId === null || record.supersededByRunId === undefined
      ? {}
      : { supersededByRunId: record.supersededByRunId }),
    revisions: record.revisions.map((revision, index) => {
      const previous = record.revisions[index - 1];
      return {
        revisionId: revision.revisionId,
        messageId: record.messageId,
        text: revision.content,
        ...(previous === undefined ? {} : { previousRevisionId: previous.revisionId }),
        createdAt: timestamp(revision.createdAt),
      };
    }),
  };
}

export const toMessage = toCurrentMessage;

export function toRevision(record: MessageRevisionRecord) {
  return {
    revisionId: record.revisionId,
    messageId: record.messageId,
    text: record.text,
    ...(record.previousRevisionId === undefined
      ? {}
      : { previousRevisionId: record.previousRevisionId }),
    createdAt: timestamp(record.createdAt),
  };
}

export function toRecap(record: RecapRecord & { cursor?: number | bigint }) {
  return {
    recapId: record.recapId,
    threadId: record.threadId,
    agentId: record.agentId,
    seq: BigInt(record.cursor ?? record.sourceSeqStart),
    sourceSeqStart: BigInt(record.sourceSeqStart),
    sourceSeqEnd: BigInt(record.sourceSeqEnd),
    sourceMessageSeqs: record.sourceMessageSeqs.map(BigInt),
    content: record.content,
    createdAt: timestamp(record.createdAt),
    validity: record.validity === 'valid' ? RecapValidity.VALID : RecapValidity.INVALID,
  };
}

export function toDevice(record: DeviceRecord) {
  return {
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    bashEnabled: record.bashEnabled,
    accountDescription: record.accountDescription,
    ...(record.pairedAt ? { pairedAt: timestamp(record.pairedAt) } : {}),
    ...(record.revokedAt ? { revokedAt: timestamp(record.revokedAt) } : {}),
    ...(record.lastSeenAt ? { lastSeenAt: timestamp(record.lastSeenAt) } : {}),
  };
}

export function toBashOperation(record: BashOperationRecord) {
  return {
    operationId: record.operationId,
    runId: record.runId,
    deviceId: record.deviceId,
    command: record.command,
    cwd: record.cwd,
    status: bashStatus(record.status),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    outputComplete: record.outputComplete,
    ...(record.endOffset === undefined ? {} : { endOffset: BigInt(record.endOffset) }),
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt),
  };
}

function bashStatus(status: BashOperationRecord['status']): BashOperationStatus {
  switch (status) {
    case 1:
      return BashOperationStatus.CREATED;
    case 2:
      return BashOperationStatus.ACCEPTED;
    case 3:
      return BashOperationStatus.RUNNING;
    case 4:
      return BashOperationStatus.CANCEL_REQUESTED;
    case 5:
      return BashOperationStatus.COMPLETED;
    case 6:
      return BashOperationStatus.FAILED;
    case 7:
      return BashOperationStatus.CANCELLED;
    case 8:
      return BashOperationStatus.EXPIRED;
    case 9:
      return BashOperationStatus.UNKNOWN;
    default:
      return BashOperationStatus.UNSPECIFIED;
  }
}

export function toThreadEvent(record: ThreadEventRecord) {
  const base = {
    eventId: record.eventId,
    threadId: record.threadId,
    seq: BigInt(record.seq),
    occurredAt: timestamp(record.occurredAt),
  };
  const payload = record.payload;
  switch (payload.case) {
    case 'threadCreated':
      return {
        ...base,
        payload: {
          case: 'threadCreated' as const,
          value: { thread: toThread(payload.value.thread) },
        },
      };
    case 'threadRenamed':
      return {
        ...base,
        payload: {
          case: 'threadRenamed' as const,
          value: { thread: toThread(payload.value.thread) },
        },
      };
    case 'inputAccepted':
      return {
        ...base,
        payload: { case: 'inputAccepted' as const, value: { input: toInput(payload.value.input) } },
      };
    case 'inputEdited':
      return {
        ...base,
        payload: { case: 'inputEdited' as const, value: { input: toInput(payload.value.input) } },
      };
    case 'inputRemoved':
      return {
        ...base,
        payload: {
          case: 'inputRemoved' as const,
          value: {
            input: toInput(payload.value.input),
            queueVersion: BigInt(payload.value.queueVersion),
          },
        },
      };
    case 'inputsReordered':
      return {
        ...base,
        payload: {
          case: 'inputsReordered' as const,
          value: {
            inputs: payload.value.inputs.map(toInput),
            queueVersion: BigInt(payload.value.queueVersion),
          },
        },
      };
    case 'messageCommitted':
      return {
        ...base,
        payload: {
          case: 'messageCommitted' as const,
          value: { message: toCurrentMessage(payload.value.message) },
        },
      };
    case 'messageRevised':
      return {
        ...base,
        payload: {
          case: 'messageRevised' as const,
          value: {
            messageId: payload.value.messageId,
            revision: toRevision(payload.value.revision),
          },
        },
      };
    case 'runChanged':
      return {
        ...base,
        payload: { case: 'runChanged' as const, value: { run: toRun(payload.value.run) } },
      };
    case 'contextViewChanged':
      return {
        ...base,
        payload: {
          case: 'contextViewChanged' as const,
          value: {
            agentId: payload.value.agentId,
            viewVersion: BigInt(payload.value.viewVersion),
            ...(payload.value.anchorMessageSeq === null
              ? {}
              : { anchorMessageSeq: BigInt(payload.value.anchorMessageSeq) }),
          },
        },
      };
    case 'hardCutStarted':
      return { ...base, payload: { case: 'hardCutStarted' as const, value: payload.value } };
    case 'hardCutCompleted':
      return {
        ...base,
        payload: {
          case: 'hardCutCompleted' as const,
          value: {
            ...payload.value,
            replacedSourceSeqs: payload.value.replacedSourceSeqs.map(BigInt),
          },
        },
      };
    case 'hardCutFailed':
      return {
        ...base,
        payload: {
          case: 'hardCutFailed' as const,
          value: {
            runId: payload.value.runId,
            ...(payload.value.operationId === undefined
              ? {}
              : { operationId: payload.value.operationId }),
            error: toErrorDetail(payload.value.error),
          },
        },
      };
    case 'recapCreated':
      return {
        ...base,
        payload: {
          case: 'recapCreated' as const,
          value: { recap: toRecap({ ...payload.value.recap, cursor: base.seq }) },
        },
      };
    case 'recapInvalidated':
      return { ...base, payload: { case: 'recapInvalidated' as const, value: payload.value } };
    case 'deviceChanged':
      return {
        ...base,
        payload: {
          case: 'deviceChanged' as const,
          value: { device: toDevice(payload.value.device) },
        },
      };
    case 'bashOperationChanged':
      return {
        ...base,
        payload: {
          case: 'bashOperationChanged' as const,
          value: { operation: toBashOperation(payload.value.operation) },
        },
      };
    case 'environmentBindingChanged':
      return {
        ...base,
        payload: {
          case: 'environmentBindingChanged' as const,
          value: {
            agentId: payload.value.agentId,
            ...(payload.value.binding
              ? { binding: toAgentEnvironmentBinding(payload.value.binding) }
              : {}),
          },
        },
      };
    case 'mainEnvironmentChanged':
      return {
        ...base,
        payload: { case: 'mainEnvironmentChanged' as const, value: toEnvironment(payload.value) },
      };
    case 'threadNotificationChanged':
      return {
        ...base,
        payload: {
          case: 'threadNotificationChanged' as const,
          value: { notification: toThreadNotification(payload.value.notification) },
        },
      };
  }
}

export function toTextDelta(record: TextDeltaRecord) {
  return {
    threadId: record.threadId,
    messageId: record.messageId,
    deltaSeq: BigInt(record.deltaSeq),
    text: record.text,
    ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
    ...(record.blockIndex === undefined ? {} : { blockIndex: record.blockIndex }),
    ...(record.runId === undefined ? {} : { runId: record.runId }),
  };
}

export function toThinkingDelta(record: ThinkingDeltaRecord) {
  return {
    threadId: record.threadId,
    messageId: record.messageId,
    deltaSeq: BigInt(record.deltaSeq),
    text: record.text,
    ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
    blockIndex: record.blockIndex,
    runId: record.runId,
  };
}

export function toWatchEvent(record: ThreadEventRecord | StreamDeltaRecord) {
  if ('seq' in record) {
    return { payload: { case: 'event' as const, value: toThreadEvent(record) } };
  }
  if ('thinking' in record) {
    return {
      payload: { case: 'thinkingDelta' as const, value: toThinkingDelta(record) },
    };
  }
  return { payload: { case: 'textDelta' as const, value: toTextDelta(record) } };
}

function toEnvironmentCapability(capability: DeviceCapability): EnvironmentCapability {
  switch (capability) {
    case DeviceCapability.BASH:
      return EnvironmentCapability.BASH;
    case DeviceCapability.FILE_READ:
      return EnvironmentCapability.FILE_READ;
    case DeviceCapability.FILE_WRITE:
      return EnvironmentCapability.FILE_WRITE;
    case DeviceCapability.FILE_EDIT:
      return EnvironmentCapability.FILE_EDIT;
    case DeviceCapability.DIRECTORY_CHECK:
      return EnvironmentCapability.DIRECTORY_CHECK;
    case DeviceCapability.DIRECTORY_LIST:
      return EnvironmentCapability.DIRECTORY_LIST;
    default:
      throw new Error('Stored environment capability is invalid.');
  }
}

function toCapabilityStatus(
  status: EnvironmentRecord['capabilityStatus'],
): EnvironmentCapabilityStatus {
  switch (status) {
    case 'pending':
      return EnvironmentCapabilityStatus.PENDING;
    case 'ready':
      return EnvironmentCapabilityStatus.READY;
    case 'failed':
      return EnvironmentCapabilityStatus.FAILED;
  }
}

function toDirectoryStatus(
  status: EnvironmentRecord['directoryStatus'],
): EnvironmentDirectoryStatus {
  switch (status) {
    case 'pending':
      return EnvironmentDirectoryStatus.PENDING;
    case 'ready':
      return EnvironmentDirectoryStatus.READY;
    case 'failed':
      return EnvironmentDirectoryStatus.FAILED;
  }
}

export function toEnvironment(record: EnvironmentRecord) {
  const bindingStatus = {
    pairing: EnvironmentBindingStatus.PAIRING,
    active: EnvironmentBindingStatus.ACTIVE,
    revoked: EnvironmentBindingStatus.REVOKED,
  }[record.bindingStatus];
  return {
    envId: record.envId,
    name: record.name,
    kind:
      record.kind === 'platform_sandbox'
        ? EnvironmentKind.PLATFORM_SANDBOX
        : record.autoDetect
          ? EnvironmentKind.UNSPECIFIED
          : record.kind === 'self_hosted_macos'
            ? EnvironmentKind.SELF_HOSTED_MACOS
            : EnvironmentKind.SELF_HOSTED_LINUX,
    ...(record.lifecycleState == null
      ? {}
      : {
          lifecycleState: {
            uninitialized: PlatformLifecycleState.UNINITIALIZED,
            starting: PlatformLifecycleState.STARTING,
            running: PlatformLifecycleState.RUNNING,
            pausing: PlatformLifecycleState.PAUSING,
            paused: PlatformLifecycleState.PAUSED,
            resuming: PlatformLifecycleState.RESUMING,
            deleting: PlatformLifecycleState.DELETING,
            deleted: PlatformLifecycleState.DELETED,
            error: PlatformLifecycleState.ERROR,
          }[record.lifecycleState],
        }),
    recommendedPwd: record.recommendedPwd,
    bindingStatus,
    connectionStatus:
      record.connectionStatus === 'online'
        ? EnvironmentConnectionStatus.ONLINE
        : EnvironmentConnectionStatus.OFFLINE,
    capabilityStatus: toCapabilityStatus(record.capabilityStatus),
    directoryStatus: toDirectoryStatus(record.directoryStatus),
    grantedCapabilities: record.grantedCapabilities.map(toEnvironmentCapability),
    ...(record.deviceId === undefined ? {} : { deviceId: record.deviceId }),
    ...(record.deviceBindingId === undefined ? {} : { deviceBindingId: record.deviceBindingId }),
    ...(record.instanceId === undefined ? {} : { instanceId: record.instanceId }),
    ...(record.daemonVersion === undefined ? {} : { daemonVersion: record.daemonVersion }),
    ...(record.os === undefined ? {} : { os: record.os }),
    ...(record.architecture === undefined ? {} : { architecture: record.architecture }),
    ...(record.statusReason === undefined ? {} : { statusReason: record.statusReason }),
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt),
    ...(record.pairedAt === undefined ? {} : { pairedAt: timestamp(record.pairedAt) }),
    ...(record.revokedAt === undefined ? {} : { revokedAt: timestamp(record.revokedAt) }),
    ...(record.lastSeenAt === undefined ? {} : { lastSeenAt: timestamp(record.lastSeenAt) }),
    ready: record.ready,
    ...(record.normalizedPwd === undefined ? {} : { normalizedPwd: record.normalizedPwd }),
    ...(record.checkedAt === undefined ? {} : { checkedAt: timestamp(record.checkedAt) }),
    maintenanceMode:
      record.maintenanceMode === 'draining'
        ? EnvironmentMaintenanceMode.DRAINING
        : EnvironmentMaintenanceMode.NORMAL,
    maintenanceVersion: BigInt(record.maintenanceVersion),
    settingsVersion: BigInt(record.settingsVersion),
    favoriteDirectories: record.favoriteDirectories,
  };
}
