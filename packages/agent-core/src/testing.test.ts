import { describe, expect, it } from 'vitest';
import type { ModelEvent, ModelRequest } from './index.js';
import { ScriptedProvider } from './testing.js';

const request: ModelRequest = {
  messages: [{ role: 'user', content: '检查测试结果。' }],
  tools: [],
};
const response: ModelEvent[] = [
  { type: 'text_delta', text: '完成。' },
  {
    type: 'response',
    message: { role: 'assistant', content: '完成。' },
    usage: { input_tokens: 10, output_tokens: 2 },
  },
];

describe('scripted provider', () => {
  it('replays deterministic events and records the actual request', async () => {
    const provider = new ScriptedProvider([response]);
    const events: ModelEvent[] = [];
    for await (const event of provider.stream(request, new AbortController().signal)) {
      events.push(event);
    }
    expect(events).toEqual(response);
    expect(provider.requests).toEqual([request]);
  });

  it('does not consume a response when the request is already cancelled', async () => {
    const provider = new ScriptedProvider([response]);
    const controller = new AbortController();
    controller.abort();
    const cancelled = provider.stream(request, controller.signal)[Symbol.asyncIterator]();
    await expect(cancelled.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.requests).toHaveLength(0);
    const next = provider.stream(request, new AbortController().signal)[Symbol.asyncIterator]();
    await expect(next.next()).resolves.toMatchObject({ value: response[0], done: false });
  });

  it('stops before the final response when cancelled during a stream', async () => {
    const provider = new ScriptedProvider([response]);
    const controller = new AbortController();
    const stream = provider.stream(request, controller.signal)[Symbol.asyncIterator]();
    await stream.next();
    controller.abort();
    await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('replays incomplete tool calls and stream interruptions', async () => {
    const interrupted: ModelEvent[] = [
      { type: 'text_delta', text: '部分输出' },
      {
        type: 'stream_interrupted',
        error: { code: 'stream_interrupted', message: '连接中断。' },
        usage: { input_tokens: 8, output_tokens: 1 },
      },
    ];
    const provider = new ScriptedProvider([
      [
        {
          type: 'response',
          message: {
            role: 'assistant',
            content: '',
            incomplete_tool_calls: [
              { id: 'call-1', name: 'read', arguments_text: '{"path"', error: 'JSON 未完整。' },
            ],
          },
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      ],
      interrupted,
    ]);

    const first = provider.stream(request, new AbortController().signal);
    const firstEvents: ModelEvent[] = [];
    for await (const event of first) firstEvents.push(event);
    expect(firstEvents[0]).toMatchObject({
      type: 'response',
      message: { incomplete_tool_calls: [{ id: 'call-1' }] },
    });

    const secondEvents: ModelEvent[] = [];
    for await (const event of provider.stream(request, new AbortController().signal)) {
      secondEvents.push(event);
    }
    expect(secondEvents).toEqual(interrupted);
  });
});
