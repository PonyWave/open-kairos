import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unexpectedBreakingChanges } from './proto-breaking.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const protoDirectory = join(root, 'packages/contracts/proto');
const generatedDirectory = join(root, 'packages/contracts/src/gen');

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

function capture(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else files.push(path);
  }
  return files.sort();
}

async function compareGeneratedFiles(regeneratedDirectory) {
  const expectedFiles = await filesUnder(generatedDirectory);
  const actualFiles = await filesUnder(regeneratedDirectory);
  const expectedNames = expectedFiles.map((path) => relative(generatedDirectory, path));
  const actualNames = actualFiles.map((path) => relative(regeneratedDirectory, path));
  const errors = [];

  for (const name of new Set([...expectedNames, ...actualNames])) {
    if (!expectedNames.includes(name)) {
      errors.push(`unexpected generated file: ${name}`);
      continue;
    }
    if (!actualNames.includes(name)) {
      errors.push(`missing generated file: ${name}`);
      continue;
    }
    const [expected, actual] = await Promise.all([
      readFile(join(generatedDirectory, name)),
      readFile(join(regeneratedDirectory, name)),
    ]);
    if (!expected.equals(actual)) errors.push(`outdated generated file: ${name}`);
  }

  if (errors.length > 0) {
    throw new Error(`Generated Protobuf code is inconsistent:\n${errors.join('\n')}`);
  }
  console.info(`Protobuf generation consistency OK: ${expectedNames.length} files.`);
}

function resolveBaselineRef() {
  if (process.env.KAIROS_PROTO_BASE_REF) return process.env.KAIROS_PROTO_BASE_REF;
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  if (process.env.GITHUB_EVENT_NAME === 'push') return 'HEAD~1';
  for (const ref of ['origin/main', 'main']) {
    try {
      capture('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return ref;
    } catch {}
  }
  return undefined;
}

async function checkBreakingChanges(tempDirectory) {
  const ref = resolveBaselineRef();
  if (!ref) {
    console.info('Buf breaking: no baseline ref; initial compatibility baseline is unavailable.');
    return;
  }

  let files;
  try {
    const listing = capture('git', [
      'ls-tree',
      '-r',
      '--name-only',
      ref,
      '--',
      'packages/contracts/proto',
    ]);
    files = listing ? listing.split('\n').filter((name) => name.endsWith('.proto')) : [];
  } catch (error) {
    if (process.env.KAIROS_PROTO_BASE_REF || process.env.GITHUB_BASE_REF) throw error;
    console.info(`Buf breaking: baseline ref ${ref} is unavailable; no comparison was performed.`);
    return;
  }

  if (files.length === 0) {
    console.info(
      `Buf breaking: no .proto baseline at ${ref}; this change establishes the initial baseline.`,
    );
    return;
  }

  const baselineRoot = join(tempDirectory, 'baseline');
  for (const file of files) {
    const destination = join(baselineRoot, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, execFileSync('git', ['show', `${ref}:${file}`], { cwd: root }));
  }
  const args = [
    'exec',
    'buf',
    'breaking',
    protoDirectory,
    '--against',
    join(baselineRoot, 'packages/contracts/proto'),
    '--error-format=json',
  ];
  try {
    execFileSync(pnpm, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // A non-diagnostic CLI failure must never be treated as an approved removal.
    if (error.status !== 100 || typeof error.stdout !== 'string' || !error.stdout.trim())
      throw error;
    const diagnostics = error.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const approval = JSON.parse(
      await readFile(join(root, 'packages/contracts/protocol-removals.json'), 'utf8'),
    );
    const baselineCommit = capture('git', ['rev-parse', `${ref}^{commit}`]);
    const unexpected = unexpectedBreakingChanges(
      diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: relative(root, diagnostic.path),
      })),
      baselineCommit,
      approval,
    );
    if (unexpected.length > 0) {
      throw new Error(
        `Unapproved Protobuf breaking changes:\n${unexpected.map((item) => JSON.stringify(item)).join('\n')}`,
      );
    }
    console.info(
      `Buf breaking: ${diagnostics.length} explicitly approved removals against ${baselineCommit}; no other breaking changes.`,
    );
  }
  console.info(`Buf breaking: compared against ${ref}.`);
}

run(pnpm, ['exec', 'buf', 'format', '--diff', '--exit-code', protoDirectory]);
run(pnpm, ['exec', 'buf', 'lint', protoDirectory]);

const tempDirectory = await mkdtemp(join(root, '.proto-check-'));
try {
  run(pnpm, ['exec', 'buf', 'generate', '--template', 'buf.gen.yaml', '--output', tempDirectory]);
  const regeneratedDirectory = join(tempDirectory, 'packages/contracts/src/gen');
  run(pnpm, ['exec', 'biome', 'check', '--write', regeneratedDirectory]);
  await compareGeneratedFiles(regeneratedDirectory);
  await checkBreakingChanges(tempDirectory);
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
