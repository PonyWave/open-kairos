import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';
import {
  EnvironmentKind,
  EnvironmentMaintenanceMode,
  EnvironmentService,
  validateBeginDeviceConnectionRequest,
  validateCancelDeviceConnectionRequest,
  validateGetEnvironmentDaemonCommandsRequest,
  validateGetEnvironmentRequest,
  validateListEnvironmentDirectoriesRequest,
  validateRegisterEnvironmentRequest,
  validateReissueEnvironmentPairingRequest,
  validateRevokeEnvironmentRequest,
  validateSetEnvironmentMaintenanceRequest,
  validateSetFavoriteDirectoryRequest,
  validateUpdateEnvironmentRequest,
} from '@kairos/contracts';
import type { DaemonCommandGuide } from '../devices/device-installer.js';
import type { EnvironmentDirectories } from '../devices/environment-directories.js';
import type { EnvironmentPairingIssue, EnvironmentStore } from '../devices/environment-store.js';
import {
  ensureMainEnvironment,
  type MainEnvironmentConfiguration,
} from '../devices/main-environment.js';
import { SessionError } from '../sessions/errors.js';
import type { GuiAuthentication } from './auth.js';
import { requireOwner } from './auth.js';
import { timestamp, toEnvironment } from './convert.js';
import { asConnectError } from './errors.js';

export interface EnvironmentApiOptions {
  environments: EnvironmentStore;
  authentication: GuiAuthentication;
  directories?: EnvironmentDirectories;
  installer?: {
    assertAvailable(): void;
    command(issued: EnvironmentPairingIssue): string;
    daemonCommands(envId: string): DaemonCommandGuide;
  };
  mainEnvironment: MainEnvironmentConfiguration;
}

function pairingFields(issued: EnvironmentPairingIssue) {
  return {
    environment: toEnvironment(issued.environment),
    pairingCredential: issued.pairingCredential,
    expiresAt: timestamp(issued.expiresAt),
  };
}

function requireDeviceEnvironment(kind: string): void {
  if (kind === 'platform_sandbox') {
    throw new SessionError(
      'permission_denied',
      'Platform environments do not use device management operations.',
    );
  }
}

export function registerEnvironmentRoutes(
  router: ConnectRouter,
  options: EnvironmentApiOptions,
): void {
  const owner = (context: HandlerContext) => requireOwner(context, options.authentication);
  const handle = async <T>(
    clientActionId: string | undefined,
    work: () => T | Promise<T>,
  ): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw asConnectError(error, clientActionId);
    }
  };

  router.service(EnvironmentService, {
    beginDeviceConnection: (request, context) =>
      handle(request.clientActionId, () => {
        validateBeginDeviceConnectionRequest(request);
        const tenantId = owner(context);
        if (!options.installer)
          throw new SessionError(
            'failed_precondition',
            'Device installation packages have not been configured.',
          );
        options.installer.assertAvailable();
        const issued = options.environments.beginConnection({
          tenantId,
          clientActionId: request.clientActionId,
        });
        return {
          clientActionId: request.clientActionId,
          ...pairingFields(issued),
          installCommand: options.installer.command(issued),
        };
      }),
    cancelDeviceConnection: (request, context) =>
      handle(request.clientActionId, () => {
        validateCancelDeviceConnectionRequest(request);
        return {
          clientActionId: request.clientActionId,
          environment: toEnvironment(
            options.environments.cancelConnection({
              tenantId: owner(context),
              clientActionId: request.clientActionId,
              envId: request.envId,
            }),
          ),
        };
      }),
    updateEnvironment: (request, context) =>
      handle(request.clientActionId, async () => {
        validateUpdateEnvironmentRequest(request);
        const tenantId = owner(context);
        const input = {
          tenantId,
          clientActionId: request.clientActionId,
          envId: request.envId,
          expectedSettingsVersion: request.expectedSettingsVersion,
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.recommendedPwd === undefined
            ? {}
            : { recommendedPwd: request.recommendedPwd }),
        };
        const replay = options.environments.replaySettingsUpdate(input);
        if (replay)
          return { clientActionId: request.clientActionId, environment: toEnvironment(replay) };
        const current = options.environments.get(tenantId, request.envId);
        requireDeviceEnvironment(current.kind);
        if (
          request.recommendedPwd !== undefined &&
          current.connectionStatus === 'online' &&
          !options.directories
        )
          throw new SessionError('failed_precondition', 'Device directory access is unavailable.');
        const checkedDirectory =
          request.recommendedPwd !== undefined &&
          current.connectionStatus === 'online' &&
          options.directories
            ? await options.directories.check(
                tenantId,
                request.envId,
                request.recommendedPwd,
                context.signal,
              )
            : undefined;
        const updated = options.environments.updateSettings({
          ...input,
          ...(checkedDirectory ? { checkedDirectory } : {}),
        });
        return { clientActionId: request.clientActionId, environment: toEnvironment(updated) };
      }),
    setFavoriteDirectory: (request, context) =>
      handle(request.clientActionId, () => {
        validateSetFavoriteDirectoryRequest(request);
        requireDeviceEnvironment(options.environments.get(owner(context), request.envId).kind);
        const updated = options.environments.setFavorite({
          tenantId: owner(context),
          clientActionId: request.clientActionId,
          envId: request.envId,
          path: request.path,
          enabled: request.enabled,
        });
        return { clientActionId: request.clientActionId, environment: toEnvironment(updated) };
      }),
    listEnvironmentDirectories: (request, context) =>
      handle(undefined, async () => {
        validateListEnvironmentDirectoriesRequest(request);
        const tenantId = owner(context);
        requireDeviceEnvironment(options.environments.get(tenantId, request.envId).kind);
        if (!options.directories)
          throw new SessionError('failed_precondition', 'Device directory access is unavailable.');
        const listed = await options.directories.list(
          tenantId,
          request.envId,
          request.path,
          request.offset,
          request.limit || 200,
          context.signal,
        );
        return {
          path: listed.normalizedPath,
          entries: listed.entries,
          hasMore: listed.hasMore,
          ...(listed.nextOffset === undefined ? {} : { nextOffset: listed.nextOffset }),
        };
      }),
    registerEnvironment: (request, context) =>
      handle(request.clientActionId, () => {
        validateRegisterEnvironmentRequest(request);
        const issued = options.environments.register({
          tenantId: owner(context),
          clientActionId: request.clientActionId,
          name: request.name,
          recommendedPwd: request.recommendedPwd,
          kind:
            request.kind === EnvironmentKind.SELF_HOSTED_MACOS
              ? 'self_hosted_macos'
              : 'self_hosted_linux',
        });
        return {
          clientActionId: request.clientActionId,
          ...pairingFields(issued),
          ...(options.installer ? { installCommand: options.installer.command(issued) } : {}),
        };
      }),
    listEnvironments: (_request, context) =>
      handle(undefined, () => {
        const tenantId = owner(context);
        const mainEnvId = ensureMainEnvironment(
          options.environments.database,
          tenantId,
          options.mainEnvironment,
        );
        const listed = options.environments.list(tenantId);
        return {
          mainEnvId,
          environments: listed.environments.map(toEnvironment),
        };
      }),
    getEnvironment: (request, context) =>
      handle(undefined, () => {
        validateGetEnvironmentRequest(request);
        return {
          environment: toEnvironment(options.environments.get(owner(context), request.envId)),
        };
      }),
    getEnvironmentDaemonCommands: (request, context) =>
      handle(undefined, () => {
        validateGetEnvironmentDaemonCommandsRequest(request);
        const environment = options.environments.get(owner(context), request.envId);
        if (environment.kind === 'platform_sandbox') {
          throw new SessionError(
            'failed_precondition',
            'Platform environments do not use device commands.',
          );
        }
        if (environment.bindingStatus !== 'active')
          throw new SessionError(
            'failed_precondition',
            'Daemon commands require an active environment binding.',
          );
        if (!options.installer)
          throw new SessionError(
            'failed_precondition',
            'Device command guidance has not been configured.',
          );
        return options.installer.daemonCommands(request.envId);
      }),
    reissueEnvironmentPairing: (request, context) =>
      handle(request.clientActionId, () => {
        validateReissueEnvironmentPairingRequest(request);
        const issued = options.environments.reissue({
          tenantId: owner(context),
          clientActionId: request.clientActionId,
          envId: request.envId,
        });
        return {
          clientActionId: request.clientActionId,
          ...pairingFields(issued),
          ...(options.installer ? { installCommand: options.installer.command(issued) } : {}),
        };
      }),
    revokeEnvironment: (request, context) =>
      handle(request.clientActionId, () => {
        validateRevokeEnvironmentRequest(request);
        const revoked = options.environments.revoke({
          tenantId: owner(context),
          clientActionId: request.clientActionId,
          envId: request.envId,
        });
        return {
          clientActionId: request.clientActionId,
          environment: toEnvironment(revoked.environment),
        };
      }),
    setEnvironmentMaintenance: (request, context) =>
      handle(request.clientActionId, () => {
        validateSetEnvironmentMaintenanceRequest(request);
        const maintenance = options.environments.setMaintenance({
          tenantId: owner(context),
          clientActionId: request.clientActionId,
          envId: request.envId,
          mode: request.mode === EnvironmentMaintenanceMode.DRAINING ? 'draining' : 'normal',
          expectedVersion: request.expectedVersion,
        });
        return {
          clientActionId: request.clientActionId,
          envId: maintenance.envId,
          mode:
            maintenance.mode === 'draining'
              ? EnvironmentMaintenanceMode.DRAINING
              : EnvironmentMaintenanceMode.NORMAL,
          maintenanceVersion: BigInt(maintenance.maintenanceVersion),
        };
      }),
  });
}
