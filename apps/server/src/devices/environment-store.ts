import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DeviceCapability, isDeviceCapability } from '@kairos/contracts/device';
import { z } from 'zod';
import { requireText, SessionError } from '../sessions/errors.js';
import { inTransaction } from '../storage/transaction.js';
import {
  EnvironmentPairing,
  type EnvironmentPairingExchange,
  type EnvironmentPairingExchangeInput,
} from './environment-pairing.js';
import type { MainEnvironmentConfiguration } from './main-environment.js';

const capabilitySchema = z.number().int().refine(isDeviceCapability);
const capabilitiesSchema = z.array(capabilitySchema);
const platformLifecycleStates = [
  'uninitialized',
  'starting',
  'running',
  'pausing',
  'paused',
  'resuming',
  'deleting',
  'deleted',
  'error',
] as const;
type PlatformLifecycleState = (typeof platformLifecycleStates)[number];
const environmentRowSchema = z.object({
  env_id: z.string(),
  tenant_id: z.string(),
  name: z.string(),
  auto_detect: z.number().int().min(0).max(1),
  settings_version: z.string(),
  kind: z.enum(['self_hosted_linux', 'self_hosted_macos', 'platform_sandbox']),
  platform_lifecycle_state: z.enum(platformLifecycleStates).nullable(),
  recommended_pwd: z.string(),
  binding_status: z.enum(['pairing', 'active', 'revoked']),
  connection_status: z.enum(['offline', 'online']),
  capability_status: z.enum(['pending', 'ready', 'failed']),
  directory_status: z.enum(['pending', 'ready', 'failed']),
  maintenance_mode: z.enum(['normal', 'draining']),
  maintenance_version: z.string(),
  authorized_capabilities_json: z.string(),
  granted_capabilities_json: z.string(),
  device_id: z.string().nullable(),
  device_binding_id: z.string().nullable(),
  instance_id: z.string().nullable(),
  daemon_version: z.string().nullable(),
  os: z.string().nullable(),
  architecture: z.string().nullable(),
  status_reason: z.string().nullable(),
  normalized_pwd: z.string().nullable(),
  checked_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  paired_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  last_seen_at: z.string().nullable(),
});

const actionRowSchema = z.object({
  method: z.string(),
  fingerprint: z.string(),
  response_json: z.string(),
});

const environmentRecordSchema = z.object({
  envId: z.string(),
  tenantId: z.string(),
  name: z.string(),
  autoDetect: z.boolean(),
  settingsVersion: z.string(),
  favoriteDirectories: z.array(z.string()),
  kind: z.enum(['self_hosted_linux', 'self_hosted_macos', 'platform_sandbox']),
  lifecycleState: z.enum(platformLifecycleStates).nullable(),
  recommendedPwd: z.string(),
  bindingStatus: z.enum(['pairing', 'active', 'revoked']),
  connectionStatus: z.enum(['offline', 'online']),
  capabilityStatus: z.enum(['pending', 'ready', 'failed']),
  directoryStatus: z.enum(['pending', 'ready', 'failed']),
  maintenanceMode: z.enum(['normal', 'draining']),
  maintenanceVersion: z.string(),
  authorizedCapabilities: capabilitiesSchema,
  grantedCapabilities: capabilitiesSchema,
  deviceId: z.string().optional(),
  deviceBindingId: z.string().optional(),
  instanceId: z.string().optional(),
  daemonVersion: z.string().optional(),
  os: z.string().optional(),
  architecture: z.string().optional(),
  statusReason: z.string().optional(),
  normalizedPwd: z.string().optional(),
  checkedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  pairedAt: z.string().optional(),
  revokedAt: z.string().optional(),
  lastSeenAt: z.string().optional(),
  ready: z.boolean(),
});

const pairingResponseSchema = z.object({
  environment: environmentRecordSchema,
  pairingCredential: z.string(),
  expiresAt: z.string(),
});

const revokeResponseSchema = z.object({
  environment: environmentRecordSchema,
});

const maintenanceResponseSchema = z.object({
  envId: z.string(),
  mode: z.enum(['normal', 'draining']),
  maintenanceVersion: z.string(),
});

export type EnvironmentKind = 'self_hosted_linux' | 'self_hosted_macos' | 'platform_sandbox';
export type EnvironmentBindingStatus = 'pairing' | 'active' | 'revoked';
export type EnvironmentConnectionStatus = 'offline' | 'online';
export type EnvironmentCheckStatus = 'pending' | 'ready' | 'failed';
export type EnvironmentMaintenanceMode = 'normal' | 'draining';

export interface EnvironmentRecord {
  envId: string;
  tenantId: string;
  name: string;
  autoDetect: boolean;
  settingsVersion: string;
  favoriteDirectories: string[];
  kind: EnvironmentKind;
  lifecycleState: PlatformLifecycleState | null;
  recommendedPwd: string;
  bindingStatus: EnvironmentBindingStatus;
  connectionStatus: EnvironmentConnectionStatus;
  capabilityStatus: EnvironmentCheckStatus;
  directoryStatus: EnvironmentCheckStatus;
  maintenanceMode: EnvironmentMaintenanceMode;
  maintenanceVersion: string;
  authorizedCapabilities: DeviceCapability[];
  grantedCapabilities: DeviceCapability[];
  deviceId?: string | undefined;
  deviceBindingId?: string | undefined;
  instanceId?: string | undefined;
  daemonVersion?: string | undefined;
  os?: string | undefined;
  architecture?: string | undefined;
  statusReason?: string | undefined;
  normalizedPwd?: string | undefined;
  checkedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
  pairedAt?: string | undefined;
  revokedAt?: string | undefined;
  lastSeenAt?: string | undefined;
  ready: boolean;
}

export interface EnvironmentInstallation {
  releaseVersion: string;
  downloadUrl: string;
}

export interface EnvironmentPairingIssue {
  environment: EnvironmentRecord;
  pairingCredential: string;
  expiresAt: string;
}

export interface EnvironmentMaintenance {
  envId: string;
  mode: EnvironmentMaintenanceMode;
  maintenanceVersion: string;
}

export interface EnvironmentStoreOptions {
  now?: () => Date;
  createId?: () => string;
  maxEnvironments?: number;
  pairingCredentialTtlMs?: number;
  mainEnvironment?: MainEnvironmentConfiguration;
}

interface EnvironmentAction {
  tenantId: string;
  clientActionId: string;
  method: string;
  parameters: unknown;
}

type EnvironmentRow = z.infer<typeof environmentRowSchema>;

const maximumUint64 = (1n << 64n) - 1n;

function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function parseCapabilities(value: string): DeviceCapability[] {
  return capabilitiesSchema.parse(JSON.parse(value));
}

function requirePosixPath(value: string, field: string): string {
  requireText(value, field, 4096);
  if (
    !value.startsWith('/') ||
    (value.length > 1 && value.endsWith('/')) ||
    value.includes('//') ||
    value.split('/').some((segment, index) => index > 0 && (segment === '.' || segment === '..'))
  ) {
    throw new SessionError(
      'invalid_argument',
      `${field} must be a normalized absolute POSIX path.`,
    );
  }
  return value;
}

function optionalText(value: string | undefined, field: string, maximum = 200): string | null {
  return value === undefined ? null : requireText(value, field, maximum);
}

export class EnvironmentStore {
  readonly pairing: EnvironmentPairing;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #maxEnvironments: number;
  readonly #mainEnvironment: MainEnvironmentConfiguration | undefined;

  constructor(
    readonly database: DatabaseSync,
    options: EnvironmentStoreOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#maxEnvironments = options.maxEnvironments ?? 32;
    this.#mainEnvironment = options.mainEnvironment;
    if (!Number.isSafeInteger(this.#maxEnvironments) || this.#maxEnvironments <= 0) {
      throw new Error('Environment limit must be a positive safe integer.');
    }
    this.pairing = new EnvironmentPairing(database, {
      ...(options.now ? { now: options.now } : {}),
      ...(options.pairingCredentialTtlMs === undefined
        ? {}
        : { credentialTtlMs: options.pairingCredentialTtlMs }),
    });
  }

  register(input: {
    tenantId: string;
    clientActionId: string;
    name: string;
    recommendedPwd: string;
    kind?: EnvironmentKind;
  }): EnvironmentPairingIssue {
    return this.#register(input, false);
  }

  beginConnection(input: { tenantId: string; clientActionId: string }): EnvironmentPairingIssue {
    return this.#register({ ...input, name: '新设备', recommendedPwd: '/' }, true);
  }

  #register(
    input: {
      tenantId: string;
      clientActionId: string;
      name: string;
      recommendedPwd: string;
      kind?: EnvironmentKind;
    },
    autoDetect: boolean,
  ): EnvironmentPairingIssue {
    const tenantId = requireText(input.tenantId, 'tenantId', 200);
    const name = requireText(input.name, 'name', 200);
    const recommendedPwd = requirePosixPath(input.recommendedPwd, 'recommendedPwd');
    const kind = input.kind ?? 'self_hosted_linux';
    if (kind === 'platform_sandbox')
      throw new SessionError(
        'permission_denied',
        'Platform environments are created only by the platform registry.',
      );
    return this.#action(
      {
        tenantId,
        clientActionId: input.clientActionId,
        method: autoDetect ? 'BeginDeviceConnection' : 'RegisterEnvironment',
        parameters: { name, recommendedPwd, kind, autoDetect },
      },
      pairingResponseSchema,
      () => {
        this.#assertTenant(tenantId);
        const count = z.object({ count: z.number().int().nonnegative() }).parse(
          this.database
            .prepare(
              `SELECT COUNT(*) AS count FROM environments e WHERE tenant_id = ? AND
                 (binding_status = 'active' OR (binding_status = 'pairing' AND EXISTS(
                   SELECT 1 FROM environment_pairing_credentials p WHERE p.env_id = e.env_id
                   AND p.consumed_at IS NULL AND p.invalidated_at IS NULL AND p.expires_at > ?)))`,
            )
            .get(tenantId, this.#now().toISOString()),
        ).count;
        if (count >= this.#maxEnvironments) {
          throw new SessionError(
            'failed_precondition',
            'The tenant environment limit was reached.',
          );
        }
        const configured = this.#mainEnvironment;
        const standaloneRegistration =
          autoDetect &&
          configured !== undefined &&
          this.database
            .prepare('SELECT 1 AS present FROM environments WHERE env_id = ?')
            .get(configured.envId) === undefined;
        const envId = standaloneRegistration ? configured.envId : this.#createId();
        const directory = standaloneRegistration ? configured.workspace : recommendedPwd;
        const now = this.#now().toISOString();
        const authorized = [
          DeviceCapability.BASH,
          DeviceCapability.FILE_READ,
          DeviceCapability.FILE_WRITE,
          DeviceCapability.FILE_EDIT,
          DeviceCapability.DIRECTORY_CHECK,
          DeviceCapability.DIRECTORY_LIST,
        ];
        this.database
          .prepare(
            `INSERT INTO environments(
              env_id, tenant_id, name, kind, recommended_pwd,
              binding_status, connection_status, capability_status, directory_status,
              maintenance_mode, maintenance_version,
              authorized_capabilities_json, granted_capabilities_json,
              device_id, device_binding_id, instance_id,
              daemon_version, os, architecture, status_reason, normalized_pwd, checked_at,
              created_at, updated_at, paired_at, revoked_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, 'pairing', 'offline', 'pending', 'pending',
              'normal', '0', ?, '[]', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
              ?, ?, NULL, NULL, NULL)`,
          )
          .run(envId, tenantId, name, kind, directory, JSON.stringify(authorized), now, now);
        const issued = this.pairing.issue(tenantId, envId);
        if (autoDetect && !standaloneRegistration)
          this.database
            .prepare('UPDATE environments SET auto_detect = 1 WHERE env_id = ?')
            .run(envId);
        return {
          environment: this.get(tenantId, envId),
          pairingCredential: issued.pairingCredential,
          expiresAt: issued.expiresAt,
        };
      },
    );
  }

  cancelConnection(input: {
    tenantId: string;
    clientActionId: string;
    envId: string;
  }): EnvironmentRecord {
    const tenantId = requireText(input.tenantId, 'tenantId', 200);
    const envId = requireText(input.envId, 'envId', 200);
    return this.#action(
      {
        tenantId,
        clientActionId: input.clientActionId,
        method: 'CancelDeviceConnection',
        parameters: { envId },
      },
      environmentRecordSchema,
      () => {
        const row = this.#ownedRow(tenantId, envId);
        if (row.binding_status === 'pairing') this.#revokeState(tenantId, envId);
        return this.get(tenantId, envId);
      },
    );
  }

  updateSettings(input: {
    tenantId: string;
    clientActionId: string;
    envId: string;
    expectedSettingsVersion: bigint;
    name?: string;
    recommendedPwd?: string;
    checkedDirectory?: { normalizedPath: string; deviceBindingId: string; instanceId: string };
  }): EnvironmentRecord {
    const tenantId = requireText(input.tenantId, 'tenantId', 200);
    const envId = requireText(input.envId, 'envId', 200);
    const name = input.name === undefined ? undefined : requireText(input.name.trim(), 'name', 200);
    const recommendedPwd =
      input.recommendedPwd === undefined
        ? undefined
        : requirePosixPath(input.recommendedPwd, 'recommendedPwd');
    if (name === undefined && recommendedPwd === undefined)
      throw new SessionError('invalid_argument', 'No device settings were provided.');
    if (input.expectedSettingsVersion < 0n || input.expectedSettingsVersion >= maximumUint64)
      throw new SessionError('invalid_argument', 'Device settings version is invalid.');
    return this.#action(
      {
        tenantId,
        clientActionId: input.clientActionId,
        method: 'UpdateEnvironment',
        parameters: {
          envId,
          name,
          recommendedPwd,
          expectedSettingsVersion: input.expectedSettingsVersion,
        },
      },
      environmentRecordSchema,
      () => {
        const row = this.#ownedRow(tenantId, envId);
        if (row.binding_status !== 'active')
          throw new SessionError('failed_precondition', 'Device is not connected.');
        if (BigInt(row.settings_version) !== input.expectedSettingsVersion)
          throw new SessionError(
            'version_conflict',
            'Device settings changed. Refresh before saving.',
          );
        const checked = input.checkedDirectory;
        if (
          checked &&
          (row.device_binding_id !== checked.deviceBindingId ||
            row.instance_id !== checked.instanceId ||
            row.connection_status !== 'online')
        )
          throw new SessionError(
            'version_conflict',
            'Device connection changed during directory validation.',
          );
        if (
          recommendedPwd !== undefined &&
          row.connection_status === 'online' &&
          checked === undefined
        )
          throw new SessionError(
            'failed_precondition',
            'An online directory must be validated before saving.',
          );
        const now = this.#now().toISOString();
        this.database
          .prepare(`UPDATE environments SET name = ?, recommended_pwd = ?, settings_version = ?,
        directory_status = ?, normalized_pwd = ?, checked_at = ?, capability_status = ?, status_reason = ?, updated_at = ? WHERE env_id = ?`)
          .run(
            name ?? row.name,
            checked?.normalizedPath ?? recommendedPwd ?? row.recommended_pwd,
            (input.expectedSettingsVersion + 1n).toString(),
            recommendedPwd === undefined ? row.directory_status : checked ? 'ready' : 'pending',
            recommendedPwd === undefined ? row.normalized_pwd : (checked?.normalizedPath ?? null),
            recommendedPwd === undefined ? row.checked_at : checked ? now : null,
            checked ? 'ready' : row.capability_status,
            recommendedPwd === undefined ? row.status_reason : null,
            now,
            envId,
          );
        return this.get(tenantId, envId);
      },
    );
  }

  replaySettingsUpdate(input: {
    tenantId: string;
    clientActionId: string;
    envId: string;
    expectedSettingsVersion: bigint;
    name?: string;
    recommendedPwd?: string;
  }): EnvironmentRecord | undefined {
    this.#assertTenant(input.tenantId);
    const value = this.database
      .prepare(
        'SELECT method, fingerprint, response_json FROM client_actions WHERE owner_id = ? AND client_action_id = ?',
      )
      .get(input.tenantId, input.clientActionId);
    if (value === undefined) return undefined;
    const row = actionRowSchema.parse(value);
    const parameters = {
      envId: input.envId,
      name: input.name?.trim(),
      recommendedPwd: input.recommendedPwd,
      expectedSettingsVersion: input.expectedSettingsVersion,
    };
    const fingerprint = createHash('sha256').update(canonicalJson(parameters)).digest('hex');
    if (row.method !== 'UpdateEnvironment' || row.fingerprint !== fingerprint)
      throw new SessionError(
        'action_conflict',
        'Client action ID was used with different parameters.',
      );
    return environmentRecordSchema.parse(JSON.parse(row.response_json));
  }

  setFavorite(input: {
    tenantId: string;
    clientActionId: string;
    envId: string;
    path: string;
    enabled: boolean;
  }): EnvironmentRecord {
    const tenantId = requireText(input.tenantId, 'tenantId', 200);
    const envId = requireText(input.envId, 'envId', 200);
    const path = requirePosixPath(input.path, 'path');
    return this.#action(
      {
        tenantId,
        clientActionId: input.clientActionId,
        method: 'SetFavoriteDirectory',
        parameters: { envId, path, enabled: input.enabled },
      },
      environmentRecordSchema,
      () => {
        const row = this.#ownedRow(tenantId, envId);
        if (row.binding_status !== 'active')
          throw new SessionError('failed_precondition', 'Device is not connected.');
        if (BigInt(row.settings_version) >= maximumUint64)
          throw new SessionError('failed_precondition', 'Device settings version is exhausted.');
        let changes = 0;
        if (input.enabled) {
          const count = z
            .object({ count: z.number() })
            .parse(
              this.database
                .prepare(
                  'SELECT COUNT(*) AS count FROM environment_favorite_directories WHERE tenant_id = ? AND env_id = ?',
                )
                .get(tenantId, envId),
            ).count;
          if (count >= 32 && !this.get(tenantId, envId).favoriteDirectories.includes(path))
            throw new SessionError(
              'failed_precondition',
              'A device can have at most 32 favorite directories.',
            );
          changes = Number(
            this.database
              .prepare(
                'INSERT OR IGNORE INTO environment_favorite_directories(tenant_id, env_id, path, created_at) VALUES (?, ?, ?, ?)',
              )
              .run(tenantId, envId, path, this.#now().toISOString()).changes,
          );
        } else {
          changes = Number(
            this.database
              .prepare(
                'DELETE FROM environment_favorite_directories WHERE tenant_id = ? AND env_id = ? AND path = ?',
              )
              .run(tenantId, envId, path).changes,
          );
        }
        if (changes > 0)
          this.database
            .prepare(
              'UPDATE environments SET settings_version = ?, updated_at = ? WHERE env_id = ?',
            )
            .run((BigInt(row.settings_version) + 1n).toString(), this.#now().toISOString(), envId);
        return this.get(tenantId, envId);
      },
    );
  }

  list(tenantId: string): { environments: EnvironmentRecord[] } {
    requireText(tenantId, 'tenantId', 200);
    this.#assertTenant(tenantId);
    const rows = this.database
      .prepare('SELECT * FROM environments WHERE tenant_id = ? ORDER BY created_at, env_id')
      .all(tenantId);
    return {
      environments: rows.map((row) => this.#toRecord(environmentRowSchema.parse(row))),
    };
  }

  get(tenantId: string, envId: string): EnvironmentRecord {
    const row = this.#ownedRow(tenantId, envId);
    return this.#toRecord(row);
  }

  reissue(input: {
    tenantId: string;
    clientActionId: string;
    envId: string;
  }): EnvironmentPairingIssue {
    const tenantId = requireText(input.tenantId, 'tenantId', 200);
    const envId = requireText(input.envId, 'envId', 200);
    return this.#action(
      {
        tenantId,
        clientActionId: input.clientActionId,
        method: 'ReissueEnvironmentPairing',
        parameters: { envId },
      },
      pairingResponseSchema,
      () => {
        const current = this.#ownedRow(tenantId, envId);
        const standalone =
          this.#mainEnvironment?.envId === current.env_id ? this.#mainEnvironment : undefined;
        if (current.binding_status === 'revoked' && !standalone) {
          throw new SessionError(
            'failed_precondition',
            'A revoked environment cannot be paired again.',
          );
        }
        if (current.kind === 'platform_sandbox')
          throw new SessionError(
            'permission_denied',
            'Platform pairing is managed by its lifecycle controller.',
          );
        const now = this.#now().toISOString();
        this.pairing.invalidate(envId, now, 'superseded');
        this.database
          .prepare(
            `UPDATE environments SET binding_status = 'pairing', connection_status = 'offline',
             capability_status = 'pending', directory_status = 'pending',
             granted_capabilities_json = '[]', device_id = NULL, device_binding_id = NULL,
             instance_id = NULL, daemon_version = NULL, os = NULL, architecture = NULL,
             recommended_pwd = ?, status_reason = NULL, normalized_pwd = NULL, checked_at = NULL,
             paired_at = NULL, last_seen_at = NULL, updated_at = ? WHERE env_id = ?`,
          )
          .run(standalone?.workspace ?? current.recommended_pwd, now, envId);
        const issued = this.pairing.issue(tenantId, envId);
        return {
          environment: this.get(tenantId, envId),
          pairingCredential: issued.pairingCredential,
          expiresAt: issued.expiresAt,
        };
      },
    );
  }

  revoke(input: { tenantId: string; clientActionId: string; envId: string }): {
    environment: EnvironmentRecord;
  } {
    const tenantId = requireText(input.tenantId, 'tenantId', 200);
    const envId = requireText(input.envId, 'envId', 200);
    return this.#action(
      {
        tenantId,
        clientActionId: input.clientActionId,
        method: 'RevokeEnvironment',
        parameters: { envId },
      },
      revokeResponseSchema,
      () => this.#revokeState(tenantId, envId),
    );
  }

  revokeForBinding(input: { envId: string; deviceBindingId: string; reason?: string }): {
    environment: EnvironmentRecord;
  } {
    const envId = requireText(input.envId, 'envId', 200);
    const deviceBindingId = requireText(input.deviceBindingId, 'deviceBindingId', 200);
    const reason = optionalText(input.reason, 'reason', 500);
    const commit = () => {
      const row = this.#row(envId);
      if (
        row.binding_status !== 'active' ||
        row.device_binding_id !== deviceBindingId ||
        row.device_id === null
      ) {
        throw new SessionError(
          'permission_denied',
          'Only the current environment binding can revoke itself.',
        );
      }
      return this.#revokeState(row.tenant_id, envId, reason);
    };
    return this.database.isTransaction ? commit() : inTransaction(this.database, commit);
  }

  setMaintenance(input: {
    tenantId: string;
    clientActionId: string;
    envId: string;
    mode: EnvironmentMaintenanceMode;
    expectedVersion: bigint;
  }): EnvironmentMaintenance {
    const tenantId = requireText(input.tenantId, 'tenantId', 200);
    const envId = requireText(input.envId, 'envId', 200);
    if (input.expectedVersion < 0n || input.expectedVersion > maximumUint64) {
      throw new SessionError('invalid_argument', 'expectedVersion must be a uint64 value.');
    }
    return this.#action(
      {
        tenantId,
        clientActionId: input.clientActionId,
        method: 'SetEnvironmentMaintenance',
        parameters: { envId, mode: input.mode, expectedVersion: input.expectedVersion },
      },
      maintenanceResponseSchema,
      () => {
        const environment = this.#ownedRow(tenantId, envId);
        if (environment.kind === 'platform_sandbox')
          throw new SessionError(
            'permission_denied',
            'Platform environments do not use device maintenance.',
          );
        if (environment.binding_status !== 'active') {
          throw new SessionError(
            'failed_precondition',
            'Maintenance requires an active environment.',
          );
        }
        const current = BigInt(environment.maintenance_version);
        if (current !== input.expectedVersion) {
          throw new SessionError(
            'version_conflict',
            'Environment maintenance version has changed.',
          );
        }
        if (current === maximumUint64) {
          throw new SessionError(
            'version_conflict',
            'Environment maintenance version is exhausted.',
          );
        }
        const maintenanceVersion = (current + 1n).toString();
        const now = this.#now().toISOString();
        const updated = this.database
          .prepare(
            `UPDATE environments SET maintenance_mode = ?, maintenance_version = ?, updated_at = ?
             WHERE env_id = ? AND maintenance_version = ? AND binding_status = 'active'`,
          )
          .run(input.mode, maintenanceVersion, now, envId, environment.maintenance_version);
        if (updated.changes !== 1) {
          throw new SessionError(
            'version_conflict',
            'Environment maintenance version has changed.',
          );
        }
        return { envId, mode: input.mode, maintenanceVersion };
      },
    );
  }

  maintenanceForBinding(input: { envId: string; deviceBindingId: string }): EnvironmentMaintenance {
    const row = this.#row(requireText(input.envId, 'envId', 200));
    if (row.binding_status !== 'active' || row.device_binding_id !== input.deviceBindingId) {
      throw new SessionError('permission_denied', 'Environment binding is not active.');
    }
    return {
      envId: row.env_id,
      mode: row.maintenance_mode,
      maintenanceVersion: row.maintenance_version,
    };
  }

  exchangePairing(input: EnvironmentPairingExchangeInput): EnvironmentPairingExchange {
    return this.pairing.exchange(input);
  }

  markConnected(input: {
    envId: string;
    deviceId: string;
    deviceBindingId: string;
    instanceId: string;
    reportedCapabilities: readonly DeviceCapability[];
    daemonVersion?: string | undefined;
    os?: string | undefined;
    architecture?: string | undefined;
  }): EnvironmentRecord {
    const envId = requireText(input.envId, 'envId', 200);
    const deviceId = requireText(input.deviceId, 'deviceId', 200);
    const deviceBindingId = requireText(input.deviceBindingId, 'deviceBindingId', 200);
    const instanceId = requireText(input.instanceId, 'instanceId', 200);
    const reported = capabilitiesSchema.parse(input.reportedCapabilities);
    return inTransaction(this.database, () => {
      const row = this.#row(envId);
      if (
        row.binding_status !== 'active' ||
        row.device_id !== deviceId ||
        row.device_binding_id !== deviceBindingId
      ) {
        throw new SessionError('permission_denied', 'Environment binding is not active.');
      }
      const authorized = parseCapabilities(row.authorized_capabilities_json);
      const requested = new Set(reported);
      const granted = authorized.filter((capability) => requested.has(capability));
      const changed =
        row.instance_id !== instanceId ||
        JSON.stringify(parseCapabilities(row.granted_capabilities_json)) !==
          JSON.stringify(granted);
      const now = this.#now().toISOString();
      this.database
        .prepare(
          `UPDATE environments SET connection_status = 'online', instance_id = ?,
           granted_capabilities_json = ?,
           capability_status = ?, directory_status = ?, normalized_pwd = ?,
           status_reason = ?, checked_at = ?, daemon_version = ?, os = ?, architecture = ?,
           last_seen_at = ?, updated_at = ? WHERE env_id = ?`,
        )
        .run(
          instanceId,
          JSON.stringify(granted),
          changed ? 'pending' : row.capability_status,
          changed ? 'pending' : row.directory_status,
          changed ? null : row.normalized_pwd,
          changed ? null : row.status_reason,
          changed ? null : row.checked_at,
          optionalText(input.daemonVersion, 'daemonVersion') ?? row.daemon_version,
          optionalText(input.os, 'os') ?? row.os,
          optionalText(input.architecture, 'architecture') ?? row.architecture,
          now,
          now,
          envId,
        );
      this.database
        .prepare(
          `UPDATE environment_device_bindings SET granted_capabilities_json = ?,
           last_seen_at = ?, updated_at = ? WHERE device_binding_id = ? AND status = 'active'`,
        )
        .run(JSON.stringify(granted), now, now, deviceBindingId);
      return this.get(row.tenant_id, envId);
    });
  }

  markDisconnected(input: {
    envId: string;
    deviceBindingId: string;
    instanceId: string;
  }): EnvironmentRecord {
    const envId = requireText(input.envId, 'envId', 200);
    const now = this.#now().toISOString();
    const row = this.#row(envId);
    this.database
      .prepare(
        `UPDATE environments SET connection_status = 'offline', updated_at = ?
         WHERE env_id = ? AND device_binding_id = ? AND instance_id = ? AND binding_status = 'active'`,
      )
      .run(now, envId, input.deviceBindingId, input.instanceId);
    return this.get(row.tenant_id, envId);
  }

  recordReadiness(input: {
    envId: string;
    deviceId: string;
    deviceBindingId: string;
    instanceId: string;
    reportedCapabilities: readonly DeviceCapability[];
    directoryStatus: 'ready' | 'failed';
    normalizedPwd?: string | undefined;
    statusReason?: string | undefined;
    daemonVersion?: string | undefined;
    os?: string | undefined;
    architecture?: string | undefined;
  }): EnvironmentRecord {
    const envId = requireText(input.envId, 'envId', 200);
    const reported = capabilitiesSchema.parse(input.reportedCapabilities);
    const normalizedPwd =
      input.directoryStatus === 'ready'
        ? requirePosixPath(input.normalizedPwd ?? '', 'normalizedPwd')
        : null;
    if (input.directoryStatus === 'failed' || input.statusReason !== undefined) {
      requireText(input.statusReason ?? '', 'statusReason', 500);
    }
    return inTransaction(this.database, () => {
      const row = this.#row(envId);
      if (
        row.binding_status !== 'active' ||
        row.connection_status !== 'online' ||
        row.device_id !== input.deviceId ||
        row.device_binding_id !== input.deviceBindingId ||
        row.instance_id !== input.instanceId
      ) {
        throw new SessionError(
          'version_conflict',
          'Environment connection or binding has changed.',
        );
      }
      const authorized = parseCapabilities(row.authorized_capabilities_json);
      const requested = new Set(reported);
      const granted = authorized.filter((capability) => requested.has(capability));
      const capabilityStatus = granted.includes(DeviceCapability.DIRECTORY_CHECK)
        ? 'ready'
        : 'failed';
      const statusReason = input.statusReason ?? null;
      if (capabilityStatus === 'failed' && statusReason === null) {
        throw new SessionError(
          'failed_precondition',
          'A failed capability check requires a status reason.',
        );
      }
      const now = this.#now().toISOString();
      this.database
        .prepare(
          `UPDATE environments SET capability_status = ?, directory_status = ?,
           granted_capabilities_json = ?, normalized_pwd = ?, status_reason = ?, checked_at = ?,
           daemon_version = ?, os = ?, architecture = ?, updated_at = ? WHERE env_id = ?`,
        )
        .run(
          capabilityStatus,
          input.directoryStatus,
          JSON.stringify(granted),
          normalizedPwd,
          statusReason,
          now,
          optionalText(input.daemonVersion, 'daemonVersion') ?? row.daemon_version,
          optionalText(input.os, 'os') ?? row.os,
          optionalText(input.architecture, 'architecture') ?? row.architecture,
          now,
          envId,
        );
      this.database
        .prepare(
          `UPDATE environment_device_bindings SET granted_capabilities_json = ?, updated_at = ?
           WHERE device_binding_id = ? AND status = 'active'`,
        )
        .run(JSON.stringify(granted), now, input.deviceBindingId);
      return this.get(row.tenant_id, envId);
    });
  }

  requireReady(tenantId: string, envId: string): EnvironmentRecord {
    const environment = this.get(tenantId, envId);
    if (!environment.ready) {
      throw new SessionError(
        'failed_precondition',
        'Environment is not ready: active binding, online instance, capability check and directory check are required.',
      );
    }
    return environment;
  }

  #assertTenant(tenantId: string): void {
    const row = this.database
      .prepare(
        `SELECT t.tenant_id FROM tenants t JOIN users u ON u.tenant_id = t.tenant_id
         WHERE t.tenant_id = ? AND u.status = 'active'`,
      )
      .get(tenantId);
    if (row === undefined) {
      throw new SessionError('permission_denied', 'The tenant is not active.');
    }
  }

  #row(envId: string): EnvironmentRow {
    requireText(envId, 'envId', 200);
    const row = this.database.prepare('SELECT * FROM environments WHERE env_id = ?').get(envId);
    if (row === undefined) throw new SessionError('not_found', 'Environment was not found.');
    return environmentRowSchema.parse(row);
  }

  #ownedRow(tenantId: string, envId: string): EnvironmentRow {
    requireText(tenantId, 'tenantId', 200);
    const row = this.#row(envId);
    if (row.tenant_id !== tenantId) {
      throw new SessionError('permission_denied', 'Environment is not available to this tenant.');
    }
    return row;
  }

  #toRecord(row: EnvironmentRow): EnvironmentRecord {
    return {
      envId: row.env_id,
      tenantId: row.tenant_id,
      name: row.name,
      autoDetect: row.auto_detect === 1,
      settingsVersion: row.settings_version,
      favoriteDirectories: this.database
        .prepare(
          'SELECT path FROM environment_favorite_directories WHERE tenant_id = ? AND env_id = ? ORDER BY created_at, path',
        )
        .all(row.tenant_id, row.env_id)
        .map((value) => z.object({ path: z.string() }).parse(value).path),
      kind: row.kind,
      lifecycleState: row.platform_lifecycle_state,
      recommendedPwd: row.recommended_pwd,
      bindingStatus: row.binding_status,
      connectionStatus: row.connection_status,
      capabilityStatus: row.capability_status,
      directoryStatus: row.directory_status,
      maintenanceMode: row.maintenance_mode,
      maintenanceVersion: row.maintenance_version,
      authorizedCapabilities: parseCapabilities(row.authorized_capabilities_json),
      grantedCapabilities: parseCapabilities(row.granted_capabilities_json),
      ...(row.device_id === null ? {} : { deviceId: row.device_id }),
      ...(row.device_binding_id === null ? {} : { deviceBindingId: row.device_binding_id }),
      ...(row.instance_id === null ? {} : { instanceId: row.instance_id }),
      ...(row.daemon_version === null ? {} : { daemonVersion: row.daemon_version }),
      ...(row.os === null ? {} : { os: row.os }),
      ...(row.architecture === null ? {} : { architecture: row.architecture }),
      ...(row.status_reason === null ? {} : { statusReason: row.status_reason }),
      ...(row.normalized_pwd === null ? {} : { normalizedPwd: row.normalized_pwd }),
      ...(row.checked_at === null ? {} : { checkedAt: row.checked_at }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.paired_at === null ? {} : { pairedAt: row.paired_at }),
      ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
      ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
      ready:
        row.binding_status === 'active' &&
        row.connection_status === 'online' &&
        row.capability_status === 'ready' &&
        row.directory_status === 'ready',
    };
  }

  #revokeState(
    tenantId: string,
    envId: string,
    reason: string | null = null,
  ): { environment: EnvironmentRecord } {
    const row = this.#ownedRow(tenantId, envId);
    if (row.env_id === this.#mainEnvironment?.envId)
      throw new SessionError('permission_denied', 'The main environment cannot be revoked.');
    const now = this.#now().toISOString();
    if (row.binding_status !== 'revoked') {
      this.pairing.invalidate(envId, now, 'revoked');
      this.database
        .prepare(
          `UPDATE environments SET binding_status = 'revoked', connection_status = 'offline',
           granted_capabilities_json = '[]', device_id = NULL, device_binding_id = NULL,
           instance_id = NULL, status_reason = ?, revoked_at = ?, updated_at = ? WHERE env_id = ?`,
        )
        .run(reason, now, now, envId);
    }
    return {
      environment: this.get(tenantId, envId),
    };
  }

  #action<T>(action: EnvironmentAction, responseSchema: z.ZodType<T>, work: () => T): T {
    requireText(action.tenantId, 'tenantId', 200);
    requireText(action.clientActionId, 'clientActionId', 200);
    const fingerprint = createHash('sha256').update(canonicalJson(action.parameters)).digest('hex');
    return inTransaction(this.database, () => {
      const row = this.database
        .prepare(
          'SELECT method, fingerprint, response_json FROM client_actions WHERE owner_id = ? AND client_action_id = ?',
        )
        .get(action.tenantId, action.clientActionId);
      if (row !== undefined) {
        const existing = actionRowSchema.parse(row);
        if (existing.method !== action.method || existing.fingerprint !== fingerprint) {
          throw new SessionError(
            'action_conflict',
            'The client action ID was already used with different parameters.',
            { clientActionId: action.clientActionId },
          );
        }
        return responseSchema.parse(JSON.parse(existing.response_json));
      }
      const response = work();
      this.database
        .prepare(
          'INSERT INTO client_actions(owner_id, client_action_id, method, fingerprint, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          action.tenantId,
          action.clientActionId,
          action.method,
          fingerprint,
          JSON.stringify(response),
          this.#now().toISOString(),
        );
      return response;
    });
  }
}
