import assert from 'node:assert/strict';
import test from 'node:test';
import { createResetPlan, parseArguments, resourceType } from '../k1/reset-runtime.mjs';
import { fixture, VOLUMES } from './reset-runtime-fixture.mjs';

test('reset uses the reviewed OpenSandbox API group for deletion and reconciliation', () => {
  assert.equal(resourceType('batchsandboxes'), 'batchsandboxes.sandbox.opensandbox.io');
  assert.equal(resourceType('sandboxsnapshots'), 'sandboxsnapshots.sandbox.opensandbox.io');
  assert.equal(resourceType('pods'), 'pods');
});

test('reset dry-run selects only reviewed test/prod resources and preserves unrelated resources', () => {
  const plan = createResetPlan(fixture());
  assert.deepEqual(
    plan.resources.map((item) => `${item.kind}/${item.name}`).sort(),
    [
      'batchsandboxes/prod-sandbox',
      'batchsandboxes/test-sandbox',
      'jobs/kp-init-test-0123456789abcdef',
      'jobs/test-commit',
      'persistentvolumeclaims/kp-prod-env-2-identity',
      'persistentvolumeclaims/kp-test-env-1-workspace',
      'persistentvolumes/pvc-prod-pvc',
      'persistentvolumes/pvc-test-pvc',
      'pods/test-commit-pod',
      'pods/test-pod',
      'sandboxsnapshots/test-pause',
      'secrets/kp-init-test-0123456789abcdef',
    ].sort(),
  );
  assert.deepEqual(
    plan.images.map((item) => item.repository),
    ['kairos/test-sandbox-sandbox'],
  );
  assert.equal(plan.registryRoot, `${VOLUMES}/pvc-registry-pvc_kairos-registry_snapshots`);
  const preserved = new Set(plan.preserved.map((item) => `${item.kind}/${item.name}`));
  for (const name of [
    'batchsandboxes/p3-m0',
    'sandboxsnapshots/m0-pause',
    'persistentvolumeclaims/p3-m0-workspace',
    'persistentvolumeclaims/kairos-platform-program',
    'persistentvolumes/kairos-platform-program',
    'persistentvolumes/pvc-registry-pvc',
    'secrets/snapshot-pull',
  ])
    assert.ok(preserved.has(name), name);
});

test('reset rejects control and BatchSandbox UID conflicts before deletion', () => {
  const input = fixture();
  input.environments[0].batch_uid = 'different-batch';
  assert.throws(() => createResetPlan(input), /UID conflicts/);
});

test('reset rejects snapshots without exact owner evidence', () => {
  const input = fixture();
  input.resources.sandboxsnapshots[0].metadata.ownerReferences[0].uid = 'different-batch';
  assert.throws(() => createResetPlan(input), /exact BatchSandbox owner/);
});

test('reset rejects PVC label conflicts and unknown deployment environments', () => {
  const wrongLabel = fixture();
  wrongLabel.resources.persistentvolumeclaims[0].metadata.labels['kairos.io/env'] = 'env-other';
  assert.throws(() => createResetPlan(wrongLabel), /PVC labels conflict/);

  const unknown = fixture();
  unknown.resources.pods[0].metadata.labels['kairos.io/env'] = 'env-other';
  assert.throws(() => createResetPlan(unknown), /Unrecognized test environment/);
});

test('reset rejects a PV hostPath outside the fixed volume root', () => {
  const input = fixture();
  input.resources.persistentvolumes[0].spec.hostPath.path = '/etc';
  assert.throws(() => createResetPlan(input), /hostPath conflicts/);
});

test('reset rejects unexpected registry references', () => {
  const input = fixture();
  input.resources.sandboxsnapshots[0].status.containers[0].imageUri =
    '10.251.0.50:5000/other/test-sandbox-sandbox:snap-1';
  assert.throws(() => createResetPlan(input), /registry reference/);
});

test('reset requires an explicit environment confirmation for execution', () => {
  assert.deepEqual(parseArguments(['--dry-run']), { execute: false });
  assert.deepEqual(parseArguments(['--execute', '--confirm-reset', 'RESET test,prod']), {
    execute: true,
  });
  assert.throws(() => parseArguments(['--execute']), /Usage/);
  assert.throws(() => parseArguments(['--execute', '--confirm-reset', 'RESET prod']), /Usage/);
  assert.throws(
    () => parseArguments(['--dry-run', '--execute', '--confirm-reset', 'RESET test,prod']),
    /Usage/,
  );
});
