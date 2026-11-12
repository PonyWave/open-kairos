import { type DelegationReference, type Message, MessageRole } from '@kairos/contracts';
import { useEffect, useMemo, useState } from 'react';
import type { KairosClients } from './client.js';
import { delegationForToolCall, delegationKey } from './delegation.js';
import { formatClientError } from './errors.js';
import { createThreadPreviewGateway } from './thread-preview-gateway.js';
import { isDelegationTool, type ThreadCallView } from './thread-view.js';

export function visibleDelegationCalls(messages: readonly Message[]): DelegationReference[] {
  const calls = new Map<string, DelegationReference>();
  for (const message of messages) {
    if (message.supersededByRunId || message.role !== MessageRole.ASSISTANT) continue;
    for (const call of message.toolCalls) {
      if (!isDelegationTool(call)) continue;
      const reference = delegationForToolCall(message, call);
      calls.set(delegationKey(reference), {
        ...reference,
        $typeName: 'kairos.gui.v1.DelegationReference',
      });
    }
  }
  return [...calls.values()];
}

export function useCallPreviews(
  clients: KairosClients,
  threadId: string | null,
  messages: readonly Message[],
  revision: number,
) {
  const gateway = useMemo(() => createThreadPreviewGateway(clients), [clients]);
  const calls = useMemo(() => visibleDelegationCalls(messages), [messages]);
  const signature = useMemo(() => JSON.stringify(calls), [calls]);
  const [state, setState] = useState<{
    previews: ReadonlyMap<string, ThreadCallView>;
    loading: boolean;
    error: string | null;
  }>({ previews: new Map(), loading: false, error: null });

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision 和 signature 用于在会话事件后刷新调用投影。
  useEffect(() => {
    const controller = new AbortController();
    if (!threadId || calls.length === 0) {
      setState({ previews: new Map(), loading: false, error: null });
      return;
    }
    setState((previous) => ({ ...previous, loading: true, error: null }));
    const refresh = async () => {
      const previews = new Map<string, ThreadCallView>();
      for (let index = 0; index < calls.length; index += 100) {
        if (controller.signal.aborted) return;
        const page = await gateway.listCallPreviews(
          calls.slice(index, index + 100),
          controller.signal,
        );
        for (const [key, preview] of page) previews.set(key, preview);
      }
      if (!controller.signal.aborted) setState({ previews, loading: false, error: null });
    };
    void refresh().catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setState((previous) => ({
        ...previous,
        loading: false,
        error: formatClientError(cause),
      }));
    });
    return () => {
      controller.abort();
    };
  }, [calls, gateway, revision, signature, threadId]);

  return state;
}
