#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const input = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(input)) {
  throw new Error('Usage: node deploy/server-release-smoke.mjs RELEASE_DIRECTORY');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function regularFiles(root, directory = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...regularFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
  }
  return files;
}

function verifyChecksums(root) {
  const lines = readFileSync(join(root, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
  const expected = new Set();
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match || match[2].startsWith('/') || match[2].split('/').includes('..')) {
      throw new Error('Release checksum manifest contains an invalid entry.');
    }
    if (expected.has(match[2])) throw new Error('Release checksum manifest contains a duplicate.');
    expected.add(match[2]);
    if (sha256(join(root, match[2])) !== match[1]) {
      throw new Error(`Release checksum mismatch: ${match[2]}`);
    }
  }
  const unchecked = regularFiles(root).filter(
    (path) => path !== 'SHA256SUMS' && !expected.has(path),
  );
  if (unchecked.length > 0) throw new Error(`Unchecked release files: ${unchecked.join(', ')}`);
}

function verifyLayout(root) {
  const canonicalRoot = realpathSync(root);
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(path);
        if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${sep}`)) {
          throw new Error(`Release symlink escapes its root: ${relative(root, path)}`);
        }
      } else if (entry.isDirectory()) {
        walk(path);
      }
    }
  }
  walk(root);
  for (const path of regularFiles(root)) {
    const lower = path.toLowerCase();
    const base = lower.split('/').pop() ?? '';
    if (
      /^\.env(?:\.|$)/.test(base) ||
      lower.endsWith('.sqlite') ||
      lower.endsWith('.sqlite3') ||
      lower.endsWith('.log') ||
      lower.startsWith('reference/') ||
      lower.startsWith('app/apps/server/src/') ||
      lower.startsWith('app/apps/server/dist/integration/') ||
      lower.startsWith('app/apps/server/dist/attachments/fixtures.') ||
      lower.startsWith('app/packages/contracts/src/') ||
      lower.startsWith('app/packages/agent-core/src/') ||
      /^app\/(apps\/server|packages\/(contracts|agent-core))\/.*\.test\.[cm]?[jt]s$/.test(lower)
    ) {
      throw new Error(`Sensitive or development file was packaged: ${path}`);
    }
  }
  for (const required of [
    'app/apps/server/dist/main.js',
    'app/packages/contracts/dist/index.js',
    'app/packages/agent-core/dist/index.js',
    'gui/index.html',
    'workspace/AGENTS.md',
    'caddy/Caddyfile',
    'release.json',
    'BUILDINFO',
    'SHA256SUMS',
  ]) {
    if (!existsSync(join(root, required))) throw new Error(`Release file is missing: ${required}`);
  }
}

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolveListen, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolveListen);
  });
  const address = listener.address();
  if (address === null || typeof address === 'string') throw new Error('No loopback test port.');
  const { port } = address;
  await new Promise((resolveClose, reject) => {
    listener.close((error) => (error ? reject(error) : resolveClose()));
  });
  return port;
}

async function waitForHealth(port, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Compiled Server exited before health check.\n${output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const health = await response.json();
        if (health.service === 'kairos-server' && health.status === 'ok') return health;
      }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Compiled Server did not become healthy.\n${output()}`);
}

verifyChecksums(input);
verifyLayout(input);
const temporary = mkdtempSync(join(tmpdir(), 'kairos-server-release-smoke-'));
let child;
try {
  const clean = join(temporary, 'clean');
  const release = join(clean, 'release');
  cpSync(input, release, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  verifyChecksums(release);
  verifyLayout(release);
  const data = join(clean, 'data');
  const workspace = join(clean, 'workspace');
  const daemonReleases = join(clean, 'daemon-releases');
  cpSync(join(release, 'workspace'), workspace, { recursive: true, dereference: false });
  const port = await unusedPort();
  let logs = '';
  child = spawn(process.execPath, [join(release, 'app/apps/server/dist/main.js')], {
    cwd: clean,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: clean,
      NODE_ENV: 'production',
      KAIROS_HOST: '127.0.0.1',
      KAIROS_PORT: String(port),
      KAIROS_DATA_DIR: data,
      KAIROS_DAEMON_RELEASE_DIR: daemonReleases,
      KAIROS_AUTH_SECRET: 'release-smoke-secret-with-at-least-32-characters',
      KAIROS_AUTH_INVITED_EMAILS: 'release-smoke@example.invalid',
      KAIROS_PUBLIC_ORIGIN: 'https://release-smoke.invalid',
      KAIROS_SMTP_URL: 'smtp://127.0.0.1:2525',
      KAIROS_SMTP_FROM: 'release-smoke@example.invalid',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    logs = `${logs}${chunk}`.slice(-1_000_000);
  });
  child.stderr.on('data', (chunk) => {
    logs = `${logs}${chunk}`.slice(-1_000_000);
  });
  const health = await waitForHealth(port, child, () => logs);
  const exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit([code, signal]));
  });
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  if (code !== 0 || signal !== null) {
    throw new Error(`Compiled Server shutdown failed: code=${code}, signal=${signal}.\n${logs}`);
  }
  if (!lstatSync(join(data, 'kairos.sqlite')).isFile()) {
    throw new Error('Compiled Server did not create its temporary database.');
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        release: input,
        checksumManifest: 'passed',
        cleanDirectory: 'passed',
        symlinkClosure: 'passed',
        compiledServerHealth: health,
        gracefulShutdown: 'passed',
        externalCredentials: 'not-used',
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  rmSync(temporary, { recursive: true, force: true });
}
