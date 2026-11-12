import { ContractValidationError } from './error.js';
import type {
  CreateWorkspaceRequest,
  RenameWorkspaceRequest,
} from './gen/kairos/gui/v1/workspace_pb.js';

export * from './gen/kairos/gui/v1/workspace_pb.js';

function reject(message: string): never {
  throw new ContractValidationError('INVALID_MESSAGE', message);
}

function requireIdentifier(value: string, field: string, maximum = 200): void {
  if (!value.trim() || value.length > maximum || value.includes('\0')) {
    reject(`${field} must contain between 1 and ${maximum} characters without null characters.`);
  }
}

function requirePosixAbsolutePath(value: string, field: string): void {
  requireIdentifier(value, field, 4096);
  const segments = value.split('/');
  if (
    !value.startsWith('/') ||
    (value.length > 1 && value.endsWith('/')) ||
    segments.some((segment, index) => index > 0 && (segment === '.' || segment === '..')) ||
    value.includes('//')
  ) {
    reject(`${field} must be a normalized absolute POSIX path.`);
  }
}

export function validateCreateWorkspaceRequest(request: CreateWorkspaceRequest): void {
  requireIdentifier(request.clientActionId, 'client_action_id');
  requireIdentifier(request.name, 'name');
  requireIdentifier(request.envId, 'env_id');
  requirePosixAbsolutePath(request.path, 'path');
}

export function validateRenameWorkspaceRequest(request: RenameWorkspaceRequest): void {
  requireIdentifier(request.clientActionId, 'client_action_id');
  requireIdentifier(request.workspaceId, 'workspace_id');
  requireIdentifier(request.name, 'name');
}
