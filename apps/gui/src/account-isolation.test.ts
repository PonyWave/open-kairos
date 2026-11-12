/// <reference lib="dom" />

import { createRouterTransport } from '@connectrpc/connect';
import { InputMode, MessageService, type SendMessageRequest } from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { accountScopeKey, scopedStorage } from './account-storage.js';
import { ActionExecutor } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import { ClientActionStore, type StorageLike } from './actions.js';
import { createKairosClients } from './client.js';
import { clearDraft, loadDraft, saveDraft } from './drafts.js';
import { ThreadDirectory } from './workbench.js';

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

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

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, release: () => resolve?.() };
}

describe('account-scoped local state', () => {
  it('isolates drafts, selected Threads and pending actions by user and tenant', () => {
    const storage = new MemoryStorage();
    const scopeA = accountScopeKey({ userId: 'user-a', tenantId: 'tenant-a' });
    const scopeB = accountScopeKey({ userId: 'user-b', tenantId: 'tenant-b' });
    const storageA = scopedStorage(storage, scopeA);
    const storageB = scopedStorage(storage, scopeB);
    saveDraft(storageA, 'shared-thread-id', { id: 'draft-a', text: '账号 A 草稿' });
    saveDraft(storageB, 'shared-thread-id', { id: 'draft-b', text: '账号 B 草稿' });
    const pendingA = new ClientActionStore(storageA);
    const pendingB = new ClientActionStore(storageB);
    pendingA.begin('send:draft-a', 'sendMessage', {
      threadId: 'shared-thread-id',
      text: '账号 A 待提交消息',
      mode: InputMode.FOLLOW_UP,
    });

    expect(loadDraft(storageA, 'shared-thread-id').text).toBe('账号 A 草稿');
    expect(loadDraft(storageB, 'shared-thread-id').text).toBe('账号 B 草稿');
    expect(pendingA.pending()).toHaveLength(1);
    expect(pendingB.pending()).toHaveLength(0);
    expect(
      [...storage.values.keys()].every((key) => key.includes(scopeA) || key.includes(scopeB)),
    ).toBe(true);
    expect([...storage.values.values()].join('')).not.toContain('945945');

    const directoryA = new ThreadDirectory({ mainThreadId: 'main-a' });
    const directoryB = new ThreadDirectory({ mainThreadId: 'main-b' });
    directoryA.openThread('task-a');
    directoryB.openThread('task-b');
    directoryA.showMain();
    expect(directoryA.state.selectedThreadId).toBe('main-a');
    expect(directoryB.state.selectedThreadId).toBe('task-b');

    clearDraft(storageA, 'shared-thread-id');
    expect(loadDraft(storageB, 'shared-thread-id').text).toBe('账号 B 草稿');
  });

  it('keeps one ActionExecutor while preventing late writes and automatic retries across accounts', async () => {
    const firstResponse = deferred();
    const requests: SendMessageRequest[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    let holdFirstAccount = true;
    const transport = createRouterTransport((router) => {
      router.service(MessageService, {
        async sendMessage(request, context) {
          requests.push(request);
          signals.push(context.signal);
          if (request.threadId === 'thread-a' && holdFirstAccount) await firstResponse.promise;
          return {
            clientActionId: request.clientActionId,
            inputId: `input-${requests.length}`,
            threadId: request.threadId,
          };
        },
      });
    });
    const handlers = createActionHandlers(createKairosClients({ transport }));
    const storage = new MemoryStorage();
    const storageA = scopedStorage(storage, 'account-a');
    const storageB = scopedStorage(storage, 'account-b');
    const storeA = new ClientActionStore(storageA);
    const storeB = new ClientActionStore(storageB);
    const completed: string[] = [];
    const executor = new ActionExecutor(storeA, handlers, (record) => {
      const payload = record.payload as { threadId: string };
      completed.push(payload.threadId);
    });
    const payloadA = {
      threadId: 'thread-a',
      text: '账号 A 消息',
      mode: InputMode.FOLLOW_UP,
    };

    const lateA = executor.execute('send:draft-a', 'sendMessage', payloadA);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
    executor.activate(storeB);
    expect(signals[0]?.aborted).toBe(true);
    expect(executor.state.busy).toBe(false);
    expect(storeA.pending()).toHaveLength(1);

    await executor.execute('send:draft-b', 'sendMessage', {
      threadId: 'thread-b',
      text: '账号 B 消息',
      mode: InputMode.FOLLOW_UP,
    });
    holdFirstAccount = false;
    firstResponse.release();
    await lateA;
    expect(completed).toEqual(['thread-b']);
    expect(storeA.pending()).toHaveLength(1);
    expect(storeB.pending()).toHaveLength(0);
    expect(requests).toHaveLength(2);

    executor.activate(storeA);
    expect(executor.state.failures).toHaveLength(1);
    expect(executor.state.failures[0]?.restored).toBe(true);
    expect(requests).toHaveLength(2);
    await executor.retry('send:draft-a');
    expect(requests).toHaveLength(3);
    expect(requests[2]?.clientActionId).toBe(requests[0]?.clientActionId);
    expect(requests[2]?.text).toBe('账号 A 消息');
    expect(completed).toEqual(['thread-b', 'thread-a']);
    expect(storeA.pending()).toHaveLength(0);
  });
});
