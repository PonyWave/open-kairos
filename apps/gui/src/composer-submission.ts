import type { InputMode } from '@kairos/contracts';
import type { ActionKind } from './actions.js';
import { validateAttachmentLimits } from './attachments.js';
import type { DraftAttachment } from './drafts.js';
import { parseSlashCommand } from './slash-commands.js';

export interface ComposerSubmissionContext {
  draftId: string;
  text: string;
  attachments?: DraftAttachment[] | undefined;
  mode: InputMode;
  busy: boolean;
  isTaskDraft: boolean;
  isMainThread?: boolean | undefined;
  workspaceId?: string | null | undefined;
  selectedThreadId: string | null;
  snapshotReady: boolean;
}

export type ComposerSubmission =
  | { kind: 'ignore' }
  | { kind: 'error'; message: string }
  | {
      kind: 'action';
      key: string;
      actionKind: ActionKind;
      payload: unknown;
      pendingNotice?: string;
      requiresConfirmation?: 'newConversation' | undefined;
    };

export function planComposerSubmission(context: ComposerSubmissionContext): ComposerSubmission {
  const parsed = parseSlashCommand(context.text);
  if (parsed.kind === 'error') return { kind: 'error', message: parsed.message };
  if (context.busy) return { kind: 'ignore' };
  const attachments = context.attachments ?? [];
  if (parsed.kind === 'command' && attachments.length > 0) {
    return { kind: 'error', message: '斜杠命令不能携带附件；请先移除附件或改为普通消息。' };
  }

  if (parsed.kind === 'command') {
    if (context.isTaskDraft || !context.selectedThreadId || !context.snapshotReady) {
      return {
        kind: 'error',
        message: '请先发送一条消息创建话题，并等待消息加载后再执行命令。',
      };
    }
    if (parsed.command === 'new' && context.isMainThread !== true) {
      return { kind: 'error', message: '/new 仅在主对话中可用。' };
    }
    const actionKind =
      parsed.command === 'reload'
        ? 'reloadResources'
        : parsed.command === 'compact'
          ? 'compactContext'
          : 'startNewMain';
    const pendingNotice =
      parsed.command === 'reload'
        ? '正在重载提示词与 Skill…'
        : parsed.command === 'compact'
          ? '正在压缩上下文…'
          : '正在开始新对话…';
    return {
      kind: 'action',
      key: `slash-command:${parsed.command}:${context.selectedThreadId}:${context.draftId}`,
      actionKind,
      payload: {
        threadId: context.selectedThreadId,
        draftId: context.draftId,
        text: context.text,
      },
      pendingNotice,
      ...(parsed.command === 'new' ? { requiresConfirmation: 'newConversation' as const } : {}),
    };
  }

  const text = parsed.text.trim();
  if (!text && attachments.length === 0) return { kind: 'ignore' };
  let attachmentIds: string[];
  try {
    if (attachments.some((attachment) => attachment.status !== 'ready' || !attachment.metadata)) {
      return { kind: 'error', message: '附件尚未全部就绪，请完成上传或结果核对后再发送。' };
    }
    const metadata = attachments.map((attachment) => {
      if (!attachment.metadata) throw new Error('附件元数据缺失。');
      return attachment.metadata;
    });
    validateAttachmentLimits(metadata);
    attachmentIds = metadata.map((attachment) => attachment.attachmentId);
  } catch (cause) {
    return { kind: 'error', message: cause instanceof Error ? cause.message : String(cause) };
  }
  const clipboardAttachmentIds = attachments
    .filter((attachment) => attachment.source === 'clipboard')
    .map((attachment) => attachment.metadata?.attachmentId)
    .filter((attachmentId): attachmentId is string => attachmentId !== undefined);
  if (context.isTaskDraft) {
    return {
      kind: 'action',
      key: `create-thread:${context.draftId}`,
      actionKind: 'createThread',
      payload: {
        title: '新话题',
        autoSummarizeTitle: true,
        initialText: text,
        initialMode: context.mode,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(context.attachments === undefined ? {} : { initialAttachmentIds: attachmentIds }),
        ...(context.attachments === undefined
          ? {}
          : { initialClipboardAttachmentIds: clipboardAttachmentIds }),
        draftId: context.draftId,
      },
    };
  }
  if (!context.selectedThreadId || !context.snapshotReady) return { kind: 'ignore' };
  return {
    kind: 'action',
    key: `send-message:${context.selectedThreadId}:${context.draftId}`,
    actionKind: 'sendMessage',
    payload: {
      threadId: context.selectedThreadId,
      draftId: context.draftId,
      text,
      ...(context.attachments === undefined ? {} : { attachmentIds }),
      ...(context.attachments === undefined ? {} : { clipboardAttachmentIds }),
      mode: context.mode,
    },
  };
}
