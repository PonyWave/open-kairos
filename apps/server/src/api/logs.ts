import { open, stat } from 'node:fs/promises';
import { BashLogStream, type ReadBashLogRequest } from '@kairos/contracts';
import { SessionError } from '../sessions/errors.js';
import type { ServerBashOperationRecord } from '../sessions/records.js';
import type { SessionStore } from '../sessions/store.js';

export interface BashLogReaderOptions {
  store: SessionStore;
  maximumBytes?: number;
  retentionMs?: number;
  now?: () => Date;
}

export class BashLogReader {
  readonly #store: SessionStore;
  readonly #maximumBytes: number;
  readonly #retentionMs: number;
  readonly #now: () => Date;

  constructor(options: BashLogReaderOptions) {
    this.#store = options.store;
    this.#maximumBytes = options.maximumBytes ?? 64 * 1024;
    this.#retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    this.#now = options.now ?? (() => new Date());
  }

  async read(ownerId: string, request: ReadBashLogRequest) {
    if (request.offset === undefined) {
      throw new SessionError('invalid_argument', 'Bash log offset is required.');
    }
    return this.#readServer(ownerId, request, request.offset);
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
