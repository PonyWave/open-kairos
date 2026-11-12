import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DaemonMessageInit,
  OperationQuery,
  OperationResultAck,
  OperationStart,
  ServerMessageInit,
} from '@kairos/contracts/device';
import {
  DeviceCapability,
  DeviceErrorCode,
  decodeServerMessage,
  encodeServerMessage,
  OperationStatus,
} from '@kairos/contracts/device';
import { afterEach, describe, expect, it } from 'vitest';
import { type EnvironmentOperationLifecycleEvent, EnvironmentOperationManager } from './manager.js';

const cleanup: Array<() => void> = [];
type OperationStartInit = Extract<
  ServerMessageInit['payload'],
  { case: 'operationStart' }
>['value'];

function fixture(
  options: { maxOperations?: number; failAccepted?: boolean; fileRead?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-operation-manager-'));
  const messages: DaemonMessageInit[] = [];
  const errors: unknown[] = [];
  const lifecycle: EnvironmentOperationLifecycleEvent[] = [];
  let acceptedFailed = false;
  const manager = new EnvironmentOperationManager({
    envId: () => 'env-1',
    deviceBindingId: () => 'binding-1',
    instanceId: 'instance-1',
    capabilities: () => [
      DeviceCapability.BASH,
      ...(options.fileRead === false ? [] : [DeviceCapability.FILE_READ]),
      DeviceCapability.FILE_WRITE,
      DeviceCapability.FILE_EDIT,
      DeviceCapability.DIRECTORY_CHECK,
    ],
    send: async (message) => {
      if (
        options.failAccepted &&
        !acceptedFailed &&
        message.payload?.case === 'operationAccepted'
      ) {
        acceptedFailed = true;
        throw new Error('accepted transport failed');
      }
      messages.push(message);
    },
    onTransportError: (error) => errors.push(error),
    onOperationError: (error) => errors.push(error),
    onLifecycleEvent: (event) => lifecycle.push(event),
    onResultAcknowledged: () => undefined,
    ...(options.maxOperations === undefined ? {} : { maxOperations: options.maxOperations }),
  });
  cleanup.push(() => {
    manager.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, messages, errors, lifecycle, manager };
}

function start(
  operationId: string,
  action: NonNullable<OperationStartInit['action']>,
  requestId = 'request-1',
): OperationStart {
  const message = decodeServerMessage(
    encodeServerMessage({
      payload: {
        case: 'operationStart',
        value: {
          operationId,
          requestId,
          target: {
            envId: 'env-1',
            deviceBindingId: 'binding-1',
            instanceId: 'instance-1',
            ...(action.case === 'directoryCheck' ? {} : { bindingVersion: 3n }),
          },
          expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 60), nanos: 0 },
          action,
        },
      },
    }),
  );
  if (message.payload.case !== 'operationStart') throw new Error('OperationStart fixture failed.');
  return message.payload.value;
}

function query(operationId: string): OperationQuery {
  const message = decodeServerMessage(
    encodeServerMessage({
      payload: {
        case: 'operationQuery',
        value: {
          operationId,
          requestId: 'query-1',
          target: {
            envId: 'env-1',
            deviceBindingId: 'binding-1',
            instanceId: 'instance-1',
            bindingVersion: 3n,
          },
        },
      },
    }),
  );
  if (message.payload.case !== 'operationQuery') throw new Error('OperationQuery fixture failed.');
  return message.payload.value;
}

function resultAck(
  result: Extract<DaemonMessageInit['payload'], { case: 'operationResult' }>['value'],
): OperationResultAck {
  const message = decodeServerMessage(
    encodeServerMessage({
      payload: {
        case: 'operationResultAck',
        value: {
          operationId: result.operationId ?? '',
          target: result.target,
          requestId: result.requestId,
        },
      },
    }),
  );
  if (message.payload.case !== 'operationResultAck')
    throw new Error('OperationResultAck fixture failed.');
  return message.payload.value;
}

async function waitFor<T>(read: () => T | undefined, timeoutMilliseconds = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for generic operation state.');
}

function results(messages: DaemonMessageInit[]) {
  return messages.flatMap((message) =>
    message.payload?.case === 'operationResult' ? [message.payload.value] : [],
  );
}

function outputs(messages: DaemonMessageInit[]) {
  return messages.flatMap((message) =>
    message.payload?.case === 'operationOutputChunk' ? [message.payload.value] : [],
  );
}

afterEach(() => {
  for (const clean of cleanup.splice(0)) clean();
});

describe('EnvironmentOperationManager', () => {
  it('deduplicates file side effects and expires acknowledged IDs without LRU reuse', async () => {
    const { directory, manager, messages } = fixture({ maxOperations: 1 });
    const path = join(directory, 'once.txt');
    const initial = start('operation-write', {
      case: 'write',
      value: { path, cwd: directory, content: 'once', overwrite: false },
    });
    await manager.start(initial);
    await waitFor(() => (results(messages).length === 1 ? true : undefined));
    await manager.start({ ...initial, requestId: 'request-duplicate' });
    await waitFor(() => (results(messages).length === 2 ? true : undefined));
    expect(readFileSync(path, 'utf8')).toBe('once');

    await expect(
      manager.start(
        start('operation-write', {
          case: 'write',
          value: { path, cwd: directory, content: 'different', overwrite: true },
        }),
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.OPERATION_CONFLICT });
    const firstResult = results(messages)[0];
    if (firstResult === undefined) throw new Error('Operation result is missing.');
    manager.acknowledgeResult(resultAck(firstResult));
    expect(manager.pendingOperationCount).toBe(0);
    await expect(manager.start(initial)).rejects.toMatchObject({
      code: DeviceErrorCode.OPERATION_EXPIRED,
    });
    await expect(
      manager.start(
        start('operation-new', {
          case: 'write',
          value: {
            path: join(directory, 'new.txt'),
            cwd: directory,
            content: 'new',
            overwrite: false,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.MESSAGE_TOO_LARGE });
    expect(readFileSync(path, 'utf8')).toBe('once');
  });

  it('executes and resends a file result after the accepted transport fails', async () => {
    const { directory, manager, messages, errors } = fixture({ failAccepted: true });
    const path = join(directory, 'accepted-recovery.txt');
    await manager.start(
      start('operation-accepted-failure', {
        case: 'write',
        value: { path, cwd: directory, content: 'once', overwrite: false },
      }),
    );
    await manager.query(query('operation-accepted-failure'));
    await waitFor(() => (results(messages).length >= 1 ? true : undefined));
    await manager.query(query('operation-accepted-failure'));
    await waitFor(() => (results(messages).length >= 2 ? true : undefined));
    expect(readFileSync(path, 'utf8')).toBe('once');
    expect(errors).toHaveLength(1);
    expect(results(messages).map((result) => result.operationId)).toEqual([
      'operation-accepted-failure',
      'operation-accepted-failure',
    ]);
  });

  it('resends unacknowledged Bash output and terminal state for a same-instance query', async () => {
    const { directory, manager, messages } = fixture();
    const path = join(directory, 'bash-once.txt');
    const initial = start('operation-bash', {
      case: 'bash',
      value: {
        command: `printf once >> ${JSON.stringify(path)}; printf output`,
        cwd: directory,
        timeoutSeconds: 20,
      },
    });
    await manager.start(initial);
    await waitFor(() =>
      results(messages).length === 1 && outputs(messages).length === 1 ? true : undefined,
    );
    await manager.query(query('operation-bash'));
    await waitFor(() =>
      results(messages).length >= 2 && outputs(messages).length >= 2 ? true : undefined,
    );
    expect(readFileSync(path, 'utf8')).toBe('once');

    const result = results(messages)[0];
    if (result === undefined) throw new Error('Bash result is missing.');
    if (result.outcome?.case !== 'bash') throw new Error('Bash outcome is missing.');
    manager.acknowledgeResult(resultAck(result));
    manager.acknowledgeOutput({
      operationId: 'operation-bash',
      target: initial.target,
      nextOffset: result.outcome.value.endOffset ?? 0n,
    });
    expect(manager.pendingOperationCount).toBe(0);
    await expect(manager.start(initial)).rejects.toMatchObject({
      code: DeviceErrorCode.OPERATION_EXPIRED,
    });
  });

  it('publishes lifecycle metadata without command or output payloads', async () => {
    const { manager, messages, lifecycle } = fixture();
    await manager.start(
      start('operation-lifecycle', {
        case: 'bash',
        value: {
          command: 'printf sensitive-command; printf sensitive-output',
          cwd: '/tmp',
          timeoutSeconds: 20,
        },
      }),
    );
    await waitFor(() => (results(messages).length === 1 ? true : undefined));
    expect(lifecycle[0]).toMatchObject({
      operationId: 'operation-lifecycle',
      kind: 'bash',
      status: 'accepted',
    });
    expect(lifecycle.some((event) => event.status === 'running')).toBe(true);
    expect(lifecycle.at(-1)?.status).toBe('completed');
    expect(JSON.stringify(lifecycle)).not.toContain('sensitive-command');
    expect(JSON.stringify(lifecycle)).not.toContain('sensitive-output');
    for (const event of lifecycle) {
      expect(Object.keys(event).sort()).toEqual(['kind', 'operationId', 'status']);
    }
  });

  it('reports generic cancel requested and actual cancellation without an exit code', async () => {
    const { manager, messages } = fixture();
    const initial = start('operation-cancel', {
      case: 'bash',
      value: { command: 'sleep 30', cwd: '/tmp', timeoutSeconds: 20 },
    });
    await manager.start(initial);
    await waitFor(() =>
      messages.some((message) => message.payload?.case === 'operationAccepted') ? true : undefined,
    );
    const target = initial.target;
    await manager.cancel({
      operationId: 'operation-cancel',
      requestId: 'cancel-1',
      target,
      reason: 'test cancellation',
    });
    const result = await waitFor(() => results(messages)[0]);
    expect(result.status).toBe(OperationStatus.CANCELLED);
    expect(result.outcome?.case).toBe('bash');
    if (result.outcome?.case !== 'bash') throw new Error('Bash outcome is missing.');
    expect(result.outcome.value.exitCode).toBeUndefined();
    expect(
      messages.some(
        (message) =>
          message.payload?.case === 'operationState' &&
          message.payload.value.status === OperationStatus.CANCEL_REQUESTED,
      ),
    ).toBe(true);
  });
});

describe('EnvironmentOperationManager image reads', () => {
  it('dispatches readImage with FILE_READ and returns binary content', async () => {
    const { writeFileSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const { directory, manager, messages } = fixture();
    const path = join(directory, 'pixel.png');
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(path, bytes);
    await manager.start(
      start('operation-image', { case: 'readImage', value: { path, cwd: directory } }),
    );
    await waitFor(() => (results(messages).length === 1 ? true : undefined));
    expect(results(messages)[0]).toMatchObject({
      status: OperationStatus.COMPLETED,
      outcome: {
        case: 'readImage',
        value: {
          data: bytes,
          fileVersion: createHash('sha256').update(bytes).digest('hex'),
        },
      },
    });
  });

  it('rejects readImage when FILE_READ is unavailable', async () => {
    const { directory, manager } = fixture({ fileRead: false });
    await expect(
      manager.start(
        start('operation-image-denied', {
          case: 'readImage',
          value: { path: 'pixel.png', cwd: directory },
        }),
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.CAPABILITY_UNAVAILABLE });
  });
});
