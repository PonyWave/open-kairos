import {
  ConfiguredModelSchema,
  create,
  DiscoverModelsRequestSchema,
  SaveModelConnectionRequestSchema,
  UpdateProfileRequestSchema,
} from '@kairos/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { pngBytes } from '../attachments/fixtures.js';
import { AuthStore } from '../auth/store.js';
import { seedTestSession } from '../integration/test-authentication.js';
import { SessionStore } from '../sessions/store.js';
import { openDatabase } from '../storage/database.js';
import { normalizeAvatar } from './avatar.js';
import { modelAddressAllowed, validateModelUrl } from './model-network.js';
import { SettingsStore } from './store.js';

const databases: ReturnType<typeof openDatabase>[] = [];
function fixture() {
  const database = openDatabase(':memory:');
  databases.push(database);
  const sessions = new SessionStore(database);
  seedTestSession(database, 'a', 'a-token');
  seedTestSession(database, 'b', 'b-token');
  const settings = new SettingsStore(database, {
    secret: 'settings-test-secret-at-least-32-characters',
  });
  return { database, sessions, settings };
}
function connection(overrides: Partial<ReturnType<typeof createRequest>> = {}) {
  return createRequest(overrides);
}
function baseModel() {
  const model = connection().models[0];
  if (!model) throw new Error('Missing fixture model');
  return model;
}
function createRequest(overrides: object = {}) {
  return create(SaveModelConnectionRequestSchema, {
    clientActionId: 'save-1',
    expectedVersion: 0,
    id: 'connection-1',
    name: 'My provider',
    apiType: 1,
    baseUrl: 'https://models.example.com/v1',
    keyChange: { case: 'replaceKey', value: 'test-api-key-not-real' },
    models: [
      create(ConfiguredModelSchema, {
        id: 'model-1',
        name: 'Default',
        modelId: 'test-model',
        contextWindow: 8192,
        maxOutputTokens: 1024,
        timeoutMs: 30000,
      }),
    ],
    ...overrides,
  });
}
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('account and model settings', () => {
  it('isolates tenants, encrypts secrets, and deduplicates mutations without retaining the key in action records', () => {
    const { settings, database } = fixture();
    const request = connection();
    const saved = settings.save('a', request);
    expect(saved.defaultModelId).toBe('model-1');
    expect(saved.version).toBe(1);
    expect(settings.save('a', request).version).toBe(1);
    expect(settings.get('b').connections).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain('test-api-key-not-real');
    const row = database.prepare('SELECT encrypted_key FROM model_connections').get();
    expect(String(row?.encrypted_key)).not.toContain('test-api-key-not-real');
    expect(JSON.stringify(database.prepare('SELECT * FROM settings_actions').all())).not.toContain(
      'test-api-key-not-real',
    );
    expect(() => settings.save('a', connection({ name: 'changed' }))).toThrow(/编号/);
    expect(() =>
      settings.delete('b', { id: 'connection-1', expectedVersion: 0, clientActionId: 'delete' }),
    ).toThrow(/不存在/);
  });
  it('checks versions and preserves default references when models or connections are removed', () => {
    const { settings } = fixture();
    settings.save('a', connection());
    expect(() => settings.save('a', connection({ clientActionId: 'stale' }))).toThrow(/其他页面/);
    expect(() =>
      settings.delete('a', { clientActionId: 'delete', expectedVersion: 1, id: 'connection-1' }),
    ).toThrow(/默认模型/);
    expect(() =>
      settings.save(
        'a',
        connection({
          clientActionId: 'remove-default',
          expectedVersion: 1,
          models: [create(ConfiguredModelSchema, { ...baseModel(), id: 'other' })],
        }),
      ),
    ).toThrow(/默认模型/);
    settings.save(
      'a',
      connection({
        clientActionId: 'second',
        expectedVersion: 1,
        id: 'second',
        models: [create(ConfiguredModelSchema, { ...baseModel(), id: 'second-model' })],
      }),
    );
    settings.setDefault('a', {
      clientActionId: 'set-default',
      expectedVersion: 2,
      modelId: 'second-model',
    });
    expect(
      settings.delete('a', { clientActionId: 'delete', expectedVersion: 3, id: 'connection-1' })
        .connections,
    ).toHaveLength(1);
  });
  it('retains, replaces and removes keys explicitly and requires credentials to be reviewed on service changes', () => {
    const { settings, database } = fixture();
    settings.save('a', connection());
    const before = database
      .prepare('SELECT encrypted_key FROM model_connections')
      .get()?.encrypted_key;
    settings.save(
      'a',
      connection({ clientActionId: 'keep', expectedVersion: 1, keyChange: { case: undefined } }),
    );
    expect(
      database.prepare('SELECT encrypted_key FROM model_connections').get()?.encrypted_key,
    ).toBe(before);
    expect(() =>
      settings.save(
        'a',
        connection({
          clientActionId: 'move',
          expectedVersion: 2,
          baseUrl: 'https://other.example.com/v1',
          keyChange: { case: undefined },
        }),
      ),
    ).toThrow(/重新输入/);
    settings.save(
      'a',
      connection({
        clientActionId: 'replace',
        expectedVersion: 2,
        keyChange: { case: 'replaceKey', value: 'replacement-key' },
      }),
    );
    expect(
      database.prepare('SELECT encrypted_key FROM model_connections').get()?.encrypted_key,
    ).not.toBe(before);
    expect(
      settings.save(
        'a',
        connection({
          clientActionId: 'remove',
          expectedVersion: 3,
          keyChange: { case: 'removeKey', value: true },
        }),
      ).connections[0]?.hasKey,
    ).toBe(false);
  });
  it('fixes model and credential versions for existing runs, including after configuration deletion', () => {
    const { settings, sessions, database } = fixture();
    settings.save('a', connection());
    const thread = sessions.getOrCreateMainThread('a');
    const first = sessions.sendMessage({
      ownerId: 'a',
      clientActionId: 'input-1',
      method: 'SendMessage',
      parameters: {},
      threadId: thread.threadId,
      text: 'first',
      mode: 'follow_up',
    });
    const run = sessions.getRunById(first.runId);
    const original = settings.capture(run);
    settings.recordRequest(
      'a',
      'request-1',
      original ??
        (() => {
          throw new Error('missing model');
        })(),
    );
    settings.save(
      'a',
      connection({
        clientActionId: 'edit',
        expectedVersion: 1,
        models: [create(ConfiguredModelSchema, { ...baseModel(), modelId: 'new-model' })],
      }),
    );
    expect(settings.capture(run)?.modelId).toBe('test-model');
    expect(settings.resolve('a')?.modelId).toBe('new-model');
    expect(() =>
      settings.recordRequest(
        'a',
        'request-1',
        settings.resolve('a') ??
          (() => {
            throw new Error('missing model');
          })(),
      ),
    ).toThrow(/不一致/);
    expect(
      JSON.stringify(database.prepare('SELECT * FROM request_model_configurations').all()),
    ).not.toContain('test-api-key-not-real');
    sessions.updateRunStatus(run.runId, 'completed');
    const second = sessions.sendMessage({
      ownerId: 'a',
      clientActionId: 'input-2',
      method: 'SendMessage',
      parameters: {},
      threadId: thread.threadId,
      text: 'second',
      mode: 'follow_up',
    });
    expect(settings.capture(sessions.getRunById(second.runId))?.modelId).toBe('new-model');
  });
  it('updates profile and avatar atomically, retains stable identity and rejects stale writes', () => {
    const { settings, database } = fixture();
    const auth = new AuthStore(database);
    const original = auth.getIdentityForUser('user-a');
    const input = create(UpdateProfileRequestSchema, {
      clientActionId: 'profile',
      expectedVersion: 0,
      username: ' 小林 ',
      avatarChange: { case: 'replaceAvatar', value: pngBytes },
    });
    settings.updateProfile('a', 'user-a', input);
    settings.updateProfile('a', 'user-a', input);
    const identity = auth.getIdentityForUser('user-a');
    expect(identity).toMatchObject({
      userId: original?.userId,
      tenantId: original?.tenantId,
      mainThreadId: original?.mainThreadId,
      email: original?.email,
      username: '小林',
      profileVersion: 1,
    });
    const id = identity?.avatarId ?? '';
    expect(settings.readAvatar('user-a', id).content).toEqual(new Uint8Array(pngBytes));
    expect(() => settings.readAvatar('user-b', id)).toThrow(/不存在/);
    expect(() =>
      settings.updateProfile(
        'a',
        'user-a',
        create(UpdateProfileRequestSchema, { clientActionId: 'stale', username: 'other' }),
      ),
    ).toThrow(/其他页面/);
    settings.updateProfile(
      'a',
      'user-a',
      create(UpdateProfileRequestSchema, {
        clientActionId: 'remove',
        expectedVersion: 1,
        username: '小林',
        avatarChange: { case: 'removeAvatar', value: true },
      }),
    );
    expect(auth.getIdentityForUser('user-a')?.avatarId).toBeUndefined();
    expect(() => settings.readAvatar('user-a', id)).toThrow();
  });
  it('rejects unsupported APIs, invalid model budgets and invalid avatar bytes', () => {
    const { settings } = fixture();
    expect(() => settings.save('a', connection({ apiType: 0 }))).toThrow(/仅支持/);
    expect(() =>
      settings.save(
        'a',
        connection({
          models: [create(ConfiguredModelSchema, { ...baseModel(), maxOutputTokens: 8192 })],
        }),
      ),
    ).toThrow(/容量/);
    expect(() => normalizeAvatar(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => normalizeAvatar(new Uint8Array(256 * 1024 + 1))).toThrow(/256/);
    const corrupted = Buffer.from(pngBytes);
    corrupted[45] = 0;
    expect(() => normalizeAvatar(corrupted)).toThrow();
  });
  it('saves, reads and edits Responses and Anthropic connections with explicit credential review', () => {
    const { settings, database } = fixture();
    const saved = settings.save('a', connection({ apiType: 2 }));
    expect(saved.connections[0]?.apiType).toBe(2);
    expect(settings.resolve('a')?.provider.constructor.name).toBe('OpenAIResponsesProvider');
    expect(() =>
      settings.save(
        'a',
        connection({
          clientActionId: 'change-api',
          expectedVersion: 1,
          apiType: 3,
          keyChange: { case: undefined },
        }),
      ),
    ).toThrow(/重新输入/);
    const edited = settings.save(
      'a',
      connection({
        clientActionId: 'change-api-with-key',
        expectedVersion: 1,
        apiType: 3,
        keyChange: { case: 'replaceKey', value: 'anthropic-fixture-key' },
      }),
    );
    expect(edited.connections[0]?.apiType).toBe(3);
    expect(settings.resolve('a')?.provider.constructor.name).toBe('AnthropicMessagesProvider');
    expect(database.prepare('SELECT api_type FROM model_connections').get()?.api_type).toBe(3);
  });
  it('keeps legacy Chat Completions configuration IDs unchanged when snapshots lack apiType', () => {
    const { settings, sessions, database } = fixture();
    settings.save('a', connection());
    const thread = sessions.getOrCreateMainThread('a');
    const sent = sessions.sendMessage({
      ownerId: 'a',
      clientActionId: 'legacy-snapshot-input',
      method: 'SendMessage',
      parameters: {},
      threadId: thread.threadId,
      text: 'legacy snapshot',
      mode: 'follow_up',
    });
    const run = sessions.getRunById(sent.runId);
    const current = settings.capture(run);
    if (!current?.configurationId) throw new Error('Missing current configuration.');
    const stored = database
      .prepare('SELECT configuration_json FROM run_model_configurations WHERE run_id = ?')
      .get(run.runId);
    const legacy = JSON.parse(String(stored?.configuration_json)) as Record<string, unknown>;
    delete legacy.apiType;
    database
      .prepare('UPDATE run_model_configurations SET configuration_json = ? WHERE run_id = ?')
      .run(JSON.stringify(legacy), run.runId);
    const credentialVersion = (JSON.parse(current.configurationId) as Record<string, unknown>)
      .credentialVersion;
    const expectedId = JSON.stringify({ ownerId: 'a', ...legacy, credentialVersion });
    const restored = settings.capture(run);
    expect(restored?.configurationId).toBe(expectedId);
    expect(restored?.provider.constructor.name).toBe('OpenAICompatibleProvider');
    expect(JSON.parse(restored?.configurationId ?? '{}')).not.toHaveProperty('apiType');
    settings.recordRequest('a', 'legacy-request', restored ?? current);
    expect(settings.acceptRecap('legacy-request', expectedId)).toBe(true);
  });
});

describe('model discovery', () => {
  function discoverFixture(fetchImplementation: typeof fetch) {
    const database = openDatabase(':memory:');
    databases.push(database);
    seedTestSession(database, 'a', 'a-token');
    const settings = new SettingsStore(database, {
      secret: 'settings-test-secret-at-least-32-characters',
      fetch: fetchImplementation,
    });
    return settings;
  }
  function discoverRequest(overrides: object = {}) {
    return create(DiscoverModelsRequestSchema, {
      apiType: 1,
      baseUrl: 'https://models.example.com/v1',
      ...overrides,
    });
  }
  const jsonList = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('lists models with an inline key without persisting it', async () => {
    const calls: { url: string; authorization: string | undefined }[] = [];
    const settings = discoverFixture(async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
      });
      return jsonList({ data: [{ id: 'model-a' }, { id: 'model-b' }] });
    });
    const result = await settings.discover(
      'a',
      discoverRequest({ apiKey: 'inline-key-not-real' }),
      new AbortController().signal,
    );
    expect(result.models).toEqual([
      { modelId: 'model-a', displayName: '' },
      { modelId: 'model-b', displayName: '' },
    ]);
    expect(calls).toEqual([
      { url: 'https://models.example.com/v1/models', authorization: 'Bearer inline-key-not-real' },
    ]);
  });

  it('reuses the saved key only for an unchanged endpoint and API type', async () => {
    const authorizations: (string | null)[] = [];
    const settings = discoverFixture(async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get('authorization'));
      return jsonList({ data: [{ id: 'model-a' }] });
    });
    settings.save('a', connection());
    await settings.discover(
      'a',
      discoverRequest({ connectionId: 'connection-1' }),
      new AbortController().signal,
    );
    expect(authorizations).toEqual(['Bearer test-api-key-not-real']);
    await expect(
      settings.discover(
        'a',
        discoverRequest({ baseUrl: 'https://other.example.com/v1', connectionId: 'connection-1' }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/重新输入 API key/);
    await expect(
      settings.discover(
        'a',
        discoverRequest({ apiType: 3, connectionId: 'connection-1' }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/重新输入 API key/);
    await expect(
      settings.discover(
        'a',
        discoverRequest({ connectionId: 'missing-connection' }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/不存在/);
  });

  it('validates the API type and base URL before requesting', async () => {
    let requested = 0;
    const settings = discoverFixture(async () => {
      requested += 1;
      return jsonList({ data: [] });
    });
    await expect(
      settings.discover('a', discoverRequest({ apiType: 0 }), new AbortController().signal),
    ).rejects.toThrow(/API 类型/);
    await expect(
      settings.discover(
        'a',
        discoverRequest({ baseUrl: 'http://models.example.com' }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/HTTPS/);
    expect(requested).toBe(0);
  });
});

describe('model address policy', () => {
  it('checks protocols, endpoint ambiguity, credentials and mapped address ranges', () => {
    expect(validateModelUrl('https://example.com/v1/')).toBe('https://example.com/v1');
    for (const value of [
      'http://example.com',
      'https://name:secret@example.com',
      'https://example.com?key=secret',
      'https://example.com/v1/chat/completions',
      'https://example.com/v1/responses',
      'https://api.anthropic.com/v1/messages',
    ])
      expect(() => validateModelUrl(value)).toThrow();
    expect(validateModelUrl('http://localhost:8000/v1', ['http://localhost:8000'])).toBe(
      'http://localhost:8000/v1',
    );
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '::1',
      '::ffff:127.0.0.1',
      '::127.0.0.1',
      '2001:db8::1',
    ])
      expect(modelAddressAllowed(address, false)).toBe(false);
    expect(modelAddressAllowed('8.8.8.8', false)).toBe(true);
    expect(modelAddressAllowed('::ffff:8.8.8.8', false)).toBe(true);
    expect(modelAddressAllowed('127.0.0.1', true)).toBe(true);
    expect(modelAddressAllowed('169.254.169.254', true)).toBe(false);
  });
});
