import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEVICE_PROTOCOL_MAJOR,
  DeviceCapability,
  decodeServerMessage,
  encodeDaemonMessage,
  type ServerMessage,
} from '@kairos/contracts/device';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { DeviceChannel } from '../devices/channel.js';
import { EnvironmentOperationStore } from '../devices/environment-operation-store.js';
import { EnvironmentStore } from '../devices/environment-store.js';
import { registerDeviceWebSocket } from '../devices/websocket.js';
import { seedTestSession } from '../integration/test-authentication.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import {
  AbsentBootstrapAttemptError,
  type KubeObject,
  OpenSandboxBackend,
  type PlatformBackend,
  platformClaimName,
} from './backend.js';
import { initializePlatformControlDatabase } from './control-store.js';
import { type PlatformHelloAuthorizer, PlatformManager } from './manager.js';
import type { PhysicalEvidence } from './physical-observer.js';
import { ensureTenantPlatformEnvironment } from './registry.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const cluster = {
  caSha256: 'a'.repeat(64),
  nodeUid: 'node',
  nodeName: 'kairos-k1',
  namespace: 'opensandbox',
};
const evidence: PhysicalEvidence = {
  scope: { root: '/sys/fs/cgroup/test', rootInode: 1, podsInode: 2, kubepodsInode: 3, device: 1 },
  podUid: 'helper-pod',
  path: '/sys/fs/cgroup/test/pods/helper-pod',
  inode: 4,
  device: 1,
};
function fixture(idleTimeoutMs = 0) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kairos-manager-')));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'control.sqlite');
  initializePlatformControlDatabase({ path, capacity: 1, cluster, idleTimeoutMs });
  const db = openDatabase(':memory:');
  cleanup.push(() => db.close());
  seedTestSession(db, 'tenant', 'token');
  const envId = ensureTenantPlatformEnvironment(db, 'tenant');
  const batches: KubeObject[] = [];
  const create = vi.fn(async (input: { operationId: string }) => {
    batches.push({
      apiVersion: 'sandbox.opensandbox.io/v1alpha1',
      metadata: {
        name: 'sandbox',
        uid: 'batch',
        labels: {
          'kairos.io/env': envId,
          'kairos.io/deployment': 'test',
          'kairos.io/create-operation': input.operationId,
        },
      },
      spec: { replicas: 1 },
      status: { phase: 'Pending' },
    });
    throw new Error('Connection lost after create was accepted');
  });
  const backend: PlatformBackend = {
    verify: vi.fn(async () => undefined),
    listBatches: async () => batches,
    getBatch: async () => batches[0],
    listPods: async () => [],
    listSnapshots: async () => [],
    listJobs: async () => [],
    prepareStorage: vi.fn(async () => undefined),
    bootstrapHash: () => 'a'.repeat(64),
    prepareBootstrap: vi.fn(async () => ({
      job: {
        apiVersion: 'batch/v1',
        metadata: { name: 'helper', uid: 'helper-job' },
        status: { succeeded: 1 },
      },
      pods: [{ apiVersion: 'v1', metadata: { name: 'helper', uid: 'helper-pod' } }],
    })),
    cleanupBootstrap: vi.fn(async () => undefined),
    acknowledgeBootstrap: vi.fn(async () => undefined),
    acknowledgeSnapshotPod: vi.fn(async () => undefined),
    create,
    change: vi.fn(async () => undefined),
    verifyManifest: vi.fn(async () => undefined),
  };
  const options = {
    path,
    capacity: 1,
    cluster,
    deploymentId: 'test',
    backend,
    physicalObserver: {
      observe: async (podUid: string): Promise<PhysicalEvidence | undefined> => ({
        ...evidence,
        podUid,
      }),
      exited: async () => true,
    },
    operations: { ensureWorkspaceReady: vi.fn(async () => undefined) },
    pollIntervalMs: 5,
    preparationTimeoutMs: 100,
    idleTimeoutMs,
  };
  return { db, envId, options, backend, create, batches };
}

it.each([
  'running',
  'late-conflict',
  'pending-running',
  'pending-uid-change',
  'pending-owner-change',
  'pending-deleting',
  'pending-terminal',
  'pending-timeout',
  'pending-channel-timeout',
  'pending-disconnect',
  'restart-during-pause',
  'startup-success',
  'startup-failure',
  'startup-timeout',
  'startup-close',
  'startup-disconnect',
])(
  'keeps real HTTP/WSS platform authorization bounded through %s while create is in flight',
  async (scenario) => {
    const responseId = scenario === 'late-conflict' ? 'conflicting-late-response' : 'sandbox';
    const initiallyPending = scenario.startsWith('pending-');
    const startupPending = scenario.startsWith('startup-');
    const f = fixture();
    let manager = new PlatformManager(f.db, {
      ...f.options,
      sharedReleaseClaim: 'program',
      preparationTimeoutMs:
        scenario === 'pending-timeout' || scenario === 'startup-timeout' ? 150 : 2000,
    });
    let managerClosed = false;
    const environments = new EnvironmentStore(f.db);
    let server = Fastify({ logger: false });
    const authorizationDone = Promise.withResolvers<void>();
    const authorizationEntered = Promise.withResolvers<void>();
    const startupGate = Promise.withResolvers<void>();
    let startupResult: Promise<void> | undefined;
    let helloSignal: AbortSignal | undefined;
    const platform: PlatformHelloAuthorizer = {
      authorizeHello(input) {
        helloSignal = input.signal;
        authorizationEntered.resolve();
        const result = manager.authorizeHello(input);
        void result.then(
          () => authorizationDone.resolve(),
          () => authorizationDone.resolve(),
        );
        return result;
      },
    };
    const channel = new DeviceChannel({
      environments,
      environmentOperations: new EnvironmentOperationStore(f.db),
      platform,
      ...(scenario === 'pending-channel-timeout' ? { authenticationTimeoutMilliseconds: 150 } : {}),
    });
    registerDeviceWebSocket(server, channel);
    const entered = Promise.withResolvers<void>();
    const replyGate = Promise.withResolvers<void>();
    const order: string[] = [];
    const podUid = '11111111-1111-1111-1111-111111111111';
    const pods: KubeObject[] = [];
    let credential: string | undefined;
    const prepare = vi.mocked(f.backend.prepareBootstrap).getMockImplementation();
    if (!prepare) throw new Error('Missing helper fixture');
    vi.mocked(f.backend.prepareBootstrap).mockImplementation(async (input, signal) => {
      credential ??= input.pairingCredential;
      return prepare(input, signal);
    });
    f.backend.listPods = async (signal) => {
      signal.throwIfAborted();
      return structuredClone(pods);
    };
    server.post('/v1/sandboxes', async (request) => {
      const operationId = manager.control.get(f.envId)?.current_operation_id;
      expect(request.body).toMatchObject({
        metadata: { 'kairos.io/create-operation': operationId },
      });
      order.push('POST entered');
      f.batches.push({
        apiVersion: 'sandbox.opensandbox.io/v1alpha1',
        kind: 'BatchSandbox',
        metadata: {
          name: 'sandbox',
          uid: 'batch',
          labels: {
            'kairos.io/env': f.envId,
            'kairos.io/deployment': 'test',
            'kairos.io/create-operation': operationId ?? '',
          },
        },
        spec: { replicas: 1 },
        status: { phase: 'Running' },
      });
      const mounts = ['workspace', 'home', 'identity'].map((kind) => ({
        name: kind,
        mountPath:
          kind === 'workspace'
            ? '/workspace'
            : kind === 'home'
              ? '/home/agent'
              : '/var/lib/kairos-identity',
      }));
      pods.push({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: 'business-pod',
          uid: podUid,
          labels: { 'kairos.io/network-role': 'tenant' },
          ownerReferences: [{ uid: 'batch', name: 'sandbox', kind: 'BatchSandbox' }],
        },
        spec: {
          nodeName: cluster.nodeName,
          automountServiceAccountToken: false,
          securityContext: { runAsUser: 1000, runAsGroup: 1000, runAsNonRoot: true },
          volumes: [
            ...(['workspace', 'home', 'identity'] as const).map((kind) => ({
              name: kind,
              persistentVolumeClaim: { claimName: platformClaimName('test', f.envId, kind) },
            })),
            { name: 'program', persistentVolumeClaim: { claimName: 'program', readOnly: true } },
          ],
          containers: [
            {
              name: 'sandbox',
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
              volumeMounts: [
                ...mounts,
                { name: 'program', mountPath: '/opt/kairos-program', readOnly: true },
              ],
            },
          ],
        },
        status: { phase: initiallyPending ? 'Pending' : 'Running' },
      });
      entered.resolve();
      await replyGate.promise;
      order.push('POST returned');
      return { id: responseId };
    });
    cleanup.push(async () => {
      replyGate.resolve();
      startupGate.resolve();
      if (!managerClosed) await manager.close();
      await server.close();
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const apiKeyFile = join(dirname(f.options.path), 'api-key');
    await writeFile(apiKeyFile, 'test-api-key', { mode: 0o600 });
    const actualBackend = new OpenSandboxBackend({
      lifecycleUrl: `http://127.0.0.1:${address.port}`,
      apiKeyFile,
      kubernetesUrl: 'https://kube.invalid',
      kubernetesCaFile: '/unused',
      kubernetesTokenFile: '/unused',
      cluster,
      deploymentId: 'test',
      image: 'test-image',
      serverWssUrl: 'wss://server.invalid/devices/wss',
      sharedReleaseClaim: 'program',
      registryUrl: 'https://registry.invalid',
      registryCaFile: '/unused',
      registryCredentialsFile: '/unused',
    });
    f.backend.create = vi.fn((input, signal) => actualBackend.create(input, signal));
    if (startupPending) {
      const prior = manager.control.reserve({
        tenantId: 'tenant',
        envId: f.envId,
        usageId: 'run:held:1',
        kind: 'run',
      });
      const operationId = prior.current_operation_id ?? '';
      manager.control.claim(operationId);
      credential = environments.pairing.issue('tenant', f.envId).pairingCredential;
      const accepted = actualBackend.create(
        { tenantId: 'tenant', envId: f.envId, operationId },
        new AbortController().signal,
      );
      await entered.promise;
      replyGate.resolve();
      const sandboxId = await accepted;
      manager.control.associateCreatedSandbox({
        envId: f.envId,
        operationId,
        runtimeVersion: prior.runtime_version,
        sandboxId,
        batchUid: 'batch',
      });
      vi.mocked(f.backend.verify).mockImplementation(async (signal) => {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          void startupGate.promise.then(() => {
            signal.removeEventListener('abort', abort);
            resolve();
          }, reject);
          if (signal.aborted) abort();
        });
      });
      startupResult = manager.start();
      void startupResult.catch(() => undefined);
      expect(manager.start()).toBe(startupResult);
    } else {
      await manager.start();
      manager.reserveUse({
        tenantId: 'tenant',
        envId: f.envId,
        usageId: 'run:held:1',
        kind: 'run',
      });
    }
    await entered.promise;
    expect(manager.control.get(f.envId)?.sandbox_id).toBe(startupPending ? 'sandbox' : null);
    if (!credential) throw new Error('Pairing credential was not prepared');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/devices/wss`);
    const messages: ServerMessage[] = [];
    socket.on('message', (bytes: Buffer) => messages.push(decodeServerMessage(bytes)));
    cleanup.push(() => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(
      encodeDaemonMessage({
        payload: {
          case: 'deviceHello',
          value: {
            envId: f.envId,
            instanceId: 'instance',
            protocolMajor: DEVICE_PROTOCOL_MAJOR,
            daemonVersion: 'test',
            deviceName: 'platform',
            os: 'linux',
            architecture: 'x86_64',
            capabilities: [DeviceCapability.BASH, DeviceCapability.DIRECTORY_CHECK],
            platformPodUid: podUid,
            platformPodName: 'business-pod',
            authentication: { case: 'pairingCredential', value: credential },
          },
        },
      }),
    );
    if (startupPending) {
      await authorizationEntered.promise;
      expect(messages).toEqual([]);
      expect(environments.get('tenant', f.envId)).toMatchObject({
        bindingStatus: 'pairing',
        connectionStatus: 'offline',
        capabilityStatus: 'pending',
      });
      expect(
        f.db
          .prepare(
            'SELECT COUNT(*) AS n FROM environment_pairing_credentials WHERE consumed_at IS NOT NULL',
          )
          .get(),
      ).toMatchObject({ n: 0 });
      expect(() =>
        manager.reserveUse({
          tenantId: 'tenant',
          envId: f.envId,
          usageId: 'run:premature:1',
          kind: 'run',
        }),
      ).toThrowError(expect.objectContaining({ code: 'sandbox_unavailable' }));
      expect(f.backend.verify).toHaveBeenCalledTimes(1);
      if (scenario === 'startup-success') {
        startupGate.resolve();
        await startupResult;
      } else {
        if (scenario === 'startup-failure')
          startupGate.reject(new Error('Cluster startup verification failed'));
        if (scenario === 'startup-close') {
          await manager.close();
          managerClosed = true;
        }
        if (scenario === 'startup-disconnect') socket.terminate();
        await authorizationDone.promise;
        expect(messages.some((message) => message.payload.case === 'serverHello')).toBe(false);
        expect(environments.get('tenant', f.envId)).toMatchObject({
          bindingStatus: 'pairing',
          connectionStatus: 'offline',
          capabilityStatus: 'pending',
        });
        expect(
          f.db
            .prepare(
              'SELECT COUNT(*) AS n FROM environment_pairing_credentials WHERE consumed_at IS NOT NULL',
            )
            .get(),
        ).toMatchObject({ n: 0 });
        expect(f.backend.verify).toHaveBeenCalledTimes(1);
        expect(f.backend.create).not.toHaveBeenCalled();
        if (scenario === 'startup-failure') {
          await expect(startupResult).rejects.toThrow('Cluster startup verification failed');
          await vi.waitFor(() =>
            expect(
              messages.find((message) => message.payload.case === 'error')?.payload.value,
            ).toMatchObject({ message: 'Platform lifecycle startup failed.' }),
          );
        }
        return;
      }
    }
    if (initiallyPending) {
      await vi.waitFor(() => expect(manager.control.get(f.envId)?.sandbox_id).toBe('sandbox'));
      expect(messages.some((message) => message.payload.case === 'serverHello')).toBe(false);
      expect(environments.get('tenant', f.envId)).toMatchObject({
        bindingStatus: 'pairing',
        capabilityStatus: 'pending',
      });
      expect(manager.control.get(f.envId)?.instance_id).toBeNull();
      const pod = pods[0];
      if (!pod) throw new Error('Missing controlled Pod');
      if (scenario === 'pending-running') pod.status = { phase: 'Running' };
      else if (scenario === 'pending-uid-change')
        pod.metadata.uid = '22222222-2222-2222-2222-222222222222';
      else if (scenario === 'pending-owner-change')
        pod.metadata.ownerReferences = [{ uid: 'other', name: 'other', kind: 'BatchSandbox' }];
      else if (scenario === 'pending-deleting')
        pod.metadata.deletionTimestamp = new Date().toISOString();
      else if (scenario === 'pending-terminal') pod.status = { phase: 'Failed' };
      else if (scenario === 'pending-disconnect') socket.terminate();
      if (scenario !== 'pending-running') {
        await authorizationDone.promise;
        expect(messages.some((message) => message.payload.case === 'serverHello')).toBe(false);
        expect(environments.get('tenant', f.envId)).toMatchObject({
          bindingStatus: 'pairing',
          connectionStatus: 'offline',
          capabilityStatus: 'pending',
        });
        expect(manager.control.get(f.envId)?.instance_id).toBeNull();
        expect(
          f.db
            .prepare(
              'SELECT COUNT(*) AS n FROM environment_pairing_credentials WHERE consumed_at IS NOT NULL',
            )
            .get(),
        ).toMatchObject({ n: 0 });
        if (scenario === 'pending-disconnect' || scenario === 'pending-channel-timeout')
          expect(helloSignal?.aborted).toBe(true);
        else if (scenario !== 'pending-timeout') {
          const expected =
            scenario === 'pending-uid-change'
              ? 'UID or name changed'
              : scenario === 'pending-owner-change'
                ? 'no owner Pod'
                : scenario === 'pending-deleting'
                  ? 'being deleted'
                  : 'terminal phase Failed';
          await vi.waitFor(() =>
            expect(
              messages.find((message) => message.payload.case === 'error')?.payload.value,
            ).toMatchObject({ message: expect.stringContaining(expected) }),
          );
        }
        replyGate.resolve();
        return;
      }
    }
    await vi.waitFor(() =>
      expect(messages.some((message) => message.payload.case === 'serverHello')).toBe(true),
    );
    order.push('Hello paired');
    expect(order).toEqual(
      startupPending
        ? ['POST entered', 'POST returned', 'Hello paired']
        : ['POST entered', 'Hello paired'],
    );
    expect(environments.get('tenant', f.envId)).toMatchObject({
      bindingStatus: 'active',
      connectionStatus: 'online',
      instanceId: 'instance',
    });
    expect(manager.control.get(f.envId)).toMatchObject({
      sandbox_id: 'sandbox',
      batch_uid: 'batch',
      pod_uid: podUid,
      instance_id: 'instance',
    });
    const hello = {
      tenantId: 'tenant',
      envId: f.envId,
      instanceId: 'instance',
      podName: 'business-pod',
      podUid,
      controlOnly: false,
      signal: new AbortController().signal,
    };
    await expect(manager.authorizeHello({ ...hello, podUid: 'old-pod' })).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(
      manager.authorizeHello({ ...hello, instanceId: 'new-instance' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    replyGate.resolve();
    await vi.waitFor(() =>
      expect(manager.control.get(f.envId)?.state).toBe(
        responseId === 'sandbox' ? 'running' : 'error',
      ),
    );
    expect(order).toEqual(
      startupPending
        ? ['POST entered', 'POST returned', 'Hello paired']
        : ['POST entered', 'Hello paired', 'POST returned'],
    );
    expect(manager.control.get(f.envId)).toMatchObject({
      sandbox_id: 'sandbox',
      batch_uid: 'batch',
    });
    expect(f.backend.create).toHaveBeenCalledTimes(startupPending ? 0 : 1);
    expect(messages.filter((message) => message.payload.case === 'operationStart')).toEqual([]);
    if (scenario === 'restart-during-pause') {
      const initialHello = messages.find((message) => message.payload.case === 'serverHello');
      if (
        initialHello?.payload.case !== 'serverHello' ||
        !initialHello.payload.value.deviceCredential
      )
        throw new Error('Missing real initial pairing response');
      const identity = initialHello.payload.value;
      const savedDeviceCredential = identity.deviceCredential;
      const initialPairingCredential = credential;
      if (!savedDeviceCredential || !initialPairingCredential)
        throw new Error('Missing saved test credentials');
      let sourceGone = false;
      let workerGone = false;
      const workerUid = '22222222-2222-2222-2222-222222222222';
      f.options.physicalObserver.exited = async (physical?: PhysicalEvidence) =>
        physical?.podUid === podUid
          ? sourceGone
          : physical?.podUid === workerUid
            ? workerGone
            : true;
      const snapshot: KubeObject = {
        apiVersion: 'sandbox.opensandbox.io/v1alpha1',
        metadata: {
          name: 'sandbox-pause',
          uid: 'snapshot',
          ownerReferences: [{ uid: 'batch', name: 'sandbox', kind: 'BatchSandbox' }],
        },
        status: { phase: 'Committing' },
      };
      const job: KubeObject = {
        apiVersion: 'batch/v1',
        metadata: {
          name: 'commit',
          uid: 'commit',
          ownerReferences: [{ uid: 'snapshot', name: 'sandbox-pause', kind: 'SandboxSnapshot' }],
        },
      };
      const worker: KubeObject = {
        apiVersion: 'v1',
        metadata: {
          name: 'commit-pod',
          uid: workerUid,
          ownerReferences: [{ uid: 'commit', name: 'commit', kind: 'Job' }],
        },
        spec: { nodeName: cluster.nodeName },
        status: { phase: 'Pending' },
      };
      f.backend.listSnapshots = async () => [snapshot];
      f.backend.listJobs = async () => [job];
      vi.mocked(f.backend.acknowledgeSnapshotPod).mockImplementation(async () => {
        worker.metadata.annotations = { 'kairos.io/physical-observed': workerUid };
      });
      vi.mocked(f.backend.change).mockImplementation(async (_id, kind) => {
        if (kind !== 'pause') throw new Error('Unexpected lifecycle operation');
        const batch = f.batches[0];
        if (!batch) throw new Error('Missing original Batch');
        batch.status = { phase: 'Pausing' };
        pods.push(worker);
      });
      manager.releaseUse({
        tenantId: 'tenant',
        envId: f.envId,
        usageId: 'run:held:1',
        kind: 'run',
      });
      await vi.waitFor(() => expect(f.backend.acknowledgeSnapshotPod).toHaveBeenCalledTimes(1));
      const originalPause = manager.control.get(f.envId);
      expect(originalPause?.state).toBe('pausing');
      await manager.close();
      await server.close();

      manager = new PlatformManager(f.db, {
        ...f.options,
        sharedReleaseClaim: 'program',
        preparationTimeoutMs: 2000,
      });
      server = Fastify({ logger: false });
      registerDeviceWebSocket(
        server,
        new DeviceChannel({
          environments,
          environmentOperations: new EnvironmentOperationStore(f.db),
          platform: manager,
        }),
      );
      await server.listen({ host: '127.0.0.1', port: address.port });
      await manager.start();
      const reconnect = async (instanceId: string, initialPairing = false) => {
        const peer = new WebSocket(`ws://127.0.0.1:${address.port}/devices/wss`);
        cleanup.push(() => peer.terminate());
        const observed: ServerMessage[] = [];
        peer.on('message', (bytes: Buffer) => observed.push(decodeServerMessage(bytes)));
        await new Promise<void>((resolve, reject) => {
          peer.once('open', resolve);
          peer.once('error', reject);
        });
        peer.send(
          encodeDaemonMessage({
            payload: {
              case: 'deviceHello',
              value: {
                envId: f.envId,
                instanceId,
                protocolMajor: DEVICE_PROTOCOL_MAJOR,
                daemonVersion: 'test',
                deviceName: 'platform',
                os: 'linux',
                architecture: 'x86_64',
                platformPodUid: podUid,
                platformPodName: 'business-pod',
                capabilities: [DeviceCapability.BASH, DeviceCapability.DIRECTORY_CHECK],
                ...(initialPairing
                  ? {
                      authentication: {
                        case: 'pairingCredential' as const,
                        value: initialPairingCredential,
                      },
                    }
                  : {
                      deviceId: identity.deviceId,
                      deviceBindingId: identity.deviceBindingId,
                      authentication: {
                        case: 'deviceCredential' as const,
                        value: savedDeviceCredential,
                      },
                    }),
              },
            },
          }),
        );
        await vi.waitFor(() =>
          expect(
            observed.some(
              (message) =>
                message.payload.case === 'serverHello' || message.payload.case === 'error',
            ),
          ).toBe(true),
        );
        return { peer, observed };
      };
      const rejected = await reconnect('new-instance');
      expect(rejected.observed.some((message) => message.payload.case === 'serverHello')).toBe(
        false,
      );
      expect(
        rejected.observed.find((message) => message.payload.case === 'error')?.payload.value,
      ).toMatchObject({ message: expect.stringContaining('recorded existing bound runtime') });
      const unpaired = await reconnect('instance', true);
      expect(unpaired.observed.some((message) => message.payload.case === 'serverHello')).toBe(
        false,
      );
      await expect(manager.authorizeHello({ ...hello })).rejects.toMatchObject({
        code: 'permission_denied',
      });
      const accepted = await reconnect('instance');
      expect(accepted.observed.some((message) => message.payload.case === 'serverHello')).toBe(
        true,
      );
      expect(accepted.observed.some((message) => message.payload.case === 'operationStart')).toBe(
        false,
      );
      expect(manager.control.get(f.envId)).toMatchObject({
        state: 'pausing',
        current_operation_id: originalPause?.current_operation_id,
        instance_id: 'instance',
        pod_uid: podUid,
        runtime_version: originalPause?.runtime_version,
      });
      expect(manager.control.useCount(f.envId)).toBe(0);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM environment_operations').get()).toMatchObject({
        n: 0,
      });

      const batch = f.batches[0];
      if (!batch) throw new Error('Missing original Batch after restart');
      batch.status = { phase: 'Paused' };
      snapshot.status = {
        phase: 'Succeed',
        containers: [
          {
            containerName: 'sandbox',
            imageUri: 'registry/image:snapshot',
            imageDigest: `sha256:${'a'.repeat(64)}`,
          },
        ],
      };
      pods.splice(0);
      sourceGone = true;
      await vi.waitFor(() => expect(f.backend.verifyManifest).toHaveBeenCalled());
      expect(manager.control.get(f.envId)?.state).toBe('pausing');
      workerGone = true;
      await vi.waitFor(() => expect(manager.control.get(f.envId)?.state).toBe('paused'));
      expect(
        manager.control.database
          .prepare(
            'SELECT COUNT(*) AS n FROM platform_control_slots WHERE deployment_id IS NOT NULL',
          )
          .get(),
      ).toMatchObject({ n: 0 });
      expect(f.backend.change).toHaveBeenCalledTimes(1);
      expect(f.backend.create).toHaveBeenCalledTimes(1);
    }
  },
);

it('refuses platform reservations before control-plane reconciliation and after a failed start', async () => {
  const f = fixture();
  const manager = new PlatformManager(f.db, f.options);
  cleanup.push(() => manager.close());
  const use = { tenantId: 'tenant', envId: f.envId, usageId: 'run:1', kind: 'run' as const };
  expect(() => manager.reserveUse(use)).toThrowError(
    expect.objectContaining({ code: 'sandbox_unavailable' }),
  );
  expect(manager.control.listAll()).toEqual([]);
  vi.mocked(f.backend.verify).mockRejectedValueOnce(new Error('Cluster identity mismatch'));
  await expect(manager.start()).rejects.toThrow('Cluster identity mismatch');
  expect(() => manager.reserveUse(use)).toThrowError(
    expect.objectContaining({ code: 'sandbox_unavailable' }),
  );
  expect(manager.control.listAll()).toEqual([]);
});

it('persists an unknown create, reports unavailable without replay, and finds the same sandbox after restart', async () => {
  const f = fixture();
  let manager = new PlatformManager(f.db, f.options);
  await manager.start();
  const use = { tenantId: 'tenant', envId: f.envId, usageId: 'run:1', kind: 'run' as const };
  manager.reserveUse(use);
  await vi.waitFor(() => expect(manager.control.get(f.envId)?.state).toBe('error'));
  expect(f.create).toHaveBeenCalledTimes(1);
  await expect(
    manager.ensureReady({ ...use, signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: 'sandbox_unavailable' });
  expect(f.create).toHaveBeenCalledTimes(1);
  const op = manager.control.get(f.envId)?.current_operation_id ?? '';
  expect(manager.control.operation(op).status).toBe('unknown');
  await manager.close();
  manager = new PlatformManager(f.db, f.options);
  cleanup.push(() => manager.close());
  await manager.start();
  await vi.waitFor(() => expect(manager.control.get(f.envId)?.sandbox_id).toBe('sandbox'));
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(manager.control.operation(op).status).toBe('unknown');
});

it('does not mark create dispatched when helper preparation fails and rejects unknown managed resources globally', async () => {
  const f = fixture();
  vi.mocked(f.backend.prepareStorage).mockRejectedValueOnce(new Error('PVC unavailable'));
  const manager = new PlatformManager(f.db, f.options);
  cleanup.push(() => manager.close());
  await manager.start();
  manager.reserveUse({ tenantId: 'tenant', envId: f.envId, usageId: 'run:1', kind: 'run' });
  await vi.waitFor(() => expect(manager.control.get(f.envId)?.state).toBe('error'));
  const op = manager.control.get(f.envId)?.current_operation_id ?? '';
  expect(manager.control.operation(op).status).toBe('prepared');
  expect(f.create).not.toHaveBeenCalled();
  const second = fixture();
  second.batches.push({
    apiVersion: 'sandbox.opensandbox.io/v1alpha1',
    metadata: {
      name: 'foreign',
      uid: 'foreign',
      labels: { 'kairos.io/deployment': 'prod', 'kairos.io/env': 'orphan' },
    },
  });
  const blocked = new PlatformManager(second.db, second.options);
  cleanup.push(() => blocked.close());
  await expect(blocked.start()).rejects.toThrow('unassociated');
  const unlabeled = fixture();
  unlabeled.batches.push({
    apiVersion: 'sandbox.opensandbox.io/v1alpha1',
    metadata: { name: 'unlabeled', uid: 'u' },
    status: { phase: 'Succeed' },
  });
  const rejected = new PlatformManager(unlabeled.db, unlabeled.options);
  cleanup.push(() => rejected.close());
  await expect(rejected.start()).rejects.toThrow('unassociated active');
});

it('recovers terminal run generations and interrupted reloads from both sides of the prepared/reserved commit window', async () => {
  const f = fixture();
  const sessions = new SessionStore(f.db);
  const main = sessions.getOrCreateMainThread('tenant');
  const sent = sessions.sendMessage({
    ownerId: 'tenant',
    clientActionId: 'message',
    method: 'SendMessage',
    parameters: { text: 'task' },
    threadId: main.threadId,
    text: 'task',
    mode: 'follow_up',
  });
  f.db.prepare("UPDATE runs SET status='interrupted' WHERE run_id=?").run(sent.runId);
  f.db
    .prepare(
      "INSERT INTO client_actions(owner_id,client_action_id,method,fingerprint,response_json,created_at) VALUES ('tenant','reload','ReloadEnvironmentResources','f',?,?)",
    )
    .run(
      JSON.stringify({
        status: 'interrupted',
        error: { code: 'operation_unknown', message: 'restart', retryable: true },
      }),
      new Date().toISOString(),
    );
  const manager = new PlatformManager(f.db, f.options);
  cleanup.push(() => manager.close());
  for (const [usageId, kind, status] of [
    [`run:${sent.runId}:1`, 'run', 'prepared'],
    ['reload:tenant:reload', 'reload', 'reserved'],
  ] as const) {
    manager.control.reserve({ tenantId: 'tenant', envId: f.envId, usageId, kind });
    f.db
      .prepare(
        'INSERT INTO platform_usage_intents(env_id,usage_id,tenant_id,kind,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        f.envId,
        usageId,
        'tenant',
        kind,
        status,
        new Date().toISOString(),
        new Date().toISOString(),
      );
  }
  await manager.start();
  expect(manager.control.useCount(f.envId)).toBe(0);
  expect(
    f.db.prepare("SELECT COUNT(*) AS n FROM platform_usage_intents WHERE status<>'released'").get(),
  ).toMatchObject({ n: 0 });
});

it('persists helper physical evidence before ACK and resumes cleanup by original UID after cleanup acceptance and a crash', async () => {
  const f = fixture();
  let manager = new PlatformManager(f.db, f.options);
  vi.mocked(f.backend.acknowledgeBootstrap).mockImplementation(async () => {
    const saved = JSON.parse(manager.control.get(f.envId)?.preparation_json ?? '{}');
    expect(saved.job.metadata.uid).toBe('helper-job');
    expect(saved.physical[0].inode).toBe(4);
  });
  vi.mocked(f.backend.cleanupBootstrap).mockRejectedValueOnce(
    new Error('Crash after DELETE accepted'),
  );
  await manager.start();
  manager.reserveUse({ tenantId: 'tenant', envId: f.envId, usageId: 'run:pending:1', kind: 'run' });
  await vi.waitFor(() => expect(manager.control.get(f.envId)?.state).toBe('error'));
  expect(f.create).not.toHaveBeenCalled();
  await manager.close();
  const preparations = vi.mocked(f.backend.prepareBootstrap).mock.calls.length;
  manager = new PlatformManager(f.db, f.options);
  cleanup.push(() => manager.close());
  await manager.start();
  await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1));
  expect(f.backend.prepareBootstrap).toHaveBeenCalledTimes(preparations);
  expect(f.backend.cleanupBootstrap).toHaveBeenCalledTimes(2);
});

it('finishes a previously observed pause after Server restart and Job TTL removal without re-sending pause', async () => {
  const f = fixture();
  const manager = new PlatformManager(f.db, f.options);
  cleanup.push(() => manager.close());
  const use = { tenantId: 'tenant', envId: f.envId, usageId: 'run:ended:1', kind: 'run' as const };
  const accepted = manager.control.reserve(use);
  const create = accepted.current_operation_id ?? '';
  manager.control.claim(create);
  manager.control.complete(f.envId, create, {
    state: 'running',
    sandbox_id: 'sandbox',
    batch_uid: 'batch',
    pod_uid: 'old-pod',
    instance_id: 'old-instance',
    leaf_json: JSON.stringify({ ...evidence, podUid: 'old-pod' }),
  });
  manager.control.release(use);
  manager.control.prepareIdlePause(f.envId);
  const pause = manager.control.get(f.envId)?.current_operation_id ?? '';
  manager.control.claim(pause);
  const snapshot = {
    uid: 'snapshot',
    sourcePodUid: 'old-pod',
    sourceInstanceId: 'old-instance',
    images: [
      {
        containerName: 'sandbox',
        imageUri: 'registry/image:snap',
        imageDigest: `sha256:${'a'.repeat(64)}`,
      },
    ],
    jobs: [{ uid: 'job', podUid: 'worker-pod', physical: { ...evidence, podUid: 'worker-pod' } }],
    sourcePhysical: { ...evidence, podUid: 'old-pod' },
  };
  manager.control.update(f.envId, { snapshot_json: JSON.stringify(snapshot) });
  f.batches.push({
    apiVersion: 'sandbox.opensandbox.io/v1alpha1',
    metadata: {
      name: 'sandbox',
      uid: 'batch',
      labels: { 'kairos.io/deployment': 'test', 'kairos.io/env': f.envId },
    },
    spec: { replicas: 1 },
    status: { phase: 'Paused' },
  });
  f.backend.listSnapshots = async () => [
    {
      apiVersion: 'sandbox.opensandbox.io/v1alpha1',
      metadata: {
        name: 'sandbox-pause',
        uid: 'snapshot',
        ownerReferences: [{ uid: 'batch', kind: 'BatchSandbox', name: 'sandbox' }],
      },
      spec: { sandboxName: 'sandbox' },
      status: { phase: 'Succeed', containers: snapshot.images },
    },
  ];
  await manager.start();
  await vi.waitFor(() => expect(manager.control.get(f.envId)?.state).toBe('paused'));
  expect(f.backend.change).not.toHaveBeenCalled();
  expect(
    manager.control.database
      .prepare('SELECT COUNT(*) AS n FROM platform_control_slots WHERE deployment_id IS NOT NULL')
      .get(),
  ).toMatchObject({ n: 0 });
});

it('recognizes the full native Snapshot Job owner chain while an observation gate waits across restart', async () => {
  const f = fixture();
  const manager = new PlatformManager(f.db, f.options);
  cleanup.push(() => manager.close());
  const use = { tenantId: 'tenant', envId: f.envId, usageId: 'run:done:1', kind: 'run' as const };
  const accepted = manager.control.reserve(use);
  const create = accepted.current_operation_id ?? '';
  manager.control.claim(create);
  manager.control.complete(f.envId, create, {
    state: 'running',
    sandbox_id: 'sandbox',
    batch_uid: 'batch',
    pod_uid: 'source',
    instance_id: 'instance',
    leaf_json: JSON.stringify(evidence),
  });
  manager.control.release(use);
  manager.control.prepareIdlePause(f.envId);
  manager.control.claim(manager.control.get(f.envId)?.current_operation_id ?? '');
  f.batches.push({
    apiVersion: 'sandbox.opensandbox.io/v1alpha1',
    metadata: {
      name: 'sandbox',
      uid: 'batch',
      labels: { 'kairos.io/deployment': 'test', 'kairos.io/env': f.envId },
    },
    spec: { replicas: 1 },
    status: { phase: 'Pausing' },
  });
  f.backend.listSnapshots = async () => [
    {
      apiVersion: 'sandbox.opensandbox.io/v1alpha1',
      metadata: {
        name: 'snapshot',
        uid: 'snapshot',
        ownerReferences: [{ uid: 'batch', name: 'sandbox', kind: 'BatchSandbox' }],
      },
      status: { phase: 'Committing' },
    },
  ];
  f.backend.listJobs = async () => [
    {
      apiVersion: 'batch/v1',
      metadata: {
        name: 'commit',
        uid: 'commit',
        ownerReferences: [{ uid: 'snapshot', name: 'snapshot', kind: 'SandboxSnapshot' }],
      },
    },
  ];
  f.backend.listPods = async () => [
    {
      apiVersion: 'v1',
      metadata: {
        name: 'worker',
        uid: 'worker',
        ownerReferences: [{ uid: 'commit', name: 'commit', kind: 'Job' }],
      },
      spec: { nodeName: 'kairos-k1' },
      status: { phase: 'Pending' },
    },
  ];
  await expect(manager.start()).resolves.toBeUndefined();
  await vi.waitFor(() => expect(f.backend.acknowledgeSnapshotPod).toHaveBeenCalled());
  expect(f.backend.change).not.toHaveBeenCalled();
});

it.each(['never-wrote', 'wrote-before-ack-timeout'] as const)(
  'retries only explicit prepared %s helper failures under the same slot and create operation',
  async (mode) => {
    const f = fixture();
    const manager = new PlatformManager(f.db, f.options);
    cleanup.push(() => manager.close());
    let oldInput: { operationId: string } | undefined;
    const failedPod = '11111111-1111-1111-1111-111111111111';
    const successfulPod = '22222222-2222-2222-2222-222222222222';
    f.options.physicalObserver.observe = async (podUid) =>
      podUid === failedPod && mode === 'never-wrote' ? undefined : { ...evidence, podUid };
    Object.assign(f.options.physicalObserver, {
      retiredHelper: async (podUid: string) => ({
        scope: evidence.scope,
        podUid,
        candidatePaths: [`/fake/qos/pod${podUid}`],
        kind: 'retired_helper_no_processes' as const,
      }),
    });
    vi.mocked(f.backend.prepareBootstrap).mockImplementation(async (input) => {
      const saved = JSON.parse(manager.control.get(f.envId)?.preparation_json ?? '{}');
      if (input.attemptId) {
        expect(saved.attemptId).toBe(input.attemptId);
        expect(saved.bootstrapSha256).toBe('a'.repeat(64));
        expect(input.operationId).toBe(oldInput?.operationId);
        expect(input.replacesSha256s).toContain('a'.repeat(64));
      } else oldInput = input;
      const uid = input.attemptId ? 'new-helper' : 'old-helper';
      const podUid = input.attemptId ? successfulPod : failedPod;
      return {
        job: {
          apiVersion: 'batch/v1',
          metadata: {
            name: uid,
            uid,
            labels: {
              'kairos.io/env': f.envId,
              'kairos.io/deployment': 'test',
              'kairos.io/bootstrap-operation': input.operationId,
              ...(input.attemptId ? { 'kairos.io/bootstrap-attempt': input.attemptId } : {}),
            },
          },
          spec: { backoffLimit: 0 },
          status: input.attemptId ? { succeeded: 1 } : { failed: 1 },
        },
        pods: [
          {
            apiVersion: 'v1',
            metadata: {
              name: `${uid}-pod`,
              uid: podUid,
              ownerReferences: [{ name: uid, uid, kind: 'Job' }],
            },
            spec: { nodeName: 'kairos-k1' },
            status: {
              phase: input.attemptId ? 'Succeeded' : 'Failed',
              containerStatuses: [
                {
                  state: {
                    terminated: {
                      exitCode: input.attemptId ? 0 : mode === 'never-wrote' ? 127 : 1,
                    },
                  },
                },
              ],
            },
          },
        ],
      };
    });
    await manager.start();
    manager.reserveUse({ tenantId: 'tenant', envId: f.envId, usageId: 'run:first:1', kind: 'run' });
    await vi.waitFor(() => expect(manager.control.get(f.envId)?.state).toBe('error'));
    const original = manager.control.get(f.envId)?.current_operation_id;
    expect(f.create).not.toHaveBeenCalled();
    const credentialsBefore = f.db
      .prepare(
        'SELECT COUNT(*) AS n FROM environment_pairing_credentials WHERE invalidated_at IS NULL',
      )
      .get();
    expect(credentialsBefore).toMatchObject({ n: 1 });
    manager.reserveUse({
      tenantId: 'tenant',
      envId: f.envId,
      usageId: 'run:explicit-continue:2',
      kind: 'run',
    });
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1));
    expect(manager.control.get(f.envId)?.current_operation_id).toBe(original);
    expect(
      manager.control.database
        .prepare('SELECT COUNT(*) AS n FROM platform_control_slots WHERE deployment_id IS NOT NULL')
        .get(),
    ).toMatchObject({ n: 1 });
    expect(
      f.db
        .prepare(
          'SELECT COUNT(*) AS n FROM environment_pairing_credentials WHERE invalidated_at IS NULL',
        )
        .get(),
    ).toMatchObject({ n: 1 });
    expect(
      f.db
        .prepare(
          'SELECT COUNT(*) AS n FROM environment_pairing_credentials WHERE invalidated_at IS NOT NULL',
        )
        .get(),
    ).toMatchObject({ n: 1 });
  },
);

it('recovers a persisted credential hash before the first helper POST only after a new explicit use confirms the attempt absent', async () => {
  const f = fixture();
  let manager = new PlatformManager(f.db, f.options);
  const successful = vi.mocked(f.backend.prepareBootstrap).getMockImplementation();
  if (!successful) throw new Error('Missing helper fixture');
  vi.mocked(f.backend.prepareBootstrap).mockImplementationOnce(async () => {
    throw new Error('Simulated process exit before the first helper POST');
  });
  await manager.start();
  manager.reserveUse({ tenantId: 'tenant', envId: f.envId, usageId: 'run:first:1', kind: 'run' });
  await vi.waitFor(() => expect(manager.control.get(f.envId)?.state).toBe('error'));
  const original = manager.control.get(f.envId)?.current_operation_id;
  const saved = JSON.parse(manager.control.get(f.envId)?.preparation_json ?? '{}');
  expect(saved).toMatchObject({ stage: 'dispatched', bootstrapSha256: 'a'.repeat(64) });
  expect(saved.job).toBeUndefined();
  await manager.close();

  vi.mocked(f.backend.prepareBootstrap).mockImplementation(async (input, signal) => {
    if (!input.attemptId) {
      expect(input.pairingCredential).toBeUndefined();
      throw new AbsentBootstrapAttemptError('original-helper');
    }
    const current = JSON.parse(manager.control.get(f.envId)?.preparation_json ?? '{}');
    expect(current).toMatchObject({
      stage: 'dispatched',
      attemptId: input.attemptId,
      attemptNumber: 1,
      replacesSha256s: ['a'.repeat(64)],
    });
    expect(input.pairingCredential).toBeTypeOf('string');
    return successful(input, signal);
  });
  manager = new PlatformManager(f.db, f.options);
  cleanup.push(() => manager.close());
  await manager.start();
  await vi.waitFor(() => expect(manager.control.get(f.envId)?.state).toBe('error'));
  expect(f.create).not.toHaveBeenCalled();
  manager.reserveUse({
    tenantId: 'tenant',
    envId: f.envId,
    usageId: 'run:explicit-continue:2',
    kind: 'run',
  });
  await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1));
  expect(manager.control.get(f.envId)?.current_operation_id).toBe(original);
  expect(manager.control.operation(original ?? '').status).toBe('unknown');
  expect(
    manager.control.database
      .prepare('SELECT COUNT(*) AS n FROM platform_control_slots WHERE deployment_id IS NOT NULL')
      .get(),
  ).toMatchObject({ n: 1 });
});

it('refuses a replaced bootstrap Job UID instead of adopting its labels', async () => {
  const f = fixture();
  const manager = new PlatformManager(f.db, f.options);
  cleanup.push(() => manager.close());
  const accepted = manager.control.reserve({
    tenantId: 'tenant',
    envId: f.envId,
    usageId: 'run:pending:1',
    kind: 'run',
  });
  manager.control.update(f.envId, {
    preparation_json: JSON.stringify({
      stage: 'dispatched',
      job: { apiVersion: 'batch/v1', metadata: { name: 'helper', uid: 'original-uid' } },
      physical: [],
    }),
  });
  vi.mocked(f.backend.prepareBootstrap).mockResolvedValue({
    job: {
      apiVersion: 'batch/v1',
      metadata: { name: 'helper', uid: 'replacement-uid' },
      status: { failed: 1 },
    },
    pods: [],
  });
  await manager.start();
  await vi.waitFor(() => expect(manager.control.get(f.envId)?.state).toBe('error'));
  expect(manager.control.operation(accepted.current_operation_id ?? '').status).toBe('prepared');
  expect(f.backend.cleanupBootstrap).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});

it('sweeps durable idle deadlines without rescheduling an idle runtime in a microtask loop and preserves time across restart', async () => {
  const f = fixture(3_600_000);
  new EnvironmentOperationStore(f.db);
  let now = Date.parse('2026-11-08T00:00:00.000Z');
  const options = { ...f.options, idleTimeoutMs: 3_600_000, now: () => new Date(now) };
  let manager = new PlatformManager(f.db, options);
  const use = { tenantId: 'tenant', envId: f.envId, usageId: 'run:ended:1', kind: 'run' as const };
  const accepted = manager.control.reserve(use);
  manager.control.complete(f.envId, accepted.current_operation_id ?? '', {
    state: 'running',
    sandbox_id: 'sandbox',
    batch_uid: 'batch',
    pod_uid: 'old-pod',
    instance_id: 'old-instance',
    leaf_json: JSON.stringify({ ...evidence, podUid: 'old-pod' }),
  });
  manager.control.release(use);
  const idleSince = manager.control.get(f.envId)?.idle_since;
  f.batches.push({
    apiVersion: 'sandbox.opensandbox.io/v1alpha1',
    metadata: {
      name: 'sandbox',
      uid: 'batch',
      labels: { 'kairos.io/deployment': 'test', 'kairos.io/env': f.envId },
    },
    spec: { replicas: 1 },
    status: { phase: 'Running' },
  });
  const scan = vi.spyOn(manager.control, 'prepareIdlePause');
  expect(manager.control.get(f.envId)).toMatchObject({
    state: 'running',
    current_operation_id: null,
  });
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM environment_operations').get()).toMatchObject({
    n: 0,
  });
  await manager.start();
  expect(manager.control.get(f.envId)).toMatchObject({
    state: 'running',
    current_operation_id: null,
  });
  now += 3_599_999;
  await vi.waitFor(() => expect(scan.mock.calls.length).toBeGreaterThanOrEqual(2), {
    timeout: 2500,
  });
  expect(scan.mock.calls.length).toBeLessThan(5);
  expect(f.backend.change).not.toHaveBeenCalled();
  expect(manager.control.get(f.envId)?.idle_since).toBe(idleSince);
  await manager.close();

  manager = new PlatformManager(f.db, options);
  cleanup.push(() => manager.close());
  now += 1;
  await manager.start();
  await vi.waitFor(() =>
    expect(f.backend.change).toHaveBeenCalledWith('sandbox', 'pause', expect.any(AbortSignal)),
  );
  expect(manager.control.get(f.envId)?.state).toBe('pausing');
  expect(f.backend.create).not.toHaveBeenCalled();
});
