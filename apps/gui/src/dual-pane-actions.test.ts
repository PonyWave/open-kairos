import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import { InputMode, MessageService } from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { ActionExecutor } from './action-executor.js';
import { createActionHandlers } from './action-handlers.js';
import { ClientActionStore, type StorageLike } from './actions.js';
import { createKairosClients } from './client.js';

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

describe('shared dual-pane action executor', () => {
  it('keeps pane action ids independent and retries an unknown result with the original id', async () => {
    const requests: { threadId: string; clientActionId: string }[] = [];
    const transport = createRouterTransport((router) => {
      router.service(MessageService, {
        sendMessage(request) {
          requests.push({ threadId: request.threadId, clientActionId: request.clientActionId });
          const response = {
            clientActionId: request.clientActionId,
            inputId: `input-${requests.length}`,
            threadId: request.threadId,
          };
          if (
            request.threadId === 'main-1' &&
            requests.filter((item) => item.threadId === 'main-1').length === 1
          ) {
            throw new ConnectError('response lost', Code.Unavailable);
          }
          return response;
        },
      });
    });
    const executor = new ActionExecutor(
      new ClientActionStore(new MemoryStorage()),
      createActionHandlers(createKairosClients({ transport })),
    );
    const payload = (threadId: string, draftId: string) => ({
      threadId,
      draftId,
      text: `发送给 ${threadId}`,
      mode: InputMode.FOLLOW_UP,
    });

    await executor.execute(
      'send-message:main-1:draft-main',
      'sendMessage',
      payload('main-1', 'draft-main'),
    );
    await executor.execute(
      'send-message:task-1:draft-topic',
      'sendMessage',
      payload('task-1', 'draft-topic'),
    );
    expect(executor.state.failures[0]?.outcome).toBe('unknown');
    await executor.retry('send-message:main-1:draft-main');

    expect(requests).toHaveLength(3);
    expect(requests[0]?.clientActionId).toBe(requests[2]?.clientActionId);
    expect(requests[0]?.clientActionId).not.toBe(requests[1]?.clientActionId);
    expect(requests.map((request) => request.threadId)).toEqual(['main-1', 'task-1', 'main-1']);
    expect(executor.state.failures).toHaveLength(0);
  });
});
