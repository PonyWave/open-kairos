import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, ModelRequest, ToolMessage } from '@kairos/agent-core';
import { expect, it } from 'vitest';
import { openDatabase } from '../storage/database.js';
import { ContextStore } from './context-store.js';
import type { RecapGenerationInput } from './model-input-service.js';
import { ModelInputService } from './model-input-service.js';
import { RecallService } from './recall-service.js';
import { currentModelMessage } from './types.js';

it('preserves complete and incomplete tool fields through reopen, recall, recap and model input', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-message-fields-'));
  const path = join(directory, 'messages.sqlite');
  const assistant: AssistantMessage = {
    role: 'assistant',
    content: 'tool batch',
    tool_calls: [{ id: 'complete', name: 'bash', arguments: { command: 'test' } }],
    incomplete_tool_calls: [
      { id: 'broken', name: 'bash', arguments_text: '{', error: 'incomplete JSON' },
      { id: 'incomplete-missing-id', arguments_text: '[', error: 'missing call id' },
    ],
  };
  const results: ToolMessage[] = [
    {
      role: 'tool',
      content: 'execution failed',
      tool_call_id: 'complete',
      tool_name: 'bash',
      status: 'error',
      error: { code: 'execution_failed', message: 'exit 1' },
    },
    {
      role: 'tool',
      content: 'incomplete JSON',
      tool_call_id: 'broken',
      tool_name: 'bash',
      status: 'error',
      error: { code: 'incomplete_call', message: 'incomplete JSON' },
    },
    {
      role: 'tool',
      content: 'missing call id',
      tool_call_id: 'incomplete-missing-id',
      tool_name: 'unknown',
      status: 'error',
      error: { code: 'incomplete_call', message: 'missing call id' },
    },
  ];
  let database = openDatabase(path);
  try {
    const store = new ContextStore(database);
    const assistantRecord = store.append({
      threadId: 'thread',
      agentId: 'thread',
      message: assistant,
    });
    expect(assistantRecord.message).toEqual(assistant);
    for (const message of results) {
      store.append({ threadId: 'thread', agentId: 'thread', message });
    }
    const relations = store.listToolCallRelations('thread', 'thread');
    expect(relations).toHaveLength(3);
    expect(relations.find((relation) => relation.callId === 'complete')).toMatchObject({
      callType: 'complete',
      assistantSeq: assistantRecord.seq,
      resultSeq: assistantRecord.seq + 1,
    });
    expect(relations.find((relation) => relation.callId === 'broken')).toMatchObject({
      callType: 'incomplete',
      assistantSeq: assistantRecord.seq,
      resultSeq: assistantRecord.seq + 2,
    });
    expect(relations.find((relation) => relation.callId === 'incomplete-missing-id')).toMatchObject(
      {
        callType: 'incomplete',
        assistantSeq: assistantRecord.seq,
        resultSeq: assistantRecord.seq + 3,
      },
    );
    database.close();

    database = openDatabase(path);
    const restored = new ContextStore(database).query({ threadId: 'thread', agentId: 'thread' });
    expect(restored.map(currentModelMessage)).toEqual([assistant, ...results]);
    const recalled = new RecallService(database, () => true).recallContext({
      scope: { threadId: 'thread', agentId: 'thread' },
    });
    expect(recalled.messages[0]).toMatchObject({
      incomplete_tool_calls: assistant.incomplete_tool_calls,
    });
    expect(recalled.messages.slice(1)).toEqual(
      results.map((message, index) =>
        expect.objectContaining({
          seq: assistantRecord.seq + index + 1,
          status: message.status,
          error: message.error,
        }),
      ),
    );

    const requests: ModelRequest[] = [];
    const generated: RecapGenerationInput[] = [];
    const service = new ModelInputService(database, {
      countTokens: (request) => {
        requests.push(request);
        return requests.length === 1 ? 900 : 100;
      },
      generateRecap: async (input) => {
        generated.push(input);
        return { content: 'tool recap' };
      },
    });
    const prepared = await service.prepare({
      threadId: 'thread',
      agentId: 'thread',
      requestId: 'fields-request',
      systemInstructions: [],
      tools: [],
      pendingMessages: [],
      contextWindowTokens: 1000,
    });
    expect(prepared.hardCut).toBe(true);
    expect(requests[0]?.messages).toEqual([assistant, ...results]);
    expect(generated).toHaveLength(1);
    expect(generated[0]?.sourceMessageSeqs).toEqual([1, 2, 3, 4]);
    expect(generated[0]?.messages.map((message) => message.message)).toEqual([
      assistant,
      ...results,
    ]);
    expect(
      database
        .prepare('SELECT source_message_seqs FROM recaps WHERE thread_id = ? AND agent_id = ?')
        .get('thread', 'thread'),
    ).toEqual({ source_message_seqs: '[1,2,3,4]' });
  } finally {
    if (database.isOpen) database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
