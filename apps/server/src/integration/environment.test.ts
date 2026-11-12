import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DeviceCapability } from '@kairos/contracts/device';
import type { FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';
import type { EmailMessage } from '../auth/mailer.js';
import { LOCAL_TEST_CODE, LOCAL_TEST_EMAIL } from '../auth/service.js';
import { EnvironmentStore } from '../devices/environment-store.js';
import { openDatabase } from '../storage/database.js';
import { createTestServer as createServer } from './test-authentication.js';

const origin = 'http://127.0.0.1:4317';

class TestClient {
  readonly #server: FastifyInstance;
  readonly #cookies = new Map<string, string>();

  constructor(server: FastifyInstance) {
    this.#server = server;
  }

  async call(service: string, method: string, payload: Record<string, unknown>) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      origin,
    };
    const cookies = [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`);
    if (cookies.length > 0) headers.cookie = cookies.join('; ');
    const csrf = this.#cookies.get('kairos_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
    const response = await this.#server.inject({
      method: 'POST',
      url: `/kairos.gui.v1.${service}/${method}`,
      headers,
      payload,
    });
    const setCookies = response.headers['set-cookie'];
    for (const cookie of Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : []) {
      const match = /^([^=]+)=([^;]*)/.exec(cookie);
      if (!match?.[1] || match[2] === undefined) continue;
      if (/Max-Age=0/.test(cookie)) this.#cookies.delete(match[1]);
      else this.#cookies.set(match[1], match[2]);
    }
    return response;
  }
}

async function login(
  client: TestClient,
  messages: EmailMessage[],
  email: string,
  username: string,
) {
  const initialized = await client.call('AuthService', 'GetCurrentIdentity', {});
  expect(initialized.statusCode).toBe(200);
  const requested = await client.call('AuthService', 'RequestEmailCode', {
    email,
    clientActionId: `request-${username}`,
  });
  expect(requested.statusCode).toBe(200);
  const verificationId = requested.json().verificationId;
  const code =
    email === LOCAL_TEST_EMAIL ? LOCAL_TEST_CODE : /(\d{6})/.exec(messages.at(-1)?.text ?? '')?.[1];
  expect(code).toMatch(/^\d{6}$/);
  const verified = await client.call('AuthService', 'VerifyEmailCode', {
    email,
    verificationId,
    code,
  });
  expect(verified.statusCode).toBe(200);
  const completed = await client.call('AuthService', 'CompleteProfile', { username });
  expect(completed.statusCode).toBe(200);
  return completed.json().identity;
}

it('runs environment RPCs with real sessions and independently verifies SQLite state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-environment-integration-'));
  const database: DatabaseSync = openDatabase(':memory:');
  const messages: EmailMessage[] = [];
  const current = new Date();
  const server = createServer(database, false, {
    identity: {
      secret: 'environment-integration-secret-at-least-32-characters',
      invitedEmails: ['second@example.com'],
      testAccountEnabled: true,
      allowedOrigin: origin,
      secureCookies: false,
      mailer: {
        async send(message) {
          messages.push(message);
        },
      },
      limits: { resendIntervalMs: 0 },
    },
    now: () => current,
  });
  const first = new TestClient(server);
  const second = new TestClient(server);
  try {
    const firstIdentity = await login(first, messages, LOCAL_TEST_EMAIL, 'first');
    await login(second, messages, 'second@example.com', 'second');
    const registered = await first.call('EnvironmentService', 'RegisterEnvironment', {
      clientActionId: 'integration-register',
      name: '集成服务器',
      recommendedPwd: '/srv/kairos',
    });
    expect(registered.statusCode).toBe(200);
    const envId = registered.json().environment.envId;
    const firstCredential = registered.json().pairingCredential;
    expect(registered.json().installation).toBeUndefined();
    expect(
      database
        .prepare('SELECT tenant_id, binding_status FROM environments WHERE env_id = ?')
        .get(envId),
    ).toEqual({ tenant_id: firstIdentity.tenantId, binding_status: 'pairing' });

    const duplicate = await first.call('EnvironmentService', 'RegisterEnvironment', {
      clientActionId: 'integration-register',
      name: '集成服务器',
      recommendedPwd: '/srv/kairos',
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().environment.envId).toBe(envId);
    expect(duplicate.json().pairingCredential).toBe(firstCredential);

    const reissued = await first.call('EnvironmentService', 'ReissueEnvironmentPairing', {
      clientActionId: 'integration-reissue',
      envId,
    });
    expect(reissued.statusCode).toBe(200);
    expect(reissued.json().environment.envId).toBe(envId);
    const pairingCredential = reissued.json().pairingCredential;
    expect(pairingCredential).not.toBe(firstCredential);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM environments WHERE kind <> 'platform_sandbox'")
        .get(),
    ).toEqual({
      count: 1,
    });

    const forbidden = await second.call('EnvironmentService', 'GetEnvironment', { envId });
    expect(forbidden.statusCode).toBe(403);
    const secondList = await second.call('EnvironmentService', 'ListEnvironments', {});
    expect(secondList.statusCode).toBe(200);
    expect(secondList.json().environments).toHaveLength(1);
    expect(secondList.json().environments[0]).toMatchObject({
      envId: secondList.json().mainEnvId,
      kind: 'ENVIRONMENT_KIND_PLATFORM_SANDBOX',
    });
    expect(secondList.json().mainEnvId).not.toBe(
      (await first.call('EnvironmentService', 'ListEnvironments', {})).json().mainEnvId,
    );

    const environments = new EnvironmentStore(database);
    const exchanged = environments.exchangePairing({
      envId,
      pairingCredential,
      reportedCapabilities: [DeviceCapability.DIRECTORY_CHECK],
      daemonVersion: 'integration-test',
      os: 'ubuntu',
      architecture: 'x86_64',
    });
    expect(exchanged.deviceId).not.toBe(envId);
    expect(exchanged.deviceBindingId).not.toBe(exchanged.deviceId);
    expect(
      database
        .prepare('SELECT default_env_id FROM tenants WHERE tenant_id = ?')
        .get(firstIdentity.tenantId),
    ).toEqual({ default_env_id: null });
    const listed = await first.call('EnvironmentService', 'ListEnvironments', {});
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).not.toHaveProperty('defaultEnvId');
    expect(
      listed
        .json()
        .environments.find((environment: { envId: string }) => environment.envId === envId),
    ).toMatchObject({ bindingStatus: 'ENVIRONMENT_BINDING_STATUS_ACTIVE' });

    const draining = await first.call('EnvironmentService', 'SetEnvironmentMaintenance', {
      clientActionId: 'integration-maintenance',
      envId,
      mode: 'ENVIRONMENT_MAINTENANCE_MODE_DRAINING',
      expectedVersion: '0',
    });
    expect(draining.statusCode).toBe(200);
    expect(draining.json().maintenanceVersion).toBe('1');
    expect(
      database
        .prepare('SELECT maintenance_mode, maintenance_version FROM environments WHERE env_id = ?')
        .get(envId),
    ).toEqual({ maintenance_mode: 'draining', maintenance_version: '1' });

    const removed = await first.call('EnvironmentService', 'SetDefaultEnvironment', {
      clientActionId: 'integration-default-removed',
      envId,
    });
    expect(removed.statusCode).toBe(404);
    expect(
      database
        .prepare('SELECT default_env_id, default_env_explicit FROM tenants WHERE tenant_id = ?')
        .get(firstIdentity.tenantId),
    ).toEqual({ default_env_id: null, default_env_explicit: 0 });

    const revoked = await first.call('EnvironmentService', 'RevokeEnvironment', {
      clientActionId: 'integration-revoke',
      envId,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().environment.bindingStatus).toBe('ENVIRONMENT_BINDING_STATUS_REVOKED');
    expect(
      database
        .prepare('SELECT binding_status, device_binding_id FROM environments WHERE env_id = ?')
        .get(envId),
    ).toEqual({ binding_status: 'revoked', device_binding_id: null });
    expect(
      database
        .prepare('SELECT default_env_id FROM tenants WHERE tenant_id = ?')
        .get(firstIdentity.tenantId),
    ).toEqual({ default_env_id: null });

    const pairingRow = database
      .prepare(
        'SELECT credential_hash FROM environment_pairing_credentials WHERE env_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(envId);
    expect(pairingRow).not.toMatchObject({ credential_hash: pairingCredential });
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM context_messages WHERE content LIKE ?')
        .get(`%${pairingCredential}%`),
    ).toEqual({ count: 0 });
  } finally {
    if (database.isOpen) await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
