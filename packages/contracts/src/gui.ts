import { create, fromBinary, fromJsonString, toBinary, toJsonString } from '@bufbuild/protobuf';

export { create, fromJsonString, toBinary, toJsonString };

import { validateEnvironmentPolicy } from './environment.js';
import { ContractValidationError } from './error.js';
import type {
  Attachment,
  CreateThreadRequest,
  DownloadAttachmentRequest,
  DownloadAttachmentResponse,
  GetModelStatusResponse,
  ReadBashLogRequest,
  ReadBashLogResponse,
  ReloadResourcesRequest,
  ReloadResourcesResponse,
  ThreadMessagePreview,
  UploadAttachmentRequest,
  WatchThreadResponse,
} from './gen/kairos/gui/v1/gui_pb.js';
import {
  AttachmentSource,
  BashLogStream,
  GetModelStatusResponseSchema,
  ReadBashLogRequestSchema,
  ReadBashLogResponseSchema,
  WatchThreadResponseSchema,
} from './gen/kairos/gui/v1/gui_pb.js';

export * from './gen/kairos/gui/v1/gui_pb.js';

type ReadBashLogRequestFields = Pick<ReadBashLogRequest, 'operationId' | 'offset' | 'limitBytes'>;

const maximumUint64 = (1n << 64n) - 1n;
const maximumUint32 = (1n << 32n) - 1n;

function reject(message: string): never {
  throw new ContractValidationError('INVALID_MESSAGE', message);
}

function requireIdentifier(value: string, field: string): void {
  if (!value.trim()) reject(`${field} must not be empty.`);
}

function requireUint64(value: bigint | undefined, field: string): bigint {
  if (value === undefined || value < 0n || value > maximumUint64) {
    reject(`${field} must be a present uint64 value.`);
  }
  return value;
}

function requireUint32(value: number | undefined, field: string): number {
  if (
    value === undefined ||
    !Number.isInteger(value) ||
    value < 0 ||
    BigInt(value) > maximumUint32
  ) {
    reject(`${field} must be a present uint32 value.`);
  }
  return value;
}

export function validateCreateThreadRequest(request: CreateThreadRequest): void {
  requireIdentifier(request.clientActionId, 'CreateThreadRequest.client_action_id');
  requireIdentifier(request.title, 'CreateThreadRequest.title');
  if (request.environmentPolicy) {
    if (request.environmentPolicy.policyVersion !== 1n) {
      reject('CreateThreadRequest.environment_policy.policy_version must be 1.');
    }
    validateEnvironmentPolicy(request.environmentPolicy);
  }
}

export function validateReadBashLogRequest(request: ReadBashLogRequestFields): void {
  requireIdentifier(request.operationId, 'ReadBashLogRequest.operation_id');
  requireUint64(request.offset, 'ReadBashLogRequest.offset');
  if (requireUint32(request.limitBytes, 'ReadBashLogRequest.limit_bytes') === 0) {
    reject('ReadBashLogRequest.limit_bytes must be greater than zero.');
  }
}

export interface ReadBashLogResponseValidationOptions {
  allowUnexplainedOffsets?: boolean;
}

interface OffsetGap {
  startOffset: bigint;
  endOffset?: bigint;
}

function assertOffsetJumpCovered(start: bigint, end: bigint, gaps: readonly OffsetGap[]): void {
  if (start === end) return;
  let cursor = start;
  for (const gap of gaps) {
    if (gap.startOffset > cursor) break;
    if (gap.endOffset !== undefined && gap.endOffset <= cursor) continue;
    cursor = gap.endOffset ?? end;
    if (cursor >= end) return;
  }
  reject(`Offset jump [${start}, ${end}) is not fully explained by gaps.`);
}

export function validateReadBashLogResponse(
  response: ReadBashLogResponse,
  request?: ReadBashLogRequestFields,
  options?: ReadBashLogResponseValidationOptions,
): void {
  requireIdentifier(response.operationId, 'ReadBashLogResponse.operation_id');
  if (response.outputComplete === undefined) {
    reject('ReadBashLogResponse.output_complete must be present.');
  }
  if (response.expired === undefined) reject('ReadBashLogResponse.expired must be present.');
  if (request) {
    validateReadBashLogRequest(request);
    if (response.operationId !== request.operationId) {
      reject('ReadBashLogResponse.operation_id does not match the request.');
    }
  }

  const chunks: { offset: bigint; end: bigint }[] = [];
  let returnedBytes = 0n;
  for (const chunk of response.chunks) {
    const offset = requireUint64(chunk.offset, 'BashLogChunk.offset');
    if (chunk.stream !== BashLogStream.STDOUT && chunk.stream !== BashLogStream.STDERR) {
      reject(`BashLogChunk.stream ${chunk.stream} is not supported.`);
    }
    if (chunk.data.length === 0) reject('BashLogChunk.data must not be empty.');
    returnedBytes += BigInt(chunk.data.length);
    if (request && returnedBytes > BigInt(request.limitBytes)) {
      reject('ReadBashLogResponse exceeds the requested byte limit.');
    }
    if (request?.offset !== undefined && offset < request.offset) {
      reject('BashLogChunk.offset must not precede the requested offset.');
    }
    const previous = chunks.at(-1);
    if (previous && offset < previous.end) {
      reject('BashLogChunk offsets must be ordered and non-overlapping.');
    }
    const end = offset + BigInt(chunk.data.length);
    if (end > maximumUint64 + 1n) reject('BashLogChunk exceeds the uint64 offset range.');
    chunks.push({ offset, end });
  }

  const nextOffset =
    response.nextOffset === undefined
      ? undefined
      : requireUint64(response.nextOffset, 'ReadBashLogResponse.next_offset');
  if (nextOffset !== undefined) {
    if (request?.offset !== undefined && nextOffset <= request.offset) {
      reject('ReadBashLogResponse.next_offset must advance the requested offset.');
    }
    const lastChunkEnd = chunks.at(-1)?.end;
    if (lastChunkEnd !== undefined && nextOffset < lastChunkEnd) {
      reject('ReadBashLogResponse.next_offset must not precede returned data.');
    }
  }
  if (response.expired && (response.chunks.length > 0 || response.nextOffset !== undefined)) {
    reject('An expired Bash log must not contain data or a next offset.');
  }

  const gaps: OffsetGap[] = [];
  let previousGapEnd: bigint | undefined;
  let previousGapOpen = false;
  for (const gap of response.gaps) {
    const start = requireUint64(gap.startOffset, 'BashLogGap.start_offset');
    const end =
      gap.endOffset === undefined
        ? undefined
        : requireUint64(gap.endOffset, 'BashLogGap.end_offset');
    if (end !== undefined && end <= start) {
      reject('BashLogGap.end_offset must be greater than start_offset.');
    }
    if (previousGapOpen || (previousGapEnd !== undefined && start < previousGapEnd)) {
      reject('BashLogGap ranges must be ordered and non-overlapping.');
    }
    if (request?.offset !== undefined && start < request.offset) {
      reject('BashLogGap ranges must not precede the requested offset.');
    }
    if (
      nextOffset !== undefined &&
      (start >= nextOffset || end === undefined || end > nextOffset)
    ) {
      reject('BashLogGap ranges must stay within next_offset and have a finite end.');
    }
    for (const chunk of chunks) {
      if (start < chunk.end && chunk.offset < (end ?? maximumUint64 + 1n)) {
        reject('BashLogGap ranges must not overlap returned chunks.');
      }
    }
    gaps.push(end === undefined ? { startOffset: start } : { startOffset: start, endOffset: end });
    previousGapEnd = end;
    previousGapOpen = end === undefined;
  }
  if (response.outputComplete && response.gaps.length > 0) {
    reject('A complete Bash log must not contain gaps.');
  }

  if (!options?.allowUnexplainedOffsets) {
    const firstChunk = chunks[0];
    if (request?.offset !== undefined && firstChunk && firstChunk.offset > request.offset) {
      assertOffsetJumpCovered(request.offset, firstChunk.offset, gaps);
    }
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1];
      const current = chunks[index];
      if (previous && current && current.offset > previous.end) {
        assertOffsetJumpCovered(previous.end, current.offset, gaps);
      }
    }
    const pageEnd = chunks.at(-1)?.end ?? request?.offset;
    if (nextOffset !== undefined && pageEnd !== undefined && nextOffset > pageEnd) {
      assertOffsetJumpCovered(pageEnd, nextOffset, gaps);
    }
  }
}

export function decodeReadBashLogRequest(data: Uint8Array): ReadBashLogRequest {
  const request = fromBinary(ReadBashLogRequestSchema, data);
  validateReadBashLogRequest(request);
  return request;
}

export function decodeReadBashLogResponse(
  data: Uint8Array,
  request?: ReadBashLogRequest,
): ReadBashLogResponse {
  const response = fromBinary(ReadBashLogResponseSchema, data);
  validateReadBashLogResponse(response, request);
  return response;
}

export function validateReloadResourcesRequest(request: ReloadResourcesRequest): void {
  requireIdentifier(request.threadId, 'ReloadResourcesRequest.thread_id');
  requireIdentifier(request.clientActionId, 'ReloadResourcesRequest.client_action_id');
}

function requireWorkspacePath(value: string, field: string): void {
  requireIdentifier(value, field);
  const segments = value.split('/');
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    reject(`${field} must be a normalized workspace-relative path.`);
  }
}

export function validateReloadResourcesResponse(response: ReloadResourcesResponse): void {
  requireIdentifier(response.snapshotId, 'ReloadResourcesResponse.snapshot_id');
  if (
    response.runtimeFingerprint !== undefined &&
    !/^[a-f0-9]{64}$/.test(response.runtimeFingerprint)
  ) {
    reject('ReloadResourcesResponse.runtime_fingerprint must be a SHA-256 hash.');
  }
  for (const [field, paths] of Object.entries({
    resources: response.resources,
    added: response.added,
    updated: response.updated,
    removed: response.removed,
  })) {
    for (const path of paths) requireWorkspacePath(path, `ReloadResourcesResponse.${field}`);
  }
}

export function validateGetModelStatusResponse(response: GetModelStatusResponse): void {
  const contextCapacity = requireUint32(
    response.contextCapacity,
    'GetModelStatusResponse.context_capacity',
  );
  const outputReserve = requireUint32(
    response.outputReserve,
    'GetModelStatusResponse.output_reserve',
  );
  if (response.available === undefined) {
    reject('GetModelStatusResponse.available must be present.');
  }
  for (const error of response.configurationErrors) {
    requireIdentifier(error.code, 'ModelConfigurationError.code');
    requireIdentifier(error.message, 'ModelConfigurationError.message');
  }
  if (response.available) {
    requireIdentifier(response.providerId, 'GetModelStatusResponse.provider_id');
    requireIdentifier(response.modelId, 'GetModelStatusResponse.model_id');
    if (contextCapacity === 0 || outputReserve === 0 || outputReserve >= contextCapacity) {
      reject('An available model must have positive capacity and output reserve below capacity.');
    }
    if (response.configurationErrors.length > 0) {
      reject('An available model must not contain configuration errors.');
    }
  } else if (response.configurationErrors.length === 0) {
    reject('An unavailable model must explain its public configuration error.');
  }
}

export function decodeGetModelStatusResponse(data: Uint8Array): GetModelStatusResponse {
  const response = fromBinary(GetModelStatusResponseSchema, data);
  validateGetModelStatusResponse(response);
  return response;
}

const attachmentMediaTypes = new Set(['text/plain', 'image/png', 'image/jpeg']);
const mimePattern = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

function validateDeclaredMediaType(value: string): void {
  if (value !== '' && !mimePattern.test(value)) {
    reject('UploadAttachmentRequest.declared_media_type must be a valid MIME type.');
  }
}

export function validateUploadAttachmentRequest(request: UploadAttachmentRequest): void {
  requireIdentifier(request.clientActionId, 'UploadAttachmentRequest.client_action_id');
  requireIdentifier(request.fileName, 'UploadAttachmentRequest.file_name');
  validateDeclaredMediaType(request.declaredMediaType);
  if (
    request.source !== AttachmentSource.UNSPECIFIED &&
    request.source !== AttachmentSource.FILE &&
    request.source !== AttachmentSource.CLIPBOARD
  ) {
    reject('UploadAttachmentRequest.source is not supported.');
  }
  if (request.data.length === 0) reject('UploadAttachmentRequest.data must not be empty.');
}

export function validateAttachment(attachment: Attachment): void {
  requireIdentifier(attachment.attachmentId, 'Attachment.attachment_id');
  requireIdentifier(attachment.fileName, 'Attachment.file_name');
  if (
    attachment.source !== AttachmentSource.UNSPECIFIED &&
    attachment.source !== AttachmentSource.FILE &&
    attachment.source !== AttachmentSource.CLIPBOARD
  ) {
    reject('Attachment.source is not supported.');
  }
  if (attachment.path !== undefined) {
    requireIdentifier(attachment.path, 'Attachment.path');
    if (!attachment.path.startsWith('/') || attachment.path.includes('\0')) {
      reject('Attachment.path must be an absolute POSIX path.');
    }
  }
  if (!attachmentMediaTypes.has(attachment.mediaType)) {
    reject(`Attachment.media_type ${attachment.mediaType} is not supported.`);
  }
  requireUint64(attachment.sizeBytes, 'Attachment.size_bytes');
  if (attachment.sizeBytes === 0n) reject('Attachment.size_bytes must be greater than zero.');
  if (!/^[a-f0-9]{64}$/.test(attachment.sha256))
    reject('Attachment.sha256 must be a SHA-256 hash.');
  for (const [field, value] of [
    ['width', attachment.width],
    ['height', attachment.height],
  ] as const) {
    if (value !== undefined && requireUint32(value, `Attachment.${field}`) === 0) {
      reject(`Attachment.${field} must be greater than zero when present.`);
    }
  }
  if (
    attachment.mediaType === 'text/plain' &&
    (attachment.width !== undefined || attachment.height !== undefined)
  ) {
    reject('Text attachments must not contain image dimensions.');
  }
  if (
    attachment.mediaType !== 'text/plain' &&
    (attachment.width === undefined || attachment.height === undefined)
  ) {
    reject('Image attachments must contain width and height.');
  }
}

export function validateThreadMessagePreview(preview: ThreadMessagePreview): void {
  requireIdentifier(preview.messageId, 'ThreadMessagePreview.message_id');
  if (preview.attachments.length > 4) {
    reject('ThreadMessagePreview.attachments must not contain more than four attachments.');
  }
  const attachmentIds = new Set<string>();
  for (const attachment of preview.attachments) {
    validateAttachment(attachment);
    if (attachmentIds.has(attachment.attachmentId)) {
      reject('ThreadMessagePreview.attachments must not contain duplicate attachment IDs.');
    }
    attachmentIds.add(attachment.attachmentId);
  }
}

export function validateDownloadAttachmentRequest(request: DownloadAttachmentRequest): void {
  requireIdentifier(request.attachmentId, 'DownloadAttachmentRequest.attachment_id');
  if (request.offset !== undefined)
    requireUint64(request.offset, 'DownloadAttachmentRequest.offset');
  if (
    requireUint32(request.limitBytes, 'DownloadAttachmentRequest.limit_bytes') === 0 ||
    request.limitBytes > 256 * 1024
  ) {
    reject('DownloadAttachmentRequest.limit_bytes must be between 1 and 262144.');
  }
}

export function validateDownloadAttachmentResponse(
  response: DownloadAttachmentResponse,
  request: DownloadAttachmentRequest,
): void {
  validateDownloadAttachmentRequest(request);
  if (!response.attachment) reject('DownloadAttachmentResponse.attachment is required.');
  validateAttachment(response.attachment);
  if (response.attachment.attachmentId !== request.attachmentId) {
    reject('DownloadAttachmentResponse.attachment_id does not match the request.');
  }
  if (response.data.length > request.limitBytes) {
    reject('DownloadAttachmentResponse exceeds the requested byte limit.');
  }
  if (response.data.length > Number.MAX_SAFE_INTEGER) reject('Attachment page is too large.');
  const endOffset = (request.offset ?? 0n) + BigInt(response.data.length);
  if (endOffset > response.attachment.sizeBytes) {
    reject('DownloadAttachmentResponse exceeds the attachment size.');
  }
  if (response.nextOffset !== undefined) {
    requireUint64(response.nextOffset, 'DownloadAttachmentResponse.next_offset');
    if (response.nextOffset !== endOffset || endOffset >= response.attachment.sizeBytes) {
      reject('DownloadAttachmentResponse.next_offset does not match the returned page.');
    }
  } else if (endOffset < response.attachment.sizeBytes) {
    reject('DownloadAttachmentResponse is missing the next offset.');
  }
}

export function decodeWatchThreadResponse(data: Uint8Array): WatchThreadResponse {
  const message = fromBinary(WatchThreadResponseSchema, data);
  if (message.payload.case === undefined) {
    throw new ContractValidationError(
      'UNSUPPORTED_PAYLOAD',
      'WatchThreadResponse must contain a supported payload.',
    );
  }
  if (message.payload.case === 'event' && message.payload.value.payload.case === undefined) {
    throw new ContractValidationError(
      'UNSUPPORTED_PAYLOAD',
      'PersistedThreadEvent must contain a supported payload.',
    );
  }
  return message;
}
