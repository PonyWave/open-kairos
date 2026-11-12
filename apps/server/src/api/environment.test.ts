import type { DatabaseSync } from 'node:sqlite';
import { Code, createClient, createRouterTransport, type Interceptor } from '@connectrpc/connect';
import {
  EnvironmentBindingStatus,
  EnvironmentCapabilityStatus,
  EnvironmentConnectionStatus,
  EnvironmentDirectoryStatus,
  EnvironmentKind,
  EnvironmentMaintenanceMode,
  EnvironmentService,
} from '@kairos/contracts';
import { DeviceCapability } from '@kairos/contracts/device';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvironmentStore } from '../devices/environment-store.js';
import {
  createTestAuthentication,
  testSessionHeaders,
} from '../integration/test-authentication.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { type EnvironmentApiOptions, registerEnvironmentRoutes } from './environment.js';

const databases: DatabaseSync[] = [];
const now = '2026-11-05T12:00:00.000Z';
const daemonCommands = () => ({
  startCommand: '~/.local/bin/kairos-daemon start',
  statusCommand: '~/.local/bin/kairos-daemon status',
  stopCommand: '~/.local/bin/kairos-daemon stop',
});
const installer = {
  assertAvailable() {},
  command: () => 'fixture-install-command',
  daemonCommands: () => daemonCommands(),
};

function seedTenant(database: DatabaseSync, tenantId: string): void {
  const userId = `user-${tenantId}`;
  database
    .prepare(
      `INSERT INTO users(
        user_id, email, email_verified_at, username, tenant_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, 'active', ?, ?)`,
    )
    .run(userId, `${tenantId}@example.com`, now, tenantId, now, now);
  database
    .prepare(
      'INSERT INTO tenants(tenant_id, user_id, default_env_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
    )
    .run(tenantId, userId, now, now);
  database.prepare('UPDATE users SET tenant_id = ? WHERE user_id = ?').run(tenantId, userId);
}

function fixture(
  options: Pick<EnvironmentApiOptions, 'installer' | 'directories'> & {
    mainEnvironmentEnvId?: string;
  } = {},
) {
  const database = openDatabase(':memory:');
  databases.push(database);
  new SessionStore(database);
  seedTenant(database, 'tenant-1');
  seedTenant(database, 'tenant-2');
  const mainEnvironment = options.mainEnvironmentEnvId
    ? { envId: options.mainEnvironmentEnvId, workspace: '/workspace' }
    : { envId: 'main', workspace: '/workspace' };
  const environments = new EnvironmentStore(database, {
    now: () => new Date(now),
    mainEnvironment,
  });
  const clientFor = (tenantId: string) => {
    const authentication: Interceptor = (next) => async (request) => {
      for (const [name, value] of Object.entries(testSessionHeaders(`session-${tenantId}`))) {
        request.header.set(name, value);
      }
      return next(request);
    };
    const transport = createRouterTransport(
      (router) =>
        registerEnvironmentRoutes(router, {
          ...(options.installer ? { installer: options.installer } : {}),
          ...(options.directories ? { directories: options.directories } : {}),
          environments,
          mainEnvironment,
          authentication: createTestAuthentication(
            database,
            tenantId,
            `session-${tenantId}`,
            mainEnvironment,
          ),
        }),
      { transport: { interceptors: [authentication] } },
    );
    return createClient(EnvironmentService, transport);
  };
  return { database, environments, first: clientFor('tenant-1'), second: clientFor('tenant-2') };
}

function exchange(environments: EnvironmentStore, envId: string, pairingCredential: string) {
  return environments.exchangePairing({
    envId,
    pairingCredential,
    reportedCapabilities: [DeviceCapability.DIRECTORY_CHECK],
  });
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('connected device management API', () => {
  it('begins without a name and accepts naming only after actual pairing', async () => {
    const { first, second, environments } = fixture({ installer });
    const issued = await first.beginDeviceConnection({ clientActionId: 'begin-generated-client' });
    expect(issued.installCommand).toBe('fixture-install-command');
    expect(issued.environment?.kind).toBe(EnvironmentKind.UNSPECIFIED);
    const envId = issued.environment?.envId ?? '';
    await expect(
      first.updateEnvironment({ clientActionId: 'name-before-pair', envId, name: '过早命名' }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    environments.exchangePairing({
      envId,
      pairingCredential: issued.pairingCredential,
      reportedCapabilities: [DeviceCapability.DIRECTORY_CHECK],
      os: 'darwin',
      deviceName: 'Detected Mac',
      homeDirectory: '/Users/test',
    });
    const saved = await first.updateEnvironment({
      clientActionId: 'name-after-pair',
      envId,
      name: '设备名称',
      expectedSettingsVersion: 0n,
    });
    expect(saved.environment).toMatchObject({
      name: '设备名称',
      kind: EnvironmentKind.SELF_HOSTED_MACOS,
      recommendedPwd: '/Users/test',
      settingsVersion: 1n,
    });
    await expect(
      second.updateEnvironment({
        clientActionId: 'foreign-name',
        envId,
        name: '越权',
        expectedSettingsVersion: 1n,
      }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    const replay = await first.updateEnvironment({
      clientActionId: 'name-after-pair',
      envId,
      name: '设备名称',
      expectedSettingsVersion: 0n,
    });
    expect(replay).toEqual(saved);
    const favorite = await first.setFavoriteDirectory({
      clientActionId: 'favorite-through-api',
      envId,
      path: '/Users/test/projects',
      enabled: true,
    });
    expect(favorite.environment?.favoriteDirectories).toEqual(['/Users/test/projects']);
    const offlinePath = await first.updateEnvironment({
      clientActionId: 'offline-default-path',
      envId,
      recommendedPwd: '/Users/test/projects',
      expectedSettingsVersion: favorite.environment?.settingsVersion ?? 0n,
    });
    expect(offlinePath.environment?.recommendedPwd).toBe('/Users/test/projects');
    const cancelled = await first.cancelDeviceConnection({ clientActionId: 'cancel-bound', envId });
    expect(cancelled.environment?.bindingStatus).toBe(EnvironmentBindingStatus.ACTIVE);
  });

  it('returns env-specific commands for two active bindings without credentials or writes', async () => {
    const { database, environments, first, second } = fixture({ installer });
    const testIssued = await first.beginDeviceConnection({
      clientActionId: 'begin-command-guide-test',
    });
    const testEnvId = testIssued.environment?.envId ?? '';
    await expect(first.getEnvironmentDaemonCommands({ envId: '' })).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    await expect(first.getEnvironmentDaemonCommands({ envId: testEnvId })).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });
    environments.exchangePairing({
      envId: testEnvId,
      pairingCredential: testIssued.pairingCredential,
      reportedCapabilities: [DeviceCapability.DIRECTORY_CHECK],
      os: 'darwin',
      deviceName: 'Shared Mac',
      homeDirectory: '/Users/test',
    });
    const prodIssued = await first.beginDeviceConnection({
      clientActionId: 'begin-command-guide-prod',
    });
    const prodEnvId = prodIssued.environment?.envId ?? '';
    environments.exchangePairing({
      envId: prodEnvId,
      pairingCredential: prodIssued.pairingCredential,
      reportedCapabilities: [DeviceCapability.DIRECTORY_CHECK],
      os: 'darwin',
      deviceName: 'Shared Mac',
      homeDirectory: '/Users/test',
    });
    expect(testEnvId).not.toBe(prodEnvId);
    expect(environments.list('tenant-1')).not.toHaveProperty('defaultEnvId');
    await expect(second.getEnvironmentDaemonCommands({ envId: testEnvId })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });

    const environmentsBefore = database.prepare('SELECT * FROM environments ORDER BY env_id').all();
    const credentialsBefore = database
      .prepare('SELECT * FROM environment_pairing_credentials ORDER BY env_id')
      .all();
    const actionsBefore = database.prepare('SELECT * FROM client_actions').all();
    const testCommands = await first.getEnvironmentDaemonCommands({ envId: testEnvId });
    const prodCommands = await first.getEnvironmentDaemonCommands({ envId: prodEnvId });
    expect(testCommands).toMatchObject(daemonCommands());
    expect(prodCommands).toMatchObject(daemonCommands());
    for (const commands of [testCommands, prodCommands]) {
      expect(commands).not.toHaveProperty('pairingCredential');
      expect(commands).not.toHaveProperty('installCommand');
      expect(JSON.stringify(commands)).not.toContain(testIssued.pairingCredential);
      expect(JSON.stringify(commands)).not.toContain(prodIssued.pairingCredential);
    }
    expect(database.prepare('SELECT * FROM environments ORDER BY env_id').all()).toEqual(
      environmentsBefore,
    );
    expect(
      database.prepare('SELECT * FROM environment_pairing_credentials ORDER BY env_id').all(),
    ).toEqual(credentialsBefore);
    expect(database.prepare('SELECT * FROM client_actions').all()).toEqual(actionsBefore);
  });

  it('does not create pending records when installation packages are unavailable', async () => {
    const { first, database } = fixture();
    await expect(
      first.beginDeviceConnection({ clientActionId: 'begin-unconfigured' }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM environments WHERE name <> '主环境'").get(),
    ).toMatchObject({
      count: 0,
    });
  });

  it('pairs a new device through the GUI client while the main environment cannot be revoked', async () => {
    const { database, environments, first } = fixture({
      installer,
      mainEnvironmentEnvId: 'cvm-device',
    });
    const initial = await first.beginDeviceConnection({ clientActionId: 'gui-begin-initial' });
    const envId = initial.environment?.envId ?? '';
    expect(envId).not.toBe('cvm-device');
    expect(initial.environment?.bindingStatus).toBe(EnvironmentBindingStatus.PAIRING);
    await expect(
      first.cancelDeviceConnection({ clientActionId: 'gui-cancel-main', envId: 'cvm-device' }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(
      first.revokeEnvironment({ clientActionId: 'gui-revoke-main', envId: 'cvm-device' }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    const cancelled = await first.cancelDeviceConnection({
      clientActionId: 'gui-cancel-device',
      envId,
    });
    expect(cancelled.environment?.bindingStatus).toBe(EnvironmentBindingStatus.REVOKED);
    const next = await first.beginDeviceConnection({ clientActionId: 'gui-begin-next' });
    expect(next.environment?.envId).not.toBe(envId);
    expect(next.pairingCredential).not.toBe(initial.pairingCredential);
    const binding = environments.exchangePairing({
      envId: next.environment?.envId ?? '',
      pairingCredential: next.pairingCredential,
      reportedCapabilities: [DeviceCapability.DIRECTORY_CHECK],
      deviceName: 'gui-device',
      homeDirectory: '/home/gui-device',
      os: 'linux',
    });
    expect(binding.deviceBindingId).toBeTruthy();
    expect(
      database
        .prepare('SELECT status FROM environment_device_bindings WHERE device_binding_id = ?')
        .get(binding.deviceBindingId),
    ).toEqual({ status: 'active' });
  });
});

describe('Environment Connect API', () => {
  it('registers a named macOS environment through the generated client', async () => {
    const { first } = fixture();
    const registered = await first.registerEnvironment({
      clientActionId: 'register-api-macos',
      name: '本地 Mac',
      recommendedPwd: '/Users/test/Kairos',
      kind: EnvironmentKind.SELF_HOSTED_MACOS,
    });
    expect(registered.environment).toMatchObject({
      name: '本地 Mac',
      kind: EnvironmentKind.SELF_HOSTED_MACOS,
      recommendedPwd: '/Users/test/Kairos',
    });
    expect((await first.listEnvironments({})).environments[0]?.name).toBe('本地 Mac');
  });

  it('registers, lists, reads and reissues with persistent action deduplication', async () => {
    const { database, first, second } = fixture();
    const input = {
      clientActionId: 'register-api-1',
      name: 'API 服务器',
      recommendedPwd: '/srv/kairos',
    };
    const registered = await first.registerEnvironment(input);
    expect(registered.environment).toMatchObject({
      name: 'API 服务器',
      bindingStatus: EnvironmentBindingStatus.PAIRING,
      connectionStatus: EnvironmentConnectionStatus.OFFLINE,
      capabilityStatus: EnvironmentCapabilityStatus.PENDING,
      directoryStatus: EnvironmentDirectoryStatus.PENDING,
      ready: false,
    });
    expect(registered.pairingCredential).toMatch(/^ke2_/);
    expect(registered.installation).toBeUndefined();
    const duplicate = await first.registerEnvironment(input);
    expect(duplicate.pairingCredential).toBe(registered.pairingCredential);
    expect(duplicate.environment?.envId).toBe(registered.environment?.envId);
    await expect(first.registerEnvironment({ ...input, name: '异参' })).rejects.toMatchObject({
      code: Code.AlreadyExists,
    });

    const envId = registered.environment?.envId ?? '';
    expect((await first.getEnvironment({ envId })).environment?.envId).toBe(envId);
    const firstList = await first.listEnvironments({});
    expect(firstList.environments).toHaveLength(2);
    expect(firstList.mainEnvId).toBeTruthy();
    expect(
      firstList.environments.find((environment) => environment.envId === firstList.mainEnvId)?.kind,
    ).toBe(EnvironmentKind.UNSPECIFIED);
    expect((await second.listEnvironments({})).environments).toHaveLength(1);
    await expect(second.getEnvironment({ envId })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    await expect(
      second.reissueEnvironmentPairing({ clientActionId: 'cross-reissue', envId }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });

    const reissued = await first.reissueEnvironmentPairing({
      clientActionId: 'reissue-api-1',
      envId,
    });
    expect(reissued.environment?.envId).toBe(envId);
    expect(reissued.pairingCredential).not.toBe(registered.pairingCredential);
    expect((await first.listEnvironments({})).environments).toHaveLength(2);
    expect(database.prepare('SELECT COUNT(*) AS count FROM environments').get()).toEqual({
      count: 3,
    });
    expect(
      database
        .prepare('SELECT method, response_json FROM client_actions WHERE client_action_id = ?')
        .get('register-api-1'),
    ).toMatchObject({ method: 'RegisterEnvironment' });
  });

  it('validates requests before changing the database', async () => {
    const { database, first } = fixture();
    await expect(
      first.registerEnvironment({
        clientActionId: 'invalid-path',
        name: 'Invalid',
        recommendedPwd: '~/kairos',
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM environments WHERE name <> '主环境'").get(),
    ).toEqual({
      count: 0,
    });
  });

  it('lists connected devices without a default and supports versioned maintenance', async () => {
    const { database, environments, first } = fixture();
    const registered = await first.registerEnvironment({
      clientActionId: 'register-api-default',
      name: 'Default',
      recommendedPwd: '/srv/kairos',
    });
    const envId = registered.environment?.envId ?? '';
    const exchanged = exchange(environments, envId, registered.pairingCredential);
    expect(await first.listEnvironments({})).not.toHaveProperty('defaultEnvId');

    const draining = await first.setEnvironmentMaintenance({
      clientActionId: 'maintenance-api-draining',
      envId,
      mode: EnvironmentMaintenanceMode.DRAINING,
      expectedVersion: 0n,
    });
    expect(draining.maintenanceVersion).toBe(1n);
    expect(draining.mode).toBe(EnvironmentMaintenanceMode.DRAINING);
    expect(
      await first.setEnvironmentMaintenance({
        clientActionId: 'maintenance-api-draining',
        envId,
        mode: EnvironmentMaintenanceMode.DRAINING,
        expectedVersion: 0n,
      }),
    ).toEqual(draining);
    await expect(
      first.setEnvironmentMaintenance({
        clientActionId: 'maintenance-api-stale',
        envId,
        mode: EnvironmentMaintenanceMode.NORMAL,
        expectedVersion: 0n,
      }),
    ).rejects.toMatchObject({ code: Code.Aborted });
    expect(environments.maintenanceForBinding(exchanged).maintenanceVersion).toBe('1');
    expect(
      database
        .prepare('SELECT maintenance_mode, maintenance_version FROM environments WHERE env_id = ?')
        .get(envId),
    ).toEqual({ maintenance_mode: 'draining', maintenance_version: '1' });

    expect(await first.listEnvironments({})).not.toHaveProperty('defaultEnvId');

    const revoked = await first.revokeEnvironment({
      clientActionId: 'revoke-api-default',
      envId,
    });
    expect(revoked.environment?.bindingStatus).toBe(EnvironmentBindingStatus.REVOKED);
    expect(revoked).not.toHaveProperty('defaultEnvId');
    expect(
      database.prepare('SELECT binding_status FROM environments WHERE env_id = ?').get(envId),
    ).toEqual({
      binding_status: 'revoked',
    });
  });
});
