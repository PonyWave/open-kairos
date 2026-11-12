import { type Automation, type AutomationFire, type Thread, ThreadType } from '@kairos/contracts';
import { requireAutomation, requireAutomationFire } from './automation-model.js';
import type { KairosClients } from './client.js';
import { formatClientError } from './errors.js';

export interface AutomationPage {
  automations: Automation[];
  nextSeq: bigint | null;
  hasMore: boolean;
}

export interface AutomationFirePage {
  fires: AutomationFire[];
  nextSeq: bigint | null;
  hasMore: boolean;
}

export async function getAutomation(
  clients: Pick<KairosClients, 'automations'>,
  scheduleId: string,
  signal?: AbortSignal,
): Promise<Automation> {
  const response = await clients.automations.getAutomation(
    { scheduleId },
    signal === undefined ? {} : { signal },
  );
  return requireAutomation(response.automation);
}

export async function listAutomations(
  clients: Pick<KairosClients, 'automations'>,
  afterSeq = 0n,
  limit = 50,
  signal?: AbortSignal,
): Promise<AutomationPage> {
  const response = await clients.automations.listAutomations(
    { afterSeq, limit },
    signal === undefined ? {} : { signal },
  );
  if (response.hasMore !== (response.nextSeq !== undefined)) {
    throw new Error('ListAutomations 返回了无效的分页位置。');
  }
  const automations = response.automations.map((automation) => requireAutomation(automation));
  const nextSeq = response.nextSeq ?? null;
  if (nextSeq !== null && nextSeq <= afterSeq) {
    throw new Error('ListAutomations 分页没有前进。');
  }
  return { automations, nextSeq, hasMore: response.hasMore };
}

export async function listAutomationFires(
  clients: Pick<KairosClients, 'automations'>,
  scheduleId: string,
  afterSeq = 0n,
  limit = 50,
  signal?: AbortSignal,
): Promise<AutomationFirePage> {
  const response = await clients.automations.listAutomationFires(
    { scheduleId, afterSeq, limit },
    signal === undefined ? {} : { signal },
  );
  if (response.hasMore !== (response.nextSeq !== undefined)) {
    throw new Error('ListAutomationFires 返回了无效的分页位置。');
  }
  const fires = response.fires.map((fire) => {
    const value = requireAutomationFire(fire);
    if (value.scheduleId !== scheduleId) {
      throw new Error('ListAutomationFires 返回了其他定时任务的执行记录。');
    }
    return value;
  });
  const nextSeq = response.nextSeq ?? null;
  if (nextSeq !== null && nextSeq <= afterSeq) {
    throw new Error('ListAutomationFires 分页没有前进。');
  }
  return { fires, nextSeq, hasMore: response.hasMore };
}

export async function listOrdinaryThreads(
  clients: Pick<KairosClients, 'thread'>,
  signal?: AbortSignal,
): Promise<Thread[]> {
  const threads: Thread[] = [];
  const seen = new Set<string>();
  let afterSeq: bigint | null = 0n;
  while (afterSeq !== null) {
    const requestSeq = afterSeq;
    const response = await clients.thread.listThreads(
      { afterSeq: requestSeq, limit: 100 },
      signal === undefined ? {} : { signal },
    );
    if (response.hasMore !== (response.nextSeq !== undefined)) {
      throw new Error('ListThreads 返回了无效的分页位置。');
    }
    for (const thread of response.threads) {
      if (
        thread.threadType !== ThreadType.TASK ||
        thread.automationOnly ||
        !thread.threadId ||
        seen.has(thread.threadId)
      ) {
        continue;
      }
      seen.add(thread.threadId);
      threads.push(thread);
    }
    if (response.nextSeq !== undefined && response.nextSeq <= requestSeq) {
      throw new Error('ListThreads 分页没有前进。');
    }
    afterSeq = response.nextSeq ?? null;
  }
  return threads;
}

export interface AutomationListState {
  automations: Automation[];
  nextSeq: bigint | null;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
}

export class AutomationListController {
  private current: AutomationListState = {
    automations: [],
    nextSeq: null,
    hasMore: false,
    loading: true,
    error: null,
  };
  private readonly listeners = new Set<(state: AutomationListState) => void>();
  private generation = 0;
  private controller: AbortController | null = null;

  constructor(private readonly clients: Pick<KairosClients, 'automations'>) {}

  readonly snapshot = (): AutomationListState => this.current;

  readonly subscribe = (listener: (state: AutomationListState) => void): (() => void) => {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  };

  stop(): void {
    ++this.generation;
    this.controller?.abort();
    this.controller = null;
  }

  async load(append = false): Promise<void> {
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const afterSeq = append ? (this.current.nextSeq ?? 0n) : 0n;
    this.patch({ loading: true, error: null });
    try {
      const page = await listAutomations(this.clients, afterSeq, 50, controller.signal);
      if (generation !== this.generation) return;
      this.current = {
        automations: append
          ? mergeAutomations(this.current.automations, page.automations)
          : page.automations,
        nextSeq: page.nextSeq,
        hasMore: page.hasMore,
        loading: false,
        error: null,
      };
      this.emit();
    } catch (cause) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.patch({ loading: false, error: formatClientError(cause) });
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  private patch(patch: Partial<AutomationListState>): void {
    this.current = { ...this.current, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current);
  }
}

function mergeAutomations(current: Automation[], incoming: Automation[]): Automation[] {
  const values = new Map(current.map((automation) => [automation.scheduleId, automation]));
  for (const automation of incoming) values.set(automation.scheduleId, automation);
  return [...values.values()].sort((left, right) =>
    left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0,
  );
}
