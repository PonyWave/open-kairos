import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createPortReservation } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { DeviceInstaller } from './device-installer.js';
import { EnvironmentStore } from './environment-store.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function reservePort(): Promise<number> {
  const reservation = createPortReservation();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port.');
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kairos-bootstrap-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const staging = join(root, 'staging');
  mkdirSync(staging);
  writeFileSync(
    join(staging, 'install.sh'),
    '#!/usr/bin/env bash\nset -euo pipefail\nIFS= read -r value\nprintf "%s" "$value" > "$TEST_INSTALL_RECEIPT"\nprintf "%s\\n" "$@" > "$TEST_INSTALL_RECEIPT.args"\n',
  );
  const file = 'kairos-daemon-test-bootstrap.tar.gz';
  const archive = join(root, file);
  execFileSync('tar', ['-czf', archive, '-C', staging, '.']);
  const target = `${process.platform}-${process.arch}`;
  writeFileSync(
    join(root, `release-${target}.json`),
    JSON.stringify({
      version: 'test',
      platform: process.platform,
      architecture: process.arch,
      file,
      sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
    }),
  );
  const port = await reservePort();
  const installer = new DeviceInstaller(root, `http://127.0.0.1:${port}`);
  const server: FastifyInstance = Fastify({ logger: false });
  installer.register(server);
  cleanup.push(() => server.close());
  await server.listen({ host: '127.0.0.1', port });
  const database = openDatabase(':memory:');
  cleanup.push(() => database.close());
  new SessionStore(database);
  const now = new Date().toISOString();
  database
    .prepare(
      "INSERT INTO users(user_id,email,email_verified_at,username,status,created_at,updated_at) VALUES ('installer-user','test@example.com',?,'test','active',?,?)",
    )
    .run(now, now, now);
  database
    .prepare(
      "INSERT INTO tenants(tenant_id,user_id,created_at,updated_at) VALUES ('installer-tenant','installer-user',?,?)",
    )
    .run(now, now);
  database
    .prepare("UPDATE users SET tenant_id = 'installer-tenant' WHERE user_id = 'installer-user'")
    .run();
  const issue = new EnvironmentStore(database).beginConnection({
    tenantId: 'installer-tenant',
    clientActionId: 'bootstrap-fixture',
  });
  const receipt = join(root, 'receipt');
  const run = async () => {
    const child = spawn('bash', ['-c', installer.command(issue)], {
      env: { ...process.env, TEST_INSTALL_RECEIPT: receipt },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    return { code, output };
  };
  return { root, archive, installer, issue, server, receipt, run };
}

describe('device installation download and bootstrap', () => {
  it('selects the requested environment in every Daemon command', () => {
    const installer = new DeviceInstaller('/unused', 'https://example.test');
    expect(installer.daemonCommands('env-test')).toEqual({
      startCommand: '~/.local/bin/kairos-daemon start env-test',
      statusCommand: '~/.local/bin/kairos-daemon status env-test',
      stopCommand: '~/.local/bin/kairos-daemon stop env-test',
    });
    expect(installer.daemonCommands('env-prod')).toEqual({
      startCommand: '~/.local/bin/kairos-daemon start env-prod',
      statusCommand: '~/.local/bin/kairos-daemon status env-prod',
      stopCommand: '~/.local/bin/kairos-daemon stop env-prod',
    });
    expect(() => installer.daemonCommands('env-test; env-prod')).toThrow(
      'Environment identifier is invalid',
    );
  });

  it.runIf(
    process.platform === 'darwin' || (process.platform === 'linux' && process.getuid?.() === 0),
  )('downloads a checksum-verified release and passes the credential on stdin', async () => {
    const test = await fixture();
    test.installer.assertAvailable();
    const result = await test.run();
    expect(result.code, result.output).toBe(0);
    expect(readFileSync(test.receipt, 'utf8')).toBe(test.issue.pairingCredential);
    expect(readFileSync(`${test.receipt}.args`, 'utf8')).toContain(test.issue.environment.envId);
    expect(result.output).not.toContain(test.issue.pairingCredential);
    const traversal = await test.server.inject('/api/daemon/artifacts/..%2F.env');
    expect([400, 404]).toContain(traversal.statusCode);
  });

  it.runIf(
    process.platform === 'darwin' || (process.platform === 'linux' && process.getuid?.() === 0),
  )('rejects a tampered archive before executing its installer', async () => {
    const test = await fixture();
    writeFileSync(test.archive, 'tampered archive');
    const result = await test.run();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('checksum verification failed');
    expect(existsSync(test.receipt)).toBe(false);
  });
});
