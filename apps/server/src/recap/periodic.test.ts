import type { DatabaseSync } from 'node:sqlite';
import type {
  AssistantMessage,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ToolCall,
} from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { pngBytes } from '../attachments/fixtures.js';
import { ContextStore } from '../context/context-store.js';
import { stripMessageMeta } from '../context/model-input.js';
import { ModelInputService } from '../context/model-input-service.js';
import { seedTestTenant } from '../integration/environment-fixture.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import type { RecapGenerationOperationInput } from './generation-operation-store.js';
import { RecapGenerationOperationStore } from './generation-operation-store.js';
import { PeriodicRecapService } from './periodic.js';
import { RecapStore } from './recap-store.js';

const usage = {
  input_tokens: 30,
  output_tokens: 5,
  total_tokens: 35,
  prompt_tokens_details: { cached_tokens: 17 },
};
const initialTime = Date.parse('2026-11-03T10:00:00.000Z');

function response(content: string, toolCalls?: ToolCall[]): ModelEvent[] {
  return [
    {
      type: 'response',
      message: {
        role: 'assistant',
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      usage,
    },
  ];
}

function deferred() {
  let resolve = () => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class GatedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  readonly gates: Array<ReturnType<typeof deferred>>;

  constructor(readonly responses: ModelEvent[][]) {
    this.gates = responses.map(() => deferred());
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const index = this.requests.length;
    this.requests.push(structuredClone(request));
    const gate = this.gates[index];
    const events = this.responses[index];
    if (!gate || !events) throw new Error('No gated response remains.');
    await Promise.race([
      gate.promise,
      new Promise<void>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
    signal.throwIfAborted();
    for (const event of events) yield event;
  }
}

function clockAt(now: () => number) {
  return () => new Date(now());
}

function createService(
  database: DatabaseSync,
  provider: ModelProvider,
  now: () => number,
  options: {
    triggerMessages?: number;
    idleAfterMs?: number;
    maxMessages?: number;
    onError?: (error: unknown) => void;
    modelId?: string;
    recapStore?: RecapStore;
  } = {},
) {
  return new PeriodicRecapService({
    database,
    provider,
    model: {
      providerId: 'test',
      modelId: options.modelId ?? 'model',
      contextWindowTokens: 1000,
      outputReserveTokens: 100,
    },
    configuration: {
      triggerMessages: options.triggerMessages ?? 10,
      idleAfterMs: options.idleAfterMs ?? 0,
      maxMessages: options.maxMessages ?? 20,
    },
    clock: clockAt(now),
    ...(options.recapStore ? { recapStore: options.recapStore } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
}

async function completedExchange(
  database: DatabaseSync,
  now: () => number,
  options: {
    requestId: string;
    userCount: number;
    threadId?: string;
    responseContent?: string;
    toolCalls?: ToolCall[];
    otherAgentMessage?: boolean;
    imageToolResult?: boolean;
  },
) {
  const threadId = options.threadId ?? 'thread';
  const context = new ContextStore(database, clockAt(now));
  let laterSource: ReturnType<ContextStore['append']> | undefined;
  for (let index = 0; index < options.userCount; index += 1) {
    const savedUser = context.append({
      threadId,
      agentId: 'thread',
      message: { role: 'user', content: `user-${options.requestId}-${index}` },
    });
    if (options.imageToolResult && index === 0) {
      const callId = `image-${options.requestId}`;
      context.append({
        threadId,
        agentId: 'thread',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: callId, name: 'read_image', arguments: { path: 'one.png' } }],
        },
      });
      const attachment = new SessionStore(database).attachments.upload({
        ownerId: 'owner-periodic-image',
        clientActionId: `upload-${options.requestId}`,
        fileName: 'one.png',
        bytes: pngBytes,
      }).attachment;
      const tool = context.append({
        threadId,
        agentId: 'thread',
        message: {
          role: 'tool',
          content: JSON.stringify({ attachment_id: attachment.attachmentId }),
          content_parts: [{ type: 'attachment', attachment_id: attachment.attachmentId }],
          tool_call_id: callId,
          tool_name: 'read_image',
        },
      });
      new SessionStore(database).attachments.linkMessage(tool.seq, 'owner-periodic-image', [
        attachment.attachmentId,
      ]);
    }
    if (options.imageToolResult && index === 1) laterSource = savedUser;
    if (options.otherAgentMessage && index === 4) {
      context.append({
        threadId,
        agentId: 'other',
        message: { role: 'user', content: 'other Agent must not be summarized' },
      });
    }
  }
  const modelInputs = new ModelInputService(database, {
    countTokens: () => 10,
    clock: clockAt(now),
  });
  await modelInputs.prepare({
    threadId,
    agentId: 'thread',
    requestId: options.requestId,
    systemInstructions: ['system instructions'],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    contextWindowTokens: 1000,
    outputReserveTokens: 100,
  });
  const assistant: AssistantMessage = {
    role: 'assistant',
    content: options.responseContent ?? `response-${options.requestId}`,
    ...(options.toolCalls ? { tool_calls: options.toolCalls } : {}),
  };
  const savedResponse = context.append({
    threadId,
    agentId: 'thread',
    message: assistant,
    responseUsage: usage,
  });
  database
    .prepare(
      "UPDATE model_request_records SET status = 'completed', updated_at = ? WHERE request_id = ?",
    )
    .run(new Date(now()).toISOString(), options.requestId);
  return {
    context,
    modelInputs,
    response: savedResponse,
    laterSource,
    normalRequest: modelInputs.getRequestRecord(options.requestId)?.request,
  };
}

async function finish(service: PeriodicRecapService, database: DatabaseSync) {
  await service.close();
  database.close();
}

it('includes direct delivery in root periodic Recap without using the ordinary input queue', async () => {
  const database = openDatabase(':memory:');
  const now = initialTime;
  const ownerId = 'owner-direct-recap';
  const store = new SessionStore(database, { clock: clockAt(() => now) });
  seedTestTenant(database, ownerId);
  const provider = new ScriptedProvider([response('direct delivery recap')]);
  let service: PeriodicRecapService | undefined;
  try {
    const main = store.getOrCreateMainThread(ownerId);
    const task = store.createThread({
      ownerId,
      clientActionId: 'create-direct-recap-task',
      method: 'CreateThread',
      parameters: { title: '后台任务' },
      title: '后台任务',
    });
    const source = store.sendMessage({
      ownerId,
      clientActionId: 'direct-recap-source',
      method: 'SendMessage',
      parameters: { threadId: main.threadId, text: '来源问题', mode: 'follow_up' as const },
      threadId: main.threadId,
      text: '来源问题',
      mode: 'follow_up',
    });
    const accepted = store.acceptThreadCall({
      ownerId,
      sourceThreadId: main.threadId,
      sourceAgentId: 'thread',
      sourceRunId: source.runId,
      sourceToolCallId: 'direct-recap-call',
      targetThreadId: task.threadId,
      prompt: '目标输入',
      mode: 'follow_up',
    });
    store.appendModelMessage({
      runId: accepted.runId,
      inputId: accepted.input.inputId,
      message: { role: 'user', content: accepted.input.text },
    });
    const targetResponse = store.appendModelMessage({
      runId: accepted.runId,
      message: { role: 'assistant', content: 'target internal response' },
    });
    store.recordInteractionResponses({
      runId: accepted.runId,
      messageId: targetResponse.messageId,
      interactionKeys: [accepted.interaction],
    });
    const directText = 'direct background response';
    const delivered = store.enqueueInteractionDelivery({
      ownerId,
      key: accepted.interaction,
      text: directText,
    });
    if (delivered.runId === null) throw new Error('Expected a root Run for direct delivery.');
    const inputCount = store.listInputs(ownerId, main.threadId).length;
    const queueVersion = store.queueVersion(main.threadId);
    const direct = store.appendInteractionDeliveryMessage({
      runId: delivered.runId,
      key: accepted.interaction,
      message: { role: 'user', content: directText },
    });
    expect(direct).toMatchObject({
      agentId: 'thread',
      source: 'thread_response',
      sourceInputId: null,
      sourceThreadId: task.threadId,
      sourceAgentId: 'thread',
      delegation: {
        sourceThreadId: accepted.interaction.sourceThreadId,
        sourceAgentId: accepted.interaction.sourceAgentId,
        sourceToolCallId: accepted.interaction.sourceToolCallId,
      },
    });
    expect(store.getInteractionDelivery(ownerId, accepted.interaction)).toMatchObject({
      status: 'consumed',
      contextMessageSeq: direct.seq,
    });
    expect(store.listInputs(ownerId, main.threadId)).toHaveLength(inputCount);
    expect(store.queueVersion(main.threadId)).toBe(queueVersion);

    const exchange = await completedExchange(database, () => now, {
      requestId: 'direct-recap-request',
      threadId: main.threadId,
      userCount: 18,
      responseContent: 'root response',
    });
    service = createService(database, provider, () => now, { recapStore: store.recaps });
    service.schedule(main.threadId, 'thread');
    await vi.waitFor(() => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 1 });
    });

    const normalRequest = exchange.normalRequest;
    const recapRequest = provider.requests[0];
    if (!normalRequest || !recapRequest) throw new Error('Expected normal and Recap requests.');
    expect(
      normalRequest.messages.filter(
        (message) => stripMessageMeta(String(message.content)) === directText,
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(normalRequest)).not.toContain('target internal response');
    expect(recapRequest.messages.slice(0, normalRequest.messages.length)).toEqual(
      normalRequest.messages,
    );
    expect(recapRequest.messages.at(-1)?.content).toContain('Kairos internal Recap operation');
    const recaps = new RecapStore(database).query({
      threadId: main.threadId,
      agentId: 'thread',
    });
    expect(recaps).toHaveLength(1);
    expect(recaps[0]?.sourceMessageSeqs).toHaveLength(20);
    expect(recaps[0]?.sourceMessageSeqs[0]).toBe(direct.seq);
    expect(recaps[0]?.sourceMessageSeqs.at(-1)).toBe(exchange.response.seq);
    const created = store
      .listEvents(main.threadId, 0n)
      .filter((event) => event.payload.case === 'recapCreated');
    expect(created).toHaveLength(1);
    expect(created[0]?.payload).toMatchObject({
      case: 'recapCreated',
      value: {
        recap: {
          content: 'direct delivery recap',
          sourceSeqEnd: exchange.response.seq,
        },
      },
    });
  } finally {
    if (service) await service.close();
    if (database.isOpen) database.close();
  }
});

it('does not schedule without a reliable completed response', async () => {
  const database = openDatabase(':memory:');
  const context = new ContextStore(database);
  for (let index = 0; index < 20; index += 1) {
    context.append({
      threadId: 'thread',
      agentId: 'thread',
      message: { role: 'user', content: `unconfirmed-${index}` },
    });
  }
  const provider = new ScriptedProvider([]);
  const service = createService(database, provider, () => initialTime);
  try {
    service.resume();
    await service.close();
    expect(provider.requests).toHaveLength(0);
    expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 0 });
  } finally {
    if (database.isOpen) database.close();
  }
});

it.each([
  { userCount: 9, expected: 0 },
  { userCount: 10, expected: 1 },
])(
  'applies the trigger-message boundary with $userCount prior users',
  async ({ userCount, expected }) => {
    const database = openDatabase(':memory:');
    const now = initialTime;
    const provider = new ScriptedProvider([response('periodic recap')]);
    await completedExchange(database, () => now, { requestId: 'x', userCount });
    const service = createService(database, provider, () => now);
    try {
      service.schedule('thread', 'thread');
      await vi.waitFor(() => {
        expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({
          count: expected,
        });
      });
      expect(provider.requests).toHaveLength(expected);
      if (expected === 1) {
        expect(database.prepare('SELECT source_message_seqs FROM recaps').get()).toEqual({
          source_message_seqs: JSON.stringify(Array.from({ length: 11 }, (_, index) => index + 1)),
        });
      }
    } finally {
      await finish(service, database);
    }
  },
);

it.each([{ elapsed: 179_999 }, { elapsed: 180_000 }, { elapsed: 180_001 }])(
  'applies the idle boundary at $elapsed ms',
  async ({ elapsed }) => {
    const database = openDatabase(':memory:');
    let now = initialTime;
    await completedExchange(database, () => now, { requestId: 'y', userCount: 19 });
    now += elapsed;
    const provider = new ScriptedProvider([response('periodic recap')]);
    const service = createService(database, provider, () => now, { idleAfterMs: 180_000 });
    try {
      service.resume();
      if (elapsed < 180_000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(provider.requests).toHaveLength(0);
        now += 1;
      }
      await vi.waitFor(() => {
        expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({
          count: 1,
        });
      });
      await service.close();
      expect(provider.requests).toHaveLength(1);
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({
        count: 1,
      });
    } finally {
      if (database.isOpen) database.close();
    }
  },
);

it('waits for complete tool groups, preserves the normal prefix and excludes later input and other Agents', async () => {
  const database = openDatabase(':memory:');
  const now = initialTime;
  const calls = [
    { id: 'call-1', name: 'read', arguments: { path: 'one' } },
    { id: 'call-2', name: 'read', arguments: { path: 'two' } },
  ];
  const exchange = await completedExchange(database, () => now, {
    requestId: 'tools',
    userCount: 17,
    toolCalls: calls,
    otherAgentMessage: true,
  });
  const provider = new ScriptedProvider([response('tool group recap')]);
  const service = createService(database, provider, () => now);
  try {
    service.schedule('thread', 'thread');
    await service.close();
    expect(provider.requests).toHaveLength(0);
    const first = exchange.context.append({
      threadId: 'thread',
      agentId: 'thread',
      message: {
        role: 'tool',
        content: 'first result',
        tool_call_id: 'call-1',
        tool_name: 'read',
      },
    });
    const runningAgain = createService(database, provider, () => now);
    runningAgain.schedule('thread', 'thread');
    await runningAgain.close();
    expect(provider.requests).toHaveLength(0);
    const second = exchange.context.append({
      threadId: 'thread',
      agentId: 'thread',
      message: {
        role: 'tool',
        content: 'second result',
        tool_call_id: 'call-2',
        tool_name: 'read',
      },
    });
    const pending = exchange.context.append({
      threadId: 'thread',
      agentId: 'thread',
      message: { role: 'user', content: 'future pending input' },
    });
    const active = createService(database, provider, () => now);
    active.schedule('thread', 'thread');
    await vi.waitFor(() => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 1 });
    });
    const recapRequest = provider.requests[0];
    const normalRequest = exchange.normalRequest;
    if (!recapRequest || !normalRequest) throw new Error('Expected normal and Recap requests.');
    expect(recapRequest.messages.slice(0, normalRequest.messages.length)).toEqual(
      normalRequest.messages,
    );
    expect(JSON.stringify(recapRequest.messages.slice(0, normalRequest.messages.length))).toBe(
      JSON.stringify(normalRequest.messages),
    );
    expect(recapRequest.tools).toEqual(normalRequest.tools);
    expect(recapRequest.messages.at(-2)).toMatchObject({ role: 'tool', content: 'second result' });
    expect(recapRequest.messages.at(-1)?.content).toContain('Kairos internal Recap operation');
    expect(JSON.stringify(recapRequest)).not.toContain('future pending input');
    expect(JSON.stringify(recapRequest)).not.toContain('other Agent must not be summarized');
    const recap = database.prepare('SELECT source_message_seqs FROM recaps').get();
    expect(recap).toEqual({
      source_message_seqs: JSON.stringify([
        ...Array.from({ length: 17 }, (_, index) => index + 1 + (index >= 5 ? 1 : 0)),
        19,
        first.seq,
        second.seq,
      ]),
    });
    expect(pending.seq).toBeGreaterThan(second.seq);
    expect(database.prepare('SELECT COUNT(*) AS count FROM context_messages').get()).toEqual({
      count: 22,
    });
    expect(
      JSON.stringify(database.prepare('SELECT content FROM context_messages').all()),
    ).not.toContain('Kairos internal Recap operation');
    await active.close();
  } finally {
    if (database.isOpen) database.close();
  }
});

it('resumes from the latest valid Recap frontier with capped batches', async () => {
  const database = openDatabase(':memory:');
  const now = initialTime;
  const provider = new ScriptedProvider([response('first recap'), response('second recap')]);
  await completedExchange(database, () => now, { requestId: 'first', userCount: 19 });
  const service = createService(database, provider, () => now);
  try {
    service.schedule('thread', 'thread');
    await vi.waitFor(() => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 1 });
    });
    await completedExchange(database, () => now, { requestId: 'second', userCount: 25 });
    service.schedule('thread', 'thread');
    await vi.waitFor(() => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 2 });
    });
    const rows = database
      .prepare('SELECT source_message_seqs FROM recaps ORDER BY source_seq_start')
      .all();
    expect(rows).toEqual([
      { source_message_seqs: JSON.stringify(Array.from({ length: 20 }, (_, index) => index + 1)) },
      { source_message_seqs: JSON.stringify(Array.from({ length: 20 }, (_, index) => index + 21)) },
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.messages.at(-1)?.content).not.toContain('source_seq_end');
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain(
      '"source_seq_start":1,"source_seq_end":20,"content":"first recap"',
    );
  } finally {
    await finish(service, database);
  }
});

it('caps each periodic Recap at maxMessages without splitting a tool group', async () => {
  const database = openDatabase(':memory:');
  const now = initialTime;
  const calls = [
    { id: 'call-1', name: 'read', arguments: { path: 'one' } },
    { id: 'call-2', name: 'read', arguments: { path: 'two' } },
  ];
  const exchange = await completedExchange(database, () => now, {
    requestId: 'cap',
    userCount: 18,
    toolCalls: calls,
  });
  for (const [index, call] of calls.entries()) {
    exchange.context.append({
      threadId: 'thread',
      agentId: 'thread',
      message: {
        role: 'tool',
        content: `result-${index + 1}`,
        tool_call_id: call.id,
        tool_name: call.name,
      },
    });
  }
  const provider = new ScriptedProvider([response('capped recap')]);
  const service = createService(database, provider, () => now);
  try {
    service.schedule('thread', 'thread');
    await vi.waitFor(() => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 1 });
    });
    await service.close();
    expect(provider.requests).toHaveLength(1);
    expect(database.prepare('SELECT source_message_seqs FROM recaps').get()).toEqual({
      source_message_seqs: JSON.stringify(Array.from({ length: 18 }, (_, index) => index + 1)),
    });
  } finally {
    if (database.isOpen) database.close();
  }
});

it('single-flights and persistently deduplicates generation while allowing later appends', async () => {
  const database = openDatabase(':memory:');
  const now = initialTime;
  const exchange = await completedExchange(database, () => now, {
    requestId: 'dedupe',
    userCount: 19,
  });
  const provider = new GatedProvider([response('deduplicated recap')]);
  const service = createService(database, provider, () => now);
  try {
    service.schedule('thread', 'thread');
    service.schedule('thread', 'thread');
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    exchange.context.append({
      threadId: 'thread',
      agentId: 'thread',
      message: { role: 'user', content: 'later append is allowed' },
    });
    provider.gates[0]?.resolve();
    await vi.waitFor(() => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 1 });
    });
    service.schedule('thread', 'thread');
    await service.close();
    expect(provider.requests).toHaveLength(1);
    expect(
      database.prepare('SELECT status, usage_json FROM recap_generation_operations').get(),
    ).toEqual({ status: 'completed', usage_json: JSON.stringify(usage) });

    const restartedProvider = new ScriptedProvider([]);
    const restarted = createService(database, restartedProvider, () => now);
    restarted.resume();
    await restarted.close();
    expect(restartedProvider.requests).toHaveLength(0);
  } finally {
    if (database.isOpen) database.close();
  }
});

it.each(['edit', 'rerun'])(
  'discards a delayed result after %s changes the source view',
  async (change) => {
    const database = openDatabase(':memory:');
    const now = initialTime;
    const exchange = await completedExchange(database, () => now, {
      requestId: change,
      userCount: 19,
    });
    const provider = new GatedProvider([response('stale recap')]);
    const errors: unknown[] = [];
    const service = createService(database, provider, () => now, {
      onError: (error) => errors.push(error),
    });
    try {
      service.schedule('thread', 'thread');
      await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
      if (change === 'edit') {
        exchange.context.revise({
          threadId: 'thread',
          agentId: 'thread',
          seq: 1,
          content: 'edited source',
        });
      } else {
        database
          .prepare(
            'UPDATE model_input_states SET view_version = view_version + 1 WHERE thread_id = ? AND agent_id = ?',
          )
          .run('thread', 'thread');
      }
      provider.gates[0]?.resolve();
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      await service.close();
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 0 });
      expect(database.prepare('SELECT status FROM recap_generation_operations').get()).toEqual({
        status: 'failed',
      });
    } finally {
      if (database.isOpen) database.close();
    }
  },
);

it('rejects different request parameters for the same persistent generation key', () => {
  const database = openDatabase(':memory:');
  const operations = new RecapGenerationOperationStore(database);
  const operation: RecapGenerationOperationInput = {
    generation: {
      threadId: 'thread',
      agentId: 'thread',
      sourceMessageSeqs: [1],
      sourceMessageIndexes: [{ seq: 1, messageIndex: 0 }],
      messages: [],
      request: { messages: [{ role: 'user', content: 'source' }], tools: [] },
      viewVersion: 0,
      trigger: 'periodic',
    },
    sourceFingerprint: 'source-fingerprint',
    instructionVersion: 1,
    requestFingerprint: 'request-fingerprint',
  };
  try {
    expect(operations.begin(operation).status).toBe('started');
    expect(() =>
      operations.begin({ ...operation, requestFingerprint: 'different-request' }),
    ).toThrow(/conflicting parameters/);
  } finally {
    database.close();
  }
});

it('keeps normal Context after periodic failure and retries only on a later evaluation', async () => {
  const database = openDatabase(':memory:');
  const now = initialTime;
  await completedExchange(database, () => now, { requestId: 'failure', userCount: 19 });
  const before = database.prepare('SELECT * FROM context_messages').all();
  const provider = new ScriptedProvider([response(''), response('recovered recap')]);
  const errors: unknown[] = [];
  const service = createService(database, provider, () => now, {
    onError: (error) => errors.push(error),
  });
  try {
    service.schedule('thread', 'thread');
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT status FROM recap_generation_operations').get()).toEqual({
      status: 'failed',
    });
    service.schedule('thread', 'thread');
    await vi.waitFor(() => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 1 });
    });
    expect(database.prepare('SELECT * FROM context_messages').all()).toEqual(before);
  } finally {
    await finish(service, database);
  }
});

it('cancels and waits during close, then recovers an interrupted operation within Y', async () => {
  const database = openDatabase(':memory:');
  let now = initialTime;
  await completedExchange(database, () => now, { requestId: 'close', userCount: 19 });
  const provider = new GatedProvider([response('must not commit')]);
  const service = createService(database, provider, () => now);
  service.schedule('thread', 'thread');
  await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
  await service.close();
  expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 0 });
  expect(database.prepare('SELECT status FROM recap_generation_operations').get()).toEqual({
    status: 'interrupted',
  });

  now += 1;
  const restartedProvider = new ScriptedProvider([response('recovered after restart')]);
  const restarted = createService(database, restartedProvider, () => now);
  restarted.resume();
  await vi.waitFor(() => {
    expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 1 });
  });
  await restarted.close();
  expect(restartedProvider.requests).toHaveLength(1);
  database.close();
});

describe('periodic Recap source indexes in the final Provider request', () => {
  it('keeps a later source aligned after an image tool result', async () => {
    const database = openDatabase(':memory:');
    const now = initialTime;
    const exchange = await completedExchange(database, () => now, {
      requestId: 'periodic-image',
      userCount: 2,
      imageToolResult: true,
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        `${data({ choices: [{ delta: { content: 'recap' }, finish_reason: 'stop' }] })}${data({
          choices: [],
          usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
        })}data: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const provider = new OpenAICompatibleProvider(
      {
        baseUrl: 'https://model.example/v1',
        model: 'model-test',
        contextWindow: 1000,
        outputReserve: 100,
      },
      fetchMock,
    );
    const materializingProvider: ModelProvider = {
      stream: (request, signal) =>
        provider.stream(new SessionStore(database).attachments.materializeRequest(request), signal),
      mapMessageIndex: (request, messageIndex) =>
        provider.mapMessageIndex(
          new SessionStore(database).attachments.materializeRequest(request),
          messageIndex,
        ),
    };
    const errors: unknown[] = [];
    const service = createService(database, materializingProvider, () => now, {
      triggerMessages: 1,
      onError: (error) => errors.push(error),
    });
    try {
      service.schedule('thread', 'thread');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(errors).toEqual([]);
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 1 });
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      const later = exchange.laterSource;
      if (!later) throw new Error('The later periodic source is missing.');
      expect(body.messages[3]).toMatchObject({
        role: 'tool',
        tool_call_id: 'image-periodic-image',
      });
      expect(body.messages[4]).toMatchObject({ role: 'user' });
      expect(body.messages[5]?.role).toBe('user');
      expect(stripMessageMeta(String(body.messages[5]?.content))).toBe('user-periodic-image-1');
      expect(body.messages.at(-1)?.content).toContain(`{"seq":${later.seq},"message_index":5}`);
      expect(body.messages.at(-1)?.content).not.toContain(`{"seq":${later.seq},"message_index":4}`);
    } finally {
      await service.close();
      if (database.isOpen) database.close();
    }
  });
});

function data(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}
