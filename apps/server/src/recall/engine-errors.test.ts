import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../storage/database.js';
import { SqlRecallEngine } from './engine.js';

const temporaryDirectories: string[] = [];
const authorization = {
  scope: { threadId: 'thread-main', agentId: 'thread' },
  currentRunId: 'internal-run',
  includeDescendants: false,
  visibility: 'self' as const,
};

function createDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-recall-errors-'));
  temporaryDirectories.push(directory);
  return openDatabase(join(directory, 'server.sqlite'));
}

const forkMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, fork: forkMock };
});

class FakeChildProcess extends EventEmitter {
  readonly pid = 4242;
  readonly exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = null;
  readonly stderr = null;

  readonly send = vi.fn((_input: unknown, callback: (error: Error | null) => void) => {
    queueMicrotask(() => callback(null));
    return true;
  });

  readonly kill = vi.fn((signal: NodeJS.Signals) => {
    queueMicrotask(() => {
      this.signalCode = signal;
      this.emit('exit', null, signal);
    });
    return true;
  });
}

afterEach(() => {
  forkMock.mockReset();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SQL recall process errors', () => {
  it('preserves the constructor failure as the public error cause', async () => {
    const database = createDatabase();
    const cause = new Error('process loader failed');
    forkMock.mockImplementation(() => {
      throw cause;
    });
    try {
      const engine = new SqlRecallEngine(database, authorization);
      await expect(engine.execute('SELECT 1')).rejects.toMatchObject({
        code: 'query_failed',
        message: 'The SQL recall process could not be started.',
        cause,
      });
      expect(engine.activeProcessCount).toBe(0);
    } finally {
      database.close();
    }
  });

  it('preserves a runtime process error and releases the process', async () => {
    const database = createDatabase();
    const child = new FakeChildProcess();
    forkMock.mockReturnValue(child as unknown as ChildProcess);
    try {
      const engine = new SqlRecallEngine(database, authorization);
      const executing = engine.execute('SELECT 1');
      const cause = new Error('IPC channel failed');
      child.emit('error', cause);
      await expect(executing).rejects.toMatchObject({
        code: 'query_failed',
        message: 'The SQL recall process failed.',
        cause,
      });
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(engine.activeProcessCount).toBe(0);
    } finally {
      database.close();
    }
  });

  it.each([{ 'watch:import': ['file:///tmp/recall-executor.ts'] }, { 'watch:require': [null] }])(
    'ignores a Node watch control message before the worker response',
    async (control) => {
      const database = createDatabase();
      const child = new FakeChildProcess();
      forkMock.mockReturnValue(child as unknown as ChildProcess);
      try {
        const engine = new SqlRecallEngine(database, authorization);
        const executing = engine.execute('SELECT 1');
        const assertion = expect(executing).resolves.toEqual({
          columns: ['value'],
          rows: [[1]],
          truncated: false,
        });
        child.emit('message', control);
        child.emit('message', {
          ok: true,
          result: { columns: ['value'], rows: [[1]], truncated: false },
        });
        await assertion;
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
        expect(engine.activeProcessCount).toBe(0);
      } finally {
        database.close();
      }
    },
  );

  it('rejects an invalid worker response after a Node watch control message', async () => {
    const database = createDatabase();
    const child = new FakeChildProcess();
    forkMock.mockReturnValue(child as unknown as ChildProcess);
    try {
      const engine = new SqlRecallEngine(database, authorization);
      const executing = engine.execute('SELECT 1');
      const assertion = expect(executing).rejects.toMatchObject({
        code: 'query_failed',
        message: 'SQL recall returned an invalid response.',
      });
      child.emit('message', { 'watch:import': ['file:///tmp/recall-executor.ts'] });
      child.emit('message', {
        ok: true,
        result: { columns: ['value'], rows: [[{}]], truncated: false },
      });
      await assertion;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(engine.activeProcessCount).toBe(0);
    } finally {
      database.close();
    }
  });
});
