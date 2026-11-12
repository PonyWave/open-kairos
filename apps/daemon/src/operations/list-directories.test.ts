import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from '@kairos/contracts';
import { DeviceErrorCode, DirectoryListActionSchema } from '@kairos/contracts/device';
import { afterEach, describe, expect, it } from 'vitest';
import { listRemoteDirectories } from './list-directories.js';

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'kairos-directory-list-'));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('remote directory listing', () => {
  it('lists real child directories in stable pages and follows usable directory links', async () => {
    const path = await root();
    await mkdir(join(path, 'alpha'));
    await mkdir(join(path, 'beta'));
    await writeFile(join(path, 'file.txt'), 'file');
    await symlink(join(path, 'alpha'), join(path, 'linked'));
    await symlink(join(path, 'missing'), join(path, 'broken'));
    const first = await listRemoteDirectories(
      create(DirectoryListActionSchema, { path, offset: 0, limit: 2 }),
      new AbortController().signal,
    );
    expect(first.normalizedPath).toBe(await realpath(path));
    expect(first.entries.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
    expect(first).toMatchObject({ hasMore: true, nextOffset: 2 });
    const next = await listRemoteDirectories(
      create(DirectoryListActionSchema, { path, offset: 2, limit: 2 }),
      new AbortController().signal,
    );
    expect(next.entries.map((entry) => entry.name)).toEqual(['linked']);
    expect(next.hasMore).toBe(false);
    expect(next.nextOffset).toBeUndefined();
  });

  it('reports inaccessible targets and rejects unbounded or relative requests', async () => {
    const path = await root();
    await writeFile(join(path, 'file'), 'file');
    await expect(
      listRemoteDirectories(
        create(DirectoryListActionSchema, { path: join(path, 'file'), limit: 20 }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.DIRECTORY_INVALID });
    await expect(
      listRemoteDirectories(
        create(DirectoryListActionSchema, { path, limit: 201 }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.PATH_INVALID });
    await expect(
      listRemoteDirectories(
        create(DirectoryListActionSchema, { path: 'relative', limit: 20 }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: DeviceErrorCode.PATH_INVALID });
  });

  it('does not read the filesystem for an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      listRemoteDirectories(
        create(DirectoryListActionSchema, { path: '/missing', limit: 20 }),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'FileOperationCancelled' });
  });
});
