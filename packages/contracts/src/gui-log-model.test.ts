import { create, fromBinary, toBinary, toJson } from '@bufbuild/protobuf';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { describe, expect, it } from 'vitest';
import {
  BashLogChunkSchema,
  BashLogGapSchema,
  BashLogService,
  BashLogStream,
  ContractValidationError,
  decodeGetModelStatusResponse,
  decodeReadBashLogRequest,
  decodeReadBashLogResponse,
  GetModelStatusResponseSchema,
  ModelService,
  ReadBashLogRequestSchema,
  ReadBashLogResponseSchema,
  validateGetModelStatusResponse,
  validateReadBashLogRequest,
  validateReadBashLogResponse,
} from './index.js';

const hugeOffset = 9_007_199_254_740_993n;

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to be rejected.');
}

describe('Bash log and model service contracts', () => {
  it('exposes unary generated methods and accepts no server file path', () => {
    expect(BashLogService.method.readBashLog.methodKind).toBe('unary');
    expect(ModelService.method.getModelStatus.methodKind).toBe('unary');
    expect(ReadBashLogRequestSchema.fields.map((field) => field.localName)).toEqual([
      'operationId',
      'offset',
      'limitBytes',
    ]);
    expect(ReadBashLogResponseSchema.fields.map((field) => field.localName)).toEqual([
      'operationId',
      'chunks',
      'nextOffset',
      'outputComplete',
      'gaps',
      'deviceId',
      'cwd',
      'expired',
    ]);
    expect(GetModelStatusResponseSchema.fields.map((field) => field.localName)).toEqual([
      'providerId',
      'modelId',
      'contextCapacity',
      'outputReserve',
      'available',
      'configurationErrors',
    ]);
  });

  it('round-trips uint64 request and response offsets without precision loss', () => {
    const request = create(ReadBashLogRequestSchema, {
      operationId: 'operation-1',
      offset: hugeOffset,
      limitBytes: 65_536,
    });
    const decodedRequest = decodeReadBashLogRequest(toBinary(ReadBashLogRequestSchema, request));
    expect(decodedRequest.offset).toBe(hugeOffset);
    expect(toJson(ReadBashLogRequestSchema, decodedRequest)).toMatchObject({
      offset: '9007199254740993',
    });

    const response = create(ReadBashLogResponseSchema, {
      operationId: request.operationId,
      nextOffset: hugeOffset + 1n,
      outputComplete: false,
      gaps: [{ startOffset: hugeOffset, endOffset: hugeOffset + 1n }],
      expired: false,
    });
    const decodedResponse = decodeReadBashLogResponse(
      toBinary(ReadBashLogResponseSchema, response),
      request,
    );
    expect(decodedResponse.nextOffset).toBe(hugeOffset + 1n);
    expect(toJson(ReadBashLogResponseSchema, decodedResponse)).toMatchObject({
      nextOffset: '9007199254740994',
    });
  });

  it('retains output bytes, stream sources, gaps, and execution location', () => {
    const request = create(ReadBashLogRequestSchema, {
      operationId: 'operation-1',
      offset: 0n,
      limitBytes: 1024,
    });
    const response = create(ReadBashLogResponseSchema, {
      operationId: request.operationId,
      chunks: [
        { offset: 0n, stream: BashLogStream.STDOUT, data: new Uint8Array([0xe4, 0xbd, 0xa0]) },
        { offset: 5n, stream: BashLogStream.STDERR, data: new Uint8Array([0, 255]) },
      ],
      nextOffset: 20n,
      outputComplete: false,
      gaps: [
        { startOffset: 3n, endOffset: 5n },
        { startOffset: 7n, endOffset: 20n },
      ],
      deviceId: 'device-1',
      cwd: '/tmp',
      expired: false,
    });
    const decoded = decodeReadBashLogResponse(
      toBinary(ReadBashLogResponseSchema, response),
      request,
    );
    expect(decoded.chunks.map((chunk) => chunk.stream)).toEqual([
      BashLogStream.STDOUT,
      BashLogStream.STDERR,
    ]);
    expect(decoded.chunks[1]?.data).toEqual(new Uint8Array([0, 255]));
    expect(decoded.gaps).toHaveLength(2);
    expect(decoded.gaps[0]).toMatchObject({ startOffset: 3n, endOffset: 5n });
    expect(decoded.gaps[1]).toMatchObject({ startOffset: 7n, endOffset: 20n });
    expect(decoded.deviceId).toBe('device-1');
    expect(decoded.cwd).toBe('/tmp');
  });
});

describe('Bash log business validation', () => {
  it('rejects a missing offset, empty operation id, and zero page size', () => {
    const valid = { operationId: 'operation-1', offset: 0n, limitBytes: 4096 };
    for (const request of [
      create(ReadBashLogRequestSchema, { ...valid, offset: undefined }),
      create(ReadBashLogRequestSchema, { ...valid, operationId: '' }),
      create(ReadBashLogRequestSchema, { ...valid, limitBytes: 0 }),
    ]) {
      expect(captureError(() => validateReadBashLogRequest(request))).toMatchObject({
        code: 'INVALID_MESSAGE',
      });
    }
  });

  it('rejects unknown stream enums instead of displaying them as stdout', () => {
    const chunk = new BinaryWriter()
      .tag(2, WireType.Varint)
      .uint32(99)
      .tag(3, WireType.LengthDelimited)
      .bytes(new Uint8Array([120]))
      .finish();
    const encoded = new BinaryWriter()
      .tag(1, WireType.LengthDelimited)
      .string('operation-1')
      .tag(2, WireType.LengthDelimited)
      .bytes(chunk)
      .tag(4, WireType.Varint)
      .bool(false)
      .tag(8, WireType.Varint)
      .bool(false)
      .finish();
    const decoded = fromBinary(ReadBashLogResponseSchema, encoded);
    expect(decoded.chunks[0]?.stream).toBe(99);
    expect(captureError(() => decodeReadBashLogResponse(encoded))).toMatchObject({
      code: 'INVALID_MESSAGE',
    });
  });

  it('accepts an explicit expired response and rejects expired data or pagination', () => {
    const expired = create(ReadBashLogResponseSchema, {
      operationId: 'operation-1',
      outputComplete: false,
      deviceId: 'device-1',
      cwd: '/tmp',
      expired: true,
    });
    expect(decodeReadBashLogResponse(toBinary(ReadBashLogResponseSchema, expired)).expired).toBe(
      true,
    );
    for (const response of [
      create(ReadBashLogResponseSchema, {
        ...expired,
        chunks: [
          create(BashLogChunkSchema, { stream: BashLogStream.STDOUT, data: new Uint8Array([1]) }),
        ],
      }),
      create(ReadBashLogResponseSchema, { ...expired, nextOffset: 1n }),
    ]) {
      expect(captureError(() => validateReadBashLogResponse(response))).toMatchObject({
        code: 'INVALID_MESSAGE',
      });
    }
  });

  it('rejects missing state, mismatched operations, regressing pages, and contradictory gaps', () => {
    const valid = create(ReadBashLogResponseSchema, {
      operationId: 'operation-1',
      chunks: [
        create(BashLogChunkSchema, {
          stream: BashLogStream.STDOUT,
          data: new Uint8Array([1, 2]),
        }),
      ],
      nextOffset: 2n,
      outputComplete: false,
      expired: false,
    });
    const cases = [
      create(ReadBashLogResponseSchema, { ...valid, outputComplete: undefined }),
      create(ReadBashLogResponseSchema, { ...valid, expired: undefined }),
      create(ReadBashLogResponseSchema, { ...valid, operationId: 'operation-2' }),
      create(ReadBashLogResponseSchema, { ...valid, nextOffset: 0n }),
      create(ReadBashLogResponseSchema, {
        ...valid,
        nextOffset: undefined,
        outputComplete: true,
        gaps: [create(BashLogGapSchema, { startOffset: 1n, endOffset: 2n })],
      }),
      create(ReadBashLogResponseSchema, {
        ...valid,
        gaps: [create(BashLogGapSchema, { startOffset: 2n, endOffset: 2n })],
      }),
      create(ReadBashLogResponseSchema, {
        ...valid,
        nextOffset: undefined,
        chunks: [
          create(BashLogChunkSchema, {
            stream: BashLogStream.STDOUT,
            data: new Uint8Array(101),
          }),
        ],
      }),
    ];
    const request = create(ReadBashLogRequestSchema, {
      operationId: 'operation-1',
      offset: 0n,
      limitBytes: 100,
    });
    for (const response of cases) {
      expect(captureError(() => validateReadBashLogResponse(response, request))).toMatchObject({
        code: 'INVALID_MESSAGE',
      });
    }
  });

  it('requires ordered, bounded gaps to explain every forward offset jump', () => {
    const request = create(ReadBashLogRequestSchema, {
      operationId: 'operation-1',
      offset: 0n,
      limitBytes: 1024,
    });
    const chunk = (offset: bigint, length = 2) =>
      create(BashLogChunkSchema, {
        offset,
        stream: BashLogStream.STDOUT,
        data: new Uint8Array(length),
      });
    const gap = (startOffset: bigint, endOffset?: bigint) =>
      create(BashLogGapSchema, { startOffset, endOffset });
    const base = { operationId: 'operation-1', outputComplete: false, expired: false };
    const invalid = [
      create(ReadBashLogResponseSchema, {
        ...base,
        chunks: [chunk(0n), chunk(3n, 1)],
        nextOffset: 4n,
      }),
      create(ReadBashLogResponseSchema, {
        ...base,
        chunks: [chunk(0n), chunk(4n, 1)],
        nextOffset: 5n,
        gaps: [gap(2n, 3n)],
      }),
      create(ReadBashLogResponseSchema, {
        ...base,
        chunks: [chunk(0n)],
        nextOffset: 4n,
        gaps: [gap(2n, 3n)],
      }),
      create(ReadBashLogResponseSchema, {
        ...base,
        chunks: [chunk(3n, 1)],
        nextOffset: 4n,
      }),
      create(ReadBashLogResponseSchema, {
        ...base,
        chunks: [chunk(0n)],
        nextOffset: 4n,
        gaps: [gap(2n, 5n)],
      }),
      create(ReadBashLogResponseSchema, {
        ...base,
        chunks: [chunk(0n)],
        nextOffset: 2n,
        gaps: [gap(1n, 2n)],
      }),
      create(ReadBashLogResponseSchema, {
        ...base,
        nextOffset: 2n,
        gaps: [gap(0n)],
      }),
      create(ReadBashLogResponseSchema, {
        ...base,
        nextOffset: 4n,
        gaps: [gap(2n, 3n), gap(1n, 2n)],
      }),
      create(ReadBashLogResponseSchema, {
        ...base,
        nextOffset: 4n,
        gaps: [gap(1n, 3n), gap(2n, 4n)],
      }),
    ];
    for (const response of invalid) {
      expect(captureError(() => validateReadBashLogResponse(response, request))).toMatchObject({
        code: 'INVALID_MESSAGE',
      });
    }

    const valid = create(ReadBashLogResponseSchema, {
      ...base,
      chunks: [chunk(0n), chunk(4n, 1)],
      nextOffset: 6n,
      gaps: [gap(2n, 4n), gap(5n, 6n)],
    });
    expect(() => validateReadBashLogResponse(valid, request)).not.toThrow();
  });
});

describe('model status business validation', () => {
  it('round-trips available configuration and public unavailable errors', () => {
    const available = create(GetModelStatusResponseSchema, {
      providerId: 'provider-1',
      modelId: 'model-1',
      contextCapacity: 200_000,
      outputReserve: 16_384,
      available: true,
    });
    expect(
      decodeGetModelStatusResponse(toBinary(GetModelStatusResponseSchema, available)),
    ).toMatchObject({ providerId: 'provider-1', contextCapacity: 200_000 });

    const unavailable = create(GetModelStatusResponseSchema, {
      providerId: 'provider-1',
      modelId: 'model-1',
      contextCapacity: 200_000,
      outputReserve: 16_384,
      available: false,
      configurationErrors: [{ code: 'AUTH_MISSING', message: 'Provider 认证尚未配置。' }],
    });
    expect(
      decodeGetModelStatusResponse(toBinary(GetModelStatusResponseSchema, unavailable))
        .configurationErrors[0]?.message,
    ).toBe('Provider 认证尚未配置。');
  });

  it('rejects missing, contradictory, and unsupported model states', () => {
    const valid = create(GetModelStatusResponseSchema, {
      providerId: 'provider-1',
      modelId: 'model-1',
      contextCapacity: 200_000,
      outputReserve: 16_384,
      available: true,
    });
    for (const response of [
      create(GetModelStatusResponseSchema, { ...valid, contextCapacity: undefined }),
      create(GetModelStatusResponseSchema, { ...valid, outputReserve: undefined }),
      create(GetModelStatusResponseSchema, { ...valid, available: undefined }),
      create(GetModelStatusResponseSchema, { ...valid, providerId: '' }),
      create(GetModelStatusResponseSchema, { ...valid, outputReserve: 200_000 }),
      create(GetModelStatusResponseSchema, {
        ...valid,
        available: false,
        configurationErrors: [],
      }),
    ]) {
      expect(captureError(() => validateGetModelStatusResponse(response))).toBeInstanceOf(
        ContractValidationError,
      );
    }
  });
});
