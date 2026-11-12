import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonIdentityStore } from './identity.js';
import { DaemonStatus, daemonStatusSocketPath, observeDaemonStatus } from './status.js';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(sourceDirectory, '../../..');
const main = join(sourceDirectory, 'main.ts');
const cleanup: Array<() => Promise<void> | void> = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-daemon-status-'));
  chmodSync(directory, 0o700);
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function waitFor<T>(read: () => T | undefined, timeoutMilliseconds = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error('Timed out waiting for Daemon status state.');
}

function childResult(child: ChildProcess): {
  output: () => string;
  result: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
} {
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    output += chunk;
  });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolvePromise({ code, signal }));
    },
  );
  return { output: () => output, result };
}

function mainProcess(
  args: string[],
  environment: NodeJS.ProcessEnv,
): {
  child: ChildProcess;
  output: () => string;
  result: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
} {
  const child = spawn(process.execPath, ['--import', 'tsx', main, ...args], {
    cwd: repository,
    env: { PATH: process.env.PATH ?? '', ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, ...childResult(child) };
}

async function runMain(args: string[], environment: NodeJS.ProcessEnv) {
  const process = mainProcess(args, environment);
  const timeout = setTimeout(() => process.child.kill('SIGKILL'), 15_000);
  try {
    const result = await process.result;
    return { ...result, output: process.output() };
  } finally {
    clearTimeout(timeout);
  }
}

function saveIdentity(directory: string, envId = 'env-status-test'): string {
  const path = join(directory, 'identity.json');
  new DaemonIdentityStore(path).save({
    version: 2,
    envId,
    deviceId: `device-${envId}`,
    deviceBindingId: `binding-${envId}`,
    deviceCredential: 'kd2_status_test_credential',
    serverUrl: 'ws://127.0.0.1:9/devices/wss',
    deviceName: 'Isolated status test',
    grantedCapabilities: ['bash', 'directory_check'],
    daemonVersion: 'status-test',
  });
  return path;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('TCP address is unavailable.');
  const { port } = address;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}

afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

describe('DaemonStatus local channel', () => {
  it('sends a bounded snapshot followed by live events without creating business files', async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, 'status.sock');
    let time = Date.parse('2026-11-07T00:00:00.000Z');
    const status = new DaemonStatus(socketPath, {
      pid: 1234,
      maxEvents: 2,
      now: () => {
        time += 1000;
        return new Date(time);
      },
    });
    await status.listen();
    cleanup.push(() => status.close());
    status.service('running');
    status.connection('connected');
    status.operation({ operationId: 'operation-1', kind: 'bash', status: 'running' });
    expect(status.snapshot().events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(status.snapshot().operations).toEqual([
      { operationId: 'operation-1', kind: 'bash', status: 'running' },
    ]);
    expect((lstatSync(socketPath).mode & 0o777).toString(8)).toBe('600');

    const lines: string[] = [];
    const observing = observeDaemonStatus(socketPath, {
      write(chunk) {
        lines.push(String(chunk));
        return true;
      },
    });
    await waitFor(() => lines.some((line) => line.startsWith('Live events')) || undefined);
    status.operation({ operationId: 'operation-1', kind: 'bash', status: 'completed' });
    await waitFor(() => lines.some((line) => line.includes('operation completed')) || undefined);
    expect(lines.join('')).toContain('WSS: connected');
    expect(lines.join('')).toContain('running bash operation-1');
    expect(status.snapshot().operations).toEqual([]);
    expect(status.snapshot().events).toHaveLength(2);
    expect(readdirSync(directory)).toEqual(['status.sock']);

    await status.close();
    await observing;
    expect(readdirSync(directory)).toEqual([]);
  });

  it('rejects insecure directories, non-socket paths and a second owner', async () => {
    const insecure = temporaryDirectory();
    chmodSync(insecure, 0o755);
    const insecureStatus = new DaemonStatus(join(insecure, 'status.sock'));
    await expect(insecureStatus.listen()).rejects.toThrow('mode 0700');
    expect(readdirSync(insecure)).toEqual([]);

    const directory = temporaryDirectory();
    const socketPath = join(directory, 'status.sock');
    writeFileSync(socketPath, 'do not remove', { mode: 0o600 });
    const invalidPath = new DaemonStatus(socketPath);
    await expect(invalidPath.listen()).rejects.toThrow('not a socket');
    expect(readFileSync(socketPath, 'utf8')).toBe('do not remove');
    rmSync(socketPath);

    const active = new DaemonStatus(socketPath);
    await active.listen();
    const second = new DaemonStatus(socketPath);
    await expect(second.listen()).rejects.toThrow('Another Daemon instance');
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    await active.close();
  });
});

describe('Daemon background CLI', () => {
  it('keeps the service alive when a status observer exits and retains identity on stop', async () => {
    const directory = temporaryDirectory();
    const identityPath = saveIdentity(directory);
    const identity = readFileSync(identityPath);
    const store = new DaemonIdentityStore(identityPath).load();
    if (store === undefined) throw new Error('Test identity is missing.');
    new DaemonIdentityStore(identityPath).save({
      ...store,
      serverUrl: `ws://127.0.0.1:${await unusedPort()}/devices/wss`,
    });
    const originalIdentity = readFileSync(identityPath);
    expect(identity.equals(originalIdentity)).toBe(false);
    const socketPath = daemonStatusSocketPath(identityPath);
    const bin = join(directory, 'bin');
    mkdirForBin(bin);
    if (process.platform === 'darwin') {
      writeFileSync(
        join(bin, 'launchctl'),
        '#!/bin/bash\n[[ $1 == print ]] || exit 2\nprintf \'  pid = %s\\n  last exit code = 0\\n\' "$KAIROS_TEST_DAEMON_PID"\n',
        { mode: 0o755 },
      );
    } else if (process.platform === 'linux') {
      writeFileSync(
        join(bin, 'systemctl'),
        "#!/bin/bash\ncase $1 in\n  is-active) printf 'active\\n' ;;\n  show) printf '%s\\n0\\n' \"$KAIROS_TEST_DAEMON_PID\" ;;\n  *) exit 2 ;;\nesac\n",
        { mode: 0o755 },
      );
    }
    const environment = {
      HOME: directory,
      KAIROS_DEVICE_IDENTITY_PATH: identityPath,
      KAIROS_DAEMON_VERSION: 'status-test',
      KAIROS_TEST_DAEMON_PID: '',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    };
    const service = mainProcess(['service'], environment);
    environment.KAIROS_TEST_DAEMON_PID = String(service.child.pid);
    cleanup.push(async () => {
      if (service.child.exitCode === null && service.child.signalCode === null) {
        service.child.kill('SIGKILL');
        await service.result;
      }
    });
    await waitFor(() => existsSync(socketPath) || undefined);
    const firstObserver = mainProcess(
      ['status', 'env-status-test', '--identity-path', identityPath],
      environment,
    );
    await waitFor(() => firstObserver.output().includes('Live events') || undefined);
    firstObserver.child.kill('SIGINT');
    expect((await firstObserver.result).signal).toBe('SIGINT');
    expect(service.child.exitCode).toBeNull();
    expect(service.child.signalCode).toBeNull();
    expect(existsSync(socketPath)).toBe(true);

    const secondObserver = mainProcess(
      ['status', 'env-status-test', '--identity-path', identityPath],
      environment,
    );
    await waitFor(() => secondObserver.output().includes('Live events') || undefined);
    secondObserver.child.kill('SIGINT');
    await secondObserver.result;
    service.child.kill('SIGTERM');
    expect((await service.result).code).toBe(0);
    expect(readFileSync(identityPath)).toEqual(originalIdentity);
    expect(existsSync(socketPath)).toBe(false);
    expect(readdirSync(directory).sort()).toEqual(['bin', 'identity.json']);
  });

  it('keeps two env-id services and status channels independent', async () => {
    if (process.platform !== 'darwin') return;
    const directory = temporaryDirectory();
    const bin = join(directory, 'bin');
    const stateDirectory = join(directory, 'service-states');
    const plistDirectory = join(directory, 'Library', 'LaunchAgents');
    mkdirSync(bin, { recursive: true });
    mkdirSync(stateDirectory, { recursive: true });
    mkdirSync(plistDirectory, { recursive: true });
    writeFileSync(join(bin, 'plutil'), '#!/bin/bash\ncat "$6"\n', { mode: 0o755 });
    writeFileSync(
      join(bin, 'launchctl'),
      `#!/bin/bash
case "$1" in
  print|bootout) target=$2 ;;
  bootstrap) target=$3 ;;
  kickstart) target=$3 ;;
  *) exit 2 ;;
esac
key=\${target##*/}
key=\${key%.plist}
state="$KAIROS_TEST_STATE_DIRECTORY/$key"
case "$1" in
  print) if [[ -f $state ]]; then read -r pid < "$state"; printf '  pid = %s\\n  last exit code = 0\\n' "$pid"; else exit 1; fi ;;
  bootstrap) printf '%s\\n' "$PPID" > "$state" ;;
  kickstart) printf '%s\\n' "$PPID" > "$state"; printf '%s\\n' "$PPID" ;;
  bootout) if [[ -f $state ]]; then read -r pid < "$state"; kill -TERM "$pid" 2>/dev/null || true; rm -f "$state"; fi ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'ps'),
      `#!/bin/bash
for state in "$KAIROS_TEST_STATE_DIRECTORY"/*; do
  [[ -f $state ]] || continue
  read -r pid < "$state"
  if [[ $pid == "$4" ]]; then printf '%s\\n' '${process.getuid?.() ?? 0}'; exit 0; fi
done
exit 1
`,
      { mode: 0o755 },
    );
    const controlEnvironment = {
      HOME: directory,
      KAIROS_TEST_STATE_DIRECTORY: stateDirectory,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    };
    const services = new Map<string, ReturnType<typeof mainProcess>>();
    for (const envId of ['env-test', 'env-prod']) {
      const environmentDirectory = join(
        directory,
        'Library',
        'Application Support',
        'Kairos',
        'daemon',
        'environments',
        envId,
      );
      mkdirSync(environmentDirectory, { recursive: true, mode: 0o700 });
      const identityPath = saveIdentity(environmentDirectory, envId);
      const suffix = createHash('sha256').update(envId).digest('hex').slice(0, 32);
      writeFileSync(join(plistDirectory, `team.kairos.daemon.${suffix}.plist`), identityPath, {
        mode: 0o600,
      });
      const service = mainProcess(['service'], {
        HOME: environmentDirectory,
        KAIROS_DEVICE_IDENTITY_PATH: identityPath,
      });
      services.set(envId, service);
      cleanup.push(async () => {
        if (service.child.exitCode === null && service.child.signalCode === null) {
          service.child.kill('SIGKILL');
          await service.result;
        }
      });
      await waitFor(() => {
        if (service.child.exitCode !== null) throw new Error(`Service exited: ${service.output()}`);
        return existsSync(daemonStatusSocketPath(identityPath)) || undefined;
      });
      writeFileSync(join(stateDirectory, `team.kairos.daemon.${suffix}`), `${service.child.pid}\n`);
      const started = await runMain(['start', envId], controlEnvironment);
      expect(started).toMatchObject({ code: 0 });
    }
    expect(readdirSync(stateDirectory)).toHaveLength(2);

    const observe = async (envId: string) => {
      const observer = mainProcess(['status', envId], controlEnvironment);
      await waitFor(() => observer.output().includes('Live events') || undefined);
      observer.child.kill('SIGINT');
      expect((await observer.result).signal).toBe('SIGINT');
      return observer.output();
    };
    expect(await observe('env-test')).toContain(`pid ${services.get('env-test')?.child.pid}`);
    expect(await observe('env-prod')).toContain(`pid ${services.get('env-prod')?.child.pid}`);

    expect((await runMain(['stop', 'env-test'], controlEnvironment)).code).toBe(0);
    const stopped = services.get('env-test');
    if (stopped === undefined) throw new Error('env-test service is missing.');
    stopped.child.kill('SIGTERM');
    expect((await stopped.result).code).toBe(0);
    expect(readdirSync(stateDirectory)).toHaveLength(1);
    expect(await observe('env-prod')).toContain('Live events');

    expect((await runMain(['stop', 'env-prod'], controlEnvironment)).code).toBe(0);
    const remaining = services.get('env-prod');
    if (remaining === undefined) throw new Error('env-prod service is missing.');
    remaining.child.kill('SIGTERM');
    expect((await remaining.result).code).toBe(0);
    for (const envId of ['env-test', 'env-prod']) {
      const identityPath = join(
        directory,
        'Library',
        'Application Support',
        'Kairos',
        'daemon',
        'environments',
        envId,
        'identity.json',
      );
      expect(new DaemonIdentityStore(identityPath).load()?.envId).toBe(envId);
    }
  }, 20_000);

  it('makes start idempotent and stop non-destructive with isolated service commands', async () => {
    const directory = temporaryDirectory();
    const identityPath = saveIdentity(directory);
    const originalIdentity = readFileSync(identityPath);
    const bin = join(directory, 'bin');
    mkdirForBin(bin);
    const state = join(directory, 'service-active');
    const label = `team.kairos.daemon.test.${process.pid}`;
    const environment = {
      HOME: directory,
      KAIROS_DEVICE_IDENTITY_PATH: identityPath,
      KAIROS_DAEMON_SERVICE_LABEL: label,
      KAIROS_TEST_IDENTITY: identityPath,
      KAIROS_TEST_SERVICE_STATE: state,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    };
    if (process.platform === 'darwin') {
      writeFileSync(
        join(bin, 'plutil'),
        '#!/bin/bash\nprintf \'%s\\n\' "$KAIROS_TEST_IDENTITY"\n',
        {
          mode: 0o755,
        },
      );
      writeFileSync(
        join(bin, 'launchctl'),
        `#!/bin/bash
case "$1" in
  print) if [[ -f "$KAIROS_TEST_SERVICE_STATE" ]]; then read -r pid < "$KAIROS_TEST_SERVICE_STATE"; printf '  pid = %s\\n  last exit code = 0\\n' "$pid"; else exit 1; fi ;;
  bootstrap) printf '%s\\n' "$PPID" > "$KAIROS_TEST_SERVICE_STATE" ;;
  kickstart) printf '%s\\n' "$PPID" > "$KAIROS_TEST_SERVICE_STATE"; printf '%s\\n' "$PPID" ;;
  bootout) rm -f "$KAIROS_TEST_SERVICE_STATE" ;;
  *) exit 2 ;;
esac
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, 'ps'),
        `#!/bin/bash
[[ -f $KAIROS_TEST_SERVICE_STATE ]] || exit 1
read -r pid < "$KAIROS_TEST_SERVICE_STATE"
[[ $pid == "$4" ]] || exit 1
printf '%s\\n' '${process.getuid?.() ?? 0}'
`,
        { mode: 0o755 },
      );
    } else if (process.platform === 'linux') {
      writeFileSync(
        join(bin, 'systemctl'),
        `#!/bin/bash
case "$1" in
  is-active) if [[ -f "$KAIROS_TEST_SERVICE_STATE" ]]; then printf 'active\\n'; else printf 'inactive\\n'; exit 3; fi ;;
  show) if [[ -f "$KAIROS_TEST_SERVICE_STATE" ]]; then printf '%s\\n0\\n' "$PPID"; else printf '0\\n1\\n'; fi ;;
  start) : > "$KAIROS_TEST_SERVICE_STATE" ;;
  stop) rm -f "$KAIROS_TEST_SERVICE_STATE" ;;
  *) exit 2 ;;
esac
`,
        { mode: 0o755 },
      );
      writeFileSync(join(bin, 'id'), `#!/bin/bash\nprintf '%s\\n' '${process.getuid?.() ?? 0}'\n`, {
        mode: 0o755,
      });
    } else {
      return;
    }
    const first = await runMain(
      ['start', 'env-status-test', '--identity-path', identityPath],
      environment,
    );
    expect(first).toMatchObject({ code: 0 });
    expect(first.output).toContain('started');
    const second = await runMain(
      ['start', 'env-status-test', '--identity-path', identityPath],
      environment,
    );
    expect(second).toMatchObject({ code: 0 });
    expect(second.output).toContain('already running');
    expect(readFileSync(identityPath)).toEqual(originalIdentity);

    const stopped = await runMain(
      ['stop', 'env-status-test', '--identity-path', identityPath],
      environment,
    );
    expect(stopped).toMatchObject({ code: 0 });
    expect(stopped.output).toContain('identity was retained');
    const stoppedAgain = await runMain(
      ['stop', 'env-status-test', '--identity-path', identityPath],
      environment,
    );
    expect(stoppedAgain).toMatchObject({ code: 0 });
    expect(stoppedAgain.output).toContain('already stopped');
    expect(readFileSync(identityPath)).toEqual(originalIdentity);
    const status = await runMain(
      ['status', 'env-status-test', '--identity-path', identityPath],
      environment,
    );
    expect(status).toMatchObject({ code: 0 });
    expect(status.output).toContain('Process: stopped');
  });
});

function mkdirForBin(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) throw new Error('Test binary parent is missing.');
  mkdirSync(path, { recursive: true });
}
