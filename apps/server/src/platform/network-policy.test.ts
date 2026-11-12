import { expect, it } from 'vitest';
import {
  platformWssIPv4,
  requiredPlatformNetworkPolicies,
  verifyPlatformNetworkPolicy,
} from './network-policy.js';

it('requires namespace-wide default deny and exact tenant DNS/WSS rules, rejecting an added management or broad destination', () => {
  for (const [name, spec] of Object.entries(requiredPlatformNetworkPolicies))
    expect(() => verifyPlatformNetworkPolicy(name, spec)).not.toThrow();
  const deny = requiredPlatformNetworkPolicies['kairos-platform-default-deny'];
  expect(deny.podSelector).toEqual({});
  expect(deny.ingress).toEqual([]);
  expect(deny.egress).toEqual([]);
  const tenant = structuredClone(requiredPlatformNetworkPolicies['kairos-platform-business']);
  expect(tenant.ingress).toEqual([]);
  expect(tenant.egress[1]).toEqual({
    to: [{ ipBlock: { cidr: `${platformWssIPv4}/32` } }],
    ports: [{ protocol: 'TCP', port: 443 }],
  });
  expect(tenant.egress[2]).toEqual({
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
  });
  for (const cidr of ['0.0.0.0/0', '10.250.0.0/16', '10.251.0.0/16', '172.27.134.23/32']) {
    const invalid = {
      ...tenant,
      egress: [
        ...tenant.egress,
        { to: [{ ipBlock: { cidr } }], ports: [{ protocol: 'TCP', port: 6443 }] },
      ],
    };
    expect(() => verifyPlatformNetworkPolicy('kairos-platform-business', invalid)).toThrow(
      'reviewed configuration',
    );
  }
  expect(() =>
    verifyPlatformNetworkPolicy('kairos-platform-default-deny', {
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
    }),
  ).not.toThrow();
  expect(() =>
    verifyPlatformNetworkPolicy('kairos-platform-business', { ...tenant, ingress: [{}] }),
  ).toThrow();
});
