import type { ModelEvent } from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicMessagesProvider } from '../providers/anthropic-messages.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import { OpenAIResponsesProvider } from '../providers/openai-responses.js';
import { buildRecapGenerationRequest, RecapModelGenerator } from './generation.js';
import type { RecapGenerationInput } from './generation-types.js';

const usage = {
  input_tokens: 20,
  output_tokens: 4,
  total_tokens: 24,
  prompt_tokens_details: { cached_tokens: 12 },
};

function input(): RecapGenerationInput {
  return {
    threadId: 'thread',
    agentId: 'thread',
    sourceMessageSeqs: [4, 9],
    sourceMessageIndexes: [
      { seq: 4, messageIndex: 1 },
      { seq: 9, messageIndex: 2 },
    ],
    messages: [],
    request: {
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'first original' },
        { role: 'assistant', content: 'second original' },
      ],
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
    },
    viewVersion: 3,
    trigger: 'periodic',
  };
}

function response(
  content: string,
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): ModelEvent[] {
  return [
    {
      type: 'response',
      message: {
        role: 'assistant',
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      usage,
    },
  ];
}

describe('unified Recap generation', () => {
  it('preserves the complete prefix and appends only the one-sentence source instruction', () => {
    const generation = input();
    const before = JSON.stringify(generation.request);
    const request = buildRecapGenerationRequest(generation);
    expect(JSON.stringify(generation.request)).toBe(before);
    expect(request.messages.slice(0, -1)).toEqual(generation.request.messages);
    expect(JSON.stringify(request.messages.slice(0, -1))).toBe(
      JSON.stringify(generation.request.messages),
    );
    expect(request.tools).toEqual(generation.request.tools);
    expect(request.messages.at(-1)).toEqual({
      role: 'user',
      content: expect.stringContaining('[{"seq":4,"message_index":1},{"seq":9,"message_index":2}]'),
    });
    const instruction = request.messages.at(-1)?.content ?? '';
    expect(instruction).toContain('instruction version 4');
    expect(instruction).toContain('Return exactly one concise plain-text sentence');
    expect(instruction).toContain(
      'at most 30 Unicode characters after trimming surrounding whitespace',
    );
    expect(instruction).toContain(
      'Include only the main goal and new or changed outcomes, decisions, blockers, or next steps.',
    );
    expect(instruction).toContain(
      'Do not restate unchanged information from existing Recaps or repeat facts within the sources.',
    );
    expect(instruction).toContain(
      'Omit secondary details, process narration, and Context sequence references.',
    );
    expect(instruction).toContain('Do not describe unknown work as completed.');
    expect(instruction).not.toContain('Preserve requirements, progress');
  });

  it('lists prior Recaps with their source ranges as context-only continuation anchors', () => {
    const generation = input();
    const request = buildRecapGenerationRequest({
      ...generation,
      priorRecaps: [
        { sourceSeqStart: 1, sourceSeqEnd: 3, content: 'earlier recap' },
        { sourceSeqStart: 4, sourceSeqEnd: 8, content: 'latest recap' },
      ],
    });
    const instruction = request.messages.at(-1)?.content ?? '';
    expect(instruction).toContain(
      'they are context only: continue from where they end, and do not summarize or restate them:\n' +
        '[{"source_seq_start":1,"source_seq_end":3,"content":"earlier recap"},' +
        '{"source_seq_start":4,"source_seq_end":8,"content":"latest recap"}]\n',
    );
    const withoutPrior = buildRecapGenerationRequest(generation);
    expect(withoutPrior.messages.at(-1)?.content).not.toContain('source_seq_end');
    const withEmptyPrior = buildRecapGenerationRequest({ ...generation, priorRecaps: [] });
    expect(withEmptyPrior.messages.at(-1)?.content).not.toContain('source_seq_end');
  });

  it('returns 30 Unicode characters after trimming and preserves the actual cache usage', async () => {
    const content = `${'字'.repeat(29)}🙂`;
    const provider = new ScriptedProvider([response(`  ${content}  `)]);
    const output = await new RecapModelGenerator(provider).generate(
      input(),
      new AbortController().signal,
    );
    expect(Array.from(content)).toHaveLength(30);
    expect(output).toEqual({ content, usage });
    expect(provider.requests).toHaveLength(1);
  });

  it.each([
    { name: 'empty', events: response('   '), error: /empty response/ },
    {
      name: 'over 30 Unicode characters',
      events: response(`${'字'.repeat(30)}🙂`),
      error: /31 Unicode characters after trimming; the limit is 30/,
    },
    {
      name: 'tool call',
      events: response('recap', [{ id: 'call', name: 'read', arguments: {} }]),
      error: /tool call/,
    },
    {
      name: 'interrupted or truncated',
      events: [
        {
          type: 'stream_interrupted',
          error: { code: 'stream_interrupted', message: 'finish reason length' },
          usage,
        },
      ],
      error: /finish reason length/,
    },
    { name: 'missing complete response', events: [], error: /empty response/ },
  ] satisfies Array<{ name: string; events: readonly ModelEvent[]; error: RegExp }>)(
    'rejects $name responses',
    async ({ events, error }) => {
      const provider = new ScriptedProvider([events]);
      await expect(
        new RecapModelGenerator(provider).generate(input(), new AbortController().signal),
      ).rejects.toThrow(error);
    },
  );
});

describe('Recap source indexes in the final Provider request', () => {
  it('keeps a later hard-cut source aligned after an image tool result', async () => {
    const generation = input();
    generation.trigger = 'hard_cut';
    generation.sourceMessageSeqs = [9];
    generation.sourceMessageIndexes = [{ seq: 9, messageIndex: 3 }];
    generation.request.messages = [
      { role: 'system', content: 'system' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'image-call', name: 'read_image', arguments: { path: 'one.png' } }],
      },
      {
        role: 'tool',
        content: '{"attachment_id":"image-1"}',
        content_parts: [
          { type: 'text', text: 'Attachment: one.png' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AQID', detail: 'low' },
          },
        ],
        tool_call_id: 'image-call',
        tool_name: 'read_image',
      },
      { role: 'user', content: 'later source' },
    ];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        `${data({ choices: [{ delta: { content: 'recap' }, finish_reason: 'stop' }] })}${data({
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        })}data: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const provider = new OpenAICompatibleProvider(
      {
        baseUrl: 'https://model.example/v1',
        model: 'model-test',
        contextWindow: 1000,
        outputReserve: 100,
      },
      fetchMock,
    );
    await new RecapModelGenerator(provider).generate(generation, new AbortController().signal);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.messages[4]).toMatchObject({ role: 'user', content: 'later source' });
    expect(body.messages.at(-1)?.content).toContain('{"seq":9,"message_index":4}');
  });

  function expandedGeneration(): RecapGenerationInput {
    const generation = input();
    generation.trigger = 'hard_cut';
    generation.sourceMessageSeqs = [4, 5, 6, 9];
    generation.sourceMessageIndexes = [
      { seq: 4, messageIndex: 1 },
      { seq: 5, messageIndex: 2 },
      { seq: 6, messageIndex: 3 },
      { seq: 9, messageIndex: 4 },
    ];
    generation.request.messages = [
      { role: 'system', content: 'system' },
      {
        role: 'assistant',
        content: 'inspect images',
        tool_calls: [
          { id: 'image-1', name: 'read_image', arguments: { path: 'one.png' } },
          { id: 'image-2', name: 'read_image', arguments: { path: 'two.png' } },
        ],
      },
      {
        role: 'tool',
        content: '{"attachment_id":"one"}',
        content_parts: [
          { type: 'text', text: 'Attachment: one.png' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID', detail: 'low' } },
        ],
        tool_call_id: 'image-1',
        tool_name: 'read_image',
      },
      {
        role: 'tool',
        content: '{"attachment_id":"two"}',
        tool_call_id: 'image-2',
        tool_name: 'read_image',
      },
      { role: 'user', content: 'later source' },
    ];
    return generation;
  }

  function sourceMappings(instruction: string): unknown {
    const match = instruction.match(/\[\{"seq":.*\}\]/);
    if (!match) throw new Error('Missing source mappings in the Recap instruction.');
    return JSON.parse(match[0]);
  }

  it('maps expanded Responses input items without including the appended instruction', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        `${data({ type: 'response.output_text.delta', delta: 'recap' })}${data({
          type: 'response.completed',
          response: {
            status: 'completed',
            usage: {
              input_tokens: 20,
              output_tokens: 4,
              total_tokens: 24,
              input_tokens_details: { cached_tokens: 12 },
            },
          },
        })}`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const provider = new OpenAIResponsesProvider(
      {
        baseUrl: 'https://model.example/v1',
        model: 'model-test',
        contextWindow: 1000,
        outputReserve: 100,
      },
      fetchMock,
    );
    await new RecapModelGenerator(provider).generate(
      expandedGeneration(),
      new AbortController().signal,
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.instructions).toBe('system');
    expect(body.input).toHaveLength(7);
    expect(body.input.slice(0, 3).map((item: { type: string }) => item.type)).toEqual([
      'message',
      'function_call',
      'function_call',
    ]);
    expect(body.input[3].type).toBe('function_call_output');
    expect(body.input[5].content).toBe('later source');
    expect(sourceMappings(body.input.at(-1).content)).toEqual([
      { seq: 4, input_item_indexes: [0, 1, 2] },
      { seq: 5, input_item_indexes: [3] },
      { seq: 6, input_item_indexes: [4] },
      { seq: 9, input_item_indexes: [5] },
    ]);
  });

  it('maps merged Anthropic content blocks without aliasing sources or summarizing the instruction', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        `${data({
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 14,
              output_tokens: 1,
              cache_read_input_tokens: 6,
            },
          },
        })}${data({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: 'recap' },
        })}${data({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 4 },
        })}${data({ type: 'message_stop' })}`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const provider = new AnthropicMessagesProvider(
      {
        baseUrl: 'https://anthropic.example',
        model: 'claude-test',
        contextWindow: 1000,
        outputReserve: 100,
      },
      fetchMock,
    );
    await new RecapModelGenerator(provider).generate(
      expandedGeneration(),
      new AbortController().signal,
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.system).toBe('system');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content.map((block: { type: string }) => block.type)).toEqual([
      'text',
      'tool_use',
      'tool_use',
    ]);
    expect(body.messages[1].content.map((block: { type: string }) => block.type)).toEqual([
      'tool_result',
      'tool_result',
      'text',
      'text',
    ]);
    expect(body.messages[1].content[2].text).toBe('later source');
    expect(body.messages[1].content[3].text).toContain('Kairos internal Recap operation');
    expect(sourceMappings(body.messages[1].content[3].text)).toEqual([
      { seq: 4, message_index: 0, content_block_indexes: [0, 1, 2] },
      { seq: 5, message_index: 1, content_block_indexes: [0] },
      { seq: 6, message_index: 1, content_block_indexes: [1] },
      { seq: 9, message_index: 1, content_block_indexes: [2] },
    ]);
  });
});

function data(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}
