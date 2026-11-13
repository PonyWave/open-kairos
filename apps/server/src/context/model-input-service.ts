import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ModelMessage, ModelRequest } from '@kairos/agent-core';
import { z } from 'zod';
import { MAX_MODEL_REQUEST_BYTES } from '../attachments/validation.js';
import type { RecapGenerator, RecapSourceMessageIndex } from '../recap/generation-types.js';
import { RecapStore } from '../recap/recap-store.js';
import { selectRecapCoverage } from '../recap/selection.js';
import type { Recap, RecapSourceGroup, SaveRecapInput } from '../recap/types.js';
import { RecapError } from '../recap/types.js';
import { inTransaction } from '../storage/transaction.js';
import { ContextStore } from './context-store.js';
import { buildModelMessages, currentModelMessageWithMeta } from './model-input.js';
import type { Clock, ContextMessage, ToolCallRelation } from './types.js';
import {
  ContextError,
  createId,
  currentModelMessage,
  isoTime,
  jsonText,
  modelMessageSchema,
  parseJson,
  parseModelMessage,
  requireIdentifier,
  requireSequence,
  systemClock,
} from './types.js';

export type HardCutErrorCode =
  | 'cancelled'
  | 'concurrent_modification'
  | 'hard_cut_over_limit'
  | 'invalid_request'
  | 'output_reserve_exceeded'
  | 'recap_generation_failed'
  | 'request_conflict'
  | 'source_changed'
  | 'storage_failed'
  | 'token_count_failed'
  | 'unfinished_tool_round_trip';

export class HardCutError extends Error {
  readonly code: HardCutErrorCode;

  constructor(code: HardCutErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HardCutError';
    this.code = code;
  }
}

export type TokenCounter = (request: ModelRequest) => number | Promise<number>;

export type {
  RecapGenerationInput,
  RecapGenerator,
  RecapSourceMessage,
  RecapSourceMessageIndex,
} from '../recap/generation-types.js';

export interface PrepareModelInput {
  threadId: string;
  agentId: string;
  systemInstructions: readonly string[];
  tools: ModelRequest['tools'];
  contextWindowTokens: number;
  pendingMessages?: readonly ModelMessage[];
  pendingContextSeqs?: readonly number[];
  outputReserveTokens?: number;
  requestId?: string;
  hardCutMode?: 'manual';
  onCommitted?: (prepared: PreparedModelInput) => void;
  signal?: AbortSignal;
}

export interface ModelInputState {
  threadId: string;
  agentId: string;
  readThroughSeq: number;
  viewVersion: number;
  selectedRecapIds: readonly string[];
  lastRequestId: string | null;
  updatedAt: string | null;
}

export interface PreparedModelInput {
  requestId: string;
  request: ModelRequest;
  estimatedInputTokens: number;
  contextWindowTokens: number;
  outputReserveTokens: number;
  readThroughSeq: number;
  selectedRecapIds: readonly string[];
  contextMessageSeqs: readonly number[];
  hardCut: boolean;
}

export interface ModelRequestRecord {
  requestId: string;
  threadId: string;
  agentId: string;
  status: 'preparing' | 'ready' | 'completed' | 'failed' | 'cancelled';
  estimatedInputTokens: number | null;
  contextWindowTokens: number;
  outputReserveTokens: number;
  readThroughSeq: number;
  viewVersion: number;
  selectedRecapIds: readonly string[];
  contextMessageSeqs: readonly number[];
  request: ModelRequest | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface NormalizedInput {
  threadId: string;
  agentId: string;
  systemInstructions: readonly string[];
  tools: ModelRequest['tools'];
  contextWindowTokens: number;
  pendingMessages: readonly ModelMessage[];
  pendingContextSeqs: readonly number[];
  outputReserveTokens: number;
  requestId: string;
  manual: boolean;
  onCommitted?: (prepared: PreparedModelInput) => void;
  signal: AbortSignal;
}

interface GeneratedRecap {
  input: SaveRecapInput;
  recap: Recap;
}

interface StoredRequest extends ModelRequestRecord {
  requestFingerprint: string | null;
  pendingContextSeqs: readonly number[];
  preparationId: string | null;
  hardCut: boolean | null;
}

type PreparationStart =
  | { status: 'ready'; prepared: PreparedModelInput }
  | {
      status: 'preparing';
      previousState: ModelInputState;
      pendingContextSeqs: readonly number[];
      preparationId: string;
    };

const stateRowSchema = z.object({
  read_through_seq: z.number().int().nonnegative(),
  view_version: z.number().int().nonnegative(),
  last_request_id: z.string().nullable(),
  updated_at: z.string(),
});
const requestRowSchema = z.object({
  request_id: z.string(),
  thread_id: z.string(),
  agent_id: z.string(),
  status: z.enum(['preparing', 'ready', 'completed', 'failed', 'cancelled']),
  estimated_input_tokens: z.number().int().nonnegative().nullable(),
  context_window_tokens: z.number().int().positive(),
  output_reserve_tokens: z.number().int().nonnegative(),
  read_through_seq: z.number().int().nonnegative(),
  view_version: z.number().int().nonnegative(),
  selected_recap_ids_json: z.string(),
  context_message_seqs_json: z.string(),
  request_json: z.string().nullable(),
  request_fingerprint: z.string().nullable(),
  pending_context_seqs_json: z.string(),
  preparation_id: z.string().nullable(),
  hard_cut: z.number().int().min(0).max(1).nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const toolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
});
const generatedRecapSchema = z.object({ content: z.string() });
const storedRequestSchema = z.object({
  messages: z.array(modelMessageSchema),
  tools: z.array(toolSchema),
});

function compareRecaps(left: Recap, right: Recap): number {
  const leftSources = left.sourceMessageSeqs;
  const rightSources = right.sourceMessageSeqs;
  const length = Math.min(leftSources.length, rightSources.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftSources[index] ?? 0) - (rightSources[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftSources.length - rightSources.length || left.recapId.localeCompare(right.recapId);
}

function sortedRecaps(recaps: readonly Recap[]): Recap[] {
  return [...recaps].sort(compareRecaps);
}

function sameSequences(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    );
  }
  return value;
}

export function runtimeSpecFingerprint(
  systemInstructions: readonly string[],
  tools: ModelRequest['tools'],
): string {
  const serialized = jsonText(
    canonicalJsonValue({ version: 1, systemInstructions, tools }),
    'runtime spec fingerprint',
  );
  return createHash('sha256').update('kairos-runtime-spec-v1\0').update(serialized).digest('hex');
}

export function runtimeSpecFingerprintFromRequest(request: ModelRequest): string | undefined {
  const systemInstructions: string[] = [];
  for (const message of request.messages) {
    if (message.role !== 'system') break;
    systemInstructions.push(message.content);
  }
  return systemInstructions.length === 0
    ? undefined
    : runtimeSpecFingerprint(systemInstructions, request.tools);
}

export class ModelInputService {
  readonly #configurationId: string | undefined;
  readonly #database: DatabaseSync;
  readonly #context: ContextStore;
  readonly #recaps: RecapStore;
  readonly #countTokens: TokenCounter;
  readonly #materializeRequest: (request: ModelRequest) => ModelRequest;
  readonly #generateRecap: RecapGenerator | undefined;
  readonly #clock: Clock;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(
    database: DatabaseSync,
    options: {
      countTokens: TokenCounter;
      configurationId?: string;
      materializeRequest?: (request: ModelRequest) => ModelRequest;
      generateRecap?: RecapGenerator;
      clock?: Clock;
      recapStore?: RecapStore;
    },
  ) {
    this.#configurationId = options.configurationId;
    this.#database = database;
    this.#context = new ContextStore(database, options.clock);
    this.#recaps = options.recapStore ?? new RecapStore(database, options.clock);
    this.#countTokens = options.countTokens;
    this.#materializeRequest = options.materializeRequest ?? ((request) => request);
    this.#generateRecap = options.generateRecap;
    this.#clock = options.clock ?? systemClock;
  }

  async prepare(input: PrepareModelInput): Promise<PreparedModelInput> {
    const normalized = this.#normalizeInput(input);
    const key = `${normalized.threadId}\0${normalized.agentId}`;
    return this.#exclusive(key, () => this.#prepareLocked(normalized));
  }

  getState(threadId: string, agentId: string): ModelInputState {
    return this.#readState(threadId, agentId);
  }

  getRequestRecord(requestId: string): ModelRequestRecord | undefined {
    return this.#readStoredRequest(requestId);
  }

  getLatestCompletedNormalRequest(
    threadId: string,
    agentId: string,
    viewVersion: number,
  ): ModelRequest | undefined {
    requireIdentifier(threadId, 'threadId');
    requireIdentifier(agentId, 'agentId');
    z.number().int().nonnegative().parse(viewVersion);
    const row = z
      .object({ request_id: z.string() })
      .optional()
      .parse(
        this.#database
          .prepare(
            `SELECT request_id FROM model_request_records
             WHERE thread_id = ? AND agent_id = ? AND view_version = ? AND status = 'completed'
               AND NOT EXISTS (
                 SELECT 1 FROM manual_compact_operations WHERE operation_id = request_id
               )
             ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          )
          .get(threadId, agentId, viewVersion),
      );
    if (!row) return undefined;
    const request = this.#readStoredRequest(row.request_id)?.request;
    if (!request) {
      throw new HardCutError(
        'storage_failed',
        `Completed request ${row.request_id} has no saved model input.`,
      );
    }
    return request;
  }

  #readStoredRequest(requestId: string): StoredRequest | undefined {
    const row = this.#database
      .prepare('SELECT * FROM model_request_records WHERE request_id = ?')
      .get(requestId);
    if (row === undefined) return undefined;
    const record = requestRowSchema.parse(row);
    return {
      requestId: record.request_id,
      threadId: record.thread_id,
      agentId: record.agent_id,
      status: record.status,
      estimatedInputTokens: record.estimated_input_tokens,
      contextWindowTokens: record.context_window_tokens,
      outputReserveTokens: record.output_reserve_tokens,
      readThroughSeq: record.read_through_seq,
      viewVersion: record.view_version,
      selectedRecapIds: z
        .array(z.string())
        .parse(parseJson(record.selected_recap_ids_json, 'selected_recap_ids_json')),
      contextMessageSeqs: z
        .array(z.number().int().positive())
        .parse(parseJson(record.context_message_seqs_json, 'context_message_seqs_json')),
      request:
        record.request_json === null
          ? null
          : storedRequestSchema.parse(parseJson(record.request_json, 'request_json')),
      requestFingerprint: record.request_fingerprint,
      pendingContextSeqs: z
        .array(z.number().int().positive())
        .parse(parseJson(record.pending_context_seqs_json, 'pending_context_seqs_json')),
      preparationId: record.preparation_id,
      hardCut: record.hard_cut === null ? null : record.hard_cut === 1,
      errorCode: record.error_code,
      errorMessage: record.error_message,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    };
  }

  async #exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#locks.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }

  #normalizeInput(input: PrepareModelInput): NormalizedInput {
    const contextWindowTokens = input.contextWindowTokens;
    const outputReserveTokens = input.outputReserveTokens ?? 0;
    if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) {
      throw new HardCutError('invalid_request', 'contextWindowTokens must be positive.');
    }
    if (!Number.isSafeInteger(outputReserveTokens) || outputReserveTokens < 0) {
      throw new HardCutError('invalid_request', 'outputReserveTokens must be non-negative.');
    }
    const pendingMessages = (input.pendingMessages ?? []).map(parseModelMessage);
    if (pendingMessages.some((message) => message.role !== 'user')) {
      throw new HardCutError('invalid_request', 'Pending messages must be user inputs.');
    }
    const pendingContextSeqs = (input.pendingContextSeqs ?? []).map((seq) =>
      requireSequence(seq, 'pendingContextSeqs'),
    );
    if (new Set(pendingContextSeqs).size !== pendingContextSeqs.length) {
      throw new HardCutError('invalid_request', 'pendingContextSeqs must not contain duplicates.');
    }
    return {
      threadId: requireIdentifier(input.threadId, 'threadId'),
      agentId: requireIdentifier(input.agentId, 'agentId'),
      systemInstructions: z.array(z.string()).parse(input.systemInstructions),
      tools: z.array(toolSchema).parse(input.tools),
      contextWindowTokens,
      pendingMessages,
      pendingContextSeqs,
      outputReserveTokens,
      requestId: requireIdentifier(input.requestId ?? createId(), 'requestId'),
      manual: input.hardCutMode === 'manual',
      ...(input.onCommitted === undefined ? {} : { onCommitted: input.onCommitted }),
      signal: input.signal ?? new AbortController().signal,
    };
  }

  async #prepareLocked(input: NormalizedInput): Promise<PreparedModelInput> {
    let start: PreparationStart;
    try {
      input.signal.throwIfAborted();
      start = this.#startPreparation(input);
    } catch (error) {
      throw this.#normalizeError(error, input.signal);
    }
    if (start.status === 'ready') return start.prepared;
    const { previousState, preparationId } = start;
    const pendingContextSeqs = [...start.pendingContextSeqs];
    let estimatedInputTokens: number | undefined;
    try {
      const snapshot = this.#context.query({
        threadId: input.threadId,
        agentId: input.agentId,
        currentOnly: true,
      });
      const snapshotBySeq = new Map(snapshot.map((message) => [message.seq, message]));
      const currentSourceSeqs = new Set(snapshot.map((message) => message.seq));
      const sourceFingerprints = new Map(
        snapshot.map((message) => [message.seq, this.#fingerprint(message)]),
      );
      const relations = this.#context.listToolCallRelations(input.threadId, input.agentId, {
        currentOnly: true,
      });
      this.#assertToolsComplete(relations);
      for (const [index, seq] of pendingContextSeqs.entries()) {
        const previousSeq = pendingContextSeqs[index - 1];
        if (previousSeq !== undefined && seq <= previousSeq) {
          throw new HardCutError(
            'invalid_request',
            'pendingContextSeqs must be strictly increasing.',
          );
        }
      }
      const pendingSeqs = new Set(pendingContextSeqs);
      const pendingRecords = pendingContextSeqs
        .map((seq) => {
          const message = snapshotBySeq.get(seq);
          if (!message || message.seq <= previousState.readThroughSeq) {
            throw new HardCutError(
              'invalid_request',
              `Pending Context message ${seq} is missing or already replaced.`,
            );
          }
          if (message.message.role !== 'user') {
            throw new HardCutError(
              'invalid_request',
              'Pending Context messages must be user inputs.',
            );
          }
          return message;
        })
        .sort((left, right) => left.seq - right.seq);
      const lastReplaceableSeq =
        snapshot.findLast((message) => !pendingSeqs.has(message.seq))?.seq ?? 0;
      if (pendingRecords.some((message) => message.seq < lastReplaceableSeq)) {
        throw new HardCutError(
          'invalid_request',
          'pendingContextSeqs must form a suffix of the current Context snapshot.',
        );
      }
      const pendingMessages = pendingRecords.map(currentModelMessageWithMeta);
      const replaceableMessages = snapshot.filter((message) => !pendingSeqs.has(message.seq));
      const oldMessages = replaceableMessages.filter(
        (message) => message.seq <= previousState.readThroughSeq,
      );
      const rawMessages = replaceableMessages.filter(
        (message) => message.seq > previousState.readThroughSeq,
      );
      const isCurrentRecap = (recap: Recap) =>
        recap.validity === 'valid' &&
        recap.sourceMessageSeqs.every((seq) => currentSourceSeqs.has(seq));
      const selected = this.#readSelectedRecaps(previousState).filter(isCurrentRecap);
      const currentSelectionValid = this.#coverageMatches(oldMessages, selected);
      const available = this.#recaps
        .query({
          threadId: input.threadId,
          agentId: input.agentId,
        })
        .filter(isCurrentRecap);
      let initialRecaps = selected;
      let initialGenerated: GeneratedRecap[] = [];
      if (!currentSelectionValid) {
        const selection = selectRecapCoverage(
          this.#sourceGroups(oldMessages, relations),
          available,
          previousState.selectedRecapIds,
        );
        const coveredSeqs = new Set(
          selection.selected.flatMap((recap) => [...recap.sourceMessageSeqs]),
        );
        const repairMessages = [
          ...oldMessages.filter((message) => !coveredSeqs.has(message.seq)),
          ...rawMessages,
        ];
        const repairRequest: ModelRequest = {
          messages: buildModelMessages({
            systemInstructions: input.systemInstructions,
            recaps: selection.selected,
            contextMessages: repairMessages,
            pendingMessages,
          }),
          tools: input.tools,
        };
        initialGenerated = await this.#generateMissing(
          selection.missingGroups,
          snapshotBySeq,
          input,
          repairRequest,
          [...repairMessages, ...pendingRecords],
          previousState.viewVersion,
        );
        initialRecaps = sortedRecaps([
          ...selection.selected,
          ...initialGenerated.map((generated) => generated.recap),
        ]);
      }
      const initialRequest: ModelRequest = {
        messages: buildModelMessages({
          systemInstructions: input.systemInstructions,
          recaps: initialRecaps,
          contextMessages: rawMessages,
          pendingMessages,
        }),
        tools: input.tools,
      };
      const initialMeasurement = await this.#measure(initialRequest, input.signal);
      estimatedInputTokens = initialMeasurement.tokens;
      const initialOverLimit =
        this.#overThreshold(estimatedInputTokens, input.contextWindowTokens) ||
        initialMeasurement.bytes > MAX_MODEL_REQUEST_BYTES;

      if (!initialOverLimit && !input.manual) {
        if (this.#exceedsOutputReserve(estimatedInputTokens, input)) {
          throw new HardCutError(
            'output_reserve_exceeded',
            'The model input leaves insufficient room for the reserved output tokens.',
          );
        }
        const finalGenerated = initialGenerated.filter((generated) =>
          initialRecaps.some((recap) => recap.recapId === generated.recap.recapId),
        );
        this.#commitSuccess({
          input,
          previousState,
          request: initialRequest,
          selectedRecaps: initialRecaps,
          readThroughSeq: previousState.readThroughSeq,
          contextMessages: [...rawMessages, ...pendingRecords],
          coverageMessages: oldMessages,
          sourceMessages: snapshot,
          sourceFingerprints,
          generated: finalGenerated,
          selectionChanged: !currentSelectionValid,
          estimatedInputTokens,
          preparationId,
          hardCut: false,
        });
        return this.#prepared(
          input,
          initialRequest,
          estimatedInputTokens,
          previousState.readThroughSeq,
          initialRecaps,
          [...rawMessages, ...pendingRecords],
          false,
        );
      }

      if (rawMessages.length === 0 && !input.manual) {
        throw new HardCutError(
          'hard_cut_over_limit',
          'The existing recap, system instructions, tools or pending input exceed the limit; no raw history remains to replace.',
        );
      }
      const cutGroups = this.#sourceGroups(replaceableMessages, relations);
      const cutSelection = selectRecapCoverage(
        cutGroups,
        [...available, ...initialGenerated.map((generated) => generated.recap)],
        initialRecaps.map((recap) => recap.recapId),
      );
      const cutGenerated = await this.#generateMissing(
        cutSelection.missingGroups,
        snapshotBySeq,
        input,
        initialRequest,
        [...rawMessages, ...pendingRecords],
        previousState.viewVersion,
      );
      const finalRecaps = sortedRecaps([
        ...cutSelection.selected,
        ...cutGenerated.map((generated) => generated.recap),
      ]);
      const finalRequest: ModelRequest = {
        messages: buildModelMessages({
          systemInstructions: input.systemInstructions,
          recaps: finalRecaps,
          contextMessages: [],
          pendingMessages,
        }),
        tools: input.tools,
      };
      const finalMeasurement = await this.#measure(finalRequest, input.signal);
      estimatedInputTokens = finalMeasurement.tokens;
      if (this.#overThreshold(estimatedInputTokens, input.contextWindowTokens)) {
        throw new HardCutError(
          'hard_cut_over_limit',
          'The merged model input remains above 80% of the context window.',
        );
      }
      if (finalMeasurement.bytes > MAX_MODEL_REQUEST_BYTES) {
        throw new HardCutError(
          'hard_cut_over_limit',
          'The merged model input exceeds the 16 MiB request byte limit.',
        );
      }
      if (this.#exceedsOutputReserve(estimatedInputTokens, input)) {
        throw new HardCutError(
          'output_reserve_exceeded',
          'The hard-cut input leaves insufficient room for the reserved output tokens.',
        );
      }
      const readThroughSeq = replaceableMessages.at(-1)?.seq;
      if (readThroughSeq === undefined) {
        throw new HardCutError('source_changed', 'The hard-cut source range is empty.');
      }
      const generatedById = new Map(
        [...initialGenerated, ...cutGenerated].map((generated) => [
          generated.recap.recapId,
          generated,
        ]),
      );
      const finalGenerated = finalRecaps
        .map((recap) => generatedById.get(recap.recapId))
        .filter((generated) => generated !== undefined);
      this.#commitSuccess({
        input,
        previousState,
        request: finalRequest,
        selectedRecaps: finalRecaps,
        readThroughSeq,
        contextMessages: pendingRecords,
        coverageMessages: replaceableMessages,
        sourceMessages: snapshot,
        sourceFingerprints,
        generated: finalGenerated,
        selectionChanged: true,
        estimatedInputTokens,
        preparationId,
        hardCut: true,
      });
      return this.#prepared(
        input,
        finalRequest,
        estimatedInputTokens,
        readThroughSeq,
        finalRecaps,
        pendingRecords,
        true,
      );
    } catch (error) {
      const normalized = this.#normalizeError(error, input.signal);
      try {
        if (!this.#recordFailure(input, preparationId, estimatedInputTokens, normalized)) {
          const completed = this.#readCompletedPreparation(input.requestId);
          if (completed) return completed;
        }
      } catch (recordError) {
        throw new HardCutError(
          'storage_failed',
          'The model input failed and its request failure could not be recorded.',
          { cause: new AggregateError([normalized, recordError]) },
        );
      }
      throw normalized;
    }
  }

  #prepared(
    input: NormalizedInput,
    request: ModelRequest,
    estimatedInputTokens: number,
    readThroughSeq: number,
    recaps: readonly Recap[],
    contextMessages: readonly ContextMessage[],
    hardCut: boolean,
  ): PreparedModelInput {
    return {
      requestId: input.requestId,
      request,
      estimatedInputTokens,
      contextWindowTokens: input.contextWindowTokens,
      outputReserveTokens: input.outputReserveTokens,
      readThroughSeq,
      selectedRecapIds: recaps.map((recap) => recap.recapId),
      contextMessageSeqs: contextMessages.map((message) => message.seq),
      hardCut,
    };
  }

  #readState(threadId: string, agentId: string): ModelInputState {
    const row = this.#database
      .prepare(
        'SELECT read_through_seq, view_version, last_request_id, updated_at FROM model_input_states WHERE thread_id = ? AND agent_id = ?',
      )
      .get(threadId, agentId);
    const selectedRecapIds = z
      .array(z.object({ recap_id: z.string() }))
      .parse(
        this.#database
          .prepare(
            'SELECT recap_id FROM model_input_recaps WHERE thread_id = ? AND agent_id = ? ORDER BY merge_position',
          )
          .all(threadId, agentId),
      )
      .map((recap) => recap.recap_id);
    if (row === undefined) {
      return {
        threadId,
        agentId,
        readThroughSeq: 0,
        viewVersion: 0,
        selectedRecapIds,
        lastRequestId: null,
        updatedAt: null,
      };
    }
    const state = stateRowSchema.parse(row);
    return {
      threadId,
      agentId,
      readThroughSeq: state.read_through_seq,
      viewVersion: state.view_version,
      selectedRecapIds,
      lastRequestId: state.last_request_id,
      updatedAt: state.updated_at,
    };
  }

  #readSelectedRecaps(state: ModelInputState): Recap[] {
    return state.selectedRecapIds.map((recapId) => {
      const recap = this.#recaps.get(state.threadId, state.agentId, recapId);
      if (!recap) throw new HardCutError('source_changed', `Selected recap ${recapId} is missing.`);
      return recap;
    });
  }

  #startPreparation(input: NormalizedInput): PreparationStart {
    const fingerprint = this.#requestFingerprint(input);
    return inTransaction(this.#database, () => {
      const previousState = this.#readState(input.threadId, input.agentId);
      const existing = this.#readStoredRequest(input.requestId);
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new HardCutError(
            'request_conflict',
            `Request ${input.requestId} was already prepared with different parameters.`,
          );
        }
        if (
          (existing.status === 'ready' || existing.status === 'completed') &&
          existing.viewVersion === previousState.viewVersion
        ) {
          return { status: 'ready', prepared: this.#completedPreparation(existing) };
        }
        const preparationId = createId();
        this.#resumeRequest(input, previousState, preparationId);
        return {
          status: 'preparing',
          previousState,
          pendingContextSeqs: existing.pendingContextSeqs,
          preparationId,
        };
      }

      const preparationId = createId();
      const pendingContextSeqs = [...input.pendingContextSeqs];
      this.#insertRequest(input, previousState, fingerprint, preparationId);
      for (const message of input.pendingMessages) {
        const persisted = this.#context.append({
          threadId: input.threadId,
          agentId: input.agentId,
          message,
        });
        pendingContextSeqs.push(persisted.seq);
      }
      this.#database
        .prepare(
          `UPDATE model_request_records SET pending_context_seqs_json = ?
           WHERE request_id = ? AND preparation_id = ?`,
        )
        .run(jsonText(pendingContextSeqs, 'pendingContextSeqs'), input.requestId, preparationId);
      return { status: 'preparing', previousState, pendingContextSeqs, preparationId };
    });
  }

  #requestFingerprint(input: NormalizedInput): string {
    const serialized = jsonText(
      canonicalJsonValue({
        version: 1,
        threadId: input.threadId,
        agentId: input.agentId,
        systemInstructions: input.systemInstructions,
        tools: input.tools,
        contextWindowTokens: input.contextWindowTokens,
        pendingMessages: input.pendingMessages,
        pendingContextSeqs: input.pendingContextSeqs,
        outputReserveTokens: input.outputReserveTokens,
        ...(this.#configurationId === undefined
          ? {}
          : { modelConfigurationId: this.#configurationId }),
        hardCutMode: input.manual ? 'manual' : 'automatic',
      }),
      'request fingerprint',
    );
    return createHash('sha256').update(serialized).digest('hex');
  }

  #readCompletedPreparation(requestId: string): PreparedModelInput | undefined {
    const record = this.#readStoredRequest(requestId);
    if (!record || (record.status !== 'ready' && record.status !== 'completed')) return undefined;
    if (record.viewVersion !== this.#readState(record.threadId, record.agentId).viewVersion) {
      return undefined;
    }
    return this.#completedPreparation(record);
  }

  #completedPreparation(record: StoredRequest): PreparedModelInput {
    if (
      record.request === null ||
      record.estimatedInputTokens === null ||
      record.hardCut === null
    ) {
      throw new HardCutError(
        'storage_failed',
        `Request ${record.requestId} has no complete saved preparation.`,
      );
    }
    return {
      requestId: record.requestId,
      request: record.request,
      estimatedInputTokens: record.estimatedInputTokens,
      contextWindowTokens: record.contextWindowTokens,
      outputReserveTokens: record.outputReserveTokens,
      readThroughSeq: record.readThroughSeq,
      selectedRecapIds: record.selectedRecapIds,
      contextMessageSeqs: record.contextMessageSeqs,
      hardCut: record.hardCut,
    };
  }

  #insertRequest(
    input: NormalizedInput,
    state: ModelInputState,
    fingerprint: string,
    preparationId: string,
  ): void {
    const now = isoTime(undefined, this.#clock);
    this.#database
      .prepare(
        `INSERT INTO model_request_records(
          request_id, thread_id, agent_id, status, context_window_tokens,
          output_reserve_tokens, read_through_seq, view_version, selected_recap_ids_json,
          context_message_seqs_json, pending_context_seqs_json, request_fingerprint,
          preparation_id, created_at, updated_at
        ) VALUES (?, ?, ?, 'preparing', ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.requestId,
        input.threadId,
        input.agentId,
        input.contextWindowTokens,
        input.outputReserveTokens,
        state.readThroughSeq,
        state.viewVersion,
        jsonText(state.selectedRecapIds, 'selectedRecapIds'),
        jsonText(input.pendingContextSeqs, 'pendingContextSeqs'),
        fingerprint,
        preparationId,
        now,
        now,
      );
  }

  #resumeRequest(input: NormalizedInput, state: ModelInputState, preparationId: string): void {
    this.#database
      .prepare(
        `UPDATE model_request_records SET status = 'preparing', preparation_id = ?,
         estimated_input_tokens = NULL, context_window_tokens = ?, output_reserve_tokens = ?,
         read_through_seq = ?, view_version = ?, selected_recap_ids_json = ?,
         context_message_seqs_json = '[]', request_json = NULL, hard_cut = NULL,
         error_code = NULL, error_message = NULL, updated_at = ? WHERE request_id = ?`,
      )
      .run(
        preparationId,
        input.contextWindowTokens,
        input.outputReserveTokens,
        state.readThroughSeq,
        state.viewVersion,
        jsonText(state.selectedRecapIds, 'selectedRecapIds'),
        isoTime(undefined, this.#clock),
        input.requestId,
      );
  }

  #recordFailure(
    input: NormalizedInput,
    preparationId: string,
    estimatedInputTokens: number | undefined,
    error: HardCutError,
  ): boolean {
    const result = this.#database
      .prepare(
        `UPDATE model_request_records SET status = ?, estimated_input_tokens = ?,
         error_code = ?, error_message = ?, updated_at = ?
         WHERE request_id = ? AND preparation_id = ? AND status = 'preparing'`,
      )
      .run(
        error.code === 'cancelled' ? 'cancelled' : 'failed',
        estimatedInputTokens ?? null,
        error.code,
        error.message,
        isoTime(undefined, this.#clock),
        input.requestId,
        preparationId,
      );
    return result.changes === 1;
  }

  async #measure(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<{ tokens: number; bytes: number }> {
    signal.throwIfAborted();
    try {
      const materialized = this.#materializeRequest(request);
      const tokens = await this.#countTokens(materialized);
      signal.throwIfAborted();
      if (!Number.isSafeInteger(tokens) || tokens < 0) {
        throw new Error(`Token counter returned ${tokens}.`);
      }
      return { tokens, bytes: Buffer.byteLength(JSON.stringify(materialized)) };
    } catch (error) {
      if (signal.aborted) throw error;
      throw new HardCutError('token_count_failed', 'Could not estimate model input tokens.', {
        cause: error,
      });
    }
  }

  #overThreshold(tokens: number, capacity: number): boolean {
    return BigInt(tokens) * 5n > BigInt(capacity) * 4n;
  }

  #exceedsOutputReserve(tokens: number, input: NormalizedInput): boolean {
    return BigInt(tokens) + BigInt(input.outputReserveTokens) > BigInt(input.contextWindowTokens);
  }

  #assertToolsComplete(relations: readonly ToolCallRelation[]): void {
    const unresolved = relations.find((relation) => relation.resultSeq === null);
    if (unresolved) {
      throw new HardCutError(
        'unfinished_tool_round_trip',
        `Tool call ${unresolved.callId} must finish or stop before the next model request.`,
      );
    }
  }

  #sourceGroups(
    messages: readonly ContextMessage[],
    relations: readonly ToolCallRelation[],
  ): RecapSourceGroup[] {
    const byAssistant = new Map<number, ToolCallRelation[]>();
    const resultSeqs = new Set<number>();
    for (const relation of relations) {
      const group = byAssistant.get(relation.assistantSeq) ?? [];
      group.push(relation);
      byAssistant.set(relation.assistantSeq, group);
      if (relation.resultSeq !== null) resultSeqs.add(relation.resultSeq);
    }
    const groups: RecapSourceGroup[] = [];
    for (const message of messages) {
      const calls = byAssistant.get(message.seq);
      if (calls) {
        groups.push({
          sourceMessageSeqs: [
            message.seq,
            ...calls.map((relation) => {
              if (relation.resultSeq === null) {
                throw new HardCutError(
                  'unfinished_tool_round_trip',
                  `Tool call ${relation.callId} has no final result.`,
                );
              }
              return relation.resultSeq;
            }),
          ].sort((left, right) => left - right),
        });
      } else if (!resultSeqs.has(message.seq)) {
        groups.push({ sourceMessageSeqs: [message.seq] });
      }
    }
    return groups;
  }

  async #generateMissing(
    groups: readonly RecapSourceGroup[],
    snapshotBySeq: ReadonlyMap<number, ContextMessage>,
    input: NormalizedInput,
    request: ModelRequest,
    requestContextMessages: readonly ContextMessage[],
    viewVersion: number,
  ): Promise<GeneratedRecap[]> {
    const generated: GeneratedRecap[] = [];
    const contextOffset = request.messages.length - requestContextMessages.length;
    const requestIndexes = new Map(
      requestContextMessages.map((message, index) => [message.seq, contextOffset + index]),
    );
    for (const group of groups) {
      input.signal.throwIfAborted();
      if (!this.#generateRecap) {
        throw new HardCutError(
          'recap_generation_failed',
          'No recap generator is configured for the required coverage.',
        );
      }
      const messages = group.sourceMessageSeqs.map((seq) => {
        const source = snapshotBySeq.get(seq);
        if (!source) throw new HardCutError('source_changed', `Source message ${seq} is missing.`);
        return { seq, createdAt: source.createdAt, message: currentModelMessage(source) };
      });
      const sourceMessageIndexes: RecapSourceMessageIndex[] = group.sourceMessageSeqs.map((seq) => {
        const messageIndex = requestIndexes.get(seq);
        if (messageIndex === undefined || messageIndex < 0) {
          throw new HardCutError(
            'source_changed',
            `Source message ${seq} is missing from the complete Recap request prefix.`,
          );
        }
        return { seq, messageIndex };
      });
      let output: { content: string };
      try {
        output = generatedRecapSchema.parse(
          await this.#generateRecap(
            {
              threadId: input.threadId,
              agentId: input.agentId,
              sourceMessageSeqs: group.sourceMessageSeqs,
              sourceMessageIndexes,
              messages,
              request,
              viewVersion,
              trigger: 'hard_cut',
            },
            input.signal,
          ),
        );
        input.signal.throwIfAborted();
        const recapInput: SaveRecapInput = {
          recapId: createId(),
          threadId: input.threadId,
          agentId: input.agentId,
          sourceMessageSeqs: group.sourceMessageSeqs,
          content: output.content,
          createdAt: isoTime(undefined, this.#clock),
        };
        generated.push({ input: recapInput, recap: this.#recaps.prepare(recapInput) });
      } catch (error) {
        if (
          input.signal.aborted ||
          (error instanceof HardCutError && error.code === 'source_changed')
        ) {
          throw error;
        }
        throw new HardCutError('recap_generation_failed', 'Could not generate a required recap.', {
          cause: error,
        });
      }
    }
    return generated;
  }

  #coverageMatches(messages: readonly ContextMessage[], recaps: readonly Recap[]): boolean {
    if (recaps.some((recap) => recap.validity !== 'valid')) return false;
    const expected = messages.map((message) => message.seq);
    const actual = recaps.flatMap((recap) => [...recap.sourceMessageSeqs]).sort((a, b) => a - b);
    return new Set(actual).size === actual.length && sameSequences(actual, expected);
  }

  #fingerprint(message: ContextMessage): string {
    return jsonText(
      {
        message: message.message,
        createdAt: message.createdAt,
        supersededByRunId: message.supersededByRunId,
        revisions: message.revisions.map((revision) => ({
          revisionId: revision.revisionId,
          revisionNumber: revision.revisionNumber,
          content: revision.content,
          createdAt: revision.createdAt,
        })),
      },
      'source fingerprint',
    );
  }

  #commitSuccess(commit: {
    input: NormalizedInput;
    previousState: ModelInputState;
    request: ModelRequest;
    selectedRecaps: readonly Recap[];
    readThroughSeq: number;
    contextMessages: readonly ContextMessage[];
    coverageMessages: readonly ContextMessage[];
    sourceMessages: readonly ContextMessage[];
    sourceFingerprints: ReadonlyMap<number, string>;
    generated: readonly GeneratedRecap[];
    selectionChanged: boolean;
    estimatedInputTokens: number;
    preparationId: string;
    hardCut: boolean;
  }): void {
    commit.input.signal.throwIfAborted();
    this.#recaps.saveMany(
      commit.generated.map((generated) => generated.input),
      () => {
        commit.input.signal.throwIfAborted();
        for (const source of commit.sourceMessages) {
          const current = this.#context.get(
            commit.input.threadId,
            commit.input.agentId,
            source.seq,
          );
          if (
            !current ||
            this.#fingerprint(current) !== commit.sourceFingerprints.get(source.seq)
          ) {
            throw new HardCutError(
              'source_changed',
              `Context source ${source.seq} changed during model input preparation.`,
            );
          }
        }
        if (!this.#coverageMatches(commit.coverageMessages, commit.selectedRecaps)) {
          throw new HardCutError(
            'source_changed',
            'Selected recaps no longer provide valid, non-overlapping source coverage.',
          );
        }
        for (const selected of commit.selectedRecaps) {
          const current = this.#recaps.get(
            commit.input.threadId,
            commit.input.agentId,
            selected.recapId,
          );
          if (
            current?.validity !== 'valid' ||
            !sameSequences(current.sourceMessageSeqs, selected.sourceMessageSeqs)
          ) {
            throw new HardCutError(
              'source_changed',
              `Recap ${selected.recapId} changed or became invalid during preparation.`,
            );
          }
        }
        const now = isoTime(undefined, this.#clock);
        this.#database
          .prepare(
            `INSERT INTO model_input_states(
              thread_id, agent_id, read_through_seq, view_version, last_request_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread_id, agent_id) DO UPDATE SET
              read_through_seq = excluded.read_through_seq,
              last_request_id = excluded.last_request_id,
              updated_at = excluded.updated_at`,
          )
          .run(
            commit.input.threadId,
            commit.input.agentId,
            commit.readThroughSeq,
            commit.previousState.viewVersion,
            commit.input.requestId,
            now,
          );
        if (commit.selectionChanged) {
          this.#database
            .prepare('DELETE FROM model_input_recaps WHERE thread_id = ? AND agent_id = ?')
            .run(commit.input.threadId, commit.input.agentId);
          const insertSelection = this.#database.prepare(
            `INSERT INTO model_input_recaps(thread_id, agent_id, merge_position, recap_id)
             VALUES (?, ?, ?, ?)`,
          );
          commit.selectedRecaps.forEach((recap, index) => {
            insertSelection.run(
              commit.input.threadId,
              commit.input.agentId,
              index + 1,
              recap.recapId,
            );
          });
          if (commit.selectedRecaps.length > 0) {
            this.#database
              .prepare(
                `INSERT INTO context_events(
                  event_id, thread_id, agent_id, event_type, payload_json, created_at
                ) VALUES (?, ?, ?, 'context_hard_cut_completed', ?, ?)`,
              )
              .run(
                createId(),
                commit.input.threadId,
                commit.input.agentId,
                jsonText(
                  {
                    request_id: commit.input.requestId,
                    replaced_source_seqs: commit.coverageMessages.map((message) => message.seq),
                    recap_ids: commit.selectedRecaps.map((recap) => recap.recapId),
                    injected_message_count: 1,
                  },
                  'hard-cut event',
                ),
                now,
              );
          }
        }
        const result = this.#database
          .prepare(
            `UPDATE model_request_records SET status = 'ready', estimated_input_tokens = ?,
             read_through_seq = ?, selected_recap_ids_json = ?, context_message_seqs_json = ?,
             request_json = ?, hard_cut = ?, error_code = NULL, error_message = NULL,
             updated_at = ?
             WHERE request_id = ? AND preparation_id = ? AND status = 'preparing'`,
          )
          .run(
            commit.estimatedInputTokens,
            commit.readThroughSeq,
            jsonText(
              commit.selectedRecaps.map((recap) => recap.recapId),
              'selectedRecapIds',
            ),
            jsonText(
              commit.contextMessages.map((message) => message.seq),
              'contextMessageSeqs',
            ),
            jsonText(commit.request, 'modelRequest'),
            commit.hardCut ? 1 : 0,
            now,
            commit.input.requestId,
            commit.preparationId,
          );
        if (result.changes !== 1) {
          throw new HardCutError(
            'concurrent_modification',
            `Request ${commit.input.requestId} was superseded by another preparation attempt.`,
          );
        }
        commit.input.onCommitted?.(
          this.#prepared(
            commit.input,
            commit.request,
            commit.estimatedInputTokens,
            commit.readThroughSeq,
            commit.selectedRecaps,
            commit.contextMessages,
            commit.hardCut,
          ),
        );
      },
      () => this.#assertStateUnchanged(commit.input, commit.previousState),
    );
  }

  #assertStateUnchanged(input: NormalizedInput, previousState: ModelInputState): void {
    const current = this.#readState(input.threadId, input.agentId);
    const selectionUnchanged =
      current.selectedRecapIds.length === previousState.selectedRecapIds.length &&
      current.selectedRecapIds.every((id, index) => id === previousState.selectedRecapIds[index]);
    if (
      current.readThroughSeq !== previousState.readThroughSeq ||
      current.viewVersion !== previousState.viewVersion ||
      current.lastRequestId !== previousState.lastRequestId ||
      !selectionUnchanged
    ) {
      throw new HardCutError(
        'concurrent_modification',
        'Model input state changed in another request before this snapshot could commit.',
      );
    }
  }

  #normalizeError(error: unknown, signal: AbortSignal): HardCutError {
    if (error instanceof HardCutError) return error;
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return new HardCutError('cancelled', 'Model input preparation was cancelled.', {
        cause: error,
      });
    }
    if (error instanceof ContextError || error instanceof RecapError) {
      return new HardCutError('source_changed', 'A Context or Recap source changed.', {
        cause: error,
      });
    }
    return new HardCutError(
      'storage_failed',
      `SQLite operation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
