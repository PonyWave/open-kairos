import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { DeviceCapability, DeviceErrorCode } from '@kairos/contracts/device';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { EnvironmentStore } from './environment-store.js';
import { ensureMainEnvironment } from './main-environment.js';

const databases: DatabaseSync[] = [];
const allCapabilities = [
  DeviceCapability.BASH,
  DeviceCapability.FILE_READ,
  DeviceCapability.FILE_WRITE,
  DeviceCapability.FILE_EDIT,
  DeviceCapability.DIRECTORY_CHECK,
];
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

function fixture(now: () => Date = () => new Date(initialTime)) {
  const database = openDatabase(':memory:');
  databases.push(database);
  new SessionStore(database);
  seedTenant(database, 'tenant-1');
  seedTenant(database, 'tenant-2');
  const store = new EnvironmentStore(database, {
    now,
    pairingCredentialTtlMs: 60_000,
  });
  return { database, store };
}

function register(store: EnvironmentStore, tenantId: string, actionId: string, name = actionId) {
  return store.register({
    tenantId,
    clientActionId: actionId,
    name,
    recommendedPwd: '/srv/kairos',
  });
}

function exchange(store: EnvironmentStore, envId: string, pairingCredential: string) {
  return store.exchangePairing({
    envId,
    pairingCredential,
    reportedCapabilities: allCapabilities,
    daemonVersion: '2.0.0-test',
    os: 'ubuntu',
    architecture: 'x86_64',
  });
}

function connectAndCheck(
  store: EnvironmentStore,
  exchanged: ReturnType<typeof exchange>,
  instanceId = 'instance-1',
) {
  store.markConnected({ ...exchanged, instanceId, reportedCapabilities: allCapabilities });
  return store.recordReadiness({
    ...exchanged,
    instanceId,
    reportedCapabilities: allCapabilities,
    directoryStatus: 'ready',
    normalizedPwd: '/srv/kairos',
  });
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('EnvironmentStore registration and idempotency', () => {
  it('registers macOS environments and checks the reported operating system', () => {
    const { store } = fixture();
    const issued = store.register({
      tenantId: 'tenant-1',
      clientActionId: 'register-macos',
      name: '本地 Mac',
      recommendedPwd: '/Users/test/Kairos',
      kind: 'self_hosted_macos',
    });
    expect(issued.environment).toMatchObject({
      name: '本地 Mac',
      kind: 'self_hosted_macos',
      recommendedPwd: '/Users/test/Kairos',
    });
    expect(() =>
      store.exchangePairing({
        envId: issued.environment.envId,
        pairingCredential: issued.pairingCredential,
        reportedCapabilities: allCapabilities,
        os: 'linux',
        architecture: 'x86_64',
      }),
    ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.UNAUTHENTICATED }));

    const exchanged = store.exchangePairing({
      envId: issued.environment.envId,
      pairingCredential: issued.pairingCredential,
      reportedCapabilities: allCapabilities,
      os: 'darwin',
      architecture: 'arm64',
    });
    expect(exchanged.envId).toBe(issued.environment.envId);
    expect(store.get('tenant-1', issued.environment.envId)).toMatchObject({
      kind: 'self_hosted_macos',
      bindingStatus: 'active',
      os: 'darwin',
      architecture: 'arm64',
    });
    const reissued = store.reissue({
      tenantId: 'tenant-1',
      clientActionId: 'reissue-macos',
      envId: issued.environment.envId,
    });
    expect(reissued.environment.kind).toBe('self_hosted_macos');
    const linux = register(store, 'tenant-2', 'register-linux');
    expect(linux.environment.kind).toBe('self_hosted_linux');
  });

  it('registers pairing environments without inventing release metadata', () => {
    const { database, store } = fixture();
    const issued = register(store, 'tenant-1', 'register-1', '构建服务器');
    expect(issued.environment).toMatchObject({
      name: '构建服务器',
      bindingStatus: 'pairing',
      connectionStatus: 'offline',
      capabilityStatus: 'pending',
      directoryStatus: 'pending',
      maintenanceMode: 'normal',
      maintenanceVersion: '0',
      ready: false,
    });

    const duplicate = register(store, 'tenant-1', 'register-1', '构建服务器');
    expect(duplicate).toEqual(issued);
    expect(() => register(store, 'tenant-1', 'register-1', '异参')).toThrowError(
      expect.objectContaining({ code: 'action_conflict' }),
    );
    expect(store.list('tenant-1').environments).toHaveLength(1);
    expect(store.get('tenant-1', issued.environment.envId).envId).toBe(issued.environment.envId);
    expect(() => store.get('tenant-2', issued.environment.envId)).toThrowError(
      expect.objectContaining({ code: 'permission_denied' }),
    );
    expect(store.list('tenant-2').environments).toHaveLength(0);

    const credentialRow = database
      .prepare('SELECT credential_hash FROM environment_pairing_credentials WHERE env_id = ?')
      .get(issued.environment.envId);
    expect(credentialRow).not.toMatchObject({ credential_hash: issued.pairingCredential });
    expect(
      database.prepare('SELECT credential_hash FROM environment_pairing_credentials').all(),
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ credential_hash: '' })]));
  });

  it('reissues the same environment and invalidates previous credentials and bindings', () => {
    const { store } = fixture();
    const issued = register(store, 'tenant-1', 'register-1');
    const first = exchange(store, issued.environment.envId, issued.pairingCredential);
    const reissued = store.reissue({
      tenantId: 'tenant-1',
      clientActionId: 'reissue-1',
      envId: issued.environment.envId,
    });
    expect(reissued.environment.envId).toBe(issued.environment.envId);
    expect(reissued.environment.bindingStatus).toBe('pairing');
    expect(reissued.pairingCredential).not.toBe(issued.pairingCredential);
    expect(store.list('tenant-1').environments).toHaveLength(1);
    expect(() => exchange(store, issued.environment.envId, issued.pairingCredential)).toThrowError(
      expect.objectContaining({ code: DeviceErrorCode.UNAUTHENTICATED }),
    );
    expect(() =>
      store.pairing.authenticate({
        envId: first.envId,
        deviceId: first.deviceId,
        deviceBindingId: first.deviceBindingId,
        deviceCredential: first.deviceCredential,
      }),
    ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.UNAUTHENTICATED }));
    expect(() =>
      store.reissue({
        tenantId: 'tenant-2',
        clientActionId: 'cross-tenant-reissue',
        envId: issued.environment.envId,
      }),
    ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));

    const second = exchange(store, reissued.environment.envId, reissued.pairingCredential);
    expect(second.deviceBindingId).not.toBe(first.deviceBindingId);
    expect(second.deviceId).not.toBe(first.deviceId);
  });
});

describe('EnvironmentStore readiness', () => {
  it('keeps binding, connection, capability and directory states independent', () => {
    const { store } = fixture();
    const issued = register(store, 'tenant-1', 'register-ready');
    const exchanged = exchange(store, issued.environment.envId, issued.pairingCredential);
    expect(exchanged.deviceId).not.toBe(exchanged.envId);
    expect(exchanged.deviceBindingId).not.toBe(exchanged.deviceId);
    expect(store.list('tenant-1')).not.toHaveProperty('defaultEnvId');
    expect(() => store.requireReady('tenant-1', exchanged.envId)).toThrowError(
      expect.objectContaining({ code: 'failed_precondition' }),
    );

    store.markConnected({
      ...exchanged,
      instanceId: 'instance-1',
      reportedCapabilities: allCapabilities,
    });
    expect(store.get('tenant-1', exchanged.envId)).toMatchObject({
      bindingStatus: 'active',
      connectionStatus: 'online',
      capabilityStatus: 'pending',
      directoryStatus: 'pending',
      ready: false,
    });
    const ready = connectAndCheck(store, exchanged);
    expect(ready).toMatchObject({
      capabilityStatus: 'ready',
      directoryStatus: 'ready',
      normalizedPwd: '/srv/kairos',
      ready: true,
    });
    expect(store.requireReady('tenant-1', exchanged.envId).ready).toBe(true);

    store.markDisconnected({
      envId: exchanged.envId,
      deviceBindingId: exchanged.deviceBindingId,
      instanceId: 'instance-1',
    });
    expect(store.get('tenant-1', exchanged.envId)).toMatchObject({
      connectionStatus: 'offline',
      capabilityStatus: 'ready',
      directoryStatus: 'ready',
      ready: false,
    });
    expect(() => store.requireReady('tenant-1', exchanged.envId)).toThrowError(
      expect.objectContaining({ code: 'failed_precondition' }),
    );
  });

  it('keeps an active environment unavailable after capability or directory failure', () => {
    const { store } = fixture();
    const issued = register(store, 'tenant-1', 'register-failed-check');
    const exchanged = exchange(store, issued.environment.envId, issued.pairingCredential);
    store.markConnected({
      ...exchanged,
      instanceId: 'instance-1',
      reportedCapabilities: [DeviceCapability.DIRECTORY_CHECK],
    });
    const failed = store.recordReadiness({
      ...exchanged,
      instanceId: 'instance-1',
      reportedCapabilities: [DeviceCapability.DIRECTORY_CHECK],
      directoryStatus: 'failed',
      statusReason: 'Directory is not writable.',
    });
    expect(failed).toMatchObject({
      bindingStatus: 'active',
      connectionStatus: 'online',
      capabilityStatus: 'ready',
      directoryStatus: 'failed',
      statusReason: 'Directory is not writable.',
      ready: false,
    });
    expect(() => store.requireReady('tenant-1', exchanged.envId)).toThrow();
  });

  it('preserves obsolete device preferences as audit while pairing and revoking devices', () => {
    const { database, store } = fixture();
    const first = register(store, 'tenant-1', 'legacy-first');
    exchange(store, first.environment.envId, first.pairingCredential);
    database
      .prepare('UPDATE tenants SET default_env_id=?, default_env_explicit=1 WHERE tenant_id=?')
      .run(first.environment.envId, 'tenant-1');
    const second = register(store, 'tenant-1', 'legacy-second');
    exchange(store, second.environment.envId, second.pairingCredential);
    store.reissue({
      tenantId: 'tenant-1',
      envId: first.environment.envId,
      clientActionId: 'legacy-reissue',
    });
    store.revoke({
      tenantId: 'tenant-1',
      envId: second.environment.envId,
      clientActionId: 'legacy-revoke',
    });
    expect(
      database
        .prepare('SELECT default_env_id,default_env_explicit FROM tenants WHERE tenant_id=?')
        .get('tenant-1'),
    ).toEqual({ default_env_id: first.environment.envId, default_env_explicit: 1 });
    expect(store.list('tenant-1')).not.toHaveProperty('defaultEnvId');
    for (const environment of store.list('tenant-1').environments) {
      expect(environment).not.toHaveProperty('isDefault');
    }
  });

  it('does not change an existing Thread when a device is paired', () => {
    const { database, store } = fixture();
    const sessions = new SessionStore(database);
    const thread = sessions.createThread({
      ownerId: 'tenant-1',
      clientActionId: 'thread-before-default',
      method: 'CreateThread',
      parameters: { title: '已有任务' },
      title: '已有任务',
    });
    const issued = register(store, 'tenant-1', 'register-default-thread');
    exchange(store, issued.environment.envId, issued.pairingCredential);
    expect(sessions.getThread('tenant-1', thread.threadId)).toEqual(thread);
    expect(
      database.prepare('SELECT * FROM threads WHERE thread_id = ?').get(thread.threadId),
    ).toMatchObject({
      thread_id: thread.threadId,
      owner_id: 'tenant-1',
      title: '已有任务',
    });
  });
});

describe('EnvironmentStore maintenance and device revocation', () => {
  it('uses expected versions and idempotent actions for user-authorized maintenance', () => {
    const { store } = fixture();
    const issued = register(store, 'tenant-1', 'register-maintenance');
    const exchanged = exchange(store, issued.environment.envId, issued.pairingCredential);
    const draining = store.setMaintenance({
      tenantId: 'tenant-1',
      clientActionId: 'maintenance-draining',
      envId: exchanged.envId,
      mode: 'draining',
      expectedVersion: 0n,
    });
    expect(draining).toEqual({ envId: exchanged.envId, mode: 'draining', maintenanceVersion: '1' });
    expect(
      store.setMaintenance({
        tenantId: 'tenant-1',
        clientActionId: 'maintenance-draining',
        envId: exchanged.envId,
        mode: 'draining',
        expectedVersion: 0n,
      }),
    ).toEqual(draining);
    expect(store.maintenanceForBinding(exchanged)).toEqual(draining);
    expect(() =>
      store.setMaintenance({
        tenantId: 'tenant-1',
        clientActionId: 'maintenance-stale',
        envId: exchanged.envId,
        mode: 'normal',
        expectedVersion: 0n,
      }),
    ).toThrowError(expect.objectContaining({ code: 'version_conflict' }));

    const normal = store.setMaintenance({
      tenantId: 'tenant-1',
      clientActionId: 'maintenance-normal',
      envId: exchanged.envId,
      mode: 'normal',
      expectedVersion: 1n,
    });
    expect(normal.maintenanceVersion).toBe('2');
    expect(() =>
      store.setMaintenance({
        tenantId: 'tenant-1',
        clientActionId: 'maintenance-normal',
        envId: exchanged.envId,
        mode: 'draining',
        expectedVersion: 1n,
      }),
    ).toThrowError(expect.objectContaining({ code: 'action_conflict' }));
  });

  it('allows only the current binding to revoke itself and persists before acknowledgement', () => {
    const { store } = fixture();
    const issued = register(store, 'tenant-1', 'register-device-revoke');
    const exchanged = exchange(store, issued.environment.envId, issued.pairingCredential);
    expect(() =>
      store.revokeForBinding({
        envId: exchanged.envId,
        deviceBindingId: 'different-binding',
        reason: 'wrong binding',
      }),
    ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));

    const revoked = store.revokeForBinding({
      envId: exchanged.envId,
      deviceBindingId: exchanged.deviceBindingId,
      reason: 'Local uninstall requested.',
    });
    expect(revoked.environment).toMatchObject({
      bindingStatus: 'revoked',
      revokedAt: initialTime,
      statusReason: 'Local uninstall requested.',
    });
    expect(revoked).not.toHaveProperty('defaultEnvId');
    expect(() => store.maintenanceForBinding(exchanged)).toThrowError(
      expect.objectContaining({ code: 'permission_denied' }),
    );
    expect(() =>
      store.pairing.authenticate({
        envId: exchanged.envId,
        deviceId: exchanged.deviceId,
        deviceBindingId: exchanged.deviceBindingId,
        deviceCredential: exchanged.deviceCredential,
      }),
    ).toThrowError(expect.objectContaining({ code: DeviceErrorCode.ENVIRONMENT_REVOKED }));
  });
});

describe('EnvironmentStore cross-process pairing', () => {
  it('pairs independent devices without writing a tenant default', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kairos-environment-default-'));
    const path = join(directory, 'test.sqlite');
    const database = openDatabase(path);
    const workers: Worker[] = [];
    try {
      new SessionStore(database);
      seedTenant(database, 'tenant-1');
      const store = new EnvironmentStore(database);
      const first = register(store, 'tenant-1', 'worker-register-1');
      const second = register(store, 'tenant-1', 'worker-register-2');
      const source = `
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
          const { register } = await import('tsx/esm/api');
          register();
          const { openDatabase } = await import(workerData.databaseModule);
          const { EnvironmentStore } = await import(workerData.storeModule);
          const database = openDatabase(workerData.path);
          try {
            const store = new EnvironmentStore(database);
            store.exchangePairing({
              envId: workerData.envId,
              pairingCredential: workerData.pairingCredential,
              reportedCapabilities: [5]
            });
            parentPort.postMessage({ ok: true });
          } finally {
            database.close();
          }
        })().catch((error) => {
          parentPort.postMessage({ ok: false, message: String(error) });
        });
      `;
      const exchanges = [first, second].map((issued) => {
        const worker = new Worker(source, {
          eval: true,
          execArgv: ['--import', 'tsx'],
          workerData: {
            databaseModule: new URL('../storage/database.ts', import.meta.url).href,
            storeModule: new URL('./environment-store.ts', import.meta.url).href,
            path,
            envId: issued.environment.envId,
            pairingCredential: issued.pairingCredential,
          },
        });
        workers.push(worker);
        return new Promise<void>((resolve, reject) => {
          worker.once('error', reject);
          worker.once('message', (message: unknown) => {
            if (
              typeof message === 'object' &&
              message !== null &&
              'ok' in message &&
              message.ok === true
            ) {
              resolve();
            } else {
              reject(new Error(`Environment exchange worker failed: ${JSON.stringify(message)}`));
            }
          });
        });
      });
      await Promise.all(exchanges);
      const selected = database
        .prepare('SELECT default_env_id FROM tenants WHERE tenant_id = ?')
        .get('tenant-1');
      expect(selected).toEqual({ default_env_id: null });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM environments WHERE binding_status = 'active'")
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('EnvironmentStore instance and capability readiness', () => {
  it('resets readiness for a new instance and rejects missing directory capability', () => {
    const { store } = fixture();
    const issued = register(store, 'tenant-1', 'register-instance-readiness');
    const exchanged = exchange(store, issued.environment.envId, issued.pairingCredential);
    connectAndCheck(store, exchanged, 'instance-1');
    expect(store.requireReady('tenant-1', exchanged.envId).ready).toBe(true);

    const reconnected = store.markConnected({
      ...exchanged,
      instanceId: 'instance-2',
      reportedCapabilities: allCapabilities,
    });
    expect(reconnected).toMatchObject({
      instanceId: 'instance-2',
      capabilityStatus: 'pending',
      directoryStatus: 'pending',
      ready: false,
    });
    const unavailable = store.recordReadiness({
      ...exchanged,
      instanceId: 'instance-2',
      reportedCapabilities: [DeviceCapability.BASH],
      directoryStatus: 'ready',
      normalizedPwd: '/srv/kairos',
      statusReason: 'Directory check capability is unavailable.',
    });
    expect(unavailable).toMatchObject({
      bindingStatus: 'active',
      connectionStatus: 'online',
      capabilityStatus: 'failed',
      directoryStatus: 'ready',
      statusReason: 'Directory check capability is unavailable.',
      ready: false,
    });
    expect(() => store.requireReady('tenant-1', exchanged.envId)).toThrowError(
      expect.objectContaining({ code: 'failed_precondition' }),
    );
  });
});

describe('connected device configuration', () => {
  it('detects macOS identity and initial directory after receiving the pairing credential', () => {
    const { store } = fixture();
    const issued = store.beginConnection({ tenantId: 'tenant-1', clientActionId: 'begin-auto' });
    expect(issued.environment.autoDetect).toBe(true);
    expect(issued.environment).not.toHaveProperty('isDefault');
    expect(() =>
      store.exchangePairing({
        envId: issued.environment.envId,
        pairingCredential: issued.pairingCredential,
        reportedCapabilities: allCapabilities,
      }),
    ).toThrow();
    const bound = store.exchangePairing({
      envId: issued.environment.envId,
      pairingCredential: issued.pairingCredential,
      reportedCapabilities: [...allCapabilities, DeviceCapability.DIRECTORY_LIST],
      os: 'darwin',
      deviceName: '工作 Mac',
      homeDirectory: '/Users/person/projects',
      architecture: 'aarch64',
    });
    expect(store.get('tenant-1', bound.envId)).toMatchObject({
      autoDetect: false,
      name: '工作 Mac',
      kind: 'self_hosted_macos',
      recommendedPwd: '/Users/person/projects',
      settingsVersion: '0',
    });
  });

  it('cancels only pending pairing and preserves a device whose connection won the race', () => {
    const { store } = fixture();
    const pending = store.beginConnection({
      tenantId: 'tenant-1',
      clientActionId: 'pending-cancel',
    });
    expect(
      store.cancelConnection({
        tenantId: 'tenant-1',
        clientActionId: 'cancel-pending',
        envId: pending.environment.envId,
      }).bindingStatus,
    ).toBe('revoked');
    expect(() => exchange(store, pending.environment.envId, pending.pairingCredential)).toThrow();
    const live = register(store, 'tenant-1', 'live-cancel');
    exchange(store, live.environment.envId, live.pairingCredential);
    expect(
      store.cancelConnection({
        tenantId: 'tenant-1',
        clientActionId: 'cancel-connected',
        envId: live.environment.envId,
      }),
    ).toMatchObject({ bindingStatus: 'active' });
  });

  it('persists versioned edits, rejects stale edits and replays the exact original result', () => {
    const { store } = fixture();
    const issued = register(store, 'tenant-1', 'edit-device');
    exchange(store, issued.environment.envId, issued.pairingCredential);
    const input = {
      tenantId: 'tenant-1',
      envId: issued.environment.envId,
      clientActionId: 'edit-settings',
      expectedSettingsVersion: 0n,
      name: '  显示名称  ',
      recommendedPwd: '/srv/new-project',
    };
    const saved = store.updateSettings(input);
    expect(saved).toMatchObject({
      name: '显示名称',
      recommendedPwd: '/srv/new-project',
      settingsVersion: '1',
      directoryStatus: 'pending',
    });
    expect(store.updateSettings(input)).toEqual(saved);
    expect(store.replaySettingsUpdate(input)).toEqual(saved);
    expect(() =>
      store.updateSettings({ ...input, clientActionId: 'stale-settings', name: '过期修改' }),
    ).toThrowError(expect.objectContaining({ code: 'version_conflict' }));
    expect(() => store.updateSettings({ ...input, name: '异参' })).toThrowError(
      expect.objectContaining({ code: 'action_conflict' }),
    );
    expect(store.get('tenant-1', issued.environment.envId).name).toBe('显示名称');
    expect(() =>
      store.updateSettings({ ...input, tenantId: 'tenant-2', clientActionId: 'foreign-update' }),
    ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
  });

  it('persists account-owned favorites across store recreation and makes removal idempotent', () => {
    const { database, store } = fixture();
    const issued = register(store, 'tenant-1', 'favorite-device');
    exchange(store, issued.environment.envId, issued.pairingCredential);
    const input = {
      tenantId: 'tenant-1',
      envId: issued.environment.envId,
      clientActionId: 'favorite-add',
      path: '/srv/kairos',
      enabled: true,
    };
    expect(store.setFavorite(input).favoriteDirectories).toEqual(['/srv/kairos']);
    expect(store.setFavorite(input).favoriteDirectories).toEqual(['/srv/kairos']);
    expect(
      new EnvironmentStore(database).get('tenant-1', issued.environment.envId).favoriteDirectories,
    ).toEqual(['/srv/kairos']);
    expect(() =>
      store.setFavorite({ ...input, tenantId: 'tenant-2', clientActionId: 'foreign-favorite' }),
    ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
    const removed = store.setFavorite({
      ...input,
      clientActionId: 'favorite-remove',
      enabled: false,
    });
    expect(removed.favoriteDirectories).toEqual([]);
    expect(store.get('tenant-1', issued.environment.envId).recommendedPwd).toBe('/srv/kairos');
  });
});

describe('main environment registration', () => {
  it('registers new devices through beginConnection while the main environment stays protected', () => {
    const { database } = fixture();
    const store = new EnvironmentStore(database, {
      now: () => new Date(initialTime),
      mainEnvironment: { envId: 'cvm-device', workspace: '/workspace' },
    });
    ensureMainEnvironment(database, 'tenant-1', { envId: 'cvm-device', workspace: '/workspace' });
    const issued = store.beginConnection({ tenantId: 'tenant-1', clientActionId: 'begin-1' });
    expect(issued.environment).toMatchObject({
      name: '新设备',
      recommendedPwd: '/',
      bindingStatus: 'pairing',
    });
    expect(issued.environment.envId).not.toBe('cvm-device');
    expect(() =>
      store.revoke({ tenantId: 'tenant-1', clientActionId: 'revoke-main', envId: 'cvm-device' }),
    ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
    const reissued = store.reissue({
      tenantId: 'tenant-1',
      clientActionId: 'reissue-main',
      envId: 'cvm-device',
    });
    expect(reissued.environment).toMatchObject({
      envId: 'cvm-device',
      bindingStatus: 'pairing',
      recommendedPwd: '/workspace',
    });
    const other = store.beginConnection({ tenantId: 'tenant-2', clientActionId: 'begin-other' });
    expect(other.environment.tenantId).toBe('tenant-2');
  });

  it('cancels and revokes ordinary devices whose revoked binding cannot be paired again', () => {
    const { database } = fixture();
    const store = new EnvironmentStore(database, {
      now: () => new Date(initialTime),
      mainEnvironment: { envId: 'cvm-device', workspace: '/workspace' },
    });
    ensureMainEnvironment(database, 'tenant-1', { envId: 'cvm-device', workspace: '/workspace' });
    const ordinary = register(store, 'tenant-1', 'ordinary-1');
    const cancelled = store.cancelConnection({
      tenantId: 'tenant-1',
      clientActionId: 'ordinary-cancel',
      envId: ordinary.environment.envId,
    });
    expect(cancelled).toMatchObject({ bindingStatus: 'revoked', revokedAt: initialTime });
    expect(() =>
      store.reissue({
        tenantId: 'tenant-1',
        clientActionId: 'ordinary-reissue',
        envId: ordinary.environment.envId,
      }),
    ).toThrowError(expect.objectContaining({ code: 'failed_precondition' }));
    expect(() =>
      store.revoke({ tenantId: 'tenant-1', clientActionId: 'revoke-main-2', envId: 'cvm-device' }),
    ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
  });
});
