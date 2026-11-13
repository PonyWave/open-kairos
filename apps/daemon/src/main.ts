import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DaemonClient, DaemonReadinessError } from './connection/client.js';
import { DaemonIdentityStore } from './identity.js';
import { runPlatformForeground, writePlatformBootstrap } from './platform.js';
import { DaemonStatus, daemonStatusSocketPath, observeDaemonStatus } from './status.js';

const daemonVersion = process.env.KAIROS_DAEMON_VERSION ?? 'development';
const defaultIdentityPath = () =>
  process.env.KAIROS_DEVICE_IDENTITY_PATH ?? join(homedir(), '.kairos', 'daemon', 'identity.json');

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (index + 1 >= args.length) throw new Error(`${name} requires a value.`);
  return args[index + 1];
}

function assertKnownOptions(args: string[], names: string[]): void {
  const allowed = new Set(names);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index] ?? '') || index + 1 >= args.length) {
      throw new Error(`Invalid command options: ${args.join(' ')}`);
    }
  }
}

function timeoutOption(args: string[]): number {
  const value = optionValue(args, '--timeout-seconds');
  if (value === undefined) return 30_000;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 300) {
    throw new Error('Timeout must be between 1 and 300 seconds.');
  }
  return seconds * 1000;
}

async function pairingCredentialFromStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 512) throw new Error('Pairing credential exceeds the input limit.');
    chunks.push(bytes);
  }
  const credential = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
  if (credential.length === 0 || credential.length > 512 || /\s/.test(credential)) {
    throw new Error('Pairing credential must be a single non-empty token.');
  }
  return credential;
}

function environmentClient(
  identityStore: DaemonIdentityStore,
  options: {
    pairingCredential?: string;
    envId?: string;
    serverUrl?: string;
    deviceName?: string;
    initialDirectory?: string;
    bashEnabled?: boolean;
    status?: DaemonStatus;
    controlOnly?: boolean;
    onFatalError?: (error: Error) => void;
  },
): DaemonClient {
  const resourcesHome = process.env.KAIROS_DEVICE_RESOURCES_HOME;
  if (resourcesHome !== undefined && !isAbsolute(resourcesHome)) {
    throw new Error('KAIROS_DEVICE_RESOURCES_HOME must be an absolute path.');
  }
  return new DaemonClient({
    identityStore,
    daemonVersion,
    ...(resourcesHome === undefined ? {} : { resourceHomeDirectory: resourcesHome }),
    ...(options.controlOnly === undefined ? {} : { controlOnly: options.controlOnly }),
    ...(options.bashEnabled === undefined ? {} : { bashEnabled: options.bashEnabled }),
    ...(options.pairingCredential === undefined
      ? {}
      : { pairingCredential: options.pairingCredential }),
    ...(options.envId === undefined ? {} : { envId: options.envId }),
    ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl }),
    ...(options.deviceName === undefined ? {} : { deviceName: options.deviceName }),
    ...(options.initialDirectory === undefined
      ? {}
      : { initialDirectory: options.initialDirectory }),
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.onFatalError === undefined ? {} : { onFatalError: options.onFatalError }),
    onError: () => undefined,
  });
}

async function pairOnce(args: string[]): Promise<void> {
  assertKnownOptions(args, [
    '--env-id',
    '--server-url',
    '--directory',
    '--device-name',
    '--identity-path',
    '--timeout-seconds',
  ]);
  const identityPath = optionValue(args, '--identity-path') ?? defaultIdentityPath();
  const identityStore = new DaemonIdentityStore(identityPath);
  const existing = identityStore.load();
  const envId = optionValue(args, '--env-id') ?? existing?.envId;
  if (existing !== undefined && envId !== existing.envId) {
    throw new Error('Existing identity belongs to another environment; refusing to replace it.');
  }
  const directory = optionValue(args, '--directory');
  if (directory !== undefined && !directory.startsWith('/')) {
    throw new Error('Working directory must be an absolute path.');
  }
  const pairingCredential =
    existing === undefined
      ? (process.env.KAIROS_DEVICE_PAIRING_CREDENTIAL ??
        (await pairingCredentialFromStandardInput()))
      : undefined;
  delete process.env.KAIROS_DEVICE_PAIRING_CREDENTIAL;
  const serverUrl = optionValue(args, '--server-url') ?? process.env.KAIROS_DEVICE_SERVER_URL;
  const client = environmentClient(identityStore, {
    ...(pairingCredential === undefined ? {} : { pairingCredential }),
    ...(envId === undefined ? {} : { envId }),
    ...(serverUrl === undefined ? {} : { serverUrl }),
    deviceName: optionValue(args, '--device-name') ?? process.env.KAIROS_DEVICE_NAME ?? hostname(),
    ...(directory === undefined ? {} : { initialDirectory: directory }),
  });
  const readiness = client.waitForReadiness(timeoutOption(args));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void client.close());
  }
  client.start();
  try {
    const normalizedPath = await readiness;
    if (directory !== undefined && (await realpath(directory)) !== normalizedPath) {
      throw new DaemonReadinessError(
        'Server readiness confirmed a different working directory; installation is not ready.',
      );
    }
    process.stdout.write('kairos-daemon: pairing and persisted readiness confirmed.\n');
  } catch (error) {
    const bound = identityStore.load() !== undefined;
    const message = error instanceof Error ? error.message : 'Pairing failed.';
    if (bound) {
      process.stderr.write(`kairos-daemon: bound but not executable: ${message}\n`);
      process.exitCode = 69;
    } else {
      process.stderr.write(`kairos-daemon: environment remains unbound: ${message}\n`);
      process.exitCode = 78;
    }
  } finally {
    await client.close();
  }
}

async function drain(args: string[]): Promise<void> {
  assertKnownOptions(args, ['--expected-version', '--timeout-seconds', '--identity-path']);
  const identityStore = new DaemonIdentityStore(
    optionValue(args, '--identity-path') ?? defaultIdentityPath(),
  );
  const client = environmentClient(identityStore, { controlOnly: true });
  const expectedText = optionValue(args, '--expected-version');
  const expectedVersion = expectedText === undefined ? undefined : BigInt(expectedText);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void client.close());
  }
  client.start();
  try {
    const version = await client.waitForDrain(expectedVersion, timeoutOption(args));
    process.stdout.write(`${version}\n`);
  } finally {
    await client.close();
  }
}

async function revoke(args: string[]): Promise<void> {
  assertKnownOptions(args, ['--timeout-seconds', '--identity-path']);
  const identityStore = new DaemonIdentityStore(
    optionValue(args, '--identity-path') ?? defaultIdentityPath(),
  );
  const client = environmentClient(identityStore, { controlOnly: true });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void client.close());
  }
  client.start();
  try {
    await client.revokeEnvironment(timeoutOption(args));
    process.stdout.write('kairos-daemon: Server persisted environment revocation.\n');
  } finally {
    await client.close();
  }
}

async function startService(): Promise<void> {
  const identityPath = defaultIdentityPath();
  const identityStore = new DaemonIdentityStore(identityPath);
  if (identityStore.load() === undefined) {
    throw new Error('No environment identity exists; run pair-once before starting the service.');
  }
  const status = new DaemonStatus(daemonStatusSocketPath(identityPath), {
    cleanupDirectory: true,
  });
  await status.listen();
  let client: DaemonClient | undefined;
  let fatalStop = false;
  let stopping = false;
  let finish: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const close = (fatal: boolean) => {
    if (stopping) return;
    stopping = true;
    fatalStop = fatal;
    if (!fatal) status.service('stopping');
    if (client === undefined) {
      finish();
      return;
    }
    void client.close().then(finish);
  };
  const signalHandlers = new Map<'SIGINT' | 'SIGTERM', () => void>();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => close(false);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  try {
    client = environmentClient(identityStore, {
      bashEnabled: true,
      status,
      onFatalError: (error) => {
        process.stderr.write(`kairos-daemon: authentication stopped: ${error.message}\n`);
        process.exitCode = 78;
        status.service('fatal', error);
        close(true);
      },
    });
    status.service('running');
    client.start();
    await stopped;
    if (!fatalStop) status.service('stopped');
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    if (client !== undefined) await client.close();
    await status.close();
  }
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function execute(command: string, args: string[]): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let size = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const append = (current: string, chunk: string): string => {
      size += Buffer.byteLength(chunk);
      if (size > 64 * 1024) {
        child.kill();
        reject(new Error(`${command} response exceeds the output limit.`));
        return current;
      }
      return current + chunk;
    };
    child.stdout.on('data', (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function requireCommand(command: string, args: string[]): Promise<CommandResult> {
  const result = await execute(command, args);
  if (result.code !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `exit ${result.code ?? 'unknown'}`;
    throw new Error(`${command} failed: ${detail}`);
  }
  return result;
}

function validateEnvironmentId(value: string): string {
  if (!/^[0-9A-Za-z._:-]{1,200}$/.test(value)) throw new Error('Environment ID is invalid.');
  return value;
}

function defaultControlIdentityPath(envId: string | undefined): string {
  if (process.platform === 'darwin') {
    if (envId === undefined) throw new Error('macOS service control requires an env-id.');
    const base = join(homedir(), 'Library', 'Application Support', 'Kairos', 'daemon');
    return join(base, 'environments', envId, 'identity.json');
  }
  if (process.platform === 'linux') return '/var/lib/kairos-daemon/identity.json';
  return defaultIdentityPath();
}

function serviceLabel(envId: string | undefined): string {
  const suffix =
    envId === undefined ? '' : `.${createHash('sha256').update(envId).digest('hex').slice(0, 32)}`;
  const label = process.env.KAIROS_DAEMON_SERVICE_LABEL ?? `team.kairos.daemon${suffix}`;
  if (!/^[0-9A-Za-z._-]{1,200}$/.test(label)) throw new Error('Daemon service label is invalid.');
  return label;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface ServiceProcess {
  state: 'running' | 'stopping' | 'loaded' | 'stopped' | 'failed';
  pid?: number;
  lastExitCode?: number;
}

function macService(envId: string): { target: string; plist: string; uid: number } {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('macOS service control requires a user ID.');
  const label = serviceLabel(envId);
  return {
    target: `gui/${uid}/${label}`,
    plist: join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`),
    uid,
  };
}

async function assertMacServiceOwnership(identityPath: string, envId: string): Promise<void> {
  const service = macService(envId);
  const configured = await requireCommand('plutil', [
    '-extract',
    'EnvironmentVariables.KAIROS_DEVICE_IDENTITY_PATH',
    'raw',
    '-o',
    '-',
    service.plist,
  ]);
  if (configured.stdout.trim() !== identityPath) {
    throw new Error('The launchd service belongs to another Daemon identity.');
  }
}

const macServicePollAttempts = 50;
const macServicePollMilliseconds = 100;

function macControlLockPath(identityPath: string, uid: number): string {
  const suffix = createHash('sha256').update(resolve(identityPath)).digest('hex').slice(0, 32);
  return `/tmp/kairos-daemon-control-${uid}-${suffix}.lock`;
}

function macControlOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function readMacControlOwner(ownerPath: string): Promise<string | undefined> {
  try {
    return await readFile(ownerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function macControlOwnerPid(owner: string): number | undefined {
  const parts = owner.trim().split(':');
  if (parts.length > 2 || !/^[1-9][0-9]*$/.test(parts[0] ?? '')) return undefined;
  if (parts.length === 2 && !/^[0-9a-f]{32}$/.test(parts[1] ?? '')) return undefined;
  const pid = Number(parts[0]);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

function macControlLockResidualError(lockPath: string, pid?: number): Error {
  const owner = pid === undefined ? '' : `; owner PID ${pid} is not running`;
  return new Error(
    `Daemon service control lock remained at ${lockPath}${owner}. Confirm that no Daemon start/stop command is running, then remove it manually with \`rm -r -- ${lockPath}\` and retry.`,
  );
}

async function acquireMacControlLock(
  identityPath: string,
  uid: number,
  onCreated: (release: () => Promise<void>) => void,
): Promise<() => Promise<void>> {
  const lockPath = macControlLockPath(identityPath, uid);
  const ownerPath = join(lockPath, 'pid');
  const token = randomBytes(16).toString('hex');
  const owner = `${process.pid}:${token}\n`;
  for (let attempt = 0; attempt < macServicePollAttempts; attempt += 1) {
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (created) {
      const release = async () => {
        if ((await readMacControlOwner(ownerPath)) !== owner) return;
        await unlink(ownerPath);
        await rmdir(lockPath);
      };
      onCreated(release);
      try {
        await writeFile(ownerPath, owner, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        await release();
        throw error;
      }
      return release;
    }
    const currentOwner = await readMacControlOwner(ownerPath);
    if (currentOwner !== undefined) {
      const pid = macControlOwnerPid(currentOwner);
      if (pid !== undefined && !macControlOwnerAlive(pid)) {
        throw macControlLockResidualError(lockPath, pid);
      }
    }
    await delay(macServicePollMilliseconds);
  }
  throw macControlLockResidualError(lockPath);
}

async function withMacControlLock(
  identityPath: string,
  uid: number,
  action: () => Promise<void>,
): Promise<void> {
  let release: (() => Promise<void>) | undefined;
  let releasePromise: Promise<void> | undefined;
  const releaseOnce = () => {
    releasePromise ??= release?.() ?? Promise.resolve();
    return releasePromise;
  };
  let settleAcquisition: () => void = () => undefined;
  const acquisitionSettled = new Promise<void>((resolvePromise) => {
    settleAcquisition = resolvePromise;
  });
  let signalExit: Promise<void> | undefined;
  const signalHandlers = new Map<'SIGINT' | 'SIGTERM', () => void>();
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    const handler = () => {
      if (signalExit !== undefined) return;
      signalExit = (async () => {
        try {
          await acquisitionSettled;
          await releaseOnce();
          process.exit(code);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown lock release error.';
          process.stderr.write(`kairos-daemon: failed to release control lock: ${message}\n`);
          process.exit(1);
        }
      })();
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  const acquisition = (async () => {
    try {
      return await acquireMacControlLock(identityPath, uid, (createdRelease) => {
        release = createdRelease;
      });
    } finally {
      settleAcquisition();
    }
  })();
  let failure: unknown;
  try {
    release = await acquisition;
    if (signalExit === undefined) await action();
  } catch (error) {
    failure = error;
  } finally {
    try {
      await releaseOnce();
    } catch (error) {
      if (failure === undefined) failure = error;
    }
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
  if (signalExit !== undefined) await signalExit;
  if (failure !== undefined) throw failure;
}

async function macStatusActive(identityPath: string): Promise<boolean> {
  let socketPath: string;
  try {
    socketPath = daemonStatusSocketPath(identityPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return new Promise<boolean>((resolvePromise, reject) => {
    const socket = createConnection(socketPath);
    const finish = (callback: () => void) => {
      socket.removeAllListeners();
      socket.destroy();
      callback();
    };
    socket.once('connect', () => finish(() => resolvePromise(true)));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        finish(() => resolvePromise(false));
      } else {
        finish(() => reject(error));
      }
    });
  });
}

async function queryMacService(envId: string): Promise<ServiceProcess> {
  const service = macService(envId);
  const result = await execute('launchctl', ['print', service.target]);
  if (result.code !== 0) return { state: 'stopped' };
  const launchdState = /^\s*state = ([0-9A-Za-z]+)\s*$/m.exec(result.stdout)?.[1];
  const pidText = /^\s*pid = ([1-9][0-9]*)\s*$/m.exec(result.stdout)?.[1];
  const exitText = /^\s*last exit code = (-?[0-9]+)\s*$/m.exec(result.stdout)?.[1];
  const state =
    pidText === undefined
      ? 'loaded'
      : launchdState !== undefined && launchdState !== 'running'
        ? 'stopping'
        : 'running';
  return {
    state,
    ...(pidText === undefined ? {} : { pid: Number(pidText) }),
    ...(exitText === undefined ? {} : { lastExitCode: Number(exitText) }),
  };
}

async function readProcessUid(pid: number): Promise<string | undefined> {
  const result = await execute('ps', ['-o', 'uid=', '-p', String(pid)]);
  if (result.code !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

async function assertProcessUid(pid: number, expectedUid: number): Promise<void> {
  let observed = 'unavailable';
  for (let attempt = 0; attempt < macServicePollAttempts; attempt += 1) {
    const uid = await readProcessUid(pid);
    if (uid !== undefined) {
      observed = uid;
      if (uid === String(expectedUid)) return;
    }
    await delay(macServicePollMilliseconds);
  }
  throw new Error(
    `Daemon process UID verification failed; expected ${expectedUid}, observed ${observed}.`,
  );
}

async function waitForMacStopped(
  identityPath: string,
  envId: string,
  previousPid: number | undefined,
): Promise<void> {
  for (let attempt = 0; attempt < macServicePollAttempts; attempt += 1) {
    const current = await queryMacService(envId);
    if (
      current.state === 'stopped' &&
      (previousPid === undefined || (await readProcessUid(previousPid)) === undefined) &&
      !(await macStatusActive(identityPath))
    ) {
      return;
    }
    await delay(macServicePollMilliseconds);
  }
  const pid = previousPid === undefined ? '' : ` (pid ${previousPid})`;
  throw new Error(`launchd service or old Daemon process${pid} did not stop within 5 seconds.`);
}

async function waitForMacStartState(
  identityPath: string,
  envId: string,
  uid: number,
): Promise<ServiceProcess> {
  let previousPid: number | undefined;
  for (let attempt = 0; attempt < macServicePollAttempts; attempt += 1) {
    const current = await queryMacService(envId);
    if (current.state === 'running') {
      if (current.pid === undefined) throw new Error('launchd process state is invalid.');
      const observedUid = await readProcessUid(current.pid);
      if (observedUid !== undefined && observedUid !== String(uid)) {
        throw new Error(
          `Daemon process UID verification failed; expected ${uid}, observed ${observedUid}.`,
        );
      }
      if (observedUid !== undefined && current.pid === previousPid) return current;
      previousPid = current.pid;
    } else if (current.state === 'stopping') {
      if (current.pid !== undefined) previousPid = current.pid;
    } else {
      const processExited =
        previousPid === undefined || (await readProcessUid(previousPid)) === undefined;
      if (processExited && !(await macStatusActive(identityPath))) return current;
    }
    await delay(macServicePollMilliseconds);
  }
  throw new Error('launchd service did not reach a stable start state within 5 seconds.');
}

async function waitForMacPid(envId: string): Promise<number> {
  let processState: ServiceProcess = { state: 'loaded' };
  for (let attempt = 0; attempt < macServicePollAttempts; attempt += 1) {
    processState = await queryMacService(envId);
    if (processState.state === 'running' && processState.pid !== undefined) {
      return processState.pid;
    }
    await delay(macServicePollMilliseconds);
  }
  const exit =
    processState.lastExitCode === undefined ? '' : `; last exit ${processState.lastExitCode}`;
  throw new Error(`launchd did not report a Daemon process${exit}.`);
}

async function startMacService(identityPath: string, envId: string): Promise<void> {
  const service = macService(envId);
  await withMacControlLock(identityPath, service.uid, async () => {
    await assertMacServiceOwnership(identityPath, envId);
    const current = await waitForMacStartState(identityPath, envId, service.uid);
    if (current.state === 'running') {
      process.stdout.write(`kairos-daemon: already running (pid ${current.pid}).\n`);
      return;
    }
    if (current.state === 'stopped') {
      await requireCommand('launchctl', ['bootstrap', `gui/${service.uid}`, service.plist]);
    } else {
      await requireCommand('launchctl', ['kickstart', '-p', service.target]);
    }
    const pid = await waitForMacPid(envId);
    await assertProcessUid(pid, service.uid);
    process.stdout.write(`kairos-daemon: started (pid ${pid}).\n`);
  });
}

async function stopMacService(identityPath: string, envId: string): Promise<void> {
  const service = macService(envId);
  await withMacControlLock(identityPath, service.uid, async () => {
    await assertMacServiceOwnership(identityPath, envId);
    const current = await queryMacService(envId);
    if (current.state === 'stopped' && !(await macStatusActive(identityPath))) {
      process.stdout.write('kairos-daemon: already stopped.\n');
      return;
    }
    if (current.state !== 'stopping' && current.state !== 'stopped') {
      await requireCommand('launchctl', ['bootout', service.target]);
    }
    await waitForMacStopped(identityPath, envId, current.pid);
    process.stdout.write('kairos-daemon: stopped; identity was retained.\n');
  });
}

async function queryLinuxService(): Promise<ServiceProcess> {
  const active = await execute('systemctl', ['is-active', 'kairos-daemon.service']);
  const state = active.stdout.trim();
  const details = await execute('systemctl', [
    'show',
    'kairos-daemon.service',
    '--property',
    'MainPID,ExecMainStatus',
    '--value',
  ]);
  const lines = details.stdout.split(/\r?\n/).map((line) => line.trim());
  const pid = Number(lines[0]);
  const exitCode = Number(lines[1]);
  return {
    state:
      state === 'active'
        ? 'running'
        : state === 'activating' || state === 'reloading'
          ? 'loaded'
          : state === 'failed'
            ? 'failed'
            : 'stopped',
    ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
    ...(Number.isSafeInteger(exitCode) ? { lastExitCode: exitCode } : {}),
  };
}

async function assertLinuxServiceUser(): Promise<number> {
  const current = await queryLinuxService();
  if (current.state !== 'running' || current.pid === undefined) {
    throw new Error(
      `systemd service is not running${current.lastExitCode === undefined ? '' : `; last exit ${current.lastExitCode}`}.`,
    );
  }
  const expected = await requireCommand('id', ['-u', 'kairos']);
  await assertProcessUid(current.pid, Number(expected.stdout.trim()));
  return current.pid;
}

async function startLinuxService(): Promise<void> {
  if ((await queryLinuxService()).state === 'running') {
    const pid = await assertLinuxServiceUser();
    process.stdout.write(`kairos-daemon: already running (pid ${pid}).\n`);
    return;
  }
  await requireCommand('systemctl', ['start', 'kairos-daemon.service']);
  const pid = await assertLinuxServiceUser();
  process.stdout.write(`kairos-daemon: started (pid ${pid}).\n`);
}

async function stopLinuxService(): Promise<void> {
  if ((await queryLinuxService()).state !== 'running') {
    process.stdout.write('kairos-daemon: already stopped.\n');
    return;
  }
  await requireCommand('systemctl', ['stop', 'kairos-daemon.service']);
  process.stdout.write('kairos-daemon: stopped; identity was retained.\n');
}

interface ControlTarget {
  identityPath: string;
  envId: string;
  paired: boolean;
}

interface MacBinding {
  identityPath: string;
  envId: string;
  deviceName: string;
}

async function listMacBindings(): Promise<MacBinding[]> {
  const base = join(
    homedir(),
    'Library',
    'Application Support',
    'Kairos',
    'daemon',
    'environments',
  );
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return [];
  }
  const bindings: MacBinding[] = [];
  for (const entry of entries) {
    const identityPath = join(base, entry, 'identity.json');
    const identity = new DaemonIdentityStore(identityPath).load();
    if (identity !== undefined) {
      bindings.push({ identityPath, envId: identity.envId, deviceName: identity.deviceName });
    }
  }
  return bindings.sort((a, b) => a.envId.localeCompare(b.envId));
}

async function chooseMacBinding(bindings: MacBinding[]): Promise<MacBinding> {
  process.stdout.write('Multiple environments are paired on this Mac:\n');
  for (const [index, binding] of bindings.entries()) {
    process.stdout.write(`  ${index + 1}) ${binding.deviceName} (${binding.envId})\n`);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`Select 1-${bindings.length} (or type a name): `)).trim();
    const index = Number(answer);
    const byIndex =
      Number.isInteger(index) && index >= 1 && index <= bindings.length
        ? bindings[index - 1]
        : undefined;
    if (byIndex !== undefined) return byIndex;
    const matched = bindings.filter(
      (binding) =>
        binding.envId === answer || binding.deviceName.toLowerCase() === answer.toLowerCase(),
    );
    if (matched.length === 1 && matched[0] !== undefined) return matched[0];
    throw new Error('No paired environment matches the selection.');
  } finally {
    prompt.close();
  }
}

async function macControlTarget(selector: string | undefined): Promise<ControlTarget> {
  const bindings = await listMacBindings();
  if (selector !== undefined) {
    const byEnv = bindings.filter((binding) => binding.envId === selector);
    if (byEnv.length === 1 && byEnv[0] !== undefined) return { ...byEnv[0], paired: true };
    const byName = bindings.filter(
      (binding) => binding.deviceName.toLowerCase() === selector.toLowerCase(),
    );
    if (byName.length === 1 && byName[0] !== undefined) return { ...byName[0], paired: true };
    if (byName.length > 1) {
      throw new Error(
        `Multiple environments share the device name ${selector}; pass the env-id instead.`,
      );
    }
    const envId = validateEnvironmentId(selector);
    const identityPath = defaultControlIdentityPath(envId);
    const identity = new DaemonIdentityStore(identityPath).load();
    if (identity !== undefined && identity.envId !== envId) {
      throw new Error('The command env-id does not match the paired identity.');
    }
    return { identityPath, envId, paired: identity !== undefined };
  }
  if (bindings.length === 0) {
    throw new Error('No paired environment exists on this Mac; run the install command first.');
  }
  if (bindings.length === 1 && bindings[0] !== undefined) return { ...bindings[0], paired: true };
  if (!process.stdin.isTTY) {
    throw new Error(
      `Multiple environments are paired; pass one of: ${bindings.map((binding) => binding.envId).join(', ')}.`,
    );
  }
  return { ...(await chooseMacBinding(bindings)), paired: true };
}

async function controlTarget(args: string[]): Promise<ControlTarget> {
  const positional = args[0] !== undefined && !args[0].startsWith('--') ? args[0] : undefined;
  const options = positional === undefined ? args : args.slice(1);
  assertKnownOptions(options, ['--identity-path']);
  const explicitIdentityPath = optionValue(options, '--identity-path');
  if (explicitIdentityPath !== undefined) {
    const envArgument = positional === undefined ? undefined : validateEnvironmentId(positional);
    const identity = new DaemonIdentityStore(explicitIdentityPath).load();
    if (envArgument !== undefined && identity !== undefined && identity.envId !== envArgument) {
      throw new Error('The command env-id does not match the paired identity.');
    }
    const envId = envArgument ?? identity?.envId;
    if (envId === undefined) {
      throw new Error('An env-id is required when no paired identity is available.');
    }
    return { identityPath: explicitIdentityPath, envId, paired: identity !== undefined };
  }
  if (process.platform === 'darwin') return macControlTarget(positional);
  const identityPath = defaultControlIdentityPath(undefined);
  const identity = new DaemonIdentityStore(identityPath).load();
  const envArgument = positional === undefined ? undefined : validateEnvironmentId(positional);
  if (envArgument !== undefined && identity !== undefined && identity.envId !== envArgument) {
    throw new Error('The command env-id does not match the paired identity.');
  }
  const envId = envArgument ?? identity?.envId;
  if (envId === undefined) {
    throw new Error('An env-id is required when no paired identity is available.');
  }
  return { identityPath, envId, paired: identity !== undefined };
}

async function startCommand(args: string[]): Promise<void> {
  const target = await controlTarget(args);
  if (!target.paired) {
    throw new Error('No paired identity exists; start does not pair or replace an identity.');
  }
  if (process.platform === 'darwin') await startMacService(target.identityPath, target.envId);
  else if (process.platform === 'linux') await startLinuxService();
  else throw new Error('Daemon service control supports only macOS and Linux.');
}

async function stopCommand(args: string[]): Promise<void> {
  const target = await controlTarget(args);
  if (process.platform === 'darwin') await stopMacService(target.identityPath, target.envId);
  else if (process.platform === 'linux') await stopLinuxService();
  else throw new Error('Daemon service control supports only macOS and Linux.');
}

async function statusCommand(args: string[]): Promise<void> {
  const target = await controlTarget(args);
  let current: ServiceProcess;
  if (process.platform === 'darwin') current = await queryMacService(target.envId);
  else if (process.platform === 'linux') current = await queryLinuxService();
  else throw new Error('Daemon status supports only macOS and Linux.');
  if (current.state !== 'running') {
    process.stdout.write(
      `Process: ${current.state}${current.lastExitCode === undefined ? '' : ` (last exit ${current.lastExitCode})`}\n`,
    );
    process.stdout.write(
      'WSS: disconnected\nRecent events: unavailable while the Daemon process is stopped.\n',
    );
    if (current.state === 'failed' || current.state === 'loaded') process.exitCode = 69;
    return;
  }
  await observeDaemonStatus(daemonStatusSocketPath(target.identityPath));
}

async function main(): Promise<void> {
  const [command = 'service', ...args] = process.argv.slice(2);
  if (command === '--check') {
    if (args.length > 0) throw new Error('--check takes no arguments.');
    process.stdout.write(`kairos-daemon ${daemonVersion} check ok\n`);
    return;
  }
  if (command === 'identity-env') {
    if (args.length !== 1) throw new Error('identity-env requires an identity path.');
    const identity = new DaemonIdentityStore(args[0] ?? '').load();
    if (identity === undefined) throw new Error('Environment identity is missing.');
    process.stdout.write(`${identity.envId}\n`);
    return;
  }
  if (command === 'pair-once') {
    await pairOnce(args);
    return;
  }
  if (command === 'drain') {
    await drain(args);
    return;
  }
  if (command === 'platform-foreground' && args.length === 0) {
    await runPlatformForeground();
    return;
  }
  if (command === 'platform-bootstrap-write' && args.length === 0) {
    await writePlatformBootstrap();
    return;
  }
  if (command === 'revoke') {
    await revoke(args);
    return;
  }
  if (command === 'start') {
    await startCommand(args);
    return;
  }
  if (command === 'status') {
    await statusCommand(args);
    return;
  }
  if (command === 'stop') {
    await stopCommand(args);
    return;
  }
  if (command !== 'service' || args.length > 0) throw new Error('Unknown Daemon command.');
  await startService();
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `kairos-daemon: ${error instanceof Error ? error.message : 'Unknown configuration error.'}\n`,
  );
  process.exitCode = 78;
}
