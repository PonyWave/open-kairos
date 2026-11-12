import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(args) {
  execFileSync(pnpm, args, { cwd: root, stdio: 'inherit' });
}

run(['exec', 'vitest', 'run', 'apps/server/src/integration/phase-one.test.ts']);
run(['exec', 'vitest', 'run', 'apps/server/src/integration/delegation.test.ts']);
run(['exec', 'vitest', 'run', 'apps/server/src/integration/delegation-identity.test.ts']);
run(['exec', 'vitest', 'run', 'apps/server/src/integration/thinking.test.ts']);
run(['exec', 'vitest', 'run', 'apps/server/src/integration/revision.test.ts']);
run(['exec', 'vitest', 'run', 'apps/server/src/integration/attachment.test.ts']);
run(['exec', 'vitest', 'run', 'apps/server/src/integration/response.test.ts']);
run(['exec', 'vitest', 'run', 'apps/server/src/integration/recall.test.ts']);
run(['exec', 'vitest', 'run', 'apps/server/src/integration/recap-periodic.test.ts']);
run([
  'exec',
  'vitest',
  'run',
  'apps/server/src/app-close.test.ts',
  'apps/server/src/integration/compact.test.ts',
  'apps/server/src/integration/workspace-resources.test.ts',
]);
run(['exec', 'vitest', 'run', 'apps/server/src/integration/real-model-recap-lifecycle.test.ts']);
run([
  'exec',
  'vitest',
  'run',
  'apps/gui/src/thinking-block.test.ts',
  'apps/gui/src/thinking-projection.test.ts',
  'apps/gui/src/thread-pagination.test.ts',
  'apps/gui/src/response-projection.test.ts',
]);
run(['build:packages']);
run(['--filter', '@kairos/server', 'build']);
run(['exec', 'node', 'apps/server/src/recall/watch-ipc.integration.mjs']);
run(['check:proto']);
console.info(
  'Phase-one, delegation identity, GUI projection, Thinking, current Context, response, SQL recall, periodic Recap, slash commands, runtime spec reload, sequential node --watch recall and Protobuf checks passed.',
);
