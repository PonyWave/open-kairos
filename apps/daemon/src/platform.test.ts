import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceErrorCode } from '@kairos/contracts/device';
import { expect, it } from 'vitest';
import {
  initializePlatformWorkspace,
  platformConnectionDiagnostic,
  writePlatformBootstrapFile,
} from './platform.js';

it('reports only bounded known connection phases, error names and codes without copying error content', () => {
  const secret = 'ke2_do_not_print_this_credential';
  const error = new Error(`request contained ${secret}`);
  Object.assign(error, { code: 'ECONNREFUSED', request: { secret } });
  expect(platformConnectionDiagnostic('transport', error)).toBe(
    'kairos-daemon: platform transport type=Error code=ECONNREFUSED\n',
  );
  for (const input of [
    { name: secret, code: secret, message: secret },
    { code: DeviceErrorCode.PERMISSION_DENIED, message: secret },
    new Error(
      `Server rejected device authentication with code ${DeviceErrorCode.PERMISSION_DENIED}.`,
    ),
  ]) {
    const line = platformConnectionDiagnostic('authentication_stopped', input);
    expect(line).not.toContain(secret);
    expect(line.length).toBeLessThan(160);
  }
  expect(
    platformConnectionDiagnostic('authentication_stopped', {
      code: DeviceErrorCode.PERMISSION_DENIED,
      message: secret,
    }),
  ).toContain(`code=device_${DeviceErrorCode.PERMISSION_DENIED}`);
});

it('seeds only missing workspace resources and refuses missing or corrupted immutable seed content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-platform-seed-'));
  const workspace = join(directory, 'workspace');
  const seed = join(directory, 'seed');
  try {
    await mkdir(workspace);
    await mkdir(seed);
    const content = '# 平台工作区\n';
    await writeFile(join(seed, 'AGENTS.md'), content);
    await writeFile(
      join(seed, 'manifest.json'),
      JSON.stringify({ 'AGENTS.md': createHash('sha256').update(content).digest('hex') }),
    );
    await initializePlatformWorkspace(workspace, seed);
    expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toBe(content);
    await writeFile(join(workspace, 'AGENTS.md'), 'user instructions');
    await mkdir(join(workspace, '.agents/skills/custom'));
    await writeFile(join(workspace, '.agents/skills/custom/SKILL.md'), 'user skill');
    await initializePlatformWorkspace(workspace, seed);
    expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toBe('user instructions');
    expect(await readFile(join(workspace, '.agents/skills/custom/SKILL.md'), 'utf8')).toBe(
      'user skill',
    );
    await writeFile(join(seed, 'AGENTS.md'), 'modified');
    await expect(initializePlatformWorkspace(workspace, seed)).rejects.toThrow('checksum');
    await rm(join(seed, 'manifest.json'));
    await expect(initializePlatformWorkspace(workspace, seed)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('replaces only a proven unpaired initialization and handles A-written/B-never-written/C retries by prior content hashes', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kairos-bootstrap-retry-')));
  const base = {
    envId: 'env-test',
    serverUrl: 'wss://server.example/devices/wss',
    initializationOperationId: '11111111-1111-1111-1111-111111111111',
  };
  const first = JSON.stringify({ ...base, pairingCredential: 'ke2_first' });
  const hashA = createHash('sha256').update(first).digest('hex');
  const second = JSON.stringify({
    ...base,
    pairingCredential: 'ke2_second',
    bootstrapAttemptId: '22222222-2222-2222-2222-222222222222',
    replacesSha256s: [hashA],
  });
  const hashB = createHash('sha256').update(second).digest('hex');
  const third = JSON.stringify({
    ...base,
    pairingCredential: 'ke2_third',
    bootstrapAttemptId: '33333333-3333-3333-3333-333333333333',
    replacesSha256s: [hashA, hashB],
  });
  try {
    await writePlatformBootstrapFile(directory, first);
    await expect(
      writePlatformBootstrapFile(directory, second.replace(hashA, 'a'.repeat(64))),
    ).rejects.toThrow('replacement');
    expect(await readFile(join(directory, 'bootstrap.json'), 'utf8')).toBe(first);
    // Attempt B's process never reached the write; C must still recognize the actually stored A.
    await writePlatformBootstrapFile(directory, third);
    expect(await readFile(join(directory, 'bootstrap.json'), 'utf8')).toBe(third);
    await writeFile(join(directory, 'identity.json'), 'existing device identity', { mode: 0o600 });
    await expect(writePlatformBootstrapFile(directory, first)).rejects.toThrow(
      'identity must never be overwritten',
    );
    expect(await readFile(join(directory, 'identity.json'), 'utf8')).toBe(
      'existing device identity',
    );
    expect(await readFile(join(directory, 'bootstrap.json'), 'utf8')).toBe(third);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
