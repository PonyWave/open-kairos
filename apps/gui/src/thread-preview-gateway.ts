import {
  type DelegationReference,
  type Message,
  MessageRole,
  MessageSource,
  RunStatus,
  type Thread,
  type ThreadCallReference,
  type ThreadCardCursor,
  ThreadCardSort,
  type ThreadMessagePreview,
  ThreadType,
  validateThreadMessagePreview,
} from '@kairos/contracts';
import { attachmentMetadata } from './attachments.js';
import type { KairosClients } from './client.js';
import { delegationKey } from './delegation.js';
import type { ReplyPreview, ThreadCallView, TopicCardView } from './thread-view.js';

export type TopicSort = 'lastMessageAt' | 'createdAt';

export interface TopicCardPage {
  cards: readonly TopicCardView[];
  nextCursor: ThreadCardCursor | null;
  hasMore: boolean;
}

export interface ThreadPreviewGateway {
  listCards(
    input: {
      limit: number;
      sort: TopicSort;
      cursor: ThreadCardCursor | null;
    },
    signal?: AbortSignal,
  ): Promise<TopicCardPage>;
  listCallPreviews(
    calls: readonly DelegationReference[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, ThreadCallView>>;
}

const roles = new Set<number>([
  MessageRole.SYSTEM,
  MessageRole.USER,
  MessageRole.ASSISTANT,
  MessageRole.TOOL,
]);
const sources = new Set<number>([
  MessageSource.USER,
  MessageSource.THREAD_CALL,
  MessageSource.THREAD_RESPONSE,
  MessageSource.SUBAGENT_RESPONSE,
  MessageSource.AUTOMATION,
  MessageSource.THREAD_NOTIFICATION,
]);
const runStatuses = new Set<number>([
  RunStatus.UNSPECIFIED,
  RunStatus.QUEUED,
  RunStatus.RUNNING,
  RunStatus.WAITING,
  RunStatus.CANCEL_REQUESTED,
  RunStatus.COMPLETED,
  RunStatus.FAILED,
  RunStatus.CANCELLED,
  RunStatus.INTERRUPTED,
]);

export function createThreadPreviewGateway(clients: KairosClients): ThreadPreviewGateway {
  return {
    async listCards({ limit, sort, cursor }, signal) {
      const protocolSort =
        sort === 'createdAt' ? ThreadCardSort.CREATED_AT : ThreadCardSort.LAST_MESSAGE_AT;
      const response = await clients.thread.listThreadCards(
        {
          limit,
          sort: protocolSort,
          ...(cursor === null ? {} : { cursor }),
        },
        signal === undefined ? {} : { signal },
      );
      const body = objectValue(response, 'ListThreadCardsResponse');
      const hasMore = booleanField(body, 'hasMore');
      const nextCursor = body.nextCursor;
      if (hasMore !== (nextCursor !== undefined)) {
        throw new Error('ListThreadCards 返回了无效的分页位置。');
      }
      if (nextCursor !== undefined) validateCursor(nextCursor, protocolSort);
      const cards = arrayField(body, 'cards').map((card) => parseTopicCard(card));
      return { cards, nextCursor: nextCursor ?? null, hasMore };
    },
    async listCallPreviews(calls, signal) {
      if (calls.length === 0) return new Map();
      if (calls.length > 100) throw new Error('单次调用预览请求不能超过 100 项。');
      const response = await clients.thread.listThreadCallPreviews(
        { calls: [...calls] },
        signal === undefined ? {} : { signal },
      );
      const body = objectValue(response, 'ListThreadCallPreviewsResponse');
      const previews = new Map<string, ThreadCallView>();
      for (const value of arrayField(body, 'previews')) {
        const preview = objectValue(value, 'ThreadCallPreview');
        const reference = parseCallReference(preview.call);
        if (!reference.delegation) throw new Error('ThreadCallPreview 缺少调用三元组。');
        const targetThreadId = textField(preview, 'targetThreadId');
        const targetTitle = stringField(preview, 'targetTitle');
        const replies = arrayField(preview, 'replies').map((reply) =>
          parseReply(reply, targetThreadId),
        );
        const replyCount = bigintField(preview, 'replyCount');
        if (replyCount < BigInt(replies.length)) {
          throw new Error('ThreadCallPreview 的回复总数小于已返回回复数。');
        }
        const status = numberField(preview, 'status');
        if (!runStatuses.has(status)) throw new Error('ThreadCallPreview 状态未知。');
        const responseMessageSeq = optionalBigint(preview.responseMessageSeq, 'responseMessageSeq');
        previews.set(delegationKey(reference.delegation), {
          target: { threadId: targetThreadId, title: targetTitle },
          ...(status === RunStatus.UNSPECIFIED ? {} : { status: status as RunStatus }),
          replyCount,
          replies,
          ...(responseMessageSeq === undefined ? {} : { responseMessageSeq }),
        });
      }
      return previews;
    },
  };
}

function parseTopicCard(value: unknown): TopicCardView {
  const card = objectValue(value, 'ThreadCard');
  const thread = parseThread(card.thread);
  if (thread.threadType !== ThreadType.TASK) {
    throw new Error('ListThreadCards 返回了非任务 Thread。');
  }
  const sourceCall = card.sourceCall === undefined ? null : parseCallReference(card.sourceCall);
  return {
    thread,
    createdAt: thread.createdAt,
    ...(card.lastMessageAt === undefined
      ? {}
      : { lastMessageAt: timestamp(card.lastMessageAt, 'lastMessageAt') }),
    replies: arrayField(card, 'messages').map((reply) => parseReply(reply, thread.threadId)),
    origin: sourceCall?.delegation
      ? {
          delegation: sourceCall.delegation,
          prompt: null,
          sourceMessageId: sourceCall.sourceMessageId,
        }
      : null,
  };
}

function parseCallReference(value: unknown): ThreadCallReference {
  const reference = objectValue(value, 'ThreadCallReference');
  if (reference.$typeName !== 'kairos.gui.v1.ThreadCallReference') {
    throw new Error('ThreadCallReference 格式无效。');
  }
  const delegation = objectValue(reference.delegation, 'DelegationReference');
  textField(delegation, 'sourceThreadId');
  textField(delegation, 'sourceAgentId');
  textField(delegation, 'sourceToolCallId');
  textField(reference, 'sourceMessageId');
  bigintField(reference, 'sourceMessageSeq');
  return value as ThreadCallReference;
}

function parseThread(value: unknown): Thread {
  const thread = objectValue(value, 'Thread');
  if (
    thread.$typeName !== 'kairos.gui.v1.Thread' ||
    typeof thread.threadId !== 'string' ||
    !thread.threadId ||
    typeof thread.title !== 'string' ||
    typeof thread.seq !== 'bigint'
  ) {
    throw new Error('ThreadCard 缺少有效 Thread。');
  }
  if (thread.createdAt !== undefined) timestamp(thread.createdAt, 'thread.createdAt');
  if (thread.updatedAt !== undefined) timestamp(thread.updatedAt, 'thread.updatedAt');
  return value as Thread;
}

function parseReply(value: unknown, threadId: string): ReplyPreview {
  const reply = objectValue(value, 'ThreadMessagePreview');
  const messageId = textField(reply, 'messageId');
  const attachments = arrayField(reply, 'attachments');
  validateThreadMessagePreview(reply as ThreadMessagePreview);
  const role = numberField(reply, 'role');
  if (!roles.has(role)) throw new Error('ThreadMessagePreview 角色未知。');
  const source = reply.source === undefined ? undefined : numberField(reply, 'source');
  if (source !== undefined && !sources.has(source)) {
    throw new Error('ThreadMessagePreview 来源未知。');
  }
  const sourceThreadId = reply.sourceThreadId;
  if (sourceThreadId !== undefined && typeof sourceThreadId !== 'string') {
    throw new Error('ThreadMessagePreview.sourceThreadId 格式无效。');
  }
  return {
    messageId,
    threadId,
    seq: bigintField(reply, 'seq'),
    role: role as MessageRole,
    ...(source === undefined ? {} : { source: source as MessageSource }),
    ...(sourceThreadId === undefined ? {} : { sourceThreadId }),
    content: stringField(reply, 'text'),
    truncated: booleanField(reply, 'textTruncated'),
    attachments: (attachments as ThreadMessagePreview['attachments']).map(attachmentMetadata),
    ...(reply.createdAt === undefined
      ? {}
      : { createdAt: timestamp(reply.createdAt, 'createdAt') }),
  };
}

function validateCursor(value: unknown, sort: ThreadCardSort): asserts value is ThreadCardCursor {
  const cursor = objectValue(value, 'ThreadCardCursor');
  if (numberField(cursor, 'sort') !== sort) throw new Error('ThreadCardCursor 排序字段已变化。');
  timestamp(cursor.sortAt, 'ThreadCardCursor.sortAt');
  bigintField(cursor, 'threadSeq');
}

function timestamp(value: unknown, label: string): NonNullable<Message['createdAt']> {
  const timestamp = objectValue(value, label);
  if (typeof timestamp.seconds !== 'bigint' || typeof timestamp.nanos !== 'number') {
    throw new Error(`${label} 格式无效。`);
  }
  return value as NonNullable<Message['createdAt']>;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 格式无效。`);
  }
  return value as Record<string, unknown>;
}

function arrayField(payload: Record<string, unknown>, key: string): unknown[] {
  const value = payload[key];
  if (!Array.isArray(value)) throw new Error(`响应字段 ${key} 不是数组。`);
  return value;
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') throw new Error(`响应字段 ${key} 不是字符串。`);
  return value;
}

function textField(payload: Record<string, unknown>, key: string): string {
  const value = stringField(payload, key);
  if (!value) throw new Error(`响应字段 ${key} 不能为空。`);
  return value;
}

function booleanField(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key];
  if (typeof value !== 'boolean') throw new Error(`响应字段 ${key} 不是布尔值。`);
  return value;
}

function numberField(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== 'number') throw new Error(`响应字段 ${key} 不是数值。`);
  return value;
}

function bigintField(payload: Record<string, unknown>, key: string): bigint {
  const value = payload[key];
  if (typeof value !== 'bigint') throw new Error(`响应字段 ${key} 不是 uint64。`);
  return value;
}

function optionalBigint(value: unknown, label: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'bigint') throw new Error(`响应字段 ${label} 不是 uint64。`);
  return value;
}
