import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Code } from '@connectrpc/connect';
import type { ModelProvider } from '@kairos/agent-core';
import {
  ContentBlockType,
  MessageRole,
  RunStatus,
  type ThreadSnapshotCursor,
  type WatchThreadResponse,
} from '@kairos/contracts';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import {
  ControlledSseServer,
  chunk,
  closeThinkingFixture,
  createThinkingThread,
  deferred,
  sendThinkingMessage,
  startThinkingFixture,
  type ThinkingFixture,
  thinkingOwnerId,
  usageChunk,
  waitThinkingRun,
} from './thinking-fixture.js';

type WatchIterator = AsyncIterator<WatchThreadResponse>;

const storedAssistantsSchema = z.array(
  z.object({
    message_id: z.string(),
    content: z.string(),
    content_blocks_json: z.string().nullable(),
    tool_calls_json: z.string().nullable(),
  }),
);

async function readSnapshotPages(fixture: ThinkingFixture, threadId: string) {
  const pages = [];
  let cursor: ThreadSnapshotCursor | undefined;
  do {
    const page = await fixture.clients.thread.getThread({
      threadId,
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    pages.push(page);
    expect(page.hasMore).toBe(page.nextCursor !== undefined);
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}

async function readContextPages(fixture: ThinkingFixture, threadId: string) {
  const messages = [];
  let afterSeq = 0n;
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const page = await fixture.clients.context.readContext({
      threadId,
      agentId: 'thread',
      afterSeq,
      limit: 1,
    });
    messages.push(...page.messages);
    if (!page.hasMore) {
      expect(page.nextSeq).toBeUndefined();
      return messages;
    }
    expect(page.nextSeq).toBeDefined();
    afterSeq = page.nextSeq ?? afterSeq;
  }
  throw new Error('ReadContext pagination did not finish.');
}

function deltaDetails(response: WatchThreadResponse) {
  if (response.payload.case !== 'textDelta' && response.payload.case !== 'thinkingDelta') {
    return undefined;
  }
  const delta = response.payload.value;
  return {
    case: response.payload.case,
    messageId: delta.messageId,
    deltaSeq: delta.deltaSeq,
    blockIndex: delta.blockIndex,
    text: delta.text,
    ...(response.payload.case === 'thinkingDelta' ? { runId: response.payload.value.runId } : {}),
  };
}

it('streams controlled Thinking through Provider, AgentLoop, SQLite and Connect with recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-thinking-controlled-'));
  const marker = join(directory, 'tool-executed.txt');
  const finishFirst = deferred();
  const finishSecond = deferred();
  const sse = new ControlledSseServer([
    [
      { data: chunk({ reasoning_content: 'Plan' }) },
      { data: chunk({ content: 'Before tool.' }) },
      { data: chunk({ reasoning_content: 'Verify.' }) },
      {
        data: chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: 'controlled-bash-call',
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({
                    env_id: 'env-1',
                    command: `printf controlled-tool > ${marker}`,
                    cwd: directory,
                    timeoutSeconds: 10,
                  }),
                },
              },
            ],
          },
          'tool_calls',
        ),
      },
      { data: usageChunk() },
      { gate: finishFirst.promise },
      { data: '[DONE]' },
    ],
    [
      { gate: finishSecond.promise },
      { data: chunk({ reasoning_content: 'Final reasoning.' }) },
      { data: chunk({ content: 'Final answer.' }, 'stop') },
      { data: usageChunk() },
      { data: '[DONE]' },
    ],
  ]);
  await sse.listen();
  const provider: ModelProvider = new OpenAICompatibleProvider({
    baseUrl: sse.baseUrl,
    model: 'controlled-thinking-model',
    contextWindow: 128_000,
    outputReserve: 4096,
  });
  const fixture = await startThinkingFixture(directory, { provider });
  const controllers: AbortController[] = [];
  try {
    const threadId = await createThinkingThread(fixture, 'controlled-thinking-thread');
    const initialCursor = (await fixture.clients.thread.getThread({ threadId })).throughSeq;
    const firstController = new AbortController();
    controllers.push(firstController);
    const firstWatch = fixture.clients.events
      .watchThread({ threadId, afterSeq: initialCursor }, { signal: firstController.signal })
      [Symbol.asyncIterator]();
    let pending = firstWatch.next();
    const runId = await sendThinkingMessage(fixture, threadId, 'controlled-thinking-input');
    const firstDeltas: NonNullable<ReturnType<typeof deltaDetails>>[] = [];
    while (firstDeltas.length < 3) {
      const item = await pending;
      if (item.done) throw new Error('The first WatchThread ended during Thinking deltas.');
      const delta = deltaDetails(item.value);
      if (delta) firstDeltas.push(delta);
      pending = firstWatch.next();
    }
    const firstMessageId = firstDeltas[0]?.messageId ?? '';
    expect(firstMessageId).not.toBe('');
    expect(firstDeltas).toEqual([
      {
        case: 'thinkingDelta',
        messageId: firstMessageId,
        deltaSeq: 1n,
        blockIndex: 0,
        text: 'Plan',
        runId,
      },
      {
        case: 'textDelta',
        messageId: firstMessageId,
        deltaSeq: 2n,
        blockIndex: 1,
        text: 'Before tool.',
      },
      {
        case: 'thinkingDelta',
        messageId: firstMessageId,
        deltaSeq: 3n,
        blockIndex: 2,
        text: 'Verify.',
        runId,
      },
    ]);

    firstController.abort();
    await pending.catch(() => undefined);
    await firstWatch.return?.();
    finishFirst.resolve();
    await vi.waitFor(() => expect(sse.requests).toHaveLength(2));
    expect(
      fixture.environmentOperations.started.filter((operation) => operation.action.case === 'bash'),
    ).toEqual([
      {
        operationId: expect.any(String),
        tenantId: thinkingOwnerId,
        envId: 'env-1',
        bindingVersion: 1n,
        action: {
          case: 'bash',
          value: {
            command: `printf controlled-tool > ${marker}`,
            cwd: directory,
            timeoutSeconds: 10,
          },
        },
      },
    ]);

    const secondController = new AbortController();
    controllers.push(secondController);
    const secondWatch = fixture.clients.events
      .watchThread({ threadId, afterSeq: initialCursor }, { signal: secondController.signal })
      [Symbol.asyncIterator]();
    const firstReplay = await secondWatch.next();
    finishSecond.resolve();
    const reconnectedDeltas: NonNullable<ReturnType<typeof deltaDetails>>[] = [];
    const committed: WatchThreadResponse[] = [];
    let completed = false;
    let item = firstReplay;
    while (!completed) {
      if (item.done) throw new Error('The reconnected WatchThread ended before completion.');
      const delta = deltaDetails(item.value);
      if (delta) reconnectedDeltas.push(delta);
      if (
        item.value.payload.case === 'event' &&
        item.value.payload.value.payload.case === 'messageCommitted'
      ) {
        committed.push(item.value);
      }
      if (
        item.value.payload.case === 'event' &&
        item.value.payload.value.payload.case === 'runChanged' &&
        item.value.payload.value.payload.value.run?.runId === runId &&
        item.value.payload.value.payload.value.run.status === RunStatus.COMPLETED
      ) {
        completed = true;
      }
      if (!completed) item = await secondWatch.next();
    }
    await secondWatch.return?.();
    await waitThinkingRun(fixture, threadId, runId, RunStatus.COMPLETED);

    const secondMessageId = reconnectedDeltas[0]?.messageId ?? '';
    expect(secondMessageId).not.toBe(firstMessageId);
    expect(reconnectedDeltas).toEqual([
      {
        case: 'thinkingDelta',
        messageId: secondMessageId,
        deltaSeq: 1n,
        blockIndex: 0,
        text: 'Final reasoning.',
        runId,
      },
      {
        case: 'textDelta',
        messageId: secondMessageId,
        deltaSeq: 2n,
        blockIndex: 1,
        text: 'Final answer.',
      },
    ]);

    const committedAssistants = committed.flatMap((response) => {
      if (
        response.payload.case !== 'event' ||
        response.payload.value.payload.case !== 'messageCommitted'
      ) {
        return [];
      }
      const message = response.payload.value.payload.value.message;
      return message?.role === MessageRole.ASSISTANT ? [message] : [];
    });
    expect(committedAssistants.map((message) => message.messageId)).toEqual([
      firstMessageId,
      secondMessageId,
    ]);
    expect(committedAssistants[0]?.content).toBe('Before tool.');
    expect(committedAssistants[0]?.content).not.toContain('Plan');
    expect(committedAssistants[0]?.content).not.toContain('Verify.');
    expect(committedAssistants[0]?.contentBlocks).toMatchObject([
      { type: ContentBlockType.THINKING, blockIndex: 0, text: 'Plan' },
      { type: ContentBlockType.TEXT, blockIndex: 1, text: 'Before tool.' },
      { type: ContentBlockType.THINKING, blockIndex: 2, text: 'Verify.' },
    ]);
    expect(committedAssistants[0]?.toolCalls).toMatchObject([
      { toolCallId: 'controlled-bash-call', blockIndex: 3 },
    ]);
    expect(committedAssistants[1]?.content).toBe('Final answer.');
    expect(committedAssistants[1]?.contentBlocks).toMatchObject([
      { type: ContentBlockType.THINKING, blockIndex: 0, text: 'Final reasoning.' },
      { type: ContentBlockType.TEXT, blockIndex: 1, text: 'Final answer.' },
    ]);

    const storedAssistants = storedAssistantsSchema.parse(
      fixture.database
        .prepare(
          "SELECT message_id, content, content_blocks_json, tool_calls_json FROM context_messages WHERE thread_id = ? AND role = 'assistant' ORDER BY seq",
        )
        .all(threadId),
    );
    expect(storedAssistants).toHaveLength(2);
    expect(JSON.parse(storedAssistants[0]?.content_blocks_json ?? 'null')).toEqual([
      { type: 'thinking', block_index: 0, text: 'Plan' },
      { type: 'text', block_index: 1, text: 'Before tool.' },
      { type: 'thinking', block_index: 2, text: 'Verify.' },
    ]);
    expect(JSON.parse(storedAssistants[0]?.tool_calls_json ?? 'null')).toMatchObject([
      { id: 'controlled-bash-call', block_index: 3 },
    ]);
    expect(JSON.parse(storedAssistants[1]?.content_blocks_json ?? 'null')).toEqual([
      { type: 'thinking', block_index: 0, text: 'Final reasoning.' },
      { type: 'text', block_index: 1, text: 'Final answer.' },
    ]);
    expect(storedAssistants[1]?.tool_calls_json).toBeNull();
    const previousAssistant = sse.requests[1]?.messages.find(
      (message) => message.role === 'assistant',
    );
    expect(previousAssistant?.content).toBe('Before tool.');
    expect(JSON.stringify(sse.requests[1]?.messages)).not.toContain('Plan');
    expect(JSON.stringify(sse.requests[1]?.messages)).not.toContain('Verify.');

    const snapshotPages = await readSnapshotPages(fixture, threadId);
    expect(snapshotPages.length).toBeGreaterThan(4);
    const pagedMessages = snapshotPages.flatMap((page) => page.snapshot?.messages ?? []);
    expect(new Set(pagedMessages.map((message) => message.messageId)).size).toBe(
      pagedMessages.length,
    );
    const contextMessages = await readContextPages(fixture, threadId);
    expect(contextMessages.map((message) => message.messageId)).toEqual(
      pagedMessages.map((message) => message.messageId),
    );
    for (const committedAssistant of committedAssistants) {
      const paged = pagedMessages.find(
        (message) => message.messageId === committedAssistant.messageId,
      );
      const context = contextMessages.find(
        (message) => message.messageId === committedAssistant.messageId,
      );
      expect(paged?.contentBlocks).toEqual(committedAssistant.contentBlocks);
      expect(context?.contentBlocks).toEqual(committedAssistant.contentBlocks);
      expect(context?.content).toBe(committedAssistant.content);
    }

    fixture.database
      .prepare('DELETE FROM thread_events WHERE thread_id = ? AND seq = 1')
      .run(threadId);
    fixture.database
      .prepare('UPDATE thread_event_retention SET first_available_seq = 2 WHERE thread_id = ?')
      .run(threadId);
    const expired = fixture.clients.events
      .watchThread({ threadId, afterSeq: 0n })
      [Symbol.asyncIterator]();
    await expect(expired.next()).rejects.toMatchObject({ code: Code.OutOfRange });
    const fresh = await fixture.clients.thread.getThread({ threadId });
    const recovered: WatchIterator = fixture.clients.events
      .watchThread({ threadId, afterSeq: fresh.throughSeq - 1n })
      [Symbol.asyncIterator]();
    const last = await recovered.next();
    expect(last.value?.payload.case).toBe('event');
    if (last.value?.payload.case === 'event') {
      expect(last.value.payload.value.seq).toBe(fresh.throughSeq);
    }
    await recovered.return?.();
  } finally {
    finishFirst.resolve();
    finishSecond.resolve();
    for (const controller of controllers) controller.abort();
    await closeThinkingFixture(fixture);
    await sse.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('does not persist or replay a completed Thinking block after an interrupted SSE stream', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-thinking-interrupted-'));
  const sse = new ControlledSseServer([
    [{ data: chunk({ reasoning_content: 'Unfinished reasoning' }) }, { end: true }],
  ]);
  await sse.listen();
  const provider = new OpenAICompatibleProvider({
    baseUrl: sse.baseUrl,
    model: 'controlled-thinking-model',
    contextWindow: 128_000,
    outputReserve: 4096,
  });
  const fixture = await startThinkingFixture(directory, { provider });
  const controller = new AbortController();
  try {
    const threadId = await createThinkingThread(fixture, 'interrupted-thinking-thread');
    const initialCursor = (await fixture.clients.thread.getThread({ threadId })).throughSeq;
    const watch = fixture.clients.events
      .watchThread({ threadId, afterSeq: initialCursor }, { signal: controller.signal })
      [Symbol.asyncIterator]();
    const runId = await sendThinkingMessage(fixture, threadId, 'interrupted-thinking-input');
    let streamingMessageId = '';
    let interrupted = false;
    let fabricatedCommit = false;
    while (!interrupted) {
      const item = await watch.next();
      if (item.done) throw new Error('WatchThread ended before the interrupted Run event.');
      const delta = deltaDetails(item.value);
      if (delta?.case === 'thinkingDelta') streamingMessageId = delta.messageId;
      if (
        item.value.payload.case === 'event' &&
        item.value.payload.value.payload.case === 'messageCommitted' &&
        item.value.payload.value.payload.value.message?.messageId === streamingMessageId
      ) {
        fabricatedCommit = true;
      }
      if (
        item.value.payload.case === 'event' &&
        item.value.payload.value.payload.case === 'runChanged' &&
        item.value.payload.value.payload.value.run?.runId === runId &&
        item.value.payload.value.payload.value.run.status === RunStatus.INTERRUPTED
      ) {
        interrupted = true;
      }
    }
    await watch.return?.();
    expect(streamingMessageId).not.toBe('');
    expect(fabricatedCommit).toBe(false);
    const assistants = fixture.database
      .prepare("SELECT message_id FROM context_messages WHERE thread_id = ? AND role = 'assistant'")
      .all(threadId);
    expect(assistants).toEqual([]);

    const replay = fixture.clients.events
      .watchThread({ threadId, afterSeq: initialCursor })
      [Symbol.asyncIterator]();
    let replayedDelta = false;
    let replayedTerminal = false;
    while (!replayedTerminal) {
      const item = await replay.next();
      if (item.done) throw new Error('Replay ended before the interrupted Run event.');
      if (deltaDetails(item.value)) replayedDelta = true;
      if (
        item.value.payload.case === 'event' &&
        item.value.payload.value.payload.case === 'runChanged' &&
        item.value.payload.value.payload.value.run?.status === RunStatus.INTERRUPTED
      ) {
        replayedTerminal = true;
      }
    }
    await replay.return?.();
    expect(replayedDelta).toBe(false);
    const snapshot = await fixture.clients.thread.getThread({ threadId });
    expect(
      snapshot.snapshot?.messages.some((message) => message.role === MessageRole.ASSISTANT),
    ).toBe(false);
  } finally {
    controller.abort();
    await closeThinkingFixture(fixture);
    await sse.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('stops before tool execution when a streamed Thinking response cannot be persisted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-thinking-persistence-'));
  const marker = join(directory, 'must-not-execute.txt');
  const sse = new ControlledSseServer([
    [
      { data: chunk({ reasoning_content: 'Unsaved reasoning' }) },
      { data: chunk({ content: 'Execute.' }) },
      {
        data: chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: 'unsaved-bash-call',
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({ command: `printf executed > ${marker}` }),
                },
              },
            ],
          },
          'tool_calls',
        ),
      },
      { data: usageChunk() },
      { data: '[DONE]' },
    ],
  ]);
  await sse.listen();
  const provider = new OpenAICompatibleProvider({
    baseUrl: sse.baseUrl,
    model: 'controlled-thinking-model',
    contextWindow: 128_000,
    outputReserve: 4096,
  });
  const fixture = await startThinkingFixture(directory, { provider });
  try {
    const threadId = await createThinkingThread(fixture, 'failed-thinking-persistence-thread');
    fixture.database.exec(`
      CREATE TRIGGER fail_thinking_assistant_event BEFORE INSERT ON thread_events
      WHEN NEW.payload_json LIKE '%"role":"assistant"%'
      BEGIN SELECT RAISE(FAIL, 'injected Thinking assistant storage failure'); END;
    `);
    const runId = await sendThinkingMessage(fixture, threadId, 'failed-thinking-persistence-input');
    await waitThinkingRun(fixture, threadId, runId, RunStatus.FAILED);
    expect(
      fixture.environmentOperations.started.filter((operation) => operation.action.case === 'bash'),
    ).toEqual([]);
    expect(sse.requests).toHaveLength(1);
    expect(
      fixture.database
        .prepare(
          "SELECT message_id FROM context_messages WHERE thread_id = ? AND role = 'assistant'",
        )
        .all(threadId),
    ).toEqual([]);
    expect(
      fixture.database
        .prepare(
          'SELECT event_id FROM thread_events WHERE thread_id = ? AND payload_json LIKE \'%"role":"assistant"%\'',
        )
        .all(threadId),
    ).toEqual([]);
    const snapshot = await fixture.clients.thread.getThread({ threadId });
    expect(
      snapshot.snapshot?.messages.some((message) => message.role === MessageRole.ASSISTANT),
    ).toBe(false);
  } finally {
    await closeThinkingFixture(fixture);
    await sse.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
