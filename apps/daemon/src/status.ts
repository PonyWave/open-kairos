import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, rmdirSync, rmSync, type Stats, statSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';

const serviceStates = ['starting', 'running', 'stopping', 'stopped', 'fatal'] as const;
const connectionStates = [
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
  'fatal',
  'stopped',
] as const;
const terminalOperationStates = new Set(['completed', 'failed', 'cancelled', 'expired', 'unknown']);

export type DaemonServiceState = (typeof serviceStates)[number];
export type DaemonConnectionState = (typeof connectionStates)[number];

export interface DaemonOperationState {
  operationId: string;
  kind: string;
  status: string;
}

export interface DaemonStatusEvent {
  sequence: number;
  timestamp: string;
  category: 'service' | 'connection' | 'operation';
  state: string;
  operationId?: string;
  kind?: string;
  error?: string;
}

export interface DaemonStatusSnapshot {
  pid: number;
  startedAt: string;
  service: DaemonServiceState;
  connection: DaemonConnectionState;
  lastError?: string;
  operations: DaemonOperationState[];
  events: DaemonStatusEvent[];
}

interface DaemonStatusOptions {
  pid?: number;
  now?: () => Date;
  maxEvents?: number;
  maxObservers?: number;
  cleanupDirectory?: boolean;
}

type StatusMessage =
  | { type: 'snapshot'; snapshot: DaemonStatusSnapshot }
  | { type: 'event'; event: DaemonStatusEvent }
  | { type: 'error'; message: string };

export function daemonStatusSocketPath(identityPath: string): string {
  const normalized = resolve(identityPath);
  const uid = statSync(normalized).uid;
  const suffix = createHash('sha256').update(normalized).digest('hex').slice(0, 32);
  return `/tmp/kairos-daemon-${uid}/${suffix}.sock`;
}

export class DaemonStatus {
  private readonly pid: number;
  private readonly now: () => Date;
  private readonly maxEvents: number;
  private readonly maxObservers: number;
  private readonly cleanupDirectory: boolean;
  private readonly startedAt: string;
  private readonly events: DaemonStatusEvent[] = [];
  private readonly operations = new Map<string, DaemonOperationState>();
  private readonly observers = new Set<Socket>();
  private server: Server | undefined;
  private closing: Promise<void> | undefined;
  private sequence = 0;
  private serviceState: DaemonServiceState = 'starting';
  private connectionState: DaemonConnectionState = 'disconnected';
  private lastError: string | undefined;

  constructor(
    readonly socketPath: string,
    options: DaemonStatusOptions = {},
  ) {
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? (() => new Date());
    this.maxEvents = options.maxEvents ?? 100;
    this.maxObservers = options.maxObservers ?? 8;
    this.cleanupDirectory = options.cleanupDirectory ?? false;
    if (
      !Number.isSafeInteger(this.pid) ||
      this.pid <= 0 ||
      !Number.isSafeInteger(this.maxEvents) ||
      this.maxEvents <= 0 ||
      this.maxEvents > 1000 ||
      !Number.isSafeInteger(this.maxObservers) ||
      this.maxObservers <= 0 ||
      this.maxObservers > 32
    ) {
      throw new Error('Daemon status limits are invalid.');
    }
    this.startedAt = this.now().toISOString();
  }

  snapshot(): DaemonStatusSnapshot {
    return {
      pid: this.pid,
      startedAt: this.startedAt,
      service: this.serviceState,
      connection: this.connectionState,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      operations: [...this.operations.values()].map((operation) => ({ ...operation })),
      events: this.events.map((event) => ({ ...event })),
    };
  }

  service(state: DaemonServiceState, error?: unknown): void {
    this.serviceState = state;
    if (error !== undefined) this.lastError = statusError(error);
    this.publish({ category: 'service', state, ...(error === undefined ? {} : { error }) });
  }

  connection(state: DaemonConnectionState, error?: unknown): void {
    this.connectionState = state;
    if (error !== undefined) this.lastError = statusError(error);
    this.publish({ category: 'connection', state, ...(error === undefined ? {} : { error }) });
  }

  operation(operation: DaemonOperationState, error?: unknown): void {
    const current = {
      operationId: requiredText(operation.operationId, 'operation ID', 200),
      kind: requiredText(operation.kind, 'operation kind', 50),
      status: requiredText(operation.status, 'operation status', 50),
    };
    if (terminalOperationStates.has(current.status)) this.operations.delete(current.operationId);
    else this.operations.set(current.operationId, current);
    this.publish({
      category: 'operation',
      state: current.status,
      operationId: current.operationId,
      kind: current.kind,
      ...(error === undefined ? {} : { error }),
    });
  }

  async listen(): Promise<void> {
    if (this.server !== undefined) throw new Error('Daemon status channel is already listening.');
    if (this.cleanupDirectory)
      mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    this.assertSecureDirectory();
    await this.removeStaleSocket();
    const server = createServer((socket) => this.observe(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once('error', failed);
        server.listen(this.socketPath, () => {
          server.off('error', failed);
          resolve();
        });
      });
      chmodSync(this.socketPath, 0o600);
      const stat = lstatSync(this.socketPath);
      if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
        throw new Error('Daemon status socket ownership or permissions are invalid.');
      }
    } catch (error) {
      this.server = undefined;
      server.close();
      rmSync(this.socketPath, { force: true });
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    const server = this.server;
    this.server = undefined;
    this.closing = (async () => {
      for (const observer of this.observers) observer.destroySoon();
      this.observers.clear();
      if (server !== undefined) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      rmSync(this.socketPath, { force: true });
      if (this.cleanupDirectory) {
        try {
          rmdirSync(dirname(this.socketPath));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
        }
      }
    })();
    return this.closing;
  }

  private publish(
    input: Omit<DaemonStatusEvent, 'sequence' | 'timestamp' | 'error'> & { error?: unknown },
  ): void {
    const event: DaemonStatusEvent = {
      sequence: ++this.sequence,
      timestamp: this.now().toISOString(),
      category: input.category,
      state: requiredText(input.state, 'event state', 50),
      ...(input.operationId === undefined
        ? {}
        : { operationId: requiredText(input.operationId, 'operation ID', 200) }),
      ...(input.kind === undefined ? {} : { kind: requiredText(input.kind, 'operation kind', 50) }),
      ...(input.error === undefined ? {} : { error: statusError(input.error) }),
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.shift();
    for (const observer of this.observers) this.write(observer, { type: 'event', event });
  }

  private observe(socket: Socket): void {
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.observers.delete(socket));
    socket.setNoDelay(true);
    if (this.observers.size >= this.maxObservers) {
      this.write(socket, { type: 'error', message: 'Too many local status observers.' });
      socket.end();
      return;
    }
    this.observers.add(socket);
    this.write(socket, { type: 'snapshot', snapshot: this.snapshot() });
  }

  private write(socket: Socket, message: StatusMessage): void {
    if (socket.destroyed || !socket.writable) return;
    socket.write(`${JSON.stringify(message)}\n`);
    if (socket.writableLength > 256 * 1024) socket.destroy();
  }

  private assertSecureDirectory(): void {
    const directory = dirname(this.socketPath);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error(
        'Daemon status socket directory must be owned by the Daemon user with mode 0700.',
      );
    }
  }

  private async removeStaleSocket(): Promise<void> {
    let stat: Stats;
    try {
      stat = lstatSync(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) {
      throw new Error('Daemon status socket path is not a socket owned by the Daemon user.');
    }
    const active = await new Promise<boolean>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const done = (callback: () => void) => {
        socket.removeAllListeners();
        socket.destroy();
        callback();
      };
      socket.once('connect', () => done(() => resolve(true)));
      socket.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
          done(() => resolve(false));
        } else {
          done(() => reject(error));
        }
      });
    });
    if (active) throw new Error('Another Daemon instance already owns the status socket.');
    rmSync(this.socketPath, { force: true });
  }
}

export function observeDaemonStatus(
  socketPath: string,
  output: Pick<NodeJS.WriteStream, 'write'> = process.stdout,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    let snapshotReceived = false;
    let settled = false;
    const succeed = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.on('error', (error) => fail(error));
    socket.on('end', () => {
      if (snapshotReceived) succeed();
      else fail(new Error('Daemon status channel closed before sending a snapshot.'));
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1024 * 1024) {
        fail(new Error('Daemon status response exceeds the input limit.'));
        return;
      }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = parseStatusMessage(line);
          if (message.type === 'error') throw new Error(message.message);
          if (message.type === 'snapshot') {
            if (snapshotReceived) throw new Error('Daemon status sent more than one snapshot.');
            snapshotReceived = true;
            renderSnapshot(message.snapshot, output);
          } else {
            if (!snapshotReceived) throw new Error('Daemon status snapshot must arrive first.');
            output.write(`${formatEvent(message.event)}\n`);
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error('Daemon status response is invalid.'));
          return;
        }
      }
    });
  });
}

function renderSnapshot(
  snapshot: DaemonStatusSnapshot,
  output: Pick<NodeJS.WriteStream, 'write'>,
): void {
  output.write(
    `Process: ${snapshot.service} (pid ${snapshot.pid}, started ${snapshot.startedAt})\n`,
  );
  output.write(`WSS: ${snapshot.connection}\n`);
  output.write('Current operations:\n');
  if (snapshot.operations.length === 0) output.write('  none\n');
  for (const operation of snapshot.operations) {
    output.write(`  ${operation.status} ${operation.kind} ${operation.operationId}\n`);
  }
  output.write('Recent events:\n');
  if (snapshot.events.length === 0) output.write('  none\n');
  for (const event of snapshot.events) output.write(`  ${formatEvent(event)}\n`);
  output.write('Live events (Ctrl+C stops only this observer):\n');
}

function formatEvent(event: DaemonStatusEvent): string {
  const operation = event.operationId === undefined ? '' : ` ${event.operationId}`;
  const kind = event.kind === undefined ? '' : ` ${event.kind}`;
  const error = event.error === undefined ? '' : ` error=${event.error}`;
  return `[${event.timestamp}] ${event.category} ${event.state}${kind}${operation}${error}`;
}

function parseStatusMessage(text: string): StatusMessage {
  const value: unknown = JSON.parse(text);
  const record = objectRecord(value, 'status message');
  if (record.type === 'error') {
    return { type: 'error', message: requiredText(record.message, 'error message', 500) };
  }
  if (record.type === 'event') return { type: 'event', event: parseEvent(record.event) };
  if (record.type === 'snapshot') {
    const snapshot = objectRecord(record.snapshot, 'status snapshot');
    const pid = snapshot.pid;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
      throw new Error('Daemon status process ID is invalid.');
    }
    if (
      !includes(serviceStates, snapshot.service) ||
      !includes(connectionStates, snapshot.connection)
    ) {
      throw new Error('Daemon status service or connection state is invalid.');
    }
    const operations = requiredArray(snapshot.operations, 'current operations', 256).map(
      (entry) => {
        const operation = objectRecord(entry, 'current operation');
        return {
          operationId: requiredText(operation.operationId, 'operation ID', 200),
          kind: requiredText(operation.kind, 'operation kind', 50),
          status: requiredText(operation.status, 'operation status', 50),
        };
      },
    );
    const events = requiredArray(snapshot.events, 'recent events', 1000).map(parseEvent);
    return {
      type: 'snapshot',
      snapshot: {
        pid: pid as number,
        startedAt: timestampText(snapshot.startedAt),
        service: snapshot.service,
        connection: snapshot.connection,
        operations,
        events,
      },
    };
  }
  throw new Error('Daemon status message type is invalid.');
}

function parseEvent(value: unknown): DaemonStatusEvent {
  const event = objectRecord(value, 'status event');
  if (
    !Number.isSafeInteger(event.sequence) ||
    (event.sequence as number) <= 0 ||
    (event.category !== 'service' &&
      event.category !== 'connection' &&
      event.category !== 'operation')
  ) {
    throw new Error('Daemon status event sequence or category is invalid.');
  }
  return {
    sequence: event.sequence as number,
    timestamp: timestampText(event.timestamp),
    category: event.category,
    state: requiredText(event.state, 'event state', 50),
    ...(event.operationId === undefined
      ? {}
      : { operationId: requiredText(event.operationId, 'operation ID', 200) }),
    ...(event.kind === undefined ? {} : { kind: requiredText(event.kind, 'operation kind', 50) }),
    ...(event.error === undefined ? {} : { error: requiredText(event.error, 'event error', 500) }),
  };
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Daemon status ${name} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, name: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`Daemon status ${name} are invalid.`);
  }
  return value;
}

function requiredText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    hasControlCharacters(value)
  ) {
    throw new Error(`Daemon status ${name} is invalid.`);
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function timestampText(value: unknown): string {
  const timestamp = requiredText(value, 'timestamp', 50);
  if (!Number.isFinite(Date.parse(timestamp)))
    throw new Error('Daemon status timestamp is invalid.');
  return timestamp;
}

function statusError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const singleLine = [...message]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('');
  return requiredText(singleLine.trim().slice(0, 500) || 'Unknown status error.', 'error', 500);
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}
