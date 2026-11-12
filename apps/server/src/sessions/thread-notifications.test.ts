import { expect, it } from 'vitest';
import { seedTestTenant } from '../integration/environment-fixture.js';
import { openDatabase } from '../storage/database.js';
import { SessionStore } from './store.js';

const ownerId = 'owner-1';

function action<T extends Record<string, unknown>>(
  method: string,
  clientActionId: string,
  parameters: T,
) {
  return { ownerId, clientActionId, method, parameters, ...parameters };
}

function fixture() {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  seedTestTenant(database, ownerId);
  const main = store.getOrCreateMainThread(ownerId);
  const task = store.createThread(
    action('CreateThread', 'create-notify-task', { title: '通知话题' }),
  );
  const sent = store.sendMessage(
    action('SendMessage', 'send-notify-task', {
      threadId: task.threadId,
      text: 'work',
      mode: 'follow_up' as const,
    }),
  );
  store.appendModelMessage({
    runId: sent.runId,
    inputId: sent.input.inputId,
    message: { role: 'user', content: 'work' },
  });
  store.appendModelMessage({
    runId: sent.runId,
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'notify-1', name: 'thread_notify', arguments: { message: '通知正文' } }],
    },
  });
  const input = {
    ownerId,
    sourceThreadId: task.threadId,
    sourceAgentId: 'thread',
    sourceRunId: sent.runId,
    sourceToolCallId: 'notify-1',
    content: '通知正文',
  };
  return { database, store, main, task, input };
}

it('deduplicates independent notification records and consumed Context by source tool call', () => {
  const { database, store, main, task, input } = fixture();
  try {
    const accepted = store.acceptThreadNotification(input);
    expect(accepted.notification).toMatchObject({
      sourceThreadId: task.threadId,
      sourceAgentId: 'thread',
      sourceToolCallId: 'notify-1',
      replyThreadId: main.threadId,
      content: '通知正文',
      status: 'queued',
      runId: accepted.runId,
    });
    const eventCount = store.listEvents(task.threadId, 0n).length;
    expect(store.acceptThreadNotification(input)).toEqual(accepted);
    expect(store.listEvents(task.threadId, 0n)).toHaveLength(eventCount);
    expect(() => store.acceptThreadNotification({ ...input, content: '不同正文' })).toThrowError(
      expect.objectContaining({ code: 'action_conflict' }),
    );
    expect(database.prepare('SELECT COUNT(*) AS count FROM thread_notifications').get()).toEqual({
      count: 1,
    });
    if (accepted.runId === null) throw new Error('Expected a main delivery Run.');
    const injected = store.appendThreadNotificationMessage({
      runId: accepted.runId,
      key: input,
      message: { role: 'user', content: accepted.notification.deliveryContent },
    });
    expect(injected).toMatchObject({
      source: 'thread_notification',
      sourceThreadId: task.threadId,
      sourceAgentId: 'thread',
      delegation: {
        sourceThreadId: task.threadId,
        sourceAgentId: 'thread',
        sourceToolCallId: 'notify-1',
      },
    });
    expect(
      store.appendThreadNotificationMessage({
        runId: accepted.runId,
        key: input,
        message: { role: 'user', content: accepted.notification.deliveryContent },
      }).seq,
    ).toBe(injected.seq);
    const rebuilt = new SessionStore(database);
    expect(rebuilt.listUndeliveredThreadNotifications(ownerId)).toEqual([]);
    expect(rebuilt.getThreadNotification(ownerId, input)).toMatchObject({
      status: 'consumed',
      contextMessageSeq: injected.seq,
    });
    expect(
      rebuilt.listThreadSnapshotNotifications(
        ownerId,
        task.threadId,
        {
          afterRowid: 0n,
          maxRowid: 10n,
        },
        10,
      ),
    ).toHaveLength(1);
  } finally {
    database.close();
  }
});

it('enforces the message bound and rejects a main Thread source', () => {
  const { database, store, main, input } = fixture();
  try {
    for (const content of ['', 'x'.repeat(20_001), 'invalid\0content']) {
      expect(() => store.acceptThreadNotification({ ...input, content })).toThrowError(
        expect.objectContaining({ code: 'invalid_argument' }),
      );
    }
    expect(database.prepare('SELECT COUNT(*) AS count FROM thread_notifications').get()).toEqual({
      count: 0,
    });
    const sent = store.sendMessage(
      action('SendMessage', 'send-main-notify', {
        threadId: main.threadId,
        text: 'main work',
        mode: 'follow_up' as const,
      }),
    );
    store.appendModelMessage({
      runId: sent.runId,
      inputId: sent.input.inputId,
      message: { role: 'user', content: 'main work' },
    });
    store.appendModelMessage({
      runId: sent.runId,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'main-notify', name: 'thread_notify', arguments: { message: 'x' } }],
      },
    });
    expect(() =>
      store.acceptThreadNotification({
        ...input,
        sourceThreadId: main.threadId,
        sourceRunId: sent.runId,
        sourceToolCallId: 'main-notify',
        content: 'x',
      }),
    ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
    expect(database.prepare('SELECT COUNT(*) AS count FROM thread_notifications').get()).toEqual({
      count: 0,
    });
  } finally {
    database.close();
  }
});
