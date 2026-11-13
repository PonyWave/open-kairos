import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  createWorkspaceResourceSnapshot,
  SKILL_NAME_PATTERN,
  WORKSPACE_RESOURCE_LIMITS,
  type WorkspaceResource,
  type WorkspaceResourceSnapshot,
} from '../workspace/index.js';

export class WorkspaceResourceLoader {
  readonly resourceHomeDirectory: string;

  constructor(resourceHomeDirectory: string) {
    if (!isAbsolute(resourceHomeDirectory) || resourceHomeDirectory.includes('\0')) {
      throw new Error(
        'The resource home directory must be an absolute path without NUL characters.',
      );
    }
    this.resourceHomeDirectory = resolve(resourceHomeDirectory);
  }

  async load(): Promise<WorkspaceResourceSnapshot> {
    await requireDirectory(this.resourceHomeDirectory, 'resource home', false);
    const resourceHome = await realpath(this.resourceHomeDirectory);
    const resources: WorkspaceResource[] = [];
    const agents = await readResource(resourceHome, '.kairos/AGENTS.md', 'AGENTS.md');
    if (agents) resources.push(agents);

    const skillsDirectory = await findSkillsDirectory(resourceHome);
    if (skillsDirectory) {
      const entries = await readdir(skillsDirectory, { withFileTypes: true });
      const skillEntries = entries.filter((entry) => !entry.isFile());
      if (skillEntries.length > WORKSPACE_RESOURCE_LIMITS.maxSkills) {
        throw new Error(
          `The workspace exceeds the ${WORKSPACE_RESOURCE_LIMITS.maxSkills}-Skill limit.`,
        );
      }
      skillEntries.sort((left, right) => compareText(left.name, right.name));
      for (const entry of skillEntries) {
        if (!SKILL_NAME_PATTERN.test(entry.name)) {
          throw new Error(`Invalid Skill directory name: ${entry.name}.`);
        }
        const skillRelativePath = `.agents/skills/${entry.name}`;
        const skillDirectory = workspacePath(resourceHome, skillRelativePath);
        await requireDirectory(skillDirectory, `Skill directory ${skillRelativePath}`, false);
        await requireRealPathWithin(resourceHome, skillDirectory, skillRelativePath);
        const resourcePath = `${skillRelativePath}/SKILL.md`;
        const resource = await readResource(resourceHome, resourcePath, resourcePath);
        if (!resource) throw new Error(`Missing workspace resource: ${resourcePath}.`);
        resources.push(resource);
      }
    }

    resources.sort((left, right) => compareText(left.path, right.path));
    let totalBytes = 0;
    for (const resource of resources) {
      totalBytes += Buffer.byteLength(resource.content);
      if (totalBytes > WORKSPACE_RESOURCE_LIMITS.maxTotalBytes) {
        throw new Error(
          `Workspace resources exceed the ${WORKSPACE_RESOURCE_LIMITS.maxTotalBytes}-byte total limit.`,
        );
      }
    }
    return createWorkspaceResourceSnapshot(resources);
  }
}

async function findSkillsDirectory(resourceHome: string): Promise<string | undefined> {
  const agentsDirectory = workspacePath(resourceHome, '.agents');
  if (!(await requireDirectory(agentsDirectory, '.agents', true))) return undefined;
  await requireRealPathWithin(resourceHome, agentsDirectory, '.agents');
  const skillsDirectory = workspacePath(resourceHome, '.agents/skills');
  if (!(await requireDirectory(skillsDirectory, '.agents/skills', true))) return undefined;
  await requireRealPathWithin(resourceHome, skillsDirectory, '.agents/skills');
  return skillsDirectory;
}

async function requireDirectory(
  path: string,
  label: string,
  allowMissing: boolean,
): Promise<boolean> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (allowMissing && hasErrorCode(error, 'ENOENT')) return false;
    throw new Error(`Unable to inspect ${label}.`, { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory without symbolic links.`);
  }
  return true;
}

async function requireRealPathWithin(
  resourceHome: string,
  path: string,
  label: string,
): Promise<void> {
  const canonicalPath = await realpath(path);
  const relativePath = relative(resourceHome, canonicalPath);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Workspace path escapes the resource home: ${label}.`);
  }
}

async function readResource(
  resourceHome: string,
  relativePath: string,
  logicalPath: string,
): Promise<WorkspaceResource | undefined> {
  const absolutePath = workspacePath(resourceHome, relativePath);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw new Error(`Unable to open workspace resource: ${logicalPath}.`, { cause: error });
  }

  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`Workspace resource must be a regular file: ${logicalPath}.`);
    }
    await requireRealPathWithin(resourceHome, absolutePath, logicalPath);
    if (metadata.size > WORKSPACE_RESOURCE_LIMITS.maxFileBytes) {
      throw new Error(
        `Workspace resource ${logicalPath} exceeds the ${WORKSPACE_RESOURCE_LIMITS.maxFileBytes}-byte file limit.`,
      );
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > WORKSPACE_RESOURCE_LIMITS.maxFileBytes) {
      throw new Error(
        `Workspace resource ${logicalPath} exceeds the ${WORKSPACE_RESOURCE_LIMITS.maxFileBytes}-byte file limit.`,
      );
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      throw new Error(`Workspace resource is not valid UTF-8: ${logicalPath}.`, {
        cause: error,
      });
    }
    if (content.includes('\0')) {
      throw new Error(`Workspace resource contains a NUL character: ${logicalPath}.`);
    }
    if (content.trim().length === 0) {
      throw new Error(`Workspace resource is blank: ${logicalPath}.`);
    }
    return Object.freeze({ path: logicalPath, content });
  } finally {
    await handle.close();
  }
}

function workspacePath(resourceHome: string, resourcePath: string): string {
  const absolutePath = resolve(resourceHome, resourcePath);
  const relativePath = relative(resourceHome, absolutePath);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Workspace resource path escapes the resource home: ${resourcePath}.`);
  }
  return absolutePath;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
