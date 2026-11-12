import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ModelMessage, ModelProvider } from '@kairos/agent-core';
import { z } from 'zod';
import { ContextStore } from '../context/context-store.js';
import { ModelInputService } from '../context/model-input-service.js';
import type { Clock } from '../context/types.js';
import { currentModelMessage, jsonText, systemClock } from '../context/types.js';
import { RECAP_INSTRUCTION_VERSION, RecapModelGenerator } from './generation.js';
import {
  fingerprintRecapSources,
  type RecapGenerationOperationInput,
  RecapGenerationOperationStore,
} from './generation-operation-store.js';
import type { RecapGenerationInput } from './generation-types.js';
import { RecapStore } from './recap-store.js';

export interface PeriodicRecapConfiguration {
  messageThreshold: number;
  responseWindowMs: number;
}

export interface PeriodicRecapModelParameters {
  providerId: string;
  modelId: string;
  contextWindowTokens: number;
  outputReserveTokens: number;
}

interface PeriodicRecapOptions {
  database: DatabaseSync;
  provider: ModelProvider;
  model: PeriodicRecapModelParameters;
  configuration: PeriodicRecapConfiguration;
  clock?: Clock;
  recapStore?: RecapStore;
  onError?: (error: unknown) => void;
  acceptRequest?: (requestId: string) => boolean;
}

interface ActiveGeneration {
  controller: AbortController;
  promise: Promise<void>;
  evaluateAgain: boolean;
}

interface PeriodicPlan {
  operation: RecapGenerationOperationInput;
  responseCompletedAt: string;
}

function validateConfiguration(configuration: PeriodicRecapConfiguration): void {
  if (
    !Number.isSafeInteger(configuration.messageThreshold) ||
    configuration.messageThreshold <= 0 ||
    !Number.isSafeInteger(configuration.responseWindowMs) ||
    configuration.responseWindowMs <= 0
  ) {
    throw new Error(
      'Periodic Recap message threshold and response window must be positive safe integers.',
    );
  }
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value;
}

function sameMessage(left: ModelMessage, right: ModelMessage): boolean {
  return jsonText(left, 'left message') === jsonText(right, 'right message');
}

export class PeriodicRecapService {
  readonly #acceptRequest: ((requestId: string) => boolean) | undefined;
  readonly #database: DatabaseSync;
  readonly #context: ContextStore;
  readonly #recaps: RecapStore;
  readonly #modelInputs: ModelInputService;
  readonly #operations: RecapGenerationOperationStore;
  readonly #generator: RecapModelGenerator;
  readonly #model: PeriodicRecapModelParameters;
  readonly #configuration: PeriodicRecapConfiguration;
  readonly #clock: Clock;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #active = new Map<string, ActiveGeneration>();
  #closing = false;

  constructor(options: PeriodicRecapOptions) {
    validateConfiguration(options.configuration);
    this.#acceptRequest = options.acceptRequest;
    this.#database = options.database;
    this.#context = new ContextStore(options.database, options.clock);
    this.#recaps = options.recapStore ?? new RecapStore(options.database, options.clock);
    this.#modelInputs = new ModelInputService(options.database, {
      countTokens: () => 0,
      ...(options.clock ? { clock: options.clock } : {}),
      recapStore: this.#recaps,
    });
    this.#operations = new RecapGenerationOperationStore(
      options.database,
      options.clock,
      this.#recaps,
    );
    this.#generator = new RecapModelGenerator(options.provider);
    this.#model = options.model;
    this.#configuration = options.configuration;
    this.#clock = options.clock ?? systemClock;
    this.#onError = options.onError;
  }

  schedule(threadId: string, agentId: string): void {
    if (this.#closing) return;
    const key = `${threadId}\0${agentId}`;
    const existing = this.#active.get(key);
    if (existing) {
      existing.evaluateAgain = true;
      return;
    }
    const state: ActiveGeneration = {
      controller: new AbortController(),
      promise: Promise.resolve(),
      evaluateAgain: false,
    };
    state.promise = this.#drive(key, threadId, agentId, state);
    this.#active.set(key, state);
  }

  hasActive(threadId: string, agentId: string): boolean {
    return this.#active.has(`${threadId}\0${agentId}`);
  }

  resume(): void {
    if (this.#closing) return;
    this.#operations.recoverInterrupted();
    const owners = z.array(z.object({ thread_id: z.string(), agent_id: z.string() })).parse(
      this.#database
        .prepare(
          `SELECT DISTINCT thread_id, agent_id FROM model_request_records
             WHERE status = 'completed' ORDER BY thread_id, agent_id`,
        )
        .all(),
    );
    for (const owner of owners) this.schedule(owner.thread_id, owner.agent_id);
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    const active = [...this.#active.values()];
    for (const state of active) {
      state.evaluateAgain = false;
      state.controller.abort(new DOMException('Server is shutting down.', 'AbortError'));
    }
    await Promise.all(active.map((state) => state.promise));
  }

  async #drive(
    key: string,
    threadId: string,
    agentId: string,
    state: ActiveGeneration,
  ): Promise<void> {
    try {
      do {
        state.evaluateAgain = false;
        try {
          await this.#evaluate(threadId, agentId, state.controller.signal);
        } catch (error) {
          if (!this.#closing && !state.controller.signal.aborted) this.#onError?.(error);
        }
      } while (state.evaluateAgain && !this.#closing && !state.controller.signal.aborted);
    } finally {
      if (this.#active.get(key) === state) this.#active.delete(key);
    }
  }

  async #evaluate(threadId: string, agentId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const plan = this.#createPlan(threadId, agentId);
    if (!plan) return;
    const started = this.#operations.begin(plan.operation);
    if (started.status !== 'started') return;
    try {
      signal.throwIfAborted();
      if (!this.#withinResponseWindow(plan.responseCompletedAt)) {
        this.#operations.fail(
          plan.operation,
          new Error('The latest complete response is outside the periodic Recap window.'),
        );
        return;
      }
      const output = await this.#generator.generate(plan.operation.generation, signal);
      signal.throwIfAborted();
      this.#operations.complete(plan.operation, output);
    } catch (error) {
      this.#operations.fail(
        plan.operation,
        error,
        this.#closing || signal.aborted ? 'interrupted' : 'failed',
      );
      throw error;
    }
  }

  #withinResponseWindow(responseCompletedAt: string): boolean {
    const completed = new Date(responseCompletedAt).getTime();
    return (
      Number.isFinite(completed) &&
      this.#clock().getTime() - completed <= this.#configuration.responseWindowMs
    );
  }

  #createPlan(threadId: string, agentId: string): PeriodicPlan | undefined {
    const state = this.#modelInputs.getState(threadId, agentId);
    const requestRow = z
      .object({ request_id: z.string() })
      .optional()
      .parse(
        this.#database
          .prepare(
            `SELECT request_id FROM model_request_records
             WHERE thread_id = ? AND agent_id = ? AND status = 'completed' AND view_version = ?
             ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
          )
          .get(threadId, agentId, state.viewVersion),
      );
    if (requestRow && this.#acceptRequest && !this.#acceptRequest(requestRow.request_id))
      return undefined;
    const record = requestRow
      ? this.#modelInputs.getRequestRecord(requestRow.request_id)
      : undefined;
    if (!record?.request || !this.#withinResponseWindow(record.updatedAt)) return undefined;
    const snapshot = this.#context.query({ threadId, agentId, currentOnly: true });
    const snapshotBySeq = new Map(snapshot.map((message) => [message.seq, message]));
    const inputBoundary = Math.max(record.readThroughSeq, 0, ...record.contextMessageSeqs);
    const response = snapshot.find((message) => message.seq > inputBoundary);
    if (
      response?.message.role !== 'assistant' ||
      response.createdAt > record.updatedAt ||
      response.responseUsage === undefined
    ) {
      return undefined;
    }
    const relations = this.#context.listToolCallRelations(threadId, agentId, {
      currentOnly: true,
    });
    const responseRelations = relations.filter(
      (relation) => relation.assistantSeq === response.seq,
    );
    if (responseRelations.some((relation) => relation.resultSeq === null)) return undefined;
    const toolSeqs = responseRelations
      .map((relation) => relation.resultSeq)
      .filter((seq): seq is number => seq !== null)
      .sort((left, right) => left - right);
    const boundary = Math.max(response.seq, ...toolSeqs);
    const currentSeqs = new Set(snapshot.map((message) => message.seq));
    const frontier = this.#recaps
      .query({ threadId, agentId, validity: 'valid' })
      .filter((recap) => recap.sourceMessageSeqs.every((seq) => currentSeqs.has(seq)))
      .reduce((maximum, recap) => Math.max(maximum, recap.sourceSeqEnd), 0);
    const sources = snapshot.filter((message) => message.seq > frontier && message.seq <= boundary);
    if (sources.length < this.#configuration.messageThreshold || sources.length === 0) {
      return undefined;
    }
    const sourceSeqs = new Set(sources.map((message) => message.seq));
    for (const relation of relations) {
      const hasAssistant = sourceSeqs.has(relation.assistantSeq);
      const hasResult = relation.resultSeq !== null && sourceSeqs.has(relation.resultSeq);
      if (hasAssistant === hasResult && (!hasAssistant || relation.resultSeq !== null)) continue;
      return undefined;
    }
    const sourceMessageSeqs = sources.map((message) => message.seq);
    const normalRequest = record.request;
    const contextOffset = normalRequest.messages.length - record.contextMessageSeqs.length;
    if (contextOffset < 0) return undefined;
    const requestIndexes = new Map(
      record.contextMessageSeqs.map((seq, index) => [seq, contextOffset + index]),
    );
    const toolIndexes = new Map(
      toolSeqs.map((seq, index) => [seq, normalRequest.messages.length + index + 1]),
    );
    const sourceMessageIndexes: Array<{ seq: number; messageIndex: number }> = [];
    for (const source of sources) {
      const requestIndex = requestIndexes.get(source.seq);
      const appendedIndex =
        source.seq === response.seq ? normalRequest.messages.length : toolIndexes.get(source.seq);
      const messageIndex = requestIndex ?? appendedIndex;
      if (messageIndex === undefined) return undefined;
      if (requestIndex !== undefined) {
        const sent = normalRequest.messages[requestIndex];
        if (!sent || !sameMessage(sent, currentModelMessage(source))) return undefined;
      }
      sourceMessageIndexes.push({ seq: source.seq, messageIndex });
    }
    const appended = [
      currentModelMessage(response),
      ...toolSeqs.map((seq) => {
        const tool = snapshotBySeq.get(seq);
        if (!tool) throw new Error(`Tool result ${seq} is missing from the current Context view.`);
        return currentModelMessage(tool);
      }),
    ];
    const generation: RecapGenerationInput = {
      threadId,
      agentId,
      sourceMessageSeqs,
      sourceMessageIndexes,
      messages: sources.map((source) => ({
        seq: source.seq,
        createdAt: source.createdAt,
        message: currentModelMessage(source),
      })),
      request: {
        messages: [...normalRequest.messages, ...appended],
        tools: normalRequest.tools,
      },
      viewVersion: state.viewVersion,
      trigger: 'periodic',
    };
    const recapRequest = this.#generator.prepareRequest(generation);
    const requestFingerprint = createHash('sha256')
      .update(
        jsonText(
          canonicalJson({ request: recapRequest, model: this.#model }),
          'Recap request fingerprint',
        ),
      )
      .digest('hex');
    return {
      operation: {
        generation,
        sourceFingerprint: fingerprintRecapSources(sources),
        instructionVersion: RECAP_INSTRUCTION_VERSION,
        requestFingerprint,
      },
      responseCompletedAt: record.updatedAt,
    };
  }
}
