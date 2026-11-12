import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Code } from '@connectrpc/connect';
import { EnvironmentBindingStatus } from '@kairos/contracts';
import { OperationStatus } from '@kairos/contracts/device';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../sessions/store.js';
import { startRealEnvironmentServer } from './environment-fixture.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(releaseDirectory?: string) {
  const root = mkdtempSync(join(tmpdir(), 'kairos-connected-devices-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const releases = join(root, 'releases');
  mkdirSync(releases);
  const file = 'kairos-daemon-test-macos-arm64.tar.gz';
  const bytes = Buffer.from('release-metadata-fixture');
  writeFileSync(join(releases, file), bytes);
  writeFileSync(
    join(releases, 'release-darwin-arm64.json'),
    JSON.stringify({
      version: 'test',
      platform: 'darwin',
      architecture: 'arm64',
      file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }),
  );
  const server = await startRealEnvironmentServer(root, {
    ownerId: 'tenant-devices',
    accessToken: 'device-api-test',
    deviceReleaseDirectory: releaseDirectory ?? releases,
  });
  cleanup.push(server.close);
  return server;
}

describe('connected devices over real HTTP and Daemon operations', () => {
  it.runIf(process.platform === 'darwin' && Boolean(process.env.KAIROS_TEST_DAEMON_RELEASE))(
    'installs and executes the bundled macOS Daemon without changing the login service',
    async () => {
      const archive = process.env.KAIROS_TEST_DAEMON_RELEASE;
      if (!archive) throw new Error('Missing explicit release archive.');
      const { dirname } = await import('node:path');
      const server = await fixture(dirname(archive));
      const root = mkdtempSync(join(tmpdir(), 'kairos-native-install-'));
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const extracted = join(root, 'release');
      mkdirSync(extracted);
      execFileSync('tar', ['-xzf', archive, '-C', extracted]);
      const workspace = join(root, 'workspace');
      mkdirSync(workspace);
      mkdirSync(join(workspace, 'real-child'));
      const prefix = join(root, 'installation with spaces');
      const issued = await server.clients.environments.beginDeviceConnection({
        clientActionId: 'native-package-pairing',
      });
      const envId = issued.environment?.envId;
      if (!envId) throw new Error('Missing installation environment.');
      const url = `${server.baseUrl.replace('http:', 'ws:')}/devices/wss`;
      const nativeEnvironment = {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      };
      const installation = spawn(
        'bash',
        [
          join(extracted, 'install.sh'),
          '--env-id',
          envId,
          '--server-url',
          url,
          '--directory',
          workspace,
          '--prefix',
          prefix,
          '--no-service',
        ],
        { env: nativeEnvironment, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      cleanup.push(() => {
        if (installation.exitCode === null && installation.signalCode === null)
          installation.kill('SIGTERM');
      });
      let output = '';
      installation.stdout.on('data', (chunk) => {
        output += chunk;
      });
      installation.stderr.on('data', (chunk) => {
        output += chunk;
      });
      installation.stdin.end(`${issued.pairingCredential}\n`);
      const status = await new Promise<number | null>((resolve, reject) => {
        installation.once('error', reject);
        installation.once('exit', resolve);
      });
      expect(status, output).toBe(0);
      expect(output).not.toContain(issued.pairingCredential);
      expect(statSync(join(prefix, 'identity.json')).mode & 0o777).toBe(0o600);
      expect(
        (await server.clients.environments.getEnvironment({ envId })).environment,
      ).toMatchObject({
        bindingStatus: EnvironmentBindingStatus.ACTIVE,
        recommendedPwd: workspace,
      });
      let child: ChildProcess | undefined = spawn(join(prefix, 'current/bin/kairos-daemon'), [], {
        env: { ...nativeEnvironment, KAIROS_DEVICE_IDENTITY_PATH: join(prefix, 'identity.json') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const installed = child;
      installed.stdout?.on('data', (chunk) => {
        output += chunk;
      });
      installed.stderr?.on('data', (chunk) => {
        output += chunk;
      });
      cleanup.push(async () => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
        child.kill('SIGTERM');
        const timer = setTimeout(() => child?.kill('SIGKILL'), 3000);
        await exited;
        clearTimeout(timer);
        child = undefined;
      });
      await expect
        .poll(() => server.environments.get('tenant-devices', envId).ready, { timeout: 10_000 })
        .toBe(true);
      const directories = await server.clients.environments.listEnvironmentDirectories({
        envId,
        path: workspace,
        limit: 200,
      });
      expect(directories.entries.map((entry) => entry.name)).toEqual(['real-child']);
    },
    30_000,
  );
  it('browses and saves real directories while tasks retain their sandbox workspace', async () => {
    const server = await fixture();
    const api = server.clients.environments;
    mkdirSync(join(server.workspace, 'alpha'));
    mkdirSync(join(server.workspace, 'beta'));
    writeFileSync(join(server.workspace, 'old-location.txt'), 'original task location');
    const sessions = new SessionStore(server.database, { mainEnvironment: server.mainEnvironment });
    const task = sessions.createThread({
      ownerId: 'tenant-devices',
      clientActionId: 'before-directory-edit',
      method: 'CreateThread',
      parameters: { title: '已有话题' },
      title: '已有话题',
      environmentPolicy: server.environmentPolicy,
    });
    const originalBinding = sessions.getThread('tenant-devices', task.threadId).currentBinding;
    expect(originalBinding?.envId).not.toBe(server.envId);
    expect(originalBinding?.pwd).toBe(server.mainEnvironment.workspace);
    const listed = await api.listEnvironmentDirectories({
      envId: server.envId,
      path: server.workspace,
      limit: 1,
    });
    expect(listed.entries).toHaveLength(1);
    expect(listed.hasMore).toBe(true);
    if (listed.nextOffset === undefined) throw new Error('Missing directory pagination offset.');
    const second = await api.listEnvironmentDirectories({
      envId: server.envId,
      path: listed.path,
      offset: listed.nextOffset,
      limit: 200,
    });
    expect([...listed.entries, ...second.entries].some((entry) => entry.name === 'beta')).toBe(
      true,
    );
    const beta =
      second.entries.find((entry) => entry.name === 'beta') ??
      listed.entries.find((entry) => entry.name === 'beta');
    if (!beta) throw new Error('Expected a real beta directory.');
    const before = await api.getEnvironment({ envId: server.envId });
    const request = {
      clientActionId: 'save-real-directory',
      envId: server.envId,
      expectedSettingsVersion: before.environment?.settingsVersion ?? 0n,
      recommendedPwd: beta.path,
    };
    const saved = await api.updateEnvironment(request);
    expect(saved.environment).toMatchObject({
      recommendedPwd: beta.path,
      ready: true,
      settingsVersion: 1n,
    });
    const operationCount = server.database
      .prepare('SELECT COUNT(*) AS count FROM environment_operations')
      .get();
    expect(await api.updateEnvironment(request)).toEqual(saved);
    expect(
      server.database.prepare('SELECT COUNT(*) AS count FROM environment_operations').get(),
    ).toEqual(operationCount);
    expect(sessions.getThread('tenant-devices', task.threadId).currentBinding).toEqual(
      originalBinding,
    );
    const invalid = {
      ...request,
      clientActionId: 'reject-invalid-directory',
      expectedSettingsVersion: 1n,
      recommendedPwd: join(server.workspace, 'missing'),
    };
    await expect(api.updateEnvironment(invalid)).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });
    expect(server.environments.get('tenant-devices', server.envId)).toMatchObject({
      recommendedPwd: beta.path,
      ready: true,
    });
    await api.setFavoriteDirectory({
      clientActionId: 'favorite-real-directory',
      envId: server.envId,
      path: beta.path,
      enabled: true,
    });
    expect(
      (await api.listEnvironments({})).environments.find((device) => device.envId === server.envId)
        ?.favoriteDirectories,
    ).toEqual([beta.path]);
    const operation = await server.channel.startEnvironmentOperation({
      tenantId: 'tenant-devices',
      envId: server.envId,
      operationId: 'read-original-task-location',
      bindingVersion: BigInt(originalBinding?.bindingVersion ?? 1),
      action: {
        case: 'read',
        value: { path: 'old-location.txt', cwd: server.workspace },
      },
      expiresAt: new Date(Date.now() + 10_000),
    });
    await expect
      .poll(
        () => server.operations.getForTenant('tenant-devices', operation.operationId).resultStatus,
      )
      .toBe(OperationStatus.COMPLETED);
    expect(
      server.operations.getForTenant('tenant-devices', operation.operationId).outcome,
    ).toMatchObject({
      case: 'read',
      value: { content: expect.stringContaining('original task location') },
    });
  });

  it('recognizes a device registered without a name without changing a default', async () => {
    const server = await fixture();
    const api = server.clients.environments;
    const issued = await api.beginDeviceConnection({ clientActionId: 'begin-real-device' });
    const envId = issued.environment?.envId;
    if (!envId) throw new Error('Missing pending environment.');
    expect(issued.environment?.bindingStatus).toBe(EnvironmentBindingStatus.PAIRING);
    expect(issued.installCommand).toContain('/api/daemon/install.sh');
    expect(await api.listEnvironments({})).not.toHaveProperty('defaultEnvId');
    const connected = await server.addEnvironment('识别的设备名称', {
      envId,
      pairingCredential: issued.pairingCredential,
    });
    const snapshot = await api.getEnvironment({ envId });
    expect(snapshot.environment).toMatchObject({
      name: '识别的设备名称',
      bindingStatus: EnvironmentBindingStatus.ACTIVE,
      ready: true,
      recommendedPwd: connected.workspace,
    });
    await api.updateEnvironment({
      clientActionId: 'name-real-device',
      envId,
      name: '用户修改的设备名称',
      expectedSettingsVersion: 0n,
    });
    expect((await api.getEnvironment({ envId })).environment?.name).toBe('用户修改的设备名称');
    const retained = await api.cancelDeviceConnection({
      clientActionId: 'cancel-after-real-pairing',
      envId,
    });
    expect(retained.environment?.bindingStatus).toBe(EnvironmentBindingStatus.ACTIVE);
    await api.revokeEnvironment({ clientActionId: 'revoke-real-device', envId });
    expect(await api.listEnvironments({})).not.toHaveProperty('defaultEnvId');
  });
});
