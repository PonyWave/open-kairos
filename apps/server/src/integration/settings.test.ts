import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { pngBytes } from '../attachments/fixtures.js';
import { openDatabase } from '../storage/database.js';
import { createTestServer, seedTestSession, testSessionHeaders } from './test-authentication.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const database = openDatabase(':memory:');
  let redirect = false;
  const received: Array<{
    authorization: string | undefined;
    apiKey: string | undefined;
    body: string;
    path: string;
  }> = [];
  const model = createHttpServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      received.push({
        authorization: request.headers.authorization,
        apiKey:
          typeof request.headers['x-api-key'] === 'string'
            ? request.headers['x-api-key']
            : undefined,
        body,
        path: request.url ?? '',
      });
      if (redirect) {
        response.writeHead(302, { location: '/secret-sink' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      if (request.url?.endsWith('/responses')) {
        response.write(
          data({
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              type: 'function_call',
              id: 'response-item',
              call_id: 'probe-call',
              name: 'kairos_settings_probe',
              arguments: '{}',
            },
          }),
        );
        response.end(
          data({
            type: 'response.completed',
            response: {
              status: 'completed',
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          }),
        );
        return;
      }
      if (request.url?.endsWith('/v1/messages')) {
        response.write(
          data({
            type: 'message_start',
            message: { usage: { input_tokens: 10, output_tokens: 1 } },
          }),
        );
        response.write(
          data({
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'probe-call',
              name: 'kairos_settings_probe',
              input: {},
            },
          }),
        );
        response.write(
          data({
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 5 },
          }),
        );
        response.end(data({ type: 'message_stop' }));
        return;
      }
      response.write(
        data({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'probe-call',
                    type: 'function',
                    function: { name: 'kairos_settings_probe', arguments: '{}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
      response.write(
        data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      );
      response.end('data: [DONE]\n\n');
    });
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  cleanups.push(() => new Promise<void>((resolve) => model.close(() => resolve())));
  const address = model.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const modelOrigin = `http://127.0.0.1:${address.port}`;
  const server = createTestServer(database, false, {
    modelSettings: { allowedOrigins: [modelOrigin] },
  });
  seedTestSession(database, 'other', 'other-session');
  await server.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => server.close());
  const serverAddress = server.server.address();
  if (!serverAddress || typeof serverAddress === 'string') throw new Error('missing address');
  const baseUrl = `http://127.0.0.1:${serverAddress.port}`;
  const call = async (method: string, payload: object = {}, token?: string, csrf = true) => {
    const headers = testSessionHeaders(token);
    if (!csrf) delete headers['x-csrf-token'];
    return fetch(`${baseUrl}/kairos.gui.v1.SettingsService/${method}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'connect-protocol-version': '1' },
      body: JSON.stringify(payload),
    });
  };
  const connection = {
    clientActionId: 'save-connection',
    id: 'c1',
    name: 'Local fixture',
    apiType: 'MODEL_API_TYPE_OPENAI_CHAT_COMPLETIONS',
    baseUrl: `${modelOrigin}/v1`,
    replaceKey: 'fixture-api-key',
    models: [
      {
        id: 'm1',
        name: 'Fixture',
        modelId: 'fixture',
        contextWindow: 8192,
        maxOutputTokens: 1024,
        timeoutMs: 10000,
      },
    ],
  };
  return {
    database,
    call,
    connection,
    received,
    redirect: () => {
      redirect = true;
    },
  };
}

it('serves account and model settings over HTTP with authentication, CSRF, tenant isolation and write-only credentials', async () => {
  const current = await fixture();
  expect((await current.call('GetSettings', {}, 'invalid')).status).toBe(401);
  expect(
    (await current.call('SaveModelConnection', current.connection, undefined, false)).status,
  ).toBe(403);
  const saved = await current.call('SaveModelConnection', current.connection);
  expect(saved.status).toBe(200);
  const payload = await saved.text();
  expect(payload).toContain('hasKey');
  expect(payload).not.toContain('fixture-api-key');
  expect((await current.call('SaveModelConnection', current.connection)).status).toBe(200);
  const other = await (await current.call('GetSettings', {}, 'other-session')).json();
  expect(other.settings?.connections ?? []).toEqual([]);
  expect(
    (
      await current.call(
        'TestConfiguredModel',
        { modelId: 'm1', expectedVersion: 1 },
        'other-session',
      )
    ).status,
  ).not.toBe(200);
  const tested = await current.call('TestConfiguredModel', { modelId: 'm1', expectedVersion: 1 });
  expect(tested.status).toBe(200);
  expect(await tested.json()).toMatchObject({ passed: true });
  expect(current.received[0]).toMatchObject({
    authorization: 'Bearer fixture-api-key',
    path: '/v1/chat/completions',
  });
  expect(JSON.parse(current.received[0]?.body ?? '{}').max_tokens).toBeLessThanOrEqual(128);
});

it.each([
  {
    apiType: 'MODEL_API_TYPE_OPENAI_RESPONSES',
    basePath: '/v1',
    path: '/v1/responses',
    header: 'authorization' as const,
    credential: 'Bearer fixture-api-key',
  },
  {
    apiType: 'MODEL_API_TYPE_ANTHROPIC_MESSAGES',
    basePath: '',
    path: '/v1/messages',
    header: 'apiKey' as const,
    credential: 'fixture-api-key',
  },
])('saves and tests $apiType through the native HTTP endpoint', async (fixtureType) => {
  const current = await fixture();
  const baseUrl = new URL(current.connection.baseUrl);
  const saved = await current.call('SaveModelConnection', {
    ...current.connection,
    apiType: fixtureType.apiType,
    baseUrl: `${baseUrl.origin}${fixtureType.basePath}`,
  });
  expect(saved.status).toBe(200);
  expect(await saved.text()).toContain(fixtureType.apiType);
  const tested = await current.call('TestConfiguredModel', { modelId: 'm1', expectedVersion: 1 });
  expect(tested.status).toBe(200);
  expect(await tested.json()).toMatchObject({ passed: true });
  expect(current.received).toHaveLength(1);
  expect(current.received[0]).toMatchObject({
    path: fixtureType.path,
    [fixtureType.header]: fixtureType.credential,
  });
  const body = JSON.parse(current.received[0]?.body ?? '{}');
  expect(body.max_output_tokens ?? body.max_tokens).toBeLessThanOrEqual(128);
  if (fixtureType.apiType === 'MODEL_API_TYPE_OPENAI_RESPONSES') expect(body.store).toBe(false);
});

it('updates and reads the current user avatar without exposing another account image', async () => {
  const { call, database } = await fixture();
  const response = await call('UpdateProfile', {
    clientActionId: 'profile',
    username: '小林',
    replaceAvatar: pngBytes.toString('base64'),
  });
  expect(response.status).toBe(200);
  const identity = (await response.json()).identity;
  expect(identity).toMatchObject({ username: '小林', profileVersion: 1 });
  const avatar = await call('ReadAvatar', { avatarId: identity.avatarId });
  expect(avatar.status).toBe(200);
  expect((await avatar.json()).content).toBe(pngBytes.toString('base64'));
  expect((await call('ReadAvatar', { avatarId: identity.avatarId }, 'other-session')).status).toBe(
    404,
  );
  expect(database.prepare('SELECT COUNT(*) AS count FROM context_messages').get()?.count).toBe(0);
});

it('rejects redirects without forwarding the API key to the next target', async () => {
  const current = await fixture();
  await current.call('SaveModelConnection', current.connection);
  current.redirect();
  const response = await current.call('TestConfiguredModel', { modelId: 'm1', expectedVersion: 1 });
  expect(response.status).toBe(200);
  expect((await response.json()).passed ?? false).toBe(false);
  expect(current.received).toHaveLength(1);
  expect(current.received[0]?.path).toBe('/v1/chat/completions');
});
