import { randomUUID } from 'node:crypto';
import type { DetailedModelUsage, ModelMessage, ToolCall } from '@kairos/agent-core';
import { z } from 'zod';
import type { AttachmentMetadata } from '../attachments/types.js';

const toolCallSchema: z.ZodType<ToolCall> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  block_index: z.number().int().nonnegative().safe().optional(),
});
const incompleteToolCallSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  arguments_text: z.string(),
  error: z.string(),
});
const toolErrorSchema = z.object({
  code: z.enum([
    'incomplete_call',
    'unknown_tool',
    'invalid_arguments',
    'execution_failed',
    'cancelled',
  ]),
  message: z.string(),
});
const contentBlockSchema = z.object({
  type: z.enum(['text', 'thinking']),
  block_index: z.number().int().nonnegative().safe(),
  text: z.string().min(1),
});
const userContentPartsSchema = z.array(
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({
      type: z.literal('image_url'),
      image_url: z.object({ url: z.string().min(1), detail: z.literal('low') }),
    }),
    z.object({
      type: z.literal('attachment'),
      attachment_id: z.string().min(1),
      workspace_required: z.boolean().optional(),
      path: z.string().min(1).optional(),
    }),
  ]),
);
const responseUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().safe(),
  output_tokens: z.number().int().nonnegative().safe(),
  total_tokens: z.number().int().nonnegative().safe().optional(),
  prompt_tokens_details: z
    .object({ cached_tokens: z.number().int().nonnegative().safe() })
    .optional(),
});

export const modelMessageSchema = z
  .discriminatedUnion('role', [
    z.object({ role: z.literal('system'), content: z.string() }),
    z.object({
      role: z.literal('user'),
      content: z.string(),
      content_parts: userContentPartsSchema.optional(),
    }),
    z.object({
      role: z.literal('assistant'),
      content: z.string(),
      content_blocks: z.array(contentBlockSchema).optional(),
      tool_calls: z.array(toolCallSchema).optional(),
      incomplete_tool_calls: z.array(incompleteToolCallSchema).optional(),
    }),
    z.object({
      role: z.literal('tool'),
      content: z.string(),
      content_parts: userContentPartsSchema.optional(),
      tool_call_id: z.string(),
      tool_name: z.string(),
      status: z.enum(['success', 'error']).optional(),
      error: toolErrorSchema.optional(),
    }),
  ])
  .transform((message): ModelMessage => {
    switch (message.role) {
      case 'system':
        return { role: message.role, content: message.content };
      case 'user':
        return {
          role: message.role,
          content: message.content,
          ...(message.content_parts === undefined ? {} : { content_parts: message.content_parts }),
        };
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content,
          ...(message.content_blocks === undefined
            ? {}
            : { content_blocks: message.content_blocks }),
          ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls }),
          ...(message.incomplete_tool_calls === undefined
            ? {}
            : {
                incomplete_tool_calls: message.incomplete_tool_calls.map((call) => ({
                  arguments_text: call.arguments_text,
                  error: call.error,
                  ...(call.id === undefined ? {} : { id: call.id }),
                  ...(call.name === undefined ? {} : { name: call.name }),
                })),
              }),
        };
      case 'tool':
        return {
          role: 'tool',
          content: message.content,
          ...(message.content_parts === undefined ? {} : { content_parts: message.content_parts }),
          tool_call_id: message.tool_call_id,
          tool_name: message.tool_name,
          ...(message.status === undefined ? {} : { status: message.status }),
          ...(message.error === undefined ? {} : { error: message.error }),
        };
    }
  });

export type ContextErrorCode =
  | 'invalid_identifier'
  | 'invalid_message'
  | 'invalid_query'
  | 'invalid_stored_data'
  | 'invalid_time'
  | 'message_not_found'
  | 'tool_call_name_mismatch'
  | 'tool_call_not_found'
  | 'tool_result_exists';

export class ContextError extends Error {
  readonly code: ContextErrorCode;

  constructor(code: ContextErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContextError';
    this.code = code;
  }
}

export interface ContextMessageRevision {
  revisionId: string;
  revisionNumber: number;
  content: string;
  createdAt: string;
  runId: string | null;
}

export type MessageSource =
  | 'user'
  | 'thread_call'
  | 'thread_response'
  | 'subagent_response'
  | 'automation'
  | 'thread_notification'
  | 'channel'
  | 'background_task';

export type ChannelId = 'wechat' | 'feishu';
export type ChannelReferenceKind = 'inbound' | 'delivery_failure';

export interface ChannelReference {
  channel: ChannelId;
  kind: ChannelReferenceKind;
  externalMessageId?: string | null | undefined;
  deliveryId?: string | null | undefined;
}

export interface AutomationReference {
  scheduleId: string;
  fireId: string;
  trigger: 'scheduled' | 'run_now';
  scheduledAt: string;
}

export interface DelegationKey {
  sourceThreadId: string;
  sourceAgentId: string;
  sourceToolCallId: string;
}

export interface ContextMessage {
  seq: number;
  messageId: string;
  threadId: string;
  agentId: string;
  createdAt: string;
  runId: string | null;
  supersededByRunId?: string | null;
  source?: MessageSource | null;
  delegation?: DelegationKey | null;
  sourceInputId?: string | null;
  sourceThreadId?: string | null;
  sourceAgentId?: string | null;
  automation?: AutomationReference | null;
  channel?: ChannelReference | null;
  responseUsage?: DetailedModelUsage;
  sendToUserEnabled?: boolean;
  attachments?: readonly AttachmentMetadata[] | undefined;
  message: ModelMessage;
  revisions: readonly ContextMessageRevision[];
}

export interface AppendContextMessageInput {
  threadId: string;
  agentId: string;
  message: ModelMessage;
  messageId?: string;
  createdAt?: string;
  runId?: string;
  source?: MessageSource;
  delegation?: DelegationKey;
  sourceInputId?: string;
  sourceThreadId?: string;
  sourceAgentId?: string;
  automation?: AutomationReference;
  channel?: ChannelReference;
  responseUsage?: DetailedModelUsage;
}

export interface ContextQuery {
  threadId: string;
  agentId: string;
  seq?: number;
  fromSeq?: number;
  toSeq?: number;
  query?: string;
  limit?: number;
  currentOnly?: boolean;
}

export interface ToolCallRelation {
  callId: string;
  toolName: string;
  assistantSeq: number;
  resultSeq: number | null;
  callType: 'complete' | 'incomplete';
}

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export function createId(): string {
  return randomUUID();
}

export function requireIdentifier(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new ContextError('invalid_identifier', `${field} must not be empty.`);
  }
  return value;
}

export function requireSequence(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ContextError('invalid_query', `${field} must be a positive safe integer.`);
  }
  return value;
}

export function isoTime(value: string | undefined, clock: Clock): string {
  const date = value === undefined ? clock() : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ContextError('invalid_time', 'Time must be a valid date.');
  }
  return date.toISOString();
}

export function currentModelMessage(record: ContextMessage): ModelMessage {
  const text = record.revisions.at(-1)?.content ?? record.message.content;
  if (
    (record.message.role === 'user' || record.message.role === 'tool') &&
    (record.attachments?.length ?? 0) > 0
  ) {
    return modelMessageSchema.parse({
      ...record.message,
      content: text,
      content_parts: (record.attachments ?? []).map((attachment) => ({
        type: 'attachment',
        attachment_id: attachment.attachmentId,
        ...(attachment.workspaceRequired === true ? { workspace_required: true } : {}),
        ...(attachment.workspaceStatus === 'completed' && attachment.path !== undefined
          ? { path: attachment.path }
          : {}),
      })),
    });
  }
  return modelMessageSchema.parse({ ...record.message, content: text });
}

export function parseResponseUsage(value: unknown): DetailedModelUsage {
  const result = responseUsageSchema.safeParse(value);
  if (!result.success) {
    throw new ContextError('invalid_message', 'Invalid response usage.', { cause: result.error });
  }
  return {
    input_tokens: result.data.input_tokens,
    output_tokens: result.data.output_tokens,
    ...(result.data.total_tokens === undefined ? {} : { total_tokens: result.data.total_tokens }),
    ...(result.data.prompt_tokens_details === undefined
      ? {}
      : { prompt_tokens_details: result.data.prompt_tokens_details }),
  };
}

export function parseModelMessage(value: unknown): ModelMessage {
  const result = modelMessageSchema.safeParse(value);
  if (!result.success) {
    throw new ContextError('invalid_message', 'Invalid model message.', { cause: result.error });
  }
  if (result.data.role === 'assistant') {
    const blocks = result.data.content_blocks;
    if (blocks !== undefined) {
      if (blocks.some((block, index) => block.block_index !== index)) {
        throw new ContextError('invalid_message', 'Content block indices must be consecutive.');
      }
      const content = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (content !== result.data.content) {
        throw new ContextError(
          'invalid_message',
          'Assistant content must contain only ordered text blocks.',
        );
      }
    }
    const ids = new Set<string>();
    const calls = [...(result.data.tool_calls ?? []), ...(result.data.incomplete_tool_calls ?? [])];
    for (const call of calls) {
      if (call.id === undefined) continue;
      if (ids.has(call.id)) {
        throw new ContextError('invalid_message', `Duplicate tool call id ${call.id}.`);
      }
      ids.add(call.id);
    }
  }
  return result.data;
}

export function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new ContextError('invalid_stored_data', `${field} contains invalid JSON.`, {
      cause: error,
    });
  }
}

export function jsonText(value: unknown, field: string): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('Value is not JSON serializable.');
    return text;
  } catch (error) {
    throw new ContextError('invalid_message', `${field} must be JSON serializable.`, {
      cause: error,
    });
  }
}
