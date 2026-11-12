import { expect, it } from 'vitest';
import { seedTestTenant } from '../integration/environment-fixture.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { createSendToUserTool } from './send-to-user.js';

const ownerId = 'send-to-user-tool-owner';

function fixture(task = false) {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  seedTestTenant(database, ownerId);
  const thread = task
    ? store.createThread({
        ownerId,
        method: 'CreateThread',
        clientActionId: 'create-task',
        parameters: {},
        title: '任务',
      })
    : store.getOrCreateMainThread(ownerId);
  const sent = store.sendMessage({
    ownerId,
    threadId: thread.threadId,
    text: 'question',
    mode: 'follow_up',
    clientActionId: 'send-question',
    method: 'SendMessage',
    parameters: {},
  });
  const run = store.getRunById(sent.runId);
  const tool = createSendToUserTool({ store, source: run });
  const call = {
    id: 'send-final',
    name: 'send_to_user',
    arguments: { content: '**完成。**\n\n检查通过。', end_turn: true },
  };
  return { database, store, thread, run, tool, call };
}

it('rejects missing content, unsupported payloads, invalid end_turn and excessive content', () => {
  const { database, tool } = fixture();
  try {
    for (const input of [
      {},
      { content: '' },
      { content: ' \n ' },
      { content: 'text', channel: 'external' },
      { content: 'text', end_turn: 'true' },
      { content: 'x'.repeat(20_001) },
    ]) {
      expect(() => tool.validate(input)).toThrow();
    }
    expect(tool.validate({ content: ' **正文**\n\n下一段。 ' })).toEqual({
      content: ' **正文**\n\n下一段。 ',
    });
  } finally {
    database.close();
  }
});

it('returns a final message only for its persisted main root intent', async () => {
  const { database, store, run, tool, call } = fixture();
  try {
    store.appendModelMessage({
      runId: run.runId,
      message: { role: 'assistant', content: '', tool_calls: [call] },
    });
    await expect(
      tool.execute(await tool.validate(call.arguments), {
        call,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      content: JSON.stringify({ status: 'sent', content: call.arguments.content, end_turn: true }),
      status: 'success',
      endTurn: true,
    });
    expect(
      store.listContext(ownerId, run.threadId).filter((message) => message.message.role === 'tool'),
    ).toHaveLength(0);
  } finally {
    database.close();
  }
});

it('rejects an unpersisted intent and an aborted send', async () => {
  const { database, tool, call } = fixture();
  try {
    await expect(
      tool.execute(await tool.validate(call.arguments), {
        call,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.execute(await tool.validate(call.arguments), { call, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    database.close();
  }
});

it('rejects changed parameters and a result that was already committed', async () => {
  const { database, store, run, tool, call } = fixture();
  try {
    store.appendModelMessage({
      runId: run.runId,
      message: { role: 'assistant', content: '', tool_calls: [call] },
    });
    await expect(
      tool.execute(await tool.validate({ content: 'different', end_turn: true }), {
        call,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'action_conflict' });
    store.appendModelMessage({
      runId: run.runId,
      message: {
        role: 'tool',
        tool_call_id: call.id,
        tool_name: call.name,
        content: 'sent',
        status: 'success',
      },
    });
    await expect(
      tool.execute(await tool.validate(call.arguments), {
        call,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'failed_precondition' });
  } finally {
    database.close();
  }
});

it('rejects a tool captured before Continue changed the execution generation', async () => {
  const { database, store, thread, run, tool, call } = fixture();
  try {
    store.appendModelMessage({
      runId: run.runId,
      message: { role: 'assistant', content: '', tool_calls: [call] },
    });
    store.updateRunStatus(run.runId, 'interrupted');
    store.continueRun({
      ownerId,
      threadId: thread.threadId,
      runId: run.runId,
      clientActionId: 'continue',
      method: 'Continue',
      parameters: {},
    });
    await expect(
      tool.execute(await tool.validate(call.arguments), {
        call,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'action_conflict' });
  } finally {
    database.close();
  }
});

it('rejects direct task and Subagent execution even when given a persisted call', async () => {
  for (const kind of ['task', 'subagent'] as const) {
    const { database, store, run, call } = fixture(kind === 'task');
    try {
      const source = kind === 'subagent' ? store.createChildRun(ownerId, run.runId, 'child') : run;
      store.appendModelMessage({
        runId: source.runId,
        message: { role: 'assistant', content: '', tool_calls: [call] },
      });
      const tool = createSendToUserTool({ store, source });
      await expect(
        tool.execute(await tool.validate(call.arguments), {
          call,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'permission_denied' });
    } finally {
      database.close();
    }
  }
});

it('allows a workspace main root Agent to send its reply', async () => {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  seedTestTenant(database, ownerId);
  try {
    const workspace = store.createWorkspace({
      ownerId,
      name: 'project-alpha',
      envId: 'main',
      path: '/workspace/project-alpha',
    });
    const sent = store.sendMessage({
      ownerId,
      threadId: workspace.mainThread.threadId,
      text: 'question',
      mode: 'follow_up',
      clientActionId: 'send-ws-question',
      method: 'SendMessage',
      parameters: {},
    });
    const run = store.getRunById(sent.runId);
    const call = {
      id: 'send-ws-final',
      name: 'send_to_user',
      arguments: { content: '整理完成。', end_turn: true },
    };
    store.appendModelMessage({
      runId: run.runId,
      message: { role: 'assistant', content: '', tool_calls: [call] },
    });
    const tool = createSendToUserTool({ store, source: run });
    await expect(
      tool.execute(await tool.validate(call.arguments), {
        call,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      content: JSON.stringify({ status: 'sent', content: '整理完成。', end_turn: true }),
      status: 'success',
      endTurn: true,
    });
  } finally {
    database.close();
  }
});

it.each(['complete', 'incomplete'] as const)(
  'rejects a final send in a response with another %s tool call',
  async (kind) => {
    const { database, store, run, tool, call } = fixture();
    try {
      store.appendModelMessage({
        runId: run.runId,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            call,
            ...(kind === 'complete' ? [{ id: 'other', name: 'recall', arguments: {} }] : []),
          ],
          ...(kind === 'incomplete'
            ? {
                incomplete_tool_calls: [
                  { id: 'other', name: 'recall', arguments_text: '{', error: 'incomplete' },
                ],
              }
            : {}),
        },
      });
      await expect(
        tool.execute(await tool.validate(call.arguments), {
          call,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      database.close();
    }
  },
);
