import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';
import {
  validateCreateWorkspaceRequest,
  validateRenameWorkspaceRequest,
  WorkspacesService,
} from '@kairos/contracts';
import type { WorkspaceRecord } from '../sessions/records.js';
import type { SessionStore } from '../sessions/store.js';
import type { GuiAuthentication } from './auth.js';
import { requireOwner } from './auth.js';
import { timestamp } from './convert.js';
import { asConnectError } from './errors.js';

export interface WorkspacesApiOptions {
  store: SessionStore;
  authentication: GuiAuthentication;
}

function toWorkspace(record: WorkspaceRecord, mainThreadId: string | undefined) {
  return {
    workspaceId: record.workspaceId,
    name: record.name,
    envId: record.envId,
    path: record.path,
    createdAt: timestamp(record.createdAt),
    mainThreadId: mainThreadId ?? '',
  };
}

export function registerWorkspacesRoutes(
  router: ConnectRouter,
  options: WorkspacesApiOptions,
): void {
  const owner = (context: HandlerContext) => requireOwner(context, options.authentication);
  const handle = async <T>(work: () => T | Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw asConnectError(error);
    }
  };
  router.service(WorkspacesService, {
    listWorkspaces: (_request, context) =>
      handle(() => {
        const tenantId = owner(context);
        return {
          workspaces: options.store
            .listWorkspaces(tenantId)
            .map((workspace) =>
              toWorkspace(
                workspace,
                options.store.workspaceMainThreadId(tenantId, workspace.workspaceId),
              ),
            ),
        };
      }),
    createWorkspace: (request, context) =>
      handle(() => {
        const tenantId = owner(context);
        validateCreateWorkspaceRequest(request);
        const created = options.store.createWorkspace({
          ownerId: tenantId,
          name: request.name,
          envId: request.envId,
          path: request.path,
        });
        return {
          clientActionId: request.clientActionId,
          workspace: toWorkspace(created.workspace, created.mainThread.threadId),
          mainThreadId: created.mainThread.threadId,
        };
      }),
    renameWorkspace: (request, context) =>
      handle(() => {
        const tenantId = owner(context);
        validateRenameWorkspaceRequest(request);
        const workspace = options.store.renameWorkspace({
          ownerId: tenantId,
          workspaceId: request.workspaceId,
          name: request.name,
        });
        return {
          clientActionId: request.clientActionId,
          workspace: toWorkspace(
            workspace,
            options.store.workspaceMainThreadId(tenantId, workspace.workspaceId),
          ),
        };
      }),
  });
}
