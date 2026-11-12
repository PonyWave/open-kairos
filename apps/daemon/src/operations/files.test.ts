import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EditAction,
  ReadAction,
  ReadImageAction,
  ServerMessageInit,
  WriteAction,
} from '@kairos/contracts/device';
import {
  DeviceErrorCode,
  decodeServerMessage,
  encodeServerMessage,
} from '@kairos/contracts/device';
import { afterEach, describe, expect, it } from 'vitest';
import { editRemoteFile, readRemoteFile, readRemoteImage, writeRemoteFile } from './files.js';

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-remote-files-'));
  directories.push(directory);
  return directory;
}

type OperationAction = Extract<
  ServerMessageInit['payload'],
  { case: 'operationStart' }
>['value']['action'];

function action<T extends 'read' | 'readImage' | 'write' | 'edit'>(
  kind: T,
  value: Extract<OperationAction, { case: T }>['value'],
): T extends 'read'
  ? ReadAction
  : T extends 'readImage'
    ? ReadImageAction
    : T extends 'write'
      ? WriteAction
      : EditAction {
  const message = decodeServerMessage(
    encodeServerMessage({
      payload: {
        case: 'operationStart',
        value: {
          operationId: 'operation-file',
          requestId: 'request-file',
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
    throw new Error('File action fixture is invalid.');
  }
  return message.payload.value.action.value as never;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('remote file operations', () => {
  it('creates exclusively, overwrites explicitly, and leaves no temporary files', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'notes.txt');
    const controller = new AbortController();
    const created = await writeRemoteFile(
      action('write', { path, cwd: directory, content: '第一行\n', overwrite: false }),
      controller.signal,
    );
    expect(created.bytesWritten).toBe(BigInt(Buffer.byteLength('第一行\n')));
    expect(created.fileVersion).toBe(createHash('sha256').update('第一行\n').digest('hex'));
    expect(readFileSync(path, 'utf8')).toBe('第一行\n');

    await expect(
      writeRemoteFile(
        action('write', { path, cwd: directory, content: 'must-not-replace', overwrite: false }),
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.OPERATION_CONFLICT });
    expect(readFileSync(path, 'utf8')).toBe('第一行\n');

    await writeRemoteFile(
      action('write', { path, cwd: directory, content: '替换\n', overwrite: true }),
      controller.signal,
    );
    expect(readFileSync(path, 'utf8')).toBe('替换\n');
    expect(readdirSync(directory)).toEqual(['notes.txt']);
  });

  it('preserves the existing mode on write and applies umask only to new files', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'existing.txt');
    const createdPath = join(directory, 'created.txt');
    writeFileSync(path, 'old\n');
    chmodSync(path, 0o755);
    const previousUmask = process.umask(0o077);
    try {
      await writeRemoteFile(
        action('write', { path, cwd: directory, content: 'updated\n', overwrite: true }),
        new AbortController().signal,
      );
      await writeRemoteFile(
        action('write', {
          path: createdPath,
          cwd: directory,
          content: 'created\n',
          overwrite: false,
        }),
        new AbortController().signal,
      );
    } finally {
      process.umask(previousUmask);
    }
    expect(readFileSync(path, 'utf8')).toBe('updated\n');
    expect(statSync(path).mode & 0o777).toBe(0o755);
    expect(readFileSync(createdPath, 'utf8')).toBe('created\n');
    expect(statSync(createdPath).mode & 0o777).toBe(0o600);
  });

  it('preserves the existing mode on edit under a restrictive umask', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'edit-mode.txt');
    writeFileSync(path, 'old\n');
    chmodSync(path, 0o755);
    const previousUmask = process.umask(0o077);
    try {
      await editRemoteFile(
        action('edit', {
          path,
          cwd: directory,
          oldText: 'old',
          newText: 'new',
          expectedOccurrences: 1,
          expectedFileVersion: createHash('sha256').update('old\n').digest('hex'),
        }),
        new AbortController().signal,
      );
    } finally {
      process.umask(previousUmask);
    }
    expect(readFileSync(path, 'utf8')).toBe('new\n');
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  it('reads real UTF-8 line ranges and hashes the complete file bytes', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'unicode.txt');
    writeFileSync(path, '第一行\nsecond\n第三行');
    const outcome = await readRemoteFile(
      action('read', { path, cwd: directory, offset: 2, limit: 1 }),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      content: 'second\n',
      startLine: 2,
      endLine: 2,
      hasMore: true,
      nextOffset: 3,
      truncated: false,
      fileVersion: createHash('sha256').update('第一行\nsecond\n第三行').digest('hex'),
    });
    const final = await readRemoteFile(
      action('read', { path, cwd: directory, offset: 3, limit: 10 }),
      new AbortController().signal,
    );
    expect(final).toMatchObject({ content: '第三行', startLine: 3, endLine: 3, hasMore: false });
  });

  it('rejects invalid UTF-8 and oversized response line ranges without truncating', async () => {
    const directory = temporaryDirectory();
    const invalid = join(directory, 'invalid.txt');
    writeFileSync(invalid, Buffer.from([0xff, 0xfe, 0x00]));
    await expect(
      readRemoteFile(
        action('read', { path: invalid, cwd: directory }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.INVALID_MESSAGE });

    const large = join(directory, 'large.txt');
    writeFileSync(large, 'x'.repeat(256 * 1024 + 1));
    await expect(
      readRemoteFile(
        action('read', { path: large, cwd: directory, limit: 1 }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.FILE_TOO_LARGE });
  });

  it('edits only the expected version and exact occurrence count', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'edit.txt');
    writeFileSync(path, 'old middle old\n');
    const read = await readRemoteFile(
      action('read', { path, cwd: directory }),
      new AbortController().signal,
    );
    if (read.fileVersion === undefined) throw new Error('Read file version is missing.');
    const expectedFileVersion = read.fileVersion;
    const edited = await editRemoteFile(
      action('edit', {
        path,
        cwd: directory,
        oldText: 'old',
        newText: 'new',
        expectedOccurrences: 2,
        expectedFileVersion,
      }),
      new AbortController().signal,
    );
    expect(edited.replacements).toBe(2);
    if (edited.fileVersion === undefined) throw new Error('Edited file version is missing.');
    const editedFileVersion = edited.fileVersion;
    expect(readFileSync(path, 'utf8')).toBe('new middle new\n');
    expect(readdirSync(directory)).toEqual(['edit.txt']);

    await expect(
      editRemoteFile(
        action('edit', {
          path,
          cwd: directory,
          oldText: 'new',
          newText: 'other',
          expectedOccurrences: 1,
          expectedFileVersion,
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.FILE_VERSION_CONFLICT });
    expect(readFileSync(path, 'utf8')).toBe('new middle new\n');

    await expect(
      editRemoteFile(
        action('edit', {
          path,
          cwd: directory,
          oldText: 'new',
          newText: 'other',
          expectedOccurrences: 3,
          expectedFileVersion: editedFileVersion,
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.OPERATION_CONFLICT });
    expect(readFileSync(path, 'utf8')).toBe('new middle new\n');
  });

  it('resolves ordinary file symlinks while writing the real target', async () => {
    const directory = temporaryDirectory();
    const target = join(directory, 'target.txt');
    const link = join(directory, 'link.txt');
    writeFileSync(target, 'target');
    symlinkSync(target, link);
    const outcome = await readRemoteFile(
      action('read', { path: link, cwd: directory }),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ path: realpathSync(target), content: 'target' });
    await writeRemoteFile(
      action('write', { path: link, cwd: directory, content: 'updated', overwrite: true }),
      new AbortController().signal,
    );
    expect(readFileSync(target, 'utf8')).toBe('updated');
    expect(readFileSync(link, 'utf8')).toBe('updated');
  });

  it('writes binary attachments with parent directories and never overwrites conflicts', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, '.kairos', 'attachments', 'pixel.png');
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]);
    const created = await writeRemoteFile(
      action('write', {
        path,
        cwd: directory,
        content: '',
        binaryContent: bytes,
        overwrite: false,
        createParents: true,
      }),
      new AbortController().signal,
    );
    expect(created.bytesWritten).toBe(BigInt(bytes.length));
    expect(created.fileVersion).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(readFileSync(path)).toEqual(Buffer.from(bytes));
    await expect(
      writeRemoteFile(
        action('write', {
          path,
          cwd: directory,
          content: '',
          binaryContent: new Uint8Array([1, 2, 3]),
          overwrite: false,
          createParents: true,
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.OPERATION_CONFLICT });
    expect(readFileSync(path)).toEqual(Buffer.from(bytes));
  });

  it('honors an already cancelled signal before creating a file', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'cancelled.txt');
    const controller = new AbortController();
    controller.abort();
    await expect(
      writeRemoteFile(
        action('write', { path, cwd: directory, content: 'must-not-exist', overwrite: false }),
        controller.signal,
      ),
    ).rejects.toThrow('cancelled');
    expect(readdirSync(directory)).toEqual([]);
  });
});

describe('remote image reads', () => {
  it('reads bounded image bytes with their SHA-256 and honors cancellation', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'pixel.png');
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(path, bytes);
    const outcome = await readRemoteImage(
      action('readImage', { path, cwd: directory }),
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      path: realpathSync(path),
      data: bytes,
      fileVersion: createHash('sha256').update(bytes).digest('hex'),
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      readRemoteImage(action('readImage', { path, cwd: directory }), controller.signal),
    ).rejects.toThrow('cancelled');
  });

  it('rejects images above 700000 bytes before returning content', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'large.jpg');
    writeFileSync(path, new Uint8Array(700_001));
    await expect(
      readRemoteImage(action('readImage', { path, cwd: directory }), new AbortController().signal),
    ).rejects.toMatchObject({ code: DeviceErrorCode.FILE_TOO_LARGE });
  });
});
