import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ServerMessageInit,
  SyncReadAction,
  SyncScanAction,
  WriteAction,
} from '@kairos/contracts/device';
import {
  DeviceErrorCode,
  decodeServerMessage,
  encodeServerMessage,
  SyncEntryKind,
} from '@kairos/contracts/device';
import { afterEach, expect, it } from 'vitest';
import { writeRemoteFile } from './files.js';
import { readSyncChunk, scanSyncPath } from './sync.js';

const directories: string[] = [];

type OperationAction = Extract<
  ServerMessageInit['payload'],
  { case: 'operationStart' }
>['value']['action'];

function action<T extends 'syncScan' | 'syncRead' | 'write'>(
  kind: T,
  value: Extract<OperationAction, { case: T }>['value'],
): T extends 'syncScan' ? SyncScanAction : T extends 'syncRead' ? SyncReadAction : WriteAction {
  const message = decodeServerMessage(
    encodeServerMessage({
      payload: {
        case: 'operationStart',
        value: {
          operationId: `operation-${kind}`,
          requestId: `request-${kind}`,
          target: {
            envId: 'env',
            deviceBindingId: 'binding',
            instanceId: 'instance',
            bindingVersion: 1n,
          },
          expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 60), nanos: 0 },
          action: { case: kind, value } as NonNullable<OperationAction>,
        },
      },
    }),
  );
  if (message.payload.case !== 'operationStart' || message.payload.value.action.case !== kind) {
    throw new Error('Sync action fixture is invalid.');
  }
  return message.payload.value.action.value as never;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-sync-files-'));
  directories.push(directory);
  return directory;
}

function writeChunk(
  path: string,
  transferId: string,
  offset: bigint,
  totalSize: bigint,
  data: Uint8Array,
  sha256: string,
  overwrite = false,
) {
  return action('write', {
    path,
    cwd: '/',
    content: '',
    binaryContent: data,
    overwrite,
    createParents: true,
    transferId,
    offset,
    totalSize,
    expectedSha256: sha256,
    executable: true,
  });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('scans nested binary files, directories, links and special files without loading file content', async () => {
  const directory = temporaryDirectory();
  const nested = join(directory, 'nested');
  const binary = join(nested, 'payload.bin');
  const link = join(directory, 'link');
  const fifo = join(directory, 'fifo');
  const bytes = Buffer.from(Array.from({ length: 150_000 }, (_, index) => index % 251));
  requireDirectory(nested);
  writeFileSync(binary, bytes);
  chmodSync(binary, 0o755);
  requireDirectory(join(directory, 'empty'));
  symlinkSync(binary, link);
  const fifoResult = spawnSync('mkfifo', [fifo]);
  expect(fifoResult.status).toBe(0);

  const outcome = await scanSyncPath(
    action('syncScan', { path: directory, cwd: '/' }),
    new AbortController().signal,
  );
  expect(outcome.kind).toBe(SyncEntryKind.DIRECTORY);
  expect(outcome.entries).toHaveLength(5);
  expect(
    outcome.entries.find((entry) => entry.relativePath === 'nested/payload.bin'),
  ).toMatchObject({
    kind: SyncEntryKind.FILE,
    size: BigInt(bytes.length),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    executable: true,
  });
  expect(outcome.entries.find((entry) => entry.relativePath === 'empty')?.kind).toBe(
    SyncEntryKind.DIRECTORY,
  );
  expect(outcome.entries.find((entry) => entry.relativePath === 'link')?.kind).toBe(
    SyncEntryKind.SYMLINK,
  );
  expect(outcome.entries.find((entry) => entry.relativePath === 'fifo')?.kind).toBe(
    SyncEntryKind.SPECIAL,
  );

  const chunk = await readSyncChunk(
    action('syncRead', { path: binary, cwd: '/', offset: 65_536n, limit: 65_536 }),
    new AbortController().signal,
  );
  expect(chunk.data).toEqual(bytes.subarray(65_536, 131_072));
  expect(chunk.size).toBe(BigInt(bytes.length));
  expect(chunk.executable).toBe(true);
});

it('writes binary chunks atomically, creates parents and preserves the executable bit', async () => {
  const directory = temporaryDirectory();
  const path = join(directory, 'new', 'nested', 'payload.bin');
  const bytes = Buffer.from(Array.from({ length: 140_000 }, (_, index) => (index * 17) % 256));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const first = await writeRemoteFile(
    writeChunk(path, 'transfer-one', 0n, BigInt(bytes.length), bytes.subarray(0, 65_536), sha256),
    new AbortController().signal,
  );
  expect(first).toMatchObject({ transferComplete: false, nextOffset: 65_536n, fileVersion: '' });
  const second = await writeRemoteFile(
    writeChunk(
      path,
      'transfer-one',
      65_536n,
      BigInt(bytes.length),
      bytes.subarray(65_536, 131_072),
      sha256,
    ),
    new AbortController().signal,
  );
  expect(second).toMatchObject({ transferComplete: false, nextOffset: 131_072n });
  const third = await writeRemoteFile(
    writeChunk(
      path,
      'transfer-one',
      131_072n,
      BigInt(bytes.length),
      bytes.subarray(131_072),
      sha256,
    ),
    new AbortController().signal,
  );
  expect(third).toMatchObject({
    transferComplete: true,
    nextOffset: BigInt(bytes.length),
    fileVersion: sha256,
  });
  expect(readFileSync(path)).toEqual(bytes);
  expect(statSync(path).mode & 0o111).not.toBe(0);
  expect(readdirSync(dirname(path))).toEqual(['payload.bin']);
});

it('rejects conflicts and hash mismatches without replacing the target', async () => {
  const directory = temporaryDirectory();
  const path = join(directory, 'target.bin');
  const source = Buffer.from('replacement');
  const sha256 = createHash('sha256').update(source).digest('hex');
  writeFileSync(path, 'original');
  await expect(
    writeRemoteFile(
      writeChunk(path, 'transfer-conflict', 0n, BigInt(source.length), source, sha256),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: DeviceErrorCode.OPERATION_CONFLICT });
  expect(readFileSync(path, 'utf8')).toBe('original');

  await expect(
    writeRemoteFile(
      writeChunk(path, 'transfer-hash', 0n, BigInt(source.length), source, '0'.repeat(64), true),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: DeviceErrorCode.OPERATION_CONFLICT });
  expect(readFileSync(path, 'utf8')).toBe('original');

  await writeRemoteFile(
    writeChunk(path, 'transfer-overwrite', 0n, BigInt(source.length), source, sha256, true),
    new AbortController().signal,
  );
  expect(readFileSync(path)).toEqual(source);
});

it('supports empty files and reports a root symbolic link without following it', async () => {
  const directory = temporaryDirectory();
  const target = join(directory, 'target');
  const link = join(directory, 'link');
  writeFileSync(target, 'content');
  symlinkSync(target, link);
  const scanned = await scanSyncPath(
    action('syncScan', { path: link, cwd: '/' }),
    new AbortController().signal,
  );
  expect(scanned.kind).toBe(SyncEntryKind.SYMLINK);
  expect(scanned.sha256).toBe('');

  const empty = join(directory, 'empty.bin');
  const emptyHash = createHash('sha256').update(new Uint8Array()).digest('hex');
  await writeRemoteFile(
    writeChunk(empty, 'transfer-empty', 0n, 0n, new Uint8Array(), emptyHash),
    new AbortController().signal,
  );
  expect(readFileSync(empty)).toHaveLength(0);
});

it('keeps non-directory ancestors and skips their descendants during conflict scans', async () => {
  const directory = temporaryDirectory();
  const outside = join(directory, 'outside');
  requireDirectory(outside);
  writeFileSync(join(directory, 'nested'), 'not a directory');
  writeFileSync(join(outside, 'child.txt'), 'outside content');
  symlinkSync(outside, join(directory, 'linked'));
  writeFileSync(join(directory, 'other.txt'), 'other');

  const outcome = await scanSyncPath(
    action('syncScan', {
      path: directory,
      cwd: '/',
      conflictScan: true,
      relativePaths: ['nested', 'nested/child.txt', 'linked', 'linked/child.txt', 'other.txt'],
    }),
    new AbortController().signal,
  );
  expect(outcome.entries.map((entry) => entry.relativePath)).toEqual([
    'linked',
    'nested',
    'other.txt',
  ]);
  expect(outcome.entries.find((entry) => entry.relativePath === 'linked')?.kind).toBe(
    SyncEntryKind.SYMLINK,
  );
  expect(outcome.entries.find((entry) => entry.relativePath === 'nested')?.kind).toBe(
    SyncEntryKind.FILE,
  );
});

it('enforces single-file and file-count limits before transferring content', async () => {
  const oversized = temporaryDirectory();
  const oversizedPath = join(oversized, 'large.bin');
  writeFileSync(oversizedPath, Buffer.alloc(8 * 1024 * 1024 + 1));
  await expect(
    scanSyncPath(
      action('syncScan', { path: oversizedPath, cwd: '/' }),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: DeviceErrorCode.FILE_TOO_LARGE });

  const excessive = temporaryDirectory();
  for (let index = 0; index <= 256; index += 1) {
    writeFileSync(join(excessive, `${index}.txt`), '');
  }
  await expect(
    scanSyncPath(action('syncScan', { path: excessive, cwd: '/' }), new AbortController().signal),
  ).rejects.toMatchObject({ code: DeviceErrorCode.MESSAGE_TOO_LARGE });
});

function requireDirectory(path: string): void {
  const result = spawnSync('mkdir', ['-p', path]);
  if (result.status !== 0) throw new Error(`Unable to create test directory ${path}.`);
}
