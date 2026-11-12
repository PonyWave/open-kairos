import { expect, it, vi } from 'vitest';
import { seedTestTenant } from '../integration/environment-fixture.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { createThreadNotificationTool } from './notification.js';

const ownerId = 'notification-tools-owner';

function fixture() {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  seedTestTenant(database, ownerId);
  store.getOrCreateMainThread(ownerId);
  const accepted = store.acceptAutomationInput({
    ownerId,
    clientActionId: 'create-hidden-notification-source',
    method: 'AutomationAccept',
    parameters: {},
    targetKind: 'new_automation_only' as const,
    title: '隐藏通知来源',
    prompt: 'hidden notification work',
    automation: {
      scheduleId: 'schedule-hidden-notification',
      fireId: 'fire-hidden-notification',
      trigger: 'run_now' as const,
      scheduledAt: '2026-11-09T00:00:00.000Z',
    },
  });
  return { database, store, accepted };
}

it('rejects direct thread_notify execution for an automation_only root without creating records', async () => {
  const { database, store, accepted } = fixture();
  try {
    const source = store.getRunById(accepted.runId);
    const scheduleThreadNotification = vi.fn();
    const tool = createThreadNotificationTool({ store, source, scheduleThreadNotification });
    await expect(
      tool.execute(await tool.validate({ message: 'hidden notice' }), {
        call: {
          id: 'hidden-notify',
          name: 'thread_notify',
          arguments: { message: 'hidden notice' },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    expect(scheduleThreadNotification).not.toHaveBeenCalled();
    expect(database.prepare('SELECT COUNT(*) AS count FROM thread_notifications').get()).toEqual({
      count: 0,
    });
  } finally {
    database.close();
  }
});

it('rejects direct Store acceptance for an automation_only root without creating records', () => {
  const { database, store, accepted } = fixture();
  try {
    store.appendModelMessage({
      runId: accepted.runId,
      inputId: accepted.input.inputId,
      message: { role: 'user', content: accepted.input.text },
    });
    store.appendModelMessage({
      runId: accepted.runId,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'hidden-notify', name: 'thread_notify', arguments: { message: 'hidden notice' } },
        ],
      },
    });
    expect(() =>
      store.acceptThreadNotification({
        ownerId,
        sourceThreadId: accepted.thread.threadId,
        sourceAgentId: 'thread',
        sourceRunId: accepted.runId,
        sourceToolCallId: 'hidden-notify',
        content: 'hidden notice',
      }),
    ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
    expect(database.prepare('SELECT COUNT(*) AS count FROM thread_notifications').get()).toEqual({
      count: 0,
    });
  } finally {
    database.close();
  }
});
