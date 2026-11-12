import { expect, it } from 'vitest';
import { RecapStore } from '../recap/recap-store.js';
import { openDatabase } from '../storage/database.js';
import { ContextStore } from './context-store.js';
import { RecallService } from './recall-service.js';

it('paginates tool structures and Recap source arrays without oversized fields', () => {
  const database = openDatabase(':memory:');
  try {
    const context = new ContextStore(database);
    const assistant = context.append({
      threadId: 'thread',
      agentId: 'thread',
      message: {
        role: 'assistant',
        content: 'assistant content',
        tool_calls: [{ id: 'complete', name: 'bash', arguments: { payload: 'a'.repeat(10000) } }],
        incomplete_tool_calls: [
          {
            id: 'broken',
            name: 'bash',
            arguments_text: 'b'.repeat(10000),
            error: 'c'.repeat(10000),
          },
        ],
      },
    });
    const tool = context.append({
      threadId: 'thread',
      agentId: 'thread',
      message: {
        role: 'tool',
        content: 'tool content',
        tool_call_id: 'complete',
        tool_name: 'bash',
        status: 'error',
        error: { code: 'execution_failed', message: 'e'.repeat(10000) },
      },
    });
    const incompleteResult = context.append({
      threadId: 'thread',
      agentId: 'thread',
      message: {
        role: 'tool',
        content: 'incomplete',
        tool_call_id: 'broken',
        tool_name: 'bash',
        status: 'error',
        error: { code: 'incomplete_call', message: 'incomplete' },
      },
    });
    const recaps = new RecapStore(database);
    const recap = recaps.save({
      recapId: 'long-recap',
      threadId: 'thread',
      agentId: 'thread',
      sourceMessageSeqs: [assistant.seq, tool.seq, incompleteResult.seq],
      content: 'recap content',
    });
    const recall = new RecallService(database, () => true);
    const assistantResult = recall.recallContext({
      scope: { threadId: 'thread', agentId: 'thread' },
      seq: assistant.seq,
      maxContentChars: 4,
    });
    const assistantItem = assistantResult.messages[0];
    expect(assistantItem).toMatchObject({
      content: 'assi',
      tool_calls_json: '[{"i',
      incomplete_tool_calls_json: '[{"a',
      structured_truncated: true,
      next_structured_offset: 4,
    });
    expect(assistantItem).not.toHaveProperty('tool_calls');
    expect(assistantItem).not.toHaveProperty('incomplete_tool_calls');
    expect(assistantItem?.tool_calls_json).toHaveLength(4);
    expect(assistantItem?.incomplete_tool_calls_json).toHaveLength(4);
    expect(assistantResult.has_more).toBe(true);
    const assistantContinuation = recall.recallContext({
      scope: { threadId: 'thread', agentId: 'thread' },
      seq: assistant.seq,
      structuredOffset: assistantItem?.next_structured_offset,
      maxContentChars: 4,
    });
    expect(assistantContinuation.messages[0]).toMatchObject({
      structured_offset: 4,
      structured_truncated: true,
      next_structured_offset: 8,
    });
    expect(assistantContinuation.messages[0]?.tool_calls_json).toHaveLength(4);

    const toolResult = recall.recallContext({
      scope: { threadId: 'thread', agentId: 'thread' },
      seq: tool.seq,
      maxContentChars: 4,
    });
    expect(toolResult.messages[0]).toMatchObject({
      error_json: '{"co',
      structured_truncated: true,
      next_structured_offset: 4,
    });
    expect(toolResult.messages[0]).not.toHaveProperty('error');
    expect(toolResult.messages[0]?.error_json).toHaveLength(4);

    const recapResult = recall.recallRecap({
      scope: { threadId: 'thread', agentId: 'thread' },
      recapId: recap.recapId,
      maxContentChars: 4,
    });
    const recapItem = recapResult.recaps[0];
    expect(recapItem).toMatchObject({
      content: 'reca',
      source_message_seqs_json: '[1,2',
      structured_truncated: true,
      next_structured_offset: 4,
    });
    expect(recapItem).not.toHaveProperty('source_message_seqs');
    expect(recapItem?.source_message_seqs_json).toHaveLength(4);
    expect(recapResult.has_more).toBe(true);
    const recapContinuation = recall.recallRecap({
      scope: { threadId: 'thread', agentId: 'thread' },
      recapId: recap.recapId,
      structuredOffset: recapItem?.next_structured_offset,
      maxContentChars: 4,
    });
    expect(recapContinuation.recaps[0]).toMatchObject({
      source_message_seqs_json: ',3]',
      structured_offset: 4,
    });
  } finally {
    database.close();
  }
});
