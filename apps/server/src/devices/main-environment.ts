import type { DatabaseSync } from 'node:sqlite';
import { DeviceCapability } from '@kairos/contracts/device';
import { z } from 'zod';
import type { EnvironmentOperationGateway } from '../sessions/environment-runtime.js';
import { SessionError } from '../sessions/errors.js';
import type { EnvironmentStore } from './environment-store.js';
import type { EnvironmentUse, EnvironmentUseGateway } from './environment-use.js';
import { workspaceReadinessGateway } from './workspace-readiness.js';

export interface MainEnvironmentConfiguration {
  envId: string;
  workspace: string;
}

export function ensureMainEnvironment(
  database: DatabaseSync,
  tenantId: string,
  configuration: MainEnvironmentConfiguration,
  now = new Date(),
): string {
  const existing = database
    .prepare('SELECT tenant_id,kind,recommended_pwd FROM environments WHERE env_id = ?')
    .get(configuration.envId);
  if (existing) {
    const row = z
      .object({ tenant_id: z.string(), kind: z.string(), recommended_pwd: z.string() })
      .parse(existing);
    if (row.tenant_id !== tenantId) {
      // The configured id belongs to another tenant; fall back to a tenant-scoped id.
      return ensureMainEnvironment(
        database,
        tenantId,
        { ...configuration, envId: `${configuration.envId}-${tenantId}` },
        now,
      );
    }
    if (row.recommended_pwd !== configuration.workspace) {
      throw new SessionError(
        'failed_precondition',
        'The main environment configuration conflicts with the stored environment.',
      );
    }
    return configuration.envId;
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
      ) VALUES (?, ?, '主环境', 'self_hosted_linux', ?, 'pairing', 'offline', 'pending', 'pending',
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
  database
    .prepare('UPDATE environments SET auto_detect = 1 WHERE env_id = ?')
    .run(configuration.envId);
  return configuration.envId;
}

export function mainEnvironmentIdFor(
  database: DatabaseSync,
  configuration: MainEnvironmentConfiguration,
  tenantId: string,
): string {
  const row = database
    .prepare('SELECT tenant_id FROM environments WHERE env_id = ?')
    .get(configuration.envId);
  if (!row) return configuration.envId;
  const owner = z.object({ tenant_id: z.string() }).parse(row).tenant_id;
  return owner === tenantId ? configuration.envId : `${configuration.envId}-${tenantId}`;
}

export function isMainEnvironmentReady(
  environments: EnvironmentStore,
  tenantId: string,
  configuration: MainEnvironmentConfiguration,
): boolean {
  try {
    const environment = environments.get(tenantId, configuration.envId);
    return environment.bindingStatus === 'active' && environment.connectionStatus === 'online';
  } catch {
    return false;
  }
}

export class MainEnvironmentUseGateway implements EnvironmentUseGateway {
  readonly #configuration: MainEnvironmentConfiguration;
  readonly #environments: EnvironmentStore;
  readonly #workspace: ReturnType<typeof workspaceReadinessGateway>;

  constructor(
    environments: EnvironmentStore,
    operations: EnvironmentOperationGateway,
    configuration: MainEnvironmentConfiguration,
  ) {
    this.#environments = environments;
    this.#configuration = configuration;
    this.#workspace = workspaceReadinessGateway(environments, operations, this);
  }

  reserveUse(input: EnvironmentUse): void {
    if (this.#isMain(input)) {
      this.#requireDevice(input);
      return;
    }
    this.#requireRegistered(input);
  }

  async ensureReady(input: EnvironmentUse & { signal: AbortSignal }): Promise<void> {
    input.signal.throwIfAborted();
    const main = this.#isMain(input);
    if (main) {
      this.#requireDevice(input);
    } else {
      this.#requireRegistered(input);
    }
    const pwd = input.pwd ?? (main ? this.#configuration.workspace : undefined);
    if (pwd === undefined) {
      throw new SessionError(
        'failed_precondition',
        'The workspace directory of the execution environment is unknown.',
      );
    }
    await this.#workspace.ensureWorkspaceReady({
      tenantId: input.tenantId,
      envId: input.envId,
      pwd,
      signal: input.signal,
    });
    if (main) this.#requireDevice(input);
    this.#environments.requireReady(input.tenantId, input.envId);
  }

  releaseUse(_input: EnvironmentUse): void {}

  #isMain(input: EnvironmentUse): boolean {
    return (
      input.envId ===
      mainEnvironmentIdFor(this.#environments.database, this.#configuration, input.tenantId)
    );
  }

  #requireRegistered(input: EnvironmentUse) {
    let environment: ReturnType<EnvironmentStore['get']>;
    try {
      environment = this.#environments.get(input.tenantId, input.envId);
    } catch (cause) {
      if (cause instanceof SessionError && cause.code === 'not_found') {
        throw new SessionError(
          'failed_precondition',
          'The execution environment is not registered.',
          { cause, retryable: true },
        );
      }
      throw cause;
    }
    if (environment.bindingStatus === 'revoked') {
      throw new SessionError('permission_denied', 'The execution environment is revoked.');
    }
    return environment;
  }

  #requireDevice(input: EnvironmentUse) {
    if (
      input.envId !==
      mainEnvironmentIdFor(this.#environments.database, this.#configuration, input.tenantId)
    ) {
      throw new SessionError('permission_denied', 'The main environment is not allowed.');
    }
    let environment: ReturnType<EnvironmentStore['get']>;
    try {
      environment = this.#environments.get(input.tenantId, input.envId);
    } catch (cause) {
      if (cause instanceof SessionError && cause.code === 'not_found') {
        throw new SessionError(
          'failed_precondition',
          'The main environment has not been initialized.',
          { cause, retryable: true },
        );
      }
      throw cause;
    }
    if (environment.bindingStatus !== 'active') {
      throw new SessionError(
        'failed_precondition',
        'The main environment has not completed pairing.',
        {
          retryable: true,
        },
      );
    }
    if (environment.connectionStatus !== 'online') {
      throw new SessionError('device_offline', 'The main environment is offline.', {
        retryable: true,
      });
    }
    if (!environment.deviceBindingId || !environment.instanceId) {
      throw new SessionError(
        'failed_precondition',
        'The main environment instance is unavailable.',
        {
          retryable: true,
        },
      );
    }
    if (environment.capabilityStatus === 'failed' || environment.directoryStatus === 'failed') {
      throw new SessionError(
        'failed_precondition',
        'The main environment capability or directory check failed.',
        { retryable: true },
      );
    }
    if (
      (environment.normalizedPwd ?? environment.recommendedPwd) !== this.#configuration.workspace
    ) {
      throw new SessionError(
        'failed_precondition',
        'The main environment workspace does not match the configured workspace.',
      );
    }
    return environment;
  }
}
