import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { EnvironmentStore } from '../devices/environment-store.js';
import { startEmbeddedDaemon } from '../embedded-daemon.js';
import { openDatabase } from '../storage/database.js';
import { createTestServer } from './test-authentication.js';

it('pairs the main environment through the embedded daemon and stops it cleanly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-embedded-daemon-'));
  const database = openDatabase(':memory:');
  const mainEnvironment = { envId: 'main', workspace: join(directory, 'workspace') };
  const server = createTestServer(database, false, { mainEnvironment });
  let daemon: { stop(): Promise<void> } | undefined;
  try {
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The embedded daemon test Server has no TCP address.');
    }
    daemon = await startEmbeddedDaemon({
      database,
      tenantId: 'local-user',
      mainEnvironment,
      port: address.port,
      dataDirectory: directory,
    });
    const environments = new EnvironmentStore(database);
    await vi.waitFor(
      () => {
        expect(environments.get('local-user', 'main').ready).toBe(true);
      },
      { timeout: 45_000 },
    );
    expect(environments.get('local-user', 'main').normalizedPwd).toBe(
      await realpath(join(directory, 'workspace')),
    );
  } finally {
    await daemon?.stop();
    if (database.isOpen) await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
