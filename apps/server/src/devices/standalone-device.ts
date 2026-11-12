import type { DatabaseSync } from 'node:sqlite';
import { DeviceCapability } from '@kairos/contracts/device';
import { z } from 'zod';
import type { PlatformUse, PlatformUseGateway } from '../platform/contracts.js';
import { platformWorkspaceGateway } from '../platform-workspace.js';
import type { EnvironmentOperationGateway } from '../sessions/environment-runtime.js';
import { SessionError } from '../sessions/errors.js';
import type { EnvironmentStore } from './environment-store.js';

export interface StandaloneDeviceConfiguration {
  envId: string;
  workspace: '/workspace';
}

export function ensureStandaloneDeviceEnvironment(
  database: DatabaseSync,
  tenantId: string,
  configuration: StandaloneDeviceConfiguration,
  now = new Date(),
): void {
  const existing = database
    .prepare('SELECT tenant_id,kind,recommended_pwd FROM environments WHERE env_id = ?')
    .get(configuration.envId);
  if (existing) {
    const row = z
      .object({ tenant_id: z.string(), kind: z.string(), recommended_pwd: z.string() })
      .parse(existing);
    if (row.tenant_id !== tenantId) {
      throw new SessionError(
        'permission_denied',
        'The standalone execution device belongs to another tenant.',
      );
    }
    if (row.kind === 'platform_sandbox' || row.recommended_pwd !== configuration.workspace) {
      throw new SessionError(
        'failed_precondition',
        'The standalone execution device configuration conflicts with the stored environment.',
      );
    }
    return;
  }
  const timestamp = now.toISOString();
  const authorized = [
    DeviceCapability.BASH,
    DeviceCapability.FILE_READ,
    DeviceCapability.FILE_WRITE,
    DeviceCapability.FILE_EDIT,
    DeviceCapability.DIRECTORY_CHECK,
    DeviceCapability.DIRECTORY_LIST,
  ];
  database
    .prepare(
      `INSERT INTO environments(
        env_id, tenant_id, name, kind, recommended_pwd,
        binding_status, connection_status, capability_status, directory_status,
        maintenance_mode, maintenance_version,
        authorized_capabilities_json, granted_capabilities_json,
        device_id, device_binding_id, instance_id,
        daemon_version, os, architecture, status_reason, normalized_pwd, checked_at,
        created_at, updated_at, paired_at, revoked_at, last_seen_at
      ) VALUES (?, ?, '本机设备', 'self_hosted_linux', ?, 'pairing', 'offline', 'pending', 'pending',
        'normal', '0', ?, '[]', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ?, ?, NULL, NULL, NULL)`,
    )
    .run(
      configuration.envId,
      tenantId,
      configuration.workspace,
      JSON.stringify(authorized),
      timestamp,
      timestamp,
    );
}

export class StandaloneDeviceUseGateway implements PlatformUseGateway {
  readonly #configuration: StandaloneDeviceConfiguration;
  readonly #environments: EnvironmentStore;
  readonly #workspace: ReturnType<typeof platformWorkspaceGateway>;

  constructor(
    environments: EnvironmentStore,
    operations: EnvironmentOperationGateway,
    configuration: StandaloneDeviceConfiguration,
  ) {
    this.#environments = environments;
    this.#configuration = configuration;
    this.#workspace = platformWorkspaceGateway(environments, operations, this);
  }

  reserveUse(input: PlatformUse): void {
    this.#requireDevice(input);
  }

  async ensureReady(input: PlatformUse & { signal: AbortSignal }): Promise<void> {
    input.signal.throwIfAborted();
    this.#requireDevice(input);
    await this.#workspace.ensureWorkspaceReady({
      tenantId: input.tenantId,
      envId: input.envId,
      pwd: this.#configuration.workspace,
      signal: input.signal,
    });
    this.#requireDevice(input);
    this.#environments.requireReady(input.tenantId, input.envId);
  }

  releaseUse(_input: PlatformUse): void {}

  #requireDevice(input: PlatformUse) {
    if (input.envId !== this.#configuration.envId) {
      throw new SessionError(
        'permission_denied',
        'The standalone execution device is not allowed.',
      );
    }
    let environment: ReturnType<EnvironmentStore['get']>;
    try {
      environment = this.#environments.get(input.tenantId, input.envId);
    } catch (cause) {
      if (cause instanceof SessionError && cause.code === 'not_found') {
        throw new SessionError(
          'failed_precondition',
          'The standalone execution device has not been paired through the GUI.',
          { cause, retryable: true },
        );
      }
      throw cause;
    }
    if (environment.kind === 'platform_sandbox') {
      throw new SessionError(
        'permission_denied',
        'The standalone execution environment must be an ordinary device.',
      );
    }
    if (environment.bindingStatus !== 'active') {
      throw new SessionError(
        'failed_precondition',
        'The standalone execution device has not completed pairing.',
        { retryable: true },
      );
    }
    if (environment.connectionStatus !== 'online') {
      throw new SessionError('device_offline', 'The standalone execution device is offline.', {
        retryable: true,
      });
    }
    if (!environment.deviceBindingId || !environment.instanceId) {
      throw new SessionError(
        'failed_precondition',
        'The standalone execution device instance is unavailable.',
        { retryable: true },
      );
    }
    if (environment.capabilityStatus === 'failed' || environment.directoryStatus === 'failed') {
      throw new SessionError(
        'failed_precondition',
        'The standalone execution device capability or directory check failed.',
        { retryable: true },
      );
    }
    if (
      (environment.normalizedPwd ?? environment.recommendedPwd) !== this.#configuration.workspace
    ) {
      throw new SessionError(
        'failed_precondition',
        'The standalone execution device workspace does not match the configured workspace.',
      );
    }
    return environment;
  }
}
