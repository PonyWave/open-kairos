import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const release = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(release)) throw new Error('Release directory is required.');
const canonical = realpathSync(release);
const files = [];
const symlinks = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = realpathSync(path);
      if (target !== canonical && !target.startsWith(`${canonical}${sep}`)) {
        throw new Error(`Release symlink escapes its root: ${relative(release, path)}`);
      }
      symlinks.push(path);
    } else if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) files.push(relative(release, path).split(sep).join('/'));
  }
}
walk(release);
const checked = new Set();
for (const line of readFileSync(join(release, 'SHA256SUMS'), 'utf8').split('\n')) {
  if (!line) continue;
  const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
  if (!match || match[2].startsWith('/') || match[2].split('/').includes('..')) {
    throw new Error('Invalid checksum manifest entry.');
  }
  const path = join(release, match[2]);
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (hash !== match[1]) throw new Error(`Checksum mismatch: ${match[2]}`);
  checked.add(match[2]);
}
for (const path of files) {
  if (path !== 'SHA256SUMS' && !checked.has(path)) throw new Error(`Unchecked file: ${path}`);
}
if (!existsSync(join(release, 'app/apps/server/dist/main.js'))) {
  throw new Error('Compiled Server entry is missing.');
}
process.stdout.write(`${JSON.stringify({ files: files.length, symlinks: symlinks.length })}\n`);
