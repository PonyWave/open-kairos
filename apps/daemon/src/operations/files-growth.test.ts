import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceErrorCode } from '@kairos/contracts/device';
import { expect, it, vi } from 'vitest';
import { readRemoteFile } from './files.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});

it('bounds bytes read when a file grows after its size inspection and closes the handle', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-file-growth-'));
  const path = join(directory, 'growing.txt');
  writeFileSync(path, 'initial\n');
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const handle: FileHandle = await original.open(path, 'r');
  const originalStat = handle.stat.bind(handle);
  vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
    const metadata = await originalStat();
    truncateSync(path, 64 * 1024 * 1024);
    return metadata;
  });
  const reads = vi.spyOn(handle, 'read');
  const unboundedRead = vi.spyOn(handle, 'readFile');
  const close = vi.spyOn(handle, 'close');
  vi.mocked(open).mockResolvedValueOnce(handle);
  try {
    await expect(
      readRemoteFile(
        { $typeName: 'kairos.device.v1.ReadAction', cwd: directory, path },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.FILE_TOO_LARGE });
    const results = await Promise.all(
      reads.mock.results.map((result) => {
        if (result.type !== 'return') throw result.value;
        return result.value;
      }),
    );
    expect(results.reduce((sum, result) => sum + result.bytesRead, 0)).toBe(16 * 1024 * 1024 + 1);
    expect(unboundedRead).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    vi.restoreAllMocks();
    await handle.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
