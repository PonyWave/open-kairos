import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ModelRequest } from '@kairos/agent-core';
import { describe, expect, it } from 'vitest';
import { RecapStore } from '../recap/recap-store.js';
import { openDatabase } from '../storage/database.js';
import { ContextStore } from './context-store.js';
import type { PrepareModelInput, RecapGenerationInput } from './model-input-service.js';
import { ModelInputService } from './model-input-service.js';
import { stripMessageMeta } from './model-input.js';

function contentTokens(request: ModelRequest): number {
  return (
    request.messages.reduce(
      (total, message) => total + stripMessageMeta(message.content).length,
      0,
    ) + request.tools.reduce((total, tool) => total + tool.description.length, 0)
  );
}

function queuedTokens(...counts: number[]): (request: ModelRequest) => number {
  let index = 0;
  return () => counts[Math.min(index++, counts.length - 1)] ?? 0;
}

function requestInput(overrides: Partial<PrepareModelInput> = {}): PrepareModelInput {
  return {
    threadId: 'thread',
    agentId: 'thread',
    requestId: 'request',
    systemInstructions: ['1234567890'],
    tools: [{ name: 'bash', description: '12345', parameters: {} }],
    pendingMessages: [],
    contextWindowTokens: 1000,
    ...overrides,
  };
}

function generatedContent(input: RecapGenerationInput): { content: string } {
  return { content: `short-${input.sourceMessageSeqs.join('-')}` };
}

function appendUser(context: ContextStore, content: string, agentId = 'thread') {
  return context.append({
    threadId: 'thread',
    agentId,
    message: { role: 'user', content },
    createdAt: '2026-11-02T01:00:00.000Z',
  });
}

describe('ModelInputService thresholds and recovery', () => {
  it.each([
    { rawLength: 774, hardCut: false },
    { rawLength: 775, hardCut: false },
    { rawLength: 776, hardCut: true },
  ])(
    'applies the strict 80%% threshold for raw length $rawLength',
    async ({ rawLength, hardCut }) => {
      const database = openDatabase(':memory:');
      try {
        const context = new ContextStore(database);
        appendUser(context, 'x'.repeat(rawLength));
        const pending = appendUser(context, '1234567890');
        const generated: RecapGenerationInput[] = [];
        const service = new ModelInputService(database, {
          countTokens: contentTokens,
          generateRecap: async (input) => {
            generated.push(input);
            return generatedContent(input);
          },
        });
        const prepared = await service.prepare(requestInput({ pendingContextSeqs: [pending.seq] }));
        expect(prepared.hardCut).toBe(hardCut);
        expect(generated).toHaveLength(hardCut ? 1 : 0);
        if (hardCut) {
          expect(prepared.estimatedInputTokens).toBeLessThanOrEqual(800);
        } else {
          expect(prepared.estimatedInputTokens).toBe(rawLength + 25);
        }
        expect(prepared.request.messages[0]).toEqual({ role: 'system', content: '1234567890' });
        expect(prepared.request.tools[0]?.description).toBe('12345');
        expect(stripMessageMeta(String(prepared.request.messages.at(-1)?.content))).toBe(
          '1234567890',
        );
        if (hardCut) {
          expect(prepared.request.messages.map((message) => message.role)).toEqual([
            'system',
            'user',
            'user',
          ]);
          expect(prepared.contextMessageSeqs).toEqual([2]);
          expect(service.getState('thread', 'thread').readThroughSeq).toBe(1);
          expect(database.prepare('SELECT COUNT(*) AS count FROM context_events').get()).toEqual({
            count: 1,
          });
        } else {
          expect(prepared.contextMessageSeqs).toEqual([1, 2]);
          expect(service.getState('thread', 'thread').readThroughSeq).toBe(0);
          expect(database.prepare('SELECT COUNT(*) AS count FROM context_events').get()).toEqual({
            count: 0,
          });
        }
        expect(database.prepare('SELECT COUNT(*) AS count FROM context_messages').get()).toEqual({
          count: 2,
        });
        expect(service.getRequestRecord('request')).toMatchObject({
          agentId: 'thread',
          status: 'ready',
        });
      } finally {
        database.close();
      }
    },
  );

  it('uses exact integer arithmetic at the 80% boundary', async () => {
    const database = openDatabase(':memory:');
    const contextWindowTokens = 9_007_199_254_740_990;
    const exactThreshold = (contextWindowTokens / 5) * 4;
    try {
      const service = new ModelInputService(database, {
        countTokens: queuedTokens(exactThreshold, exactThreshold + 1),
      });
      const exact = await service.prepare(
        requestInput({
          requestId: 'exact-large',
          systemInstructions: [],
          tools: [],
          pendingMessages: [],
          contextWindowTokens,
        }),
      );
      expect(exact.hardCut).toBe(false);
      await expect(
        service.prepare(
          requestInput({
            requestId: 'above-large',
            systemInstructions: [],
            tools: [],
            pendingMessages: [],
            contextWindowTokens,
          }),
        ),
      ).rejects.toMatchObject({ code: 'hard_cut_over_limit' });
    } finally {
      database.close();
    }
  });

  it('keeps persisted pending input as raw text without selecting it as recap source', async () => {
    const database = openDatabase(':memory:');
    try {
      const context = new ContextStore(database);
      appendUser(context, 'history to replace');
      const pending = appendUser(context, 'new pending original');
      const generated: RecapGenerationInput[] = [];
      const service = new ModelInputService(database, {
        countTokens: queuedTokens(900, 100),
        generateRecap: async (input) => {
          generated.push(input);
          return generatedContent(input);
        },
      });
      const prepared = await service.prepare(
        requestInput({
          requestId: 'pending-request',
          pendingMessages: [],
          pendingContextSeqs: [pending.seq],
        }),
      );
      expect(generated.map((input) => input.sourceMessageSeqs)).toEqual([[1]]);
      expect(prepared.readThroughSeq).toBe(1);
      expect(prepared.contextMessageSeqs).toEqual([2]);
      expect(prepared.request.messages.map((message) => message.role)).toEqual([
        'system',
        'user',
        'user',
      ]);
      expect(prepared.request.messages[1]?.content).not.toContain('new pending original');
      expect(stripMessageMeta(String(prepared.request.messages.at(-1)?.content))).toBe(
        'new pending original',
      );
      expect(service.getRequestRecord('pending-request')?.contextMessageSeqs).toEqual([2]);
      expect(database.prepare('SELECT payload_json FROM context_events').get()).toEqual({
        payload_json: expect.stringContaining('"replaced_source_seqs":[1]'),
      });
    } finally {
      database.close();
    }
  });

  it('rejects non-suffix pending and preserves a valid pending suffix on later requests', async () => {
    const database = openDatabase(':memory:');
    try {
      const context = new ContextStore(database);
      appendUser(context, 'history');
      appendUser(context, 'pending original');
      appendUser(context, 'later raw');
      const generated: RecapGenerationInput[] = [];
      const service = new ModelInputService(database, {
        countTokens: queuedTokens(900, 100),
        generateRecap: async (input) => {
          generated.push(input);
          return generatedContent(input);
        },
      });
      await expect(
        service.prepare(
          requestInput({
            requestId: 'non-suffix-pending',
            pendingMessages: [],
            pendingContextSeqs: [2],
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(service.getState('thread', 'thread').readThroughSeq).toBe(0);
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 0 });
      expect(generated).toHaveLength(0);

      const first = await service.prepare(
        requestInput({
          requestId: 'suffix-first',
          pendingMessages: [],
          pendingContextSeqs: [2, 3],
        }),
      );
      expect(first.readThroughSeq).toBe(1);
      expect(first.contextMessageSeqs).toEqual([2, 3]);
      expect(generated.map((input) => input.sourceMessageSeqs)).toEqual([[1]]);
      expect(
        first.request.messages.filter(
          (message) => stripMessageMeta(String(message.content)) === 'pending original',
        ),
      ).toHaveLength(1);
      expect(
        first.request.messages.filter(
          (message) => stripMessageMeta(String(message.content)) === 'later raw',
        ),
      ).toHaveLength(1);

      const second = await service.prepare(
        requestInput({
          requestId: 'suffix-second',
          pendingMessages: [],
          pendingContextSeqs: [2, 3],
        }),
      );
      expect(second.hardCut).toBe(false);
      expect(second.readThroughSeq).toBe(1);
      expect(second.contextMessageSeqs).toEqual([2, 3]);
      expect(
        second.request.messages.filter(
          (message) => stripMessageMeta(String(message.content)) === 'pending original',
        ),
      ).toHaveLength(1);
      expect(
        second.request.messages.filter(
          (message) => stripMessageMeta(String(message.content)) === 'later raw',
        ),
      ).toHaveLength(1);
      expect(generated).toHaveLength(1);
      expect(database.prepare('SELECT source_message_seqs FROM recaps').all()).toEqual([
        { source_message_seqs: '[1]' },
      ]);
    } finally {
      database.close();
    }
  });

  it('rejects unordered pending suffixes before hard-cut and ordinary request preparation', async () => {
    const database = openDatabase(':memory:');
    let tokenCalls = 0;
    try {
      const context = new ContextStore(database);
      appendUser(context, 'history');
      appendUser(context, 'pending original');
      appendUser(context, 'later raw');
      const generated: RecapGenerationInput[] = [];
      const service = new ModelInputService(database, {
        countTokens: () => {
          tokenCalls += 1;
          return tokenCalls === 1 ? 900 : 100;
        },
        generateRecap: async (input) => {
          generated.push(input);
          return generatedContent(input);
        },
      });
      await expect(
        service.prepare(
          requestInput({
            requestId: 'unordered-hard-cut',
            pendingMessages: [],
            pendingContextSeqs: [3, 2],
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(tokenCalls).toBe(0);
      expect(generated).toHaveLength(0);
      expect(service.getState('thread', 'thread').readThroughSeq).toBe(0);
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 0 });

      const first = await service.prepare(
        requestInput({
          requestId: 'ordered-hard-cut',
          pendingMessages: [],
          pendingContextSeqs: [2, 3],
        }),
      );
      expect(first.readThroughSeq).toBe(1);
      expect(tokenCalls).toBe(2);
      await expect(
        service.prepare(
          requestInput({
            requestId: 'unordered-normal',
            pendingMessages: [],
            pendingContextSeqs: [3, 2],
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(tokenCalls).toBe(2);
      expect(service.getState('thread', 'thread')).toMatchObject({
        readThroughSeq: 1,
        lastRequestId: 'ordered-hard-cut',
        selectedRecapIds: first.selectedRecapIds,
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM recaps').get()).toEqual({ count: 1 });
      expect(service.getRequestRecord('unordered-normal')).toMatchObject({
        status: 'failed',
        errorCode: 'invalid_request',
      });

      const ordinary = await service.prepare(
        requestInput({
          requestId: 'ordered-normal',
          pendingMessages: [],
          pendingContextSeqs: [2, 3],
        }),
      );
      expect(ordinary.contextMessageSeqs).toEqual([2, 3]);
      const contents = ordinary.request.messages.map((message) =>
        stripMessageMeta(String(message.content)),
      );
      expect(contents.indexOf('pending original')).toBeLessThan(contents.indexOf('later raw'));
      expect(generated).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('keeps tool calls and results together and excludes another Agent from coverage', async () => {
    const database = openDatabase(':memory:');
    try {
      const context = new ContextStore(database);
      const recaps = new RecapStore(database);
      context.append({
        threadId: 'thread',
        agentId: 'thread',
        message: {
          role: 'assistant',
          content: 'call',
          tool_calls: [{ id: 'call', name: 'bash', arguments: { command: 'test' } }],
        },
      });
      appendUser(context, 'between');
      context.append({
        threadId: 'thread',
        agentId: 'thread',
        message: { role: 'tool', content: 'result', tool_call_id: 'call', tool_name: 'bash' },
      });
      const other = appendUser(context, 'other-agent-secret', 'other');
      const otherRecap = recaps.save({
        recapId: 'other-recap',
        threadId: 'thread',
        agentId: 'other',
        sourceMessageSeqs: [other.seq],
        content: 'other-agent-secret',
      });
      const generated: RecapGenerationInput[] = [];
      const service = new ModelInputService(database, {
        countTokens: queuedTokens(900, 100),
        generateRecap: async (input) => {
          generated.push(input);
          return generatedContent(input);
        },
      });
      const prepared = await service.prepare(requestInput());
      expect(generated.map((input) => input.sourceMessageSeqs)).toEqual([[1, 3], [2]]);
      expect(prepared.selectedRecapIds).not.toContain(otherRecap.recapId);
      expect(prepared.request.messages[1]?.content).not.toContain('other-agent-secret');
      expect(prepared.request.messages[1]?.content.indexOf('short-1-3')).toBeLessThan(
        prepared.request.messages[1]?.content.indexOf('short-2') ?? 0,
      );
      const event = database.prepare('SELECT payload_json FROM context_events').get();
      expect(event).toEqual({
        payload_json: expect.stringContaining('"replaced_source_seqs":[1,2,3]'),
      });
      expect(service.getState('thread', 'thread').selectedRecapIds).toEqual(
        prepared.selectedRecapIds,
      );
      expect(database.prepare('SELECT COUNT(*) AS count FROM context_messages').get()).toEqual({
        count: 4,
      });
    } finally {
      database.close();
    }
  });

  it('reuses prior recaps across reopen and multiple hard cuts, then repairs an invalid source', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kairos-hard-cut-'));
    const path = join(directory, 'state.sqlite');
    let database: DatabaseSync | undefined;
    try {
      database = openDatabase(path);
      let context = new ContextStore(database);
      appendUser(context, 'first original');
      const firstGenerated: RecapGenerationInput[] = [];
      const first = new ModelInputService(database, {
        countTokens: queuedTokens(900, 100),
        generateRecap: async (input) => {
          firstGenerated.push(input);
          return generatedContent(input);
        },
      });
      const firstResult = await first.prepare(requestInput({ requestId: 'first' }));
      expect(firstResult.hardCut).toBe(true);
      expect(firstGenerated.map((input) => input.sourceMessageSeqs)).toEqual([[1]]);
      const firstRecapId = firstResult.selectedRecapIds[0];
      database.close();

      database = openDatabase(path);
      context = new ContextStore(database);
      const secondRaw = 'x'.repeat(1000);
      appendUser(context, secondRaw);
      const secondGenerated: RecapGenerationInput[] = [];
      const secondRequests: ModelRequest[] = [];
      const second = new ModelInputService(database, {
        countTokens: (request) => {
          secondRequests.push(request);
          return contentTokens(request);
        },
        generateRecap: async (input) => {
          secondGenerated.push(input);
          return generatedContent(input);
        },
      });
      const secondResult = await second.prepare(requestInput({ requestId: 'second' }));
      expect(secondRequests).toHaveLength(2);
      expect(secondRequests[0]?.messages[1]?.content).toContain('short-1');
      expect(
        secondRequests[0]?.messages.some(
          (message) => stripMessageMeta(String(message.content)) === secondRaw,
        ),
      ).toBe(true);
      expect(secondGenerated.map((input) => input.sourceMessageSeqs)).toEqual([[2]]);
      expect(secondResult.selectedRecapIds).toEqual([
        firstRecapId,
        secondResult.selectedRecapIds[1],
      ]);
      expect(secondResult.request.messages.map((message) => message.role)).toEqual([
        'system',
        'user',
      ]);
      database.close();

      database = openDatabase(path);
      const recovered = new ModelInputService(database, { countTokens: () => 100 });
      const recoveredResult = await recovered.prepare(requestInput({ requestId: 'recovered' }));
      expect(recoveredResult.hardCut).toBe(false);
      expect(recoveredResult.contextMessageSeqs).toEqual([]);
      expect(recoveredResult.request.messages.map((message) => message.role)).toEqual([
        'system',
        'user',
      ]);
      expect(recoveredResult.request.messages[1]?.content).toContain('short-1');
      expect(recoveredResult.request.messages[1]?.content).toContain('short-2');
      expect(recoveredResult.request.messages[1]?.content).not.toContain('first original');
      expect(recoveredResult.request.messages[1]?.content).not.toContain(secondRaw);
      expect(recoveredResult.selectedRecapIds).toHaveLength(2);

      context = new ContextStore(database);
      context.revise({
        threadId: 'thread',
        agentId: 'thread',
        seq: 1,
        content: 'first revised',
      });
      const repairedGenerated: RecapGenerationInput[] = [];
      const repaired = new ModelInputService(database, {
        countTokens: () => 100,
        generateRecap: async (input) => {
          repairedGenerated.push(input);
          return generatedContent(input);
        },
      });
      const repairedResult = await repaired.prepare(requestInput({ requestId: 'repaired' }));
      expect(repairedGenerated.map((input) => input.sourceMessageSeqs)).toEqual([[1]]);
      expect(repairedResult.selectedRecapIds).not.toContain(firstRecapId);
      expect(repairedResult.selectedRecapIds).toContain(secondResult.selectedRecapIds[1]);
      expect(repairedResult.contextMessageSeqs).toEqual([]);
      expect(repairedResult.request.messages.map((message) => message.role)).toEqual([
        'system',
        'user',
      ]);
      expect(repairedResult.request.messages[1]?.content).not.toContain('first original');
      expect(repairedResult.readThroughSeq).toBe(2);
      expect(database.prepare('SELECT COUNT(*) AS count FROM context_messages').get()).toEqual({
        count: 2,
      });
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM context_message_revisions').get(),
      ).toEqual({ count: 1 });
    } finally {
      if (database?.isOpen) database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a prepared request above the 16 MiB byte budget', async () => {
    const database = openDatabase(':memory:');
    try {
      const service = new ModelInputService(database, { countTokens: () => 100 });
      await expect(
        service.prepare(requestInput({ systemInstructions: ['x'.repeat(16 * 1024 * 1024)] })),
      ).rejects.toMatchObject({ code: 'hard_cut_over_limit' });
    } finally {
      database.close();
    }
  });
});
