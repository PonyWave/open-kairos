import * as files from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create, ReadBashLogRequestSchema } from '@kairos/contracts';
import { BashStatus } from '@kairos/contracts/device';
import { expect, it, vi } from 'vitest';
import { DeviceBashStore } from '../devices/operation-store.js';
import { seedTestSession } from '../integration/test-authentication.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { BashLogReader } from './logs.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

it.each([1, 1001])(
  'pages every persisted historical byte before a missing suffix (%i chunks)',
  async (chunkCount) => {
    const database = openDatabase(':memory:');
    const now = () => new Date('2026-11-08T00:00:00.000Z');
    const store = new SessionStore(database);
    const operations = new DeviceBashStore(database);
    const reader = new BashLogReader({ store, operations, now });
    const offset = (value: number) => String(value).padStart(20, '0');
    const persistedBytes = chunkCount * 10;
    try {
      database
        .prepare(`INSERT INTO devices (
      device_id, owner_id, device_name, account_description, bash_enabled, status,
      created_at, updated_at
    ) VALUES ('audit-device', 'audit-owner', 'historical device', 'test', 1, 'revoked', ?, ?)`)
        .run(now().toISOString(), now().toISOString());
      database
        .prepare(`INSERT INTO device_bash_operations (
      operation_id, owner_id, device_id, run_id, command, cwd, expires_at, timeout_seconds,
      target_instance_id, delivery_state, status, next_offset, result_status,
      result_end_offset, output_complete, output_gap, created_at, updated_at
    ) VALUES ('audit-operation', 'audit-owner', 'audit-device', 'historical-run', 'test', '/', ?,
      60, 'historical-instance', 'sent', ?, ?, ?, ?, 0, 1, ?, ?)`)
        .run(
          now().toISOString(),
          BashStatus.UNKNOWN,
          offset(persistedBytes),
          BashStatus.UNKNOWN,
          offset(persistedBytes + 10),
          now().toISOString(),
          now().toISOString(),
        );
      const insert = database.prepare(`INSERT INTO device_bash_output_chunks
      (operation_id, offset, end_offset, stream, data) VALUES ('audit-operation', ?, ?, 1, ?)`);
      for (let chunk = 0; chunk < chunkCount; chunk += 1) {
        insert.run(offset(chunk * 10), offset((chunk + 1) * 10), Buffer.from('0123456789'));
      }

      let cursor = 0n;
      const text: string[] = [];
      const gaps: Array<{ startOffset: bigint; endOffset?: bigint }> = [];
      for (let page = 0; page < 10; page += 1) {
        const result = await reader.read(
          'audit-owner',
          create(ReadBashLogRequestSchema, {
            operationId: 'audit-operation',
            offset: cursor,
            limitBytes: chunkCount === 1 ? 4 : 64 * 1024,
          }),
        );
        text.push(...result.chunks.map((chunk) => Buffer.from(chunk.data).toString('utf8')));
        gaps.push(...result.gaps);
        if (result.nextOffset === undefined) break;
        expect(result.nextOffset).toBeGreaterThan(cursor);
        cursor = result.nextOffset;
      }
      expect(text.join('')).toBe('0123456789'.repeat(chunkCount));
      expect(gaps).toEqual([
        { startOffset: BigInt(persistedBytes), endOffset: BigInt(persistedBytes + 10) },
      ]);
      await expect(
        reader.read(
          'other-owner',
          create(ReadBashLogRequestSchema, {
            operationId: 'audit-operation',
            offset: 0n,
            limitBytes: 4,
          }),
        ),
      ).rejects.toThrow();
    } finally {
      database.close();
    }
  },
);

it('returns only bytes actually read when a historical file is truncated after stat', async () => {
  const directory = await files.mkdtemp(join(tmpdir(), 'kairos-log-read-'));
  const path = join(directory, 'output.log');
  const database = openDatabase(':memory:');
  seedTestSession(database, 'owner', 'log-session');
  const store = new SessionStore(database);
  const operations = new DeviceBashStore(database);
  try {
    const thread = store.createThread({
      ownerId: 'owner',
      method: 'CreateThread',
      clientActionId: 'thread',
      parameters: {},
      title: 'log',
    });
    const sent = store.sendMessage({
      ownerId: 'owner',
      method: 'SendMessage',
      clientActionId: 'input',
      parameters: {},
      threadId: thread.threadId,
      text: 'log',
      mode: 'follow_up',
    });
    await files.writeFile(path, '0123456789');
    store.recordServerBashOperation({
      operationId: 'file-log',
      runId: sent.runId,
      toolCallId: 'call',
      logPath: path,
      outputComplete: true,
      endOffset: 10n,
      expiresAt: null,
    });
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(files.open).mockImplementationOnce(async () => {
      await files.truncate(path, 4);
      return actual.open(path, 'r');
    });
    const reader = new BashLogReader({ store, operations });
    const result = await reader.read(
      'owner',
      create(ReadBashLogRequestSchema, {
        operationId: 'file-log',
        offset: 0n,
        limitBytes: 10,
      }),
    );
    expect(result.chunks).toHaveLength(1);
    expect(Buffer.from(result.chunks[0]?.data ?? []).toString('utf8')).toBe('0123');
    expect(result.nextOffset).toBeUndefined();
  } finally {
    vi.restoreAllMocks();
    database.close();
    await files.rm(directory, { recursive: true, force: true });
  }
});

it.each([-1, 0, 1])('honors the absolute Server log expiration (%i ms)', async (delta) => {
  const directory = await files.mkdtemp(join(tmpdir(), 'kairos-log-expiration-'));
  const path = join(directory, 'output.log');
  const database = openDatabase(':memory:');
  seedTestSession(database, 'owner', 'log-session');
  const store = new SessionStore(database);
  const operations = new DeviceBashStore(database);
  const now = new Date();
  try {
    const thread = store.createThread({
      ownerId: 'owner',
      method: 'CreateThread',
      clientActionId: 'thread',
      parameters: {},
      title: 'log',
    });
    const sent = store.sendMessage({
      ownerId: 'owner',
      method: 'SendMessage',
      clientActionId: 'input',
      parameters: {},
      threadId: thread.threadId,
      text: 'log',
      mode: 'follow_up',
    });
    await files.writeFile(path, 'retained output');
    store.recordServerBashOperation({
      operationId: 'expiring-log',
      runId: sent.runId,
      toolCallId: 'call',
      logPath: path,
      outputComplete: true,
      endOffset: 15n,
      expiresAt: new Date(now.getTime() + delta).toISOString(),
    });
    const reader = new BashLogReader({ store, operations, now: () => now });
    const result = await reader.read(
      'owner',
      create(ReadBashLogRequestSchema, {
        operationId: 'expiring-log',
        offset: 0n,
        limitBytes: 64,
      }),
    );
    expect(result.expired).toBe(delta <= 0);
    expect(result.chunks).toHaveLength(delta <= 0 ? 0 : 1);
  } finally {
    database.close();
    await files.rm(directory, { recursive: true, force: true });
  }
});
