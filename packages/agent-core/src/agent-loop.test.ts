import { describe, expect, it } from 'vitest';
import { AgentLoop } from './agent-loop.js';
import type {
  AgentLoopEvent,
  AgentLoopPersistence,
  AgentTool,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelUsage,
  ToolCall,
  ToolExecutionResult,
  ToolMessage,
} from './index.js';
import { ScriptedProvider } from './testing.js';

const usage: ModelUsage = { input_tokens: 10, output_tokens: 2 };

class TestPersistence implements AgentLoopPersistence {
  readonly messages: ModelMessage[] = [];
  readonly toolCalls: ToolCall[] = [];
  readonly responseUsages: ModelUsage[] = [];
  readonly deliveryIds: string[] = [];
  readonly operations: string[] = [];
  failMessage: ((message: ModelMessage) => boolean) | undefined;
  failToolCall: ((call: ToolCall) => boolean) | undefined;

  async saveMessage(
    message: ModelMessage,
    _inputId?: string,
    responseUsage?: ModelUsage,
    deliveryId?: string,
  ) {
    if (this.failMessage?.(message)) throw new Error('Injected message persistence failure.');
    if (responseUsage) this.responseUsages.push(structuredClone(responseUsage));
    if (deliveryId) this.deliveryIds.push(deliveryId);
    this.messages.push(structuredClone(message));
    this.operations.push(`message:${message.role}`);
  }

  async saveToolResult(message: ToolMessage, commit: () => void): Promise<void> {
    commit();
    await this.saveMessage(message);
  }

  async saveToolCall(call: ToolCall): Promise<void> {
    if (this.failToolCall?.(call)) throw new Error('Injected tool persistence failure.');
    this.toolCalls.push(structuredClone(call));
    this.operations.push(`intent:${call.id}`);
  }
}

interface ValueArguments {
  value: string;
}

function isValueArguments(value: unknown): value is ValueArguments {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    typeof value.value === 'string'
  );
}

function valueTool(
  execute: (
    value: string,
    context: { call: ToolCall; signal: AbortSignal },
  ) => Promise<string | ToolExecutionResult>,
): AgentTool<ValueArguments> {
  return {
    name: 'record',
    description: 'Record a value.',
    parameters: { type: 'object' },
    validate(value) {
      if (!isValueArguments(value)) throw new Error('value must be a string.');
      return value;
    },
    execute(argumentsValue, context) {
      return execute(argumentsValue.value, context);
    },
  };
}

function response(
  message: Extract<ModelMessage, { role: 'assistant' }>,
  eventUsage: ModelUsage = usage,
): ModelEvent[] {
  return [{ type: 'response', message, usage: eventUsage }];
}

function assistantWithCalls(
  calls: readonly ToolCall[],
): Extract<ModelMessage, { role: 'assistant' }> {
  return { role: 'assistant', content: '', tool_calls: calls };
}

function finalResponse(text = '完成。', eventUsage: ModelUsage = usage): ModelEvent[] {
  return response({ role: 'assistant', content: text }, eventUsage);
}

describe('AgentLoop tool iteration', () => {
  it('runs consecutive tools only after saving intents and results', async () => {
    const effects: string[] = [];
    const persistence = new TestPersistence();
    const tool = valueTool(async (value, context) => {
      effects.push(value);
      persistence.operations.push(`execute:${context.call.id}`);
      return `saved:${value}`;
    });
    const provider = new ScriptedProvider([
      response(
        assistantWithCalls([
          { id: 'call-1', name: 'record', arguments: { value: 'one' } },
          { id: 'call-2', name: 'record', arguments: { value: 'two' } },
        ]),
        { input_tokens: 4, output_tokens: 3 },
      ),
      response(
        assistantWithCalls([{ id: 'call-3', name: 'record', arguments: { value: 'three' } }]),
        { input_tokens: 6, output_tokens: 2, total_tokens: 9 },
      ),
      finalResponse('全部完成。', { input_tokens: 8, output_tokens: 1 }),
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });

    const result = await loop.run('依次保存。');

    expect(result).toMatchObject({ status: 'completed', steps: 3 });
    expect(effects).toEqual(['one', 'two', 'three']);
    expect(persistence.toolCalls.map((call) => call.id)).toEqual(['call-1', 'call-2', 'call-3']);
    expect(persistence.operations).toEqual([
      'message:user',
      'message:assistant',
      'intent:call-1',
      'execute:call-1',
      'message:tool',
      'intent:call-2',
      'execute:call-2',
      'message:tool',
      'message:assistant',
      'intent:call-3',
      'execute:call-3',
      'message:tool',
      'message:assistant',
    ]);
    expect(provider.requests[1]?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
    ]);
    expect(provider.requests[2]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-3',
      content: 'saved:three',
    });
    expect(result.usage).toEqual({ input_tokens: 18, output_tokens: 6, total_tokens: 25 });
    expect(loop.getContext()).toEqual(persistence.messages);
  });

  it('overlaps concurrent tools and saves their final results in call order', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let notifyBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      notifyBothStarted = resolve;
    });
    let notifySecondFinished!: () => void;
    const secondFinished = new Promise<void>((resolve) => {
      notifySecondFinished = resolve;
    });
    const effects: string[] = [];
    const persistence = new TestPersistence();
    const tool: AgentTool<ValueArguments> = {
      ...valueTool(async (value) => {
        effects.push(`start:${value}`);
        if (effects.length === 2) notifyBothStarted();
        await (value === 'one' ? firstGate : secondGate);
        effects.push(`finish:${value}`);
        if (value === 'two') notifySecondFinished();
        return value;
      }),
      concurrent: true,
    };
    const provider = new ScriptedProvider([
      response(
        assistantWithCalls([
          { id: 'call-1', name: 'record', arguments: { value: 'one' } },
          { id: 'call-2', name: 'record', arguments: { value: 'two' } },
        ]),
      ),
      finalResponse(),
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });

    const running = loop.run('并发执行。');
    await bothStarted;
    expect(effects).toEqual(['start:one', 'start:two']);
    releaseSecond();
    await secondFinished;
    expect(persistence.messages.filter((message) => message.role === 'tool')).toEqual([]);

    releaseFirst();
    const result = await running;

    expect(result.status).toBe('completed');
    expect(effects).toEqual(['start:one', 'start:two', 'finish:two', 'finish:one']);
    expect(
      persistence.messages
        .filter(
          (message): message is Extract<ModelMessage, { role: 'tool' }> => message.role === 'tool',
        )
        .map((message) => message.tool_call_id),
    ).toEqual(['call-1', 'call-2']);
  });

  it('returns errors for incomplete, invalid, unknown and failed calls without executing them', async () => {
    const effects: string[] = [];
    const persistence = new TestPersistence();
    const tool = valueTool(async (value) => {
      if (value === 'explode') throw new Error('Tool failed.');
      effects.push(value);
      return 'ok';
    });
    const provider = new ScriptedProvider([
      response({
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'invalid', name: 'record', arguments: { value: 42 } },
          { id: 'unknown', name: 'missing', arguments: {} },
          { id: 'failed', name: 'record', arguments: { value: 'explode' } },
          { id: 'valid', name: 'record', arguments: { value: 'executed' } },
        ],
        incomplete_tool_calls: [
          { id: 'partial', name: 'record', arguments_text: '{"value"', error: 'Incomplete JSON.' },
        ],
      }),
      finalResponse(),
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });

    const result = await loop.run('处理工具错误。');

    expect(result.status).toBe('completed');
    expect(effects).toEqual(['executed']);
    expect(persistence.toolCalls.map((call) => call.id)).toEqual(['failed', 'valid']);
    const toolMessages = persistence.messages.filter(
      (message): message is Extract<ModelMessage, { role: 'tool' }> => message.role === 'tool',
    );
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual([
      'partial',
      'invalid',
      'unknown',
      'failed',
      'valid',
    ]);
    expect(toolMessages.map((message) => message.error?.code)).toEqual([
      'incomplete_call',
      'invalid_arguments',
      'unknown_tool',
      'execution_failed',
      undefined,
    ]);
    expect(provider.requests[1]?.messages.slice(-5)).toEqual(toolMessages);
  });

  it('rejects unknown or unnamed incomplete calls without suppressing a valid call', async () => {
    const effects: string[] = [];
    const persistence = new TestPersistence();
    const tool = valueTool(async (value) => {
      effects.push(value);
      return value;
    });
    const provider = new ScriptedProvider([
      response({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'valid', name: 'record', arguments: { value: 'executed' } }],
        incomplete_tool_calls: [
          {
            id: 'unknown-partial',
            name: 'missing',
            arguments_text: '{',
            error: 'Unknown incomplete call.',
          },
          {
            id: 'unnamed-partial',
            arguments_text: '{',
            error: 'Unnamed incomplete call.',
          },
        ],
      }),
      finalResponse(),
    ]);
    const loop = new AgentLoop({
      provider,
      persistence,
      tools: [tool],
    });

    const result = await loop.run('处理不完整调用。');

    expect(result.status).toBe('completed');
    expect(effects).toEqual(['executed']);
    expect(persistence.toolCalls.map((call) => call.id)).toEqual(['valid']);
    const toolMessages = persistence.messages.filter(
      (message): message is Extract<ModelMessage, { role: 'tool' }> => message.role === 'tool',
    );
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual([
      'unknown-partial',
      'unnamed-partial',
      'valid',
    ]);
    expect(toolMessages.map((message) => message.error?.code)).toEqual([
      'incomplete_call',
      'incomplete_call',
      undefined,
    ]);
  });

  it.each([
    {
      label: 'duplicate complete calls',
      message: assistantWithCalls([
        { id: 'duplicate', name: 'record', arguments: { value: 'one' } },
        { id: 'duplicate', name: 'record', arguments: { value: 'two' } },
      ]),
    },
    {
      label: 'complete/incomplete id conflicts',
      message: {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'duplicate', name: 'record', arguments: { value: 'one' } }],
        incomplete_tool_calls: [
          {
            id: 'duplicate',
            name: 'record',
            arguments_text: '{"value"',
            error: 'Incomplete JSON.',
          },
        ],
      },
    },
  ])('rejects $label before saving the assistant message', async ({ message }) => {
    const effects: string[] = [];
    const persistence = new TestPersistence();
    const tool = valueTool(async (value) => {
      effects.push(value);
      return value;
    });
    const provider = new ScriptedProvider([response(message)]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });

    const result = await loop.run('重复编号。');

    expect(result).toMatchObject({ status: 'failed', error: { code: 'invalid_provider_event' } });
    expect(effects).toEqual([]);
    expect(persistence.messages).toEqual([{ role: 'user', content: '重复编号。' }]);
    expect(persistence.toolCalls).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it('scopes generated incomplete call ids to each run and saves them with assistant messages', async () => {
    const persistence = new TestPersistence();
    const incompleteResponse = () =>
      response({
        role: 'assistant',
        content: '',
        incomplete_tool_calls: [
          { name: 'record', arguments_text: '{"value"', error: 'Incomplete JSON.' },
        ],
      });
    const firstProvider = new ScriptedProvider([
      incompleteResponse(),
      finalResponse('第一次完成。'),
    ]);
    const firstLoop = new AgentLoop({
      provider: firstProvider,
      persistence,
      executionId: 'run-one',
    });

    expect((await firstLoop.run('第一次。')).status).toBe('completed');
    const firstRunMessages = structuredClone(persistence.messages);
    const secondProvider = new ScriptedProvider([
      incompleteResponse(),
      finalResponse('第二次完成。'),
    ]);
    const secondLoop = new AgentLoop({
      provider: secondProvider,
      persistence,
      initialMessages: firstRunMessages,
      executionId: 'run-two',
    });

    expect((await secondLoop.run('第二次。')).status).toBe('completed');

    const assistants = persistence.messages.filter(
      (message): message is Extract<ModelMessage, { role: 'assistant' }> =>
        message.role === 'assistant' && message.incomplete_tool_calls !== undefined,
    );
    expect(assistants).toHaveLength(2);
    const firstId = assistants[0]?.incomplete_tool_calls?.[0]?.id;
    const secondId = assistants[1]?.incomplete_tool_calls?.[0]?.id;
    expect(firstId).toBe('incomplete-run-one-1-1');
    expect(secondId).toBe('incomplete-run-two-1-1');
    expect(secondId).not.toBe(firstId);

    const toolMessages = persistence.messages.filter(
      (message): message is Extract<ModelMessage, { role: 'tool' }> => message.role === 'tool',
    );
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual([firstId, secondId]);
    expect(toolMessages.map((message) => message.error?.code)).toEqual([
      'incomplete_call',
      'incomplete_call',
    ]);
    expect(secondProvider.requests[1]?.messages.slice(-2)).toEqual([
      assistants[1],
      toolMessages[1],
    ]);
  });

  it('stops before execution when a tool intent cannot be saved', async () => {
    const effects: string[] = [];
    const persistence = new TestPersistence();
    persistence.failToolCall = (call) => call.id === 'call-1';
    const tool = valueTool(async (value) => {
      effects.push(value);
      return value;
    });
    const provider = new ScriptedProvider([
      response(
        assistantWithCalls([
          { id: 'call-1', name: 'record', arguments: { value: 'one' } },
          { id: 'call-2', name: 'record', arguments: { value: 'two' } },
        ]),
      ),
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });

    const result = await loop.run('保存意图。');

    expect(result).toMatchObject({ status: 'failed', error: { code: 'persistence_failed' } });
    expect(effects).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it('stops later tools and model steps when a tool result cannot be saved', async () => {
    const effects: string[] = [];
    const persistence = new TestPersistence();
    persistence.failMessage = (message) =>
      message.role === 'tool' && message.tool_call_id === 'call-1';
    const tool = valueTool(async (value) => {
      effects.push(value);
      return value;
    });
    const provider = new ScriptedProvider([
      response(
        assistantWithCalls([
          { id: 'call-1', name: 'record', arguments: { value: 'one' } },
          { id: 'call-2', name: 'record', arguments: { value: 'two' } },
        ]),
      ),
      finalResponse(),
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });

    const result = await loop.run('保存结果。');

    expect(result).toMatchObject({ status: 'failed', error: { code: 'persistence_failed' } });
    expect(effects).toEqual(['one']);
    expect(persistence.toolCalls.map((call) => call.id)).toEqual(['call-1']);
    expect(provider.requests).toHaveLength(1);
  });

  it('does not execute tools when the complete assistant message cannot be saved', async () => {
    const effects: string[] = [];
    const persistence = new TestPersistence();
    persistence.failMessage = (message) => message.role === 'assistant';
    const tool = valueTool(async (value) => {
      effects.push(value);
      return value;
    });
    const provider = new ScriptedProvider([
      response(assistantWithCalls([{ id: 'call-1', name: 'record', arguments: { value: 'one' } }])),
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });

    const result = await loop.run('保存助手输出。');

    expect(result).toMatchObject({ status: 'failed', error: { code: 'persistence_failed' } });
    expect(effects).toEqual([]);
    expect(persistence.toolCalls).toEqual([]);
  });

  it('enforces the model step limit after saving the last tool result', async () => {
    const effects: string[] = [];
    const persistence = new TestPersistence();
    const tool = valueTool(async (value) => {
      effects.push(value);
      return value;
    });
    const provider = new ScriptedProvider([
      response(assistantWithCalls([{ id: 'call-1', name: 'record', arguments: { value: 'one' } }])),
      finalResponse(),
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool], maxSteps: 1 });

    const result = await loop.run('限制步骤。');

    expect(result).toMatchObject({ status: 'failed', steps: 1, error: { code: 'step_limit' } });
    expect(effects).toEqual(['one']);
    expect(provider.requests).toHaveLength(1);
    expect(persistence.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-1' });
  });
});

describe('AgentLoop input and cancellation', () => {
  it('consumes supplements at model boundaries and queued inputs after natural completion', async () => {
    const persistence = new TestPersistence();
    const tool = valueTool(async (value) => value);
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', text: '执行中' },
        ...response(
          assistantWithCalls([{ id: 'call-1', name: 'record', arguments: { value: 'one' } }]),
        ),
      ],
      finalResponse('补充完成。'),
      finalResponse('第一项后续完成。'),
      finalResponse('第二项后续完成。'),
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });
    loop.subscribe((event) => {
      if (event.type === 'text_delta') {
        loop.supplement('中途补充');
        loop.enqueue('后续一');
        loop.enqueue('后续二');
      }
    });

    const result = await loop.run('初始输入');

    expect(result).toMatchObject({ status: 'completed', steps: 4 });
    expect(provider.requests[1]?.messages.map((message) => message.content)).toEqual([
      '初始输入',
      '',
      'one',
      '中途补充',
    ]);
    expect(provider.requests[2]?.messages.at(-1)).toEqual({ role: 'user', content: '后续一' });
    expect(provider.requests[3]?.messages.at(-1)).toEqual({ role: 'user', content: '后续二' });
    expect(
      persistence.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
    ).toEqual(['初始输入', '中途补充', '后续一', '后续二']);
    expect(persistence.operations.slice(0, 6)).toEqual([
      'message:user',
      'message:assistant',
      'intent:call-1',
      'message:tool',
      'message:user',
      'message:assistant',
    ]);
  });

  it('persists direct injections before queued follow-up inputs', async () => {
    const persistence = new TestPersistence();
    const provider = new ScriptedProvider([
      [{ type: 'text_delta', text: '执行中' }, ...finalResponse('首次回复')],
      finalResponse('注入后回复'),
      finalResponse('普通后续回复'),
    ]);
    const loop = new AgentLoop({ provider, persistence });
    loop.subscribe((event) => {
      if (event.type === 'text_delta') {
        loop.inject('后台终态结果', 'delivery-key');
        loop.enqueue('普通后续', 'follow-up');
      }
    });

    const result = await loop.run('初始输入');

    expect(result).toMatchObject({ status: 'completed', steps: 3 });
    expect(provider.requests[1]?.messages.map((message) => message.content)).toEqual([
      '初始输入',
      '首次回复',
      '后台终态结果',
    ]);
    expect(provider.requests[2]?.messages.at(-1)).toEqual({
      role: 'user',
      content: '普通后续',
    });
    expect(persistence.deliveryIds).toEqual(['delivery-key']);
  });

  it('runs another model step for a direct injection without a follow-up input', async () => {
    const persistence = new TestPersistence();
    const provider = new ScriptedProvider([
      [{ type: 'text_delta', text: '执行中' }, ...finalResponse('首次回复')],
      finalResponse('注入后回复'),
    ]);
    const loop = new AgentLoop({ provider, persistence });
    loop.subscribe((event) => {
      if (event.type === 'text_delta') loop.inject('后台终态结果', 'delivery-key');
    });

    const result = await loop.run('初始输入');

    expect(result).toMatchObject({ status: 'completed', steps: 2 });
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: '后台终态结果',
    });
    expect(persistence.deliveryIds).toEqual(['delivery-key']);
  });

  it('distinguishes model cancellation acceptance from actual completion', async () => {
    const effects: string[] = [];
    const persistence = new TestPersistence();
    const tool = valueTool(async (value) => {
      effects.push(value);
      return value;
    });
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', text: '部分输出' },
        ...response(
          assistantWithCalls([{ id: 'call-1', name: 'record', arguments: { value: 'one' } }]),
        ),
      ],
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });
    const events: AgentLoopEvent[] = [];
    loop.subscribe((event) => {
      events.push(event);
      if (event.type === 'text_delta') expect(loop.cancel('停止模型。')).toBe(true);
    });

    const result = await loop.run('取消模型');

    expect(result.status).toBe('cancelled');
    expect(loop.isRunning).toBe(false);
    expect(loop.isCancellationRequested).toBe(true);
    expect(loop.cancel()).toBe(false);
    expect(effects).toEqual([]);
    expect(persistence.messages).toEqual([{ role: 'user', content: '取消模型' }]);
    expect(events.map((event) => event.type)).toEqual([
      'message',
      'text_delta',
      'cancel_requested',
      'complete',
    ]);
  });

  it('aborts the provider signal when a cancel_requested subscriber throws', async () => {
    let providerSignal: AbortSignal | undefined;
    const provider: ModelProvider = {
      async *stream(_request, signal) {
        providerSignal = signal;
        yield { type: 'text_delta', text: '取消中' };
        yield* finalResponse();
      },
    };
    const persistence = new TestPersistence();
    const loop = new AgentLoop({ provider, persistence });
    loop.subscribe((event) => {
      if (event.type === 'text_delta') {
        expect(() => loop.cancel('停止模型。')).toThrow('Injected cancel subscriber failure.');
        expect(providerSignal?.aborted).toBe(true);
      }
      if (event.type === 'cancel_requested') {
        throw new Error('Injected cancel subscriber failure.');
      }
    });

    const result = await loop.run('取消模型');

    expect(result.status).toBe('cancelled');
    expect(providerSignal?.aborted).toBe(true);
    expect(persistence.messages).toEqual([{ role: 'user', content: '取消模型' }]);
  });

  it('passes AbortSignal to a tool and waits for its actual result before finishing cancellation', async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const effects: string[] = [];
    let toolSignal: AbortSignal | undefined;
    const persistence = new TestPersistence();
    const tool = valueTool(async (_value, context) => {
      toolSignal = context.signal;
      notifyStarted();
      await toolGate;
      effects.push('finished');
      return 'late result';
    });
    const provider = new ScriptedProvider([
      response(assistantWithCalls([{ id: 'call-1', name: 'record', arguments: { value: 'one' } }])),
      finalResponse(),
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });
    const events: AgentLoopEvent[] = [];
    loop.subscribe((event) => events.push(event));

    const running = loop.run('取消工具');
    await started;
    expect(loop.cancel('停止工具。')).toBe(true);
    expect(toolSignal?.aborted).toBe(true);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(loop.isRunning).toBe(true);

    releaseTool();
    const result = await running;

    expect(result.status).toBe('cancelled');
    expect(effects).toEqual(['finished']);
    expect(provider.requests).toHaveLength(1);
    expect(persistence.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: 'late result',
      status: 'success',
    });
    expect(events.at(-1)).toMatchObject({ type: 'complete', result: { status: 'cancelled' } });
    expect(events.some((event) => event.type === 'cancel_requested')).toBe(true);
  });

  it('saves cancelled results for every remaining call and continues from the saved context', async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const effects: string[] = [];
    const persistence = new TestPersistence();
    const tool = valueTool(async (value, context) => {
      effects.push(`start:${value}`);
      if (value === 'one') {
        notifyStarted();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), {
            once: true,
          });
        });
      }
      effects.push(`finish:${value}`);
      return value;
    });
    const provider = new ScriptedProvider([
      response(
        assistantWithCalls([
          { id: 'call-1', name: 'record', arguments: { value: 'one' } },
          { id: 'call-2', name: 'record', arguments: { value: 'two' } },
        ]),
      ),
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });

    const running = loop.run('取消后继续。');
    await started;
    expect(loop.cancel('停止工具。')).toBe(true);
    const result = await running;

    expect(result.status).toBe('cancelled');
    expect(effects).toEqual(['start:one']);
    expect(provider.requests).toHaveLength(1);
    expect(persistence.toolCalls.map((call) => call.id)).toEqual(['call-1']);
    const savedMessages = structuredClone(persistence.messages);
    expect(savedMessages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call-1' }, { id: 'call-2' }],
    });
    const toolMessages = savedMessages.filter(
      (message): message is Extract<ModelMessage, { role: 'tool' }> => message.role === 'tool',
    );
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual(['call-1', 'call-2']);
    expect(toolMessages.map((message) => message.error?.code)).toEqual(['cancelled', 'cancelled']);

    const nextProvider = new ScriptedProvider([finalResponse('继续完成。')]);
    const nextPersistence = new TestPersistence();
    const nextLoop = new AgentLoop({
      provider: nextProvider,
      persistence: nextPersistence,
      initialMessages: savedMessages,
    });

    expect((await nextLoop.run('继续。')).status).toBe('completed');
    expect(nextProvider.requests[0]?.messages).toEqual([
      ...savedMessages,
      { role: 'user', content: '继续。' },
    ]);
  });

  it.each(['message', 'tool_status'] as const)(
    'keeps one final result per call and continues when a %s subscriber throws',
    async (eventType) => {
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const effects: string[] = [];
      const persistence = new TestPersistence();
      const tool = valueTool(async (value, context) => {
        effects.push(value);
        if (value === 'one') {
          notifyStarted();
          await new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(context.signal.reason), {
              once: true,
            });
          });
        }
        return value;
      });
      const provider = new ScriptedProvider([
        response(
          assistantWithCalls([
            { id: 'call-1', name: 'record', arguments: { value: 'one' } },
            { id: 'call-2', name: 'record', arguments: { value: 'two' } },
          ]),
        ),
      ]);
      const loop = new AgentLoop({ provider, persistence, tools: [tool] });
      let shouldThrow = true;
      loop.subscribe((event) => {
        if (eventType === 'message') {
          if (
            event.type !== 'message' ||
            event.message.role !== 'tool' ||
            event.message.tool_call_id !== 'call-1'
          ) {
            return;
          }
        } else if (
          event.type !== 'tool_status' ||
          event.call_id !== 'call-1' ||
          event.status !== 'cancelled'
        ) {
          return;
        }
        if (!shouldThrow) return;
        shouldThrow = false;
        throw new Error('Injected subscriber failure.');
      });

      const running = loop.run('订阅异常。');
      await started;
      expect(loop.cancel('停止工具。')).toBe(true);
      const result = await running;

      expect(result.status).toBe('cancelled');
      expect(effects).toEqual(['one']);
      expect(persistence.toolCalls.map((call) => call.id)).toEqual(['call-1']);
      const savedMessages = structuredClone(persistence.messages);
      const toolMessages = savedMessages.filter(
        (message): message is Extract<ModelMessage, { role: 'tool' }> => message.role === 'tool',
      );
      expect(toolMessages.map((message) => message.tool_call_id)).toEqual(['call-1', 'call-2']);
      expect(toolMessages.map((message) => message.error?.code)).toEqual([
        'cancelled',
        'cancelled',
      ]);

      const nextProvider = new ScriptedProvider([finalResponse('订阅异常后继续完成。')]);
      const nextPersistence = new TestPersistence();
      const nextLoop = new AgentLoop({
        provider: nextProvider,
        persistence: nextPersistence,
        initialMessages: savedMessages,
      });

      expect((await nextLoop.run('继续。')).status).toBe('completed');
      expect(nextProvider.requests[0]?.messages).toEqual([
        ...savedMessages,
        { role: 'user', content: '继续。' },
      ]);
    },
  );

  it('cancels remaining incomplete and complete calls after an incomplete rejection', async () => {
    const effects: string[] = [];
    const persistence = new TestPersistence();
    const tool = valueTool(async (value) => {
      effects.push(value);
      return value;
    });
    const provider = new ScriptedProvider([
      response({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'complete', name: 'record', arguments: { value: 'one' } }],
        incomplete_tool_calls: [
          {
            id: 'partial-1',
            name: 'record',
            arguments_text: '{"value"',
            error: 'First incomplete JSON.',
          },
          {
            id: 'partial-2',
            name: 'record',
            arguments_text: '{"value"',
            error: 'Second incomplete JSON.',
          },
        ],
      }),
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });
    loop.subscribe((event) => {
      if (event.type === 'tool_status' && event.call_id === 'partial-1') {
        expect(loop.cancel('停止剩余调用。')).toBe(true);
      }
    });

    const result = await loop.run('取消不完整调用。');

    expect(result.status).toBe('cancelled');
    expect(effects).toEqual([]);
    expect(persistence.toolCalls).toEqual([]);
    const toolMessages = persistence.messages.filter(
      (message): message is Extract<ModelMessage, { role: 'tool' }> => message.role === 'tool',
    );
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual([
      'partial-1',
      'partial-2',
      'complete',
    ]);
    expect(toolMessages.map((message) => message.error?.code)).toEqual([
      'incomplete_call',
      'cancelled',
      'cancelled',
    ]);
  });

  it('reports persistence failure while saving a remaining cancellation result', async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const effects: string[] = [];
    const persistence = new TestPersistence();
    persistence.failMessage = (message) =>
      message.role === 'tool' && message.tool_call_id === 'call-2';
    const tool = valueTool(async (value) => {
      effects.push(value);
      if (value === 'one') {
        notifyStarted();
        await toolGate;
        return 'late result';
      }
      return value;
    });
    const provider = new ScriptedProvider([
      response(
        assistantWithCalls([
          { id: 'call-1', name: 'record', arguments: { value: 'one' } },
          { id: 'call-2', name: 'record', arguments: { value: 'two' } },
        ]),
      ),
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });

    const running = loop.run('取消结果保存失败。');
    await started;
    expect(loop.cancel('停止工具。')).toBe(true);
    releaseTool();
    const result = await running;

    expect(result).toMatchObject({ status: 'failed', error: { code: 'persistence_failed' } });
    expect(effects).toEqual(['one']);
    expect(provider.requests).toHaveLength(1);
    expect(persistence.toolCalls.map((call) => call.id)).toEqual(['call-1']);
    const toolMessages = persistence.messages.filter(
      (message): message is Extract<ModelMessage, { role: 'tool' }> => message.role === 'tool',
    );
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]).toMatchObject({
      tool_call_id: 'call-1',
      content: 'late result',
      status: 'success',
    });
  });

  it('does not cancel the loop when a subscriber unsubscribes', async () => {
    const persistence = new TestPersistence();
    const provider = new ScriptedProvider([
      [{ type: 'text_delta', text: '继续' }, ...finalResponse()],
    ]);
    const loop = new AgentLoop({ provider, persistence });
    const unsubscribe = loop.subscribe((event) => {
      if (event.type === 'text_delta') unsubscribe();
    });

    const result = await loop.run('退订');

    expect(result.status).toBe('completed');
    expect(loop.isCancellationRequested).toBe(false);
  });
});

describe('AgentLoop content blocks', () => {
  it('persists ordered Thinking and text blocks with response usage before tool execution', async () => {
    const persistence = new TestPersistence();
    const effects: string[] = [];
    const tool = valueTool(async (value) => {
      effects.push(value);
      return value;
    });
    const blocks = [
      { type: 'thinking' as const, block_index: 0, text: 'plan' },
      { type: 'text' as const, block_index: 1, text: 'answer' },
      { type: 'thinking' as const, block_index: 2, text: 'next step' },
    ];
    const provider = new ScriptedProvider([
      [
        { type: 'thinking_delta', text: 'pl', block_index: 0 },
        { type: 'thinking_delta', text: 'an', block_index: 0 },
        { type: 'text_delta', text: 'answer', block_index: 1 },
        { type: 'thinking_delta', text: 'next step', block_index: 2 },
        ...response({
          role: 'assistant',
          content: 'answer',
          content_blocks: blocks,
          tool_calls: [{ id: 'call-1', name: 'record', arguments: { value: 'done' } }],
        }),
      ],
      finalResponse(),
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });
    const events: AgentLoopEvent[] = [];
    loop.subscribe((event) => events.push(event));

    expect((await loop.run('start')).status).toBe('completed');

    expect(effects).toEqual(['done']);
    expect(persistence.messages[1]).toEqual({
      role: 'assistant',
      content: 'answer',
      content_blocks: blocks,
      tool_calls: [{ id: 'call-1', name: 'record', arguments: { value: 'done' } }],
    });
    expect(persistence.responseUsages).toEqual([usage, usage]);
    expect(persistence.operations.slice(0, 4)).toEqual([
      'message:user',
      'message:assistant',
      'intent:call-1',
      'message:tool',
    ]);
    expect(events.filter((event) => event.type.endsWith('_delta'))).toEqual([
      { type: 'thinking_delta', text: 'pl', block_index: 0 },
      { type: 'thinking_delta', text: 'an', block_index: 0 },
      { type: 'text_delta', text: 'answer', block_index: 1 },
      { type: 'thinking_delta', text: 'next step', block_index: 2 },
    ]);
    expect(provider.requests[1]?.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'answer',
    });
    expect(provider.requests[1]?.messages[1]?.content).not.toContain('plan');
  });

  it('saves a Thinking-only response without adding a text placeholder', async () => {
    const persistence = new TestPersistence();
    const provider = new ScriptedProvider([
      [
        { type: 'thinking_delta', text: 'reasoning', block_index: 0 },
        ...response({
          role: 'assistant',
          content: '',
          content_blocks: [{ type: 'thinking', block_index: 0, text: 'reasoning' }],
        }),
      ],
    ]);
    const loop = new AgentLoop({ provider, persistence });

    expect((await loop.run('think')).status).toBe('completed');
    expect(persistence.messages.at(-1)).toEqual({
      role: 'assistant',
      content: '',
      content_blocks: [{ type: 'thinking', block_index: 0, text: 'reasoning' }],
    });
  });

  it('ignores empty deltas without creating blocks', async () => {
    const persistence = new TestPersistence();
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', text: '' },
        { type: 'thinking_delta', text: '', block_index: 0 },
        ...response({ role: 'assistant', content: '' }),
      ],
    ]);
    const loop = new AgentLoop({ provider, persistence });
    const events: AgentLoopEvent[] = [];
    loop.subscribe((event) => events.push(event));

    expect((await loop.run('empty')).status).toBe('completed');
    expect(events.some((event) => event.type.endsWith('_delta'))).toBe(false);
    expect(persistence.messages.at(-1)).toEqual({ role: 'assistant', content: '' });
  });

  it.each([
    {
      label: 'non-consecutive indices',
      message: {
        role: 'assistant' as const,
        content: 'text',
        content_blocks: [{ type: 'text' as const, block_index: 1, text: 'text' }],
      },
    },
    {
      label: 'empty blocks',
      message: {
        role: 'assistant' as const,
        content: '',
        content_blocks: [{ type: 'thinking' as const, block_index: 0, text: '' }],
      },
    },
    {
      label: 'Thinking copied into content',
      message: {
        role: 'assistant' as const,
        content: 'thinking',
        content_blocks: [{ type: 'thinking' as const, block_index: 0, text: 'thinking' }],
      },
    },
  ])('rejects $label before saving', async ({ message }) => {
    const persistence = new TestPersistence();
    const provider = new ScriptedProvider([response(message)]);
    const loop = new AgentLoop({ provider, persistence });

    expect((await loop.run('invalid')).error?.code).toBe('invalid_provider_event');
    expect(persistence.messages).toEqual([{ role: 'user', content: 'invalid' }]);
    expect(persistence.responseUsages).toEqual([]);
  });

  it.each([
    { deltas: [{ type: 'thinking_delta' as const, text: 'reasoning', block_index: 0 }] },
    { deltas: [{ type: 'text_delta' as const, text: 'skipped', block_index: 1 }] },
    {
      deltas: [
        { type: 'thinking_delta' as const, text: 'reasoning', block_index: 0 },
        { type: 'text_delta' as const, text: 'same block', block_index: 0 },
      ],
    },
  ])('rejects invalid streamed block sequences', async ({ deltas }) => {
    const persistence = new TestPersistence();
    const provider = new ScriptedProvider([
      [...deltas, ...response({ role: 'assistant', content: '' })],
    ]);
    const loop = new AgentLoop({ provider, persistence });

    expect((await loop.run('invalid stream')).error?.code).toBe('invalid_provider_event');
    expect(persistence.messages).toEqual([{ role: 'user', content: 'invalid stream' }]);
  });

  it('does not save partial Thinking or response usage after stream interruption', async () => {
    const persistence = new TestPersistence();
    const provider = new ScriptedProvider([
      [
        { type: 'thinking_delta', text: 'partial', block_index: 0 },
        {
          type: 'stream_interrupted',
          error: { code: 'stream_interrupted', message: 'Connection lost.' },
          usage,
        },
      ],
    ]);
    const loop = new AgentLoop({ provider, persistence });

    expect((await loop.run('interrupt')).status).toBe('interrupted');
    expect(persistence.messages).toEqual([{ role: 'user', content: 'interrupt' }]);
    expect(persistence.responseUsages).toEqual([]);
  });
});

describe('AgentLoop atomic results', () => {
  it('commits tool state in the same persistence operation as its result', async () => {
    const persistence = new TestPersistence();
    const tool = valueTool(async (value) => ({
      content: value,
      commit: () => persistence.operations.push(`commit:${value}`),
    }));
    const provider = new ScriptedProvider([
      response(assistantWithCalls([{ id: 'call-1', name: 'record', arguments: { value: 'one' } }])),
      finalResponse('done'),
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });

    expect((await loop.run('start')).status).toBe('completed');
    expect(persistence.operations).toEqual([
      'message:user',
      'message:assistant',
      'intent:call-1',
      'commit:one',
      'message:tool',
      'message:assistant',
    ]);
  });

  it('keeps image attachment references on the correlated tool result', async () => {
    const persistence = new TestPersistence();
    const content = JSON.stringify({ attachment_id: 'image-1', media_type: 'image/png' });
    const tool = valueTool(async () => ({
      content,
      content_parts: [{ type: 'attachment', attachment_id: 'image-1' }],
    }));
    const provider = new ScriptedProvider([
      response(
        assistantWithCalls([{ id: 'call-image', name: 'record', arguments: { value: 'one' } }]),
      ),
      finalResponse('done'),
    ]);
    const loop = new AgentLoop({ provider, persistence, tools: [tool] });

    expect((await loop.run('inspect')).status).toBe('completed');
    const saved = persistence.messages.find(
      (message): message is ToolMessage => message.role === 'tool',
    );
    expect(saved).toEqual({
      role: 'tool',
      content,
      content_parts: [{ type: 'attachment', attachment_id: 'image-1' }],
      tool_call_id: 'call-image',
      tool_name: 'record',
      status: 'success',
    });
    expect(provider.requests[1]?.messages.at(-1)).toEqual(saved);
    expect(JSON.stringify(saved)).not.toContain('base64');
  });
});

describe('AgentLoop provider failures and isolation', () => {
  it('reports stream interruption with partial usage and without saving a partial assistant', async () => {
    const persistence = new TestPersistence();
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', text: '部分输出' },
        {
          type: 'stream_interrupted',
          error: { code: 'stream_interrupted', message: 'Connection lost.' },
          usage: { input_tokens: 7, output_tokens: 3, total_tokens: 11 },
        },
      ],
    ]);
    const loop = new AgentLoop({ provider, persistence });
    const events: AgentLoopEvent[] = [];
    loop.subscribe((event) => events.push(event));

    const result = await loop.run('中断');

    expect(result).toMatchObject({
      status: 'interrupted',
      error: { code: 'stream_interrupted', message: 'Connection lost.' },
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 11 },
    });
    expect(loop.getUsage()).toEqual({ input_tokens: 7, output_tokens: 3, total_tokens: 11 });
    expect(persistence.messages).toEqual([{ role: 'user', content: '中断' }]);
    expect(events.map((event) => event.type)).toEqual([
      'message',
      'text_delta',
      'usage',
      'error',
      'complete',
    ]);
  });

  it('keeps contexts independent across thread and subagent loops', async () => {
    const threadProvider = new ScriptedProvider([finalResponse('Thread result.')]);
    const subagentProvider = new ScriptedProvider([finalResponse('Subagent result.')]);
    const threadPersistence = new TestPersistence();
    const subagentPersistence = new TestPersistence();
    const thread = new AgentLoop({ provider: threadProvider, persistence: threadPersistence });
    const subagent = new AgentLoop({
      provider: subagentProvider,
      persistence: subagentPersistence,
    });

    const [threadResult, subagentResult] = await Promise.all([
      thread.run('Thread input'),
      subagent.run('Subagent input'),
    ]);

    expect(threadResult.status).toBe('completed');
    expect(subagentResult.status).toBe('completed');
    expect(threadProvider.requests[0]?.messages).toEqual([
      { role: 'user', content: 'Thread input' },
    ]);
    expect(subagentProvider.requests[0]?.messages).toEqual([
      { role: 'user', content: 'Subagent input' },
    ]);
    expect(thread.getContext().map((message) => message.content)).toEqual([
      'Thread input',
      'Thread result.',
    ]);
    expect(subagent.getContext().map((message) => message.content)).toEqual([
      'Subagent input',
      'Subagent result.',
    ]);
  });

  it('accepts attachment-only user content parts', async () => {
    const provider = new ScriptedProvider([finalResponse('Received.')]);
    const persistence = new TestPersistence();
    const loop = new AgentLoop({ provider, persistence });
    const contentParts = [{ type: 'attachment' as const, attachment_id: 'attachment-1' }];
    const result = await loop.run({ content: '', content_parts: contentParts });
    expect(result.status).toBe('completed');
    expect(persistence.messages[0]).toEqual({
      role: 'user',
      content: '',
      content_parts: contentParts,
    });
    expect(provider.requests[0]?.messages[0]).toEqual({
      role: 'user',
      content: '',
      content_parts: contentParts,
    });
  });

  it('rejects empty content on every input path while allowing attachment-only input', async () => {
    const emptyProvider = new ScriptedProvider([]);
    const emptyPersistence = new TestPersistence();
    const emptyLoop = new AgentLoop({ provider: emptyProvider, persistence: emptyPersistence });
    const emptyResult = await emptyLoop.run({ content: '', content_parts: [] });
    expect(emptyResult.status).toBe('failed');
    expect(emptyProvider.requests).toHaveLength(0);
    expect(emptyPersistence.messages).toHaveLength(0);

    const provider = new ScriptedProvider([
      finalResponse('first'),
      finalResponse('injected'),
      finalResponse('supplemented'),
      finalResponse('follow-up'),
    ]);
    const persistence = new TestPersistence();
    const loop = new AgentLoop({ provider, persistence });
    const running = loop.run('start');
    for (const submit of [loop.supplement, loop.enqueue, loop.inject]) {
      expect(() => submit.call(loop, { content: '', content_parts: [] })).toThrow(
        'Input content cannot be empty.',
      );
    }
    const contentParts = [{ type: 'attachment' as const, attachment_id: 'attachment-1' }];
    loop.supplement({ content: '', content_parts: contentParts });
    loop.enqueue({ content: '', content_parts: contentParts });
    loop.inject({ content: '', content_parts: contentParts });
    expect((await running).status).toBe('completed');
    expect(
      persistence.messages.filter(
        (message) =>
          message.role === 'user' &&
          message.content_parts?.some(
            (part) => part.type === 'attachment' && part.attachment_id === 'attachment-1',
          ),
      ),
    ).toHaveLength(3);
  });
});
