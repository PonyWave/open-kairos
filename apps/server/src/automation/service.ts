import type { InputRecord } from '../sessions/records.js';
import type { SessionStore } from '../sessions/store.js';
import { AutomationStore, type AutomationStoreOptions } from './store.js';
import type {
  AutomationFireRecord,
  AutomationRecord,
  CreateAutomationInput,
  UpdateAutomationInput,
} from './types.js';

export interface AutomationServiceOptions extends AutomationStoreOptions {
  deliver(input: InputRecord, runId: string): Promise<string>;
  onError?: ((error: unknown) => void) | undefined;
}

export class AutomationService {
  readonly store: AutomationStore;
  readonly #sessions: SessionStore;
  readonly #options: AutomationServiceOptions;
  readonly #watchers = new Map<string, () => void>();
  #timer: NodeJS.Timeout | undefined;
  #work: Promise<void> = Promise.resolve();
  #started = false;
  #closing = false;

  constructor(sessions: SessionStore, options: AutomationServiceOptions) {
    this.#sessions = sessions;
    this.#options = options;
    this.store = new AutomationStore(sessions, options);
  }

  start(): void {
    if (this.#started || this.#closing) return;
    this.#started = true;
    for (const fire of this.store.listActiveFires()) this.#watch(fire);
    this.#requestTick();
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#started = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#work;
    for (const unsubscribe of this.#watchers.values()) unsubscribe();
    this.#watchers.clear();
  }

  getThread(ownerId: string, threadId: string) {
    return this.#sessions.getThread(ownerId, threadId);
  }

  create(input: CreateAutomationInput): AutomationRecord {
    const automation = this.store.create(input);
    this.#changed();
    return automation;
  }

  update(input: UpdateAutomationInput): AutomationRecord {
    const automation = this.store.update(input);
    this.#changed();
    return automation;
  }

  delete(input: {
    ownerId: string;
    clientActionId: string;
    scheduleId: string;
    expectedVersion: bigint;
  }): { scheduleId: string; deleted: true } {
    const result = this.store.delete(input);
    this.#changed();
    return result;
  }

  runNow(input: {
    ownerId: string;
    clientActionId: string;
    scheduleId: string;
  }): Promise<AutomationFireRecord> {
    return this.#enqueue(async () => {
      try {
        const fire = this.store.runNow(input);
        this.#watch(fire);
        if (fire.status === 'queued') await this.#deliver(fire);
        return fire;
      } finally {
        this.#arm();
      }
    });
  }

  runDue(): Promise<void> {
    return this.#enqueue(() => this.#runDue());
  }

  #runDue(): Promise<void> {
    return (async () => {
      try {
        if (this.#closing) return;
        const active = this.store.listActiveFires();
        for (const current of active) {
          try {
            const fire = this.store.reconcileFire(current.fireId);
            this.#watch(fire);
            if (fire.status === 'queued') await this.#deliverSafely(fire);
          } catch (error) {
            this.#options.onError?.(error);
          }
        }
        const now = this.#options.clock?.() ?? new Date();
        for (const automation of this.store.listDueAutomations(now.toISOString())) {
          if (this.#closing) return;
          try {
            const fire = this.store.acceptScheduled(automation.scheduleId);
            if (!fire) continue;
            this.#watch(fire);
            if (fire.status === 'queued') await this.#deliverSafely(fire);
          } catch (error) {
            this.#options.onError?.(error);
          }
        }
      } finally {
        this.#arm();
      }
    })();
  }

  async #deliver(fire: AutomationFireRecord): Promise<void> {
    if (fire.inputId === null || fire.acceptedRunId === null) return;
    const input = this.#sessions.getInput(fire.ownerId, fire.inputId);
    if (input.status !== 'queued') {
      this.store.reconcileFire(fire.fireId);
      return;
    }
    const deliveredRunId = await this.#options.deliver(input, fire.acceptedRunId);
    this.store.recordAcceptedRun(fire.fireId, deliveredRunId);
    const current = this.store.reconcileFire(fire.fireId);
    if (isTerminal(current.status)) this.#unwatch(current.fireId);
  }

  async #deliverSafely(fire: AutomationFireRecord): Promise<void> {
    try {
      await this.#deliver(fire);
    } catch (error) {
      this.#options.onError?.(error);
    }
  }

  #watch(fire: AutomationFireRecord): void {
    if (isTerminal(fire.status) || fire.targetThreadId === null) {
      this.#unwatch(fire.fireId);
      return;
    }
    if (this.#watchers.has(fire.fireId)) return;
    const unsubscribe = this.#sessions.subscribe(fire.targetThreadId, () => {
      void this.#enqueue(() => {
        const current = this.store.reconcileFire(fire.fireId);
        if (isTerminal(current.status)) {
          this.#unwatch(current.fireId);
          if (this.#started) this.#requestTick();
        }
      }).catch(() => undefined);
    });
    this.#watchers.set(fire.fireId, unsubscribe);
  }

  #unwatch(fireId: string): void {
    this.#watchers.get(fireId)?.();
    this.#watchers.delete(fireId);
  }

  #changed(): void {
    if (this.#started) this.#requestTick();
    else this.#arm();
  }

  #requestTick(): void {
    if (!this.#started || this.#closing) return;
    void this.runDue().catch((error) => this.#options.onError?.(error));
  }

  #arm(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#started || this.#closing) return;
    const next = this.store.nextDueAt();
    const hasActiveFire = this.store.listActiveFires().length > 0;
    if (next === null && !hasActiveFire) return;
    const now = (this.#options.clock?.() ?? new Date()).getTime();
    const dueDelay = next === null ? Number.POSITIVE_INFINITY : Math.max(Date.parse(next) - now, 0);
    const delay = hasActiveFire ? 1000 : Math.min(dueDelay, 2_147_483_647);
    this.#timer = setTimeout(() => this.#requestTick(), delay);
    this.#timer.unref();
  }

  #enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.#work.then(work);
    this.#work = result.then(
      () => undefined,
      (error) => {
        this.#options.onError?.(error);
      },
    );
    return result;
  }
}

function isTerminal(status: AutomationFireRecord['status']): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
}
