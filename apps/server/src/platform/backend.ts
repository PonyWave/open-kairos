import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import type { PlatformClusterIdentity, PlatformLifecycleOperation } from './control-store.js';
import {
  requiredPlatformNetworkPolicies,
  verifyPlatformNetworkPolicy,
  verifyPlatformWssResolution,
} from './network-policy.js';

const metadata = z.object({
  name: z.string(),
  uid: z.string(),
  deletionTimestamp: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
  ownerReferences: z
    .array(z.object({ uid: z.string(), kind: z.string(), name: z.string() }))
    .optional(),
});
export const kubeObjectSchema = z.object({
  apiVersion: z.string(),
  kind: z.string().optional(),
  metadata,
  spec: z.record(z.string(), z.unknown()).optional(),
  status: z.record(z.string(), z.unknown()).optional(),
});
export type KubeObject = z.infer<typeof kubeObjectSchema>;
const kubernetesResources = {
  pods: { apiVersion: 'v1', kind: 'Pod', prefix: '/api/v1' },
  persistentvolumeclaims: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', prefix: '/api/v1' },
  jobs: { apiVersion: 'batch/v1', kind: 'Job', prefix: '/apis/batch/v1' },
  batchsandboxes: {
    apiVersion: 'sandbox.opensandbox.io/v1alpha1',
    kind: 'BatchSandbox',
    prefix: '/apis/sandbox.opensandbox.io/v1alpha1',
  },
  sandboxsnapshots: {
    apiVersion: 'sandbox.opensandbox.io/v1alpha1',
    kind: 'SandboxSnapshot',
    prefix: '/apis/sandbox.opensandbox.io/v1alpha1',
  },
};
export function parseKubernetesList(
  resource: keyof typeof kubernetesResources,
  input: unknown,
): KubeObject[] {
  const expected = kubernetesResources[resource];
  const list = z
    .object({
      apiVersion: z.literal(expected.apiVersion),
      kind: z.literal(`${expected.kind}List`),
      items: z.array(z.record(z.string(), z.unknown())),
    })
    .parse(input);
  return list.items.map((item) => {
    if (item.apiVersion !== undefined && item.apiVersion !== expected.apiVersion)
      throw new Error(
        'Kubernetes list item API group/version conflicts with its requested resource.',
      );
    if (item.kind !== undefined && item.kind !== expected.kind)
      throw new Error('Kubernetes list item kind conflicts with its requested resource.');
    return kubeObjectSchema.parse({
      ...item,
      apiVersion: expected.apiVersion,
      kind: expected.kind,
    });
  });
}
export interface PlatformBackendOptions {
  lifecycleUrl: string;
  apiKeyFile: string;
  kubernetesUrl: string;
  kubernetesCaFile: string;
  kubernetesTokenFile: string;
  cluster: PlatformClusterIdentity;
  deploymentId: string;
  image: string;
  serverWssUrl: string;
  sharedReleaseClaim: string;
  registryUrl: string;
  registryCaFile: string;
  registryCredentialsFile: string;
  requestTimeoutMs?: number;
}
export interface PlatformBackend {
  verify(signal: AbortSignal): Promise<void>;
  listBatches(signal: AbortSignal): Promise<KubeObject[]>;
  getBatch(id: string, signal: AbortSignal): Promise<KubeObject | undefined>;
  listPods(signal: AbortSignal): Promise<KubeObject[]>;
  listSnapshots(signal: AbortSignal): Promise<KubeObject[]>;
  listJobs(signal: AbortSignal): Promise<KubeObject[]>;
  prepareStorage(envId: string, signal: AbortSignal): Promise<void>;
  prepareBootstrap(
    input: BootstrapAttemptInput,
    signal: AbortSignal,
  ): Promise<{ job: KubeObject; pods: KubeObject[] }>;
  bootstrapHash(input: BootstrapAttemptInput & { pairingCredential: string }): string;
  cleanupBootstrap(
    input: { job: KubeObject; envId: string; operationId: string },
    signal: AbortSignal,
  ): Promise<void>;
  acknowledgeBootstrap(
    input: { job: KubeObject; operationId: string },
    signal: AbortSignal,
  ): Promise<void>;
  acknowledgeSnapshotPod(
    input: { snapshotUid: string; jobUid: string; podUid: string; podName: string },
    signal: AbortSignal,
  ): Promise<void>;
  create(
    input: { envId: string; tenantId: string; operationId: string },
    signal: AbortSignal,
  ): Promise<string>;
  change(
    id: string,
    kind: Exclude<PlatformLifecycleOperation['kind'], 'create'>,
    signal: AbortSignal,
  ): Promise<void>;
  verifyManifest(uri: string, digest: string, signal: AbortSignal): Promise<void>;
}
export interface BootstrapAttemptInput {
  envId: string;
  operationId: string;
  attemptId?: string;
  pairingCredential?: string;
  replacesSha256?: string;
  replacesSha256s?: string[];
}
export class AbsentBootstrapAttemptError extends Error {
  constructor(readonly helperName: string) {
    super('The exact bootstrap attempt has no Job, Secret or Pod.');
    this.name = 'AbsentBootstrapAttemptError';
  }
}

/** Bounded HTTP client; all endpoint/credential locations are administrator configuration. */
export async function boundedRequest(
  url: URL,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    ca?: Buffer;
    signal: AbortSignal;
    timeoutMs: number;
  },
): Promise<{ status: number; body: unknown; rawBody: Buffer }> {
  const bytes = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: options.method ?? 'GET',
        signal: options.signal,
        ca: options.ca,
        headers: {
          ...(bytes
            ? { 'content-type': 'application/json', 'content-length': String(bytes.length) }
            : {}),
          ...options.headers,
        },
      },
      (response) => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) {
            request.destroy(new Error('Platform response exceeds 4 MiB.'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          const rawBody = Buffer.concat(chunks);
          const text = rawBody.toString('utf8');
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: text.length ? JSON.parse(text) : null,
              rawBody,
            });
          } catch (cause) {
            reject(new Error('Platform response is not valid JSON.', { cause }));
          }
        });
      },
    );
    request.setTimeout(options.timeoutMs, () =>
      request.destroy(new Error('Platform request deadline exceeded.')),
    );
    const deadline = setTimeout(
      () => request.destroy(new Error('Platform total request deadline exceeded.')),
      options.timeoutMs,
    );
    request.once('close', () => clearTimeout(deadline));
    request.once('error', reject);
    request.end(bytes);
  });
}

export function platformClaimName(
  deploymentId: string,
  envId: string,
  kind: 'workspace' | 'home' | 'identity',
): string {
  if (!/^[a-z0-9-]{1,32}$/.test(deploymentId) || !/^[a-zA-Z0-9-]{1,64}$/.test(envId))
    throw new Error('Invalid platform storage identity.');
  return `kp-${deploymentId}-${envId.toLowerCase()}-${kind}`;
}

export class OpenSandboxBackend implements PlatformBackend {
  readonly #timeout: number;
  constructor(readonly options: PlatformBackendOptions) {
    this.#timeout = options.requestTimeoutMs ?? 75_000;
    for (const value of [options.lifecycleUrl, options.kubernetesUrl, options.serverWssUrl]) {
      const url = new URL(value);
      if (url.username || url.password || url.hash || url.search)
        throw new Error('Platform service URLs must not contain credentials, query or fragment.');
    }
    if (new URL(options.kubernetesUrl).protocol !== 'https:')
      throw new Error('Kubernetes API requires HTTPS.');
  }
  async #kube(path: string, signal: AbortSignal, method = 'GET', body?: unknown): Promise<unknown> {
    const [ca, token] = await Promise.all([
      readFile(this.options.kubernetesCaFile),
      readFile(this.options.kubernetesTokenFile, 'utf8'),
    ]);
    const response = await boundedRequest(new URL(path, this.options.kubernetesUrl), {
      method,
      body,
      ca,
      signal,
      timeoutMs: this.#timeout,
      headers: { authorization: `Bearer ${token.trim()}` },
    });
    if (response.status === 404) return undefined;
    if (response.status < 200 || response.status >= 300)
      throw new Error(`Kubernetes ${method} failed with HTTP ${response.status}.`);
    return response.body;
  }
  async verify(signal: AbortSignal): Promise<void> {
    const { createHash } = await import('node:crypto');
    const ca = await readFile(this.options.kubernetesCaFile);
    if (createHash('sha256').update(ca).digest('hex') !== this.options.cluster.caSha256)
      throw new Error('Kubernetes CA identity changed.');
    const node = kubeObjectSchema.parse(
      await this.#kube(
        `/api/v1/nodes/${encodeURIComponent(this.options.cluster.nodeName)}`,
        signal,
      ),
    );
    if (node.metadata.uid !== this.options.cluster.nodeUid)
      throw new Error('Kubernetes node identity changed.');
    for (const name of Object.keys(requiredPlatformNetworkPolicies)) {
      const object = kubeObjectSchema.parse(
        await this.#kube(
          `/apis/networking.k8s.io/v1/namespaces/${this.options.cluster.namespace}/networkpolicies/${name}`,
          signal,
        ),
      );
      verifyPlatformNetworkPolicy(name, object.spec);
    }
    await verifyPlatformWssResolution(this.options.serverWssUrl);
  }
  async #list(kind: keyof typeof kubernetesResources, signal: AbortSignal): Promise<KubeObject[]> {
    const prefix = kubernetesResources[kind].prefix;
    const body = await this.#kube(
      `${prefix}/namespaces/${this.options.cluster.namespace}/${kind}`,
      signal,
    );
    return parseKubernetesList(kind, body);
  }
  listBatches(signal: AbortSignal): Promise<KubeObject[]> {
    return this.#list('batchsandboxes', signal);
  }
  async getBatch(id: string, signal: AbortSignal): Promise<KubeObject | undefined> {
    const body = await this.#kube(
      `/apis/sandbox.opensandbox.io/v1alpha1/namespaces/${this.options.cluster.namespace}/batchsandboxes/${encodeURIComponent(id)}`,
      signal,
    );
    return body === undefined ? undefined : kubeObjectSchema.parse(body);
  }
  listPods(signal: AbortSignal): Promise<KubeObject[]> {
    return this.#list('pods', signal);
  }
  listSnapshots(signal: AbortSignal): Promise<KubeObject[]> {
    return this.#list('sandboxsnapshots', signal);
  }
  listJobs(signal: AbortSignal): Promise<KubeObject[]> {
    return this.#list('jobs', signal);
  }
  async prepareStorage(envId: string, signal: AbortSignal): Promise<void> {
    for (const kind of ['workspace', 'home', 'identity'] as const) {
      const name = platformClaimName(this.options.deploymentId, envId, kind);
      const path = `/api/v1/namespaces/${this.options.cluster.namespace}/persistentvolumeclaims`;
      const existing = await this.#kube(`${path}/${name}`, signal);
      if (existing !== undefined) {
        const pvc = kubeObjectSchema.parse(existing);
        if (
          pvc.metadata.labels?.['kairos.io/env'] !== envId ||
          pvc.metadata.labels?.['kairos.io/deployment'] !== this.options.deploymentId
        )
          throw new Error('Platform PVC identity conflict.');
        continue;
      }
      await this.#kube(path, signal, 'POST', {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name,
          labels: { 'kairos.io/env': envId, 'kairos.io/deployment': this.options.deploymentId },
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          storageClassName: 'kairos-local-retain',
          resources: { requests: { storage: kind === 'workspace' ? '2Gi' : '1Gi' } },
        },
      });
    }
  }
  async prepareBootstrap(
    input: BootstrapAttemptInput,
    signal: AbortSignal,
  ): Promise<{ job: KubeObject; pods: KubeObject[] }> {
    const name = `kp-init-${this.options.deploymentId}-${createHash('sha256')
      .update(input.attemptId ?? input.operationId)
      .digest('hex')
      .slice(0, 16)}`;
    const path = `/apis/batch/v1/namespaces/${this.options.cluster.namespace}/jobs`;
    let existing = await this.#kube(`${path}/${name}`, signal);
    const labels = {
      'kairos.io/env': input.envId,
      'kairos.io/deployment': this.options.deploymentId,
      'kairos.io/bootstrap-operation': input.operationId,
      ...(input.attemptId ? { 'kairos.io/bootstrap-attempt': input.attemptId } : {}),
    };
    if (existing === undefined) {
      const secretPath = `/api/v1/namespaces/${this.options.cluster.namespace}/secrets`;
      const prior = await this.#kube(`${secretPath}/${name}`, signal);
      if (!input.pairingCredential) {
        const pods = await this.listPods(signal);
        if (
          prior === undefined &&
          !pods.some(
            (pod) =>
              pod.metadata.labels?.['kairos.io/bootstrap-operation'] === input.operationId &&
              pod.metadata.labels?.['kairos.io/bootstrap-attempt'] === input.attemptId,
          )
        )
          throw new AbsentBootstrapAttemptError(name);
        throw new Error(
          'Bootstrap helper is missing after an uncertain preparation; original resources require reconciliation.',
        );
      }
      if (prior === undefined)
        await this.#kube(secretPath, signal, 'POST', {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name, labels },
          type: 'Opaque',
          stringData: {
            'bootstrap.json': this.#bootstrapContent({
              ...input,
              pairingCredential: input.pairingCredential,
            }),
          },
        });
      else {
        const secret = kubeObjectSchema.parse(prior);
        if (
          secret.metadata.labels?.['kairos.io/bootstrap-operation'] !== input.operationId ||
          secret.metadata.labels?.['kairos.io/env'] !== input.envId ||
          secret.metadata.labels?.['kairos.io/deployment'] !== this.options.deploymentId ||
          secret.metadata.labels?.['kairos.io/bootstrap-attempt'] !== input.attemptId
        )
          throw new Error('Bootstrap Secret operation conflict.');
      }
      existing = await this.#kube(path, signal, 'POST', {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name, labels },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: 150,
          template: {
            metadata: { labels: { ...labels, 'kairos.io/network-role': 'bootstrap' } },
            spec: {
              restartPolicy: 'Never',
              automountServiceAccountToken: false,
              imagePullSecrets: [{ name: 'snapshot-pull' }],
              securityContext: {
                runAsUser: 1000,
                runAsGroup: 1000,
                fsGroup: 1000,
                runAsNonRoot: true,
                seccompProfile: { type: 'RuntimeDefault' },
              },
              containers: [
                {
                  name: 'bootstrap',
                  image: this.options.image,
                  command: [
                    '/bin/sh',
                    '-c',
                    `release=$(readlink -f /opt/kairos-program/${this.options.deploymentId}/current); test -n "$release" && exec "$release/bin/kairos-daemon" platform-bootstrap-write`,
                  ],
                  resources: {
                    requests: { cpu: '50m', memory: '64Mi' },
                    limits: { cpu: '250m', memory: '128Mi' },
                  },
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    capabilities: { drop: ['ALL'] },
                  },
                  volumeMounts: [
                    { name: 'identity', mountPath: '/var/lib/kairos-identity' },
                    { name: 'program', mountPath: '/opt/kairos-program', readOnly: true },
                    {
                      name: 'bootstrap-secret',
                      mountPath: '/run/kairos-bootstrap',
                      readOnly: true,
                    },
                  ],
                },
              ],
              volumes: [
                {
                  name: 'identity',
                  persistentVolumeClaim: {
                    claimName: platformClaimName(
                      this.options.deploymentId,
                      input.envId,
                      'identity',
                    ),
                  },
                },
                {
                  name: 'program',
                  persistentVolumeClaim: {
                    claimName: this.options.sharedReleaseClaim,
                    readOnly: true,
                  },
                },
                { name: 'bootstrap-secret', secret: { secretName: name, defaultMode: 0o440 } },
              ],
            },
          },
        },
      });
    }
    const job = kubeObjectSchema.parse(existing);
    if (
      job.metadata.labels?.['kairos.io/bootstrap-operation'] !== input.operationId ||
      job.metadata.labels?.['kairos.io/env'] !== input.envId ||
      job.metadata.labels?.['kairos.io/deployment'] !== this.options.deploymentId ||
      job.metadata.labels?.['kairos.io/bootstrap-attempt'] !== input.attemptId
    )
      throw new Error('Bootstrap Job ownership conflict.');
    return {
      job,
      pods: (await this.listPods(signal)).filter((pod) =>
        pod.metadata.ownerReferences?.some((owner) => owner.uid === job.metadata.uid),
      ),
    };
  }
  #bootstrapContent(input: BootstrapAttemptInput & { pairingCredential: string }): string {
    return JSON.stringify({
      envId: input.envId,
      serverUrl: this.options.serverWssUrl,
      pairingCredential: input.pairingCredential,
      initializationOperationId: input.operationId,
      ...(input.attemptId ? { bootstrapAttemptId: input.attemptId } : {}),
      ...(input.replacesSha256 ? { replacesSha256: input.replacesSha256 } : {}),
      ...(input.replacesSha256s?.length ? { replacesSha256s: input.replacesSha256s } : {}),
    });
  }
  bootstrapHash(input: BootstrapAttemptInput & { pairingCredential: string }): string {
    return createHash('sha256').update(this.#bootstrapContent(input)).digest('hex');
  }
  async cleanupBootstrap(
    input: { job: KubeObject; envId: string; operationId: string },
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.#kube(
      `/apis/batch/v1/namespaces/${this.options.cluster.namespace}/jobs/${input.job.metadata.name}`,
      signal,
    );
    if (current !== undefined) {
      const job = kubeObjectSchema.parse(current);
      if (
        job.metadata.uid !== input.job.metadata.uid ||
        job.metadata.labels?.['kairos.io/bootstrap-operation'] !== input.operationId
      )
        throw new Error('Bootstrap Job cleanup identity conflict.');
      await this.#kube(
        `/apis/batch/v1/namespaces/${this.options.cluster.namespace}/jobs/${job.metadata.name}`,
        signal,
        'DELETE',
        {
          apiVersion: 'v1',
          kind: 'DeleteOptions',
          preconditions: { uid: job.metadata.uid },
          propagationPolicy: 'Foreground',
        },
      );
    }
    const path = `/api/v1/namespaces/${this.options.cluster.namespace}/secrets/${input.job.metadata.name}`;
    const secret = await this.#kube(path, signal);
    if (secret !== undefined) {
      const parsed = kubeObjectSchema.parse(secret);
      if (
        parsed.metadata.labels?.['kairos.io/bootstrap-operation'] !== input.operationId ||
        parsed.metadata.labels?.['kairos.io/env'] !== input.envId
      )
        throw new Error('Bootstrap Secret cleanup identity conflict.');
      await this.#kube(path, signal, 'DELETE', {
        apiVersion: 'v1',
        kind: 'DeleteOptions',
        preconditions: { uid: parsed.metadata.uid },
      });
    }
  }
  async acknowledgeBootstrap(
    input: { job: KubeObject; operationId: string },
    signal: AbortSignal,
  ): Promise<void> {
    if (input.job.metadata.labels?.['kairos.io/bootstrap-operation'] !== input.operationId)
      throw new Error('Bootstrap acknowledgement operation conflict.');
    const path = `/api/v1/namespaces/${this.options.cluster.namespace}/secrets/${input.job.metadata.name}`;
    const raw = await this.#kube(path, signal);
    const secret = kubeObjectSchema.parse(raw);
    if (secret.metadata.labels?.['kairos.io/bootstrap-operation'] !== input.operationId)
      throw new Error('Bootstrap acknowledgement Secret ownership conflict.');
    const key = (await readFile(this.options.kubernetesTokenFile, 'utf8')).trim();
    const response = await boundedRequest(new URL(path, this.options.kubernetesUrl), {
      method: 'PATCH',
      body: { stringData: { observed: input.operationId } },
      ca: await readFile(this.options.kubernetesCaFile),
      signal,
      timeoutMs: this.#timeout,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/merge-patch+json' },
    });
    if (response.status !== 200)
      throw new Error('Bootstrap physical observation acknowledgement failed.');
  }
  async acknowledgeSnapshotPod(
    input: { snapshotUid: string; jobUid: string; podUid: string; podName: string },
    signal: AbortSignal,
  ): Promise<void> {
    const job = (await this.listJobs(signal)).find((value) => value.metadata.uid === input.jobUid);
    if (!job?.metadata.ownerReferences?.some((value) => value.uid === input.snapshotUid))
      throw new Error('Snapshot Job ownership changed before acknowledgement.');
    const pod = (await this.listPods(signal)).find(
      (value) => value.metadata.name === input.podName && value.metadata.uid === input.podUid,
    );
    if (
      !pod?.metadata.ownerReferences?.some((value) => value.uid === input.jobUid) ||
      pod.spec?.nodeName !== this.options.cluster.nodeName
    )
      throw new Error('Snapshot worker Pod ownership or node changed before acknowledgement.');
    if (pod.metadata.annotations?.['kairos.io/physical-observed'] === input.podUid) return;
    const path = `/api/v1/namespaces/${this.options.cluster.namespace}/pods/${encodeURIComponent(input.podName)}`;
    const token = (await readFile(this.options.kubernetesTokenFile, 'utf8')).trim();
    const response = await boundedRequest(new URL(path, this.options.kubernetesUrl), {
      method: 'PATCH',
      body: [
        { op: 'test', path: '/metadata/uid', value: input.podUid },
        {
          op: 'add',
          path: '/metadata/annotations/kairos.io~1physical-observed',
          value: input.podUid,
        },
      ],
      ca: await readFile(this.options.kubernetesCaFile),
      signal,
      timeoutMs: this.#timeout,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json-patch+json' },
    });
    if (response.status !== 200)
      throw new Error('Snapshot worker physical observation acknowledgement failed.');
  }
  async #lifecycle(
    path: string,
    signal: AbortSignal,
    method = 'GET',
    body?: unknown,
  ): Promise<unknown> {
    const key = (await readFile(this.options.apiKeyFile, 'utf8')).trim();
    const response = await boundedRequest(new URL(`/v1${path}`, this.options.lifecycleUrl), {
      method,
      body,
      signal,
      timeoutMs: this.#timeout,
      headers: { 'OPEN-SANDBOX-API-KEY': key },
    });
    if (response.status !== 202 && response.status !== 200)
      throw new Error(`Sandbox lifecycle ${method} failed with HTTP ${response.status}.`);
    return response.body;
  }
  async create(
    input: { envId: string; tenantId: string; operationId: string },
    signal: AbortSignal,
  ): Promise<string> {
    const volumes = (['workspace', 'home', 'identity'] as const).map((kind) => ({
      name: kind,
      mountPath:
        kind === 'workspace'
          ? '/workspace'
          : kind === 'home'
            ? '/home/agent'
            : '/var/lib/kairos-identity',
      pvc: {
        claimName: platformClaimName(this.options.deploymentId, input.envId, kind),
        createIfNotExists: false,
        deleteOnSandboxTermination: false,
      },
    }));
    const body = await this.#lifecycle('/sandboxes', signal, 'POST', {
      image: { uri: this.options.image },
      timeout: null,
      entrypoint: [
        '/bin/sh',
        '-c',
        `release=$(readlink -f /opt/kairos-program/${this.options.deploymentId}/current); test -n "$release" && exec "$release/bin/kairos-daemon" platform-foreground`,
      ],
      env: {
        HOME: '/home/agent',
        KAIROS_PLATFORM_ENV_ID: input.envId,
        KAIROS_PLATFORM_DEPLOYMENT: this.options.deploymentId,
      },
      metadata: {
        'kairos.io/deployment': this.options.deploymentId,
        'kairos.io/env': input.envId,
        'kairos.io/create-operation': input.operationId,
        'kairos.io/network-role': 'tenant',
      },
      resourceLimits: { cpu: '1', memory: '1Gi' },
      resourceRequests: { cpu: '100m', memory: '128Mi' },
      volumes: [
        ...volumes,
        {
          name: 'program',
          mountPath: '/opt/kairos-program',
          readOnly: true,
          pvc: {
            claimName: this.options.sharedReleaseClaim,
            createIfNotExists: false,
            deleteOnSandboxTermination: false,
          },
        },
      ],
    });
    return z.object({ id: z.string().min(1).max(200) }).parse(body).id;
  }
  async change(
    id: string,
    kind: 'pause' | 'resume' | 'delete',
    signal: AbortSignal,
  ): Promise<void> {
    await this.#lifecycle(
      `/sandboxes/${encodeURIComponent(id)}${kind === 'delete' ? '' : `/${kind}`}`,
      signal,
      kind === 'delete' ? 'DELETE' : 'POST',
    );
  }
  async verifyManifest(uri: string, digest: string, signal: AbortSignal): Promise<void> {
    // Registry verification credentials are provided only to the trusted manager.
    const parsed = uri.match(/^([^/]+)\/(.+):([^/:]+)$/);
    if (!parsed || !/^sha256:[a-f0-9]{64}$/.test(digest))
      throw new Error('Snapshot image reference is invalid.');
    const expected = new URL(this.options.registryUrl);
    if (parsed[1] !== expected.host)
      throw new Error('Snapshot registry does not match the configured trusted image registry.');
    const credentials = z
      .object({ username: z.string(), password: z.string() })
      .parse(JSON.parse(await readFile(this.options.registryCredentialsFile, 'utf8')));
    const response = await boundedRequest(
      new URL(`/v2/${parsed[2]}/manifests/${digest}`, expected),
      {
        signal,
        timeoutMs: this.#timeout,
        ca: await readFile(this.options.registryCaFile),
        headers: {
          authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
          accept:
            'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
        },
      },
    );
    if (response.status !== 200) throw new Error('Snapshot manifest cannot be verified.');
    const { createHash } = await import('node:crypto');
    if (`sha256:${createHash('sha256').update(response.rawBody).digest('hex')}` !== digest)
      throw new Error('Snapshot manifest bytes do not match the recorded digest.');
  }
}
