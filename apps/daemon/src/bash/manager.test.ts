import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BashStatus, DeviceErrorCode, OutputStream } from '@kairos/contracts/device';
import { afterEach, describe, expect, it } from 'vitest';
import type { BashEvent, BashResultEvent, BashStartCommand } from './manager.js';
import { BashManager } from './manager.js';

const cleanup: Array<() => void> = [];

function fixture(options?: {
  maxPendingBytes?: number;
  maxChunkBytes?: number;
  maxOperations?: number;
  killGraceMilliseconds?: number;
  onEvent?: (event: BashEvent) => void;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-daemon-bash-'));
  const events: BashEvent[] = [];
  const transportErrors: unknown[] = [];
  const manager = new BashManager({
    instanceId: 'instance-1',
    ...(options?.maxPendingBytes === undefined ? {} : { maxPendingBytes: options.maxPendingBytes }),
    ...(options?.maxChunkBytes === undefined ? {} : { maxChunkBytes: options.maxChunkBytes }),
    ...(options?.maxOperations === undefined ? {} : { maxOperations: options.maxOperations }),
    ...(options?.killGraceMilliseconds === undefined
      ? {}
      : { killGraceMilliseconds: options.killGraceMilliseconds }),
    send: async (event) => {
      events.push(event);
      options?.onEvent?.(event);
    },
    onTransportError: (error) => transportErrors.push(error),
  });
  cleanup.push(() => {
    manager.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const command = (input: Partial<BashStartCommand> = {}): BashStartCommand => ({
    operationId: 'operation-1',
    requestId: 'request-1',
    runId: 'run-1',
    deviceId: 'device-1',
    instanceId: 'instance-1',
    command: 'printf ok',
    cwd: directory,
    expiresAt: new Date(Date.now() + 60_000),
    timeoutSeconds: 20,
    ...input,
  });
  return { directory, events, transportErrors, manager, command };
}

async function waitFor<T>(read: () => T | undefined, timeoutMilliseconds = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for Bash event.');
}

function result(events: BashEvent[]): BashResultEvent | undefined {
  return events.find((event): event is BashResultEvent => event.type === 'result');
}

afterEach(() => {
  for (const clean of cleanup.splice(0)) clean();
});

describe('BashManager real process execution', () => {
  it('streams short stdout and stderr before exit and accepts their acknowledgements', async () => {
    const { events, manager, command, transportErrors } = fixture();
    manager.start(command({ command: 'printf out; printf err >&2; sleep 30' }));
    const output = await waitFor(() => {
      const chunks = events.filter((event) => event.type === 'output');
      return chunks.reduce((bytes, chunk) => bytes + chunk.data.length, 0) === 6
        ? chunks
        : undefined;
    }, 2000);

    expect(result(events)).toBeUndefined();
    expect(
      output
        .filter((chunk) => chunk.stream === OutputStream.STDOUT)
        .map((chunk) => Buffer.from(chunk.data).toString())
        .join(''),
    ).toBe('out');
    expect(
      output
        .filter((chunk) => chunk.stream === OutputStream.STDERR)
        .map((chunk) => Buffer.from(chunk.data).toString())
        .join(''),
    ).toBe('err');
    let nextOffset = 0n;
    for (const chunk of output) {
      expect(chunk.data.length).toBeGreaterThan(0);
      expect(chunk.offset).toBe(nextOffset);
      nextOffset += BigInt(chunk.data.length);
      manager.acknowledgeOutput(chunk.operationId, 'instance-1', nextOffset);
    }
    expect(manager.bufferedBytes('operation-1')).toBe(0);
    expect(result(events)).toBeUndefined();

    manager.cancel('operation-1', 'instance-1', 'cancel-streaming', 'short output confirmed');
    const final = await waitFor(() => result(events));
    expect(final).toMatchObject({
      status: BashStatus.CANCELLED,
      endOffset: 6n,
      outputComplete: true,
    });
    manager.acknowledgeResult('operation-1', 'instance-1');
    expect(manager.pendingOperationCount).toBe(0);
    expect(transportErrors).toEqual([]);
  });

  it.each([OutputStream.STDOUT, OutputStream.STDERR])(
    'drains a short pending tail on stream %i after acknowledgement without exceeding byte or chunk limits',
    async (stream) => {
      const { events, manager, command, transportErrors } = fixture({
        maxPendingBytes: 7,
        maxChunkBytes: 4,
      });
      manager.start(
        command({
          command: `printf 0123456789${stream === OutputStream.STDERR ? ' >&2' : ''}; sleep 30`,
        }),
      );
      await waitFor(() => (manager.isPaused('operation-1') ? true : undefined));
      expect(manager.bufferedBytes('operation-1')).toBe(7);
      await waitFor(() =>
        events
          .filter((event) => event.type === 'output')
          .reduce((bytes, chunk) => bytes + chunk.data.length, 0) === 7
          ? true
          : undefined,
      );
      expect(result(events)).toBeUndefined();

      manager.acknowledgeOutput('operation-1', 'instance-1', 7n);
      const output = await waitFor(() => {
        const chunks = events.filter((event) => event.type === 'output');
        return chunks.reduce((bytes, chunk) => bytes + chunk.data.length, 0) === 10
          ? chunks
          : undefined;
      }, 2000);
      expect(result(events)).toBeUndefined();
      expect(manager.bufferedBytes('operation-1')).toBe(3);
      expect(manager.isPaused('operation-1')).toBe(false);
      let nextOffset = 0n;
      for (const chunk of output) {
        expect(chunk.stream).toBe(stream);
        expect(chunk.offset).toBe(nextOffset);
        expect(chunk.data.length).toBeGreaterThan(0);
        expect(chunk.data.length).toBeLessThanOrEqual(4);
        nextOffset += BigInt(chunk.data.length);
      }
      expect(Buffer.concat(output.map((chunk) => chunk.data)).toString()).toBe('0123456789');
      manager.acknowledgeOutput('operation-1', 'instance-1', 10n);
      expect(manager.bufferedBytes('operation-1')).toBe(0);
      manager.cancel('operation-1', 'instance-1', 'cancel-tail', 'tail confirmed');
      const final = await waitFor(() => result(events));
      expect(final).toMatchObject({
        status: BashStatus.CANCELLED,
        endOffset: 10n,
        outputComplete: true,
      });
      expect(transportErrors).toEqual([]);
    },
  );

  it('collects stdout and stderr at merged byte offsets and preserves a nonzero exit', async () => {
    const { directory, events, manager, command } = fixture();
    manager.start(
      command({
        command: "printf 'out-'; printf 'err-中' >&2; exit 7",
      }),
    );
    const final = await waitFor(() => result(events));
    const output = events.filter((event) => event.type === 'output');

    expect(final).toMatchObject({
      status: BashStatus.FAILED,
      exitCode: 7,
      outputComplete: true,
      endOffset: BigInt(Buffer.byteLength('out-err-中')),
    });
    let expectedOffset = 0n;
    for (const chunk of output) {
      if (chunk.type !== 'output') continue;
      expect(chunk.offset).toBe(expectedOffset);
      expectedOffset += BigInt(chunk.data.byteLength);
    }
    expect(expectedOffset).toBe(final.endOffset);
    expect(new Set(output.map((chunk) => chunk.stream))).toEqual(
      new Set([OutputStream.STDOUT, OutputStream.STDERR]),
    );
    expect(
      Buffer.concat(
        output.filter((chunk) => chunk.stream === OutputStream.STDOUT).map((chunk) => chunk.data),
      ).toString(),
    ).toBe('out-');
    expect(
      Buffer.concat(
        output.filter((chunk) => chunk.stream === OutputStream.STDERR).map((chunk) => chunk.data),
      ).toString(),
    ).toBe('err-中');
    expect(readdirSync(directory)).toEqual([]);
  });

  it('deduplicates starts in the same instance without repeating file side effects', async () => {
    const { directory, events, manager, command } = fixture();
    const businessFile = join(directory, 'business.txt');
    const start = command({ command: `printf executed >> ${JSON.stringify(businessFile)}` });
    manager.start(start);
    await waitFor(() => result(events));
    manager.start({ ...start, requestId: 'request-duplicate' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(readFileSync(businessFile, 'utf8')).toBe('executed');
    expect(readdirSync(directory)).toEqual(['business.txt']);
    expect(() => manager.start({ ...start, command: 'printf different' })).toThrowError(
      expect.objectContaining({ code: DeviceErrorCode.OPERATION_CONFLICT }),
    );
    expect(manager.pendingOperationCount).toBe(1);
  });

  it('retires fully acknowledged operations while retaining deduplication', async () => {
    const { directory, events, manager, command } = fixture({ maxOperations: 3 });
    const businessFile = join(directory, 'retired.txt');
    const first = command({
      command: `printf executed >> ${JSON.stringify(businessFile)}; printf first`,
    });
    const starts = [
      first,
      command({ operationId: 'operation-2', command: 'printf second' }),
      command({ operationId: 'operation-3', command: 'printf third' }),
    ];

    for (const [index, start] of starts.entries()) {
      manager.start(start);
      const final = await waitFor(() =>
        events.find(
          (event): event is BashResultEvent =>
            event.type === 'result' && event.operationId === start.operationId,
        ),
      );
      expect(final.status).toBe(BashStatus.COMPLETED);
      if (index % 2 === 0) {
        manager.acknowledgeOutput(start.operationId, 'instance-1', final.endOffset ?? 0n);
        manager.acknowledgeResult(start.operationId, 'instance-1');
      } else {
        manager.acknowledgeResult(start.operationId, 'instance-1');
        manager.acknowledgeOutput(start.operationId, 'instance-1', final.endOffset ?? 0n);
      }
      expect(manager.pendingOperationCount).toBe(0);
      expect(manager.bufferedBytes(start.operationId)).toBe(0);
    }

    manager.start({ ...first, requestId: 'request-retired-duplicate' });
    await waitFor(() =>
      events.filter((event) => event.type === 'result' && event.operationId === first.operationId)
        .length >= 2
        ? true
        : undefined,
    );
    expect(readFileSync(businessFile, 'utf8')).toBe('executed');
    expect(manager.pendingOperationCount).toBe(0);
    expect(() => manager.start({ ...first, command: 'printf conflict' })).toThrowError(
      expect.objectContaining({ code: DeviceErrorCode.OPERATION_CONFLICT }),
    );
  });

  it('pauses output at the memory high-water mark and resumes after acknowledgements', async () => {
    let manager: BashManager;
    let release = false;
    const fixtureValue = fixture({
      maxPendingBytes: 4096,
      maxChunkBytes: 1024,
      onEvent: (event) => {
        if (release && event.type === 'output') {
          const acknowledged = event.offset + BigInt(event.data.byteLength);
          queueMicrotask(() =>
            manager.acknowledgeOutput(event.operationId, 'instance-1', acknowledged),
          );
        }
      },
    });
    manager = fixtureValue.manager;
    const { events, command } = fixtureValue;
    manager.start(command({ command: "for i in $(seq 1 1024); do printf '%01024d' 0; done" }));
    await waitFor(() => (manager.isPaused('operation-1') ? true : undefined));
    expect(manager.bufferedBytes('operation-1')).toBe(4096);
    release = true;
    const lastOutput = events.filter((event) => event.type === 'output').at(-1);
    if (lastOutput?.type === 'output') {
      manager.acknowledgeOutput(
        lastOutput.operationId,
        'instance-1',
        lastOutput.offset + BigInt(lastOutput.data.byteLength),
      );
    }
    const final = await waitFor(() => result(events));

    expect(final.status).toBe(BashStatus.COMPLETED);
    expect(final.endOffset).toBe(1_048_576n);
    expect(manager.isPaused('operation-1')).toBe(false);
    await waitFor(() => (manager.bufferedBytes('operation-1') === 0 ? true : undefined));
  }, 10_000);

  it.each([1, 2])('resends from offset zero when Query races output offset %i', async (offset) => {
    const directory = mkdtempSync(join(tmpdir(), 'kairos-daemon-query-race-'));
    const events: BashEvent[] = [];
    const transportErrors: unknown[] = [];
    let notifyBlocked: () => void = () => undefined;
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => (notifyBlocked = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let shouldBlock = true;
    const manager = new BashManager({
      instanceId: 'instance-1',
      maxChunkBytes: 1,
      send: async (event) => {
        events.push(event);
        if (shouldBlock && event.type === 'output' && event.offset === BigInt(offset)) {
          shouldBlock = false;
          notifyBlocked();
          await gate;
        }
      },
      onTransportError: (error) => transportErrors.push(error),
    });
    cleanup.push(() => {
      manager.close();
      rmSync(directory, { recursive: true, force: true });
    });
    manager.start({
      operationId: 'operation-query-race',
      requestId: 'request-query-race',
      runId: 'run-1',
      deviceId: 'device-1',
      instanceId: 'instance-1',
      command: 'printf abc',
      cwd: directory,
      expiresAt: new Date(Date.now() + 60_000),
      timeoutSeconds: 20,
    });
    await blocked;
    manager.query('operation-query-race', 'instance-1', 'query-race');
    release();
    const offsets = await waitFor(() => {
      const current = events
        .filter((event) => event.type === 'output')
        .map((event) => Number(event.offset));
      return current.length >= offset + 4 ? current : undefined;
    });
    expect(offsets).toEqual([...Array.from({ length: offset + 1 }, (_, index) => index), 0, 1, 2]);
    expect(transportErrors).toEqual([]);
  });

  it('resends unacknowledged output and terminal state after a same-instance reconnect', async () => {
    const { events, manager, command } = fixture();
    manager.start(command({ command: "printf 'reconnect'" }));
    await waitFor(() => result(events));
    const firstSend = events.filter((event) => event.type === 'output' || event.type === 'result');
    manager.resume();
    await waitFor(() =>
      events.filter((event) => event.type === 'output' || event.type === 'result').length >=
      firstSend.length * 2
        ? true
        : undefined,
    );

    expect(firstSend.some((event) => event.type === 'output')).toBe(true);
    expect(events.filter((event) => event.type === 'result')).toHaveLength(2);
    manager.acknowledgeResult('operation-1', 'instance-1');
    manager.resume();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.filter((event) => event.type === 'result')).toHaveLength(2);
  });

  it('waits for actual cancellation and timeout results without inventing exit code zero', async () => {
    const cancelled = fixture();
    cancelled.manager.start(cancelled.command({ command: 'sleep 30' }));
    await waitFor(() =>
      cancelled.events.some((event) => event.type === 'accepted') ? true : undefined,
    );
    cancelled.manager.cancel('operation-1', 'instance-1', 'cancel-1', 'test cancellation');
    const cancelledResult = await waitFor(() => result(cancelled.events));
    expect(cancelledResult).toMatchObject({
      status: BashStatus.CANCELLED,
      outputComplete: true,
    });
    expect(cancelledResult.exitCode).toBeUndefined();

    const timedOut = fixture();
    timedOut.manager.start(
      timedOut.command({
        operationId: 'operation-timeout',
        command: 'sleep 30',
        timeoutSeconds: 1,
      }),
    );
    const timeoutResult = await waitFor(() => result(timedOut.events));
    expect(timeoutResult.status).toBe(BashStatus.EXPIRED);
    expect(timeoutResult.exitCode).toBeUndefined();
  });

  it('cancels a backpressured process without waiting for output acknowledgements', async () => {
    const { events, manager, command } = fixture({
      maxPendingBytes: 4096,
      maxChunkBytes: 1024,
      killGraceMilliseconds: 50,
    });
    manager.start(command({ command: "for i in $(seq 1 1024); do printf '%01024d' 0; done" }));
    await waitFor(() => (manager.isPaused('operation-1') ? true : undefined));

    manager.cancel('operation-1', 'instance-1', 'cancel-paused', 'cancel while paused');
    const final = await waitFor(() => result(events), 2000);
    expect(final.status).toBe(BashStatus.CANCELLED);
    expect(final.outputComplete).toBe(false);
    expect(final.exitCode).toBeUndefined();
    expect(manager.bufferedBytes('operation-1')).toBe(4096);
    const retained = events.filter((event) => event.type === 'output');
    expect(retained.reduce((bytes, chunk) => bytes + chunk.data.length, 0)).toBe(4096);
    expect(retained.every((chunk) => chunk.data.length > 0 && chunk.data.length <= 1024)).toBe(
      true,
    );
    manager.resume();
    await waitFor(() =>
      events.filter((event) => event.type === 'result').length === 2 ? true : undefined,
    );
    const resent = events.filter((event) => event.type === 'output').slice(retained.length);
    expect(resent).toEqual(retained);
    expect(manager.bufferedBytes('operation-1')).toBe(4096);
    manager.acknowledgeResult('operation-1', 'instance-1');
    expect(manager.pendingOperationCount).toBe(1);
    manager.acknowledgeOutput('operation-1', 'instance-1', final.endOffset ?? 0n);
    expect(manager.bufferedBytes('operation-1')).toBe(0);
    expect(manager.pendingOperationCount).toBe(0);
  });

  it('times out a backpressured process without waiting for output acknowledgements', async () => {
    const { events, manager, command } = fixture({
      maxPendingBytes: 4096,
      maxChunkBytes: 1024,
      killGraceMilliseconds: 50,
    });
    manager.start(
      command({
        command: "for i in $(seq 1 1024); do printf '%01024d' 0; done",
        timeoutSeconds: 1,
      }),
    );
    await waitFor(() => (manager.isPaused('operation-1') ? true : undefined));

    const final = await waitFor(() => result(events), 3000);
    expect(final.status).toBe(BashStatus.EXPIRED);
    expect(final.outputComplete).toBe(false);
    expect(final.exitCode).toBeUndefined();
  });

  it('kills background descendants after the shell group leader has exited', async () => {
    const { directory, events, manager, command } = fixture({ killGraceMilliseconds: 50 });
    const sideEffect = join(directory, 'descendant.txt');
    manager.start(
      command({
        command: `(sleep 0.4; printf side-effect > ${JSON.stringify(sideEffect)}) & exit 0`,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    manager.cancel('operation-1', 'instance-1', 'cancel-descendants', 'cancel process group');
    const final = await waitFor(() => result(events), 2000);
    expect(final.status).toBe(BashStatus.CANCELLED);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(existsSync(sideEffect)).toBe(false);
  });

  it('does not report a libuv spawn error as a process exit code', async () => {
    const { directory, events, manager, command } = fixture();
    manager.start(command({ cwd: join(directory, 'missing') }));
    const final = await waitFor(() => result(events));

    expect(final.status).toBe(BashStatus.FAILED);
    expect(final.exitCode).toBeUndefined();
    expect(final.outputComplete).toBe(false);
  });

  it('rejects timer overflow and lets a normal sleep complete', async () => {
    const { events, manager, command } = fixture();
    expect(() =>
      manager.start(command({ command: 'sleep 0.2', timeoutSeconds: 2_147_484 })),
    ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.INVALID_MESSAGE }));
    expect(manager.pendingOperationCount).toBe(0);

    const startedAt = Date.now();
    manager.start(
      command({ operationId: 'operation-normal-sleep', command: 'sleep 0.2', timeoutSeconds: 120 }),
    );
    const final = await waitFor(() => result(events));
    expect(final.status).toBe(BashStatus.COMPLETED);
    expect(final.exitCode).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
  });

  it('rejects new operation IDs only while the bounded memory is fully active', async () => {
    const { events, manager, command } = fixture({ maxOperations: 1 });
    const first = command({ command: 'sleep 0.5' });
    manager.start(first);
    expect(() => manager.start(command({ operationId: 'operation-2' }))).toThrowError(
      expect.objectContaining({ code: DeviceErrorCode.MESSAGE_TOO_LARGE }),
    );
    const final = await waitFor(() => result(events));
    manager.acknowledgeOutput(first.operationId, 'instance-1', final.endOffset ?? 0n);
    manager.acknowledgeResult(first.operationId, 'instance-1');
    expect(manager.pendingOperationCount).toBe(0);
    manager.start(command({ operationId: 'operation-2', command: 'printf second' }));
    await waitFor(() =>
      events.filter((event) => event.type === 'result').length >= 2 ? true : undefined,
    );
  });

  it('rejects expired commands and unknown operations before spawning', () => {
    const { manager, command } = fixture();
    expect(() => manager.start(command({ expiresAt: new Date(Date.now() - 1) }))).toThrowError(
      expect.objectContaining({ code: DeviceErrorCode.OPERATION_EXPIRED }),
    );
    expect(() => manager.query('missing', 'instance-1', 'query-1')).toThrowError(
      expect.objectContaining({ code: DeviceErrorCode.OPERATION_UNKNOWN }),
    );
    expect(manager.pendingOperationCount).toBe(0);
  });
});
