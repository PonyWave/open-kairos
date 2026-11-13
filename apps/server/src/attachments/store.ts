import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ModelRequest, UserContentBlock } from '@kairos/agent-core';
import { z } from 'zod';
import { type Clock, isoTime, systemClock } from '../context/types.js';
import { SessionError } from '../sessions/errors.js';
import type { ActionInput } from '../sessions/store.js';
import type { AttachmentContent, AttachmentMetadata } from './types.js';
import { attachmentMetadataSchema } from './types.js';
import {
  decodeTextAttachment,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENTS_PER_INPUT,
  MAX_DOWNLOAD_BYTES,
  MAX_TEXT_ATTACHMENT_TOTAL_BYTES,
  maximumUploadBytes,
  validateAttachmentBytes,
  validateChannelAttachmentBytes,
  validateFileName,
} from './validation.js';

const metadataColumns = `
  attachment_id, owner_id, file_name, media_type, byte_size, sha256, width, height, created_at
`;
const rowSchema = z.object({
  attachment_id: z.string(),
  owner_id: z.string(),
  file_name: z.string(),
  media_type: z.enum(['text/plain', 'image/png', 'image/jpeg', 'application/octet-stream']),
  byte_size: z.number().int().positive().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.instanceof(Uint8Array),
  width: z.number().int().positive().safe().nullable(),
  height: z.number().int().positive().safe().nullable(),
  created_at: z.string(),
  source: z.enum(['file', 'clipboard', 'channel']).nullable().optional(),
  workspace_required: z.number().int().min(0).max(1).nullable().optional(),
  workspace_status: z.enum(['pending', 'completed']).nullable().optional(),
  env_id: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  operation_id: z.string().nullable().optional(),
});
type AttachmentRow = z.infer<typeof rowSchema>;
type ActionRunner = <T>(action: ActionInput, responseSchema: z.ZodType<T>, work: () => T) => T;

const uploadResponseSchema = z.object({ attachment: attachmentMetadataSchema });
const deleteResponseSchema = z.object({ attachmentId: z.string(), deleted: z.boolean() });

export interface AttachmentStoreOptions {
  clock?: Clock;
  createId?: () => string;
  maxRpcBytes?: number;
  runAction: ActionRunner;
}

export class AttachmentStore {
  readonly #database: DatabaseSync;
  readonly #clock: Clock;
  readonly #createId: () => string;
  readonly #maximumUploadBytes: number;
  readonly #runAction: ActionRunner;

  constructor(database: DatabaseSync, options: AttachmentStoreOptions) {
    this.#database = database;
    this.#clock = options.clock ?? systemClock;
    this.#createId = options.createId ?? randomUUID;
    this.#maximumUploadBytes = maximumUploadBytes(options.maxRpcBytes ?? 1024 * 1024);
    this.#runAction = options.runAction;
  }

  upload(input: {
    ownerId: string;
    clientActionId: string;
    fileName: string;
    declaredMediaType?: string;
    bytes: Uint8Array;
    source?: 'file' | 'clipboard';
  }): {
    attachment: AttachmentMetadata;
  } {
    const source = input.source ?? 'file';
    const fileName = validateFileName(input.fileName);
    const declaredMediaType = input.declaredMediaType ?? '';
    if (
      declaredMediaType !== '' &&
      !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(
        declaredMediaType,
      )
    ) {
      throw new SessionError('invalid_argument', 'declaredMediaType must be a valid MIME type.');
    }
    if (input.bytes.length > this.#maximumUploadBytes) {
      throw new SessionError(
        'input_too_large',
        'Attachment exceeds the configured RPC or attachment byte limit.',
      );
    }
    const validated = validateAttachmentBytes(input.bytes);
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    return this.#runAction(
      {
        ownerId: input.ownerId,
        clientActionId: input.clientActionId,
        method: 'UploadAttachment',
        parameters: { fileName, declaredMediaType, byteSize: input.bytes.length, sha256, source },
      },
      uploadResponseSchema,
      () => {
        const existing = this.#byHash(input.ownerId, sha256);
        if (existing) {
          if (!equalBytes(existing.bytes, input.bytes)) {
            throw new SessionError('internal', 'Attachment SHA-256 collision detected.');
          }
          return { attachment: { ...metadata(existing), source } };
        }
        const createdAt = isoTime(undefined, this.#clock);
        const attachmentId = this.#createId();
        this.#database
          .prepare(
            `INSERT INTO attachments(
              attachment_id, owner_id, file_name, media_type, byte_size, sha256, content,
              width, height, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            attachmentId,
            input.ownerId,
            fileName,
            validated.mediaType,
            input.bytes.length,
            sha256,
            input.bytes,
            validated.width ?? null,
            validated.height ?? null,
            createdAt,
          );
        return {
          attachment: { ...metadata(this.#readById(attachmentId, true)), source },
        };
      },
    );
  }

  uploadChannel(input: {
    ownerId: string;
    fileName: string;
    bytes: Uint8Array;
  }): AttachmentMetadata {
    const fileName = validateFileName(input.fileName);
    const validated = validateChannelAttachmentBytes(input.bytes);
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const existing = this.#byHash(input.ownerId, sha256);
    if (existing) {
      if (!equalBytes(existing.bytes, input.bytes)) {
        throw new SessionError('internal', 'Attachment SHA-256 collision detected.');
      }
      return { ...metadata(existing), source: 'channel' };
    }
    const createdAt = isoTime(undefined, this.#clock);
    const attachmentId = this.#createId();
    this.#database
      .prepare(
        `INSERT INTO attachments(
          attachment_id, owner_id, file_name, media_type, byte_size, sha256, content,
          width, height, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attachmentId,
        input.ownerId,
        fileName,
        validated.mediaType,
        input.bytes.length,
        sha256,
        input.bytes,
        validated.width ?? null,
        validated.height ?? null,
        createdAt,
      );
    return { ...metadata(this.#readById(attachmentId, true)), source: 'channel' };
  }

  selectForChannelInput(
    ownerId: string,
    attachmentIds: readonly string[],
  ): AttachmentMetadata[] {
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_INPUT) {
      throw new SessionError('input_too_large', 'An input can contain at most four attachments.');
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new SessionError('invalid_argument', 'Attachment IDs must not contain duplicates.');
    }
    return attachmentIds.map((value) => ({
      ...metadata(this.#readOwned(ownerId, requireAttachmentId(value), false)),
      source: 'channel' as const,
    }));
  }

  remove(input: { ownerId: string; clientActionId: string; attachmentId: string }) {
    const attachmentId = requireAttachmentId(input.attachmentId);
    return this.#runAction(
      {
        ownerId: input.ownerId,
        clientActionId: input.clientActionId,
        method: 'DeleteAttachment',
        parameters: { attachmentId },
      },
      deleteResponseSchema,
      () => {
        this.#readOwned(input.ownerId, attachmentId, false);
        const result = this.#database
          .prepare(
            `DELETE FROM attachments
             WHERE attachment_id = ? AND owner_id = ?
               AND NOT EXISTS (SELECT 1 FROM input_attachments WHERE attachment_id = ?)
               AND NOT EXISTS (
                 SELECT 1 FROM context_message_attachments WHERE attachment_id = ?
               )`,
          )
          .run(attachmentId, input.ownerId, attachmentId, attachmentId);
        return { attachmentId, deleted: result.changes === 1 };
      },
    );
  }

  download(input: {
    ownerId: string;
    attachmentId: string;
    offset?: bigint | undefined;
    limitBytes: number;
  }): { attachment: AttachmentMetadata; data: Uint8Array; nextOffset?: bigint } {
    const attachmentId = requireAttachmentId(input.attachmentId);
    if (
      !Number.isSafeInteger(input.limitBytes) ||
      input.limitBytes <= 0 ||
      input.limitBytes > MAX_DOWNLOAD_BYTES
    ) {
      throw new SessionError(
        'invalid_argument',
        `limitBytes must be between 1 and ${MAX_DOWNLOAD_BYTES}.`,
      );
    }
    const offset = input.offset ?? 0n;
    if (offset < 0n) throw new SessionError('invalid_argument', 'offset must not be negative.');
    const record = this.#readOwned(input.ownerId, attachmentId, true);
    if (offset > BigInt(record.byteSize)) {
      throw new SessionError('invalid_argument', 'offset exceeds the attachment size.');
    }
    const start = Number(offset);
    const end = Math.min(start + input.limitBytes, record.byteSize);
    return {
      attachment: metadata(record),
      data: record.bytes.slice(start, end),
      ...(end < record.byteSize ? { nextOffset: BigInt(end) } : {}),
    };
  }

  selectForInput(
    ownerId: string,
    attachmentIds: readonly string[],
    clipboardAttachmentIds: readonly string[] = [],
  ): AttachmentMetadata[] {
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_INPUT) {
      throw new SessionError('input_too_large', 'An input can contain at most four attachments.');
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new SessionError('invalid_argument', 'Attachment IDs must not contain duplicates.');
    }
    const clipboard = new Set(clipboardAttachmentIds.map(requireAttachmentId));
    if (clipboard.size !== clipboardAttachmentIds.length) {
      throw new SessionError('invalid_argument', 'Clipboard attachment IDs must not repeat.');
    }
    if (clipboardAttachmentIds.some((attachmentId) => !attachmentIds.includes(attachmentId))) {
      throw new SessionError(
        'invalid_argument',
        'Clipboard attachment IDs must reference the selected attachments.',
      );
    }
    let totalBytes = 0;
    let textBytes = 0;
    return attachmentIds.map((value) => {
      const attachment = this.#readOwned(ownerId, requireAttachmentId(value), false);
      totalBytes += attachment.byteSize;
      if (attachment.mediaType === 'text/plain') textBytes += attachment.byteSize;
      if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
        throw new SessionError(
          'input_too_large',
          'Attachments exceed the 2800000-byte input limit.',
        );
      }
      if (textBytes > MAX_TEXT_ATTACHMENT_TOTAL_BYTES) {
        throw new SessionError(
          'input_too_large',
          'Text attachments exceed the 256 KiB input limit.',
        );
      }
      return { ...metadata(attachment), source: clipboard.has(value) ? 'clipboard' : 'file' };
    });
  }

  linkInput(inputId: string, attachments: readonly AttachmentMetadata[]): void {
    const insert = this.#database.prepare(
      `INSERT INTO input_attachments(
        input_id, position, attachment_id, source, workspace_required, workspace_status
      ) VALUES (?, ?, ?, ?, 1, 'pending')`,
    );
    attachments.forEach((attachment, index) => {
      insert.run(inputId, index + 1, attachment.attachmentId, attachment.source ?? 'file');
    });
  }

  linkMessageFromInput(messageSeq: number, inputId: string): void {
    this.#database
      .prepare(
        `INSERT INTO context_message_attachments(
          message_seq, position, attachment_id, source, workspace_required, workspace_status,
          env_id, path, operation_id
        )
         SELECT ?, position, attachment_id, source, workspace_required, workspace_status,
           env_id, path, operation_id FROM input_attachments WHERE input_id = ?`,
      )
      .run(messageSeq, inputId);
  }

  listForInput(inputId: string): AttachmentMetadata[] {
    const rows = z.array(rowSchema).parse(
      this.#database
        .prepare(
          `SELECT ${metadataColumns}, x'' AS content,
             input_attachments.source, input_attachments.workspace_required,
             input_attachments.workspace_status, input_attachments.env_id,
             input_attachments.path, input_attachments.operation_id
           FROM attachments
           JOIN input_attachments USING(attachment_id)
           WHERE input_attachments.input_id = ? ORDER BY input_attachments.position`,
        )
        .all(inputId),
    );
    const expected = z
      .object({ count: z.number().int().nonnegative() })
      .parse(
        this.#database
          .prepare('SELECT COUNT(*) AS count FROM input_attachments WHERE input_id = ?')
          .get(inputId),
      ).count;
    if (rows.length !== expected) {
      throw new SessionError('internal', 'A stored input attachment is missing its content.');
    }
    return rows.map(metadata);
  }

  static listForMessage(database: DatabaseSync, messageSeq: number): AttachmentMetadata[] {
    const rows = z.array(rowSchema).parse(
      database
        .prepare(
          `SELECT ${metadataColumns}, x'' AS content,
             context_message_attachments.source, context_message_attachments.workspace_required,
             context_message_attachments.workspace_status, context_message_attachments.env_id,
             context_message_attachments.path, context_message_attachments.operation_id
           FROM attachments
           JOIN context_message_attachments USING(attachment_id)
           WHERE context_message_attachments.message_seq = ?
           ORDER BY context_message_attachments.position`,
        )
        .all(messageSeq),
    );
    const expected = z
      .object({ count: z.number().int().nonnegative() })
      .parse(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM context_message_attachments WHERE message_seq = ?',
          )
          .get(messageSeq),
      ).count;
    if (rows.length !== expected) {
      throw new SessionError('internal', 'A stored Context attachment is missing its content.');
    }
    return rows.map(metadata);
  }

  listForMessage(messageSeq: number): AttachmentMetadata[] {
    return AttachmentStore.listForMessage(this.#database, messageSeq);
  }

  listPendingWorkspace(
    threadId: string,
    agentId: string,
  ): Array<{
    messageSeq: number;
    inputId: string | null;
    attachment: AttachmentMetadata;
  }> {
    const schema = rowSchema.extend({
      message_seq: z.number().int().positive(),
      source_input_id: z.string().nullable(),
    });
    return z
      .array(schema)
      .parse(
        this.#database
          .prepare(
            `SELECT link.message_seq, message.source_input_id,
               attachments.attachment_id, attachments.owner_id, attachments.file_name,
               attachments.media_type, attachments.byte_size, attachments.sha256,
               x'' AS content, attachments.width, attachments.height, attachments.created_at,
               link.source, link.workspace_required, link.workspace_status,
               link.env_id, link.path, link.operation_id
             FROM context_message_attachments AS link
             JOIN context_messages AS message ON message.seq = link.message_seq
             JOIN attachments ON attachments.attachment_id = link.attachment_id
             WHERE message.thread_id = ? AND message.agent_id = ?
               AND message.superseded_by_run_id IS NULL AND link.workspace_required = 1
               AND link.workspace_status = 'pending'
             ORDER BY link.message_seq, link.position`,
          )
          .all(threadId, agentId),
      )
      .map((row) => ({
        messageSeq: row.message_seq,
        inputId: row.source_input_id,
        attachment: metadata(row),
      }));
  }

  findCompletedWorkspace(
    ownerId: string,
    attachmentId: string,
    envId: string,
    path: string,
    cwd: string,
  ): AttachmentMetadata | undefined {
    const hasOperations =
      this.#database
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'environment_operations'",
        )
        .get() !== undefined;
    const row = this.#database
      .prepare(
        `SELECT ${metadataColumns}, x'' AS content,
           context_message_attachments.source, context_message_attachments.workspace_required,
           context_message_attachments.workspace_status, context_message_attachments.env_id,
           context_message_attachments.path, context_message_attachments.operation_id
         FROM attachments
         JOIN context_message_attachments USING(attachment_id)
         WHERE attachments.owner_id = ? AND attachments.attachment_id = ?
           AND context_message_attachments.workspace_required = 1
           AND context_message_attachments.workspace_status = 'completed'
           AND context_message_attachments.env_id = ?
           AND ${
             hasOperations
               ? `(
                   context_message_attachments.path = ?
                   OR EXISTS (
                     SELECT 1 FROM environment_operations AS operation
                     WHERE operation.operation_id = context_message_attachments.operation_id
                       AND operation.cwd = ?
                   )
                 )`
               : 'context_message_attachments.path = ?'
           }
           AND context_message_attachments.operation_id IS NOT NULL
         LIMIT 1`,
      )
      .get(ownerId, attachmentId, envId, path, ...(hasOperations ? [cwd] : []));
    return row === undefined ? undefined : metadata(rowSchema.parse(row));
  }

  readForWorkspace(ownerId: string, attachmentId: string): AttachmentContent {
    return this.#readOwned(ownerId, requireAttachmentId(attachmentId), true);
  }

  stageWorkspace(input: {
    messageSeq: number;
    inputId: string | null;
    attachmentId: string;
    envId: string;
    path: string;
    operationId: string;
    status: 'pending' | 'completed';
  }): void {
    const values = [input.envId, input.path, input.operationId, input.status] as const;
    const context = this.#database
      .prepare(
        `UPDATE context_message_attachments
         SET env_id = ?, path = ?, operation_id = ?, workspace_status = ?
         WHERE message_seq = ? AND attachment_id = ?
           AND workspace_required = 1 AND workspace_status = 'pending'`,
      )
      .run(...values, input.messageSeq, input.attachmentId);
    if (context.changes !== 1) {
      throw new SessionError('action_conflict', 'The Context attachment location changed.');
    }
    if (input.inputId === null) return;
    const source = this.#database
      .prepare(
        `UPDATE input_attachments
         SET env_id = ?, path = ?, operation_id = ?, workspace_status = ?
         WHERE input_id = ? AND attachment_id = ?
           AND workspace_required = 1 AND workspace_status = 'pending'`,
      )
      .run(...values, input.inputId, input.attachmentId);
    if (source.changes !== 1) {
      throw new SessionError('action_conflict', 'The Input attachment location changed.');
    }
  }

  createToolImage(input: {
    ownerId: string;
    fileName: string;
    bytes: Uint8Array;
    expectedSha256: string;
  }): AttachmentMetadata {
    const fileName = validateFileName(input.fileName);
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    if (sha256 !== input.expectedSha256) {
      throw new SessionError('invalid_argument', 'Image content does not match its SHA-256.');
    }
    const validated = validateAttachmentBytes(input.bytes);
    if (validated.mediaType === 'text/plain') {
      throw new SessionError('invalid_argument', 'read_image supports only PNG and JPEG files.');
    }
    const existing = this.#byHash(input.ownerId, sha256);
    if (existing) {
      if (!equalBytes(existing.bytes, input.bytes)) {
        throw new SessionError('internal', 'Attachment SHA-256 collision detected.');
      }
      return metadata(existing);
    }
    const attachmentId = this.#createId();
    const createdAt = isoTime(undefined, this.#clock);
    this.#database
      .prepare(
        `INSERT INTO attachments(
          attachment_id, owner_id, file_name, media_type, byte_size, sha256, content,
          width, height, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attachmentId,
        input.ownerId,
        fileName,
        validated.mediaType,
        input.bytes.length,
        sha256,
        input.bytes,
        validated.width ?? null,
        validated.height ?? null,
        createdAt,
      );
    return metadata(this.#readById(attachmentId, false));
  }

  linkMessage(messageSeq: number, ownerId: string, attachmentIds: readonly string[]): void {
    if (!Number.isSafeInteger(messageSeq) || messageSeq <= 0) {
      throw new SessionError('internal', 'A valid Context message sequence is required.');
    }
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_INPUT) {
      throw new SessionError(
        'input_too_large',
        'A tool result can contain at most four attachments.',
      );
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new SessionError('invalid_argument', 'Attachment IDs must not contain duplicates.');
    }
    const insert = this.#database.prepare(
      'INSERT INTO context_message_attachments(message_seq, position, attachment_id) VALUES (?, ?, ?)',
    );
    attachmentIds.forEach((value, index) => {
      const attachment = this.#readOwned(ownerId, requireAttachmentId(value), false);
      insert.run(messageSeq, index + 1, attachment.attachmentId);
    });
  }

  materializeRequest(request: ModelRequest): ModelRequest {
    return {
      tools: request.tools,
      messages: request.messages.map((message) => {
        if (
          (message.role !== 'user' && message.role !== 'tool') ||
          message.content_parts === undefined
        ) {
          return message;
        }
        const contentParts: UserContentBlock[] = [];
        for (const block of message.content_parts) {
          if (block.type !== 'attachment') {
            contentParts.push(block);
            continue;
          }
          if (block.workspace_required === true && block.path === undefined) {
            throw new SessionError(
              'failed_precondition',
              'An attachment must be written to the tenant sandbox before model dispatch.',
            );
          }
          const attachment = this.#readById(block.attachment_id, true);
          const bytes = attachment.bytes;
          const validated = validateAttachmentBytes(bytes);
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          if (
            sha256 !== attachment.sha256 ||
            validated.mediaType !== attachment.mediaType ||
            validated.width !== attachment.width ||
            validated.height !== attachment.height
          ) {
            throw new SessionError('internal', 'Stored attachment content failed validation.');
          }
          const location =
            block.path === undefined
              ? ''
              : `\nOriginal sandbox file: ${block.path}\nUse ${
                  attachment.mediaType === 'text/plain' ? 'read' : 'read_image'
                } with this path and omit env_id to read the original file later.`;
          contentParts.push({
            type: 'text',
            text: `Attachment: ${attachment.fileName}${location}`,
          });
          if (attachment.mediaType === 'text/plain') {
            contentParts.push({ type: 'text', text: decodeTextAttachment(bytes) });
          } else {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${attachment.mediaType};base64,${Buffer.from(bytes).toString('base64')}`,
                detail: 'low',
              },
            });
          }
        }
        return { ...message, content_parts: contentParts };
      }),
    };
  }

  #byHash(ownerId: string, sha256: string): AttachmentContent | undefined {
    const row = this.#database
      .prepare(
        `SELECT ${metadataColumns}, content FROM attachments WHERE owner_id = ? AND sha256 = ?`,
      )
      .get(ownerId, sha256);
    return row === undefined ? undefined : content(rowSchema.parse(row));
  }

  #readOwned(ownerId: string, attachmentId: string, withBytes: true): AttachmentContent;
  #readOwned(ownerId: string, attachmentId: string, withBytes: false): AttachmentContent;
  #readOwned(ownerId: string, attachmentId: string, withBytes: boolean): AttachmentContent {
    const record = this.#readById(attachmentId, withBytes);
    if (record.ownerId !== ownerId) {
      throw new SessionError('permission_denied', 'Attachment is not available to this owner.');
    }
    return record;
  }

  #readById(attachmentId: string, withBytes = true): AttachmentContent {
    const row = this.#database
      .prepare(
        `SELECT ${metadataColumns}${withBytes ? ', content' : ", x'' AS content"} FROM attachments WHERE attachment_id = ?`,
      )
      .get(attachmentId);
    if (row === undefined) throw new SessionError('not_found', 'Attachment was not found.');
    return content(rowSchema.parse(row));
  }
}

function content(row: AttachmentRow): AttachmentContent {
  return {
    ...metadata(row),
    ownerId: row.owner_id,
    bytes: row.content,
    sha256: row.sha256,
  };
}

function metadata(row: AttachmentRow | AttachmentContent): AttachmentMetadata {
  if ('attachmentId' in row) {
    return {
      attachmentId: row.attachmentId,
      fileName: row.fileName,
      mediaType: row.mediaType,
      byteSize: row.byteSize,
      ...(row.width === undefined ? {} : { width: row.width }),
      ...(row.height === undefined ? {} : { height: row.height }),
      sha256: row.sha256,
      createdAt: row.createdAt,
      ...(row.source === undefined ? {} : { source: row.source }),
      ...(row.workspaceRequired === undefined ? {} : { workspaceRequired: row.workspaceRequired }),
      ...(row.workspaceStatus === undefined ? {} : { workspaceStatus: row.workspaceStatus }),
      ...(row.envId === undefined ? {} : { envId: row.envId }),
      ...(row.path === undefined ? {} : { path: row.path }),
      ...(row.operationId === undefined ? {} : { operationId: row.operationId }),
    };
  }
  return {
    attachmentId: row.attachment_id,
    fileName: row.file_name,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
    sha256: row.sha256,
    createdAt: row.created_at,
    ...(row.source === null || row.source === undefined ? {} : { source: row.source }),
    ...(row.workspace_required === null || row.workspace_required === undefined
      ? {}
      : { workspaceRequired: row.workspace_required === 1 }),
    ...(row.workspace_status === null || row.workspace_status === undefined
      ? {}
      : { workspaceStatus: row.workspace_status }),
    ...(row.env_id === null || row.env_id === undefined ? {} : { envId: row.env_id }),
    ...(row.path === null || row.path === undefined ? {} : { path: row.path }),
    ...(row.operation_id === null || row.operation_id === undefined
      ? {}
      : { operationId: row.operation_id }),
  };
}

function requireAttachmentId(value: string): string {
  if (value.trim().length === 0 || value.length > 200) {
    throw new SessionError('invalid_argument', 'attachmentId must not be empty.');
  }
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
