import { describe, expect, it } from 'vitest';
import { RecapStore } from '../recap/recap-store.js';
import { openDatabase } from '../storage/database.js';
import { ContextStore } from './context-store.js';
import { RecallService } from './recall-service.js';

function seed() {
  const database = openDatabase(':memory:');
  const context = new ContextStore(database);
  const recaps = new RecapStore(database);
  const first = context.append({
    threadId: 'thread',
    agentId: 'thread',
    runId: 'run-internal-secret',
    message: { role: 'user', content: '1234567890' },
    createdAt: '2026-11-02T01:00:00.000Z',
  });
  const assistant = context.append({
    threadId: 'thread',
    agentId: 'thread',
    message: {
      role: 'assistant',
      content: 'call',
      tool_calls: [{ id: 'call', name: 'bash', arguments: { command: 'test' } }],
    },
  });
  context.append({
    threadId: 'thread',
    agentId: 'thread',
    message: { role: 'tool', content: 'result', tool_call_id: 'call', tool_name: 'bash' },
  });
  context.append({
    threadId: 'thread',
    agentId: 'other',
    runId: 'other-run',
    message: { role: 'user', content: 'other-agent-secret' },
  });
  const recap = recaps.save({
    recapId: 'recap-main',
    threadId: 'thread',
    agentId: 'thread',
    sourceMessageSeqs: [first.seq],
    content: 'abcdefghij',
  });
  recaps.save({
    recapId: 'recap-other',
    threadId: 'thread',
    agentId: 'other',
    sourceMessageSeqs: [assistant.seq + 2],
    content: 'other-agent-secret',
  });
  const recall = new RecallService(
    database,
    (scope) => scope.threadId === 'thread' && scope.agentId === 'thread',
    { resultLimit: 20, contentLimit: 4000 },
  );
  return { database, context, recaps, recall, first, recap };
}

describe('RecallService', () => {
  it('returns only authorized business fields and preserves tool relationships', () => {
    const { database, recall } = seed();
    try {
      const result = recall.recallContext({ scope: { threadId: 'thread', agentId: 'thread' } });
      expect(result.messages).toHaveLength(3);
      expect(result.messages[1]?.tool_calls?.[0]).toMatchObject({ id: 'call', name: 'bash' });
      expect(result.messages[2]).toMatchObject({ tool_call_id: 'call', tool_name: 'bash' });
      expect(JSON.stringify(result)).not.toContain('run-internal-secret');
      expect(result.messages[0]).not.toHaveProperty('run_id');
      expect(result.messages[0]).not.toHaveProperty('message_id');
      expect(result.messages[0]).not.toHaveProperty('thread_id');
      expect(() =>
        recall.recallContext({ scope: { threadId: 'thread', agentId: 'other' } }),
      ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
      expect(() =>
        recall.recallRecap({ scope: { threadId: 'thread', agentId: 'other' } }),
      ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
      expect(() =>
        recall.recallContext({
          scope: { threadId: 'thread', agentId: 'thread' },
          sql: 'SELECT * FROM context_messages',
        }),
      ).toThrowError(expect.objectContaining({ code: 'invalid_query' }));
      expect(() =>
        recall.recallContext({
          scope: { threadId: 'thread', agentId: 'thread' },
          run_id: 'run-internal-secret',
        }),
      ).toThrowError(expect.objectContaining({ code: 'invalid_query' }));
    } finally {
      database.close();
    }
  });

  it('paginates records and resumes long Context and Recap content by offset', () => {
    const { database, recall, first, recap } = seed();
    try {
      const page = recall.recallContext({
        scope: { threadId: 'thread', agentId: 'thread' },
        limit: 1,
      });
      expect(page.messages.map((message) => message.seq)).toEqual([first.seq]);
      expect(page).toMatchObject({ has_more: true, next_after_seq: first.seq });
      const next = recall.recallContext({
        scope: { threadId: 'thread', agentId: 'thread' },
        afterSeq: page.next_after_seq,
        limit: 1,
      });
      expect(next.messages[0]?.seq).toBe(first.seq + 1);

      const long = recall.recallContext({
        scope: { threadId: 'thread', agentId: 'thread' },
        seq: first.seq,
        maxContentChars: 4,
      });
      expect(long.messages[0]).toMatchObject({
        content: '1234',
        content_truncated: true,
        next_content_offset: 4,
      });
      const remainder = recall.recallContext({
        scope: { threadId: 'thread', agentId: 'thread' },
        seq: first.seq,
        contentOffset: long.messages[0]?.next_content_offset,
        maxContentChars: 10,
      });
      expect(remainder.messages[0]).toMatchObject({ content: '567890', content_offset: 4 });

      const longRecap = recall.recallRecap({
        scope: { threadId: 'thread', agentId: 'thread' },
        recapId: recap.recapId,
        maxContentChars: 5,
      });
      expect(longRecap.recaps[0]).toMatchObject({
        content: 'abcde',
        content_truncated: true,
        next_content_offset: 5,
        source_message_seqs: [first.seq],
      });
      const recapRemainder = recall.recallRecap({
        scope: { threadId: 'thread', agentId: 'thread' },
        recapId: recap.recapId,
        contentOffset: 5,
        maxContentChars: 5,
      });
      expect(recapRemainder.recaps[0]?.content).toBe('fghij');
      expect(JSON.stringify(longRecap)).not.toContain('invalidation_reason');
    } finally {
      database.close();
    }
  });

  it('paginates only the current content of a revised message', () => {
    const { database, context, recall } = seed();
    try {
      const original = 'x'.repeat(10000);
      const message = context.append({
        threadId: 'thread',
        agentId: 'thread',
        message: { role: 'user', content: original },
      });
      context.revise({
        threadId: 'thread',
        agentId: 'thread',
        seq: message.seq,
        content: 'short revision',
      });
      const first = recall.recallContext({
        scope: { threadId: 'thread', agentId: 'thread' },
        seq: message.seq,
        maxContentChars: 4,
      });
      expect(first.messages[0]).toMatchObject({
        content: 'shor',
        revision_number: 1,
        next_content_offset: 4,
      });
      expect(first.messages[0]).not.toHaveProperty('original_content');
      expect(first.has_more).toBe(true);
      const second = recall.recallContext({
        scope: { threadId: 'thread', agentId: 'thread' },
        seq: message.seq,
        contentOffset: first.messages[0]?.next_content_offset,
        maxContentChars: 4,
      });
      expect(second.messages[0]).toMatchObject({
        content: 't re',
        content_offset: 4,
        content_truncated: true,
        next_content_offset: 8,
      });
      expect(second.messages[0]).not.toHaveProperty('original_content');
    } finally {
      database.close();
    }
  });

  it('filters superseded messages and mixed-source recaps before search and pagination', () => {
    const { database, context, recaps, recall, first } = seed();
    try {
      const assistantSeq = first.seq + 1;
      const toolSeq = first.seq + 2;
      recaps.save({
        recapId: 'mixed-recap',
        threadId: 'thread',
        agentId: 'thread',
        sourceMessageSeqs: [first.seq, assistantSeq, toolSeq],
        content: 'mixed sources',
      });
      context.revise({
        threadId: 'thread',
        agentId: 'thread',
        seq: first.seq,
        content: 'current revision',
      });
      database
        .prepare('UPDATE context_messages SET superseded_by_run_id = ? WHERE seq IN (?, ?)')
        .run('rerun-current', assistantSeq, toolSeq);

      for (const query of ['1234567890', 'result', 'call']) {
        expect(
          recall.recallContext({ scope: { threadId: 'thread', agentId: 'thread' }, query })
            .messages,
        ).toEqual([]);
      }
      const page = recall.recallContext({
        scope: { threadId: 'thread', agentId: 'thread' },
        query: 'current',
        limit: 1,
      });
      expect(page.messages.map((message) => message.seq)).toEqual([first.seq]);
      expect(page.has_more).toBe(false);
      expect(
        recall.recallRecap({ scope: { threadId: 'thread', agentId: 'thread' } }).recaps,
      ).toEqual([]);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM recaps WHERE thread_id = 'thread' AND agent_id = 'thread'",
          )
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it('hides invalid recaps by default and never returns original content', () => {
    const { database, context, recaps, recall, first, recap } = seed();
    try {
      context.revise({
        threadId: 'thread',
        agentId: 'thread',
        seq: first.seq,
        content: 'revised',
      });
      expect(
        recall.recallRecap({ scope: { threadId: 'thread', agentId: 'thread' } }).recaps,
      ).toHaveLength(0);
      const invalid = recall.recallRecap({
        scope: { threadId: 'thread', agentId: 'thread' },
        includeInvalid: true,
      });
      expect(invalid.recaps.map((item) => item.recap_id)).toEqual([recap.recapId]);
      expect(invalid.recaps[0]?.validity).toBe('invalid');
      expect(recaps.get('thread', 'thread', recap.recapId)?.validity).toBe('invalid');
      const message = recall.recallContext({
        scope: { threadId: 'thread', agentId: 'thread' },
        seq: first.seq,
      }).messages[0];
      expect(message).toMatchObject({ content: 'revised', revision_number: 1 });
      expect(message).not.toHaveProperty('original_content');
    } finally {
      database.close();
    }
  });
});
