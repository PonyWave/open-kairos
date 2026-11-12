import { createContext, useContext } from 'react';

export interface ThreadIdentity {
  workspaceId?: string | undefined;
  main: boolean;
}

const ThreadWorkspaceContext = createContext<ReadonlyMap<string, ThreadIdentity>>(new Map());

export const ThreadWorkspaceProvider = ThreadWorkspaceContext.Provider;

export function useThreadIdentity(threadId: string | undefined): ThreadIdentity | undefined {
  const identities = useContext(ThreadWorkspaceContext);
  if (!threadId) return undefined;
  return identities.get(threadId);
}
