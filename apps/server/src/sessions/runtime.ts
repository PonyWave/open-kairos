import { randomUUID } from 'node:crypto';
import {
  AgentLoop,
  type AgentLoopEvent,
  type AgentLoopPersistence,
  type AgentLoopResult,
  type AgentTool,
  type DetailedModelUsage,
  type ModelEvent,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ToolCall,
  type ToolExecutionResult,
  type UserMessage,
} from '@kairos/agent-core';
import { z } from 'zod';
import type { AutomationService } from '../automation/service.js';
import { DEFAULT_PERIODIC_RECAP_CONFIGURATION } from '../config.js';
import {
  HardCutError,
  ModelInputService,
  runtimeSpecFingerprint,
  runtimeSpecFingerprintFromRequest,
} from '../context/model-input-service.js';
import type { ContextMessage, DelegationKey } from '../context/types.js';
import type { EnvironmentStore } from '../devices/environment-store.js';
import type { EnvironmentUseGateway } from '../devices/environment-use.js';
import { SqlRecallEngine, type SqlRecallLimits, SqlRecallProcessPool } from '../recall/index.js';
import { RecapModelGenerator } from '../recap/generation.js';
import { type PeriodicRecapConfiguration, PeriodicRecapService } from '../recap/periodic.js';
import type { SettingsStore } from '../settings/store.js';
import {
  BrowserRuntime,
  type BrowserRuntimeOptions,
  browserOptionsFromEnvironment,
} from '../tools/browser.js';
import { BACKGROUND_ACCEPTED_NEXT_STEP } from '../tools/delegation.js';
import {
  environmentPolicyInput,
  optionalEnvironmentPolicySchema,
} from '../tools/environment-policy.js';
import {
  createAutomationTools,
  createEnvironmentTools,
  createRecallTool,
  createSendToUserTool,
  createSubagentDelegationTools,
  createThreadDelegationTools,
  createThreadNotificationTool,
  createWorkspaceListTool,
  threadNotificationAcceptance,
} from '../tools/index.js';
import {
  createWebTools,
  DEFAULT_WEB_SEARCH_LIMITS,
  WebSearchQuota,
  type WebToolOptions,
} from '../tools/web.js';
import { agentInstructions } from './agent-instructions.js';
import {
  AgentEnvironmentRuntime,
  type EnvironmentOperationGateway,
} from './environment-runtime.js';
import { SessionError } from './errors.js';
import {
  type ManualCompactInput,
  ManualCompactionService,
  type ManualCompactResult,
} from './manual-compaction.js';
import type {
  InputRecord,
  InteractionDeliveryRecord,
  InteractionRecord,
  RunError,
  RunRecord,
  StreamDeltaRecord,
  ThreadNotificationRecord,
} from './records.js';
import { RequestSlots } from './request-slots.js';
import type { AcceptedThreadCall, AcceptedThreadNotification, SessionStore } from './store.js';
import { ThreadTitleGenerator } from './title-generation.js';
import type { ReloadResourcesInput, ReloadResourcesResult } from './workspace-resources.js';

const subagentInputSchema = z
  .object({
    task: z.string().min(1).max(100_000),
    mode: z.enum(['foreground', 'background']),
    ...optionalEnvironmentPolicySchema.shape,
  })
  .strict();
const serverResultSchema = z.object({
  content: z.string().nullable(),
  status: z.enum(['success', 'error']).nullable(),
});

export interface RuntimeModelConfiguration {
  configurationId?: string;
  provider: ModelProvider;
  providerId: string;
  modelId: string;
  contextWindowTokens: number;
  outputReserveTokens: number;
  countTokens?: (request: ModelRequest) => number | Promise<number>;
}

export interface RunCoordinatorOptions {
  store: SessionStore;
  automations?: AutomationService;
  model?: RuntimeModelConfiguration;
  settings?: SettingsStore;
  environments: EnvironmentStore;
  environmentOperations: EnvironmentOperationGateway;
  environmentUse: EnvironmentUseGateway;
  maxActiveThreads?: number;
  maxConcurrentModelRequests?: number;
  maxStepsPerRun?: number;
  maxSubagentDepth?: number;
  maxChildrenPerRun?: number;
  bashDefaultTimeoutSeconds?: number;
  bashPreviewBytes?: number;
  periodicRecap?: PeriodicRecapConfiguration;
  sqlRecall?: Partial<SqlRecallLimits>;
  web?: WebToolOptions;
  browser?: BrowserRuntime | BrowserRuntimeOptions | false;
  now?: () => Date;
  createId?: () => string;
  onError?: (error: unknown) => void;
}

interface ModelRuntime {
  model: RuntimeModelConfiguration;
  provider: LimitedProvider;
  input: ModelInputService;
  periodic: PeriodicRecapService;
  manual: ManualCompactionService;
  title: ThreadTitleGenerator;
}

interface ActiveExecution {
  runtime: ModelRuntime | null;
  runId: string;
  threadId: string;
  agentId: string;
  generation: number;
  interactionKey: DelegationKey | null;
  instructions: readonly string[] | null;
  loop: AgentLoop | null;
  preparationController: AbortController;
  pendingInputIds: string[];
  streamingMessageId: string | null;
  deltaSequence: number;
  rerunAnchorPending: boolean;
  usageBase: { inputTokens: number; outputTokens: number };
  cancelReason: string | null;
  promise: Promise<void> | null;
}

class LimitedProvider implements ModelProvider {
  constructor(
    readonly base: ModelProvider,
    readonly slots: RequestSlots,
    readonly materialize: (request: ModelRequest) => ModelRequest,
  ) {}

  mapMessageIndex(request: ModelRequest, messageIndex: number): number {
    const materialized = this.materialize(request);
    return this.base.mapMessageIndex?.(materialized, messageIndex) ?? messageIndex;
  }

  mapMessageSource(request: ModelRequest, messageIndex: number) {
    const materialized = this.materialize(request);
    if (this.base.mapMessageSource) return this.base.mapMessageSource(materialized, messageIndex);
    return {
      messageIndex: this.base.mapMessageIndex?.(materialized, messageIndex) ?? messageIndex,
    };
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const release = await this.slots.acquire(signal);
    try {
      yield* this.base.stream(this.materialize(request), signal);
    } finally {
      release();
    }
  }
}

export class RunCoordinator {
  readonly store: SessionStore;
  readonly #options: RunCoordinatorOptions;
  readonly #slots: RequestSlots;
  readonly #recallProcessPool: SqlRecallProcessPool;
  readonly #limitedProvider: LimitedProvider | undefined;
  readonly #recapGenerator: RecapModelGenerator | undefined;
  readonly #titleGenerator: ThreadTitleGenerator | undefined;
  readonly #periodicRecaps: PeriodicRecapService | undefined;
  readonly #modelInput: ModelInputService;
  readonly #manualCompaction: ManualCompactionService;
  readonly #environmentRuntime: AgentEnvironmentRuntime;
  readonly #webSearchQuota: WebSearchQuota;
  readonly #browserRuntime: BrowserRuntime | undefined;
  readonly #modelRuntimes = new Map<string, ModelRuntime>();
  readonly #activeByThread = new Map<string, ActiveExecution>();
  readonly #activeByRun = new Map<string, ActiveExecution>();
  readonly #pendingThreads = new Set<string>();
  readonly #pendingSubagents = new Map<string, DelegationKey>();
  readonly #interactionWaiters = new Map<string, Set<() => void>>();
  readonly #deliveryPromises = new Set<Promise<void>>();
  readonly #titleSummaries = new Map<
    string,
    { controller: AbortController; promise: Promise<void>; run: RunRecord }
  >();
  readonly #createId: () => string;
  #closing = false;

  constructor(options: RunCoordinatorOptions) {
    if (!options.environments || !options.environmentOperations || !options.environmentUse) {
      throw new SessionError(
        'internal',
        'EnvironmentStore, the remote Operation gateway and the environment usage gateway are required.',
      );
    }
    this.store = options.store;
    this.#options = options;
    this.#webSearchQuota = new WebSearchQuota(
      options.web?.searchLimits?.maxRequestsPerMinute ??
        DEFAULT_WEB_SEARCH_LIMITS.maxRequestsPerMinute,
      options.web?.now ?? Date.now,
    );
    if (options.browser === false) {
      this.#browserRuntime = undefined;
    } else if (options.browser instanceof BrowserRuntime) {
      this.#browserRuntime = options.browser;
    } else {
      const browserOptions = { ...browserOptionsFromEnvironment(), ...options.browser };
      const onError = browserOptions.onError ?? options.onError;
      this.#browserRuntime = new BrowserRuntime({
        ...browserOptions,
        ...(onError ? { onError } : {}),
      });
    }
    this.#environmentRuntime = new AgentEnvironmentRuntime({
      store: options.store,
      environments: options.environments,
      operations: options.environmentOperations,
      environmentUse: options.environmentUse,
      ...(options.createId ? { createId: options.createId } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.bashDefaultTimeoutSeconds
        ? { bashDefaultTimeoutSeconds: options.bashDefaultTimeoutSeconds }
        : {}),
      ...(options.bashPreviewBytes ? { bashPreviewBytes: options.bashPreviewBytes } : {}),
    });
    this.#slots = new RequestSlots(options.maxConcurrentModelRequests ?? 4);
    this.#recallProcessPool = new SqlRecallProcessPool(options.sqlRecall?.maxConcurrentProcesses);
    this.#limitedProvider = options.model
      ? new LimitedProvider(options.model.provider, this.#slots, (request) =>
          this.store.attachments.materializeRequest(request),
        )
      : undefined;
    this.#recapGenerator = this.#limitedProvider
      ? new RecapModelGenerator(this.#limitedProvider)
      : undefined;
    const countTokens =
      options.model?.countTokens ??
      ((request: ModelRequest) =>
        Math.ceil(
          JSON.stringify(request, (key, value: unknown) =>
            key === 'content_blocks' ? undefined : value,
          ).length / 4,
        ));
    this.#titleGenerator =
      options.model && this.#limitedProvider
        ? new ThreadTitleGenerator(this.#limitedProvider, {
            contextWindowTokens: options.model.contextWindowTokens,
            countTokens,
          })
        : undefined;
    this.#periodicRecaps =
      options.model && this.#limitedProvider
        ? new PeriodicRecapService({
            database: this.store.database,
            recapStore: this.store.recaps,
            provider: this.#limitedProvider,
            acceptRequest: (requestId) =>
              !options.settings || options.settings.acceptRecap(requestId),
            model: {
              providerId: options.model.providerId,
              modelId: options.model.modelId,
              contextWindowTokens: options.model.contextWindowTokens,
              outputReserveTokens: options.model.outputReserveTokens,
            },
            configuration: options.periodicRecap ?? DEFAULT_PERIODIC_RECAP_CONFIGURATION,
            ...(options.now ? { clock: options.now } : {}),
            ...(options.onError ? { onError: options.onError } : {}),
          })
        : undefined;
    const recapGenerator = this.#recapGenerator;
    this.#modelInput = new ModelInputService(this.store.database, {
      materializeRequest: (request) => this.store.attachments.materializeRequest(request),
      recapStore: this.store.recaps,
      countTokens,
      ...(recapGenerator
        ? { generateRecap: (input, signal) => recapGenerator.generate(input, signal) }
        : {}),
      ...(options.now ? { clock: options.now } : {}),
    });
    this.#createId = options.createId ?? randomUUID;
    this.#manualCompaction = new ManualCompactionService({
      store: this.store,
      modelInputs: this.#modelInput,
      ...(options.model
        ? {
            model: {
              contextWindowTokens: options.model.contextWindowTokens,
              outputReserveTokens: options.model.outputReserveTokens,
            },
          }
        : {}),
      systemInstructions: (ownerId, threadId) => this.#instructions(ownerId, threadId, 'thread'),
      toolsForThread: (ownerId, threadId) => {
        const run = this.store
          .listRuns(ownerId, threadId)
          .findLast(
            (candidate) => candidate.agentId === 'thread' && candidate.parentRunId === null,
          );
        return (run ? this.#tools(run, 0) : []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: structuredClone(tool.parameters),
        }));
      },
      isThreadActive: (threadId) => this.#activeByThread.has(threadId),
      isPeriodicRecapActive: (threadId, agentId) =>
        this.#periodicRecaps?.hasActive(threadId, agentId) ?? false,
      createId: this.#createId,
      ...(options.now ? { clock: options.now } : {}),
    });
  }

  get activeThreadCount(): number {
    return this.#activeByThread.size;
  }

  reloadResources(input: ReloadResourcesInput): Promise<ReloadResourcesResult> {
    return this.#environmentRuntime.reload(input, {
      isRootRunActive: (threadId) => this.#activeByThread.has(threadId),
      isManualCompactionActive: (threadId) =>
        this.#manualCompaction.isActive(threadId) ||
        [...this.#modelRuntimes.values()].some((runtime) => runtime.manual.isActive(threadId)),
      invalidate: (threadId) =>
        this.store.invalidateModelRequestsForReload(threadId, (runId) =>
          this.#activeByRun.has(runId),
        ),
      runtimeSpec: (ownerId, threadId) => this.#runtimeSpec(ownerId, threadId),
    });
  }

  resumePeriodicRecaps(): void {
    this.#periodicRecaps?.resume();
    if (this.#options.settings) {
      const rows = z
        .array(z.object({ run_id: z.string() }))
        .parse(
          this.store.database
            .prepare('SELECT run_id FROM run_model_configurations ORDER BY rowid DESC')
            .all(),
        );
      const visited = new Set<string>();
      for (const row of rows) {
        const run = this.store.getRunById(row.run_id);
        const key = `${run.threadId}\0${run.agentId}`;
        if (visited.has(key)) continue;
        visited.add(key);
        try {
          this.#runtimeForRun(run)?.periodic.schedule(run.threadId, run.agentId);
        } catch (error) {
          this.#options.onError?.(error);
        }
      }
    }
  }

  recoverManualCompactions(): void {
    this.#manualCompaction.recoverInterrupted();
    this.#environmentRuntime.recoverReloads();
  }

  compactContext(input: ManualCompactInput): Promise<ManualCompactResult> {
    const model = this.#options.settings?.resolve(input.ownerId);
    const runtime = model ? this.#runtimeForModel(model) : undefined;
    return (runtime?.manual ?? this.#manualCompaction).compact(input);
  }

  scheduleThreadTitleSummary(input: {
    ownerId: string;
    threadId: string;
    prompt: string;
    expectedTitle: string;
  }): void {
    const titleRun = this.store.getActiveRun(input.threadId);
    const generator =
      titleRun && this.#options.settings
        ? this.#runtimeForRun(titleRun)?.title
        : this.#titleGenerator;
    if (
      !generator ||
      this.#closing ||
      !input.prompt.trim() ||
      this.#titleSummaries.has(input.threadId)
    )
      return;
    const run = this.store.getActiveRun(input.threadId);
    if (!run) return;
    try {
      this.#environmentRuntime.reserveRun(run);
    } catch (cause) {
      if (!(cause instanceof SessionError && cause.code === 'sandbox_capacity_exhausted'))
        this.#options.onError?.(cause);
      return;
    }
    const controller = new AbortController();
    const promise = this.#environmentRuntime
      .ensureRunReady(run, controller.signal)
      .then(() => generator.generate(input.prompt, controller.signal))
      .then((title) => {
        if (!controller.signal.aborted) this.store.renameThreadIfTitle({ ...input, title });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) this.#options.onError?.(error);
      })
      .finally(() => {
        if (this.#titleSummaries.get(input.threadId)?.promise === promise) {
          this.#titleSummaries.delete(input.threadId);
        }
      });
    this.#titleSummaries.set(input.threadId, { controller, promise, run });
  }

  async deliver(input: InputRecord, runId: string): Promise<string> {
    if (this.#closing) return runId;
    const current = this.store.getInput(input.ownerId, input.inputId);
    if (current.status !== 'queued') return current.consumedRunId ?? runId;
    if (this.store.getRunById(runId).error?.code === 'sandbox_capacity_exhausted') return runId;
    const active = this.#activeByThread.get(current.threadId);
    if (active?.pendingInputIds.includes(current.inputId)) return active.runId;
    if (active?.rerunAnchorPending) return active.runId;
    if (active?.loop?.isRunning) {
      try {
        if (current.mode === 'steer') {
          active.loop.supplement(inputModelContent(current), current.inputId);
        } else {
          active.loop.enqueue(inputModelContent(current), current.inputId);
        }
        active.pendingInputIds.push(current.inputId);
        return active.runId;
      } catch (error) {
        if (active.loop.isRunning && !active.loop.isCancellationRequested) throw error;
      }
    }
    let targetRunId = runId;
    const acceptedRun = this.store.getRunById(runId);
    if ((active?.runId === runId && active.loop !== null) || isTerminal(acceptedRun.status)) {
      targetRunId = this.store.moveInputToNewRun(current.ownerId, current.inputId).runId;
    }
    this.schedule(current.threadId, targetRunId);
    return targetRunId;
  }

  schedule(threadId: string, runId?: string): void {
    if (this.#closing || this.#activeByThread.has(threadId)) return;
    const run =
      runId === undefined ? this.store.getActiveRun(threadId) : this.store.getRunById(runId);
    if (
      !run ||
      run.threadId !== threadId ||
      run.agentId !== 'thread' ||
      run.parentRunId !== null ||
      run.status !== 'queued'
    ) {
      this.#pendingThreads.delete(threadId);
      return;
    }
    try {
      this.#environmentRuntime.reserveRun(run);
    } catch (cause) {
      this.#rejectBeforeScheduling(run, cause);
      return;
    }
    const thread = this.store.getThread(run.ownerId, threadId);
    if (thread.threadType === 'task' && !this.#hasBackgroundSlot()) {
      this.#pendingThreads.add(threadId);
      return;
    }
    this.#pendingThreads.delete(threadId);
    this.#startExecution(this.#activeExecution(run, null), true);
  }

  async scheduleThreadCall(accepted: AcceptedThreadCall): Promise<void> {
    await this.deliver(accepted.input, accepted.runId);
  }

  async scheduleThreadNotification(accepted: AcceptedThreadNotification): Promise<void> {
    if (accepted.runId !== null) {
      this.#injectThreadNotification(accepted.notification, accepted.runId);
    }
  }

  async waitForInteraction(key: DelegationKey, waitMs: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const deadline = Date.now() + waitMs;
    const mapKey = delegationMapKey(key);
    let interaction = this.store.getInteraction(this.#ownerForInteraction(key), key);
    while (!isTerminal(interaction.status)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise<void>((resolve, reject) => {
        const listeners = this.#interactionWaiters.get(mapKey) ?? new Set<() => void>();
        this.#interactionWaiters.set(mapKey, listeners);
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          listeners.delete(done);
          if (listeners.size === 0) this.#interactionWaiters.delete(mapKey);
        };
        const done = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const timer = setTimeout(done, remaining);
        listeners.add(done);
        signal.addEventListener('abort', abort, { once: true });
      });
      interaction = this.store.getInteraction(this.#ownerForInteraction(key), key);
    }
  }

  async cancelInteraction(
    interaction: InteractionRecord,
    reason: string,
  ): Promise<InteractionRecord> {
    const cancelled = this.store.requestInteractionCancel({
      ownerId: interaction.ownerId,
      key: interaction,
      reason,
    });
    this.#notifyInteraction(interaction);
    if (cancelled.run) await this.cancel(cancelled.run, reason);
    for (const [runId, key] of this.#pendingSubagents) {
      if (delegationMapKey(key) !== delegationMapKey(interaction)) continue;
      if (!isTerminal(this.store.getRunById(runId).status)) {
        this.store.updateRunStatus(runId, 'cancelled');
      }
      this.#environmentRuntime.releaseRun(this.store.getRunById(runId));
      this.#pendingSubagents.delete(runId);
    }
    if (isTerminal(cancelled.interaction.status)) {
      await this.#deliverInteraction(interaction);
    }
    return this.store.getInteraction(interaction.ownerId, interaction);
  }

  resumeDeliveries(): void {
    if (this.#closing) return;
    const owners = z.array(z.object({ owner_id: z.string() })).parse(
      this.store.database
        .prepare(
          `SELECT owner_id FROM interaction_deliveries WHERE status <> 'consumed'
             UNION
             SELECT owner_id FROM thread_notifications WHERE status <> 'consumed'`,
        )
        .all(),
    );
    for (const { owner_id: ownerId } of owners) {
      for (const delivery of this.store.listUndeliveredInteractionDeliveries(ownerId)) {
        this.#trackDelivery(delivery);
      }
      for (const notification of this.store.listUndeliveredThreadNotifications(ownerId)) {
        this.#trackThreadNotification(notification);
      }
    }
  }

  #ownerForInteraction(key: DelegationKey): string {
    const row = z.object({ owner_id: z.string() }).parse(
      this.store.database
        .prepare(
          `SELECT owner_id FROM interactions
             WHERE source_thread_id = ? AND source_agent_id = ? AND source_tool_call_id = ?`,
        )
        .get(key.sourceThreadId, key.sourceAgentId, key.sourceToolCallId),
    );
    return row.owner_id;
  }

  #rejectBeforeScheduling(
    run: RunRecord,
    cause: unknown,
    key?: DelegationKey,
    initialInput?: string,
  ): void {
    const error = this.#runError(cause);
    this.store.transaction(() => {
      if (key) this.store.startSubagentInteraction(run.ownerId, key, run.runId);
      const queued = run.agentId === 'thread' ? this.store.listQueuedInputs(run.threadId) : [];
      for (const input of queued)
        this.store.appendModelMessage({
          runId: run.runId,
          inputId: input.inputId,
          message: { role: 'user', content: input.text },
        });
      const prompt =
        initialInput ?? (key ? this.store.getInteraction(run.ownerId, key).prompt : undefined);
      if (prompt)
        this.store.appendModelMessage({
          runId: run.runId,
          message: { role: 'user', content: prompt },
        });
      this.store.updateRunStatus(run.runId, 'failed', error);
    });
    this.#environmentRuntime.releaseRun(run);
    {
      const active = this.#activeExecution(run, key ?? null);
      const completion = this.#finishInteractions(active, 'failed', error).catch((cause) =>
        this.#options.onError?.(cause),
      );
      this.#deliveryPromises.add(completion);
      void completion.finally(() => this.#deliveryPromises.delete(completion));
    }
  }

  #activeExecution(run: RunRecord, interactionKey: DelegationKey | null): ActiveExecution {
    const hasAssistant =
      run.rerunFromMessageSeq !== null &&
      this.store.context
        .query({ threadId: run.threadId, agentId: run.agentId, currentOnly: true })
        .some((message) => message.runId === run.runId && message.message.role === 'assistant');
    return {
      runtime: null,
      runId: run.runId,
      threadId: run.threadId,
      agentId: run.agentId,
      generation: run.generation,
      interactionKey,
      instructions: null,
      loop: null,
      preparationController: new AbortController(),
      pendingInputIds: [],
      streamingMessageId: null,
      deltaSequence: 0,
      rerunAnchorPending: run.rerunFromMessageSeq !== null && !hasAssistant,
      usageBase: { inputTokens: 0, outputTokens: 0 },
      cancelReason: null,
      promise: null,
    };
  }

  #startExecution(
    active: ActiveExecution,
    root: boolean,
    depth = 0,
    signal?: AbortSignal,
    initialInput?: string,
  ): void {
    if (root) this.#activeByThread.set(active.threadId, active);
    this.#activeByRun.set(active.runId, active);
    active.promise = this.#execute(active, depth, signal, initialInput)
      .catch(async (error: unknown) => {
        this.#options.onError?.(error);
        await this.#failExecution(active, error);
      })
      .finally(() => {
        this.#environmentRuntime.releaseRun({ runId: active.runId, generation: active.generation });
        if (root && this.#activeByThread.get(active.threadId) === active) {
          this.#activeByThread.delete(active.threadId);
        }
        if (this.#activeByRun.get(active.runId) === active) {
          this.#activeByRun.delete(active.runId);
        }
        if (!this.#closing) {
          if (root) this.#scheduleQueuedRoot(active);
          this.#drain();
        }
      });
  }

  #scheduleQueuedRoot(active: ActiveExecution): void {
    const finished = this.store.getRunById(active.runId);
    for (const delivery of this.store.listUndeliveredInteractionDeliveries(finished.ownerId)) {
      if (delivery.replyThreadId !== active.threadId) continue;
      if (delivery.runId === active.runId && finished.status !== 'completed') continue;
      this.#trackDelivery(delivery);
    }
    for (const notification of this.store.listUndeliveredThreadNotifications(finished.ownerId)) {
      if (notification.replyThreadId !== active.threadId) continue;
      if (notification.runId === active.runId && finished.status !== 'completed') continue;
      this.#trackThreadNotification(notification);
    }
    if (finished.inputIds.length === 0 && finished.rerunFromMessageSeq === null) {
      this.schedule(active.threadId);
      return;
    }
    if (!this.store.getActiveRun(active.threadId)) {
      const first = this.store.listQueuedInputs(active.threadId)[0];
      if (first) {
        const run = this.store.moveInputToNewRun(first.ownerId, first.inputId);
        this.schedule(active.threadId, run.runId);
        return;
      }
    }
    this.schedule(active.threadId);
  }

  #scheduleSubagent(run: RunRecord, key: DelegationKey): void {
    if (this.#closing || this.#activeByRun.has(run.runId)) return;
    const current = this.store.getRunById(run.runId);
    if (isTerminal(current.status)) {
      this.#pendingSubagents.delete(run.runId);
      return;
    }
    try {
      this.#environmentRuntime.reserveRun(current);
    } catch (cause) {
      this.#rejectBeforeScheduling(current, cause, key);
      this.#pendingSubagents.delete(run.runId);
      return;
    }
    if (!this.#hasBackgroundSlot()) {
      if (current.status === 'running') this.store.updateRunStatus(current.runId, 'queued');
      this.#pendingSubagents.set(run.runId, key);
      return;
    }
    this.#pendingSubagents.delete(run.runId);
    const interaction = this.store.getInteraction(current.ownerId, key);
    this.#startExecution(
      this.#activeExecution(current, key),
      false,
      1,
      undefined,
      interaction.prompt,
    );
  }

  #hasBackgroundSlot(): boolean {
    let active = 0;
    for (const execution of new Set(this.#activeByRun.values())) {
      const run = this.store.getRunById(execution.runId);
      if (run.parentRunId === null) {
        if (this.store.getThread(run.ownerId, run.threadId).threadType === 'task') active += 1;
      } else if (run.executionMode === 'background') {
        active += 1;
      }
    }
    return active < (this.#options.maxActiveThreads ?? 2);
  }

  #drain(): void {
    for (const threadId of [...this.#pendingThreads]) {
      if (!this.#hasBackgroundSlot()) return;
      this.schedule(threadId);
    }
    for (const [runId, key] of [...this.#pendingSubagents]) {
      if (!this.#hasBackgroundSlot()) return;
      this.#scheduleSubagent(this.store.getRunById(runId), key);
    }
  }

  async cancel(run: RunRecord, reason: string): Promise<void> {
    const acceptedGeneration = run.cancelAcceptedGeneration;
    if (acceptedGeneration === null) return;
    const current = this.store.getRunById(run.runId);
    if (
      current.generation !== acceptedGeneration ||
      current.cancelAcceptedGeneration !== acceptedGeneration ||
      isTerminal(current.status)
    ) {
      if (isTerminal(current.status) && !this.#activeByRun.has(current.runId)) {
        this.#environmentRuntime.releaseRun(current);
        this.#pendingThreads.delete(current.threadId);
        this.#pendingSubagents.delete(current.runId);
      }
      return;
    }
    if (this.#activeByRun.get(run.runId)?.generation !== acceptedGeneration) {
      this.#environmentRuntime.releaseRun(current);
      this.#pendingThreads.delete(current.threadId);
      this.#pendingSubagents.delete(current.runId);
      return;
    }
    this.#cancelTree(current, reason);
  }

  #cancelTree(run: RunRecord, reason: string): void {
    const active = this.#activeByRun.get(run.runId);
    if (active) {
      active.cancelReason = reason;
      active.preparationController.abort(new DOMException(reason, 'AbortError'));
      active.loop?.cancel(reason);
    }
    for (const child of this.store
      .listRuns(run.ownerId, run.threadId)
      .filter(
        (candidate) =>
          candidate.parentRunId === run.runId && candidate.executionMode === 'foreground',
      )) {
      if (this.#activeByRun.has(child.runId) && !isTerminal(child.status)) {
        this.#cancelTree(child, reason);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    const periodicClosing = Promise.all([
      this.#periodicRecaps?.close(),
      ...[...this.#modelRuntimes.values()].map((runtime) => runtime.periodic.close()),
    ]);
    const manualCompactionClosing = Promise.all([
      this.#manualCompaction.close(),
      ...[...this.#modelRuntimes.values()].map((runtime) => runtime.manual.close()),
    ]);
    const titleSummaries = [...this.#titleSummaries.values()];
    for (const summary of titleSummaries) {
      summary.controller.abort();
      if (
        !this.#activeByRun.has(summary.run.runId) &&
        !this.#pendingThreads.has(summary.run.threadId)
      )
        this.#environmentRuntime.releaseRun(summary.run);
    }
    const error: RunError = {
      code: 'operation_unknown',
      message: 'Server is shutting down before this execution starts.',
      retryable: true,
    };
    for (const [runId, key] of this.#pendingSubagents) {
      const interaction = this.store.getInteraction(this.#ownerForInteraction(key), key);
      if (!isTerminal(interaction.status)) {
        this.store.recordInteractionTerminal({
          ownerId: interaction.ownerId,
          key,
          status: 'interrupted',
          error,
        });
        this.#notifyInteraction(key);
      }
      if (!isTerminal(this.store.getRunById(runId).status)) {
        this.store.updateRunStatus(runId, 'interrupted', error);
      }
      this.#environmentRuntime.releaseRun(this.store.getRunById(runId));
    }
    this.#pendingSubagents.clear();
    for (const threadId of this.#pendingThreads) {
      const run = this.store.getActiveRun(threadId);
      if (run && !isTerminal(run.status)) {
        this.store.updateRunStatus(run.runId, 'interrupted', error);
        this.#environmentRuntime.releaseRun(run);
      }
    }
    this.#pendingThreads.clear();
    const active = [...new Set(this.#activeByRun.values())];
    for (const execution of active) {
      execution.cancelReason = 'Server is shutting down.';
      execution.preparationController.abort(new DOMException(execution.cancelReason, 'AbortError'));
      execution.loop?.cancel(execution.cancelReason);
    }
    try {
      await Promise.all([
        ...active.map((execution) => execution.promise),
        ...this.#deliveryPromises,
        ...titleSummaries.map((summary) => summary.promise),
        periodicClosing,
        manualCompactionClosing,
        this.#environmentRuntime.close(),
      ]);
    } finally {
      await this.#browserRuntime?.close();
    }
  }

  async #execute(
    active: ActiveExecution,
    depth = 0,
    signal?: AbortSignal,
    initialInput?: string,
  ): Promise<void> {
    let initialRun = this.store.getRunById(active.runId);
    if (active.interactionKey !== null) {
      const interaction = this.store.getInteraction(initialRun.ownerId, active.interactionKey);
      if (isTerminal(interaction.status)) {
        if (!isTerminal(initialRun.status)) {
          this.store.updateRunStatus(
            initialRun.runId,
            interaction.status,
            interaction.error ?? undefined,
          );
        }
        return;
      }
      this.store.startSubagentInteraction(
        initialRun.ownerId,
        active.interactionKey,
        initialRun.runId,
      );
      initialRun = this.store.getRunById(active.runId);
    }
    active.usageBase = { ...initialRun.usage };
    const rootQueued = depth === 0 ? this.store.listQueuedInputs(initialRun.threadId) : [];
    const rootDeliveries =
      depth === 0 ? this.store.listInteractionDeliveriesForRun(initialRun.runId) : [];
    const rootNotifications =
      depth === 0 ? this.store.listThreadNotificationsForRun(initialRun.runId) : [];
    if (
      depth === 0 &&
      initialRun.inputIds.length === 0 &&
      rootQueued.length === 0 &&
      rootDeliveries.length + rootNotifications.length === 0 &&
      initialRun.rerunFromMessageSeq === null
    ) {
      this.store.updateRunStatus(active.runId, 'cancelled');
      await this.#finishInteractions(active, 'cancelled');
      return;
    }
    await this.#recoverToolRoundTrips(initialRun);
    active.runtime = this.#options.settings ? (this.#runtimeForRun(initialRun) ?? null) : null;
    const executionModel = active.runtime?.model ?? this.#options.model;
    const executionProvider = active.runtime?.provider ?? this.#limitedProvider;
    if (!executionModel || !executionProvider) {
      const error: RunError = {
        code: 'failed_precondition',
        message: 'Model configuration is unavailable.',
        retryable: false,
      };
      this.store.updateRunStatus(active.runId, 'failed', error);
      await this.#finishInteractions(active, 'failed', error);
      return;
    }
    const current = this.store.getRunById(active.runId);
    if (current.status === 'cancelled') {
      await this.#finishInteractions(active, 'cancelled');
      return;
    }
    if (current.status !== 'cancel_requested') {
      this.store.updateRunStatus(active.runId, 'running');
    } else {
      active.preparationController.abort(new DOMException('Cancellation requested.', 'AbortError'));
    }
    await this.#environmentRuntime.prepare(current, active.preparationController.signal);
    active.instructions = this.#instructions(
      current.ownerId,
      current.threadId,
      current.agentId,
      current,
    );
    const persistence = this.#persistence(active);
    const modelInput = active.runtime?.input ?? this.#modelInputService();
    const provider = this.#preparedProvider(
      initialRun,
      active,
      modelInput,
      executionProvider,
      executionModel,
    );
    const loop = new AgentLoop({
      provider,
      persistence,
      tools: this.#tools(initialRun, depth),
      maxSteps: this.#options.maxStepsPerRun ?? 30,
      executionId: initialRun.runId,
      ...(depth === 0
        ? {
            readInputs: (mode) => this.#readInputs(active, mode),
            readInjections: () => this.#readInjections(active),
          }
        : {}),
    });
    active.loop = loop;
    const cancelReason =
      active.cancelReason ??
      (current.status === 'cancel_requested' ? 'Cancellation requested.' : null);
    const unsubscribe = loop.subscribe((event) => this.#loopEvent(active, event));
    try {
      const queued = depth === 0 ? this.store.listQueuedInputs(initialRun.threadId) : [];
      const anchored = depth === 0 && initialRun.rerunFromMessageSeq !== null;
      const first = anchored ? undefined : queued[0];
      if (first) active.pendingInputIds.push(first.inputId);
      const input = depth === 0 ? (first ? inputModelContent(first) : undefined) : initialInput;
      const running = loop.run(input, {
        ...(first ? { inputId: first.inputId } : {}),
        ...(signal ? { signal } : {}),
      });
      if (cancelReason !== null) loop.cancel(cancelReason);
      if (!anchored) {
        for (const input of queued.slice(1)) {
          if (input.mode === 'steer') loop.supplement(inputModelContent(input), input.inputId);
          else loop.enqueue(inputModelContent(input), input.inputId);
          active.pendingInputIds.push(input.inputId);
        }
      }
      const result = await running;
      await this.#finish(active, result);
    } catch (error) {
      const runError = this.#runError(error);
      this.store.updateRunStatus(active.runId, 'failed', runError);
      await this.#finishInteractions(active, 'failed', runError);
    } finally {
      unsubscribe();
      active.loop = null;
      active.streamingMessageId = null;
      await this.#browserRuntime?.closeRun(active.runId);
    }
  }

  #readInputs(active: ActiveExecution, mode: 'steer' | 'follow_up') {
    const delivered = new Set(active.pendingInputIds);
    const queued = this.store
      .listQueuedInputs(active.threadId)
      .filter((input) => delivered.has(input.inputId));
    active.pendingInputIds = queued.map((input) => input.inputId);
    return queued
      .filter((input) => input.mode === mode)
      .map((input) => ({ id: input.inputId, ...inputModelContent(input) }));
  }

  #readInjections(active: ActiveExecution) {
    const interactions = this.store
      .listInteractionDeliveriesForRun(active.runId)
      .map((delivery) => {
        if (delivery.content === null) {
          throw new SessionError('internal', 'A queued delivery has no content.');
        }
        return { id: delegationMapKey(delivery), content: delivery.content };
      });
    const notifications = this.store
      .listThreadNotificationsForRun(active.runId)
      .map((notification) => ({
        id: `thread_notification:${delegationMapKey(notification)}`,
        content: notification.deliveryContent,
      }));
    return [...interactions, ...notifications];
  }

  async #finish(active: ActiveExecution, result: AgentLoopResult): Promise<void> {
    if (this.#closing || result.status === 'interrupted') {
      const error: RunError = {
        code: 'operation_unknown',
        message:
          result.error?.message ?? 'The model stream or Server process interrupted this Run.',
        retryable: true,
      };
      this.store.updateRunStatus(active.runId, 'interrupted', error);
      await this.#finishInteractions(active, 'interrupted', error);
      return;
    }
    if (result.status === 'cancelled') {
      this.store.updateRunStatus(active.runId, 'cancelled');
      await this.#finishInteractions(active, 'cancelled');
      return;
    }
    if (result.status === 'failed') {
      const error = this.#runError(result.error);
      this.store.updateRunStatus(active.runId, 'failed', error);
      await this.#finishInteractions(active, 'failed', error);
      return;
    }
    this.store.updateRunStatus(active.runId, 'completed');
    await this.#finishInteractions(active, 'completed');
  }

  async #failExecution(active: ActiveExecution, cause: unknown): Promise<void> {
    try {
      const error = this.#closing
        ? ({
            code: 'operation_unknown',
            message: 'Server is shutting down during this execution.',
            retryable: true,
          } as const)
        : this.#runError(cause);
      const status = this.#closing
        ? 'interrupted'
        : error.code === 'operation_unknown'
          ? 'failed'
          : active.cancelReason !== null ||
              this.store.getRunById(active.runId).status === 'cancel_requested'
            ? 'cancelled'
            : 'failed';
      if (!isTerminal(this.store.getRunById(active.runId).status)) {
        this.store.transaction(() => {
          if (active.loop === null && active.agentId === 'thread') {
            for (const input of this.store.listQueuedInputs(active.threadId)) {
              this.store.appendModelMessage({
                runId: active.runId,
                inputId: input.inputId,
                message: { role: 'user', content: input.text },
              });
            }
          }
          this.store.updateRunStatus(active.runId, status, error);
        });
      }
      await this.#finishInteractions(active, status, error);
    } catch (error) {
      this.#options.onError?.(error);
    }
  }

  #loopEvent(active: ActiveExecution, event: AgentLoopEvent): void {
    if (event.type === 'text_delta' || event.type === 'thinking_delta') {
      const messageId = active.streamingMessageId;
      if (!messageId) return;
      active.deltaSequence += 1;
      const delta: StreamDeltaRecord = {
        threadId: active.threadId,
        agentId: active.agentId,
        messageId,
        deltaSeq: active.deltaSequence,
        text: event.text,
        blockIndex: event.block_index,
        runId: active.runId,
        ...(event.type === 'thinking_delta' ? { thinking: true as const } : {}),
      };
      this.store.publishTextDelta(delta);
      return;
    }
    if (event.type === 'usage') {
      this.store.updateRunUsage(
        active.runId,
        active.usageBase.inputTokens + event.total_usage.input_tokens,
        active.usageBase.outputTokens + event.total_usage.output_tokens,
      );
      return;
    }
    if (event.type === 'tool_status') {
      const run = this.store.getRunById(active.runId);
      if (event.status === 'running' && run.status === 'running') {
        this.store.updateRunStatus(active.runId, 'waiting');
      } else if (
        ['succeeded', 'failed', 'rejected', 'cancelled'].includes(event.status) &&
        run.status === 'waiting'
      ) {
        this.store.updateRunStatus(active.runId, 'running');
      }
    }
  }

  async #recoverToolRoundTrips(run: RunRecord): Promise<void> {
    const pending = this.store.context
      .listToolCallRelations(run.threadId, run.agentId)
      .filter((relation) => relation.resultSeq === null);
    for (const relation of pending) {
      const assistant = this.store.context.get(run.threadId, run.agentId, relation.assistantSeq);
      const ownerRunId = assistant?.runId ?? run.runId;
      const saved = await this.#savedToolResult(ownerRunId, relation.callId);
      const content =
        saved?.content ??
        JSON.stringify({
          status: 'unknown',
          error: 'tool_result_unknown',
          message:
            'Server restarted before the tool result was confirmed. The operation was not repeated.',
        });
      const status = saved?.status ?? 'error';
      const message: ModelMessage = {
        role: 'tool',
        tool_call_id: relation.callId,
        tool_name: relation.toolName,
        content,
        ...(saved?.content_parts === undefined ? {} : { content_parts: saved.content_parts }),
        status,
        ...(status === 'error'
          ? { error: { code: 'execution_failed' as const, message: content } }
          : {}),
      };
      const attachmentIds = toolAttachmentIds(message);
      this.store.transaction(() => {
        const record = this.store.appendModelMessage({
          runId: ownerRunId,
          message: withoutToolContentParts(message),
        });
        if (attachmentIds.length > 0) {
          this.store.attachments.linkMessage(record.seq, run.ownerId, attachmentIds);
        }
      });
    }
  }

  async #savedToolResult(runId: string, callId: string): Promise<ToolExecutionResult | undefined> {
    const environmentResult = await this.#environmentRuntime.savedResult(runId, callId);
    if (environmentResult) return environmentResult;

    const serverRow = this.store.database
      .prepare(
        'SELECT content, status FROM server_bash_operations WHERE run_id = ? AND tool_call_id = ?',
      )
      .get(runId, callId);
    if (serverRow !== undefined) {
      const server = serverResultSchema.parse(serverRow);
      if (server.content !== null && server.status !== null) {
        return { content: server.content, status: server.status };
      }
    }
    const notification = this.store.findThreadNotificationForToolResult(runId, callId);
    if (notification) {
      return {
        content: JSON.stringify(threadNotificationAcceptance(notification)),
        status: 'success',
      };
    }
    return undefined;
  }

  #persistence(active: ActiveExecution): AgentLoopPersistence {
    const saveMessage = async (
      message: ModelMessage,
      inputId?: string,
      responseUsage?: DetailedModelUsage,
      deliveryId?: string,
      commit?: () => void,
    ): Promise<void> => {
      const run = this.store.getRunById(active.runId);
      if (
        message.role === 'user' &&
        run.agentId === 'thread' &&
        inputId === undefined &&
        deliveryId === undefined
      ) {
        throw new Error('A Thread root Agent user message is not associated with a queued input.');
      }
      const attachmentIds = toolAttachmentIds(message);
      let completed: InteractionRecord[] = [];
      const deliveries: Array<{
        delivery: InteractionDeliveryRecord;
        runId: string | null;
      }> = [];
      this.store.transaction(() => {
        commit?.();
        let saved: ContextMessage;
        if (deliveryId === undefined) {
          saved = this.store.appendModelMessage({
            runId: active.runId,
            ...(message.role === 'user' && inputId !== undefined ? { inputId } : {}),
            ...(message.role === 'assistant' && active.streamingMessageId
              ? { messageId: active.streamingMessageId }
              : {}),
            message: withoutToolContentParts(message),
            ...(responseUsage === undefined ? {} : { responseUsage }),
          });
        } else {
          if (message.role !== 'user') {
            throw new SessionError('internal', 'A delivery injection must use a user message.');
          }
          if (deliveryId.startsWith('thread_notification:')) {
            saved = this.store.appendThreadNotificationMessage({
              runId: active.runId,
              key: parseDelegationMapKey(deliveryId.slice('thread_notification:'.length)),
              message: { role: 'user', content: message.content },
            });
          } else {
            saved = this.store.appendInteractionDeliveryMessage({
              runId: active.runId,
              key: parseDelegationMapKey(deliveryId),
              message: { role: 'user', content: message.content },
            });
          }
        }
        if (attachmentIds.length > 0) {
          this.store.attachments.linkMessage(saved.seq, run.ownerId, attachmentIds);
        }
        if (
          message.role === 'assistant' &&
          (message.tool_calls?.length ?? 0) === 0 &&
          (message.incomplete_tool_calls?.length ?? 0) === 0
        ) {
          const interactionKeys = this.#responseInteractionKeys(active);
          if (interactionKeys.length > 0) {
            completed = this.store.recordInteractionResponses({
              runId: active.runId,
              messageId: saved.messageId,
              interactionKeys,
            });
            for (const interaction of completed) {
              if (interaction.executionMode === 'background') {
                deliveries.push(this.#enqueueDelivery(interaction));
              }
            }
          }
        }
      });
      if (
        (message.role === 'assistant' || message.role === 'tool') &&
        active.cancelReason === null &&
        run.status !== 'cancel_requested' &&
        active.loop?.isCancellationRequested !== true
      ) {
        (active.runtime?.periodic ?? this.#periodicRecaps)?.schedule(run.threadId, run.agentId);
      }
      for (const interaction of completed) this.#notifyInteraction(interaction);
      for (const pending of deliveries) {
        if (pending.runId !== null) this.#injectDelivery(pending.delivery, pending.runId);
      }
      if (message.role === 'user' && inputId !== undefined) {
        active.pendingInputIds = active.pendingInputIds.filter(
          (candidate) => candidate !== inputId,
        );
      }
      if (message.role === 'assistant') {
        active.streamingMessageId = null;
        if (active.rerunAnchorPending) {
          active.rerunAnchorPending = false;
          for (const input of this.store.listQueuedInputs(active.threadId)) {
            if (input.mode === 'steer') {
              active.loop?.supplement(inputModelContent(input), input.inputId);
            } else {
              active.loop?.enqueue(inputModelContent(input), input.inputId);
            }
            active.pendingInputIds.push(input.inputId);
          }
        }
      }
    };
    return {
      saveMessage,
      saveToolResult: async (message, commit) =>
        saveMessage(message, undefined, undefined, undefined, commit),
      saveToolCall: async (call: ToolCall) => {
        const run = this.store.getRunById(active.runId);
        const relation = this.store.context
          .listToolCallRelations(run.threadId, run.agentId)
          .find((candidate) => candidate.callId === call.id);
        if (!relation) throw new Error(`Tool intent ${call.id} was not persisted.`);
      },
    };
  }

  #responseInteractionKeys(active: ActiveExecution): DelegationKey[] {
    const run = this.store.getRunById(active.runId);
    if (active.interactionKey !== null) {
      const interaction = this.store.getInteraction(run.ownerId, active.interactionKey);
      return interaction.consumedRunId === run.runId && !isTerminal(interaction.status)
        ? [active.interactionKey]
        : [];
    }
    const keys = new Map<string, DelegationKey>();
    for (const inputId of run.inputIds) {
      const input = this.store.getInput(run.ownerId, inputId);
      if (
        input.source !== 'thread_call' ||
        input.delegation === null ||
        input.consumedRunId !== run.runId
      ) {
        continue;
      }
      const interaction = this.store.getInteraction(run.ownerId, input.delegation);
      if (interaction.consumedRunId === run.runId && !isTerminal(interaction.status)) {
        keys.set(delegationMapKey(input.delegation), input.delegation);
      }
    }
    return [...keys.values()];
  }

  async #finishInteractions(
    active: ActiveExecution,
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted',
    runError?: RunError,
  ): Promise<void> {
    for (const key of this.#responseInteractionKeys(active)) {
      const interaction = this.store.getInteraction(
        this.store.getRunById(active.runId).ownerId,
        key,
      );
      const terminalStatus = status === 'completed' ? 'failed' : status;
      const error =
        terminalStatus === 'failed'
          ? (runError ?? {
              code: 'internal' as const,
              message: 'The Run completed without a response for this interaction.',
              retryable: false,
            })
          : terminalStatus === 'interrupted'
            ? (runError ?? {
                code: 'operation_unknown' as const,
                message: 'The interaction was interrupted before its response was confirmed.',
                retryable: true,
              })
            : undefined;
      const finished = this.store.recordInteractionTerminal({
        ownerId: interaction.ownerId,
        key,
        status: terminalStatus,
        ...(error ? { error } : {}),
      });
      this.#notifyInteraction(key);
      if (finished.executionMode === 'background') await this.#deliverInteraction(key);
    }
  }

  #interactionDeliveryText(interaction: InteractionRecord): string {
    const response = this.store.getCurrentInteractionResponse(interaction.ownerId, interaction);
    return JSON.stringify({
      source_thread_id: interaction.sourceThreadId,
      source_agent_id: interaction.sourceAgentId,
      tool_call_id: interaction.sourceToolCallId,
      kind: interaction.kind,
      thread_id: interaction.targetThreadId,
      agent_id: interaction.targetAgentId,
      status: interaction.status,
      response: response?.message.role === 'assistant' ? response.message.content : null,
      error: interaction.error,
    });
  }

  #enqueueDelivery(interaction: InteractionRecord): {
    delivery: InteractionDeliveryRecord;
    runId: string | null;
  } {
    return this.store.enqueueInteractionDelivery({
      ownerId: interaction.ownerId,
      key: interaction,
      text: this.#interactionDeliveryText(interaction),
    });
  }

  async #deliverInteraction(key: DelegationKey): Promise<void> {
    const ownerId = this.#ownerForInteraction(key);
    const interaction = this.store.getInteraction(ownerId, key);
    if (interaction.executionMode !== 'background' || !isTerminal(interaction.status)) return;
    const pending = this.#enqueueDelivery(interaction);
    if (pending.runId !== null) this.#injectDelivery(pending.delivery, pending.runId);
  }

  #injectDelivery(delivery: InteractionDeliveryRecord, runId: string): void {
    if (this.#closing || delivery.status === 'consumed') return;
    const run = this.store.getRunById(runId);
    if (isTerminal(run.status)) {
      if (run.error?.code === 'sandbox_capacity_exhausted') return;
      const interaction = this.store.getInteraction(delivery.ownerId, delivery);
      const reassigned = this.#enqueueDelivery(interaction);
      if (reassigned.runId !== null && reassigned.runId !== runId) {
        this.#injectDelivery(reassigned.delivery, reassigned.runId);
      }
      return;
    }
    if (this.#activeByThread.get(delivery.replyThreadId)?.runId === runId) return;
    this.schedule(delivery.replyThreadId, runId);
  }

  #injectThreadNotification(notification: ThreadNotificationRecord, runId: string): void {
    if (this.#closing || notification.status === 'consumed') return;
    const run = this.store.getRunById(runId);
    if (isTerminal(run.status)) {
      if (run.error?.code === 'sandbox_capacity_exhausted') return;
      const reassigned = this.store.enqueueThreadNotification({
        ownerId: notification.ownerId,
        key: notification,
      });
      if (reassigned.runId !== null && reassigned.runId !== runId) {
        this.#injectThreadNotification(reassigned.notification, reassigned.runId);
      }
      return;
    }
    if (this.#activeByThread.get(notification.replyThreadId)?.runId === runId) return;
    this.schedule(notification.replyThreadId, runId);
  }

  #trackThreadNotification(notification: ThreadNotificationRecord): void {
    if (this.#closing) return;
    try {
      const pending = this.store.enqueueThreadNotification({
        ownerId: notification.ownerId,
        key: notification,
      });
      if (pending.runId !== null) {
        this.#injectThreadNotification(pending.notification, pending.runId);
      }
    } catch (error) {
      this.#options.onError?.(error);
    }
  }

  #trackDelivery(key: DelegationKey): void {
    if (this.#closing) return;
    const tracked = this.#deliverInteraction(key).catch((error: unknown) => {
      this.#options.onError?.(error);
    });
    this.#deliveryPromises.add(tracked);
    void tracked.then(() => this.#deliveryPromises.delete(tracked));
  }

  #notifyInteraction(key: DelegationKey): void {
    for (const notify of [...(this.#interactionWaiters.get(delegationMapKey(key)) ?? [])]) notify();
  }

  #runtimeForRun(run: RunRecord): ModelRuntime | undefined {
    const model = this.#options.settings?.capture(run);
    return model ? this.#runtimeForModel(model) : undefined;
  }

  #runtimeForModel(model: RuntimeModelConfiguration): ModelRuntime {
    const key = model.configurationId ?? `${model.providerId}:${model.modelId}`;
    const existing = this.#modelRuntimes.get(key);
    if (existing) return existing;
    const provider = new LimitedProvider(model.provider, this.#slots, (request) =>
      this.store.attachments.materializeRequest(request),
    );
    const generator = new RecapModelGenerator(provider);
    const countTokens =
      model.countTokens ??
      ((request: ModelRequest) => Math.ceil(JSON.stringify(request).length / 4));
    const input = new ModelInputService(this.store.database, {
      countTokens,
      materializeRequest: (request) => this.store.attachments.materializeRequest(request),
      recapStore: this.store.recaps,
      generateRecap: (generation, signal) => generator.generate(generation, signal),
      configurationId: key,
      ...(this.#options.now ? { clock: this.#options.now } : {}),
    });
    const periodic = new PeriodicRecapService({
      database: this.store.database,
      recapStore: this.store.recaps,
      provider,
      model: {
        providerId: model.providerId,
        modelId: model.modelId,
        contextWindowTokens: model.contextWindowTokens,
        outputReserveTokens: model.outputReserveTokens,
      },
      configuration: this.#options.periodicRecap ?? DEFAULT_PERIODIC_RECAP_CONFIGURATION,
      acceptRequest: (requestId) => this.#options.settings?.acceptRecap(requestId, key) ?? true,
      ...(this.#options.now ? { clock: this.#options.now } : {}),
      ...(this.#options.onError ? { onError: this.#options.onError } : {}),
    });
    const manual = new ManualCompactionService({
      store: this.store,
      modelInputs: input,
      model: {
        contextWindowTokens: model.contextWindowTokens,
        outputReserveTokens: model.outputReserveTokens,
      },
      systemInstructions: (ownerId, threadId) => this.#instructions(ownerId, threadId, 'thread'),
      toolsForThread: (ownerId, threadId) => {
        const run = this.store
          .listRuns(ownerId, threadId)
          .findLast(
            (candidate) => candidate.agentId === 'thread' && candidate.parentRunId === null,
          );
        return (run ? this.#tools(run, 0) : []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: structuredClone(tool.parameters),
        }));
      },
      isThreadActive: (threadId) =>
        this.#activeByThread.has(threadId) ||
        this.#manualCompaction.isActive(threadId) ||
        [...this.#modelRuntimes.values()].some((runtime) => runtime.manual.isActive(threadId)),
      isPeriodicRecapActive: (threadId, agentId) =>
        (this.#periodicRecaps?.hasActive(threadId, agentId) ?? false) ||
        [...this.#modelRuntimes.values()].some((runtime) =>
          runtime.periodic.hasActive(threadId, agentId),
        ),
      createId: this.#createId,
      ...(this.#options.now ? { clock: this.#options.now } : {}),
    });
    const runtime = {
      model,
      provider,
      input,
      periodic,
      manual,
      title: new ThreadTitleGenerator(provider, {
        contextWindowTokens: model.contextWindowTokens,
        countTokens,
      }),
    };
    this.#modelRuntimes.set(key, runtime);
    return runtime;
  }

  #modelInputService(): ModelInputService {
    if (!this.#options.model || !this.#recapGenerator) {
      throw new SessionError('internal', 'Model is unavailable.');
    }
    return this.#modelInput;
  }

  #instructions(
    ownerId: string,
    threadId: string,
    agentId: string,
    run?: RunRecord,
  ): readonly string[] {
    const thread = this.store.getThread(ownerId, threadId);
    return Object.freeze([
      agentInstructions(thread.threadType, agentId),
      ...this.#environmentRuntime.instructions(ownerId, threadId, agentId, run),
    ]);
  }

  #runtimeSpec(
    ownerId: string,
    threadId: string,
  ): { runtimeFingerprint: string; runtimeChanged?: boolean } | undefined {
    const run = this.store
      .listRuns(ownerId, threadId)
      .findLast((candidate) => candidate.agentId === 'thread' && candidate.parentRunId === null);
    if (!run) return undefined;
    const tools = this.#tools(run, 0).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: structuredClone(tool.parameters),
    }));
    const fingerprint = runtimeSpecFingerprint(
      this.#instructions(ownerId, threadId, 'thread'),
      tools,
    );
    const viewVersion = this.#modelInput.getState(threadId, 'thread').viewVersion;
    const completed = this.#modelInput.getLatestCompletedNormalRequest(
      threadId,
      'thread',
      viewVersion,
    );
    const baseline =
      completed === undefined ? undefined : runtimeSpecFingerprintFromRequest(completed);
    return {
      runtimeFingerprint: fingerprint,
      ...(baseline === undefined ? {} : { runtimeChanged: baseline !== fingerprint }),
    };
  }

  #preparedProvider(
    run: RunRecord,
    active: ActiveExecution,
    modelInput: ModelInputService,
    provider: ModelProvider,
    model: RuntimeModelConfiguration,
  ): ModelProvider {
    if (!model) throw new SessionError('internal', 'Model is unavailable.');
    return {
      stream: async function* (this: RunCoordinator, request: ModelRequest, signal: AbortSignal) {
        const current = this.store.getRunById(run.runId);
        const requestId = current.currentRequestId ?? `${run.runId}:request:${this.#createId()}`;
        this.#options.settings?.recordRequest(run.ownerId, requestId, model);
        this.store.setCurrentRequestId(run.runId, requestId);
        active.streamingMessageId = this.#createId();
        active.deltaSequence = 0;
        const previousState = modelInput.getState(run.threadId, run.agentId);
        const pendingContextSeqs =
          run.rerunFromMessageSeq !== null && active.rerunAnchorPending
            ? this.store
                .listContext(run.ownerId, run.threadId, run.agentId)
                .filter(
                  (message) =>
                    message.supersededByRunId === null &&
                    message.seq >= (run.rerunFromMessageSeq ?? 0) &&
                    message.message.role === 'user',
                )
                .map((message) => message.seq)
            : [];
        try {
          await this.#environmentRuntime.prepareAttachments(current, signal);
          const prepared = await modelInput.prepare({
            requestId,
            threadId: run.threadId,
            agentId: run.agentId,
            systemInstructions:
              active.instructions ??
              (() => {
                throw new SessionError('internal', 'Execution instructions are not prepared.');
              })(),
            tools: request.tools,
            contextWindowTokens: model.contextWindowTokens,
            outputReserveTokens: model.outputReserveTokens,
            ...(pendingContextSeqs.length > 0 ? { pendingContextSeqs } : {}),
            onCommitted: () => this.store.recordModelRequestPrepared(run.runId, requestId),
            signal,
          });
          if (prepared.hardCut) {
            this.store.recordEvent(run.threadId, {
              case: 'hardCutStarted',
              value: { runId: run.runId },
            });
            const replacedSourceSeqs = this.store
              .listContext(run.ownerId, run.threadId, run.agentId)
              .filter(
                (message) =>
                  message.seq > previousState.readThroughSeq &&
                  message.seq <= prepared.readThroughSeq,
              )
              .map((message) => message.seq);
            this.store.recordEvent(run.threadId, {
              case: 'hardCutCompleted',
              value: {
                runId: run.runId,
                replacedSourceSeqs,
                recapIds: [...prepared.selectedRecapIds],
                injectedMessageCount: 1,
              },
            });
          }
          const dispatchRequest = this.store.attachments.materializeRequest(prepared.request);
          this.store.recordModelRequestDispatched(run.runId, requestId);
          yield* provider.stream(dispatchRequest, signal);
        } catch (error) {
          if (error instanceof HardCutError) {
            this.store.recordEvent(run.threadId, {
              case: 'hardCutFailed',
              value: { runId: run.runId, error: this.#runError(error) },
            });
          }
          throw error;
        }
      }.bind(this),
    };
  }

  #recallEngine(run: RunRecord): SqlRecallEngine {
    return new SqlRecallEngine(
      this.store.database,
      {
        scope: { threadId: run.threadId, agentId: run.agentId },
        currentRunId: run.runId,
        includeDescendants: run.agentId === 'thread',
      },
      {
        ...(this.#options.sqlRecall ? { limits: this.#options.sqlRecall } : {}),
        processPool: this.#recallProcessPool,
      },
    );
  }

  #tools(run: RunRecord, depth: number): AgentTool[] {
    const scope = { threadId: run.threadId, agentId: run.agentId };
    const recall = {
      execute: (sql: string, options: { signal?: AbortSignal }) =>
        this.#recallEngine(run).execute(sql, options),
    };
    const thread = this.store.getThread(run.ownerId, run.threadId);
    const threadType = thread.threadType;
    const tools: AgentTool[] = [createRecallTool({ engine: recall, scope })];
    tools.push(...createEnvironmentTools(this.#environmentRuntime, run));
    tools.push(
      ...createWebTools({
        ...(this.#options.web ?? {}),
        searchQuota: this.#webSearchQuota,
        quotaKey: run.ownerId,
      }),
    );
    if (this.#browserRuntime) tools.push(this.#browserRuntime.createTool(run.runId));
    if (depth === 0 && run.agentId === 'thread' && run.parentRunId === null) {
      const delegation = {
        store: this.store,
        source: run,
        scheduleThreadCall: (accepted: AcceptedThreadCall) => this.scheduleThreadCall(accepted),
        waitForInteraction: (key: DelegationKey, waitMs: number, signal: AbortSignal) =>
          this.waitForInteraction(key, waitMs, signal),
        cancelInteraction: (interaction: InteractionRecord, reason: string) =>
          this.cancelInteraction(interaction, reason),
        resolveEnvironmentIds: (envIds: readonly string[]) =>
          this.#environmentRuntime.resolveEnvironmentIds(run.ownerId, envIds),
        projectEnvironmentIds: (envIds: readonly string[]) =>
          this.#environmentRuntime.projectEnvironmentIds(run.ownerId, envIds),
      };
      if (threadType === 'main') {
        tools.push(createSendToUserTool({ store: this.store, source: run }));
        tools.push(...createThreadDelegationTools(delegation));
        tools.push(createWorkspaceListTool(delegation));
        if (this.#options.automations) {
          tools.push(
            ...createAutomationTools({
              automations: this.#options.automations,
              source: run,
              resolveEnvironmentIds: delegation.resolveEnvironmentIds,
              projectEnvironmentIds: delegation.projectEnvironmentIds,
            }),
          );
        }
      } else if (threadType === 'workspace_main') {
        tools.push(...createThreadDelegationTools(delegation));
        tools.push(createWorkspaceListTool(delegation));
        tools.push(
          createThreadNotificationTool({
            store: this.store,
            source: run,
            scheduleThreadNotification: (accepted) => this.scheduleThreadNotification(accepted),
          }),
        );
      } else if (!thread.automationOnly) {
        tools.push(
          createThreadNotificationTool({
            store: this.store,
            source: run,
            scheduleThreadNotification: (accepted) => this.scheduleThreadNotification(accepted),
          }),
        );
      }
      tools.push(...createSubagentDelegationTools(delegation));
    }
    if (depth < (this.#options.maxSubagentDepth ?? 1)) {
      tools.push(this.#subagentTool(run, depth));
    }
    return tools;
  }

  #subagentTool(parent: RunRecord, depth: number): AgentTool<z.infer<typeof subagentInputSchema>> {
    let createdChildren = 0;
    return {
      name: 'subagent',
      description:
        'Delegate a bounded one-off task to a temporary Subagent with its own context; it does not appear in the task list. A lengthy one-off task still belongs here. Use a task Thread for ongoing work needing follow-ups or continued user conversation. Supply a self-contained task with relevant context, constraints, paths, environment needs, deliverable and completion checks. Prefer background for lengthy or independent work. Use foreground when the next step needs the result immediately; it waits and returns the terminal result. Background returns accepted, which is not completion. Its terminal result is persisted and injected automatically, with a root Run scheduled if needed. After acceptance, continue other work or finish this turn after stating that the task is still running. Do not use subagent_status or wait_ms to keep a Run alive or collect the result.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['task', 'mode'],
        properties: {
          task: { type: 'string', minLength: 1, maxLength: 100_000 },
          mode: { type: 'string', enum: ['foreground', 'background'] },
          allowed_env: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 },
        },
      },
      concurrent: true,
      validate: (value) => subagentInputSchema.parse(value),
      execute: async (input, { signal, call }) => {
        signal.throwIfAborted();
        if (
          input.mode === 'background' &&
          (depth !== 0 || parent.agentId !== 'thread' || parent.parentRunId !== null)
        ) {
          throw new SessionError(
            'permission_denied',
            'Only a persistent Thread root Agent can create a background Subagent.',
          );
        }
        if (createdChildren >= (this.#options.maxChildrenPerRun ?? 2)) {
          throw new Error('The maximum number of Subagents for this Run has been reached.');
        }
        createdChildren += 1;
        const environmentPolicy = environmentPolicyInput(input, (envIds) =>
          this.#environmentRuntime.resolveEnvironmentIds(parent.ownerId, envIds),
        );
        const requestedAgentId = `subagent-${this.#createId()}`;
        let interaction: InteractionRecord | undefined;
        if (parent.agentId === 'thread') {
          interaction = this.store.createSubagentInteraction({
            ownerId: parent.ownerId,
            sourceThreadId: parent.threadId,
            sourceAgentId: parent.agentId,
            sourceRunId: parent.runId,
            sourceToolCallId: call.id,
            targetAgentId: requestedAgentId,
            prompt: input.task,
            executionMode: input.mode,
            ...(environmentPolicy ? { environmentPolicy } : {}),
          });
        }
        const child = interaction?.acceptedRunId
          ? this.store.getRunById(interaction.acceptedRunId)
          : this.store.createChildRun(
              parent.ownerId,
              parent.runId,
              interaction?.targetAgentId ?? requestedAgentId,
              input.mode,
              environmentPolicy,
            );
        if (input.mode === 'background') {
          if (!interaction)
            throw new SessionError('internal', 'Background interaction is missing.');
          this.#scheduleSubagent(child, interaction);
          return {
            content: JSON.stringify({
              tool_call_id: call.id,
              status: 'accepted',
              automatic_delivery: true,
              next_step: BACKGROUND_ACCEPTED_NEXT_STEP,
            }),
          };
        }

        try {
          this.#environmentRuntime.reserveRun(child);
        } catch (cause) {
          this.#rejectBeforeScheduling(child, cause, interaction ?? undefined, input.task);
        }
        const childActive = this.#activeExecution(child, interaction ?? null);
        if (!isTerminal(this.store.getRunById(child.runId).status))
          this.#startExecution(childActive, false, depth + 1, signal, input.task);
        await childActive.promise;
        const childRun = this.store.getRunById(child.runId);
        const currentInteraction = interaction
          ? this.store.getInteraction(parent.ownerId, interaction)
          : undefined;
        const interactionResponse = currentInteraction
          ? this.store.getInteractionResponse(parent.ownerId, currentInteraction)
          : undefined;
        const finalMessage = interactionResponse
          ? undefined
          : this.store
              .listContext(child.ownerId, child.threadId, child.agentId)
              .findLast((message) => message.message.role === 'assistant');
        const response =
          interactionResponse?.message.role === 'assistant'
            ? interactionResponse.message.content
            : finalMessage?.message.role === 'assistant'
              ? finalMessage.message.content
              : '';
        const status = currentInteraction?.status ?? childRun.status;
        return {
          content: JSON.stringify({
            ...(currentInteraction ? { tool_call_id: currentInteraction.sourceToolCallId } : {}),
            status,
            result: response,
            usage: {
              input_tokens: childRun.usage.inputTokens,
              output_tokens: childRun.usage.outputTokens,
              total_tokens: childRun.usage.inputTokens + childRun.usage.outputTokens,
            },
            ...(currentInteraction?.error || childRun.error
              ? { error: (currentInteraction?.error ?? childRun.error)?.message }
              : {}),
          }),
          status: status === 'completed' ? 'success' : 'error',
        };
      },
    };
  }

  #runError(error: unknown): RunError {
    let current = error;
    const seen = new Set<unknown>();
    while (!seen.has(current)) {
      seen.add(current);
      if (current instanceof HardCutError) {
        if (current.code === 'request_conflict') {
          return { code: 'action_conflict', message: current.message, retryable: false };
        }
        if (current.code === 'storage_failed') {
          return { code: 'internal', message: current.message, retryable: true };
        }
        return { code: 'recap_invalid', message: current.message, retryable: true };
      }
      if (current instanceof SessionError) {
        return { code: current.code, message: current.message, retryable: current.retryable };
      }
      if (current instanceof Error && 'code' in current) {
        if (current.code === 'operation_unknown') {
          return { code: 'operation_unknown', message: current.message, retryable: true };
        }
        if (current.code === 'stream_interrupted') {
          return { code: 'operation_unknown', message: current.message, retryable: true };
        }
        if (current.code === 'persistence_failed') {
          return { code: 'internal', message: current.message, retryable: true };
        }
        if (current.code === 'step_limit') {
          return { code: 'failed_precondition', message: current.message, retryable: false };
        }
        if (current.code === 'request_too_large') {
          return { code: 'input_too_large', message: current.message, retryable: false };
        }
      }
      current = current instanceof Error ? current.cause : undefined;
    }
    return {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    };
  }
}

function toolAttachmentIds(message: ModelMessage): string[] {
  if (message.role !== 'tool' || message.content_parts === undefined) return [];
  return message.content_parts.map((part) => {
    if (part.type !== 'attachment') {
      throw new SessionError(
        'invalid_argument',
        'Tool result content parts must reference stored attachments.',
      );
    }
    return part.attachment_id;
  });
}

function withoutToolContentParts(message: ModelMessage): ModelMessage {
  if (message.role !== 'tool' || message.content_parts === undefined) return message;
  const stored = { ...message };
  delete stored.content_parts;
  return stored;
}

function inputModelContent(input: InputRecord): Omit<UserMessage, 'role'> {
  const automation = input.automation;
  const content = automation
    ? `Kairos Automation trigger; trigger=${automation.trigger}; schedule_id=${automation.scheduleId}; fire_id=${automation.fireId}; scheduled_at=${automation.scheduledAt}.\nThe configured Automation prompt follows; it is not a new human instruction:\n\n${input.text}`
    : input.text;
  return {
    content,
    ...((input.attachments?.length ?? 0) > 0
      ? {
          content_parts: (input.attachments ?? []).map((attachment) => ({
            type: 'attachment' as const,
            attachment_id: attachment.attachmentId,
          })),
        }
      : {}),
  };
}

function delegationMapKey(key: DelegationKey): string {
  return JSON.stringify([key.sourceThreadId, key.sourceAgentId, key.sourceToolCallId]);
}

function parseDelegationMapKey(value: string): DelegationKey {
  const [sourceThreadId, sourceAgentId, sourceToolCallId] = z
    .tuple([z.string(), z.string(), z.string()])
    .parse(JSON.parse(value));
  return { sourceThreadId, sourceAgentId, sourceToolCallId };
}

function isTerminal(status: RunRecord['status']): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
}
