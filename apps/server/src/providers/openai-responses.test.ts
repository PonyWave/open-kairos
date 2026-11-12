import type { ModelEvent, ModelProvider, ModelRequest } from '@kairos/agent-core';
import { ModelApiType } from '@kairos/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { EstimatingModelProvider } from './base.js';
import { createModelProvider, providerIdForApiType } from './factory.js';
import { OpenAIResponsesProvider } from './openai-responses.js';

const config = () => ({
  baseUrl: 'https://model.example/v1/',
  apiKey: 'secret-responses-key',
  model: 'model-test',
  contextWindow: 1000,
  outputReserve: 200,
});

const usage = {
  input_tokens: 20,
  output_tokens: 8,
  total_tokens: 28,
  input_tokens_details: { cached_tokens: 6 },
};

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
  return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`.replaceAll(
    '\r\n',
    ending,
  );
}

function completed() {
  return data({ type: 'response.completed', response: { status: 'completed', usage } });
}

async function collect(provider: ModelProvider, request: ModelRequest): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of provider.stream(request, new AbortController().signal))
    events.push(event);
  return events;
}

const simpleRequest: ModelRequest = { messages: [{ role: 'user', content: 'hello' }], tools: [] };

describe('OpenAIResponsesProvider', () => {
  it('uses the apiType factory without changing Chat Completions defaults', () => {
    const provider = createModelProvider(ModelApiType.OPENAI_RESPONSES, config());
    expect(provider).toBeInstanceOf(OpenAIResponsesProvider);
    expect(providerIdForApiType(ModelApiType.OPENAI_RESPONSES)).toBe('openai-responses');
    expect(
      createModelProvider(ModelApiType.OPENAI_CHAT_COMPLETIONS, config()).constructor.name,
    ).toBe('OpenAICompatibleProvider');
    expect(createModelProvider(ModelApiType.ANTHROPIC_MESSAGES, config()).constructor.name).toBe(
      'AnthropicMessagesProvider',
    );
    expect(() => createModelProvider(ModelApiType.UNSPECIFIED, config())).toThrow(/Unsupported/);
    expect(provider.getContextBudget(simpleRequest)).toMatchObject({
      fits: true,
      maxInputTokens: 800,
    });
  });

  it('excludes display order metadata from token estimates', () => {
    const provider = new OpenAIResponsesProvider(config());
    const withoutOrder: ModelRequest = {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', name: 'read', arguments: { path: '/tmp/a' } }],
        },
      ],
      tools: [],
    };
    const withOrder: ModelRequest = {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call-1', name: 'read', arguments: { path: '/tmp/a' }, block_index: 0 },
          ],
        },
      ],
      tools: [],
    };

    expect(provider.estimateRequestTokens(withOrder)).toBe(
      provider.estimateRequestTokens(withoutOrder),
    );
  });

  it('serializes native instructions, input items, images, tool outputs and incomplete history', async () => {
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
            { type: 'thinking', block_index: 0, text: 'omit native reasoning' },
            { type: 'text', block_index: 1, text: 'I will inspect it.' },
          ],
          tool_calls: [{ id: 'call-complete', name: 'read_image', arguments: { path: 'one.png' } }],
          incomplete_tool_calls: [
            {
              id: 'call-incomplete',
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
          tool_call_id: 'call-complete',
          tool_name: 'read_image',
          status: 'success',
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
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([completed()]));
    const provider = new OpenAIResponsesProvider(config(), fetchMock);
    await collect(provider, request);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://model.example/v1/responses');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-responses-key' });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchInlineSnapshot(`
      {
        "input": [
          {
            "content": [
              {
                "text": "describe",
                "type": "input_text",
              },
              {
                "text": "Attachment: one.png",
                "type": "input_text",
              },
              {
                "detail": "low",
                "image_url": "data:image/png;base64,AQID",
                "type": "input_image",
              },
            ],
            "role": "user",
            "type": "message",
          },
          {
            "content": [
              {
                "annotations": [],
                "text": "I will inspect it.",
                "type": "output_text",
              },
            ],
            "role": "assistant",
            "type": "message",
          },
          {
            "arguments": "{"path":"one.png"}",
            "call_id": "call-complete",
            "name": "read_image",
            "type": "function_call",
          },
          {
            "arguments": "{"path":",
            "call_id": "call-incomplete",
            "name": "edit",
            "type": "function_call",
          },
          {
            "call_id": "call-complete",
            "output": [
              {
                "text": "{"attachment_id":"one"}",
                "type": "input_text",
              },
              {
                "text": "Attachment: one.png",
                "type": "input_text",
              },
              {
                "detail": "low",
                "image_url": "data:image/png;base64,AQID",
                "type": "input_image",
              },
            ],
            "type": "function_call_output",
          },
        ],
        "instructions": "first instruction

      second instruction",
        "max_output_tokens": 200,
        "model": "model-test",
        "store": false,
        "stream": true,
        "tools": [
          {
            "description": "Read an image.",
            "name": "read_image",
            "parameters": {
              "properties": {
                "path": {
                  "type": "string",
                },
              },
              "type": "object",
            },
            "strict": false,
            "type": "function",
          },
        ],
      }
    `);
    expect(JSON.stringify(body)).not.toContain('omit native reasoning');
    expect(provider.estimateRequestTokens(request)).toBeGreaterThan(1024);
  });

  it('streams text, Thinking and parallel calls while keeping item IDs separate from call IDs', async () => {
    const events = [
      data({ type: 'response.reasoning_summary_text.delta', delta: 'Think' }),
      data({ type: 'response.output_text.delta', delta: 'Hel' }),
      data({ type: 'response.output_text.delta', delta: 'lo' }),
      data({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'item-0',
          call_id: 'call-0',
          name: 'read',
          arguments: '',
        },
      }),
      data({
        type: 'response.function_call_arguments.delta',
        item_id: 'item-0',
        output_index: 0,
        delta: '{"path":',
      }),
      data({
        type: 'response.function_call_arguments.done',
        item_id: 'item-0',
        output_index: 0,
        arguments: '{"path":"/tmp/a"}',
      }),
      data({
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'item-1',
          call_id: 'call-1',
          name: 'edit',
          arguments: '',
        },
      }),
      data({
        type: 'response.function_call_arguments.delta',
        item_id: 'item-1',
        output_index: 1,
        delta: '{"path":',
      }),
      completed(),
    ];
    const provider = new OpenAIResponsesProvider(
      config(),
      vi.fn<typeof fetch>().mockResolvedValue(streamResponse(events)),
    );
    const result = await collect(provider, simpleRequest);
    expect(result).toEqual([
      { type: 'thinking_delta', text: 'Think', block_index: 0 },
      { type: 'text_delta', text: 'Hel', block_index: 1 },
      { type: 'text_delta', text: 'lo', block_index: 1 },
      {
        type: 'response',
        message: {
          role: 'assistant',
          content: 'Hello',
          content_blocks: [
            { type: 'thinking', block_index: 0, text: 'Think' },
            { type: 'text', block_index: 1, text: 'Hello' },
          ],
          tool_calls: [
            { id: 'call-0', name: 'read', arguments: { path: '/tmp/a' }, block_index: 2 },
          ],
          incomplete_tool_calls: [
            {
              id: 'call-1',
              name: 'edit',
              arguments_text: '{"path":',
              error: expect.stringContaining('incomplete or invalid'),
            },
          ],
        },
        usage: {
          input_tokens: 20,
          output_tokens: 8,
          total_tokens: 28,
          prompt_tokens_details: { cached_tokens: 6 },
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('item-0');
    expect(JSON.stringify(result)).not.toContain('item-1');
  });

  it('preserves reasoning and function call item order with following text', async () => {
    const provider = new OpenAIResponsesProvider(
      config(),
      vi.fn<typeof fetch>().mockResolvedValue(
        streamResponse([
          data({ type: 'response.reasoning_text.delta', delta: 'First' }),
          data({
            type: 'response.output_item.added',
            output_index: 1,
            item: {
              type: 'function_call',
              id: 'item-1',
              call_id: 'call-0',
              name: 'read',
              arguments: '{}',
            },
          }),
          data({ type: 'response.reasoning_text.delta', delta: 'Second' }),
          data({
            type: 'response.output_item.added',
            output_index: 3,
            item: {
              type: 'function_call',
              id: 'item-3',
              call_id: 'call-1',
              name: 'bash',
              arguments: '{}',
            },
          }),
          data({ type: 'response.output_text.delta', delta: 'After' }),
          completed(),
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
            { id: 'call-0', name: 'read', arguments: {}, block_index: 1 },
            { id: 'call-1', name: 'bash', arguments: {}, block_index: 2 },
          ],
        },
        usage: {
          input_tokens: 20,
          output_tokens: 8,
          total_tokens: 28,
          prompt_tokens_details: { cached_tokens: 6 },
        },
      },
    ]);
  });

  it('parses identical output for whole, fragmented and bytewise CRLF streams', async () => {
    const input = [
      data({ type: 'response.reasoning_text.delta', delta: 'native thinking' }, '\r\n'),
      data({ type: 'response.output_text.delta', delta: 'visible' }, '\r\n'),
      completed().replaceAll('\n', '\r\n'),
    ].join('');
    const expected: ModelEvent[] = [
      { type: 'thinking_delta', text: 'native thinking', block_index: 0 },
      { type: 'text_delta', text: 'visible', block_index: 1 },
      {
        type: 'response',
        message: {
          role: 'assistant',
          content: 'visible',
          content_blocks: [
            { type: 'thinking', block_index: 0, text: 'native thinking' },
            { type: 'text', block_index: 1, text: 'visible' },
          ],
        },
        usage: {
          input_tokens: 20,
          output_tokens: 8,
          total_tokens: 28,
          prompt_tokens_details: { cached_tokens: 6 },
        },
      },
    ];
    for (const chunks of [[input], [input.slice(0, 17), input.slice(17)], [...input]]) {
      const provider = new OpenAIResponsesProvider(
        config(),
        vi.fn<typeof fetch>().mockResolvedValue(streamResponse(chunks)),
      );
      expect(await collect(provider, simpleRequest)).toEqual(expected);
    }
    const bytewise = new OpenAIResponsesProvider(
      config(),
      vi.fn<typeof fetch>().mockResolvedValue(streamResponse([input], true)),
    );
    expect(await collect(bytewise, simpleRequest)).toEqual(expected);
  });

  it('reports native incomplete, failed, error and EOF terminals with safe details', async () => {
    const cases = [
      [
        data({
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage,
          },
        }),
        'max_output_tokens',
      ],
      [
        data({
          type: 'response.failed',
          response: { status: 'failed', error: { message: 'bad secret-responses-key' }, usage },
        }),
        'bad [redacted]',
      ],
      [
        data({ type: 'error', message: 'bad secret-responses-key', code: 'invalid_key' }),
        'bad [redacted]',
      ],
      [
        data({ type: 'response.output_text.delta', delta: 'partial' }),
        'before a terminal response event',
      ],
      [
        `${data({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item-0', call_id: 'call-0', name: 'read', arguments: '' } })}${data({ type: 'response.function_call_arguments.delta', item_id: 'item-0', output_index: 1, delta: '{}' })}`,
        'output index does not match',
      ],
      ['data: not-json\n\n', 'invalid JSON'],
    ] as const;
    for (const [chunk, message] of cases) {
      const provider = new OpenAIResponsesProvider(
        config(),
        vi.fn<typeof fetch>().mockResolvedValue(streamResponse([chunk])),
      );
      const events = await collect(provider, simpleRequest);
      expect(events.at(-1)).toMatchObject({ type: 'stream_interrupted' });
      expect(JSON.stringify(events.at(-1))).toContain(message);
      expect(JSON.stringify(events)).not.toContain('secret-responses-key');
    }
  });

  it('passes AbortSignal, reports timeout and rejects images when vision is disabled', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      return Promise.resolve(streamResponse([completed()]));
    });
    for await (const _event of new OpenAIResponsesProvider(config(), fetchMock).stream(
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
    const timeout = new OpenAIResponsesProvider(
      { ...config(), requestTimeoutMs: 5 },
      timeoutFetch,
    ).stream(simpleRequest, new AbortController().signal);
    await expect(timeout[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'request_timeout',
    });

    const disabledFetch = vi.fn<typeof fetch>();
    const disabled = new OpenAIResponsesProvider(
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
              data({ type: 'response.output_text.delta', delta: 'partial' }),
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
    const provider = new OpenAIResponsesProvider(config(), fetchMock);
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

  it('rejects unresolved attachments and oversized requests before fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const provider: EstimatingModelProvider = new OpenAIResponsesProvider(config(), fetchMock);
    const unresolved = provider.stream(
      {
        messages: [
          {
            role: 'user',
            content: '',
            content_parts: [{ type: 'attachment', attachment_id: 'missing' }],
          },
        ],
        tools: [],
      },
      new AbortController().signal,
    );
    await expect(unresolved[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'invalid_request',
    });
    const oversized = provider.stream(
      { messages: [{ role: 'user', content: 'x'.repeat(16 * 1024 * 1024) }], tools: [] },
      new AbortController().signal,
    );
    await expect(oversized[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'request_too_large',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
