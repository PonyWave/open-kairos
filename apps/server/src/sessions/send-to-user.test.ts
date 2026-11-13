import type { AssistantMessage, ModelEvent, ModelProvider, ToolCall } from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import { create, GetThreadRequestSchema, MessageRole } from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { getThreadSnapshot } from '../api/snapshot.js';
import { stripMessageMeta } from '../context/model-input.js';
import { ModelInputService } from '../context/model-input-service.js';
import { controlledEnvironmentDependencies } from '../integration/environment-fixture.js';
import { openDatabase } from '../storage/database.js';
import type {
  RunStatus,
  TextDeltaRecord,
  ThreadEventRecord,
  ToolProgressRecord,
} from './records.js';
import { RunCoordinator } from './runtime.js';
import { SessionStore } from './store.js';

const ownerId = 'send-to-user-runtime-owner';
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

function response(message: AssistantMessage): ModelEvent[] {
  return [
    ...(message.content ? [{ type: 'text_delta' as const, text: message.content }] : []),
    { type: 'response', message, usage },
  ];
}

function sendCall(id: string, content: string, endTurn: boolean): ToolCall {
  return { id, name: 'send_to_user', arguments: { content, end_turn: endTurn } };
}

function fixture(provider: ModelProvider) {
  const database = openDatabase(':memory:');
  const store = new SessionStore(database);
  const coordinator = new RunCoordinator({
    ...controlledEnvironmentDependencies(database, ownerId),
    store,
    model: {
      provider,
      providerId: 'test',
      modelId: 'test-model',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
    },
  });
  const thread = store.getOrCreateMainThread(ownerId);
  return { database, store, coordinator, thread };
}

function send(store: SessionStore, threadId: string, id = 'send-question') {
  return store.sendMessage({
    ownerId,
    threadId,
    text: id,
    mode: 'follow_up',
    clientActionId: id,
    method: 'SendMessage',
    parameters: {},
  });
}

async function waitStatus(store: SessionStore, runId: string, status: RunStatus) {
  await vi.waitFor(() => expect(store.getRunById(runId).status).toBe(status), { timeout: 3000 });
}

async function close(current: ReturnType<typeof fixture>) {
  await current.coordinator.close();
  current.database.close();
}

it('persists a final send, publishes its mode before text and restores exact display metadata', async () => {
  const provider = new ScriptedProvider([
    response({
      role: 'assistant',
      content: 'private note',
      tool_calls: [sendCall('final', '**完成。**', true)],
    }),
    response({
      role: 'assistant',
      content: '',
      tool_calls: [sendCall('next-final', '下一次回复。', true)],
    }),
  ]);
  const current = fixture(provider);
  const { store, thread, coordinator, database } = current;
  const events: Array<ThreadEventRecord | TextDeltaRecord | ToolProgressRecord> = [];
  const unsubscribe = store.subscribe(thread.threadId, (event) => events.push(event));
  try {
    const accepted = send(store, thread.threadId);
    await coordinator.deliver(accepted.input, accepted.runId);
    await waitStatus(store, accepted.runId, 'completed');
    expect(provider.requests).toHaveLength(1);
    expect(store.getRunById(accepted.runId).sendToUserEnabled).toBe(true);
    const modeIndex = events.findIndex(
      (event) =>
        'payload' in event &&
        event.payload.case === 'runChanged' &&
        event.payload.value.run.sendToUserEnabled === true,
    );
    const textIndex = events.findIndex((event) => !('payload' in event));
    expect(modeIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThan(modeIndex);
    const records = store.listContext(ownerId, thread.threadId);
    const assistant = records.find((record) => record.message.role === 'assistant');
    const result = records.find((record) => record.message.role === 'tool');
    expect(assistant?.sendToUserEnabled).toBe(true);
    expect(result).toMatchObject({
      sendToUserEnabled: true,
      message: {
        role: 'tool',
        tool_call_id: 'final',
        tool_name: 'send_to_user',
        status: 'success',
        content: JSON.stringify({
          status: 'sent',
          content: '**完成。**',
          message_seq: 2,
          end_turn: true,
        }),
      },
    });
    const snapshot = getThreadSnapshot(
      new SessionStore(database),
      ownerId,
      create(GetThreadRequestSchema, { threadId: thread.threadId }),
    ).snapshot;
    expect(
      snapshot?.messages.find((message) => message.role === MessageRole.ASSISTANT)
        ?.sendToUserEnabled,
    ).toBe(true);
    expect(
      snapshot?.messages.find((message) => message.role === MessageRole.TOOL)?.sendToUserEnabled,
    ).toBe(true);
    expect(snapshot?.runs[0]?.sendToUserEnabled).toBe(true);
    const committed = store
      .listEvents(thread.threadId, 0n)
      .find(
        (event) =>
          event.payload.case === 'messageCommitted' &&
          event.payload.value.message.message.role === 'assistant',
      );
    expect(committed?.payload).toMatchObject({
      case: 'messageCommitted',
      value: { message: { sendToUserEnabled: true } },
    });
    const next = send(store, thread.threadId, 'next-question');
    await coordinator.deliver(next.input, next.runId);
    await waitStatus(store, next.runId, 'completed');
    expect(provider.requests).toHaveLength(2);
    const nextMessages = provider.requests[1]?.messages ?? [];
    const callIndex = nextMessages.findIndex(
      (message) =>
        message.role === 'assistant' && message.tool_calls?.some((call) => call.id === 'final'),
    );
    expect(nextMessages[callIndex + 1]).toMatchObject({
      role: 'tool',
      tool_call_id: 'final',
      status: 'success',
    });
    expect(nextMessages.at(-1)?.role).toBe('user');
    expect(stripMessageMeta(String(nextMessages.at(-1)?.content))).toBe('next-question');
    expect(nextMessages.some((message) => 'sendToUserEnabled' in message)).toBe(false);
  } finally {
    unsubscribe();
    await close(current);
  }
});

it('continues after progress, rejects a mixed final send and can then send a valid final result', async () => {
  const provider = new ScriptedProvider([
    response({
      role: 'assistant',
      content: '',
      tool_calls: [sendCall('progress', '正在检查。', false)],
    }),
    response({
      role: 'assistant',
      content: '',
      tool_calls: [
        sendCall('mixed-final', '过早完成。', true),
        { id: 'list', name: 'thread_list', arguments: {} },
      ],
    }),
    response({
      role: 'assistant',
      content: '',
      tool_calls: [sendCall('final', '检查完成。', true)],
    }),
  ]);
  const current = fixture(provider);
  try {
    const accepted = send(current.store, current.thread.threadId);
    await current.coordinator.deliver(accepted.input, accepted.runId);
    await waitStatus(current.store, accepted.runId, 'completed');
    expect(provider.requests).toHaveLength(3);
    const results = current.store
      .listContext(ownerId, current.thread.threadId)
      .filter((record) => record.message.role === 'tool');
    expect(
      results.map(
        (record) =>
          record.message.role === 'tool' && [record.message.tool_call_id, record.message.status],
      ),
    ).toEqual([
      ['progress', 'success'],
      ['mixed-final', 'error'],
      ['list', 'success'],
      ['final', 'success'],
    ]);
  } finally {
    await close(current);
  }
});

it('does not report a final send when its result cannot be committed', async () => {
  const provider = new ScriptedProvider([
    response({
      role: 'assistant',
      content: '',
      tool_calls: [sendCall('final', '不会交付。', true)],
    }),
  ]);
  const current = fixture(provider);
  try {
    current.database.exec(`CREATE TRIGGER fail_user_send BEFORE INSERT ON context_messages
      WHEN NEW.role = 'tool' AND NEW.tool_name = 'send_to_user'
      BEGIN SELECT RAISE(FAIL, 'injected final result failure'); END;`);
    const accepted = send(current.store, current.thread.threadId);
    await current.coordinator.deliver(accepted.input, accepted.runId);
    await waitStatus(current.store, accepted.runId, 'failed');
    expect(provider.requests).toHaveLength(1);
    expect(
      current.store
        .listContext(ownerId, current.thread.threadId)
        .some((record) => record.message.role === 'tool'),
    ).toBe(false);
    expect(
      current.store
        .listEvents(current.thread.threadId, 0n)
        .some(
          (event) =>
            event.payload.case === 'messageCommitted' &&
            event.payload.value.message.message.role === 'tool',
        ),
    ).toBe(false);
  } finally {
    await close(current);
  }
});

it('keeps the tool and user communication instructions exclusive to the main root', async () => {
  const provider = new ScriptedProvider([
    response({
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'child', name: 'subagent', arguments: { task: '独立任务', mode: 'foreground' } },
      ],
    }),
    response({ role: 'assistant', content: 'child done' }),
    response({
      role: 'assistant',
      content: '',
      tool_calls: [sendCall('main-final', '完成。', true)],
    }),
    response({ role: 'assistant', content: 'task done' }),
  ]);
  const current = fixture(provider);
  try {
    const accepted = send(current.store, current.thread.threadId);
    await current.coordinator.deliver(accepted.input, accepted.runId);
    await waitStatus(current.store, accepted.runId, 'completed');
    const task = current.store.createThread({
      ownerId,
      title: '普通任务',
      clientActionId: 'task',
      method: 'CreateThread',
      parameters: {},
    });
    const taskAccepted = send(current.store, task.threadId, 'task-question');
    await current.coordinator.deliver(taskAccepted.input, taskAccepted.runId);
    await waitStatus(current.store, taskAccepted.runId, 'completed');
    expect(
      provider.requests.map((request) =>
        request.tools.some((tool) => tool.name === 'send_to_user'),
      ),
    ).toEqual([true, false, true, false]);
    const instructions = provider.requests.map((request) =>
      request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n'),
    );
    expect(instructions[0]).toContain('Use send_to_user for every user-facing');
    expect(instructions[0]).toContain('Never produce ordinary assistant text in this conversation');
    expect(instructions[0]).toContain('several send_to_user calls across the turn');
    expect(instructions[0]).toContain('the full view is only a diagnostic view');
    expect(instructions[0]).toContain(
      'your first and only action is exactly one send_to_user call',
    );
    expect(instructions[0]).toContain('"Who are you?" and "你是谁"');
    expect(instructions[1]).not.toContain('Use send_to_user for every user-facing');
    expect(instructions[3]).not.toContain('Use send_to_user for every user-facing');
    expect(
      provider.requests[0]?.tools.find((tool) => tool.name === 'send_to_user')?.description,
    ).toContain('ordinary assistant text is private execution content, never a reply');
    expect(
      provider.requests[0]?.tools.find((tool) => tool.name === 'send_to_user')?.description,
    ).toContain('the only tool call in that response');
  } finally {
    await close(current);
  }
});

it.each(['prepared', 'dispatched'] as const)(
  'restores the current generation mode before reusing a %s request',
  async (evidence) => {
    const current = fixture(new ScriptedProvider([]));
    const { store, database, thread } = current;
    try {
      const accepted = send(store, thread.threadId);
      const user = store.appendModelMessage({
        runId: accepted.runId,
        inputId: accepted.input.inputId,
        message: { role: 'user', content: accepted.input.text },
      });
      const inputs = new ModelInputService(database, { countTokens: () => 100 });
      const prepared = await inputs.prepare({
        threadId: thread.threadId,
        agentId: 'thread',
        requestId: 'reused-ready',
        tools: [{ name: 'send_to_user', description: 'send', parameters: {} }],
        systemInstructions: ['system'],
        contextWindowTokens: 128_000,
        pendingContextSeqs: [user.seq],
      });
      store.setCurrentRequestId(accepted.runId, prepared.requestId);
      store.recordModelRequestPrepared(accepted.runId, prepared.requestId);
      if (evidence === 'dispatched')
        store.recordModelRequestDispatched(accepted.runId, prepared.requestId);
      store.updateRunStatus(accepted.runId, 'interrupted');
      store.continueRun({
        ownerId,
        threadId: thread.threadId,
        runId: accepted.runId,
        method: 'Continue',
        clientActionId: 'continue',
        parameters: {},
      });
      expect(store.getRunById(accepted.runId).sendToUserEnabled).toBeUndefined();
      let nextRequestId = prepared.requestId;
      if (evidence === 'prepared') {
        const rebuilt = await inputs.prepare({
          threadId: thread.threadId,
          agentId: 'thread',
          requestId: 'rebuilt-ready',
          tools: [{ name: 'send_to_user', description: 'send', parameters: {} }],
          systemInstructions: ['system'],
          contextWindowTokens: 128_000,
          pendingContextSeqs: [user.seq],
        });
        nextRequestId = rebuilt.requestId;
        store.setCurrentRequestId(accepted.runId, nextRequestId);
        store.recordModelRequestPrepared(accepted.runId, nextRequestId);
      }
      store.recordModelRequestDispatched(accepted.runId, nextRequestId);
      expect(store.getRunById(accepted.runId)).toMatchObject({
        generation: 2,
        sendToUserEnabled: true,
      });
      const latest = store
        .listEvents(thread.threadId, 0n)
        .filter((event) => event.payload.case === 'runChanged')
        .at(-1);
      expect(latest?.payload).toMatchObject({
        case: 'runChanged',
        value: { run: { generation: 2, sendToUserEnabled: true } },
      });
    } finally {
      await close(current);
    }
  },
);

it('preserves each persisted message mode when Continue enables explicit sends on the same Run', async () => {
  const current = fixture(new ScriptedProvider([]));
  const { store, database, thread } = current;
  try {
    const accepted = send(store, thread.threadId);
    const user = store.appendModelMessage({
      runId: accepted.runId,
      inputId: accepted.input.inputId,
      message: { role: 'user', content: accepted.input.text },
    });
    const inputs = new ModelInputService(database, { countTokens: () => 100 });
    const legacy = await inputs.prepare({
      threadId: thread.threadId,
      agentId: 'thread',
      requestId: 'legacy-response',
      tools: [],
      systemInstructions: ['old'],
      contextWindowTokens: 128_000,
      pendingContextSeqs: [user.seq],
    });
    store.setCurrentRequestId(accepted.runId, legacy.requestId);
    store.recordModelRequestPrepared(accepted.runId, legacy.requestId);
    const oldAssistant = store.appendModelMessage({
      runId: accepted.runId,
      message: {
        role: 'assistant',
        content: 'old reply',
        tool_calls: [{ id: 'legacy-call', name: 'read', arguments: {} }],
      },
    });
    const oldResult = store.appendModelMessage({
      runId: accepted.runId,
      message: {
        role: 'tool',
        tool_call_id: 'legacy-call',
        tool_name: 'read',
        content: 'old result',
        status: 'success',
      },
    });
    store.updateRunStatus(accepted.runId, 'interrupted');
    store.continueRun({
      ownerId,
      threadId: thread.threadId,
      runId: accepted.runId,
      clientActionId: 'continue',
      method: 'Continue',
      parameters: {},
    });
    const next = await inputs.prepare({
      threadId: thread.threadId,
      agentId: 'thread',
      requestId: 'explicit-response',
      tools: [{ name: 'send_to_user', description: 'send', parameters: {} }],
      systemInstructions: ['new'],
      contextWindowTokens: 128_000,
    });
    store.setCurrentRequestId(accepted.runId, next.requestId);
    store.recordModelRequestPrepared(accepted.runId, next.requestId);
    const latest = store.appendModelMessage({
      runId: accepted.runId,
      message: { role: 'assistant', content: 'private new reply' },
    });
    const reloaded = new SessionStore(database);
    expect(reloaded.getRunById(accepted.runId).sendToUserEnabled).toBe(true);
    expect(
      reloaded.getContextMessage(ownerId, thread.threadId, oldAssistant.messageId)
        .sendToUserEnabled,
    ).toBe(false);
    expect(
      reloaded.getContextMessage(ownerId, thread.threadId, oldResult.messageId).sendToUserEnabled,
    ).toBe(false);
    expect(
      reloaded.getContextMessage(ownerId, thread.threadId, latest.messageId).sendToUserEnabled,
    ).toBe(true);
    const unversioned = store.appendModelMessage({
      runId: accepted.runId,
      message: { role: 'assistant', content: 'legacy fixture' },
    });
    expect(
      reloaded.getContextMessage(ownerId, thread.threadId, unversioned.messageId).sendToUserEnabled,
    ).toBeUndefined();
  } finally {
    await close(current);
  }
});
