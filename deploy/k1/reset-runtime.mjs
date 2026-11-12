#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const ROOT = '/home/wanghailong/kairos';
const CONTROL = `${ROOT}/runtime/sandbox/platform-control.sqlite`;
const VOLUMES = '/var/lib/kairos-sandbox/volumes';
const GUARD = '/opt/kairos-sandbox/bin/cluster-command.py';
const NAMESPACE = 'opensandbox';
const DEPLOYMENTS = ['test', 'prod'];
const CONFIRMATION = 'RESET test,prod';
const CLAIM_KINDS = ['workspace', 'home', 'identity'];

function fail(message) {
  throw new Error(message);
}

function metadata(resource) {
  return {
    name: resource.metadata?.name,
    uid: resource.metadata?.uid,
    labels: resource.metadata?.labels ?? {},
    owners: resource.metadata?.ownerReferences ?? [],
  };
}

function descriptor(kind, resource) {
  return { kind, name: metadata(resource).name, uid: metadata(resource).uid };
}

function claimIdentity(name, known) {
  for (const deployment of DEPLOYMENTS) {
    for (const envId of known.get(deployment)) {
      for (const kind of CLAIM_KINDS) {
        if (name === `kp-${deployment}-${envId.toLowerCase()}-${kind}`)
          return { deployment, envId, kind };
      }
    }
  }
  return undefined;
}

function targetIdentity(resource, known) {
  const labels = metadata(resource).labels;
  const deployment = labels['kairos.io/deployment'];
  const envId = labels['kairos.io/env'];
  if (!DEPLOYMENTS.includes(deployment)) return undefined;
  if (!known.get(deployment).has(envId))
    fail(`Unrecognized ${deployment} environment on ${metadata(resource).name}.`);
  return { deployment, envId };
}

function volumePath(uid, claimName) {
  return `${VOLUMES}/pvc-${uid}_${NAMESPACE}_${claimName}`;
}

function registryReference(snapshot, batch, container) {
  const name = container?.containerName;
  const reference = container?.imageUri;
  const digest = container?.imageDigest;
  const repository = `kairos/${batch}-${name}`;
  const prefix = `10.251.0.50:5000/${repository}:`;
  if (
    !/^[a-z0-9-]+$/.test(name ?? '') ||
    typeof reference !== 'string' ||
    !reference.startsWith(prefix) ||
    !/^sha256:[a-f0-9]{64}$/.test(digest ?? '') ||
    reference.slice(prefix.length).length === 0 ||
    reference.includes('@')
  )
    fail(`Unexpected snapshot registry reference on ${snapshot}.`);
  return { snapshot, repository, reference, digest };
}

export function createResetPlan({ environments, operations, resources, registryPvc }) {
  const known = new Map(DEPLOYMENTS.map((deployment) => [deployment, new Set()]));
  for (const row of [...environments, ...operations]) {
    if (!DEPLOYMENTS.includes(row.deployment_id)) continue;
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(row.env_id ?? ''))
      fail('Invalid environment identifier in the control database.');
    known.get(row.deployment_id).add(row.env_id);
  }
  for (const deployment of DEPLOYMENTS) {
    if (known.get(deployment).size === 0) fail(`No control records found for ${deployment}.`);
  }

  const batches = resources.batchsandboxes;
  const currentBatches = new Map();
  for (const row of environments) {
    if (!DEPLOYMENTS.includes(row.deployment_id) || !row.sandbox_id) continue;
    const batch = batches.find((item) => metadata(item).name === row.sandbox_id);
    if (batch) {
      if (metadata(batch).uid !== row.batch_uid)
        fail(`BatchSandbox UID conflicts with the control database: ${row.sandbox_id}.`);
      const identity = targetIdentity(batch, known);
      if (identity?.deployment !== row.deployment_id || identity.envId !== row.env_id)
        fail(`BatchSandbox labels conflict with the control database: ${row.sandbox_id}.`);
    }
    currentBatches.set(row.sandbox_id, row);
  }

  const targetBatches = batches.filter((item) => {
    const labels = metadata(item).labels;
    if (targetIdentity(item, known)) {
      if (labels['kairos.io/network-role'] !== 'tenant')
        fail(`Unexpected BatchSandbox network role: ${metadata(item).name}.`);
      const current = currentBatches.get(metadata(item).name);
      if (current && current.batch_uid !== metadata(item).uid)
        fail(`BatchSandbox UID changed: ${metadata(item).name}.`);
      return true;
    }
    if (currentBatches.has(metadata(item).name))
      fail(`Current BatchSandbox lacks deployment ownership: ${metadata(item).name}.`);
    return false;
  });
  const batchUids = new Set(targetBatches.map((item) => metadata(item).uid));
  const batchNames = new Set(targetBatches.map((item) => metadata(item).name));

  const targetSnapshots = resources.sandboxsnapshots.filter((item) => {
    const name = metadata(item).name;
    const sandboxName = item.spec?.sandboxName;
    const selected = metadata(item).owners.some(
      (owner) =>
        owner.kind === 'BatchSandbox' && batchUids.has(owner.uid) && owner.name === sandboxName,
    );
    if (selected && !batchNames.has(sandboxName))
      fail(`Snapshot ownership conflicts with its BatchSandbox: ${name}.`);
    if (!selected && batchNames.has(sandboxName))
      fail(`Snapshot lacks an exact BatchSandbox owner: ${name}.`);
    return selected;
  });
  const snapshotUids = new Set(targetSnapshots.map((item) => metadata(item).uid));

  const targetJobs = resources.jobs.filter((item) => {
    const snapshotOwned = metadata(item).owners.some(
      (owner) => owner.kind === 'SandboxSnapshot' && snapshotUids.has(owner.uid),
    );
    const identity = targetIdentity(item, known);
    if (identity) {
      const name = metadata(item).name;
      if (
        !name.startsWith(`kp-init-${identity.deployment}-`) ||
        !metadata(item).labels['kairos.io/bootstrap-operation']
      )
        fail(`Unrecognized deployment Job: ${name}.`);
    }
    return snapshotOwned || Boolean(identity);
  });
  const jobUids = new Set(targetJobs.map((item) => metadata(item).uid));

  const targetPods = resources.pods.filter((item) => {
    const owner = metadata(item).owners.find(
      (candidate) =>
        (candidate.kind === 'BatchSandbox' && batchUids.has(candidate.uid)) ||
        (candidate.kind === 'Job' && jobUids.has(candidate.uid)),
    );
    const identity = targetIdentity(item, known);
    if (identity && !owner) fail(`Deployment Pod lacks an exact owner: ${metadata(item).name}.`);
    return Boolean(owner || identity);
  });

  const targetPvcs = resources.persistentvolumeclaims.filter((item) => {
    const name = metadata(item).name;
    const identity = claimIdentity(name, known);
    if (identity) {
      const labels = metadata(item).labels;
      if (
        labels['kairos.io/deployment'] !== identity.deployment ||
        labels['kairos.io/env'] !== identity.envId
      )
        fail(`PVC labels conflict with its name: ${name}.`);
      return true;
    }
    if (targetIdentity(item, known))
      fail(`PVC name conflicts with its deployment labels: ${name}.`);
    return false;
  });
  const pvcByName = new Map(targetPvcs.map((item) => [metadata(item).name, item]));
  const targetPvs = resources.persistentvolumes.filter((item) => {
    const claim = item.spec?.claimRef;
    if (claim?.namespace !== NAMESPACE) return false;
    const identity = claimIdentity(claim.name, known);
    if (!identity) return false;
    const name = metadata(item).name;
    if (
      name !== `pvc-${claim.uid}` ||
      item.spec?.persistentVolumeReclaimPolicy !== 'Retain' ||
      item.spec?.storageClassName !== 'kairos-local-retain' ||
      item.spec?.hostPath?.path !== volumePath(claim.uid, claim.name)
    )
      fail(`PV identity or hostPath conflicts with its claim: ${name}.`);
    const pvc = pvcByName.get(claim.name);
    if (pvc && (metadata(pvc).uid !== claim.uid || pvc.spec?.volumeName !== name))
      fail(`PVC and PV claimRef differ: ${claim.name}.`);
    return true;
  });

  const targetSecrets = resources.secrets.filter((item) => {
    const identity = targetIdentity(item, known);
    if (!identity) return false;
    const name = metadata(item).name;
    if (
      !new RegExp(`^kp-init-${identity.deployment}-[a-f0-9]{16}$`).test(name) ||
      !metadata(item).labels['kairos.io/bootstrap-operation']
    )
      fail(`Unrecognized deployment Secret: ${name}.`);
    return true;
  });

  const batchByUid = new Map(
    targetBatches.map((item) => [metadata(item).uid, metadata(item).name]),
  );
  const images = targetSnapshots.flatMap((snapshot) => {
    const owner = metadata(snapshot).owners.find((candidate) => batchByUid.has(candidate.uid));
    return (snapshot.status?.containers ?? []).map((container) =>
      registryReference(metadata(snapshot).name, batchByUid.get(owner.uid), container),
    );
  });

  if (registryPvc) {
    const registryPv = resources.persistentvolumes.find(
      (item) =>
        item.spec?.claimRef?.namespace === 'kairos-registry' &&
        item.spec?.claimRef?.name === 'snapshots' &&
        item.spec?.claimRef?.uid === metadata(registryPvc).uid,
    );
    if (
      !registryPv ||
      metadata(registryPvc).name !== 'snapshots' ||
      registryPvc.spec?.volumeName !== metadata(registryPv).name ||
      registryPv.spec?.hostPath?.path !==
        `${VOLUMES}/pvc-${metadata(registryPvc).uid}_kairos-registry_snapshots`
    )
      fail('Registry volume identity changed.');
  }

  const selected = [
    ...targetPods.map((item) => descriptor('pods', item)),
    ...targetJobs.map((item) => descriptor('jobs', item)),
    ...targetSecrets.map((item) => descriptor('secrets', item)),
    ...targetSnapshots.map((item) => descriptor('sandboxsnapshots', item)),
    ...targetBatches.map((item) => descriptor('batchsandboxes', item)),
    ...targetPvcs.map((item) => descriptor('persistentvolumeclaims', item)),
    ...targetPvs.map((item) => descriptor('persistentvolumes', item)),
  ];
  const selectedKeys = new Set(selected.map((item) => `${item.kind}:${item.uid}`));
  const preserved = Object.entries(resources).flatMap(([kind, items]) =>
    items
      .filter((item) => !selectedKeys.has(`${kind}:${metadata(item).uid}`))
      .map((item) => descriptor(kind, item)),
  );
  return {
    environments: environments
      .filter((row) => DEPLOYMENTS.includes(row.deployment_id))
      .map((row) => ({
        deploymentId: row.deployment_id,
        envId: row.env_id,
        state: row.state,
        sandboxId: row.sandbox_id,
        batchUid: row.batch_uid,
      })),
    local: {
      data: DEPLOYMENTS.map((deployment) => `${ROOT}/${deployment}/data`),
      control: [CONTROL, `${CONTROL}-wal`, `${CONTROL}-shm`],
    },
    resources: selected,
    volumes: targetPvs.map((item) => ({
      pv: metadata(item).name,
      path: item.spec.hostPath.path,
    })),
    images,
    registryRoot: registryPvc
      ? resources.persistentvolumes.find(
          (item) =>
            item.spec?.claimRef?.namespace === 'kairos-registry' &&
            item.spec?.claimRef?.name === 'snapshots' &&
            item.spec?.claimRef?.uid === metadata(registryPvc).uid,
        )?.spec.hostPath.path
      : undefined,
    preserved,
  };
}

export function parseArguments(argv) {
  const execute = argv.includes('--execute');
  const dryRun = argv.includes('--dry-run');
  const confirmationIndex = argv.indexOf('--confirm-reset');
  const confirmation = confirmationIndex >= 0 ? argv[confirmationIndex + 1] : undefined;
  const allowed = new Set(['--execute', '--dry-run', '--confirm-reset', CONFIRMATION]);
  if (
    argv.some((argument) => !allowed.has(argument)) ||
    execute === dryRun ||
    (execute && confirmation !== CONFIRMATION)
  )
    fail(`Usage: reset-runtime.mjs --dry-run | --execute --confirm-reset "${CONFIRMATION}"`);
  return { execute };
}

function guard(args, input) {
  return execFileSync(GUARD, args, {
    encoding: 'utf8',
    input,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
    timeout: 120_000,
  });
}

function namespaced(kind) {
  return JSON.parse(guard(['kubectl', 'get', kind, '-n', NAMESPACE, '-o', 'json'])).items;
}

function clusterResources(kind) {
  return JSON.parse(guard(['kubectl', 'get', kind, '-o', 'json'])).items;
}

function secretMetadata() {
  const output = guard([
    'kubectl',
    'get',
    'secrets',
    '-n',
    NAMESPACE,
    '-o',
    'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.uid}{"\\t"}{.metadata.labels}{"\\n"}{end}',
  ]);
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, uid, labels] = line.split('\t');
      return {
        metadata: { name, uid, labels: labels ? JSON.parse(labels) : {} },
      };
    });
}

function readResources() {
  return {
    batchsandboxes: namespaced('batchsandboxes.sandbox.opensandbox.io'),
    sandboxsnapshots: namespaced('sandboxsnapshots.sandbox.opensandbox.io'),
    pods: namespaced('pods'),
    jobs: namespaced('jobs'),
    persistentvolumeclaims: namespaced('persistentvolumeclaims'),
    persistentvolumes: clusterResources('persistentvolumes'),
    secrets: secretMetadata(),
  };
}

function assertExactPath(path, expected) {
  if (resolve(path) !== expected || lstatSync(path).isSymbolicLink())
    fail(`Refusing a path outside the reviewed reset scope: ${path}.`);
  if (realpathSync(path) !== expected) fail(`Path resolves outside the reset scope: ${path}.`);
}

function assertStopped() {
  for (const deployment of DEPLOYMENTS) {
    const directory = `${ROOT}/${deployment}`;
    assertExactPath(directory, `${ROOT}/${deployment}`);
    for (const role of ['server', 'entry', 'legacy']) {
      for (const suffix of ['pid', 'runner.pid']) {
        if (existsSync(`${directory}/run/${role}.${suffix}`))
          fail(`${deployment} ${role} still has a process record.`);
      }
      if (!existsSync(`${directory}/run/${role}.stop`))
        fail(`${deployment} ${role} has not been stopped through kairos.sh.`);
    }
    if (!existsSync(`${directory}/run/maintenance`)) fail(`${deployment} is not in maintenance.`);
  }
}

export function resourceType(kind) {
  return (
    {
      batchsandboxes: 'batchsandboxes.sandbox.opensandbox.io',
      sandboxsnapshots: 'sandboxsnapshots.sandbox.opensandbox.io',
    }[kind] ?? kind
  );
}

function deleteResources(kind, items) {
  if (items.length === 0) return;
  const names = items.map((item) => item.name);
  const namespacedKind = kind !== 'persistentvolumes';
  guard([
    'kubectl',
    'delete',
    resourceType(kind),
    ...names,
    ...(namespacedKind ? ['-n', NAMESPACE] : []),
    '--wait=false',
    '--ignore-not-found=true',
  ]);
}

async function delay(ms) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitAbsent(kind, items) {
  const expected = new Set(items.map((item) => item.name));
  if (expected.size === 0) return;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const current =
      kind === 'persistentvolumes' ? clusterResources(kind) : namespaced(resourceType(kind));
    if (current.every((item) => !expected.has(metadata(item).name))) return;
    await delay(2000);
  }
  fail(`Timed out waiting for ${kind} deletion.`);
}

async function removeRegistryRepositories(plan) {
  if (plan.images.length === 0) return;
  if (!plan.registryRoot) fail('Snapshot registry storage evidence is required.');
  assertExactPath(plan.registryRoot, plan.registryRoot);
  const repositoryRoot = resolve(plan.registryRoot, 'docker/registry/v2/repositories');
  const paths = plan.images.map((image) => {
    const path = resolve(repositoryRoot, ...image.repository.split('/'));
    if (dirname(path) !== resolve(repositoryRoot, 'kairos'))
      fail('Invalid registry repository path.');
    if (existsSync(path)) assertExactPath(path, path);
    return path;
  });
  if (paths.every((path) => !existsSync(path))) return;
  let scaledDown = false;
  try {
    guard([
      'kubectl',
      'scale',
      'deployment',
      'snapshot-registry',
      '-n',
      'kairos-registry',
      '--replicas=0',
    ]);
    scaledDown = true;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const pods = JSON.parse(
        guard([
          'kubectl',
          'get',
          'pods',
          '-n',
          'kairos-registry',
          '-l',
          'app=snapshot-registry',
          '-o',
          'json',
        ]),
      ).items;
      if (pods.length === 0) break;
      await delay(1000);
    }
    const remaining = JSON.parse(
      guard([
        'kubectl',
        'get',
        'pods',
        '-n',
        'kairos-registry',
        '-l',
        'app=snapshot-registry',
        '-o',
        'json',
      ]),
    ).items;
    if (remaining.length !== 0) fail('Registry did not stop before repository removal.');
    for (const path of paths) {
      if (!existsSync(path)) continue;
      assertExactPath(path, path);
      if (!lstatSync(path).isDirectory()) fail(`Registry repository is not a directory: ${path}.`);
      rmSync(path, { recursive: true });
    }
  } finally {
    if (scaledDown) {
      guard([
        'kubectl',
        'scale',
        'deployment',
        'snapshot-registry',
        '-n',
        'kairos-registry',
        '--replicas=1',
      ]);
      guard([
        'kubectl',
        'rollout',
        'status',
        'deployment/snapshot-registry',
        '-n',
        'kairos-registry',
        '--timeout=120s',
      ]);
    }
  }
  for (const path of paths)
    if (existsSync(path)) fail(`Registry repository still exists: ${path}.`);
}

function removeLocalData() {
  for (const deployment of DEPLOYMENTS) {
    const directory = `${ROOT}/${deployment}`;
    const owner = statSync(directory);
    const data = `${directory}/data`;
    if (existsSync(data)) {
      assertExactPath(data, data);
      if (!lstatSync(data).isDirectory()) fail(`Data path is not a directory: ${data}.`);
      rmSync(data, { recursive: true });
    }
    mkdirSync(data, { mode: 0o700 });
    chownSync(data, owner.uid, owner.gid);
  }
}

function removeControl() {
  for (const suffix of ['-wal', '-shm']) {
    const path = `${CONTROL}${suffix}`;
    if (existsSync(path)) {
      assertExactPath(path, path);
      unlinkSync(path);
    }
  }
  if (existsSync(CONTROL)) {
    assertExactPath(CONTROL, CONTROL);
    unlinkSync(CONTROL);
  }
}

export async function main() {
  const { execute } = parseArguments(process.argv.slice(2));
  assertExactPath(ROOT, ROOT);
  if (execute) assertStopped();
  const database = new DatabaseSync(CONTROL, { readOnly: true });
  let environments;
  let operations;
  try {
    database.exec('PRAGMA query_only=ON');
    if (database.prepare('PRAGMA user_version').get().user_version !== 2)
      fail('Shared control schema is not version 2.');
    environments = database
      .prepare(
        'SELECT deployment_id,env_id,state,sandbox_id,batch_uid FROM platform_control_environments ORDER BY deployment_id,env_id',
      )
      .all();
    operations = database
      .prepare('SELECT deployment_id,env_id FROM platform_control_operations')
      .all();
  } finally {
    database.close();
  }
  const resources = readResources();
  const registryPvc = JSON.parse(
    guard([
      'kubectl',
      'get',
      'persistentvolumeclaim',
      'snapshots',
      '-n',
      'kairos-registry',
      '-o',
      'json',
    ]),
  );
  const plan = createResetPlan({ environments, operations, resources, registryPvc });
  if (!execute) {
    process.stdout.write(`${JSON.stringify({ status: 'dry_run', ...plan }, null, 2)}\n`);
    return;
  }
  await removeRegistryRepositories(plan);
  const batches = plan.resources.filter((item) => item.kind === 'batchsandboxes');
  deleteResources('batchsandboxes', batches);
  await waitAbsent('batchsandboxes', batches);
  for (const kind of ['sandboxsnapshots', 'jobs', 'secrets']) {
    deleteResources(
      kind,
      plan.resources.filter((item) => item.kind === kind),
    );
  }
  for (const kind of ['pods', 'sandboxsnapshots', 'jobs', 'secrets']) {
    await waitAbsent(
      kind,
      plan.resources.filter((item) => item.kind === kind),
    );
  }
  for (const kind of ['persistentvolumeclaims', 'persistentvolumes']) {
    deleteResources(
      kind,
      plan.resources.filter((item) => item.kind === kind),
    );
  }
  await waitAbsent(
    'persistentvolumeclaims',
    plan.resources.filter((item) => item.kind === 'persistentvolumeclaims'),
  );
  await waitAbsent(
    'persistentvolumes',
    plan.resources.filter((item) => item.kind === 'persistentvolumes'),
  );
  for (const volume of plan.volumes) {
    if (!existsSync(volume.path)) continue;
    assertExactPath(volume.path, volume.path);
    if (!lstatSync(volume.path).isDirectory())
      fail(`Volume path is not a directory: ${volume.path}.`);
    rmSync(volume.path, { recursive: true });
  }
  removeLocalData();
  removeControl();
  const remaining = readResources();
  for (const target of plan.resources) {
    if (remaining[target.kind].some((item) => metadata(item).name === target.name))
      fail(`A selected Kubernetes resource still exists: ${target.kind}/${target.name}.`);
  }
  for (const preserved of plan.preserved) {
    if (!remaining[preserved.kind].some((item) => metadata(item).uid === preserved.uid))
      fail(`A preserved Kubernetes resource changed: ${preserved.kind}/${preserved.name}.`);
  }
  process.stdout.write(
    `${JSON.stringify({ status: 'reset_complete', deleted: plan.resources, volumes: plan.volumes, images: plan.images, local: plan.local }, null, 2)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
