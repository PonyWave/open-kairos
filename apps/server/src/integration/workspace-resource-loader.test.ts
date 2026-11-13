import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareWorkspaceResourceSnapshots,
  WORKSPACE_RESOURCE_LIMITS,
} from '../workspace/index.js';
import { WorkspaceResourceLoader } from './workspace-resource-loader.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('WorkspaceResourceLoader', () => {
  it('returns an empty snapshot when AGENTS.md and Skill directories are absent', async () => {
    const root = await createWorkspace();
    const loader = new WorkspaceResourceLoader(root);
    const empty = await loader.load();

    expect(empty.resources).toEqual([]);
    expect(empty.systemInstructions).toBe('');
    expect(empty.snapshotId).toMatch(/^[0-9a-f]{64}$/);

    await mkdir(join(root, '.agents'));
    expect((await loader.load()).snapshotId).toBe(empty.snapshotId);
    await mkdir(join(root, '.agents', 'skills'));
    expect((await loader.load()).snapshotId).toBe(empty.snapshotId);
  });

  it('loads complete resources and renders a Skill catalog with the full AGENTS.md', async () => {
    const root = await createWorkspace();
    await writeResource(root, '.agents/skills/zeta/SKILL.md', 'zeta instructions');
    await writeResource(root, '.kairos/AGENTS.md', 'root instructions\n');
    await writeResource(root, 'AGENTS.md', 'workspace root AGENTS.md must not be read');
    await writeResource(
      root,
      '.agents/skills/alpha/SKILL.md',
      '---\ndescription: alpha catalog summary\n---\nalpha instructions',
    );
    await writeResource(root, '.agents/skills/alpha/script.mjs', 'throw new Error("not executed")');
    await writeResource(root, '.agents/skills/stray', 'ordinary files are ignored');
    await writeResource(root, '.env', 'KAIROS_MARKER=env must not be read');
    await writeResource(root, 'reference/AGENTS.md', 'reference must not be read');
    await writeResource(root, 'node_modules/AGENTS.md', 'dependencies must not be read');

    const snapshot = await new WorkspaceResourceLoader(root).load();

    expect(snapshot.resources.map((resource) => resource.path)).toEqual([
      '.agents/skills/alpha/SKILL.md',
      '.agents/skills/zeta/SKILL.md',
      'AGENTS.md',
    ]);
    expect(snapshot.systemInstructions).toBe(
      '<workspace-skills>\n' +
        '- alpha: alpha catalog summary\n' +
        '- zeta: zeta instructions\n' +
        '</workspace-skills>\n\n' +
        '<workspace-resource path="AGENTS.md">\n' +
        'root instructions\n</workspace-resource>',
    );
    expect(snapshot.systemInstructions).not.toContain('alpha instructions');
    expect(snapshot.systemInstructions).not.toContain('not executed');
    expect(snapshot.systemInstructions).not.toContain('must not be read');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.resources)).toBe(true);
    expect(snapshot.resources.every((resource) => Object.isFrozen(resource))).toBe(true);
  });

  it.each([
    {
      label: 'a name that differs from the directory',
      content: '---\nname: other\ndescription: summary\n---\nbody',
      error: /does not match its directory/,
    },
    {
      label: 'frontmatter that is not valid YAML',
      content: '---\nname: [unclosed\n---\nbody',
      error: /not valid YAML/,
    },
    {
      label: 'a non-string description',
      content: '---\ndescription: 42\n---\nbody',
      error: /frontmatter is invalid/,
    },
  ])('rejects a Skill with $label', async ({ content, error }) => {
    const root = await createWorkspace();
    await writeResource(root, '.agents/skills/alpha/SKILL.md', content);
    await expect(new WorkspaceResourceLoader(root).load()).rejects.toThrow(error);
  });

  it('hashes paths and content and compares added, updated and removed resources', async () => {
    const root = await createWorkspace();
    await writeResource(root, '.kairos/AGENTS.md', 'unchanged');
    await writeResource(root, '.agents/skills/alpha/SKILL.md', 'old alpha');
    await writeResource(root, '.agents/skills/remove_me/SKILL.md', 'removed');
    const loader = new WorkspaceResourceLoader(root);
    const previous = await loader.load();

    await writeResource(root, '.agents/skills/alpha/SKILL.md', 'new alpha');
    await writeResource(root, '.agents/skills/added/SKILL.md', 'added');
    await rm(join(root, '.agents/skills/remove_me'), { recursive: true });
    const next = await loader.load();

    expect(next.snapshotId).not.toBe(previous.snapshotId);
    expect(compareWorkspaceResourceSnapshots(previous, next)).toEqual({
      added: ['.agents/skills/added/SKILL.md'],
      updated: ['.agents/skills/alpha/SKILL.md'],
      removed: ['.agents/skills/remove_me/SKILL.md'],
    });

    const unchanged = await loader.load();
    expect(unchanged.snapshotId).toBe(next.snapshotId);
    expect(compareWorkspaceResourceSnapshots(next, unchanged)).toEqual({
      added: [],
      updated: [],
      removed: [],
    });
    const diff = compareWorkspaceResourceSnapshots(previous, next);
    expect(Object.isFrozen(diff)).toBe(true);
    expect(Object.isFrozen(diff.added)).toBe(true);
  });

  it('rejects a failed candidate without modifying an accepted snapshot', async () => {
    const root = await createWorkspace();
    await writeResource(root, '.kairos/AGENTS.md', 'accepted root');
    await writeResource(root, '.agents/skills/alpha/SKILL.md', 'accepted Skill');
    const loader = new WorkspaceResourceLoader(root);
    const accepted = await loader.load();

    await writeResource(root, '.kairos/AGENTS.md', 'candidate root');
    await writeResource(root, '.agents/skills/alpha/SKILL.md', '   \n');
    await expect(loader.load()).rejects.toThrow(/blank/);

    expect(accepted.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(accepted.resources).toEqual([
      { path: '.agents/skills/alpha/SKILL.md', content: 'accepted Skill' },
      { path: 'AGENTS.md', content: 'accepted root' },
    ]);
    expect(accepted.systemInstructions).not.toContain('candidate root');
  });

  it('accepts the exact per-file and total byte limits', async () => {
    const fileRoot = await createWorkspace();
    await writeResource(
      fileRoot,
      '.kairos/AGENTS.md',
      'a'.repeat(WORKSPACE_RESOURCE_LIMITS.maxFileBytes),
    );
    await expect(new WorkspaceResourceLoader(fileRoot).load()).resolves.toMatchObject({
      resources: [{ path: 'AGENTS.md' }],
    });

    const totalRoot = await createWorkspace();
    await writeResource(totalRoot, '.kairos/AGENTS.md', 'a'.repeat(64 * 1024));
    for (const name of ['one', 'two', 'three']) {
      await writeResource(totalRoot, `.agents/skills/${name}/SKILL.md`, 'a'.repeat(64 * 1024));
    }
    const snapshot = await new WorkspaceResourceLoader(totalRoot).load();
    expect(
      snapshot.resources.reduce(
        (total, resource) => total + Buffer.byteLength(resource.content),
        0,
      ),
    ).toBe(WORKSPACE_RESOURCE_LIMITS.maxTotalBytes);
  });

  it('rejects files above 64 KiB and resources above 256 KiB in total', async () => {
    const fileRoot = await createWorkspace();
    await writeResource(
      fileRoot,
      '.kairos/AGENTS.md',
      'a'.repeat(WORKSPACE_RESOURCE_LIMITS.maxFileBytes + 1),
    );
    await expect(new WorkspaceResourceLoader(fileRoot).load()).rejects.toThrow(/file limit/);

    const totalRoot = await createWorkspace();
    for (const name of ['one', 'two', 'three', 'four', 'five']) {
      await writeResource(totalRoot, `.agents/skills/${name}/SKILL.md`, 'a'.repeat(52 * 1024));
    }
    await expect(new WorkspaceResourceLoader(totalRoot).load()).rejects.toThrow(/total limit/);
  });

  it('accepts 32 Skills and rejects 33 Skills', async () => {
    const root = await createWorkspace();
    for (let index = 0; index < 32; index += 1) {
      await writeResource(root, `.agents/skills/skill-${index}/SKILL.md`, 'x');
    }
    const loader = new WorkspaceResourceLoader(root);
    await expect(loader.load()).resolves.toMatchObject({ resources: { length: 32 } });

    await writeResource(root, '.agents/skills/skill-32/SKILL.md', 'x');
    await expect(loader.load()).rejects.toThrow(/32-Skill limit/);
  });

  it.each([
    { label: 'invalid UTF-8', content: Buffer.from([0xf0, 0x9f, 0x92]), error: /UTF-8/ },
    { label: 'a NUL character', content: Buffer.from('before\0after'), error: /NUL/ },
    { label: 'whitespace only', content: ' \t\r\n', error: /blank/ },
  ])('rejects AGENTS.md containing $label', async ({ content, error }) => {
    const root = await createWorkspace();
    await writeResource(root, '.kairos/AGENTS.md', content);
    await expect(new WorkspaceResourceLoader(root).load()).rejects.toThrow(error);
  });

  it('rejects a non-file AGENTS.md and symbolic links to external resources', async () => {
    const directoryRoot = await createWorkspace();
    await mkdir(join(directoryRoot, '.kairos', 'AGENTS.md'), { recursive: true });
    await expect(new WorkspaceResourceLoader(directoryRoot).load()).rejects.toThrow(/regular file/);

    const externalRoot = await createWorkspace();
    await writeResource(externalRoot, 'outside.md', 'external secret');
    const linkRoot = await createWorkspace();
    await mkdir(join(linkRoot, '.kairos'), { recursive: true });
    await symlink(join(externalRoot, 'outside.md'), join(linkRoot, '.kairos', 'AGENTS.md'));
    await expect(new WorkspaceResourceLoader(linkRoot).load()).rejects.toThrow(/Unable to open/);
  });

  it('rejects a symbolic-link Skill directory instead of reading its target', async () => {
    const externalRoot = await createWorkspace();
    await writeResource(externalRoot, 'SKILL.md', 'external Skill');
    const root = await createWorkspace();
    await mkdir(join(root, '.agents', 'skills'), { recursive: true });
    await symlink(externalRoot, join(root, '.agents', 'skills', 'linked'), 'dir');

    await expect(new WorkspaceResourceLoader(root).load()).rejects.toThrow(/real directory/);
  });

  it.each(['bad name', '.hidden', 'name.with.dot', 'a'.repeat(65)])(
    'rejects an invalid Skill directory name: %s',
    async (name) => {
      const root = await createWorkspace();
      await writeResource(root, `.agents/skills/${name}/SKILL.md`, 'content');
      await expect(new WorkspaceResourceLoader(root).load()).rejects.toThrow(
        /Invalid Skill directory name/,
      );
    },
  );

  it('rejects a Skill directory without SKILL.md', async () => {
    const root = await createWorkspace();
    await mkdir(join(root, '.agents', 'skills', 'alpha'), { recursive: true });
    await expect(new WorkspaceResourceLoader(root).load()).rejects.toThrow(
      /Missing workspace resource/,
    );
  });

  it('requires an existing real directory and an explicitly absolute workspace path', async () => {
    const root = await createWorkspace();
    const missing = join(root, 'missing');
    await expect(new WorkspaceResourceLoader(missing).load()).rejects.toThrow(/Unable to inspect/);
    expect(() => new WorkspaceResourceLoader('relative/workspace')).toThrow(/absolute path/);

    const alias = join(root, 'alias');
    await symlink(root, alias, 'dir');
    await expect(new WorkspaceResourceLoader(alias).load()).rejects.toThrow(/real directory/);
  });
});

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-workspace-resources-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeResource(
  root: string,
  resourcePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const absolutePath = join(root, resourcePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}
