import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import type { SyncReadAction, SyncScanAction } from '@kairos/contracts/device';
import {
  DEVICE_SYNC_LIMITS,
  DeviceErrorAction,
  DeviceErrorCode,
  SyncEntryKind,
} from '@kairos/contracts/device';
import { BashOperationFailure } from '../bash/manager.js';
import { FileOperationCancelled } from './files.js';

const maximumDepth = 64;

type SyncScanOutcome = {
  path: string;
  kind: SyncEntryKind;
  size: bigint;
  sha256: string;
  executable: boolean;
  entries: Array<{
    relativePath: string;
    kind: SyncEntryKind;
    size: bigint;
    sha256: string;
    executable: boolean;
  }>;
  conflictScan: boolean;
  reason?: string;
};

type SyncReadOutcome = {
  path: string;
  offset: bigint;
  data: Buffer;
  size: bigint;
  executable: boolean;
  reason?: string;
};

function failure(code: DeviceErrorCode, message: string): BashOperationFailure {
  return new BashOperationFailure(code, message, DeviceErrorAction.ABORT);
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new FileOperationCancelled();
}

function validatePath(value: string, field: string): void {
  if (
    !value.isWellFormed() ||
    value.includes('\0') ||
    value.length > 4096 ||
    !value.startsWith('/') ||
    posix.normalize(value) !== value ||
    (value.length > 1 && value.endsWith('/'))
  ) {
    throw failure(DeviceErrorCode.PATH_INVALID, `${field} must be a normalized absolute path.`);
  }
}

async function syncPath(cwd: string, path: string): Promise<string> {
  validatePath(cwd, 'Operation cwd');
  validatePath(path, 'Sync path');
  const directory = await realpath(cwd);
  if (!(await stat(directory)).isDirectory()) {
    throw failure(DeviceErrorCode.DIRECTORY_INVALID, 'Operation cwd is not a real directory.');
  }
  return resolve(directory, path);
}

function entryKind(metadata: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): SyncEntryKind {
  if (metadata.isSymbolicLink()) return SyncEntryKind.SYMLINK;
  if (metadata.isFile()) return SyncEntryKind.FILE;
  if (metadata.isDirectory()) return SyncEntryKind.DIRECTORY;
  return SyncEntryKind.SPECIAL;
}

async function hashFile(path: string, expectedSize: number, signal: AbortSignal): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    let total = 0;
    while (true) {
      checkSignal(signal);
      const buffer = Buffer.allocUnsafe(
        Math.min(DEVICE_SYNC_LIMITS.chunkBytes, DEVICE_SYNC_LIMITS.maxFileBytes + 1 - total),
      );
      const { bytesRead } = await handle.read({ buffer, offset: 0, length: buffer.length });
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > DEVICE_SYNC_LIMITS.maxFileBytes) {
        throw failure(DeviceErrorCode.FILE_TOO_LARGE, 'A synced file exceeds the 8 MiB limit.');
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (total !== expectedSize) {
      throw failure(
        DeviceErrorCode.OPERATION_CONFLICT,
        'A file changed while it was being scanned.',
      );
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function fileMetadata(path: string, signal: AbortSignal, conflictScan = false) {
  const metadata = await lstat(path);
  const size = BigInt(metadata.size);
  const executable = (metadata.mode & 0o111) !== 0;
  if (metadata.size > DEVICE_SYNC_LIMITS.maxFileBytes) {
    if (conflictScan) return { size, sha256: '', executable };
    throw failure(DeviceErrorCode.FILE_TOO_LARGE, 'A synced file exceeds the 8 MiB limit.');
  }
  return {
    size,
    sha256: await hashFile(path, metadata.size, signal),
    executable,
  };
}

export async function scanSyncPath(
  action: SyncScanAction,
  signal: AbortSignal,
): Promise<SyncScanOutcome> {
  checkSignal(signal);
  const conflictScan = action.conflictScan === true;
  if (
    action.relativePaths.length > DEVICE_SYNC_LIMITS.maxEntries ||
    (!conflictScan && action.relativePaths.length > 0)
  ) {
    throw failure(DeviceErrorCode.INVALID_MESSAGE, 'The sync conflict scan paths are invalid.');
  }
  for (const relativePath of action.relativePaths) {
    if (
      relativePath !== '.' &&
      (!relativePath ||
        relativePath.startsWith('/') ||
        relativePath.length > 4096 ||
        relativePath.includes('\0') ||
        relativePath.split('/').some((part) => !part || part === '.' || part === '..'))
    ) {
      throw failure(DeviceErrorCode.INVALID_MESSAGE, 'A sync conflict relative path is invalid.');
    }
  }
  const path = await syncPath(action.cwd, action.path);
  const base = { path, size: 0n, sha256: '', executable: false, conflictScan };
  let root: Awaited<ReturnType<typeof lstat>>;
  try {
    root = await lstat(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { ...base, kind: SyncEntryKind.MISSING, entries: [] };
    }
    throw failure(DeviceErrorCode.PATH_INVALID, 'The sync path cannot be inspected.');
  }
  const kind = entryKind(root);
  if (kind !== SyncEntryKind.DIRECTORY) {
    const metadata =
      kind === SyncEntryKind.FILE
        ? await fileMetadata(path, signal, conflictScan)
        : { size: 0n, sha256: '', executable: false };
    return { ...base, kind, ...metadata, entries: [] };
  }

  const entries: SyncScanOutcome['entries'] = [];
  if (conflictScan) {
    const blockedAncestors = new Set<string>();
    const hasBlockedAncestor = (relativePath: string) =>
      [...blockedAncestors].some((ancestor) => relativePath.startsWith(`${ancestor}/`));
    const orderedPaths = [...action.relativePaths].sort((left, right) => left.localeCompare(right));
    for (const relativePath of orderedPaths) {
      if (relativePath === '.' || hasBlockedAncestor(relativePath)) continue;
      checkSignal(signal);
      const absolute = resolve(path, relativePath);
      validatePath(absolute, 'Sync conflict entry path');
      let metadata: Awaited<ReturnType<typeof lstat>>;
      try {
        metadata = await lstat(absolute);
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP') {
            continue;
          }
        }
        throw error;
      }
      const kind = entryKind(metadata);
      if (kind !== SyncEntryKind.DIRECTORY) blockedAncestors.add(relativePath);
      const file =
        kind === SyncEntryKind.FILE
          ? await fileMetadata(absolute, signal, true)
          : { size: 0n, sha256: '', executable: false };
      entries.push({ relativePath, kind, ...file });
    }
    entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const responseBytes = Buffer.byteLength(
      JSON.stringify(entries, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );
    if (responseBytes > DEVICE_SYNC_LIMITS.responseBytes) {
      throw failure(DeviceErrorCode.MESSAGE_TOO_LARGE, 'The sync scan response exceeds 1 MiB.');
    }
    return { ...base, kind, entries };
  }

  let files = 0;
  let totalBytes = 0n;
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > maximumDepth) {
      throw failure(
        DeviceErrorCode.PATH_INVALID,
        'The source directory exceeds the 64-level limit.',
      );
    }
    const handle = await opendir(directory);
    for await (const entry of handle) {
      checkSignal(signal);
      const absolute = resolve(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      validatePath(absolute, 'Sync entry path');
      if (entries.length >= DEVICE_SYNC_LIMITS.maxEntries) {
        throw failure(
          DeviceErrorCode.MESSAGE_TOO_LARGE,
          'The directory exceeds the 512-entry limit.',
        );
      }
      const metadata = await lstat(absolute);
      const kind = entryKind(metadata);
      if (kind === SyncEntryKind.DIRECTORY) {
        entries.push({ relativePath, kind, size: 0n, sha256: '', executable: false });
        await walk(absolute, relativePath, depth + 1);
        continue;
      }
      if (kind === SyncEntryKind.FILE) {
        const file = await fileMetadata(absolute, signal);
        files += 1;
        totalBytes += file.size;
        if (files > DEVICE_SYNC_LIMITS.maxFiles) {
          throw failure(
            DeviceErrorCode.MESSAGE_TOO_LARGE,
            'The directory exceeds the 256-file limit.',
          );
        }
        if (totalBytes > BigInt(DEVICE_SYNC_LIMITS.maxTotalBytes)) {
          throw failure(
            DeviceErrorCode.MESSAGE_TOO_LARGE,
            'The directory exceeds the 64 MiB limit.',
          );
        }
        entries.push({ relativePath, kind, ...file });
        continue;
      }
      entries.push({ relativePath, kind, size: 0n, sha256: '', executable: false });
    }
  };
  await walk(path, '', 0);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const responseBytes = Buffer.byteLength(
    JSON.stringify(entries, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );
  if (responseBytes > DEVICE_SYNC_LIMITS.responseBytes) {
    throw failure(DeviceErrorCode.MESSAGE_TOO_LARGE, 'The sync scan response exceeds 1 MiB.');
  }
  return { ...base, kind, entries };
}

export async function readSyncChunk(
  action: SyncReadAction,
  signal: AbortSignal,
): Promise<SyncReadOutcome> {
  checkSignal(signal);
  if (
    !Number.isSafeInteger(action.limit) ||
    action.limit < 1 ||
    action.limit > DEVICE_SYNC_LIMITS.chunkBytes ||
    action.offset < 0n
  ) {
    throw failure(DeviceErrorCode.INVALID_MESSAGE, 'The sync read range is invalid.');
  }
  const path = await syncPath(action.cwd, action.path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw failure(DeviceErrorCode.PATH_INVALID, 'The sync source is not a regular file.');
    }
    if (metadata.size > DEVICE_SYNC_LIMITS.maxFileBytes || action.offset > BigInt(metadata.size)) {
      throw failure(DeviceErrorCode.FILE_TOO_LARGE, 'The sync source size or offset is invalid.');
    }
    const length = Math.min(action.limit, Number(BigInt(metadata.size) - action.offset));
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read({
      buffer,
      offset: 0,
      length,
      position: Number(action.offset),
    });
    checkSignal(signal);
    return {
      path,
      offset: action.offset,
      data: buffer.subarray(0, bytesRead),
      size: BigInt(metadata.size),
      executable: (metadata.mode & 0o111) !== 0,
    };
  } finally {
    await handle.close();
  }
}
