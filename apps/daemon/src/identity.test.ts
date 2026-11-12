import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonIdentityError, DaemonIdentityStore, validateServerUrl } from './identity.js';

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-daemon-identity-'));
  directories.push(directory);
  return directory;
}

function identity() {
  return {
    version: 2 as const,
    envId: 'env-1',
    deviceId: 'device-1',
    deviceBindingId: 'binding-1',
    deviceCredential: 'kd1_secret',
    serverUrl: 'wss://server.example.test/devices/wss',
    deviceName: 'Ubuntu server',
    grantedCapabilities: ['directory_check' as const],
    daemonVersion: '1.2.3',
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('DaemonIdentityStore', () => {
  it('persists identity v2 without process or one-time credentials', () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'private', 'identity.json');
    const store = new DaemonIdentityStore(path);
    expect(store.load()).toBeUndefined();
    store.save(identity());

    expect(store.load()).toEqual(identity());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(path))).toEqual(['identity.json']);
    const saved = readFileSync(path, 'utf8');
    expect(saved).not.toContain('instanceId');
    expect(saved).not.toContain('pairingCredential');
    expect(JSON.parse(saved)).toEqual(identity());
  });

  it('rejects identity v1 and requires reauthorization', () => {
    const path = join(temporaryDirectory(), 'identity.json');
    const store = new DaemonIdentityStore(path);
    store.save(identity());
    chmodSync(path, 0o600);
    const legacy = {
      version: 1,
      deviceId: 'device-1',
      deviceCredential: 'kd1_secret',
      serverUrl: 'wss://server.example.test/devices/wss',
      deviceName: 'Legacy device',
      bashEnabled: true,
    };
    writeFileSync(path, JSON.stringify(legacy), { mode: 0o600 });

    expect(() => store.load()).toThrowError(DaemonIdentityError);
    expect(() => store.load()).toThrow('reauthorize');
    try {
      store.load();
    } catch (error) {
      expect(error).toMatchObject({ code: 'REAUTHORIZATION_REQUIRED' });
    }
  });

  it('rejects insecure permissions, invalid capabilities and non-WSS remote URLs', () => {
    const path = join(temporaryDirectory(), 'identity.json');
    const store = new DaemonIdentityStore(path);
    store.save(identity());
    chmodSync(path, 0o644);
    expect(() => store.load()).toThrow('0600');
    chmodSync(path, 0o600);
    expect(() =>
      store.save({ ...identity(), grantedCapabilities: ['file_write' as 'bash'] }),
    ).toThrow('unsupported granted capability');
    expect(validateServerUrl('ws://127.0.0.1:3000/devices/wss')).toContain('ws://');
    expect(() => validateServerUrl('ws://server.example.test/devices/wss')).toThrow('WSS');
  });
});
