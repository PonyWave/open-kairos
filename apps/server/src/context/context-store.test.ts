import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../storage/database.js';
import { ContextStore } from './context-store.js';
import { currentModelMessage } from './types.js';

function withDatabase(work: (database: DatabaseSync, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-context-'));
  const path = join(directory, 'context.sqlite');
  const database = openDatabase(path);
  try {
    work(database, path);
  } finally {
    if (database.isOpen) database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('ContextStore', () => {
  it('persists ordered messages, tool relations and only the model-visible Bash preview', () => {
    withDatabase((database, path) => {
      const store = new ContextStore(database);
      const timestamp = '2026-11-02T01:00:00.000Z';
      const user = store.append({
        threadId: 'thread',
        agentId: 'thread',
        message: { role: 'user', content: '检查测试失败原因。' },
        createdAt: timestamp,
      });
      const assistant = store.append({
        threadId: 'thread',
        agentId: 'thread',
        message: {
          role: 'assistant',
          content: '执行测试。',
          tool_calls: [{ id: 'call-bash', name: 'bash', arguments: { command: 'pnpm test' } }],
        },
        createdAt: timestamp,
      });
      const preview = JSON.stringify({
        output: '最后两行',
        truncated: true,
        full_output_path: '/srv/kairos/output.log',
        exit_code: 1,
      });
      const fullLogLine = '不应进入 Context 的完整日志正文';
      const tool = store.append({
        threadId: 'thread',
        agentId: 'thread',
        message: {
          role: 'tool',
          content: preview,
          tool_call_id: 'call-bash',
          tool_name: 'bash',
        },
        createdAt: timestamp,
      });
      expect([user.seq, assistant.seq, tool.seq]).toEqual([1, 2, 3]);
      expect(store.listToolCallRelations('thread', 'thread')).toEqual([
        {
          callId: 'call-bash',
          toolName: 'bash',
          assistantSeq: assistant.seq,
          resultSeq: tool.seq,
          callType: 'complete',
        },
      ]);
      expect(
        store
          .query({ threadId: 'thread', agentId: 'thread', fromSeq: 2, toSeq: 3 })
          .map((message) => message.seq),
      ).toEqual([2, 3]);
      expect(
        store
          .query({ threadId: 'thread', agentId: 'thread', query: '测试失败' })
          .map((message) => message.seq),
      ).toEqual([1]);
      expect(
        database.prepare('SELECT content FROM context_messages WHERE seq = ?').get(tool.seq),
      ).toEqual({ content: preview });
      expect(preview).not.toContain(fullLogLine);
      database.close();

      const reopened = openDatabase(path);
      try {
        const restored = new ContextStore(reopened).query({
          threadId: 'thread',
          agentId: 'thread',
        });
        expect(restored.map((record) => currentModelMessage(record))).toEqual([
          { role: 'user', content: '检查测试失败原因。' },
          {
            role: 'assistant',
            content: '执行测试。',
            tool_calls: [{ id: 'call-bash', name: 'bash', arguments: { command: 'pnpm test' } }],
          },
          {
            role: 'tool',
            content: preview,
            tool_call_id: 'call-bash',
            tool_name: 'bash',
          },
        ]);
      } finally {
        reopened.close();
      }
    });
  });

  it('round-trips ordered content blocks and response usage without changing legacy messages', () => {
    withDatabase((database, path) => {
      const store = new ContextStore(database);
      const legacy = store.append({
        threadId: 'thread',
        agentId: 'thread',
        message: { role: 'assistant', content: 'legacy' },
      });
      const message = {
        role: 'assistant' as const,
        content: 'AB',
        content_blocks: [
          { type: 'thinking' as const, block_index: 0, text: 'first thought' },
          { type: 'text' as const, block_index: 1, text: 'A' },
          { type: 'thinking' as const, block_index: 2, text: 'second thought' },
          { type: 'text' as const, block_index: 3, text: 'B' },
        ],
      };
      const responseUsage = { input_tokens: 8, output_tokens: 5, total_tokens: 13 };
      const saved = store.append({
        threadId: 'thread',
        agentId: 'thread',
        message,
        responseUsage,
      });
      expect(saved.message).toEqual(message);
      expect(saved.responseUsage).toEqual(responseUsage);
      expect(legacy.message).toEqual({ role: 'assistant', content: 'legacy' });
      expect(legacy.responseUsage).toBeUndefined();
      expect(
        database
          .prepare(
            'SELECT content_blocks_json, response_usage_json FROM context_messages WHERE seq = ?',
          )
          .get(saved.seq),
      ).toEqual({
        content_blocks_json: JSON.stringify(message.content_blocks),
        response_usage_json: JSON.stringify(responseUsage),
      });
      expect(() =>
        store.append({
          threadId: 'thread',
          agentId: 'thread',
          message: {
            role: 'assistant',
            content: 'thinking must not be content',
            content_blocks: [
              { type: 'thinking', block_index: 0, text: 'thinking must not be content' },
            ],
          },
        }),
      ).toThrowError(expect.objectContaining({ code: 'invalid_message' }));
      expect(() =>
        store.append({
          threadId: 'thread',
          agentId: 'thread',
          message: { role: 'user', content: 'usage is not allowed' },
          responseUsage,
        }),
      ).toThrowError(expect.objectContaining({ code: 'invalid_message' }));
      database.close();

      const reopened = openDatabase(path);
      try {
        const restored = new ContextStore(reopened).get('thread', 'thread', saved.seq);
        expect(restored?.message).toEqual(message);
        expect(restored?.responseUsage).toEqual(responseUsage);
        expect(restored && currentModelMessage(restored)).toEqual(message);
      } finally {
        reopened.close();
      }
    });
  });

  it('keeps the original revision and invalidates every recap that sources it', () => {
    withDatabase((database) => {
      const store = new ContextStore(database);
      const message = store.append({
        threadId: 'thread',
        agentId: 'thread',
        message: { role: 'user', content: '原始要求' },
        createdAt: '2026-11-02T01:00:00.000Z',
      });
      database
        .prepare(
          `INSERT INTO recaps(
            recap_id, thread_id, agent_id, source_seq_start, source_seq_end,
            source_message_seqs, content, created_at, validity
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'valid')`,
        )
        .run(
          'recap',
          'thread',
          'thread',
          message.seq,
          message.seq,
          `[${message.seq}]`,
          '原始要求',
          '2026-11-02T01:01:00.000Z',
        );
      database.prepare('INSERT INTO recap_sources VALUES (?, ?, ?)').run('recap', 1, message.seq);

      const revised = store.revise({
        threadId: 'thread',
        agentId: 'thread',
        seq: message.seq,
        content: '修订要求',
        createdAt: '2026-11-02T01:02:00.000Z',
      });
      expect(revised.message.content).toBe('原始要求');
      expect(revised.revisions).toHaveLength(1);
      expect(currentModelMessage(revised)).toEqual({ role: 'user', content: '修订要求' });
      expect(
        database.prepare('SELECT content FROM context_messages WHERE seq = ?').get(message.seq),
      ).toEqual({ content: '原始要求' });
      expect(
        database
          .prepare('SELECT validity, invalidation_reason FROM recaps WHERE recap_id = ?')
          .get('recap'),
      ).toEqual({ validity: 'invalid', invalidation_reason: 'source_revised' });
      expect(
        store
          .query({ threadId: 'thread', agentId: 'thread', query: '修订要求' })
          .map((record) => record.seq),
      ).toEqual([message.seq]);
    });
  });

  it('persists generated incomplete call IDs and requires exact result correlation', () => {
    withDatabase((database, path) => {
      const store = new ContextStore(database);
      const assistant = store.append({
        threadId: 'thread',
        agentId: 'thread',
        messageId: 'assistant-incomplete',
        message: {
          role: 'assistant',
          content: '',
          incomplete_tool_calls: [{ name: 'edit', arguments_text: '{', error: 'Invalid JSON.' }],
        },
      });
      const callId = 'incomplete-assistant-incomplete-1';
      expect(assistant.message).toMatchObject({ incomplete_tool_calls: [{ id: callId }] });
      expect(store.listToolCallRelations('thread', 'thread')[0]?.callId).toBe(callId);
      expect(() =>
        store.append({
          threadId: 'thread',
          agentId: 'thread',
          message: {
            role: 'tool',
            tool_name: 'edit',
            tool_call_id: 'incomplete-1-0',
            content: 'Invalid JSON.',
            status: 'error',
            error: { code: 'incomplete_call', message: 'Invalid JSON.' },
          },
        }),
      ).toThrowError(expect.objectContaining({ code: 'tool_call_not_found' }));
      expect(store.listToolCallRelations('thread', 'thread')[0]?.resultSeq).toBeNull();
      const result = store.append({
        threadId: 'thread',
        agentId: 'thread',
        message: {
          role: 'tool',
          tool_name: 'edit',
          tool_call_id: callId,
          content: 'Invalid JSON.',
          status: 'error',
          error: { code: 'incomplete_call', message: 'Invalid JSON.' },
        },
      });
      expect(store.listToolCallRelations('thread', 'thread')[0]?.resultSeq).toBe(result.seq);
      database.close();
      const reopened = openDatabase(path);
      try {
        expect(new ContextStore(reopened).get('thread', 'thread', assistant.seq)?.message).toEqual(
          assistant.message,
        );
      } finally {
        reopened.close();
      }
    });
  });

  it('rejects orphaned, cross-agent, mismatched and duplicate tool results', () => {
    withDatabase((database) => {
      const store = new ContextStore(database);
      expect(() =>
        store.append({
          threadId: 'thread',
          agentId: 'thread',
          message: {
            role: 'tool',
            content: 'unknown',
            tool_call_id: 'missing',
            tool_name: 'bash',
          },
        }),
      ).toThrowError(expect.objectContaining({ code: 'tool_call_not_found' }));
      store.append({
        threadId: 'thread',
        agentId: 'other-agent',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call', name: 'bash', arguments: {} }],
        },
      });
      expect(() =>
        store.append({
          threadId: 'thread',
          agentId: 'thread',
          message: { role: 'tool', content: 'cross', tool_call_id: 'call', tool_name: 'bash' },
        }),
      ).toThrowError(expect.objectContaining({ code: 'tool_call_not_found' }));
      store.append({
        threadId: 'thread',
        agentId: 'thread',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call', name: 'bash', arguments: {} }],
        },
      });
      expect(() =>
        store.append({
          threadId: 'thread',
          agentId: 'thread',
          message: { role: 'tool', content: 'wrong', tool_call_id: 'call', tool_name: 'other' },
        }),
      ).toThrowError(expect.objectContaining({ code: 'tool_call_name_mismatch' }));
      store.append({
        threadId: 'thread',
        agentId: 'thread',
        message: { role: 'tool', content: 'done', tool_call_id: 'call', tool_name: 'bash' },
      });
      expect(() =>
        store.append({
          threadId: 'thread',
          agentId: 'thread',
          message: { role: 'tool', content: 'again', tool_call_id: 'call', tool_name: 'bash' },
        }),
      ).toThrowError(expect.objectContaining({ code: 'tool_result_exists' }));
    });
  });

  it('rolls back an assistant message when a tool-call insert fails', () => {
    withDatabase((database) => {
      database.exec(`
        CREATE TRIGGER reject_tool_call BEFORE INSERT ON context_tool_calls
        BEGIN SELECT RAISE(ABORT, 'injected tool-call failure'); END;
      `);
      const store = new ContextStore(database);
      expect(() =>
        store.append({
          threadId: 'thread',
          agentId: 'thread',
          message: {
            role: 'assistant',
            content: 'must roll back',
            tool_calls: [{ id: 'call', name: 'bash', arguments: {} }],
          },
        }),
      ).toThrow(/injected tool-call failure/);
      expect(database.prepare('SELECT COUNT(*) AS count FROM context_messages').get()).toEqual({
        count: 0,
      });
    });
  });

  it('round-trips delegation sources and filters the current view by the complete key', () => {
    withDatabase((database) => {
      database.exec(`
        CREATE TABLE interactions (
          source_thread_id TEXT NOT NULL,
          source_agent_id TEXT NOT NULL,
          source_tool_call_id TEXT NOT NULL,
          PRIMARY KEY(source_thread_id, source_agent_id, source_tool_call_id)
        )
      `);
      const store = new ContextStore(database);
      const keys = [
        { sourceThreadId: 'source-a', sourceAgentId: 'thread', sourceToolCallId: 'shared-call' },
        {
          sourceThreadId: 'source-a',
          sourceAgentId: 'subagent-source',
          sourceToolCallId: 'shared-call',
        },
        { sourceThreadId: 'source-b', sourceAgentId: 'thread', sourceToolCallId: 'shared-call' },
      ] as const;
      const sources = keys.map((key) =>
        store.append({
          threadId: key.sourceThreadId,
          agentId: key.sourceAgentId,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: key.sourceToolCallId, name: 'thread_call', arguments: {} }],
          },
        }),
      );
      const insertInteraction = database.prepare('INSERT INTO interactions VALUES (?, ?, ?)');
      for (const key of keys) {
        insertInteraction.run(key.sourceThreadId, key.sourceAgentId, key.sourceToolCallId);
      }
      const followUps = keys.map((key, index) =>
        store.append({
          threadId: 'reply-thread',
          agentId: 'thread',
          message: { role: 'user', content: `background-${index}` },
          source: index === 1 ? 'subagent_response' : 'thread_response',
          delegation: key,
          sourceInputId: `input-${index}`,
          sourceThreadId: `target-${index}`,
          sourceAgentId: index === 1 ? 'subagent-target' : 'thread',
        }),
      );
      const ordinary = store.append({
        threadId: 'reply-thread',
        agentId: 'thread',
        message: { role: 'user', content: 'ordinary' },
        source: 'user',
      });
      const [supersededSource] = sources;
      const [supersededFollowUp] = followUps;
      if (!supersededSource || !supersededFollowUp) throw new Error('Expected source fixtures.');

      expect(supersededFollowUp).toMatchObject({
        delegation: keys[0],
        sourceInputId: 'input-0',
        sourceThreadId: 'target-0',
        sourceAgentId: 'thread',
      });
      expect(
        database
          .prepare(
            `SELECT delegation_source_thread_id, delegation_source_agent_id, source_tool_call_id
             FROM context_messages WHERE seq = ?`,
          )
          .get(supersededFollowUp.seq),
      ).toEqual({
        delegation_source_thread_id: 'source-a',
        delegation_source_agent_id: 'thread',
        source_tool_call_id: 'shared-call',
      });

      database
        .prepare('UPDATE context_messages SET superseded_by_run_id = ? WHERE seq = ?')
        .run('rerun-source', supersededSource.seq);
      expect(
        store
          .query({ threadId: 'reply-thread', agentId: 'thread', currentOnly: true })
          .map((message) => message.message.content),
      ).toEqual(['background-1', 'background-2', ordinary.message.content]);
      expect(
        store.query({ threadId: 'reply-thread', agentId: 'thread' }).map((message) => message.seq),
      ).toEqual([...followUps.map((message) => message.seq), ordinary.seq]);
    });
  });
});
