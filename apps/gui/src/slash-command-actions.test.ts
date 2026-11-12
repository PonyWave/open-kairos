import { clearSubmittedDraft } from './draft-test-support.js';
/// <reference lib="dom" />

import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import {
  type CompactContextResponse,
  CompactContextResponseSchema,
  CompactContextStatus,
  ContextService,
  create,
  ErrorCode,
  ErrorDetailSchema,
  MessageService,
  type ReloadResourcesResponse,
  ReloadResourcesResponseSchema,
  RunService,
  type StartNewMainResponse,
  StartNewMainResponseSchema,
  ThreadService,
  ThreadType,
  WorkspaceService,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { applyDraftCompletion, completeGuiAction } from './action-completion.js';
import { ActionExecutor } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import { ClientActionStore, type StorageLike } from './actions.js';
import { createKairosClients } from './client.js';
import { loadDraft, newDraft, saveDraft } from './drafts.js';

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

interface HarnessOptions {
  loseReload?: boolean;
  loseCompact?: boolean;
  loseNew?: boolean;
  reject?: 'reload' | 'compact';
  terminalFailure?: 'reload' | 'compact';
  reloadChanged?: boolean;
  reloadRuntimeFingerprint?: string;
  reloadRuntimeChanged?: boolean;
  compactStatus?: CompactContextStatus;
  onReload?: () => void;
  onCompact?: () => void;
  onNew?: () => void;
}

function createHarness(options: HarnessOptions = {}) {
  const reloadIds: string[] = [];
  const compactIds: string[] = [];
  const newIds: string[] = [];
  const acceptedReload = new Map<string, ReloadResourcesResponse>();
  const acceptedCompact = new Map<string, CompactContextResponse>();
  const acceptedNew = new Map<string, StartNewMainResponse>();
  const calls = { create: 0, send: 0, cancel: 0 };
  const transport = createRouterTransport((router) => {
    router.service(WorkspaceService, {
      reloadResources(request) {
        reloadIds.push(request.clientActionId);
        const existing = acceptedReload.get(request.clientActionId);
        if (existing) return existing;
        if (options.reject === 'reload') throw busyError();
        if (options.terminalFailure === 'reload' && reloadIds.length === 1) {
          throw terminalError();
        }
        const response = create(ReloadResourcesResponseSchema, {
          snapshotId: 'snapshot-v2',
          changed: options.reloadChanged ?? true,
          resources: ['AGENTS.md', '.agents/skills/review/SKILL.md'],
          ...(options.reloadChanged === false
            ? {}
            : {
                added: ['.agents/skills/review/SKILL.md'],
                updated: ['AGENTS.md'],
                removed: ['.agents/skills/old/SKILL.md'],
              }),
          ...(options.reloadRuntimeFingerprint === undefined
            ? {}
            : { runtimeFingerprint: options.reloadRuntimeFingerprint }),
          ...(options.reloadRuntimeChanged === undefined
            ? {}
            : { runtimeChanged: options.reloadRuntimeChanged }),
        });
        acceptedReload.set(request.clientActionId, response);
        options.onReload?.();
        if (options.loseReload && reloadIds.length === 1) {
          throw new ConnectError('response lost', Code.Unavailable);
        }
        return response;
      },
    });
    router.service(ContextService, {
      compactContext(request) {
        compactIds.push(request.clientActionId);
        const existing = acceptedCompact.get(request.clientActionId);
        if (existing) return existing;
        if (options.reject === 'compact') throw busyError();
        if (options.terminalFailure === 'compact' && compactIds.length === 1) {
          throw terminalError();
        }
        const response = create(CompactContextResponseSchema, {
          operationId: 'compact-operation-1',
          status: options.compactStatus ?? CompactContextStatus.CHANGED,
          readThroughSeq: 9_007_199_254_740_993n,
          recapIds: ['recap-1', 'recap-2'],
        });
        acceptedCompact.set(request.clientActionId, response);
        options.onCompact?.();
        if (options.loseCompact && compactIds.length === 1) {
          throw new ConnectError('response lost', Code.Unavailable);
        }
        return response;
      },
    });
    router.service(ThreadService, {
      createThread(request) {
        calls.create += 1;
        return {
          clientActionId: request.clientActionId,
          thread: { threadId: 'unexpected', title: request.title, seq: 1n },
        };
      },
      startNewMain(request) {
        newIds.push(request.clientActionId);
        const existing = acceptedNew.get(request.clientActionId);
        if (existing) return existing;
        const response = create(StartNewMainResponseSchema, {
          clientActionId: request.clientActionId,
          thread: {
            threadId: 'main-new',
            title: '主对话',
            threadType: ThreadType.MAIN,
            newConversation: true,
            seq: 2n,
          },
        });
        acceptedNew.set(request.clientActionId, response);
        options.onNew?.();
        if (options.loseNew && newIds.length === 1) {
          throw new ConnectError('response lost', Code.Unavailable);
        }
        return response;
      },
    });
    router.service(MessageService, {
      sendMessage(request) {
        calls.send += 1;
        return {
          clientActionId: request.clientActionId,
          inputId: 'unexpected',
          threadId: request.threadId,
        };
      },
    });
    router.service(RunService, {
      cancelRun(request) {
        calls.cancel += 1;
        return {
          clientActionId: request.clientActionId,
          runId: request.runId,
          status: 5,
        };
      },
    });
  });
  return {
    handlers: createActionHandlers(createKairosClients({ transport })),
    reloadIds,
    compactIds,
    newIds,
    calls,
  };
}

function busyError(): ConnectError {
  return new ConnectError('busy', Code.FailedPrecondition, undefined, [
    {
      desc: ErrorDetailSchema,
      value: {
        code: ErrorCode.FAILED_PRECONDITION,
        message: 'Wait for the active root Run to finish first.',
        retryable: false,
      },
    },
  ]);
}

function terminalError(): ConnectError {
  return new ConnectError('persisted failure', Code.Internal, undefined, [
    {
      desc: ErrorDetailSchema,
      value: {
        code: ErrorCode.INTERNAL,
        message: 'The Server saved a failed operation.',
        retryable: false,
        terminal: true,
      },
    },
  ]);
}

function completionEffects(storage: MemoryStorage, notices: string[]) {
  return {
    upsertThread: () => {},
    selectThread: () => {},
    completeDraft: (completion: { threadId: string; draftId: string; text: string }) => {
      clearSubmittedDraft(storage, completion);
    },
    closeForm: () => {},
    showNotice: (message: string) => notices.push(message),
  };
}

function commandDraft(text: string) {
  return { ...newDraft(), text };
}

function commandPayload(draft: ReturnType<typeof commandDraft>) {
  return { threadId: 'thread-1', draftId: draft.id, text: draft.text };
}

describe('slash command persistent actions', () => {
  it('recovers /reload through WorkspaceService with the original action id', async () => {
    const storage = new MemoryStorage();
    const draft = commandDraft('/reload');
    saveDraft(storage, 'thread-1', draft);
    const notices: string[] = [];
    const harness = createHarness({
      loseReload: true,
      reloadRuntimeFingerprint: '0123456789abcdef'.repeat(4),
      reloadRuntimeChanged: true,
    });
    const key = `slash-command:reload:thread-1:${draft.id}`;
    const executor = new ActionExecutor(
      new ClientActionStore(storage),
      harness.handlers,
      (record, result) => completeGuiAction(record, result, completionEffects(storage, notices)),
    );

    await executor.execute(key, 'reloadResources', commandPayload(draft));
    expect(executor.state.failures[0]?.outcome).toBe('unknown');
    expect(loadDraft(storage, 'thread-1')).toEqual(draft);

    const restoredStore = new ClientActionStore(storage);
    const restored = new ActionExecutor(restoredStore, harness.handlers, (record, result) =>
      completeGuiAction(record, result, completionEffects(storage, notices)),
    );
    expect(restored.state.failures[0]?.restored).toBe(true);
    await restored.retry(key);

    expect(harness.reloadIds).toHaveLength(2);
    expect(harness.reloadIds[0]).toBe(harness.reloadIds[1]);
    expect(harness.compactIds).toEqual([]);
    expect(harness.calls).toEqual({ create: 0, send: 0, cancel: 0 });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe('/reload 已完成：提示词与 Skill 已更新。');
    expect(notices[0]).not.toContain('snapshot-v2');
    expect(notices[0]).not.toContain('新增：.agents/skills/review/SKILL.md');
    expect(notices[0]).not.toContain('更新：AGENTS.md');
    expect(notices[0]).not.toContain('删除：.agents/skills/old/SKILL.md');
    expect(notices[0]).not.toContain('当前运行规格 0123456789ab 与上次完成请求不同');
    expect(notices[0]).not.toContain('GUI 会话快照与 Provider 未重载');
    expect(notices[0]).not.toContain('新 Run');
    expect(restoredStore.pending()).toEqual([]);
    expect(loadDraft(storage, 'thread-1').text).toBe('');
  });

  it('recovers /compact through ContextService with lossless persisted results', async () => {
    const storage = new MemoryStorage();
    const draft = commandDraft('/compact');
    saveDraft(storage, 'thread-1', draft);
    const notices: string[] = [];
    const harness = createHarness({ loseCompact: true });
    const key = `slash-command:compact:thread-1:${draft.id}`;
    const store = new ClientActionStore(storage);
    const executor = new ActionExecutor(store, harness.handlers, (record, result) =>
      completeGuiAction(record, result, completionEffects(storage, notices)),
    );

    await executor.execute(key, 'compactContext', commandPayload(draft));
    await executor.retry(key);

    expect(harness.compactIds).toHaveLength(2);
    expect(harness.compactIds[0]).toBe(harness.compactIds[1]);
    expect(harness.reloadIds).toEqual([]);
    expect(harness.calls).toEqual({ create: 0, send: 0, cancel: 0 });
    expect(notices[0]).toBe('/compact 已完成：对话上下文已压缩。');
    expect(notices[0]).not.toContain('compact-operation-1');
    expect(notices[0]).not.toContain('#9007199254740993');
    expect(notices[0]).not.toContain('合并 2 条 Recap');
    expect(store.pending()).toEqual([]);
    expect(loadDraft(storage, 'thread-1').text).toBe('');
  });

  it('recovers /new without creating another main conversation', async () => {
    const storage = new MemoryStorage();
    const draft = commandDraft('/new');
    saveDraft(storage, 'thread-1', draft);
    const notices: string[] = [];
    const selected: string[] = [];
    const harness = createHarness({ loseNew: true });
    const key = `slash-command:new:thread-1:${draft.id}`;
    const store = new ClientActionStore(storage);
    const effects = {
      ...completionEffects(storage, notices),
      startNewMain: (thread: { threadId: string }) => selected.push(thread.threadId),
    };
    const executor = new ActionExecutor(store, harness.handlers, (record, result) =>
      completeGuiAction(record, result, effects),
    );

    await executor.execute(key, 'startNewMain', commandPayload(draft));
    expect(executor.state.failures[0]?.outcome).toBe('unknown');
    expect(selected).toEqual([]);
    const restoredStore = new ClientActionStore(storage);
    const restored = new ActionExecutor(restoredStore, harness.handlers, (record, result) =>
      completeGuiAction(record, result, effects),
    );
    await restored.retry(key);

    expect(harness.newIds).toHaveLength(2);
    expect(harness.newIds[0]).toBe(harness.newIds[1]);
    expect(selected).toEqual(['main-new']);
    expect(restoredStore.pending()).toEqual([]);
    expect(loadDraft(storage, 'thread-1').text).toBe('');
    expect(notices).toEqual([]);
    expect(harness.calls).toEqual({ create: 0, send: 0, cancel: 0 });
  });

  it('shows /reload resource noop with a runtime change and preserves edits', async () => {
    const storage = new MemoryStorage();
    const draft = commandDraft('/reload');
    saveDraft(storage, 'thread-1', draft);
    const notices: string[] = [];
    const harness = createHarness({
      reloadChanged: false,
      reloadRuntimeFingerprint: '0123456789abcdef'.repeat(4),
      reloadRuntimeChanged: true,
      onReload: () => {
        saveDraft(storage, 'thread-1', { ...draft, text: '后续编辑' });
      },
    });
    const executor = new ActionExecutor(
      new ClientActionStore(storage),
      harness.handlers,
      (record, result) => completeGuiAction(record, result, completionEffects(storage, notices)),
    );

    await executor.execute(
      `slash-command:reload:thread-1:${draft.id}`,
      'reloadResources',
      commandPayload(draft),
    );

    expect(notices[0]).toBe('/reload 已完成：已加载当前提示词与 Skill。');
    expect(notices[0]).not.toContain('snapshot-v2 未变化');
    expect(notices[0]).not.toContain('当前资源：AGENTS.md、.agents/skills/review/SKILL.md');
    expect(notices[0]).not.toContain('当前运行规格 0123456789ab 与上次完成请求不同');
    expect(loadDraft(storage, 'thread-1').text).toBe('后续编辑');
    expect(harness.calls).toEqual({ create: 0, send: 0, cancel: 0 });
  });

  it('preserves an explicit false runtime_changed through real action completion', async () => {
    const storage = new MemoryStorage();
    const draft = commandDraft('/reload');
    saveDraft(storage, 'thread-1', draft);
    const notices: string[] = [];
    const harness = createHarness({
      reloadChanged: false,
      reloadRuntimeFingerprint: '0123456789abcdef'.repeat(4),
      reloadRuntimeChanged: false,
    });
    const store = new ClientActionStore(storage);
    const executor = new ActionExecutor(store, harness.handlers, (record, result) =>
      completeGuiAction(record, result, completionEffects(storage, notices)),
    );

    await executor.execute(
      `slash-command:reload:thread-1:${draft.id}`,
      'reloadResources',
      commandPayload(draft),
    );

    expect(notices[0]).not.toContain('当前运行规格 0123456789ab 与上次完成请求相同');
    expect(notices[0]).not.toContain('历史基线未知');
    expect(store.pending()).toEqual([]);
    expect(loadDraft(storage, 'thread-1').text).toBe('');
    expect(harness.calls).toEqual({ create: 0, send: 0, cancel: 0 });
  });

  it('keeps absent optional runtime fields unknown through real action completion', async () => {
    const storage = new MemoryStorage();
    const draft = commandDraft('/reload');
    saveDraft(storage, 'thread-1', draft);
    const notices: string[] = [];
    const harness = createHarness({ reloadChanged: false });
    const store = new ClientActionStore(storage);
    const executor = new ActionExecutor(store, harness.handlers, (record, result) =>
      completeGuiAction(record, result, completionEffects(storage, notices)),
    );

    await executor.execute(
      `slash-command:reload:thread-1:${draft.id}`,
      'reloadResources',
      commandPayload(draft),
    );

    expect(notices[0]).toBe('/reload 已完成：已加载当前提示词与 Skill。');
    expect(notices[0]).not.toContain('当前运行规格指纹未返回；历史基线未知');
    expect(notices[0]).not.toContain('与上次完成请求相同');
    expect(notices[0]).not.toContain('与上次完成请求不同');
    expect(store.pending()).toEqual([]);
    expect(loadDraft(storage, 'thread-1').text).toBe('');
    expect(harness.calls).toEqual({ create: 0, send: 0, cancel: 0 });
  });

  it('shows /compact noop without treating it as a changed hard cut', async () => {
    const storage = new MemoryStorage();
    const draft = commandDraft('/compact');
    saveDraft(storage, 'thread-1', draft);
    const notices: string[] = [];
    const harness = createHarness({ compactStatus: CompactContextStatus.NOOP });
    const executor = new ActionExecutor(
      new ClientActionStore(storage),
      harness.handlers,
      (record, result) => completeGuiAction(record, result, completionEffects(storage, notices)),
    );

    await executor.execute(
      `slash-command:compact:thread-1:${draft.id}`,
      'compactContext',
      commandPayload(draft),
    );

    expect(notices[0]).toBe('/compact 已完成：当前没有需要压缩的消息。');
    expect(notices[0]).not.toContain('没有新增合格历史');
    expect(notices[0]).not.toContain('未新增 Recap 或硬切完成事件');
    expect(notices[0]).not.toContain('已持久提交');
  });

  it.each([
    ['reload', ' '],
    ['reload', '\n'],
    ['compact', ' '],
    ['compact', '\n'],
  ] as const)(
    'starts /%s with a new action id after a terminal failure',
    async (command, suffix) => {
      const storage = new MemoryStorage();
      const draft = commandDraft(`/${command}`);
      saveDraft(storage, 'thread-1', draft);
      const notices: string[] = [];
      const draftsAtSuccess: string[] = [];
      const options: HarnessOptions =
        command === 'reload'
          ? {
              terminalFailure: command,
              onReload: () => draftsAtSuccess.push(loadDraft(storage, 'thread-1').text),
            }
          : {
              terminalFailure: command,
              onCompact: () => draftsAtSuccess.push(loadDraft(storage, 'thread-1').text),
            };
      const harness = createHarness(options);
      const store = new ClientActionStore(storage);
      const executor = new ActionExecutor(store, harness.handlers, (record, result) =>
        completeGuiAction(record, result, completionEffects(storage, notices)),
      );
      const actionKind = command === 'reload' ? 'reloadResources' : 'compactContext';
      const key = `slash-command:${command}:thread-1:${draft.id}`;
      const ids = command === 'reload' ? harness.reloadIds : harness.compactIds;

      await executor.execute(key, actionKind, commandPayload(draft));

      expect(executor.state.failures[0]?.outcome).toBe('terminal');
      expect(store.get(key)).toBeUndefined();
      expect(loadDraft(storage, 'thread-1')).toEqual(draft);
      expect(notices).toEqual([]);

      const edited = { ...draft, text: `${draft.text}${suffix}` };
      saveDraft(storage, 'thread-1', edited);
      await executor.execute(key, actionKind, commandPayload(edited));

      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
      expect(draftsAtSuccess).toEqual([edited.text]);
      expect(notices).toHaveLength(1);
      expect(store.pending()).toEqual([]);
      expect(new ClientActionStore(storage).pending()).toEqual([]);
      expect(loadDraft(storage, 'thread-1').text).toBe('');
      expect(harness.calls).toEqual({ create: 0, send: 0, cancel: 0 });
    },
  );

  it.each([
    ['reload', ' '],
    ['reload', '\n'],
    ['compact', ' '],
    ['compact', '\n'],
  ] as const)('preserves whitespace edits made before /%s completion', async (command, suffix) => {
    const storage = new MemoryStorage();
    const submittedText = `/${command}`;
    const editedText = `${submittedText}${suffix}`;
    const draft = commandDraft(submittedText);
    const edited = { ...draft, text: editedText };
    saveDraft(storage, 'thread-1', draft);
    const notices: string[] = [];
    const options: HarnessOptions =
      command === 'reload'
        ? { onReload: () => saveDraft(storage, 'thread-1', edited) }
        : { onCompact: () => saveDraft(storage, 'thread-1', edited) };
    const harness = createHarness(options);
    const executor = new ActionExecutor(
      new ClientActionStore(storage),
      harness.handlers,
      (record, result) => completeGuiAction(record, result, completionEffects(storage, notices)),
    );
    const actionKind = command === 'reload' ? 'reloadResources' : 'compactContext';

    await executor.execute(
      `slash-command:${command}:thread-1:${draft.id}`,
      actionKind,
      commandPayload(draft),
    );

    const stored = loadDraft(storage, 'thread-1');
    expect(stored).toEqual(edited);
    expect(
      applyDraftCompletion(stored, {
        threadId: 'thread-1',
        draftId: draft.id,
        text: submittedText,
        exactText: true,
      }),
    ).toBeNull();
  });

  it('keeps the existing trim comparison for ordinary message completion', () => {
    const storage = new MemoryStorage();
    const draft = commandDraft('  普通消息\n');
    saveDraft(storage, 'thread-1', draft);
    const completion = { threadId: 'thread-1', draftId: draft.id, text: '普通消息' };

    expect(applyDraftCompletion(draft, completion)?.text).toBe('');
    expect(clearSubmittedDraft(storage, completion)).toBe(true);
    expect(loadDraft(storage, 'thread-1').text).toBe('');
  });

  it.each(['reload', 'compact'] as const)('reports busy rejection for /%s', async (command) => {
    const storage = new MemoryStorage();
    const draft = commandDraft(`/${command}`);
    saveDraft(storage, 'thread-1', draft);
    const notices: string[] = [];
    const harness = createHarness({ reject: command });
    const store = new ClientActionStore(storage);
    const executor = new ActionExecutor(store, harness.handlers, (record, result) =>
      completeGuiAction(record, result, completionEffects(storage, notices)),
    );
    const actionKind = command === 'reload' ? 'reloadResources' : 'compactContext';

    await executor.execute(
      `slash-command:${command}:thread-1:${draft.id}`,
      actionKind,
      commandPayload(draft),
    );

    expect(executor.state.failures[0]?.outcome).toBe('not-executed');
    expect(executor.state.failures[0]?.message).toContain('当前状态不允许该操作');
    expect(executor.state.failures[0]?.message).toContain('active root Run');
    expect(store.pending()).toEqual([]);
    expect(loadDraft(storage, 'thread-1')).toEqual(draft);
    expect(notices).toEqual([]);
    expect(harness.calls).toEqual({ create: 0, send: 0, cancel: 0 });
  });
});
