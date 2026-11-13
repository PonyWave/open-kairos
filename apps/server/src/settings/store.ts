import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type ConfiguredModel,
  ConfiguredModelSchema,
  type DiscoverModelsRequest,
  fromJsonString,
  ModelApiType,
  type SaveModelConnectionRequest,
  toJsonString,
  type UpdateProfileRequest,
} from '@kairos/contracts';
import { z } from 'zod';
import { listProviderModels } from '../providers/discovery.js';
import { createModelProvider, providerIdForApiType } from '../providers/factory.js';
import { requireText, SessionError } from '../sessions/errors.js';
import type { RunRecord } from '../sessions/records.js';
import type { RuntimeModelConfiguration } from '../sessions/runtime.js';
import { inTransaction } from '../storage/transaction.js';
import { normalizeAvatar } from './avatar.js';
import { modelFetch, validateModelUrl } from './model-network.js';

const apiTypeSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const rowSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  name: z.string(),
  api_type: apiTypeSchema,
  base_url: z.string(),
  encrypted_key: z.string().nullable(),
  models_json: z.string(),
  revision: z.number().int().positive(),
});
const stateSchema = z.object({
  version: z.number().int().nonnegative(),
  default_model_id: z.string(),
});
const profileSchema = z.object({
  version: z.number().int().nonnegative(),
  avatar_id: z.string().nullable(),
  avatar_bytes: z.instanceof(Uint8Array).nullable(),
});
const snapshotSchema = z.object({
  kind: z.enum(['platform', 'custom']),
  id: z.string(),
  modelId: z.string(),
  providerId: z.string(),
  apiType: apiTypeSchema.optional(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().nonnegative(),
  timeoutMs: z.number().int().positive(),
  supportsVision: z.boolean(),
  baseUrl: z.string().optional(),
  revision: z.number().int().nonnegative(),
  platformFingerprint: z.string().optional(),
});
type Snapshot = z.infer<typeof snapshotSchema>;
const snapshotRowSchema = z.object({
  tenant_id: z.string(),
  configuration_json: z.string(),
  encrypted_key: z.string().nullable(),
});

export interface ModelSettingsOptions {
  secret: string;
  platformModel?: RuntimeModelConfiguration;
  allowedOrigins?: readonly string[];
  fetch?: typeof globalThis.fetch;
}

export class SettingsStore {
  readonly #key: Buffer;
  readonly #fetch: typeof globalThis.fetch;
  readonly #allowedOrigins: readonly string[];
  constructor(
    readonly database: DatabaseSync,
    readonly options: ModelSettingsOptions,
  ) {
    this.#key = Buffer.from(hkdfSync('sha256', options.secret, '', 'kairos-settings-v1', 32));
    this.#allowedOrigins = options.allowedOrigins ?? [];
    this.#fetch = options.fetch ?? modelFetch(this.#allowedOrigins);
  }

  get(ownerId: string) {
    const state = this.#state(ownerId);
    const platform = this.options.platformModel;
    return {
      version: state.version,
      defaultModelId:
        state.default_model_id === 'platform' && !platform ? '' : state.default_model_id,
      connections: this.#connections(ownerId).map((row) => ({
        id: row.id,
        name: row.name,
        apiType: row.api_type,
        baseUrl: row.base_url,
        hasKey: row.encrypted_key !== null,
        models: this.#models(row),
      })),
      ...(platform
        ? {
            platformModel: {
              id: 'platform',
              name: '平台模型',
              modelId: platform.modelId,
              contextWindow: platform.contextWindowTokens,
              maxOutputTokens: platform.outputReserveTokens,
              timeoutMs: 0,
              supportsVision: false,
            },
          }
        : {}),
    };
  }

  save(ownerId: string, input: SaveModelConnectionRequest) {
    const name = requireText(input.name.trim(), '连接名称', 80);
    const id = requireText(input.id, '连接编号', 100);
    if (
      input.apiType !== ModelApiType.OPENAI_CHAT_COMPLETIONS &&
      input.apiType !== ModelApiType.OPENAI_RESPONSES &&
      input.apiType !== ModelApiType.ANTHROPIC_MESSAGES &&
      input.apiType !== ModelApiType.GOOGLE_GENAI
    )
      throw new SessionError(
        'invalid_argument',
        'API 类型仅支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 或 Google Gemini。',
      );
    const baseUrl = validateModelUrl(input.baseUrl, this.#allowedOrigins);
    if (input.models.length < 1 || input.models.length > 50)
      throw new SessionError('invalid_argument', '每个连接须包含 1 至 50 个模型。');
    const models = input.models.map((model) => this.#validateModel(model));
    const modelIds = new Set(models.map((model) => model.id));
    if (
      modelIds.size !== models.length ||
      new Set(models.map((model) => model.modelId)).size !== models.length
    )
      throw new SessionError('invalid_argument', '同一连接内的模型不能重复。');
    this.#mutate(ownerId, input.clientActionId, input, () => {
      this.#expectVersion(ownerId, input.expectedVersion);
      const rows = this.#connections(ownerId);
      const previous = rows.find((row) => row.id === id);
      if (!previous && rows.length >= 20)
        throw new SessionError('failed_precondition', '最多保存 20 个模型连接。');
      for (const row of rows.filter((row) => row.id !== id)) {
        if (this.#models(row).some((model) => modelIds.has(model.id)))
          throw new SessionError('invalid_argument', '模型配置编号重复。');
      }
      const defaultId = this.#state(ownerId).default_model_id;
      if (
        previous &&
        this.#models(previous).some((model) => model.id === defaultId) &&
        !modelIds.has(defaultId)
      )
        throw new SessionError('failed_precondition', '请先选择其他默认模型，再移除当前默认模型。');
      let key = previous?.encrypted_key ?? null;
      if (input.keyChange.case === 'replaceKey') {
        const raw = input.keyChange.value.trim();
        if (!raw || raw.length > 8192 || /[\r\n\0]/.test(raw))
          throw new SessionError('invalid_argument', 'API key 为空、过长或包含无效字符。');
        key = this.#encrypt(ownerId, raw);
      } else if (input.keyChange.case === 'removeKey') {
        if (!input.keyChange.value)
          throw new SessionError('invalid_argument', '移除密钥参数无效。');
        key = null;
      } else if (
        previous &&
        (new URL(previous.base_url).origin !== new URL(baseUrl).origin ||
          previous.api_type !== input.apiType) &&
        key !== null
      ) {
        throw new SessionError(
          'invalid_argument',
          '更换服务地址或 API 类型时须重新输入对应的 API key。',
        );
      }
      this.database
        .prepare(`INSERT INTO model_connections(id, tenant_id, name, api_type, base_url, encrypted_key, models_json, revision) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(tenant_id, id) DO UPDATE SET name=excluded.name, api_type=excluded.api_type, base_url=excluded.base_url, encrypted_key=excluded.encrypted_key, models_json=excluded.models_json, revision=model_connections.revision+1`)
        .run(
          id,
          ownerId,
          name,
          input.apiType,
          baseUrl,
          key,
          JSON.stringify(models.map((model) => toJsonString(ConfiguredModelSchema, model))),
        );
      this.#bump(ownerId);
      if (!this.options.platformModel && defaultId === 'platform' && models[0])
        this.database
          .prepare('UPDATE model_settings SET default_model_id = ? WHERE tenant_id = ?')
          .run(models[0].id, ownerId);
    });
    return this.get(ownerId);
  }

  delete(ownerId: string, input: { clientActionId: string; expectedVersion: number; id: string }) {
    this.#mutate(ownerId, input.clientActionId, input, () => {
      this.#expectVersion(ownerId, input.expectedVersion);
      const row = this.#connection(ownerId, input.id);
      if (this.#models(row).some((model) => model.id === this.#state(ownerId).default_model_id))
        throw new SessionError('failed_precondition', '请先选择其他默认模型，再删除该连接。');
      this.database
        .prepare('DELETE FROM model_connections WHERE tenant_id = ? AND id = ?')
        .run(ownerId, input.id);
      this.#bump(ownerId);
    });
    return this.get(ownerId);
  }

  setDefault(
    ownerId: string,
    input: { clientActionId: string; expectedVersion: number; modelId: string },
  ) {
    this.#mutate(ownerId, input.clientActionId, input, () => {
      this.#expectVersion(ownerId, input.expectedVersion);
      this.#selected(ownerId, input.modelId);
      this.#bump(ownerId);
      this.database
        .prepare('UPDATE model_settings SET default_model_id = ? WHERE tenant_id = ?')
        .run(input.modelId, ownerId);
    });
    return this.get(ownerId);
  }

  updateProfile(ownerId: string, userId: string, input: UpdateProfileRequest): void {
    const username = requireText(input.username.trim(), '用户名', 80);
    if (username.includes('\0'))
      throw new SessionError('invalid_argument', '用户名不能包含空字符。');
    const bytes =
      input.avatarChange.case === 'replaceAvatar'
        ? normalizeAvatar(input.avatarChange.value)
        : null;
    this.#mutate(
      ownerId,
      input.clientActionId,
      {
        ...input,
        avatarChange:
          input.avatarChange.case === 'replaceAvatar'
            ? {
                case: 'replaceAvatar',
                hash: createHash('sha256').update(input.avatarChange.value).digest('hex'),
              }
            : input.avatarChange,
      },
      () => {
        if (
          !this.database
            .prepare(
              "SELECT user_id FROM users WHERE user_id = ? AND tenant_id = ? AND status = 'active'",
            )
            .get(userId, ownerId)
        )
          throw new SessionError('permission_denied', '账号资料归属无效。');
        const previous = this.#profile(userId);
        if (previous.version !== input.expectedVersion)
          throw new SessionError('version_conflict', '资料已在其他页面更新，请重新加载后编辑。');
        const remove = input.avatarChange.case === 'removeAvatar';
        if (remove && !input.avatarChange.value)
          throw new SessionError('invalid_argument', '移除头像参数无效。');
        this.database
          .prepare(
            'UPDATE users SET username = ?, updated_at = ? WHERE user_id = ? AND tenant_id = ?',
          )
          .run(username, new Date().toISOString(), userId, ownerId);
        this.database
          .prepare(
            `INSERT INTO user_profiles(user_id, version, avatar_id, avatar_bytes) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version, avatar_id=excluded.avatar_id, avatar_bytes=excluded.avatar_bytes`,
          )
          .run(
            userId,
            previous.version + 1,
            bytes ? randomUUID() : remove ? null : previous.avatar_id,
            bytes ?? (remove ? null : previous.avatar_bytes),
          );
      },
    );
  }

  readAvatar(userId: string, avatarId: string) {
    const profile = this.#profile(userId);
    if (!avatarId || profile.avatar_id !== avatarId || !profile.avatar_bytes)
      throw new SessionError('not_found', '头像不存在。');
    return { content: profile.avatar_bytes, mediaType: 'image/png' };
  }

  resolve(
    ownerId: string,
    modelId = this.#state(ownerId).default_model_id,
  ): RuntimeModelConfiguration | undefined {
    const selected = this.#selected(ownerId, modelId, true);
    return selected ? this.#runtime(ownerId, selected.configuration, selected.key) : undefined;
  }

  capture(run: RunRecord): RuntimeModelConfiguration | undefined {
    let stored = this.database
      .prepare(
        'SELECT tenant_id, configuration_json, encrypted_key FROM run_model_configurations WHERE run_id = ?',
      )
      .get(run.runId);
    if (!stored) {
      if (
        run.currentRequestId &&
        this.database
          .prepare(
            "SELECT request_id FROM model_request_records WHERE request_id = ? AND status IN ('ready', 'preparing')",
          )
          .get(run.currentRequestId)
      )
        throw new SessionError(
          'action_conflict',
          '旧请求缺少模型配置关联，不能自动重放；请提交新的执行。',
        );
      const source =
        run.parentRunId ??
        this.database
          .prepare(
            'SELECT source_run_id FROM interactions WHERE owner_id = ? AND (accepted_run_id = ? OR consumed_run_id = ?) ORDER BY created_at LIMIT 1',
          )
          .get(run.ownerId, run.runId, run.runId)?.source_run_id;
      const inherited =
        typeof source === 'string'
          ? this.database
              .prepare(
                'SELECT tenant_id, configuration_json, encrypted_key FROM run_model_configurations WHERE run_id = ?',
              )
              .get(source)
          : undefined;
      const selected = inherited
        ? snapshotRowSchema.parse(inherited)
        : this.#selected(run.ownerId, this.#state(run.ownerId).default_model_id, true);
      if (!selected) return undefined;
      if ('tenant_id' in selected && selected.tenant_id !== run.ownerId)
        throw new SessionError('permission_denied', '来源执行的模型配置归属无效。');
      const json =
        'configuration_json' in selected
          ? selected.configuration_json
          : JSON.stringify(selected.configuration);
      const key = 'encrypted_key' in selected ? selected.encrypted_key : selected.key;
      this.database
        .prepare(
          'INSERT INTO run_model_configurations(run_id, tenant_id, configuration_json, encrypted_key) VALUES (?, ?, ?, ?)',
        )
        .run(run.runId, run.ownerId, json, key);
      stored = { tenant_id: run.ownerId, configuration_json: json, encrypted_key: key };
    }
    const parsed = snapshotRowSchema.parse(stored);
    if (parsed.tenant_id !== run.ownerId)
      throw new SessionError('permission_denied', '模型配置归属无效。');
    return this.#runtime(
      run.ownerId,
      snapshotSchema.parse(JSON.parse(parsed.configuration_json)),
      parsed.encrypted_key,
    );
  }

  acceptRecap(requestId: string, configurationId?: string): boolean {
    const row = this.database
      .prepare('SELECT configuration_json FROM request_model_configurations WHERE request_id = ?')
      .get(requestId);
    return row ? row.configuration_json === configurationId : configurationId === undefined;
  }

  recordRequest(ownerId: string, requestId: string, model: RuntimeModelConfiguration): void {
    const config = model.configurationId ?? '';
    const existing = this.database
      .prepare('SELECT configuration_json FROM request_model_configurations WHERE request_id = ?')
      .get(requestId);
    if (existing && existing.configuration_json !== config)
      throw new SessionError('failed_precondition', '该请求的模型配置与当前执行不一致，不能重放。');
    this.database
      .prepare(
        'INSERT OR IGNORE INTO request_model_configurations(request_id, tenant_id, configuration_json) VALUES (?, ?, ?)',
      )
      .run(requestId, ownerId, config);
  }

  async test(ownerId: string, modelId: string, expectedVersion: number, signal: AbortSignal) {
    this.#expectVersion(ownerId, expectedVersion);
    const selected = this.#selected(ownerId, modelId);
    const model = selected
      ? this.#runtime(
          ownerId,
          {
            ...selected.configuration,
            maxOutputTokens: Math.min(128, selected.configuration.maxOutputTokens),
          },
          selected.key,
        )
      : undefined;
    if (!model) throw new SessionError('failed_precondition', '模型未配置。');
    let passed = false;
    for await (const event of model.provider.stream(
      {
        messages: [
          {
            role: 'user',
            content: 'Call kairos_settings_probe with an empty object. Do not answer with text.',
          },
        ],
        tools: [
          {
            name: 'kairos_settings_probe',
            description: 'Checks tool calling compatibility. Call with an empty object.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      },
      AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    )) {
      if (event.type === 'stream_interrupted')
        return { passed: false, message: '模型流未完整结束或缺少用量信息。' };
      if (event.type === 'response')
        passed =
          event.message.tool_calls?.some((call) => call.name === 'kairos_settings_probe') ?? false;
    }
    return {
      passed,
      message: passed
        ? '流式响应、工具调用和用量信息测试通过。'
        : '模型未返回有效工具调用，请核对模型能力与 API 类型。',
    };
  }

  async discover(ownerId: string, input: DiscoverModelsRequest, signal: AbortSignal) {
    if (
      input.apiType !== ModelApiType.OPENAI_CHAT_COMPLETIONS &&
      input.apiType !== ModelApiType.OPENAI_RESPONSES &&
      input.apiType !== ModelApiType.ANTHROPIC_MESSAGES &&
      input.apiType !== ModelApiType.GOOGLE_GENAI
    )
      throw new SessionError(
        'invalid_argument',
        'API 类型仅支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 或 Google Gemini。',
      );
    const baseUrl = validateModelUrl(input.baseUrl, this.#allowedOrigins);
    let apiKey = input.apiKey.trim();
    if (/[\r\n\0]/.test(apiKey) || apiKey.length > 8192)
      throw new SessionError('invalid_argument', 'API key 过长或包含无效字符。');
    if (!apiKey && input.connectionId) {
      const row = this.#connection(ownerId, input.connectionId);
      if (row.encrypted_key !== null) {
        if (
          new URL(row.base_url).origin !== new URL(baseUrl).origin ||
          row.api_type !== input.apiType
        )
          throw new SessionError(
            'invalid_argument',
            '连接的服务地址或 API 类型已变化，请重新输入 API key。',
          );
        apiKey = this.#decrypt(ownerId, row.encrypted_key);
      }
    }
    const models = await listProviderModels(
      input.apiType,
      { baseUrl, ...(apiKey ? { apiKey } : {}) },
      signal,
      this.#fetch,
    );
    return { models: models.map((model) => ({ ...model })) };
  }

  #runtime(ownerId: string, config: Snapshot, key: string | null): RuntimeModelConfiguration {
    const configurationId = JSON.stringify({
      ownerId,
      ...config,
      credentialVersion: key === null ? null : createHash('sha256').update(key).digest('hex'),
    });
    if (config.kind === 'platform') {
      const platform = this.options.platformModel;
      if (!platform || config.platformFingerprint !== this.#platformFingerprint())
        throw new SessionError(
          'failed_precondition',
          '平台模型配置已变化，旧执行不能使用其他服务重放；请提交新的执行。',
        );
      return { ...platform, configurationId };
    }
    const provider = createModelProvider(
      config.apiType ?? ModelApiType.OPENAI_CHAT_COMPLETIONS,
      {
        baseUrl: config.baseUrl ?? '',
        model: config.modelId,
        contextWindow: config.contextWindow,
        outputReserve: config.maxOutputTokens,
        requestTimeoutMs: config.timeoutMs,
        supportsVision: config.supportsVision,
        ...(key ? { apiKey: this.#decrypt(ownerId, key) } : {}),
      },
      this.#fetch,
    );
    return {
      configurationId,
      provider,
      providerId: config.providerId,
      modelId: config.modelId,
      contextWindowTokens: config.contextWindow,
      outputReserveTokens: config.maxOutputTokens,
      countTokens: (request) => provider.estimateRequestTokens(request),
    };
  }

  #selected(
    ownerId: string,
    id: string,
    optional = false,
  ): { configuration: Snapshot; key: string | null } | undefined {
    if (id === 'platform') {
      const model = this.options.platformModel;
      if (!model) {
        if (optional) return undefined;
        throw new SessionError('failed_precondition', '平台默认模型未配置。');
      }
      return {
        configuration: {
          kind: 'platform',
          id,
          modelId: model.modelId,
          providerId: model.providerId,
          contextWindow: model.contextWindowTokens,
          maxOutputTokens: model.outputReserveTokens,
          timeoutMs: 300_000,
          supportsVision: false,
          revision: 0,
          platformFingerprint: this.#platformFingerprint(),
        },
        key: null,
      };
    }
    for (const row of this.#connections(ownerId)) {
      const model = this.#models(row).find((model) => model.id === id);
      if (model)
        return {
          configuration: {
            kind: 'custom',
            id,
            modelId: model.modelId,
            providerId: providerIdForApiType(row.api_type),
            apiType: row.api_type,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxOutputTokens,
            timeoutMs: model.timeoutMs,
            supportsVision: model.supportsVision,
            baseUrl: row.base_url,
            revision: row.revision,
          },
          key: row.encrypted_key,
        };
    }
    throw new SessionError('not_found', '模型配置不存在。');
  }

  #platformFingerprint(): string {
    const model = this.options.platformModel;
    return (
      model?.configurationId ??
      JSON.stringify({
        providerId: model?.providerId,
        modelId: model?.modelId,
        contextWindow: model?.contextWindowTokens,
        output: model?.outputReserveTokens,
      })
    );
  }
  #validateModel(model: ConfiguredModel): ConfiguredModel {
    requireText(model.id, '模型配置编号', 100);
    if (model.id === 'platform')
      throw new SessionError('invalid_argument', '模型配置编号不能使用 platform。');
    const name = requireText(model.name.trim(), '模型名称', 80);
    const modelId = requireText(model.modelId.trim(), '模型 ID', 200);
    if (/\s/.test(modelId) || modelId.includes('\0'))
      throw new SessionError('invalid_argument', '模型 ID 不能包含空白或空字符。');
    if (
      ![model.contextWindow, model.maxOutputTokens, model.timeoutMs].every(Number.isSafeInteger) ||
      model.contextWindow < 1024 ||
      model.contextWindow > 10_000_000 ||
      model.maxOutputTokens < 1 ||
      model.maxOutputTokens >= model.contextWindow ||
      model.timeoutMs < 1000 ||
      model.timeoutMs > 3_600_000
    )
      throw new SessionError('invalid_argument', '上下文容量、最大输出或请求超时超出范围。');
    return { ...model, name, modelId };
  }
  #models(row: z.infer<typeof rowSchema>): ConfiguredModel[] {
    return z
      .array(z.string())
      .parse(JSON.parse(row.models_json))
      .map((value) => fromJsonString(ConfiguredModelSchema, value));
  }
  #connections(ownerId: string) {
    return z
      .array(rowSchema)
      .parse(
        this.database
          .prepare('SELECT * FROM model_connections WHERE tenant_id = ? ORDER BY rowid')
          .all(ownerId),
      );
  }
  #connection(ownerId: string, id: string) {
    const row = this.#connections(ownerId).find((row) => row.id === id);
    if (!row) throw new SessionError('not_found', '模型连接不存在。');
    return row;
  }
  #state(ownerId: string) {
    const row = this.database
      .prepare('SELECT version, default_model_id FROM model_settings WHERE tenant_id = ?')
      .get(ownerId);
    return row ? stateSchema.parse(row) : { version: 0, default_model_id: 'platform' };
  }
  #profile(userId: string) {
    const row = this.database
      .prepare('SELECT version, avatar_id, avatar_bytes FROM user_profiles WHERE user_id = ?')
      .get(userId);
    return row ? profileSchema.parse(row) : { version: 0, avatar_id: null, avatar_bytes: null };
  }
  #expectVersion(ownerId: string, expected: number) {
    if (this.#state(ownerId).version !== expected)
      throw new SessionError('version_conflict', '模型设置已在其他页面更新，请重新加载后编辑。');
  }
  #bump(ownerId: string) {
    this.database
      .prepare(
        `INSERT INTO model_settings(tenant_id, version) VALUES (?, 1) ON CONFLICT(tenant_id) DO UPDATE SET version=version+1`,
      )
      .run(ownerId);
  }
  #mutate(ownerId: string, actionId: string, payload: object, effect: () => void): void {
    requireText(actionId, '操作编号', 100);
    const fingerprint = createHmac('sha256', this.#key)
      .update(
        JSON.stringify(payload, (_key, value: unknown) =>
          value !== null && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value,
        ),
      )
      .digest('hex');
    inTransaction(this.database, () => {
      const previous = this.database
        .prepare('SELECT fingerprint FROM settings_actions WHERE tenant_id = ? AND action_id = ?')
        .get(ownerId, actionId);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new SessionError('action_conflict', '该操作编号已关联其他参数。');
        return;
      }
      effect();
      this.database
        .prepare('INSERT INTO settings_actions(tenant_id, action_id, fingerprint) VALUES (?, ?, ?)')
        .run(ownerId, actionId, fingerprint);
    });
  }
  #encrypt(ownerId: string, value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(ownerId));
    return Buffer.concat([
      iv,
      cipher.update(value, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64url');
  }
  #decrypt(ownerId: string, value: string): string {
    try {
      const bytes = Buffer.from(value, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(ownerId));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      throw new SessionError(
        'failed_precondition',
        '模型密钥无法解密，请核对 Server 密钥配置或重新输入 API key。',
      );
    }
  }
}
