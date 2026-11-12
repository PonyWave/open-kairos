import { CompactContextStatus, RunStatus, type Thread, ThreadType } from '@kairos/contracts';
import type { ClientActionRecord } from './actions.js';
import { requireAutomation, requireAutomationFire } from './automation-model.js';
import { localTaskDraftId, type MessageDraft, newDraft } from './drafts.js';
import { parseQueueDraftRestore, type QueueDraftRestore } from './queue-draft.js';

export interface DraftCompletion {
  threadId: string;
  draftId: string;
  text: string;
  attachmentIds?: string[] | undefined;
  exactText?: boolean;
}

export interface ActionCompletionEffects {
  restoreQueueDraft?: (restore: QueueDraftRestore) => void;
  upsertThread: (thread: Thread) => void;
  selectThread: (threadId: string) => void;
  startNewMain?: (thread: Thread) => void;
  completeDraft: (completion: DraftCompletion) => void;
  removeDraftAttachment?: (input: {
    draftOwner: string;
    draftId: string;
    localId: string;
    attachmentId: string;
  }) => void;
  closeForm: (key: string) => void;
  showNotice: (message: string) => void;
  automationChanged?: () => void;
}

export function completeGuiAction(
  record: ClientActionRecord,
  result: unknown,
  effects: ActionCompletionEffects,
): void {
  const payload = objectValue(record.payload, '操作参数');
  switch (record.kind) {
    case 'createThread': {
      const thread = threadResponse(result, 'CreateThreadResponse');
      if (payload.initialText !== undefined || payload.initialAttachmentIds !== undefined) {
        const response = objectValue(result, 'CreateThreadResponse');
        text(response, 'inputId');
        text(response, 'runId');
        effects.completeDraft({
          threadId: localTaskDraftId,
          draftId: text(payload, 'draftId'),
          text: content(payload, 'initialText'),
          attachmentIds: optionalStringArray(payload, 'initialAttachmentIds'),
        });
      }
      effects.upsertThread(thread);
      effects.selectThread(thread.threadId);
      return;
    }
    case 'renameThread':
      effects.upsertThread(threadResponse(result, 'RenameThreadResponse'));
      return;
    case 'sendMessage': {
      const threadId = text(payload, 'threadId');
      if (text(objectValue(result, 'SendMessageResponse'), 'threadId') !== threadId) {
        throw new Error('SendMessage 响应与会话不一致。');
      }
      text(objectValue(result, 'SendMessageResponse'), 'inputId');
      effects.completeDraft({
        threadId,
        draftId: text(payload, 'draftId'),
        text: content(payload, 'text'),
        attachmentIds: optionalStringArray(payload, 'attachmentIds'),
      });
      return;
    }
    case 'deleteAttachment': {
      const response = objectValue(result, 'DeleteAttachmentResponse');
      const attachmentId = text(payload, 'attachmentId');
      requireMatchingId(result, 'attachmentId', attachmentId, 'DeleteAttachment');
      booleanField(response, 'deleted');
      effects.removeDraftAttachment?.({
        draftOwner: text(payload, 'draftOwner'),
        draftId: text(payload, 'draftId'),
        localId: text(payload, 'localId'),
        attachmentId,
      });
      return;
    }
    case 'reviseMessage': {
      const response = objectValue(result, 'ReviseMessageResponse');
      requireMatchingId(result, 'messageId', text(payload, 'messageId'), 'ReviseMessage');
      text(response, 'revisionId');
      effects.closeForm(record.key);
      return;
    }
    case 'editInput': {
      const response = objectValue(result, 'EditInputResponse');
      requireMatchingId(result, 'inputId', text(payload, 'inputId'), 'EditInput');
      bigintField(response, 'version');
      effects.closeForm(record.key);
      return;
    }
    case 'removeInput': {
      const response = objectValue(result, 'RemoveInputResponse');
      requireMatchingId(result, 'inputId', text(payload, 'inputId'), 'RemoveInput');
      bigintField(response, 'queueVersion');
      if (payload.draftRestore !== undefined) {
        const restore = parseQueueDraftRestore(payload.draftRestore);
        if (restore.inputId !== payload.inputId || restore.draftOwner !== payload.threadId)
          throw new Error('队列恢复记录与原输入不一致。');
        if (!effects.restoreQueueDraft) throw new Error('当前界面无法恢复队列草稿。');
        effects.restoreQueueDraft(restore);
      }
      return;
    }
    case 'reorderInputs': {
      const response = objectValue(result, 'ReorderInputsResponse');
      const inputs = arrayField(response, 'inputs');
      for (const input of inputs) text(objectValue(input, 'Input'), 'inputId');
      bigintField(response, 'queueVersion');
      return;
    }
    case 'cancelRun': {
      const response = objectValue(result, 'CancelRunResponse');
      requireMatchingId(result, 'runId', text(payload, 'runId'), 'CancelRun');
      runStatus(response.status);
      return;
    }
    case 'continueRun': {
      const response = objectValue(result, 'ContinueRunResponse');
      requireMatchingId(result, 'runId', text(payload, 'runId'), 'ContinueRun');
      runStatus(response.status);
      return;
    }
    case 'rerun': {
      const response = objectValue(result, 'RerunResponse');
      text(response, 'runId');
      runStatus(response.status);
      return;
    }
    case 'reloadResources':
    case 'compactContext': {
      const threadId = text(payload, 'threadId');
      const notice =
        record.kind === 'reloadResources'
          ? reloadResourcesNotice(result)
          : compactContextNotice(result);
      effects.completeDraft({
        threadId,
        draftId: text(payload, 'draftId'),
        text: text(payload, 'text'),
        attachmentIds: [],
        exactText: true,
      });
      effects.showNotice(notice);
      return;
    }
    case 'startNewMain': {
      const response = objectValue(result, 'StartNewMainResponse');
      const thread = response.thread;
      if (response.$typeName !== 'kairos.gui.v1.StartNewMainResponse' || !isThread(thread)) {
        throw new Error('StartNewMainResponse 缺少有效会话。');
      }
      if (thread.threadType !== ThreadType.MAIN || thread.newConversation !== true) {
        throw new Error('StartNewMainResponse 未标记新的主对话。');
      }
      if (thread.threadId === text(payload, 'threadId')) {
        throw new Error('StartNewMainResponse 未更换主对话编号。');
      }
      effects.completeDraft({
        threadId: text(payload, 'threadId'),
        draftId: text(payload, 'draftId'),
        text: text(payload, 'text'),
        attachmentIds: [],
        exactText: true,
      });
      if (!effects.startNewMain) throw new Error('当前界面无法切换主对话。');
      effects.startNewMain(thread);
      return;
    }
    case 'createAutomation':
    case 'updateAutomation': {
      const operation =
        record.kind === 'createAutomation' ? 'CreateAutomation' : 'UpdateAutomation';
      const response = objectValue(result, `${operation}Response`);
      if (response.$typeName !== `kairos.gui.v1.${operation}Response`) {
        throw new Error(`${operation}Response 格式无效。`);
      }
      const automation = requireAutomation(
        response.automation as Parameters<typeof requireAutomation>[0],
      );
      if (
        record.kind === 'updateAutomation' &&
        automation.scheduleId !== text(payload, 'scheduleId')
      ) {
        throw new Error('UpdateAutomation 响应与原操作不一致。');
      }
      effects.automationChanged?.();
      return;
    }
    case 'deleteAutomation': {
      const response = objectValue(result, 'DeleteAutomationResponse');
      if (response.$typeName !== 'kairos.gui.v1.DeleteAutomationResponse') {
        throw new Error('DeleteAutomationResponse 格式无效。');
      }
      requireMatchingId(result, 'scheduleId', text(payload, 'scheduleId'), 'DeleteAutomation');
      if (!booleanField(response, 'deleted')) {
        throw new Error('DeleteAutomation 未确认删除结果。');
      }
      effects.automationChanged?.();
      return;
    }
    case 'runAutomationNow': {
      const response = objectValue(result, 'RunAutomationNowResponse');
      if (response.$typeName !== 'kairos.gui.v1.RunAutomationNowResponse') {
        throw new Error('RunAutomationNowResponse 格式无效。');
      }
      const fire = requireAutomationFire(
        response.fire as Parameters<typeof requireAutomationFire>[0],
      );
      if (fire.scheduleId !== text(payload, 'scheduleId')) {
        throw new Error('RunAutomationNow 响应与原操作不一致。');
      }
      effects.automationChanged?.();
      return;
    }
  }
}

function reloadResourcesNotice(result: unknown): string {
  const response = objectValue(result, 'ReloadResourcesResponse');
  if (response.$typeName !== 'kairos.gui.v1.ReloadResourcesResponse') {
    throw new Error('ReloadResourcesResponse 格式无效。');
  }
  text(response, 'snapshotId');
  const changed = booleanField(response, 'changed');
  workspacePaths(response, 'resources');
  const added = workspacePaths(response, 'added');
  const updated = workspacePaths(response, 'updated');
  const removed = workspacePaths(response, 'removed');
  if (!changed && added.length + updated.length + removed.length > 0) {
    throw new Error('ReloadResourcesResponse 的 noop 结果包含资源变化。');
  }
  validateReloadRuntime(response);
  if (!changed) {
    return '/reload 已完成：已加载当前提示词与 Skill。';
  }
  return '/reload 已完成：提示词与 Skill 已更新。';
}

function validateReloadRuntime(response: Record<string, unknown>): void {
  const fingerprint = response.runtimeFingerprint;
  if (
    fingerprint !== undefined &&
    (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint))
  ) {
    throw new Error('ReloadResourcesResponse.runtime_fingerprint 格式无效。');
  }
  const changed = response.runtimeChanged;
  if (changed !== undefined && typeof changed !== 'boolean') {
    throw new Error('ReloadResourcesResponse.runtime_changed 不是布尔值。');
  }
}

function compactContextNotice(result: unknown): string {
  const response = objectValue(result, 'CompactContextResponse');
  if (response.$typeName !== 'kairos.gui.v1.CompactContextResponse') {
    throw new Error('CompactContextResponse 格式无效。');
  }
  text(response, 'operationId');
  if (
    response.status !== CompactContextStatus.CHANGED &&
    response.status !== CompactContextStatus.NOOP
  ) {
    throw new Error('CompactContextResponse 状态未知或未设置。');
  }
  const readThroughSeq = bigintField(response, 'readThroughSeq');
  if (readThroughSeq < 0n) throw new Error('CompactContextResponse 读取位置无效。');
  stringArrayField(response, 'recapIds');
  if (response.status === CompactContextStatus.NOOP) {
    return '/compact 已完成：当前没有需要压缩的消息。';
  }
  return '/compact 已完成：对话上下文已压缩。';
}

function workspacePaths(payload: Record<string, unknown>, key: string): string[] {
  return stringArrayField(payload, key).map((path) => {
    const segments = path.split('/');
    if (
      path.startsWith('/') ||
      path.includes('\\') ||
      path.includes('\0') ||
      segments.some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      throw new Error(`ReloadResourcesResponse.${key} 含非法工作区相对路径。`);
    }
    return path;
  });
}

function stringArrayField(payload: Record<string, unknown>, key: string): string[] {
  return arrayField(payload, key).map((value) => {
    if (typeof value !== 'string' || !value) throw new Error(`响应字段 ${key} 含无效字符串。`);
    return value;
  });
}

function booleanField(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key];
  if (typeof value !== 'boolean') throw new Error(`响应字段 ${key} 不是布尔值。`);
  return value;
}

export function applyDraftCompletion(
  draft: MessageDraft,
  completion: DraftCompletion,
): MessageDraft | null {
  if (draft.id !== completion.draftId) return null;
  const textMatches = completion.exactText
    ? draft.text === completion.text
    : draft.text.trim() === completion.text.trim();
  const attachmentIds = completion.attachmentIds ?? [];
  if (!textMatches && attachmentIds.length === 0) return null;
  const submitted = new Set(attachmentIds);
  const attachments = (draft.attachments ?? []).filter(
    (item) => !item.metadata || !submitted.has(item.metadata.attachmentId),
  );
  const text = textMatches ? '' : draft.text;
  if (!text && attachments.length === 0) return newDraft();
  return { ...draft, text, attachments };
}

function optionalStringArray(payload: Record<string, unknown>, key: string): string[] | undefined {
  return payload[key] === undefined ? undefined : stringArrayField(payload, key);
}

function threadResponse(
  value: unknown,
  typeName: 'CreateThreadResponse' | 'RenameThreadResponse',
): Thread {
  const body = objectValue(value, typeName);
  const thread = body.thread;
  if (body.$typeName !== `kairos.gui.v1.${typeName}` || !isThread(thread)) {
    throw new Error(`${typeName} 缺少有效会话。`);
  }
  return thread;
}

function isThread(value: unknown): value is Thread {
  const body = objectValue(value, 'Thread');
  return (
    body.$typeName === 'kairos.gui.v1.Thread' &&
    typeof body.threadId === 'string' &&
    typeof body.title === 'string' &&
    typeof body.seq === 'bigint'
  );
}

function requireMatchingId(
  result: unknown,
  field: string,
  expected: string,
  operation: string,
): void {
  if (text(objectValue(result, `${operation}Response`), field) !== expected) {
    throw new Error(`${operation} 响应与原操作不一致。`);
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 格式无效。`);
  }
  return value as Record<string, unknown>;
}

function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value) throw new Error(`操作参数字段 ${key} 无效。`);
  return value;
}

function content(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') throw new Error(`操作参数字段 ${key} 无效。`);
  return value;
}

function bigintField(payload: Record<string, unknown>, key: string): bigint {
  const value = payload[key];
  if (typeof value !== 'bigint') throw new Error(`响应字段 ${key} 不是 uint64。`);
  return value;
}

function arrayField(payload: Record<string, unknown>, key: string): unknown[] {
  const value = payload[key];
  if (!Array.isArray(value)) throw new Error(`响应字段 ${key} 不是数组。`);
  return value;
}

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

function runStatus(value: unknown): void {
  if (typeof value !== 'number' || !runStatuses.has(value)) {
    throw new Error('Run 响应状态未知或未设置。');
  }
}
