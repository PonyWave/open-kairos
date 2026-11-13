import { describe, expect, it } from 'vitest';
import { openDatabase } from '../storage/database.js';
import { ContextStore } from './context-store.js';
import { stripMessageMeta } from './model-input.js';
import type { PrepareModelInput } from './model-input-service.js';
import { ModelInputService } from './model-input-service.js';

function input(overrides: Partial<PrepareModelInput> = {}): PrepareModelInput {
  return {
    threadId: 'thread',
    agentId: 'thread',
    requestId: 'request',
    systemInstructions: ['system'],
    tools: [],
    pendingMessages: [{ role: 'user', content: 'pending once' }],
    contextWindowTokens: 1000,
    ...overrides,
  };
}

function expectSinglePendingRequest(database: ReturnType<typeof openDatabase>): void {
  expect(
    database.prepare('SELECT seq, role, content FROM context_messages ORDER BY seq').all(),
  ).toEqual([{ seq: 1, role: 'user', content: 'pending once' }]);
  expect(
    database
      .prepare(
        `SELECT request_id, status, context_message_seqs_json, pending_context_seqs_json,
         hard_cut, request_fingerprint FROM model_request_records`,
      )
      .get(),
  ).toEqual({
    request_id: 'request',
    status: 'ready',
    context_message_seqs_json: '[1]',
    pending_context_seqs_json: '[1]',
    hard_cut: 0,
    request_fingerprint: expect.any(String),
  });
}

describe('ModelInputService requestId deduplication', () => {
  it('returns the complete saved request without appending or counting again', async () => {
    const database = openDatabase(':memory:');
    let tokenCalls = 0;
    try {
      const service = new ModelInputService(database, {
        countTokens: () => {
          tokenCalls += 1;
          return 100;
        },
      });
      const first = await service.prepare(input());
      const second = await service.prepare(input());
      expect(second).toEqual(first);
      expect(tokenCalls).toBe(1);
      expectSinglePendingRequest(database);
    } finally {
      database.close();
    }
  });

  it('rejects different parameters before changing Context or the saved request', async () => {
    const database = openDatabase(':memory:');
    let tokenCalls = 0;
    try {
      const service = new ModelInputService(database, {
        countTokens: () => {
          tokenCalls += 1;
          return 100;
        },
      });
      const first = await service.prepare(input());
      const saved = database.prepare('SELECT * FROM model_request_records').get();
      await expect(
        service.prepare(input({ pendingMessages: [{ role: 'user', content: 'different' }] })),
      ).rejects.toMatchObject({ code: 'request_conflict' });
      expect(tokenCalls).toBe(1);
      expectSinglePendingRequest(database);
      expect(database.prepare('SELECT * FROM model_request_records').get()).toEqual(saved);
      expect(service.getRequestRecord('request')?.request).toEqual(first.request);
    } finally {
      database.close();
    }
  });

  it('resumes a failed preparation with the persisted pending input', async () => {
    const database = openDatabase(':memory:');
    let tokenCalls = 0;
    try {
      const service = new ModelInputService(database, {
        countTokens: () => {
          tokenCalls += 1;
          if (tokenCalls === 1) throw new Error('injected token failure');
          return 100;
        },
      });
      await expect(service.prepare(input())).rejects.toMatchObject({ code: 'token_count_failed' });
      expect(database.prepare('SELECT COUNT(*) AS count FROM context_messages').get()).toEqual({
        count: 1,
      });
      expect(service.getRequestRecord('request')).toMatchObject({
        status: 'failed',
        errorCode: 'token_count_failed',
      });

      const recovered = await service.prepare(input());
      expect(recovered.contextMessageSeqs).toEqual([1]);
      expect(stripMessageMeta(String(recovered.request.messages.at(-1)?.content))).toBe(
        'pending once',
      );
      expect(tokenCalls).toBe(2);
      expectSinglePendingRequest(database);
      expect(service.getRequestRecord('request')).toMatchObject({
        status: 'ready',
        errorCode: null,
        errorMessage: null,
      });
    } finally {
      database.close();
    }
  });

  it('rebuilds a saved request when the current view version changes', async () => {
    const database = openDatabase(':memory:');
    let tokenCalls = 0;
    try {
      const context = new ContextStore(database);
      const service = new ModelInputService(database, {
        countTokens: () => {
          tokenCalls += 1;
          return 100;
        },
      });
      const first = await service.prepare(input());
      context.revise({
        threadId: 'thread',
        agentId: 'thread',
        seq: 1,
        content: 'current revision',
      });
      database.prepare('UPDATE model_input_states SET view_version = view_version + 1').run();
      const rebuilt = await service.prepare(input());
      expect(rebuilt.requestId).toBe(first.requestId);
      expect(rebuilt.request.messages.at(-1)?.role).toBe('user');
      expect(stripMessageMeta(String(rebuilt.request.messages.at(-1)?.content))).toBe(
        'current revision',
      );
      expect(rebuilt.request).not.toEqual(first.request);
      expect(tokenCalls).toBe(2);
      expect(service.getRequestRecord('request')?.viewVersion).toBe(1);
    } finally {
      database.close();
    }
  });

  it('restores the complete hard-cut result without generating another recap', async () => {
    const database = openDatabase(':memory:');
    let tokenCalls = 0;
    let generationCalls = 0;
    try {
      new ContextStore(database).append({
        threadId: 'thread',
        agentId: 'thread',
        message: { role: 'user', content: 'raw history' },
      });
      const service = new ModelInputService(database, {
        countTokens: () => {
          tokenCalls += 1;
          return tokenCalls === 1 ? 900 : 100;
        },
        generateRecap: async () => {
          generationCalls += 1;
          return { content: 'summary' };
        },
      });
      const first = await service.prepare(input());
      expect(first.hardCut).toBe(true);
      const second = await service.prepare(input());
      expect(second).toEqual(first);
      expect(tokenCalls).toBe(2);
      expect(generationCalls).toBe(1);
      expect(database.prepare('SELECT COUNT(*) AS count FROM context_messages').get()).toEqual({
        count: 2,
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 1 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM context_events').get()).toEqual({
        count: 1,
      });
      expect(
        database
          .prepare(
            `SELECT context_message_seqs_json, pending_context_seqs_json, hard_cut
             FROM model_request_records`,
          )
          .get(),
      ).toEqual({
        context_message_seqs_json: '[2]',
        pending_context_seqs_json: '[2]',
        hard_cut: 1,
      });
    } finally {
      database.close();
    }
  });
});
