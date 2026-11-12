import { Code, ConnectError, createRouterTransport, type ServiceImpl } from '@connectrpc/connect';
import {
  create,
  type Environment,
  EnvironmentBindingStatus,
  EnvironmentConnectionStatus,
  EnvironmentKind,
  EnvironmentSchema,
  EnvironmentService,
} from '@kairos/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKairosClients } from './client.js';
import { ConnectedDevices } from './connected-devices.js';

const controllers: ConnectedDevices[] = [];
const device = () =>
  create(EnvironmentSchema, {
    envId: 'env-1',
    kind: EnvironmentKind.SELF_HOSTED_LINUX,
    name: '工作设备',
    recommendedPwd: '/work',
    bindingStatus: EnvironmentBindingStatus.ACTIVE,
    connectionStatus: EnvironmentConnectionStatus.ONLINE,
    settingsVersion: 0n,
    createdAt: { seconds: 1n, nanos: 0 },
  });
const pending = (envId = 'pending') =>
  create(EnvironmentSchema, { envId, bindingStatus: EnvironmentBindingStatus.PAIRING });
const daemonCommands = (envId: string) => ({
  startCommand: `~/.local/bin/kairos-daemon start ${envId}`,
  statusCommand: `~/.local/bin/kairos-daemon status ${envId}`,
  stopCommand: `~/.local/bin/kairos-daemon stop ${envId}`,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  methods: Partial<ServiceImpl<typeof EnvironmentService>> = {},
  now: () => number = Date.now,
) {
  let begins = 0;
  let current = device();
  const updates: Array<{
    envId: string;
    name?: string;
    recommendedPwd?: string;
    expectedSettingsVersion: bigint;
    clientActionId: string;
  }> = [];
  const transport = createRouterTransport((router) =>
    router.service(EnvironmentService, {
      listEnvironments: () => ({ environments: [current] }),
      beginDeviceConnection: () => ({
        environment: pending(`pending-${++begins}`),
        installCommand: `command-${begins}`,
        expiresAt: { seconds: BigInt(Math.floor((now() + 600_000) / 1000)), nanos: 0 },
      }),
      getEnvironment: (request) => ({ environment: pending(request.envId) }),
      getEnvironmentDaemonCommands: (request) => daemonCommands(request.envId),
      cancelDeviceConnection: (request) => ({
        environment: create(EnvironmentSchema, {
          envId: request.envId,
          bindingStatus: EnvironmentBindingStatus.REVOKED,
        }),
      }),
      listEnvironmentDirectories: (request) => ({
        path: request.path,
        entries: [{ name: 'project', path: `${request.path}/project` }],
        hasMore: false,
      }),
      updateEnvironment: (request) => {
        updates.push({
          envId: request.envId,
          expectedSettingsVersion: request.expectedSettingsVersion,
          clientActionId: request.clientActionId,
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.recommendedPwd === undefined
            ? {}
            : { recommendedPwd: request.recommendedPwd }),
        });
        current = create(EnvironmentSchema, {
          ...current,
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.recommendedPwd === undefined
            ? {}
            : { recommendedPwd: request.recommendedPwd }),
          settingsVersion: current.settingsVersion + 1n,
        });
        return { environment: current };
      },
      setFavoriteDirectory: (request) => {
        current = create(EnvironmentSchema, {
          ...current,
          favoriteDirectories: request.enabled ? [request.path] : [],
        });
        return { environment: current };
      },
      revokeEnvironment: () => ({}),
      ...methods,
    }),
  );
  const controller = new ConnectedDevices(createKairosClients({ transport }).environments, now);
  controllers.push(controller);
  return { controller, updates, begins: () => begins };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.useRealTimers();
});

describe('connected devices GUI state', () => {
  it('keeps non-device environments out of device management and local startup commands', async () => {
    const commands = vi.fn((request) => daemonCommands(request.envId));
    const pending = create(EnvironmentSchema, {
      envId: 'pending-main',
      name: '待识别环境',
      kind: EnvironmentKind.UNSPECIFIED,
      bindingStatus: EnvironmentBindingStatus.ACTIVE,
    });
    const { controller } = fixture({
      listEnvironments: () => ({ environments: [pending, device()], mainEnvId: pending.envId }),
      getEnvironmentDaemonCommands: commands,
    });
    await controller.reload();
    expect(controller.state.devices.map((environment) => environment.envId)).toEqual(['env-1']);
    await controller.copyStartCommand(pending, async () => {});
    expect(commands).not.toHaveBeenCalled();
  });
  it('does not create a second polling loop when React restarts the controller effect', async () => {
    vi.useFakeTimers();
    const list = vi.fn(() => ({ environments: [device()] }));
    const { controller } = fixture({ listEnvironments: list });
    controller.start();
    controller.stop();
    controller.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(list).toHaveBeenCalledTimes(3);
    controller.stop();
    await vi.advanceTimersByTimeAsync(6000);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('does not overwrite saved metadata with an older list response', async () => {
    let reads = 0;
    const oldList = deferred<{ environments: Environment[] }>();
    const { controller } = fixture({
      listEnvironments: () => (++reads === 1 ? { environments: [device()] } : oldList.promise),
    });
    await controller.reload();
    const oldRequest = controller.reload();
    expect(await controller.rename(device(), '已保存的新名称')).toBe(true);
    oldList.resolve({ environments: [device()] });
    await oldRequest;
    expect(controller.state.devices[0]?.name).toBe('已保存的新名称');
  });
  it('reuses the same action ID when retrying an unknown settings result', async () => {
    const ids: string[] = [];
    const { controller } = fixture({
      updateEnvironment: (request) => {
        ids.push(request.clientActionId);
        if (ids.length === 1) throw new ConnectError('lost response', Code.Unavailable);
        return {
          environment: create(EnvironmentSchema, {
            ...device(),
            name: request.name ?? '',
            settingsVersion: 1n,
          }),
        };
      },
    });
    await controller.reload();
    expect(await controller.rename(device(), '新名称')).toBe(false);
    expect(await controller.rename(device(), '新名称')).toBe(true);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
  it('shows in-button copy feedback and expires against the server deadline', async () => {
    vi.useFakeTimers();
    let now = 0;
    const { controller } = fixture({}, () => now);
    await controller.beginConnection();
    expect(controller.state.connection).toMatchObject({
      phase: 'waiting',
      remainingSeconds: 600,
      device: null,
    });
    const copy = vi.fn(async () => {});
    await controller.copyCommand(copy);
    expect(copy).toHaveBeenCalledWith('command-1');
    expect(controller.state.connection?.copyState).toBe('copied');
    await controller.copyCommand(async () => {
      throw new Error('clipboard denied');
    });
    expect(controller.state.connection).toMatchObject({
      copyState: 'idle',
      copyError: expect.stringContaining('手动复制'),
    });
    now = 599_999;
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.state.connection).toMatchObject({ phase: 'waiting', remainingSeconds: 1 });
    now = 600_000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.state.connection?.phase).toBe('expired');
    await controller.copyCommand(copy);
    expect(copy).toHaveBeenCalledTimes(1);
  });

  it('loads the command guide after pairing and copies start, status and stop with feedback', async () => {
    const connected = device();
    const expectedCommands = daemonCommands(connected.envId);
    const getCommands = vi.fn((request: { envId: string }) => daemonCommands(request.envId));
    const { controller } = fixture({
      getEnvironment: () => ({ environment: connected }),
      getEnvironmentDaemonCommands: getCommands,
    });
    await controller.beginConnection();
    await vi.waitFor(() => {
      expect(controller.state.connection?.daemonCommands).toMatchObject(expectedCommands);
    });
    expect(controller.state.connection).toMatchObject({
      phase: 'connected',
      device: { envId: connected.envId },
      daemonCommandsLoading: false,
      daemonCommandsError: null,
    });
    expect(getCommands.mock.calls[0]?.[0]).toMatchObject({ envId: connected.envId });

    const copy = vi.fn(async () => {});
    for (const name of ['startCommand', 'statusCommand', 'stopCommand'] as const) {
      await controller.copyDaemonCommand(name, copy);
      expect(copy).toHaveBeenLastCalledWith(expectedCommands[name]);
      expect(controller.state.connection?.daemonCopy).toEqual({ name, state: 'copied' });
    }
    await controller.copyDaemonCommand('startCommand', async () => {
      throw new Error('clipboard denied');
    });
    expect(controller.state.connection).toMatchObject({
      daemonCopy: null,
      daemonCopyError: expect.stringContaining('手动复制'),
    });
  });

  it('keeps the active binding when command loading fails and supports retry', async () => {
    const connected = device();
    let available = false;
    const { controller } = fixture({
      getEnvironment: () => ({ environment: connected }),
      getEnvironmentDaemonCommands: (request) => {
        if (!available) throw new ConnectError('temporarily unavailable', Code.Unavailable);
        return daemonCommands(request.envId);
      },
    });
    await controller.beginConnection();
    await vi.waitFor(() => {
      expect(controller.state.connection?.daemonCommandsError).toBeTruthy();
    });
    expect(controller.state.connection?.phase).toBe('connected');
    expect(controller.state.devices[0]?.envId).toBe(connected.envId);
    available = true;
    await controller.retryDaemonCommands();
    expect(controller.state.connection?.daemonCommands).toMatchObject(
      daemonCommands(connected.envId),
    );
    expect(controller.state.connection?.daemonCommandsError).toBeNull();
  });

  it('copies only start for an offline device and preserves online polling updates', async () => {
    const offline = create(EnvironmentSchema, {
      ...device(),
      connectionStatus: EnvironmentConnectionStatus.OFFLINE,
    });
    let current = offline;
    const { controller } = fixture({
      listEnvironments: () => ({ environments: [current] }),
    });
    await controller.reload();
    const copy = vi.fn(async () => {});
    await controller.copyStartCommand(offline, copy);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith(daemonCommands(offline.envId).startCommand);
    expect(controller.state.wake).toMatchObject({ envId: offline.envId, phase: 'copied' });

    await controller.copyStartCommand(offline, async () => {
      throw new Error('clipboard denied');
    });
    expect(controller.state.wake).toMatchObject({
      phase: 'error',
      error: expect.stringContaining('复制启动命令失败'),
    });

    current = create(EnvironmentSchema, {
      ...offline,
      connectionStatus: EnvironmentConnectionStatus.ONLINE,
    });
    await controller.reload();
    expect(controller.state.devices[0]?.connectionStatus).toBe(EnvironmentConnectionStatus.ONLINE);
    await controller.copyStartCommand(current, copy);
    expect(copy).toHaveBeenCalledTimes(1);
  });

  it('keeps test and prod offline commands on their own environments', async () => {
    const testDevice = create(EnvironmentSchema, {
      ...device(),
      envId: 'env-test',
      connectionStatus: EnvironmentConnectionStatus.OFFLINE,
    });
    const prodDevice = create(EnvironmentSchema, {
      ...device(),
      envId: 'env-prod',
      connectionStatus: EnvironmentConnectionStatus.OFFLINE,
    });
    const { controller } = fixture({
      listEnvironments: () => ({
        environments: [prodDevice, testDevice],
      }),
    });
    await controller.reload();
    const copy = vi.fn(async (_text: string) => {});
    await controller.copyStartCommand(testDevice, copy);
    await controller.copyStartCommand(prodDevice, copy);
    expect(copy.mock.calls.map(([text]) => text)).toEqual([
      '~/.local/bin/kairos-daemon start env-test',
      '~/.local/bin/kairos-daemon start env-prod',
    ]);
    expect(controller.state.wake).toMatchObject({ envId: prodDevice.envId, phase: 'copied' });
  });

  it('ignores delayed clipboard results after closing and reopening a connection', async () => {
    const { controller } = fixture();
    await controller.beginConnection();
    const copied = deferred<void>();
    const firstCopy = controller.copyCommand(() => copied.promise);
    await controller.closeConnection();
    await controller.beginConnection();
    copied.resolve();
    await firstCopy;
    expect(controller.state.connection).toMatchObject({
      phase: 'waiting',
      command: 'command-2',
      copyState: 'idle',
    });
  });

  it('starts a fresh pairing flow after revoking the active device', async () => {
    const connected = device();
    const { controller, begins } = fixture({
      revokeEnvironment: () => ({
        environment: create(EnvironmentSchema, {
          ...connected,
          bindingStatus: EnvironmentBindingStatus.REVOKED,
        }),
      }),
    });
    await controller.reload();
    expect(await controller.revoke(connected)).toBe(true);
    expect(controller.state.devices).toHaveLength(0);
    await controller.beginConnection();
    expect(begins()).toBe(1);
    expect(controller.state.connection).toMatchObject({
      phase: 'waiting',
      envId: 'pending-1',
      command: 'command-1',
      device: null,
    });
  });

  it('keeps a device that paired while cancellation or retry was being resolved', async () => {
    vi.useFakeTimers();
    let now = 0;
    const connected = device();
    const { controller, begins } = fixture(
      { cancelDeviceConnection: () => ({ environment: connected }) },
      () => now,
    );
    await controller.beginConnection();
    now = 600_000;
    await vi.advanceTimersByTimeAsync(1000);
    await controller.retryConnection();
    expect(begins()).toBe(1);
    expect(controller.state.connection).toMatchObject({
      phase: 'connected',
      device: { envId: connected.envId },
    });
    expect(controller.state.devices[0]?.envId).toBe(connected.envId);
  });

  it('does not replace current directories with an older request or a later path edit', async () => {
    const slow = deferred<{ path: string; entries: []; hasMore: boolean }>();
    const typed = deferred<{ path: string; entries: []; hasMore: boolean }>();
    const { controller } = fixture({
      listEnvironmentDirectories: (request) =>
        request.path === '/slow'
          ? slow.promise
          : request.path === '/typed-request'
            ? typed.promise
            : { path: request.path, entries: [], hasMore: false },
    });
    await controller.reload();
    await controller.openDirectory(device());
    const old = controller.browseDirectory('/slow');
    await controller.browseDirectory('/fast');
    slow.resolve({ path: '/slow', entries: [], hasMore: false });
    await old;
    expect(controller.state.directory?.browsePath).toBe('/fast');
    const loading = controller.browseDirectory('/typed-request');
    controller.selectDirectory('/user-edited');
    typed.resolve({ path: '/canonical-directory', entries: [], hasMore: false });
    await loading;
    expect(controller.state.directory).toMatchObject({
      browsePath: '/canonical-directory',
      path: '/user-edited',
    });
  });

  it('saves favorites independently and commits only the directory in the input', async () => {
    const { controller, updates } = fixture();
    await controller.reload();
    await controller.openDirectory(device());
    controller.selectDirectory('/work/project');
    expect(controller.state.directory?.browsePath).toBe('/work');
    await controller.toggleFavorite();
    controller.closeDirectory();
    expect(controller.state.devices[0]?.favoriteDirectories).toEqual(['/work/project']);
    expect(controller.state.devices[0]?.recommendedPwd).toBe('/work');
    expect(updates).toHaveLength(0);
    await controller.openDirectory(controller.state.devices[0] ?? device());
    controller.selectDirectory('/work/project');
    expect(await controller.saveDirectory()).toBe(true);
    expect(updates[0]).toMatchObject({
      recommendedPwd: '/work/project',
      expectedSettingsVersion: 0n,
    });
    expect(controller.state.directory).toBeNull();
  });

  it('preserves unsaved directory state after a version conflict', async () => {
    const { controller } = fixture({
      updateEnvironment: () => {
        throw new ConnectError('Changed', Code.Aborted);
      },
    });
    await controller.reload();
    await controller.openDirectory(device());
    controller.selectDirectory('/new-path');
    expect(await controller.saveDirectory()).toBe(false);
    expect(controller.state.directory?.path).toBe('/new-path');
    expect(controller.state.devices[0]?.recommendedPwd).toBe('/work');
    expect(controller.state.actionError).toBeTruthy();
  });

  it('does not apply old account responses after the controller stops', async () => {
    const response = deferred<{ environments: Environment[] }>();
    const { controller } = fixture({ listEnvironments: () => response.promise });
    const request = controller.reload();
    controller.stop();
    response.resolve({ environments: [device()] });
    await request;
    expect(controller.state.devices).toEqual([]);
  });

  it('allows offline path configuration without pretending to browse the device', async () => {
    const offline = create(EnvironmentSchema, {
      ...device(),
      connectionStatus: EnvironmentConnectionStatus.OFFLINE,
    });
    const list = vi.fn(() => ({ path: '/work', entries: [], hasMore: false }));
    const { controller, updates } = fixture({
      listEnvironments: () => ({ environments: [offline] }),
      listEnvironmentDirectories: list,
    });
    await controller.reload();
    await controller.openDirectory(offline);
    expect(list).not.toHaveBeenCalled();
    expect(controller.state.directory?.error).toContain('设备离线');
    controller.selectDirectory('/offline-config');
    await controller.saveDirectory();
    expect(updates[0]?.recommendedPwd).toBe('/offline-config');
  });
});
