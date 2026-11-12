import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeviceErrorCode } from '@kairos/contracts/device';
import { DaemonClient } from './connection/client.js';
import { DaemonIdentityStore } from './identity.js';

interface Bootstrap {
  envId: string;
  serverUrl: string;
  pairingCredential: string;
  initializationOperationId: string;
  bootstrapAttemptId?: string;
  replacesSha256?: string;
  replacesSha256s?: string[];
}

export function platformConnectionDiagnostic(
  stage: 'transport' | 'authentication_stopped' | 'initialization_failed',
  error: unknown,
): string {
  const value = typeof error === 'object' && error !== null ? error : undefined;
  const protocolCode =
    value && 'code' in value && typeof value.code === 'number' && isDeviceErrorCode(value.code)
      ? value.code
      : undefined;
  const authentication =
    error instanceof Error
      ? /^Server rejected device authentication with code ([0-9]+)\.$/.exec(error.message)
      : null;
  const authenticationCode = authentication ? Number(authentication[1]) : undefined;
  const knownName =
    error instanceof Error &&
    [
      'Error',
      'TypeError',
      'RangeError',
      'SyntaxError',
      'AggregateError',
      'AbortError',
      'DaemonReadinessError',
    ].includes(error.name)
      ? error.name
      : protocolCode !== undefined
        ? 'DeviceError'
        : 'UnknownError';
  const osCodes = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EPIPE',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'EACCES',
    'EPERM',
    'ENOENT',
    'ENOTDIR',
    'EISDIR',
    'EEXIST',
    'EROFS',
    'ENOSPC',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
  ];
  const code =
    protocolCode !== undefined
      ? `device_${protocolCode}`
      : authenticationCode !== undefined && isDeviceErrorCode(authenticationCode)
        ? `device_${authenticationCode}`
        : value && 'code' in value && typeof value.code === 'string' && osCodes.includes(value.code)
          ? value.code
          : 'unknown';
  return `kairos-daemon: platform ${stage} type=${knownName} code=${code}\n`;
}
function parseBootstrap(raw: string): Bootstrap {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('envId' in value) ||
    typeof value.envId !== 'string' ||
    !('serverUrl' in value) ||
    typeof value.serverUrl !== 'string' ||
    !('pairingCredential' in value) ||
    typeof value.pairingCredential !== 'string' ||
    value.pairingCredential.length > 512
  )
    throw new Error('Platform bootstrap configuration is invalid.');
  if (
    !('initializationOperationId' in value) ||
    typeof value.initializationOperationId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.initializationOperationId)
  )
    throw new Error('Platform initialization operation is invalid.');
  return {
    envId: value.envId,
    serverUrl: value.serverUrl,
    pairingCredential: value.pairingCredential,
    initializationOperationId: value.initializationOperationId,
    ...('bootstrapAttemptId' in value && typeof value.bootstrapAttemptId === 'string'
      ? { bootstrapAttemptId: value.bootstrapAttemptId }
      : {}),
    ...('replacesSha256' in value && typeof value.replacesSha256 === 'string'
      ? { replacesSha256: value.replacesSha256 }
      : {}),
    ...('replacesSha256s' in value
      ? {
          replacesSha256s:
            Array.isArray(value.replacesSha256s) &&
            value.replacesSha256s.length <= 3 &&
            value.replacesSha256s.every(
              (entry) => typeof entry === 'string' && /^[a-f0-9]{64}$/.test(entry),
            )
              ? value.replacesSha256s
              : (() => {
                  throw new Error('Bootstrap predecessor hashes are invalid.');
                })(),
        }
      : {}),
  };
}
export async function writePlatformBootstrapFile(directory: string, raw: string): Promise<void> {
  const bootstrap = parseBootstrap(raw);
  if (bootstrap.replacesSha256 && !/^[a-f0-9]{64}$/.test(bootstrap.replacesSha256))
    throw new Error('Bootstrap replacement proof is invalid.');
  if (bootstrap.bootstrapAttemptId && !/^[a-f0-9-]{36}$/.test(bootstrap.bootstrapAttemptId))
    throw new Error('Bootstrap attempt identity is invalid.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== resolve(directory))
    throw new Error('Bootstrap identity directory must not be a symbolic link.');
  const assertUnpaired = async () => {
    try {
      await lstat(join(directory, 'identity.json'));
      throw new Error('An existing platform identity must never be overwritten.');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  };
  await assertUnpaired();
  const destination = join(directory, 'bootstrap.json');
  try {
    const output = await open(destination, 'wx', 0o600);
    try {
      await output.writeFile(raw);
      await output.sync();
    } finally {
      await output.close();
    }
    return;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const previousInfo = await lstat(destination);
  if (
    !previousInfo.isFile() ||
    previousInfo.isSymbolicLink() ||
    (previousInfo.mode & 0o077) !== 0 ||
    previousInfo.size > 4096
  )
    throw new Error('Existing bootstrap file cannot be safely replaced.');
  const previous = await readFile(destination, 'utf8');
  const previousHash = createHash('sha256').update(previous).digest('hex');
  const previousBootstrap = parseBootstrap(previous);
  if (
    ![
      ...(bootstrap.replacesSha256s ?? []),
      ...(bootstrap.replacesSha256 ? [bootstrap.replacesSha256] : []),
    ].includes(previousHash) ||
    previousBootstrap.envId !== bootstrap.envId ||
    previousBootstrap.initializationOperationId !== bootstrap.initializationOperationId
  )
    throw new Error('Bootstrap replacement does not match the failed unpaired initialization.');
  const temporary = join(
    directory,
    `bootstrap.${bootstrap.bootstrapAttemptId ?? bootstrap.initializationOperationId}.new`,
  );
  const output = await open(temporary, 'wx', 0o600);
  try {
    await output.writeFile(raw);
    await output.sync();
  } finally {
    await output.close();
  }
  try {
    await assertUnpaired();
    const current = await lstat(destination);
    if (
      current.ino !== previousInfo.ino ||
      current.dev !== previousInfo.dev ||
      createHash('sha256')
        .update(await readFile(destination))
        .digest('hex') !== previousHash
    )
      throw new Error('Bootstrap replacement file changed during preparation.');
    await rename(temporary, destination);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (
        !(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT')
      )
        throw new AggregateError(
          [error, cleanupError],
          'Bootstrap replacement and temporary-file cleanup failed.',
        );
    }
    throw error;
  }
}

export async function initializePlatformWorkspace(
  workspace: string,
  seedRoot: string,
): Promise<void> {
  const manifestRaw = await readFile(join(seedRoot, 'manifest.json'), 'utf8');
  const manifest: unknown = JSON.parse(manifestRaw);
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('AGENTS.md' in manifest) ||
    typeof manifest['AGENTS.md'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest['AGENTS.md'])
  )
    throw new Error('The fixed platform workspace seed manifest is invalid.');
  const bytes = await readFile(join(seedRoot, 'AGENTS.md'));
  if (
    bytes.length > 64 * 1024 ||
    createHash('sha256').update(bytes).digest('hex') !== manifest['AGENTS.md']
  )
    throw new Error('The fixed platform workspace seed checksum does not match.');
  await mkdir(join(workspace, '.agents/skills'), { recursive: true, mode: 0o755 });
  try {
    const file = await open(join(workspace, 'AGENTS.md'), 'wx', 0o644);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
}

/** Trusted initializer only: never replaces an identity or an existing bootstrap file. */
export async function writePlatformBootstrap(): Promise<void> {
  const input = await open('/run/kairos-bootstrap/bootstrap.json', 'r');
  let raw: string;
  try {
    const meta = await input.stat();
    if (meta.size > 4096) throw new Error('Platform bootstrap is too large.');
    raw = await input.readFile('utf8');
  } finally {
    await input.close();
  }
  const bootstrap = parseBootstrap(raw);
  await writePlatformBootstrapFile('/var/lib/kairos-identity/identity', raw);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      if (
        (await readFile('/run/kairos-bootstrap/observed', 'utf8')).trim() ===
        bootstrap.initializationOperationId
      )
        return;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Bootstrap physical observation was not acknowledged before its deadline.');
}

/** One process pairs once, then continues using the same authenticated DaemonClient. */
export async function runPlatformForeground(): Promise<void> {
  try {
    await runPlatformForegroundProcess();
  } catch (error) {
    process.stderr.write(platformConnectionDiagnostic('initialization_failed', error));
    throw error;
  }
}

async function runPlatformForegroundProcess(): Promise<void> {
  const podName = (await readFile('/etc/kairos-pod/name', 'utf8')).trim();
  const podUid = (await readFile('/etc/kairos-pod/uid', 'utf8')).trim();
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(podName) || !/^[a-f0-9-]{36}$/.test(podUid))
    throw new Error('Downward API platform Pod identity is invalid.');
  const identityPath = '/var/lib/kairos-identity/identity/identity.json';
  await mkdir(dirname(identityPath), { recursive: true, mode: 0o700 });
  const store = new DaemonIdentityStore(identityPath);
  const existing = store.load();
  let bootstrap: Bootstrap | undefined;
  if (!existing) {
    const file = await open('/var/lib/kairos-identity/identity/bootstrap.json', 'r');
    try {
      const meta = await file.stat();
      if (meta.size > 4096 || (meta.mode & 0o077) !== 0)
        throw new Error('Bootstrap identity file is invalid.');
      bootstrap = parseBootstrap(await file.readFile('utf8'));
    } finally {
      await file.close();
    }
  }
  const envId = existing?.envId ?? bootstrap?.envId;
  if (!envId || envId !== process.env.KAIROS_PLATFORM_ENV_ID)
    throw new Error('Platform identity belongs to another environment.');
  await initializePlatformWorkspace(
    '/workspace',
    fileURLToPath(new URL('../../../../workspace-seed/', import.meta.url)),
  );
  let settle: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let transportReported = false;
  const client = new DaemonClient({
    identityStore: store,
    envId,
    ...(bootstrap
      ? { serverUrl: bootstrap.serverUrl, pairingCredential: bootstrap.pairingCredential }
      : {}),
    deviceName: `platform-${envId}`,
    initialDirectory: '/workspace',
    bashEnabled: true,
    daemonVersion: process.env.KAIROS_DAEMON_VERSION ?? 'development',
    platformPod: { uid: podUid, name: podName },
    onError: (error) => {
      if (!transportReported) {
        transportReported = true;
        process.stderr.write(platformConnectionDiagnostic('transport', error));
      }
    },
    onFatalError: (error) => {
      process.stderr.write(platformConnectionDiagnostic('authentication_stopped', error));
      process.exitCode = 78;
      void client.close().finally(settle);
    },
  });
  const stop = () => {
    void client.close().finally(settle);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop);
  try {
    client.start();
    await client.waitForConnection(120_000);
    try {
      await unlink('/var/lib/kairos-identity/identity/bootstrap.json');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    bootstrap = undefined;
    // Initialization preserves existing tenant resources and never writes into a shared release.
    await realpath('/workspace');
    await done;
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.off(signal, stop);
    await client.close();
  }
}
