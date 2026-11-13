import { describe, expect, it } from 'vitest';
import { openDatabase } from '../storage/database.js';
import { ContextStore } from './context-store.js';
import { buildModelMessages, messageMetaReminder, stripMessageMeta } from './model-input.js';

function seed() {
  const database = openDatabase(':memory:');
  const context = new ContextStore(database);
  return { database, context };
}

describe('message meta in model input', () => {
  it('annotates direct user and assistant messages with seq, local time and origin', () => {
    const { database, context } = seed();
    try {
      const user = context.append({
        threadId: 'thread',
        agentId: 'thread',
        message: { role: 'user', content: '你好' },
        createdAt: '2026-11-14T02:00:00.000Z',
      });
      const assistant = context.append({
        threadId: 'thread',
        agentId: 'thread',
        message: { role: 'assistant', content: '你好，有什么可以帮你？' },
        createdAt: '2026-11-14T02:00:05.000Z',
      });
      const messages = buildModelMessages({
        systemInstructions: ['system'],
        recaps: [],
        contextMessages: context.query({ threadId: 'thread', agentId: 'thread' }),
        pendingMessages: [],
      });
      expect(messages[0]).toEqual({ role: 'system', content: 'system' });
      expect(messages[1]?.content).toBe(
        `${messageMetaReminder({ seq: user.seq, createdAt: user.createdAt, from: 'app' })}\n\n你好`,
      );
      expect(messages[2]?.content).toBe(
        `${messageMetaReminder({ seq: assistant.seq, createdAt: assistant.createdAt })}\n\n你好，有什么可以帮你？`,
      );
      expect(messages[2]?.content).not.toContain('from=');
    } finally {
      database.close();
    }
  });

  it('marks channel-originated user messages with their channel', () => {
    const { database, context } = seed();
    try {
      const inbound = context.append({
        threadId: 'thread',
        agentId: 'thread',
        message: { role: 'user', content: '从微信发来的消息' },
        createdAt: '2026-11-14T02:00:00.000Z',
        source: 'channel',
        channel: { channel: 'wechat', kind: 'inbound', externalMessageId: 'm-1' },
      });
      const messages = buildModelMessages({
        systemInstructions: [],
        recaps: [],
        contextMessages: context.query({ threadId: 'thread', agentId: 'thread' }),
        pendingMessages: [],
      });
      expect(messages[0]?.content).toBe(
        `${messageMetaReminder({ seq: inbound.seq, createdAt: inbound.createdAt, from: 'wechat' })}\n\n从微信发来的消息`,
      );
    } finally {
      database.close();
    }
  });

  it('leaves tool result messages unannotated and strips cleanly', () => {
    const { database, context } = seed();
    try {
      context.append({
        threadId: 'thread',
        agentId: 'thread',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', name: 'bash', arguments: { command: 'ls' } }],
        },
        createdAt: '2026-11-14T02:00:00.000Z',
      });
      context.append({
        threadId: 'thread',
        agentId: 'thread',
        message: {
          role: 'tool',
          content: 'file.txt',
          tool_call_id: 'call-1',
          tool_name: 'bash',
          status: 'success',
        },
        createdAt: '2026-11-14T02:00:01.000Z',
      });
      const messages = buildModelMessages({
        systemInstructions: [],
        recaps: [],
        contextMessages: context.query({ threadId: 'thread', agentId: 'thread' }),
        pendingMessages: [],
      });
      const tool = messages.at(-1);
      expect(tool?.role).toBe('tool');
      expect(tool?.content).toBe('file.txt');
      expect(stripMessageMeta(String(messages[0]?.content))).toBe('');
      expect(
        stripMessageMeta(
          `${messageMetaReminder({ seq: 9, createdAt: '2026-11-14T02:00:00.000Z', from: 'feishu' })}\n\n正文`,
        ),
      ).toBe('正文');
    } finally {
      database.close();
    }
  });
});

it('renders quoted channel messages as a ref tag inside the meta block', () => {
  const { database, context } = seed();
  try {
    context.append({
      threadId: 'thread',
      agentId: 'thread',
      message: { role: 'user', content: '针对上面那条回复' },
      createdAt: '2026-11-14T02:00:00.000Z',
      source: 'channel',
      channel: {
        channel: 'feishu',
        kind: 'inbound',
        externalMessageId: 'om_1',
        quoteSeq: 42,
        quoteExcerpt: '上一条回复 <内容>',
      },
    });
    const messages = buildModelMessages({
      systemInstructions: [],
      recaps: [],
      contextMessages: context.query({ threadId: 'thread', agentId: 'thread' }),
      pendingMessages: [],
    });
    expect(messages[0]?.content).toContain('<ref seq="42">上一条回复 &lt;内容&gt;</ref>');
    expect(messages[0]?.content).toContain('from="feishu"');
  } finally {
    database.close();
  }
});
