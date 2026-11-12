import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ModelEvent } from '@kairos/agent-core';
import { ScriptedProvider } from '@kairos/agent-core/testing';
import type { FastifyInstance } from 'fastify';
import { expect, it, vi } from 'vitest';
import type { IdentityServerOptions } from '../app.js';
import type { EmailMessage } from '../auth/mailer.js';
import { LOCAL_TEST_CODE, LOCAL_TEST_EMAIL } from '../auth/service.js';
import { openDatabase } from '../storage/database.js';
import {
  createEnvironmentTestServer as createServer,
  seedTestEnvironment,
  testEnvironmentPolicyJson,
} from './environment-fixture.js';

const origin = 'http://127.0.0.1:4317';

class TestClient {
  readonly #server: FastifyInstance;
  readonly #cookies = new Map<string, string>();

  constructor(server: FastifyInstance, cookies?: Map<string, string>) {
    this.#server = server;
    if (cookies) {
      for (const [name, value] of cookies) this.#cookies.set(name, value);
    }
  }

  fork(): TestClient {
    return new TestClient(this.#server, this.#cookies);
  }

  async call(
    service: string,
    method: string,
    payload: Record<string, unknown>,
    options: { origin?: boolean; csrf?: boolean } = {},
  ) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'connect-protocol-version': '1',
    };
    if (options.origin !== false) headers.origin = origin;
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
  messages: EmailMessage[];
  now: Date;
  advance: (milliseconds: number) => void;
}

async function fixture(
  limitOverrides: IdentityServerOptions['limits'] = {},
  invitedEmails: readonly string[] = ['second@example.com'],
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'kairos-auth-integration-'));
  const database = openDatabase(':memory:');
  const messages: EmailMessage[] = [];
  const current = new Date();
  const provider = new ScriptedProvider([
    modelResponse('无环境普通回复'),
    modelResponse('第二个回复'),
  ]);
  const server = createServer(database, false, {
    identity: {
      secret: 'integration-authentication-secret-at-least-32-characters',
      invitedEmails,
      testAccountEnabled: true,
      allowedOrigin: origin,
      secureCookies: false,
      mailer: {
        async send(message) {
          messages.push(message);
        },
      },
      limits: {
        resendIntervalMs: 60_000,
        sourceLimit: 100,
        globalLimit: 100,
        ...limitOverrides,
      },
    },
    model: {
      provider,
      providerId: 'test',
      modelId: 'test-model',
      contextWindowTokens: 128_000,
      outputReserveTokens: 4096,
    },
    now: () => current,
  });
  return {
    server,
    database,
    directory,
    messages,
    now: current,
    advance(milliseconds) {
      current.setTime(current.getTime() + milliseconds);
    },
  };
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

async function login(client: TestClient, current: Fixture, email: string, username: string) {
  await initialize(client);
  const requested = await client.call('AuthService', 'RequestEmailCode', {
    email,
    clientActionId: randomUUID(),
  });
  expect(requested.statusCode).toBe(200);
  const verificationId = requested.json().verificationId;
  const code =
    email === LOCAL_TEST_EMAIL
      ? LOCAL_TEST_CODE
      : /(\d{6})/.exec(current.messages.at(-1)?.text ?? '')?.[1];
  expect(code).toMatch(/^\d{6}$/);
  const verified = await client.call('AuthService', 'VerifyEmailCode', {
    email,
    verificationId,
    code,
  });
  expect(verified.statusCode).toBe(200);
  if (verified.json().state === 'AUTHENTICATION_STATE_AUTHENTICATED') {
    const currentIdentity = await client.call('AuthService', 'GetCurrentIdentity', {});
    expect(currentIdentity.json().state).toBe('AUTHENTICATION_STATE_AUTHENTICATED');
    return verified.json().identity;
  }
  expect(verified.json().state).toBe('AUTHENTICATION_STATE_PROFILE_REQUIRED');
  const setupIdentity = await client.call('AuthService', 'GetCurrentIdentity', {});
  expect(setupIdentity.json().state).toBe('AUTHENTICATION_STATE_PROFILE_REQUIRED');
  const completed = await client.call('AuthService', 'CompleteProfile', { username });
  expect(completed.statusCode).toBe(200);
  const currentIdentity = await client.call('AuthService', 'GetCurrentIdentity', {});
  expect(currentIdentity.json().state).toBe('AUTHENTICATION_STATE_AUTHENTICATED');
  return completed.json().identity;
}

it('registers and logs in an arbitrary email with captured SMTP codes when invitations are open', async () => {
  const current = await fixture({ resendIntervalMs: 0 }, ['*']);
  const client = new TestClient(current.server);
  const returningClient = new TestClient(current.server);
  try {
    const email = 'open-person@example.net';
    const identity = await login(client, current, email, '开放邀请用户');
    expect(current.messages).toHaveLength(1);
    expect(current.messages[0]?.to).toBe(email);
    const threads = await client.call('ThreadService', 'ListThreads', {
      afterSeq: '0',
      limit: 10,
    });
    expect(threads.statusCode).toBe(200);
    expect(threads.json().threads.map((thread: { threadId: string }) => thread.threadId)).toEqual([
      identity.mainThreadId,
    ]);

    const restoredIdentity = await login(returningClient, current, email, '再次登录');
    expect(restoredIdentity).toMatchObject({
      email,
      tenantId: identity.tenantId,
      mainThreadId: identity.mainThreadId,
    });
    expect(current.messages).toHaveLength(2);
    expect(current.messages.every((message) => message.to === email)).toBe(true);
    expect(current.database.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({
      count: 1,
    });
    expect(current.database.prepare('SELECT COUNT(*) AS count FROM tenants').get()).toEqual({
      count: 1,
    });
  } finally {
    await cleanup(current);
  }
});

it('continues to reject emails outside an ordinary invitation list', async () => {
  const current = await fixture();
  const client = new TestClient(current.server);
  try {
    await initialize(client);
    const requested = await client.call('AuthService', 'RequestEmailCode', {
      email: 'outside@example.net',
      clientActionId: randomUUID(),
    });
    expect(requested.statusCode).toBe(403);
    expect(current.messages).toHaveLength(0);
  } finally {
    await cleanup(current);
  }
});

it('runs the local login lifecycle with CSRF, replay, concurrency and ordinary conversation', async () => {
  const current = await fixture();
  const client = new TestClient(current.server);
  try {
    await initialize(client);
    const missingCsrf = await client.call(
      'AuthService',
      'RequestEmailCode',
      { email: LOCAL_TEST_EMAIL, clientActionId: 'missing-csrf' },
      { csrf: false },
    );
    expect(missingCsrf.statusCode).toBe(403);
    const wrongOrigin = await client.call(
      'AuthService',
      'RequestEmailCode',
      { email: LOCAL_TEST_EMAIL, clientActionId: 'wrong-origin' },
      { origin: false },
    );
    expect(wrongOrigin.statusCode).toBe(403);

    const requested = await client.call('AuthService', 'RequestEmailCode', {
      email: ` ${LOCAL_TEST_EMAIL.toUpperCase()} `,
      clientActionId: 'request-1',
    });
    expect(requested.statusCode).toBe(200);
    const firstVerification = requested.json().verificationId;
    expect(current.messages).toHaveLength(0);
    const duplicate = await client.call('AuthService', 'RequestEmailCode', {
      email: LOCAL_TEST_EMAIL,
      clientActionId: 'request-1',
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().verificationId).toBe(firstVerification);
    const wrong = await client.call('AuthService', 'VerifyEmailCode', {
      email: LOCAL_TEST_EMAIL,
      verificationId: firstVerification,
      code: '111111',
    });
    expect(wrong.statusCode).toBe(401);
    expect(
      current.database
        .prepare(
          'SELECT attempts, code_hash FROM auth_email_verifications WHERE verification_id = ?',
        )
        .get(firstVerification),
    ).toMatchObject({ attempts: 1 });
    expect(
      current.database
        .prepare('SELECT code_hash FROM auth_email_verifications WHERE verification_id = ?')
        .get(firstVerification),
    ).not.toMatchObject({ code_hash: LOCAL_TEST_CODE });

    const tooSoon = await client.call('AuthService', 'RequestEmailCode', {
      email: LOCAL_TEST_EMAIL,
      clientActionId: 'request-too-soon',
    });
    expect(tooSoon.statusCode).toBe(429);
    current.advance(61_000);
    const resent = await client.call('AuthService', 'RequestEmailCode', {
      email: LOCAL_TEST_EMAIL,
      clientActionId: 'request-2',
    });
    expect(resent.statusCode).toBe(200);
    const secondVerification = resent.json().verificationId;
    const invalidated = await client.call('AuthService', 'VerifyEmailCode', {
      email: LOCAL_TEST_EMAIL,
      verificationId: firstVerification,
      code: LOCAL_TEST_CODE,
    });
    expect(invalidated.statusCode).toBe(401);

    const verified = await client.call('AuthService', 'VerifyEmailCode', {
      email: LOCAL_TEST_EMAIL,
      verificationId: secondVerification,
      code: LOCAL_TEST_CODE,
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().state).toBe('AUTHENTICATION_STATE_PROFILE_REQUIRED');
    const setCookies = verified.headers['set-cookie'];
    expect(JSON.stringify(setCookies)).toContain('HttpOnly');
    expect(JSON.stringify(setCookies)).toContain('SameSite=Strict');
    expect(JSON.stringify(setCookies)).not.toContain('Secure');
    const replay = await client.call('AuthService', 'VerifyEmailCode', {
      email: LOCAL_TEST_EMAIL,
      verificationId: secondVerification,
      code: LOCAL_TEST_CODE,
    });
    expect(replay.statusCode).toBe(401);
    const setupCannotRead = await client.call('ThreadService', 'ListThreads', {
      afterSeq: '0',
      limit: 10,
    });
    expect(setupCannotRead.statusCode).toBe(401);

    const firstProfile = client.fork();
    const secondProfile = client.fork();
    const [firstCompleted, secondCompleted] = await Promise.all([
      firstProfile.call('AuthService', 'CompleteProfile', { username: '测试用户' }),
      secondProfile.call('AuthService', 'CompleteProfile', { username: '测试用户' }),
    ]);
    expect(firstCompleted.statusCode).toBe(200);
    expect(secondCompleted.statusCode).toBe(401);
    const identity = firstCompleted.json().identity;
    expect(identity).not.toHaveProperty('defaultEnvId');
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
    expect(current.database.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get()).toEqual({
      count: 1,
    });
    expect((await secondProfile.call('AuthService', 'GetCurrentIdentity', {})).json().state).toBe(
      'AUTHENTICATION_STATE_ANONYMOUS',
    );
    current.advance(61_000);
    const secondLogin = await secondProfile.call('AuthService', 'RequestEmailCode', {
      email: LOCAL_TEST_EMAIL,
      clientActionId: 'second-browser-login',
    });
    expect(secondLogin.statusCode).toBe(200);
    const secondSession = await secondProfile.call('AuthService', 'VerifyEmailCode', {
      email: LOCAL_TEST_EMAIL,
      verificationId: secondLogin.json().verificationId,
      code: LOCAL_TEST_CODE,
    });
    expect(secondSession.statusCode).toBe(200);
    expect(secondSession.json().state).toBe('AUTHENTICATION_STATE_AUTHENTICATED');
    expect(secondSession.json().identity.tenantId).toBe(identity.tenantId);
    expect(
      current.database
        .prepare('SELECT default_env_id FROM tenants WHERE tenant_id = ?')
        .get(identity.tenantId),
    ).toEqual({ default_env_id: null });

    const currentIdentity = await firstProfile.call('AuthService', 'GetCurrentIdentity', {});
    expect(currentIdentity.json().state).toBe('AUTHENTICATION_STATE_AUTHENTICATED');
    expect(currentIdentity.json().identity.email).toBe(LOCAL_TEST_EMAIL);
    const businessWithoutCsrf = await firstProfile.call(
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
    const sent = await firstProfile.call('MessageService', 'SendMessage', {
      clientActionId: 'ordinary-message',
      threadId: identity.mainThreadId,
      text: '没有环境也能对话吗？',
      mode: 'INPUT_MODE_FOLLOW_UP',
    });
    expect(sent.statusCode).toBe(200);
    await vi.waitFor(async () => {
      const snapshot = await firstProfile.call('ThreadService', 'GetThread', {
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

    const logoutWithoutCsrf = await firstProfile.call('AuthService', 'Logout', {}, { csrf: false });
    expect(logoutWithoutCsrf.statusCode).toBe(403);
    const logout = await firstProfile.call('AuthService', 'Logout', {});
    expect(logout.statusCode).toBe(200);
    const loggedOut = await firstProfile.call('ThreadService', 'ListThreads', {
      afterSeq: '0',
      limit: 10,
    });
    expect(loggedOut.statusCode).toBe(401);
    expect((await secondProfile.call('AuthService', 'GetCurrentIdentity', {})).json().state).toBe(
      'AUTHENTICATION_STATE_AUTHENTICATED',
    );

    current.advance(61_000);
    const requestedAgain = await firstProfile.call('AuthService', 'RequestEmailCode', {
      email: LOCAL_TEST_EMAIL,
      clientActionId: 'login-again',
    });
    expect(requestedAgain.statusCode).toBe(200);
    const verifiedAgain = await firstProfile.call('AuthService', 'VerifyEmailCode', {
      email: LOCAL_TEST_EMAIL,
      verificationId: requestedAgain.json().verificationId,
      code: LOCAL_TEST_CODE,
    });
    expect(verifiedAgain.statusCode).toBe(200);
    expect(verifiedAgain.json().state).toBe('AUTHENTICATION_STATE_AUTHENTICATED');
    expect(verifiedAgain.json().identity.tenantId).toBe(identity.tenantId);
    expect(verifiedAgain.json().identity.mainThreadId).toBe(identity.mainThreadId);
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
  const current = await fixture({ resendIntervalMs: 0 });
  const first = new TestClient(current.server);
  const second = new TestClient(current.server);
  try {
    const firstIdentity = await login(first, current, LOCAL_TEST_EMAIL, '第一用户');
    const secondIdentity = await login(second, current, 'second@example.com', '第二用户');
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
