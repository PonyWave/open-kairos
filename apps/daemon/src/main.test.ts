import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonIdentityStore } from './identity.js';
import { DaemonStatus, daemonStatusSocketPath } from './status.js';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(sourceDirectory, '../../..');
const main = join(sourceDirectory, 'main.ts');
const cleanup: Array<() => Promise<void> | void> = [];
const spawnedMainTestTimeoutMilliseconds = 15_000;

type FakeServiceState = 'running' | 'stopping' | 'loaded' | 'stopped';

interface FakeLaunchdState {
  service: FakeServiceState;
  pid?: number | undefined;
  oldPid: number;
  newPid: number;
  oldProcess: boolean;
  transitionPrints: number;
  remainingPrints: number;
  processChecks: number;
  bootstrapAttempts: number;
  bootstrapConflictCount: number;
  bootstrapCount: number;
  bootoutCount: number;
  kickstartCount: number;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-daemon-main-'));
  chmodSync(directory, 0o700);
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function saveIdentity(directory: string): string {
  const path = join(directory, 'identity.json');
  new DaemonIdentityStore(path).save({
    version: 2,
    envId: 'env-main-test',
    deviceId: 'device-main-test',
    deviceBindingId: 'binding-main-test',
    deviceCredential: 'kd2_main_test_credential',
    serverUrl: 'ws://127.0.0.1:9/devices/wss',
    deviceName: 'Isolated main test',
    grantedCapabilities: ['bash', 'directory_check'],
    daemonVersion: 'main-test',
  });
  return path;
}

function writeState(path: string, state: FakeLaunchdState): void {
  writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
}

function readState(path: string): FakeLaunchdState {
  return JSON.parse(readFileSync(path, 'utf8')) as FakeLaunchdState;
}

function fakeLaunchdScript(): string {
  return `#!${process.execPath}
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
const statePath = process.env.KAIROS_TEST_LAUNCHD_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => {
  const next = \`\${statePath}.new-\${process.pid}\`;
  writeFileSync(next, JSON.stringify(state));
  renameSync(next, statePath);
};
const command = process.argv[2];
if (command === 'print') {
  if (state.service === 'stopped') process.exit(1);
  const reportedService = state.service;
  if (state.service === 'running' && state.remainingPrints === -2) {
    state.service = 'stopping';
    state.remainingPrints = state.transitionPrints;
  }
  if (state.service === 'stopping' && reportedService !== 'running') {
    if (state.remainingPrints === 0) {
      state.service = 'stopped';
      delete state.pid;
      save();
      process.exit(1);
    }
    if (state.remainingPrints > 0) state.remainingPrints -= 1;
  }
  save();
  if (reportedService === 'running' || reportedService === 'stopping') {
    console.log(\`  state = \${reportedService === 'running' ? 'running' : 'SIGTERMed'}\`);
    console.log(\`  pid = \${state.pid}\`);
    console.log('  last exit code = (never exited)');
  } else {
    console.log('  state = not running');
    console.log('  last exit code = 0');
  }
  process.exit(0);
}
if (command === 'bootout') {
  if (state.service === 'stopped') process.exit(1);
  state.bootoutCount += 1;
  state.service = 'stopping';
  state.pid = state.oldPid;
  state.remainingPrints = state.transitionPrints;
  save();
  process.exit(0);
}
if (command === 'bootstrap' || command === 'kickstart') {
  if (command === 'bootstrap') state.bootstrapAttempts += 1;
  if (state.service === 'stopping' || state.oldProcess) {
    if (command === 'bootstrap' && state.oldProcess) state.bootstrapConflictCount += 1;
    save();
    console.error('old Daemon is still stopping');
    process.exit(1);
  }
  state.service = 'running';
  state.pid = state.newPid;
  if (command === 'bootstrap') state.bootstrapCount += 1;
  else state.kickstartCount += 1;
  save();
  process.exit(0);
}
process.exit(2);
`;
}

function fakePsScript(): string {
  return `#!${process.execPath}
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
const statePath = process.env.KAIROS_TEST_LAUNCHD_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const pid = Number(process.argv.at(-1));
const save = () => {
  const next = \`\${statePath}.new-\${process.pid}\`;
  writeFileSync(next, JSON.stringify(state));
  renameSync(next, statePath);
};
if (state.service === 'running' && pid === state.pid) {
  console.log(process.env.KAIROS_TEST_UID);
  process.exit(0);
}
if (pid === state.oldPid && state.oldProcess) {
  if (state.processChecks === 0) {
    state.oldProcess = false;
    save();
    process.exit(1);
  }
  if (state.processChecks > 0) state.processChecks -= 1;
  save();
  console.log(process.env.KAIROS_TEST_UID);
  process.exit(0);
}
process.exit(1);
`;
}

interface Fixture {
  directory: string;
  identityPath: string;
  statePath: string;
  environment: NodeJS.ProcessEnv;
}

function fixture(initial: Partial<FakeLaunchdState> = {}): Fixture {
  const directory = temporaryDirectory();
  const identityPath = saveIdentity(directory);
  const statePath = join(directory, 'launchd-state.json');
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'launchctl'), fakeLaunchdScript(), { mode: 0o700 });
  writeFileSync(join(bin, 'ps'), fakePsScript(), { mode: 0o700 });
  writeFileSync(join(bin, 'plutil'), '#!/bin/bash\nprintf \'%s\\n\' "$KAIROS_TEST_IDENTITY"\n', {
    mode: 0o700,
  });
  const oldPid = 4101;
  writeState(statePath, {
    service: 'running',
    pid: oldPid,
    oldPid,
    newPid: 4102,
    oldProcess: true,
    transitionPrints: 0,
    remainingPrints: 0,
    processChecks: 0,
    bootstrapAttempts: 0,
    bootstrapConflictCount: 0,
    bootstrapCount: 0,
    bootoutCount: 0,
    kickstartCount: 0,
    ...initial,
  });
  return {
    directory,
    identityPath,
    statePath,
    environment: {
      HOME: directory,
      KAIROS_DAEMON_SERVICE_LABEL: `team.kairos.daemon.m142.${process.pid}`,
      KAIROS_TEST_IDENTITY: identityPath,
      KAIROS_TEST_LAUNCHD_STATE: statePath,
      KAIROS_TEST_UID: String(process.getuid?.() ?? 0),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    },
  };
}

function controlLockPath(test: Fixture): string {
  const uid = process.getuid?.() ?? 0;
  const suffix = createHash('sha256').update(resolve(test.identityPath)).digest('hex').slice(0, 32);
  return `/tmp/kairos-daemon-control-${uid}-${suffix}.lock`;
}

function cleanControlLockArtifacts(test: Fixture): void {
  const lockPath = controlLockPath(test);
  for (const entry of readdirSync(dirname(lockPath))) {
    const path = join(dirname(lockPath), entry);
    if (path.startsWith(lockPath)) rmSync(path, { recursive: true, force: true });
  }
}

function instrumentControlProbe(test: Fixture, delayMilliseconds = 300): string {
  const activityLog = join(test.directory, 'control-activity.log');
  const activeRoot = join(test.directory, 'control-active');
  test.environment.KAIROS_TEST_CONTROL_ACTIVITY_LOG = activityLog;
  test.environment.KAIROS_TEST_CONTROL_ACTIVE_ROOT = activeRoot;
  writeFileSync(
    join(test.directory, 'bin', 'plutil'),
    `#!${process.execPath}
import { appendFileSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
const activeRoot = process.env.KAIROS_TEST_CONTROL_ACTIVE_ROOT;
mkdirSync(activeRoot, { recursive: true });
const active = join(activeRoot, String(process.pid));
mkdirSync(active);
appendFileSync(process.env.KAIROS_TEST_CONTROL_ACTIVITY_LOG, \`\${readdirSync(activeRoot).length}\\n\`);
await new Promise((resolvePromise) => setTimeout(resolvePromise, ${delayMilliseconds}));
rmdirSync(active);
console.log(process.env.KAIROS_TEST_IDENTITY);
`,
    { mode: 0o700 },
  );
  return activityLog;
}

function mainProcess(test: Fixture, command: 'start' | 'stop', preloads: string[] = []) {
  const child = spawn(
    process.execPath,
    [
      ...preloads.flatMap((path) => ['--import', path]),
      '--import',
      'tsx',
      main,
      command,
      'env-main-test',
      '--identity-path',
      test.identityPath,
    ],
    {
      cwd: repository,
      env: test.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolvePromise({ code, signal }));
    },
  );
  return { child, result, output: () => output };
}

async function runMain(test: Fixture, command: 'start' | 'stop') {
  const process = mainProcess(test, command);
  const timeout = setTimeout(() => process.child.kill('SIGKILL'), 12_000);
  try {
    return { ...(await process.result), output: process.output() };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitFor(
  read: () => boolean,
  timeoutMilliseconds = 5000,
  intervalMilliseconds = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMilliseconds));
  }
  throw new Error('Timed out waiting for the fake launchd transition.');
}

afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

function describeSpawnedMainSuite(name: string, suite: () => void): void {
  describe.skipIf(process.platform !== 'darwin')(name, suite, spawnedMainTestTimeoutMilliseconds);
}

describeSpawnedMainSuite('Daemon environment resolution', () => {
  function saveBindingIdentity(directory: string, envId: string, deviceName: string): void {
    const envDirectory = join(
      directory,
      'Library',
      'Application Support',
      'Kairos',
      'daemon',
      'environments',
      envId,
    );
    mkdirSync(envDirectory, { recursive: true });
    new DaemonIdentityStore(join(envDirectory, 'identity.json')).save({
      version: 2,
      envId,
      deviceId: `device-${envId}`,
      deviceBindingId: `binding-${envId}`,
      deviceCredential: `kd2_${envId}_credential`,
      serverUrl: 'ws://127.0.0.1:9/devices/wss',
      deviceName,
      grantedCapabilities: ['bash', 'directory_check'],
      daemonVersion: 'resolution-test',
    });
  }

  function resolutionFixture(bindings: Array<{ envId: string; deviceName: string }>): {
    directory: string;
    log: string;
    environment: NodeJS.ProcessEnv;
  } {
    const directory = temporaryDirectory();
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    const log = join(directory, 'launchctl.log');
    writeFileSync(
      join(bin, 'launchctl'),
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
process.exit(1);
`,
      { mode: 0o700 },
    );
    for (const binding of bindings)
      saveBindingIdentity(directory, binding.envId, binding.deviceName);
    return {
      directory,
      log,
      environment: { HOME: directory, PATH: `${bin}:${process.env.PATH ?? ''}` },
    };
  }

  function runDaemon(
    environment: NodeJS.ProcessEnv,
    args: string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', main, ...args], {
        env: { ...process.env, ...environment },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
    });
  }

  function serviceLabel(envId: string): string {
    return `team.kairos.daemon.${createHash('sha256').update(envId).digest('hex').slice(0, 32)}`;
  }

  it('uses the only paired environment when no selector is given', async () => {
    const test = resolutionFixture([{ envId: 'env-alpha', deviceName: 'alpha-mac' }]);
    const result = await runDaemon(test.environment, ['status']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Process: stopped');
    expect(readFileSync(test.log, 'utf8')).toContain(serviceLabel('env-alpha'));
  });

  it('requires a selector for multiple environments when input is not a terminal', async () => {
    const test = resolutionFixture([
      { envId: 'env-alpha', deviceName: 'alpha-mac' },
      { envId: 'env-beta', deviceName: 'beta-mac' },
    ]);
    const result = await runDaemon(test.environment, ['status']);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('Multiple environments are paired; pass one of:');
    expect(result.stderr).toContain('env-alpha');
    expect(result.stderr).toContain('env-beta');
  });

  it('resolves a selector by device name', async () => {
    const test = resolutionFixture([
      { envId: 'env-alpha', deviceName: 'alpha-mac' },
      { envId: 'env-beta', deviceName: 'beta-mac' },
    ]);
    const result = await runDaemon(test.environment, ['status', 'beta-mac']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Process: stopped');
    expect(readFileSync(test.log, 'utf8')).toContain(serviceLabel('env-beta'));
  });

  it('rejects a device name shared by multiple environments', async () => {
    const test = resolutionFixture([
      { envId: 'env-alpha', deviceName: 'shared-name' },
      { envId: 'env-beta', deviceName: 'shared-name' },
    ]);
    const result = await runDaemon(test.environment, ['status', 'shared-name']);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('Multiple environments share the device name');
  });

  it('reports when no environment is paired', async () => {
    const test = resolutionFixture([]);
    const result = await runDaemon(test.environment, ['status']);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('No paired environment exists on this Mac');
  });
});

describeSpawnedMainSuite('macOS Daemon service lifecycle', () => {
  it('waits for launchd and process exit before stop and immediate start', async () => {
    const test = fixture({ transitionPrints: 2, processChecks: 2 });
    const originalIdentity = readFileSync(test.identityPath);

    const stopped = await runMain(test, 'stop');

    expect(stopped).toMatchObject({ code: 0 });
    expect(stopped.output).toContain('stopped; identity was retained');
    expect(readState(test.statePath)).toMatchObject({ service: 'stopped', oldProcess: false });
    expect(readFileSync(test.identityPath)).toEqual(originalIdentity);

    const started = await runMain(test, 'start');
    expect(started).toMatchObject({ code: 0 });
    expect(started.output).toContain('started (pid 4102)');
    expect(readState(test.statePath)).toMatchObject({
      service: 'running',
      pid: 4102,
      bootstrapCount: 1,
    });
    expect(readFileSync(test.identityPath)).toEqual(originalIdentity);
  });

  it('waits for a SIGTERMed instance and starts exactly one replacement', async () => {
    const test = fixture({
      service: 'stopping',
      transitionPrints: 2,
      remainingPrints: 2,
      processChecks: 1,
    });
    const originalIdentity = readFileSync(test.identityPath);

    const started = await runMain(test, 'start');

    expect(started).toMatchObject({ code: 0 });
    expect(started.output).toContain('started (pid 4102)');
    expect(started.output).not.toContain('already running');
    expect(readState(test.statePath)).toMatchObject({
      service: 'running',
      pid: 4102,
      oldProcess: false,
      bootstrapCount: 1,
      kickstartCount: 0,
    });
    expect(readFileSync(test.identityPath)).toEqual(originalIdentity);
  });

  it('rechecks a healthy-looking PID before treating start as idempotent', async () => {
    const test = fixture({ transitionPrints: 1, remainingPrints: -2, processChecks: 1 });
    const originalIdentity = readFileSync(test.identityPath);

    const started = await runMain(test, 'start');

    expect(started).toMatchObject({ code: 0 });
    expect(started.output).toContain('started (pid 4102)');
    expect(started.output).not.toContain('already running');
    expect(readState(test.statePath)).toMatchObject({
      service: 'running',
      pid: 4102,
      oldProcess: false,
      bootstrapCount: 1,
    });
    expect(readFileSync(test.identityPath)).toEqual(originalIdentity);
  });

  it('re-reads launchd when the old PID exits before its UID check', async () => {
    const test = fixture({ transitionPrints: 0, remainingPrints: -2, processChecks: 0 });
    const originalIdentity = readFileSync(test.identityPath);

    const started = await runMain(test, 'start');

    expect(started).toMatchObject({ code: 0 });
    expect(started.output).toContain('started (pid 4102)');
    expect(readState(test.statePath)).toMatchObject({
      service: 'running',
      pid: 4102,
      oldProcess: false,
      bootstrapConflictCount: 0,
      bootstrapCount: 1,
    });
    expect(readFileSync(test.identityPath)).toEqual(originalIdentity);
  });

  it('waits for an active old status socket when launchd is already stopped', async () => {
    const test = fixture({
      service: 'stopped',
      pid: undefined,
      oldProcess: true,
      processChecks: 1,
    });
    const originalIdentity = readFileSync(test.identityPath);
    const status = new DaemonStatus(daemonStatusSocketPath(test.identityPath), {
      cleanupDirectory: true,
      pid: 4101,
    });
    await status.listen();
    const closeTimer = setTimeout(() => {
      writeState(test.statePath, { ...readState(test.statePath), oldProcess: false });
      void status.close();
    }, 300);
    cleanup.push(async () => {
      clearTimeout(closeTimer);
      await status.close();
    });

    const started = await runMain(test, 'start');

    expect(started).toMatchObject({ code: 0 });
    expect(started.output).toContain('started (pid 4102)');
    expect(readState(test.statePath)).toMatchObject({
      service: 'running',
      pid: 4102,
      oldProcess: false,
      bootstrapAttempts: 1,
      bootstrapConflictCount: 0,
      bootstrapCount: 1,
    });
    expect(readFileSync(test.identityPath)).toEqual(originalIdentity);
  });

  it('serializes start with a stop whose launchd service exited before its process', async () => {
    const test = fixture({ transitionPrints: 0, processChecks: 4 });
    const originalIdentity = readFileSync(test.identityPath);
    const stopping = mainProcess(test, 'stop');
    const processes = [stopping];
    cleanup.push(async () => {
      for (const process of processes) {
        if (process.child.exitCode === null && process.child.signalCode === null) {
          process.child.kill('SIGKILL');
        }
        await process.result;
      }
    });
    await waitFor(() => {
      const state = readState(test.statePath);
      return state.service === 'stopped' && state.oldProcess;
    });
    const starting = mainProcess(test, 'start');
    processes.push(starting);

    const [stopped, started] = await Promise.all([stopping.result, starting.result]);

    expect(stopped.code).toBe(0);
    expect(started.code).toBe(0);
    expect(starting.output()).toContain('started (pid 4102)');
    expect(readState(test.statePath)).toMatchObject({
      service: 'running',
      pid: 4102,
      oldProcess: false,
      bootstrapAttempts: 1,
      bootstrapConflictCount: 0,
      bootstrapCount: 1,
    });
    expect(readFileSync(test.identityPath)).toEqual(originalIdentity);
  });

  it('rejects a stale lock without service control and succeeds after manual cleanup', async () => {
    const test = fixture({ service: 'stopped', pid: undefined, oldProcess: false });
    const lockPath = controlLockPath(test);
    const ownerPath = join(lockPath, 'pid');
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(ownerPath, '99999999\n', { mode: 0o600 });
    const activityLog = instrumentControlProbe(test);
    cleanup.push(() => cleanControlLockArtifacts(test));

    const startFailure = await runMain(test, 'start');
    const stopFailure = await runMain(test, 'stop');

    for (const failure of [startFailure, stopFailure]) {
      expect(failure.code).toBe(78);
      expect(failure.output).toContain(lockPath);
      expect(failure.output).toContain('no Daemon start/stop command is running');
      expect(failure.output).toContain(`rm -r -- ${lockPath}`);
    }
    expect(existsSync(activityLog)).toBe(false);
    expect(readFileSync(ownerPath, 'utf8')).toBe('99999999\n');
    expect(readState(test.statePath)).toMatchObject({
      service: 'stopped',
      bootstrapAttempts: 0,
      bootstrapCount: 0,
      bootoutCount: 0,
    });

    rmSync(lockPath, { recursive: true });
    const started = await runMain(test, 'start');
    expect(started).toMatchObject({ code: 0 });
    expect(started.output).toContain('started (pid 4102)');
    const stopped = await runMain(test, 'stop');
    expect(stopped).toMatchObject({ code: 0 });
    expect(stopped.output).toContain('stopped; identity was retained');
    const artifacts = readdirSync(dirname(lockPath)).filter((entry) =>
      join(dirname(lockPath), entry).startsWith(lockPath),
    );
    expect(artifacts).toEqual([]);
  }, 20_000);

  it('does not release a replacement lock owned by another token', async () => {
    const test = fixture({ service: 'stopped', pid: undefined, oldProcess: false });
    const lockPath = controlLockPath(test);
    const entered = join(test.directory, 'plutil-entered');
    const gate = join(test.directory, 'plutil-gate');
    test.environment.KAIROS_TEST_PLUTIL_ENTERED = entered;
    test.environment.KAIROS_TEST_PLUTIL_GATE = gate;
    writeFileSync(
      join(test.directory, 'bin', 'plutil'),
      `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(process.env.KAIROS_TEST_PLUTIL_ENTERED, '');
while (!existsSync(process.env.KAIROS_TEST_PLUTIL_GATE)) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
}
console.log(process.env.KAIROS_TEST_IDENTITY);
`,
      { mode: 0o700 },
    );
    const stopping = mainProcess(test, 'stop');
    cleanup.push(async () => {
      if (stopping.child.exitCode === null && stopping.child.signalCode === null) {
        stopping.child.kill('SIGKILL');
      }
      await stopping.result;
      cleanControlLockArtifacts(test);
    });
    await waitFor(() => existsSync(entered));
    const displaced = `${lockPath}.displaced-${process.pid}`;
    renameSync(lockPath, displaced);
    mkdirSync(lockPath, { mode: 0o700 });
    const replacementOwner = `${process.pid}:${'a'.repeat(32)}\n`;
    writeFileSync(join(lockPath, 'pid'), replacementOwner, { mode: 0o600 });
    writeFileSync(gate, '');

    const stopped = await stopping.result;

    expect(stopped.code).toBe(0);
    expect(readFileSync(join(lockPath, 'pid'), 'utf8')).toBe(replacementOwner);
    expect(existsSync(displaced)).toBe(true);
  });

  it.each([
    { signal: 'SIGINT' as const, code: 130 },
    { signal: 'SIGTERM' as const, code: 143 },
  ])('cleans a new lock on $signal before owner write completes', async ({ signal, code }) => {
    const test = fixture({ service: 'stopped', pid: undefined, oldProcess: false });
    const lockPath = controlLockPath(test);
    const ownerPath = join(lockPath, 'pid');
    const starting = mainProcess(test, 'start');
    cleanup.push(async () => {
      if (starting.child.exitCode === null && starting.child.signalCode === null) {
        starting.child.kill('SIGKILL');
      }
      await starting.result;
      cleanControlLockArtifacts(test);
    });
    const deadline = Date.now() + 5000;
    while (!existsSync(lockPath)) {
      if (starting.child.exitCode !== null || starting.child.signalCode !== null) {
        throw new Error(`start exited before lock creation: ${starting.output()}`);
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for lock directory creation.');
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
    }
    starting.child.kill('SIGSTOP');
    expect(existsSync(ownerPath)).toBe(false);
    starting.child.kill(signal);
    starting.child.kill('SIGCONT');

    const signaled = await starting.result;

    expect(signaled.code).toBe(code);
    expect(existsSync(lockPath)).toBe(false);
    expect(readState(test.statePath)).toMatchObject({ bootstrapAttempts: 0, bootoutCount: 0 });
  });

  it.each([
    { signal: 'SIGINT' as const, code: 130 },
    { signal: 'SIGTERM' as const, code: 143 },
  ])('cleans the control lock on $signal before exiting', async ({ signal, code }) => {
    const test = fixture({ service: 'stopped', pid: undefined, oldProcess: false });
    const lockPath = controlLockPath(test);
    const entered = join(test.directory, 'plutil-entered');
    const gate = join(test.directory, 'plutil-gate');
    test.environment.KAIROS_TEST_PLUTIL_ENTERED = entered;
    test.environment.KAIROS_TEST_PLUTIL_GATE = gate;
    writeFileSync(
      join(test.directory, 'bin', 'plutil'),
      `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(process.env.KAIROS_TEST_PLUTIL_ENTERED, '');
while (!existsSync(process.env.KAIROS_TEST_PLUTIL_GATE)) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
}
console.log(process.env.KAIROS_TEST_IDENTITY);
`,
      { mode: 0o700 },
    );
    const starting = mainProcess(test, 'start');
    cleanup.push(async () => {
      writeFileSync(gate, '');
      if (starting.child.exitCode === null && starting.child.signalCode === null) {
        starting.child.kill('SIGKILL');
      }
      await starting.result;
      cleanControlLockArtifacts(test);
    });
    await waitFor(() => existsSync(entered));
    starting.child.kill(signal);
    const signaled = await starting.result;
    writeFileSync(gate, '');

    expect(signaled.code).toBe(code);
    expect(existsSync(lockPath)).toBe(false);
    expect(readState(test.statePath)).toMatchObject({ bootstrapAttempts: 0, bootoutCount: 0 });
    const started = await runMain(test, 'start');
    expect(started).toMatchObject({ code: 0 });
    expect(started.output).toContain('started (pid 4102)');
    expect(existsSync(lockPath)).toBe(false);
  });

  it.each([
    { signal: 'SIGINT' as const, code: 130 },
    { signal: 'SIGTERM' as const, code: 143 },
  ])('waits for lock release on $signal during rmdir', async ({ signal, code }) => {
    const test = fixture({ service: 'stopped', pid: undefined, oldProcess: false });
    const lockPath = controlLockPath(test);
    const ownerPath = join(lockPath, 'pid');
    const entered = join(test.directory, 'rmdir-entered');
    const gate = join(test.directory, 'rmdir-gate');
    const signalObserved = join(test.directory, 'rmdir-signal-observed');
    const preload = join(test.directory, 'rmdir-gate.mjs');
    writeFileSync(
      preload,
      `
import filesystem from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const target = ${JSON.stringify(lockPath)};
const entered = ${JSON.stringify(entered)};
const gate = ${JSON.stringify(gate)};
const original = filesystem.rmdir;
filesystem.rmdir = async function(path, ...options) {
  if (path === target) {
    writeFileSync(entered, '');
    const deadline = Date.now() + 10000;
    while (!existsSync(gate)) {
      if (Date.now() >= deadline) throw new Error('Test rmdir gate was not released.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  return original.call(this, path, ...options);
};
syncBuiltinESMExports();
process.on(${JSON.stringify(signal)}, () => {
  if (existsSync(entered)) writeFileSync(${JSON.stringify(signalObserved)}, '');
});
`,
      { mode: 0o600 },
    );
    const stopping = mainProcess(test, 'stop', [preload]);
    cleanup.push(async () => {
      writeFileSync(gate, '');
      if (stopping.child.exitCode === null && stopping.child.signalCode === null) {
        stopping.child.kill('SIGKILL');
      }
      await stopping.result;
      cleanControlLockArtifacts(test);
    });
    await waitFor(() => existsSync(entered));
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(ownerPath)).toBe(false);
    stopping.child.kill(signal);
    await waitFor(() => existsSync(signalObserved));
    expect(stopping.child.exitCode).toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    writeFileSync(gate, '');

    const signaled = await stopping.result;

    expect(signaled.code).toBe(code);
    expect(stopping.output()).toContain('already stopped');
    expect(existsSync(lockPath)).toBe(false);
    expect(readState(test.statePath)).toMatchObject({ bootstrapAttempts: 0, bootoutCount: 0 });
  });

  it('does not remove a lock whose PID is alive', async () => {
    const test = fixture({ service: 'stopped', pid: undefined, oldProcess: false });
    const lockPath = controlLockPath(test);
    mkdirSync(lockPath, { mode: 0o700 });
    const owner = `${process.pid}:${'b'.repeat(32)}\n`;
    writeFileSync(join(lockPath, 'pid'), owner, { mode: 0o600 });
    cleanup.push(() => cleanControlLockArtifacts(test));

    const started = await runMain(test, 'start');

    expect(started).toMatchObject({ code: 78 });
    expect(started.output).toContain('control lock remained');
    expect(started.output).toContain(lockPath);
    expect(readFileSync(join(lockPath, 'pid'), 'utf8')).toBe(owner);
    expect(readState(test.statePath).bootstrapAttempts).toBe(0);
  });

  it('keeps start idempotent for a stable healthy instance', async () => {
    const test = fixture();

    const started = await runMain(test, 'start');

    expect(started).toMatchObject({ code: 0 });
    expect(started.output).toContain('already running (pid 4101)');
    expect(readState(test.statePath)).toMatchObject({
      service: 'running',
      pid: 4101,
      bootstrapCount: 0,
      kickstartCount: 0,
    });
  });

  it('still rejects a running PID owned by a different UID', async () => {
    const test = fixture();
    test.environment.KAIROS_TEST_UID = String((process.getuid?.() ?? 0) + 1);

    const started = await runMain(test, 'start');

    expect(started).toMatchObject({ code: 78 });
    expect(started.output).toContain('Daemon process UID verification failed');
    expect(readState(test.statePath)).toMatchObject({
      service: 'running',
      pid: 4101,
      bootstrapAttempts: 0,
      kickstartCount: 0,
    });
  });

  it('fails instead of reporting stop while launchd remains stopping', async () => {
    const test = fixture({ transitionPrints: -1, processChecks: -1 });
    const originalIdentity = readFileSync(test.identityPath);

    const stopped = await runMain(test, 'stop');

    expect(stopped).toMatchObject({ code: 78 });
    expect(stopped.output).toContain('did not stop');
    expect(stopped.output).not.toContain('stopped; identity was retained');
    expect(readState(test.statePath).service).toBe('stopping');
    expect(readFileSync(test.identityPath)).toEqual(originalIdentity);
  });

  it('fails instead of reporting stop when the old process outlives launchd', async () => {
    const test = fixture({ transitionPrints: 0, processChecks: -1 });
    const originalIdentity = readFileSync(test.identityPath);

    const stopped = await runMain(test, 'stop');

    expect(stopped).toMatchObject({ code: 78 });
    expect(stopped.output).toContain('did not stop');
    expect(stopped.output).not.toContain('stopped; identity was retained');
    expect(readState(test.statePath)).toMatchObject({ service: 'stopped', oldProcess: true });
    expect(readFileSync(test.identityPath)).toEqual(originalIdentity);
  });
});
