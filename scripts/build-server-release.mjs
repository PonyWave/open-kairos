#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeVersion = readFileSync(join(repository, '.node-version'), 'utf8').trim();
const pnpmVersion = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'))
  .packageManager.split('@')
  .at(-1);

function fail(message) {
  throw new Error(message);
}

function argumentsFor(argv) {
  const result = { output: join(repository, 'dist', 'server-releases'), allowDirty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output' && index + 1 < argv.length) {
      result.output = resolve(argv[++index]);
    } else if (argument === '--allow-dirty') {
      result.allowDirty = true;
    } else {
      fail('Usage: node scripts/build-server-release.mjs [--output DIRECTORY] [--allow-dirty]');
    }
  }
  return result;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, CI: 'true' },
    ...options,
  }).trim();
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

function writeChecksums(staging) {
  const lines = regularFiles(staging)
    .filter((path) => path !== 'SHA256SUMS')
    .sort()
    .map((path) => `${sha256(join(staging, path))}  ${path}`);
  writeFileSync(join(staging, 'SHA256SUMS'), `${lines.join('\n')}\n`, { mode: 0o644 });
}

function copySourceTree(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter(path) {
      const name = path.split(sep).at(-1) ?? '';
      return name !== 'node_modules' && name !== 'dist' && !/^\.env(?:\.|$)/.test(name);
    },
  });
}

function prepareSource(temporary) {
  const source = join(temporary, 'source');
  mkdirSync(source);
  for (const file of [
    '.node-version',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'biome.json',
  ]) {
    cpSync(join(repository, file), join(source, file));
  }
  for (const directory of ['apps', 'packages']) {
    copySourceTree(join(repository, directory), join(source, directory));
  }
  run('pnpm', ['install', '--frozen-lockfile', '--store-dir', join(repository, '.pnpm-store')], {
    cwd: source,
    env: { ...process.env, CI: 'true' },
  });
  return source;
}

function cleanPackageJson(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  delete value.devDependencies;
  return value;
}

function installApplication(source, deployed, staging) {
  const application = join(staging, 'app');
  mkdirSync(application, { recursive: true });
  cpSync(join(deployed, 'node_modules'), join(application, 'node_modules'), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  for (const metadata of ['.modules.yaml', '.package-map.json']) {
    rmSync(join(application, 'node_modules', metadata), { force: true });
  }
  rmSync(join(application, 'node_modules', '@kairos'), { recursive: true, force: true });
  mkdirSync(join(application, 'node_modules', '@kairos'), { recursive: true });

  for (const [name, sourcePath] of [
    ['server', 'apps/server'],
    ['contracts', 'packages/contracts'],
    ['agent-core', 'packages/agent-core'],
  ]) {
    const deployedPackage =
      name === 'server' ? deployed : join(deployed, 'node_modules', '@kairos', name);
    const target = join(application, sourcePath);
    mkdirSync(target, { recursive: true });
    if (!existsSync(join(deployedPackage, 'dist'))) {
      fail(`Compiled workspace output is missing: ${name}`);
    }
    cpSync(join(deployedPackage, 'dist'), join(target, 'dist'), {
      recursive: true,
      dereference: true,
    });
    const packageJson = `${JSON.stringify(cleanPackageJson(join(source, sourcePath, 'package.json')), null, 2)}\n`;
    writeFileSync(join(target, 'package.json'), packageJson);
    for (const entry of readdirSync(join(application, 'node_modules', '.pnpm'))) {
      if (!entry.startsWith(`@kairos+${name}@`)) continue;
      const packageRoot = join(
        application,
        'node_modules/.pnpm',
        entry,
        'node_modules/@kairos',
        name,
      );
      rmSync(packageRoot, { recursive: true, force: true });
      mkdirSync(packageRoot, { recursive: true });
      cpSync(join(target, 'dist'), join(packageRoot, 'dist'), {
        recursive: true,
        dereference: true,
      });
      writeFileSync(join(packageRoot, 'package.json'), packageJson);
    }
  }
  const pnpmEntries = readdirSync(join(application, 'node_modules', '.pnpm'));
  for (const name of ['contracts', 'agent-core']) {
    const entry = pnpmEntries.find((candidate) => candidate.startsWith(`@kairos+${name}@`));
    if (!entry) fail(`Deployed workspace package is missing: ${name}`);
    symlinkSync(
      `../.pnpm/${entry}/node_modules/@kairos/${name}`,
      join(application, 'node_modules', '@kairos', name),
    );
  }
  const pnpmWorkspaceLinks = join(application, 'node_modules/.pnpm/node_modules/@kairos');
  for (const [name, target] of [
    ['server', '../../../../apps/server'],
    ['contracts', '../../../../packages/contracts'],
    ['agent-core', '../../../../packages/agent-core'],
  ]) {
    const link = join(pnpmWorkspaceLinks, name);
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link);
  }

  const serverPackage = cleanPackageJson(join(source, 'apps/server/package.json'));
  serverPackage.scripts = { start: 'node dist/main.js', migrate: 'node dist/migrate.js' };
  writeFileSync(
    join(application, 'apps/server/package.json'),
    `${JSON.stringify(serverPackage, null, 2)}\n`,
  );
}

function installResources(source, staging) {
  mkdirSync(join(staging, 'workspace'), { recursive: true });
  cpSync(join(repository, 'AGENTS.md'), join(staging, 'workspace', 'AGENTS.md'));
  if (existsSync(join(repository, '.agents'))) {
    cpSync(join(repository, '.agents'), join(staging, 'workspace', '.agents'), {
      recursive: true,
      dereference: false,
      filter(path) {
        const name = path.split(sep).at(-1) ?? '';
        return !/^\.env(?:\.|$)/.test(name);
      },
    });
  }
  cpSync(join(source, 'apps/gui/dist'), join(staging, 'gui'), {
    recursive: true,
    dereference: true,
  });
  mkdirSync(join(staging, 'caddy'), { recursive: true });
  cpSync(join(repository, 'deploy/caddy/Caddyfile'), join(staging, 'caddy', 'Caddyfile'));
  cpSync(join(repository, 'deploy/k1'), join(staging, 'operations'), {
    recursive: true,
    dereference: true,
  });
  cpSync(join(repository, 'deploy/cvm'), join(staging, 'cvm'), {
    recursive: true,
    dereference: true,
  });
}

function verifyClosure(staging) {
  const root = realpathSync(staging);
  const application = join(staging, 'app');
  for (const required of [
    'apps/server/dist/main.js',
    'packages/contracts/dist/index.js',
    'packages/agent-core/dist/index.js',
    'node_modules/fastify/package.json',
    'node_modules/@connectrpc/connect-fastify/package.json',
    'node_modules/nodemailer/package.json',
    'node_modules/ws/package.json',
    'node_modules/zod/package.json',
  ]) {
    if (!existsSync(join(application, required)))
      fail(`Release runtime file is missing: ${required}`);
  }
  for (const forbidden of ['typescript', 'vitest', 'tsx', '@types']) {
    if (existsSync(join(application, 'node_modules', ...forbidden.split('/')))) {
      fail(`Development dependency was included in the release: ${forbidden}`);
    }
  }
  for (const entry of readdirSync(join(application, 'node_modules', '.pnpm'))) {
    if (/^(?:typescript|vitest|tsx|vite)@/.test(entry) || entry.startsWith('@types+')) {
      fail(`Development dependency was included in the release closure: ${entry}`);
    }
  }
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(path);
        if (target !== root && !target.startsWith(`${root}${sep}`)) {
          fail(
            `Release symlink escapes its root: ${relative(staging, path)} -> ${target} (root ${root})`,
          );
        }
      } else if (entry.isDirectory()) {
        walk(path);
      }
    }
  }
  walk(staging);
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (process.version !== `v${nodeVersion}`) fail(`Build requires Node.js ${nodeVersion}.`);
  const actualPnpmVersion = run('pnpm', ['--version']);
  if (actualPnpmVersion !== pnpmVersion) fail(`Build requires pnpm ${pnpmVersion}.`);
  const commit = run('git', ['rev-parse', 'HEAD']);
  const dirty = run('git', ['status', '--porcelain']).length > 0;
  if (dirty && !options.allowDirty) {
    fail('A clean Git worktree is required; use --allow-dirty only for a local candidate.');
  }
  const target = join(options.output, commit);
  if (existsSync(target)) fail(`Refusing to overwrite immutable release directory: ${target}`);
  mkdirSync(options.output, { recursive: true });
  const staging = join(options.output, `.${commit}.building-${process.pid}`);
  if (existsSync(staging)) fail(`Temporary release path already exists: ${staging}`);
  const temporary = mkdtempSync(join(tmpdir(), 'kairos-server-release-'));
  try {
    const source = prepareSource(temporary);
    run(
      'pnpm',
      [
        '--filter',
        '@kairos/contracts',
        '--filter',
        '@kairos/agent-core',
        '--filter',
        '@kairos/server',
        'build',
      ],
      { cwd: source },
    );
    run('pnpm', ['--filter', '@kairos/gui', 'build'], { cwd: source });
    const deployed = join(temporary, 'deployed');
    run(
      'pnpm',
      [
        '--store-dir',
        join(repository, '.pnpm-store'),
        '--filter',
        '@kairos/server',
        'deploy',
        '--prod',
        '--legacy',
        deployed,
      ],
      { cwd: source },
    );
    const deployedPackage = JSON.parse(readFileSync(join(deployed, 'package.json'), 'utf8'));
    if (deployedPackage.name !== '@kairos/server') fail('pnpm deploy produced the wrong package.');
    mkdirSync(staging);
    installApplication(source, deployed, staging);
    installResources(source, staging);
    const lockfileSha256 = sha256(join(repository, 'pnpm-lock.yaml'));
    const release = {
      version: commit,
      sourceCommit: commit,
      sourceDirty: dirty,
      nodeVersion,
      pnpmVersion,
      lockfileSha256,
      checksumManifest: 'SHA256SUMS',
    };
    writeFileSync(join(staging, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
    writeFileSync(
      join(staging, 'BUILDINFO'),
      [
        `version=${commit}`,
        `source_commit=${commit}`,
        `source_dirty=${dirty}`,
        `node_version=${nodeVersion}`,
        `pnpm_version=${pnpmVersion}`,
        `lockfile_sha256=${lockfileSha256}`,
        '',
      ].join('\n'),
    );
    verifyClosure(staging);
    writeChecksums(staging);
    renameSync(staging, target);
    process.stdout.write(`${JSON.stringify({ release: target, ...release }, null, 2)}\n`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
}

await main();
