import type { ModelRequest } from '@kairos/agent-core';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../storage/database.js';
import { ContextStore } from './context-store.js';
import type { PrepareModelInput } from './model-input-service.js';
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

function appendUser(context: ContextStore, content: string): void {
  context.append({
    threadId: 'thread',
    agentId: 'thread',
    message: { role: 'user', content },
  });
}

describe('ModelInputService cross-instance concurrency', () => {
  it('rejects a stale hard-cut commit without regressing state or duplicating recaps', async () => {
    const database = openDatabase(':memory:');
    let generationStarted = () => {};
    const started = new Promise<void>((resolve) => {
      generationStarted = resolve;
    });
    let finishGeneration = (_value: { content: string }) => {};
    const generated = new Promise<{ content: string }>((resolve) => {
      finishGeneration = resolve;
    });
    try {
      const context = new ContextStore(database);
      appendUser(context, 'first original');
      const older = new ModelInputService(database, {
        countTokens: queuedTokens(900, 100),
        generateRecap: async () => {
          generationStarted();
          return generated;
        },
      });
      const olderPreparation = older.prepare(input({ requestId: 'older' }));
      await started;
      appendUser(context, 'second original');
      const newer = new ModelInputService(database, {
        countTokens: queuedTokens(900, 100),
        generateRecap: async (generation) => ({
          content: `new-${generation.sourceMessageSeqs.join('-')}`,
        }),
      });
      const newerResult = await newer.prepare(input({ requestId: 'newer' }));
      expect(newerResult.readThroughSeq).toBe(2);
      finishGeneration({ content: 'stale' });
      await expect(olderPreparation).rejects.toMatchObject({ code: 'concurrent_modification' });

      expect(older.getRequestRecord('older')).toMatchObject({
        status: 'failed',
        errorCode: 'concurrent_modification',
      });
      expect(newer.getRequestRecord('newer')?.status).toBe('ready');
      expect(older.getState('thread', 'thread')).toMatchObject({
        readThroughSeq: 2,
        lastRequestId: 'newer',
        selectedRecapIds: newerResult.selectedRecapIds,
      });
      expect(
        database
          .prepare('SELECT source_message_seqs FROM recaps ORDER BY source_message_seqs')
          .all(),
      ).toEqual([{ source_message_seqs: '[1]' }, { source_message_seqs: '[2]' }]);
      expect(database.prepare('SELECT COUNT(*) AS count FROM context_events').get()).toEqual({
        count: 1,
      });

      const recovered = new ModelInputService(database, { countTokens: () => 100 });
      const next = await recovered.prepare(input({ requestId: 'next' }));
      expect(next.contextMessageSeqs).toEqual([]);
      expect(next.selectedRecapIds).toEqual(newerResult.selectedRecapIds);
      expect(next.request.messages.map((message) => message.content)).not.toContain(
        'first original',
      );
      expect(next.request.messages.map((message) => message.content)).not.toContain(
        'second original',
      );
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it('also rejects an older ordinary request after another instance updates the last request', async () => {
    const database = openDatabase(':memory:');
    let countStarted = () => {};
    const started = new Promise<void>((resolve) => {
      countStarted = resolve;
    });
    let finishCount = () => {};
    const counting = new Promise<void>((resolve) => {
      finishCount = resolve;
    });
    try {
      appendUser(new ContextStore(database), 'raw');
      const older = new ModelInputService(database, {
        countTokens: async () => {
          countStarted();
          await counting;
          return 100;
        },
      });
      const olderPreparation = older.prepare(input({ requestId: 'older-normal' }));
      await started;
      const newer = new ModelInputService(database, { countTokens: () => 100 });
      const newerResult = await newer.prepare(input({ requestId: 'newer-normal' }));
      expect(newerResult.hardCut).toBe(false);
      finishCount();
      await expect(olderPreparation).rejects.toMatchObject({ code: 'concurrent_modification' });
      expect(older.getState('thread', 'thread')).toMatchObject({
        readThroughSeq: 0,
        lastRequestId: 'newer-normal',
        selectedRecapIds: [],
      });
      expect(older.getRequestRecord('older-normal')).toMatchObject({
        status: 'failed',
        errorCode: 'concurrent_modification',
      });
      expect(newer.getRequestRecord('newer-normal')?.status).toBe('ready');
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('shares one pending input and saved result across concurrent instances', async () => {
    const database = openDatabase(':memory:');
    let countStarted = () => {};
    const started = new Promise<void>((resolve) => {
      countStarted = resolve;
    });
    let finishCount = () => {};
    const counting = new Promise<void>((resolve) => {
      finishCount = resolve;
    });
    const request = input({ pendingMessages: [{ role: 'user', content: 'pending once' }] });
    try {
      const older = new ModelInputService(database, {
        countTokens: async () => {
          countStarted();
          await counting;
          return 100;
        },
      });
      const olderPreparation = older.prepare(request);
      await started;

      const newer = new ModelInputService(database, { countTokens: () => 100 });
      const newerResult = await newer.prepare(request);
      finishCount();
      const olderResult = await olderPreparation;
      expect(olderResult).toEqual(newerResult);
      expect(
        database.prepare('SELECT seq, role, content FROM context_messages ORDER BY seq').all(),
      ).toEqual([{ seq: 1, role: 'user', content: 'pending once' }]);
      expect(
        database
          .prepare(
            `SELECT request_id, status, context_message_seqs_json, pending_context_seqs_json
             FROM model_request_records`,
          )
          .get(),
      ).toEqual({
        request_id: 'request',
        status: 'ready',
        context_message_seqs_json: '[1]',
        pending_context_seqs_json: '[1]',
      });
      expect(database.prepare('SELECT last_request_id FROM model_input_states').get()).toEqual({
        last_request_id: 'request',
      });
    } finally {
      database.close();
    }
  });
});
