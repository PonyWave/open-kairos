export interface ReloadResourcesInput {
  ownerId: string;
  threadId: string;
  clientActionId: string;
}

export interface ReloadResourcesResult {
  snapshotId: string;
  changed: boolean;
  resources: readonly string[];
  added: readonly string[];
  updated: readonly string[];
  removed: readonly string[];
  runtimeFingerprint?: string | undefined;
  runtimeChanged?: boolean | undefined;
}
