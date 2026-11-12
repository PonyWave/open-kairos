import type { ModelEvent, ModelRequest } from '@kairos/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { jpegBytes, pngBytes } from '../attachments/fixtures.js';
import { ModelInputService } from '../context/model-input-service.js';
import { seedTestSession } from '../integration/test-authentication.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { OpenAICompatibleProvider, ProviderError } from './openai-compatible.js';

const request: ModelRequest = {
  messages: [{ role: 'user', content: 'hello' }],
  tools: [
    {
      name: 'read',
      description: 'Read a file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
};

function config() {
  return {
    baseUrl: 'https://model.example/v1/',
    apiKey: 'secret-test-key',
    model: 'model-test',
    contextWindow: 1000,
    outputReserve: 200,
  };
}

function streamResponse(events: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function data(value: unknown): string {
  return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
}

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return { choices: [{ delta, finish_reason: finishReason }] };
}

function usage(): Record<string, unknown> {
  return {
    choices: [],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

async function collect(provider: OpenAICompatibleProvider): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of provider.stream(request, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

describe('OpenAICompatibleProvider', () => {
  it('validates configuration and reports token budget', () => {
    expect(() => new OpenAICompatibleProvider({ ...config(), outputReserve: 1000 })).toThrow(
      ProviderError,
    );
    const provider = new OpenAICompatibleProvider(config());
    expect(provider.estimateTextTokens('abcd中')).toBe(2);
    expect(provider.getContextBudget(request)).toMatchObject({
      contextWindow: 1000,
      outputReserve: 200,
      maxInputTokens: 800,
      fits: true,
    });
  });

  it('excludes display order metadata from token estimates', () => {
    const provider = new OpenAICompatibleProvider(config());
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

  it('streams text and complete tool calls with actual usage', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      streamResponse([
        data(chunk({ content: 'Hel' })),
        data(chunk({ content: 'lo' })),
        data(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                type: 'function',
                function: { name: 'read', arguments: '{"path":' },
              },
            ],
          }),
        ),
        data(
          chunk(
            {
              tool_calls: [{ index: 0, function: { arguments: '"/tmp/a"}' } }],
            },
            'tool_calls',
          ),
        ),
        data(usage()),
        data('[DONE]'),
      ]),
    );
    const provider = new OpenAICompatibleProvider(config(), fetchMock);
    const events = await collect(provider);

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel', block_index: 0 },
      { type: 'text_delta', text: 'lo', block_index: 0 },
      {
        type: 'response',
        message: {
          role: 'assistant',
          content: 'Hello',
          content_blocks: [{ type: 'text', block_index: 0, text: 'Hello' }],
          tool_calls: [
            { id: 'call-1', name: 'read', arguments: { path: '/tmp/a' }, block_index: 1 },
          ],
        },
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    ]);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('Expected fetch to be called.');
    const [url, init] = call;
    expect(url).toBe('https://model.example/v1/chat/completions');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-test-key' });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'model-test',
      max_tokens: 200,
      stream_options: { include_usage: true },
    });
  });

  it('preserves Thinking, tool and text order across streamed deltas', async () => {
    const provider = new OpenAICompatibleProvider(
      config(),
      vi.fn<typeof fetch>().mockResolvedValue(
        streamResponse([
          data(chunk({ reasoning_content: 'First' })),
          data(
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: 'call-0',
                  type: 'function',
                  function: { name: 'read', arguments: '{}' },
                },
              ],
            }),
          ),
          data(chunk({ reasoning_content: 'Second' })),
          data(
            chunk({
              tool_calls: [
                {
                  index: 1,
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'bash', arguments: '{}' },
                },
              ],
            }),
          ),
          data(chunk({ content: 'After' })),
          data(usage()),
          data('[DONE]'),
        ]),
      ),
    );

    expect(await collect(provider)).toEqual([
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
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    ]);
  });

  it('preserves reported cached prompt tokens without inventing missing cache usage', async () => {
    const cachedUsage = {
      choices: [],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 9 },
      },
    };
    const provider = new OpenAICompatibleProvider(
      config(),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          streamResponse([data(chunk({ content: 'cached' })), data(cachedUsage), data('[DONE]')]),
        ),
    );
    const events = await collect(provider);
    expect(events.at(-1)).toMatchObject({
      type: 'response',
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 9 },
      },
    });
    const withoutDetails = new OpenAICompatibleProvider(
      config(),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          streamResponse([data(chunk({ content: 'uncached' })), data(usage()), data('[DONE]')]),
        ),
    );
    const withoutCacheEvents = await collect(withoutDetails);
    expect(withoutCacheEvents.at(-1)).toMatchObject({
      type: 'response',
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    });
    expect(withoutCacheEvents.at(-1)).not.toHaveProperty('usage.prompt_tokens_details');
  });

  it('preserves ordered plain reasoning fragments as multiple Thinking blocks', async () => {
    const provider = new OpenAICompatibleProvider(
      config(),
      vi.fn<typeof fetch>().mockResolvedValue(
        streamResponse([
          data(chunk({ reasoning_content: '', content: '' })),
          data(
            chunk({
              reasoning_content: 'Think',
              reasoning_summary: [{ text: 'summary must not be shown' }],
              encrypted_content: 'encrypted must not be shown',
              redacted_reasoning: 'redacted must not be shown',
              content: 'A',
            }),
          ),
          data(
            chunk({
              reasoning_content: ' more',
              reasoning: 'the other alias stays unused',
              content: '',
            }),
          ),
          data(chunk({ reasoning: 'still unused', content: 'B' })),
          data(usage()),
          data('[DONE]'),
        ]),
      ),
    );

    expect(await collect(provider)).toEqual([
      { type: 'thinking_delta', text: 'Think', block_index: 0 },
      { type: 'text_delta', text: 'A', block_index: 1 },
      { type: 'thinking_delta', text: ' more', block_index: 2 },
      { type: 'text_delta', text: 'B', block_index: 3 },
      {
        type: 'response',
        message: {
          role: 'assistant',
          content: 'AB',
          content_blocks: [
            { type: 'thinking', block_index: 0, text: 'Think' },
            { type: 'text', block_index: 1, text: 'A' },
            { type: 'thinking', block_index: 2, text: ' more' },
            { type: 'text', block_index: 3, text: 'B' },
          ],
        },
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    ]);
  });

  it('supports Thinking-only responses and omits blocks for empty responses', async () => {
    const thinkingOnly = new OpenAICompatibleProvider(
      config(),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          streamResponse([
            data(chunk({ reasoning_text: 'actual reasoning' })),
            data(usage()),
            data('[DONE]'),
          ]),
        ),
    );
    expect(await collect(thinkingOnly)).toEqual([
      { type: 'thinking_delta', text: 'actual reasoning', block_index: 0 },
      {
        type: 'response',
        message: {
          role: 'assistant',
          content: '',
          content_blocks: [{ type: 'thinking', block_index: 0, text: 'actual reasoning' }],
        },
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    ]);

    const empty = new OpenAICompatibleProvider(
      config(),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          streamResponse([
            data(chunk({ reasoning: '', reasoning_content: '', reasoning_text: '', content: '' })),
            data(usage()),
            data('[DONE]'),
          ]),
        ),
    );
    expect(await collect(empty)).toEqual([
      {
        type: 'response',
        message: { role: 'assistant', content: '' },
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    ]);
  });

  it('treats nullish reasoning as absent without interrupting normal text', async () => {
    const provider = new OpenAICompatibleProvider(
      config(),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          streamResponse([
            data(chunk({ reasoning_content: null, content: 'visible' })),
            data(chunk({ reasoning: null, reasoning_text: null })),
            data(chunk({ reasoning: '', reasoning_text: '' })),
            data(usage()),
            data('[DONE]'),
          ]),
        ),
    );

    expect(await collect(provider)).toEqual([
      { type: 'text_delta', text: 'visible', block_index: 0 },
      {
        type: 'response',
        message: {
          role: 'assistant',
          content: 'visible',
          content_blocks: [{ type: 'text', block_index: 0, text: 'visible' }],
        },
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      },
    ]);
  });

  it.each(['reasoning_content', 'reasoning', 'reasoning_text'])(
    'interrupts the stream when %s is not a string',
    async (alias) => {
      for (const value of [42, { summary: 'not plain text' }, ['not plain text']]) {
        const provider = new OpenAICompatibleProvider(
          config(),
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(
              streamResponse([data(chunk({ [alias]: value })), data(usage()), data('[DONE]')]),
            ),
        );
        const events = await collect(provider);
        expect(events).toEqual([
          {
            type: 'stream_interrupted',
            error: {
              code: 'stream_interrupted',
              message: 'The provider returned an invalid reasoning field.',
            },
          },
        ]);
      }
    },
  );

  it('keeps Thinking out of later model input and token estimates', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(streamResponse([data(usage()), data('[DONE]')]));
    const provider = new OpenAICompatibleProvider(config(), fetchMock);
    const assistant = {
      role: 'assistant' as const,
      content: 'visible',
      content_blocks: [
        { type: 'thinking' as const, block_index: 0, text: 'private reasoning' },
        { type: 'text' as const, block_index: 1, text: 'visible' },
      ],
    };
    const withBlocks: ModelRequest = { messages: [assistant], tools: [] };
    const withoutBlocks: ModelRequest = {
      messages: [{ role: 'assistant', content: 'visible' }],
      tools: [],
    };
    expect(provider.estimateRequestTokens(withBlocks)).toBe(
      provider.estimateRequestTokens(withoutBlocks),
    );

    for await (const _event of provider.stream(withBlocks, new AbortController().signal)) {
      // Consume the complete response.
    }
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.messages).toEqual([{ role: 'assistant', content: 'visible' }]);
    expect(JSON.stringify(body)).not.toContain('private reasoning');
  });

  it('returns malformed tool arguments as incomplete calls without executing them', async () => {
    const provider = new OpenAICompatibleProvider(
      config(),
      vi.fn<typeof fetch>().mockResolvedValue(
        streamResponse([
          data(
            chunk(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-bad',
                    type: 'function',
                    function: { name: 'edit', arguments: '{"path":' },
                  },
                ],
              },
              'tool_calls',
            ),
          ),
          data(usage()),
          data('[DONE]'),
        ]),
      ),
    );

    const events = await collect(provider);
    expect(events.at(-1)).toMatchObject({
      type: 'response',
      message: {
        incomplete_tool_calls: [{ id: 'call-bad', name: 'edit', arguments_text: '{"path":' }],
      },
    });
    expect(events.at(-1)).not.toHaveProperty('message.tool_calls');
  });

  it('preserves incomplete call and tool result correlation in later requests', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(streamResponse([data(usage()), data('[DONE]')]));
    const provider = new OpenAICompatibleProvider(config(), fetchMock);
    const history: ModelRequest = {
      messages: [
        {
          role: 'assistant',
          content: '',
          incomplete_tool_calls: [
            {
              id: 'incomplete-1-0',
              name: 'edit',
              arguments_text: '{"path":',
              error: 'Invalid JSON.',
            },
          ],
        },
        {
          role: 'tool',
          content: 'Invalid JSON.',
          tool_call_id: 'incomplete-1-0',
          tool_name: 'edit',
          status: 'error',
        },
      ],
      tools: [],
    };
    for await (const _event of provider.stream(history, new AbortController().signal)) {
      // Consume the complete response.
    }
    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    expect(body.messages[0].tool_calls).toEqual([
      {
        id: 'incomplete-1-0',
        type: 'function',
        function: { name: 'edit', arguments: '{"path":' },
      },
    ]);
    expect(body.messages[1].tool_call_id).toBe('incomplete-1-0');
  });

  it('rejects missing incomplete call IDs instead of inferring them from later results', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const provider = new OpenAICompatibleProvider(config(), fetchMock);
    const history: ModelRequest = {
      messages: [
        {
          role: 'assistant',
          content: '',
          incomplete_tool_calls: [
            { name: 'edit', arguments_text: '{"path":', error: 'Invalid JSON.' },
          ],
        },
        {
          role: 'tool',
          content: 'Result from a different call.',
          tool_call_id: 'incomplete-other-run-1-1',
          tool_name: 'edit',
          status: 'error',
        },
      ],
      tools: [],
    };
    const consume = async () => {
      for await (const _event of provider.stream(history, new AbortController().signal)) {
        // Consume the complete response.
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses the same multiline data event identically across CR/LF fragmentations', async () => {
    const expected: ModelEvent[] = [
      {
        type: 'response',
        message: { role: 'assistant', content: '' },
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    ];
    const parse = async (fragments: readonly string[]) => {
      const provider = new OpenAICompatibleProvider(
        config(),
        vi.fn<typeof fetch>().mockResolvedValue(streamResponse(fragments)),
      );
      return collect(provider);
    };

    for (const ending of ['\n', '\r', '\r\n']) {
      const input = [
        'data: {"choices":[],"usage":',
        'data: {"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
        '',
        'data: [DONE]',
        '',
        '',
      ].join(ending);
      expect(await parse([input])).toEqual(expected);
      for (let split = 1; split < input.length; split += 1) {
        expect(await parse([input.slice(0, split), input.slice(split)])).toEqual(expected);
      }
      expect(await parse([...input])).toEqual(expected);
    }
  });

  it('keeps invalid multiline JSON interrupted for whole and fragmented input', async () => {
    const input = ['data: {"choices":', 'data: not-json}', '', 'data: [DONE]', '', ''].join('\r\n');
    const firstCR = input.indexOf('\r');
    const variants = [[input], [input.slice(0, firstCR + 1), input.slice(firstCR + 1)], [...input]];
    for (const fragments of variants) {
      const provider = new OpenAICompatibleProvider(
        config(),
        vi.fn<typeof fetch>().mockResolvedValue(streamResponse(fragments)),
      );
      expect((await collect(provider)).at(-1)).toMatchObject({
        type: 'stream_interrupted',
        error: { message: 'The provider returned invalid JSON.' },
      });
    }
  });

  it('reports interrupted streams and invalid network data', async () => {
    const interrupted = new OpenAICompatibleProvider(
      config(),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(streamResponse([data(chunk({ content: 'partial' }))])),
    );
    expect((await collect(interrupted)).at(-1)).toMatchObject({
      type: 'stream_interrupted',
      error: { code: 'stream_interrupted' },
    });

    const invalid = new OpenAICompatibleProvider(
      config(),
      vi.fn<typeof fetch>().mockResolvedValue(streamResponse([data({ choices: 'wrong' })])),
    );
    expect((await collect(invalid)).at(-1)).toMatchObject({ type: 'stream_interrupted' });
  });

  it('passes the caller AbortSignal to fetch', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      return Promise.resolve(streamResponse([data(usage()), data('[DONE]')]));
    });
    const provider = new OpenAICompatibleProvider(config(), fetchMock);
    for await (const _event of provider.stream(request, controller.signal)) {
      // Consume the complete response.
    }
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('redacts credentials from stream errors', async () => {
    const provider = new OpenAICompatibleProvider(
      config(),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          streamResponse([
            data({ choices: [], error: { message: 'bad secret-test-key', code: 'invalid_key' } }),
          ]),
        ),
    );
    const events = await collect(provider);
    expect(events.at(-1)).toEqual({
      type: 'stream_interrupted',
      error: {
        code: 'stream_interrupted',
        message: 'The provider returned an error: bad [redacted]',
      },
    });
    expect(JSON.stringify(events)).not.toContain('secret-test-key');
  });

  it('redacts credentials from HTTP errors', async () => {
    const provider = new OpenAICompatibleProvider(
      config(),
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'bad secret-test-key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const events = provider.stream(request, new AbortController().signal);
    const next = events[Symbol.asyncIterator]().next();
    await expect(next).rejects.toThrow('HTTP 401: bad [redacted]');
    await expect(next).rejects.not.toThrow('secret-test-key');
  });

  it('serializes real image_url content blocks and budgets low-detail images', async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`;
    const multimodal: ModelRequest = {
      messages: [
        { role: 'system', content: 'system text' },
        {
          role: 'user',
          content: 'describe this',
          content_parts: [
            { type: 'text', text: 'Attachment: image.png' },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
          ],
        },
      ],
      tools: [],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        streamResponse([data(chunk({ content: 'ok' })), data(usage()), data('[DONE]')]),
      );
    const provider = new OpenAICompatibleProvider(config(), fetchMock);
    for await (const _event of provider.stream(multimodal, new AbortController().signal)) {
      // Consume the response.
    }
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body)).messages).toEqual([
      { role: 'system', content: 'system text' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'text', text: 'Attachment: image.png' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        ],
      },
    ]);
    const withoutParts: ModelRequest = {
      ...multimodal,
      messages: multimodal.messages.map((message) =>
        message.role === 'user' ? { role: 'user', content: message.content } : message,
      ),
    };
    expect(
      provider.estimateRequestTokens(multimodal) - provider.estimateRequestTokens(withoutParts),
    ).toBe(provider.estimateTextTokens('Attachment: image.png') + 1024);
  });

  it('keeps tool results textual and moves image content to a following user message', async () => {
    const dataUrl = `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}`;
    const multimodal: ModelRequest = {
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'image-call', name: 'read_image', arguments: { path: 'a.jpg' } }],
        },
        {
          role: 'tool',
          content: '{"attachment_id":"image-1"}',
          content_parts: [
            { type: 'text', text: 'Attachment: a.jpg' },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
          ],
          tool_call_id: 'image-call',
          tool_name: 'read_image',
        },
      ],
      tools: [],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        streamResponse([data(chunk({ content: 'ok' })), data(usage()), data('[DONE]')]),
      );
    const provider = new OpenAICompatibleProvider(config(), fetchMock);
    for await (const _event of provider.stream(multimodal, new AbortController().signal)) {
      // Consume the response.
    }
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body)).messages.slice(1)).toEqual([
      {
        role: 'tool',
        content: '{"attachment_id":"image-1"}',
        tool_call_id: 'image-call',
        name: 'read_image',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image content from preceding tool results.' },
          { type: 'text', text: 'Tool result image-call:' },
          { type: 'text', text: 'Attachment: a.jpg' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        ],
      },
    ]);
    expect(provider.estimateRequestTokens(multimodal)).toBeGreaterThan(1024);
  });

  it('serializes consecutive recovered image results only after every tool result', async () => {
    const database = openDatabase(':memory:');
    try {
      const ownerId = 'owner-1';
      seedTestSession(database, ownerId, 'provider-session');
      const store = new SessionStore(database);
      const thread = store.createThread({
        ownerId,
        clientActionId: 'create-image-recovery-thread',
        method: 'CreateThread',
        parameters: {},
        title: 'image recovery',
      });
      const sent = store.sendMessage({
        ownerId,
        clientActionId: 'send-image-recovery-input',
        method: 'SendMessage',
        parameters: {},
        threadId: thread.threadId,
        text: 'inspect',
        mode: 'follow_up',
      });
      store.appendModelMessage({
        runId: sent.runId,
        inputId: sent.input.inputId,
        message: { role: 'user', content: 'inspect' },
      });
      store.appendModelMessage({
        runId: sent.runId,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'image-call-1', name: 'read_image', arguments: { path: 'one.png' } },
            { id: 'image-call-2', name: 'read_image', arguments: { path: 'two.jpg' } },
          ],
        },
      });
      const images = [
        { callId: 'image-call-1', fileName: 'one.png', bytes: pngBytes },
        { callId: 'image-call-2', fileName: 'two.jpg', bytes: jpegBytes },
      ];
      for (const [index, image] of images.entries()) {
        const attachment = store.attachments.upload({
          ownerId,
          clientActionId: `upload-recovered-image-${index}`,
          fileName: image.fileName,
          bytes: image.bytes,
        }).attachment;
        const saved = store.appendModelMessage({
          runId: sent.runId,
          message: {
            role: 'tool',
            content: JSON.stringify({ attachment_id: attachment.attachmentId }),
            content_parts: [{ type: 'attachment', attachment_id: attachment.attachmentId }],
            tool_call_id: image.callId,
            tool_name: 'read_image',
            status: 'success',
          },
        });
        store.attachments.linkMessage(saved.seq, ownerId, [attachment.attachmentId]);
      }
      const service = new ModelInputService(database, { countTokens: () => 1 });
      await service.prepare({
        threadId: thread.threadId,
        agentId: 'thread',
        requestId: 'recovered-image-request',
        systemInstructions: [],
        tools: [],
        contextWindowTokens: 128_000,
      });
      const recovered = new ModelInputService(database, {
        countTokens: () => 1,
      }).getRequestRecord('recovered-image-request')?.request;
      if (!recovered) throw new Error('The recovered model request is missing.');
      expect(recovered.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'tool',
      ]);

      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          streamResponse([data(chunk({ content: 'ok' })), data(usage()), data('[DONE]')]),
        );
      const provider = new OpenAICompatibleProvider(config(), fetchMock);
      const materialized = store.attachments.materializeRequest(recovered);
      for await (const _event of provider.stream(materialized, new AbortController().signal)) {
        // Consume the response.
      }
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'tool',
        'user',
      ]);
      for (const message of body.messages.filter(
        (candidate: { role: string }) => candidate.role === 'tool',
      )) {
        expect(typeof message.content).toBe('string');
        expect(JSON.stringify(message)).not.toContain('image_url');
      }
      const supplemental = body.messages.at(-1);
      expect(supplemental.content.map((part: { type: string }) => part.type)).toEqual([
        'text',
        'text',
        'text',
        'image_url',
        'text',
        'text',
        'image_url',
      ]);
      expect(supplemental.content).toEqual([
        { type: 'text', text: 'Image content from preceding tool results.' },
        { type: 'text', text: 'Tool result image-call-1:' },
        { type: 'text', text: 'Attachment: one.png' },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${Buffer.from(pngBytes).toString('base64')}`,
            detail: 'low',
          },
        },
        { type: 'text', text: 'Tool result image-call-2:' },
        { type: 'text', text: 'Attachment: two.jpg' },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${Buffer.from(jpegBytes).toString('base64')}`,
            detail: 'low',
          },
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('rejects image input when the configured model does not support vision', async () => {
    const multimodal: ModelRequest = {
      messages: [
        {
          role: 'tool',
          content: '{}',
          content_parts: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AQID', detail: 'low' },
            },
          ],
          tool_call_id: 'image-call',
          tool_name: 'read_image',
        },
      ],
      tools: [],
    };
    const fetchMock = vi.fn<typeof fetch>();
    const provider = new OpenAICompatibleProvider(
      { ...config(), supportsVision: false },
      fetchMock,
    );
    expect(() => provider.estimateRequestTokens(multimodal)).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    const stream = provider.stream(multimodal, new AbortController().signal);
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unresolved attachments and requests above 16 MiB before fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const provider = new OpenAICompatibleProvider(config(), fetchMock);
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
