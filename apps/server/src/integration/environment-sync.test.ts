import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AgentEnvironmentRuntime } from '../sessions/environment-runtime.js';
import { SessionStore } from '../sessions/store.js';
import {
  ControlledEnvironmentUseGateway,
  startRealEnvironmentServer,
} from './environment-fixture.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

it('syncs files and nested directories in both directions through real Daemons with conflict policies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-environment-sync-'));
  const fixture = await startRealEnvironmentServer(directory, {
    ownerId: 'tenant-sync',
    accessToken: 'token-sync',
  });
  cleanup.push(async () => {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  const second = await fixture.addEnvironment('second');
  const store = new SessionStore(fixture.database, { mainEnvironment: fixture.mainEnvironment });
  const runtime = new AgentEnvironmentRuntime({
    store,
    environments: fixture.environments,
    operations: fixture.channel,
    environmentUse: new ControlledEnvironmentUseGateway(fixture.database),
  });
  const task = store.createThread({
    ownerId: 'tenant-sync',
    clientActionId: 'create-sync-task',
    method: 'CreateThread',
    parameters: {},
    title: 'environment sync',
    initialText: 'sync',
    initialMode: 'follow_up',
    environmentPolicy: { allowedEnv: [fixture.envId, second.envId] },
  });
  const run = store.getRunById(task.runId);
  const source = join(fixture.workspace, 'source');
  const target = join(second.workspace, 'copied');
  await mkdir(join(source, 'nested'), { recursive: true });
  await mkdir(join(source, 'empty'), { recursive: true });
  await writeFile(join(source, 'same.txt'), 'same');
  await writeFile(join(source, 'other.txt'), 'source version');
  await writeFile(
    join(source, 'nested', 'payload.bin'),
    Buffer.from(Array.from({ length: 140_000 }, (_, index) => (index * 19) % 256)),
  );
  await writeFile(join(source, 'empty', '.keep'), '');
  await rm(join(source, 'empty', '.keep'));
  const sourceBinary = await readFile(join(source, 'nested', 'payload.bin'));

  const forwarded = await runtime.sync(
    run,
    {
      sourceEnvId: fixture.envId,
      sourcePath: source,
      targetEnvId: second.envId,
      targetPath: target,
      onConflict: 'fail',
    },
    'sync-forward',
    new AbortController().signal,
  );
  expect(JSON.parse(forwarded.content)).toEqual({
    status: 'completed',
    succeeded: 3,
    skipped: 0,
    failed: 0,
    failures: [],
  });
  expect(forwarded.content).not.toContain('operation_id');
  expect(await readFile(join(target, 'nested', 'payload.bin'))).toEqual(sourceBinary);
  expect((await stat(join(target, 'empty'))).isDirectory()).toBe(true);

  const reversedPath = join(fixture.workspace, 'reverse.bin');
  const reversed = await runtime.sync(
    run,
    {
      sourceEnvId: second.envId,
      sourcePath: join(target, 'nested', 'payload.bin'),
      targetEnvId: fixture.envId,
      targetPath: reversedPath,
      onConflict: 'fail',
    },
    'sync-reverse',
    new AbortController().signal,
  );
  expect(JSON.parse(reversed.content)).toMatchObject({ status: 'completed', succeeded: 1 });
  expect(await readFile(reversedPath)).toEqual(sourceBinary);

  await writeFile(join(target, 'other.txt'), 'target version');
  await writeFile(join(source, 'new.txt'), 'new file');
  const conflict = await runtime.sync(
    run,
    {
      sourceEnvId: fixture.envId,
      sourcePath: source,
      targetEnvId: second.envId,
      targetPath: target,
      onConflict: 'fail',
    },
    'sync-conflict-fail',
    new AbortController().signal,
  );
  expect(JSON.parse(conflict.content)).toMatchObject({
    status: 'partial',
    succeeded: 1,
    skipped: 2,
    failed: 1,
  });
  expect(JSON.parse(conflict.content).failures[0].reason).toContain('on_conflict is fail');
  expect(await readFile(join(target, 'other.txt'), 'utf8')).toBe('target version');
  expect(await readFile(join(target, 'new.txt'), 'utf8')).toBe('new file');

  const skipped = await runtime.sync(
    run,
    {
      sourceEnvId: fixture.envId,
      sourcePath: source,
      targetEnvId: second.envId,
      targetPath: target,
      onConflict: 'skip',
    },
    'sync-conflict-skip',
    new AbortController().signal,
  );
  expect(JSON.parse(skipped.content)).toEqual({
    status: 'completed',
    succeeded: 0,
    skipped: 4,
    failed: 0,
    failures: [],
  });

  await writeFile(join(target, 'extra.txt'), 'preserve me');
  const overwritten = await runtime.sync(
    run,
    {
      sourceEnvId: fixture.envId,
      sourcePath: source,
      targetEnvId: second.envId,
      targetPath: target,
      onConflict: 'overwrite',
    },
    'sync-conflict-overwrite',
    new AbortController().signal,
  );
  expect(JSON.parse(overwritten.content)).toMatchObject({
    status: 'completed',
    succeeded: 1,
    skipped: 3,
    failed: 0,
  });
  expect(await readFile(join(target, 'other.txt'), 'utf8')).toBe('source version');
  expect(await readFile(join(target, 'extra.txt'), 'utf8')).toBe('preserve me');

  const audit = fixture.database
    .prepare(
      `SELECT source_env_id, target_env_id, status, succeeded, skipped, failed
       FROM environment_syncs WHERE tool_call_id = 'sync-conflict-overwrite'`,
    )
    .get();
  expect(audit).toMatchObject({
    source_env_id: fixture.envId,
    target_env_id: second.envId,
    status: 'completed',
    succeeded: 1,
    skipped: 3,
    failed: 0,
  });
  const fileAudit = fixture.database
    .prepare(
      `SELECT sync_file_id, relative_path, source_sha256, target_sha256, status, operation_id
       FROM environment_sync_files
       WHERE sync_id = (SELECT sync_id FROM environment_syncs WHERE tool_call_id = 'sync-conflict-overwrite')
         AND kind = 'file' ORDER BY relative_path`,
    )
    .all();
  expect(fileAudit).toHaveLength(4);
  expect(
    fileAudit.every((row) => String(row.sync_file_id).startsWith('env-sync-file:env-sync:')),
  ).toBe(true);
  expect(fileAudit.find((row) => row.relative_path === 'other.txt')).toMatchObject({
    status: 'succeeded',
    source_sha256: fileAudit.find((row) => row.relative_path === 'other.txt')?.target_sha256,
    operation_id: expect.stringContaining('env-sync-operation:'),
  });
  const chunkOperations = fixture.database
    .prepare(
      `SELECT COUNT(*) AS count FROM environment_operations
       WHERE sync_action IN ('sync_read', 'sync_write')`,
    )
    .get();
  expect(Number(chunkOperations?.count)).toBeGreaterThan(6);

  const restricted = store.createThread({
    ownerId: 'tenant-sync',
    clientActionId: 'create-restricted-sync-task',
    method: 'CreateThread',
    parameters: {},
    title: 'restricted sync',
    initialText: 'restricted',
    initialMode: 'follow_up',
    environmentPolicy: { allowedEnv: [fixture.envId] },
  });
  await expect(
    runtime.sync(
      store.getRunById(restricted.runId),
      {
        sourceEnvId: fixture.envId,
        sourcePath: join(source, 'same.txt'),
        targetEnvId: second.envId,
        targetPath: join(second.workspace, 'denied.txt'),
        onConflict: 'fail',
      },
      'sync-denied',
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'permission_denied' });
}, 30_000);

it('ignores unrelated large and numerous target entries during bounded conflict precheck', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-environment-sync-target-'));
  const fixture = await startRealEnvironmentServer(directory, {
    ownerId: 'tenant-sync-target',
    accessToken: 'token-sync-target',
  });
  cleanup.push(async () => {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  const second = await fixture.addEnvironment('second');
  const store = new SessionStore(fixture.database, { mainEnvironment: fixture.mainEnvironment });
  const runtime = new AgentEnvironmentRuntime({
    store,
    environments: fixture.environments,
    operations: fixture.channel,
    environmentUse: new ControlledEnvironmentUseGateway(fixture.database),
  });
  const task = store.createThread({
    ownerId: 'tenant-sync-target',
    clientActionId: 'create-target-precheck-task',
    method: 'CreateThread',
    parameters: {},
    title: 'bounded target precheck',
    initialText: 'sync',
    initialMode: 'follow_up',
    environmentPolicy: { allowedEnv: [fixture.envId, second.envId] },
  });
  const source = join(fixture.workspace, 'small-source');
  const target = join(second.workspace, 'large-target');
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(source, 'source.txt'), 'small source');
  const oversizedPath = join(target, 'oversized.bin');
  await writeFile(oversizedPath, Buffer.alloc(8 * 1024 * 1024 + 1, 7));
  for (let index = 0; index < 300; index += 1) {
    await writeFile(join(target, `extra-${index}.txt`), `extra ${index}`);
  }

  const result = await runtime.sync(
    store.getRunById(task.runId),
    {
      sourceEnvId: fixture.envId,
      sourcePath: source,
      targetEnvId: second.envId,
      targetPath: target,
      onConflict: 'fail',
    },
    'sync-large-target',
    new AbortController().signal,
  );
  expect(JSON.parse(result.content)).toEqual({
    status: 'completed',
    succeeded: 1,
    skipped: 0,
    failed: 0,
    failures: [],
  });
  expect(await readFile(join(target, 'source.txt'), 'utf8')).toBe('small source');
  expect((await stat(oversizedPath)).size).toBe(8 * 1024 * 1024 + 1);
  expect(await readFile(join(target, 'extra-299.txt'), 'utf8')).toBe('extra 299');
  expect(await readdir(target)).toHaveLength(302);

  const targetScan = fixture.database
    .prepare(
      `SELECT conflict_scan, relative_paths_json FROM environment_operations
       WHERE env_id = ? AND sync_action = 'sync_scan'
       ORDER BY created_at DESC, operation_id DESC LIMIT 1`,
    )
    .get(second.envId);
  expect(targetScan).toEqual({ conflict_scan: 1, relative_paths_json: '["source.txt"]' });
}, 30_000);

it('overwrites large existing files by existence rather than target hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-environment-sync-overwrite-'));
  const fixture = await startRealEnvironmentServer(directory, {
    ownerId: 'tenant-sync-overwrite',
    accessToken: 'token-sync-overwrite',
  });
  cleanup.push(async () => {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  const second = await fixture.addEnvironment('second');
  const store = new SessionStore(fixture.database, { mainEnvironment: fixture.mainEnvironment });
  const runtime = new AgentEnvironmentRuntime({
    store,
    environments: fixture.environments,
    operations: fixture.channel,
    environmentUse: new ControlledEnvironmentUseGateway(fixture.database),
  });
  const task = store.createThread({
    ownerId: 'tenant-sync-overwrite',
    clientActionId: 'create-large-overwrite-task',
    method: 'CreateThread',
    parameters: {},
    title: 'large overwrite',
    initialText: 'sync',
    initialMode: 'follow_up',
    environmentPolicy: { allowedEnv: [fixture.envId, second.envId] },
  });
  const run = store.getRunById(task.runId);
  const sourceFile = join(fixture.workspace, 'source.txt');
  const targetFile = join(second.workspace, 'target.bin');
  const replacement = Buffer.from('small replacement');
  await writeFile(sourceFile, replacement);
  await writeFile(targetFile, Buffer.alloc(8 * 1024 * 1024 + 1, 9));

  const single = await runtime.sync(
    run,
    {
      sourceEnvId: fixture.envId,
      sourcePath: sourceFile,
      targetEnvId: second.envId,
      targetPath: targetFile,
      onConflict: 'overwrite',
    },
    'sync-large-single-overwrite',
    new AbortController().signal,
  );
  expect(JSON.parse(single.content)).toMatchObject({
    status: 'completed',
    succeeded: 1,
    skipped: 0,
    failed: 0,
  });
  expect(await readFile(targetFile)).toEqual(replacement);
  expect(
    createHash('sha256')
      .update(await readFile(targetFile))
      .digest('hex'),
  ).toBe(createHash('sha256').update(replacement).digest('hex'));
  expect(
    fixture.database
      .prepare(
        "SELECT target_exists FROM environment_sync_files WHERE relative_path = '.' AND sync_id = (SELECT sync_id FROM environment_syncs WHERE tool_call_id = 'sync-large-single-overwrite')",
      )
      .get(),
  ).toEqual({ target_exists: 1 });

  const sourceDirectory = join(fixture.workspace, 'source-directory');
  const targetDirectory = join(second.workspace, 'target-directory');
  const sourceNested = join(sourceDirectory, 'nested', 'payload.bin');
  const targetNested = join(targetDirectory, 'nested', 'payload.bin');
  await mkdir(join(sourceDirectory, 'nested'), { recursive: true });
  await mkdir(join(targetDirectory, 'nested'), { recursive: true });
  await writeFile(sourceNested, replacement);
  await writeFile(targetNested, Buffer.alloc(8 * 1024 * 1024 + 2, 4));
  const directoryResult = await runtime.sync(
    run,
    {
      sourceEnvId: fixture.envId,
      sourcePath: sourceDirectory,
      targetEnvId: second.envId,
      targetPath: targetDirectory,
      onConflict: 'overwrite',
    },
    'sync-large-directory-overwrite',
    new AbortController().signal,
  );
  expect(JSON.parse(directoryResult.content)).toMatchObject({
    status: 'completed',
    succeeded: 1,
    skipped: 0,
    failed: 0,
  });
  expect(await readFile(targetNested)).toEqual(replacement);
  expect(
    createHash('sha256')
      .update(await readFile(targetNested))
      .digest('hex'),
  ).toBe(createHash('sha256').update(replacement).digest('hex'));
}, 30_000);

it('skips non-directory and symlink ancestors while copying unrelated files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-environment-sync-ancestors-'));
  const fixture = await startRealEnvironmentServer(directory, {
    ownerId: 'tenant-sync-ancestors',
    accessToken: 'token-sync-ancestors',
  });
  cleanup.push(async () => {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  const second = await fixture.addEnvironment('second');
  const store = new SessionStore(fixture.database, { mainEnvironment: fixture.mainEnvironment });
  const runtime = new AgentEnvironmentRuntime({
    store,
    environments: fixture.environments,
    operations: fixture.channel,
    environmentUse: new ControlledEnvironmentUseGateway(fixture.database),
  });
  const task = store.createThread({
    ownerId: 'tenant-sync-ancestors',
    clientActionId: 'create-ancestor-conflict-task',
    method: 'CreateThread',
    parameters: {},
    title: 'ancestor conflicts',
    initialText: 'sync',
    initialMode: 'follow_up',
    environmentPolicy: { allowedEnv: [fixture.envId, second.envId] },
  });
  const source = join(fixture.workspace, 'ancestor-source');
  const target = join(second.workspace, 'ancestor-target');
  const outside = join(second.workspace, 'outside');
  await mkdir(join(source, 'nested'), { recursive: true });
  await mkdir(join(source, 'linked'), { recursive: true });
  await mkdir(target, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(source, 'nested', 'child.txt'), 'nested source');
  await writeFile(join(source, 'linked', 'child.txt'), 'linked source');
  await writeFile(join(source, 'conflict.txt'), 'source conflict');
  await writeFile(join(source, 'other.txt'), 'other source');
  await writeFile(join(target, 'nested'), 'do not change');
  await writeFile(join(target, 'conflict.txt'), 'target conflict');
  await writeFile(join(outside, 'child.txt'), 'outside original');
  await symlink(outside, join(target, 'linked'));

  const result = await runtime.sync(
    store.getRunById(task.runId),
    {
      sourceEnvId: fixture.envId,
      sourcePath: source,
      targetEnvId: second.envId,
      targetPath: target,
      onConflict: 'skip',
    },
    'sync-ancestor-skip',
    new AbortController().signal,
  );
  expect(JSON.parse(result.content)).toEqual({
    status: 'completed',
    succeeded: 1,
    skipped: 3,
    failed: 0,
    failures: [],
  });
  expect(await readFile(join(target, 'nested'), 'utf8')).toBe('do not change');
  expect(await readFile(join(target, 'conflict.txt'), 'utf8')).toBe('target conflict');
  expect(await readlink(join(target, 'linked'))).toBe(outside);
  expect(await readFile(join(outside, 'child.txt'), 'utf8')).toBe('outside original');
  expect(await readFile(join(target, 'other.txt'), 'utf8')).toBe('other source');
  const statuses = fixture.database
    .prepare(
      `SELECT relative_path, status FROM environment_sync_files
       WHERE sync_id = (SELECT sync_id FROM environment_syncs WHERE tool_call_id = 'sync-ancestor-skip')
       ORDER BY relative_path`,
    )
    .all();
  expect(statuses).toEqual([
    { relative_path: 'conflict.txt', status: 'skipped' },
    { relative_path: 'linked', status: 'skipped' },
    { relative_path: 'linked/child.txt', status: 'skipped' },
    { relative_path: 'nested', status: 'skipped' },
    { relative_path: 'nested/child.txt', status: 'skipped' },
    { relative_path: 'other.txt', status: 'succeeded' },
  ]);
}, 30_000);
