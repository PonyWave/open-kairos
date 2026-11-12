import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fixture, resource } from './reset-runtime-fixture.mjs';

async function mockMainExecution(t) {
  const input = fixture();
  const events = [];
  const output = [];
  const key = '__kairosResetExecution';
  const state = { replacementPod: false, accelerateTime: false, now: 0 };
  let batchesDeleted = false;
  const targets = {
    batchsandboxes: new Set(['test-sandbox', 'prod-sandbox']),
    sandboxsnapshots: new Set(['test-pause']),
    jobs: new Set(input.resources.jobs.map((item) => item.metadata.name)),
    pods: new Set(input.resources.pods.map((item) => item.metadata.name)),
    secrets: new Set(['kp-init-test-0123456789abcdef']),
    persistentvolumeclaims: new Set(['kp-test-env-1-workspace', 'kp-prod-env-2-identity']),
    persistentvolumes: new Set(['pvc-test-pvc', 'pvc-prod-pvc']),
  };
  const canonicalKind = (kind) =>
    ({
      'batchsandboxes.sandbox.opensandbox.io': 'batchsandboxes',
      'sandboxsnapshots.sandbox.opensandbox.io': 'sandboxsnapshots',
    })[kind] ?? kind;

  function currentItems(kind) {
    const canonical = canonicalKind(kind);
    const items = input.resources[canonical];
    if (!batchesDeleted) return items;
    const remaining = items.filter((item) => !targets[canonical].has(item.metadata.name));
    if (canonical === 'pods' && state.replacementPod) {
      remaining.push(
        resource('test-pod', 'replacement-pod', {
          labels: { 'kairos.io/deployment': 'test', 'kairos.io/env': 'env-1' },
        }),
      );
    }
    return remaining;
  }

  function execFileSync(command, args) {
    assert.equal(command, '/opt/kairos-sandbox/bin/cluster-command.py');
    const [action, operation, kind] = args;
    assert.equal(action, 'kubectl');
    if (operation === 'delete') {
      events.push(`delete:${kind}`);
      if (kind === 'batchsandboxes.sandbox.opensandbox.io') batchesDeleted = true;
      return '';
    }
    assert.equal(operation, 'get');
    if (kind === 'persistentvolumeclaim') return JSON.stringify(input.registryPvc);
    events.push(`get:${kind}`);
    const format = args[args.indexOf('-o') + 1];
    if (kind === 'secrets' && format.startsWith('jsonpath=')) {
      return currentItems(kind)
        .map(
          (item) =>
            `${item.metadata.name}\t${item.metadata.uid}\t${JSON.stringify(item.metadata.labels ?? {})}`,
        )
        .join('\n');
    }
    return JSON.stringify({ items: currentItems(kind) });
  }

  const fs = {
    chownSync() {},
    existsSync(path) {
      if (path.endsWith('.stop') || path.endsWith('/maintenance') || path.endsWith('/data'))
        return true;
      return path.includes('platform-control.sqlite');
    },
    lstatSync() {
      return { isSymbolicLink: () => false, isDirectory: () => true };
    },
    mkdirSync(path) {
      events.push(`mkdir:${path}`);
    },
    realpathSync(path) {
      return path;
    },
    rmSync(path) {
      events.push(`rm:${path}`);
    },
    statSync() {
      return { uid: 1000, gid: 1000 };
    },
    unlinkSync(path) {
      events.push(`unlink:${path}`);
    },
  };
  class DatabaseSync {
    exec() {}
    prepare(sql) {
      if (sql === 'PRAGMA user_version') return { get: () => ({ user_version: 2 }) };
      return {
        all: () =>
          sql.includes('platform_control_environments') ? input.environments : input.operations,
      };
    }
    close() {}
  }

  globalThis[key] = { execFileSync, fs, DatabaseSync };
  const hooks = registerHooks({
    load(specifier, context, nextLoad) {
      const sources = {
        'node:child_process': `export const execFileSync = globalThis.${key}.execFileSync;`,
        'node:fs': `export const { chownSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, unlinkSync } = globalThis.${key}.fs;`,
        'node:sqlite': `export const DatabaseSync = globalThis.${key}.DatabaseSync;`,
      };
      if (sources[specifier])
        return { format: 'module', source: sources[specifier], shortCircuit: true };
      return nextLoad(specifier, context);
    },
  });
  const previousArgv = process.argv;
  process.argv = ['node', 'reset-runtime.mjs', '--execute', '--confirm-reset', 'RESET test,prod'];
  t.after(() => {
    process.argv = previousArgv;
    hooks.deregister();
    delete globalThis[key];
  });
  t.mock.method(process.stdout, 'write', (chunk) => {
    output.push(String(chunk));
    return true;
  });
  t.mock.method(Date, 'now', () => state.now);
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds) => {
    if (state.accelerateTime) state.now += milliseconds;
    callback();
  });

  const { main } = await import('../k1/reset-runtime.mjs?execution=1');
  return {
    events,
    output,
    runScenario({ replacementPod = false } = {}) {
      batchesDeleted = false;
      events.length = 0;
      output.length = 0;
      state.replacementPod = replacementPod;
      state.accelerateTime = replacementPod;
      state.now = 0;
      return main();
    },
  };
}

test('main enforces deletion order and same-name Pod failure before local deletion', async (t) => {
  const { runScenario, events, output } = await mockMainExecution(t);
  await runScenario();

  const batchKind = 'batchsandboxes.sandbox.opensandbox.io';
  const snapshotKind = 'sandboxsnapshots.sandbox.opensandbox.io';
  const batchDelete = events.indexOf(`delete:${batchKind}`);
  const batchWait = events.indexOf(`get:${batchKind}`, batchDelete + 1);
  const snapshotDelete = events.indexOf(`delete:${snapshotKind}`);
  const podWait = events.indexOf('get:pods', batchWait + 1);
  assert.ok(batchDelete >= 0);
  assert.ok(batchWait > batchDelete);
  assert.ok(snapshotDelete > batchWait);
  assert.ok(events.indexOf('delete:jobs') > batchWait);
  assert.ok(podWait > snapshotDelete);
  assert.equal(events.includes('delete:pods'), false);
  assert.ok(events.indexOf('delete:persistentvolumeclaims') > podWait);
  assert.ok(
    events.indexOf('rm:/home/wanghailong/kairos/test/data') >
      events.indexOf('delete:persistentvolumes'),
  );
  assert.equal(JSON.parse(output.join('')).status, 'reset_complete');

  await assert.rejects(
    runScenario({ replacementPod: true }),
    /Timed out waiting for pods deletion/,
  );
  assert.ok(events.filter((event) => event === 'get:pods').length > 1);
  assert.equal(events.includes('delete:persistentvolumeclaims'), false);
  assert.equal(events.includes('delete:persistentvolumes'), false);
  assert.equal(
    events.some(
      (event) =>
        event.startsWith('rm:') || event.startsWith('unlink:') || event.startsWith('mkdir:'),
    ),
    false,
  );
  assert.equal(output.length, 0);
});
