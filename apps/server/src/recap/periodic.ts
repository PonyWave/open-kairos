import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ModelMessage, ModelProvider } from '@kairos/agent-core';
import { z } from 'zod';
import { ContextStore } from '../context/context-store.js';
import { currentModelMessageWithMeta } from '../context/model-input.js';
import { ModelInputService } from '../context/model-input-service.js';
import type { Clock, ContextMessage, ToolCallRelation } from '../context/types.js';
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
  triggerMessages: number;
  idleAfterMs: number;
  maxMessages: number;
}

const PRIOR_RECAP_INSTRUCTION_LIMIT = 3;

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
}

type PeriodicAssessment =
  | { kind: 'generate'; plan: PeriodicPlan }
  | { kind: 'wait'; delayMs: number }
  | { kind: 'skip' };

function validateConfiguration(configuration: PeriodicRecapConfiguration): void {
  if (
    !Number.isSafeInteger(configuration.triggerMessages) ||
    configuration.triggerMessages <= 0 ||
    !Number.isSafeInteger(configuration.idleAfterMs) ||
    configuration.idleAfterMs < 0 ||
    !Number.isSafeInteger(configuration.maxMessages) ||
    configuration.maxMessages <= 0
  ) {
    throw new Error(
      'Periodic Recap trigger messages, max messages and idle duration must be safe integers; the idle duration may be zero.',
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
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
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
    for (const key of [...this.#timers.keys()]) this.#clearTimer(key);
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
    const assessment = this.#assess(threadId, agentId);
    if (assessment.kind === 'wait') {
      this.#armTimer(threadId, agentId, assessment.delayMs);
      return;
    }
    this.#clearTimer(`${threadId}\0${agentId}`);
    if (assessment.kind === 'skip') return;
    const plan = assessment.plan;
    const started = this.#operations.begin(plan.operation);
    if (started.status !== 'started') return;
    try {
      signal.throwIfAborted();
      const output = await this.#generator.generate(plan.operation.generation, signal);
      signal.throwIfAborted();
      this.#operations.complete(plan.operation, output);
      this.schedule(threadId, agentId);
    } catch (error) {
      this.#operations.fail(
        plan.operation,
        error,
        this.#closing || signal.aborted ? 'interrupted' : 'failed',
      );
      throw error;
    }
  }

  #armTimer(threadId: string, agentId: string, delayMs: number): void {
    if (this.#closing) return;
    const key = `${threadId}\0${agentId}`;
    this.#clearTimer(key);
    const timer = setTimeout(() => {
      this.#timers.delete(key);
      this.schedule(threadId, agentId);
    }, delayMs);
    this.#timers.set(key, timer);
  }

  #clearTimer(key: string): void {
    const timer = this.#timers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.#timers.delete(key);
  }

  #assess(threadId: string, agentId: string): PeriodicAssessment {
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
    if (requestRow && this.#acceptRequest && !this.#acceptRequest(requestRow.request_id)) {
      return { kind: 'skip' };
    }
    const record = requestRow
      ? this.#modelInputs.getRequestRecord(requestRow.request_id)
      : undefined;
    if (!record?.request) return { kind: 'skip' };
    const snapshot = this.#context.query({ threadId, agentId, currentOnly: true });
    const snapshotBySeq = new Map(snapshot.map((message) => [message.seq, message]));
    const inputBoundary = Math.max(record.readThroughSeq, 0, ...record.contextMessageSeqs);
    const response = snapshot.find((message) => message.seq > inputBoundary);
    if (
      response?.message.role !== 'assistant' ||
      response.createdAt > record.updatedAt ||
      response.responseUsage === undefined
    ) {
      return { kind: 'skip' };
    }
    const relations = this.#context.listToolCallRelations(threadId, agentId, {
      currentOnly: true,
    });
    const responseRelations = relations.filter(
      (relation) => relation.assistantSeq === response.seq,
    );
    if (responseRelations.some((relation) => relation.resultSeq === null)) return { kind: 'skip' };
    const toolSeqs = responseRelations
      .map((relation) => relation.resultSeq)
      .filter((seq): seq is number => seq !== null)
      .sort((left, right) => left - right);
    const boundary = Math.max(response.seq, ...toolSeqs);
    const currentSeqs = new Set(snapshot.map((message) => message.seq));
    const currentRecaps = this.#recaps
      .query({ threadId, agentId, validity: 'valid' })
      .filter((recap) => recap.sourceMessageSeqs.every((seq) => currentSeqs.has(seq)));
    const frontier = currentRecaps.reduce(
      (maximum, recap) => Math.max(maximum, recap.sourceSeqEnd),
      0,
    );
    const sources = snapshot.filter((message) => message.seq > frontier && message.seq <= boundary);
    if (sources.length <= this.#configuration.triggerMessages) return { kind: 'skip' };
    const sourceSeqs = new Set(sources.map((message) => message.seq));
    for (const relation of relations) {
      const hasAssistant = sourceSeqs.has(relation.assistantSeq);
      const hasResult = relation.resultSeq !== null && sourceSeqs.has(relation.resultSeq);
      if (hasAssistant === hasResult && (!hasAssistant || relation.resultSeq !== null)) continue;
      return { kind: 'skip' };
    }
    const completedAt = new Date(record.updatedAt).getTime();
    if (!Number.isFinite(completedAt)) return { kind: 'skip' };
    const idleRemaining = this.#configuration.idleAfterMs - (this.#clock().getTime() - completedAt);
    if (idleRemaining > 0) return { kind: 'wait', delayMs: idleRemaining };
    const capped = this.#capSources(sources, snapshotBySeq, relations);
    if (capped.length === 0) return { kind: 'skip' };
    const normalRequest = record.request;
    const contextOffset = normalRequest.messages.length - record.contextMessageSeqs.length;
    if (contextOffset < 0) return { kind: 'skip' };
    const requestIndexes = new Map(
      record.contextMessageSeqs.map((seq, index) => [seq, contextOffset + index]),
    );
    const toolIndexes = new Map(
      toolSeqs.map((seq, index) => [seq, normalRequest.messages.length + index + 1]),
    );
    const sourceMessageIndexes: Array<{ seq: number; messageIndex: number }> = [];
    for (const source of capped) {
      const requestIndex = requestIndexes.get(source.seq);
      const appendedIndex =
        source.seq === response.seq ? normalRequest.messages.length : toolIndexes.get(source.seq);
      const messageIndex = requestIndex ?? appendedIndex;
      if (messageIndex === undefined) return { kind: 'skip' };
      if (requestIndex !== undefined) {
        const sent = normalRequest.messages[requestIndex];
        if (!sent || !sameMessage(sent, currentModelMessageWithMeta(source)))
          return { kind: 'skip' };
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
    const priorRecaps = [...currentRecaps]
      .sort((left, right) => left.sourceSeqEnd - right.sourceSeqEnd)
      .slice(-PRIOR_RECAP_INSTRUCTION_LIMIT)
      .map((recap) => ({
        sourceSeqStart: recap.sourceSeqStart,
        sourceSeqEnd: recap.sourceSeqEnd,
        content: recap.content,
      }));
    const generation: RecapGenerationInput = {
      threadId,
      agentId,
      sourceMessageSeqs: capped.map((message) => message.seq),
      sourceMessageIndexes,
      messages: capped.map((source) => ({
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
      ...(priorRecaps.length > 0 ? { priorRecaps } : {}),
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
      kind: 'generate',
      plan: {
        operation: {
          generation,
          sourceFingerprint: fingerprintRecapSources(capped),
          instructionVersion: RECAP_INSTRUCTION_VERSION,
          requestFingerprint,
        },
      },
    };
  }

  #capSources(
    sources: readonly ContextMessage[],
    snapshotBySeq: ReadonlyMap<number, ContextMessage>,
    relations: readonly ToolCallRelation[],
  ): ContextMessage[] {
    const limit = this.#configuration.maxMessages;
    const resultSeqsByAssistant = new Map<number, number[]>();
    for (const relation of relations) {
      if (relation.resultSeq === null) continue;
      const group = resultSeqsByAssistant.get(relation.assistantSeq) ?? [];
      group.push(relation.resultSeq);
      resultSeqsByAssistant.set(relation.assistantSeq, group);
    }
    const included = new Set<number>();
    const capped: ContextMessage[] = [];
    for (const message of sources) {
      if (included.has(message.seq)) continue;
      const unit = [message];
      for (const resultSeq of resultSeqsByAssistant.get(message.seq) ?? []) {
        const result = snapshotBySeq.get(resultSeq);
        if (result && !included.has(result.seq)) unit.push(result);
      }
      if (capped.length + unit.length > limit) break;
      for (const entry of unit) {
        included.add(entry.seq);
        capped.push(entry);
      }
    }
    return capped;
  }
}
