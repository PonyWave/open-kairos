import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GetThreadResponse,
  MessageRole,
  MessageSource,
  RunStatus,
  ThreadNotificationStatus,
} from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import {
  ControlledProvider,
  closeFixture,
  type Fixture,
  response,
  sendMessage,
  startFixture,
  waitRequest,
  waitRun,
} from './delegation-fixture.js';

interface NotificationRow {
  source_thread_id: string;
  source_agent_id: string;
  source_tool_call_id: string;
  owner_id: string;
  source_run_id: string;
  reply_thread_id: string;
  content: string;
  delivery_content: string;
  context_message_seq: number | null;
  run_id: string | null;
  status: string;
}

function notification(fixture: Fixture, sourceThreadId: string, callId: string) {
  return fixture.database
    .prepare(
      'SELECT * FROM thread_notifications WHERE source_thread_id = ? AND source_tool_call_id = ?',
    )
    .get(sourceThreadId, callId) as NotificationRow | undefined;
}

async function waitNotification(
  fixture: Fixture,
  sourceThreadId: string,
  callId: string,
  status: string,
) {
  await vi.waitFor(
    () => {
      expect(notification(fixture, sourceThreadId, callId)?.status).toBe(status);
    },
    { timeout: 10_000 },
  );
}

async function context(fixture: Fixture, threadId: string) {
  return (
    await fixture.clients.context.readContext({
      threadId,
      agentId: 'thread',
      afterSeq: 0n,
      limit: 500,
    })
  ).messages;
}

function toolResult(messages: Awaited<ReturnType<typeof context>>, callId: string) {
  const result = messages.find(
    (message) => message.role === MessageRole.TOOL && message.toolCallId === callId,
  );
  if (!result) throw new Error(`Missing tool result ${callId}.`);
  return result;
}

function mainNotification(snapshot: GetThreadResponse, callId: string) {
  return snapshot.snapshot?.messages.find(
    (message) =>
      message.source === MessageSource.THREAD_NOTIFICATION &&
      message.delegation?.sourceToolCallId === callId,
  );
}

async function createTask(fixture: Fixture, actionId: string, title: string) {
  const thread = (await fixture.clients.thread.createThread({ clientActionId: actionId, title }))
    .thread;
  if (!thread) throw new Error('Task creation returned no Thread.');
  return thread;
}

it('registers thread_notify only on task roots and persists idle delivery with both GUI projections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-thread-notify-idle-'));
  const provider = new ControlledProvider();
  const fixture = await startFixture(directory, { provider });
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const task = await createTask(fixture, 'create-idle-notify-task', '空闲通知话题');
    provider.respond('user:check main tools', response('main tools checked'));
    const mainRun = await sendMessage(fixture, mainId, 'check main tools', 'send-main-tool-check');
    await waitRun(fixture, mainId, mainRun.runId, RunStatus.COMPLETED);
    const mainRequest = provider.requests.find(
      (request) => request.key === 'user:check main tools',
    )?.request;
    expect(mainRequest?.tools.map((tool) => tool.name)).not.toContain('thread_notify');

    provider.respond(
      'user:idle notification',
      response('', [
        {
          id: 'notify-idle',
          name: 'thread_notify',
          arguments: { message: '请主对话关注 **已经完成** 的检查。' },
        },
      ]),
    );
    provider.respond('tool:notify-idle', response('task finished'));
    provider.respond('notification:notify-idle', response('main received the notification'));
    const taskRun = await sendMessage(
      fixture,
      task.threadId,
      'idle notification',
      'send-idle-notify',
    );
    await waitNotification(fixture, task.threadId, 'notify-idle', 'consumed');
    await waitRun(fixture, task.threadId, taskRun.runId, RunStatus.COMPLETED);
    const delivered = notification(fixture, task.threadId, 'notify-idle');
    if (!delivered?.run_id) throw new Error('The idle notification has no delivery Run.');
    await waitRun(fixture, mainId, delivered.run_id, RunStatus.COMPLETED);

    const taskRequest = provider.requests.find(
      (request) => request.key === 'user:idle notification',
    )?.request;
    expect(taskRequest?.tools.map((tool) => tool.name)).toContain('thread_notify');
    expect(taskRequest?.tools.map((tool) => tool.name)).not.toContain('thread_call');
    expect(toolResult(await context(fixture, task.threadId), 'notify-idle').content).toContain(
      '"status":"accepted"',
    );
    expect(toolResult(await context(fixture, task.threadId), 'notify-idle').content).toContain(
      '"automatic_delivery":true',
    );
    expect(delivered).toMatchObject({
      source_thread_id: task.threadId,
      source_agent_id: 'thread',
      source_tool_call_id: 'notify-idle',
      source_run_id: taskRun.runId,
      reply_thread_id: mainId,
      content: '请主对话关注 **已经完成** 的检查。',
      status: 'consumed',
      context_message_seq: expect.any(Number),
    });
    expect(JSON.parse(delivered.delivery_content)).toMatchObject({
      kind: 'thread_notification',
      source_thread_id: task.threadId,
      source_agent_id: 'thread',
      tool_call_id: 'notify-idle',
      thread_id: task.threadId,
      message: '请主对话关注 **已经完成** 的检查。',
    });
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM interactions WHERE source_tool_call_id = 'notify-idle'",
        )
        .get(),
    ).toEqual({ count: 0 });

    const mainSnapshot = await fixture.clients.thread.getThread({ threadId: mainId });
    const projected = mainNotification(mainSnapshot, 'notify-idle');
    expect(projected).toMatchObject({
      threadId: mainId,
      agentId: 'thread',
      role: MessageRole.USER,
      source: MessageSource.THREAD_NOTIFICATION,
      sourceThreadId: task.threadId,
      sourceAgentId: 'thread',
      delegation: {
        sourceThreadId: task.threadId,
        sourceAgentId: 'thread',
        sourceToolCallId: 'notify-idle',
      },
    });
    expect(projected?.content).toBe(delivered.delivery_content);
    expect(
      mainSnapshot.snapshot?.inputs.filter(
        (input) => input.source === MessageSource.THREAD_NOTIFICATION,
      ),
    ).toEqual([]);
    const taskSnapshot = await fixture.clients.thread.getThread({ threadId: task.threadId });
    expect(taskSnapshot.snapshot?.notifications).toHaveLength(1);
    expect(taskSnapshot.snapshot?.notifications[0]).toMatchObject({
      content: '请主对话关注 **已经完成** 的检查。',
      status: ThreadNotificationStatus.CONSUMED,
      replyThreadId: mainId,
      sourceRunId: taskRun.runId,
      runId: delivered.run_id,
      contextMessageSeq: BigInt(delivered.context_message_seq ?? 0),
    });

    const statuses: ThreadNotificationStatus[] = [];
    for await (const watched of fixture.clients.events.watchThread({
      threadId: task.threadId,
      afterSeq: 0n,
    })) {
      if (watched.payload.case !== 'event') continue;
      const payload = watched.payload.value.payload;
      if (payload.case !== 'threadNotificationChanged') continue;
      const status = payload.value.notification?.status;
      if (status !== undefined) statuses.push(status);
      if (status === ThreadNotificationStatus.CONSUMED) break;
    }
    expect(statuses).toEqual([
      ThreadNotificationStatus.PENDING,
      ThreadNotificationStatus.QUEUED,
      ThreadNotificationStatus.CONSUMED,
    ]);

    provider.respond(
      'user:check subagent tools',
      response('', [
        {
          id: 'child-permission',
          name: 'subagent',
          arguments: { task: 'child notify attempt', mode: 'foreground' },
        },
      ]),
    );
    provider.respond(
      'user:child notify attempt',
      response('', [
        { id: 'child-notify', name: 'thread_notify', arguments: { message: 'must not send' } },
      ]),
    );
    provider.respond('tool:child-notify', response('child finished'));
    provider.respond('tool:child-permission', response('subagent check finished'));
    const permissionRun = await sendMessage(
      fixture,
      mainId,
      'check subagent tools',
      'send-subagent-tool-check',
    );
    await waitRun(fixture, mainId, permissionRun.runId, RunStatus.COMPLETED);
    const childRequest = provider.requests.find(
      (request) => request.key === 'user:child notify attempt',
    )?.request;
    expect(childRequest?.tools.map((tool) => tool.name)).not.toContain('thread_notify');
    const child = fixture.database
      .prepare('SELECT agent_id FROM runs WHERE parent_run_id = ?')
      .get(permissionRun.runId) as { agent_id: string } | undefined;
    if (!child) throw new Error('The permission-check Subagent Run is missing.');
    const childContext = await fixture.clients.context.readContext({
      threadId: mainId,
      agentId: child.agent_id,
      afterSeq: 0n,
      limit: 100,
    });
    expect(toolResult(childContext.messages, 'child-notify')).toMatchObject({
      toolStatus: 2,
      toolError: { code: 'unknown_tool' },
    });
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM thread_notifications WHERE source_tool_call_id = 'child-notify'",
        )
        .get(),
    ).toEqual({ count: 0 });
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);

it('queues a busy notification before ordinary follow-up and lets the main Agent reply to its source task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-thread-notify-busy-'));
  const provider = new ControlledProvider();
  const fixture = await startFixture(directory, { provider });
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const task = await createTask(fixture, 'create-busy-notify-task', '忙时通知话题');
    provider.register('user:main is busy', response('busy main response'));
    provider.respond(
      'user:task sends busy notification',
      response('', [
        {
          id: 'notify-busy',
          name: 'thread_notify',
          arguments: { message: '主对话需要在下一步知道这个消息。' },
        },
      ]),
    );
    provider.respond('tool:notify-busy', response('task notification accepted'));
    const busy = await sendMessage(fixture, mainId, 'main is busy', 'send-main-busy');
    await waitRequest(provider, 'user:main is busy');
    const taskRun = await sendMessage(
      fixture,
      task.threadId,
      'task sends busy notification',
      'send-busy-notify-task',
    );
    await waitNotification(fixture, task.threadId, 'notify-busy', 'queued');
    await waitRun(fixture, task.threadId, taskRun.runId, RunStatus.COMPLETED);
    expect(notification(fixture, task.threadId, 'notify-busy')?.run_id).toBe(busy.runId);
    expect(provider.requests.some((request) => request.key === 'notification:notify-busy')).toBe(
      false,
    );
    expect(
      provider.requests
        .find((request) => request.key === 'user:main is busy')
        ?.request.messages.at(-1)?.content,
    ).toBe('main is busy');

    provider.respond(
      'notification:notify-busy',
      response('', [
        {
          id: 'reply-to-notify-task',
          name: 'thread_call',
          arguments: { thread_id: task.threadId, prompt: '主对话已收到，请继续原话题。' },
        },
      ]),
    );
    provider.respond('tool:reply-to-notify-task', response('main accepted reply'));
    provider.respond('user:主对话已收到，请继续原话题。', response('task received main reply'));
    provider.respond('delivery:reply-to-notify-task', response('main received task reply'));
    provider.respond('user:ordinary after notification', response('ordinary response'));
    const ordinary = await fixture.clients.messages.sendMessage({
      clientActionId: 'send-ordinary-after-notification',
      threadId: mainId,
      text: 'ordinary after notification',
      mode: 1,
    });
    expect(ordinary.inputId).not.toBe('');
    provider.resolve('user:main is busy');
    await waitRequest(provider, 'notification:notify-busy');
    await waitRequest(provider, 'user:ordinary after notification');
    await waitRun(fixture, mainId, busy.runId, RunStatus.COMPLETED);
    const keys = provider.requests.map((request) => request.key);
    expect(keys.indexOf('notification:notify-busy')).toBeGreaterThan(
      keys.indexOf('user:main is busy'),
    );
    expect(keys.indexOf('user:ordinary after notification')).toBeGreaterThan(
      keys.indexOf('notification:notify-busy'),
    );
    expect(keys.indexOf('user:ordinary after notification')).toBeGreaterThan(
      keys.indexOf('tool:reply-to-notify-task'),
    );
    const notificationRequest = provider.requests.find(
      (request) => request.key === 'notification:notify-busy',
    )?.request;
    expect(notificationRequest?.messages.at(-1)?.content).toContain(task.threadId);
    expect(notificationRequest?.messages.at(-1)?.content).toContain(
      '主对话需要在下一步知道这个消息。',
    );
    await vi.waitFor(() => {
      expect(
        fixture.database
          .prepare(
            "SELECT status FROM interactions WHERE source_tool_call_id = 'reply-to-notify-task'",
          )
          .get(),
      ).toEqual({ status: 'completed' });
    });
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM interactions WHERE source_tool_call_id = 'notify-busy'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      (await context(fixture, task.threadId)).some(
        (message) =>
          message.source === MessageSource.THREAD_CALL &&
          message.delegation?.sourceToolCallId === 'reply-to-notify-task' &&
          message.content === '主对话已收到，请继续原话题。',
      ),
    ).toBe(true);
  } finally {
    provider.resolve('user:main is busy');
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);

it('restores an accepted receipt without duplicating a consumed notification after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-thread-notify-restart-'));
  const provider = new ControlledProvider();
  let fixture = await startFixture(directory, { provider });
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const task = await createTask(fixture, 'create-restart-notify-task', '重启通知话题');
    provider.respond(
      'user:restart notification',
      response('', [
        { id: 'notify-restart', name: 'thread_notify', arguments: { message: '只交付一次。' } },
      ]),
    );
    provider.respond('notification:notify-restart', response('main handled restart notification'));
    fixture.database.exec(`
      CREATE TRIGGER fail_thread_notify_receipt BEFORE INSERT ON context_messages
      WHEN NEW.role = 'tool' AND NEW.tool_call_id = 'notify-restart'
      BEGIN SELECT RAISE(FAIL, 'controlled notify receipt failure'); END;
    `);
    const taskRun = await sendMessage(
      fixture,
      task.threadId,
      'restart notification',
      'send-restart-notify-task',
    );
    await waitNotification(fixture, task.threadId, 'notify-restart', 'consumed');
    await waitRun(fixture, task.threadId, taskRun.runId, RunStatus.FAILED);
    const delivered = notification(fixture, task.threadId, 'notify-restart');
    if (!delivered?.run_id) throw new Error('The restart notification has no delivery Run.');
    await waitRun(fixture, mainId, delivered.run_id, RunStatus.COMPLETED);
    expect(
      (await context(fixture, task.threadId)).filter(
        (message) => message.role === MessageRole.TOOL && message.toolCallId === 'notify-restart',
      ),
    ).toEqual([]);
    fixture.database.exec('DROP TRIGGER fail_thread_notify_receipt');
    await closeFixture(fixture);

    const restartedProvider = new ControlledProvider();
    fixture = await startFixture(directory, { provider: restartedProvider });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(restartedProvider.requests).toEqual([]);
    restartedProvider.respond('tool:notify-restart', response('task recovered'));
    const continued = await fixture.clients.runs.continueRun({
      clientActionId: 'continue-restart-notify-task',
      threadId: task.threadId,
      runId: taskRun.runId,
    });
    expect(continued.status).toBe(RunStatus.QUEUED);
    await waitRun(fixture, task.threadId, taskRun.runId, RunStatus.COMPLETED);
    const receipt = toolResult(await context(fixture, task.threadId), 'notify-restart');
    expect(receipt.content).toContain('"status":"accepted"');
    expect(receipt.content).not.toContain('tool_result_unknown');
    expect(restartedProvider.requests.map((request) => request.key)).toEqual([
      'tool:notify-restart',
    ]);
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM thread_notifications WHERE source_tool_call_id = 'notify-restart'",
        )
        .get(),
    ).toEqual({ count: 1 });
    const mainSnapshot = await fixture.clients.thread.getThread({ threadId: mainId });
    expect(
      mainSnapshot.snapshot?.messages.filter(
        (message) =>
          message.source === MessageSource.THREAD_NOTIFICATION &&
          message.delegation?.sourceToolCallId === 'notify-restart',
      ),
    ).toHaveLength(1);
    await closeFixture(fixture);
    const quietProvider = new ControlledProvider();
    fixture = await startFixture(directory, { provider: quietProvider });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(quietProvider.requests).toEqual([]);
  } finally {
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);

it('supersedes queued notifications and removes consumed notifications from the current main view after source Rerun', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-thread-notify-rerun-'));
  const provider = new ControlledProvider();
  const fixture = await startFixture(directory, { provider });
  try {
    const mainId = (await fixture.clients.thread.getOrCreateMain({})).thread?.threadId ?? '';
    const queuedTask = await createTask(fixture, 'create-queued-rerun-task', '待注入失效话题');
    provider.register('user:main stays busy', response('busy finished'));
    provider.respond(
      'user:queued branch notification',
      response('', [
        {
          id: 'notify-queued-branch',
          name: 'thread_notify',
          arguments: { message: '不得进入新分支。' },
        },
      ]),
    );
    provider.respond('tool:notify-queued-branch', response('queued source finished'));
    const busy = await sendMessage(fixture, mainId, 'main stays busy', 'send-rerun-main-busy');
    await waitRequest(provider, 'user:main stays busy');
    const queuedRun = await sendMessage(
      fixture,
      queuedTask.threadId,
      'queued branch notification',
      'send-queued-branch',
    );
    await waitRun(fixture, queuedTask.threadId, queuedRun.runId, RunStatus.COMPLETED);
    await waitNotification(fixture, queuedTask.threadId, 'notify-queued-branch', 'queued');
    provider.respond('user:queued branch notification', response('queued source rerun finished'));
    const queuedRerun = await fixture.clients.runs.rerun({
      clientActionId: 'rerun-queued-notification-source',
      threadId: queuedTask.threadId,
      messageId: (await context(fixture, queuedTask.threadId))[0]?.messageId ?? '',
    });
    await waitRun(fixture, queuedTask.threadId, queuedRerun.runId, RunStatus.COMPLETED);
    await waitNotification(fixture, queuedTask.threadId, 'notify-queued-branch', 'superseded');
    provider.resolve('user:main stays busy');
    await waitRun(fixture, mainId, busy.runId, RunStatus.COMPLETED);
    expect(
      provider.requests.some((request) => request.key === 'notification:notify-queued-branch'),
    ).toBe(false);

    const consumedTask = await createTask(fixture, 'create-consumed-rerun-task', '已注入失效话题');
    provider.respond(
      'user:consumed branch notification',
      response('', [
        {
          id: 'notify-consumed-branch',
          name: 'thread_notify',
          arguments: { message: '旧通知正文不得召回。' },
        },
      ]),
    );
    provider.respond('tool:notify-consumed-branch', response('consumed source finished'));
    provider.respond(
      'notification:notify-consumed-branch',
      response('main consumed branch notice'),
    );
    const consumedRun = await sendMessage(
      fixture,
      consumedTask.threadId,
      'consumed branch notification',
      'send-consumed-branch',
    );
    await waitRun(fixture, consumedTask.threadId, consumedRun.runId, RunStatus.COMPLETED);
    await waitNotification(fixture, consumedTask.threadId, 'notify-consumed-branch', 'consumed');
    expect(
      mainNotification(
        await fixture.clients.thread.getThread({ threadId: mainId }),
        'notify-consumed-branch',
      ),
    ).toBeDefined();
    provider.respond(
      'user:consumed branch notification',
      response('consumed source rerun finished'),
    );
    const consumedRerun = await fixture.clients.runs.rerun({
      clientActionId: 'rerun-consumed-notification-source',
      threadId: consumedTask.threadId,
      messageId: (await context(fixture, consumedTask.threadId))[0]?.messageId ?? '',
    });
    await waitRun(fixture, consumedTask.threadId, consumedRerun.runId, RunStatus.COMPLETED);
    expect(notification(fixture, consumedTask.threadId, 'notify-consumed-branch')?.status).toBe(
      'consumed',
    );
    expect(
      mainNotification(
        await fixture.clients.thread.getThread({ threadId: mainId }),
        'notify-consumed-branch',
      ),
    ).toBeUndefined();
    expect(
      (await context(fixture, mainId)).some(
        (message) =>
          message.source === MessageSource.THREAD_NOTIFICATION &&
          message.delegation?.sourceToolCallId === 'notify-consumed-branch',
      ),
    ).toBe(true);

    provider.respond('user:main after source reruns', response('current view checked'));
    const after = await sendMessage(
      fixture,
      mainId,
      'main after source reruns',
      'send-main-after-reruns',
    );
    await waitRun(fixture, mainId, after.runId, RunStatus.COMPLETED);
    const request = provider.requests.find(
      (candidate) => candidate.key === 'user:main after source reruns',
    )?.request;
    expect(JSON.stringify(request?.messages)).not.toContain('旧通知正文不得召回');
    expect(JSON.stringify(request?.messages)).not.toContain('不得进入新分支');
  } finally {
    provider.resolve('user:main stays busy');
    await closeFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);
