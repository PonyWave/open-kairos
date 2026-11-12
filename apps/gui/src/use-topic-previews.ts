import { useEffect, useMemo, useState } from 'react';
import type { KairosClients } from './client.js';
import { createThreadPreviewGateway, type TopicSort } from './thread-preview-gateway.js';
import { type TopicPreviewState, TopicPreviewStore } from './topic-previews.js';

export function useTopicPreviews(clients: KairosClients, enabled: boolean) {
  const store = useMemo(
    () => new TopicPreviewStore(createThreadPreviewGateway(clients)),
    [clients],
  );
  const [state, setState] = useState<TopicPreviewState>(store.state);

  useEffect(() => {
    const unsubscribe = store.subscribe(setState);
    if (enabled) void store.loadRecent();
    else store.reset();
    return () => {
      unsubscribe();
      store.stop();
    };
  }, [enabled, store]);

  const operations = useMemo(
    () => ({
      openDirectory: () => store.openDirectory(),
      closeDirectory: () => store.closeDirectory(),
      setSort: (sort: TopicSort) => store.setSort(sort),
      loadMore: () => store.loadMore(),
      invalidate: () => store.invalidate(),
      upsertThread: (thread: Parameters<TopicPreviewStore['upsertThread']>[0]) =>
        store.upsertThread(thread),
    }),
    [store],
  );

  return { state, ...operations };
}
