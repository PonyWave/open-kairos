import { InputMode } from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { type ComposerSubmissionContext, planComposerSubmission } from './composer-submission.js';

function context(overrides: Partial<ComposerSubmissionContext> = {}): ComposerSubmissionContext {
  return {
    draftId: 'draft-1',
    text: '普通消息',
    mode: InputMode.FOLLOW_UP,
    busy: false,
    isTaskDraft: false,
    selectedThreadId: 'thread-1',
    snapshotReady: true,
    ...overrides,
  };
}

describe('planComposerSubmission slash commands', () => {
  it.each([
    ['/reload', 'reloadResources', 'reload'],
    ['/compact', 'compactContext', 'compact'],
    ['/new', 'startNewMain', 'new'],
  ] as const)('routes %s only to its persistent RPC action', (text, actionKind, command) => {
    const submission = planComposerSubmission(context({ text, isMainThread: command === 'new' }));
    expect(submission).toMatchObject({
      kind: 'action',
      key: `slash-command:${command}:thread-1:draft-1`,
      actionKind,
      payload: { threadId: 'thread-1', draftId: 'draft-1', text },
    });
    if (submission.kind !== 'action') throw new Error('missing action');
    expect(submission.pendingNotice).toBe(
      command === 'reload'
        ? '正在重载提示词与 Skill…'
        : command === 'compact'
          ? '正在压缩上下文…'
          : undefined,
    );
    expect(submission.requiresConfirmation).toBe(command === 'new' ? 'newConversation' : undefined);
    if (submission.pendingNotice !== undefined) {
      expect(submission.pendingNotice).not.toContain('Run');
    }
  });

  it('requires the main conversation and a second confirmation for /new', () => {
    expect(planComposerSubmission(context({ text: '/new' }))).toEqual({
      kind: 'error',
      message: '/new 仅在主对话中可用。',
    });
    const main = planComposerSubmission(context({ text: '/new', isMainThread: true }));
    expect(main).toMatchObject({
      kind: 'action',
      actionKind: 'startNewMain',
      requiresConfirmation: 'newConversation',
    });
  });

  it.each(['/unknown', '/reload now', '/compact now'])(
    'keeps invalid input %s as a local error without an action',
    (text) => {
      expect(planComposerSubmission(context({ text })).kind).toBe('error');
    },
  );

  it.each(['/reload', '/compact'])(
    'does not create an empty Thread for %s in a local task draft',
    (text) => {
      const submission = planComposerSubmission(context({ text, isTaskDraft: true }));
      expect(submission).toEqual({
        kind: 'error',
        message: '请先发送一条消息创建话题，并等待消息加载后再执行命令。',
      });
    },
  );

  it('requires a loaded persistent Thread snapshot before executing a command', () => {
    expect(planComposerSubmission(context({ text: '/reload', snapshotReady: false })).kind).toBe(
      'error',
    );
    expect(planComposerSubmission(context({ text: '/compact', selectedThreadId: null })).kind).toBe(
      'error',
    );
  });

  it('does not submit commands or ordinary messages while another action is busy', () => {
    expect(planComposerSubmission(context({ text: '/reload', busy: true }))).toEqual({
      kind: 'ignore',
    });
    expect(planComposerSubmission(context({ busy: true }))).toEqual({ kind: 'ignore' });
  });
});

describe('planComposerSubmission ordinary messages', () => {
  it.each([InputMode.FOLLOW_UP, InputMode.STEER])(
    'preserves the existing send action and mode %s',
    (mode) => {
      const submission = planComposerSubmission(context({ text: '  普通消息  ', mode }));
      expect(submission).toEqual({
        kind: 'action',
        key: 'send-message:thread-1:draft-1',
        actionKind: 'sendMessage',
        payload: { threadId: 'thread-1', draftId: 'draft-1', text: '普通消息', mode },
      });
    },
  );

  it('preserves atomic first-input creation for an ordinary new task draft', () => {
    const submission = planComposerSubmission(
      context({
        text: '首条输入',
        mode: InputMode.STEER,
        isTaskDraft: true,
      }),
    );
    expect(submission).toEqual({
      kind: 'action',
      key: 'create-thread:draft-1',
      actionKind: 'createThread',
      payload: {
        title: '新话题',
        autoSummarizeTitle: true,
        initialText: '首条输入',
        initialMode: InputMode.STEER,
        draftId: 'draft-1',
      },
    });
  });

  it('keeps multiline text and slash text inside an ordinary message', () => {
    const text = '第一行\n/reload';
    const submission = planComposerSubmission(context({ text }));
    expect(submission).toMatchObject({ actionKind: 'sendMessage', payload: { text } });
    expect(planComposerSubmission(context({ text: '   ' }))).toEqual({ kind: 'ignore' });
  });
});
