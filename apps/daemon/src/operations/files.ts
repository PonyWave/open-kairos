import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  DaemonMessageInit,
  EditAction,
  ReadAction,
  ReadImageAction,
  WriteAction,
} from '@kairos/contracts/device';
import { DEVICE_SYNC_LIMITS, DeviceErrorAction, DeviceErrorCode } from '@kairos/contracts/device';
import { BashOperationFailure } from '../bash/manager.js';

type OperationResult = Extract<DaemonMessageInit['payload'], { case: 'operationResult' }>['value'];
type ReadOutcome = Extract<OperationResult['outcome'], { case: 'read' }>['value'];
type ReadImageOutcome = Extract<OperationResult['outcome'], { case: 'readImage' }>['value'];
type WriteOutcome = Extract<OperationResult['outcome'], { case: 'write' }>['value'];
type EditOutcome = Extract<OperationResult['outcome'], { case: 'edit' }>['value'];

const maximumFileBytes = 16 * 1024 * 1024;
const maximumReadBytes = 256 * 1024;
const maximumImageBytes = 700_000;
const maximumWriteBytes = 512 * 1024;

export class FileOperationCancelled extends Error {
  constructor() {
    super('File operation was cancelled before its final write.');
    this.name = 'FileOperationCancelled';
  }
}

function failure(
  code: DeviceErrorCode,
  message: string,
  action: DeviceErrorAction = DeviceErrorAction.ABORT,
): BashOperationFailure {
  return new BashOperationFailure(code, message, action);
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new FileOperationCancelled();
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function validateText(value: string, field: string, maximumBytes: number, allowEmpty = true): void {
  if (
    (!allowEmpty && value.length === 0) ||
    value.includes('\0') ||
    !value.isWellFormed() ||
    Buffer.byteLength(value) > maximumBytes
  ) {
    throw failure(
      Buffer.byteLength(value) > maximumBytes
        ? DeviceErrorCode.FILE_TOO_LARGE
        : DeviceErrorCode.INVALID_MESSAGE,
      `${field} is not valid bounded UTF-8 text.`,
    );
  }
}

async function realDirectory(path: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) {
      throw failure(DeviceErrorCode.DIRECTORY_INVALID, 'Operation cwd is not a real directory.');
    }
    return canonical;
  } catch (error) {
    if (error instanceof BashOperationFailure) throw error;
    throw failure(DeviceErrorCode.DIRECTORY_INVALID, 'Operation cwd cannot be inspected.');
  }
}

async function existingFile(cwd: string, path: string): Promise<string> {
  validateText(path, 'path', 4096);
  validateText(cwd, 'cwd', 4096);
  if (!cwd.startsWith('/'))
    throw failure(DeviceErrorCode.PATH_INVALID, 'Operation cwd must be absolute.');
  const directory = await realDirectory(cwd);
  try {
    const canonical = await realpath(resolve(directory, path));
    if (!(await stat(canonical)).isFile()) {
      throw failure(DeviceErrorCode.PATH_INVALID, 'Operation target is not a regular file.');
    }
    return canonical;
  } catch (error) {
    if (error instanceof BashOperationFailure) throw error;
    throw failure(DeviceErrorCode.PATH_INVALID, 'Operation target cannot be inspected.');
  }
}

async function newFile(cwd: string, path: string, createParents = false): Promise<string> {
  validateText(path, 'path', 4096);
  validateText(cwd, 'cwd', 4096);
  if (!cwd.startsWith('/'))
    throw failure(DeviceErrorCode.PATH_INVALID, 'Operation cwd must be absolute.');
  const directory = await realDirectory(cwd);
  const candidate = resolve(directory, path);
  if (createParents) await mkdir(dirname(candidate), { recursive: true });
  try {
    const parent = await realpath(dirname(candidate));
    if (!(await stat(parent)).isDirectory()) throw new Error('Parent is not a directory.');
    return join(parent, basename(candidate));
  } catch {
    throw failure(DeviceErrorCode.PATH_INVALID, 'The destination parent directory is unavailable.');
  }
}

async function readBytes(path: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw failure(DeviceErrorCode.PATH_INVALID, 'Read target is not a regular file.');
    if (metadata.size > maximumFileBytes) {
      throw failure(DeviceErrorCode.FILE_TOO_LARGE, 'File exceeds the 16 MiB inspection limit.');
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maximumFileBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumFileBytes + 1 - totalBytes));
      const { bytesRead } = await handle.read({ buffer, offset: 0, length: buffer.length });
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maximumFileBytes) {
        throw failure(
          DeviceErrorCode.FILE_TOO_LARGE,
          'File grew beyond the 16 MiB inspection limit.',
        );
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, totalBytes);
  } catch (error) {
    if (error instanceof BashOperationFailure) throw error;
    throw failure(DeviceErrorCode.PATH_INVALID, 'File cannot be read.');
  } finally {
    await handle?.close();
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw failure(DeviceErrorCode.INVALID_MESSAGE, 'File is not valid UTF-8.');
  }
}

function fileVersion(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function readRemoteFile(
  action: ReadAction,
  signal: AbortSignal,
): Promise<ReadOutcome> {
  const offset = action.offset ?? 1;
  const limit = action.limit ?? 2000;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 2000
  ) {
    throw failure(DeviceErrorCode.INVALID_MESSAGE, 'Read line range is invalid.');
  }
  checkSignal(signal);
  const path = await existingFile(action.cwd, action.path);
  const bytes = await readBytes(path);
  checkSignal(signal);
  const version = fileVersion(bytes);
  const content = decodeUtf8(bytes);
  const lines = content.split('\n');
  const trailingNewline = lines.at(-1) === '';
  if (trailingNewline) lines.pop();
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const startLine = offset;
  const endLine = selected.length === 0 ? offset - 1 : offset + selected.length - 1;
  const hasMore = offset - 1 + selected.length < lines.length;
  let selectedContent = selected.join('\n');
  if (selected.length > 0 && (trailingNewline || endLine < lines.length)) selectedContent += '\n';
  if (Buffer.byteLength(selectedContent) > maximumReadBytes) {
    throw failure(
      DeviceErrorCode.FILE_TOO_LARGE,
      'The requested line range exceeds the 256 KiB response limit; request fewer lines.',
    );
  }
  return {
    path,
    content: selectedContent,
    startLine,
    endLine,
    hasMore,
    ...(hasMore ? { nextOffset: endLine + 1 } : {}),
    fileVersion: version,
    truncated: false,
  };
}

export async function readRemoteImage(
  action: ReadImageAction,
  signal: AbortSignal,
): Promise<ReadImageOutcome> {
  checkSignal(signal);
  const path = await existingFile(action.cwd, action.path);
  const bytes = await readBytes(path);
  if (bytes.byteLength > maximumImageBytes) {
    throw failure(DeviceErrorCode.FILE_TOO_LARGE, 'Image exceeds the 700000-byte read limit.');
  }
  checkSignal(signal);
  return { path, data: bytes, fileVersion: fileVersion(bytes) };
}

async function atomicWrite(
  target: string,
  bytes: Buffer,
  overwrite: boolean,
  signal: AbortSignal,
): Promise<void> {
  const directory = dirname(target);
  const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let reserved: { dev: number; ino: number } | undefined;
  let renamed = false;
  try {
    checkSignal(signal);
    if (!overwrite) {
      const reservation = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o666,
      );
      try {
        const metadata = await reservation.stat();
        reserved = { dev: metadata.dev, ino: metadata.ino };
      } finally {
        await reservation.close();
      }
    }
    const existingMode = overwrite ? (await stat(target)).mode & 0o777 : 0o666;
    temporaryHandle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      existingMode,
    );
    if (overwrite) await temporaryHandle.chmod(existingMode);
    await temporaryHandle.writeFile(bytes);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    checkSignal(signal);
    if (reserved !== undefined) {
      const current = await lstat(target);
      if (current.dev !== reserved.dev || current.ino !== reserved.ino) {
        throw failure(
          DeviceErrorCode.OPERATION_CONFLICT,
          'The destination changed during exclusive creation.',
        );
      }
    }
    await rename(temporary, target);
    renamed = true;
  } catch (error) {
    if (error instanceof BashOperationFailure || error instanceof FileOperationCancelled)
      throw error;
    if (hasErrorCode(error, 'EEXIST')) {
      throw failure(
        DeviceErrorCode.OPERATION_CONFLICT,
        'The destination already exists; set overwrite to replace it.',
      );
    }
    throw failure(DeviceErrorCode.PATH_INVALID, 'The destination cannot be written atomically.');
  } finally {
    await temporaryHandle?.close();
    await rm(temporary, { force: true });
    if (!renamed && reserved !== undefined) {
      try {
        const current = await lstat(target);
        if (current.dev === reserved.dev && current.ino === reserved.ino)
          await rm(target, { force: true });
      } catch {
        // The reservation may already have been replaced by another process.
      }
    }
  }
}

async function assertSyncTarget(target: string, overwrite: boolean): Promise<void> {
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw failure(DeviceErrorCode.OPERATION_CONFLICT, 'The sync target is not a regular file.');
    }
    if (!overwrite) {
      throw failure(DeviceErrorCode.OPERATION_CONFLICT, 'The sync target already exists.');
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return;
    throw error;
  }
}

async function hashStagedFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    let position = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(DEVICE_SYNC_LIMITS.chunkBytes);
      const { bytesRead } = await handle.read({
        buffer,
        offset: 0,
        length: buffer.length,
        position,
      });
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      if (position > DEVICE_SYNC_LIMITS.maxFileBytes) {
        throw failure(DeviceErrorCode.FILE_TOO_LARGE, 'The staged sync file exceeds 8 MiB.');
      }
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function commitSyncFile(
  target: string,
  temporary: string,
  overwrite: boolean,
  signal: AbortSignal,
): Promise<void> {
  let reserved: { dev: number; ino: number } | undefined;
  let renamed = false;
  try {
    await assertSyncTarget(target, overwrite);
    if (!overwrite) {
      const reservation = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        const metadata = await reservation.stat();
        reserved = { dev: metadata.dev, ino: metadata.ino };
      } finally {
        await reservation.close();
      }
    }
    checkSignal(signal);
    if (reserved !== undefined) {
      const current = await lstat(target);
      if (current.dev !== reserved.dev || current.ino !== reserved.ino) {
        throw failure(
          DeviceErrorCode.OPERATION_CONFLICT,
          'The sync target changed during creation.',
        );
      }
    }
    await rename(temporary, target);
    renamed = true;
  } finally {
    await rm(temporary, { force: true });
    if (!renamed && reserved !== undefined) {
      try {
        const current = await lstat(target);
        if (current.dev === reserved.dev && current.ino === reserved.ino) {
          await rm(target, { force: true });
        }
      } catch {
        // Another process may already have replaced the reservation.
      }
    }
  }
}

async function writeSyncChunk(action: WriteAction, signal: AbortSignal): Promise<WriteOutcome> {
  const transferId = action.transferId;
  const offset = action.offset;
  const totalSize = action.totalSize;
  const expectedSha256 = action.expectedSha256;
  const bytes = action.binaryContent === undefined ? undefined : Buffer.from(action.binaryContent);
  if (
    transferId === undefined ||
    offset === undefined ||
    totalSize === undefined ||
    expectedSha256 === undefined ||
    action.executable === undefined ||
    bytes === undefined ||
    !/^[a-f0-9]{64}$/.test(expectedSha256) ||
    totalSize > DEVICE_SYNC_LIMITS.maxFileBytes ||
    offset > totalSize ||
    bytes.length > DEVICE_SYNC_LIMITS.chunkBytes ||
    offset + BigInt(bytes.length) > totalSize
  ) {
    throw failure(DeviceErrorCode.INVALID_MESSAGE, 'Chunked write metadata is invalid.');
  }
  validateText(transferId, 'transferId', 200, false);
  validateText(action.content, 'content', 0);
  const target = await newFile(action.cwd, action.path, true);
  const suffix = createHash('sha256').update(transferId).digest('hex');
  const temporary = join(dirname(target), `.${basename(target)}.${suffix}.sync-tmp`);
  const complete = offset + BigInt(bytes.length) === totalSize;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let committed = false;
  try {
    checkSignal(signal);
    if (offset === 0n) {
      await assertSyncTarget(target, action.overwrite);
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
    } else {
      handle = await open(temporary, constants.O_WRONLY | constants.O_NOFOLLOW);
      const metadata = await handle.stat();
      if (!metadata.isFile() || BigInt(metadata.size) !== offset) {
        throw failure(
          DeviceErrorCode.OPERATION_CONFLICT,
          'The staged sync chunk offset does not match.',
        );
      }
    }
    let written = 0;
    while (written < bytes.length) {
      const result = await handle.write(
        bytes,
        written,
        bytes.length - written,
        Number(offset) + written,
      );
      written += result.bytesWritten;
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    checkSignal(signal);
    if (!complete) {
      committed = true;
      return {
        path: target,
        bytesWritten: BigInt(bytes.length),
        fileVersion: '',
        nextOffset: offset + BigInt(bytes.length),
        transferComplete: false,
      };
    }
    const metadata = await stat(temporary);
    const actualSha256 = await hashStagedFile(temporary);
    if (BigInt(metadata.size) !== totalSize || actualSha256 !== expectedSha256) {
      throw failure(
        DeviceErrorCode.OPERATION_CONFLICT,
        'The staged sync file does not match its source hash.',
      );
    }
    const temporaryHandle = await open(temporary, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      await temporaryHandle.chmod(action.executable ? 0o755 : 0o644);
    } finally {
      await temporaryHandle.close();
    }
    await commitSyncFile(target, temporary, action.overwrite, signal);
    committed = true;
    return {
      path: target,
      bytesWritten: BigInt(bytes.length),
      fileVersion: actualSha256,
      nextOffset: totalSize,
      transferComplete: true,
    };
  } finally {
    await handle?.close();
    if (!committed) await rm(temporary, { force: true });
  }
}

async function createSyncDirectory(
  action: WriteAction,
  signal: AbortSignal,
): Promise<WriteOutcome> {
  checkSignal(signal);
  const path = await newFile(action.cwd, action.path, true);
  await mkdir(path, { recursive: true });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw failure(DeviceErrorCode.OPERATION_CONFLICT, 'The sync directory target is invalid.');
  }
  return { path, bytesWritten: 0n, fileVersion: '', transferComplete: true };
}

export async function writeRemoteFile(
  action: WriteAction,
  signal: AbortSignal,
): Promise<WriteOutcome> {
  if (action.createDirectory === true) return createSyncDirectory(action, signal);
  if (action.transferId !== undefined) return writeSyncChunk(action, signal);
  const binary = action.binaryContent;
  if (binary !== undefined) {
    if (action.content.length > 0 || binary.length === 0) {
      throw failure(DeviceErrorCode.INVALID_MESSAGE, 'Binary write content is invalid.');
    }
    if (binary.length > maximumImageBytes) {
      throw failure(DeviceErrorCode.FILE_TOO_LARGE, 'Binary write exceeds the 700000-byte limit.');
    }
  } else {
    validateText(action.content, 'content', maximumWriteBytes);
  }
  const path = action.overwrite
    ? await existingFile(action.cwd, action.path)
    : await newFile(action.cwd, action.path, action.createParents);
  const bytes = binary === undefined ? Buffer.from(action.content, 'utf8') : Buffer.from(binary);
  checkSignal(signal);
  await atomicWrite(path, bytes, action.overwrite, signal);
  return { path, bytesWritten: BigInt(bytes.byteLength), fileVersion: fileVersion(bytes) };
}

function occurrences(content: string, oldText: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - oldText.length) {
    const found = content.indexOf(oldText, offset);
    if (found < 0) break;
    count += 1;
    offset = found + oldText.length;
  }
  return count;
}

export async function editRemoteFile(
  action: EditAction,
  signal: AbortSignal,
): Promise<EditOutcome> {
  validateText(action.oldText, 'oldText', maximumWriteBytes, false);
  validateText(action.newText, 'newText', maximumWriteBytes);
  if (!/^[a-f0-9]{64}$/.test(action.expectedFileVersion)) {
    throw failure(DeviceErrorCode.INVALID_MESSAGE, 'Expected file version must be a SHA-256 hash.');
  }
  const expectedOccurrences = action.expectedOccurrences ?? 1;
  if (
    !Number.isSafeInteger(expectedOccurrences) ||
    expectedOccurrences < 1 ||
    expectedOccurrences > 1000
  ) {
    throw failure(DeviceErrorCode.INVALID_MESSAGE, 'Expected occurrence count is invalid.');
  }
  checkSignal(signal);
  const path = await existingFile(action.cwd, action.path);
  const originalBytes = await readBytes(path);
  if (fileVersion(originalBytes) !== action.expectedFileVersion) {
    throw failure(
      DeviceErrorCode.FILE_VERSION_CONFLICT,
      'The file changed after it was read; read the current version before editing.',
    );
  }
  const original = decodeUtf8(originalBytes);
  const found = occurrences(original, action.oldText);
  if (found !== expectedOccurrences) {
    throw failure(
      DeviceErrorCode.OPERATION_CONFLICT,
      `Expected ${expectedOccurrences} replacements but found ${found}.`,
    );
  }
  const updated = original.split(action.oldText).join(action.newText);
  const bytes = Buffer.from(updated, 'utf8');
  if (bytes.byteLength > maximumFileBytes) {
    throw failure(DeviceErrorCode.FILE_TOO_LARGE, 'Edited file exceeds the 16 MiB limit.');
  }
  checkSignal(signal);
  await atomicWrite(path, bytes, true, signal);
  return {
    path,
    replacements: found,
    bytesWritten: BigInt(bytes.byteLength),
    fileVersion: fileVersion(bytes),
  };
}
