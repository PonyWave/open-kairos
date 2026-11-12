import { expect, it } from 'vitest';
import { AgentLoop } from './agent-loop.js';
import type {
  AgentLoopPersistence,
  AgentTool,
  ModelEvent,
  ModelMessage,
  ToolExecutionResult,
} from './index.js';
import { ScriptedProvider } from './testing.js';

const usage = { input_tokens: 1, output_tokens: 1 };

function response(message: Extract<ModelMessage, { role: 'assistant' }>): ModelEvent[] {
  return [{ type: 'response', message, usage }];
}

function call(id = 'send-1'): ModelEvent[] {
  return response({
    role: 'assistant',
    content: '',
    tool_calls: [{ id, name: 'send', arguments: {} }],
  });
}

function persistence() {
  const messages: ModelMessage[] = [];
  const store: AgentLoopPersistence = {
    saveMessage: async (message) => {
      messages.push(structuredClone(message));
    },
    saveToolCall: async () => {},
  };
  return { messages, store };
}

function tool(execute: () => Promise<ToolExecutionResult>): AgentTool {
  return {
    name: 'send',
    description: 'Send a message.',
    parameters: { type: 'object' },
    validate: (value) => value,
    execute,
  };
}

it('persists a final tool result and ends without an extra model request, then reuses the pair', async () => {
  const firstProvider = new ScriptedProvider([call()]);
  const { messages, store } = persistence();
  const send = tool(async () => ({ content: 'sent', endTurn: true }));
  const first = new AgentLoop({ provider: firstProvider, persistence: store, tools: [send] });
  await expect(first.run('first question')).resolves.toMatchObject({
    status: 'completed',
    steps: 1,
  });
  expect(firstProvider.requests).toHaveLength(1);
  expect(messages.at(-1)).toMatchObject({
    role: 'tool',
    tool_call_id: 'send-1',
    content: 'sent',
    status: 'success',
  });
  const secondProvider = new ScriptedProvider([call('send-2')]);
  const next = new AgentLoop({
    provider: secondProvider,
    persistence: store,
    tools: [send],
    initialMessages: first.getContext(),
  });
  await expect(next.run('next question')).resolves.toMatchObject({ status: 'completed' });
  expect(secondProvider.requests[0]?.messages).toEqual([
    { role: 'user', content: 'first question' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'send-1', name: 'send', arguments: {} }],
    },
    { role: 'tool', tool_call_id: 'send-1', tool_name: 'send', content: 'sent', status: 'success' },
    { role: 'user', content: 'next question' },
  ]);
});

it('continues after a non-final send', async () => {
  let sends = 0;
  const provider = new ScriptedProvider([call(), call('send-2')]);
  const { messages, store } = persistence();
  const loop = new AgentLoop({
    provider,
    persistence: store,
    tools: [tool(async () => ({ content: 'sent', endTurn: ++sends === 2 }))],
  });
  await expect(loop.run('work')).resolves.toMatchObject({ status: 'completed', steps: 2 });
  expect(provider.requests).toHaveLength(2);
  expect(messages.filter((message) => message.role === 'tool')).toHaveLength(2);
});

it.each(['inject', 'supplement', 'enqueue'] as const)(
  'processes pending %s input after the final tool result',
  async (method) => {
    const provider = new ScriptedProvider([call(), call('send-2')]);
    const { store } = persistence();
    let sends = 0;
    const loop = new AgentLoop({
      provider,
      persistence: store,
      tools: [
        tool(async () => {
          if (++sends === 1) loop[method]('new input');
          return { content: 'sent', endTurn: true };
        }),
      ],
    });
    await expect(loop.run('work')).resolves.toMatchObject({ status: 'completed', steps: 2 });
    expect(provider.requests[1]?.messages.slice(-2)).toEqual([
      {
        role: 'tool',
        tool_call_id: 'send-1',
        tool_name: 'send',
        content: 'sent',
        status: 'success',
      },
      { role: 'user', content: 'new input' },
    ]);
  },
);

it('ignores an end request from a failed tool result', async () => {
  const provider = new ScriptedProvider([
    call(),
    response({ role: 'assistant', content: 'could not send' }),
  ]);
  const { messages, store } = persistence();
  const loop = new AgentLoop({
    provider,
    persistence: store,
    tools: [tool(async () => ({ content: 'send failed', status: 'error', endTurn: true }))],
  });
  await expect(loop.run('work')).resolves.toMatchObject({ status: 'completed', steps: 2 });
  expect(messages.find((message) => message.role === 'tool')).toMatchObject({ status: 'error' });
});

it('stops on final result persistence failure without reporting completion', async () => {
  const provider = new ScriptedProvider([call()]);
  const { messages, store } = persistence();
  const originalSave = store.saveMessage;
  store.saveMessage = async (message) => {
    if (message.role === 'tool') throw new Error('storage unavailable');
    await originalSave(message);
  };
  const loop = new AgentLoop({
    provider,
    persistence: store,
    tools: [tool(async () => ({ content: 'sent', endTurn: true }))],
  });
  await expect(loop.run('work')).resolves.toMatchObject({
    status: 'failed',
    error: { code: 'persistence_failed' },
  });
  expect(messages.some((message) => message.role === 'tool')).toBe(false);
  expect(provider.requests).toHaveLength(1);
});

it('saves every tool result before ending a response', async () => {
  const provider = new ScriptedProvider([
    response({
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'first', name: 'send', arguments: {} },
        { id: 'second', name: 'send', arguments: {} },
      ],
    }),
  ]);
  const { messages, store } = persistence();
  let executed = 0;
  const loop = new AgentLoop({
    provider,
    persistence: store,
    tools: [tool(async () => ({ content: `sent-${++executed}`, endTurn: true }))],
  });
  await expect(loop.run('work')).resolves.toMatchObject({ status: 'completed' });
  expect(executed).toBe(2);
  expect(
    messages.filter((message) => message.role === 'tool').map((message) => message.content),
  ).toEqual(['sent-1', 'sent-2']);
});
