import {
  create,
  GetThreadRequestSchema,
  MessageSchema,
  ToolResultStatus,
  toBinary,
} from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { seedTestSession } from '../integration/test-authentication.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { toAuditMessage } from './convert.js';
import { getThreadSnapshot } from './snapshot.js';

describe('persisted tool status projection', () => {
  it.each(['success', 'error'] as const)(
    'keeps a plain text %s result and its error in the current and audit protocols',
    (status) => {
      const database = openDatabase(':memory:');
      seedTestSession(database, 'owner', 'log-session');
      const store = new SessionStore(database);
      try {
        const thread = store.createThread({
          ownerId: 'owner',
          method: 'CreateThread',
          clientActionId: 'create',
          parameters: {},
          title: '工具状态',
        });
        const sent = store.sendMessage({
          ownerId: 'owner',
          method: 'SendMessage',
          clientActionId: 'send',
          parameters: {},
          threadId: thread.threadId,
          text: '读取文件',
          mode: 'follow_up',
        });
        store.appendModelMessage({
          runId: sent.runId,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'read-call', name: 'read', arguments: { path: '/missing' } }],
          },
        });
        const record = store.appendModelMessage({
          runId: sent.runId,
          message: {
            role: 'tool',
            tool_call_id: 'read-call',
            tool_name: 'read',
            content: status === 'error' ? '文件不存在。' : '文件内容',
            status,
            ...(status === 'error'
              ? { error: { code: 'execution_failed' as const, message: '文件不存在。' } }
              : {}),
          },
        });
        const current = getThreadSnapshot(
          store,
          'owner',
          create(GetThreadRequestSchema, { threadId: thread.threadId }),
        ).snapshot?.messages.find((message) => message.messageId === record.messageId);
        if (!current) throw new Error('Missing persisted tool message.');
        const audit = create(MessageSchema, toAuditMessage(record));
        expect(toBinary(MessageSchema, audit).length).toBeGreaterThan(0);
        for (const message of [current, audit]) {
          expect(message.toolStatus).toBe(
            status === 'error' ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
          );
          expect(message.content).toBe(record.message.content);
          expect(message.toolError).toEqual(
            status === 'error'
              ? expect.objectContaining({ code: 'execution_failed', message: '文件不存在。' })
              : undefined,
          );
        }
      } finally {
        database.close();
      }
    },
  );
});
