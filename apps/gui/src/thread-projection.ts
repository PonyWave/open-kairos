import {
  type BashOperation,
  BashOperationStatus,
  type ContentBlock,
  ContentBlockSchema,
  ContentBlockType,
  type ContextHardCutCompleted,
  create,
  type DelegationReference,
  ErrorCode,
  type ErrorDetail,
  InputMode,
  InputStatus,
  type Message,
  type MessageRevision,
  MessageRole,
  MessageSource,
  type PersistedThreadEvent,
  RecapValidity,
  RunExecutionMode,
  RunStatus,
  type Thread,
  ThreadNotificationStatus,
  type ThreadSnapshot,
  ThreadType,
  type ToolProgress,
  ToolResultStatus,
  validateAgentEnvironmentBinding,
  validateAttachment,
  validateEnvironmentPolicy,
  type WatchThreadResponse,
} from '@kairos/contracts';
import { validateMainEnvironment } from './environment-view.js';

export class UnsupportedEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedEventError';
  }
}

export class EventGapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventGapError';
  }
}

export interface TransientResponse {
  messageId: string;
  deltaSeq: bigint;
  runId?: string | undefined;
  agentId?: string | undefined;
  contentBlocks: readonly ContentBlock[];
}

export interface HardCutProjection {
  runId: string;
  operationId: string | null;
  trigger: 'automatic' | 'manual';
  status: 'started' | 'completed' | 'failed';
  replacedSourceSeqs: readonly bigint[];
  recapIds: readonly string[];
  injectedMessageCount: number;
  error: string | null;
}

export interface ToolProgressState {
  toolCallId: string;
  text: string;
  authorization?: { serverName: string; authorizationUrl: string; expiresAt: string };
}

export interface ThreadProjectionState {
  snapshot: ThreadSnapshot | null;
  throughSeq: bigint;
  transientResponses: readonly TransientResponse[];
  toolProgress: ReadonlyMap<string, ToolProgressState>;
  bashOperations: readonly BashOperation[];
  hardCuts: readonly HardCutProjection[];
  invalidatedRecaps: Readonly<Record<string, string>>;
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new UnsupportedEventError(`事件缺少 ${field}。`);
  return value;
}

const toolResultStatuses: ReadonlySet<number> = new Set([
  ToolResultStatus.UNSPECIFIED,
  ToolResultStatus.SUCCESS,
  ToolResultStatus.ERROR,
]);
const messageRoles: ReadonlySet<number> = new Set([
  MessageRole.SYSTEM,
  MessageRole.USER,
  MessageRole.ASSISTANT,
  MessageRole.TOOL,
]);
const messageSources: ReadonlySet<number> = new Set([
  MessageSource.USER,
  MessageSource.THREAD_CALL,
  MessageSource.THREAD_RESPONSE,
  MessageSource.SUBAGENT_RESPONSE,
  MessageSource.AUTOMATION,
  MessageSource.THREAD_NOTIFICATION,
]);
const notificationStatuses: ReadonlySet<number> = new Set([
  ThreadNotificationStatus.PENDING,
  ThreadNotificationStatus.QUEUED,
  ThreadNotificationStatus.CONSUMED,
  ThreadNotificationStatus.SUPERSEDED,
]);
const threadTypes: ReadonlySet<number> = new Set([
  ThreadType.MAIN,
  ThreadType.TASK,
  ThreadType.WORKSPACE_MAIN,
]);
const executionModes: ReadonlySet<number> = new Set([
  RunExecutionMode.FOREGROUND,
  RunExecutionMode.BACKGROUND,
]);
const inputModes: ReadonlySet<number> = new Set([InputMode.FOLLOW_UP, InputMode.STEER]);
const inputStatuses: ReadonlySet<number> = new Set([
  InputStatus.QUEUED,
  InputStatus.CONSUMED,
  InputStatus.CANCELLED,
]);
const runStatuses: ReadonlySet<number> = new Set([
  RunStatus.QUEUED,
  RunStatus.RUNNING,
  RunStatus.WAITING,
  RunStatus.CANCEL_REQUESTED,
  RunStatus.COMPLETED,
  RunStatus.FAILED,
  RunStatus.CANCELLED,
  RunStatus.INTERRUPTED,
]);
const bashStatuses: ReadonlySet<number> = new Set([
  BashOperationStatus.CREATED,
  BashOperationStatus.ACCEPTED,
  BashOperationStatus.RUNNING,
  BashOperationStatus.CANCEL_REQUESTED,
  BashOperationStatus.COMPLETED,
  BashOperationStatus.FAILED,
  BashOperationStatus.CANCELLED,
  BashOperationStatus.EXPIRED,
  BashOperationStatus.UNKNOWN,
]);
const errorCodes: ReadonlySet<number> = new Set([
  ErrorCode.UNAUTHENTICATED,
  ErrorCode.PERMISSION_DENIED,
  ErrorCode.VERSION_CONFLICT,
  ErrorCode.ACTION_CONFLICT,
  ErrorCode.DEVICE_OFFLINE,
  ErrorCode.OPERATION_UNKNOWN,
  ErrorCode.RECAP_INVALID,
  ErrorCode.INPUT_TOO_LARGE,
  ErrorCode.PROTOCOL_INCOMPATIBLE,
  ErrorCode.INVALID_ARGUMENT,
  ErrorCode.NOT_FOUND,
  ErrorCode.FAILED_PRECONDITION,
  ErrorCode.INTERNAL,
]);

function validateEnum(value: number, known: ReadonlySet<number>, field: string): void {
  if (!known.has(value)) {
    throw new UnsupportedEventError(`${field} 含未知或未设置枚举值 ${value}。`);
  }
}

function validateDelegation(delegation: DelegationReference | undefined): void {
  if (
    delegation !== undefined &&
    (!delegation.sourceThreadId || !delegation.sourceAgentId || !delegation.sourceToolCallId)
  ) {
    throw new UnsupportedEventError('DelegationReference 必须包含完整来源三元组。');
  }
}

function validateMessage(message: Message): void {
  validateEnum(message.role, messageRoles, 'Message.role');
  validateEnum(message.toolStatus, toolResultStatuses, 'Message.tool_status');
  if (
    message.toolError &&
    (message.role !== MessageRole.TOOL ||
      message.toolStatus !== ToolResultStatus.ERROR ||
      !message.toolError.code ||
      typeof message.toolError.message !== 'string')
  ) {
    throw new UnsupportedEventError('工具错误缺少有效的终态或错误内容。');
  }
  if (message.source !== undefined) validateEnum(message.source, messageSources, 'Message.source');
  validateDelegation(message.delegation);
  validateMessageAttachments(message.attachments);
  const blockIndexes = new Set<number>();
  for (const block of message.contentBlocks) {
    if (block.type !== ContentBlockType.TEXT && block.type !== ContentBlockType.THINKING) {
      throw new UnsupportedEventError('Message.content_blocks 含未知或未设置块类型。');
    }
    if (blockIndexes.has(block.blockIndex)) {
      throw new UnsupportedEventError('Message.content_blocks 含重复块编号。');
    }
    blockIndexes.add(block.blockIndex);
  }
}

function validateInput(input: ThreadSnapshot['inputs'][number]): void {
  validateEnum(input.mode, inputModes, 'Input.mode');
  validateEnum(input.status, inputStatuses, 'Input.status');
  if (input.source !== undefined) validateEnum(input.source, messageSources, 'Input.source');
  validateDelegation(input.delegation);
  validateMessageAttachments(input.attachments);
}

function validateMessageAttachments(attachments: Message['attachments']): void {
  try {
    for (const attachment of attachments) validateAttachment(attachment);
  } catch (cause) {
    throw new UnsupportedEventError(
      `附件元数据无效：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function validateError(error: ErrorDetail): void {
  validateEnum(error.code, errorCodes, 'ErrorDetail.code');
}

function validateRun(run: ThreadSnapshot['runs'][number]): void {
  validateEnum(run.status, runStatuses, 'Run.status');
  if (run.executionMode !== undefined) {
    validateEnum(run.executionMode, executionModes, 'Run.execution_mode');
  }
  if (run.error) validateError(run.error);
}

function validateThread(thread: Thread): void {
  if (thread.threadType !== undefined) {
    validateEnum(thread.threadType, threadTypes, 'Thread.thread_type');
  }
  if (thread.environmentPolicy) {
    try {
      validateEnvironmentPolicy(thread.environmentPolicy);
    } catch (cause) {
      throw new UnsupportedEventError(
        cause instanceof Error ? cause.message : '任务环境授权无效。',
      );
    }
  }
}

function validateOperation(operation: BashOperation): void {
  validateEnum(operation.status, bashStatuses, 'BashOperation.status');
}

function validateRecap(recap: ThreadSnapshot['recaps'][number]): void {
  validateEnum(
    recap.validity,
    new Set([RecapValidity.VALID, RecapValidity.INVALID]),
    'Recap.validity',
  );
  if (!recap.recapId || !recap.agentId || !recap.content.trim()) {
    throw new UnsupportedEventError('Recap 缺少编号、Agent 归属或正文。');
  }
  let previous = 0n;
  for (const seq of recap.sourceMessageSeqs) {
    if (seq <= previous) {
      throw new UnsupportedEventError('Recap 来源序号必须严格递增。');
    }
    previous = seq;
  }
  if (recap.sourceSeqStart !== recap.sourceMessageSeqs[0] || recap.sourceSeqEnd !== previous) {
    throw new UnsupportedEventError('Recap 来源起止序号与来源集合不一致。');
  }
}

function validateNotification(notification: ThreadSnapshot['notifications'][number]): void {
  validateEnum(notification.status, notificationStatuses, 'ThreadNotification.status');
  validateDelegation(notification.delegation);
  if (!notification.sourceRunId || !notification.replyThreadId || !notification.content) {
    throw new UnsupportedEventError('通知缺少来源 Run、目标主对话或正文。');
  }
}

function validateSnapshot(snapshot: ThreadSnapshot): void {
  if (snapshot.thread) validateThread(snapshot.thread);
  if (snapshot.mainEnvironment) validatePlatformEnvironment(snapshot.mainEnvironment);
  for (const message of snapshot.messages) validateMessage(message);
  for (const input of snapshot.inputs) validateInput(input);
  for (const run of snapshot.runs) validateRun(run);
  for (const recap of snapshot.recaps) validateRecap(recap);
  for (const notification of snapshot.notifications) validateNotification(notification);
}

function validatePlatformEnvironment(
  environment: NonNullable<ThreadSnapshot['mainEnvironment']>,
): void {
  try {
    validateMainEnvironment(environment);
  } catch (cause) {
    throw new UnsupportedEventError(cause instanceof Error ? cause.message : '主环境状态无效。');
  }
}

function compareMessages(left: Message, right: Message): number {
  if (left.seq < right.seq) return -1;
  if (left.seq > right.seq) return 1;
  if (left.messageId === right.messageId) return 0;
  return left.messageId < right.messageId ? -1 : 1;
}

function mergeById<T>(
  current: readonly T[],
  incoming: readonly T[],
  id: (value: T) => string,
): T[] {
  const merged = new Map(current.map((value) => [id(value), value]));
  for (const value of incoming) merged.set(id(value), value);
  return [...merged.values()];
}

interface HardCutIdentity {
  key: string;
  runId: string;
  operationId: string | null;
  trigger: 'automatic' | 'manual';
}

function hardCutIdentity(runId: string, operationId: string | undefined): HardCutIdentity {
  if (operationId !== undefined) {
    if (!operationId) throw new UnsupportedEventError('手动硬切的 operation_id 不能为空。');
    return { key: `operation:${operationId}`, runId, operationId, trigger: 'manual' };
  }
  if (!runId) throw new UnsupportedEventError('自动硬切缺少 run_id 或手动硬切 operation_id。');
  return { key: `run:${runId}`, runId, operationId: null, trigger: 'automatic' };
}

function emptyHardCut(identity: HardCutIdentity): HardCutProjection {
  return {
    runId: identity.runId,
    operationId: identity.operationId,
    trigger: identity.trigger,
    status: 'started',
    replacedSourceSeqs: [],
    recapIds: [],
    injectedMessageCount: 0,
    error: null,
  };
}

export class ThreadProjector {
  private snapshot: ThreadSnapshot | null = null;
  private readonly messageIds = new Set<string>();
  private readonly runsById = new Map<string, ThreadSnapshot['runs'][number]>();
  private throughSeq = 0n;
  private readonly eventIds = new Set<string>();
  private readonly transient = new Map<string, TransientResponse>();
  private readonly toolProgress = new Map<string, ToolProgressState>();
  private readonly operations = new Map<string, BashOperation>();
  private readonly hardCutMap = new Map<string, HardCutProjection>();
  private readonly invalidRecaps: Record<string, string> = {};

  constructor(readonly threadId: string) {}

  get state(): ThreadProjectionState {
    return {
      snapshot: this.snapshot,
      throughSeq: this.throughSeq,
      transientResponses: [...this.transient.values()],
      toolProgress: this.toolProgress,
      bashOperations: [...this.operations.values()],
      hardCuts: [...this.hardCutMap.values()],
      invalidatedRecaps: { ...this.invalidRecaps },
    };
  }

  applySnapshot(snapshot: ThreadSnapshot, throughSeq: bigint): void {
    if (required(snapshot.thread, 'snapshot.thread').threadId !== this.threadId) {
      throw new UnsupportedEventError('快照不属于当前会话。');
    }
    for (const message of snapshot.messages) this.assertThread(message.threadId);
    for (const input of snapshot.inputs) this.assertThread(input.threadId);
    for (const run of snapshot.runs) this.assertThread(run.threadId);
    for (const recap of snapshot.recaps) this.assertThread(recap.threadId);
    for (const notification of snapshot.notifications) {
      this.assertThread(notification.delegation?.sourceThreadId ?? '');
    }
    validateSnapshot(snapshot);
    this.snapshot = {
      ...snapshot,
      messages: [...snapshot.messages].sort(compareMessages),
      inputs: [...snapshot.inputs],
      runs: [...snapshot.runs],
      devices: [...snapshot.devices],
      recaps: [...snapshot.recaps],
      notifications: [...snapshot.notifications],
    };
    this.indexSnapshot();
    this.throughSeq = throughSeq;
    this.eventIds.clear();
    this.clearTransient();
    this.operations.clear();
    this.hardCutMap.clear();
    for (const recapId of Object.keys(this.invalidRecaps)) delete this.invalidRecaps[recapId];
  }

  applySnapshotPage(snapshot: ThreadSnapshot, throughSeq: bigint): void {
    if (!this.snapshot) {
      this.applySnapshot(snapshot, throughSeq);
      return;
    }
    if (throughSeq !== this.throughSeq) {
      throw new UnsupportedEventError('分页快照的事件序号不一致。');
    }
    if (snapshot.thread) this.assertThread(snapshot.thread.threadId);
    if (
      snapshot.mainEnvironment &&
      this.snapshot.mainEnvironment &&
      snapshot.mainEnvironment.envId !== this.snapshot.mainEnvironment.envId
    ) {
      throw new UnsupportedEventError('分页主环境编号与首份快照不一致。');
    }
    for (const message of snapshot.messages) this.assertThread(message.threadId);
    for (const input of snapshot.inputs) this.assertThread(input.threadId);
    for (const run of snapshot.runs) this.assertThread(run.threadId);
    for (const recap of snapshot.recaps) this.assertThread(recap.threadId);
    for (const notification of snapshot.notifications) {
      this.assertThread(notification.delegation?.sourceThreadId ?? '');
    }
    validateSnapshot(snapshot);
    const current = this.snapshot;
    this.snapshot = {
      ...current,
      ...(snapshot.thread ? { thread: snapshot.thread } : {}),
      ...(snapshot.mainEnvironment ? { mainEnvironment: snapshot.mainEnvironment } : {}),
      messages: mergeById(current.messages, snapshot.messages, (message) => message.messageId).sort(
        compareMessages,
      ),
      inputs: mergeById(current.inputs, snapshot.inputs, (input) => input.inputId),
      runs: mergeById(current.runs, snapshot.runs, (run) => run.runId),
      devices: mergeById(current.devices, snapshot.devices, (device) => device.deviceId),
      recaps: mergeById(current.recaps, snapshot.recaps, (recap) => recap.recapId),
      notifications: mergeById(
        current.notifications,
        snapshot.notifications,
        (notification) =>
          `${notification.delegation?.sourceThreadId ?? ''}:${notification.delegation?.sourceAgentId ?? ''}:${notification.delegation?.sourceToolCallId ?? ''}`,
      ),
    };
    this.indexSnapshot();
  }

  clearTransient(): void {
    this.transient.clear();
    this.toolProgress.clear();
  }

  applyWatchResponse(response: WatchThreadResponse): void {
    if (response.payload.case === 'event') {
      this.applyPersisted(response.payload.value);
      return;
    }
    if (response.payload.case === 'textDelta') {
      this.applyTransientDelta(response.payload.value, ContentBlockType.TEXT);
      return;
    }
    if (response.payload.case === 'thinkingDelta') {
      this.applyTransientDelta(response.payload.value, ContentBlockType.THINKING);
      return;
    }
    if (response.payload.case === 'toolProgress') {
      this.applyToolProgress(response.payload.value);
      return;
    }
    throw new UnsupportedEventError('收到未知事件负载，已停止应用后续事件。');
  }

  private applyToolProgress(progress: ToolProgress): void {
    this.assertThread(progress.threadId);
    if (progress.agentId !== 'thread') return;
    this.toolProgress.set(progress.toolCallId, {
      toolCallId: progress.toolCallId,
      text: progress.text,
      ...(progress.authorization === undefined || progress.authorization.expiresAt === undefined
        ? {}
        : {
            authorization: {
              serverName: progress.authorization.serverName,
              authorizationUrl: progress.authorization.authorizationUrl,
              expiresAt: new Date(
                Number(progress.authorization.expiresAt.seconds) * 1000 +
                  progress.authorization.expiresAt.nanos / 1_000_000,
              ).toISOString(),
            },
          }),
    });
  }

  private applyTransientDelta(
    delta: {
      threadId: string;
      messageId: string;
      deltaSeq: bigint;
      text: string;
      blockIndex?: number | undefined;
      runId?: string | undefined;
      agentId?: string | undefined;
    },
    type: ContentBlockType.TEXT | ContentBlockType.THINKING,
  ): void {
    this.assertThread(delta.threadId);
    if (!delta.messageId) throw new UnsupportedEventError('临时增量缺少消息编号。');
    if (this.messageIds.has(delta.messageId)) return;
    const associatedRun = delta.runId ? this.runsById.get(delta.runId) : undefined;
    if (
      associatedRun &&
      (associatedRun.status === RunStatus.COMPLETED ||
        associatedRun.status === RunStatus.FAILED ||
        associatedRun.status === RunStatus.CANCELLED ||
        associatedRun.status === RunStatus.INTERRUPTED)
    ) {
      return;
    }
    if (delta.agentId !== undefined && !delta.agentId.trim())
      throw new UnsupportedEventError('增量缺少有效 Agent 归属。');
    if (delta.agentId && associatedRun?.agentId && delta.agentId !== associatedRun.agentId)
      throw new UnsupportedEventError('增量与 Run 的 Agent 归属冲突。');
    const previous = this.transient.get(delta.messageId);
    if (previous?.agentId && delta.agentId && previous.agentId !== delta.agentId)
      throw new UnsupportedEventError('同一消息的 Agent 归属不能改变。');
    if (previous) {
      if (delta.deltaSeq <= previous.deltaSeq) return;
      if (delta.deltaSeq !== previous.deltaSeq + 1n) {
        throw new EventGapError('临时增量不连续，将重新连接。');
      }
      if (previous.runId && delta.runId && previous.runId !== delta.runId) {
        throw new UnsupportedEventError('同一临时 response 不能关联不同 Run。');
      }
    }
    const blockIndex = delta.blockIndex ?? 0;
    const currentBlocks = previous?.contentBlocks ?? [];
    const existing = currentBlocks.find((block) => block.blockIndex === blockIndex);
    if (existing && existing.type !== type) {
      throw new UnsupportedEventError('同一块编号不能同时包含正文和思考内容。');
    }
    const contentBlocks = existing
      ? currentBlocks.map((block) =>
          block.blockIndex === blockIndex
            ? create(ContentBlockSchema, { ...block, text: `${block.text}${delta.text}` })
            : block,
        )
      : [...currentBlocks, create(ContentBlockSchema, { type, blockIndex, text: delta.text })];
    contentBlocks.sort((left, right) => left.blockIndex - right.blockIndex);
    this.transient.set(delta.messageId, {
      messageId: delta.messageId,
      deltaSeq: delta.deltaSeq,
      runId: delta.runId || previous?.runId,
      agentId: delta.agentId || previous?.agentId || associatedRun?.agentId,
      contentBlocks,
    });
  }

  private applyPersisted(event: PersistedThreadEvent): void {
    this.assertThread(event.threadId);
    if (!event.eventId) throw new UnsupportedEventError('持久事件缺少 event_id。');
    if (event.seq <= this.throughSeq) return;
    if (this.eventIds.has(event.eventId)) {
      throw new UnsupportedEventError('同一 event_id 对应了不同事件序号。');
    }
    if (event.seq !== this.throughSeq + 1n) {
      throw new EventGapError(`事件序号不连续：当前 ${this.throughSeq}，收到 ${event.seq}。`);
    }
    this.applyPayload(event);
    this.eventIds.add(event.eventId);
    this.throughSeq = event.seq;
  }

  private applyPayload(event: PersistedThreadEvent): void {
    const payload = event.payload;
    switch (payload.case) {
      case 'threadCreated':
      case 'threadRenamed':
        this.updateThread(required(payload.value.thread, payload.case));
        return;
      case 'inputAccepted':
      case 'inputEdited':
        this.updateInput(required(payload.value.input, payload.case));
        return;
      case 'inputRemoved':
        this.updateInput(required(payload.value.input, payload.case));
        this.updateSnapshot({ queueVersion: payload.value.queueVersion });
        return;
      case 'inputsReordered':
        for (const input of payload.value.inputs) validateInput(input);
        this.updateSnapshot({
          inputs: [...payload.value.inputs],
          queueVersion: payload.value.queueVersion,
        });
        return;
      case 'messageCommitted':
        this.updateMessage(required(payload.value.message, payload.case));
        return;
      case 'messageRevised':
        this.updateRevision(required(payload.value.revision, payload.case));
        return;
      case 'runChanged':
        this.updateRun(required(payload.value.run, payload.case));
        return;
      case 'threadNotificationChanged': {
        const notification = required(payload.value.notification, payload.case);
        validateNotification(notification);
        if (!this.snapshot) throw new EventGapError('通知事件到达时快照尚未加载。');
        this.assertThread(notification.delegation?.sourceThreadId ?? '');
        if (notification.delegation?.sourceAgentId !== 'thread') {
          throw new UnsupportedEventError('通知来源不是持久任务根 Agent。');
        }
        const key = `${notification.delegation.sourceThreadId}:${notification.delegation.sourceAgentId}:${notification.delegation.sourceToolCallId}`;
        const identity = (candidate: ThreadSnapshot['notifications'][number]) =>
          `${candidate.delegation?.sourceThreadId ?? ''}:${candidate.delegation?.sourceAgentId ?? ''}:${candidate.delegation?.sourceToolCallId ?? ''}`;
        const found = this.snapshot.notifications.some((candidate) => identity(candidate) === key);
        this.updateSnapshot({
          notifications: found
            ? this.snapshot.notifications.map((candidate) =>
                identity(candidate) === key ? notification : candidate,
              )
            : [...this.snapshot.notifications, notification],
        });
        return;
      }
      case 'environmentBindingChanged': {
        if (!payload.value.agentId) {
          throw new UnsupportedEventError('环境绑定变化缺少 Agent 标识。');
        }
        if (payload.value.agentId !== 'thread') return;
        if (!this.snapshot?.thread) throw new EventGapError('环境绑定事件到达时快照尚未加载。');
        const thread = { ...this.snapshot.thread };
        if (payload.value.binding) {
          validateAgentEnvironmentBinding(payload.value.binding);
          thread.currentBinding = payload.value.binding;
        } else {
          delete thread.currentBinding;
        }
        this.updateThread(thread);
        return;
      }
      case 'mainEnvironmentChanged':
        validatePlatformEnvironment(payload.value);
        if (!this.snapshot) throw new EventGapError('主环境事件到达时快照尚未加载。');
        if (
          this.snapshot.mainEnvironment &&
          this.snapshot.mainEnvironment.envId !== payload.value.envId
        ) {
          throw new UnsupportedEventError('主环境编号与快照不一致。');
        }
        this.updateSnapshot({ mainEnvironment: payload.value });
        return;
      case 'contextViewChanged':
        return;
      case 'hardCutStarted': {
        const identity = hardCutIdentity(payload.value.runId, payload.value.operationId);
        this.hardCutMap.set(identity.key, emptyHardCut(identity));
        return;
      }
      case 'hardCutCompleted':
        this.completeHardCut(payload.value);
        return;
      case 'hardCutFailed': {
        if (payload.value.error) validateError(payload.value.error);
        const identity = hardCutIdentity(payload.value.runId, payload.value.operationId);
        this.hardCutMap.set(identity.key, {
          ...emptyHardCut(identity),
          status: 'failed',
          error:
            payload.value.error?.message ||
            (identity.trigger === 'manual'
              ? '手动硬切失败，Server 未提交新的读取状态。'
              : '自动硬切失败，模型请求已暂停。'),
        });
        return;
      }
      case 'recapCreated':
        this.updateRecap(required(payload.value.recap, payload.case));
        return;
      case 'recapInvalidated':
        this.invalidateRecap(payload.value.recapId, payload.value.reason);
        return;
      case 'deviceChanged':
        this.updateDevice(required(payload.value.device, payload.case));
        return;
      case 'bashOperationChanged': {
        const operation = required(payload.value.operation, payload.case);
        validateOperation(operation);
        this.operations.set(operation.operationId, operation);
        return;
      }
      default:
        throw new UnsupportedEventError('收到未知持久事件，已停止应用后续事件。');
    }
  }

  private updateThread(thread: NonNullable<ThreadSnapshot['thread']>): void {
    this.assertThread(thread.threadId);
    validateThread(thread);
    this.updateSnapshot({ thread });
  }

  private updateInput(input: ThreadSnapshot['inputs'][number]): void {
    this.assertThread(input.threadId);
    validateInput(input);
    if (!this.snapshot) throw new EventGapError('输入事件到达时快照尚未加载。');
    const found = this.snapshot.inputs.some((item) => item.inputId === input.inputId);
    this.updateSnapshot({
      inputs: found
        ? this.snapshot.inputs.map((item) => (item.inputId === input.inputId ? input : item))
        : [...this.snapshot.inputs, input],
    });
  }

  private updateMessage(message: Message): void {
    this.assertThread(message.threadId);
    validateMessage(message);
    if (!this.snapshot) throw new EventGapError('消息事件到达时快照尚未加载。');
    const found = this.snapshot.messages.some((item) => item.messageId === message.messageId);
    this.updateSnapshot({
      messages: (found
        ? this.snapshot.messages.map((item) =>
            item.messageId === message.messageId ? message : item,
          )
        : [...this.snapshot.messages, message]
      ).sort(compareMessages),
    });
    this.messageIds.add(message.messageId);
    this.transient.delete(message.messageId);
    if (message.role === MessageRole.TOOL) this.toolProgress.delete(message.toolCallId);
  }

  private updateRevision(revision: MessageRevision): void {
    if (!this.snapshot) throw new EventGapError('修订事件到达时快照尚未加载。');
    this.updateSnapshot({
      messages: this.snapshot.messages.map((message) =>
        message.messageId === revision.messageId
          ? { ...message, content: revision.text, revisionId: revision.revisionId }
          : message,
      ),
    });
  }

  private updateRun(run: ThreadSnapshot['runs'][number]): void {
    this.assertThread(run.threadId);
    validateRun(run);
    if (!this.snapshot) throw new EventGapError('Run 事件到达时快照尚未加载。');
    const found = this.snapshot.runs.some((item) => item.runId === run.runId);
    this.updateSnapshot({
      runs: found
        ? this.snapshot.runs.map((item) => (item.runId === run.runId ? run : item))
        : [...this.snapshot.runs, run],
    });
    this.runsById.set(run.runId, run);
    if (
      run.status === RunStatus.COMPLETED ||
      run.status === RunStatus.FAILED ||
      run.status === RunStatus.CANCELLED ||
      run.status === RunStatus.INTERRUPTED
    ) {
      for (const [messageId, response] of this.transient) {
        if (response.runId === run.runId) this.transient.delete(messageId);
      }
      this.toolProgress.clear();
    }
  }

  private updateRecap(recap: ThreadSnapshot['recaps'][number]): void {
    this.assertThread(recap.threadId);
    validateRecap(recap);
    if (recap.validity !== RecapValidity.VALID) {
      throw new UnsupportedEventError('Recap 创建事件必须包含有效正文。');
    }
    if (!this.snapshot) throw new EventGapError('Recap 事件到达时快照尚未加载。');
    this.updateSnapshot({
      recaps: mergeById(this.snapshot.recaps, [recap], (item) => item.recapId),
    });
    delete this.invalidRecaps[recap.recapId];
  }

  private invalidateRecap(recapId: string, reason: string): void {
    if (!recapId) throw new UnsupportedEventError('Recap 失效事件缺少编号。');
    if (!this.snapshot) throw new EventGapError('Recap 失效事件到达时快照尚未加载。');
    this.invalidRecaps[recapId] = reason;
    this.updateSnapshot({
      recaps: this.snapshot.recaps.filter((recap) => recap.recapId !== recapId),
    });
  }

  private updateDevice(device: ThreadSnapshot['devices'][number]): void {
    if (!this.snapshot) throw new EventGapError('设备事件到达时快照尚未加载。');
    const found = this.snapshot.devices.some((item) => item.deviceId === device.deviceId);
    this.updateSnapshot({
      devices: found
        ? this.snapshot.devices.map((item) => (item.deviceId === device.deviceId ? device : item))
        : [...this.snapshot.devices, device],
    });
  }

  private completeHardCut(completed: ContextHardCutCompleted): void {
    const identity = hardCutIdentity(completed.runId, completed.operationId);
    this.hardCutMap.set(identity.key, {
      ...emptyHardCut(identity),
      status: 'completed',
      replacedSourceSeqs: [...completed.replacedSourceSeqs],
      recapIds: [...completed.recapIds],
      injectedMessageCount: completed.injectedMessageCount,
      error: null,
    });
  }

  private updateSnapshot(patch: Partial<ThreadSnapshot>): void {
    if (!this.snapshot) throw new EventGapError('事件到达时快照尚未加载。');
    this.snapshot = { ...this.snapshot, ...patch };
  }

  private indexSnapshot(): void {
    this.messageIds.clear();
    this.runsById.clear();
    for (const message of this.snapshot?.messages ?? []) this.messageIds.add(message.messageId);
    for (const run of this.snapshot?.runs ?? []) this.runsById.set(run.runId, run);
  }

  private assertThread(threadId: string): void {
    if (threadId !== this.threadId) {
      throw new UnsupportedEventError('事件或记录不属于当前会话。');
    }
  }
}
