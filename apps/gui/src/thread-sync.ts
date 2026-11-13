import type { ThreadSnapshotCursor } from '@kairos/contracts';
import type { KairosClients } from './client.js';
import { formatClientError, isExpiredCursorError } from './errors.js';
import {
  EventGapError,
  type ThreadProjectionState,
  ThreadProjector,
  UnsupportedEventError,
} from './thread-projection.js';

export type ThreadConnectionStatus = 'idle' | 'loading' | 'live' | 'reconnecting' | 'error';

export interface ThreadSyncState extends ThreadProjectionState {
  status: ThreadConnectionStatus;
  error: string | null;
}

interface ThreadSynchronizerOptions {
  clients: Pick<KairosClients, 'thread' | 'events' | 'automations'>;
  automationScheduleId?: string | undefined;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  onChange?: (state: ThreadSyncState) => void;
}

export class ThreadSynchronizer {
  private projector: ThreadProjector | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private status: ThreadConnectionStatus = 'idle';
  private error: string | null = null;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private initialRefresh: Promise<void> | null = null;

  constructor(private readonly options: ThreadSynchronizerOptions) {
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 8000;
  }

  get state(): ThreadSyncState {
    return {
      ...(this.projector?.state ?? {
        snapshot: null,
        throughSeq: 0n,
        transientResponses: [],
        toolProgress: new Map(),
        bashOperations: [],
        hardCuts: [],
        invalidatedRecaps: {},
      }),
      status: this.status,
      error: this.error,
    };
  }

  start(threadId: string): void {
    this.restart(new ThreadProjector(threadId));
  }

  stop(): void {
    ++this.generation;
    this.controller?.abort();
    this.controller = null;
    this.initialRefresh = null;
  }

  async reload(): Promise<void> {
    const projector = this.projector;
    if (!projector) return;
    this.restart(projector);
    await this.initialRefresh;
  }

  private restart(projector: ThreadProjector): void {
    this.stop();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.projector = projector;
    projector.clearTransient();
    this.setStatus('loading', null);
    this.initialRefresh = this.bootstrap(generation, controller.signal);
  }

  private async bootstrap(generation: number, signal: AbortSignal): Promise<void> {
    const projector = this.projector;
    if (!projector) return;
    try {
      await this.refresh(projector, generation, signal);
    } catch (error) {
      if (signal.aborted || generation !== this.generation) return;
      this.setStatus('error', formatClientError(error));
      return;
    }
    void this.watch(projector, generation, signal).catch((error: unknown) => {
      if (signal.aborted || generation !== this.generation) return;
      this.setStatus('error', formatClientError(error));
    });
  }

  private async refresh(
    projector: ThreadProjector,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const staged = new ThreadProjector(projector.threadId);
    let cursor: ThreadSnapshotCursor | undefined;
    let throughSeq: bigint | undefined;
    do {
      const scheduleId = this.options.automationScheduleId;
      const response = scheduleId
        ? await this.options.clients.automations.getAutomationThread(
            {
              scheduleId,
              threadId: projector.threadId,
              limit: 100,
              ...(cursor ? { cursor } : {}),
            },
            { signal },
          )
        : await this.options.clients.thread.getThread(
            { threadId: projector.threadId, limit: 100, ...(cursor ? { cursor } : {}) },
            { signal },
          );
      if (generation !== this.generation || signal.aborted) return;
      if (!response.snapshot) throw new Error('Server 未返回会话快照。');
      if (throughSeq !== undefined && response.throughSeq !== throughSeq) {
        throw new Error('Server 返回了事件序号不一致的分页快照。');
      }
      if (response.throughSeq < projector.state.throughSeq) return;
      if (response.hasMore !== (response.nextCursor !== undefined)) {
        throw new Error('Server 返回了无效的分页位置。');
      }
      staged.applySnapshotPage(response.snapshot, response.throughSeq);
      throughSeq = response.throughSeq;
      cursor = response.nextCursor;
    } while (cursor !== undefined);

    const snapshot = staged.state.snapshot;
    if (!snapshot || throughSeq === undefined) throw new Error('Server 未返回完整会话快照。');
    if (generation !== this.generation || signal.aborted) return;
    if (throughSeq < projector.state.throughSeq) return;
    projector.applySnapshot(snapshot, throughSeq);
    this.emit();
  }

  private async watch(
    projector: ThreadProjector,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    let delay = this.retryDelayMs;
    while (!signal.aborted && generation === this.generation) {
      projector.clearTransient();
      this.setStatus(delay === this.retryDelayMs ? 'live' : 'reconnecting', null);
      try {
        const stream = this.options.clients.events.watchThread(
          {
            threadId: projector.threadId,
            afterSeq: projector.state.throughSeq,
            ...(this.options.automationScheduleId
              ? { scheduleId: this.options.automationScheduleId }
              : {}),
          },
          { signal },
        );
        for await (const response of stream) {
          if (generation !== this.generation || signal.aborted) return;
          this.setStatus('live', null);
          const viewEventSeq = contextViewChangedSequence(response);
          if (viewEventSeq !== undefined && viewEventSeq > projector.state.throughSeq) {
            await this.refresh(projector, generation, signal);
            if (generation !== this.generation || signal.aborted) return;
            if (projector.state.throughSeq < viewEventSeq) {
              throw new EventGapError('视图快照尚未覆盖对应的持久事件。');
            }
          }
          projector.applyWatchResponse(response);
          delay = this.retryDelayMs;
          this.emit();
        }
        if (!signal.aborted) throw new Error('事件流已由 Server 结束。');
      } catch (error) {
        if (signal.aborted || generation !== this.generation) return;
        projector.clearTransient();
        if (error instanceof UnsupportedEventError) {
          this.setStatus('error', formatClientError(error));
          return;
        }
        if (isExpiredCursorError(error) || error instanceof EventGapError) {
          this.setStatus('reconnecting', '正在通过新快照恢复事件位置。');
          await this.refresh(projector, generation, signal);
          continue;
        }
        this.setStatus('reconnecting', formatClientError(error));
      }
      await wait(delay, signal);
      delay = Math.min(delay * 2, this.maxRetryDelayMs);
    }
  }

  private setStatus(status: ThreadConnectionStatus, error: string | null): void {
    this.status = status;
    this.error = error;
    this.emit();
  }

  private emit(): void {
    this.options.onChange?.(this.state);
  }
}

function contextViewChangedSequence(
  response: Parameters<ThreadProjector['applyWatchResponse']>[0],
): bigint | undefined {
  if (
    response.payload.case !== 'event' ||
    response.payload.value.payload.case !== 'contextViewChanged'
  ) {
    return undefined;
  }
  return response.payload.value.seq;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
