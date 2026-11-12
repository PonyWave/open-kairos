import type { ActionHandlers } from './action-handlers.js';
import type { ActionKind, ClientActionRecord, ClientActionStore } from './actions.js';
import { type ActionFailureOutcome, classifyActionFailure, formatClientError } from './errors.js';

export interface ActionFailure {
  key: string;
  kind: ActionKind;
  message: string;
  outcome: ActionFailureOutcome;
  restored: boolean;
}

export interface ActionExecutorState {
  busy: boolean;
  failures: readonly ActionFailure[];
}

type Listener = (state: ActionExecutorState) => void;
export type ActionCompletion = (
  record: ClientActionRecord,
  result: unknown,
) => void | Promise<void>;

export class ActionExecutor {
  private readonly inFlight = new Map<
    string,
    { generation: number; controller: AbortController; promise: Promise<unknown> }
  >();
  private readonly failures = new Map<string, ActionFailure>();
  private readonly listeners = new Set<Listener>();
  private pendingCount = 0;
  private generation = 0;

  constructor(
    private store: ClientActionStore,
    private readonly handlers: ActionHandlers,
    private readonly complete?: ActionCompletion,
  ) {
    this.restoreFailures();
  }

  get state(): ActionExecutorState {
    return { busy: this.pendingCount > 0, failures: [...this.failures.values()] };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  activate(store: ClientActionStore): void {
    if (store === this.store) return;
    ++this.generation;
    for (const operation of this.inFlight.values()) operation.controller.abort();
    this.inFlight.clear();
    this.pendingCount = 0;
    this.store = store;
    this.failures.clear();
    this.restoreFailures();
    this.emit();
  }

  async execute<T>(key: string, kind: ActionKind, payload: unknown): Promise<T | undefined> {
    const store = this.store;
    const generation = this.generation;
    let record: ClientActionRecord;
    try {
      record = store.begin(key, kind, payload);
    } catch (cause) {
      this.setFailure(key, kind, cause, false, undefined, generation);
      return undefined;
    }
    return this.start<T>(record, store, generation);
  }

  async retry<T>(key: string): Promise<T | undefined> {
    const record = this.store.get(key);
    if (!record) {
      this.failures.delete(key);
      this.emit();
      return undefined;
    }
    return this.start<T>(record, this.store, this.generation);
  }

  dismiss(key: string): void {
    this.failures.delete(key);
    this.emit();
  }

  private start<T>(
    record: ClientActionRecord,
    store: ClientActionStore,
    generation: number,
  ): Promise<T | undefined> {
    const existing = this.inFlight.get(record.key);
    if (existing?.generation === generation) return existing.promise as Promise<T | undefined>;
    const controller = new AbortController();
    const { promise, resolve, reject } = Promise.withResolvers<T | undefined>();
    this.inFlight.set(record.key, { generation, controller, promise });
    void this.perform<T>(record, store, generation, controller).then(resolve, reject);
    return promise;
  }

  private async perform<T>(
    record: ClientActionRecord,
    store: ClientActionStore,
    generation: number,
    controller: AbortController,
  ): Promise<T | undefined> {
    if (generation !== this.generation) return undefined;
    this.pendingCount += 1;
    this.failures.delete(record.key);
    this.emit();
    try {
      let result: unknown;
      try {
        result = await this.handlers[record.kind](record.payload, record.id, controller.signal);
      } catch (cause) {
        if (generation === this.generation) {
          this.handleRequestFailure(record, cause, store, generation);
        }
        return undefined;
      }
      if (generation !== this.generation) return undefined;
      try {
        await this.complete?.(record, result);
        if (generation !== this.generation) return undefined;
        store.succeed(record.key, record.id);
        this.failures.delete(record.key);
        return result as T;
      } catch (cause) {
        if (generation === this.generation) {
          this.setFailure(record.key, record.kind, cause, false, 'unknown', generation);
        }
        return undefined;
      }
    } finally {
      if (generation === this.generation) {
        this.pendingCount -= 1;
        this.inFlight.delete(record.key);
        this.emit();
      }
    }
  }

  private handleRequestFailure(
    record: ClientActionRecord,
    cause: unknown,
    store: ClientActionStore,
    generation: number,
  ): void {
    const outcome = classifyActionFailure(cause);
    if (outcome !== 'unknown') {
      try {
        store.fail(record.key, record.id);
      } catch (cleanupCause) {
        const message = `${formatClientError(cause)} 本地操作记录清理失败：${formatClientError(cleanupCause)}`;
        this.setFailure(record.key, record.kind, new Error(message), false, 'unknown', generation);
        return;
      }
    }
    this.setFailure(record.key, record.kind, cause, false, outcome, generation);
  }

  private setFailure(
    key: string,
    kind: ActionKind,
    cause: unknown,
    restored: boolean,
    outcome: ActionFailureOutcome | undefined,
    generation: number,
  ): void {
    if (generation !== this.generation) return;
    this.failures.set(key, {
      key,
      kind,
      message: formatClientError(cause),
      outcome: outcome ?? classifyActionFailure(cause),
      restored,
    });
    this.emit();
  }

  private restoreFailures(): void {
    for (const record of this.store.pending()) {
      this.failures.set(record.key, {
        key: record.key,
        kind: record.kind,
        message: `操作 ${record.key} 在上次会话中尚未确认，可沿用原编号重试。`,
        outcome: 'unknown',
        restored: true,
      });
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
