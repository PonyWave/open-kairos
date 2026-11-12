import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  directory: '',
  connected: false,
  bootstrapReads: 0,
  reportTransport: false,
  stop: () => undefined,
}));
vi.mock('./identity.js', () => ({
  DaemonIdentityStore: class {
    load() {
      return { envId: 'saved-environment' };
    }
  },
}));
vi.mock('./connection/client.js', () => ({
  DaemonClient: class {
    constructor(options: { onError?: (error: unknown) => void }) {
      if (runtime.reportTransport) {
        const error = Object.assign(new Error('ke2_secret_must_not_be_logged'), {
          code: 'ECONNREFUSED',
        });
        options.onError?.(error);
        options.onError?.(error);
      }
      runtime.stop = () => {
        process.emit('SIGTERM');
        return undefined;
      };
    }
    start() {}
    async waitForConnection() {
      runtime.connected = true;
      setImmediate(() => runtime.stop());
    }
    async close() {}
  },
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const map = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    if (value.startsWith('/var/lib/kairos-identity/identity'))
      return value.replace(
        '/var/lib/kairos-identity/identity',
        join(runtime.directory, 'identity'),
      );
    if (value.startsWith('/workspace'))
      return value.replace('/workspace', join(runtime.directory, 'workspace'));
    if (value.includes('/workspace-seed/'))
      return join(runtime.directory, 'seed', value.split('/workspace-seed/')[1] ?? '');
    return value;
  };
  return {
    ...original,
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      if (args[0] === '/etc/kairos-pod/name') return 'platform-pod';
      if (args[0] === '/etc/kairos-pod/uid') return '11111111-1111-1111-1111-111111111111';
      if (args[0] === '/var/lib/kairos-identity/identity/bootstrap.json') runtime.bootstrapReads++;
      return Reflect.apply(original.readFile, original, [map(args[0]), ...args.slice(1)]);
    },
    mkdir: async (...args: Parameters<typeof original.mkdir>) =>
      Reflect.apply(original.mkdir, original, [map(args[0]), ...args.slice(1)]),
    open: async (...args: Parameters<typeof original.open>) =>
      Reflect.apply(original.open, original, [map(args[0]), ...args.slice(1)]),
    realpath: async (...args: Parameters<typeof original.realpath>) =>
      Reflect.apply(original.realpath, original, [map(args[0]), ...args.slice(1)]),
    unlink: async (path: Parameters<typeof original.unlink>[0]) => {
      expect(runtime.connected).toBe(true);
      return original.unlink(map(path) as string);
    },
  };
});

import { runPlatformForeground } from './platform.js';

afterEach(async () => {
  vi.unstubAllEnvs();
  if (runtime.directory) await rm(runtime.directory, { recursive: true, force: true });
  runtime.directory = '';
  runtime.connected = false;
  runtime.bootstrapReads = 0;
  runtime.reportTransport = false;
  vi.restoreAllMocks();
});

it.each(['residual', 'missing', 'directory'] as const)(
  'cleans a %s bootstrap after reconnect with an existing identity without reading expired credentials',
  async (kind) => {
    runtime.directory = await mkdtemp(join(tmpdir(), 'kairos-platform-reconnect-'));
    vi.stubEnv('KAIROS_PLATFORM_ENV_ID', 'saved-environment');
    for (const name of ['identity', 'workspace', 'seed'])
      await mkdir(join(runtime.directory, name));
    const originalIdentity = 'existing persisted identity bytes';
    await writeFile(join(runtime.directory, 'identity/identity.json'), originalIdentity);
    const seed = '# Platform workspace\n';
    await writeFile(join(runtime.directory, 'seed/AGENTS.md'), seed);
    await writeFile(
      join(runtime.directory, 'seed/manifest.json'),
      JSON.stringify({ 'AGENTS.md': createHash('sha256').update(seed).digest('hex') }),
    );
    const bootstrap = join(runtime.directory, 'identity/bootstrap.json');
    runtime.reportTransport = kind === 'missing';
    const diagnostics = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    if (kind === 'residual')
      await writeFile(bootstrap, 'expired credential content must never be parsed', {
        mode: 0o600,
      });
    if (kind === 'directory') await mkdir(bootstrap);
    if (kind === 'directory') {
      await expect(runPlatformForeground()).rejects.toMatchObject({
        code: expect.not.stringMatching(/^ENOENT$/),
      });
      expect(diagnostics).toHaveBeenCalledWith(
        expect.stringContaining('platform initialization_failed type=Error code='),
      );
    } else {
      await runPlatformForeground();
      await expect(readFile(bootstrap)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(runtime.bootstrapReads).toBe(0);
    if (kind === 'missing') {
      expect(diagnostics).toHaveBeenCalledTimes(1);
      expect(diagnostics).toHaveBeenCalledWith(
        'kairos-daemon: platform transport type=Error code=ECONNREFUSED\n',
      );
    }
    expect(await readFile(join(runtime.directory, 'identity/identity.json'), 'utf8')).toBe(
      originalIdentity,
    );
  },
);
