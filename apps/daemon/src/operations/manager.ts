import { createHash } from 'node:crypto';
import type {
  DaemonMessageInit,
  OperationQuery,
  OperationResultAck,
  OperationStart,
  OperationTarget,
} from '@kairos/contracts/device';
import {
  BashStatus,
  DeviceCapability,
  DeviceErrorAction,
  DeviceErrorCode,
  OperationStatus,
} from '@kairos/contracts/device';
import type { BashEvent, BashStartCommand } from '../bash/manager.js';
import { BashManager, BashOperationFailure } from '../bash/manager.js';
import { checkDirectory } from './directory.js';
import {
  editRemoteFile,
  FileOperationCancelled,
  readRemoteFile,
  readRemoteImage,
  writeRemoteFile,
} from './files.js';
import { listRemoteDirectories } from './list-directories.js';
import { runRemoteGlob, runRemoteGrep } from './search.js';
import { readSyncChunk, scanSyncPath } from './sync.js';

export type EnvironmentOperationResult = Extract<
  DaemonMessageInit['payload'],
  { case: 'operationResult' }
>['value'];
type Action = OperationStart['action'];
type ActionCase = NonNullable<Action['case']>;
type Outcome = NonNullable<EnvironmentOperationResult['outcome']>;

export interface EnvironmentOperationLifecycleEvent {
  operationId: string;
  kind: ActionCase;
  status: string;
  error?: string;
}

interface OperationEntry {
  operationId: string;
  fingerprint: string;
  target: OperationTarget;
  kind: ActionCase;
  action?: Action;
  requestId: string;
  expiresAt: Date;
  acceptedAt: Date;
  status: OperationStatus;
  result?: EnvironmentOperationResult;
  cancelRequested: boolean;
  retired: boolean;
  abortController: AbortController;
  execution?: Promise<void>;
}

export interface EnvironmentOperationManagerOptions {
  envId: () => string;
  deviceBindingId: () => string;
  instanceId: string;
  capabilities: () => DeviceCapability[];
  send: (message: DaemonMessageInit) => Promise<void>;
  onTransportError: (error: unknown) => void;
  onOperationError?: (error: unknown) => void;
  onLifecycleEvent?: (event: EnvironmentOperationLifecycleEvent) => void;
  onResultAcknowledged: (result: EnvironmentOperationResult) => void;
  now?: () => Date;
  maxOperations?: number;
  maxPendingBytes?: number;
  maxChunkBytes?: number;
  killGraceMilliseconds?: number;
  resourceHomeDirectory?: string;
}

function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, entry]) => !key.startsWith('$') && entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function timestamp(date: Date): { seconds: bigint; nanos: number } {
  const milliseconds = date.getTime();
  return {
    seconds: BigInt(Math.floor(milliseconds / 1000)),
    nanos: (milliseconds % 1000) * 1_000_000,
  };
}

function timestampDate(value: { seconds: bigint; nanos: number } | undefined): Date {
  if (value === undefined) {
    throw new BashOperationFailure(
      DeviceErrorCode.INVALID_MESSAGE,
      'Operation expiration is missing.',
    );
  }
  const milliseconds = Number(value.seconds) * 1000 + value.nanos / 1_000_000;
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) {
    throw new BashOperationFailure(
      DeviceErrorCode.INVALID_MESSAGE,
      'Operation expiration is invalid.',
    );
  }
  return new Date(milliseconds);
}

function failure(
  code: DeviceErrorCode,
  message: string,
  operationId?: string,
  requestId?: string,
  action = DeviceErrorAction.ABORT,
): BashOperationFailure {
  return new BashOperationFailure(code, message, action, operationId, requestId);
}

function emptyOutcome(action: Action, reason?: string): Outcome {
  switch (action.case) {
    case 'directoryList':
      return {
        case: 'directoryList',
        value: {
          normalizedPath: action.value.path,
          entries: [],
          hasMore: false,
          ...(reason === undefined ? {} : { reason }),
        },
      };
    case 'directoryCheck':
      return {
        case: 'directoryCheck',
        value: {
          normalizedPath: action.value.path,
          exists: false,
          directory: false,
          readable: false,
          writable: false,
          executable: false,
          os: '',
          architecture: '',
          capabilities: [],
          resources: [],
          ...(reason === undefined ? {} : { reason }),
        },
      };
    case 'read':
      return {
        case: 'read',
        value: {
          path: action.value.path,
          content: '',
          startLine: 0,
          endLine: 0,
          hasMore: false,
          fileVersion: '',
          truncated: false,
        },
      };
    case 'readImage':
      return {
        case: 'readImage',
        value: { path: action.value.path, data: new Uint8Array(), fileVersion: '' },
      };
    case 'write':
      return {
        case: 'write',
        value: { path: action.value.path, bytesWritten: 0n, fileVersion: '' },
      };
    case 'edit':
      return {
        case: 'edit',
        value: { path: action.value.path, replacements: 0, bytesWritten: 0n, fileVersion: '' },
      };
    case 'bash':
      return { case: 'bash', value: { outputComplete: false } };
    case 'glob':
      return {
        case: 'glob',
        value: {
          path: action.value.path,
          files: [],
          truncated: false,
          ...(reason === undefined ? {} : { reason }),
        },
      };
    case 'grep':
      return {
        case: 'grep',
        value: {
          path: action.value.path,
          matches: [],
          files: [],
          counts: [],
          truncated: false,
          ...(reason === undefined ? {} : { reason }),
        },
      };
    case 'syncScan':
      return {
        case: 'syncScan',
        value: {
          path: action.value.path,
          kind: 0,
          size: 0n,
          sha256: '',
          executable: false,
          conflictScan: action.value.conflictScan === true,
          entries: [],
          ...(reason === undefined ? {} : { reason }),
        },
      };
    case 'syncRead':
      return {
        case: 'syncRead',
        value: {
          path: action.value.path,
          offset: action.value.offset,
          data: new Uint8Array(),
          size: 0n,
          executable: false,
          ...(reason === undefined ? {} : { reason }),
        },
      };
    default:
      throw failure(DeviceErrorCode.PROTOCOL_INCOMPATIBLE, 'Operation action is missing.');
  }
}

function requiredCapability(kind: ActionCase): DeviceCapability {
  switch (kind) {
    case 'read':
    case 'readImage':
    case 'syncScan':
    case 'syncRead':
      return DeviceCapability.FILE_READ;
    case 'write':
      return DeviceCapability.FILE_WRITE;
    case 'edit':
      return DeviceCapability.FILE_EDIT;
    case 'bash':
      return DeviceCapability.BASH;
    case 'directoryCheck':
      return DeviceCapability.DIRECTORY_CHECK;
    case 'directoryList':
      return DeviceCapability.DIRECTORY_LIST;
    case 'glob':
    case 'grep':
      return DeviceCapability.FILE_SEARCH;
  }
}

function operationStatus(status: BashStatus): OperationStatus {
  if (status < BashStatus.CREATED || status > BashStatus.UNKNOWN) {
    throw new Error('Bash event contains an unsupported status.');
  }
  return status as unknown as OperationStatus;
}

function lifecycleStatus(status: OperationStatus): string {
  const name = OperationStatus[status];
  if (name === undefined) throw new Error('Operation event contains an unsupported status.');
  return name.toLowerCase();
}

function outcomeError(outcome: Outcome): string | undefined {
  const value: unknown = outcome.value;
  if (typeof value !== 'object' || value === null || !('reason' in value)) return undefined;
  return typeof value.reason === 'string' ? value.reason : undefined;
}

export class EnvironmentOperationManager {
  private readonly operations = new Map<string, OperationEntry>();
  private readonly bash: BashManager;
  private readonly now: () => Date;
  private readonly maxOperations: number;

  constructor(private readonly options: EnvironmentOperationManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxOperations = options.maxOperations ?? 256;
    if (!Number.isSafeInteger(this.maxOperations) || this.maxOperations <= 0) {
      throw new Error('maxOperations must be a positive safe integer.');
    }
    this.bash = new BashManager({
      instanceId: options.instanceId,
      maxOperations: this.maxOperations,
      ...(options.maxPendingBytes === undefined
        ? {}
        : { maxPendingBytes: options.maxPendingBytes }),
      ...(options.maxChunkBytes === undefined ? {} : { maxChunkBytes: options.maxChunkBytes }),
      ...(options.killGraceMilliseconds === undefined
        ? {}
        : { killGraceMilliseconds: options.killGraceMilliseconds }),
      send: (event) => this.sendBashEvent(event),
      onTransportError: options.onTransportError,
      onRetired: (operationId) => this.retireBash(operationId),
    });
  }

  get pendingOperationCount(): number {
    let count = 0;
    for (const operation of this.operations.values()) if (!operation.retired) count += 1;
    return count;
  }

  hasOperation(operationId: string): boolean {
    return this.operations.has(operationId);
  }

  isDirectoryOperation(operationId: string): boolean {
    return this.operations.get(operationId)?.kind === 'directoryCheck';
  }

  bufferedBytes(operationId: string): number | undefined {
    return this.hasOperation(operationId) ? this.bash.bufferedBytes(operationId) : undefined;
  }

  isPaused(operationId: string): boolean | undefined {
    return this.hasOperation(operationId) ? this.bash.isPaused(operationId) : undefined;
  }

  async start(start: OperationStart): Promise<void> {
    const kind = start.action.case;
    if (kind === undefined) {
      throw failure(
        DeviceErrorCode.PROTOCOL_INCOMPATIBLE,
        'Operation action is missing.',
        start.operationId,
        start.requestId,
      );
    }
    const target = this.requireTarget(
      start.target,
      start.action,
      start.operationId,
      start.requestId,
    );
    const expiresAt = timestampDate(start.expiresAt);
    const fingerprint = createHash('sha256')
      .update(canonicalJson({ target, expiresAt: start.expiresAt, action: start.action }))
      .digest('hex');
    const existing = this.operations.get(start.operationId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw failure(
          DeviceErrorCode.OPERATION_CONFLICT,
          'The operation ID is associated with different parameters.',
          start.operationId,
          start.requestId,
          DeviceErrorAction.QUERY_OPERATION,
        );
      }
      if (existing.retired) {
        throw failure(
          DeviceErrorCode.OPERATION_EXPIRED,
          'The acknowledged operation ID is retained only for deduplication.',
          start.operationId,
          start.requestId,
        );
      }
      existing.requestId = start.requestId;
      if (existing.kind === 'bash') this.startBash(existing, start.requestId);
      else await this.sendCurrent(existing);
      return;
    }
    if (expiresAt.getTime() <= this.now().getTime()) {
      throw failure(
        DeviceErrorCode.OPERATION_EXPIRED,
        'The operation start has expired.',
        start.operationId,
        start.requestId,
      );
    }
    if (!this.options.capabilities().includes(requiredCapability(kind))) {
      throw failure(
        DeviceErrorCode.CAPABILITY_UNAVAILABLE,
        'The required operation capability was not granted by the Server.',
        start.operationId,
        start.requestId,
      );
    }
    if (this.operations.size >= this.maxOperations) {
      throw failure(
        DeviceErrorCode.MESSAGE_TOO_LARGE,
        'The bounded Daemon operation deduplication memory is full.',
        start.operationId,
        start.requestId,
        DeviceErrorAction.RETRY,
      );
    }
    const operation: OperationEntry = {
      operationId: start.operationId,
      fingerprint,
      target,
      kind,
      action: start.action,
      requestId: start.requestId,
      expiresAt,
      acceptedAt: this.now(),
      status: OperationStatus.ACCEPTED,
      cancelRequested: false,
      retired: false,
      abortController: new AbortController(),
    };
    this.operations.set(start.operationId, operation);
    this.emitLifecycle(operation);
    if (operation.kind === 'bash') {
      this.startBash(operation, start.requestId);
      return;
    }
    operation.execution = this.execute(operation);
    await this.sendAccepted(operation);
  }

  async query(query: OperationQuery): Promise<void> {
    const operation = this.requireOperation(query.operationId, query.target, query.requestId);
    if (operation.retired) {
      throw failure(
        DeviceErrorCode.OPERATION_EXPIRED,
        'The acknowledged operation is no longer available for query.',
        query.operationId,
        query.requestId,
      );
    }
    if (operation.kind === 'bash') {
      this.bash.query(query.operationId, this.options.instanceId, query.requestId);
      return;
    }
    if (operation.execution === undefined) operation.execution = this.execute(operation);
    await this.sendCurrent(operation, query.requestId);
  }

  async cancel(input: {
    operationId: string;
    requestId: string;
    target?: OperationTarget | undefined;
    reason: string;
  }): Promise<void> {
    if (!input.reason || input.reason.length > 1000 || input.reason.includes('\0')) {
      throw failure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Cancellation reason is invalid.',
        input.operationId,
        input.requestId,
      );
    }
    const operation = this.requireOperation(input.operationId, input.target, input.requestId);
    if (operation.retired) {
      throw failure(
        DeviceErrorCode.OPERATION_EXPIRED,
        'The acknowledged operation cannot be cancelled.',
        input.operationId,
        input.requestId,
      );
    }
    if (operation.result !== undefined) {
      await this.sendCurrent(operation, input.requestId);
      return;
    }
    if (!operation.cancelRequested) {
      operation.cancelRequested = true;
      operation.status = OperationStatus.CANCEL_REQUESTED;
      operation.abortController.abort();
      this.emitLifecycle(operation);
    }
    if (operation.kind === 'bash') {
      this.bash.cancel(input.operationId, this.options.instanceId, input.requestId, input.reason);
      return;
    }
    await this.sendOperationMessage({
      payload: {
        case: 'operationState',
        value: {
          operationId: operation.operationId,
          requestId: input.requestId,
          target: operation.target,
          status: OperationStatus.CANCEL_REQUESTED,
          observedAt: timestamp(this.now()),
        },
      },
    });
  }

  acknowledgeOutput(input: {
    operationId: string;
    target?: OperationTarget | undefined;
    nextOffset: bigint;
  }): void {
    const operation = this.requireOperation(input.operationId, input.target);
    if (operation.kind !== 'bash') {
      throw failure(
        DeviceErrorCode.INVALID_MESSAGE,
        'Only Bash operations have output acknowledgements.',
        input.operationId,
      );
    }
    this.bash.acknowledgeOutput(input.operationId, this.options.instanceId, input.nextOffset);
  }

  acknowledgeResult(ack: OperationResultAck): void {
    const operation = this.requireOperation(ack.operationId, ack.target, ack.requestId);
    if (operation.retired) return;
    if (operation.kind === 'bash') {
      this.bash.acknowledgeResult(ack.operationId, this.options.instanceId);
      return;
    }
    if (operation.result === undefined) {
      throw failure(
        DeviceErrorCode.OPERATION_UNKNOWN,
        'The operation result acknowledgement has no matching result.',
        ack.operationId,
        ack.requestId,
        DeviceErrorAction.QUERY_OPERATION,
      );
    }
    const result = operation.result;
    operation.retired = true;
    delete operation.result;
    delete operation.action;
    this.options.onResultAcknowledged(result);
  }

  resume(): void {
    this.bash.resume();
  }

  close(): void {
    this.bash.close();
    for (const operation of this.operations.values()) operation.abortController.abort();
  }

  private requireTarget(
    target: OperationTarget | undefined,
    action: Action,
    operationId: string,
    requestId?: string,
  ): OperationTarget {
    if (
      target === undefined ||
      target.envId !== this.options.envId() ||
      target.deviceBindingId !== this.options.deviceBindingId() ||
      target.instanceId !== this.options.instanceId ||
      (action.case === 'directoryCheck' || action.case === 'directoryList'
        ? target.bindingVersion !== undefined
        : target.bindingVersion === undefined || target.bindingVersion <= 0n)
    ) {
      throw failure(
        DeviceErrorCode.PERMISSION_DENIED,
        'Operation target does not match the authenticated binding, instance, and Agent version.',
        operationId,
        requestId,
      );
    }
    return target;
  }

  private requireOperation(
    operationId: string,
    target: OperationTarget | undefined,
    requestId?: string,
  ): OperationEntry {
    const operation = this.operations.get(operationId);
    if (operation === undefined) {
      throw failure(
        DeviceErrorCode.OPERATION_UNKNOWN,
        'This Daemon instance has no such operation.',
        operationId,
        requestId,
        DeviceErrorAction.QUERY_OPERATION,
      );
    }
    if (
      target === undefined ||
      target.envId !== operation.target.envId ||
      target.deviceBindingId !== operation.target.deviceBindingId ||
      target.instanceId !== operation.target.instanceId ||
      target.bindingVersion !== operation.target.bindingVersion
    ) {
      throw failure(
        DeviceErrorCode.PERMISSION_DENIED,
        'Operation target does not match its original start.',
        operationId,
        requestId,
      );
    }
    return operation;
  }

  private startBash(operation: OperationEntry, requestId: string): void {
    if (operation.action?.case !== 'bash') throw new Error('Bash operation action is unavailable.');
    const command: BashStartCommand = {
      operationId: operation.operationId,
      requestId,
      runId: operation.target.bindingVersion?.toString() ?? '',
      deviceId: operation.target.deviceBindingId,
      instanceId: this.options.instanceId,
      command: operation.action.value.command,
      cwd: operation.action.value.cwd,
      expiresAt: operation.expiresAt,
      timeoutSeconds: operation.action.value.timeoutSeconds,
    };
    this.bash.start(command);
  }

  private async execute(operation: OperationEntry): Promise<void> {
    const action = operation.action;
    if (action === undefined || action.case === 'bash' || action.case === undefined) return;
    try {
      if (operation.abortController.signal.aborted) throw new FileOperationCancelled();
      let outcome: Outcome;
      let status = OperationStatus.COMPLETED;
      switch (action.case) {
        case 'read':
          outcome = {
            case: 'read',
            value: await readRemoteFile(action.value, operation.abortController.signal),
          };
          break;
        case 'readImage':
          outcome = {
            case: 'readImage',
            value: await readRemoteImage(action.value, operation.abortController.signal),
          };
          break;
        case 'syncScan':
          outcome = {
            case: 'syncScan',
            value: await scanSyncPath(action.value, operation.abortController.signal),
          };
          break;
        case 'syncRead':
          outcome = {
            case: 'syncRead',
            value: await readSyncChunk(action.value, operation.abortController.signal),
          };
          break;
        case 'write':
          outcome = {
            case: 'write',
            value: await writeRemoteFile(action.value, operation.abortController.signal),
          };
          break;
        case 'edit':
          outcome = {
            case: 'edit',
            value: await editRemoteFile(action.value, operation.abortController.signal),
          };
          break;
        case 'directoryList':
          outcome = {
            case: 'directoryList',
            value: await listRemoteDirectories(action.value, operation.abortController.signal),
          };
          break;
        case 'glob':
          outcome = {
            case: 'glob',
            value: await runRemoteGlob(action.value, operation.abortController.signal),
          };
          break;
        case 'grep':
          outcome = {
            case: 'grep',
            value: await runRemoteGrep(action.value, operation.abortController.signal),
          };
          break;
        case 'directoryCheck': {
          const report = await checkDirectory(
            action.value.path,
            action.value.loadWorkspace,
            this.options.capabilities(),
            this.options.resourceHomeDirectory,
          );
          if (operation.abortController.signal.aborted) throw new FileOperationCancelled();
          status = report.ready ? OperationStatus.COMPLETED : OperationStatus.FAILED;
          outcome = {
            case: 'directoryCheck',
            value: {
              normalizedPath: report.normalizedPath,
              exists: report.exists,
              directory: report.directory,
              readable: report.readable,
              writable: report.writable,
              executable: report.executable,
              os: report.os,
              architecture: report.architecture,
              capabilities: report.capabilities,
              resources: report.resources,
              ...(report.reason === undefined ? {} : { reason: report.reason }),
            },
          };
          break;
        }
      }
      if (operation.cancelRequested && action.case !== 'write' && action.case !== 'edit') {
        throw new FileOperationCancelled();
      }
      await this.recordResult(operation, status, outcome);
    } catch (error) {
      const cancelled = error instanceof FileOperationCancelled || operation.cancelRequested;
      const resultStatus = cancelled ? OperationStatus.CANCELLED : OperationStatus.FAILED;
      await this.recordResult(
        operation,
        resultStatus,
        emptyOutcome(
          action,
          cancelled
            ? 'Operation was cancelled.'
            : error instanceof Error
              ? error.message
              : 'Operation failed.',
        ),
      );
      if (!cancelled) this.options.onOperationError?.(error);
    }
  }

  private async sendOperationMessage(message: DaemonMessageInit): Promise<void> {
    try {
      await this.options.send(message);
    } catch (error) {
      this.options.onTransportError(error);
    }
  }

  private async recordResult(
    operation: OperationEntry,
    status: OperationStatus,
    outcome: Outcome,
  ): Promise<void> {
    if (operation.result !== undefined || operation.retired) return;
    operation.status = status;
    const result: EnvironmentOperationResult = {
      operationId: operation.operationId,
      target: operation.target,
      status,
      observedAt: timestamp(this.now()),
      requestId: operation.requestId,
      outcome,
    };
    operation.result = result;
    this.emitLifecycle(operation, outcomeError(outcome));
    await this.sendOperationMessage({ payload: { case: 'operationResult', value: result } });
  }

  private emitLifecycle(operation: OperationEntry, error?: string): void {
    this.options.onLifecycleEvent?.({
      operationId: operation.operationId,
      kind: operation.kind,
      status: lifecycleStatus(operation.status),
      ...(error === undefined ? {} : { error }),
    });
  }

  private async sendAccepted(operation: OperationEntry): Promise<void> {
    await this.sendOperationMessage({
      payload: {
        case: 'operationAccepted',
        value: {
          operationId: operation.operationId,
          requestId: operation.requestId,
          target: operation.target,
          status: operation.status,
          acceptedAt: timestamp(operation.acceptedAt),
        },
      },
    });
  }

  private async sendCurrent(operation: OperationEntry, requestId?: string): Promise<void> {
    if (operation.result !== undefined) {
      await this.sendOperationMessage({
        payload: {
          case: 'operationResult',
          value: { ...operation.result, ...(requestId === undefined ? {} : { requestId }) },
        },
      });
      return;
    }
    if (requestId !== undefined && operation.cancelRequested) {
      await this.sendOperationMessage({
        payload: {
          case: 'operationState',
          value: {
            operationId: operation.operationId,
            requestId,
            target: operation.target,
            status: operation.status,
            observedAt: timestamp(this.now()),
          },
        },
      });
      return;
    }
    await this.sendAccepted(operation);
  }

  private async sendBashEvent(event: BashEvent): Promise<void> {
    const operation = this.operations.get(event.operationId);
    if (operation === undefined) throw new Error('Bash event has no generic operation record.');
    if (event.type === 'accepted' && event.status === BashStatus.ACCEPTED) {
      operation.status = OperationStatus.RUNNING;
      this.emitLifecycle(operation);
    } else if (event.type === 'state' || event.type === 'result') {
      operation.status = operationStatus(event.status);
      this.emitLifecycle(operation);
    }
    switch (event.type) {
      case 'accepted':
        await this.sendOperationMessage({
          payload: {
            case: 'operationAccepted',
            value: {
              operationId: event.operationId,
              requestId: event.requestId,
              target: operation.target,
              status: operationStatus(event.status),
              acceptedAt: timestamp(event.acceptedAt),
            },
          },
        });
        return;
      case 'state':
        await this.sendOperationMessage({
          payload: {
            case: 'operationState',
            value: {
              operationId: event.operationId,
              requestId: event.requestId,
              target: operation.target,
              status: operationStatus(event.status),
              observedAt: timestamp(event.observedAt),
            },
          },
        });
        return;
      case 'output':
        await this.sendOperationMessage({
          payload: {
            case: 'operationOutputChunk',
            value: {
              operationId: event.operationId,
              target: operation.target,
              offset: event.offset,
              stream: event.stream,
              data: event.data,
            },
          },
        });
        return;
      case 'result':
        operation.status = operationStatus(event.status);
        operation.result = {
          operationId: event.operationId,
          target: operation.target,
          status: operation.status,
          observedAt: timestamp(this.now()),
          ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
          outcome: {
            case: 'bash',
            value: {
              ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
              outputComplete: event.outputComplete,
              ...(event.endOffset === undefined ? {} : { endOffset: event.endOffset }),
            },
          },
        };
        await this.sendOperationMessage({
          payload: { case: 'operationResult', value: operation.result },
        });
    }
  }

  private retireBash(operationId: string): void {
    const operation = this.operations.get(operationId);
    if (operation === undefined) return;
    operation.retired = true;
    delete operation.action;
    delete operation.result;
  }
}
