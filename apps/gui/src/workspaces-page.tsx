import type { Environment, EnvironmentDirectoryEntry } from '@kairos/contracts';
import { useEffect, useState } from 'react';
import type { KairosClients } from './client.js';
import { FailureNotice } from './failure-notice.js';
import { Icon } from './icon.js';
import type { WorkspaceGroup } from './use-workspaces.js';

export function WorkspacesPage({
  clients,
  groups,
  loading,
  error,
  onChanged,
  onOpenThread,
}: {
  clients: KairosClients;
  groups: readonly WorkspaceGroup[];
  loading: boolean;
  error: string | null;
  onChanged: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [environments, setEnvironments] = useState<readonly Environment[]>([]);
  const [name, setName] = useState('');
  const [envId, setEnvId] = useState('');
  const [path, setPath] = useState('/');
  const [browsePath, setBrowsePath] = useState('/');
  const [entries, setEntries] = useState<readonly EnvironmentDirectoryEntry[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ workspaceId: string; name: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void clients.environments
      .listEnvironments({})
      .then((result) => {
        if (cancelled) return;
        setEnvironments(result.environments);
        setEnvId((current) => current || (result.environments[0]?.envId ?? ''));
      })
      .catch(() => {
        if (!cancelled) setFormError('设备列表加载失败。');
      });
    return () => {
      cancelled = true;
    };
  }, [clients]);

  async function browse(target: string) {
    if (!envId) {
      setFormError('请先选择设备。');
      return;
    }
    setBrowsing(true);
    setFormError(null);
    try {
      const result = await clients.environments.listEnvironmentDirectories({
        envId,
        path: target,
        offset: 0,
        limit: 200,
      });
      setBrowsePath(result.path);
      setPath(result.path);
      setEntries(result.entries);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBrowsing(false);
    }
  }

  async function create() {
    if (!name.trim() || !envId || !path.trim()) {
      setFormError('请填写名称、设备和工作目录。');
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await clients.workspaces.createWorkspace({
        clientActionId: crypto.randomUUID(),
        name: name.trim(),
        envId,
        path: path.trim(),
      });
      setName('');
      onChanged();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    if (!renaming || !renaming.name.trim()) return;
    setBusy(true);
    setFormError(null);
    try {
      await clients.workspaces.renameWorkspace({
        clientActionId: crypto.randomUUID(),
        workspaceId: renaming.workspaceId,
        name: renaming.name.trim(),
      });
      setRenaming(null);
      onChanged();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="workspaces-page conversation-list-page"
      aria-labelledby="workspaces-heading"
    >
      <header className="page-heading">
        <div>
          <h1 id="workspaces-heading">工作空间</h1>
        </div>
      </header>
      {error && (
        <FailureNotice
          label="工作空间加载失败"
          message={error}
          busy={loading}
          onRetry={onChanged}
        />
      )}
      <section className="workspace-create" aria-label="新建工作空间">
        <h2>新建工作空间</h2>
        <div className="workspace-create-form">
          <label>
            名称
            <input
              value={name}
              maxLength={200}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：Kairos 项目"
            />
          </label>
          <label>
            设备
            <select
              value={envId}
              disabled={busy}
              onChange={(event) => {
                setEnvId(event.target.value);
                setEntries([]);
              }}
            >
              {environments.map((environment) => (
                <option key={environment.envId} value={environment.envId}>
                  {environment.name || environment.envId}
                </option>
              ))}
            </select>
          </label>
          <label>
            工作目录
            <span className="workspace-path-row">
              <input
                value={path}
                disabled={busy}
                autoCapitalize="off"
                spellCheck={false}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/absolute/path"
              />
              <button
                type="button"
                className="device-secondary"
                disabled={busy || browsing || !envId}
                onClick={() => void browse(path)}
              >
                {browsing ? '正在读取' : '浏览'}
              </button>
            </span>
          </label>
          {entries.length > 0 && (
            <div className="workspace-browse">
              <button
                type="button"
                className="device-secondary"
                disabled={busy || browsePath === '/'}
                onClick={() => {
                  const parent = browsePath.split('/').slice(0, -1).join('/') || '/';
                  void browse(parent);
                }}
              >
                上级目录
              </button>
              <ul>
                {entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="workspace-browse-entry"
                      disabled={busy}
                      onClick={() => void browse(entry.path)}
                    >
                      <Icon name="folder" className="i-sm" />
                      {entry.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {formError && (
            <p className="sidebar-error" role="alert">
              {formError}
            </p>
          )}
          <button
            type="button"
            className="primary"
            disabled={busy || !name.trim() || !envId || !path.trim()}
            onClick={() => void create()}
          >
            {busy ? '正在保存' : '创建工作空间'}
          </button>
        </div>
      </section>
      <section className="workspace-list" aria-label="已有工作空间">
        <h2>已有工作空间</h2>
        {groups.length === 0 && !loading ? (
          <p className="empty">还没有工作空间。</p>
        ) : (
          groups.map((group) => (
            <div className="workspace-item" key={group.workspace?.workspaceId ?? 'unknown'}>
              {renaming?.workspaceId === group.workspace?.workspaceId && renaming ? (
                <span className="workspace-rename">
                  <input
                    value={renaming.name}
                    maxLength={200}
                    disabled={busy}
                    onChange={(event) =>
                      setRenaming({ workspaceId: renaming.workspaceId, name: event.target.value })
                    }
                  />
                  <button
                    type="button"
                    className="device-secondary"
                    disabled={busy || !renaming.name.trim()}
                    onClick={() => void rename()}
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    className="device-secondary"
                    disabled={busy}
                    onClick={() => setRenaming(null)}
                  >
                    取消
                  </button>
                </span>
              ) : (
                <>
                  <span className="workspace-item-name">{group.workspace?.name}</span>
                  <span
                    className="workspace-item-path"
                    title={`${group.workspace?.envId} · ${group.workspace?.path}`}
                  >
                    {group.workspace?.envId} · {group.workspace?.path}
                  </span>
                  <button
                    type="button"
                    className="device-secondary"
                    disabled={busy}
                    onClick={() =>
                      setRenaming({
                        workspaceId: group.workspace?.workspaceId ?? '',
                        name: group.workspace?.name ?? '',
                      })
                    }
                  >
                    重命名
                  </button>
                  {group.mainThread && (
                    <button
                      type="button"
                      className="device-secondary"
                      onClick={() => onOpenThread(group.mainThread?.threadId ?? '')}
                    >
                      打开主对话
                    </button>
                  )}
                </>
              )}
            </div>
          ))
        )}
      </section>
    </section>
  );
}
