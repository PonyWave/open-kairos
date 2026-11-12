import { expect, it } from 'vitest';
import { createTestServer as createServer } from '../integration/test-authentication.js';
import { openDatabase } from '../storage/database.js';

const allowedOrigin = 'http://127.0.0.1:4317';

function invitedEmail(index: number): string {
  return `person-${index}@example.com`;
}

async function networkFixture(trustedProxies?: string) {
  const database = openDatabase(':memory:');
  const previous = process.env.KAIROS_TRUSTED_PROXIES;
  if (trustedProxies === undefined) delete process.env.KAIROS_TRUSTED_PROXIES;
  else process.env.KAIROS_TRUSTED_PROXIES = trustedProxies;
  let server: ReturnType<typeof createServer>;
  try {
    server = createServer(database, false, {
      identity: {
        secret: 'trusted-proxy-test-secret-at-least-32-characters',
        invitedEmails: Array.from({ length: 20 }, (_, index) => invitedEmail(index)),
        testAccountEnabled: false,
        allowedOrigin,
        secureCookies: false,
        mailer: { send: async () => {} },
        limits: {
          resendIntervalMs: 0,
          sourceLimit: 2,
          globalLimit: 100,
        },
      },
    });
  } catch (error) {
    database.close();
    throw error;
  } finally {
    if (previous === undefined) delete process.env.KAIROS_TRUSTED_PROXIES;
    else process.env.KAIROS_TRUSTED_PROXIES = previous;
  }
  try {
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The authentication test Server has no TCP address.');
    }
    return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
  } catch (error) {
    await server.close();
    throw error;
  }
}

class HttpAuthClient {
  readonly #cookies = new Map<string, string>();

  constructor(readonly baseUrl: string) {}

  async initialize(): Promise<void> {
    const response = await this.call('GetCurrentIdentity', {});
    expect(response.status).toBe(200);
    expect(this.#cookies.has('kairos_csrf')).toBe(true);
  }

  async requestCode(
    clientActionId: string,
    email: string,
    forwardedFor: string,
    forgedSourceAddress: string,
  ): Promise<number> {
    const response = await this.call(
      'RequestEmailCode',
      { email, clientActionId },
      {
        'x-forwarded-for': forwardedFor,
        'x-kairos-source-address': forgedSourceAddress,
      },
    );
    return response.status;
  }

  async call(
    method: string,
    payload: Record<string, unknown>,
    additionalHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      origin: allowedOrigin,
      ...additionalHeaders,
    };
    const cookies = [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`);
    if (cookies.length > 0) headers.cookie = cookies.join('; ');
    const csrf = this.#cookies.get('kairos_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
    const response = await fetch(`${this.baseUrl}/kairos.gui.v1.AuthService/${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const setCookie = response.headers.get('set-cookie');
    const match = setCookie ? /^([^=]+)=([^;]*)/.exec(setCookie) : null;
    if (match?.[1] && match[2] !== undefined) this.#cookies.set(match[1], match[2]);
    return { status: response.status, body: await response.text() };
  }
}

function expectSource(
  current: Awaited<ReturnType<typeof networkFixture>>,
  clientActionId: string,
  sourceAddress: string,
): void {
  expect(
    current.database
      .prepare('SELECT source_address FROM auth_email_verifications WHERE client_action_id = ?')
      .get(clientActionId),
  ).toEqual({ source_address: sourceAddress });
}

it('uses the direct peer and ignores forwarded and source headers by default', async () => {
  const current = await networkFixture();
  const client = new HttpAuthClient(current.baseUrl);
  try {
    await client.initialize();
    for (const [index, forwardedFor] of ['198.51.100.1', '198.51.100.2'].entries()) {
      const actionId = `direct-${index}`;
      expect(
        await client.requestCode(actionId, invitedEmail(index), forwardedFor, '192.0.2.200'),
      ).toBe(200);
      expectSource(current, actionId, '127.0.0.1');
    }
    expect(
      await client.requestCode('direct-limited', invitedEmail(2), '198.51.100.3', '192.0.2.201'),
    ).toBe(429);
    expect(
      current.database
        .prepare(
          "SELECT COUNT(*) AS count FROM auth_email_verifications WHERE client_action_id = 'direct-limited'",
        )
        .get(),
    ).toEqual({ count: 0 });
  } finally {
    if (current.database.isOpen) await current.server.close();
  }
});

it('resolves loopback and multiple trusted hops for source rate limit isolation', async () => {
  const current = await networkFixture('127.0.0.1, ::1, 10.20.0.0/16');
  const client = new HttpAuthClient(current.baseUrl);
  try {
    await client.initialize();
    expect(
      await client.requestCode('loopback-1', invitedEmail(0), '198.51.100.10', '192.0.2.210'),
    ).toBe(200);
    expectSource(current, 'loopback-1', '198.51.100.10');
    expect(
      await client.requestCode(
        'multi-hop-1',
        invitedEmail(1),
        '198.51.100.10, 10.20.30.40',
        '192.0.2.211',
      ),
    ).toBe(200);
    expectSource(current, 'multi-hop-1', '198.51.100.10');
    expect(
      await client.requestCode(
        'multi-hop-limited',
        invitedEmail(2),
        '198.51.100.10, 10.20.30.41',
        '192.0.2.212',
      ),
    ).toBe(429);
    expect(
      await client.requestCode(
        'multi-hop-other-client',
        invitedEmail(3),
        '198.51.100.11, 10.20.30.40',
        '192.0.2.213',
      ),
    ).toBe(200);
    expectSource(current, 'multi-hop-other-client', '198.51.100.11');
  } finally {
    if (current.database.isOpen) await current.server.close();
  }
});

it('stops at the first untrusted hop instead of accepting a forged client address', async () => {
  const current = await networkFixture('127.0.0.1, 10.20.0.0/16');
  const client = new HttpAuthClient(current.baseUrl);
  try {
    await client.initialize();
    for (const [index, clientAddress] of ['198.51.100.20', '198.51.100.21'].entries()) {
      const actionId = `untrusted-${index}`;
      expect(
        await client.requestCode(
          actionId,
          invitedEmail(index),
          `${clientAddress}, 203.0.113.9`,
          '192.0.2.220',
        ),
      ).toBe(200);
      expectSource(current, actionId, '203.0.113.9');
    }
    expect(
      await client.requestCode(
        'untrusted-limited',
        invitedEmail(2),
        '198.51.100.22, 203.0.113.9',
        '192.0.2.221',
      ),
    ).toBe(429);
  } finally {
    if (current.database.isOpen) await current.server.close();
  }
});
