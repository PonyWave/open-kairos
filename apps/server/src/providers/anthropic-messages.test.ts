import type { ModelEvent, ModelProvider, ModelRequest } from '@kairos/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicMessagesProvider } from './anthropic-messages.js';

const config = () => ({
  baseUrl: 'https://anthropic.example/',
  apiKey: 'secret-anthropic-key',
  model: 'claude-test',
  contextWindow: 1000,
  outputReserve: 200,
});

function streamResponse(chunks: readonly string[], bytewise = false): Response {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(chunks.join(''));
  return new Response(
    new ReadableStream({
      start(controller) {
        if (bytewise) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        else for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function data(value: unknown, ending = '\n'): string {
  return `data: ${JSON.stringify(value)}\r\n\r\n`.replaceAll('\r\n', ending);
}

function start() {
  return data({
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 20,
        output_tokens: 1,
        cache_read_input_tokens: 6,
        cache_creation_input_tokens: 4,
      },
    },
  });
}

function stop(reason = 'end_turn') {
  return [
    data({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 8 } }),
    data({ type: 'message_stop' }),
  ];
}

async function collect(provider: ModelProvider, request: ModelRequest): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of provider.stream(request, new AbortController().signal))
    events.push(event);
  return events;
}

const simpleRequest: ModelRequest = { messages: [{ role: 'user', content: 'hello' }], tools: [] };

describe('AnthropicMessagesProvider', () => {
  it('serializes native system, content blocks, images, tool results and incomplete history', async () => {
    const png = 'data:image/png;base64,AQID';
    const request: ModelRequest = {
      messages: [
        { role: 'system', content: 'first instruction' },
        { role: 'system', content: 'second instruction' },
        {
          role: 'user',
          content: 'describe',
          content_parts: [
            { type: 'text', text: 'Attachment: one.png' },
            { type: 'image_url', image_url: { url: png, detail: 'low' } },
          ],
        },
        {
          role: 'assistant',
          content: 'I will inspect it.',
          content_blocks: [
            { type: 'thinking', block_index: 0, text: 'omit unsigned reasoning' },
            { type: 'text', block_index: 1, text: 'I will inspect it.' },
          ],
          tool_calls: [{ id: 'tool-complete', name: 'read_image', arguments: { path: 'one.png' } }],
          incomplete_tool_calls: [
            {
              id: 'tool-incomplete',
              name: 'edit',
              arguments_text: '{"path":',
              error: 'Invalid JSON.',
            },
          ],
        },
        {
          role: 'tool',
          content: '{"attachment_id":"one"}',
          content_parts: [
            { type: 'text', text: 'Attachment: one.png' },
            { type: 'image_url', image_url: { url: png, detail: 'low' } },
          ],
          tool_call_id: 'tool-complete',
          tool_name: 'read_image',
          status: 'success',
        },
        {
          role: 'tool',
          content: 'Invalid JSON.',
          tool_call_id: 'tool-incomplete',
          tool_name: 'edit',
          status: 'error',
        },
      ],
      tools: [
        {
          name: 'read_image',
          description: 'Read an image.',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([start(), ...stop()]));
    const provider = new AnthropicMessagesProvider(config(), fetchMock);
    await collect(provider, request);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://anthropic.example/v1/messages');
    expect(init?.headers).toMatchObject({
      'x-api-key': 'secret-anthropic-key',
      'anthropic-version': '2023-06-01',
    });
    expect(init?.headers).not.toHaveProperty('authorization');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchInlineSnapshot(`
      {
        "max_tokens": 200,
        "messages": [
          {
            "content": [
              {
                "text": "describe",
                "type": "text",
              },
              {
                "text": "Attachment: one.png",
                "type": "text",
              },
              {
                "source": {
                  "data": "AQID",
                  "media_type": "image/png",
                  "type": "base64",
                },
                "type": "image",
              },
            ],
            "role": "user",
          },
          {
            "content": [
              {
                "text": "I will inspect it.",
                "type": "text",
              },
              {
                "id": "tool-complete",
                "input": {
                  "path": "one.png",
                },
                "name": "read_image",
                "type": "tool_use",
              },
              {
                "id": "tool-incomplete",
                "input": {
                  "_kairos_incomplete_arguments": "{"path":",
                },
                "name": "edit",
                "type": "tool_use",
              },
            ],
            "role": "assistant",
          },
          {
            "content": [
              {
                "content": [
                  {
                    "text": "{"attachment_id":"one"}",
                    "type": "text",
                  },
                  {
                    "text": "Attachment: one.png",
                    "type": "text",
                  },
                  {
                    "source": {
                      "data": "AQID",
                      "media_type": "image/png",
                      "type": "base64",
                    },
                    "type": "image",
                  },
                ],
                "tool_use_id": "tool-complete",
                "type": "tool_result",
              },
              {
                "content": [
                  {
                    "text": "Invalid JSON.",
                    "type": "text",
                  },
                ],
                "is_error": true,
                "tool_use_id": "tool-incomplete",
                "type": "tool_result",
              },
            ],
            "role": "user",
          },
        ],
        "model": "claude-test",
        "stream": true,
        "system": "first instruction

      second instruction",
        "tools": [
          {
            "description": "Read an image.",
            "input_schema": {
              "properties": {
                "path": {
                  "type": "string",
                },
              },
              "type": "object",
            },
            "name": "read_image",
          },
        ],
      }
    `);
    expect(JSON.stringify(body)).not.toContain('omit unsigned reasoning');
    const incomplete = body.messages[1].content.find(
      (block: { id?: string }) => block.id === 'tool-incomplete',
    );
    expect(incomplete.input).toEqual({ _kairos_incomplete_arguments: '{"path":' });
    expect(incomplete.input).not.toEqual({});
    expect(body.messages[2].content[1].is_error).toBe(true);
    expect(provider.getContextBudget(request)).toMatchObject({
      fits: false,
      maxInputTokens: 800,
      estimatedInputTokens: expect.any(Number),
    });
  });

  it('streams Thinking, text and parallel tool calls, ignores signatures and merges native usage', async () => {
    const chunks = [
      start(),
      data({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'Think' },
      }),
      data({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: ' more' },
      }),
      data({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'do-not-persist' },
      }),
      data({ type: 'content_block_stop', index: 0 }),
      data({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'redacted_thinking', data: 'do-not-show' },
      }),
      data({ type: 'content_block_stop', index: 1 }),
      data({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'Hel' } }),
      data({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'lo' } }),
      data({ type: 'content_block_stop', index: 2 }),
      data({
        type: 'content_block_start',
        index: 3,
        content_block: { type: 'tool_use', id: 'tool-0', name: 'read', input: {} },
      }),
      data({
        type: 'content_block_delta',
        index: 3,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      }),
      data({
        type: 'content_block_delta',
        index: 3,
        delta: { type: 'input_json_delta', partial_json: '"/tmp/a"}' },
      }),
      data({ type: 'content_block_stop', index: 3 }),
      data({
        type: 'content_block_start',
        index: 4,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'edit', input: {} },
      }),
      data({
        type: 'content_block_delta',
        index: 4,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      }),
      data({ type: 'content_block_stop', index: 4 }),
      ...stop('tool_use'),
    ];
    const provider = new AnthropicMessagesProvider(
      config(),
      vi.fn<typeof fetch>().mockResolvedValue(streamResponse(chunks)),
    );
    const events = await collect(provider, simpleRequest);
    expect(events).toEqual([
      { type: 'thinking_delta', text: 'Think', block_index: 0 },
      { type: 'thinking_delta', text: ' more', block_index: 0 },
      { type: 'text_delta', text: 'Hel', block_index: 1 },
      { type: 'text_delta', text: 'lo', block_index: 1 },
      {
        type: 'response',
        message: {
          role: 'assistant',
          content: 'Hello',
          content_blocks: [
            { type: 'thinking', block_index: 0, text: 'Think more' },
            { type: 'text', block_index: 1, text: 'Hello' },
          ],
          tool_calls: [
            { id: 'tool-0', name: 'read', arguments: { path: '/tmp/a' }, block_index: 2 },
          ],
          incomplete_tool_calls: [
            {
              id: 'tool-1',
              name: 'edit',
              arguments_text: '{"path":',
              error: expect.stringContaining('incomplete or invalid'),
            },
          ],
        },
        usage: {
          input_tokens: 30,
          output_tokens: 8,
          total_tokens: 38,
          prompt_tokens_details: { cached_tokens: 6 },
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('do-not-persist');
    expect(JSON.stringify(events)).not.toContain('do-not-show');
  });

  it('preserves native Thinking and tool block order with following text', async () => {
    const provider = new AnthropicMessagesProvider(
      config(),
      vi.fn<typeof fetch>().mockResolvedValue(
        streamResponse([
          start(),
          data({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: 'First' },
          }),
          data({ type: 'content_block_stop', index: 0 }),
          data({
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'tool-0', name: 'read', input: {} },
          }),
          data({ type: 'content_block_stop', index: 1 }),
          data({
            type: 'content_block_start',
            index: 2,
            content_block: { type: 'thinking', thinking: 'Second' },
          }),
          data({ type: 'content_block_stop', index: 2 }),
          data({
            type: 'content_block_start',
            index: 3,
            content_block: { type: 'tool_use', id: 'tool-1', name: 'bash', input: {} },
          }),
          data({ type: 'content_block_stop', index: 3 }),
          data({
            type: 'content_block_start',
            index: 4,
            content_block: { type: 'text', text: 'After' },
          }),
          data({ type: 'content_block_stop', index: 4 }),
          ...stop('tool_use'),
        ]),
      ),
    );

    expect(await collect(provider, simpleRequest)).toEqual([
      { type: 'thinking_delta', text: 'First', block_index: 0 },
      { type: 'thinking_delta', text: 'Second', block_index: 1 },
      { type: 'text_delta', text: 'After', block_index: 2 },
      {
        type: 'response',
        message: {
          role: 'assistant',
          content: 'After',
          content_blocks: [
            { type: 'thinking', block_index: 0, text: 'First' },
            { type: 'thinking', block_index: 1, text: 'Second' },
            { type: 'text', block_index: 2, text: 'After' },
          ],
          tool_calls: [
            { id: 'tool-0', name: 'read', arguments: {}, block_index: 1 },
            { id: 'tool-1', name: 'bash', arguments: {}, block_index: 2 },
          ],
        },
        usage: {
          input_tokens: 30,
          output_tokens: 8,
          total_tokens: 38,
          prompt_tokens_details: { cached_tokens: 6 },
        },
      },
    ]);
  });

  it('accepts a complete native input object without argument deltas', async () => {
    const chunks = [
      start(),
      data({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'tool-native',
          name: 'read',
          input: { path: '/tmp/a' },
        },
      }),
      data({ type: 'content_block_stop', index: 0 }),
      ...stop('tool_use'),
    ];
    const provider = new AnthropicMessagesProvider(
      config(),
      vi.fn<typeof fetch>().mockResolvedValue(streamResponse(chunks)),
    );
    const events = await collect(provider, simpleRequest);
    expect(events.at(-1)).toMatchObject({
      type: 'response',
      message: { tool_calls: [{ id: 'tool-native', name: 'read', arguments: { path: '/tmp/a' } }] },
    });
  });

  it('parses identical output for whole, fragmented and bytewise CRLF streams', async () => {
    const input = [
      start(),
      data(
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        '\r\n',
      ),
      data(
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'native' },
        },
        '\r\n',
      ),
      data(
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        '\r\n',
      ),
      data(
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'visible' } },
        '\r\n',
      ),
      ...stop().map((event) => event.replaceAll('\n', '\r\n')),
    ].join('');
    const expected: ModelEvent[] = [
      { type: 'thinking_delta', text: 'native', block_index: 0 },
      { type: 'text_delta', text: 'visible', block_index: 1 },
      {
        type: 'response',
        message: {
          role: 'assistant',
          content: 'visible',
          content_blocks: [
            { type: 'thinking', block_index: 0, text: 'native' },
            { type: 'text', block_index: 1, text: 'visible' },
          ],
        },
        usage: {
          input_tokens: 30,
          output_tokens: 8,
          total_tokens: 38,
          prompt_tokens_details: { cached_tokens: 6 },
        },
      },
    ];
    for (const chunks of [[input], [input.slice(0, 23), input.slice(23)], [...input]]) {
      const provider = new AnthropicMessagesProvider(
        config(),
        vi.fn<typeof fetch>().mockResolvedValue(streamResponse(chunks)),
      );
      expect(await collect(provider, simpleRequest)).toEqual(expected);
    }
    const bytewise = new AnthropicMessagesProvider(
      config(),
      vi.fn<typeof fetch>().mockResolvedValue(streamResponse([input], true)),
    );
    expect(await collect(bytewise, simpleRequest)).toEqual(expected);
  });

  it('requires message_stop and reports native errors, truncation and malformed events safely', async () => {
    const cases = [
      [[start(), ...stop('max_tokens')], 'max_tokens'],
      [
        [
          start(),
          data({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 8 },
          }),
        ],
        'before message_stop',
      ],
      [
        [start(), data({ type: 'error', error: { message: 'bad secret-anthropic-key' } })],
        'bad [redacted]',
      ],
      [['data: not-json\n\n'], 'invalid JSON'],
      [
        [
          data({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: 42 },
          }),
        ],
        'content_block_start.text must be a string',
      ],
      [
        [
          data({
            type: 'content_block_delta',
            index: 99,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          }),
        ],
        'unknown content block',
      ],
    ] as const;
    for (const [chunks, message] of cases) {
      const provider = new AnthropicMessagesProvider(
        config(),
        vi.fn<typeof fetch>().mockResolvedValue(streamResponse(chunks)),
      );
      const events = await collect(provider, simpleRequest);
      expect(events.at(-1)).toMatchObject({ type: 'stream_interrupted' });
      expect(JSON.stringify(events.at(-1))).toContain(message);
      expect(JSON.stringify(events)).not.toContain('secret-anthropic-key');
    }
  });

  it('passes AbortSignal, reports timeout and rejects unsupported image input before fetch', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      return Promise.resolve(streamResponse([start(), ...stop()]));
    });
    for await (const _event of new AnthropicMessagesProvider(config(), fetchMock).stream(
      simpleRequest,
      controller.signal,
    )) {
      // Consume the response with the caller's signal.
    }
    expect(fetchMock).toHaveBeenCalledOnce();

    const timeoutFetch = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const timeout = new AnthropicMessagesProvider(
      { ...config(), requestTimeoutMs: 5 },
      timeoutFetch,
    ).stream(simpleRequest, new AbortController().signal);
    await expect(timeout[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'request_timeout',
    });

    const disabledFetch = vi.fn<typeof fetch>();
    const disabled = new AnthropicMessagesProvider(
      { ...config(), supportsVision: false },
      disabledFetch,
    );
    const image: ModelRequest = {
      messages: [
        {
          role: 'user',
          content: '',
          content_parts: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID', detail: 'low' } },
          ],
        },
      ],
      tools: [],
    };
    await expect(
      disabled.stream(image, new AbortController().signal)[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(disabledFetch).not.toHaveBeenCalled();
  });

  it('aborts an active stream and cancels the underlying reader without a successful response', async () => {
    const controller = new AbortController();
    let requestAborted = false;
    let readerCancelled = false;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(
            new TextEncoder().encode(
              data({
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: 'partial' },
              }),
            ),
          );
          init?.signal?.addEventListener(
            'abort',
            () => {
              requestAborted = true;
              stream.error(init.signal?.reason);
            },
            { once: true },
          );
        },
      });
      const getReader = body.getReader.bind(body);
      function trackedReader(options: { mode: 'byob' }): ReadableStreamBYOBReader;
      function trackedReader(): ReadableStreamDefaultReader<Uint8Array>;
      function trackedReader(
        options?: ReadableStreamGetReaderOptions,
      ): ReadableStreamReader<Uint8Array> {
        if (options?.mode === 'byob') return getReader(options);
        const reader = getReader();
        const cancel = reader.cancel.bind(reader);
        reader.cancel = async () => {
          readerCancelled = true;
          return cancel();
        };
        return reader;
      }
      body.getReader = trackedReader;
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    });
    const provider = new AnthropicMessagesProvider(config(), fetchMock);
    const iterator = provider.stream(simpleRequest, controller.signal)[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'text_delta', text: 'partial', block_index: 0 },
    });
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestAborted).toBe(true);
    expect(readerCancelled).toBe(true);
  });

  it('redacts credentials from HTTP errors', async () => {
    const provider = new AnthropicMessagesProvider(
      config(),
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'bad secret-anthropic-key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const next = provider
      .stream(simpleRequest, new AbortController().signal)
      [Symbol.asyncIterator]()
      .next();
    await expect(next).rejects.toThrow('HTTP 401: bad [redacted]');
    await expect(next).rejects.not.toThrow('secret-anthropic-key');
  });
});
