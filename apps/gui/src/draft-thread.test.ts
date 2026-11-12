import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import {
  type CreateThreadRequest,
  type CreateThreadResponse,
  CreateThreadResponseSchema,
  create,
  InputMode,
  MessageService,
  ThreadSchema,
  ThreadService,
  ThreadType,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { completeGuiAction } from './action-completion.js';
import { ActionExecutor } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import { ClientActionStore, type StorageLike } from './actions.js';
import { createKairosClients } from './client.js';
import { clearSubmittedDraft } from './draft-test-support.js';
import { loadDraft, localTaskDraftId, newDraft, saveDraft } from './drafts.js';
import { ThreadDirectory } from './workbench.js';

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

const task = create(ThreadSchema, {
  threadId: 'task-1',
  title: '新任务 Thread',
  seq: 2n,
  threadType: ThreadType.TASK,
});

function createdResponse(request: CreateThreadRequest): CreateThreadResponse {
  return create(CreateThreadResponseSchema, {
    clientActionId: request.clientActionId,
    thread: task,
    inputId: 'input-1',
    runId: 'run-1',
  });
}

function completionEffects(storage: MemoryStorage, state: { selectedThreadId: string | null }) {
  return {
    upsertThread: () => {},
    selectThread: (threadId: string) => {
      state.selectedThreadId = threadId;
    },
    completeDraft: (completion: { threadId: string; draftId: string; text: string }) => {
      clearSubmittedDraft(storage, completion);
    },
    closeForm: () => {},
    showNotice: () => {},
  };
}

describe('local task Thread drafts', () => {
  it('opens and abandons a local draft without CreateThread or an empty listed record', async () => {
    const directory = new ThreadDirectory({
      mainThreadId: 'main-1',
    });

    directory.openDraft();
    expect(directory.state.page).toBe('draft');
    expect(directory.state.selectedThreadId).toBeNull();
    expect(directory.state.threads).toEqual([]);

    directory.openDirectory();
    expect(directory.state.page).toBe('directory');
    expect(directory.state.threads).toEqual([]);
    directory.openDraft();
    directory.openDirectory();
  });

  it('atomically creates the first input and retries an unknown result with the original id', async () => {
    const storage = new MemoryStorage();
    const draft = { ...newDraft(), text: '首条输入' };
    saveDraft(storage, localTaskDraftId, draft);
    const state = { selectedThreadId: null };
    const requests: CreateThreadRequest[] = [];
    const accepted = new Map<string, CreateThreadResponse>();
    let sendCalls = 0;
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        createThread(request) {
          requests.push(request);
          const existing = accepted.get(request.clientActionId);
          if (existing) return existing;
          const response = createdResponse(request);
          accepted.set(request.clientActionId, response);
          throw new ConnectError('response lost', Code.Unavailable);
        },
      });
      router.service(MessageService, {
        sendMessage(request) {
          sendCalls += 1;
          return {
            clientActionId: request.clientActionId,
            inputId: 'unexpected',
            threadId: request.threadId,
          };
        },
      });
    });
    const executor = new ActionExecutor(
      new ClientActionStore(storage),
      createActionHandlers(createKairosClients({ transport })),
      (record, result) => completeGuiAction(record, result, completionEffects(storage, state)),
    );
    const key = `create-thread:${draft.id}`;
    const payload = {
      title: '新任务 Thread',
      autoSummarizeTitle: true,
      initialText: draft.text,
      initialMode: InputMode.FOLLOW_UP,
      draftId: draft.id,
    };

    await executor.execute(key, 'createThread', payload);
    expect(state.selectedThreadId).toBeNull();
    expect(loadDraft(storage, localTaskDraftId)).toEqual(draft);
    expect(executor.state.failures[0]?.outcome).toBe('unknown');

    await executor.retry(key);
    expect(state.selectedThreadId).toBe(task.threadId);
    expect(loadDraft(storage, localTaskDraftId).id).not.toBe(draft.id);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.clientActionId).toBe(requests[0]?.clientActionId);
    expect(requests[0]).toMatchObject({
      autoSummarizeTitle: true,
      initialText: '首条输入',
      initialMode: InputMode.FOLLOW_UP,
    });
    expect(sendCalls).toBe(0);
    expect(accepted).toHaveLength(1);

    await executor.retry(key);
    expect(requests).toHaveLength(2);
  });

  it('deduplicates duplicate first-send submissions while the atomic request is pending', async () => {
    const storage = new MemoryStorage();
    const draft = { ...newDraft(), text: '首条输入' };
    saveDraft(storage, localTaskDraftId, draft);
    const state = { selectedThreadId: null };
    const requests: CreateThreadRequest[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = createRouterTransport((router) => {
      router.service(ThreadService, {
        async createThread(request) {
          requests.push(request);
          await gate;
          return createdResponse(request);
        },
      });
    });
    const executor = new ActionExecutor(
      new ClientActionStore(storage),
      createActionHandlers(createKairosClients({ transport })),
      (record, result) => completeGuiAction(record, result, completionEffects(storage, state)),
    );
    const key = `create-thread:${draft.id}`;
    const payload = {
      title: '新任务 Thread',
      initialText: draft.text,
      initialMode: InputMode.STEER,
      draftId: draft.id,
    };

    const first = executor.execute(key, 'createThread', payload);
    const duplicate = executor.execute(key, 'createThread', payload);
    release?.();
    await Promise.all([first, duplicate]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.initialMode).toBe(InputMode.STEER);
    expect(state.selectedThreadId).toBe(task.threadId);
  });
});
