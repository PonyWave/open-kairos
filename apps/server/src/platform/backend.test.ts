import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { boundedRequest, kubeObjectSchema, parseKubernetesList } from './backend.js';

const cleanup: Array<() => Promise<void>> = [];
it('normalizes legal typed List items only within the requested exact API group/version and kind', () => {
  const pod = {
    metadata: { name: 'bootstrap-worker', uid: 'pod-uid' },
    spec: { nodeName: 'kairos-k1' },
    status: { phase: 'Running' },
  };
  expect(parseKubernetesList('pods', { apiVersion: 'v1', kind: 'PodList', items: [pod] })).toEqual([
    { ...pod, apiVersion: 'v1', kind: 'Pod' },
  ]);
  expect(
    parseKubernetesList('jobs', {
      apiVersion: 'batch/v1',
      kind: 'JobList',
      items: [{ metadata: { name: 'helper', uid: 'job' } }],
    })[0],
  ).toMatchObject({ apiVersion: 'batch/v1', kind: 'Job' });
  expect(() =>
    parseKubernetesList('pods', { apiVersion: 'batch/v1', kind: 'PodList', items: [pod] }),
  ).toThrow();
  expect(() =>
    parseKubernetesList('pods', { apiVersion: 'v1', kind: 'JobList', items: [pod] }),
  ).toThrow();
  expect(() =>
    parseKubernetesList('pods', {
      apiVersion: 'v1',
      kind: 'PodList',
      items: [{ ...pod, apiVersion: 'unknown/v9' }],
    }),
  ).toThrow('conflicts');
  expect(() =>
    parseKubernetesList('pods', {
      apiVersion: 'v1',
      kind: 'PodList',
      items: [{ ...pod, kind: 'Secret' }],
    }),
  ).toThrow('conflicts');
  expect(() => kubeObjectSchema.parse(pod)).toThrow();
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
it('preserves both Kubernetes PATCH media types on the actual HTTP wire and bounds a continuously streaming response', async () => {
  const observed: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/pods') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          apiVersion: 'v1',
          kind: 'PodList',
          items: [{ metadata: { name: 'helper', uid: 'pod' }, status: { phase: 'Failed' } }],
        }),
      );
      return;
    }
    if (request.url === '/slow') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"value":"');
      const interval = setInterval(() => response.write('x'), 5);
      response.on('close', () => clearInterval(interval));
      return;
    }
    observed.push(String(request.headers['content-type']));
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP fixture address');
  const pods = await boundedRequest(new URL(`http://127.0.0.1:${address.port}/pods`), {
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
  expect(parseKubernetesList('pods', pods.body)[0]).toMatchObject({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'helper', uid: 'pod' },
  });
  for (const type of ['application/merge-patch+json', 'application/json-patch+json']) {
    const result = await boundedRequest(new URL(`http://127.0.0.1:${address.port}/patch`), {
      method: 'PATCH',
      headers: { 'content-type': type },
      body: { value: 1 },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
    expect(result.body).toEqual({ ok: true });
  }
  expect(observed).toEqual(['application/merge-patch+json', 'application/json-patch+json']);
  await expect(
    boundedRequest(new URL(`http://127.0.0.1:${address.port}/slow`), {
      signal: new AbortController().signal,
      timeoutMs: 50,
    }),
  ).rejects.toThrow('total request deadline');
});
