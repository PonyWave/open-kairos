import {
  ContentBlockType,
  create,
  type Input,
  InputStatus,
  type Message,
  MessageRole,
  MessageSchema,
  MessageSource,
  type Recap,
  RecapValidity,
  type Run,
  RunStatus,
} from '@kairos/contracts';
import { delegationForToolCall, delegationKey } from './delegation.js';
import { isRootAgent } from './labels.js';
import { stripLeadingReminders, stripStreamingReminders } from './reminder-text.js';
import { type SentUserMessage, sentUserMessage } from './sent-user-message.js';
import type { TransientResponse } from './thread-projection.js';
import { timestampDate } from './time-format.js';
import {
  type OrdinaryToolItem,
  projectAssociatedToolResultIds,
  projectToolItems,
  projectToolOutcomes,
  type ToolItem,
} from './tool-group-projection.js';

export interface DelegationCallProjection {
  messageId: string;
  seq: bigint;
  toolName: string;
  toolCallId: string;
}

export interface DisplayMessage {
  message: Message;
  streaming: boolean;
  delegationCall: DelegationCallProjection | null;
  toolItems?: ToolItem[];
  mergedThinkingBlockIndexes?: ReadonlySet<number>;
  sentMessage?: SentUserMessage | null;
  hideContent?: boolean;
  compact?: boolean;
  sendFailure?: boolean;
}

export type ConversationItem =
  | { kind: 'message'; key: string; value: DisplayMessage }
  | { kind: 'recap'; key: string; value: Recap }
  | { kind: 'run-outcome'; key: string; value: Run }
  | { kind: 'missing-user-reply'; key: string; value: Run }
  | { kind: 'pending-agent'; key: string; value: Input | Run };

interface ConversationProjectionInput {
  threadId: string;
  agentId?: string;
  messages: readonly Message[];
  transientResponses: readonly TransientResponse[];
  runs: readonly Run[];
  inputs?: readonly Input[];
  recaps?: readonly Recap[];
  invalidatedRecaps?: Readonly<Record<string, string>>;
}

const outcomeStatuses: ReadonlySet<number> = new Set([
  RunStatus.FAILED,
  RunStatus.CANCELLED,
  RunStatus.INTERRUPTED,
]);

export function projectConversation({
  threadId,
  agentId = 'thread',
  messages,
  transientResponses,
  runs,
  inputs = [],
  recaps = [],
  invalidatedRecaps = {},
}: ConversationProjectionInput): ConversationItem[] {
  const allRuns = runs.filter((run) => run.threadId === threadId);
  const runsById = new Map(allRuns.map((run) => [run.runId, run]));
  const currentRuns = allRuns.filter((run) => run.agentId === agentId);
  const runOwners = new Map(allRuns.map((run) => [run.runId, run.agentId]));
  const terminalRunIds = new Set(
    currentRuns.filter((run) => isTerminal(run.status)).map((run) => run.runId),
  );
  const currentMessages = messages.filter(
    (message) =>
      message.threadId === threadId && message.agentId === agentId && !message.supersededByRunId,
  );
  const sourceCalls = projectSourceCalls(
    messages.filter((message) => message.threadId === threadId && !message.supersededByRunId),
  );
  const persistedIds = new Set(currentMessages.map((message) => message.messageId));
  const displayMessages: DisplayMessage[] = currentMessages.map((current) => {
    const message = visibleAssistantMessage(current);
    const matches = message.delegation
      ? sourceCalls.get(delegationKey(message.delegation))
      : undefined;
    const sent = sentUserMessage(message);
    return {
      message,
      streaming: false,
      delegationCall: matches?.length === 1 ? (matches[0] ?? null) : null,
      ...(sent ? { sentMessage: sent } : {}),
    };
  });
  for (const response of transientResponses) {
    const owner = response.agentId ?? (response.runId ? runOwners.get(response.runId) : undefined);
    if (
      owner !== agentId ||
      persistedIds.has(response.messageId) ||
      (response.runId !== undefined && terminalRunIds.has(response.runId))
    ) {
      continue;
    }
    const visibleBlocks = response.contentBlocks.map((block) =>
      block.type === ContentBlockType.TEXT
        ? { ...block, text: stripStreamingReminders(block.text) }
        : block,
    );
    const visibleText = visibleBlocks
      .filter((block) => block.type === ContentBlockType.TEXT)
      .map((block) => block.text)
      .join('');
    const hasVisibleContent =
      visibleText.trim().length > 0 ||
      visibleBlocks.some((block) => block.type !== ContentBlockType.TEXT && block.text.trim());
    if (!hasVisibleContent) continue;
    const responseRun = response.runId === undefined ? undefined : runsById.get(response.runId);
    const createdAt = responseRun?.startedAt ?? responseRun?.createdAt;
    displayMessages.push({
      message: create(MessageSchema, {
        messageId: response.messageId,
        threadId,
        agentId,
        role: MessageRole.ASSISTANT,
        content: visibleText,
        contentBlocks: visibleBlocks,
        ...(response.runId === undefined ? {} : { runId: response.runId }),
        ...(responseRun?.sendToUserEnabled === undefined
          ? {}
          : { sendToUserEnabled: responseRun.sendToUserEnabled }),
        ...(createdAt === undefined ? {} : { createdAt }),
      }),
      streaming: true,
      delegationCall: null,
    });
  }

  const pendingInputs = inputs
    .filter(
      (input) =>
        input.status === InputStatus.QUEUED &&
        (input.source === undefined || input.source === MessageSource.USER) &&
        !currentMessages.some((message) => message.sourceInputId === input.inputId),
    )
    .sort((left, right) => {
      if (left.position < right.position) return -1;
      if (left.position > right.position) return 1;
      return left.inputId < right.inputId ? -1 : 1;
    });
  for (const input of pendingInputs) {
    displayMessages.push({
      message: create(MessageSchema, {
        messageId: `queued:${input.inputId}`,
        threadId,
        agentId,
        role: MessageRole.USER,
        content: input.text,
        source: MessageSource.USER,
        sourceInputId: input.inputId,
        createdAt: input.createdAt,
        attachments: [...input.attachments],
      }),
      streaming: false,
      delegationCall: null,
    });
  }

  const outcomes = currentRuns
    .filter((run) => !run.supersededByRunId && outcomeStatuses.has(run.status))
    .sort(compareRuns);
  const messageIndexes = indexMessages(displayMessages);
  const placements = new Map<number, Run[]>();
  for (const run of outcomes) {
    const position = outcomePosition(run, displayMessages, messageIndexes);
    const atPosition = placements.get(position);
    if (atPosition) atPosition.push(run);
    else placements.set(position, [run]);
  }
  const currentSequences = new Set(currentMessages.map((message) => message.seq));
  const recapPlacements = new Map<number, Recap[]>();
  const recapsById = new Map(recaps.map((recap) => [recap.recapId, recap]));
  for (const recap of recapsById.values()) {
    if (
      recap.threadId !== threadId ||
      recap.agentId !== agentId ||
      recap.validity !== RecapValidity.VALID ||
      invalidatedRecaps[recap.recapId] !== undefined ||
      !recap.sourceMessageSeqs.every((seq) => currentSequences.has(seq))
    ) {
      continue;
    }
    const anchor = messageIndexes.sequences.get(recap.sourceSeqEnd);
    if (anchor === undefined) continue;
    const position = anchor + 1;
    const atPosition = recapPlacements.get(position);
    if (atPosition) atPosition.push(recap);
    else recapPlacements.set(position, [recap]);
  }
  for (const placed of recapPlacements.values()) placed.sort(compareRecaps);
  const items: ConversationItem[] = [];
  for (let position = 0; position <= displayMessages.length; position += 1) {
    for (const run of placements.get(position) ?? []) {
      items.push({
        kind: 'run-outcome',
        key: `run-outcome:${run.runId}`,
        value: run,
      });
    }
    for (const recap of recapPlacements.get(position) ?? []) {
      items.push({ kind: 'recap', key: `recap:${recap.recapId}`, value: recap });
    }
    const display = displayMessages[position];
    if (display) {
      items.push({
        kind: 'message',
        key: display.message.messageId,
        value: display,
      });
    }
  }
  const pendingInput = pendingInputs.at(-1);
  if (pendingInput) {
    items.push({
      kind: 'pending-agent',
      key: `pending-agent:${pendingInput.inputId}`,
      value: pendingInput,
    });
  } else {
    const activeRun = currentRuns
      .filter(
        (run) =>
          !run.supersededByRunId &&
          (run.status === RunStatus.QUEUED ||
            run.status === RunStatus.RUNNING ||
            run.status === RunStatus.WAITING),
      )
      .sort(compareRuns)
      .at(-1);
    if (
      activeRun &&
      !currentMessages.some(
        (message) => message.runId === activeRun.runId && sentUserMessage(message) !== null,
      )
    ) {
      items.push({
        kind: 'pending-agent',
        key: `pending-agent:run:${activeRun.runId}`,
        value: activeRun,
      });
    }
  }
  return projectMixedOperationGroups(items, currentMessages);
}

function projectMixedOperationGroups(
  items: ConversationItem[],
  messages: readonly Message[],
): ConversationItem[] {
  const outcomes = projectToolOutcomes(messages);
  const associatedToolResultIds = projectAssociatedToolResultIds(messages, outcomes);
  const sentCallIds = new Set<string>();
  for (const message of messages) {
    if (sentUserMessage(message)) sentCallIds.add(message.toolCallId);
  }
  let open:
    | {
        display: DisplayMessage;
        index: number;
        group: OrdinaryToolItem;
      }
    | undefined;
  const storeOpenGroup = () => {
    if (!open) return;
    const toolItems = [...(open.display.toolItems ?? [])];
    toolItems[open.index] = open.group;
    open.display.toolItems = toolItems;
  };
  for (const item of items) {
    if (item.kind !== 'message') {
      open = undefined;
      continue;
    }
    const display = item.value;
    const message = display.message;
    if (
      message.role === MessageRole.TOOL &&
      associatedToolResultIds.has(message.toolCallId) &&
      outcomes.has(message.toolCallId)
    ) {
      continue;
    }
    if (message.role !== MessageRole.ASSISTANT) {
      open = undefined;
      continue;
    }
    if (
      open &&
      (open.display.message.sendToUserEnabled === true) !== (message.sendToUserEnabled === true)
    ) {
      open = undefined;
    }
    const visibleCalls = message.toolCalls.filter((call) => !sentCallIds.has(call.toolCallId));
    const ownItems = projectToolItems(visibleCalls, {
      contentBlocks: message.contentBlocks,
      messageId: message.messageId,
      streaming: display.streaming,
    });
    const mergedThinking = new Set<number>();
    for (const toolItem of ownItems) {
      if (toolItem.kind !== 'ordinary') continue;
      for (const operation of toolItem.operations) {
        if (operation.kind === 'thinking') mergedThinking.add(operation.blockIndex);
      }
    }
    display.mergedThinkingBlockIndexes = mergedThinking;
    display.toolItems = ownItems;
    const hasText =
      message.contentBlocks.length > 0
        ? message.contentBlocks.some(
            (block) => block.type === ContentBlockType.TEXT && block.text.trim().length > 0,
          )
        : message.content.trim().length > 0;
    const first = ownItems[0];
    if (
      ownItems.length === 0 &&
      message.toolCalls.length > 0 &&
      !hasText &&
      message.attachments.length === 0
    ) {
      continue;
    }
    if (
      open &&
      !hasText &&
      message.attachments.length === 0 &&
      first?.kind === 'ordinary' &&
      (first.calls.length > 0 || visibleCalls.length === 0)
    ) {
      open.group = {
        ...open.group,
        calls: [...open.group.calls, ...first.calls],
        operations: [...open.group.operations, ...first.operations],
      };
      storeOpenGroup();
      display.toolItems = ownItems.slice(1);
      if (display.toolItems.length === 0) continue;
    }
    const remaining = display.toolItems;
    const last = remaining.at(-1);
    const lastPosition = last?.blockIndex;
    const textAfterLast =
      lastPosition !== undefined &&
      message.contentBlocks.some(
        (block) =>
          block.type === ContentBlockType.TEXT &&
          block.text.trim().length > 0 &&
          block.blockIndex >= lastPosition,
      );
    open =
      last?.kind === 'ordinary' && message.attachments.length === 0 && !textAfterLast
        ? { display, index: remaining.length - 1, group: last }
        : undefined;
  }
  return items;
}

function visibleAssistantMessage(message: Message): Message {
  if (message.role !== MessageRole.ASSISTANT) return message;
  const hasReminderText =
    message.content.startsWith('<system-reminder>\n') ||
    message.contentBlocks.some(
      (block) =>
        block.type === ContentBlockType.TEXT && block.text.startsWith('<system-reminder>\n'),
    );
  if (!hasReminderText) return message;
  return create(MessageSchema, {
    ...message,
    content: stripLeadingReminders(message.content),
    contentBlocks: message.contentBlocks.map((block) =>
      block.type === ContentBlockType.TEXT && block.text.startsWith('<system-reminder>\n')
        ? { ...block, text: stripLeadingReminders(block.text) }
        : block,
    ),
  });
}

function projectSourceCalls(
  messages: readonly Message[],
): ReadonlyMap<string, readonly DelegationCallProjection[]> {
  const calls = new Map<string, DelegationCallProjection[]>();
  for (const message of messages) {
    if (message.role !== MessageRole.ASSISTANT) continue;
    for (const call of message.toolCalls) {
      const key = delegationKey(delegationForToolCall(message, call));
      const projection = {
        messageId: message.messageId,
        seq: message.seq,
        toolName: call.toolName,
        toolCallId: call.toolCallId,
      };
      calls.set(key, [...(calls.get(key) ?? []), projection]);
    }
  }
  return calls;
}

function indexMessages(displayMessages: readonly DisplayMessage[]) {
  const runIds = new Map<string, number>();
  const sourceInputIds = new Map<string, number>();
  const rootUserSequences = new Map<bigint, number>();
  const sequences = new Map<bigint, number>();
  const times: Array<{ createdAt: NonNullable<Message['createdAt']>; position: number }> = [];
  for (const [index, { message }] of displayMessages.entries()) {
    if (message.runId) runIds.set(message.runId, index);
    if (message.sourceInputId) sourceInputIds.set(message.sourceInputId, index);
    if (message.seq > 0n) sequences.set(message.seq, index);
    if (isRootAgent(message.agentId) && message.role === MessageRole.USER) {
      rootUserSequences.set(message.seq, index);
    }
    const createdAt = validTimestamp(message.createdAt);
    const latest = times.at(-1);
    // 仅记录按消息顺序首次出现的新最大时间，保留第一条晚于 Run 的消息位置。
    if (createdAt && (!latest || compareTimestamps(createdAt, latest.createdAt) > 0)) {
      times.push({ createdAt, position: index });
    }
  }
  return { runIds, sourceInputIds, rootUserSequences, sequences, times };
}

function outcomePosition(
  run: Run,
  displayMessages: readonly DisplayMessage[],
  indexes: ReturnType<typeof indexMessages>,
): number {
  const associated = indexes.runIds.get(run.runId);
  if (associated !== undefined) return associated + 1;
  if (run.rerunFromMessageSeq !== undefined) {
    const anchored = indexes.rootUserSequences.get(run.rerunFromMessageSeq);
    if (anchored !== undefined) return anchored + 1;
  }
  if (run.inputIds.length > 0) {
    const anchored = run.inputIds.reduce(
      (latest, id) => Math.max(latest, indexes.sourceInputIds.get(id) ?? -1),
      -1,
    );
    if (anchored >= 0) return anchored + 1;
  }
  const createdAt = validTimestamp(run.createdAt);
  if (!createdAt) return displayMessages.length;
  let start = 0;
  let end = indexes.times.length;
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    const candidate = indexes.times[middle];
    if (candidate && compareTimestamps(candidate.createdAt, createdAt) > 0) end = middle;
    else start = middle + 1;
  }
  return indexes.times[start]?.position ?? displayMessages.length;
}

function compareRecaps(left: Recap, right: Recap): number {
  if (left.seq < right.seq) return -1;
  if (left.seq > right.seq) return 1;
  return left.recapId < right.recapId ? -1 : left.recapId > right.recapId ? 1 : 0;
}

function compareRuns(left: Run, right: Run): number {
  const leftTime = validTimestamp(left.createdAt);
  const rightTime = validTimestamp(right.createdAt);
  if (leftTime && rightTime) {
    const compared = compareTimestamps(leftTime, rightTime);
    if (compared !== 0) return compared;
  } else if (leftTime) {
    return -1;
  } else if (rightTime) {
    return 1;
  }
  return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
}

function validTimestamp(value: Message['createdAt']): Message['createdAt'] {
  return timestampDate(value) ? value : undefined;
}

function compareTimestamps(
  left: { seconds: bigint; nanos: number },
  right: { seconds: bigint; nanos: number },
): number {
  if (left.seconds < right.seconds) return -1;
  if (left.seconds > right.seconds) return 1;
  if (left.nanos < right.nanos) return -1;
  if (left.nanos > right.nanos) return 1;
  return 0;
}

function isTerminal(status: RunStatus): boolean {
  return (
    status === RunStatus.COMPLETED ||
    status === RunStatus.FAILED ||
    status === RunStatus.CANCELLED ||
    status === RunStatus.INTERRUPTED
  );
}

export function selectPaneMessages(
  messages: readonly Message[],
  agentId: string,
  prompt?: {
    sourceCall?: import('./delegation.js').DelegationIdentity;
    task?: string | undefined;
    runId?: string | undefined;
  },
) {
  const scoped = messages.filter(
    (message) =>
      message.agentId === agentId &&
      !message.supersededByRunId &&
      message.source !== MessageSource.SUBAGENT_RESPONSE,
  );
  const duplicate = scoped.find((message) => {
    if (message.role !== MessageRole.USER) return false;
    if (prompt?.sourceCall)
      return (
        message.source === MessageSource.THREAD_CALL &&
        message.delegation &&
        delegationKey(message.delegation) === delegationKey(prompt.sourceCall)
      );
    return (
      prompt?.task !== undefined &&
      message.content === prompt.task &&
      (!prompt.runId || message.runId === prompt.runId)
    );
  });
  return scoped.filter((message) => message.messageId !== duplicate?.messageId);
}
