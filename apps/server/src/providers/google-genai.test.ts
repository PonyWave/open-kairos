import type { ModelEvent, ModelProvider, ModelRequest } from '@kairos/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { GoogleGenAIProvider } from './google-genai.js';

const config = () => ({
  baseUrl: 'https://gemini.example/',
  apiKey: 'secret-gemini-key',
  model: 'gemini-test',
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

function data(value: unknown): string {
  return `data: ${JSON.stringify(value)}\r\n\r\n`;
}

function textChunk(text: string, thought = false) {
  return data({
    candidates: [{ content: { parts: [{ text, ...(thought ? { thought } : {}) }] } }],
  });
}

function stopChunk(reason = 'STOP', usage: Record<string, number> | undefined = undefined) {
  return data({
    candidates: [{ finishReason: reason }],
    usageMetadata: usage ?? {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      thoughtsTokenCount: 3,
      cachedContentTokenCount: 2,
    },
  });
}

async function collect(provider: ModelProvider, request: ModelRequest): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of provider.stream(request, new AbortController().signal))
    events.push(event);
  return events;
}

const simpleRequest: ModelRequest = { messages: [{ role: 'user', content: 'hello' }], tools: [] };

describe('GoogleGenAIProvider', () => {
  it('serializes system instruction, content parts, images, tool results and incomplete history', async () => {
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
          tool_calls: [
            { id: 'tool-complete', name: 'read_image', arguments: { path: 'one.png' } },
            { id: 'kairos-gemini-call-1', name: 'list', arguments: {} },
          ],
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
        {
          role: 'tool',
          content: 'listed',
          tool_call_id: 'kairos-gemini-call-1',
          tool_name: 'list',
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
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([stopChunk()]));
    const provider = new GoogleGenAIProvider(config(), fetchMock);
    await collect(provider, request);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://gemini.example/v1beta/models/gemini-test:streamGenerateContent?alt=sse',
    );
    expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'secret-gemini-key' });
    expect(init?.headers).not.toHaveProperty('authorization');
    const body = JSON.parse(String(init?.body));
    expect(body.systemInstruction).toEqual({
      parts: [{ text: 'first instruction\n\nsecond instruction' }],
    });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 200 });
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'read_image',
            description: 'Read an image.',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      },
    ]);
    expect(body.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'describe' },
          { text: 'Attachment: one.png' },
          { inlineData: { mimeType: 'image/png', data: 'AQID' } },
        ],
      },
      {
        role: 'model',
        parts: [
          { text: 'I will inspect it.' },
          {
            functionCall: {
              id: 'tool-complete',
              name: 'read_image',
              args: { path: 'one.png' },
            },
          },
          { functionCall: { name: 'list', args: {} } },
          {
            functionCall: {
              id: 'tool-incomplete',
              name: 'edit',
              args: { _kairos_incomplete_arguments: '{"path":' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'tool-complete',
              name: 'read_image',
              response: { content: '{"attachment_id":"one"}' },
            },
          },
          { text: 'Attachment: one.png' },
          { inlineData: { mimeType: 'image/png', data: 'AQID' } },
          {
            functionResponse: {
              id: 'tool-incomplete',
              name: 'edit',
              response: { content: 'Invalid JSON.', is_error: true },
            },
          },
          {
            functionResponse: { name: 'list', response: { content: 'listed' } },
          },
        ],
      },
    ]);
  });

  it('rejects non-data-URL images before dispatch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const provider = new GoogleGenAIProvider(config(), fetchMock);
    const request: ModelRequest = {
      messages: [
        {
          role: 'user',
          content: 'look',
          content_parts: [
            { type: 'image_url', image_url: { url: 'https://img.example/a.png', detail: 'low' } },
          ],
        },
      ],
      tools: [],
    };
    await expect(collect(provider, request)).rejects.toThrow(
      'Gemini supports image input only from base64 data URLs.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps text, thought and function call parts into deltas and a final response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      streamResponse([
        textChunk('Hello '),
        textChunk('world'),
        textChunk('reasoning', true),
        data({
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: 'read_image', args: { path: 'one.png' } } },
                  { functionCall: { id: 'fc-1', name: 'edit', args: {} } },
                ],
              },
            },
          ],
        }),
        stopChunk(),
      ]),
    );
    const provider = new GoogleGenAIProvider(config(), fetchMock);
    const events = await collect(provider, simpleRequest);
    expect(events).toEqual([
      { type: 'text_delta', text: 'Hello ', block_index: 0 },
      { type: 'text_delta', text: 'world', block_index: 0 },
      { type: 'thinking_delta', text: 'reasoning', block_index: 1 },
      {
        type: 'response',
        message: {
          role: 'assistant',
          content: 'Hello world',
          content_blocks: [
            { type: 'text', block_index: 0, text: 'Hello world' },
            { type: 'thinking', block_index: 1, text: 'reasoning' },
          ],
          tool_calls: [
            {
              id: 'kairos-gemini-call-0',
              name: 'read_image',
              arguments: { path: 'one.png' },
              block_index: 2,
            },
            { id: 'fc-1', name: 'edit', arguments: {}, block_index: 2 },
          ],
        },
        usage: {
          input_tokens: 10,
          output_tokens: 8,
          total_tokens: 18,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      },
    ]);
  });

  it('reassembles byte-wise streams', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        streamResponse(
          [textChunk('Hello'), stopChunk('STOP', { promptTokenCount: 1, candidatesTokenCount: 1 })],
          true,
        ),
      );
    const provider = new GoogleGenAIProvider(config(), fetchMock);
    const events = await collect(provider, simpleRequest);
    expect(events.at(-1)).toMatchObject({
      type: 'response',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  });

  it.each([
    ['MAX_TOKENS', 'The provider stopped with reason MAX_TOKENS.'],
    ['SAFETY', 'The provider stopped with reason SAFETY.'],
    ['MALFORMED_FUNCTION_CALL', 'The provider stopped with reason MALFORMED_FUNCTION_CALL.'],
  ])('reports finish reason %s as an interruption', async (reason, message) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(streamResponse([textChunk('partial'), stopChunk(reason)]));
    const provider = new GoogleGenAIProvider(config(), fetchMock);
    const events = await collect(provider, simpleRequest);
    expect(events.at(-1)).toEqual({
      type: 'stream_interrupted',
      error: { code: 'stream_interrupted', message },
      usage: {
        input_tokens: 10,
        output_tokens: 8,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    });
  });

  it('reports a blocked prompt as an interruption', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        streamResponse([data({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })]),
      );
    const provider = new GoogleGenAIProvider(config(), fetchMock);
    const events = await collect(provider, simpleRequest);
    expect(events.at(-1)).toEqual({
      type: 'stream_interrupted',
      error: {
        code: 'stream_interrupted',
        message: 'The provider blocked the prompt with reason PROHIBITED_CONTENT.',
      },
    });
  });

  it('reports streams without a finish reason or usage as interruptions', async () => {
    const missingReason = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        streamResponse([
          textChunk('Hello'),
          data({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
        ]),
      );
    const events = await collect(new GoogleGenAIProvider(config(), missingReason), simpleRequest);
    expect(events.at(-1)).toMatchObject({
      type: 'stream_interrupted',
      error: { message: 'The provider stream did not include a finish reason.' },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const missingUsage = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        streamResponse([textChunk('Hello'), data({ candidates: [{ finishReason: 'STOP' }] })]),
      );
    const usageEvents = await collect(
      new GoogleGenAIProvider(config(), missingUsage),
      simpleRequest,
    );
    expect(usageEvents.at(-1)).toMatchObject({
      type: 'stream_interrupted',
      error: { message: 'The provider stream did not include complete token usage.' },
    });
  });

  it('reports invalid JSON and truncated streams as interruptions', async () => {
    const invalid = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(['data: {broken\n\n']));
    const events = await collect(new GoogleGenAIProvider(config(), invalid), simpleRequest);
    expect(events.at(-1)).toMatchObject({
      type: 'stream_interrupted',
      error: { message: 'The provider returned invalid JSON.' },
    });
    const truncated = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([textChunk('Hello')]));
    const truncatedEvents = await collect(
      new GoogleGenAIProvider(config(), truncated),
      simpleRequest,
    );
    expect(truncatedEvents.at(-1)).toMatchObject({
      type: 'stream_interrupted',
      error: { message: 'The provider stream did not include a finish reason.' },
    });
  });

  it('maps source messages onto merged Gemini contents', async () => {
    const provider = new GoogleGenAIProvider(
      config(),
      vi.fn<typeof fetch>().mockResolvedValue(streamResponse([stopChunk()])),
    );
    const request: ModelRequest = {
      messages: [
        { role: 'system', content: 'instruction' },
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', name: 'read', arguments: {} }],
        },
        { role: 'tool', content: 'done', tool_call_id: 'call-1', tool_name: 'read' },
      ],
      tools: [],
    };
    expect(provider.mapMessageIndex(request, 1)).toBe(0);
    expect(provider.mapMessageSource(request, 2)).toEqual({
      messageIndex: 0,
      contentBlockIndexes: [1],
    });
    expect(provider.mapMessageSource(request, 4)).toEqual({
      messageIndex: 2,
      contentBlockIndexes: [0],
    });
    expect(() => provider.mapMessageIndex(request, 0)).toThrow(
      'The source message has no content in the Gemini request.',
    );
  });
});
