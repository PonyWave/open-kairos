import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  BASH_MAX_TIMEOUT_SECONDS,
  BashStatus,
  DeviceErrorAction,
  DeviceErrorCode,
  OutputStream,
} from '@kairos/contracts/device';

export interface BashStartCommand {
  operationId: string;
  requestId: string;
  runId: string;
  deviceId: string;
  instanceId: string;
  command: string;
  cwd: string;
  expiresAt: Date;
  timeoutSeconds: number;
}

export interface BashAcceptedEvent {
  type: 'accepted';
  operationId: string;
  requestId: string;
  instanceId: string;
  status: BashStatus;
  acceptedAt: Date;
}

export interface BashStateEvent {
  type: 'state';
  operationId: string;
  instanceId: string;
  status: BashStatus;
  observedAt: Date;
  requestId?: string;
}

export interface BashOutputEvent {
  type: 'output';
  operationId: string;
  instanceId: string;
  offset: bigint;
  stream: OutputStream;
  data: Uint8Array;
}

export interface BashResultEvent {
  type: 'result';
  operationId: string;
  instanceId: string;
  status: BashStatus;
  exitCode?: number;
  outputComplete: boolean;
  endOffset?: bigint;
  requestId?: string;
}

export type BashEvent = BashAcceptedEvent | BashStateEvent | BashOutputEvent | BashResultEvent;

export class BashOperationFailure extends Error {
  constructor(
    readonly code: DeviceErrorCode,
    message: string,
    readonly action: DeviceErrorAction = DeviceErrorAction.ABORT,
    readonly operationId?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'BashOperationFailure';
  }
}

interface BufferedChunk {
  offset: bigint;
  stream: OutputStream.STDOUT | OutputStream.STDERR;
  data: Buffer;
}

interface Operation {
  command: BashStartCommand;
  child?: ChildProcess;
  status: BashStatus;
  acceptedAt: Date;
  pending: BufferedChunk[];
  sendIndex: number;
  flushing: boolean;
  resumeRequested: boolean;
  sendGeneration: number;
  bufferedBytes: number;
  observedBytes: bigint;
  result?: BashResultEvent;
  resultSent: boolean;
  resultAcknowledged: boolean;
  paused: boolean;
  collectionFailed: boolean;
  spawnFailed: boolean;
  stdioDiscarded: boolean;
  cancelRequested: boolean;
  timedOut: boolean;
  timeout?: NodeJS.Timeout;
  killEscalation?: NodeJS.Timeout;
}

interface CompletedOperation {
  fingerprint: string;
  acceptedAt: Date;
  result: BashResultEvent;
}

function commandFingerprint(command: BashStartCommand): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        command.runId,
        command.deviceId,
        command.instanceId,
        command.command,
        command.cwd,
        command.expiresAt.toISOString(),
        command.timeoutSeconds,
      ]),
    )
    .digest('hex');
}

export interface BashManagerOptions {
  instanceId: string;
  send: (event: BashEvent) => Promise<void>;
  onTransportError: (error: unknown) => void;
  now?: () => Date;
  maxPendingBytes?: number;
  maxChunkBytes?: number;
  maxOperations?: number;
  killGraceMilliseconds?: number;
  onRetired?: (operationId: string) => void;
}

function text(value: string, field: string, maximum: number): string {
  if (value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new BashOperationFailure(
      DeviceErrorCode.INVALID_MESSAGE,
      `${field} must contain between 1 and ${maximum} characters.`,
    );
  }
  return value;
}

function isTerminal(status: BashStatus): boolean {
  return [
    BashStatus.COMPLETED,
    BashStatus.FAILED,
    BashStatus.CANCELLED,
    BashStatus.EXPIRED,
    BashStatus.UNKNOWN,
  ].includes(status);
}

export class BashManager {
  private readonly operations = new Map<string, Operation>();
  private readonly completedOperations = new Map<string, CompletedOperation>();
  private readonly now: () => Date;
  private readonly maxPendingBytes: number;
  private readonly maxChunkBytes: number;
  private readonly maxOperations: number;
  private readonly killGraceMilliseconds: number;

  constructor(private readonly options: BashManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxPendingBytes = options.maxPendingBytes ?? 1024 * 1024;
    this.maxChunkBytes = options.maxChunkBytes ?? 64 * 1024;
    this.maxOperations = options.maxOperations ?? 256;
    this.killGraceMilliseconds = options.killGraceMilliseconds ?? 5000;
    for (const [name, value] of [
      ['maxPendingBytes', this.maxPendingBytes],
      ['maxChunkBytes', this.maxChunkBytes],
      ['maxOperations', this.maxOperations],
      ['killGraceMilliseconds', this.killGraceMilliseconds],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive safe integer.`);
      }
    }
  }

  get pendingOperationCount(): number {
    return this.operations.size;
  }

  bufferedBytes(operationId: string): number {
    return this.operations.get(operationId)?.bufferedBytes ?? 0;
  }

  isPaused(operationId: string): boolean {
    return this.operations.get(operationId)?.paused ?? false;
  }

  start(command: BashStartCommand): void {
    this.validateCommand(command);
    const completed = this.completedOperations.get(command.operationId);
    if (completed !== undefined) {
      if (completed.fingerprint !== commandFingerprint(command)) {
        throw new BashOperationFailure(
          DeviceErrorCode.OPERATION_CONFLICT,
          'The operation ID is already associated with different Bash parameters.',
          DeviceErrorAction.QUERY_OPERATION,
          command.operationId,
          command.requestId,
        );
      }
      this.emit({
        type: 'accepted',
        operationId: command.operationId,
        requestId: command.requestId,
        instanceId: this.options.instanceId,
        status: completed.result.status,
        acceptedAt: completed.acceptedAt,
      });
      this.emit({ ...completed.result, requestId: command.requestId });
      return;
    }
    const existing = this.operations.get(command.operationId);
    if (existing !== undefined) {
      if (!this.sameParameters(existing.command, command)) {
        throw new BashOperationFailure(
          DeviceErrorCode.OPERATION_CONFLICT,
          'The operation ID is already associated with different Bash parameters.',
          DeviceErrorAction.QUERY_OPERATION,
          command.operationId,
          command.requestId,
        );
      }
      this.emit({
        type: 'accepted',
        operationId: command.operationId,
        requestId: command.requestId,
        instanceId: this.options.instanceId,
        status: existing.status,
        acceptedAt: existing.acceptedAt,
      });
      existing.sendGeneration += 1;
      existing.sendIndex = 0;
      existing.resultSent = false;
      this.resumeOperation(existing);
      return;
    }
    if (this.operations.size + this.completedOperations.size >= this.maxOperations) {
      this.evictCompletedOperations();
    }
    if (this.operations.size + this.completedOperations.size >= this.maxOperations) {
      throw new BashOperationFailure(
        DeviceErrorCode.MESSAGE_TOO_LARGE,
        'The Daemon operation memory limit has been reached.',
        DeviceErrorAction.RETRY,
        command.operationId,
        command.requestId,
      );
    }
    if (command.expiresAt.getTime() <= this.now().getTime()) {
      throw new BashOperationFailure(
        DeviceErrorCode.OPERATION_EXPIRED,
        'The Bash start command has expired.',
        DeviceErrorAction.ABORT,
        command.operationId,
        command.requestId,
      );
    }

    const operation: Operation = {
      command,
      status: BashStatus.ACCEPTED,
      acceptedAt: this.now(),
      pending: [],
      sendIndex: 0,
      flushing: false,
      resumeRequested: false,
      sendGeneration: 0,
      bufferedBytes: 0,
      observedBytes: 0n,
      resultSent: false,
      resultAcknowledged: false,
      paused: false,
      collectionFailed: false,
      spawnFailed: false,
      stdioDiscarded: false,
      cancelRequested: false,
      timedOut: false,
    };
    this.operations.set(command.operationId, operation);
    this.emit({
      type: 'accepted',
      operationId: command.operationId,
      requestId: command.requestId,
      instanceId: this.options.instanceId,
      status: operation.status,
      acceptedAt: operation.acceptedAt,
    });

    const child = spawn('/bin/bash', ['-c', command.command], {
      cwd: command.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    operation.child = child;
    if (child.stdout === null || child.stderr === null) {
      operation.collectionFailed = true;
      throw new BashOperationFailure(
        DeviceErrorCode.INTERNAL,
        'Bash output pipes could not be created.',
        DeviceErrorAction.QUERY_OPERATION,
        command.operationId,
        command.requestId,
      );
    }
    operation.status = BashStatus.RUNNING;
    child.stdout.on('readable', () => {
      this.drain(operation, OutputStream.STDOUT);
    });
    child.stderr.on('readable', () => {
      this.drain(operation, OutputStream.STDERR);
    });
    child.stdout.on('error', () => {
      operation.collectionFailed = true;
    });
    child.stderr.on('error', () => {
      operation.collectionFailed = true;
    });
    child.once('error', () => {
      operation.collectionFailed = true;
      operation.spawnFailed = true;
    });
    child.once('close', (code) => {
      this.finish(operation, code);
    });
    operation.timeout = setTimeout(() => {
      if (operation.result !== undefined) return;
      operation.timedOut = true;
      operation.status = BashStatus.EXPIRED;
      this.emitState(operation);
      this.terminate(operation, 'SIGTERM');
    }, command.timeoutSeconds * 1000);
  }

  query(operationId: string, instanceId: string, requestId: string): void {
    const completed = this.completedForInstance(operationId, instanceId, requestId);
    if (completed !== undefined) {
      this.emit({
        type: 'state',
        operationId,
        instanceId: this.options.instanceId,
        status: completed.result.status,
        observedAt: this.now(),
        requestId,
      });
      this.emit({ ...completed.result, requestId });
      return;
    }
    const operation = this.requireOperation(operationId, instanceId, requestId);
    this.emit({
      type: 'state',
      operationId,
      instanceId: this.options.instanceId,
      status: operation.status,
      observedAt: this.now(),
      requestId,
    });
    operation.sendGeneration += 1;
    operation.sendIndex = 0;
    operation.resultSent = false;
    this.resumeOperation(operation);
  }

  cancel(operationId: string, instanceId: string, requestId: string, reason: string): void {
    text(reason, 'reason', 1000);
    const completed = this.completedForInstance(operationId, instanceId, requestId);
    if (completed !== undefined) {
      this.emit({
        type: 'state',
        operationId,
        instanceId: this.options.instanceId,
        status: completed.result.status,
        observedAt: this.now(),
        requestId,
      });
      return;
    }
    const operation = this.requireOperation(operationId, instanceId, requestId);
    if (operation.result !== undefined || isTerminal(operation.status)) {
      this.emitState(operation, requestId);
      return;
    }
    if (!operation.cancelRequested) {
      operation.cancelRequested = true;
      operation.status = BashStatus.CANCEL_REQUESTED;
      this.emitState(operation, requestId);
      this.terminate(operation, 'SIGTERM');
    } else {
      this.emitState(operation, requestId);
    }
  }

  acknowledgeOutput(operationId: string, instanceId: string, nextOffset: bigint): void {
    if (nextOffset < 0n) {
      throw new BashOperationFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Output acknowledgement offset cannot be negative.',
        DeviceErrorAction.QUERY_OPERATION,
        operationId,
      );
    }
    const completed = this.completedForInstance(operationId, instanceId);
    if (completed !== undefined) {
      if (nextOffset > (completed.result.endOffset ?? 0n)) {
        throw new BashOperationFailure(
          DeviceErrorCode.INVALID_MESSAGE,
          'Output acknowledgement exceeds bytes observed by the Daemon.',
          DeviceErrorAction.QUERY_OPERATION,
          operationId,
        );
      }
      return;
    }
    const operation = this.requireOperation(operationId, instanceId);
    if (nextOffset > operation.observedBytes) {
      throw new BashOperationFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Output acknowledgement exceeds bytes observed by the Daemon.',
        DeviceErrorAction.QUERY_OPERATION,
        operationId,
      );
    }
    while (operation.pending.length > 0) {
      const first = operation.pending[0];
      if (first === undefined) break;
      const end = first.offset + BigInt(first.data.length);
      if (end <= nextOffset) {
        operation.pending.shift();
        operation.bufferedBytes -= first.data.length;
        operation.sendIndex = Math.max(0, operation.sendIndex - 1);
        continue;
      }
      if (first.offset < nextOffset) {
        const consumed = Number(nextOffset - first.offset);
        first.data = first.data.subarray(consumed);
        first.offset = nextOffset;
        operation.bufferedBytes -= consumed;
      }
      break;
    }
    if (operation.paused && operation.bufferedBytes < this.maxPendingBytes) {
      operation.paused = false;
      this.drain(operation, OutputStream.STDOUT);
      this.drain(operation, OutputStream.STDERR);
    }
    if (!this.retireIfComplete(operation)) this.resumeOperation(operation);
  }

  acknowledgeResult(operationId: string, instanceId: string): void {
    if (this.completedForInstance(operationId, instanceId) !== undefined) return;
    const operation = this.requireOperation(operationId, instanceId);
    operation.resultAcknowledged = true;
    this.retireIfComplete(operation);
  }

  resume(): void {
    for (const operation of this.operations.values()) {
      operation.sendGeneration += 1;
      operation.sendIndex = 0;
      operation.resultSent = false;
      this.resumeOperation(operation);
    }
  }

  close(): void {
    for (const operation of this.operations.values()) {
      if (operation.result === undefined) this.terminate(operation, 'SIGKILL');
      if (operation.timeout !== undefined) clearTimeout(operation.timeout);
      if (operation.killEscalation !== undefined) clearTimeout(operation.killEscalation);
    }
  }

  private validateCommand(command: BashStartCommand): void {
    text(command.operationId, 'operationId', 200);
    text(command.requestId, 'requestId', 200);
    text(command.runId, 'runId', 200);
    text(command.deviceId, 'deviceId', 200);
    text(command.command, 'command', 64 * 1024);
    text(command.cwd, 'cwd', 4096);
    if (command.instanceId !== this.options.instanceId) {
      throw new BashOperationFailure(
        DeviceErrorCode.OPERATION_UNKNOWN,
        'The Bash command targets a different Daemon instance.',
        DeviceErrorAction.QUERY_OPERATION,
        command.operationId,
        command.requestId,
      );
    }
    if (!Number.isFinite(command.expiresAt.getTime())) {
      throw new BashOperationFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        'The Bash expiration time is invalid.',
        DeviceErrorAction.ABORT,
        command.operationId,
        command.requestId,
      );
    }
    if (
      !Number.isSafeInteger(command.timeoutSeconds) ||
      command.timeoutSeconds <= 0 ||
      command.timeoutSeconds > BASH_MAX_TIMEOUT_SECONDS
    ) {
      throw new BashOperationFailure(
        DeviceErrorCode.INVALID_MESSAGE,
        `Bash timeoutSeconds must be between 1 and ${BASH_MAX_TIMEOUT_SECONDS}.`,
        DeviceErrorAction.ABORT,
        command.operationId,
        command.requestId,
      );
    }
  }

  private sameParameters(left: BashStartCommand, right: BashStartCommand): boolean {
    return (
      left.runId === right.runId &&
      left.deviceId === right.deviceId &&
      left.instanceId === right.instanceId &&
      left.command === right.command &&
      left.cwd === right.cwd &&
      left.expiresAt.getTime() === right.expiresAt.getTime() &&
      left.timeoutSeconds === right.timeoutSeconds
    );
  }

  private completedForInstance(
    operationId: string,
    instanceId: string,
    requestId?: string,
  ): CompletedOperation | undefined {
    text(operationId, 'operationId', 200);
    const completed = this.completedOperations.get(operationId);
    if (completed !== undefined && instanceId !== this.options.instanceId) {
      throw new BashOperationFailure(
        DeviceErrorCode.OPERATION_UNKNOWN,
        'The operation targets a different Daemon instance.',
        DeviceErrorAction.QUERY_OPERATION,
        operationId,
        requestId,
      );
    }
    return completed;
  }

  private retireIfComplete(operation: Operation): boolean {
    if (
      operation.result === undefined ||
      !operation.resultAcknowledged ||
      operation.pending.length > 0 ||
      operation.bufferedBytes !== 0
    ) {
      return false;
    }
    this.completedOperations.set(operation.command.operationId, {
      fingerprint: commandFingerprint(operation.command),
      acceptedAt: operation.acceptedAt,
      result: operation.result,
    });
    this.operations.delete(operation.command.operationId);
    this.options.onRetired?.(operation.command.operationId);
    return true;
  }

  private evictCompletedOperations(): void {
    for (const operationId of this.completedOperations.keys()) {
      if (this.operations.size + this.completedOperations.size < this.maxOperations) return;
      this.completedOperations.delete(operationId);
    }
  }

  private requireOperation(operationId: string, instanceId: string, requestId?: string): Operation {
    text(operationId, 'operationId', 200);
    if (instanceId !== this.options.instanceId) {
      throw new BashOperationFailure(
        DeviceErrorCode.OPERATION_UNKNOWN,
        'The operation targets a different Daemon instance.',
        DeviceErrorAction.QUERY_OPERATION,
        operationId,
        requestId,
      );
    }
    const operation = this.operations.get(operationId);
    if (operation === undefined) {
      throw new BashOperationFailure(
        DeviceErrorCode.OPERATION_UNKNOWN,
        'The operation is not present in this Daemon instance.',
        DeviceErrorAction.QUERY_OPERATION,
        operationId,
        requestId,
      );
    }
    return operation;
  }

  private drain(operation: Operation, stream: OutputStream.STDOUT | OutputStream.STDERR): void {
    if (operation.result !== undefined || operation.stdioDiscarded) return;
    const readable =
      stream === OutputStream.STDOUT ? operation.child?.stdout : operation.child?.stderr;
    if (readable === null || readable === undefined) {
      operation.collectionFailed = true;
      return;
    }
    while (operation.bufferedBytes < this.maxPendingBytes) {
      const size = Math.min(
        readable.readableLength,
        this.maxChunkBytes,
        this.maxPendingBytes - operation.bufferedBytes,
      );
      if (size === 0) {
        // 空流仍需 read(0) 推动 EOF 通知，不消费预算外数据。
        readable.read(0);
        break;
      }
      const data: unknown = readable.read(size);
      if (data === null) break;
      if (!Buffer.isBuffer(data)) {
        operation.collectionFailed = true;
        break;
      }
      if (data.length === 0) break;
      operation.pending.push({ offset: operation.observedBytes, stream, data });
      operation.observedBytes += BigInt(data.length);
      operation.bufferedBytes += data.length;
    }
    if (operation.bufferedBytes >= this.maxPendingBytes && !operation.paused) {
      operation.paused = true;
      operation.child?.stdout?.pause();
      operation.child?.stderr?.pause();
    }
    this.resumeOperation(operation);
  }

  private finish(operation: Operation, code: number | null): void {
    if (operation.timeout !== undefined) clearTimeout(operation.timeout);
    if (operation.killEscalation !== undefined) clearTimeout(operation.killEscalation);
    operation.paused = false;
    const status = operation.timedOut
      ? BashStatus.EXPIRED
      : operation.cancelRequested
        ? BashStatus.CANCELLED
        : operation.spawnFailed || code !== 0
          ? BashStatus.FAILED
          : BashStatus.COMPLETED;
    operation.status = status;
    operation.result = {
      type: 'result',
      operationId: operation.command.operationId,
      instanceId: this.options.instanceId,
      status,
      ...(!operation.timedOut &&
      !operation.cancelRequested &&
      !operation.spawnFailed &&
      typeof code === 'number'
        ? { exitCode: code }
        : {}),
      outputComplete: !operation.collectionFailed && !operation.stdioDiscarded,
      endOffset: operation.observedBytes,
    };
    this.resumeOperation(operation);
  }

  private terminate(operation: Operation, signal: NodeJS.Signals): void {
    if (operation.result !== undefined) return;
    if (operation.paused || signal === 'SIGKILL') this.discardUnreadOutput(operation);
    const child = operation.child;
    if (child?.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
      }
    }
    if (signal === 'SIGTERM' && operation.killEscalation === undefined) {
      operation.killEscalation = setTimeout(() => {
        this.terminate(operation, 'SIGKILL');
      }, this.killGraceMilliseconds);
    }
  }

  private discardUnreadOutput(operation: Operation): void {
    if (operation.stdioDiscarded) return;
    operation.stdioDiscarded = true;
    operation.collectionFailed = true;
    operation.paused = false;
    operation.child?.stdout?.destroy();
    operation.child?.stderr?.destroy();
  }

  private emitState(operation: Operation, requestId?: string): void {
    this.emit({
      type: 'state',
      operationId: operation.command.operationId,
      instanceId: this.options.instanceId,
      status: operation.status,
      observedAt: this.now(),
      ...(requestId === undefined ? {} : { requestId }),
    });
  }

  private emit(event: BashEvent): void {
    void this.options.send(event).catch((error: unknown) => {
      this.options.onTransportError(error);
    });
  }

  private resumeOperation(operation: Operation): void {
    if (operation.flushing) {
      operation.resumeRequested = true;
      return;
    }
    operation.flushing = true;
    const generation = operation.sendGeneration;
    void (async () => {
      try {
        while (operation.sendIndex < operation.pending.length) {
          const chunk = operation.pending[operation.sendIndex];
          if (chunk === undefined) break;
          await this.options.send({
            type: 'output',
            operationId: operation.command.operationId,
            instanceId: this.options.instanceId,
            offset: chunk.offset,
            stream: chunk.stream,
            data: chunk.data,
          });
          if (generation !== operation.sendGeneration) return;
          if (operation.pending[operation.sendIndex] === chunk) {
            operation.sendIndex += 1;
          } else {
            const currentIndex = operation.pending.indexOf(chunk);
            if (currentIndex >= 0) operation.sendIndex = currentIndex + 1;
          }
        }
        if (generation !== operation.sendGeneration) return;
        if (
          operation.result !== undefined &&
          !operation.resultSent &&
          !operation.resultAcknowledged
        ) {
          await this.options.send(operation.result);
          if (generation !== operation.sendGeneration) return;
          operation.resultSent = true;
        }
      } catch (error) {
        this.options.onTransportError(error);
      } finally {
        operation.flushing = false;
        if (operation.resumeRequested) {
          operation.resumeRequested = false;
          this.resumeOperation(operation);
        }
      }
    })();
  }
}
