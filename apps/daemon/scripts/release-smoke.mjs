#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const archive = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(archive)) {
  throw new Error('Usage: node apps/daemon/scripts/release-smoke.mjs RELEASE_ARCHIVE');
}
const checksumPath = `${archive}.sha256`;
if (!existsSync(checksumPath)) throw new Error('External archive checksum is missing.');

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function runAsync(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.uid === undefined ? {} : { uid: options.uid }),
      ...(options.gid === undefined ? {} : { gid: options.gid }),
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolvePromise(output.trim());
      else reject(new Error(`Command failed with exit ${code}: ${command}\n${output.trim()}`));
    });
    child.stdin.end(options.input);
  });
}

const externalLine = readFileSync(checksumPath, 'utf8').trim();
const externalMatch = /^([a-f0-9]{64}) {2}(.+)$/.exec(externalLine);
if (!externalMatch || externalMatch[2] !== archive.split('/').pop()) {
  throw new Error('External archive checksum format is invalid.');
}
if (digest(archive) !== externalMatch[1]) throw new Error('Archive checksum verification failed.');

const entries = run('tar', ['-tzf', archive]).split('\n').filter(Boolean);
for (const entry of entries) {
  const normalized = entry.replace(/^\.\//, '');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe archive entry: ${entry}`);
  }
}

const temporary = mkdtempSync(join(tmpdir(), 'kairos-daemon-smoke-'));
const root = temporary;

function walk(directory = root) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(path));
    else result.push(path);
  }
  return result;
}

function regularFiles() {
  return walk()
    .filter((path) => lstatSync(path).isFile())
    .map((path) => relative(root, path).split(sep).join('/'));
}

function verifyInternalChecksums() {
  const lines = readFileSync(join(root, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
  const expected = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match || match[2].startsWith('/') || match[2].split('/').includes('..')) {
      throw new Error('Internal checksum manifest contains an invalid entry.');
    }
    if (expected.has(match[2])) throw new Error('Internal checksum manifest contains a duplicate.');
    expected.set(match[2], match[1]);
    if (digest(join(root, match[2])) !== match[1]) {
      throw new Error(`Internal checksum mismatch: ${match[2]}`);
    }
  }
  const unchecked = regularFiles().filter((path) => path !== 'SHA256SUMS' && !expected.has(path));
  if (unchecked.length > 0) throw new Error(`Unchecked release files: ${unchecked.join(', ')}`);
}

async function waitFor(read, timeoutMilliseconds = 15_000, intervalMilliseconds = 50) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMilliseconds));
  }
  throw new Error('Timed out waiting for macOS launchd smoke state.');
}

function smokeServiceLabel(envId) {
  return `team.kairos.daemon.${createHash('sha256').update(envId).digest('hex').slice(0, 32)}`;
}

function smokeStatusSocket(identityPath) {
  const uid = statSync(identityPath).uid;
  const suffix = createHash('sha256').update(identityPath).digest('hex').slice(0, 32);
  return `/tmp/kairos-daemon-${uid}/${suffix}.sock`;
}

function smokeControlLock(identityPath) {
  const uid = statSync(identityPath).uid;
  const suffix = createHash('sha256').update(resolve(identityPath)).digest('hex').slice(0, 32);
  return `/tmp/kairos-daemon-control-${uid}-${suffix}.lock`;
}

function identityMetadata(identityPath) {
  const stat = statSync(identityPath);
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.mtimeMs].join(':');
}

async function macosLaunchdSmoke() {
  const { default: WebSocket } = await import(
    pathToFileURL(join(root, 'app/node_modules/ws/index.js')).href
  );
  const { WebSocketServer } = WebSocket;
  const { DeviceCapability, decodeDaemonMessage, encodeServerMessage } = await import(
    pathToFileURL(join(root, 'app/packages/contracts/dist/device.js')).href
  );
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolvePromise) => server.once('listening', resolvePromise));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Smoke WSS address is invalid.');
  const serverUrl = `ws://127.0.0.1:${address.port}/devices/wss`;
  const events = [];
  const connections = new Map();
  server.on('error', (error) => events.push({ type: 'serverError', error: error.message }));
  let operationSequence = 0;
  server.on('connection', (socket) => {
    let envId = '';
    connections.set(socket, envId);
    events.push({ type: 'connection' });
    socket.on('error', (error) => events.push({ type: 'socketError', error: error.message }));
    socket.on('close', () => {
      connections.delete(socket);
      events.push({ type: 'close', envId });
    });
    socket.on('message', (data) => {
      events.push({ type: 'message' });
      const bytes = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      const message = decodeDaemonMessage(bytes);
      if (message.payload.case === 'deviceHello') {
        const hello = message.payload.value;
        envId = hello.envId;
        connections.set(socket, envId);
        const pairing = hello.authentication.case === 'pairingCredential';
        if (pairing && hello.authentication.value !== 'kp1_smoke') {
          throw new Error('Smoke pairing credential was not transmitted correctly.');
        }
        events.push({ type: 'hello', envId, pairing });
        socket.send(
          encodeServerMessage({
            payload: {
              case: 'serverHello',
              value: {
                deviceId: `device-${envId}`,
                instanceId: hello.instanceId,
                protocolMajor: 1,
                capabilities: [DeviceCapability.BASH, DeviceCapability.DIRECTORY_CHECK],
                serverTime: { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 },
                envId,
                deviceBindingId: `binding-${envId}`,
                ...(pairing ? { deviceCredential: `kd2_smoke_${envId}` } : {}),
              },
            },
          }),
          { binary: true },
        );
        operationSequence += 1;
        socket.send(
          encodeServerMessage({
            payload: {
              case: 'operationStart',
              value: {
                operationId: `directory-${operationSequence}`,
                requestId: `directory-request-${operationSequence}`,
                target: {
                  envId,
                  deviceBindingId: `binding-${envId}`,
                  instanceId: hello.instanceId,
                },
                expiresAt: {
                  seconds: BigInt(Math.floor((Date.now() + 60_000) / 1000)),
                  nanos: 0,
                },
                action: {
                  case: 'directoryCheck',
                  value: { path: workingDirectory, loadWorkspace: false },
                },
              },
            },
          }),
          { binary: true },
        );
      } else if (message.payload.case === 'operationResult') {
        const result = message.payload.value;
        socket.send(
          encodeServerMessage({
            payload: {
              case: 'operationResultAck',
              value: {
                operationId: result.operationId,
                target: result.target,
                ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
              },
            },
          }),
          { binary: true },
        );
      } else if (message.payload.case === 'heartbeat') {
        socket.send(
          encodeServerMessage({
            payload: {
              case: 'heartbeatAck',
              value: {
                sequence: message.payload.value.sequence,
                receivedAt: { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 },
              },
            },
          }),
          { binary: true },
        );
      }
    });
  });

  const isolatedRoot = mkdtempSync(join(tmpdir(), 'kairos-daemon-launchd-'));
  const home = join(isolatedRoot, 'isolated-home');
  const workingDirectory = join(isolatedRoot, 'working-directory');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(workingDirectory, { mode: 0o700 });
  const environment = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home };
  const uid = run('id', ['-u']);
  const envIds = [`test-m142-${process.pid}`, `prod-m142-${process.pid}`];
  const labels = envIds.map(smokeServiceLabel);
  const control = join(home, '.local/bin/kairos-daemon');
  const identityPath = (envId) =>
    join(home, 'Library/Application Support/Kairos/daemon/environments', envId, 'identity.json');
  const servicePid = (label) => {
    try {
      const output = run('launchctl', ['print', `gui/${uid}/${label}`]);
      const match = /^\s*pid = ([1-9][0-9]*)\s*$/m.exec(output);
      return match === null ? undefined : Number(match[1]);
    } catch {
      return undefined;
    }
  };
  const processExists = (pid) => {
    try {
      run('ps', ['-o', 'uid=', '-p', String(pid)]);
      return true;
    } catch {
      return false;
    }
  };
  const observe = async (envId) => {
    await waitFor(() => (existsSync(smokeStatusSocket(identityPath(envId))) ? true : undefined));
    const child = spawn(control, ['status', envId], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const result = new Promise((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolvePromise({ code, signal }));
    });
    try {
      await waitFor(() =>
        output.includes('Live events') &&
        (output.includes('WSS: connected') || output.includes('connection connected'))
          ? true
          : undefined,
      );
      child.kill('SIGINT');
      const closed = await result;
      if (closed.signal !== 'SIGINT') throw new Error('status observer did not exit on SIGINT.');
      return output;
    } catch (error) {
      child.kill('SIGKILL');
      await result;
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
    }
  };

  const install = async (envId) => {
    try {
      return await runAsync(
        'bash',
        [
          join(root, 'install.sh'),
          '--env-id',
          envId,
          '--server-url',
          serverUrl,
          '--directory',
          workingDirectory,
        ],
        { env: environment, input: 'kp1_smoke\n' },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${detail}\nWSS events: ${JSON.stringify(events)}`);
    }
  };

  try {
    for (const envId of envIds) {
      const output = await install(envId);
      for (const command of ['status', 'stop', 'start']) {
        if (!output.includes(`${command} ${envId}`)) {
          throw new Error(`Installation guide does not include ${command} ${envId}.`);
        }
      }
      await waitFor(() => {
        const envEvents = events.filter((event) => event.envId === envId);
        const closeIndex = envEvents.findIndex((event) => event.type === 'close');
        const backgroundIndex = envEvents.findIndex(
          (event, index) => event.type === 'hello' && index > closeIndex && closeIndex >= 0,
        );
        return closeIndex >= 0 && backgroundIndex > closeIndex ? true : undefined;
      });
    }
    const pids = labels.map((label) => servicePid(label));
    if (pids.some((pid) => pid === undefined))
      throw new Error('Two launchd services are not active.');
    for (const pid of pids) {
      if (run('ps', ['-o', 'uid=', '-p', String(pid)]).trim() !== uid) {
        throw new Error('launchd service UID does not match the isolated login user.');
      }
      if (run('ps', ['-o', 'ppid=', '-p', String(pid)]).trim() !== '1') {
        throw new Error('Daemon remains attached to the installer process instead of launchd.');
      }
    }
    const repeated = await runAsync(control, ['start', envIds[0]], { env: environment });
    if (!repeated.includes('already running') || servicePid(labels[0]) !== pids[0]) {
      throw new Error('start restarted an active environment.');
    }
    await observe(envIds[0]);
    await observe(envIds[1]);

    const originalIdentity = identityMetadata(identityPath(envIds[0]));
    const controlLock = smokeControlLock(identityPath(envIds[0]));
    const controlOwner = join(controlLock, 'pid');
    mkdirSync(controlLock, { mode: 0o700 });
    writeFileSync(controlOwner, '99999999\n', { mode: 0o600 });
    const staleFailure = await runAsync(control, ['stop', envIds[0]], { env: environment }).then(
      () => {
        throw new Error('stop accepted a stale control lock.');
      },
      (error) => error,
    );
    const staleOutput = staleFailure instanceof Error ? staleFailure.message : String(staleFailure);
    if (
      !staleOutput.includes(controlLock) ||
      !staleOutput.includes(`rm -r -- ${controlLock}`) ||
      !staleOutput.includes('no Daemon start/stop command is running')
    ) {
      throw new Error(`stale lock rejection is missing safe cleanup guidance: ${staleOutput}`);
    }
    if (servicePid(labels[0]) !== pids[0] || !processExists(pids[0])) {
      throw new Error('stale lock rejection stopped the healthy Daemon.');
    }
    if (readFileSync(controlOwner, 'utf8') !== '99999999\n') {
      throw new Error('stale lock rejection modified the residual owner.');
    }
    await observe(envIds[0]);
    rmSync(controlLock, { recursive: true, force: true });

    const stopping = runAsync(control, ['stop', envIds[0]], { env: environment });
    await Promise.race([
      waitFor(
        () => {
          try {
            return /^[1-9][0-9]*:[0-9a-f]{32}\n$/.test(readFileSync(controlOwner, 'utf8'))
              ? true
              : undefined;
          } catch {
            return undefined;
          }
        },
        15_000,
        5,
      ),
      stopping.then(() => {
        throw new Error('stop completed before its in-progress control lock was observed.');
      }),
    ]);
    const starting = runAsync(control, ['start', envIds[0]], { env: environment });
    const [stopped, restarted] = await Promise.all([stopping, starting]);
    if (!stopped.includes('stopped; identity was retained')) {
      throw new Error(`Concurrent stop did not complete cleanly: ${stopped}`);
    }
    if (processExists(pids[0])) {
      throw new Error('Concurrent start completed before the old Daemon process exited.');
    }
    if (existsSync(smokeStatusSocket(identityPath(envIds[0])))) {
      throw new Error('Concurrent start completed before the old status channel closed.');
    }
    if (existsSync(controlLock)) throw new Error('The Daemon control lock was not released.');

    if (!restarted.includes('started (pid ')) {
      throw new Error(`Concurrent start did not create a replacement: ${restarted}`);
    }
    const replacementPid = await waitFor(() => {
      const pid = servicePid(labels[0]);
      return pid !== undefined && pid !== pids[0] ? pid : undefined;
    });
    if (processExists(pids[0])) throw new Error('The old Daemon survived immediate start.');
    await observe(envIds[0]);
    await waitFor(() =>
      [...connections.values()].filter((envId) => envId === envIds[0]).length === 1
        ? true
        : undefined,
    );
    if (identityMetadata(identityPath(envIds[0])) !== originalIdentity) {
      throw new Error('stop/start changed the paired identity metadata.');
    }
    if (run('ps', ['-o', 'ppid=', '-p', String(replacementPid)]).trim() !== '1') {
      throw new Error('The replacement Daemon is not managed by launchd.');
    }
    if (servicePid(labels[1]) === undefined) throw new Error('Stopping test stopped prod.');
    await observe(envIds[1]);

    await runAsync(control, ['stop', envIds[0]], { env: environment });
    await runAsync(control, ['stop', envIds[1]], { env: environment });
    await waitFor(() =>
      labels.every((label) => servicePid(label) === undefined) ? true : undefined,
    );
    if (events.filter((event) => event.type === 'hello' && event.pairing).length !== 2) {
      throw new Error('start unexpectedly repeated pairing.');
    }
    return {
      environments: envIds,
      simultaneousLaunchdServices: true,
      parentPid: 1,
      statusObserverExitPreservedDaemon: true,
      independentStopStart: true,
      concurrentStopStart: true,
      staleLockRejected: true,
      manualStaleLockCleanup: true,
      controlLockReleased: true,
      oldProcessExitedBeforeReplacement: true,
      singleReplacementConnection: true,
      replacementOnline: true,
      pairingClosedBeforeBackground: true,
      identityMetadataRetained: true,
    };
  } finally {
    for (const label of labels) {
      try {
        execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
      } catch {}
    }
    for (const client of server.clients) client.terminate();
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    rmSync(isolatedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function linuxSystemdSmoke() {
  if (platform() !== 'linux' || arch() !== 'x64' || expectedTarget !== 'ubuntu22.04-24.04-x86_64') {
    throw new Error('Linux systemd smoke requires the Linux x64 archive on a Linux x64 host.');
  }
  if (process.getuid?.() !== 0)
    throw new Error('Linux systemd smoke requires root on a dedicated host.');
  if (readFileSync('/proc/1/comm', 'utf8').trim() !== 'systemd') {
    throw new Error('Linux systemd smoke requires PID 1 to be systemd.');
  }
  execFileSync('script', ['--version'], { stdio: 'ignore' });
  const osRelease = readFileSync('/etc/os-release', 'utf8');
  if (!/^ID=ubuntu$/m.test(osRelease) || !/^VERSION_ID="(22\.04|24\.04)"$/m.test(osRelease)) {
    throw new Error('Linux systemd smoke supports only Ubuntu 22.04 or 24.04.');
  }
  const ubuntuVersion = /^VERSION_ID="(22\.04|24\.04)"$/m.exec(osRelease)?.[1];
  const managedPaths = [
    '/opt/kairos-daemon',
    '/etc/kairos-daemon',
    '/var/lib/kairos-daemon',
    '/etc/systemd/system/kairos-daemon.service',
  ];
  if (managedPaths.some((path) => existsSync(path))) {
    throw new Error('Linux systemd smoke requires a host without an existing Kairos installation.');
  }
  let kairosAccountExists = true;
  try {
    execFileSync('getent', ['passwd', 'kairos'], { stdio: 'ignore' });
  } catch {
    kairosAccountExists = false;
  }
  if (kairosAccountExists) {
    throw new Error('Linux systemd smoke requires the kairos account to be absent.');
  }
  const user = `kairos-m140-${process.pid}`;
  const home = `/tmp/${user}`;
  const sudoers = `/etc/sudoers.d/${user}`;
  if ([home, sudoers, '/tmp/kairos-m140-work'].some((path) => existsSync(path))) {
    throw new Error('Linux systemd smoke temporary paths already exist.');
  }
  let ordinaryUserExists = true;
  try {
    execFileSync('getent', ['passwd', user], { stdio: 'ignore' });
  } catch {
    ordinaryUserExists = false;
  }
  if (ordinaryUserExists) throw new Error('Linux systemd smoke temporary user already exists.');

  const { default: WebSocket } = await import(
    pathToFileURL(join(root, 'app/node_modules/ws/index.js')).href
  );
  const { WebSocketServer } = WebSocket;
  const { DeviceCapability, decodeDaemonMessage, encodeServerMessage } = await import(
    pathToFileURL(join(root, 'app/packages/contracts/dist/device.js')).href
  );
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolvePromise) => server.once('listening', resolvePromise));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Linux smoke WSS address is invalid.');
  const serverUrl = `ws://127.0.0.1:${address.port}/devices/wss`;
  const workingDirectory = '/tmp/kairos-m140-work';
  mkdirSync(workingDirectory, { mode: 0o700 });
  let operationSequence = 0;
  server.on('connection', (socket) => {
    socket.on('error', () => undefined);
    socket.on('message', (data) => {
      const bytes = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      const message = decodeDaemonMessage(bytes);
      if (message.payload.case === 'deviceHello') {
        const hello = message.payload.value;
        const pairing = hello.authentication.case === 'pairingCredential';
        if (pairing && hello.authentication.value !== 'kp1_smoke') {
          throw new Error('Linux smoke pairing credential is invalid.');
        }
        const envId = hello.envId;
        socket.send(
          encodeServerMessage({
            payload: {
              case: 'serverHello',
              value: {
                deviceId: `device-${envId}`,
                instanceId: hello.instanceId,
                protocolMajor: 1,
                capabilities: [DeviceCapability.BASH, DeviceCapability.DIRECTORY_CHECK],
                serverTime: { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 },
                envId,
                deviceBindingId: `binding-${envId}`,
                ...(pairing ? { deviceCredential: `kd2_smoke_${envId}` } : {}),
              },
            },
          }),
          { binary: true },
        );
        operationSequence += 1;
        socket.send(
          encodeServerMessage({
            payload: {
              case: 'operationStart',
              value: {
                operationId: `directory-${operationSequence}`,
                requestId: `directory-request-${operationSequence}`,
                target: {
                  envId,
                  deviceBindingId: `binding-${envId}`,
                  instanceId: hello.instanceId,
                },
                expiresAt: {
                  seconds: BigInt(Math.floor((Date.now() + 60_000) / 1000)),
                  nanos: 0,
                },
                action: {
                  case: 'directoryCheck',
                  value: { path: workingDirectory, loadWorkspace: false },
                },
              },
            },
          }),
          { binary: true },
        );
      } else if (message.payload.case === 'operationResult') {
        const result = message.payload.value;
        socket.send(
          encodeServerMessage({
            payload: {
              case: 'operationResultAck',
              value: {
                operationId: result.operationId,
                target: result.target,
                ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
              },
            },
          }),
          { binary: true },
        );
      } else if (message.payload.case === 'heartbeat') {
        socket.send(
          encodeServerMessage({
            payload: {
              case: 'heartbeatAck',
              value: {
                sequence: message.payload.value.sequence,
                receivedAt: { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 },
              },
            },
          }),
          { binary: true },
        );
      }
    });
  });

  const envId = `env-linux-m140-${process.pid}`;
  const control = join(home, '.local/bin/kairos-daemon');
  const identityPath = '/var/lib/kairos-daemon/identity.json';
  const path = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  let ordinaryUid = 0;
  let ordinaryGid = 0;
  const password = randomBytes(24).toString('base64');
  const interactiveControl = (command) => {
    const child = spawn(
      'script',
      ['-q', '-e', '-c', `stty -echo; sudo -k; ${control} ${command} ${envId}`, '/dev/null'],
      {
        env: { PATH: path, HOME: home, LC_ALL: 'C' },
        uid: ordinaryUid,
        gid: ordinaryGid,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let rawOutput = '';
    let prompted = false;
    const output = () => rawOutput.replaceAll(password, '[redacted]');
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const receive = (chunk) => {
      rawOutput += chunk;
      if (!prompted && rawOutput.includes('password for')) {
        prompted = true;
        child.stdin.write(`${password}\n`);
      }
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    const result = new Promise((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolvePromise({ code, signal }));
    });
    return { child, result, output, prompted: () => prompted };
  };
  const runAsUser = async (command) => {
    const session = interactiveControl(command);
    const closed = await session.result;
    if (!session.prompted()) throw new Error(`sudo did not request a password for ${command}.`);
    if (closed.code !== 0) {
      throw new Error(
        `Interactive ${command} failed with exit ${closed.code}: ${session.output()}`,
      );
    }
    return session.output();
  };
  const servicePid = () =>
    Number(run('systemctl', ['show', 'kairos-daemon.service', '--property', 'MainPID', '--value']));
  const observe = async () => {
    const session = interactiveControl('status');
    try {
      await waitFor(() => (session.output().includes('Live events') ? true : undefined));
      session.child.kill('SIGINT');
      const closed = await session.result;
      if (!session.prompted()) throw new Error('sudo did not request a password for status.');
      if (closed.signal !== 'SIGINT' && closed.code !== 130) {
        throw new Error('Linux status observer did not exit on SIGINT.');
      }
      return session.output();
    } catch (error) {
      session.child.kill('SIGKILL');
      await session.result;
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${session.output()}`,
      );
    }
  };

  try {
    run('useradd', ['--create-home', '--home-dir', home, '--shell', '/bin/bash', user]);
    ordinaryUid = Number(run('id', ['-u', user]));
    ordinaryGid = Number(run('id', ['-g', user]));
    execFileSync('chpasswd', {
      input: `${user}:${password}\n`,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    writeFileSync(
      sudoers,
      `${user} ALL=(root) /opt/kairos-daemon/current/systemd/control.sh, /opt/kairos-daemon/releases/*/systemd/control.sh\n`,
      { mode: 0o440 },
    );
    await runAsync(
      'bash',
      [
        join(root, 'install.sh'),
        '--env-id',
        envId,
        '--server-url',
        serverUrl,
        '--directory',
        workingDirectory,
      ],
      {
        env: {
          PATH: path,
          HOME: '/root',
          SUDO_USER: user,
          SUDO_UID: String(ordinaryUid),
          SUDO_GID: String(ordinaryGid),
        },
        input: 'kp1_smoke\n',
      },
    );
    if (readlinkSync(control) !== '/opt/kairos-daemon/current/systemd/control.sh') {
      throw new Error('Linux control link does not target the privileged systemd helper.');
    }
    await runAsync('test', ['-x', control], {
      env: { PATH: path, HOME: home },
      uid: ordinaryUid,
      gid: ordinaryGid,
    });
    const kairosUid = Number(run('id', ['-u', 'kairos']));
    if (
      (statSync(identityPath).mode & 0o777) !== 0o600 ||
      statSync(identityPath).uid !== kairosUid
    ) {
      throw new Error('Linux identity owner or mode changed.');
    }
    if ((statSync('/var/lib/kairos-daemon').mode & 0o777) !== 0o700) {
      throw new Error('Linux service account directory is not mode 0700.');
    }
    await runAsync('test', ['!', '-r', identityPath], {
      env: { PATH: path, HOME: home },
      uid: ordinaryUid,
      gid: ordinaryGid,
    });
    await runAsync('test', ['!', '-x', `/tmp/kairos-daemon-${kairosUid}`], {
      env: { PATH: path, HOME: home },
      uid: ordinaryUid,
      gid: ordinaryGid,
    });
    const initialPid = servicePid();
    await runAsUser('start');
    if (servicePid() !== initialPid) throw new Error('Linux start restarted an active Daemon.');
    if (run('ps', ['-o', 'uid=', '-p', String(servicePid())]).trim() !== String(kairosUid)) {
      throw new Error('start launched the Daemon as the wrong account.');
    }
    await observe();
    if (run('ps', ['-o', 'uid=', '-p', String(servicePid())]).trim() !== String(kairosUid)) {
      throw new Error('status observer exit stopped or replaced the Daemon.');
    }
    const originalIdentity = readFileSync(identityPath);
    await runAsUser('stop');
    if (!readFileSync(identityPath).equals(originalIdentity)) {
      throw new Error('Linux stop changed the paired identity.');
    }
    const stopped = await runAsUser('status');
    if (!stopped.includes('Process: stopped'))
      throw new Error('Linux stopped status is not visible.');
    await runAsUser('start');
    await observe();
    await runAsUser('stop');
    return {
      ubuntuVersion,
      rootInstallation: true,
      ordinaryUserHome: home,
      ordinaryUserEntryAccessible: true,
      interactiveSudoPrompt: true,
      sudoTimestampClearedPerCommand: true,
      serviceAccountIdentityAndStatus: true,
      startStopStatusAcrossAccounts: true,
      statusObserverExitPreservedDaemon: true,
      identityRetained: true,
    };
  } finally {
    await runAsync('systemctl', ['disable', '--now', 'kairos-daemon.service']).catch(
      () => undefined,
    );
    for (const pathToRemove of managedPaths) {
      rmSync(pathToRemove, { recursive: true, force: true });
    }
    try {
      execFileSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
    } catch {}
    await runAsync('runuser', ['-u', user, '--', 'sudo', '-k']).catch(() => undefined);
    rmSync(sudoers, { force: true });
    try {
      execFileSync('userdel', [user], { stdio: 'ignore' });
    } catch {}
    try {
      execFileSync('userdel', ['kairos'], { stdio: 'ignore' });
    } catch {}
    rmSync(home, { recursive: true, force: true });
    rmSync(workingDirectory, { recursive: true, force: true });
    for (const client of server.clients) client.terminate();
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  }
}

try {
  run('tar', ['-xzf', archive, '-C', temporary]);
  if (!existsSync(join(root, 'SHA256SUMS'))) throw new Error('Release root is missing.');
  verifyInternalChecksums();

  const required = [
    'node/bin/node',
    'app/apps/daemon/dist/main.js',
    'app/packages/contracts/dist/device.js',
    'app/node_modules/ws/package.json',
    'app/node_modules/@bufbuild/protobuf/package.json',
    'app/node_modules/zod/package.json',
    'bin/kairos-daemon',
    'systemd/kairos-daemon.service',
    'systemd/control.sh',
    'systemd/control-home.sh',
    'macos/control.sh',
    'install.sh',
    'upgrade.sh',
    'uninstall.sh',
    'VERSION',
    'BUILDINFO',
    'SHA256SUMS',
  ];
  for (const path of required) {
    if (!existsSync(join(root, path))) throw new Error(`Required release file is missing: ${path}`);
  }
  const contractLink = join(root, 'app/node_modules/@kairos/contracts');
  if (readlinkSync(contractLink) !== '../../packages/contracts') {
    throw new Error('Workspace contracts link is invalid.');
  }
  const canonicalRoot = realpathSync(root);
  for (const path of walk()) {
    if (lstatSync(path).isSymbolicLink() && !realpathSync(path).startsWith(`${canonicalRoot}/`)) {
      throw new Error(`Release symlink escapes its root: ${relative(root, path)}`);
    }
  }

  for (const path of regularFiles()) {
    const lower = path.toLowerCase();
    const base = lower.split('/').pop();
    if (
      base === '.env' ||
      base?.startsWith('.env.') ||
      base?.startsWith('._') ||
      lower.endsWith('.sqlite') ||
      lower.endsWith('.sqlite3') ||
      lower.endsWith('.log') ||
      lower.endsWith('.pem') ||
      lower.endsWith('.key') ||
      lower.startsWith('.git/') ||
      lower.startsWith('.tower/') ||
      lower.startsWith('reference/') ||
      lower.startsWith('app/apps/daemon/src/') ||
      lower.startsWith('app/packages/contracts/src/') ||
      /app\/(apps\/daemon|packages\/contracts)\/.*\.test\.[cm]?[jt]s$/.test(lower)
    ) {
      throw new Error(`Sensitive or development file was packaged: ${path}`);
    }
  }
  for (const path of [
    'bin/kairos-daemon',
    'install.sh',
    'upgrade.sh',
    'uninstall.sh',
    'macos/control.sh',
    'systemd/control.sh',
  ]) {
    if ((statSync(join(root, path)).mode & 0o111) === 0) {
      throw new Error(`Release executable mode is missing: ${path}`);
    }
  }
  const daemonPackage = JSON.parse(
    readFileSync(join(root, 'app/apps/daemon/package.json'), 'utf8'),
  );
  if (daemonPackage.devDependencies !== undefined) {
    throw new Error('Daemon development dependencies were packaged.');
  }
  const expectedTarget = ['ubuntu22.04-24.04-x86_64', 'macos-arm64', 'macos-x64'].find((target) =>
    archive.endsWith(`-${target}.tar.gz`),
  );
  if (!expectedTarget) throw new Error('Release archive does not identify a supported target.');
  const buildInfo = readFileSync(join(root, 'BUILDINFO'), 'utf8');
  for (const requiredInfo of [
    'node_version=26.4.0',
    `target=${expectedTarget}`,
    'release_signature_verification=unverified_no_public_key',
    'release_download_url=unconfigured',
    'ubuntu22.04_systemd_acceptance=unverified',
    'ubuntu24.04_systemd_acceptance=unverified',
  ]) {
    if (!buildInfo.includes(`${requiredInfo}\n`))
      throw new Error(`BUILDINFO is missing ${requiredInfo}`);
  }

  const main = join(root, 'app/apps/daemon/dist/main.js');
  const original = readFileSync(main);
  original[original.length - 1] ^= 1;
  writeFileSync(main, original);
  let negativeRejected = false;
  try {
    verifyInternalChecksums();
  } catch {
    negativeRejected = true;
  }
  if (!negativeRejected) throw new Error('Modified release content was not rejected.');
  original[original.length - 1] ^= 1;
  writeFileSync(main, original);
  verifyInternalChecksums();

  const packagedRuntime =
    (platform() === 'linux' && arch() === 'x64' && expectedTarget === 'ubuntu22.04-24.04-x86_64') ||
    (platform() === 'darwin' && expectedTarget === `macos-${arch()}`);
  const node = packagedRuntime ? join(root, 'node/bin/node') : process.execPath;
  if (packagedRuntime && run(node, ['--version']) !== 'v26.4.0') {
    throw new Error('Packaged Node.js runtime version is incorrect.');
  }
  const output = run(node, [main, '--check'], {
    cwd: temporary,
    env: { PATH: '/usr/bin:/bin', HOME: temporary },
  });
  if (!output.includes('check ok')) throw new Error('Release module smoke check failed.');
  run(
    node,
    ['--input-type=module', '--eval', "await import('@kairos/contracts'); await import('zod');"],
    {
      cwd: join(root, 'app/apps/daemon'),
      env: { PATH: '/usr/bin:/bin', HOME: temporary },
    },
  );

  const macosLaunchdAcceptance =
    platform() === 'darwin' &&
    expectedTarget === `macos-${arch()}` &&
    process.env.KAIROS_DAEMON_SMOKE_LAUNCHD === '1'
      ? await macosLaunchdSmoke()
      : 'not-run';
  const linuxSystemdAcceptance =
    process.env.KAIROS_DAEMON_SMOKE_SYSTEMD === '1' ? await linuxSystemdSmoke() : 'not-run';

  process.stdout.write(
    `${JSON.stringify(
      {
        archive,
        externalChecksum: 'passed',
        internalChecksum: 'passed',
        modifiedCopyRejected: true,
        dependencyClosure: 'passed',
        runtime: packagedRuntime ? `packaged-${expectedTarget}` : 'host-module-check-only',
        macosLaunchdAcceptance,
        linuxSystemdAcceptance,
        hostPlatform: `${platform()}-${arch()}`,
        ubuntu22_04X86_64SystemdAcceptance:
          typeof linuxSystemdAcceptance === 'object' &&
          linuxSystemdAcceptance.ubuntuVersion === '22.04'
            ? 'passed'
            : 'unverified',
        ubuntu24_04X86_64SystemdAcceptance:
          typeof linuxSystemdAcceptance === 'object' &&
          linuxSystemdAcceptance.ubuntuVersion === '24.04'
            ? 'passed'
            : 'unverified',
        releaseSignatureVerification: 'unverified_no_public_key',
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  try {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (cleanupError) {
    console.error('Smoke temporary cleanup failed after the original error.', cleanupError);
  }
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
