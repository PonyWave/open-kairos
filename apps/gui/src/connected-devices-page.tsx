import {
  type Environment,
  EnvironmentConnectionStatus,
  EnvironmentDirectoryStatus,
} from '@kairos/contracts';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppDialog as DeviceDialog } from './app-dialog.js';
import type { KairosClients } from './client.js';
import {
  ConnectedDevices,
  type ConnectedDevicesState,
  type DeviceConnection,
  type DeviceDirectory,
  type DeviceWake,
  normalizeDevicePath,
} from './connected-devices.js';
import { Dropdown } from './dropdown.js';
import { Icon } from './icon.js';

export function ConnectedDevicesPage({ clients }: { clients: KairosClients }) {
  const controller = useMemo(
    () => new ConnectedDevices(clients.environments),
    [clients.environments],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const [revoke, setRevoke] = useState<Environment | null>(null);
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  const directoryDevice = state.devices.find((device) => device.envId === state.directory?.envId);
  return (
    <section className="connected-devices-page">
      <header className="device-page-heading">
        <h1>连接设备</h1>
        {state.devices.length > 0 && (
          <button
            type="button"
            className="device-primary"
            onClick={() => void controller.beginConnection()}
          >
            <Icon name="plus" className="i-sm" />
            添加设备
          </button>
        )}
      </header>
      {state.error && (
        <div className="device-error" role="alert">
          <span>{state.error}</span>
          <button
            type="button"
            className="device-secondary"
            onClick={() => void controller.reload()}
          >
            重试
          </button>
        </div>
      )}
      {state.actionError && !state.connection && !state.directory && (
        <div className="device-error" role="alert">
          <span>{state.actionError}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭错误提示"
            onClick={() => controller.clearActionError()}
          >
            <Icon name="close" className="i-sm" />
          </button>
        </div>
      )}
      {state.loading && state.devices.length === 0 ? (
        <p className="muted" role="status">
          正在加载设备…
        </p>
      ) : state.devices.length === 0 && !state.error ? (
        <div className="device-empty">
          <span className="device-mark">
            <Icon name="monitor" />
          </span>
          <h2>尚未连接设备</h2>
          <p>连接设备后，即可在该设备上执行任务。</p>
          <button
            type="button"
            className="device-primary"
            onClick={() => void controller.beginConnection()}
          >
            <Icon name="plus" className="i-sm" />
            添加设备
          </button>
        </div>
      ) : (
        <div className="device-list">
          {state.devices.map((device) => (
            <DeviceRow
              key={device.envId}
              device={device}
              controller={controller}
              busy={state.busy !== null}
              wake={state.wake?.envId === device.envId ? state.wake : null}
              onRevoke={() => {
                controller.clearActionError();
                setRevoke(device);
              }}
            />
          ))}
        </div>
      )}
      {state.connection && (
        <ConnectionDialog controller={controller} connection={state.connection} state={state} />
      )}
      {state.directory && directoryDevice && (
        <DirectoryDialog
          controller={controller}
          directory={state.directory}
          device={directoryDevice}
          state={state}
        />
      )}
      {revoke && (
        <DeviceDialog
          title={`解除“${revoke.name}”的绑定？`}
          onClose={() => setRevoke(null)}
          closeDisabled={state.busy !== null}
          actions={
            <>
              <button
                type="button"
                className="device-secondary"
                disabled={state.busy !== null}
                onClick={() => setRevoke(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="device-primary device-danger"
                disabled={state.busy !== null}
                onClick={() =>
                  void controller.revoke(revoke).then((saved) => {
                    if (saved) setRevoke(null);
                  })
                }
              >
                解除绑定
              </button>
            </>
          }
        >
          <p>解除后无法在该设备启动新操作，项目文件会保留。正在执行的操作仍需核对实际结果。</p>
          {state.actionError && (
            <p className="device-field-error" role="alert">
              {state.actionError}
            </p>
          )}
        </DeviceDialog>
      )}
    </section>
  );
}

function DeviceRow({
  device,
  controller,
  busy,
  wake,
  onRevoke,
}: {
  device: Environment;
  controller: ConnectedDevices;
  busy: boolean;
  wake: DeviceWake | null;
  onRevoke: () => void;
}) {
  const [editing, setEditing] = useState<{
    value: string;
    version: bigint;
    error: string | null;
  } | null>(null);
  const editor = useRef<HTMLFormElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const isEditing = editing !== null;
  useEffect(() => {
    if (!isEditing) return;
    nameInput.current?.focus();
    nameInput.current?.select();
    const cancelOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !editor.current?.contains(event.target)) setEditing(null);
    };
    document.addEventListener('pointerdown', cancelOutside);
    return () => document.removeEventListener('pointerdown', cancelOutside);
  }, [isEditing]);
  const save = async () => {
    if (!editing || busy) return;
    if (!editing.value.trim()) {
      setEditing({ ...editing, error: '请输入设备名称' });
      return;
    }
    if (await controller.rename({ ...device, settingsVersion: editing.version }, editing.value))
      setEditing(null);
  };
  const online = device.connectionStatus === EnvironmentConnectionStatus.ONLINE;
  return (
    <article className="connected-device-row">
      <div className="device-main">
        <span className="device-mark">
          <Icon name="monitor" />
        </span>
        <div className="device-copy">
          <div className="device-title-line">
            {editing ? (
              <form
                ref={editor}
                className="device-rename"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <input
                  ref={nameInput}
                  aria-label="设备名称"
                  value={editing.value}
                  maxLength={200}
                  aria-invalid={Boolean(editing.error)}
                  disabled={busy}
                  onChange={(event) =>
                    setEditing({ ...editing, value: event.currentTarget.value, error: null })
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setEditing(null);
                    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void save();
                    }
                  }}
                />
                <button type="submit" className="icon-button" aria-label="保存名称" disabled={busy}>
                  <Icon name="check" className="i-sm" />
                </button>
              </form>
            ) : (
              <h2>{device.name}</h2>
            )}
          </div>
          {editing?.error && (
            <p className="device-field-error" role="alert">
              {editing.error}
            </p>
          )}
          <div className="device-directory-summary">
            <span>推荐工作目录</span>
            <code title={device.recommendedPwd}>{device.recommendedPwd}</code>
            <button
              type="button"
              className="device-edit-path"
              disabled={busy}
              aria-label={`修改 ${device.name} 的推荐工作目录`}
              onClick={() => void controller.openDirectory(device)}
            >
              编辑
            </button>
            {!online && (
              <button
                type="button"
                className="device-secondary device-copy-start"
                aria-label={`复制 ${device.name} 的启动命令`}
                aria-live="polite"
                disabled={busy || wake?.phase === 'loading' || wake?.phase === 'copying'}
                onClick={() =>
                  void controller.copyStartCommand(device, (text) =>
                    navigator.clipboard.writeText(text),
                  )
                }
              >
                <Icon name={wake?.phase === 'copied' ? 'check' : 'copy'} className="i-sm" />
                {wake?.phase === 'copied'
                  ? '已复制'
                  : wake?.phase === 'copying'
                    ? '复制中…'
                    : wake?.phase === 'loading'
                      ? '获取命令…'
                      : '复制启动命令'}
              </button>
            )}
          </div>
          {device.directoryStatus === EnvironmentDirectoryStatus.FAILED && (
            <p className="device-field-error">工作目录不可用，请检查目录及访问权限。</p>
          )}
          {!online && wake?.error && (
            <p className="device-field-error" role="alert">
              {wake.error}
            </p>
          )}
        </div>
      </div>
      <div className="device-row-actions">
        <span className={`device-status${online ? ' online' : ''}`}>
          <span />
          {online ? '在线' : '离线'}
        </span>
        <Dropdown
          label={`${device.name} 的更多操作`}
          trigger={<Icon name="more" />}
          triggerClassName="icon-button"
          panelClassName="device-actions-menu"
          align="end"
          disabled={busy}
          items={[
            { value: 'rename', label: '重命名', icon: 'edit' },
            { value: 'revoke', label: '解除绑定', icon: 'link' },
          ]}
          onSelect={(action) => {
            if (action === 'rename') {
              controller.clearActionError();
              setEditing({ value: device.name, version: device.settingsVersion, error: null });
            }
            if (action === 'revoke') onRevoke();
          }}
        />
      </div>
    </article>
  );
}

function ConnectionDialog({
  controller,
  connection,
  state,
}: {
  controller: ConnectedDevices;
  connection: DeviceConnection;
  state: ConnectedDevicesState;
}) {
  const copy = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (connection.phase === 'waiting') copy.current?.focus();
  }, [connection.phase]);
  const close = () => void controller.closeConnection();
  if (connection.phase === 'connected' && connection.device)
    return (
      <ConnectedNameDialog
        controller={controller}
        connection={connection}
        device={connection.device}
        state={state}
      />
    );
  const waiting = connection.phase === 'waiting';
  const seconds = connection.remainingSeconds;
  const countdown = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <DeviceDialog
      title="添加设备"
      onClose={close}
      actions={
        <button type="button" className="device-secondary" onClick={close}>
          取消
        </button>
      }
    >
      {connection.phase === 'preparing' ? (
        <p role="status">正在生成连接命令…</p>
      ) : (
        <>
          {connection.command && (
            <>
              <p>在要添加的设备上执行以下命令，安装并连接 Kairos。</p>
              <div className="device-command">
                <pre>
                  <code>{connection.command}</code>
                </pre>
              </div>
              <button
                ref={copy}
                type="button"
                className="device-secondary device-copy-command"
                aria-live="polite"
                disabled={!waiting || connection.copyState === 'copying' || seconds === 0}
                onClick={() =>
                  void controller.copyCommand((text) => navigator.clipboard.writeText(text))
                }
              >
                <Icon
                  name={connection.copyState === 'copied' ? 'check' : 'copy'}
                  className="i-sm"
                />
                {connection.copyState === 'copied'
                  ? '已复制'
                  : connection.copyState === 'copying'
                    ? '复制中…'
                    : '复制命令'}
              </button>
            </>
          )}
          {connection.copyError && (
            <p className="device-field-error" role="alert">
              {connection.copyError}
            </p>
          )}
          {waiting ? (
            <>
              <div className="device-connection-state" role="status">
                <Icon name="clock" />
                <div>
                  <strong>等待设备连接</strong>
                  <p>请保持此弹窗打开，等待绑定完成。</p>
                </div>
              </div>
              <div className="device-binding-guidance">
                <p>关闭弹窗将结束本次等待。</p>
                <p>
                  命令有效期 10 分钟，剩余 <span className="device-countdown">{countdown}</span>
                </p>
              </div>
            </>
          ) : (
            <div className="device-connection-state" role="status">
              <Icon name="alert" />
              <div>
                <strong>
                  {connection.phase === 'expired' ? '连接命令已过期' : '无法完成设备连接'}
                </strong>
                <p>{connection.error ?? '请重新获取命令，并在目标设备执行。'}</p>
                <button
                  type="button"
                  className="device-secondary"
                  onClick={() => void controller.retryConnection()}
                >
                  重新获取命令
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </DeviceDialog>
  );
}

function ConnectedNameDialog({
  controller,
  connection,
  device,
  state,
}: {
  controller: ConnectedDevices;
  connection: DeviceConnection;
  device: Environment;
  state: ConnectedDevicesState;
}) {
  const [name, setName] = useState(device.name);
  const [version, setVersion] = useState(device.settingsVersion);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        !editor.current?.contains(event.target) &&
        !event.target.closest('[data-device-name-save]')
      ) {
        setName(device.name);
        setVersion(device.settingsVersion);
        setError(null);
        controller.clearActionError();
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [controller, device.name, device.settingsVersion]);
  const save = async () => {
    if (state.busy) return;
    if (!name.trim()) {
      setError('请输入设备名称');
      return;
    }
    if (await controller.rename({ ...device, settingsVersion: version }, name))
      await controller.closeConnection();
  };
  return (
    <DeviceDialog
      title="添加设备"
      onClose={() => void controller.closeConnection()}
      closeDisabled={state.busy !== null}
      actions={
        <button
          type="button"
          className="device-primary"
          data-device-name-save
          disabled={state.busy !== null}
          onClick={() => void save()}
        >
          完成
        </button>
      }
    >
      <div className="device-connection-state connected" role="status">
        <Icon name="checkCircle" />
        <div>
          <strong>设备已连接</strong>
          <p>可修改设备名称，便于在列表中识别。</p>
        </div>
      </div>
      <div ref={editor}>
        <label className="device-name-label" htmlFor="connected-device-name">
          设备名称
        </label>
        <input
          ref={input}
          id="connected-device-name"
          value={name}
          maxLength={200}
          aria-invalid={Boolean(error)}
          disabled={state.busy !== null}
          onChange={(event) => {
            setName(event.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void save();
            }
          }}
        />
        {error && (
          <p className="device-field-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <DaemonCommandGuide controller={controller} connection={connection} />
      {state.actionError && (
        <p className="device-field-error" role="alert">
          {state.actionError}
        </p>
      )}
    </DeviceDialog>
  );
}

function DaemonCommandGuide({
  controller,
  connection,
}: {
  controller: ConnectedDevices;
  connection: DeviceConnection;
}) {
  const commands = connection.daemonCommands;
  const rows = [
    { name: 'startCommand', label: 'start' },
    { name: 'statusCommand', label: 'status' },
    { name: 'stopCommand', label: 'stop' },
  ] as const;
  return (
    <section className="device-daemon-guide" aria-label="Daemon 命令指南">
      <h3>Daemon 命令指南</h3>
      <p>通过以下命令可以启动或暂停守护进程。</p>
      {connection.daemonCommandsLoading ? (
        <p className="device-daemon-guide-status" role="status">
          正在获取命令…
        </p>
      ) : connection.daemonCommandsError ? (
        <div className="device-daemon-guide-status">
          <p className="device-field-error" role="alert">
            {connection.daemonCommandsError}
          </p>
          <button
            type="button"
            className="device-secondary"
            onClick={() => void controller.retryDaemonCommands()}
          >
            重新获取命令
          </button>
        </div>
      ) : commands ? (
        <>
          <div className="device-daemon-codeblock">
            {rows.map((row) => {
              const copied =
                connection.daemonCopy?.name === row.name &&
                connection.daemonCopy.state === 'copied';
              return (
                <div className="device-daemon-codeblock-row" key={row.name}>
                  <code>{commands[row.name]}</code>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={copied ? `${row.label} 命令已复制` : `复制 ${row.label} 命令`}
                    aria-live="polite"
                    disabled={connection.daemonCopy?.state === 'copying'}
                    onClick={() =>
                      void controller.copyDaemonCommand(row.name, (text) =>
                        navigator.clipboard.writeText(text),
                      )
                    }
                  >
                    <Icon name={copied ? 'check' : 'copy'} className="i-sm" />
                  </button>
                </div>
              );
            })}
          </div>
          {connection.daemonCopyError && (
            <p className="device-field-error" role="alert">
              {connection.daemonCopyError}
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}

function parentDirectory(path: string): string {
  return normalizeDevicePath(`${path}/..`);
}

function DirectoryDialog({
  controller,
  directory,
  device,
  state,
}: {
  controller: ConnectedDevices;
  directory: DeviceDirectory;
  device: Environment;
  state: ConnectedDevicesState;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const selected = directory.path;
  let favorite = false;
  let validFavoritePath = true;
  try {
    favorite = device.favoriteDirectories.includes(normalizeDevicePath(selected));
  } catch {
    // The address can be incomplete while editing; only valid paths can be bookmarked.
    validFavoritePath = false;
  }
  const disabled = state.busy !== null;
  return (
    <DeviceDialog
      wide
      title="修改推荐工作目录"
      subtitle={device.name}
      onClose={() => controller.closeDirectory()}
      closeDisabled={disabled}
      actions={
        <>
          <button
            type="button"
            className="device-secondary"
            disabled={disabled}
            onClick={() => controller.closeDirectory()}
          >
            取消
          </button>
          <button
            type="button"
            className="device-primary"
            disabled={disabled}
            onClick={() => void controller.saveDirectory()}
          >
            保存
          </button>
        </>
      }
    >
      <div className="device-path-layout">
        <nav className="device-favorites" aria-label="常用目录">
          <h3>常用目录</h3>
          {device.favoriteDirectories.length ? (
            <div className="device-favorite-list">
              {device.favoriteDirectories.map((path) => (
                <button
                  type="button"
                  key={path}
                  className="device-favorite"
                  title={path}
                  aria-label={`转到常用目录 ${path}`}
                  aria-current={directory.browsePath === path ? 'location' : undefined}
                  onClick={() => void controller.browseDirectory(path)}
                >
                  <Icon name="folder" className="i-sm" />
                  <span>
                    <span className="device-favorite-name">
                      {path.split('/').filter(Boolean).at(-1) ?? '根目录'}
                    </span>
                    <span className="device-favorite-parent">{parentDirectory(path)}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">点击右侧星标，收藏此目录。</p>
          )}
        </nav>
        <section className="device-path-browser" aria-label="文件夹浏览">
          <div className="device-path-address">
            <button
              type="button"
              className="icon-button"
              aria-label="返回上级目录"
              title="返回上级目录"
              disabled={directory.browsePath === '/'}
              onClick={() => void controller.browseDirectory(parentDirectory(directory.browsePath))}
            >
              <Icon name="up" className="i-sm" />
            </button>
            <input
              ref={input}
              aria-label="工作目录，支持输入绝对路径"
              value={selected}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(event) => controller.selectDirectory(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void controller.browseDirectory(selected);
                }
              }}
            />
            <button
              type="button"
              className="device-secondary"
              onClick={() => void controller.browseDirectory(selected)}
            >
              转到
            </button>
            <button
              type="button"
              className="icon-button device-bookmark"
              aria-label={favorite ? '取消收藏此目录' : '收藏此目录'}
              aria-pressed={favorite}
              title={favorite ? '取消收藏此目录' : '收藏此目录'}
              disabled={disabled || !validFavoritePath}
              onClick={() => void controller.toggleFavorite()}
            >
              <Icon name="star" className="i-sm" />
            </button>
          </div>
          {directory.error && (
            <p className="device-field-error" role="alert">
              {directory.error}
            </p>
          )}
          {state.actionError && (
            <p className="device-field-error" role="alert">
              {state.actionError}
            </p>
          )}
          <div className="device-folder-list">
            {directory.loading && directory.entries.length === 0 ? (
              <p className="device-folder-empty" role="status">
                正在读取目录…
              </p>
            ) : directory.entries.length === 0 ? (
              <p className="device-folder-empty">
                {directory.error ? '目录列表暂不可用。' : '该目录没有子文件夹'}
              </p>
            ) : (
              directory.entries.map((entry) => (
                <div className="device-folder-row" key={entry.path}>
                  <button
                    type="button"
                    className={`device-folder-select${entry.path === selected ? ' selected' : ''}`}
                    aria-label={`${entry.path === selected ? '已选择' : '选择'}目录 ${entry.name}`}
                    onClick={() => controller.selectDirectory(entry.path)}
                    onDoubleClick={() => void controller.browseDirectory(entry.path)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowRight') {
                        event.preventDefault();
                        void controller.browseDirectory(entry.path);
                      }
                    }}
                  >
                    <Icon name="folder" className="i-sm" />
                    <span>{entry.name}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`打开目录 ${entry.name}`}
                    onClick={() => void controller.browseDirectory(entry.path)}
                  >
                    <Icon name="chevron" className="i-sm" />
                  </button>
                </div>
              ))
            )}
          </div>
          {directory.hasMore && (
            <button
              type="button"
              className="device-secondary device-load-more"
              disabled={directory.loading}
              onClick={() => void controller.browseDirectory(directory.browsePath, true)}
            >
              {directory.loading ? '正在读取…' : '加载更多目录'}
            </button>
          )}
        </section>
      </div>
    </DeviceDialog>
  );
}
