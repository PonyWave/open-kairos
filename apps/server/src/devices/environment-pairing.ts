import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type DeviceCapability,
  DeviceErrorAction,
  DeviceErrorCode,
  isDeviceCapability,
} from '@kairos/contracts/device';
import { z } from 'zod';
import { inTransaction } from '../storage/transaction.js';
import { DeviceFailure } from './errors.js';

const pairingCredentialRowSchema = z.object({
  credential_id: z.string(),
  tenant_id: z.string(),
  env_id: z.string(),
  purpose: z.literal('daemon_pairing'),
  expires_at: z.string(),
  consumed_at: z.string().nullable(),
  invalidated_at: z.string().nullable(),
});

const environmentRowSchema = z.object({
  tenant_id: z.string(),
  kind: z.enum(['self_hosted_linux', 'self_hosted_macos', 'platform_sandbox']),
  binding_status: z.enum(['pairing', 'active', 'revoked']),
  authorized_capabilities_json: z.string(),
  auto_detect: z.number().int().min(0).max(1),
  name: z.string(),
  recommended_pwd: z.string(),
});

const bindingRowSchema = z.object({
  tenant_id: z.string(),
  env_id: z.string(),
  device_id: z.string(),
  device_binding_id: z.string(),
  credential_hash: z.string().nullable(),
  status: z.enum(['active', 'superseded', 'revoked']),
  environment_status: z.enum(['pairing', 'active', 'revoked']),
  current_device_id: z.string().nullable(),
  current_device_binding_id: z.string().nullable(),
  granted_capabilities_json: z.string(),
});

const capabilitySchema = z.number().int().refine(isDeviceCapability);
const capabilitiesSchema = z.array(capabilitySchema);

export interface EnvironmentPairingIssue {
  credentialId: string;
  pairingCredential: string;
  expiresAt: string;
}

export interface EnvironmentPairingExchangeInput {
  envId: string;
  pairingCredential: string;
  reportedCapabilities: readonly DeviceCapability[];
  daemonVersion?: string;
  os?: string;
  architecture?: string;
  deviceName?: string;
  homeDirectory?: string;
}

export interface EnvironmentAuthentication {
  tenantId: string;
  envId: string;
  deviceId: string;
  deviceBindingId: string;
  grantedCapabilities: DeviceCapability[];
}

export interface EnvironmentPairingExchange extends EnvironmentAuthentication {
  deviceCredential: string;
}

export interface EnvironmentPairingOptions {
  now?: () => Date;
  credentialTtlMs?: number;
}

function authenticationError(): DeviceFailure {
  return new DeviceFailure(
    DeviceErrorCode.UNAUTHENTICATED,
    'Environment pairing authentication failed.',
    DeviceErrorAction.REAUTHENTICATE,
  );
}

function credentialHash(kind: 'pairing' | 'device', credential: string): string {
  return createHash('sha256').update(`kairos-environment-${kind}\0${credential}`).digest('hex');
}

function createCredential(prefix: 'ke2' | 'kd2'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

function requiredText(value: string, maximum = 200): string {
  if (!value.trim() || value.length > maximum || value.includes('\0')) throw authenticationError();
  return value;
}

function parseCapabilities(value: string): DeviceCapability[] {
  return capabilitiesSchema.parse(JSON.parse(value));
}

function validateCapabilities(capabilities: readonly DeviceCapability[]): DeviceCapability[] {
  return capabilitiesSchema.parse(capabilities);
}

export class EnvironmentPairing {
  readonly #now: () => Date;
  readonly #credentialTtlMs: number;

  constructor(
    readonly database: DatabaseSync,
    options: EnvironmentPairingOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#credentialTtlMs = options.credentialTtlMs ?? 10 * 60 * 1000;
    if (
      !Number.isSafeInteger(this.#credentialTtlMs) ||
      this.#credentialTtlMs <= 0 ||
      this.#credentialTtlMs > 60 * 60 * 1000
    ) {
      throw new Error('Environment pairing credential lifetime must be between 1 ms and 1 hour.');
    }
  }

  issue(tenantId: string, envId: string): EnvironmentPairingIssue {
    const now = this.#now();
    const pairingCredential = createCredential('ke2');
    const issue = {
      credentialId: randomUUID(),
      pairingCredential,
      expiresAt: new Date(now.getTime() + this.#credentialTtlMs).toISOString(),
    };
    this.database
      .prepare(
        `INSERT INTO environment_pairing_credentials(
          credential_id, tenant_id, env_id, purpose, credential_hash,
          created_at, expires_at, consumed_at, invalidated_at
        ) VALUES (?, ?, ?, 'daemon_pairing', ?, ?, ?, NULL, NULL)`,
      )
      .run(
        issue.credentialId,
        tenantId,
        envId,
        credentialHash('pairing', pairingCredential),
        now.toISOString(),
        issue.expiresAt,
      );
    return issue;
  }
  reissueUnusedInitialization(tenantId: string, envId: string): EnvironmentPairingIssue {
    return inTransaction(this.database, () => {
      const environment = this.database
        .prepare(
          'SELECT kind,binding_status,device_binding_id FROM environments WHERE tenant_id=? AND env_id=?',
        )
        .get(tenantId, envId);
      if (
        environment?.kind !== 'platform_sandbox' ||
        environment.binding_status !== 'pairing' ||
        environment.device_binding_id !== null
      )
        throw authenticationError();
      this.database
        .prepare(
          'UPDATE environment_pairing_credentials SET invalidated_at=? WHERE tenant_id=? AND env_id=? AND consumed_at IS NULL AND invalidated_at IS NULL',
        )
        .run(this.#now().toISOString(), tenantId, envId);
      return this.issue(tenantId, envId);
    });
  }

  invalidate(envId: string, now: string, bindingStatus: 'superseded' | 'revoked'): void {
    this.database
      .prepare(
        `UPDATE environment_pairing_credentials SET invalidated_at = ?
         WHERE env_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL`,
      )
      .run(now, envId);
    this.database
      .prepare(
        `UPDATE environment_device_bindings SET status = ?, credential_hash = NULL,
         revoked_at = ?, updated_at = ? WHERE env_id = ? AND status = 'active'`,
      )
      .run(bindingStatus, now, now, envId);
  }

  preview(input: EnvironmentPairingExchangeInput): { tenantId: string; envId: string } {
    const envId = requiredText(input.envId);
    const credentialText = requiredText(input.pairingCredential, 512);
    validateCapabilities(input.reportedCapabilities);
    const raw = this.database
      .prepare('SELECT * FROM environment_pairing_credentials WHERE credential_hash=?')
      .get(credentialHash('pairing', credentialText));
    const credential = raw === undefined ? undefined : pairingCredentialRowSchema.parse(raw);
    const row = this.database
      .prepare(
        `SELECT e.* FROM environments e JOIN users u ON u.tenant_id=e.tenant_id AND u.status='active' WHERE e.env_id=?`,
      )
      .get(envId);
    if (
      !credential ||
      credential.env_id !== envId ||
      credential.consumed_at !== null ||
      credential.invalidated_at !== null ||
      Date.parse(credential.expires_at) <= this.#now().getTime() ||
      !Number.isFinite(Date.parse(credential.expires_at)) ||
      row?.tenant_id !== credential.tenant_id ||
      row.binding_status !== 'pairing'
    )
      throw authenticationError();
    const environment = environmentRowSchema.parse(row);
    parseCapabilities(environment.authorized_capabilities_json);
    if (input.os !== undefined) {
      if (environment.auto_detect === 1) {
        if (
          !input.deviceName ||
          !input.homeDirectory?.startsWith('/') ||
          !['linux', 'ubuntu', 'darwin'].includes(input.os)
        )
          throw authenticationError();
      } else if (
        environment.kind === 'self_hosted_macos'
          ? input.os !== 'darwin'
          : !['linux', 'ubuntu'].includes(input.os)
      )
        throw authenticationError();
    }
    return { tenantId: credential.tenant_id, envId };
  }

  exchange(input: EnvironmentPairingExchangeInput): EnvironmentPairingExchange {
    const envId = requiredText(input.envId);
    const pairingCredential = requiredText(input.pairingCredential, 512);
    const reportedCapabilities = validateCapabilities(input.reportedCapabilities);
    const now = this.#now();
    const nowText = now.toISOString();
    return inTransaction(this.database, () => {
      const credentialRow = this.database
        .prepare('SELECT * FROM environment_pairing_credentials WHERE credential_hash = ?')
        .get(credentialHash('pairing', pairingCredential));
      const credential =
        credentialRow === undefined ? undefined : pairingCredentialRowSchema.parse(credentialRow);
      if (
        credential?.env_id !== envId ||
        credential.purpose !== 'daemon_pairing' ||
        credential.consumed_at !== null ||
        credential.invalidated_at !== null ||
        !Number.isFinite(Date.parse(credential.expires_at)) ||
        Date.parse(credential.expires_at) <= now.getTime()
      ) {
        throw authenticationError();
      }
      const environmentRow = this.database
        .prepare(
          `SELECT e.tenant_id, e.kind, e.binding_status, e.authorized_capabilities_json,
           e.auto_detect, e.name, e.recommended_pwd
           FROM environments e
           JOIN users u ON u.tenant_id = e.tenant_id AND u.status = 'active'
           WHERE e.env_id = ?`,
        )
        .get(envId);
      const environment =
        environmentRow === undefined ? undefined : environmentRowSchema.parse(environmentRow);
      if (
        environment?.tenant_id !== credential.tenant_id ||
        environment.binding_status !== 'pairing'
      ) {
        throw authenticationError();
      }
      let kind = environment.kind;
      let name = environment.name;
      let recommendedPwd = environment.recommended_pwd;
      if (environment.auto_detect === 1) {
        name = requiredText(input.deviceName ?? '');
        const home = requiredText(input.homeDirectory ?? '', 4096);
        if (!home.startsWith('/')) throw authenticationError();
        recommendedPwd = posix.normalize(home);
        if (input.os === 'darwin') kind = 'self_hosted_macos';
        else if (input.os === 'linux' || input.os === 'ubuntu') kind = 'self_hosted_linux';
        else throw authenticationError();
      }
      if (
        input.os !== undefined &&
        (kind === 'self_hosted_macos'
          ? input.os !== 'darwin'
          : input.os !== 'linux' && input.os !== 'ubuntu')
      ) {
        throw authenticationError();
      }
      const authorized = parseCapabilities(environment.authorized_capabilities_json);
      const requested = new Set(reportedCapabilities);
      const grantedCapabilities = authorized.filter((capability) => requested.has(capability));
      const deviceId = randomUUID();
      const deviceBindingId = randomUUID();
      const deviceCredential = createCredential('kd2');
      const consumed = this.database
        .prepare(
          `UPDATE environment_pairing_credentials SET consumed_at = ?
           WHERE credential_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL`,
        )
        .run(nowText, credential.credential_id);
      if (consumed.changes !== 1) throw authenticationError();
      this.database
        .prepare(
          `INSERT INTO environment_device_bindings(
            device_binding_id, tenant_id, env_id, device_id, credential_hash, status,
            granted_capabilities_json, created_at, updated_at, paired_at, revoked_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          deviceBindingId,
          credential.tenant_id,
          envId,
          deviceId,
          credentialHash('device', deviceCredential),
          JSON.stringify(grantedCapabilities),
          nowText,
          nowText,
          nowText,
        );
      const activated = this.database
        .prepare(
          `UPDATE environments SET binding_status = 'active', connection_status = 'offline',
           name = ?, kind = ?, recommended_pwd = ?, auto_detect = 0,
           capability_status = 'pending', directory_status = 'pending',
           granted_capabilities_json = ?, device_id = ?, device_binding_id = ?, instance_id = NULL,
           daemon_version = ?, os = ?, architecture = ?, status_reason = NULL,
           normalized_pwd = NULL, checked_at = NULL, paired_at = ?, revoked_at = NULL,
           last_seen_at = NULL, updated_at = ?
           WHERE env_id = ? AND binding_status = 'pairing'`,
        )
        .run(
          name,
          kind,
          recommendedPwd,
          JSON.stringify(grantedCapabilities),
          deviceId,
          deviceBindingId,
          input.daemonVersion ?? null,
          input.os ?? null,
          input.architecture ?? null,
          nowText,
          nowText,
          envId,
        );
      if (activated.changes !== 1) throw authenticationError();
      return {
        tenantId: credential.tenant_id,
        envId,
        deviceId,
        deviceBindingId,
        deviceCredential,
        grantedCapabilities,
      };
    });
  }

  authenticate(input: {
    envId: string;
    deviceId: string;
    deviceBindingId: string;
    deviceCredential: string;
  }): EnvironmentAuthentication {
    const envId = requiredText(input.envId);
    const deviceId = requiredText(input.deviceId);
    const deviceBindingId = requiredText(input.deviceBindingId);
    const deviceCredential = requiredText(input.deviceCredential, 512);
    const row = this.database
      .prepare(
        `SELECT b.tenant_id, b.env_id, b.device_id, b.device_binding_id, b.credential_hash,
         b.status, b.granted_capabilities_json, e.binding_status AS environment_status,
         e.device_id AS current_device_id, e.device_binding_id AS current_device_binding_id
         FROM environment_device_bindings b
         JOIN environments e ON e.env_id = b.env_id
         WHERE b.env_id = ? AND b.device_id = ? AND b.device_binding_id = ?`,
      )
      .get(envId, deviceId, deviceBindingId);
    const binding = row === undefined ? undefined : bindingRowSchema.parse(row);
    if (binding?.environment_status === 'revoked' || binding?.status === 'revoked') {
      throw new DeviceFailure(
        DeviceErrorCode.ENVIRONMENT_REVOKED,
        'Environment binding has been revoked.',
        DeviceErrorAction.REAUTHENTICATE,
      );
    }
    const expected = Buffer.from(binding?.credential_hash ?? '', 'hex');
    const supplied = Buffer.from(credentialHash('device', deviceCredential), 'hex');
    if (
      binding === undefined ||
      binding.tenant_id.length === 0 ||
      binding.environment_status !== 'active' ||
      binding.status !== 'active' ||
      binding.current_device_id !== deviceId ||
      binding.current_device_binding_id !== deviceBindingId ||
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    ) {
      throw authenticationError();
    }
    return {
      tenantId: binding.tenant_id,
      envId,
      deviceId,
      deviceBindingId,
      grantedCapabilities: parseCapabilities(binding.granted_capabilities_json),
    };
  }
}
