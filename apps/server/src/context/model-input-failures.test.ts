import type { ModelRequest } from '@kairos/agent-core';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../storage/database.js';
import { ContextStore } from './context-store.js';
import type { PrepareModelInput, RecapGenerationInput } from './model-input-service.js';
import { ModelInputService } from './model-input-service.js';

function input(overrides: Partial<PrepareModelInput> = {}): PrepareModelInput {
  return {
    threadId: 'thread',
    agentId: 'thread',
    requestId: 'request',
    systemInstructions: ['system'],
    tools: [],
    pendingMessages: [],
    contextWindowTokens: 1000,
    ...overrides,
  };
}

function queuedTokens(...counts: number[]): (request: ModelRequest) => number {
  let index = 0;
  return () => counts[Math.min(index++, counts.length - 1)] ?? 0;
}

function seedContext() {
  const database = openDatabase(':memory:');
  const context = new ContextStore(database);
  context.append({
    threadId: 'thread',
    agentId: 'thread',
    runId: 'run-internal',
    message: { role: 'user', content: 'original source' },
    createdAt: '2026-11-02T01:00:00.000Z',
  });
  return { database, context };
}

function expectUnchanged(database: ReturnType<typeof openDatabase>): void {
  expect(database.prepare('SELECT COUNT(*) AS count FROM context_messages').get()).toEqual({
    count: 1,
  });
  expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 0 });
  expect(database.prepare('SELECT COUNT(*) AS count FROM model_input_recaps').get()).toEqual({
    count: 0,
  });
  expect(database.prepare('SELECT COUNT(*) AS count FROM context_events').get()).toEqual({
    count: 0,
  });
  expect(database.prepare('SELECT COUNT(*) AS count FROM model_input_states').get()).toEqual({
    count: 0,
  });
}

describe('ModelInputService failure handling', () => {
  it('preserves state after recap generation fails and accepts later input without retrying', async () => {
    const { database, context } = seedContext();
    let generationCount = 0;
    try {
      const service = new ModelInputService(database, {
        countTokens: () => 900,
        generateRecap: async () => {
          generationCount += 1;
          throw new Error('injected generation failure');
        },
      });
      await expect(service.prepare(input())).rejects.toMatchObject({
        code: 'recap_generation_failed',
      });
      expectUnchanged(database);
      expect(service.getRequestRecord('request')).toMatchObject({
        status: 'failed',
        errorCode: 'recap_generation_failed',
        readThroughSeq: 0,
      });
      context.append({
        threadId: 'thread',
        agentId: 'thread',
        message: { role: 'user', content: 'queued while failed' },
      });
      expect(generationCount).toBe(1);
      expect(database.prepare('SELECT COUNT(*) AS count FROM context_messages').get()).toEqual({
        count: 2,
      });
    } finally {
      database.close();
    }
  });

  it('rechecks source revisions at commit while allowing new input to remain queued', async () => {
    const { database, context } = seedContext();
    let generationStarted = () => {};
    const started = new Promise<void>((resolve) => {
      generationStarted = resolve;
    });
    let finishGeneration = (_value: { content: string }) => {};
    const generated = new Promise<{ content: string }>((resolve) => {
      finishGeneration = resolve;
    });
    try {
      const service = new ModelInputService(database, {
        countTokens: queuedTokens(900, 100),
        generateRecap: async () => {
          generationStarted();
          return generated;
        },
      });
      const preparation = service.prepare(input());
      await started;
      context.revise({
        threadId: 'thread',
        agentId: 'thread',
        seq: 1,
        content: 'revised during generation',
      });
      context.append({
        threadId: 'thread',
        agentId: 'thread',
        message: { role: 'user', content: 'new queued input' },
      });
      finishGeneration({ content: 'stale summary' });
      await expect(preparation).rejects.toMatchObject({ code: 'source_changed' });
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 0 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM model_input_states').get()).toEqual({
        count: 0,
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM context_events').get()).toEqual({
        count: 0,
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM context_messages').get()).toEqual({
        count: 2,
      });
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM context_message_revisions').get(),
      ).toEqual({ count: 1 });
      expect(service.getRequestRecord('request')).toMatchObject({
        status: 'failed',
        errorCode: 'source_changed',
        readThroughSeq: 0,
      });
    } finally {
      database.close();
    }
  });

  it('rolls back generated recaps, state and events when the SQLite commit fails', async () => {
    const { database } = seedContext();
    try {
      database.exec(`
        CREATE TRIGGER reject_selection BEFORE INSERT ON model_input_recaps
        BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END;
      `);
      const service = new ModelInputService(database, {
        countTokens: queuedTokens(900, 100),
        generateRecap: async () => ({ content: 'summary' }),
      });
      await expect(service.prepare(input())).rejects.toMatchObject({ code: 'storage_failed' });
      expectUnchanged(database);
      expect(service.getRequestRecord('request')).toMatchObject({
        status: 'failed',
        errorCode: 'storage_failed',
        readThroughSeq: 0,
      });
    } finally {
      database.close();
    }
  });

  it('cancels generation without committing or retrying', async () => {
    const { database } = seedContext();
    let generationStarted = () => {};
    const started = new Promise<void>((resolve) => {
      generationStarted = resolve;
    });
    const controller = new AbortController();
    let generationCount = 0;
    try {
      const service = new ModelInputService(database, {
        countTokens: () => 900,
        generateRecap: async (_input, signal) => {
          generationCount += 1;
          generationStarted();
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      });
      const preparation = service.prepare(input({ signal: controller.signal }));
      await started;
      controller.abort(new DOMException('cancelled by test', 'AbortError'));
      await expect(preparation).rejects.toMatchObject({ code: 'cancelled' });
      expectUnchanged(database);
      expect(generationCount).toBe(1);
      expect(service.getRequestRecord('request')).toMatchObject({
        status: 'cancelled',
        errorCode: 'cancelled',
      });
    } finally {
      database.close();
    }
  });

  it('stops without a retry when the merged input remains over the limit', async () => {
    const { database } = seedContext();
    const generated: RecapGenerationInput[] = [];
    try {
      const service = new ModelInputService(database, {
        countTokens: () => 900,
        generateRecap: async (input) => {
          generated.push(input);
          return { content: 'still too large' };
        },
      });
      await expect(service.prepare(input())).rejects.toMatchObject({ code: 'hard_cut_over_limit' });
      expectUnchanged(database);
      expect(generated).toHaveLength(1);
      expect(service.getRequestRecord('request')).toMatchObject({
        status: 'failed',
        errorCode: 'hard_cut_over_limit',
        estimatedInputTokens: 900,
      });
    } finally {
      database.close();
    }
  });

  it('checks output reserve separately and rejects unfinished tool calls before generation', async () => {
    const { database, context } = seedContext();
    let generationCount = 0;
    try {
      const service = new ModelInputService(database, {
        countTokens: () => 800,
        generateRecap: async () => {
          generationCount += 1;
          return { content: 'summary' };
        },
      });
      await expect(service.prepare(input({ outputReserveTokens: 201 }))).rejects.toMatchObject({
        code: 'output_reserve_exceeded',
      });
      expectUnchanged(database);
      expect(generationCount).toBe(0);
      context.append({
        threadId: 'thread',
        agentId: 'thread',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'unfinished', name: 'bash', arguments: {} }],
        },
      });
      await expect(
        service.prepare(input({ requestId: 'unfinished-request' })),
      ).rejects.toMatchObject({
        code: 'unfinished_tool_round_trip',
      });
      expect(generationCount).toBe(0);
      expect(service.getRequestRecord('unfinished-request')?.errorCode).toBe(
        'unfinished_tool_round_trip',
      );
    } finally {
      database.close();
    }
  });
});
