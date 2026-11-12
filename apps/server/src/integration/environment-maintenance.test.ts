import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperationStatus } from '@kairos/contracts/device';
import { expect, it, vi } from 'vitest';
import { startRealEnvironmentServer } from './environment-fixture.js';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const daemonMain = join(repository, 'apps/daemon/src/main.ts');
const tenantId = 'maintenance-integration-owner';

type MaintenanceFixture = Awaited<ReturnType<typeof startRealEnvironmentServer>>;

async function control(
  fixture: MaintenanceFixture,
  command: 'drain' | 'revoke',
  args: string[] = [],
) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      daemonMain,
      command,
      '--identity-path',
      join(fixture.identityDirectory, 'identity.json'),
      '--timeout-seconds',
      '5',
      ...args,
    ],
    {
      cwd: repository,
      env: { ...process.env, KAIROS_DAEMON_VERSION: 'candidate-control-version' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

function directoryOperationCount(fixture: MaintenanceFixture) {
  return fixture.database
    .prepare(
      "SELECT COUNT(*) AS count FROM environment_operations WHERE env_id = ? AND action = 'directory_check'",
    )
    .get(fixture.envId);
}

async function startBash(fixture: MaintenanceFixture, operationId: string, command: string) {
  await fixture.channel.startEnvironmentOperation({
    operationId,
    tenantId,
    envId: fixture.envId,
    bindingVersion: 1n,
    action: { case: 'bash', value: { command, cwd: fixture.workspace, timeoutSeconds: 30 } },
    expiresAt: new Date(Date.now() + 60_000),
  });
  await vi.waitFor(() =>
    expect(fixture.operations.getForTenant(tenantId, operationId).nextOffset).toBeGreaterThan(0n),
  );
}

it('runs candidate drain clients alongside a live Daemon without changing its instance or profile', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-live-maintenance-'));
  const fixture = await startRealEnvironmentServer(directory, {
    ownerId: tenantId,
    accessToken: 'maintenance-test-session',
  });
  try {
    const identityPath = join(fixture.identityDirectory, 'identity.json');
    const originalIdentity = readFileSync(identityPath, 'utf8');
    const before = fixture.environments.get(tenantId, fixture.envId);
    const directoryChecks = directoryOperationCount(fixture);
    await startBash(fixture, 'live-bash', 'printf active; sleep 25');
    fixture.environments.setMaintenance({
      tenantId,
      envId: fixture.envId,
      clientActionId: 'enter-draining',
      mode: 'draining',
      expectedVersion: 0n,
    });

    const busy = await control(fixture, 'drain', ['--expected-version', '1']);
    expect(busy.code).not.toBe(0);
    expect(busy.stderr).toContain('active operations');
    expect(fixture.operations.getForTenant(tenantId, 'live-bash').resultRecordedAt).toBeUndefined();
    expect(fixture.environments.get(tenantId, fixture.envId)).toMatchObject({
      instanceId: before.instanceId,
      connectionStatus: 'online',
      ready: true,
      daemonVersion: before.daemonVersion,
    });

    await fixture.channel.cancelEnvironmentOperation({
      tenantId,
      operationId: 'live-bash',
      reason: 'Finish controlled drain test.',
    });
    await vi.waitFor(() =>
      expect(
        fixture.operations.getForTenant(tenantId, 'live-bash').resultAcknowledgedAt,
      ).toBeDefined(),
    );
    const results = await Promise.all([
      control(fixture, 'drain', ['--expected-version', '1']),
      control(fixture, 'drain', ['--expected-version', '1']),
    ]);
    for (const result of results) expect(result).toEqual({ code: 0, stdout: '1\n', stderr: '' });
    expect(readFileSync(identityPath, 'utf8')).toBe(originalIdentity);
    expect(directoryOperationCount(fixture)).toEqual(directoryChecks);
    expect(fixture.environments.get(tenantId, fixture.envId)).toMatchObject({
      instanceId: before.instanceId,
      connectionStatus: 'online',
      ready: true,
      daemonVersion: before.daemonVersion,
      capabilityStatus: 'ready',
      directoryStatus: 'ready',
      maintenanceMode: 'draining',
      maintenanceVersion: '1',
    });
    expect(fixture.operations.getForTenant(tenantId, 'live-bash').resultStatus).toBe(
      OperationStatus.CANCELLED,
    );

    const wrongVersion = await control(fixture, 'drain', ['--expected-version', '0']);
    expect(wrongVersion.code).not.toBe(0);
    expect(wrongVersion.stderr).toContain('maintenance version changed');
    expect(directoryOperationCount(fixture)).toEqual(directoryChecks);
    expect(readFileSync(identityPath, 'utf8')).toBe(originalIdentity);
  } finally {
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('revokes the original live instance and preserves confirmed output when a control CLI requests removal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-live-revoke-'));
  const fixture = await startRealEnvironmentServer(directory, {
    ownerId: tenantId,
    accessToken: 'revoke-test-session',
  });
  try {
    const before = fixture.environments.get(tenantId, fixture.envId);
    const identityPath = join(fixture.identityDirectory, 'identity.json');
    const originalIdentity = readFileSync(identityPath, 'utf8');
    const marker = join(fixture.workspace, 'must-not-run-after-revoke');
    await startBash(
      fixture,
      'revoked-bash',
      `printf confirmed; sleep 3; printf forbidden > '${marker}'`,
    );
    await vi.waitFor(() =>
      expect(fixture.operations.getForTenant(tenantId, 'revoked-bash').nextOffset).toBeGreaterThan(
        0n,
      ),
    );
    const result = await control(fixture, 'revoke');
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('persisted environment revocation');
    expect(fixture.environments.get(tenantId, fixture.envId)).toMatchObject({
      bindingStatus: 'revoked',
      connectionStatus: 'offline',
    });
    const operation = fixture.operations.getForTenant(tenantId, 'revoked-bash');
    expect(operation).toMatchObject({
      targetInstanceId: before.instanceId,
      resultStatus: OperationStatus.UNKNOWN,
      resultSource: 'recovery',
      outputComplete: false,
      outputGap: true,
    });
    expect(
      fixture.operations
        .readOutputForTenant(tenantId, 'revoked-bash', 0n, 1024)
        .map((chunk) => Buffer.from(chunk.data).toString('utf8'))
        .join(''),
    ).toContain('confirmed');
    expect(readFileSync(identityPath, 'utf8')).toBe(originalIdentity);
    await vi.waitFor(() =>
      expect(fixture.daemon.output()).toContain('Server rejected device authentication'),
    );
    await new Promise((resolve) => setTimeout(resolve, 3200));
    expect(existsSync(marker)).toBe(false);
  } finally {
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
