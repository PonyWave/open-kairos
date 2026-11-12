import {
  type ContentBlock,
  ContentBlockType,
  type Message,
  MessageRole,
  type ToolCall,
  ToolResultStatus,
} from '@kairos/contracts';
import { isDelegationTool } from './thread-view.js';
import { parseToolContent, type ToolContentView } from './tool-content.js';

export interface ToolOutcome {
  message: Message;
  result: ToolContentView;
}

export type ToolOperationState = 'running' | 'failed' | 'unknown' | 'cancelled' | 'succeeded';

export interface ThinkingOperation {
  kind: 'thinking';
  id: string;
  messageId: string;
  blockIndex: number;
  text: string;
  active: boolean;
}

export type ToolGroupOperation =
  | ThinkingOperation
  | { kind: 'call'; id: string; messageId: string; call: ToolCall };

interface ToolItemPosition {
  id: string;
  blockIndex?: number | undefined;
}

export type OrdinaryToolItem = ToolItemPosition & {
  kind: 'ordinary';
  calls: readonly ToolCall[];
  operations: readonly ToolGroupOperation[];
};

export type ToolItem =
  | OrdinaryToolItem
  | (ToolItemPosition & { kind: 'delegation'; call: ToolCall })
  | (ToolItemPosition & { kind: 'notification'; call: ToolCall })
  | (ToolItemPosition & { kind: 'subagent'; call: ToolCall });

interface ToolItemProjectionOptions {
  contentBlocks?: readonly ContentBlock[];
  messageId?: string;
  streaming?: boolean;
}

export function projectThinkingOperations(
  contentBlocks: readonly ContentBlock[],
  streaming: boolean,
): ThinkingOperation[] {
  const blocks = [...contentBlocks]
    .filter((block) => block.text.trim().length > 0)
    .sort((left, right) => left.blockIndex - right.blockIndex);
  const activeBlockIndex =
    streaming && blocks.at(-1)?.type === ContentBlockType.THINKING
      ? blocks.at(-1)?.blockIndex
      : undefined;
  return blocks.flatMap((block) =>
    block.type === ContentBlockType.THINKING
      ? [
          {
            kind: 'thinking' as const,
            id: `thinking:${block.blockIndex}`,
            messageId: '',
            blockIndex: block.blockIndex,
            text: block.text,
            active: block.blockIndex === activeBlockIndex,
          },
        ]
      : [],
  );
}

export function projectToolItems(
  calls: readonly ToolCall[],
  options: ToolItemProjectionOptions = {},
): ToolItem[] {
  const contentBlocks = [...(options.contentBlocks ?? [])].sort(
    (left, right) => left.blockIndex - right.blockIndex,
  );
  let previousCallPosition = 0;
  const ordered =
    contentBlocks.every((block, index) => block.blockIndex === index) &&
    calls.every((call) => {
      const position = call.blockIndex;
      const valid =
        position !== undefined &&
        Number.isSafeInteger(position) &&
        position >= previousCallPosition &&
        position <= contentBlocks.length;
      if (valid) previousCallPosition = position;
      return valid;
    });
  return ordered
    ? projectOrderedToolItems(calls, contentBlocks, options)
    : projectLegacyToolItems(calls, options);
}

function projectLegacyToolItems(
  calls: readonly ToolCall[],
  options: ToolItemProjectionOptions,
): ToolItem[] {
  const items: ToolItem[] = [];
  let ordinary: ToolCall[] = [];
  const messageId = options.messageId ?? '';
  const flush = () => {
    const first = ordinary[0];
    if (!first) return;
    items.push({
      kind: 'ordinary',
      id: first.toolCallId,
      calls: ordinary,
      operations: ordinary.map((call) => ({
        kind: 'call',
        id: call.toolCallId,
        messageId,
        call,
      })),
    });
    ordinary = [];
  };
  for (const call of calls) {
    const special = specialToolKind(call);
    if (special) {
      flush();
      items.push({ kind: special, id: call.toolCallId, call });
    } else {
      ordinary.push(call);
    }
  }
  flush();
  const thinking = projectThinkingOperations(
    options.contentBlocks ?? [],
    options.streaming ?? false,
  ).map((operation) => ({ ...operation, messageId }));
  const firstThinking = thinking[0];
  if (!firstThinking) return items;
  const first = items[0];
  if (first?.kind === 'ordinary') {
    items[0] = {
      ...first,
      id: firstThinking.id,
      operations: [...thinking, ...first.operations],
    };
  } else {
    items.unshift({
      kind: 'ordinary',
      id: firstThinking.id,
      calls: [],
      operations: thinking,
    });
  }
  return items;
}

function projectOrderedToolItems(
  calls: readonly ToolCall[],
  contentBlocks: readonly ContentBlock[],
  options: ToolItemProjectionOptions,
): ToolItem[] {
  const items: ToolItem[] = [];
  const messageId = options.messageId ?? '';
  const thinking = projectThinkingOperations(contentBlocks, options.streaming ?? false).map(
    (operation) => ({ ...operation, messageId }),
  );
  const thinkingByBlock = new Map(thinking.map((operation) => [operation.blockIndex, operation]));
  let operations: ToolGroupOperation[] = [];
  const flush = (blockIndex: number) => {
    const first = operations[0];
    if (!first) return;
    items.push({
      kind: 'ordinary',
      id: first.id,
      calls: operations.flatMap((operation) => (operation.kind === 'call' ? [operation.call] : [])),
      operations,
      blockIndex,
    });
    operations = [];
  };
  const appendCall = (call: ToolCall, blockIndex: number) => {
    const special = specialToolKind(call);
    if (special) {
      flush(blockIndex);
      items.push({ kind: special, id: call.toolCallId, call, blockIndex });
      return;
    }
    operations.push({ kind: 'call', id: call.toolCallId, messageId, call });
  };
  let callIndex = 0;
  for (let blockIndex = 0; blockIndex <= contentBlocks.length; blockIndex += 1) {
    while (calls[callIndex]?.blockIndex === blockIndex) {
      const call = calls[callIndex];
      if (call) appendCall(call, blockIndex);
      callIndex += 1;
    }
    const block = contentBlocks[blockIndex];
    if (!block?.text.trim()) continue;
    if (block.type === ContentBlockType.TEXT) {
      flush(blockIndex);
      continue;
    }
    const operation = thinkingByBlock.get(blockIndex);
    if (operation) operations.push(operation);
  }
  flush(contentBlocks.length);
  return items;
}

function specialToolKind(call: ToolCall): 'delegation' | 'notification' | 'subagent' | undefined {
  if (call.toolName === 'subagent') return 'subagent';
  if (isDelegationTool(call)) return 'delegation';
  if (call.toolName === 'thread_notify') return 'notification';
  return undefined;
}

export function projectToolOutcomes(
  messages: readonly Message[],
): ReadonlyMap<string, ToolOutcome> {
  const outcomes = new Map<string, ToolOutcome>();
  for (const message of messages) {
    if (
      message.supersededByRunId ||
      message.role !== MessageRole.TOOL ||
      isDelegationTool(message)
    ) {
      continue;
    }
    const result = parseToolContent(message.content);
    if (message.toolCallId) outcomes.set(message.toolCallId, { message, result });
  }
  return outcomes;
}

export function projectAssociatedToolResultIds(
  messages: readonly Message[],
  outcomes: ReadonlyMap<string, ToolOutcome>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.supersededByRunId || message.role !== MessageRole.ASSISTANT) continue;
    for (const call of message.toolCalls) {
      if (!isDelegationTool(call) && outcomes.has(call.toolCallId)) ids.add(call.toolCallId);
    }
  }
  return ids;
}

export function toolOperationState(
  call: Pick<ToolCall, 'toolName'>,
  outcome: ToolOutcome | undefined,
  streaming: boolean,
): ToolOperationState {
  if (!outcome) return streaming ? 'running' : 'unknown';
  const { message, result } = outcome;
  if (result.resultUnknown) return 'unknown';
  if (message.toolError?.code === 'cancelled') return 'cancelled';
  if (message.toolStatus === ToolResultStatus.ERROR) return 'failed';
  if (message.toolStatus !== ToolResultStatus.SUCCESS) return 'unknown';
  if (result.status === 'failed' || (result.exitCode !== null && result.exitCode !== 0)) {
    return 'failed';
  }
  if (result.status === 'cancelled' || result.status === 'interrupted') return 'cancelled';
  if (result.status === 'accepted' || result.status === 'created' || result.status === 'running') {
    return 'running';
  }
  if (result.outputComplete === false) return 'unknown';
  if (result.status === 'completed' || result.status === 'succeeded' || result.exitCode === 0) {
    return 'succeeded';
  }
  if (result.status === 'unknown' || result.status === 'offline') return 'unknown';
  if (call.toolName === 'bash' || call.toolName === 'device_bash') return 'unknown';
  return 'succeeded';
}

export function toolGroupState(
  calls: readonly ToolCall[],
  outcomes: ReadonlyMap<string, ToolOutcome>,
  streaming: boolean,
): ToolOperationState {
  const states = calls.map((call) =>
    toolOperationState(call, outcomes.get(call.toolCallId), streaming),
  );
  for (const attention of ['failed', 'unknown', 'cancelled'] as const) {
    if (states.includes(attention)) return attention;
  }
  return states.includes('running') ? 'running' : 'succeeded';
}

export function toolStateLabel(state: ToolOperationState, grouped = false): string {
  if (grouped) {
    if (state === 'failed') return '包含失败调用';
    if (state === 'unknown') return '有结果待核对';
    if (state === 'cancelled') return '包含已取消调用';
    if (state === 'running') return '执行中';
    return '完成';
  }
  if (state === 'failed') return '失败';
  if (state === 'unknown') return '结果待核对';
  if (state === 'cancelled') return '已取消';
  if (state === 'running') return '执行中';
  return '完成';
}

export function withToolExpanded(
  current: Readonly<Record<string, boolean>>,
  operationId: string,
  expanded: boolean,
): Record<string, boolean> {
  return { ...current, [operationId]: expanded };
}
