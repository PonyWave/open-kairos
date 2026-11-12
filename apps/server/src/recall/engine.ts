import { type ChildProcess, fork } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { jsonStringByteLength } from './byte-length.js';
import { assertSingleRecallStatement } from './statement.js';
import {
  DEFAULT_SQL_RECALL_LIMITS,
  type RecallAuthorization,
  RecallError,
  type RecallWorkerInput,
  recallAuthorizationSchema,
  recallWorkerInputSchema,
  recallWorkerResponseSchema,
  type SqlRecallLimits,
  type SqlRecallResult,
  sqlRecallLimitsSchema,
} from './types.js';

export class SqlRecallProcessPool {
  readonly #maximum: number;
  #active = 0;

  constructor(maximum = DEFAULT_SQL_RECALL_LIMITS.maxConcurrentProcesses) {
    this.#maximum = sqlRecallLimitsSchema.shape.maxConcurrentProcesses.parse(maximum);
  }

  get maximum(): number {
    return this.#maximum;
  }

  get activeProcessCount(): number {
    return this.#active;
  }

  tryAcquire(): boolean {
    if (this.#active >= this.#maximum) return false;
    this.#active += 1;
    return true;
  }

  release(): void {
    if (this.#active === 0) throw new Error('SQL recall process pool is already empty.');
    this.#active -= 1;
  }
}

export interface SqlRecallEngineOptions {
  limits?: Partial<SqlRecallLimits>;
  processPool?: SqlRecallProcessPool;
}

export interface SqlRecallExecuteOptions {
  signal?: AbortSignal;
}

interface ExecutionOutcome {
  error?: RecallError;
  result?: SqlRecallResult;
}

export class SqlRecallEngine {
  readonly #databasePath: string | null;
  readonly #authorization: RecallAuthorization;
  readonly #limits: SqlRecallLimits;
  readonly #processPool: SqlRecallProcessPool;

  constructor(
    database: DatabaseSync,
    authorization: RecallAuthorization,
    options: SqlRecallEngineOptions = {},
  ) {
    this.#databasePath = database.location();
    this.#authorization = recallAuthorizationSchema.parse(authorization);
    this.#limits = sqlRecallLimitsSchema.parse({
      ...DEFAULT_SQL_RECALL_LIMITS,
      ...options.limits,
    });
    this.#processPool =
      options.processPool ?? new SqlRecallProcessPool(this.#limits.maxConcurrentProcesses);
  }

  get activeProcessCount(): number {
    return this.#processPool.activeProcessCount;
  }

  async execute(sql: string, options: SqlRecallExecuteOptions = {}): Promise<SqlRecallResult> {
    const query = z.string().min(1).safeParse(sql);
    if (!query.success || query.data.trim().length === 0) {
      throw new RecallError('invalid_query', 'SQL must be a non-empty string.');
    }
    assertSingleRecallStatement(query.data);
    throwIfCancelled(options.signal);
    const deadline = Date.now() + this.#limits.timeoutMs;
    const databasePath = this.#databasePath;
    if (databasePath === null) {
      throw new RecallError('query_failed', 'SQL recall requires a file-backed database.');
    }
    if (jsonStringByteLength(query.data) > this.#limits.maxIpcBytes) {
      throw new RecallError(
        'ipc_limit',
        `SQL recall exceeded the ${this.#limits.maxIpcBytes} byte IPC limit.`,
      );
    }
    const input = recallWorkerInputSchema.parse({
      sql: query.data,
      limits: this.#limits,
      databasePath,
      authorization: this.#authorization,
    });
    if (messageBytes(input) > this.#limits.maxIpcBytes) {
      throw new RecallError(
        'ipc_limit',
        `SQL recall exceeded the ${this.#limits.maxIpcBytes} byte IPC limit.`,
      );
    }
    if (!this.#processPool.tryAcquire()) {
      throw new RecallError(
        'concurrency_limit',
        `SQL recall reached the ${this.#processPool.maximum} concurrent process limit.`,
      );
    }
    return this.#executeInProcess(input, options.signal, deadline);
  }

  async #executeInProcess(
    input: RecallWorkerInput,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<SqlRecallResult> {
    const typescript = import.meta.url.endsWith('.ts');
    const processPath = fileURLToPath(
      new URL(`./executor-process.${typescript ? 'ts' : 'js'}`, import.meta.url),
    );
    let child: ChildProcess;
    try {
      child = fork(processPath, {
        execArgv: [
          `--max-old-space-size=${this.#limits.maxJavaScriptHeapMb}`,
          ...(typescript ? ['--import', 'tsx'] : []),
        ],
        serialization: 'json',
        silent: true,
      });
    } catch (error) {
      this.#processPool.release();
      throw new RecallError('query_failed', 'The SQL recall process could not be started.', {
        cause: error,
      });
    }
    return new Promise<SqlRecallResult>((resolve, reject) => {
      let outcome: ExecutionOutcome | undefined;
      let exited = false;
      let released = false;
      let diagnostics = '';
      let timer: NodeJS.Timeout | undefined;
      const release = () => {
        if (released) return;
        released = true;
        this.#processPool.release();
      };
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        diagnostics = (diagnostics + chunk).slice(-65_536);
      });
      child.stdout?.resume();

      const settle = () => {
        if (!exited || !outcome) return;
        release();
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        child.off('message', onMessage);
        if (outcome.error) reject(outcome.error);
        else if (outcome.result) resolve(outcome.result);
        else {
          reject(
            new RecallError('query_failed', 'SQL recall returned no result.', {
              cause: new Error('The execution outcome contained neither a result nor an error.'),
            }),
          );
        }
      };
      const finish = (next: ExecutionOutcome, terminationSignal: NodeJS.Signals) => {
        if (outcome) return;
        outcome = next;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (
          exited ||
          child.exitCode !== null ||
          child.signalCode !== null ||
          child.pid === undefined
        ) {
          exited = true;
          settle();
          return;
        }
        try {
          child.kill(terminationSignal);
        } catch (error) {
          outcome = {
            error: new RecallError('query_failed', 'The SQL recall process could not be stopped.', {
              cause: error,
            }),
          };
        }
      };
      const onAbort = () => {
        finish({ error: new RecallError('cancelled', 'SQL recall was cancelled.') }, 'SIGKILL');
      };
      const onTimeout = () => {
        finish(
          {
            error: new RecallError(
              'timeout',
              `SQL recall exceeded the ${this.#limits.timeoutMs} ms execution limit.`,
            ),
          },
          'SIGKILL',
        );
      };
      child.once('exit', (code, terminationSignal) => {
        exited = true;
        if (!outcome) {
          const detail = diagnostics.trim();
          const cause = new Error(
            `SQL recall process exited with code ${code} and signal ${terminationSignal}.${detail ? `\n${detail}` : ''}`,
          );
          outcome = {
            error: isMemoryExhaustion(diagnostics)
              ? new RecallError(
                  'javascript_heap_limit',
                  `SQL recall exceeded the ${this.#limits.maxJavaScriptHeapMb} MiB JavaScript heap limit.`,
                  { cause },
                )
              : new RecallError('query_failed', 'The SQL recall process exited early.', { cause }),
          };
        }
        settle();
      });
      child.once('error', (error) => {
        finish(
          {
            error: new RecallError('query_failed', 'The SQL recall process failed.', {
              cause: error,
            }),
          },
          'SIGKILL',
        );
      });
      const onMessage = (message: unknown) => {
        if (outcome || isNodeWatchControlMessage(message)) return;
        child.off('message', onMessage);
        if (messageBytes(message) > this.#limits.maxIpcBytes) {
          finish(
            {
              error: new RecallError(
                'ipc_limit',
                `SQL recall exceeded the ${this.#limits.maxIpcBytes} byte IPC limit.`,
              ),
            },
            'SIGKILL',
          );
          return;
        }
        const parsed = recallWorkerResponseSchema.safeParse(message);
        if (!parsed.success) {
          finish(
            {
              error: new RecallError('query_failed', 'SQL recall returned an invalid response.', {
                cause: parsed.error,
              }),
            },
            'SIGKILL',
          );
          return;
        }
        finish(
          parsed.data.ok
            ? { result: parsed.data.result }
            : { error: new RecallError(parsed.data.error.code, parsed.data.error.message) },
          'SIGTERM',
        );
      };
      child.on('message', onMessage);
      signal?.addEventListener('abort', onAbort, { once: true });
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) onTimeout();
      else timer = setTimeout(onTimeout, remainingMs);
      if (signal?.aborted) onAbort();
      if (outcome) return;
      try {
        child.send(input, (error) => {
          if (error) {
            finish(
              {
                error: new RecallError('query_failed', 'The SQL recall input could not be sent.', {
                  cause: error,
                }),
              },
              'SIGKILL',
            );
          }
        });
      } catch (error) {
        finish(
          {
            error: new RecallError('query_failed', 'The SQL recall input could not be sent.', {
              cause: error,
            }),
          },
          'SIGKILL',
        );
      }
    });
  }
}

function messageBytes(message: unknown): number {
  const serialized = JSON.stringify(message);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
}

function isMemoryExhaustion(diagnostics: string): boolean {
  return /JavaScript heap out of memory|Array buffer allocation failed/.test(diagnostics);
}

function isNodeWatchControlMessage(message: unknown): boolean {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return false;
  const entries: [string, unknown][] = Object.entries(message);
  if (entries.length !== 1) return false;
  const [key, value] = entries[0] ?? [];
  return (key === 'watch:import' || key === 'watch:require') && Array.isArray(value);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RecallError('cancelled', 'SQL recall was cancelled.');
}
