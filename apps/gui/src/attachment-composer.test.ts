import { InputMode } from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { applyDraftCompletion } from './action-completion.js';
import type { AttachmentMetadata } from './attachments.js';
import { planComposerSubmission } from './composer-submission.js';
import type { DraftAttachment, MessageDraft } from './drafts.js';

function metadata(id: string, mediaType = 'text/plain'): AttachmentMetadata {
  return {
    attachmentId: id,
    fileName: `${id}.txt`,
    mediaType,
    sizeBytes: 10n,
    sha256: id.padEnd(64, '0').slice(0, 64),
  };
}

function ready(id: string): DraftAttachment {
  const attachment = metadata(id);
  return {
    localId: `local-${id}`,
    actionKey: `upload-${id}`,
    actionId: `action-${id}`,
    fileName: attachment.fileName,
    declaredMediaType: 'text/plain',
    sizeBytes: 10,
    sha256: attachment.sha256,
    status: 'ready',
    metadata: attachment,
  };
}

describe('attachment composer submission', () => {
  it('creates a Thread for attachment-only input with ordered initial ids', () => {
    const attachments = [ready('b'), ready('a')];
    const submission = planComposerSubmission({
      draftId: 'draft-1',
      text: '',
      attachments,
      mode: InputMode.FOLLOW_UP,
      busy: false,
      isTaskDraft: true,
      selectedThreadId: null,
      snapshotReady: false,
    });
    expect(submission).toMatchObject({
      kind: 'action',
      actionKind: 'createThread',
      payload: {
        initialText: '',
        initialAttachmentIds: ['b', 'a'],
        draftId: 'draft-1',
      },
    });
  });

  it('rejects slash commands with attachments before creating an action', () => {
    const submission = planComposerSubmission({
      draftId: 'draft-1',
      text: '/reload',
      attachments: [ready('a')],
      mode: InputMode.FOLLOW_UP,
      busy: false,
      isTaskDraft: false,
      selectedThreadId: 'thread-1',
      snapshotReady: true,
    });
    expect(submission).toEqual({
      kind: 'error',
      message: '斜杠命令不能携带附件；请先移除附件或改为普通消息。',
    });
  });

  it('does not send pending or duplicate attachments', () => {
    const pending = { ...ready('a'), status: 'uploading' as const, metadata: undefined };
    const base = {
      draftId: 'draft-1',
      text: '',
      mode: InputMode.FOLLOW_UP,
      busy: false,
      isTaskDraft: false,
      selectedThreadId: 'thread-1',
      snapshotReady: true,
    };
    expect(planComposerSubmission({ ...base, attachments: [pending] })).toMatchObject({
      kind: 'error',
    });
    expect(planComposerSubmission({ ...base, attachments: [ready('a'), ready('a')] })).toEqual({
      kind: 'error',
      message: '同一内容不能重复添加为多个附件。',
    });
  });
});

describe('attachment submission cleanup', () => {
  it('removes only the submitted snapshot and preserves newer text and attachments', () => {
    const first = ready('a');
    const second = ready('b');
    const draft: MessageDraft = {
      id: 'draft-1',
      text: '发送后的新编辑',
      attachments: [first, second],
    };
    const completed = applyDraftCompletion(draft, {
      threadId: 'thread-1',
      draftId: draft.id,
      text: '原提交',
      attachmentIds: ['a'],
    });
    expect(completed).toMatchObject({
      id: 'draft-1',
      text: '发送后的新编辑',
      attachments: [second],
    });
  });

  it('clears submitted text while retaining an attachment added during the request', () => {
    const draft: MessageDraft = {
      id: 'draft-1',
      text: '原提交',
      attachments: [ready('a'), ready('b')],
    };
    const completed = applyDraftCompletion(draft, {
      threadId: 'thread-1',
      draftId: draft.id,
      text: '原提交',
      attachmentIds: ['a'],
    });
    expect(completed?.text).toBe('');
    expect(completed?.attachments?.map((item) => item.metadata?.attachmentId)).toEqual(['b']);
  });
});
