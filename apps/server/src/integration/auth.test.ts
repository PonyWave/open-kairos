import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ModelEvent } from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import type { FastifyInstance } from 'fastify';
import { expect, it, vi } from 'vitest';
import { AuthService } from '../auth/service.js';
import { AuthStore } from '../auth/store.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import {
  createEnvironmentTestServer as createServer,
  seedTestEnvironment,
  testEnvironmentPolicyJson,
} from './environment-fixture.js';
import { seedTestSession, testIdentityOptions } from './test-authentication.js';

const origin = 'http://127.0.0.1:4317';
const secret = testIdentityOptions().secret;

class TestClient {
  readonly #server: FastifyInstance;
  readonly #cookies = new Map<string, string>();

  constructor(server: FastifyInstance, cookies?: Map<string, string>) {
    this.#server = server;
    if (cookies) {
      for (const [name, value] of cookies) this.#cookies.set(name, value);
    }
  }

  setCookie(name: string, value: string): void {
    this.#cookies.set(name, value);
  }

  async call(
    service: string,
    method: string,
    payload: Record<string, unknown>,
    options: { origin?: boolean; csrf?: boolean; originValue?: string; host?: string } = {},
  ) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'connect-protocol-version': '1',
    };
    if (options.origin !== false) headers.origin = options.originValue ?? origin;
    if (options.host !== undefined) headers.host = options.host;
    const cookies = [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`);
    if (cookies.length > 0) headers.cookie = cookies.join('; ');
    const csrf = this.#cookies.get('kairos_csrf');
    if (options.csrf !== false && csrf) headers['x-csrf-token'] = csrf;
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

interface Fixture {
  server: FastifyInstance;
  database: DatabaseSync;
  directory: string;
}

async function fixture(
  identityOverrides: { allowedOrigin?: string | null; secureCookies?: boolean } = {},
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-auth-integration-'));
  const database = openDatabase(':memory:');
  const provider = new ScriptedProvider([
    modelResponse('无环境普通回复'),
    modelResponse('第二个回复'),
  ]);
  const server = createServer(database, false, {
    identity: {
      secret,
      allowedOrigin: origin,
      secureCookies: false,
      ...identityOverrides,
    },
    model: {
      provider,
      providerId: 'test',
      modelId: 'test-model',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
    },
  });
  return { server, database, directory };
}

async function cleanup(current: Fixture): Promise<void> {
  if (current.database.isOpen) await current.server.close();
  await rm(current.directory, { recursive: true, force: true });
}

function modelResponse(text: string): ModelEvent[] {
  return [
    { type: 'text_delta', text },
    {
      type: 'response',
      message: { role: 'assistant', content: text },
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  ];
}

async function initialize(client: TestClient): Promise<void> {
  const response = await client.call('AuthService', 'GetCurrentIdentity', {});
  expect(response.statusCode).toBe(200);
  expect(response.json().state).toBe('AUTHENTICATION_STATE_ANONYMOUS');
}

function localAuthService(current: Fixture): AuthService {
  return new AuthService(new AuthStore(current.database), {
    secret,
    createMainThread: (tenantId) =>
      new SessionStore(current.database).getOrCreateMainThread(tenantId),
  });
}

async function bootstrap(client: TestClient, current: Fixture) {
  await initialize(client);
  const session = localAuthService(current).createLocalSession();
  const response = await client.call('AuthService', 'BootstrapSession', { token: session.token });
  expect(response.statusCode).toBe(200);
  return response.json().identity;
}

it('runs the local bootstrap lifecycle with CSRF and ordinary conversation', async () => {
  const current = await fixture();
  const client = new TestClient(current.server);
  try {
    await initialize(client);
    const session = localAuthService(current).createLocalSession();
    const missingCsrf = await client.call(
      'AuthService',
      'BootstrapSession',
      { token: session.token },
      { csrf: false },
    );
    expect(missingCsrf.statusCode).toBe(403);
    const wrongOrigin = await client.call(
      'AuthService',
      'BootstrapSession',
      { token: session.token },
      { origin: false },
    );
    expect(wrongOrigin.statusCode).toBe(403);
    const invalid = await client.call('AuthService', 'BootstrapSession', {
      token: 'invalid-token',
    });
    expect(invalid.statusCode).toBe(401);

    const bootstrapped = await client.call('AuthService', 'BootstrapSession', {
      token: session.token,
    });
    expect(bootstrapped.statusCode).toBe(200);
    const identity = bootstrapped.json().identity;
    expect(identity.email).toBe('local@open-kairos.local');
    const setCookies = bootstrapped.headers['set-cookie'];
    expect(JSON.stringify(setCookies)).toContain('HttpOnly');
    expect(JSON.stringify(setCookies)).toContain('SameSite=Strict');
    expect(JSON.stringify(setCookies)).not.toContain('Secure');

    const currentIdentity = await client.call('AuthService', 'GetCurrentIdentity', {});
    expect(currentIdentity.json().state).toBe('AUTHENTICATION_STATE_AUTHENTICATED');
    expect(currentIdentity.json().identity.email).toBe('local@open-kairos.local');
    const businessWithoutCsrf = await client.call(
      'MessageService',
      'SendMessage',
      {
        clientActionId: 'business-without-csrf',
        threadId: identity.mainThreadId,
        text: '不得受理',
        mode: 'INPUT_MODE_FOLLOW_UP',
      },
      { csrf: false },
    );
    expect(businessWithoutCsrf.statusCode).toBe(403);
    const sent = await client.call('MessageService', 'SendMessage', {
      clientActionId: 'ordinary-message',
      threadId: identity.mainThreadId,
      text: '没有环境也能对话吗？',
      mode: 'INPUT_MODE_FOLLOW_UP',
    });
    expect(sent.statusCode).toBe(200);
    await vi.waitFor(async () => {
      const snapshot = await client.call('ThreadService', 'GetThread', {
        threadId: identity.mainThreadId,
      });
      expect(
        snapshot
          .json()
          .snapshot?.messages?.some(
            (message: { content?: string }) => message.content === '无环境普通回复',
          ),
      ).toBe(true);
    });

    const logoutWithoutCsrf = await client.call('AuthService', 'Logout', {}, { csrf: false });
    expect(logoutWithoutCsrf.statusCode).toBe(403);
    const logout = await client.call('AuthService', 'Logout', {});
    expect(logout.statusCode).toBe(200);
    const loggedOut = await client.call('ThreadService', 'ListThreads', {
      afterSeq: '0',
      limit: 10,
    });
    expect(loggedOut.statusCode).toBe(401);

    const again = await bootstrap(client, current);
    expect(again.tenantId).toBe(identity.tenantId);
    expect(again.mainThreadId).toBe(identity.mainThreadId);
    expect(current.database.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({
      count: 1,
    });
    expect(current.database.prepare('SELECT COUNT(*) AS count FROM tenants').get()).toEqual({
      count: 1,
    });
    expect(
      current.database
        .prepare("SELECT COUNT(*) AS count FROM threads WHERE thread_type = 'main'")
        .get(),
    ).toEqual({ count: 1 });
  } finally {
    await cleanup(current);
  }
});

it('isolates threads, runs, logs and devices between personal tenants', async () => {
  const current = await fixture();
  const first = new TestClient(current.server);
  const second = new TestClient(current.server);
  try {
    const firstIdentity = await bootstrap(first, current);
    seedTestSession(current.database, 'tenant-b', 'tenant-b-token');
    second.setCookie('kairos_session', 'tenant-b-token');
    const secondCurrent = await second.call('AuthService', 'GetCurrentIdentity', {});
    expect(secondCurrent.statusCode).toBe(200);
    const secondIdentity = secondCurrent.json().identity;
    expect(firstIdentity.tenantId).not.toBe(secondIdentity.tenantId);
    seedTestEnvironment(current.database, firstIdentity.tenantId);
    const created = await first.call('ThreadService', 'CreateThread', {
      clientActionId: 'private-thread',
      title: '第一用户私有任务',
      environmentPolicy: testEnvironmentPolicyJson,
    });
    expect(created.statusCode).toBe(200);
    const threadId = created.json().thread.threadId;
    const sent = await first.call('MessageService', 'SendMessage', {
      clientActionId: 'private-message',
      threadId,
      text: '私有消息',
      mode: 'INPUT_MODE_FOLLOW_UP',
    });
    expect(sent.statusCode).toBe(200);
    const snapshot = await first.call('ThreadService', 'GetThread', { threadId });
    const runId = snapshot.json().snapshot.runs[0].runId;
    const registered = await first.call('EnvironmentService', 'RegisterEnvironment', {
      clientActionId: 'private-device',
      name: '私有设备',
      recommendedPwd: '/tmp',
      kind: 'ENVIRONMENT_KIND_SELF_HOSTED_LINUX',
    });
    expect(registered.statusCode).toBe(200);
    const envId = registered.json().environment.envId;
    const now = new Date().toISOString();
    current.database
      .prepare(
        `INSERT INTO server_bash_operations(
          operation_id, owner_id, thread_id, run_id, tool_call_id, log_path,
          output_complete, end_offset, expires_at, content, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 1, '0', NULL, '', 'success', ?, ?)`,
      )
      .run('private-log', firstIdentity.tenantId, threadId, runId, 'call-1', now, now);
    const uploaded = await first.call('AttachmentService', 'UploadAttachment', {
      clientActionId: 'private-attachment',
      fileName: 'private.txt',
      declaredMediaType: 'text/plain',
      data: Buffer.from('租户私有附件').toString('base64'),
    });
    expect(uploaded.statusCode).toBe(200);
    const attachmentId = uploaded.json().attachment.attachmentId;

    expect((await second.call('ThreadService', 'GetThread', { threadId })).statusCode).toBe(403);
    expect(
      (
        await second.call('ContextService', 'ReadContext', {
          threadId,
          agentId: '',
          afterSeq: '0',
          limit: 100,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await second.call('RunService', 'ContinueRun', {
          clientActionId: 'cross-account-run',
          threadId,
          runId,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await second.call('BashLogService', 'ReadBashLog', {
          operationId: 'private-log',
          offset: '0',
          limitBytes: 100,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await second.call('EnvironmentService', 'RevokeEnvironment', {
          clientActionId: 'cross-account-device',
          envId,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await second.call('AttachmentService', 'DownloadAttachment', {
          attachmentId,
          offset: '0',
          limitBytes: 100,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await second.call('AttachmentService', 'DeleteAttachment', {
          clientActionId: 'cross-account-attachment',
          attachmentId,
        })
      ).statusCode,
    ).toBe(403);
    const downloaded = await first.call(
      'AttachmentService',
      'DownloadAttachment',
      { attachmentId, offset: '0', limitBytes: 100 },
      { csrf: false },
    );
    expect(downloaded.statusCode).toBe(200);
    expect(Buffer.from(downloaded.json().data, 'base64').toString()).toBe('租户私有附件');
    const secondThreads = await second.call('ThreadService', 'ListThreads', {
      afterSeq: '0',
      limit: 100,
    });
    expect(
      secondThreads.json().threads.map((thread: { threadId: string }) => thread.threadId),
    ).toEqual([secondIdentity.mainThreadId]);
    expect((await first.call('ThreadService', 'GetThread', { threadId })).statusCode).toBe(200);
  } finally {
    await cleanup(current);
  }
});

it('accepts same-host origins alongside the public origin and omits Secure cookies on direct HTTP', async () => {
  const current = await fixture({
    allowedOrigin: 'https://kairos.example.test',
    secureCookies: true,
  });
  try {
    const direct = new TestClient(current.server);
    const directIdentity = await direct.call(
      'AuthService',
      'GetCurrentIdentity',
      {},
      { originValue: 'http://172.27.134.23:4317', host: '172.27.134.23:4317' },
    );
    expect(directIdentity.statusCode).toBe(200);
    expect(JSON.stringify(directIdentity.headers['set-cookie'])).toContain('kairos_csrf');
    expect(JSON.stringify(directIdentity.headers['set-cookie'])).not.toContain('Secure');

    const proxied = new TestClient(current.server);
    const proxiedIdentity = await proxied.call(
      'AuthService',
      'GetCurrentIdentity',
      {},
      { originValue: 'https://kairos.example.test', host: 'kairos.example.test' },
    );
    expect(proxiedIdentity.statusCode).toBe(200);
    expect(JSON.stringify(proxiedIdentity.headers['set-cookie'])).toContain('Secure');

    const foreign = new TestClient(current.server);
    const foreignCall = await foreign.call(
      'AuthService',
      'BootstrapSession',
      { token: 'invalid-token' },
      { originValue: 'https://evil.example.com', host: '172.27.134.23:4317' },
    );
    expect(foreignCall.statusCode).toBe(403);
  } finally {
    await cleanup(current);
  }
});
