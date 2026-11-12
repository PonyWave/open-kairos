import {
  type DelegationReference,
  type Message,
  MessageRole,
  type MessageSource,
  type RunStatus,
  type Thread,
  type ToolCall,
} from '@kairos/contracts';
import type { AttachmentMetadata } from './attachments.js';
import { isDirectUserMessage } from './labels.js';
import { parseToolContent } from './tool-content.js';

export interface ReplyPreview {
  messageId: string;
  threadId: string;
  seq: bigint;
  role: MessageRole;
  source?: MessageSource;
  sourceThreadId?: string;
  content: string;
  truncated: boolean;
  attachments?: AttachmentMetadata[];
  createdAt?: Message['createdAt'];
}

export interface AgentOrigin {
  delegation: DelegationReference;
  prompt: string | null;
  sourceMessageId: string | null;
}

export interface TopicCardView {
  thread: Thread;
  createdAt?: Message['createdAt'];
  lastMessageAt?: Message['createdAt'];
  replies: readonly ReplyPreview[];
  origin: AgentOrigin | null;
}

export interface ThreadCallView {
  target: Pick<Thread, 'threadId' | 'title'> | null;
  status?: RunStatus;
  replyCount: bigint;
  replies: readonly ReplyPreview[];
  responseMessageSeq?: bigint;
}

export interface DelegationReceipt {
  status: string;
  threadId: string | null;
}

export function isDelegationTool(call: Pick<ToolCall, 'toolName'>): boolean {
  return call.toolName === 'thread_call';
}

export function isContinuedDelegation(call: Pick<ToolCall, 'toolName' | 'argumentsJson'>): boolean {
  return call.toolName === 'thread_call' && delegationThreadId(call) !== null;
}

export function delegationThreadId(
  call: Pick<ToolCall, 'toolName' | 'argumentsJson'>,
): string | null {
  if (call.toolName !== 'thread_call') return null;
  const threadId = toolArguments(call)?.thread_id;
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
}

export function delegationPrompt(call: Pick<ToolCall, 'argumentsJson'>): string | null {
  const prompt = toolArguments(call)?.prompt;
  return typeof prompt === 'string' ? prompt : null;
}

export function projectDelegationReceipts(
  messages: readonly Message[],
): ReadonlyMap<string, DelegationReceipt> {
  const receipts = new Map<string, DelegationReceipt>();
  for (const message of messages) {
    if (message.role !== MessageRole.TOOL || !isDelegationTool(message)) continue;
    const result = parseToolContent(message.content);
    if (!result.toolCallId || !result.status) continue;
    receipts.set(result.toolCallId, {
      status: result.status,
      threadId: result.threadId,
    });
  }
  return receipts;
}

export function previewSender(reply: Pick<ReplyPreview, 'role' | 'source'>): {
  label: string;
  user: boolean;
} {
  const user = isDirectUserMessage(reply);
  return { label: user ? '用户' : 'Kairos', user };
}

function toolArguments(call: Pick<ToolCall, 'argumentsJson'>): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(call.argumentsJson);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
