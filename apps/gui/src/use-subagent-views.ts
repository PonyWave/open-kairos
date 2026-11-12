import {
  type Message,
  RunExecutionMode,
  RunStatus,
  type SubagentCallView,
} from '@kairos/contracts';
import { useEffect, useMemo, useState } from 'react';
import type { KairosClients } from './client.js';
import { delegationForToolCall, delegationKey } from './delegation.js';

const subagentStatuses = new Set([
  RunStatus.QUEUED,
  RunStatus.RUNNING,
  RunStatus.WAITING,
  RunStatus.CANCEL_REQUESTED,
  RunStatus.COMPLETED,
  RunStatus.FAILED,
  RunStatus.CANCELLED,
  RunStatus.INTERRUPTED,
]);

export function validateSubagentView(view: SubagentCallView): void {
  const source = view.call?.delegation;
  if (
    !source?.sourceThreadId ||
    !source.sourceAgentId ||
    !source.sourceToolCallId ||
    !view.call?.sourceMessageId ||
    view.call.sourceMessageSeq <= 0n ||
    view.threadId !== source.sourceThreadId ||
    !view.agentId ||
    view.agentId === 'thread' ||
    !view.task ||
    (view.runId !== undefined && !view.runId)
  )
    throw new Error('子代理详情缺少有效的来源或目标。');
  if (
    !subagentStatuses.has(view.status) ||
    (view.executionMode !== RunExecutionMode.FOREGROUND &&
      view.executionMode !== RunExecutionMode.BACKGROUND)
  )
    throw new Error('子代理详情包含未知的执行状态或执行方式。');
}

export function useSubagentViews(
  clients: KairosClients,
  messages: readonly Message[],
  revision: number,
) {
  const calls = useMemo(
    () =>
      messages
        .filter((message) => !message.supersededByRunId)
        .flatMap((message) =>
          message.toolCalls
            .filter((call) => call.toolName === 'subagent')
            .map((call) => delegationForToolCall(message, call)),
        ),
    [messages],
  );
  const [views, setViews] = useState<ReadonlyMap<string, SubagentCallView>>(new Map());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!calls.length) {
      setViews(new Map());
      setError(null);
      return;
    }
    const refresh = async () => {
      const result = new Map<string, SubagentCallView>();
      for (let offset = 0; offset < calls.length; offset += 100) {
        const response = await clients.thread.listSubagentCallViews(
          { calls: calls.slice(offset, offset + 100) },
          { signal: controller.signal },
        );
        for (const view of response.views) {
          validateSubagentView(view);
          if (view.call?.delegation) result.set(delegationKey(view.call.delegation), view);
        }
      }
      if (!controller.signal.aborted) {
        setViews(result);
        setError(null);
      }
    };
    // A new persisted snapshot can make a just-created interaction available.
    if (revision >= 0)
      void refresh().catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [calls, clients, revision]);
  return { views, error };
}
