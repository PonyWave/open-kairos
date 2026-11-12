import type { ModelMessage } from '@kairos/agent-core';
import { describe, expect, it } from 'vitest';
import { ContextStore } from '../context/context-store.js';
import { buildModelMessages } from '../context/model-input.js';
import { openDatabase } from '../storage/database.js';
import { RecapStore } from './recap-store.js';
import { mergeRecapText, selectRecapCoverage } from './selection.js';
import type { Recap } from './types.js';

function appendUser(store: ContextStore, content: string, createdAt: string) {
  return store.append({
    threadId: 'thread',
    agentId: 'thread',
    message: { role: 'user', content },
    createdAt,
  });
}

function recapFixture(
  recapId: string,
  sourceMessageSeqs: number[],
  validity: 'valid' | 'invalid' = 'valid',
): Recap {
  return {
    recapId,
    threadId: 'thread',
    agentId: 'thread',
    sourceSeqStart: sourceMessageSeqs[0] ?? 0,
    sourceSeqEnd: sourceMessageSeqs.at(-1) ?? 0,
    sourceMessageSeqs,
    sourceCreatedAtStart: '2026-11-02T01:00:00.000Z',
    sourceCreatedAtEnd: '2026-11-02T01:00:00.000Z',
    content: `content-${recapId}`,
    createdAt: '2026-11-02T01:00:00.000Z',
    validity,
    invalidatedAt: null,
    invalidationReason: null,
  };
}

describe('RecapStore', () => {
  it('stores non-contiguous sources and derives their time range by sequence', () => {
    const database = openDatabase(':memory:');
    try {
      const context = new ContextStore(database);
      const recaps = new RecapStore(database);
      const first = appendUser(context, 'first', '2026-11-02T01:00:00.000Z');
      appendUser(context, 'middle', '2026-11-02T01:00:00.000Z');
      const third = appendUser(context, 'third', '2026-11-02T01:00:00.000Z');
      const nonContiguous = recaps.save({
        recapId: 'non-contiguous',
        threadId: 'thread',
        agentId: 'thread',
        sourceMessageSeqs: [first.seq, third.seq],
        content: 'first and third',
      });
      recaps.save({
        recapId: 'middle',
        threadId: 'thread',
        agentId: 'thread',
        sourceMessageSeqs: [2],
        content: 'middle only',
      });
      expect(nonContiguous).toMatchObject({
        sourceSeqStart: 1,
        sourceSeqEnd: 3,
        sourceMessageSeqs: [1, 3],
        sourceCreatedAtStart: first.createdAt,
        sourceCreatedAtEnd: third.createdAt,
        validity: 'valid',
      });
      expect(
        database
          .prepare(
            "SELECT message_seq FROM recap_sources WHERE recap_id = 'non-contiguous' ORDER BY position",
          )
          .all(),
      ).toEqual([{ message_seq: 1 }, { message_seq: 3 }]);
      expect(
        recaps.query({ threadId: 'thread', agentId: 'thread', fromSeq: 2, toSeq: 2 }),
      ).toHaveLength(1);
      expect(
        recaps.query({ threadId: 'thread', agentId: 'thread', fromSeq: 3, toSeq: 3 })[0]?.recapId,
      ).toBe('non-contiguous');
      expect(
        recaps.query({ threadId: 'thread', agentId: 'thread', query: 'first and' })[0]?.recapId,
      ).toBe('non-contiguous');
      recaps.invalidate('thread', 'thread', 'non-contiguous', 'expired');
      expect(recaps.get('thread', 'thread', 'non-contiguous')?.validity).toBe('invalid');
      expect(
        recaps.query({ threadId: 'thread', agentId: 'thread', validity: 'valid' }),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('computes minimum and maximum source times independently of sequence order', () => {
    const database = openDatabase(':memory:');
    try {
      const context = new ContextStore(database);
      const recaps = new RecapStore(database);
      appendUser(context, 'late', '2026-11-02T02:00:00.000Z');
      appendUser(context, 'early', '2026-11-02T01:00:00.000Z');
      appendUser(context, 'also early', '2026-11-02T01:00:00.000Z');
      const recap = recaps.save({
        recapId: 'time-range',
        threadId: 'thread',
        agentId: 'thread',
        sourceMessageSeqs: [1, 2, 3],
        content: 'time range',
      });
      expect(recap).toMatchObject({
        sourceSeqStart: 1,
        sourceSeqEnd: 3,
        sourceCreatedAtStart: '2026-11-02T01:00:00.000Z',
        sourceCreatedAtEnd: '2026-11-02T02:00:00.000Z',
      });
      const sameTime = recaps.save({
        recapId: 'same-time',
        threadId: 'thread',
        agentId: 'thread',
        sourceMessageSeqs: [2, 3],
        content: 'same time',
      });
      expect(sameTime).toMatchObject({
        sourceSeqStart: 2,
        sourceSeqEnd: 3,
        sourceCreatedAtStart: '2026-11-02T01:00:00.000Z',
        sourceCreatedAtEnd: '2026-11-02T01:00:00.000Z',
      });
      expect(recaps.get('thread', 'thread', 'time-range')).toMatchObject({
        sourceCreatedAtStart: '2026-11-02T01:00:00.000Z',
        sourceCreatedAtEnd: '2026-11-02T02:00:00.000Z',
      });
    } finally {
      database.close();
    }
  });

  it('requires complete tool round trips and rolls back a failed batch', () => {
    const database = openDatabase(':memory:');
    try {
      const context = new ContextStore(database);
      const recaps = new RecapStore(database);
      const assistant = context.append({
        threadId: 'thread',
        agentId: 'thread',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call', name: 'bash', arguments: { command: 'test' } }],
        },
      });
      expect(() =>
        recaps.save({
          threadId: 'thread',
          agentId: 'thread',
          sourceMessageSeqs: [assistant.seq],
          content: 'partial',
        }),
      ).toThrowError(expect.objectContaining({ code: 'incomplete_tool_round_trip' }));
      const result = context.append({
        threadId: 'thread',
        agentId: 'thread',
        message: { role: 'tool', content: 'done', tool_call_id: 'call', tool_name: 'bash' },
      });
      const saved = recaps.save({
        recapId: 'complete',
        threadId: 'thread',
        agentId: 'thread',
        sourceMessageSeqs: [assistant.seq, result.seq],
        content: 'complete',
      });
      expect(saved.sourceMessageSeqs).toEqual([assistant.seq, result.seq]);
      expect(() =>
        recaps.saveMany([
          {
            recapId: 'new',
            threadId: 'thread',
            agentId: 'thread',
            sourceMessageSeqs: [result.seq, assistant.seq].sort((a, b) => a - b),
            content: 'new',
          },
          {
            recapId: 'complete',
            threadId: 'thread',
            agentId: 'thread',
            sourceMessageSeqs: [assistant.seq, result.seq],
            content: 'duplicate',
          },
        ]),
      ).toThrow();
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM recaps WHERE recap_id = 'new'").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});

describe('recap coverage and model input', () => {
  it('selects valid, non-overlapping coverage and reports missing groups', () => {
    const preferred = recapFixture('preferred', [1]);
    const overlap = recapFixture('overlap', [1, 2]);
    const second = recapFixture('second', [2]);
    const third = recapFixture('third', [3]);
    const invalid = recapFixture('invalid', [4], 'invalid');
    const selection = selectRecapCoverage(
      [
        { sourceMessageSeqs: [1] },
        { sourceMessageSeqs: [2] },
        { sourceMessageSeqs: [3] },
        { sourceMessageSeqs: [4] },
      ],
      [overlap, second, third, preferred, invalid],
      ['preferred', 'overlap'],
    );
    expect(selection.selected.map((recap) => recap.recapId)).toEqual([
      'preferred',
      'second',
      'third',
    ]);
    expect(selection.missingGroups).toEqual([{ sourceMessageSeqs: [4] }]);
    const merged = mergeRecapText(selection.selected);
    expect(merged.indexOf('preferred')).toBeLessThan(merged.indexOf('second'));
    expect(merged.indexOf('second')).toBeLessThan(merged.indexOf('third'));
  });

  it('places all recap text in one user message after system instructions', () => {
    const recaps = [recapFixture('first', [1]), recapFixture('second', [2, 3])];
    const raw: Parameters<typeof buildModelMessages>[0]['contextMessages'][number] = {
      seq: 4,
      messageId: 'message',
      threadId: 'thread',
      agentId: 'thread',
      createdAt: '2026-11-02T01:00:00.000Z',
      runId: 'internal-run',
      message: { role: 'assistant', content: 'raw' },
      revisions: [],
    };
    const pending: ModelMessage = { role: 'user', content: 'pending' };
    const messages = buildModelMessages({
      systemInstructions: ['system one', 'system two'],
      recaps,
      contextMessages: [raw],
      pendingMessages: [pending],
    });
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[2]).toEqual({ role: 'user', content: mergeRecapText(recaps) });
    expect(messages[2]?.content).toContain('来源消息序号: 1');
    expect(messages[2]?.content).toContain('来源消息序号: 2, 3');
  });
});
