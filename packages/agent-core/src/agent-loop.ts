import { randomUUID } from 'node:crypto';
import type {
  AssistantMessage,
  ContentBlock,
  DetailedModelUsage,
  IncompleteToolCall,
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelUsage,
  ToolCall,
  ToolError,
  ToolMessage,
} from './index.js';

export const DEFAULT_MAX_STEPS = 32;

export interface ToolExecutionContext {
  call: ToolCall;
  signal: AbortSignal;
}

export interface ToolExecutionResult {
  content: string;
  content_parts?: ToolMessage['content_parts'];
  status?: 'success' | 'error';
  commit?: () => void;
  endTurn?: boolean;
}

export interface AgentTool<ValidatedArguments = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  concurrent?: boolean;
  validate(argumentsValue: unknown): ValidatedArguments | Promise<ValidatedArguments>;
  execute(
    argumentsValue: ValidatedArguments,
    context: ToolExecutionContext,
  ): Promise<string | ToolExecutionResult>;
}

export interface AgentLoopPersistence {
  saveMessage(
    message: ModelMessage,
    inputId?: string,
    responseUsage?: DetailedModelUsage,
    deliveryId?: string,
  ): Promise<void>;
  saveToolResult?(message: ToolMessage, commit: () => void): Promise<void>;
  saveToolCall(call: ToolCall): Promise<void>;
}

export interface AgentLoopOptions {
  provider: ModelProvider;
  persistence: AgentLoopPersistence;
  tools?: readonly AgentTool[];
  initialMessages?: readonly ModelMessage[];
  maxSteps?: number;
  executionId?: string;
  readInputs?: (mode: 'steer' | 'follow_up') => readonly AgentLoopInput[];
  readInjections?: () => readonly AgentLoopInput[];
}

export interface AgentLoopRunOptions {
  signal?: AbortSignal;
  inputId?: string;
}

export type AgentLoopErrorCode =
  | 'model_request_failed'
  | 'invalid_provider_event'
  | 'stream_interrupted'
  | 'persistence_failed'
  | 'step_limit'
  | 'operation_unknown'
  | 'internal_error';

export class AgentLoopError extends Error {
  readonly code: AgentLoopErrorCode;

  constructor(code: AgentLoopErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentLoopError';
    this.code = code;
  }
}

export interface AgentLoopResult {
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  steps: number;
  usage: ModelUsage;
  error?: AgentLoopError;
}

export type AgentLoopToolStatus =
  | 'intent_saved'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'cancelled';

export type AgentLoopEvent =
  | { type: 'text_delta'; text: string; block_index: number }
  | { type: 'thinking_delta'; text: string; block_index: number }
  | { type: 'message'; message: ModelMessage }
  | {
      type: 'tool_status';
      call_id: string;
      tool_name: string;
      status: AgentLoopToolStatus;
      error?: ToolError;
    }
  | { type: 'usage'; usage: DetailedModelUsage; total_usage: ModelUsage }
  | { type: 'cancel_requested'; reason: string }
  | { type: 'error'; error: AgentLoopError }
  | { type: 'complete'; result: AgentLoopResult };

type AgentLoopUserMessage = Extract<ModelMessage, { role: 'user' }>;
type AgentLoopContent = string | Omit<AgentLoopUserMessage, 'role'>;

interface AgentLoopInput extends Omit<AgentLoopUserMessage, 'role'> {
  id: string;
}

function userContent(content: AgentLoopContent): Omit<AgentLoopUserMessage, 'role'> {
  return typeof content === 'string' ? { content } : content;
}

function requireUserContent(content: AgentLoopContent): Omit<AgentLoopUserMessage, 'role'> {
  const normalized = userContent(content);
  if (normalized.content.length === 0 && (normalized.content_parts?.length ?? 0) === 0) {
    throw new Error('Input content cannot be empty.');
  }
  return normalized;
}

function userMessage(content: AgentLoopContent): AgentLoopUserMessage {
  const normalized = requireUserContent(content);
  return {
    role: 'user',
    content: normalized.content,
    ...(normalized.content_parts === undefined ? {} : { content_parts: normalized.content_parts }),
  };
}

export class AgentLoop {
  private readonly provider: ModelProvider;
  private readonly persistence: AgentLoopPersistence;
  private readonly tools: readonly AgentTool[];
  private readonly messages: ModelMessage[];
  private readonly maxSteps: number;
  private readonly executionId: string;
  private readonly readInputs: AgentLoopOptions['readInputs'];
  private readonly readInjections: AgentLoopOptions['readInjections'];
  private readonly finalizedToolCallIds = new Set<string>();
  private readonly listeners = new Set<(event: AgentLoopEvent) => void>();
  private readonly controller = new AbortController();
  private readonly injections: AgentLoopInput[] = [];
  private readonly supplements: AgentLoopInput[] = [];
  private readonly followUps: AgentLoopInput[] = [];
  private readonly totalUsage: ModelUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  private runPromise: Promise<AgentLoopResult> | undefined;
  private running = false;
  private cancellationRequested = false;
  private inputSequence = 0;
  private steps = 0;

  constructor(options: AgentLoopOptions) {
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new RangeError('maxSteps must be a positive integer.');
    }
    const executionId = options.executionId ?? randomUUID();
    if (executionId.trim().length === 0) {
      throw new RangeError('executionId must not be empty.');
    }
    this.provider = options.provider;
    this.persistence = options.persistence;
    this.tools = options.tools ?? [];
    this.messages = structuredClone([...(options.initialMessages ?? [])]);
    this.maxSteps = maxSteps;
    this.executionId = executionId;
    this.readInputs = options.readInputs;
    this.readInjections = options.readInjections;
  }

  subscribe(listener: (event: AgentLoopEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  run(input?: AgentLoopContent, options: AgentLoopRunOptions = {}): Promise<AgentLoopResult> {
    if (this.runPromise) throw new Error('This AgentLoop has already run.');
    this.running = true;
    const signal = options.signal;
    const cancelFromCaller = () => {
      this.cancel('The caller cancelled the run.');
    };
    if (signal?.aborted) cancelFromCaller();
    else signal?.addEventListener('abort', cancelFromCaller, { once: true });

    this.runPromise = this.execute(input, options.inputId).finally(() => {
      signal?.removeEventListener('abort', cancelFromCaller);
    });
    return this.runPromise;
  }

  inject(content: AgentLoopContent, id?: string): string {
    return this.addInput(this.injections, content, id);
  }

  supplement(content: AgentLoopContent, id?: string): string {
    return this.addInput(this.supplements, content, id);
  }

  enqueue(content: AgentLoopContent, id?: string): string {
    return this.addInput(this.followUps, content, id);
  }

  cancel(reason = 'Cancellation requested.'): boolean {
    if (!this.running || this.cancellationRequested) return false;
    this.cancellationRequested = true;
    this.controller.abort(new DOMException(reason, 'AbortError'));
    this.emit({ type: 'cancel_requested', reason });
    return true;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isCancellationRequested(): boolean {
    return this.cancellationRequested;
  }

  getContext(): ModelMessage[] {
    return structuredClone(this.messages);
  }

  getUsage(): ModelUsage {
    return { ...this.totalUsage };
  }

  private addInput(queue: AgentLoopInput[], content: AgentLoopContent, id?: string): string {
    if (!this.running)
      throw new Error('Inputs can only be submitted while the AgentLoop is running.');
    if (this.cancellationRequested) throw new Error('Cannot submit input after cancellation.');
    const normalized = requireUserContent(content);
    const inputId = id ?? `input-${++this.inputSequence}`;
    queue.push({ id: inputId, ...normalized });
    return inputId;
  }

  private currentInputs(mode: 'steer' | 'follow_up', queue: AgentLoopInput[]): AgentLoopInput[] {
    if (!this.readInputs) return queue;
    return [...this.readInputs(mode)];
  }

  private currentInjections(): AgentLoopInput[] {
    return this.readInjections ? [...this.readInjections()] : this.injections;
  }

  private async execute(input?: AgentLoopContent, inputId?: string): Promise<AgentLoopResult> {
    try {
      if (input !== undefined) await this.saveMessage(userMessage(input), inputId);
      let naturalEnd = false;

      while (true) {
        this.throwIfCancelled();
        const injections = this.currentInjections().splice(0);
        for (const injection of injections) {
          await this.saveMessage(userMessage(injection), undefined, undefined, injection.id);
        }
        const supplements = this.currentInputs('steer', this.supplements).splice(0);
        for (const supplement of supplements) {
          await this.saveMessage(userMessage(supplement), supplement.id);
        }

        if (naturalEnd) {
          if (supplements.length === 0 && injections.length === 0) {
            const followUp = this.currentInputs('follow_up', this.followUps).shift();
            if (followUp) await this.saveMessage(userMessage(followUp), followUp.id);
            else
              return this.finish({
                status: 'completed',
                steps: this.steps,
                usage: this.getUsage(),
              });
          }
          naturalEnd = false;
        }

        this.throwIfCancelled();
        if (this.steps >= this.maxSteps) {
          throw new AgentLoopError(
            'step_limit',
            `AgentLoop reached the ${this.maxSteps}-step limit.`,
          );
        }
        await this.runModelStep();
        naturalEnd = await this.runToolStep();
      }
    } catch (error) {
      if (this.cancellationRequested && !(error instanceof AgentLoopError)) {
        return this.finish({ status: 'cancelled', steps: this.steps, usage: this.getUsage() });
      }
      const loopError = this.asLoopError(error);
      if (loopError.code !== 'stream_interrupted') this.emit({ type: 'error', error: loopError });
      return this.finish({
        status: loopError.code === 'stream_interrupted' ? 'interrupted' : 'failed',
        steps: this.steps,
        usage: this.getUsage(),
        error: loopError,
      });
    }
  }

  private async runModelStep(): Promise<void> {
    this.steps += 1;
    const request: ModelRequest = {
      messages: structuredClone(this.messages),
      tools: this.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: structuredClone(tool.parameters),
      })),
    };

    const streamedBlocks: ContentBlock[] = [];
    try {
      for await (const event of this.provider.stream(request, this.controller.signal)) {
        this.throwIfCancelled();
        if (!isModelEvent(event)) {
          throw new AgentLoopError('invalid_provider_event', 'Provider returned an invalid event.');
        }
        if (event.type === 'text_delta' || event.type === 'thinking_delta') {
          if (event.text.length === 0) continue;
          const type = event.type === 'text_delta' ? 'text' : 'thinking';
          const blockIndex = event.block_index ?? 0;
          const previous = streamedBlocks.at(-1);
          if (
            (previous === undefined && blockIndex !== 0) ||
            (previous !== undefined &&
              (blockIndex < previous.block_index || blockIndex > previous.block_index + 1)) ||
            (previous !== undefined &&
              previous.block_index === blockIndex &&
              previous.type !== type)
          ) {
            throw new AgentLoopError(
              'invalid_provider_event',
              'Provider returned content deltas with invalid block ordering.',
            );
          }
          if (previous?.block_index === blockIndex) previous.text += event.text;
          else streamedBlocks.push({ type, block_index: blockIndex, text: event.text });
          this.emit({ type: event.type, text: event.text, block_index: blockIndex });
          continue;
        }
        if (event.type === 'stream_interrupted') {
          if (event.usage) this.addUsage(event.usage);
          const error = new AgentLoopError('stream_interrupted', event.error.message);
          this.emit({ type: 'error', error });
          throw error;
        }

        const message = this.materializeIncompleteCallIds(structuredClone(event.message));
        if (message.content_blocks !== undefined && streamedBlocks.length > 0) {
          if (!sameContentBlocks(message.content_blocks, streamedBlocks)) {
            throw new AgentLoopError(
              'invalid_provider_event',
              'Provider response blocks do not match its content deltas.',
            );
          }
        } else if (
          message.content_blocks === undefined &&
          streamedBlocks.some((block) => block.type === 'thinking')
        ) {
          throw new AgentLoopError(
            'invalid_provider_event',
            'Provider response is missing its thinking blocks.',
          );
        }
        const callIds = [
          ...(message.tool_calls ?? []).map((call) => call.id),
          ...(message.incomplete_tool_calls ?? []).map((call, index) =>
            this.incompleteCallId(call, index),
          ),
        ];
        if (new Set(callIds).size !== callIds.length) {
          throw new AgentLoopError(
            'invalid_provider_event',
            'Provider returned duplicate tool call ids.',
          );
        }
        await this.saveMessage(message, undefined, event.usage);
        this.addUsage(event.usage);
        return;
      }
    } catch (error) {
      if (error instanceof AgentLoopError || this.cancellationRequested) throw error;
      throw new AgentLoopError('model_request_failed', errorMessage(error), { cause: error });
    }
    throw new AgentLoopError(
      'model_request_failed',
      'Provider stream ended without a complete response or a stream interruption.',
    );
  }

  private materializeIncompleteCallIds(message: AssistantMessage): AssistantMessage {
    const calls = message.incomplete_tool_calls;
    if (!calls?.some((call) => call.id === undefined)) return message;
    return {
      ...message,
      incomplete_tool_calls: calls.map((call, index) => ({
        ...call,
        id: this.incompleteCallId(call, index),
      })),
    };
  }

  private incompleteCallId(call: IncompleteToolCall, index: number): string {
    return call.id ?? `incomplete-${this.executionId}-${this.steps}-${index + 1}`;
  }

  private async runToolStep(): Promise<boolean> {
    const assistant = this.messages.at(-1);
    if (assistant?.role !== 'assistant') {
      throw new AgentLoopError(
        'internal_error',
        'A saved assistant message is required before tool execution.',
      );
    }
    const completeCalls = assistant.tool_calls ?? [];
    const incompleteCalls = assistant.incomplete_tool_calls ?? [];
    if (completeCalls.length + incompleteCalls.length === 0) return true;

    const deferredErrors: unknown[] = [];
    let turnEnded = false;
    const processCall = async (
      callId: string,
      toolName: string,
      action: () => Promise<void> | Promise<boolean>,
      beforeResultSave?: Promise<void>,
    ): Promise<void> => {
      try {
        if ((await action()) === true) turnEnded = true;
      } catch (error) {
        if (!this.cancellationRequested || error instanceof AgentLoopError) throw error;
        deferredErrors.push(error);
      }
      if (!this.cancellationRequested || this.finalizedToolCallIds.has(callId)) return;
      try {
        await this.saveCancelledToolResult(callId, toolName, beforeResultSave);
      } catch (error) {
        if (error instanceof AgentLoopError) throw error;
        deferredErrors.push(error);
      }
    };

    for (const [index, call] of incompleteCalls.entries()) {
      const callId = this.incompleteCallId(call, index);
      const toolName = call.name ?? 'unknown';
      await processCall(callId, toolName, () =>
        this.cancellationRequested
          ? this.saveCancelledToolResult(callId, toolName)
          : this.rejectIncompleteCall(call, index),
      );
    }
    const isConcurrent = (call: ToolCall) =>
      this.tools.find((tool) => tool.name === call.name)?.concurrent === true;
    let callIndex = 0;
    while (callIndex < completeCalls.length) {
      const call = completeCalls[callIndex];
      if (!call) break;
      if (!isConcurrent(call)) {
        await processCall(call.id, call.name, () =>
          this.cancellationRequested
            ? this.saveCancelledToolResult(call.id, call.name)
            : this.runToolCall(call),
        );
        callIndex += 1;
        continue;
      }

      const group: ToolCall[] = [];
      while (callIndex < completeCalls.length) {
        const concurrentCall = completeCalls[callIndex];
        if (!concurrentCall || !isConcurrent(concurrentCall)) break;
        group.push(concurrentCall);
        callIndex += 1;
      }
      let previous = Promise.resolve();
      const pending: Promise<void>[] = [];
      for (const concurrentCall of group) {
        const beforeResultSave = previous.catch(() => undefined);
        const process = processCall(
          concurrentCall.id,
          concurrentCall.name,
          () =>
            this.cancellationRequested
              ? this.saveCancelledToolResult(
                  concurrentCall.id,
                  concurrentCall.name,
                  beforeResultSave,
                )
              : this.runToolCall(concurrentCall, beforeResultSave),
          beforeResultSave,
        );
        previous = process;
        pending.push(process);
      }
      for (const settled of await Promise.allSettled(pending)) {
        if (settled.status === 'rejected') throw settled.reason;
      }
    }
    if (deferredErrors.length > 0) throw deferredErrors[0];
    this.throwIfCancelled();
    return turnEnded;
  }

  private async rejectIncompleteCall(call: IncompleteToolCall, index: number): Promise<void> {
    const error: ToolError = { code: 'incomplete_call', message: call.error };
    const callId = this.incompleteCallId(call, index);
    const toolName = call.name ?? 'unknown';
    await this.saveMessage({
      role: 'tool',
      content: call.error,
      tool_call_id: callId,
      tool_name: toolName,
      status: 'error',
      error,
    });
    this.emit({
      type: 'tool_status',
      call_id: callId,
      tool_name: toolName,
      status: 'rejected',
      error,
    });
  }

  private async saveCancelledToolResult(
    callId: string,
    toolName: string,
    beforeResultSave?: Promise<void>,
  ): Promise<void> {
    if (this.finalizedToolCallIds.has(callId)) return;
    const error: ToolError = { code: 'cancelled', message: 'Tool execution was cancelled.' };
    if (beforeResultSave) await beforeResultSave;
    await this.saveMessage({
      role: 'tool',
      content: error.message,
      tool_call_id: callId,
      tool_name: toolName,
      status: 'error',
      error,
    });
    this.emit({
      type: 'tool_status',
      call_id: callId,
      tool_name: toolName,
      status: 'cancelled',
      error,
    });
  }

  private async runToolCall(call: ToolCall, beforeResultSave?: Promise<void>): Promise<boolean> {
    const tool = this.tools.find((candidate) => candidate.name === call.name);
    if (!tool) {
      await this.rejectToolCall(
        call,
        {
          code: 'unknown_tool',
          message: `Unknown tool: ${call.name}.`,
        },
        beforeResultSave,
      );
      return false;
    }

    let validatedArguments: unknown;
    try {
      validatedArguments = await tool.validate(call.arguments);
    } catch (error) {
      await this.rejectToolCall(
        call,
        { code: 'invalid_arguments', message: errorMessage(error) },
        beforeResultSave,
      );
      return false;
    }

    this.throwIfCancelled();
    try {
      await this.persistence.saveToolCall(structuredClone(call));
    } catch (error) {
      throw new AgentLoopError('persistence_failed', `Failed to save tool call ${call.id}.`, {
        cause: error,
      });
    }
    this.emit({
      type: 'tool_status',
      call_id: call.id,
      tool_name: call.name,
      status: 'intent_saved',
    });
    this.throwIfCancelled();
    this.emit({ type: 'tool_status', call_id: call.id, tool_name: call.name, status: 'running' });
    this.throwIfCancelled();

    let message: ToolMessage;
    let finalStatus: AgentLoopToolStatus;
    let commit: (() => void) | undefined;
    let operationUnknownError: AgentLoopError | undefined;
    let endTurn = false;
    try {
      const result = await tool.execute(validatedArguments, {
        call: structuredClone(call),
        signal: this.controller.signal,
      });
      const normalized = typeof result === 'string' ? { content: result } : result;
      if (typeof normalized.content !== 'string') {
        throw new Error('Tool result content must be a string.');
      }
      if (normalized.content_parts !== undefined && !Array.isArray(normalized.content_parts)) {
        throw new Error('Tool result content parts must be an array.');
      }
      if (normalized.endTurn !== undefined && typeof normalized.endTurn !== 'boolean') {
        throw new Error('Tool endTurn must be a boolean.');
      }
      const status = normalized.status ?? 'success';
      commit = normalized.commit;
      message = {
        role: 'tool',
        content: normalized.content,
        ...(normalized.content_parts === undefined
          ? {}
          : { content_parts: normalized.content_parts }),
        tool_call_id: call.id,
        tool_name: call.name,
        status,
      };
      if (status === 'error') {
        message.error = { code: 'execution_failed', message: normalized.content };
      }
      finalStatus = status === 'success' ? 'succeeded' : 'failed';
      endTurn = status === 'success' && normalized.endTurn === true;
    } catch (error) {
      const operationUnknown =
        error instanceof AgentLoopError && error.code === 'operation_unknown';
      if (operationUnknown) operationUnknownError = error;
      const cancelled = this.cancellationRequested && isAbortError(error);
      const toolError: ToolError = {
        code: operationUnknown ? 'execution_failed' : cancelled ? 'cancelled' : 'execution_failed',
        message: cancelled ? 'Tool execution was cancelled.' : errorMessage(error),
      };
      message = {
        role: 'tool',
        content: toolError.message,
        tool_call_id: call.id,
        tool_name: call.name,
        status: 'error',
        error: toolError,
      };
      finalStatus = cancelled ? 'cancelled' : 'failed';
    }

    if (beforeResultSave) await beforeResultSave;
    await this.saveMessage(message, undefined, undefined, undefined, commit);
    this.emit({
      type: 'tool_status',
      call_id: call.id,
      tool_name: call.name,
      status: finalStatus,
      ...(message.error ? { error: message.error } : {}),
    });
    if (operationUnknownError) throw operationUnknownError;
    return endTurn;
  }

  private async rejectToolCall(
    call: ToolCall,
    error: ToolError,
    beforeResultSave?: Promise<void>,
  ): Promise<void> {
    if (beforeResultSave) await beforeResultSave;
    await this.saveMessage({
      role: 'tool',
      content: error.message,
      tool_call_id: call.id,
      tool_name: call.name,
      status: 'error',
      error,
    });
    this.emit({
      type: 'tool_status',
      call_id: call.id,
      tool_name: call.name,
      status: 'rejected',
      error,
    });
  }

  private async saveMessage(
    message: ModelMessage,
    inputId?: string,
    responseUsage?: ModelUsage,
    deliveryId?: string,
    commit?: () => void,
  ): Promise<void> {
    const saved = structuredClone(message);
    try {
      if (commit !== undefined) {
        if (saved.role !== 'tool' || this.persistence.saveToolResult === undefined) {
          throw new Error('Atomic tool result persistence is unavailable.');
        }
        await this.persistence.saveToolResult(structuredClone(saved), commit);
      } else {
        await this.persistence.saveMessage(
          structuredClone(saved),
          inputId,
          responseUsage,
          deliveryId,
        );
      }
    } catch (error) {
      throw new AgentLoopError('persistence_failed', `Failed to save ${message.role} message.`, {
        cause: error,
      });
    }
    this.messages.push(saved);
    if (saved.role === 'tool') this.finalizedToolCallIds.add(saved.tool_call_id);
    this.emit({ type: 'message', message: structuredClone(saved) });
  }

  private addUsage(usage: DetailedModelUsage): void {
    this.totalUsage.input_tokens += usage.input_tokens;
    this.totalUsage.output_tokens += usage.output_tokens;
    this.totalUsage.total_tokens =
      (this.totalUsage.total_tokens ?? 0) +
      (usage.total_tokens ?? usage.input_tokens + usage.output_tokens);
    this.emit({ type: 'usage', usage: { ...usage }, total_usage: this.getUsage() });
  }

  private throwIfCancelled(): void {
    if (this.cancellationRequested) throw this.controller.signal.reason;
  }

  private finish(result: AgentLoopResult): AgentLoopResult {
    this.running = false;
    this.emit({ type: 'complete', result });
    return result;
  }

  private asLoopError(error: unknown): AgentLoopError {
    if (error instanceof AgentLoopError) return error;
    return new AgentLoopError('internal_error', errorMessage(error), { cause: error });
  }

  private emit(event: AgentLoopEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function isModelEvent(value: unknown): value is ModelEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'text_delta') {
    return (
      typeof value.text === 'string' &&
      (value.block_index === undefined || isBlockIndex(value.block_index))
    );
  }
  if (value.type === 'thinking_delta') {
    return typeof value.text === 'string' && isBlockIndex(value.block_index);
  }
  if (value.type === 'stream_interrupted') {
    return (
      isRecord(value.error) &&
      value.error.code === 'stream_interrupted' &&
      typeof value.error.message === 'string' &&
      (value.usage === undefined || isUsage(value.usage))
    );
  }
  if (value.type !== 'response' || !isUsage(value.usage)) return false;
  return isAssistantMessage(value.message);
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  if (!isRecord(value) || value.role !== 'assistant' || typeof value.content !== 'string')
    return false;
  if (value.content_blocks !== undefined) {
    if (!Array.isArray(value.content_blocks) || !value.content_blocks.every(isContentBlock)) {
      return false;
    }
    if (value.content_blocks.some((block, index) => block.block_index !== index)) return false;
    const content = value.content_blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (content !== value.content) return false;
  }
  if (value.tool_calls !== undefined) {
    if (!Array.isArray(value.tool_calls) || !value.tool_calls.every(isToolCall)) return false;
  }
  if (value.incomplete_tool_calls !== undefined) {
    if (
      !Array.isArray(value.incomplete_tool_calls) ||
      !value.incomplete_tool_calls.every(isIncompleteToolCall)
    ) {
      return false;
    }
  }
  return true;
}

function isContentBlock(value: unknown): value is ContentBlock {
  return (
    isRecord(value) &&
    (value.type === 'text' || value.type === 'thinking') &&
    isBlockIndex(value.block_index) &&
    typeof value.text === 'string' &&
    value.text.length > 0
  );
}

function isBlockIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function sameContentBlocks(left: readonly ContentBlock[], right: readonly ContentBlock[]): boolean {
  return (
    left.length === right.length &&
    left.every((block, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        block.type === other.type &&
        block.block_index === other.block_index &&
        block.text === other.text
      );
    })
  );
}

function isToolCall(value: unknown): value is ToolCall {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    isRecord(value.arguments) &&
    (value.block_index === undefined || isBlockIndex(value.block_index))
  );
}

function isIncompleteToolCall(value: unknown): value is IncompleteToolCall {
  return (
    isRecord(value) &&
    (value.id === undefined || typeof value.id === 'string') &&
    (value.name === undefined || typeof value.name === 'string') &&
    typeof value.arguments_text === 'string' &&
    typeof value.error === 'string'
  );
}

function isUsage(value: unknown): value is DetailedModelUsage {
  return (
    isRecord(value) &&
    isTokenCount(value.input_tokens) &&
    isTokenCount(value.output_tokens) &&
    (value.total_tokens === undefined || isTokenCount(value.total_tokens)) &&
    (value.prompt_tokens_details === undefined ||
      (isRecord(value.prompt_tokens_details) &&
        isTokenCount(value.prompt_tokens_details.cached_tokens)))
  );
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
