import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readPlatformConfiguration } from './config-platform.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function read(changes: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-platform-config-'));
  directories.push(directory);
  const path = join(directory, 'configuration.json');
  writeFileSync(
    path,
    JSON.stringify({
      deploymentId: 'test',
      controlDatabasePath: '/srv/kairos/platform/control.sqlite',
      lifecycleUrl: 'http://10.251.0.20',
      apiKeyFile: '/srv/kairos/credentials/api-key',
      kubernetesUrl: 'https://127.0.0.1:6443',
      kubernetesCaFile: '/srv/kairos/ca.crt',
      kubernetesTokenFile: '/srv/kairos/credentials/kubernetes-token',
      cluster: {
        caSha256: 'a'.repeat(64),
        nodeUid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        nodeName: 'kairos-k1',
        namespace: 'opensandbox',
      },
      image: `registry.example/base/ubuntu@sha256:${'b'.repeat(64)}`,
      serverWssUrl: 'wss://kairos.example/devices/wss',
      sharedReleaseClaim: 'kairos-daemon-program',
      registryUrl: 'https://10.251.0.50:5000',
      registryCaFile: '/srv/kairos/registry-ca.crt',
      registryCredentialsFile: '/srv/kairos/credentials/registry.json',
      cgroupProofFile: '/etc/kairos/scope.json',
      ...changes,
    }),
  );
  return readPlatformConfiguration(path);
}

it('loads explicit service and credential-file locations with at most five slots', () => {
  const configuration = read();
  expect(configuration.capacity).toBe(5);
  expect(configuration.preparationTimeoutMs).toBe(180_000);
  expect(configuration.requestTimeoutMs).toBe(75_000);
  expect(configuration.idleTimeoutMs).toBe(3_600_000);
  expect(configuration.controlDatabasePath).toBe('/srv/kairos/platform/control.sqlite');
  expect(read({ deploymentId: 'prod' }).controlDatabasePath).toBe(
    configuration.controlDatabasePath,
  );
});

it.each([
  { capacity: 6 },
  { capacity: 0 },
  { idleTimeoutMs: 0 },
  { idleTimeoutMs: -1 },
  { idleTimeoutMs: 3_600_000.5 },
  { controlDatabasePath: './control.sqlite' },
  { apiKey: 'inline-secret' },
  { apiKeyFile: 'relative-key' },
  { kubernetesUrl: 'http://127.0.0.1:6443' },
  { registryUrl: 'http://10.251.0.50:5000' },
  { lifecycleUrl: 'http://user:secret@example.test' },
  { serverWssUrl: 'ws://public.example/devices/wss' },
  { image: 'ubuntu:latest' },
  { cluster: { nodeName: 'kairos-k1' } },
])('rejects unsafe or incomplete deployment configuration %j', (changes) => {
  expect(() => read(changes)).toThrow();
});

it('rejects oversized configuration without parsing it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-platform-config-'));
  directories.push(directory);
  const path = join(directory, 'large.json');
  writeFileSync(path, ' '.repeat(64 * 1024 + 1));
  expect(() => readPlatformConfiguration(path)).toThrow('exceeds 64 KiB');
});
