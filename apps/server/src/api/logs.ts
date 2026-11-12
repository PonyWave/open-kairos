import { open, stat } from 'node:fs/promises';
import { BashLogStream, type ReadBashLogRequest } from '@kairos/contracts';
import { z } from 'zod';
import type { BashOperationRecord, DeviceBashStore } from '../devices/operation-store.js';
import { SessionError } from '../sessions/errors.js';
import type { ServerBashOperationRecord } from '../sessions/records.js';
import type { SessionStore } from '../sessions/store.js';

const containingChunkSchema = z.object({
  offset: z.string(),
  stream: z.number().int().min(1).max(2),
  data: z.instanceof(Uint8Array),
});

export interface BashLogReaderOptions {
  store: SessionStore;
  operations: DeviceBashStore;
  maximumBytes?: number;
  retentionMs?: number;
  now?: () => Date;
}

export class BashLogReader {
  readonly #store: SessionStore;
  readonly #operations: DeviceBashStore;
  readonly #maximumBytes: number;
  readonly #retentionMs: number;
  readonly #now: () => Date;

  constructor(options: BashLogReaderOptions) {
    this.#store = options.store;
    this.#operations = options.operations;
    this.#maximumBytes = options.maximumBytes ?? 64 * 1024;
    this.#retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    this.#now = options.now ?? (() => new Date());
  }

  async read(ownerId: string, request: ReadBashLogRequest) {
    if (request.offset === undefined) {
      throw new SessionError('invalid_argument', 'Bash log offset is required.');
    }
    const device = this.#operations.find(request.operationId);
    return device
      ? this.#readDevice(ownerId, request, request.offset, device)
      : this.#readServer(ownerId, request, request.offset);
  }

  #readDevice(
    ownerId: string,
    request: ReadBashLogRequest,
    offset: bigint,
    candidate: BashOperationRecord,
  ) {
    const operation = this.#operations.getForOwner(ownerId, candidate.operationId);
    if (this.#expired(operation.resultAcknowledgedAt)) {
      return {
        operationId: operation.operationId,
        chunks: [],
        gaps: [],
        deviceId: operation.deviceId,
        cwd: operation.cwd,
        outputComplete: operation.outputComplete,
        expired: true,
      };
    }
    const limit = Math.min(request.limitBytes, this.#maximumBytes);
    const containing = this.#containingChunk(operation.operationId, offset);
    const subsequent = this.#operations.readOutputForOwner(
      ownerId,
      operation.operationId,
      offset,
      1000,
    );
    const records = (function* () {
      if (containing) yield containing;
      yield* subsequent;
    })();
    const chunks: Array<{
      offset: bigint;
      stream: BashLogStream;
      data: Uint8Array;
    }> = [];
    const gaps: Array<{ startOffset: bigint; endOffset?: bigint }> = [];
    let cursor = offset;
    let bytes = 0;
    let readAny = false;
    for (const record of records) {
      readAny = true;
      if (record.offset > cursor) {
        gaps.push({ startOffset: cursor, endOffset: record.offset });
        cursor = record.offset;
      }
      const remaining = limit - bytes;
      const start = record.offset < cursor ? Number(cursor - record.offset) : 0;
      const data = record.data.slice(start, start + remaining);
      chunks.push({
        offset: cursor,
        stream: record.stream === 1 ? BashLogStream.STDOUT : BashLogStream.STDERR,
        data,
      });
      cursor += BigInt(data.length);
      bytes += data.length;
      if (bytes >= limit) break;
    }
    if (!readAny && cursor < operation.nextOffset) {
      gaps.push({ startOffset: cursor, endOffset: operation.nextOffset });
      cursor = operation.nextOffset;
    }
    const unreadOutput =
      this.#store.database
        .prepare(
          `SELECT 1 FROM device_bash_output_chunks
           WHERE operation_id = ? AND end_offset > ? LIMIT 1`,
        )
        .get(operation.operationId, cursor.toString().padStart(20, '0')) !== undefined;
    if (
      !unreadOutput &&
      operation.outputGap &&
      operation.endOffset !== undefined &&
      cursor < operation.endOffset
    ) {
      gaps.push({ startOffset: cursor, endOffset: operation.endOffset });
      cursor = operation.endOffset;
    }
    const advanced = cursor > offset;
    const hasMore =
      unreadOutput ||
      cursor < operation.nextOffset ||
      (operation.outputGap && operation.endOffset !== undefined && cursor < operation.endOffset);
    return {
      operationId: operation.operationId,
      chunks,
      ...(advanced && hasMore ? { nextOffset: cursor } : {}),
      outputComplete: operation.outputComplete,
      gaps,
      deviceId: operation.deviceId,
      cwd: operation.cwd,
      expired: false,
    };
  }

  #containingChunk(operationId: string, offset: bigint) {
    if (offset === 0n) return undefined;
    const key = offset.toString().padStart(20, '0');
    const row = this.#store.database
      .prepare(
        `SELECT offset, stream, data FROM device_bash_output_chunks
         WHERE operation_id = ? AND offset < ? AND end_offset > ?
         ORDER BY offset DESC LIMIT 1`,
      )
      .get(operationId, key, key);
    if (row === undefined) return undefined;
    const parsed = containingChunkSchema.parse(row);
    return {
      offset: BigInt(parsed.offset),
      stream: parsed.stream,
      data: Buffer.from(parsed.data),
    };
  }

  async #readServer(ownerId: string, request: ReadBashLogRequest, offset: bigint) {
    const operation = this.#store.getServerBashOperation(ownerId, request.operationId);
    if (operation.expiresAt !== null && this.#now().getTime() >= Date.parse(operation.expiresAt)) {
      return this.#expiredServer(operation);
    }
    if (!operation.logPath) {
      return {
        operationId: operation.operationId,
        chunks: [],
        gaps: [],
        deviceId: '',
        cwd: '',
        outputComplete: operation.outputComplete,
        expired: false,
      };
    }
    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await stat(operation.logPath);
      if (!metadata.isFile()) throw new Error('Not a regular file.');
    } catch (error) {
      throw new SessionError('operation_unknown', 'The Server Bash log is unavailable.', {
        cause: error,
      });
    }
    if (this.#now().getTime() - metadata.mtimeMs > this.#retentionMs) {
      return this.#expiredServer(operation);
    }
    const size = BigInt(metadata.size);
    if (offset >= size) {
      return {
        operationId: operation.operationId,
        chunks: [],
        gaps: [],
        deviceId: '',
        cwd: '',
        outputComplete: operation.outputComplete,
        expired: false,
      };
    }
    const length = Math.min(request.limitBytes, this.#maximumBytes, Number(size - offset));
    const data = Buffer.alloc(length);
    const handle = await open(operation.logPath, 'r');
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(data, 0, length, Number(offset)));
    } finally {
      await handle.close();
    }
    const next = offset + BigInt(bytesRead);
    return {
      operationId: operation.operationId,
      chunks:
        bytesRead === 0
          ? []
          : [{ offset, stream: BashLogStream.STDOUT, data: data.subarray(0, bytesRead) }],
      ...(bytesRead === length && next < size ? { nextOffset: next } : {}),
      outputComplete: operation.outputComplete,
      gaps: [],
      deviceId: '',
      cwd: '',
      expired: false,
    };
  }

  #expired(value: string | null | undefined): boolean {
    if (!value) return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && this.#now().getTime() - time > this.#retentionMs;
  }

  #expiredServer(operation: ServerBashOperationRecord) {
    return {
      operationId: operation.operationId,
      chunks: [],
      gaps: [],
      deviceId: '',
      cwd: '',
      outputComplete: operation.outputComplete,
      expired: true,
    };
  }
}
