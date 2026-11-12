import {
  type Environment,
  EnvironmentBindingStatus,
  EnvironmentConnectionStatus,
  type EnvironmentDirectoryEntry,
  type GetEnvironmentDaemonCommandsResponse,
} from '@kairos/contracts';
import type { KairosClients } from './client.js';
import { isSelfHostedEnvironment } from './environment-view.js';
import { classifyActionFailure, formatClientError } from './errors.js';

export type DaemonCommandName = 'startCommand' | 'statusCommand' | 'stopCommand';

export interface DeviceWake {
  envId: string;
  phase: 'loading' | 'copying' | 'copied' | 'error';
  error: string | null;
}

export interface DeviceConnection {
  phase: 'preparing' | 'waiting' | 'connected' | 'expired' | 'error';
  envId: string | null;
  command: string;
  expiresAt: number;
  remainingSeconds: number;
  device: Environment | null;
  error: string | null;
  copyState: 'idle' | 'copying' | 'copied';
  copyError: string | null;
  daemonCommands: GetEnvironmentDaemonCommandsResponse | null;
  daemonCommandsLoading: boolean;
  daemonCommandsError: string | null;
  daemonCopy: { name: DaemonCommandName; state: 'copying' | 'copied' } | null;
  daemonCopyError: string | null;
}

export interface DeviceDirectory {
  envId: string;
  browsePath: string;
  path: string;
  entries: readonly EnvironmentDirectoryEntry[];
  loading: boolean;
  hasMore: boolean;
  nextOffset: number;
  error: string | null;
}

export interface ConnectedDevicesState {
  devices: readonly Environment[];
  loading: boolean;
  error: string | null;
  busy: string | null;
  actionError: string | null;
  connection: DeviceConnection | null;
  directory: DeviceDirectory | null;
  wake: DeviceWake | null;
}

export function normalizeDevicePath(value: string): string {
  if (!value.startsWith('/') || value.includes('\0') || value.length > 4096)
    throw new Error('请输入以 / 开头的绝对目录路径。');
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function message(cause: unknown): string {
  const text = formatClientError(cause);
  if (text.includes('installation package') || text.includes('KAIROS_DAEMON_RELEASE_DIR'))
    return '服务端尚未配置可用的设备安装包，请先构建并配置安装包目录。';
  return text;
}

export class ConnectedDevices {
  private current: ConnectedDevicesState = {
    devices: [],
    loading: false,
    error: null,
    busy: null,
    actionError: null,
    connection: null,
    directory: null,
    wake: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private listGeneration = 0;
  private connectionGeneration = 0;
  private directoryGeneration = 0;
  private directorySelectionGeneration = 0;
  private wakeGeneration = 0;
  private active = false;
  private lifetime = new AbortController();
  private listRequest: AbortController | undefined;
  private connectionRequest: AbortController | undefined;
  private directoryRequest: AbortController | undefined;
  private wakeRequest: AbortController | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private connectionTimer: ReturnType<typeof setTimeout> | undefined;
  private countdownTimer: ReturnType<typeof setTimeout> | undefined;
  private mutationIds = new Map<string, { fingerprint: string; id: string }>();

  constructor(
    private readonly client: KairosClients['environments'],
    private readonly now: () => number = Date.now,
  ) {}

  get state(): ConnectedDevicesState {
    return this.current;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = (): ConnectedDevicesState => this.current;

  start(): void {
    if (this.active) return;
    this.active = true;
    this.lifetime = new AbortController();
    const generation = this.generation;
    const tick = async () => {
      if (!this.active || generation !== this.generation) return;
      await this.reload();
      if (this.active && generation === this.generation)
        this.refreshTimer = setTimeout(() => void tick(), 3000);
    };
    void tick();
  }

  stop(): void {
    this.active = false;
    ++this.generation;
    ++this.listGeneration;
    ++this.connectionGeneration;
    ++this.directoryGeneration;
    ++this.wakeGeneration;
    this.lifetime.abort();
    this.listRequest?.abort();
    this.connectionRequest?.abort();
    this.directoryRequest?.abort();
    this.wakeRequest?.abort();
    clearTimeout(this.refreshTimer);
    clearTimeout(this.connectionTimer);
    clearTimeout(this.countdownTimer);
  }

  private patch(patch: Partial<ConnectedDevicesState>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener();
  }

  async reload(): Promise<void> {
    const generation = ++this.listGeneration;
    this.listRequest?.abort();
    const request = new AbortController();
    this.listRequest = request;
    this.patch({ loading: this.current.devices.length === 0, error: null });
    try {
      const result = await this.client.listEnvironments(
        {},
        { signal: request.signal, timeoutMs: 10_000 },
      );
      if (generation !== this.listGeneration) return;
      const devices = result.environments.filter(
        (device) =>
          isSelfHostedEnvironment(device) &&
          device.bindingStatus === EnvironmentBindingStatus.ACTIVE,
      );
      const connection = this.current.connection;
      const connected =
        connection?.phase === 'connected'
          ? devices.find((device) => device.envId === connection.envId)
          : undefined;
      this.patch({
        devices,
        loading: false,
        ...(connected && connection ? { connection: { ...connection, device: connected } } : {}),
      });
      if (
        this.current.directory &&
        !devices.some((device) => device.envId === this.current.directory?.envId)
      ) {
        this.closeDirectory();
        this.patch({ actionError: '该设备已解除绑定。' });
      }
    } catch (cause) {
      if (generation === this.listGeneration && !request.signal.aborted)
        this.patch({ loading: false, error: message(cause) });
    }
  }

  private upsert(device: Environment): void {
    ++this.listGeneration;
    this.listRequest?.abort();
    const existing = this.current.devices.find((value) => value.envId === device.envId);
    if (existing && existing.settingsVersion > device.settingsVersion) return;
    const devices = this.current.devices.filter((value) => value.envId !== device.envId);
    if (isSelfHostedEnvironment(device) && device.bindingStatus === EnvironmentBindingStatus.ACTIVE)
      devices.push(device);
    devices.sort((left, right) => {
      const first = left.createdAt?.seconds ?? 0n;
      const second = right.createdAt?.seconds ?? 0n;
      return first < second
        ? -1
        : first > second
          ? 1
          : (left.createdAt?.nanos ?? 0) - (right.createdAt?.nanos ?? 0) ||
            left.envId.localeCompare(right.envId);
    });
    this.patch({ devices });
  }

  private async mutation(
    key: string,
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<boolean> {
    if (this.current.busy) return false;
    ++this.listGeneration;
    this.listRequest?.abort();
    const generation = this.generation;
    this.patch({ busy: key, actionError: null });
    try {
      await work(this.lifetime.signal);
      if (generation !== this.generation) return false;
      this.mutationIds.delete(key);
      return true;
    } catch (cause) {
      if (generation === this.generation && !this.lifetime.signal.aborted) {
        if (classifyActionFailure(cause) !== 'unknown') this.mutationIds.delete(key);
        this.patch({ actionError: message(cause) });
      }
      return false;
    } finally {
      if (generation === this.generation) this.patch({ busy: null });
    }
  }

  private mutationId(key: string, payload: unknown): string {
    const fingerprint = JSON.stringify(payload);
    const existing = this.mutationIds.get(key);
    if (existing?.fingerprint === fingerprint) return existing.id;
    const id = crypto.randomUUID();
    this.mutationIds.set(key, { fingerprint, id });
    return id;
  }

  rename(device: Environment, name: string): Promise<boolean> {
    return this.mutation(`rename:${device.envId}`, async (signal) => {
      const result = await this.client.updateEnvironment(
        {
          clientActionId: this.mutationId(`rename:${device.envId}`, {
            name: name.trim(),
            version: device.settingsVersion.toString(),
          }),
          envId: device.envId,
          name: name.trim(),
          expectedSettingsVersion: device.settingsVersion,
        },
        { signal, timeoutMs: 10_000 },
      );
      if (signal.aborted) return;
      if (!result.environment) throw new Error('服务端未返回设备设置。');
      this.upsert(result.environment);
      if (this.current.connection?.envId === device.envId)
        this.patch({ connection: { ...this.current.connection, device: result.environment } });
    });
  }

  revoke(device: Environment): Promise<boolean> {
    return this.mutation(`revoke:${device.envId}`, async (signal) => {
      await this.client.revokeEnvironment(
        {
          clientActionId: this.mutationId(`revoke:${device.envId}`, { envId: device.envId }),
          envId: device.envId,
        },
        { signal, timeoutMs: 10_000 },
      );
      if (signal.aborted) return;
      ++this.listGeneration;
      this.listRequest?.abort();
      if (this.current.wake?.envId === device.envId) {
        ++this.wakeGeneration;
        this.wakeRequest?.abort();
      }
      this.patch({
        devices: this.current.devices.filter((value) => value.envId !== device.envId),
        ...(this.current.wake?.envId === device.envId ? { wake: null } : {}),
      });
    });
  }

  async beginConnection(): Promise<void> {
    this.connectionRequest?.abort();
    clearTimeout(this.connectionTimer);
    clearTimeout(this.countdownTimer);
    const generation = ++this.connectionGeneration;
    const request = new AbortController();
    this.connectionRequest = request;
    this.patch({
      connection: {
        phase: 'preparing',
        envId: null,
        command: '',
        expiresAt: 0,
        remainingSeconds: 0,
        device: null,
        error: null,
        copyState: 'idle',
        copyError: null,
        daemonCommands: null,
        daemonCommandsLoading: false,
        daemonCommandsError: null,
        daemonCopy: null,
        daemonCopyError: null,
      },
    });
    try {
      const result = await this.client.beginDeviceConnection(
        { clientActionId: crypto.randomUUID() },
        { signal: request.signal, timeoutMs: 10_000 },
      );
      if (generation !== this.connectionGeneration) return;
      if (!result.environment || !result.expiresAt || !result.installCommand)
        throw new Error('服务端未返回完整的设备连接命令。');
      const expiresAt =
        Number(result.expiresAt.seconds) * 1000 + result.expiresAt.nanos / 1_000_000;
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now())
        throw new Error('连接命令已经到期，请重新获取。');
      this.patch({
        connection: {
          phase: 'waiting',
          envId: result.environment.envId,
          command: result.installCommand,
          expiresAt,
          remainingSeconds: Math.ceil((expiresAt - this.now()) / 1000),
          device: null,
          error: null,
          copyState: 'idle',
          copyError: null,
          daemonCommands: null,
          daemonCommandsLoading: false,
          daemonCommandsError: null,
          daemonCopy: null,
          daemonCopyError: null,
        },
      });
      this.countdown(generation);
      void this.pollConnection(generation);
    } catch (cause) {
      if (
        generation === this.connectionGeneration &&
        !request.signal.aborted &&
        this.current.connection
      )
        this.patch({
          connection: { ...this.current.connection, phase: 'error', error: message(cause) },
        });
    }
  }

  private countdown(generation: number): void {
    const connection = this.current.connection;
    if (generation !== this.connectionGeneration || connection?.phase !== 'waiting') return;
    const remainingSeconds = Math.max(0, Math.ceil((connection.expiresAt - this.now()) / 1000));
    this.patch({
      connection: {
        ...connection,
        remainingSeconds,
        ...(remainingSeconds === 0
          ? { phase: 'expired' as const, copyState: 'idle' as const }
          : {}),
      },
    });
    if (remainingSeconds > 0)
      this.countdownTimer = setTimeout(
        () => this.countdown(generation),
        Math.min(1000, connection.expiresAt - this.now()),
      );
  }

  private async pollConnection(generation: number): Promise<void> {
    const connection = this.current.connection;
    const signal = this.connectionRequest?.signal;
    if (
      generation !== this.connectionGeneration ||
      !connection?.envId ||
      connection.phase !== 'waiting' ||
      !signal
    )
      return;
    try {
      const result = await this.client.getEnvironment(
        { envId: connection.envId },
        { signal, timeoutMs: 3000 },
      );
      if (generation !== this.connectionGeneration || !this.current.connection) return;
      if (!result.environment) throw new Error('服务端未返回设备状态。');
      if (result.environment.bindingStatus === EnvironmentBindingStatus.ACTIVE) {
        this.completeConnection(result.environment);
        return;
      }
      if (result.environment.bindingStatus === EnvironmentBindingStatus.REVOKED)
        throw new Error('本次连接等待已结束，请重新获取命令。');
    } catch (cause) {
      if (
        generation === this.connectionGeneration &&
        this.current.connection?.phase === 'waiting' &&
        !this.connectionRequest?.signal.aborted
      ) {
        clearTimeout(this.countdownTimer);
        this.patch({
          connection: { ...this.current.connection, phase: 'error', error: message(cause) },
        });
      }
    }
    if (generation === this.connectionGeneration && this.current.connection?.phase === 'waiting')
      this.connectionTimer = setTimeout(() => void this.pollConnection(generation), 500);
  }

  private completeConnection(device: Environment): void {
    const connection = this.current.connection;
    if (!connection) return;
    clearTimeout(this.countdownTimer);
    this.upsert(device);
    this.patch({
      connection: {
        ...connection,
        phase: 'connected',
        envId: device.envId,
        device,
        error: null,
        daemonCommands: null,
        daemonCommandsLoading: true,
        daemonCommandsError: null,
        daemonCopy: null,
        daemonCopyError: null,
      },
    });
    void this.loadDaemonCommands(device.envId);
  }

  private async loadDaemonCommands(envId: string): Promise<void> {
    const connection = this.current.connection;
    if (connection?.phase !== 'connected' || connection.envId !== envId) return;
    const generation = this.connectionGeneration;
    const signal = this.connectionRequest?.signal ?? this.lifetime.signal;
    this.patch({
      connection: {
        ...connection,
        daemonCommandsLoading: true,
        daemonCommandsError: null,
        daemonCopyError: null,
      },
    });
    try {
      const commands = await this.client.getEnvironmentDaemonCommands(
        { envId },
        { signal, timeoutMs: 10_000 },
      );
      if (!commands.startCommand || !commands.statusCommand || !commands.stopCommand)
        throw new Error('服务端未返回完整的 Daemon 管理命令。');
      const current = this.current.connection;
      if (
        generation === this.connectionGeneration &&
        current?.phase === 'connected' &&
        current.envId === envId
      )
        this.patch({
          connection: { ...current, daemonCommands: commands, daemonCommandsLoading: false },
        });
    } catch (cause) {
      const current = this.current.connection;
      if (
        generation === this.connectionGeneration &&
        current?.phase === 'connected' &&
        current.envId === envId &&
        !signal.aborted
      )
        this.patch({
          connection: {
            ...current,
            daemonCommandsLoading: false,
            daemonCommandsError: message(cause),
          },
        });
    }
  }

  async retryDaemonCommands(): Promise<void> {
    const connection = this.current.connection;
    if (connection?.phase === 'connected' && connection.envId)
      await this.loadDaemonCommands(connection.envId);
  }

  async copyDaemonCommand(
    name: DaemonCommandName,
    write: (text: string) => Promise<void>,
  ): Promise<void> {
    const connection = this.current.connection;
    if (
      connection?.phase !== 'connected' ||
      !connection.envId ||
      !connection.daemonCommands ||
      connection.daemonCopy?.state === 'copying'
    )
      return;
    const envId = connection.envId;
    const generation = this.connectionGeneration;
    this.patch({
      connection: {
        ...connection,
        daemonCopy: { name, state: 'copying' },
        daemonCopyError: null,
      },
    });
    try {
      await write(connection.daemonCommands[name]);
      const current = this.current.connection;
      if (
        generation === this.connectionGeneration &&
        current?.phase === 'connected' &&
        current.envId === envId
      )
        this.patch({ connection: { ...current, daemonCopy: { name, state: 'copied' } } });
    } catch {
      const current = this.current.connection;
      if (
        generation === this.connectionGeneration &&
        current?.phase === 'connected' &&
        current.envId === envId
      )
        this.patch({
          connection: {
            ...current,
            daemonCopy: null,
            daemonCopyError: '复制失败，请选中命令手动复制。',
          },
        });
    }
  }

  async closeConnection(): Promise<void> {
    const connection = this.current.connection;
    ++this.connectionGeneration;
    this.connectionRequest?.abort();
    clearTimeout(this.connectionTimer);
    clearTimeout(this.countdownTimer);
    this.patch({ connection: null });
    if (connection?.envId && connection.phase !== 'connected') {
      try {
        const result = await this.client.cancelDeviceConnection(
          { clientActionId: crypto.randomUUID(), envId: connection.envId },
          { signal: this.lifetime.signal, timeoutMs: 5000 },
        );
        if (!this.lifetime.signal.aborted && result.environment) this.upsert(result.environment);
      } catch (cause) {
        if (!this.lifetime.signal.aborted)
          this.patch({
            actionError: `等待已结束，服务端未确认取消；命令将在到期后失效。${message(cause)}`,
          });
      }
    }
  }

  async retryConnection(): Promise<void> {
    const previous = this.current.connection;
    if (
      !previous ||
      previous.phase === 'connected' ||
      previous.phase === 'waiting' ||
      previous.phase === 'preparing'
    )
      return;
    if (previous.envId) {
      try {
        const result = await this.client.cancelDeviceConnection(
          { clientActionId: crypto.randomUUID(), envId: previous.envId },
          { signal: this.lifetime.signal, timeoutMs: 5000 },
        );
        if (this.current.connection !== previous || this.lifetime.signal.aborted) return;
        if (result.environment?.bindingStatus === EnvironmentBindingStatus.ACTIVE) {
          this.completeConnection(result.environment);
          return;
        }
      } catch (cause) {
        if (this.current.connection === previous)
          this.patch({ connection: { ...previous, error: message(cause) } });
        return;
      }
    }
    await this.beginConnection();
  }

  async copyCommand(write: (text: string) => Promise<void>): Promise<void> {
    const connection = this.current.connection;
    if (
      connection?.phase !== 'waiting' ||
      connection.copyState === 'copying' ||
      connection.expiresAt <= this.now()
    )
      return;
    const generation = this.connectionGeneration;
    this.patch({ connection: { ...connection, copyState: 'copying', copyError: null } });
    try {
      await write(connection.command);
      if (
        generation === this.connectionGeneration &&
        this.current.connection?.phase === 'waiting' &&
        connection.expiresAt > this.now()
      )
        this.patch({ connection: { ...this.current.connection, copyState: 'copied' } });
    } catch {
      if (generation === this.connectionGeneration && this.current.connection?.phase === 'waiting')
        this.patch({
          connection: {
            ...this.current.connection,
            copyState: 'idle',
            copyError: '复制失败，请选中命令手动复制。',
          },
        });
    }
  }

  async copyStartCommand(
    device: Environment,
    write: (text: string) => Promise<void>,
  ): Promise<void> {
    if (
      !isSelfHostedEnvironment(device) ||
      device.bindingStatus !== EnvironmentBindingStatus.ACTIVE ||
      device.connectionStatus === EnvironmentConnectionStatus.ONLINE ||
      ((this.current.wake?.phase === 'loading' || this.current.wake?.phase === 'copying') &&
        this.current.wake.envId === device.envId)
    )
      return;
    this.wakeRequest?.abort();
    const generation = ++this.wakeGeneration;
    const request = new AbortController();
    this.wakeRequest = request;
    this.patch({ wake: { envId: device.envId, phase: 'loading', error: null } });
    let copying = false;
    try {
      const commands = await this.client.getEnvironmentDaemonCommands(
        { envId: device.envId },
        { signal: request.signal, timeoutMs: 10_000 },
      );
      if (generation !== this.wakeGeneration) return;
      if (!commands.startCommand) throw new Error('服务端未返回 Daemon 启动命令。');
      copying = true;
      this.patch({ wake: { envId: device.envId, phase: 'copying', error: null } });
      await write(commands.startCommand);
      if (generation === this.wakeGeneration)
        this.patch({ wake: { envId: device.envId, phase: 'copied', error: null } });
    } catch (cause) {
      if (generation === this.wakeGeneration && !request.signal.aborted)
        this.patch({
          wake: {
            envId: device.envId,
            phase: 'error',
            error: copying ? '复制启动命令失败，请重试。' : message(cause),
          },
        });
    }
  }

  async openDirectory(device: Environment): Promise<void> {
    this.patch({
      actionError: null,
      directory: {
        envId: device.envId,
        browsePath: device.recommendedPwd,
        path: device.recommendedPwd,
        entries: [],
        loading: false,
        hasMore: false,
        nextOffset: 0,
        error: null,
      },
    });
    await this.browseDirectory(device.recommendedPwd);
  }

  selectDirectory(path: string): void {
    ++this.directorySelectionGeneration;
    if (this.current.directory) this.patch({ directory: { ...this.current.directory, path } });
  }
  closeDirectory(): void {
    ++this.directoryGeneration;
    this.directoryRequest?.abort();
    this.patch({ directory: null });
  }

  async browseDirectory(path: string, append = false): Promise<void> {
    const directory = this.current.directory;
    if (!directory) return;
    const device = this.current.devices.find((value) => value.envId === directory.envId);
    let normalized: string;
    try {
      normalized = normalizeDevicePath(path);
    } catch (cause) {
      this.patch({ directory: { ...directory, error: message(cause) } });
      return;
    }
    if (device?.connectionStatus !== EnvironmentConnectionStatus.ONLINE) {
      this.patch({
        directory: {
          ...directory,
          path: normalized,
          browsePath: normalized,
          entries: [],
          hasMore: false,
          loading: false,
          error: '设备离线，暂时无法浏览目录。可输入并保存目录，连接后再校验可用性。',
        },
      });
      return;
    }
    const generation = ++this.directoryGeneration;
    const selectionGeneration = ++this.directorySelectionGeneration;
    this.directoryRequest?.abort();
    const request = new AbortController();
    this.directoryRequest = request;
    this.patch({
      directory: {
        ...directory,
        loading: true,
        error: null,
        ...(!append
          ? { path: normalized, browsePath: normalized, entries: [], hasMore: false }
          : {}),
      },
    });
    try {
      const result = await this.client.listEnvironmentDirectories(
        {
          envId: directory.envId,
          path: normalized,
          offset: append ? directory.nextOffset : 0,
          limit: 200,
        },
        { signal: request.signal, timeoutMs: 12_000 },
      );
      if (generation !== this.directoryGeneration || !this.current.directory) return;
      if (
        result.hasMore &&
        (result.nextOffset === undefined ||
          result.nextOffset <= (append ? directory.nextOffset : 0))
      )
        throw new Error('目录分页位置无效。');
      this.patch({
        directory: {
          ...this.current.directory,
          path:
            !append && selectionGeneration === this.directorySelectionGeneration
              ? result.path
              : this.current.directory.path,
          browsePath: result.path,
          entries: append ? [...directory.entries, ...result.entries] : result.entries,
          loading: false,
          hasMore: result.hasMore,
          nextOffset: result.nextOffset ?? 0,
        },
      });
    } catch (cause) {
      if (
        generation === this.directoryGeneration &&
        this.current.directory &&
        !request.signal.aborted
      )
        this.patch({
          directory: { ...this.current.directory, loading: false, error: message(cause) },
        });
    }
  }

  async saveDirectory(): Promise<boolean> {
    const directory = this.current.directory;
    const device = this.current.devices.find((value) => value.envId === directory?.envId);
    if (!directory || !device) return false;
    return this.mutation(`directory:${device.envId}`, async (signal) => {
      const path = normalizeDevicePath(directory.path);
      const result = await this.client.updateEnvironment(
        {
          clientActionId: this.mutationId(`directory:${device.envId}`, {
            path,
            version: device.settingsVersion.toString(),
          }),
          envId: device.envId,
          expectedSettingsVersion: device.settingsVersion,
          recommendedPwd: path,
        },
        { signal, timeoutMs: 12_000 },
      );
      if (signal.aborted) return;
      if (!result.environment) throw new Error('服务端未返回设备设置。');
      this.upsert(result.environment);
      this.closeDirectory();
    });
  }

  async toggleFavorite(): Promise<boolean> {
    const directory = this.current.directory;
    const device = this.current.devices.find((value) => value.envId === directory?.envId);
    if (!directory || !device) return false;
    return this.mutation(`favorite:${device.envId}`, async (signal) => {
      const path = normalizeDevicePath(directory.path);
      const enabled = !device.favoriteDirectories.includes(path);
      const result = await this.client.setFavoriteDirectory(
        {
          clientActionId: this.mutationId(`favorite:${device.envId}`, { path, enabled }),
          envId: device.envId,
          path,
          enabled,
        },
        { signal, timeoutMs: 10_000 },
      );
      if (signal.aborted) return;
      if (!result.environment) throw new Error('服务端未返回常用目录。');
      this.upsert(result.environment);
    });
  }

  clearActionError(): void {
    this.patch({ actionError: null });
  }
}
