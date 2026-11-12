import { ContractValidationError } from './error.js';
import type {
  AgentEnvironmentBinding,
  BeginDeviceConnectionRequest,
  CancelDeviceConnectionRequest,
  EnvironmentPolicy,
  GetEnvironmentDaemonCommandsRequest,
  GetEnvironmentRequest,
  ListEnvironmentDirectoriesRequest,
  RegisterEnvironmentRequest,
  ReissueEnvironmentPairingRequest,
  RevokeEnvironmentRequest,
  SetEnvironmentMaintenanceRequest,
  SetFavoriteDirectoryRequest,
  UpdateEnvironmentRequest,
} from './gen/kairos/gui/v1/environment_pb.js';
import { EnvironmentKind, EnvironmentMaintenanceMode } from './gen/kairos/gui/v1/environment_pb.js';

export * from './gen/kairos/gui/v1/environment_pb.js';

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

function requireAction(clientActionId: string): void {
  requireIdentifier(clientActionId, 'client_action_id');
}

export function validateBeginDeviceConnectionRequest(request: BeginDeviceConnectionRequest): void {
  requireAction(request.clientActionId);
}

export function validateCancelDeviceConnectionRequest(
  request: CancelDeviceConnectionRequest,
): void {
  requireAction(request.clientActionId);
  requireIdentifier(request.envId, 'env_id');
}

export function validateUpdateEnvironmentRequest(request: UpdateEnvironmentRequest): void {
  requireAction(request.clientActionId);
  requireIdentifier(request.envId, 'env_id');
  if (request.name === undefined && request.recommendedPwd === undefined)
    reject('At least one device setting is required.');
  if (request.name !== undefined) requireIdentifier(request.name.trim(), 'name');
  if (request.recommendedPwd !== undefined)
    requirePosixAbsolutePath(request.recommendedPwd, 'recommended_pwd');
  if (request.expectedSettingsVersion < 0n || request.expectedSettingsVersion >= (1n << 64n) - 1n)
    reject('Device settings version is invalid.');
}

export function validateSetFavoriteDirectoryRequest(request: SetFavoriteDirectoryRequest): void {
  requireAction(request.clientActionId);
  requireIdentifier(request.envId, 'env_id');
  requirePosixAbsolutePath(request.path, 'path');
}

export function validateListEnvironmentDirectoriesRequest(
  request: ListEnvironmentDirectoriesRequest,
): void {
  requireIdentifier(request.envId, 'env_id');
  requirePosixAbsolutePath(request.path, 'path');
  if (request.limit > 200 || request.offset > 10000)
    reject('Directory list range exceeds its limit.');
}

export function validateRegisterEnvironmentRequest(request: RegisterEnvironmentRequest): void {
  requireAction(request.clientActionId);
  requireIdentifier(request.name, 'name');
  requirePosixAbsolutePath(request.recommendedPwd, 'recommended_pwd');
  if (
    request.kind !== EnvironmentKind.UNSPECIFIED &&
    request.kind !== EnvironmentKind.SELF_HOSTED_LINUX &&
    request.kind !== EnvironmentKind.SELF_HOSTED_MACOS
  ) {
    reject('kind must be SELF_HOSTED_LINUX or SELF_HOSTED_MACOS.');
  }
}

export function validateGetEnvironmentRequest(request: GetEnvironmentRequest): void {
  requireIdentifier(request.envId, 'env_id');
}

export function validateGetEnvironmentDaemonCommandsRequest(
  request: GetEnvironmentDaemonCommandsRequest,
): void {
  requireIdentifier(request.envId, 'env_id');
}

export function validateReissueEnvironmentPairingRequest(
  request: ReissueEnvironmentPairingRequest,
): void {
  requireAction(request.clientActionId);
  requireIdentifier(request.envId, 'env_id');
}

export function validateRevokeEnvironmentRequest(request: RevokeEnvironmentRequest): void {
  requireAction(request.clientActionId);
  requireIdentifier(request.envId, 'env_id');
}

export function validateEnvironmentPolicy(policy: EnvironmentPolicy): void {
  if (policy.allowedEnv.length === 0) reject('allowed_env must not be empty.');
  if (new Set(policy.allowedEnv).size !== policy.allowedEnv.length) {
    reject('allowed_env must not contain duplicates.');
  }
  for (const envId of policy.allowedEnv) requireIdentifier(envId, 'allowed_env');
  if (policy.policyVersion <= 0n) reject('policy_version must be greater than zero.');
}

export function validateAgentEnvironmentBinding(binding: AgentEnvironmentBinding): void {
  requireIdentifier(binding.envId, 'env_id');
  requirePosixAbsolutePath(binding.pwd, 'pwd');
  if (binding.bindingVersion <= 0n) reject('binding_version must be greater than zero.');
  if (binding.resourceVersion !== undefined) {
    requireIdentifier(binding.resourceVersion, 'resource_version');
  }
}

export function validateSetEnvironmentMaintenanceRequest(
  request: SetEnvironmentMaintenanceRequest,
): void {
  requireAction(request.clientActionId);
  requireIdentifier(request.envId, 'env_id');
  if (
    request.mode !== EnvironmentMaintenanceMode.NORMAL &&
    request.mode !== EnvironmentMaintenanceMode.DRAINING
  ) {
    reject('mode must be NORMAL or DRAINING.');
  }
  if (request.expectedVersion < 0n) reject('expected_version must be a uint64 value.');
}
