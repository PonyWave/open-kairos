import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { arch, homedir, platform } from 'node:os';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import type { DeviceCapability } from '@kairos/contracts/device';

const maximumResourceBytes = 64 * 1024;
const maximumResourcesBytes = 256 * 1024;
const maximumSkills = 32;
const skillName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface DirectoryResource {
  path: string;
  content: string;
  sha256: string;
}

export interface DirectoryCheckReport {
  normalizedPath: string;
  exists: boolean;
  directory: boolean;
  readable: boolean;
  writable: boolean;
  executable: boolean;
  os: string;
  architecture: string;
  capabilities: DeviceCapability[];
  resources: DirectoryResource[];
  ready: boolean;
  reason?: string;
}

export async function checkDirectory(
  path: string,
  loadWorkspace: boolean,
  capabilities: DeviceCapability[],
  resourceHome: string = homedir(),
): Promise<DirectoryCheckReport> {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error('Directory check requires an absolute path without NUL characters.');
  }
  const report: DirectoryCheckReport = {
    normalizedPath: normalize(path),
    exists: false,
    directory: false,
    readable: false,
    writable: false,
    executable: false,
    os: platform(),
    architecture: architectureName(),
    capabilities: [...capabilities],
    resources: [],
    ready: false,
  };
  try {
    report.normalizedPath = await realpath(path);
    report.exists = true;
    report.directory = (await stat(report.normalizedPath)).isDirectory();
    if (!report.directory) {
      report.reason = 'The working path is not a directory.';
      return report;
    }
    report.readable = await permits(report.normalizedPath, constants.R_OK);
    report.writable = await permits(report.normalizedPath, constants.W_OK);
    report.executable = await permits(report.normalizedPath, constants.X_OK);
    if (!report.readable || !report.writable || !report.executable) {
      report.reason = 'The working directory lacks read, write, or traverse permission.';
      return report;
    }
    if (loadWorkspace) report.resources = await readUserResources(resourceHome);
    report.ready = true;
    return report;
  } catch (error) {
    report.reason =
      error instanceof Error && !hasErrorCode(error, 'ENOENT')
        ? error.message
        : 'The working directory does not exist or cannot be inspected.';
    return report;
  }
}

async function permits(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

function architectureName(): string {
  const value = arch();
  if (value === 'x64') return 'x86_64';
  if (value === 'arm64') return 'aarch64';
  return value;
}

// Resource snapshot sources are fixed user-level locations: AGENTS.md comes from
// <home>/.kairos/AGENTS.md and Skills from <home>/.agents/skills, independent of
// the directory being checked. Reported resource paths stay workspace-relative
// logical identifiers.
async function readUserResources(resourceHome: string): Promise<DirectoryResource[]> {
  let home: string;
  try {
    home = await realpath(resourceHome);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return [];
    throw error;
  }
  const resources: DirectoryResource[] = [];
  const agents = await readResource(home, '.kairos/AGENTS.md', 'AGENTS.md');
  if (agents !== undefined) resources.push(agents);
  const skills = await skillsDirectory(home);
  if (skills !== undefined) {
    const entries = (await readdir(skills, { withFileTypes: true })).filter(
      (entry) => !entry.isFile(),
    );
    if (entries.length > maximumSkills)
      throw new Error('Workspace has too many Skill directories.');
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!skillName.test(entry.name))
        throw new Error('Workspace Skill directory name is invalid.');
      const relativePath = `.agents/skills/${entry.name}`;
      const directory = containedPath(home, relativePath);
      await requireRealDirectory(directory, 'Workspace Skill directory');
      await requireContained(home, directory);
      const resource = await readResource(
        home,
        `${relativePath}/SKILL.md`,
        `${relativePath}/SKILL.md`,
      );
      if (resource === undefined) throw new Error('Workspace Skill is missing SKILL.md.');
      resources.push(resource);
    }
  }
  resources.sort((left, right) => left.path.localeCompare(right.path));
  let totalBytes = 0;
  for (const resource of resources) {
    totalBytes += Buffer.byteLength(resource.content);
    if (totalBytes > maximumResourcesBytes) {
      throw new Error('Workspace resources exceed the total byte limit.');
    }
  }
  return resources;
}

async function skillsDirectory(home: string): Promise<string | undefined> {
  const agents = containedPath(home, '.agents');
  if (!(await realDirectoryIfPresent(agents))) return undefined;
  await requireContained(home, agents);
  const skills = containedPath(home, '.agents/skills');
  if (!(await realDirectoryIfPresent(skills))) return undefined;
  await requireContained(home, skills);
  return skills;
}

async function realDirectoryIfPresent(path: string): Promise<boolean> {
  try {
    await requireRealDirectory(path, 'Workspace resource directory');
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function requireRealDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

async function readResource(
  home: string,
  relativePath: string,
  logicalPath: string,
): Promise<DirectoryResource | undefined> {
  const absolute = containedPath(home, relativePath);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw new Error(`Unable to open workspace resource: ${logicalPath}.`, { cause: error });
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new Error(`Workspace resource is not a regular file: ${logicalPath}.`);
    await requireContained(home, absolute);
    if (metadata.size > maximumResourceBytes) {
      throw new Error(`Workspace resource exceeds the byte limit: ${logicalPath}.`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maximumResourceBytes) {
      throw new Error(`Workspace resource exceeds the byte limit: ${logicalPath}.`);
    }
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (content.includes('\0') || content.trim().length === 0) {
      throw new Error(`Workspace resource is blank or contains NUL: ${logicalPath}.`);
    }
    return { path: logicalPath, content, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await handle.close();
  }
}

function containedPath(home: string, path: string): string {
  const absolute = resolve(home, path);
  const relation = relative(home, absolute);
  if (
    relation.length === 0 ||
    relation === '..' ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new Error('Workspace resource path escapes the resource home.');
  }
  return absolute;
}

async function requireContained(home: string, path: string): Promise<void> {
  const canonical = await realpath(path);
  const relation = relative(home, canonical);
  if (
    relation.length === 0 ||
    relation === '..' ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new Error('Workspace resource resolves outside the resource home.');
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
