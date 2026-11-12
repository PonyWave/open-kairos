import { fork } from 'node:child_process';
import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  type ControlStoreOptions,
  initializePlatformControlDatabase,
  PlatformControlStore,
} from './control-store.js';

const dirs: string[] = [];
const stores: PlatformControlStore[] = [];
const cluster = {
  caSha256: 'a'.repeat(64),
  nodeUid: 'node-uid',
  nodeName: 'kairos-k1',
  namespace: 'opensandbox',
};
function fixture(capacity = 1) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kairos-control-')));
  dirs.push(dir);
  const path = join(dir, 'control.sqlite');
  initializePlatformControlDatabase({ path, capacity, cluster });
  return { dir, path, capacity, cluster };
}
function open(
  input: ReturnType<typeof fixture>,
  deploymentId = 'test',
  options: Pick<ControlStoreOptions, 'now' | 'idleTimeoutMs'> = {},
) {
  const store = new PlatformControlStore({ ...input, deploymentId, ...options });
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const use = (envId: string, usageId = 'run-1') => ({
  envId,
  tenantId: `tenant-${envId}`,
  usageId,
  kind: 'run' as const,
});

it('shares fixed slots across deployments and keeps unknown allocations occupied after reopen', () => {
  const f = fixture();
  const one = open(f, 'test');
  const two = open(f, 'prod');
  const accepted = one.reserve(use('env-1'));
  expect(one.claim(accepted.current_operation_id ?? '')).toBe(true);
  one.markOperation(accepted.current_operation_id ?? '', 'unknown');
  expect(() => two.reserve(use('env-2'))).toThrowError(
    expect.objectContaining({ code: 'sandbox_capacity_exhausted' }),
  );
  const reopened = open(f, 'test');
  expect(reopened.get('env-1')?.state).toBe('starting');
  expect(() => reopened.reserve(use('env-3'))).toThrowError(
    expect.objectContaining({ code: 'sandbox_capacity_exhausted' }),
  );
});

it('cancels only an undispatched pause; a later use preserves the original slot until resume', () => {
  let now = Date.parse('2026-11-08T00:00:00.000Z');
  const store = open(fixture(), 'test', { now: () => new Date(now) });
  const first = store.reserve(use('env-1'));
  const create = first.current_operation_id ?? '';
  store.claim(create);
  store.complete('env-1', create, { state: 'running', sandbox_id: 'sandbox' });
  store.release(use('env-1'));
  now += 3_600_000;
  store.prepareIdlePause('env-1');
  let pause = store.get('env-1')?.current_operation_id ?? '';
  store.reserve(use('env-1', 'run-2'));
  expect(store.operation(pause).status).toBe('cancelled');
  expect(store.get('env-1')?.state).toBe('running');
  expect(store.claim(pause)).toBe(false);
  store.release(use('env-1', 'run-2'));
  now += 3_600_000;
  store.prepareIdlePause('env-1');
  pause = store.get('env-1')?.current_operation_id ?? '';
  expect(store.claim(pause)).toBe(true);
  store.reserve(use('env-1', 'run-3'));
  expect(store.get('env-1')?.state).toBe('pausing');
  expect(() => store.reserve(use('env-2'))).toThrowError(
    expect.objectContaining({ code: 'sandbox_capacity_exhausted' }),
  );
  store.complete('env-1', pause, { state: 'paused' });
  expect(store.get('env-1')?.state).toBe('resuming');
  expect(store.useCount('env-1')).toBe(1);
});

it('associates only the original dispatched create and rejects changed runtime, Batch or late response IDs', () => {
  const store = open(fixture());
  const accepted = store.reserve(use('env-1'));
  const association = {
    envId: 'env-1',
    operationId: accepted.current_operation_id ?? '',
    runtimeVersion: accepted.runtime_version,
    sandboxId: 'sandbox',
    batchUid: 'batch',
  };
  expect(() => store.associateCreatedSandbox(association)).toThrow('dispatched create');
  store.claim(association.operationId);
  expect(() =>
    store.associateCreatedSandbox({
      ...association,
      runtimeVersion: association.runtimeVersion + 1,
    }),
  ).toThrow('dispatched create');
  store.associateCreatedSandbox(association);
  store.associateCreatedSandbox(association);
  expect(store.get('env-1')).toMatchObject({ sandbox_id: 'sandbox', batch_uid: 'batch' });
  expect(() => store.associateCreatedSandbox({ ...association, sandboxId: 'other' })).toThrow(
    'dispatched create',
  );
  expect(() => store.associateCreatedSandbox({ ...association, batchUid: 'replaced' })).toThrow(
    'dispatched create',
  );
  store.complete('env-1', association.operationId, { state: 'running' });
  expect(() => store.associateCreatedSandbox(association)).toThrow('dispatched create');
});

it('keeps a pausing reconnect idempotent only for the exact recorded Batch, Pod, instance and runtime version', () => {
  let now = Date.parse('2026-11-08T00:00:00.000Z');
  const store = open(fixture(), 'test', { now: () => new Date(now) });
  const registered = store.reserve(use('env-1'));
  const create = registered.current_operation_id ?? '';
  store.claim(create);
  store.complete('env-1', create, {
    state: 'running',
    sandbox_id: 'sandbox',
    batch_uid: 'batch',
    pod_uid: 'pod',
    pod_name: 'pod-name',
    instance_id: 'instance',
  });
  store.release(use('env-1'));
  now += 3_600_000;
  store.prepareIdlePause('env-1');
  const original = store.get('env-1');
  if (!original) throw new Error('Missing paused fixture');
  store.claim(original.current_operation_id ?? '');
  const dispatched = store.get('env-1');
  store.bindRuntime(
    'env-1',
    { uid: 'pod', name: 'pod-name', batchUid: 'batch' },
    'instance',
    original.runtime_version,
    original.current_operation_id ?? '',
  );
  expect(store.get('env-1')).toEqual(dispatched);
  for (const pod of [
    { uid: 'other', name: 'pod-name', batchUid: 'batch' },
    { uid: 'pod', name: 'other', batchUid: 'batch' },
    { uid: 'pod', name: 'pod-name', batchUid: 'other' },
  ])
    expect(() =>
      store.bindRuntime(
        'env-1',
        pod,
        'instance',
        original.runtime_version,
        original.current_operation_id ?? '',
      ),
    ).toThrow('unchanged recorded instance');
  expect(() =>
    store.bindRuntime(
      'env-1',
      { uid: 'pod', name: 'pod-name', batchUid: 'batch' },
      'other',
      original.runtime_version,
      original.current_operation_id ?? '',
    ),
  ).toThrow('unchanged recorded instance');
  expect(() =>
    store.bindRuntime(
      'env-1',
      { uid: 'pod', name: 'pod-name', batchUid: 'batch' },
      'instance',
      original.runtime_version + 1,
      original.current_operation_id ?? '',
    ),
  ).toThrow('unchanged recorded instance');
  expect(() =>
    store.bindRuntime(
      'env-1',
      { uid: 'pod', name: 'pod-name', batchUid: 'batch' },
      'instance',
      original.runtime_version,
      'other-pause',
    ),
  ).toThrow('unchanged recorded instance');
  expect(store.useCount('env-1')).toBe(0);
});

it('counts one hour from the last settled use and preserves the deadline through repeated releases and reopen', () => {
  let now = Date.parse('2026-11-08T00:00:00.000Z');
  const f = fixture();
  const clock = { now: () => new Date(now) };
  const store = open(f, 'test', clock);
  const run = use('env-1');
  const operation = { ...use('env-1', 'operation-1'), kind: 'operation' as const };
  const accepted = store.reserve(run);
  store.reserve(operation);
  store.complete('env-1', accepted.current_operation_id ?? '', { state: 'running' });
  store.release(run);
  now += 7_200_000;
  expect(store.prepareIdlePause('env-1')).toBeUndefined();
  expect(store.get('env-1')?.idle_since).toBeNull();
  store.release(operation);
  const firstIdle = new Date(now).toISOString();
  expect(store.get('env-1')).toMatchObject({ state: 'running', idle_since: firstIdle });
  now += 3_599_999;
  store.release(operation);
  expect(store.prepareIdlePause('env-1')).toBeUndefined();
  expect(store.get('env-1')?.idle_since).toBe(firstIdle);
  expect(() => open(f, 'prod').reserve(use('env-2'))).toThrowError(
    expect.objectContaining({ code: 'sandbox_capacity_exhausted' }),
  );
  const reopened = open(f, 'test', clock);
  expect(reopened.get('env-1')?.idle_since).toBe(firstIdle);
  now += 1;
  const pause = reopened.prepareIdlePause('env-1');
  expect(pause).toBeTypeOf('string');
  expect(reopened.get('env-1')?.state).toBe('pausing');
  reopened.complete('env-1', pause ?? '', { state: 'paused' });
  expect(reopened.get('env-1')?.idle_since).toBeNull();
  expect(open(f, 'prod').reserve(use('env-2')).state).toBe('starting');
});

it('clears the idle deadline on use and starts a new full hour after that use ends', () => {
  let now = Date.parse('2026-11-08T00:00:00.000Z');
  const store = open(fixture(), 'test', { now: () => new Date(now) });
  const first = store.reserve(use('env-1'));
  store.complete('env-1', first.current_operation_id ?? '', { state: 'running' });
  store.release(use('env-1'));
  now += 3_599_999;
  store.reserve(use('env-1', 'next'));
  expect(store.get('env-1')?.idle_since).toBeNull();
  now += 3_600_000;
  expect(store.prepareIdlePause('env-1')).toBeUndefined();
  store.release(use('env-1', 'next'));
  expect(store.get('env-1')?.idle_since).toBe(new Date(now).toISOString());
  now += 3_599_999;
  expect(store.prepareIdlePause('env-1')).toBeUndefined();
  now += 1;
  expect(store.prepareIdlePause('env-1')).toBeTypeOf('string');
});

it('starts idle time when a newly created runtime becomes ready after all use was released', () => {
  let now = Date.parse('2026-11-08T00:00:00.000Z');
  const store = open(fixture(), 'test', { now: () => new Date(now) });
  const accepted = store.reserve(use('env-1'));
  store.release(use('env-1'));
  expect(store.get('env-1')?.idle_since).toBeNull();
  now += 3_600_000;
  store.complete('env-1', accepted.current_operation_id ?? '', { state: 'running' });
  expect(store.get('env-1')).toMatchObject({
    state: 'running',
    idle_since: new Date(now).toISOString(),
    current_operation_id: null,
  });
  expect(store.prepareIdlePause('env-1')).toBeUndefined();
});

it('rejects missing, corrupt, replaced, incompatible cluster or capacity databases without initializing them', () => {
  const f = fixture();
  expect(
    () => new PlatformControlStore({ ...f, path: join(f.dir, 'missing'), deploymentId: 'test' }),
  ).toThrow();
  expect(() => new PlatformControlStore({ ...f, capacity: 2, deploymentId: 'test' })).toThrow();
  expect(
    () => new PlatformControlStore({ ...f, idleTimeoutMs: 60_000, deploymentId: 'prod' }),
  ).toThrow('idle timeout does not match');
  expect(
    () =>
      new PlatformControlStore({
        ...f,
        cluster: { ...cluster, nodeUid: 'different' },
        deploymentId: 'test',
      }),
  ).toThrow();
  const store = open(f);
  renameSync(f.path, `${f.path}.original`);
  writeFileSync(f.path, 'corrupt', { mode: 0o600 });
  expect(() => store.reserve(use('env-1'))).toThrow();
});

it('arbitrates the last slot atomically between two separate Node processes', async () => {
  const f = fixture();
  const source = join(f.dir, 'reserve.mjs');
  writeFileSync(
    source,
    `import { PlatformControlStore } from ${JSON.stringify(new URL('./control-store.ts', import.meta.url).href)};process.on('message',()=>{const store=new PlatformControlStore(JSON.parse(process.argv[2]));try{store.reserve({tenantId:process.argv[3],envId:process.argv[3],usageId:'run',kind:'run'});process.send('reserved');}catch(error){process.send(error.code??'error');}finally{store.close();process.disconnect();}});process.send('ready');`,
  );
  const children = ['test', 'prod'].map((deploymentId) =>
    fork(source, [JSON.stringify({ ...f, deploymentId }), deploymentId], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    }),
  );
  const ready = children.map(
    (child) =>
      new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('message', (value) =>
          value === 'ready' ? resolve() : reject(new Error('Unexpected worker state')),
        );
      }),
  );
  await Promise.all(ready);
  const exits = children.map(
    (child) => new Promise<void>((resolve) => child.once('exit', () => resolve())),
  );
  const outcomes = children.map(
    (child) =>
      new Promise<string>((resolve, reject) => {
        child.once('error', reject);
        child.once('message', (value) => resolve(String(value)));
      }),
  );
  children.forEach((child) => {
    child.send('reserve');
  });
  expect((await Promise.all(outcomes)).sort()).toEqual(['reserved', 'sandbox_capacity_exhausted']);
  await Promise.all(exits);
});
