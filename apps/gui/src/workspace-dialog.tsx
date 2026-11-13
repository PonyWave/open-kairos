import {
  type Environment,
  EnvironmentConnectionStatus,
  type EnvironmentDirectoryEntry,
  type Workspace,
} from '@kairos/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { AppDialog } from './app-dialog.js';
import type { KairosClients } from './client.js';
import { Dropdown } from './dropdown.js';
import { workspaceSelectableEnvironments } from './environment-view.js';
import { formatClientError } from './errors.js';
import { Icon } from './icon.js';
import { randomId } from './random.js';

export function WorkspaceDialog({
  clients,
  workspace,
  onClose,
  onSaved,
  onVisibilityChanged,
}: {
  clients: KairosClients;
  workspace: Workspace | null;
  onClose: () => void;
  onSaved: () => void;
  onVisibilityChanged?: (() => void) | undefined;
}) {
  const formId = useId();
  const pathInputId = useId();
  const previewId = useId();
  const [name, setName] = useState(workspace?.name ?? '');
  const [description, setDescription] = useState(workspace?.description ?? '');
  const [envId, setEnvId] = useState(workspace?.envId ?? '');
  const [path, setPath] = useState(workspace?.path ?? '');
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [browse, setBrowse] = useState<{
    path: string;
    entries: EnvironmentDirectoryEntry[];
    next: number | null;
  } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [hidden, setHidden] = useState(workspace?.hidden ?? false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const initial = useRef({
    name: workspace?.name ?? '',
    description: workspace?.description ?? '',
    envId: workspace?.envId ?? '',
    path: workspace?.path ?? '',
  });
  const dirty =
    name !== initial.current.name ||
    description !== initial.current.description ||
    envId !== initial.current.envId ||
    path !== initial.current.path;
  useEffect(() => {
    const abort = new AbortController();
    void clients.environments
      .listEnvironments({}, { signal: abort.signal })
      .then((result) => {
        const usable = workspaceSelectableEnvironments(result.environments, workspace?.envId);
        setEnvironments(usable);
        if (!workspace) {
          const main =
            usable.find((e) => e.envId === 'main') ??
            usable.find((e) => e.connectionStatus === EnvironmentConnectionStatus.ONLINE) ??
            usable[0];
          if (main) {
            initial.current.envId = main.envId;
            initial.current.path = main.recommendedPwd;
            setEnvId(main.envId);
            setPath(main.recommendedPwd);
          }
        }
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setError(formatClientError(cause));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => {
      abort.abort();
      request.current?.abort();
    };
  }, [clients, workspace]);
  useEffect(() => {
    const block = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', block);
    return () => window.removeEventListener('beforeunload', block);
  }, [dirty]);
  const change = (key: string) =>
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  const selected = environments.find((e) => e.envId === envId);
  const envLabel = loading
    ? '正在加载设备…'
    : !environments.length
      ? '暂无可用设备'
      : selected
        ? selected.name || selected.envId
        : envId === 'main'
          ? '主环境'
          : envId || '选择设备';
  const close = () => {
    if (busy) return;
    if (dirty) setDiscard(true);
    else onClose();
  };
  const togglePreview = () => {
    if (previewOpen) {
      request.current?.abort();
      setBrowsing(false);
      setBrowse(null);
      setPreviewOpen(false);
      return;
    }
    setPreviewOpen(true);
    void list(path);
  };
  async function toggleVisibility() {
    if (!workspace || visibilityBusy) return;
    setVisibilityBusy(true);
    setVisibilityError(null);
    try {
      await clients.workspaces.updateWorkspace({
        clientActionId: randomId(),
        workspaceId: workspace.workspaceId,
        hidden: !hidden,
      });
      setHidden(!hidden);
      onVisibilityChanged?.();
    } catch (cause) {
      setVisibilityError(formatClientError(cause));
    } finally {
      setVisibilityBusy(false);
    }
  }
  async function list(dir: string, offset = 0, env: string = envId) {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setBrowsing(true);
    setError(null);
    try {
      const result = await clients.environments.listEnvironmentDirectories(
        { envId: env, path: dir, offset, limit: 100 },
        { signal: abort.signal },
      );
      if (abort.signal.aborted) return;
      setPath(result.path);
      setBrowse((current) => ({
        path: result.path,
        entries:
          offset && current?.path === result.path
            ? [...current.entries, ...result.entries]
            : result.entries,
        next: result.hasMore ? (result.nextOffset ?? offset + result.entries.length) : null,
      }));
    } catch (cause) {
      if (!abort.signal.aborted) setError(formatClientError(cause));
    } finally {
      if (!abort.signal.aborted) setBrowsing(false);
    }
  }
  async function save() {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = '请填写工作空间名称。';
    if (!workspace) {
      if (!envId) next.envId = '请选择设备。';
      if (
        !path.startsWith('/') ||
        path.includes('//') ||
        path.split('/').some((p) => p === '.' || p === '..') ||
        (path.length > 1 && path.endsWith('/'))
      )
        next.path = '请填写规范的绝对目录，例如 /Users/me/project。';
    }
    setFieldErrors(next);
    if (Object.keys(next).length) {
      requestAnimationFrame(() =>
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (workspace)
        await clients.workspaces.updateWorkspace({
          clientActionId: randomId(),
          workspaceId: workspace.workspaceId,
          name: name.trim(),
          description: description.trim(),
        });
      else
        await clients.workspaces.createWorkspace({
          clientActionId: randomId(),
          name: name.trim(),
          description: description.trim(),
          envId,
          path: path.trim(),
        });
      onSaved();
    } catch (cause) {
      setError(formatClientError(cause));
    } finally {
      setBusy(false);
    }
  }
  const fieldError = (key: string) =>
    fieldErrors[key] && (
      <span className="settings-field-error" role="alert">
        {fieldErrors[key]}
      </span>
    );
  return (
    <AppDialog
      title={workspace ? '编辑空间' : '添加工作空间'}
      wide
      onClose={close}
      closeDisabled={busy}
      subtitle={
        workspace
          ? '查看执行位置，调整名称、描述和侧边栏显示。'
          : '选择设备和工作目录，新话题会使用这个默认执行位置。'
      }
      actions={
        discard ? (
          <>
            <button className="device-secondary" type="button" onClick={() => setDiscard(false)}>
              继续编辑
            </button>
            <button className="device-primary" type="button" onClick={onClose}>
              放弃修改
            </button>
          </>
        ) : (
          <>
            <button className="device-secondary" type="button" disabled={busy} onClick={close}>
              取消
            </button>
            <button
              className="device-primary"
              type="submit"
              form={formId}
              disabled={busy || (!workspace && loading)}
            >
              {busy ? '正在保存…' : workspace ? '保存修改' : '创建工作空间'}
            </button>
          </>
        )
      }
    >
      {discard ? (
        <p role="alert">尚有未保存的修改。关闭后将丢弃这些修改。</p>
      ) : (
        <form
          id={formId}
          ref={formRef}
          className="workspace-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy}>
            <label className="settings-field">
              名称
              <input
                value={name}
                maxLength={200}
                required
                aria-invalid={Boolean(fieldErrors.name)}
                onChange={(e) => {
                  setName(e.target.value);
                  change('name');
                }}
                placeholder="例如：产品设计"
              />
              {fieldError('name')}
            </label>
            <label className="settings-field">
              描述
              <textarea
                value={description}
                maxLength={2000}
                rows={3}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="例如：界面设计、体验验收与发布准备"
              />
            </label>
            {workspace ? (
              <>
                <div className="settings-field">
                  <span id={`${pathInputId}-label`}>工作目录</span>
                  <span className="workspace-path-row">
                    <span
                      className="settings-select-trigger workspace-env-trigger workspace-env-static"
                      aria-disabled="true"
                      title="设备创建后不可修改"
                    >
                      <span className="workspace-env-name">
                        {selected?.name ?? (envId === 'main' ? '主环境' : envId)}
                      </span>
                    </span>
                    <span
                      className="workspace-path-static"
                      aria-labelledby={`${pathInputId}-label`}
                      title="目录创建后不可修改"
                    >
                      {path}
                    </span>
                  </span>
                </div>
                <label className="workspace-visibility-toggle">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={!hidden}
                    aria-checked={!hidden}
                    disabled={visibilityBusy}
                    onChange={() => void toggleVisibility()}
                  />
                  <span className="workspace-switch-track" aria-hidden="true">
                    <span className="workspace-switch-thumb" />
                  </span>
                  在侧边栏显示
                </label>
                {visibilityError && (
                  <p className="settings-field-error" role="alert">
                    {visibilityError}
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="settings-field">
                  <label htmlFor={pathInputId}>工作目录</label>
                  <span className="workspace-path-row">
                    <Dropdown
                      label="设备"
                      trigger={
                        <>
                          <span className="workspace-env-name">{envLabel}</span>
                          <Icon name="down" className="i-sm dropdown-chevron" />
                        </>
                      }
                      triggerClassName="settings-select-trigger workspace-env-trigger"
                      value={envId}
                      items={environments.map((e) => ({
                        value: e.envId,
                        label: `${e.name || e.envId}${
                          e.connectionStatus === EnvironmentConnectionStatus.ONLINE ? '' : ' · 离线'
                        }`,
                      }))}
                      onSelect={(nextEnv) => {
                        request.current?.abort();
                        setBrowsing(false);
                        const nextPath =
                          environments.find((v) => v.envId === nextEnv)?.recommendedPwd ?? '';
                        setEnvId(nextEnv);
                        setPath(nextPath);
                        setBrowse(null);
                        setError(null);
                        change('envId');
                        if (previewOpen) void list(nextPath, 0, nextEnv);
                      }}
                      disabled={loading || environments.length === 0}
                    />
                    <input
                      id={pathInputId}
                      value={path}
                      autoCapitalize="off"
                      spellCheck={false}
                      placeholder="/Users/me/project"
                      aria-invalid={Boolean(fieldErrors.path)}
                      onChange={(e) => {
                        setPath(e.target.value);
                        change('path');
                        setBrowse(null);
                      }}
                    />
                    <button
                      type="button"
                      className="icon-button workspace-preview-toggle"
                      aria-expanded={previewOpen}
                      aria-controls={previewId}
                      aria-label={previewOpen ? '收起目录预览' : '展开目录预览'}
                      title={previewOpen ? '收起目录预览' : '展开目录预览'}
                      disabled={
                        !envId || selected?.connectionStatus !== EnvironmentConnectionStatus.ONLINE
                      }
                      onClick={togglePreview}
                    >
                      <Icon
                        name="down"
                        className={`i-sm workspace-preview-chevron${previewOpen ? ' expanded' : ''}`}
                      />
                    </button>
                  </span>
                  {fieldError('envId')}
                  {fieldError('path')}
                </div>
                {selected?.connectionStatus !== EnvironmentConnectionStatus.ONLINE && !loading && (
                  <p className="settings-help">
                    设备当前离线，暂时无法浏览目录。可以填写目录创建空间，设备上线后再执行任务。
                  </p>
                )}
                <div
                  id={previewId}
                  className="workspace-preview"
                  data-open={previewOpen || undefined}
                >
                  {previewOpen &&
                    (browse ? (
                      <>
                        <div className="workspace-browse-heading">
                          <button
                            className="device-secondary"
                            type="button"
                            disabled={browse.path === '/' || browsing}
                            onClick={() =>
                              void list(browse.path.split('/').slice(0, -1).join('/') || '/')
                            }
                          >
                            上级目录
                          </button>
                          <code>{browse.path}</code>
                        </div>
                        <div className="workspace-browse-list">
                          {browse.entries.length === 0 ? (
                            <p className="workspace-no-topics">
                              此目录没有子目录，可以使用当前目录。
                            </p>
                          ) : (
                            <ul>
                              {browse.entries.map((e) => (
                                <li key={e.path}>
                                  <button
                                    type="button"
                                    className="workspace-browse-entry"
                                    disabled={browsing}
                                    onClick={() => void list(e.path)}
                                  >
                                    <Icon name="folder" className="i-sm" />
                                    {e.name}
                                    <Icon name="chevron" className="i-sm" />
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                          {browse.next !== null && (
                            <button
                              type="button"
                              className="device-secondary"
                              disabled={browsing}
                              onClick={() => void list(browse.path, browse.next ?? 0)}
                            >
                              加载更多目录
                            </button>
                          )}
                        </div>
                      </>
                    ) : (
                      <p className="workspace-preview-status">
                        {browsing ? '正在读取目录…' : '目录已修改，收起后重新展开以读取。'}
                      </p>
                    ))}
                </div>
              </>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="settings-error">
              {error}
            </p>
          )}
        </form>
      )}
    </AppDialog>
  );
}
