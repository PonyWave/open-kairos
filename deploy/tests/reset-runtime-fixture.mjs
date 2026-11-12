export const VOLUMES = '/var/lib/kairos-sandbox/volumes';

export function resource(name, uid, { labels, owners, spec, status } = {}) {
  return { metadata: { name, uid, labels, ownerReferences: owners }, spec, status };
}

function claim(deployment, envId, kind, uid) {
  const name = `kp-${deployment}-${envId}-${kind}`;
  const pvc = resource(name, uid, {
    labels: { 'kairos.io/deployment': deployment, 'kairos.io/env': envId },
    spec: { volumeName: `pvc-${uid}` },
  });
  const pv = resource(`pvc-${uid}`, `pv-${uid}`, {
    spec: {
      claimRef: { namespace: 'opensandbox', name, uid },
      persistentVolumeReclaimPolicy: 'Retain',
      storageClassName: 'kairos-local-retain',
      hostPath: { path: `${VOLUMES}/pvc-${uid}_opensandbox_${name}` },
    },
  });
  return { pvc, pv };
}

export function fixture() {
  const environments = [
    {
      deployment_id: 'test',
      env_id: 'env-1',
      state: 'paused',
      sandbox_id: 'test-sandbox',
      batch_uid: 'test-batch',
    },
    {
      deployment_id: 'prod',
      env_id: 'env-2',
      state: 'running',
      sandbox_id: 'prod-sandbox',
      batch_uid: 'prod-batch',
    },
  ];
  const testClaim = claim('test', 'env-1', 'workspace', 'test-pvc');
  const prodClaim = claim('prod', 'env-2', 'identity', 'prod-pvc');
  const registryPvc = resource('snapshots', 'registry-pvc', {
    spec: { volumeName: 'pvc-registry-pvc' },
  });
  const resources = {
    batchsandboxes: [
      resource('test-sandbox', 'test-batch', {
        labels: {
          'kairos.io/deployment': 'test',
          'kairos.io/env': 'env-1',
          'kairos.io/network-role': 'tenant',
        },
      }),
      resource('prod-sandbox', 'prod-batch', {
        labels: {
          'kairos.io/deployment': 'prod',
          'kairos.io/env': 'env-2',
          'kairos.io/network-role': 'tenant',
        },
      }),
      resource('p3-m0', 'm0-batch', { labels: { 'kairos.io/purpose': 'p3-m0' } }),
    ],
    sandboxsnapshots: [
      resource('test-pause', 'test-snapshot', {
        owners: [{ kind: 'BatchSandbox', name: 'test-sandbox', uid: 'test-batch' }],
        spec: { sandboxName: 'test-sandbox' },
        status: {
          containers: [
            {
              containerName: 'sandbox',
              imageUri: '10.251.0.50:5000/kairos/test-sandbox-sandbox:snap-1',
              imageDigest: `sha256:${'a'.repeat(64)}`,
            },
          ],
        },
      }),
      resource('m0-pause', 'm0-snapshot', {
        owners: [{ kind: 'BatchSandbox', name: 'p3-m0', uid: 'm0-batch' }],
        spec: { sandboxName: 'p3-m0' },
      }),
    ],
    jobs: [
      resource('test-commit', 'test-commit', {
        owners: [{ kind: 'SandboxSnapshot', name: 'test-pause', uid: 'test-snapshot' }],
      }),
      resource('kp-init-test-0123456789abcdef', 'test-bootstrap', {
        labels: {
          'kairos.io/deployment': 'test',
          'kairos.io/env': 'env-1',
          'kairos.io/bootstrap-operation': 'operation-1',
        },
      }),
    ],
    pods: [
      resource('test-pod', 'test-pod', {
        labels: { 'kairos.io/deployment': 'test', 'kairos.io/env': 'env-1' },
        owners: [{ kind: 'BatchSandbox', name: 'test-sandbox', uid: 'test-batch' }],
      }),
      resource('test-commit-pod', 'test-commit-pod', {
        owners: [{ kind: 'Job', name: 'test-commit', uid: 'test-commit' }],
      }),
    ],
    secrets: [
      resource('kp-init-test-0123456789abcdef', 'test-bootstrap-secret', {
        labels: {
          'kairos.io/deployment': 'test',
          'kairos.io/env': 'env-1',
          'kairos.io/bootstrap-operation': 'operation-1',
        },
      }),
      resource('snapshot-pull', 'snapshot-pull', { labels: {} }),
    ],
    persistentvolumeclaims: [
      testClaim.pvc,
      prodClaim.pvc,
      resource('kairos-platform-program', 'program-pvc', { labels: {}, spec: {} }),
      resource('p3-m0-workspace', 'm0-pvc', { labels: {}, spec: {} }),
    ],
    persistentvolumes: [
      testClaim.pv,
      prodClaim.pv,
      resource('kairos-platform-program', 'program-pv', {
        spec: {
          claimRef: {
            namespace: 'opensandbox',
            name: 'kairos-platform-program',
            uid: 'program-pvc',
          },
          hostPath: { path: `${VOLUMES}/program` },
        },
      }),
      resource('pvc-m0-pvc', 'm0-pv', {
        spec: {
          claimRef: { namespace: 'opensandbox', name: 'p3-m0-workspace', uid: 'm0-pvc' },
          hostPath: { path: `${VOLUMES}/pvc-m0-pvc_opensandbox_p3-m0-workspace` },
        },
      }),
      resource('pvc-registry-pvc', 'registry-pv', {
        spec: {
          claimRef: { namespace: 'kairos-registry', name: 'snapshots', uid: 'registry-pvc' },
          hostPath: { path: `${VOLUMES}/pvc-registry-pvc_kairos-registry_snapshots` },
        },
      }),
    ],
  };
  return { environments, operations: [], resources, registryPvc };
}
