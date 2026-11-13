#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_VERSION = readFileSync(join(repository, '.node-version'), 'utf8').trim();
const PNPM_VERSION = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'))
  .packageManager.split('@')
  .at(-1);
let TARGET = 'ubuntu22.04-24.04-x86_64';
let NODE_PLATFORM = 'linux';
let NODE_ARCH = 'x64';
let NODE_ARCHIVE = `node-v${NODE_VERSION}-${NODE_PLATFORM}-${NODE_ARCH}.tar.gz`;
const NODE_DIST_URL = `https://nodejs.org/dist/v${NODE_VERSION}`;

function fail(message) {
  throw new Error(message);
}

function argumentsFor(argv) {
  const result = {
    output: join(repository, 'dist', 'releases'),
    platform: 'linux',
    architecture: 'x64',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--platform' && index + 1 < argv.length) {
      result.platform = argv[++index];
    } else if (argument === '--arch' && index + 1 < argv.length) {
      result.architecture = argv[++index];
    } else if (argument === '--version' && index + 1 < argv.length) {
      result.version = argv[++index];
    } else if (argument === '--output' && index + 1 < argv.length) {
      result.output = resolve(argv[++index]);
    } else if (argument === '--node-archive' && index + 1 < argv.length) {
      result.nodeArchive = resolve(argv[++index]);
    } else if (argument === '--node-sums' && index + 1 < argv.length) {
      result.nodeSums = resolve(argv[++index]);
    } else {
      fail(
        'Usage: node scripts/build-daemon-release.mjs --version VERSION [--platform linux|darwin] [--arch x64|arm64] [--output DIRECTORY] [--node-archive ARCHIVE --node-sums SHASUMS256.txt]',
      );
    }
  }
  if ((result.nodeArchive === undefined) !== (result.nodeSums === undefined)) {
    fail('Cached Node.js archive and official checksum file must be supplied together.');
  }
  if (!result.version || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,99}$/.test(result.version)) {
    fail('An explicit immutable release version is required.');
  }
  if (result.version === '0.0.0') fail('0.0.0 is not a release version.');
  if (
    !['linux', 'darwin'].includes(result.platform) ||
    !['x64', 'arm64'].includes(result.architecture) ||
    (result.platform === 'linux' && result.architecture !== 'x64')
  )
    fail('Supported targets: linux/x64, darwin/x64, darwin/arm64.');
  return result;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  }).trim();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function download(url, destination) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(300_000),
    headers: { 'user-agent': 'kairos-daemon-release-builder' },
  });
  if (!response.ok || response.body === null) {
    fail(`Node.js download failed with HTTP ${response.status}: ${url}`);
  }
  const file = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  await pipeline(Readable.fromWeb(response.body), file);
}

const RG_VERSION = '15.0.0';
const RG_ARCHIVE_SHA256 = {
  'ripgrep-15.0.0-x86_64-unknown-linux-musl.tar.gz':
    '253ad0fd5fef0d64cba56c70dccdacc1916d4ed70ad057cc525fcdb0c3bbd2a7',
  'ripgrep-15.0.0-x86_64-apple-darwin.tar.gz':
    '44128c733d127ddbda461e01225a68b5f9997cfe7635242a797f645ca674a71a',
  'ripgrep-15.0.0-aarch64-apple-darwin.tar.gz':
    '98bb2e61e7277ba0ea72d2ae2592497fd8d2940934a16b122448d302a6637e3b',
};

function ripgrepArchiveName() {
  const target =
    NODE_PLATFORM === 'linux'
      ? 'x86_64-unknown-linux-musl'
      : NODE_ARCH === 'arm64'
        ? 'aarch64-apple-darwin'
        : 'x86_64-apple-darwin';
  return `ripgrep-${RG_VERSION}-${target}.tar.gz`;
}

async function installRipgrep(staging, temporary) {
  const archiveName = ripgrepArchiveName();
  const archive = join(temporary, archiveName);
  await download(
    `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${archiveName}`,
    archive,
  );
  const expected = RG_ARCHIVE_SHA256[archiveName];
  if (expected === undefined || sha256(archive) !== expected) {
    fail('ripgrep archive checksum verification failed.');
  }
  const extracted = join(temporary, 'ripgrep-extracted');
  mkdirSync(extracted);
  run('tar', ['-xzf', archive, '-C', extracted]);
  const root = join(extracted, archiveName.replace(/\.tar\.gz$/, ''));
  mkdirSync(join(staging, 'bin'), { recursive: true });
  cpSync(join(root, 'rg'), join(staging, 'bin', 'rg'));
  chmodSync(join(staging, 'bin', 'rg'), 0o755);
  const license = join(root, 'LICENSE-MIT');
  if (existsSync(license)) {
    mkdirSync(join(staging, 'NOTICE'), { recursive: true });
    cpSync(license, join(staging, 'NOTICE', 'ripgrep-LICENSE-MIT'));
  }
  const executable = readFileSync(join(staging, 'bin', 'rg'));
  const valid =
    executable.length >= 20 &&
    (NODE_PLATFORM === 'linux'
      ? executable.subarray(0, 4).toString('hex') === '7f454c46' &&
        executable.readUInt16LE(18) === 62
      : executable.subarray(0, 4).toString('hex') === 'cffaedfe' &&
        executable.readUInt32LE(4) === (NODE_ARCH === 'arm64' ? 0x0100000c : 0x01000007));
  if (!valid)
    fail('Packaged ripgrep executable does not match the target platform and architecture.');
}

async function installNodeRuntime(staging, temporary, cached = {}) {
  const archive = cached.archive ?? join(temporary, NODE_ARCHIVE);
  const sums = cached.sums ?? join(temporary, 'NODE-SHA256SUMS256.txt');
  if (cached.archive === undefined) {
    await download(`${NODE_DIST_URL}/${NODE_ARCHIVE}`, archive);
    await download(`${NODE_DIST_URL}/SHASUMS256.txt`, sums);
  }
  const sumLine = readFileSync(sums, 'utf8')
    .split('\n')
    .find((line) => line.endsWith(`  ${NODE_ARCHIVE}`));
  if (!sumLine) fail('Official Node.js checksums do not contain the required target archive.');
  const expected = sumLine.split(/\s+/)[0];
  const actual = sha256(archive);
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
    fail('Node.js archive checksum verification failed.');
  }
  const extracted = join(temporary, 'node-extracted');
  mkdirSync(extracted);
  run('tar', ['-xzf', archive, '-C', extracted]);
  const nodeRoot = join(extracted, `node-v${NODE_VERSION}-${NODE_PLATFORM}-${NODE_ARCH}`);
  mkdirSync(join(staging, 'node', 'bin'), { recursive: true });
  cpSync(join(nodeRoot, 'bin', 'node'), join(staging, 'node', 'bin', 'node'));
  cpSync(join(nodeRoot, 'LICENSE'), join(staging, 'node', 'LICENSE'));
  const executable = join(staging, 'node', 'bin', 'node');
  const binary = readFileSync(executable);
  const valid =
    binary.length >= 20 &&
    (NODE_PLATFORM === 'linux'
      ? binary.subarray(0, 4).toString('hex') === '7f454c46' && binary.readUInt16LE(18) === 62
      : binary.subarray(0, 4).toString('hex') === 'cffaedfe' &&
        binary.readUInt32LE(4) === (NODE_ARCH === 'arm64' ? 0x0100000c : 0x01000007));
  if (!valid)
    fail('Packaged Node.js executable does not match the target platform and architecture.');
  return actual;
}

function cleanPackageJson(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  delete value.devDependencies;
  return value;
}

function copyProductionDependency(deployed, staging, name, visited = new Set()) {
  if (visited.has(name)) return;
  visited.add(name);
  const pnpmDirectory = join(deployed, 'node_modules', '.pnpm');
  const prefix = `${name.replaceAll('/', '+')}@`;
  const source = readdirSync(pnpmDirectory)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(pnpmDirectory, entry, 'node_modules', ...name.split('/')))
    .find((path) => existsSync(join(path, 'package.json')));
  if (source === undefined) fail(`Deployed production dependency is missing: ${name}`);
  const destination = join(staging, 'app', 'node_modules', ...name.split('/'));
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true, dereference: true });
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    copyProductionDependency(deployed, staging, dependency, visited);
  }
}

function installApplication(staging, temporary) {
  run('pnpm', ['--filter', '@kairos/contracts', 'build']);
  run('pnpm', ['--filter', '@kairos/daemon', 'build']);
  const deployed = join(temporary, 'deployed');
  run('pnpm', ['--filter', '@kairos/daemon', 'deploy', '--prod', '--legacy', deployed]);
  const deployedPackage = JSON.parse(readFileSync(join(deployed, 'package.json'), 'utf8'));
  if (deployedPackage.name !== '@kairos/daemon') fail('pnpm deploy produced the wrong package.');
  const deployedContracts = join(deployed, 'node_modules', '@kairos', 'contracts');
  if (
    !existsSync(join(deployed, 'dist', 'main.js')) ||
    !existsSync(join(deployedContracts, 'dist', 'device.js'))
  ) {
    fail('pnpm deploy does not contain the Daemon/contracts runtime closure.');
  }

  const daemonTarget = join(staging, 'app', 'apps', 'daemon');
  const contractsTarget = join(staging, 'app', 'packages', 'contracts');
  mkdirSync(daemonTarget, { recursive: true });
  mkdirSync(contractsTarget, { recursive: true });
  cpSync(join(deployed, 'dist'), join(daemonTarget, 'dist'), {
    recursive: true,
    dereference: true,
  });
  cpSync(join(deployedContracts, 'dist'), join(contractsTarget, 'dist'), {
    recursive: true,
    dereference: true,
  });
  cpSync(join(deployed, 'node_modules'), join(staging, 'app', 'node_modules'), {
    recursive: true,
    dereference: true,
  });
  for (const dependency of ['ws', '@bufbuild/protobuf', 'zod']) {
    copyProductionDependency(deployed, staging, dependency);
  }
  for (const deploymentMetadata of ['.pnpm', '.modules.yaml', '.package-map.json']) {
    rmSync(join(staging, 'app', 'node_modules', deploymentMetadata), {
      recursive: true,
      force: true,
    });
  }
  rmSync(join(staging, 'app', 'node_modules', '@kairos', 'contracts'), {
    recursive: true,
    force: true,
  });
  symlinkSync(
    '../../packages/contracts',
    join(staging, 'app', 'node_modules', '@kairos', 'contracts'),
  );

  const daemonPackage = cleanPackageJson(join(repository, 'apps', 'daemon', 'package.json'));
  daemonPackage.scripts = { start: 'node dist/main.js' };
  writeFileSync(join(daemonTarget, 'package.json'), `${JSON.stringify(daemonPackage, null, 2)}\n`);
  const contractsPackage = cleanPackageJson(
    join(repository, 'packages', 'contracts', 'package.json'),
  );
  writeFileSync(
    join(contractsTarget, 'package.json'),
    `${JSON.stringify(contractsPackage, null, 2)}\n`,
  );

  for (const required of ['ws', '@bufbuild/protobuf', 'zod']) {
    if (!existsSync(join(staging, 'app', 'node_modules', ...required.split('/'), 'package.json'))) {
      fail(`Production dependency is missing from the release: ${required}`);
    }
  }
  for (const forbidden of ['typescript', 'vitest', 'tsx', '@types']) {
    if (existsSync(join(staging, 'app', 'node_modules', ...forbidden.split('/')))) {
      fail(`Development dependency was included in the release: ${forbidden}`);
    }
  }
}

function installPackaging(staging, version, commit, dirty, lockHash, nodeHash) {
  cpSync(join(repository, 'apps', 'daemon', 'packaging'), staging, {
    recursive: true,
    dereference: true,
  });
  for (const executable of [
    'bin/kairos-daemon',
    'install.sh',
    'upgrade.sh',
    'uninstall.sh',
    'lib/platform.sh',
    'macos/install.sh',
    'macos/upgrade.sh',
    'macos/uninstall.sh',
    'macos/common.sh',
  ]) {
    const path = join(staging, executable);
    const mode = statSync(path).mode;
    chmodSync(path, mode | 0o111);
  }
  writeFileSync(join(staging, 'VERSION'), `${version}\n`, { mode: 0o644 });
  const buildInfo = [
    `version=${version}`,
    `source_commit=${commit}`,
    `source_dirty=${dirty}`,
    'protocol_major=1',
    `lockfile_sha256=${lockHash}`,
    `node_version=${NODE_VERSION}`,
    `node_archive_sha256=${nodeHash}`,
    `target=${TARGET}`,
    'release_signature_verification=unverified_no_public_key',
    'release_download_url=unconfigured',
    'ubuntu22.04_systemd_acceptance=unverified',
    'ubuntu24.04_systemd_acceptance=unverified',
    '',
  ];
  writeFileSync(join(staging, 'BUILDINFO'), buildInfo.join('\n'), { mode: 0o644 });
  const notices = join(staging, 'NOTICE');
  mkdirSync(notices, { recursive: true });
  const nodeLicense = join(staging, 'node', 'LICENSE');
  if (existsSync(nodeLicense)) cpSync(nodeLicense, join(notices, 'Node.js-LICENSE'));
  for (const dependency of ['ws', '@bufbuild/protobuf', 'zod']) {
    const packageRoot = join(staging, 'app', 'node_modules', ...dependency.split('/'));
    const license = readdirSync(packageRoot).find((entry) => /^licen[cs]e/i.test(entry));
    if (license) {
      cpSync(
        join(packageRoot, license),
        join(notices, `${dependency.replaceAll('/', '-')}-${license}`),
      );
    }
  }
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

function writeChecksums(staging) {
  const lines = regularFiles(staging)
    .filter((path) => path !== 'SHA256SUMS')
    .sort()
    .map((path) => `${sha256(join(staging, path))}  ${path}`);
  writeFileSync(join(staging, 'SHA256SUMS'), `${lines.join('\n')}\n`, { mode: 0o644 });
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  NODE_PLATFORM = options.platform;
  NODE_ARCH = options.architecture;
  TARGET = NODE_PLATFORM === 'linux' ? 'ubuntu22.04-24.04-x86_64' : `macos-${NODE_ARCH}`;
  NODE_ARCHIVE = `node-v${NODE_VERSION}-${NODE_PLATFORM}-${NODE_ARCH}.tar.gz`;
  if (process.version !== `v${NODE_VERSION}`) fail(`Build requires Node.js ${NODE_VERSION}.`);
  const pnpmVersion = run('pnpm', ['--version']);
  if (pnpmVersion !== PNPM_VERSION) fail(`Build requires pnpm ${PNPM_VERSION}.`);
  const commit = run('git', ['rev-parse', 'HEAD']);
  const dirty = run('git', ['status', '--porcelain']).length > 0;
  const lockHash = sha256(join(repository, 'pnpm-lock.yaml'));
  const output = options.output;
  const archiveName = `kairos-daemon-${options.version}-${TARGET}.tar.gz`;
  const archive = join(output, archiveName);
  if (existsSync(archive)) fail(`Refusing to overwrite immutable release artifact: ${archive}`);
  mkdirSync(output, { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), 'kairos-daemon-release-'));
  try {
    const staging = join(temporary, 'staging');
    mkdirSync(staging);
    installApplication(staging, temporary);
    await installRipgrep(staging, temporary);
    const nodeHash = await installNodeRuntime(staging, temporary, {
      ...(options.nodeArchive === undefined ? {} : { archive: options.nodeArchive }),
      ...(options.nodeSums === undefined ? {} : { sums: options.nodeSums }),
    });
    installPackaging(staging, options.version, commit, dirty, lockHash, nodeHash);
    if (process.platform === 'darwin') run('xattr', ['-rc', staging]);
    writeChecksums(staging);
    run('tar', ['--no-xattrs', '-czf', archive, '-C', staging, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const archiveHash = sha256(archive);
    writeFileSync(join(output, `${archiveName}.sha256`), `${archiveHash}  ${archiveName}\n`);
    const releaseManifest = join(output, `release-${NODE_PLATFORM}-${NODE_ARCH}.json`);
    const stagedManifest = `${releaseManifest}.new-${process.pid}`;
    writeFileSync(
      stagedManifest,
      `${JSON.stringify({ version: options.version, platform: NODE_PLATFORM, architecture: NODE_ARCH, file: archiveName, sha256: archiveHash }, null, 2)}\n`,
    );
    renameSync(stagedManifest, releaseManifest);
    process.stdout.write(
      `${JSON.stringify(
        {
          archive,
          sha256: archiveHash,
          target: TARGET,
          node: NODE_VERSION,
          signatureVerification: 'unverified_no_public_key',
          ubuntuSystemdAcceptance: 'unverified',
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    run('pnpm', ['install', '--frozen-lockfile'], {
      env: { ...process.env, CI: 'true' },
    });
  }
}

await main();
