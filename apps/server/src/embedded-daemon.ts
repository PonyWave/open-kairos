import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { EnvironmentStore } from './devices/environment-store.js';
import type { MainEnvironmentConfiguration } from './devices/main-environment.js';
import { ensureMainEnvironment } from './devices/main-environment.js';

export interface EmbeddedDaemonOptions {
  database: DatabaseSync;
  tenantId: string;
  mainEnvironment: MainEnvironmentConfiguration;
  port: number;
  dataDirectory: string;
  onError?: (error: unknown) => void;
}

export interface EmbeddedDaemon {
  stop(): Promise<void>;
}

function daemonEntry(): string[] {
  const dist = fileURLToPath(new URL('../../daemon/dist/main.js', import.meta.url));
  if (existsSync(dist)) return [dist];
  return ['--import', 'tsx', fileURLToPath(new URL('../../daemon/src/main.ts', import.meta.url))];
}

async function runPairOnce(input: {
  envId: string;
  serverUrl: string;
  directory: string;
  identityPath: string;
  pairingCredential: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        ...daemonEntry(),
        'pair-once',
        '--env-id',
        input.envId,
        '--server-url',
        input.serverUrl,
        '--directory',
        input.directory,
        '--identity-path',
        input.identityPath,
        '--timeout-seconds',
        '60',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Embedded daemon pair-once failed (${code}): ${output}`));
    });
    child.stdin.end(input.pairingCredential);
  });
}

export async function startEmbeddedDaemon(options: EmbeddedDaemonOptions): Promise<EmbeddedDaemon> {
  const identityPath = join(options.dataDirectory, 'daemon-identity.json');
  const serverUrl = `ws://127.0.0.1:${options.port}/devices/wss`;
  await mkdir(options.mainEnvironment.workspace, { recursive: true });
  const envId = ensureMainEnvironment(options.database, options.tenantId, options.mainEnvironment);
  if (!existsSync(identityPath)) {
    const environments = new EnvironmentStore(options.database);
    const issued = environments.reissue({
      tenantId: options.tenantId,
      clientActionId: `embedded-daemon-${randomUUID()}`,
      envId,
    });
    await runPairOnce({
      envId,
      serverUrl,
      directory: options.mainEnvironment.workspace,
      identityPath,
      pairingCredential: issued.pairingCredential,
    });
  }
  const child = spawn(process.execPath, daemonEntry(), {
    env: {
      ...process.env,
      KAIROS_DEVICE_IDENTITY_PATH: identityPath,
      KAIROS_DEVICE_SERVER_URL: serverUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  child.once('exit', (code) => {
    if (code !== null && code !== 0) {
      options.onError?.(new Error(`Embedded daemon exited (${code}): ${output}`));
    }
  });
  let stopping = false;
  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timeout);
    },
  };
}
