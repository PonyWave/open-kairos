import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const forbiddenPackage =
  /^(?:@earendil-works\/|@mariozechner\/|@openai\/codex|@moonshot-ai\/(?:kimi|acp-server|agent-core-v2|kap-server|klient|migration-legacy|minidb|pi-tui|remote-control|session-import|transcript|tree-sitter-bash)|@moonshot\/kimi|codex(?:-|$)|kimi-code(?:-|$))/;
const referencePath = /(?:^|[/\\])reference(?:[/\\]|$)/;

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage', '.git'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

const manifests = [join(root, 'package.json')];
for (const directory of ['apps', 'packages']) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (entry.isDirectory()) manifests.push(join(root, directory, entry.name, 'package.json'));
  }
}

for (const path of manifests) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (
        forbiddenPackage.test(name) ||
        forbiddenPackage.test(String(version).replace(/^npm:/, '')) ||
        referencePath.test(String(version))
      ) {
        errors.push(`${relative(root, path)}: forbidden dependency ${name}`);
      }
    }
  }
  if (path === join(root, 'package.json')) continue;
  for (const file of await sourceFiles(dirname(path))) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g,
    )) {
      if (referencePath.test(match[1]) || forbiddenPackage.test(match[1])) {
        errors.push(`${relative(root, file)}: forbidden import ${match[1]}`);
      }
    }
  }
}

const workspace = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
const packageBlock = workspace.match(/^packages:\s*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1] ?? '';
const members = [...packageBlock.matchAll(/^\s+-\s+['"]?([^'"\n]+)['"]?\s*$/gm)].map((match) =>
  match[1].trim(),
);
if (members.join(',') !== 'apps/*,packages/*') {
  errors.push('Workspace members must be limited to apps/* and packages/*.');
}
try {
  const lockfile = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
  for (const match of lockfile.matchAll(/^ {2}['"]?([^:\n]+):/gm)) {
    if (forbiddenPackage.test(match[1])) {
      errors.push(`Lockfile contains a reference runtime dependency: ${match[1]}`);
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.info(
    `Dependency boundaries OK: ${manifests.length - 1} workspace packages; reference checkouts excluded.`,
  );
}
