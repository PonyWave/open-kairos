import { opendir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DirectoryListAction, DirectoryListOutcome } from '@kairos/contracts/device';
import { DeviceErrorCode } from '@kairos/contracts/device';
import { BashOperationFailure } from '../bash/manager.js';
import { FileOperationCancelled } from './files.js';

type Outcome = Omit<DirectoryListOutcome, '$typeName' | 'entries'> & {
  entries: Omit<DirectoryListOutcome['entries'][number], '$typeName'>[];
};

export async function listRemoteDirectories(
  action: DirectoryListAction,
  signal: AbortSignal,
): Promise<Outcome> {
  const check = () => {
    if (signal.aborted) throw new FileOperationCancelled();
  };
  check();
  if (
    !action.path.startsWith('/') ||
    action.path.includes('\0') ||
    action.path.length > 4096 ||
    action.limit < 1 ||
    action.limit > 200 ||
    action.offset > 10_000
  ) {
    throw new BashOperationFailure(
      DeviceErrorCode.PATH_INVALID,
      'Directory listing parameters are invalid.',
    );
  }
  try {
    const normalizedPath = await realpath(action.path);
    check();
    const names: string[] = [];
    let scanned = 0;
    for await (const entry of await opendir(normalizedPath)) {
      check();
      if (++scanned > 10_000)
        throw new BashOperationFailure(
          DeviceErrorCode.MESSAGE_TOO_LARGE,
          'Directory contains more than 10000 entries. Enter a more specific path.',
        );
      let directory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          directory = (await stat(join(normalizedPath, entry.name))).isDirectory();
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            continue;
          throw error;
        }
      }
      if (directory && entry.name.isWellFormed()) names.push(entry.name);
    }
    check();
    names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const entries: { name: string; path: string }[] = [];
    let bytes = Buffer.byteLength(normalizedPath);
    for (const name of names.slice(action.offset, action.offset + action.limit)) {
      const path = join(normalizedPath, name);
      const size = Buffer.byteLength(JSON.stringify({ name, path }));
      if (bytes + size > 128 * 1024) break;
      bytes += size;
      entries.push({ name, path });
    }
    const nextOffset = action.offset + entries.length;
    const hasMore = nextOffset < names.length;
    return { normalizedPath, entries, hasMore, ...(hasMore ? { nextOffset } : {}) };
  } catch (error) {
    if (error instanceof BashOperationFailure || error instanceof FileOperationCancelled)
      throw error;
    throw new BashOperationFailure(
      DeviceErrorCode.DIRECTORY_INVALID,
      'Directory is unavailable or cannot be listed.',
    );
  }
}
