import { lookup } from 'node:dns/promises';
import { z } from 'zod';

export const platformNetworkRole = 'kairos.io/network-role';
export const platformWssIPv4 = '172.27.65.55';
const dns = {
  to: [
    {
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
      podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
    },
    { ipBlock: { cidr: '10.251.0.10/32' } },
  ],
  ports: [
    { protocol: 'UDP', port: 53 },
    { protocol: 'TCP', port: 53 },
  ],
};
export const requiredPlatformNetworkPolicies = {
  'kairos-platform-default-deny': {
    podSelector: {},
    policyTypes: ['Ingress', 'Egress'],
    ingress: [],
    egress: [],
  },
  'kairos-platform-business': {
    podSelector: { matchLabels: { [platformNetworkRole]: 'tenant' } },
    policyTypes: ['Ingress', 'Egress'],
    ingress: [],
    egress: [
      dns,
      {
        to: [{ ipBlock: { cidr: `${platformWssIPv4}/32` } }],
        ports: [{ protocol: 'TCP', port: 443 }],
      },
      {
        to: [
          {
            ipBlock: {
              cidr: '0.0.0.0/0',
              except: [
                '0.0.0.0/8',
                '10.0.0.0/8',
                '100.64.0.0/10',
                '127.0.0.0/8',
                '169.254.0.0/16',
                '172.16.0.0/12',
                '192.168.0.0/16',
                '224.0.0.0/4',
                '240.0.0.0/4',
              ],
            },
          },
        ],
      },
    ],
  },
  'kairos-platform-helper': {
    podSelector: {
      matchExpressions: [
        { key: platformNetworkRole, operator: 'In', values: ['bootstrap', 'snapshot'] },
      ],
    },
    policyTypes: ['Ingress', 'Egress'],
    ingress: [],
    egress: [
      dns,
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'kairos-registry' },
            },
            podSelector: { matchLabels: { app: 'snapshot-registry' } },
          },
          { ipBlock: { cidr: '10.251.0.50/32' } },
        ],
        ports: [{ protocol: 'TCP', port: 5000 }],
      },
    ],
  },
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function verifyPlatformNetworkPolicy(name: string, value: unknown): void {
  const expected = Object.entries(requiredPlatformNetworkPolicies).find(
    ([key]) => key === name,
  )?.[1];
  const spec = z
    .object({
      podSelector: z.record(z.string(), z.unknown()),
      policyTypes: z.array(z.string()),
      ingress: z.array(z.unknown()).optional(),
      egress: z.array(z.unknown()).optional(),
    })
    .strict()
    .parse(value);
  if (
    !expected ||
    canonical({ ...spec, ingress: spec.ingress ?? [], egress: spec.egress ?? [] }) !==
      canonical(expected)
  )
    throw new Error(
      'The required fixed platform NetworkPolicy differs from its reviewed configuration.',
    );
}
export async function verifyPlatformWssResolution(serverWssUrl: string): Promise<void> {
  const url = new URL(serverWssUrl);
  if (url.protocol !== 'wss:' || (url.port && url.port !== '443'))
    throw new Error('Platform WSS requires the reviewed TLS port 443.');
  const addresses = await lookup(url.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((address) => address.family !== 4 || address.address !== platformWssIPv4)
  )
    throw new Error('Platform WSS DNS no longer matches the administrator-reviewed exact address.');
}
