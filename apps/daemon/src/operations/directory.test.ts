import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceCapability } from '@kairos/contracts/device';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDirectory } from './directory.js';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-directory-check-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('directory check', () => {
  it('checks real permissions and loads bounded workspace resources', async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, '.kairos'), { recursive: true });
    await writeFile(join(directory, '.kairos', 'AGENTS.md'), '# Project instructions\n');
    await mkdir(join(directory, '.agents', 'skills', 'review'), { recursive: true });
    await writeFile(join(directory, '.agents', 'skills', 'review', 'SKILL.md'), '# Review\n');

    const report = await checkDirectory(
      directory,
      true,
      [DeviceCapability.DIRECTORY_CHECK],
      directory,
    );
    expect(report).toMatchObject({
      exists: true,
      directory: true,
      readable: true,
      writable: true,
      executable: true,
      ready: true,
      capabilities: [DeviceCapability.DIRECTORY_CHECK],
    });
    expect(report.normalizedPath).toBe(
      await (await import('node:fs/promises')).realpath(directory),
    );
    expect(report.resources.map((resource) => resource.path)).toEqual([
      '.agents/skills/review/SKILL.md',
      'AGENTS.md',
    ]);
    expect(report.resources[1]?.sha256).toBe(
      createHash('sha256').update('# Project instructions\n').digest('hex'),
    );
  });

  it('reports missing directories without creating or changing files', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'missing');
    const before = await readdir(directory);
    const report = await checkDirectory(target, false, [DeviceCapability.DIRECTORY_CHECK]);
    expect(report).toMatchObject({ exists: false, directory: false, ready: false });
    expect(await readdir(directory)).toEqual(before);
  });

  it('rejects relative paths and reports non-directory paths', async () => {
    const directory = await temporaryDirectory();
    await expect(checkDirectory('relative', false, [])).rejects.toThrow('absolute');
    await writeFile(join(directory, 'file'), 'content');
    const report = await checkDirectory(join(directory, 'file'), false, []);
    expect(report).toMatchObject({ exists: true, directory: false, ready: false });
  });

  it('rejects workspace resources that resolve outside the real directory', async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(join(outside, 'AGENTS.md'), '# Outside\n');
    await mkdir(join(directory, '.kairos'), { recursive: true });
    await symlink(join(outside, 'AGENTS.md'), join(directory, '.kairos', 'AGENTS.md'));

    const report = await checkDirectory(
      directory,
      true,
      [DeviceCapability.DIRECTORY_CHECK],
      directory,
    );
    expect(report.ready).toBe(false);
    expect(report.resources).toEqual([]);
    expect(report.reason).toContain('workspace resource');
  });
});
