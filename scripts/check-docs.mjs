import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const docs = (await readdir(join(root, 'docs'))).filter((name) => name.endsWith('.md'));
const pages = ['README.md', 'AGENTS.md', ...docs.map((name) => `docs/${name}`)];
const errors = [];
let links = 0;
let jsonExamples = 0;

for (const page of pages) {
  const path = join(root, page);
  const content = await readFile(path, 'utf8');
  if ((content.match(/^```/gm) ?? []).length % 2) errors.push(`${page}: unclosed code fence`);
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(?:[a-z]+:|#)/i.test(target)) continue;
    links += 1;
    const file = resolve(dirname(path), target.split('#')[0]);
    try {
      await access(file);
    } catch {
      errors.push(`${page}: missing link ${relative(root, file)}`);
    }
  }
  for (const match of content.matchAll(/^```json\s*\n(.*?)^```/gms)) {
    jsonExamples += 1;
    try {
      JSON.parse(match[1]);
    } catch (error) {
      errors.push(`${page}: invalid JSON example: ${error.message}`);
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.info(
    `Documentation OK: ${docs.length} documents, ${links} links, ${jsonExamples} JSON examples.`,
  );
}
