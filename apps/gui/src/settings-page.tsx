import {
  type ConfiguredModel,
  ConfiguredModelSchema,
  create,
  type Identity,
  ModelApiType,
  type ModelConnection,
  type ModelSettings,
} from '@kairos/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppDialog } from './app-dialog.js';
import { AvatarEditor } from './avatar-editor.js';
import { ChannelSettings } from './channels-settings.js';
import type { KairosClients } from './client.js';
import type { ConversationDisplayMode } from './conversation-display.js';
import { Dropdown } from './dropdown.js';
import { formatClientError } from './errors.js';
import { SettingsRequests } from './settings-requests.js';
import { UserAvatar } from './user-avatar.js';

export type SettingsSection = 'account' | 'models' | 'channels' | 'display';
export function settingsSectionFromLocation(search: string): SettingsSection {
  const section = new URLSearchParams(search).get('section');
  return section === 'models' || section === 'display' || section === 'channels'
    ? section
    : 'account';
}

export function SettingsPage({
  clients,
  identity,
  section,
  onSectionChange,
  onIdentityChange,
  onDirtyChange,
  conversationDisplayMode,
  conversationDisplayError,
  onConversationDisplayChange,
}: {
  clients: KairosClients;
  identity: Identity;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onIdentityChange: (identity: Identity) => void;
  onDirtyChange: (dirty: boolean) => void;
  conversationDisplayMode: ConversationDisplayMode;
  conversationDisplayError: string | null;
  onConversationDisplayChange: (mode: ConversationDisplayMode) => void;
}) {
  return (
    <section className="settings-page" aria-labelledby="settings-heading">
      <h1 id="settings-heading">设置</h1>
      <nav className="settings-tabs" aria-label="设置栏目">
        <button
          type="button"
          aria-current={section === 'account' ? 'page' : undefined}
          onClick={() => onSectionChange('account')}
        >
          账户
        </button>
        <button
          type="button"
          aria-current={section === 'models' ? 'page' : undefined}
          onClick={() => onSectionChange('models')}
        >
          模型
        </button>
        <button
          type="button"
          aria-current={section === 'channels' ? 'page' : undefined}
          onClick={() => onSectionChange('channels')}
        >
          渠道
        </button>
        <button
          type="button"
          aria-current={section === 'display' ? 'page' : undefined}
          onClick={() => onSectionChange('display')}
        >
          显示
        </button>
      </nav>
      {section === 'account' ? (
        <AccountSettings
          key={identity.userId}
          clients={clients}
          identity={identity}
          onIdentityChange={onIdentityChange}
          onDirtyChange={onDirtyChange}
        />
      ) : section === 'models' ? (
        <ModelSettingsPanel clients={clients} onDirtyChange={onDirtyChange} />
      ) : section === 'channels' ? (
        <ChannelSettings clients={clients} />
      ) : (
        <ConversationDisplaySettings
          mode={conversationDisplayMode}
          error={conversationDisplayError}
          onChange={onConversationDisplayChange}
        />
      )}
    </section>
  );
}

export function ConversationDisplaySettings({
  mode,
  error,
  onChange,
}: {
  mode: ConversationDisplayMode;
  error: string | null;
  onChange: (mode: ConversationDisplayMode) => void;
}) {
  return (
    <div className="settings-form">
      <div className="settings-section-heading">
        <h2>主对话展示模式</h2>
        <p>控制主对话与工作空间主对话的内容展示。任务话题与子代理详情保持完整视图。</p>
      </div>
      <fieldset className="settings-display-options" aria-label="主对话展示模式">
        <label className="settings-display-option">
          <input
            type="radio"
            name="conversation-display"
            value="compact"
            checked={mode === 'compact'}
            onChange={() => onChange('compact')}
          />
          <span>
            <strong>精简视图</strong>
            <span className="settings-help">显示用户消息、正式回复及创建和回复话题的卡片。</span>
          </span>
        </label>
        <label className="settings-display-option">
          <input
            type="radio"
            name="conversation-display"
            value="full"
            checked={mode === 'full'}
            onChange={() => onChange('full')}
          />
          <span>
            <strong>完整视图</strong>
            <span className="settings-help">同时显示思考、工具调用、返回内容及其他执行记录。</span>
          </span>
        </label>
      </fieldset>
      <p className="settings-help">选择后立即生效，按账号保存在当前浏览器。</p>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function AccountSettings({
  clients,
  identity,
  onIdentityChange,
  onDirtyChange,
}: {
  clients: KairosClients;
  identity: Identity;
  onIdentityChange: (identity: Identity) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [username, setUsername] = useState(identity.username);
  const [avatar, setAvatar] = useState<Uint8Array | 'remove' | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [reloadProfile, setReloadProfile] = useState(false);
  const [requests] = useState(() => new SettingsRequests());
  const controller = useRef(new AbortController());
  const dirty = username !== identity.username || avatar !== null;
  useEffect(() => {
    onDirtyChange(dirty || busy || requests.pending !== null);
    return () => onDirtyChange(false);
  }, [dirty, busy, requests, onDirtyChange]);
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    return () => active.abort();
  }, []);
  useEffect(() => {
    if (!(avatar instanceof Uint8Array)) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([new Uint8Array(avatar)], { type: 'image/png' }));
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [avatar]);
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 3000);
    return () => window.clearTimeout(timer);
  }, [saved]);
  async function submit() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const input = {
      username: username.trim(),
      expectedVersion: identity.profileVersion,
      avatarChange:
        avatar === 'remove'
          ? { case: 'removeAvatar' as const, value: true }
          : avatar
            ? { case: 'replaceAvatar' as const, value: avatar }
            : ({ case: undefined } as const),
    };
    try {
      await requests.execute(async (clientActionId) => {
        const response = await clients.settings.updateProfile(
          { ...input, clientActionId },
          { signal: controller.current.signal },
        );
        if (!controller.current.signal.aborted && response.identity) {
          onIdentityChange(response.identity);
          setUsername(response.identity.username);
          setAvatar(null);
          setSaved(true);
        }
      });
    } catch (cause) {
      if (!controller.current.signal.aborted) setError(formatClientError(cause));
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function refreshProfile() {
    setReloadProfile(false);
    setBusy(true);
    setError(null);
    try {
      const response = await clients.auth.getCurrentIdentity(
        {},
        { signal: controller.current.signal },
      );
      if (!response.identity) throw new Error('当前登录已失效，请刷新页面。');
      if (!controller.current.signal.aborted) {
        onIdentityChange(response.identity);
        setUsername(response.identity.username);
        setAvatar(null);
      }
    } catch (cause) {
      if (!controller.current.signal.aborted) setError(formatClientError(cause));
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function retry() {
    setBusy(true);
    try {
      await requests.pending?.retry();
      setError(null);
    } catch (cause) {
      setError(formatClientError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="settings-section-heading">
        <h2>账户资料</h2>
        <p>用户名与头像会同步显示在侧栏、聊天消息和任务回复中。</p>
      </div>
      <fieldset disabled={busy || requests.pending !== null}>
        <div className="settings-field">
          <span className="settings-label">头像</span>
          <div className="settings-avatar-row">
            <UserAvatar
              className="settings-avatar"
              username={username}
              previewUrl={avatar === 'remove' ? null : avatar ? preview : undefined}
            />
            <div className="settings-avatar-actions">
              <label className="device-secondary settings-file-button">
                选择图片
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  aria-label="选择头像图片"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    event.target.value = '';
                  }}
                />
              </label>
              {(identity.avatarId || avatar instanceof Uint8Array) && (
                <button
                  type="button"
                  className="settings-text-button"
                  onClick={() => setAvatar('remove')}
                >
                  移除头像
                </button>
              )}
              <span className="settings-help">
                PNG 或 JPEG，最大 5 MiB。默认显示用户名的第一个字。
              </span>
            </div>
          </div>
        </div>
        <label className="settings-field">
          用户名
          <input
            required
            maxLength={80}
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
              setSaved(false);
            }}
            autoComplete="nickname"
          />
          <span className="settings-help">用于显示，可与其他用户重复。</span>
        </label>
      </fieldset>
      {error && (
        <div role="alert" className="settings-error">
          {error}
          {!requests.pending && (
            <button
              type="button"
              className="settings-text-button"
              disabled={busy}
              onClick={() => setReloadProfile(true)}
            >
              重新加载资料
            </button>
          )}
        </div>
      )}
      {requests.pending && !busy && (
        <div className="settings-unknown">
          <p>保存结果尚未确认。请重试原操作，或刷新后核对资料。</p>
          <button type="button" className="device-secondary" onClick={() => void retry()}>
            重试确认
          </button>
        </div>
      )}
      <div className="settings-form-actions">
        <button
          className="device-primary"
          type="submit"
          disabled={!dirty || busy || requests.pending !== null}
        >
          {busy ? '正在保存…' : '保存资料'}
        </button>
        <button
          className="device-secondary"
          type="button"
          disabled={!dirty || busy || requests.pending !== null}
          onClick={() => {
            setUsername(identity.username);
            setAvatar(null);
            setError(null);
          }}
        >
          取消修改
        </button>
        {saved && (
          <span role="status" className="settings-saved">
            已保存
          </span>
        )}
      </div>
      {reloadProfile && (
        <AppDialog
          title="重新加载账户资料"
          onClose={() => setReloadProfile(false)}
          actions={
            <>
              <button
                type="button"
                className="device-secondary"
                onClick={() => setReloadProfile(false)}
              >
                继续编辑
              </button>
              <button
                type="button"
                className="device-primary"
                onClick={() => void refreshProfile()}
              >
                放弃修改并加载
              </button>
            </>
          }
        >
          <p>重新读取已保存的资料，当前未保存修改会丢弃。</p>
        </AppDialog>
      )}
      {file && (
        <AvatarEditor
          file={file}
          onClose={() => setFile(null)}
          onApply={(bytes) => {
            setAvatar(bytes);
            setFile(null);
            setSaved(false);
          }}
        />
      )}
    </form>
  );
}

function newModel(): ConfiguredModel {
  return create(ConfiguredModelSchema, {
    id: crypto.randomUUID(),
    name: '',
    modelId: '',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    timeoutMs: 300000,
    supportsVision: false,
  });
}
export function modelApiTypePresentation(apiType: ModelApiType): {
  label: string;
  path: string;
  baseUrlPlaceholder: string;
  authentication: string;
} {
  switch (apiType) {
    case ModelApiType.OPENAI_CHAT_COMPLETIONS:
      return {
        label: 'OpenAI Chat Completions 兼容',
        path: '/chat/completions',
        baseUrlPlaceholder: 'https://api.example.com/v1',
        authentication: 'API key 通过 Authorization: Bearer 发送。',
      };
    case ModelApiType.OPENAI_RESPONSES:
      return {
        label: 'OpenAI Responses',
        path: '/responses',
        baseUrlPlaceholder: 'https://api.example.com/v1',
        authentication: 'API key 通过 Authorization: Bearer 发送。',
      };
    case ModelApiType.ANTHROPIC_MESSAGES:
      return {
        label: 'Anthropic Messages',
        path: '/v1/messages',
        baseUrlPlaceholder: 'https://api.anthropic.com',
        authentication: 'API key 通过 x-api-key 发送，请求包含 anthropic-version: 2023-06-01。',
      };
    default:
      throw new Error(`不支持的 API 类型：${String(apiType)}`);
  }
}

interface ConnectionDraft {
  id: string;
  name: string;
  apiType: ModelApiType;
  baseUrl: string;
  apiKey: string;
  removeKey: boolean;
  hasKey: boolean;
  models: ConfiguredModel[];
}
function connectionDraft(connection?: ModelConnection): ConnectionDraft {
  return connection
    ? {
        id: connection.id,
        name: connection.name,
        apiType: connection.apiType,
        baseUrl: connection.baseUrl,
        apiKey: '',
        removeKey: false,
        hasKey: connection.hasKey,
        models: connection.models.map((model) => ({ ...model })),
      }
    : {
        id: crypto.randomUUID(),
        name: '',
        apiType: ModelApiType.OPENAI_CHAT_COMPLETIONS,
        baseUrl: '',
        apiKey: '',
        removeKey: false,
        hasKey: false,
        models: [newModel()],
      };
}

function ModelSettingsPanel({
  clients,
  onDirtyChange,
}: {
  clients: KairosClients;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [snapshot, setSnapshot] = useState<ModelSettings | null>(null);
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const original = useRef('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { passed: boolean; message: string }>>({});
  const [discarding, setDiscarding] = useState(false);
  const [deleting, setDeleting] = useState<ModelConnection | null>(null);
  const [requests] = useState(() => new SettingsRequests());
  const controller = useRef(new AbortController());
  const dirty = draft !== null && JSON.stringify(draft) !== original.current;
  useEffect(() => {
    onDirtyChange(dirty || busy || requests.pending !== null);
    return () => onDirtyChange(false);
  }, [dirty, busy, requests, onDirtyChange]);
  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await clients.settings.getSettings({}, { signal });
        if (!signal.aborted)
          setSnapshot(
            response.settings ??
              (() => {
                throw new Error('Server 未返回模型设置。');
              })(),
          );
      } catch (cause) {
        if (!signal.aborted) setError(formatClientError(cause));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [clients.settings],
  );
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    void load(active.signal);
    return () => active.abort();
  }, [load]);
  function edit(connection?: ModelConnection) {
    const next = connectionDraft(connection);
    original.current = JSON.stringify(next);
    setDraft(next);
    setError(null);
  }
  async function mutate(
    operation: (actionId: string) => Promise<{ settings?: ModelSettings | undefined }>,
  ) {
    setBusy(true);
    setError(null);
    try {
      await requests.execute(async (actionId) => {
        const response = await operation(actionId);
        if (!controller.current.signal.aborted) {
          setSnapshot(
            response.settings ??
              (() => {
                throw new Error('Server 未返回模型设置。');
              })(),
          );
          setResults({});
          setDraft(null);
          setDeleting(null);
        }
      });
    } catch (cause) {
      if (!controller.current.signal.aborted) setError(formatClientError(cause));
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function retry() {
    setBusy(true);
    try {
      await requests.pending?.retry();
      setError(null);
    } catch (cause) {
      setError(formatClientError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function test(modelId: string) {
    if (!snapshot) return;
    setBusy(true);
    setError(null);
    try {
      const result = await clients.settings.testConfiguredModel(
        { modelId, expectedVersion: snapshot.version },
        { signal: controller.current.signal },
      );
      if (!controller.current.signal.aborted)
        setResults((current) => ({ ...current, [modelId]: result }));
    } catch (cause) {
      if (!controller.current.signal.aborted)
        setResults((current) => ({
          ...current,
          [modelId]: { passed: false, message: formatClientError(cause) },
        }));
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  function modelRow(model: Pick<ConfiguredModel, 'id' | 'name' | 'modelId'>) {
    const isDefault = snapshot?.defaultModelId === model.id;
    return (
      <div className="settings-model-row" key={model.id}>
        <div className="settings-model-info">
          <strong>{model.name}</strong>
          <span className="settings-help">{model.modelId}</span>
        </div>
        <div className="settings-model-actions">
          {isDefault ? (
            <span className="settings-default">默认</span>
          ) : (
            <button
              type="button"
              className="settings-text-button"
              disabled={busy || requests.pending !== null}
              onClick={() =>
                void mutate((clientActionId) =>
                  clients.settings.setDefaultModel(
                    { clientActionId, expectedVersion: snapshot?.version ?? 0, modelId: model.id },
                    { signal: controller.current.signal },
                  ),
                )
              }
            >
              设为默认
            </button>
          )}
          <button
            type="button"
            className="device-secondary"
            disabled={busy || requests.pending !== null}
            onClick={() => void test(model.id)}
          >
            测试模型
          </button>
        </div>
        {results[model.id] && (
          <p
            role="status"
            className={`settings-test-result ${results[model.id]?.passed ? 'settings-saved' : 'settings-error'}`}
          >
            {results[model.id]?.message}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="settings-models">
      <div className="settings-section-heading">
        <div>
          <h2>模型配置</h2>
          <p>连接保存 API 类型、基础 URL 和凭据。一个连接可配置多个模型。</p>
        </div>
        {!draft && (
          <button
            type="button"
            className="device-primary"
            disabled={busy || loading || requests.pending !== null}
            onClick={() => edit()}
          >
            添加连接
          </button>
        )}
      </div>
      <p className="settings-help settings-model-notice">
        默认模型用于后续新执行。正在执行及继续原执行的任务沿用原配置；子任务继承所属执行。更换服务后，后续执行会向新服务发送当前对话上下文。
      </p>
      {error && (
        <div role="alert" className="settings-error">
          {error}
          {!draft && (
            <button
              type="button"
              className="settings-text-button"
              disabled={busy || requests.pending !== null}
              onClick={() => void load(controller.current.signal)}
            >
              重新加载设置
            </button>
          )}
          {draft && <span className="settings-help">可取消编辑后重新加载设置。</span>}
        </div>
      )}
      {requests.pending && !busy && (
        <div className="settings-unknown">
          <p>保存结果尚未确认。请重试原操作，或刷新后核对配置。</p>
          <button type="button" className="device-secondary" onClick={() => void retry()}>
            重试确认
          </button>
        </div>
      )}
      {loading && (
        <p role="status" className="muted">
          正在加载设置…
        </p>
      )}
      {draft && snapshot ? (
        <ConnectionEditor
          draft={draft}
          setDraft={setDraft}
          defaultModelId={snapshot.defaultModelId}
          busy={busy || requests.pending !== null}
          onCancel={() => {
            if (dirty) setDiscarding(true);
            else setDraft(null);
          }}
          onSave={() =>
            void mutate((clientActionId) =>
              clients.settings.saveModelConnection(
                {
                  clientActionId,
                  expectedVersion: snapshot.version,
                  id: draft.id,
                  name: draft.name,
                  apiType: draft.apiType,
                  baseUrl: draft.baseUrl,
                  keyChange: draft.apiKey
                    ? { case: 'replaceKey', value: draft.apiKey }
                    : draft.removeKey
                      ? { case: 'removeKey', value: true }
                      : { case: undefined },
                  models: draft.models,
                },
                { signal: controller.current.signal },
              ),
            )
          }
        />
      ) : (
        <>
          {snapshot?.platformModel && (
            <section className="settings-connection">
              <div className="settings-connection-heading">
                <h3>平台提供</h3>
                <span className="settings-help">由部署者维护</span>
              </div>
              {modelRow(snapshot.platformModel)}
            </section>
          )}
          {snapshot?.connections.map((connection) => (
            <section className="settings-connection" key={connection.id}>
              <div className="settings-connection-heading">
                <div>
                  <h3>{connection.name}</h3>
                  <span className="settings-help">
                    {modelApiTypePresentation(connection.apiType).label}
                  </span>
                  <span className="settings-help settings-url">{connection.baseUrl}</span>
                </div>
                <Dropdown
                  label={`管理连接 ${connection.name}`}
                  trigger="管理"
                  triggerClassName="device-secondary"
                  items={[
                    { value: 'edit', label: '编辑连接' },
                    {
                      value: 'delete',
                      label: '删除连接',
                      disabled: connection.models.some(
                        (model) => model.id === snapshot.defaultModelId,
                      ),
                    },
                  ]}
                  disabled={busy || requests.pending !== null}
                  onSelect={(value) =>
                    value === 'edit' ? edit(connection) : setDeleting(connection)
                  }
                />
              </div>
              {connection.models.map(modelRow)}
            </section>
          ))}
          {snapshot && !snapshot.platformModel && snapshot.connections.length === 0 && (
            <div className="settings-empty">
              <h3>尚未配置模型</h3>
              <p>添加一个连接并填写模型 ID，即可用于对话和任务。</p>
            </div>
          )}
          {snapshot && (
            <p className="settings-help">
              测试会发送少量模型请求，可能产生费用。测试通过仅代表当时的服务状态。删除默认模型所属连接前，请先选择其他默认模型。
            </p>
          )}
        </>
      )}
      {discarding && (
        <AppDialog
          title="放弃模型配置修改"
          onClose={() => setDiscarding(false)}
          actions={
            <>
              <button
                type="button"
                className="device-secondary"
                onClick={() => setDiscarding(false)}
              >
                继续编辑
              </button>
              <button
                type="button"
                className="device-primary"
                onClick={() => {
                  setDraft(null);
                  setDiscarding(false);
                }}
              >
                放弃修改
              </button>
            </>
          }
        >
          <p>未保存的连接与模型修改会丢弃。</p>
        </AppDialog>
      )}
      {deleting && snapshot && (
        <AppDialog
          title="删除模型连接"
          subtitle={`确认删除“${deleting.name}”及其模型配置？已有执行的配置记录会保留。`}
          onClose={() => setDeleting(null)}
          closeDisabled={busy}
          actions={
            <>
              <button
                type="button"
                className="device-secondary"
                disabled={busy}
                onClick={() => setDeleting(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="device-primary"
                disabled={busy || requests.pending !== null}
                onClick={() =>
                  void mutate((clientActionId) =>
                    clients.settings.deleteModelConnection(
                      { clientActionId, expectedVersion: snapshot.version, id: deleting.id },
                      { signal: controller.current.signal },
                    ),
                  )
                }
              >
                删除连接
              </button>
            </>
          }
        >
          <p>该操作不会修改其他连接。</p>
        </AppDialog>
      )}
    </div>
  );
}

function ConnectionEditor({
  draft,
  setDraft,
  defaultModelId,
  busy,
  onCancel,
  onSave,
}: {
  draft: ConnectionDraft;
  setDraft: (draft: ConnectionDraft) => void;
  defaultModelId: string;
  busy: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const update = (id: string, changes: Partial<ConfiguredModel>) =>
    setDraft({
      ...draft,
      models: draft.models.map((model) => (model.id === id ? { ...model, ...changes } : model)),
    });
  const presentation = modelApiTypePresentation(draft.apiType);
  return (
    <form
      className="settings-form settings-connection-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <fieldset disabled={busy}>
        <label className="settings-field">
          连接名称
          <input
            required
            maxLength={80}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="例如：我的模型服务"
          />
        </label>
        <div className="settings-field">
          <span className="settings-label">API 类型</span>
          <Dropdown
            label="API 类型"
            trigger={presentation.label}
            triggerClassName="device-secondary"
            value={String(draft.apiType)}
            items={[
              {
                value: String(ModelApiType.OPENAI_CHAT_COMPLETIONS),
                label: modelApiTypePresentation(ModelApiType.OPENAI_CHAT_COMPLETIONS).label,
              },
              {
                value: String(ModelApiType.OPENAI_RESPONSES),
                label: modelApiTypePresentation(ModelApiType.OPENAI_RESPONSES).label,
              },
              {
                value: String(ModelApiType.ANTHROPIC_MESSAGES),
                label: modelApiTypePresentation(ModelApiType.ANTHROPIC_MESSAGES).label,
              },
            ]}
            onSelect={(value) => {
              const apiType = [
                ModelApiType.OPENAI_CHAT_COMPLETIONS,
                ModelApiType.OPENAI_RESPONSES,
                ModelApiType.ANTHROPIC_MESSAGES,
              ].find((candidate) => String(candidate) === value);
              if (apiType === undefined) throw new Error(`不支持的 API 类型：${value}`);
              setDraft({ ...draft, apiType });
            }}
            disabled={busy}
          />
          <span className="settings-help">API 类型只表示请求与流式事件格式。</span>
        </div>
        <label className="settings-field">
          基础 URL
          <input
            type="url"
            required
            maxLength={2048}
            value={draft.baseUrl}
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            placeholder={presentation.baseUrlPlaceholder}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="settings-help">
            系统追加 {presentation.path}。请求从 Server 发出，localhost 指向
            Server；内网服务须由部署者放行。
          </span>
        </label>
        <label className="settings-field">
          API key
          <input
            type="password"
            value={draft.apiKey}
            maxLength={8192}
            onChange={(event) =>
              setDraft({ ...draft, apiKey: event.target.value, removeKey: false })
            }
            placeholder={
              draft.hasKey && !draft.removeKey ? '已配置，留空保留原密钥' : '按模型服务要求填写'
            }
            autoComplete="new-password"
            spellCheck={false}
          />
          <span className="settings-help">
            {presentation.authentication} 保存后不回显完整密钥。更换服务域名或 API
            类型时需重新填写。
          </span>
        </label>
        {draft.hasKey && (
          <button
            className="settings-text-button"
            type="button"
            onClick={() => setDraft({ ...draft, removeKey: !draft.removeKey, apiKey: '' })}
          >
            {draft.removeKey ? '取消移除密钥' : '移除已保存密钥'}
          </button>
        )}
        <div className="settings-model-editor-heading">
          <h3>模型</h3>
          <button
            type="button"
            className="device-secondary"
            disabled={draft.models.length >= 50}
            onClick={() => setDraft({ ...draft, models: [...draft.models, newModel()] })}
          >
            添加模型
          </button>
        </div>
        {draft.models.map((model, index) => (
          <div className="settings-model-editor" key={model.id}>
            <div className="settings-connection-heading">
              <h4>模型 {index + 1}</h4>
              <button
                type="button"
                className="settings-text-button"
                disabled={draft.models.length === 1 || model.id === defaultModelId}
                onClick={() =>
                  setDraft({
                    ...draft,
                    models: draft.models.filter((candidate) => candidate.id !== model.id),
                  })
                }
              >
                移除
              </button>
            </div>
            <label className="settings-field">
              显示名称
              <input
                required
                maxLength={80}
                value={model.name}
                onChange={(event) => update(model.id, { name: event.target.value })}
                placeholder="例如：日常任务"
              />
            </label>
            <label className="settings-field">
              模型 ID
              <input
                required
                maxLength={200}
                value={model.modelId}
                onChange={(event) => update(model.id, { modelId: event.target.value })}
                placeholder="填写服务提供的准确模型 ID"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <details className="settings-advanced">
              <summary>高级设置</summary>
              <div className="settings-numeric-fields">
                <label className="settings-field">
                  上下文容量（token）
                  <input
                    type="number"
                    min={1024}
                    max={10000000}
                    required
                    value={model.contextWindow}
                    onChange={(event) =>
                      update(model.id, { contextWindow: Number(event.target.value) })
                    }
                  />
                </label>
                <label className="settings-field">
                  最大输出（token）
                  <input
                    type="number"
                    min={1}
                    max={model.contextWindow - 1}
                    required
                    value={model.maxOutputTokens}
                    onChange={(event) =>
                      update(model.id, { maxOutputTokens: Number(event.target.value) })
                    }
                  />
                </label>
                <label className="settings-field">
                  请求超时（秒）
                  <input
                    type="number"
                    min={1}
                    max={3600}
                    required
                    value={model.timeoutMs / 1000}
                    onChange={(event) =>
                      update(model.id, { timeoutMs: Number(event.target.value) * 1000 })
                    }
                  />
                </label>
              </div>
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={model.supportsVision}
                  onChange={(event) => update(model.id, { supportsVision: event.target.checked })}
                />
                支持图片输入
              </label>
              <p className="settings-help">
                按实际模型能力填写。最大输出同时作为上下文预算中的输出预留。
              </p>
            </details>
          </div>
        ))}
      </fieldset>
      <div className="settings-form-actions">
        <button className="device-primary" type="submit" disabled={busy}>
          {busy ? '正在保存…' : '保存连接'}
        </button>
        <button className="device-secondary" type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
      <p className="settings-help">保存后可在模型列表测试并设为默认。</p>
    </form>
  );
}
