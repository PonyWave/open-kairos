import type { Thread } from '@kairos/contracts';
import { useEffect, useMemo, useState } from 'react';
import type { KairosClients } from './client.js';
import { formatClientError } from './errors.js';
import { createThreadPreviewGateway } from './thread-preview-gateway.js';
import type { TopicCardView } from './thread-view.js';
import type { WorkspaceGroup } from './use-workspaces.js';

const threadIdChunkSize = 100;

export function useWorkspaceCards(
  clients: KairosClients,
  enabled: boolean,
  groups: readonly WorkspaceGroup[],
  temporary: readonly Thread[],
) {
  const gateway = useMemo(() => createThreadPreviewGateway(clients), [clients]);
  const [state, setState] = useState<{ cards: readonly TopicCardView[]; error: string | null }>({
    cards: [],
    error: null,
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    void revision;
    const ids: string[] = [];
    for (const group of groups) {
      if (group.mainThread) ids.push(group.mainThread.threadId);
      for (const task of group.tasks) ids.push(task.threadId);
    }
    for (const thread of temporary) ids.push(thread.threadId);
    if (!enabled || ids.length === 0) {
      setState({ cards: [], error: null });
      return;
    }
    const controller = new AbortController();
    const chunks: string[][] = [];
    for (let start = 0; start < ids.length; start += threadIdChunkSize) {
      chunks.push(ids.slice(start, start + threadIdChunkSize));
    }
    void Promise.all(
      chunks.map((threadIds) =>
        gateway.listCards(
          { limit: threadIds.length, sort: 'lastMessageAt', cursor: null, threadIds },
          controller.signal,
        ),
      ),
    ).then(
      (pages) => {
        if (controller.signal.aborted) return;
        setState({ cards: pages.flatMap((page) => page.cards), error: null });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({ cards: [], error: formatClientError(cause) });
      },
    );
    return () => controller.abort();
  }, [enabled, gateway, groups, temporary, revision]);
  return {
    cards: state.cards,
    error: state.error,
    reload: () => setRevision((value) => value + 1),
  };
}
