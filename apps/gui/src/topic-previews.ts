import type { Thread, ThreadCardCursor } from '@kairos/contracts';
import { formatClientError } from './errors.js';
import type { ThreadPreviewGateway, TopicSort } from './thread-preview-gateway.js';
import type { TopicCardView } from './thread-view.js';

export interface TopicPreviewState {
  recent: readonly TopicCardView[];
  cards: readonly TopicCardView[];
  sort: TopicSort;
  cursor: ThreadCardCursor | null;
  hasMore: boolean;
  recentLoading: boolean;
  loading: boolean;
  error: string | null;
  recentError: string | null;
}

const initialState: TopicPreviewState = {
  recent: [],
  cards: [],
  sort: 'lastMessageAt',
  cursor: null,
  hasMore: false,
  recentLoading: false,
  loading: false,
  error: null,
  recentError: null,
};

export class TopicPreviewStore {
  private current: TopicPreviewState = initialState;
  private listener: ((state: TopicPreviewState) => void) | undefined;
  private listGeneration = 0;
  private recentGeneration = 0;
  private directoryOpen = false;
  private listController: AbortController | null = null;
  private recentController: AbortController | null = null;

  constructor(private readonly gateway: ThreadPreviewGateway) {}

  get state(): TopicPreviewState {
    return { ...this.current, recent: [...this.current.recent], cards: [...this.current.cards] };
  }

  subscribe(listener: (state: TopicPreviewState) => void): () => void {
    this.listener = listener;
    listener(this.state);
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  async loadRecent(): Promise<void> {
    this.recentController?.abort();
    const controller = new AbortController();
    this.recentController = controller;
    const generation = ++this.recentGeneration;
    this.patch({ recentLoading: true, recentError: null });
    try {
      const page = await this.gateway.listCards(
        { limit: 4, sort: 'lastMessageAt', cursor: null },
        controller.signal,
      );
      if (generation !== this.recentGeneration) return;
      this.patch({ recent: page.cards, recentLoading: false });
    } catch (cause) {
      if (generation !== this.recentGeneration) return;
      this.patch({ recentLoading: false, recentError: formatClientError(cause) });
    } finally {
      if (this.recentController === controller) this.recentController = null;
    }
  }

  async openDirectory(): Promise<void> {
    this.directoryOpen = true;
    await this.loadFirstPage();
  }

  closeDirectory(): void {
    this.directoryOpen = false;
    this.listController?.abort();
    this.listController = null;
    ++this.listGeneration;
  }

  async setSort(sort: TopicSort): Promise<void> {
    if (sort === this.current.sort && this.current.cards.length > 0) return;
    this.patch({ sort, cards: [], cursor: null, hasMore: false });
    await this.loadFirstPage();
  }

  async loadMore(): Promise<void> {
    if (this.current.loading || !this.current.hasMore || this.current.cursor === null) return;
    await this.loadPage(this.current.cursor, true, this.listGeneration);
  }

  async invalidate(): Promise<void> {
    const requests: Promise<void>[] = [this.loadRecent()];
    if (this.directoryOpen) requests.push(this.loadFirstPage());
    await Promise.all(requests);
  }

  upsertThread(thread: Thread): void {
    const update = (card: TopicCardView) =>
      card.thread.threadId === thread.threadId ? { ...card, thread } : card;
    this.patch({
      recent: this.current.recent.map(update),
      cards: this.current.cards.map(update),
    });
  }

  reset(): void {
    this.stop();
    this.current = initialState;
    this.emit();
  }

  stop(): void {
    this.directoryOpen = false;
    ++this.listGeneration;
    ++this.recentGeneration;
    this.listController?.abort();
    this.recentController?.abort();
    this.listController = null;
    this.recentController = null;
  }

  private async loadFirstPage(): Promise<void> {
    const generation = ++this.listGeneration;
    await this.loadPage(null, false, generation);
  }

  private async loadPage(
    cursor: ThreadCardCursor | null,
    append: boolean,
    generation: number,
  ): Promise<void> {
    this.listController?.abort();
    const controller = new AbortController();
    this.listController = controller;
    this.patch({ loading: true, error: null });
    try {
      const page = await this.gateway.listCards(
        { limit: 50, sort: this.current.sort, cursor },
        controller.signal,
      );
      if (generation !== this.listGeneration) return;
      const cards = append ? mergeCards(this.current.cards, page.cards) : page.cards;
      this.patch({
        cards,
        cursor: page.nextCursor,
        hasMore: page.hasMore,
        loading: false,
      });
    } catch (cause) {
      if (generation !== this.listGeneration) return;
      this.patch({ loading: false, error: formatClientError(cause) });
    } finally {
      if (this.listController === controller) this.listController = null;
    }
  }

  private patch(patch: Partial<TopicPreviewState>): void {
    this.current = { ...this.current, ...patch };
    this.emit();
  }

  private emit(): void {
    this.listener?.(this.state);
  }
}

export function mergeCards(
  current: readonly TopicCardView[],
  incoming: readonly TopicCardView[],
): TopicCardView[] {
  const cards = new Map(current.map((card) => [card.thread.threadId, card]));
  for (const card of incoming) cards.set(card.thread.threadId, card);
  return [...cards.values()];
}
