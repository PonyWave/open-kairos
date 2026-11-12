import { createHash } from 'node:crypto';

export const WORKSPACE_RESOURCE_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024,
  maxSkills: 32,
  maxTotalBytes: 256 * 1024,
});

export interface WorkspaceResource {
  readonly path: string;
  readonly content: string;
}

export interface WorkspaceResourceSnapshot {
  readonly snapshotId: string;
  readonly systemInstructions: string;
  readonly resources: readonly WorkspaceResource[];
}

export interface WorkspaceResourceDiff {
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
}

export function compareWorkspaceResourceSnapshots(
  previous: WorkspaceResourceSnapshot,
  next: WorkspaceResourceSnapshot,
): WorkspaceResourceDiff {
  const previousByPath = new Map(previous.resources.map((resource) => [resource.path, resource]));
  const nextByPath = new Map(next.resources.map((resource) => [resource.path, resource]));
  const added = next.resources
    .filter((resource) => !previousByPath.has(resource.path))
    .map((resource) => resource.path);
  const updated = next.resources
    .filter((resource) => {
      const oldResource = previousByPath.get(resource.path);
      return oldResource !== undefined && oldResource.content !== resource.content;
    })
    .map((resource) => resource.path);
  const removed = previous.resources
    .filter((resource) => !nextByPath.has(resource.path))
    .map((resource) => resource.path);
  added.sort(compareText);
  updated.sort(compareText);
  removed.sort(compareText);
  return Object.freeze({
    added: Object.freeze(added),
    updated: Object.freeze(updated),
    removed: Object.freeze(removed),
  });
}

export function createWorkspaceResourceSnapshot(
  resources: readonly WorkspaceResource[],
): WorkspaceResourceSnapshot {
  const frozenResources = Object.freeze(
    [...resources]
      .sort((left, right) => compareText(left.path, right.path))
      .map((resource) => Object.freeze({ ...resource })),
  );
  const systemInstructions = frozenResources
    .map(
      (resource) =>
        `<workspace-resource path="${resource.path}">\n${resource.content}${resource.content.endsWith('\n') ? '' : '\n'}</workspace-resource>`,
    )
    .join('\n\n');
  const hash = createHash('sha256').update('kairos-workspace-resources-v1\0');
  for (const resource of frozenResources) {
    hash.update(JSON.stringify([resource.path, resource.content]));
  }
  return Object.freeze({
    snapshotId: hash.digest('hex'),
    systemInstructions,
    resources: frozenResources,
  });
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
