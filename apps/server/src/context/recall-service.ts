import type { DatabaseSync } from 'node:sqlite';
import type { IncompleteToolCall, ModelMessage, ToolCall, ToolError } from '@kairos/agent-core';
import { z } from 'zod';
import { RecapStore } from '../recap/recap-store.js';
import type { Recap, RecapValidity } from '../recap/types.js';
import { ContextStore } from './context-store.js';
import type { ContextMessage } from './types.js';
import { currentModelMessage } from './types.js';

export interface RecallScope {
  threadId: string;
  agentId: string;
}

export type RecallAuthorizer = (scope: RecallScope) => boolean;

export type RecallErrorCode = 'invalid_query' | 'permission_denied';

export class RecallError extends Error {
  readonly code: RecallErrorCode;

  constructor(code: RecallErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RecallError';
    this.code = code;
  }
}

const scopeSchema = z.object({ threadId: z.string().min(1), agentId: z.string().min(1) }).strict();
const contextInputSchema = z
  .object({
    scope: scopeSchema,
    query: z.string().optional(),
    seq: z.number().int().positive().optional(),
    fromSeq: z.number().int().positive().optional(),
    toSeq: z.number().int().positive().optional(),
    afterSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
    maxContentChars: z.number().int().positive().optional(),
    contentOffset: z.number().int().nonnegative().optional(),
    structuredOffset: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.afterSeq !== undefined && input.fromSeq !== undefined) {
      context.addIssue({ code: 'custom', message: 'afterSeq and fromSeq are mutually exclusive.' });
    }
    if (input.contentOffset !== undefined && input.seq === undefined) {
      context.addIssue({ code: 'custom', message: 'contentOffset requires seq.' });
    }
    if (input.structuredOffset !== undefined && input.seq === undefined) {
      context.addIssue({ code: 'custom', message: 'structuredOffset requires seq.' });
    }
  });
const recapInputSchema = z
  .object({
    scope: scopeSchema,
    query: z.string().optional(),
    recapId: z.string().min(1).optional(),
    fromSeq: z.number().int().positive().optional(),
    toSeq: z.number().int().positive().optional(),
    includeInvalid: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
    maxContentChars: z.number().int().positive().optional(),
    contentOffset: z.number().int().nonnegative().optional(),
    structuredOffset: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.contentOffset !== undefined && input.recapId === undefined) {
      context.addIssue({ code: 'custom', message: 'contentOffset requires recapId.' });
    }
    if (input.structuredOffset !== undefined && input.recapId === undefined) {
      context.addIssue({ code: 'custom', message: 'structuredOffset requires recapId.' });
    }
  });

export interface RecallContextInput {
  scope: RecallScope;
  query?: string | undefined;
  seq?: number | undefined;
  fromSeq?: number | undefined;
  toSeq?: number | undefined;
  afterSeq?: number | undefined;
  limit?: number | undefined;
  maxContentChars?: number | undefined;
  contentOffset?: number | undefined;
  structuredOffset?: number | undefined;
}

export interface RecallRecapInput {
  scope: RecallScope;
  query?: string | undefined;
  recapId?: string | undefined;
  fromSeq?: number | undefined;
  toSeq?: number | undefined;
  includeInvalid?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  maxContentChars?: number | undefined;
  contentOffset?: number | undefined;
  structuredOffset?: number | undefined;
}

export interface RecalledContextMessage {
  seq: number;
  role: ModelMessage['role'];
  content: string;
  created_at: string;
  tool_calls?: readonly ToolCall[];
  tool_calls_json?: string;
  incomplete_tool_calls?: readonly IncompleteToolCall[];
  incomplete_tool_calls_json?: string;
  tool_call_id?: string;
  tool_name?: string;
  status?: 'success' | 'error';
  error?: ToolError;
  error_json?: string;
  structured_offset?: number;
  structured_truncated?: boolean;
  next_structured_offset?: number;
  revision_number?: number;
  content_offset?: number;
  content_truncated?: boolean;
  next_content_offset?: number;
}

export interface ContextRecallResult {
  messages: RecalledContextMessage[];
  has_more: boolean;
  next_after_seq?: number;
}

export interface RecalledRecap {
  recap_id: string;
  content: string;
  source_message_seqs?: readonly number[];
  source_message_seqs_json?: string;
  source_created_at_start: string;
  source_created_at_end: string;
  created_at: string;
  validity: RecapValidity;
  structured_offset?: number;
  structured_truncated?: boolean;
  next_structured_offset?: number;
  content_offset?: number;
  content_truncated?: boolean;
  next_content_offset?: number;
}

export interface RecapRecallResult {
  recaps: RecalledRecap[];
  has_more: boolean;
  next_offset?: number;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RecallError('invalid_query', 'Invalid recall query.', { cause: result.error });
  }
  return result.data;
}

type StructuredField<T> =
  | { kind: 'value'; value: T }
  | { kind: 'json'; json: string; truncated: boolean };

function sliceStructured<T>(value: T, offset: number, limit: number): StructuredField<T> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Could not serialize a recalled field.');
  if (offset === 0 && serialized.length <= limit) return { kind: 'value', value };
  const json = serialized.slice(offset, offset + limit);
  return { kind: 'json', json, truncated: offset + json.length < serialized.length };
}

function structuredProperties<T>(
  field: StructuredField<T>,
  valueName: string,
  jsonName: string,
): Record<string, unknown> {
  return field.kind === 'value' ? { [valueName]: field.value } : { [jsonName]: field.json };
}

export class RecallService {
  readonly #context: ContextStore;
  readonly #recaps: RecapStore;
  readonly #authorize: RecallAuthorizer;
  readonly #resultLimit: number;
  readonly #contentLimit: number;

  constructor(
    database: DatabaseSync,
    authorize: RecallAuthorizer,
    options: { resultLimit?: number; contentLimit?: number } = {},
  ) {
    this.#context = new ContextStore(database);
    this.#recaps = new RecapStore(database);
    this.#authorize = authorize;
    this.#resultLimit = Math.min(options.resultLimit ?? 20, 20);
    this.#contentLimit = Math.min(options.contentLimit ?? 4000, 4000);
  }

  recallContext(input: unknown): ContextRecallResult {
    const query = parseInput(contextInputSchema, input);
    this.#authorizeScope(query.scope);
    const limit = Math.min(query.limit ?? this.#resultLimit, this.#resultLimit);
    const contentLimit = Math.min(query.maxContentChars ?? this.#contentLimit, this.#contentLimit);
    const fromSeq =
      query.afterSeq === undefined ? query.fromSeq : requireAfterSequence(query.afterSeq);
    const records = this.#context.query({
      threadId: query.scope.threadId,
      agentId: query.scope.agentId,
      ...(query.seq === undefined ? {} : { seq: query.seq }),
      ...(fromSeq === undefined ? {} : { fromSeq }),
      ...(query.toSeq === undefined ? {} : { toSeq: query.toSeq }),
      ...(query.query === undefined ? {} : { query: query.query }),
      currentOnly: true,
      limit: limit + 1,
    });
    const hasExtraRecord = records.length > limit;
    const selected = records.slice(0, limit);
    const messages = selected.map((record) =>
      this.#contextItem(
        record,
        query.contentOffset ?? 0,
        query.structuredOffset ?? 0,
        contentLimit,
      ),
    );
    const last = selected.at(-1);
    return {
      messages,
      has_more:
        hasExtraRecord ||
        messages.some(
          (message) => message.content_truncated === true || message.structured_truncated === true,
        ),
      ...(hasExtraRecord && last ? { next_after_seq: last.seq } : {}),
    };
  }

  recallRecap(input: unknown): RecapRecallResult {
    const query = parseInput(recapInputSchema, input);
    this.#authorizeScope(query.scope);
    const limit = Math.min(query.limit ?? this.#resultLimit, this.#resultLimit);
    const contentLimit = Math.min(query.maxContentChars ?? this.#contentLimit, this.#contentLimit);
    const offset = query.offset ?? 0;
    const currentSourceSeqs = new Set(
      this.#context
        .query({
          threadId: query.scope.threadId,
          agentId: query.scope.agentId,
          currentOnly: true,
        })
        .map((message) => message.seq),
    );
    const records = this.#recaps
      .query({
        threadId: query.scope.threadId,
        agentId: query.scope.agentId,
        ...(query.recapId === undefined ? {} : { recapId: query.recapId }),
        ...(query.includeInvalid === true ? {} : { validity: 'valid' }),
        ...(query.query === undefined ? {} : { query: query.query }),
        ...(query.fromSeq === undefined ? {} : { fromSeq: query.fromSeq }),
        ...(query.toSeq === undefined ? {} : { toSeq: query.toSeq }),
      })
      .filter((recap) => recap.sourceMessageSeqs.every((seq) => currentSourceSeqs.has(seq)));
    const page = records.slice(offset, offset + limit + 1);
    const hasExtraRecord = page.length > limit;
    const selected = page.slice(0, limit);
    const recaps = selected.map((recap) =>
      this.#recapItem(recap, query.contentOffset ?? 0, query.structuredOffset ?? 0, contentLimit),
    );
    return {
      recaps,
      has_more:
        hasExtraRecord ||
        recaps.some(
          (recap) => recap.content_truncated === true || recap.structured_truncated === true,
        ),
      ...(hasExtraRecord ? { next_offset: offset + selected.length } : {}),
    };
  }

  #authorizeScope(scope: RecallScope): void {
    if (this.#authorize(scope) !== true) {
      throw new RecallError('permission_denied', 'The requested context scope is not authorized.');
    }
  }

  #contextItem(
    record: ContextMessage,
    contentOffset: number,
    structuredOffset: number,
    contentLimit: number,
  ): RecalledContextMessage {
    const message = currentModelMessage(record);
    const content = message.content.slice(contentOffset, contentOffset + contentLimit);
    const nextOffset = contentOffset + content.length;
    const truncated = nextOffset < message.content.length;
    const toolCalls =
      message.role === 'assistant' && message.tool_calls !== undefined
        ? sliceStructured(message.tool_calls, structuredOffset, contentLimit)
        : undefined;
    const incompleteToolCalls =
      message.role === 'assistant' && message.incomplete_tool_calls !== undefined
        ? sliceStructured(message.incomplete_tool_calls, structuredOffset, contentLimit)
        : undefined;
    const toolError =
      message.role === 'tool' && message.error !== undefined
        ? sliceStructured(message.error, structuredOffset, contentLimit)
        : undefined;
    const structuredTruncated =
      (toolCalls?.kind === 'json' && toolCalls.truncated) ||
      (incompleteToolCalls?.kind === 'json' && incompleteToolCalls.truncated) ||
      (toolError?.kind === 'json' && toolError.truncated);
    return {
      seq: record.seq,
      role: message.role,
      content,
      created_at: record.createdAt,
      ...(toolCalls ? structuredProperties(toolCalls, 'tool_calls', 'tool_calls_json') : {}),
      ...(incompleteToolCalls
        ? structuredProperties(
            incompleteToolCalls,
            'incomplete_tool_calls',
            'incomplete_tool_calls_json',
          )
        : {}),
      ...(message.role === 'tool'
        ? {
            tool_call_id: message.tool_call_id,
            tool_name: message.tool_name,
            ...(message.status === undefined ? {} : { status: message.status }),
          }
        : {}),
      ...(toolError ? structuredProperties(toolError, 'error', 'error_json') : {}),
      ...(structuredOffset > 0 ? { structured_offset: structuredOffset } : {}),
      ...(structuredTruncated
        ? {
            structured_truncated: true,
            next_structured_offset: structuredOffset + contentLimit,
          }
        : {}),
      ...(record.revisions.length > 0
        ? { revision_number: record.revisions.at(-1)?.revisionNumber ?? 0 }
        : {}),
      ...(contentOffset > 0 ? { content_offset: contentOffset } : {}),
      ...(truncated ? { content_truncated: true, next_content_offset: nextOffset } : {}),
    };
  }

  #recapItem(
    recap: Recap,
    contentOffset: number,
    structuredOffset: number,
    contentLimit: number,
  ): RecalledRecap {
    const content = recap.content.slice(contentOffset, contentOffset + contentLimit);
    const nextOffset = contentOffset + content.length;
    const truncated = nextOffset < recap.content.length;
    const sources = sliceStructured(recap.sourceMessageSeqs, structuredOffset, contentLimit);
    const structuredTruncated = sources.kind === 'json' && sources.truncated;
    return {
      recap_id: recap.recapId,
      content,
      ...structuredProperties(sources, 'source_message_seqs', 'source_message_seqs_json'),
      source_created_at_start: recap.sourceCreatedAtStart,
      source_created_at_end: recap.sourceCreatedAtEnd,
      created_at: recap.createdAt,
      validity: recap.validity,
      ...(structuredOffset > 0 ? { structured_offset: structuredOffset } : {}),
      ...(structuredTruncated
        ? {
            structured_truncated: true,
            next_structured_offset: structuredOffset + contentLimit,
          }
        : {}),
      ...(contentOffset > 0 ? { content_offset: contentOffset } : {}),
      ...(truncated ? { content_truncated: true, next_content_offset: nextOffset } : {}),
    };
  }
}

function requireAfterSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new RecallError('invalid_query', 'afterSeq is outside the supported sequence range.');
  }
  return value + 1;
}
