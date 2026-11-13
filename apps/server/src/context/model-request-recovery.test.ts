import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase } from '../storage/database.js';
import { ContextStore } from './context-store.js';
import type { PrepareModelInput } from './model-input-service.js';
import { ModelInputService } from './model-input-service.js';
import { stripMessageMeta } from './model-input.js';

it('persists pending inputs and restores each complete model request after reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-request-recovery-'));
  const path = join(directory, 'requests.sqlite');
  let database = openDatabase(path);
  try {
    const service = new ModelInputService(database, { countTokens: () => 100 });
    const first = await service.prepare({
      threadId: 'thread',
      agentId: 'thread',
      requestId: 'request-one',
      systemInstructions: ['system one'],
      tools: [{ name: 'first-tool', description: 'first', parameters: { type: 'object' } }],
      pendingMessages: [{ role: 'user', content: 'first pending' }],
      contextWindowTokens: 1000,
    });
    expect(first.contextMessageSeqs).toEqual([1]);
    const second = await service.prepare({
      threadId: 'thread',
      agentId: 'thread',
      requestId: 'request-two',
      systemInstructions: ['system two'],
      tools: [{ name: 'second-tool', description: 'second', parameters: { type: 'object' } }],
      pendingMessages: [{ role: 'user', content: 'second pending' }],
      contextWindowTokens: 1000,
    });
    expect(second.contextMessageSeqs).toEqual([1, 2]);
    expect(service.getRequestRecord('request-one')?.request).toEqual(first.request);
    expect(service.getRequestRecord('request-two')?.request).toEqual(second.request);
    database.close();

    database = openDatabase(path);
    let restoredTokenCalls = 0;
    const restored = new ModelInputService(database, {
      countTokens: () => {
        restoredTokenCalls += 1;
        return 100;
      },
    });
    expect(restored.getRequestRecord('request-one')?.request).toEqual(first.request);
    expect(restored.getRequestRecord('request-two')?.request).toEqual(second.request);
    const replayed = await restored.prepare({
      threadId: 'thread',
      agentId: 'thread',
      requestId: 'request-one',
      systemInstructions: ['system one'],
      tools: [{ name: 'first-tool', description: 'first', parameters: { type: 'object' } }],
      pendingMessages: [{ role: 'user', content: 'first pending' }],
      contextWindowTokens: 1000,
    });
    expect(replayed).toEqual(first);
    expect(restoredTokenCalls).toBe(0);
    const context = new ContextStore(database).query({ threadId: 'thread', agentId: 'thread' });
    expect(context.map((record) => [record.seq, record.message.content])).toEqual([
      [1, 'first pending'],
      [2, 'second pending'],
    ]);
    expect(
      database
        .prepare(
          `SELECT request_id, status, context_message_seqs_json, pending_context_seqs_json
           FROM model_request_records WHERE request_id = 'request-one'`,
        )
        .get(),
    ).toEqual({
      request_id: 'request-one',
      status: 'ready',
      context_message_seqs_json: '[1]',
      pending_context_seqs_json: '[1]',
    });
  } finally {
    if (database.isOpen) database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('does not count or ready a request when pending input cannot be persisted', async () => {
  const database = openDatabase(':memory:');
  let tokenCalls = 0;
  try {
    database.exec(`
      CREATE TRIGGER reject_pending BEFORE INSERT ON context_messages
      BEGIN SELECT RAISE(ABORT, 'injected pending persistence failure'); END;
    `);
    const service = new ModelInputService(database, {
      countTokens: () => {
        tokenCalls += 1;
        return 100;
      },
    });
    await expect(
      service.prepare({
        threadId: 'thread',
        agentId: 'thread',
        requestId: 'unpersisted',
        systemInstructions: [],
        tools: [],
        pendingMessages: [{ role: 'user', content: 'not persisted' }],
        contextWindowTokens: 1000,
      }),
    ).rejects.toMatchObject({ code: 'storage_failed' });
    expect(tokenCalls).toBe(0);
    expect(database.prepare('SELECT COUNT(*) AS count FROM context_messages').get()).toEqual({
      count: 0,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM model_request_records').get()).toEqual({
      count: 0,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM model_input_states').get()).toEqual({
      count: 0,
    });
  } finally {
    database.close();
  }
});

it('rolls back pending input when the request placeholder cannot be persisted', async () => {
  const database = openDatabase(':memory:');
  let tokenCalls = 0;
  try {
    database.exec(`
      CREATE TRIGGER reject_request BEFORE INSERT ON model_request_records
      BEGIN SELECT RAISE(ABORT, 'injected request persistence failure'); END;
    `);
    const service = new ModelInputService(database, {
      countTokens: () => {
        tokenCalls += 1;
        return 100;
      },
    });
    await expect(
      service.prepare({
        threadId: 'thread',
        agentId: 'thread',
        requestId: 'unpersisted-request',
        systemInstructions: [],
        tools: [],
        pendingMessages: [{ role: 'user', content: 'not persisted' }],
        contextWindowTokens: 1000,
      }),
    ).rejects.toMatchObject({ code: 'storage_failed' });
    expect(tokenCalls).toBe(0);
    expect(database.prepare('SELECT COUNT(*) AS count FROM context_messages').get()).toEqual({
      count: 0,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM model_request_records').get()).toEqual({
      count: 0,
    });
  } finally {
    database.close();
  }
});

it('resumes an interrupted preparation after reopen without duplicating input', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-request-interrupted-'));
  const path = join(directory, 'requests.sqlite');
  let database = openDatabase(path);
  let countStarted = () => {};
  const started = new Promise<void>((resolve) => {
    countStarted = resolve;
  });
  let finishCount = (_value: number) => {};
  const counting = new Promise<number>((resolve) => {
    finishCount = resolve;
  });
  const request: PrepareModelInput = {
    threadId: 'thread',
    agentId: 'thread',
    requestId: 'interrupted-request',
    systemInstructions: ['system'],
    tools: [],
    pendingMessages: [{ role: 'user', content: 'pending once' }],
    contextWindowTokens: 1000,
  };
  try {
    const interrupted = new ModelInputService(database, {
      countTokens: async () => {
        countStarted();
        return counting;
      },
    });
    const pendingPreparation = interrupted.prepare(request);
    await started;
    expect(interrupted.getRequestRecord('interrupted-request')?.status).toBe('preparing');
    database.close();

    database = openDatabase(path);
    const recoveredService = new ModelInputService(database, { countTokens: () => 100 });
    const recovered = await recoveredService.prepare(request);
    expect(recovered.contextMessageSeqs).toEqual([1]);
    expect(stripMessageMeta(String(recovered.request.messages.at(-1)?.content))).toBe(
      'pending once',
    );
    finishCount(100);
    await expect(pendingPreparation).rejects.toMatchObject({ code: 'storage_failed' });
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
      request_id: 'interrupted-request',
      status: 'ready',
      context_message_seqs_json: '[1]',
      pending_context_seqs_json: '[1]',
    });
  } finally {
    if (database.isOpen) database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
