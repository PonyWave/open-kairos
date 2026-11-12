import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const docs = (await readdir(join(root, 'docs'))).filter((name) => name.endsWith('.md'));
const pages = [
  'README.md',
  'AGENTS.md',
  'CHANGELOG.md',
  'reference/README.md',
  ...docs.map((name) => `docs/${name}`),
];
const metadata = JSON.parse(await readFile(join(root, 'reference/upstream-metadata.json'), 'utf8'));
const optionalReferences = metadata.repositories.map((repository) =>
  resolve(root, repository.path),
);
const errors = [];
let links = 0;
let jsonExamples = 0;
let optionalLinks = 0;

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
      if (optionalReferences.some((directory) => file.startsWith(`${directory}/`))) {
        optionalLinks += 1;
      } else {
        errors.push(`${page}: missing link ${relative(root, file)}`);
      }
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

for (const [file, prefix, count] of [
  ['docs/goals-and-scope.md', 'REQ', 12],
  ['docs/testing-and-acceptance.md', 'AT', 20],
]) {
  const content = await readFile(join(root, file), 'utf8');
  const actual = [...content.matchAll(new RegExp(`^\\| (${prefix}-\\d+) \\|`, 'gm'))].map(
    (match) => match[1],
  );
  const expected = Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index + 1).padStart(2, '0')}`,
  );
  if (actual.join(',') !== expected.join(','))
    errors.push(`${file}: missing or duplicate ${prefix} definitions`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.info(
    `Documentation OK: ${docs.length} documents, ${links} links, ${jsonExamples} JSON examples (${optionalLinks} optional reference links absent).`,
  );
}
