import type { DatabaseSync } from 'node:sqlite';
import { DeviceCapability, DeviceErrorCode } from '@kairos/contracts/device';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { EnvironmentStore } from './environment-store.js';

const databases: DatabaseSync[] = [];
const initialTime = '2026-11-05T12:00:00.000Z';

function seedTenant(database: DatabaseSync, tenantId: string): void {
  const userId = `user-${tenantId}`;
  database
    .prepare(
      `INSERT INTO users(
        user_id, email, email_verified_at, username, tenant_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, 'active', ?, ?)`,
    )
    .run(userId, `${tenantId}@example.com`, initialTime, tenantId, initialTime, initialTime);
  database
    .prepare(
      'INSERT INTO tenants(tenant_id, user_id, default_env_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
    )
    .run(tenantId, userId, initialTime, initialTime);
  database.prepare('UPDATE users SET tenant_id = ? WHERE user_id = ?').run(tenantId, userId);
}

function fixture() {
  let time = new Date(initialTime);
  const database = openDatabase(':memory:');
  databases.push(database);
  new SessionStore(database);
  seedTenant(database, 'tenant-1');
  seedTenant(database, 'tenant-2');
  const store = new EnvironmentStore(database, {
    now: () => time,
    pairingCredentialTtlMs: 1000,
  });
  return {
    database,
    store,
    advance(milliseconds: number) {
      time = new Date(time.getTime() + milliseconds);
    },
  };
}

function issue(store: EnvironmentStore, tenantId: string, actionId: string) {
  return store.register({
    tenantId,
    clientActionId: actionId,
    name: actionId,
    recommendedPwd: '/srv/kairos',
  });
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('EnvironmentPairing credential boundaries', () => {
  it('binds purpose, tenant, environment and expiry to a one-time credential', () => {
    const current = fixture();
    const issued = issue(current.store, 'tenant-1', 'pairing-expiry');
    const other = issue(current.store, 'tenant-2', 'pairing-other-tenant');
    expect(() =>
      current.store.exchangePairing({
        envId: other.environment.envId,
        pairingCredential: issued.pairingCredential,
        reportedCapabilities: [DeviceCapability.DIRECTORY_CHECK],
      }),
    ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.UNAUTHENTICATED }));

    current.advance(1000);
    expect(() =>
      current.store.exchangePairing({
        envId: issued.environment.envId,
        pairingCredential: issued.pairingCredential,
        reportedCapabilities: [DeviceCapability.DIRECTORY_CHECK],
      }),
    ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.UNAUTHENTICATED }));
    expect(current.store.get('tenant-1', issued.environment.envId).bindingStatus).toBe('pairing');
    expect(current.store.list('tenant-1')).not.toHaveProperty('defaultEnvId');
  });

  it('rejects replay and stores only credential hashes outside action responses', () => {
    const current = fixture();
    const issued = issue(current.store, 'tenant-1', 'pairing-replay');
    const exchanged = current.store.exchangePairing({
      envId: issued.environment.envId,
      pairingCredential: issued.pairingCredential,
      reportedCapabilities: [DeviceCapability.DIRECTORY_CHECK, DeviceCapability.BASH],
    });
    expect(exchanged.grantedCapabilities).toEqual([
      DeviceCapability.BASH,
      DeviceCapability.DIRECTORY_CHECK,
    ]);
    expect(exchanged.deviceCredential).not.toBe(issued.pairingCredential);
    expect(() =>
      current.store.exchangePairing({
        envId: issued.environment.envId,
        pairingCredential: issued.pairingCredential,
        reportedCapabilities: [DeviceCapability.DIRECTORY_CHECK],
      }),
    ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.UNAUTHENTICATED }));

    const pairingRow = current.database
      .prepare(
        'SELECT credential_hash, consumed_at FROM environment_pairing_credentials WHERE env_id = ?',
      )
      .get(issued.environment.envId);
    expect(pairingRow).not.toMatchObject({ credential_hash: issued.pairingCredential });
    expect(pairingRow).toMatchObject({ consumed_at: initialTime });
    const bindingRow = current.database
      .prepare(
        'SELECT credential_hash FROM environment_device_bindings WHERE device_binding_id = ?',
      )
      .get(exchanged.deviceBindingId);
    expect(bindingRow).not.toMatchObject({ credential_hash: exchanged.deviceCredential });
    expect(
      current.database
        .prepare('SELECT response_json FROM client_actions WHERE client_action_id = ?')
        .get('pairing-replay'),
    ).toMatchObject({ response_json: expect.stringContaining(issued.pairingCredential) });
    expect(current.store.list('tenant-2')).not.toHaveProperty('defaultEnvId');
  });

  it('derives tenant authorization from the stored binding rather than device input', () => {
    const current = fixture();
    const first = issue(current.store, 'tenant-1', 'pairing-identity-1');
    const second = issue(current.store, 'tenant-2', 'pairing-identity-2');
    const exchanged = current.store.exchangePairing({
      envId: first.environment.envId,
      pairingCredential: first.pairingCredential,
      reportedCapabilities: [DeviceCapability.DIRECTORY_CHECK],
    });
    const authenticated = current.store.pairing.authenticate({
      envId: first.environment.envId,
      deviceId: exchanged.deviceId,
      deviceBindingId: exchanged.deviceBindingId,
      deviceCredential: exchanged.deviceCredential,
    });
    expect(authenticated.tenantId).toBe('tenant-1');
    expect(authenticated.envId).toBe(first.environment.envId);
    for (const input of [
      {
        envId: second.environment.envId,
        deviceId: exchanged.deviceId,
        deviceBindingId: exchanged.deviceBindingId,
        deviceCredential: exchanged.deviceCredential,
      },
      {
        envId: first.environment.envId,
        deviceId: exchanged.deviceId,
        deviceBindingId: exchanged.deviceBindingId,
        deviceCredential: 'kd2_incorrect',
      },
    ]) {
      expect(() => current.store.pairing.authenticate(input)).toThrowError(
        expect.objectContaining({ code: DeviceErrorCode.UNAUTHENTICATED }),
      );
    }
  });
});

describe('EnvironmentPairing tenant status', () => {
  it('does not consume a credential for a disabled tenant', () => {
    const current = fixture();
    const issued = issue(current.store, 'tenant-1', 'pairing-disabled-tenant');
    current.database
      .prepare("UPDATE users SET status = 'disabled' WHERE tenant_id = ?")
      .run('tenant-1');
    expect(() =>
      current.store.exchangePairing({
        envId: issued.environment.envId,
        pairingCredential: issued.pairingCredential,
        reportedCapabilities: [DeviceCapability.DIRECTORY_CHECK],
      }),
    ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.UNAUTHENTICATED }));
    expect(
      current.database
        .prepare('SELECT consumed_at FROM environment_pairing_credentials WHERE env_id = ?')
        .get(issued.environment.envId),
    ).toEqual({ consumed_at: null });
  });
});
