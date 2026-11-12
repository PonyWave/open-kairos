import { clearSubmittedDraft } from './draft-test-support.js';
/// <reference lib="dom" />

import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import {
  CancelRunResponseSchema,
  ContinueRunResponseSchema,
  CreateThreadResponseSchema,
  EditInputResponseSchema,
  InputMode,
  MessageService,
  RemoveInputResponseSchema,
  RenameThreadResponseSchema,
  ReorderInputsResponseSchema,
  RerunResponseSchema,
  ReviseMessageResponseSchema,
  RunStatus,
  SendMessageResponseSchema,
  type Thread,
  ThreadService,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { type ActionCompletionEffects, completeGuiAction } from './action-completion.js';
import { ActionExecutor } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import {
  type ActionKind,
  type ClientActionRecord,
  ClientActionStore,
  type StorageLike,
} from './actions.js';
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

interface CompletionState {
  threads: Thread[];
  selectedThreadId: string | null;
  closedForms: string[];
  notices: string[];
}

function createEffects(state: CompletionState, storage: StorageLike): ActionCompletionEffects {
  return {
    upsertThread: (thread) => {
      const index = state.threads.findIndex((item) => item.threadId === thread.threadId);
      if (index < 0) state.threads.push(thread);
      else state.threads[index] = thread;
    },
    selectThread: (threadId) => {
      state.selectedThreadId = threadId;
    },
    completeDraft: (completion) => {
      clearSubmittedDraft(storage, completion);
    },
    closeForm: (key) => {
      state.closedForms.push(key);
    },
    showNotice: (message) => {
      state.notices.push(message);
    },
  };
}

function emptyState(): CompletionState {
  return { threads: [], selectedThreadId: null, closedForms: [], notices: [] };
}

function createLossyHarness() {
  const ids: Record<string, string[]> = { createThread: [], sendMessage: [] };
  const created = new Map<string, { clientActionId: string; thread: Thread }>();
  const sent = new Map<string, { clientActionId: string; inputId: string; threadId: string }>();
  const transport = createRouterTransport((router) => {
    router.service(ThreadService, {
      createThread(request) {
        ids.createThread?.push(request.clientActionId);
        const existing = created.get(request.clientActionId);
        if (existing) return existing;
        const response = {
          clientActionId: request.clientActionId,
          thread: {
            $typeName: 'kairos.gui.v1.Thread' as const,
            threadId: 'thread-1',
            title: request.title,
            seq: 1n,
          },
        };
        created.set(request.clientActionId, response);
        throw new ConnectError('response lost', Code.Unavailable);
      },
    });
    router.service(MessageService, {
      sendMessage(request) {
        ids.sendMessage?.push(request.clientActionId);
        const existing = sent.get(request.clientActionId);
        if (existing) return existing;
        const response = {
          clientActionId: request.clientActionId,
          inputId: 'input-1',
          threadId: request.threadId,
        };
        sent.set(request.clientActionId, response);
        throw new ConnectError('response lost', Code.Unavailable);
      },
    });
  });
  return { handlers: createActionHandlers(createKairosClients({ transport })), ids };
}

describe('unified completion after warning retry', () => {
  it('adds and selects the created thread before acknowledging retry', async () => {
    const storage = new MemoryStorage();
    const state = emptyState();
    const harness = createLossyHarness();
    const executor = new ActionExecutor(
      new ClientActionStore(storage),
      harness.handlers,
      (record, result) => completeGuiAction(record, result, createEffects(state, storage)),
    );
    await executor.execute('create-thread', 'createThread', { title: '新会话' });
    expect(state.threads).toHaveLength(0);
    await executor.retry('create-thread');
    expect(state.threads.map((thread) => thread.threadId)).toEqual(['thread-1']);
    expect(state.selectedThreadId).toBe('thread-1');
    expect(harness.ids.createThread).toHaveLength(2);
    expect(harness.ids.createThread?.[0]).toBe(harness.ids.createThread?.[1]);
    await executor.retry('create-thread');
    expect(harness.ids.createThread).toHaveLength(2);
  });

  it('clears only the submitted draft and prevents an immediate duplicate send', async () => {
    const storage = new MemoryStorage();
    const state = emptyState();
    const harness = createLossyHarness();
    const executor = new ActionExecutor(
      new ClientActionStore(storage),
      harness.handlers,
      (record, result) => completeGuiAction(record, result, createEffects(state, storage)),
    );
    const draft = { ...newDraft(), text: '待发送输入' };
    saveDraft(storage, 'thread-1', draft);
    const key = `send-message:thread-1:${draft.id}`;
    const payload = {
      threadId: 'thread-1',
      draftId: draft.id,
      text: draft.text,
      mode: InputMode.STEER,
    };
    await executor.execute(key, 'sendMessage', payload);
    expect(loadDraft(storage, 'thread-1')).toEqual(draft);
    await executor.retry(key);
    const cleared = loadDraft(storage, 'thread-1');
    expect(cleared.text).toBe('');
    expect(cleared.id).not.toBe(draft.id);
    if (cleared.text.trim()) await executor.execute(key, 'sendMessage', payload);
    expect(harness.ids.sendMessage).toHaveLength(2);
    expect(harness.ids.sendMessage?.[0]).toBe(harness.ids.sendMessage?.[1]);
  });
});

describe('all remaining completion kinds', () => {
  it('updates threads, closes forms, and publishes operation-specific confirmations', () => {
    const state = emptyState();
    const effects = createEffects(state, new MemoryStorage());
    const thread = {
      $typeName: 'kairos.gui.v1.Thread' as const,
      threadId: 'thread-1',
      title: '已重命名',
      seq: 1n,
    };
    completeGuiAction(
      action('renameThread', 'rename-thread:thread-1', { title: '已重命名' }),
      {
        $typeName: 'kairos.gui.v1.RenameThreadResponse',
        clientActionId: 'id-rename-thread:thread-1',
        thread,
      },
      effects,
    );
    completeGuiAction(
      action('reviseMessage', 'revise-message:message-1', { messageId: 'message-1' }),
      {
        $typeName: 'kairos.gui.v1.ReviseMessageResponse',
        clientActionId: 'id-revise-message:message-1',
        messageId: 'message-1',
        revisionId: 'revision-1',
      },
      effects,
    );
    completeGuiAction(
      action('editInput', 'edit-input:input-1', { inputId: 'input-1' }),
      {
        $typeName: 'kairos.gui.v1.EditInputResponse',
        clientActionId: 'id-edit-input:input-1',
        inputId: 'input-1',
        version: 2n,
      },
      effects,
    );
    completeGuiAction(
      action('removeInput', 'remove-input:input-1', { inputId: 'input-1' }),
      {
        $typeName: 'kairos.gui.v1.RemoveInputResponse',
        clientActionId: 'id-remove-input:input-1',
        inputId: 'input-1',
        queueVersion: 2n,
      },
      effects,
    );
    completeGuiAction(
      action('reorderInputs', 'reorder-inputs:thread-1', {}),
      {
        $typeName: 'kairos.gui.v1.ReorderInputsResponse',
        clientActionId: 'id-reorder-inputs:thread-1',
        inputs: [],
        queueVersion: 2n,
      },
      effects,
    );
    completeGuiAction(
      action('cancelRun', 'cancel-run:run-1', { runId: 'run-1' }),
      {
        $typeName: 'kairos.gui.v1.CancelRunResponse',
        clientActionId: 'id-cancel-run:run-1',
        runId: 'run-1',
        status: RunStatus.CANCEL_REQUESTED,
      },
      effects,
    );
    completeGuiAction(
      action('continueRun', 'continue-run:run-1', { runId: 'run-1' }),
      {
        $typeName: 'kairos.gui.v1.ContinueRunResponse',
        clientActionId: 'id-continue-run:run-1',
        runId: 'run-1',
        status: RunStatus.QUEUED,
      },
      effects,
    );
    completeGuiAction(
      action('rerun', 'rerun:message-1', {}),
      {
        $typeName: 'kairos.gui.v1.RerunResponse',
        clientActionId: 'id-rerun:message-1',
        runId: 'run-2',
        status: RunStatus.QUEUED,
      },
      effects,
    );

    expect(state.threads[0]?.title).toBe('已重命名');
    expect(state.closedForms).toEqual(['revise-message:message-1', 'edit-input:input-1']);
    expect(state.notices).toHaveLength(0);
    expect(state.notices.join(' ')).not.toContain('Run 事件');
  });
});

describe('reloadResources runtime completion', () => {
  const fingerprint = '0123456789abcdef'.repeat(4);

  function completeReload(
    changed: boolean,
    runtime: { runtimeFingerprint?: string; runtimeChanged?: boolean },
  ): string {
    const storage = new MemoryStorage();
    const state = emptyState();
    const draft = { ...newDraft(), text: '/reload' };
    saveDraft(storage, 'thread-1', draft);
    completeGuiAction(
      action('reloadResources', `slash-command:reload:thread-1:${draft.id}`, {
        threadId: 'thread-1',
        draftId: draft.id,
        text: draft.text,
      }),
      {
        $typeName: 'kairos.gui.v1.ReloadResourcesResponse',
        snapshotId: 'snapshot-v2',
        changed,
        resources: ['AGENTS.md'],
        added: changed ? ['AGENTS.md'] : [],
        updated: [],
        removed: [],
        ...runtime,
      },
      createEffects(state, storage),
    );
    return state.notices[0] ?? '';
  }

  it('acknowledges reload without exposing runtime diagnostics', () => {
    const notice = completeReload(false, { runtimeFingerprint: fingerprint, runtimeChanged: true });

    expect(notice).toBe('/reload 已完成：已加载当前提示词与 Skill。');
    expect(notice).not.toContain('运行规格');
    expect(notice).not.toContain(fingerprint);
    expect(notice).not.toContain('新 Run');
  });

  it('acknowledges changed resources with a concise completion', () => {
    const notice = completeReload(true, {
      runtimeFingerprint: fingerprint,
      runtimeChanged: false,
    });

    expect(notice).toBe('/reload 已完成：提示词与 Skill 已更新。');
    expect(notice).not.toContain('运行规格');
  });

  it.each([
    ['both optional fields are absent', {}],
    ['the completed baseline is absent', { runtimeFingerprint: fingerprint }],
    ['the fingerprint is absent and runtime_changed is false', { runtimeChanged: false }],
  ])('accepts absent historical baseline without adding diagnostics when %s', (_label, runtime) => {
    const notice = completeReload(false, runtime);

    expect(notice).not.toContain('历史基线');
    expect(notice).not.toContain('与上次完成请求相同');
    expect(notice).not.toContain('与上次完成请求不同');
    if (!('runtimeFingerprint' in runtime)) {
      expect(notice).not.toContain('指纹');
    }
  });
});

describe('action response schemas', () => {
  it('checks current completion response shapes against generated contracts', () => {
    const cases = [
      [CreateThreadResponseSchema, ['clientActionId', 'thread']],
      [RenameThreadResponseSchema, ['clientActionId', 'thread']],
      [SendMessageResponseSchema, ['clientActionId', 'inputId', 'threadId']],
      [ReviseMessageResponseSchema, ['clientActionId', 'messageId', 'revisionId']],
      [EditInputResponseSchema, ['clientActionId', 'inputId', 'version']],
      [RemoveInputResponseSchema, ['clientActionId', 'inputId', 'queueVersion']],
      [ReorderInputsResponseSchema, ['clientActionId', 'inputs', 'queueVersion']],
      [CancelRunResponseSchema, ['clientActionId', 'runId', 'status']],
      [ContinueRunResponseSchema, ['clientActionId', 'runId', 'status']],
      [RerunResponseSchema, ['clientActionId', 'runId', 'status']],
    ] as const;
    for (const [schema, fields] of cases) {
      expect(schema.fields.map((field) => field.localName)).toEqual(
        expect.arrayContaining([...fields]),
      );
    }
  });
});

function action(kind: ActionKind, key: string, payload: unknown): ClientActionRecord {
  return { id: `id-${key}`, key, kind, fingerprint: key, payload };
}
