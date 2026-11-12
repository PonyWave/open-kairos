import { create, fromBinary, toBinary, toJson } from '@bufbuild/protobuf';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { describe, expect, it } from 'vitest';
import {
  BashOutcomeSchema,
  DaemonMessageSchema,
  DeviceErrorSchema,
  EnvironmentMaintenanceMode as DeviceMaintenanceMode,
  decodeDaemonMessage,
  decodeServerMessage,
  encodeDaemonMessage,
  encodeServerMessage,
  HeartbeatAckSchema,
  HeartbeatSchema,
  OperationOutputChunkSchema,
  OperationStartSchema,
  OperationStatus,
  OutputStream,
  ServerHelloSchema,
  ServerMessageSchema,
} from './device.js';
import {
  AgentEnvironmentBindingSchema,
  AttachmentSchema,
  AttachmentService,
  AuthenticationState,
  AuthService,
  CompleteProfileRequestSchema,
  ContentBlockType,
  ContextService,
  ContractValidationError,
  DownloadAttachmentRequestSchema,
  DownloadAttachmentResponseSchema,
  decodeWatchThreadResponse,
  EnvironmentMaintenanceMode,
  EnvironmentPolicySchema,
  EnvironmentService,
  ErrorCode,
  ErrorDetailSchema,
  EventService,
  GetEnvironmentDaemonCommandsRequestSchema,
  GetEnvironmentDaemonCommandsResponseSchema,
  GetThreadRequestSchema,
  GetThreadResponseSchema,
  InputMode,
  ListThreadCallPreviewsResponseSchema,
  ListThreadCardsResponseSchema,
  MessageRole,
  MessageSchema,
  MessageService,
  MessageSource,
  PersistedThreadEventSchema,
  QueueService,
  RegisterEnvironmentRequestSchema,
  ReloadResourcesResponseSchema,
  RequestEmailCodeRequestSchema,
  RunService,
  RunStatus,
  SendMessageRequestSchema,
  SetEnvironmentMaintenanceRequestSchema,
  TextDeltaSchema,
  ThinkingDeltaSchema,
  ThreadCardSort,
  ThreadMessagePreviewSchema,
  ThreadService,
  ThreadType,
  UploadAttachmentRequestSchema,
  VerifyEmailCodeRequestSchema,
  validateAgentEnvironmentBinding,
  validateCompleteProfileRequest,
  validateDownloadAttachmentRequest,
  validateDownloadAttachmentResponse,
  validateEnvironmentPolicy,
  validateGetEnvironmentDaemonCommandsRequest,
  validateReloadResourcesResponse,
  validateRequestEmailCodeRequest,
  validateSetEnvironmentMaintenanceRequest,
  validateThreadMessagePreview,
  validateUploadAttachmentRequest,
  validateVerifyEmailCodeRequest,
  WatchThreadRequestSchema,
  WatchThreadResponseSchema,
  WorkspaceService,
} from './index.js';

function appendUnknownString(data: Uint8Array, fieldNumber: number, value: string): Uint8Array {
  return new BinaryWriter()
    .raw(data)
    .tag(fieldNumber, WireType.LengthDelimited)
    .string(value)
    .finish();
}

function appendUnknownMessage(data: Uint8Array, fieldNumber: number): Uint8Array {
  return new BinaryWriter()
    .raw(data)
    .tag(fieldNumber, WireType.LengthDelimited)
    .bytes(new Uint8Array())
    .finish();
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to be rejected.');
}

describe('GUI service descriptors', () => {
  it('exposes every phase-one method and a server-streaming event method', () => {
    expect(ThreadService.methods.map((method) => method.localName)).toEqual([
      'createThread',
      'getOrCreateMain',
      'startNewMain',
      'getThread',
      'listThreads',
      'listThreadCards',
      'listThreadCallPreviews',
      'listSubagentCallViews',
      'renameThread',
    ]);
    expect(MessageService.methods.map((method) => method.localName)).toEqual([
      'sendMessage',
      'reviseMessage',
    ]);
    expect(QueueService.methods.map((method) => method.localName)).toEqual([
      'editInput',
      'removeInput',
      'reorderInputs',
    ]);
    expect(RunService.methods.map((method) => method.localName)).toEqual([
      'cancelRun',
      'continueRun',
      'rerun',
    ]);
    expect(ContextService.methods.map((method) => method.localName)).toEqual([
      'readContext',
      'readRecaps',
      'compactContext',
    ]);
    expect(EventService.method.watchThread.methodKind).toBe('server_streaming');
  });

  it('requires client_action_id on mutating requests and limits CompactContext parameters', () => {
    const methods = [
      ThreadService.method.createThread,
      ThreadService.method.renameThread,
      MessageService.method.sendMessage,
      MessageService.method.reviseMessage,
      QueueService.method.editInput,
      QueueService.method.removeInput,
      QueueService.method.reorderInputs,
      RunService.method.cancelRun,
      RunService.method.continueRun,
      RunService.method.rerun,
      ContextService.method.compactContext,
      WorkspaceService.method.reloadResources,
    ];
    for (const method of methods) {
      expect(method.input.fields.some((field) => field.localName === 'clientActionId')).toBe(true);
    }
    expect(
      ContextService.method.compactContext.input.fields.map((field) => field.localName),
    ).toEqual(['threadId', 'clientActionId']);
    expect(ContextService.method.compactContext.methodKind).toBe('unary');
  });

  it('limits ReloadResources to thread identity and returns relative resource paths', () => {
    const method = WorkspaceService.method.reloadResources;
    expect(method.methodKind).toBe('unary');
    expect(method.input.fields.map((field) => field.localName)).toEqual([
      'threadId',
      'clientActionId',
    ]);
    expect(method.output.fields.map((field) => field.localName)).toEqual([
      'snapshotId',
      'changed',
      'resources',
      'added',
      'updated',
      'removed',
      'runtimeFingerprint',
      'runtimeChanged',
    ]);
    const response = create(ReloadResourcesResponseSchema, {
      snapshotId: 'snapshot-1',
      changed: true,
      resources: ['AGENTS.md', '.agents/skills/review/SKILL.md'],
      added: ['.agents/skills/review/SKILL.md'],
      updated: ['AGENTS.md'],
      removed: [],
      runtimeFingerprint: 'a'.repeat(64),
      runtimeChanged: true,
    });
    expect(() => validateReloadResourcesResponse(response)).not.toThrow();
    expect(() =>
      validateReloadResourcesResponse({ ...response, runtimeFingerprint: 'old-version' }),
    ).toThrow(ContractValidationError);
    expect(() =>
      validateReloadResourcesResponse({ ...response, runtimeFingerprint: undefined }),
    ).not.toThrow();
    for (const path of ['/AGENTS.md', '../AGENTS.md', '.agents/../AGENTS.md', 'C:\\AGENTS.md']) {
      expect(() => validateReloadResourcesResponse({ ...response, resources: [path] })).toThrow(
        ContractValidationError,
      );
    }
  });
});

describe('attachment contracts', () => {
  it('exposes unary attachment methods with action IDs for mutations', () => {
    expect(AttachmentService.methods.map((method) => method.localName)).toEqual([
      'uploadAttachment',
      'deleteAttachment',
      'downloadAttachment',
    ]);
    for (const method of [
      AttachmentService.method.uploadAttachment,
      AttachmentService.method.deleteAttachment,
    ]) {
      expect(method.methodKind).toBe('unary');
      expect(method.input.fields.some((field) => field.localName === 'clientActionId')).toBe(true);
    }
    expect(AttachmentService.method.downloadAttachment.methodKind).toBe('unary');
  });

  it('preserves uint64 sizes, offsets and optional preview dimensions', () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    const attachment = create(AttachmentSchema, {
      attachmentId: 'attachment-1',
      fileName: 'image.png',
      mediaType: 'image/png',
      sizeBytes: huge,
      width: 0,
      height: 1080,
      sha256: 'a'.repeat(64),
    });
    const decoded = fromBinary(AttachmentSchema, toBinary(AttachmentSchema, attachment));
    expect(decoded.sizeBytes).toBe(huge);
    expect(decoded.width).toBe(0);
    expect(decoded.height).toBe(1080);
    expect(decoded.sha256).toBe('a'.repeat(64));
    expect(toJson(AttachmentSchema, decoded)).toMatchObject({ sizeBytes: '9007199254740993' });
    const withoutDimensions = create(AttachmentSchema, { attachmentId: 'text-1' });
    expect(
      fromBinary(AttachmentSchema, toBinary(AttachmentSchema, withoutDimensions)).width,
    ).toBeUndefined();

    const request = create(DownloadAttachmentRequestSchema, {
      attachmentId: 'attachment-1',
      offset: huge,
      limitBytes: 262_144,
    });
    expect(
      fromBinary(
        DownloadAttachmentRequestSchema,
        toBinary(DownloadAttachmentRequestSchema, request),
      ),
    ).toEqual(request);
    const zeroOffset = create(DownloadAttachmentRequestSchema, { offset: 0n });
    expect(
      fromBinary(
        DownloadAttachmentRequestSchema,
        toBinary(DownloadAttachmentRequestSchema, zeroOffset),
      ).offset,
    ).toBe(0n);
    const absentOffset = create(DownloadAttachmentRequestSchema, {});
    expect(
      fromBinary(
        DownloadAttachmentRequestSchema,
        toBinary(DownloadAttachmentRequestSchema, absentOffset),
      ).offset,
    ).toBeUndefined();

    const send = create(SendMessageRequestSchema, {
      clientActionId: 'send-attachments',
      attachmentIds: ['attachment-1', 'attachment-2'],
    });
    expect(
      fromBinary(SendMessageRequestSchema, toBinary(SendMessageRequestSchema, send)).attachmentIds,
    ).toEqual(['attachment-1', 'attachment-2']);
  });

  it('carries bounded attachment metadata in Thread message previews without content bytes', () => {
    const attachments = [
      create(AttachmentSchema, {
        attachmentId: 'text-1',
        fileName: 'note.txt',
        mediaType: 'text/plain',
        sizeBytes: 4n,
        sha256: 'a'.repeat(64),
      }),
      create(AttachmentSchema, {
        attachmentId: 'image-1',
        fileName: 'image.png',
        mediaType: 'image/png',
        sizeBytes: 8n,
        width: 2,
        height: 3,
        sha256: 'b'.repeat(64),
      }),
    ];
    const preview = create(ThreadMessagePreviewSchema, {
      messageId: 'message-1',
      seq: 9n,
      role: MessageRole.USER,
      text: '',
      attachments,
    });
    const decoded = fromBinary(
      ThreadMessagePreviewSchema,
      toBinary(ThreadMessagePreviewSchema, preview),
    );
    expect(decoded.attachments.map((attachment) => attachment.attachmentId)).toEqual([
      'text-1',
      'image-1',
    ]);
    expect(() => validateThreadMessagePreview(decoded)).not.toThrow();
    for (const attachment of decoded.attachments) {
      expect(attachment).not.toHaveProperty('data');
      expect(attachment).not.toHaveProperty('bytes');
      expect(attachment).not.toHaveProperty('ownerId');
    }
    expect(JSON.stringify(toJson(ThreadMessagePreviewSchema, decoded))).not.toContain('base64');

    const tooMany = create(ThreadMessagePreviewSchema, {
      messageId: 'message-1',
      attachments: Array.from({ length: 5 }, (_, index) =>
        create(AttachmentSchema, {
          attachmentId: `attachment-${index}`,
          fileName: 'note.txt',
          mediaType: 'text/plain',
          sizeBytes: 4n,
          sha256: 'a'.repeat(64),
        }),
      ),
    });
    expect(() => validateThreadMessagePreview(tooMany)).toThrow(ContractValidationError);
    const duplicate = decoded.attachments[0];
    if (!duplicate) throw new Error('Missing decoded attachment fixture.');
    expect(() =>
      validateThreadMessagePreview({
        ...preview,
        attachments: [duplicate, duplicate],
      }),
    ).toThrow(ContractValidationError);
  });

  it('validates upload bytes, declared MIME syntax and download pagination', () => {
    const upload = create(UploadAttachmentRequestSchema, {
      clientActionId: 'upload-1',
      fileName: 'note.txt',
      declaredMediaType: 'image/png',
      data: new Uint8Array([1]),
    });
    expect(() => validateUploadAttachmentRequest(upload)).not.toThrow();
    expect(() => validateUploadAttachmentRequest({ ...upload, data: new Uint8Array() })).toThrow(
      ContractValidationError,
    );
    expect(() =>
      validateUploadAttachmentRequest({ ...upload, declaredMediaType: 'invalid' }),
    ).toThrow(ContractValidationError);

    const attachment = create(AttachmentSchema, {
      attachmentId: 'attachment-1',
      fileName: 'note.txt',
      mediaType: 'text/plain',
      sizeBytes: 6n,
      sha256: 'a'.repeat(64),
    });
    const request = create(DownloadAttachmentRequestSchema, {
      attachmentId: 'attachment-1',
      offset: 2n,
      limitBytes: 3,
    });
    expect(() => validateDownloadAttachmentRequest(request)).not.toThrow();
    expect(() => validateDownloadAttachmentRequest({ ...request, limitBytes: 0 })).toThrow(
      ContractValidationError,
    );
    const response = create(DownloadAttachmentResponseSchema, {
      attachment,
      data: new Uint8Array([3, 4, 5]),
      nextOffset: 5n,
    });
    expect(() => validateDownloadAttachmentResponse(response, request)).not.toThrow();
    expect(() =>
      validateDownloadAttachmentResponse({ ...response, nextOffset: 6n }, request),
    ).toThrow(ContractValidationError);
    expect(() =>
      validateDownloadAttachmentResponse(
        { ...response, attachment: { ...attachment, sha256: 'invalid' } },
        request,
      ),
    ).toThrow(ContractValidationError);

    const emptyRequest = { ...request, offset: 6n };
    const emptyResponse = create(DownloadAttachmentResponseSchema, {
      attachment,
      data: new Uint8Array(),
    });
    expect(() => validateDownloadAttachmentResponse(emptyResponse, emptyRequest)).not.toThrow();
    expect(() =>
      validateDownloadAttachmentResponse(emptyResponse, { ...emptyRequest, offset: 99n }),
    ).toThrow(ContractValidationError);

    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    const hugeAttachment = { ...attachment, sizeBytes: huge + 1n };
    expect(() =>
      validateDownloadAttachmentResponse(
        create(DownloadAttachmentResponseSchema, {
          attachment: hugeAttachment,
          data: new Uint8Array([1]),
        }),
        { ...request, offset: huge },
      ),
    ).not.toThrow();
  });
});

describe('authentication contract', () => {
  it('exposes the email login, profile, identity and logout methods', () => {
    expect(AuthService.methods.map((method) => method.localName)).toEqual([
      'requestEmailCode',
      'verifyEmailCode',
      'completeProfile',
      'getCurrentIdentity',
      'logout',
    ]);
    expect(AuthenticationState.PROFILE_REQUIRED).toBe(2);
  });

  it('validates authentication inputs and normalizes email addresses', async () => {
    const { normalizeEmail } = await import('./auth.js');
    expect(normalizeEmail(' Test@Example.COM ')).toBe('test@example.com');
    expect(() =>
      validateRequestEmailCodeRequest(
        create(RequestEmailCodeRequestSchema, {
          email: 'invalid',
          clientActionId: 'request-1',
        }),
      ),
    ).toThrow(ContractValidationError);
    expect(() =>
      validateVerifyEmailCodeRequest(
        create(VerifyEmailCodeRequestSchema, {
          email: 'person@example.com',
          verificationId: 'verification-1',
          code: '12345',
        }),
      ),
    ).toThrow(ContractValidationError);
    expect(() =>
      validateCompleteProfileRequest(create(CompleteProfileRequestSchema, { username: '' })),
    ).toThrow(ContractValidationError);
    expect(() =>
      validateCompleteProfileRequest(create(CompleteProfileRequestSchema, { username: '用户' })),
    ).not.toThrow();
  });
});

describe('binary compatibility', () => {
  it('round-trips a request as protobuf binary', () => {
    const request = create(SendMessageRequestSchema, {
      clientActionId: 'action-1',
      threadId: 'thread-1',
      text: '检查协议编解码',
      mode: InputMode.STEER,
    });
    const decoded = fromBinary(
      SendMessageRequestSchema,
      toBinary(SendMessageRequestSchema, request),
    );
    expect(decoded).toEqual(request);
  });

  it('round-trips ErrorDetail terminal presence without changing existing fields', () => {
    for (const terminal of [undefined, false, true] as const) {
      const detail = create(ErrorDetailSchema, {
        code: ErrorCode.OPERATION_UNKNOWN,
        message: 'persisted operation outcome',
        clientActionId: 'action-1',
        retryable: true,
        ...(terminal === undefined ? {} : { terminal }),
      });
      const decoded = fromBinary(ErrorDetailSchema, toBinary(ErrorDetailSchema, detail));
      expect(decoded).toMatchObject({
        code: ErrorCode.OPERATION_UNKNOWN,
        message: 'persisted operation outcome',
        clientActionId: 'action-1',
        retryable: true,
      });
      expect(decoded.terminal).toBe(terminal);
    }
  });

  it('preserves unknown fields when a supported message is decoded and re-encoded', () => {
    const request = create(SendMessageRequestSchema, {
      clientActionId: 'action-1',
      threadId: 'thread-1',
      text: '保留未知字段',
      mode: InputMode.FOLLOW_UP,
    });
    const encoded = appendUnknownString(
      toBinary(SendMessageRequestSchema, request),
      15,
      'future-value',
    );
    const decoded = fromBinary(SendMessageRequestSchema, encoded);
    expect(decoded.text).toBe('保留未知字段');
    expect(toBinary(SendMessageRequestSchema, decoded)).toEqual(encoded);
  });

  it('accepts unknown additions on a supported device operation and preserves their bytes', () => {
    const message = create(DaemonMessageSchema, {
      protocolMajor: 1,
      payload: {
        case: 'heartbeat',
        value: create(HeartbeatSchema, { sequence: 9n }),
      },
    });
    const encoded = appendUnknownString(toBinary(DaemonMessageSchema, message), 99, 'future');
    const decoded = decodeDaemonMessage(encoded);
    expect(decoded.payload.case).toBe('heartbeat');
    expect(toBinary(DaemonMessageSchema, decoded)).toEqual(encoded);
  });

  it('rejects empty and unknown oneof payloads explicitly', () => {
    const emptyDaemon = toBinary(
      DaemonMessageSchema,
      create(DaemonMessageSchema, { protocolMajor: 1 }),
    );
    const emptyServer = toBinary(
      ServerMessageSchema,
      create(ServerMessageSchema, { protocolMajor: 1 }),
    );
    const unknownDaemon = appendUnknownMessage(emptyDaemon, 99);
    const unknownWatchEvent = appendUnknownMessage(new Uint8Array(), 99);

    for (const run of [
      () => decodeDaemonMessage(emptyDaemon),
      () => decodeDaemonMessage(unknownDaemon),
      () => decodeServerMessage(emptyServer),
      () => decodeWatchThreadResponse(new Uint8Array()),
      () => decodeWatchThreadResponse(unknownWatchEvent),
    ]) {
      const error = captureError(run);
      expect(error).toBeInstanceOf(ContractValidationError);
      expect(error).toMatchObject({ code: 'UNSUPPORTED_PAYLOAD' });
    }
  });

  it('rejects an empty nested persisted-event payload', () => {
    const response = create(WatchThreadResponseSchema, {
      payload: {
        case: 'event',
        value: create(PersistedThreadEventSchema, {
          eventId: 'event-1',
          threadId: 'thread-1',
          seq: 1n,
        }),
      },
    });
    expect(
      captureError(() => decodeWatchThreadResponse(toBinary(WatchThreadResponseSchema, response))),
    ).toMatchObject({ code: 'UNSUPPORTED_PAYLOAD' });
  });

  it('rejects unknown enum values instead of treating them as valid state', () => {
    const result = new BinaryWriter()
      .tag(1, WireType.LengthDelimited)
      .string('operation-1')
      .tag(3, WireType.Varint)
      .uint32(99)
      .finish();
    const encoded = new BinaryWriter()
      .tag(1, WireType.Varint)
      .uint32(1)
      .tag(12, WireType.LengthDelimited)
      .bytes(result)
      .finish();
    const decoded = fromBinary(DaemonMessageSchema, encoded);
    expect(decoded.payload.case).toBe('operationResult');
    expect(captureError(() => decodeDaemonMessage(encoded))).toMatchObject({
      code: 'UNSUPPORTED_PAYLOAD',
    });
  });

  it('rejects unknown and unspecified DeviceError codes and actions in both directions', () => {
    const invalid = [
      { code: 99, action: 1 },
      { code: 1, action: 99 },
      { code: 0, action: 1 },
      { code: 1, action: 0 },
    ];
    for (const value of invalid) {
      const daemon = create(DaemonMessageSchema, {
        protocolMajor: 1,
        payload: {
          case: 'error',
          value: create(DeviceErrorSchema, { message: 'invalid', ...value }),
        },
      });
      const server = create(ServerMessageSchema, {
        protocolMajor: 1,
        payload: {
          case: 'error',
          value: create(DeviceErrorSchema, { message: 'invalid', ...value }),
        },
      });
      expect(
        captureError(() => decodeDaemonMessage(toBinary(DaemonMessageSchema, daemon))),
      ).toMatchObject({ code: 'UNSUPPORTED_PAYLOAD' });
      expect(
        captureError(() => decodeServerMessage(toBinary(ServerMessageSchema, server))),
      ).toMatchObject({ code: 'UNSUPPORTED_PAYLOAD' });
    }
  });

  it('rejects incompatible protocol majors', () => {
    const message = create(ServerMessageSchema, {
      protocolMajor: 2,
      payload: {
        case: 'heartbeatAck',
        value: create(HeartbeatAckSchema, { sequence: 1n }),
      },
    });
    expect(
      captureError(() => decodeServerMessage(toBinary(ServerMessageSchema, message))),
    ).toMatchObject({ code: 'INCOMPATIBLE_PROTOCOL_MAJOR' });
  });
});

describe('field presence and 64-bit values', () => {
  it('distinguishes a missing Bash outcome exit code, zero, and a non-zero exit code', () => {
    const roundTrip = (value: { exitCode?: number; outputComplete: boolean }) =>
      fromBinary(BashOutcomeSchema, toBinary(BashOutcomeSchema, create(BashOutcomeSchema, value)));
    const missing = roundTrip({ outputComplete: false });
    const zero = roundTrip({ exitCode: 0, outputComplete: true });
    const nonZero = roundTrip({ exitCode: 23, outputComplete: true });
    expect(missing.exitCode).toBeUndefined();
    expect(zero.exitCode).toBe(0);
    expect(nonZero.exitCode).toBe(23);
    expect(toJson(BashOutcomeSchema, missing)).not.toHaveProperty('exitCode');
    expect(toJson(BashOutcomeSchema, zero)).toHaveProperty('exitCode', 0);
    expect(toJson(BashOutcomeSchema, nonZero)).toHaveProperty('exitCode', 23);
    expect(toBinary(BashOutcomeSchema, zero).length).toBeGreaterThan(
      toBinary(BashOutcomeSchema, missing).length,
    );
  });

  it('returns a new device credential only when the pairing exchange includes one', () => {
    const paired = create(ServerHelloSchema, {
      deviceId: 'device-1',
      instanceId: 'instance-1',
      protocolMajor: 1,
      deviceCredential: 'kd2_independent_secret',
    });
    const reconnected = create(ServerHelloSchema, {
      deviceId: 'device-1',
      instanceId: 'instance-1',
      protocolMajor: 1,
    });
    const decodedPaired = fromBinary(ServerHelloSchema, toBinary(ServerHelloSchema, paired));
    const decodedReconnected = fromBinary(
      ServerHelloSchema,
      toBinary(ServerHelloSchema, reconnected),
    );

    expect(decodedPaired.deviceCredential).toBe('kd2_independent_secret');
    expect(decodedReconnected.deviceCredential).toBeUndefined();
    expect(toJson(ServerHelloSchema, reconnected)).not.toHaveProperty('deviceCredential');
  });

  it('round-trips content blocks and Thinking deltas with zero indices and uint64 sequences', () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    const message = create(MessageSchema, {
      messageId: 'message-1',
      threadId: 'thread-1',
      agentId: 'main',
      seq: huge,
      content: 'AB',
      contentBlocks: [
        { type: ContentBlockType.THINKING, blockIndex: 0, text: 'reasoning' },
        { type: ContentBlockType.TEXT, blockIndex: 1, text: 'A' },
        { type: ContentBlockType.THINKING, blockIndex: 2, text: 'more reasoning' },
        { type: ContentBlockType.TEXT, blockIndex: 3, text: 'B' },
      ],
    });
    expect(fromBinary(MessageSchema, toBinary(MessageSchema, message))).toEqual(message);
    expect(toJson(MessageSchema, message)).toMatchObject({ seq: '9007199254740993' });

    const delta = create(ThinkingDeltaSchema, {
      threadId: 'thread-1',
      messageId: 'message-1',
      deltaSeq: huge,
      text: 'reasoning',
      blockIndex: 0,
      runId: 'run-1',
    });
    expect(fromBinary(ThinkingDeltaSchema, toBinary(ThinkingDeltaSchema, delta))).toEqual(delta);
    const watched = create(WatchThreadResponseSchema, {
      payload: { case: 'thinkingDelta', value: delta },
    });
    expect(decodeWatchThreadResponse(toBinary(WatchThreadResponseSchema, watched))).toEqual(
      watched,
    );

    const indexedText = create(TextDeltaSchema, { deltaSeq: 1n, blockIndex: 0 });
    const legacyText = create(TextDeltaSchema, { deltaSeq: 1n });
    expect(fromBinary(TextDeltaSchema, toBinary(TextDeltaSchema, indexedText)).blockIndex).toBe(0);
    expect(fromBinary(TextDeltaSchema, toBinary(TextDeltaSchema, legacyText)).blockIndex).toBe(
      undefined,
    );
  });

  it('keeps cursors above the JavaScript safe-integer range lossless', () => {
    const cursor = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    const request = create(WatchThreadRequestSchema, {
      threadId: 'thread-1',
      afterSeq: cursor,
    });
    const decoded = fromBinary(
      WatchThreadRequestSchema,
      toBinary(WatchThreadRequestSchema, request),
    );
    expect(decoded.afterSeq).toBe(cursor);
    expect(toJson(WatchThreadRequestSchema, decoded)).toMatchObject({
      afterSeq: '9007199254740993',
    });
  });

  it('keeps paginated snapshot cursors lossless and legacy requests compatible', () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    const cursor = {
      threadId: 'thread-1',
      throughSeq: huge,
      messages: { afterRowid: huge, maxRowid: huge + 1n },
      inputs: { afterRowid: huge + 2n, maxRowid: huge + 3n },
      runs: { afterRowid: huge + 4n, maxRowid: huge + 5n },
      devices: { afterRowid: huge + 6n, maxRowid: huge + 7n },
      recaps: { afterRowid: huge + 8n, maxRowid: huge + 9n },
    };
    const request = create(GetThreadRequestSchema, {
      threadId: 'thread-1',
      limit: 40,
      cursor,
    });
    const decoded = fromBinary(GetThreadRequestSchema, toBinary(GetThreadRequestSchema, request));
    expect(decoded.cursor).toMatchObject(cursor);
    expect(toJson(GetThreadRequestSchema, decoded)).toMatchObject({
      cursor: { throughSeq: '9007199254740993' },
    });

    const response = create(GetThreadResponseSchema, {
      throughSeq: huge,
      nextCursor: cursor,
      hasMore: true,
    });
    expect(
      fromBinary(GetThreadResponseSchema, toBinary(GetThreadResponseSchema, response)),
    ).toEqual(response);
    const legacy = fromBinary(
      GetThreadRequestSchema,
      toBinary(GetThreadRequestSchema, create(GetThreadRequestSchema, { threadId: 'thread-1' })),
    );
    expect(legacy.limit).toBeUndefined();
    expect(legacy.cursor).toBeUndefined();
  });

  it('keeps Thread preview cursors, locations and optional responses lossless', () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    const sourceCall = {
      delegation: {
        sourceThreadId: 'main-1',
        sourceAgentId: 'thread',
        sourceToolCallId: 'call-1',
      },
      sourceMessageId: 'source-message-1',
      sourceMessageSeq: huge,
    };
    const cards = create(ListThreadCardsResponseSchema, {
      cards: [
        {
          thread: {
            threadId: 'task-1',
            title: '任务',
            seq: huge,
            threadType: ThreadType.TASK,
            createdAt: { seconds: 1_762_000_000n },
          },
          lastMessageAt: { seconds: 1_762_000_100n, nanos: 123_000_000 },
          messages: [
            {
              messageId: 'message-1',
              seq: huge,
              role: MessageRole.ASSISTANT,
              text: '预览',
              textTruncated: true,
              createdAt: { seconds: 1_762_000_100n, nanos: 123_000_000 },
              source: MessageSource.USER,
            },
          ],
          sourceCall,
        },
      ],
      nextCursor: {
        sort: ThreadCardSort.CREATED_AT,
        sortAt: { seconds: 1_762_000_100n, nanos: 123_000_000 },
        threadSeq: huge,
      },
      hasMore: true,
    });
    const decodedCards = fromBinary(
      ListThreadCardsResponseSchema,
      toBinary(ListThreadCardsResponseSchema, cards),
    );
    expect(decodedCards).toEqual(cards);
    expect(toJson(ListThreadCardsResponseSchema, decodedCards)).toMatchObject({
      nextCursor: { threadSeq: '9007199254740993' },
      cards: [{ sourceCall: { sourceMessageSeq: '9007199254740993' } }],
    });

    const previews = create(ListThreadCallPreviewsResponseSchema, {
      previews: [
        {
          call: sourceCall,
          targetThreadId: 'task-1',
          targetTitle: '任务',
          status: RunStatus.COMPLETED,
          replyCount: huge,
          replies: [],
          responseMessageSeq: huge,
        },
        {
          call: sourceCall,
          targetThreadId: 'task-2',
          targetTitle: '等待',
          status: RunStatus.QUEUED,
          replyCount: 0n,
          replies: [],
        },
      ],
    });
    const decodedPreviews = fromBinary(
      ListThreadCallPreviewsResponseSchema,
      toBinary(ListThreadCallPreviewsResponseSchema, previews),
    );
    expect(decodedPreviews).toEqual(previews);
    expect(decodedPreviews.previews[0]?.responseMessageSeq).toBe(huge);
    expect(decodedPreviews.previews[1]?.responseMessageSeq).toBeUndefined();
    expect(toJson(ListThreadCallPreviewsResponseSchema, decodedPreviews)).toMatchObject({
      previews: [{ replyCount: '9007199254740993', responseMessageSeq: '9007199254740993' }, {}],
    });
  });

  it('keeps the maximum uint64 output offset and output bytes lossless', () => {
    const maximum = (1n << 64n) - 1n;
    const chunk = create(OperationOutputChunkSchema, {
      operationId: 'operation-1',
      offset: maximum,
      stream: OutputStream.STDERR,
      data: new Uint8Array([0xf0, 0x9f, 0x00, 0xff]),
      target: { envId: 'env-1', deviceBindingId: 'binding-1', instanceId: 'instance-1' },
    });
    const decoded = fromBinary(
      OperationOutputChunkSchema,
      toBinary(OperationOutputChunkSchema, chunk),
    );
    expect(decoded.offset).toBe(maximum);
    expect(decoded.data).toEqual(chunk.data);
    expect(toJson(OperationOutputChunkSchema, decoded)).toMatchObject({
      offset: '18446744073709551615',
    });
  });

  it('reserves retired Bash transport fields and rejects their wire payloads', () => {
    const retired = [
      { schema: DaemonMessageSchema, fields: [4, 5, 6, 7], decode: decodeDaemonMessage },
      { schema: ServerMessageSchema, fields: [4, 5, 6, 7, 8], decode: decodeServerMessage },
    ];
    for (const { schema, fields, decode } of retired) {
      const active = schema.fields.map((field) => field.number);
      for (const number of fields) {
        expect(active).not.toContain(number);
        expect(
          schema.proto.reservedRange.some((range) => range.start <= number && range.end > number),
        ).toBe(true);
        const encoded = new BinaryWriter()
          .tag(1, WireType.Varint)
          .uint32(1)
          .tag(number, WireType.LengthDelimited)
          .bytes(new Uint8Array())
          .finish();
        expect(captureError(() => decode(encoded))).toMatchObject({ code: 'UNSUPPORTED_PAYLOAD' });
      }
    }
  });
});

describe('environment contracts', () => {
  it('exposes registry, pairing, revocation and maintenance without default selection', () => {
    expect(EnvironmentService.methods.map((method) => method.localName)).toEqual([
      'beginDeviceConnection',
      'cancelDeviceConnection',
      'updateEnvironment',
      'setFavoriteDirectory',
      'listEnvironmentDirectories',
      'registerEnvironment',
      'listEnvironments',
      'getEnvironment',
      'getEnvironmentDaemonCommands',
      'reissueEnvironmentPairing',
      'revokeEnvironment',
      'setEnvironmentMaintenance',
    ]);
    for (const method of [
      EnvironmentService.method.beginDeviceConnection,
      EnvironmentService.method.cancelDeviceConnection,
      EnvironmentService.method.updateEnvironment,
      EnvironmentService.method.setFavoriteDirectory,
      EnvironmentService.method.registerEnvironment,
      EnvironmentService.method.reissueEnvironmentPairing,
      EnvironmentService.method.revokeEnvironment,
      EnvironmentService.method.setEnvironmentMaintenance,
    ]) {
      expect(method.methodKind).toBe('unary');
      expect(method.input.fields.some((field) => field.localName === 'clientActionId')).toBe(true);
    }
  });

  it('validates daemon command lookup and exposes only the three command fields', () => {
    const request = create(GetEnvironmentDaemonCommandsRequestSchema, { envId: 'env-1' });
    const decoded = fromBinary(
      GetEnvironmentDaemonCommandsRequestSchema,
      toBinary(GetEnvironmentDaemonCommandsRequestSchema, request),
    );
    expect(() => validateGetEnvironmentDaemonCommandsRequest(decoded)).not.toThrow();
    expect(() => validateGetEnvironmentDaemonCommandsRequest({ ...decoded, envId: '' })).toThrow(
      ContractValidationError,
    );

    const commands = {
      startCommand: '~/.local/bin/kairos-daemon start env-1',
      statusCommand: '~/.local/bin/kairos-daemon status env-1',
      stopCommand: '~/.local/bin/kairos-daemon stop env-1',
    };
    const response = create(GetEnvironmentDaemonCommandsResponseSchema, commands);
    const decodedResponse = fromBinary(
      GetEnvironmentDaemonCommandsResponseSchema,
      toBinary(GetEnvironmentDaemonCommandsResponseSchema, response),
    );
    expect(decodedResponse).toMatchObject(commands);
    expect(
      GetEnvironmentDaemonCommandsResponseSchema.fields.map((field) => field.localName),
    ).toEqual(['startCommand', 'statusCommand', 'stopCommand']);
    expect(EnvironmentService.method.getEnvironmentDaemonCommands.methodKind).toBe('unary');
    expect(
      EnvironmentService.method.getEnvironmentDaemonCommands.input.fields.some(
        (field) => field.localName === 'clientActionId',
      ),
    ).toBe(false);
  });

  it('preserves unknown fields when registering an environment', () => {
    const request = create(RegisterEnvironmentRequestSchema, {
      clientActionId: 'register-1',
      name: '构建服务器',
      recommendedPwd: '/srv/kairos',
    });
    const encoded = appendUnknownString(
      toBinary(RegisterEnvironmentRequestSchema, request),
      20,
      'future-value',
    );
    const decoded = fromBinary(RegisterEnvironmentRequestSchema, encoded);
    expect(decoded).toMatchObject(request);
    expect(toBinary(RegisterEnvironmentRequestSchema, decoded)).toEqual(encoded);
  });

  it('validates future policy and binding types with lossless uint64 versions', () => {
    const maximum = (1n << 64n) - 1n;
    const policy = create(EnvironmentPolicySchema, {
      allowedEnv: ['env-1', 'env-2'],
      policyVersion: maximum,
    });
    const binding = create(AgentEnvironmentBindingSchema, {
      envId: 'env-1',
      pwd: '/srv/kairos',
      bindingVersion: maximum,
      resourceVersion: 'resource-v1',
    });
    const decodedPolicy = fromBinary(
      EnvironmentPolicySchema,
      toBinary(EnvironmentPolicySchema, policy),
    );
    const decodedBinding = fromBinary(
      AgentEnvironmentBindingSchema,
      toBinary(AgentEnvironmentBindingSchema, binding),
    );
    expect(decodedPolicy.policyVersion).toBe(maximum);
    expect(decodedBinding.bindingVersion).toBe(maximum);
    expect(toJson(AgentEnvironmentBindingSchema, decodedBinding)).toMatchObject({
      bindingVersion: '18446744073709551615',
    });
    expect(() => validateEnvironmentPolicy(decodedPolicy)).not.toThrow();
    expect(() => validateAgentEnvironmentBinding(decodedBinding)).not.toThrow();
    expect(() =>
      validateEnvironmentPolicy({ ...decodedPolicy, allowedEnv: ['env-2', 'env-2'] }),
    ).toThrow(ContractValidationError);
    expect(() =>
      validateAgentEnvironmentBinding({ ...decodedBinding, bindingVersion: 0n }),
    ).toThrow(ContractValidationError);
  });

  it('validates maintenance mode and preserves uint64 expected versions', () => {
    const request = create(SetEnvironmentMaintenanceRequestSchema, {
      clientActionId: 'maintenance-1',
      envId: 'env-1',
      mode: EnvironmentMaintenanceMode.DRAINING,
      expectedVersion: 9_007_199_254_740_993n,
    });
    const decoded = fromBinary(
      SetEnvironmentMaintenanceRequestSchema,
      toBinary(SetEnvironmentMaintenanceRequestSchema, request),
    );
    expect(decoded.expectedVersion).toBe(9_007_199_254_740_993n);
    expect(() => validateSetEnvironmentMaintenanceRequest(decoded)).not.toThrow();
    expect(() =>
      validateSetEnvironmentMaintenanceRequest({
        ...decoded,
        mode: EnvironmentMaintenanceMode.UNSPECIFIED,
      }),
    ).toThrow(ContractValidationError);
  });
});

describe('generic device operations', () => {
  const target = {
    envId: 'env-1',
    deviceBindingId: 'binding-1',
    instanceId: 'instance-1',
  };

  it('round-trips an operation start and maximum uint64 output offset', () => {
    const start = create(OperationStartSchema, {
      operationId: 'operation-1',
      requestId: 'request-1',
      target: { ...target, bindingVersion: 9_007_199_254_740_993n },
      expiresAt: { seconds: 1_762_000_000n },
      action: {
        case: 'bash',
        value: { command: 'pwd', cwd: '/srv/kairos', timeoutSeconds: 30 },
      },
    });
    const encoded = encodeServerMessage({ payload: { case: 'operationStart', value: start } });
    const decoded = decodeServerMessage(encoded);
    expect(decoded.payload.case).toBe('operationStart');
    if (decoded.payload.case !== 'operationStart') throw new Error('Unexpected payload.');
    expect(decoded.payload.value.target?.bindingVersion).toBe(9_007_199_254_740_993n);

    const maximum = (1n << 64n) - 1n;
    const chunk = create(OperationOutputChunkSchema, {
      operationId: 'operation-1',
      target,
      offset: maximum,
      stream: OutputStream.STDOUT,
      data: new Uint8Array([0, 255]),
    });
    const decodedChunk = fromBinary(
      OperationOutputChunkSchema,
      toBinary(OperationOutputChunkSchema, chunk),
    );
    expect(decodedChunk.offset).toBe(maximum);
    expect(decodedChunk.data).toEqual(chunk.data);
  });

  it('requires a binding version for Agent actions and omits it for directory checks', () => {
    const directory = create(OperationStartSchema, {
      operationId: 'operation-directory',
      requestId: 'request-directory',
      target,
      expiresAt: { seconds: 1_762_000_000n },
      action: { case: 'directoryCheck', value: { path: '/srv/kairos', loadWorkspace: true } },
    });
    expect(() =>
      decodeServerMessage(
        encodeServerMessage({ payload: { case: 'operationStart', value: directory } }),
      ),
    ).not.toThrow();
    const invalid = create(OperationStartSchema, {
      operationId: 'operation-read',
      requestId: 'request-read',
      target,
      expiresAt: { seconds: 1_762_000_000n },
      action: { case: 'read', value: { path: 'AGENTS.md', cwd: '/srv/kairos' } },
    });
    expect(
      captureError(() =>
        decodeServerMessage(
          encodeServerMessage({ payload: { case: 'operationStart', value: invalid } }),
        ),
      ),
    ).toMatchObject({ code: 'INVALID_MESSAGE' });
  });

  it('round-trips image bytes and rejects invalid image results', () => {
    const start = create(OperationStartSchema, {
      operationId: 'operation-image',
      requestId: 'request-image',
      target: { ...target, bindingVersion: 3n },
      expiresAt: { seconds: 1_762_000_000n },
      action: { case: 'readImage', value: { path: 'pixel.png', cwd: '/srv/kairos' } },
    });
    const decodedStart = decodeServerMessage(
      encodeServerMessage({ payload: { case: 'operationStart', value: start } }),
    );
    expect(decodedStart.payload.case).toBe('operationStart');
    if (decodedStart.payload.case !== 'operationStart') throw new Error('Unexpected payload.');
    expect(decodedStart.payload.value.action).toMatchObject({
      case: 'readImage',
      value: { path: 'pixel.png', cwd: '/srv/kairos' },
    });

    const result = decodeDaemonMessage(
      encodeDaemonMessage({
        payload: {
          case: 'operationResult',
          value: {
            operationId: 'operation-image',
            target: { ...target, bindingVersion: 3n },
            status: OperationStatus.COMPLETED,
            outcome: {
              case: 'readImage',
              value: {
                path: '/srv/kairos/pixel.png',
                data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
                fileVersion: 'a'.repeat(64),
              },
            },
          },
        },
      }),
    );
    expect(result.payload).toMatchObject({
      case: 'operationResult',
      value: {
        outcome: { case: 'readImage', value: { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) } },
      },
    });

    const invalid = create(DaemonMessageSchema, {
      protocolMajor: 1,
      payload: {
        case: 'operationResult',
        value: {
          operationId: 'operation-image',
          target: { ...target, bindingVersion: 3n },
          status: OperationStatus.COMPLETED,
          outcome: {
            case: 'readImage',
            value: {
              path: '/srv/kairos/pixel.png',
              data: new Uint8Array(700_001),
              fileVersion: 'a'.repeat(64),
            },
          },
        },
      },
    });
    expect(
      captureError(() => decodeDaemonMessage(toBinary(DaemonMessageSchema, invalid))),
    ).toMatchObject({ code: 'INVALID_MESSAGE' });
  });

  it('rejects unknown operation actions, outcomes and enum values', () => {
    const emptyStart = create(OperationStartSchema, {
      operationId: 'operation-1',
      requestId: 'request-1',
      target,
      expiresAt: { seconds: 1_762_000_000n },
    });
    expect(
      captureError(() =>
        decodeServerMessage(
          encodeServerMessage({ payload: { case: 'operationStart', value: emptyStart } }),
        ),
      ),
    ).toMatchObject({ code: 'UNSUPPORTED_PAYLOAD' });

    const resultTarget = new BinaryWriter()
      .tag(1, WireType.LengthDelimited)
      .string('env-1')
      .tag(2, WireType.LengthDelimited)
      .string('binding-1')
      .tag(3, WireType.LengthDelimited)
      .string('instance-1')
      .finish();
    const result = new BinaryWriter()
      .tag(1, WireType.LengthDelimited)
      .string('operation-1')
      .tag(2, WireType.LengthDelimited)
      .bytes(resultTarget)
      .tag(3, WireType.Varint)
      .uint32(99)
      .tag(10, WireType.LengthDelimited)
      .bytes(new Uint8Array())
      .finish();
    const encoded = new BinaryWriter()
      .tag(1, WireType.Varint)
      .uint32(1)
      .tag(12, WireType.LengthDelimited)
      .bytes(result)
      .finish();
    expect(captureError(() => decodeDaemonMessage(encoded))).toMatchObject({
      code: 'UNSUPPORTED_PAYLOAD',
    });

    const emptyResult = create(DaemonMessageSchema, {
      protocolMajor: 1,
      payload: {
        case: 'operationResult',
        value: {
          operationId: 'operation-1',
          target,
          status: OperationStatus.COMPLETED,
        },
      },
    });
    expect(
      captureError(() => decodeDaemonMessage(toBinary(DaemonMessageSchema, emptyResult))),
    ).toMatchObject({
      code: 'UNSUPPORTED_PAYLOAD',
    });
  });

  it('round-trips device revocation and read-only maintenance state', () => {
    const revoked = decodeDaemonMessage(
      encodeDaemonMessage({
        payload: {
          case: 'environmentRevoke',
          value: {
            requestId: 'revoke-request',
            envId: 'env-1',
            deviceBindingId: 'binding-1',
            reason: 'uninstall',
          },
        },
      }),
    );
    expect(revoked.payload.case).toBe('environmentRevoke');
    const acknowledged = decodeServerMessage(
      encodeServerMessage({
        payload: {
          case: 'environmentRevokeAck',
          value: {
            requestId: 'revoke-request',
            envId: 'env-1',
            deviceBindingId: 'binding-1',
            revokedAt: { seconds: 1_762_000_000n },
          },
        },
      }),
    );
    expect(acknowledged.payload.case).toBe('environmentRevokeAck');

    const query = decodeDaemonMessage(
      encodeDaemonMessage({
        payload: {
          case: 'environmentMaintenanceQuery',
          value: { requestId: 'maintenance-request', envId: 'env-1', deviceBindingId: 'binding-1' },
        },
      }),
    );
    expect(query.payload.case).toBe('environmentMaintenanceQuery');
    const maximum = (1n << 64n) - 1n;
    const report = decodeServerMessage(
      encodeServerMessage({
        payload: {
          case: 'environmentMaintenanceReport',
          value: {
            requestId: 'maintenance-request',
            envId: 'env-1',
            deviceBindingId: 'binding-1',
            maintenanceMode: DeviceMaintenanceMode.DRAINING,
            maintenanceVersion: maximum,
            activeOperationCount: maximum,
          },
        },
      }),
    );
    expect(report.payload.case).toBe('environmentMaintenanceReport');
    if (report.payload.case !== 'environmentMaintenanceReport') {
      throw new Error('Unexpected payload.');
    }
    expect(report.payload.value.maintenanceVersion).toBe(maximum);
    expect(report.payload.value.activeOperationCount).toBe(maximum);
  });
});

it('round-trips control-only handshakes and rejects pairing or execution grants on them', () => {
  const hello = decodeDaemonMessage(
    encodeDaemonMessage({
      payload: {
        case: 'deviceHello',
        value: {
          controlOnly: true,
          protocolMajor: 1,
          deviceId: 'device',
          deviceBindingId: 'binding',
          envId: 'env',
          instanceId: 'control',
          authentication: { case: 'deviceCredential', value: 'existing-credential' },
        },
      },
    }),
  );
  expect(hello.payload.value).toMatchObject({ controlOnly: true, capabilities: [] });
  const acknowledgement = decodeServerMessage(
    encodeServerMessage({
      payload: {
        case: 'serverHello',
        value: {
          controlOnly: true,
          protocolMajor: 1,
          deviceId: 'device',
          deviceBindingId: 'binding',
          envId: 'env',
          instanceId: 'control',
          serverTime: { seconds: 1n },
        },
      },
    }),
  );
  expect(acknowledgement.payload.value).toMatchObject({ controlOnly: true, capabilities: [] });
  expect(() =>
    decodeDaemonMessage(
      encodeDaemonMessage({
        payload: {
          case: 'deviceHello',
          value: {
            controlOnly: true,
            protocolMajor: 1,
            authentication: { case: 'pairingCredential', value: 'pairing' },
          },
        },
      }),
    ),
  ).toThrow('existing credential');
  expect(() =>
    decodeDaemonMessage(
      encodeDaemonMessage({
        payload: {
          case: 'deviceHello',
          value: {
            controlOnly: true,
            protocolMajor: 1,
            capabilities: [1],
            authentication: { case: 'deviceCredential', value: 'credential' },
          },
        },
      }),
    ),
  ).toThrow('no capabilities');
  expect(() =>
    decodeServerMessage(
      encodeServerMessage({
        payload: {
          case: 'serverHello',
          value: { controlOnly: true, protocolMajor: 1, capabilities: [1] },
        },
      }),
    ),
  ).toThrow('grant capabilities');
  expect(() =>
    decodeServerMessage(
      encodeServerMessage({
        payload: {
          case: 'serverHello',
          value: { controlOnly: true, protocolMajor: 1, deviceCredential: 'new-credential' },
        },
      }),
    ),
  ).toThrow('issue credentials');
});
