import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify';
import type { FastifyServerOptions } from 'fastify';
import Fastify from 'fastify';
import type { GuiAuthentication } from './api/auth.js';
import { registerGuiRoutes } from './api/connect.js';
import { registerGuiStatic } from './api/gui-static.js';
import { registerHealthRoute } from './api/health.js';
import { BashLogReader } from './api/logs.js';
import { AuthService } from './auth/service.js';
import { AuthStore } from './auth/store.js';
import { AutomationService } from './automation/service.js';
import {
  type ModelConfigurationStatus,
  readPeriodicRecapConfig,
  readServerConfig,
} from './config.js';
import { DeviceChannel } from './devices/channel.js';
import { DeviceInstaller } from './devices/device-installer.js';
import { EnvironmentDirectories } from './devices/environment-directories.js';
import { EnvironmentOperationStore } from './devices/environment-operation-store.js';
import { EnvironmentStore, type EnvironmentStoreOptions } from './devices/environment-store.js';
import type { EnvironmentUseGateway } from './devices/environment-use.js';
import {
  isMainEnvironmentReady,
  type MainEnvironmentConfiguration,
  MainEnvironmentUseGateway,
} from './devices/main-environment.js';
import { registerDeviceWebSocket } from './devices/websocket.js';
import { McpManager } from './mcp/manager.js';
import {
  ensureMemoryDreamAutomation,
  type MemoryConfiguration,
  MemoryWiki,
} from './memory/index.js';
import type { SqlRecallLimits } from './recall/index.js';
import type { PeriodicRecapConfiguration } from './recap/periodic.js';
import type { EnvironmentOperationGateway } from './sessions/environment-runtime.js';
import { RunCoordinator, type RuntimeModelConfiguration } from './sessions/runtime.js';
import { SessionStore } from './sessions/store.js';
import { SettingsStore } from './settings/store.js';
import type { WebToolOptions } from './tools/web.js';

export interface IdentityServerOptions {
  secret: string;
  allowedOrigin: string | null;
  secureCookies: boolean;
  authDisabled?: boolean;
}

export interface ServerOptions {
  deviceReleaseDirectory?: string;
  identity?: IdentityServerOptions;
  tenantId?: string;
  memory?: MemoryConfiguration | false;
  memoryDreamEnabled?: boolean;
  environment?: EnvironmentStoreOptions;
  environmentOperations?: EnvironmentOperationGateway;
  environmentUse?: EnvironmentUseGateway;
  mainEnvironment?: MainEnvironmentConfiguration;
  deviceChannel?: DeviceChannel;
  model?: RuntimeModelConfiguration;
  modelSettings?: { allowedOrigins?: readonly string[]; fetch?: typeof globalThis.fetch };
  modelStatus?: ModelConfigurationStatus;
  now?: () => Date;
  maxRpcBytes?: number;
  maxEventQueue?: number;
  maxActiveThreads?: number;
  maxConcurrentModelRequests?: number;
  maxStepsPerRun?: number;
  periodicRecap?: PeriodicRecapConfiguration;
  sqlRecall?: SqlRecallLimits;
  web?: WebToolOptions;
  maxQueuedInputs?: number;
  eventRetentionMs?: number;
}

const unavailableModel: ModelConfigurationStatus = {
  providerId: '',
  modelId: '',
  contextCapacity: 1,
  outputReserve: 1,
  available: false,
  configurationErrors: [
    { code: 'model_not_configured', message: 'Model provider is not configured.' },
  ],
};

export function createServer(
  database: DatabaseSync,
  logger: FastifyServerOptions['logger'] = false,
  options: ServerOptions = {},
) {
  const identity = options.identity;
  if (!identity) throw new Error('Server identity authentication must be configured.');
  const maxRpcBytes = options.maxRpcBytes ?? 1024 * 1024;
  const mainEnvironment = options.mainEnvironment ?? {
    envId: 'main',
    workspace: '/workspace',
  };
  const serverConfig = readServerConfig();
  const server = Fastify({
    logger,
    bodyLimit: maxRpcBytes,
    trustProxy: serverConfig.trustedProxies.length > 0 ? serverConfig.trustedProxies : false,
  });
  const store = new SessionStore(database, {
    ...(options.now ? { clock: options.now } : {}),
    maxRpcBytes,
    maxMessageBytes: Math.max(1, Math.floor(maxRpcBytes / 2)),
    ...(options.maxQueuedInputs ? { maxQueuedInputs: options.maxQueuedInputs } : {}),
    ...(options.eventRetentionMs ? { eventRetentionMs: options.eventRetentionMs } : {}),
    mainEnvironment,
  });
  const environments = new EnvironmentStore(database, {
    ...(options.environment ?? {}),
    ...(options.now ? { now: options.now } : {}),
    mainEnvironment,
  });
  const environmentOperations = new EnvironmentOperationStore(database, options.now);
  const deviceChannel =
    options.deviceChannel ??
    new DeviceChannel({
      environments,
      environmentOperations,
      ...(options.now ? { now: options.now } : {}),
      onDeviceError: (error) => server.log.error(error),
    });
  const environmentUse =
    options.environmentUse ??
    new MainEnvironmentUseGateway(
      environments,
      options.environmentOperations ?? deviceChannel,
      mainEnvironment,
    );
  const settings = new SettingsStore(database, {
    secret: identity.secret,
    ...(options.model ? { platformModel: options.model } : {}),
    ...options.modelSettings,
    allowedOrigins: options.modelSettings?.allowedOrigins ?? serverConfig.modelAllowedOrigins,
  });
  const memory =
    options.memory === false ? undefined : new MemoryWiki(options.memory ?? serverConfig.memory);
  let coordinator: RunCoordinator;
  const automations = new AutomationService(store, {
    ...(options.now ? { clock: options.now } : {}),
    deliver: (input, runId) => coordinator.deliver(input, runId),
    onError: (error) => server.log.error(error),
  });
  const mcp =
    serverConfig.mcp.length > 0
      ? new McpManager({
          configs: serverConfig.mcp,
          channel: deviceChannel,
          resolveMainEnvId: (ownerId: string) =>
            store.agentEnvironments.mainEnvironmentIdFor(ownerId),
          credentials: store,
          publicOrigin:
            serverConfig.auth.allowedOrigin ?? `http://${serverConfig.host}:${serverConfig.port}`,
          onError: (error: unknown) => server.log.error(error),
        })
      : undefined;
  coordinator = new RunCoordinator({
    settings,
    store,
    automations,
    ...(mcp ? { mcp } : {}),
    ...(options.model ? { model: options.model } : {}),
    environments,
    environmentOperations: options.environmentOperations ?? deviceChannel,
    environmentUse: environmentUse,
    ...(options.maxActiveThreads ? { maxActiveThreads: options.maxActiveThreads } : {}),
    ...(options.maxConcurrentModelRequests
      ? { maxConcurrentModelRequests: options.maxConcurrentModelRequests }
      : {}),
    ...(options.maxStepsPerRun ? { maxStepsPerRun: options.maxStepsPerRun } : {}),
    ...(memory ? { memory } : {}),
    periodicRecap: options.periodicRecap ?? readPeriodicRecapConfig(),
    sqlRecall: options.sqlRecall ?? serverConfig.sqlRecall,
    web: options.web ?? serverConfig.web,
    ...(options.now ? { now: options.now } : {}),
    onError: (error) => server.log.error(error),
  });
  const logs = new BashLogReader({
    store,
    ...(options.now ? { now: options.now } : {}),
  });
  const authentication: GuiAuthentication = {
    authService: new AuthService(new AuthStore(database), {
      secret: identity.secret,
      createMainThread: (tenantId) => store.getOrCreateMainThread(tenantId),
      ...(options.now ? { now: options.now } : {}),
    }),
    allowedOrigin: identity.allowedOrigin,
    secureCookies: identity.secureCookies,
    ...(identity.authDisabled ? { disabled: true } : {}),
  };
  server.addHook('onRequest', async (request) => {
    request.headers['x-kairos-source-address'] = request.ip;
  });
  registerHealthRoute(server, database);
  const guiServed = registerGuiStatic(
    server,
    fileURLToPath(new URL('../../gui/dist', import.meta.url)),
  );
  if (!guiServed) {
    server.log.warn('GUI build output is missing; run pnpm build to serve the local web page.');
  }
  server.get('/mcp/oauth/callback', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const state = typeof query.state === 'string' ? query.state : '';
    const code = typeof query.code === 'string' ? query.code : '';
    const error = typeof query.error === 'string' ? query.error : '';
    const handled =
      mcp !== undefined && state.length > 0 && code.length > 0 && error.length === 0
        ? mcp.handleOAuthCallback(state, code)
        : false;
    reply.type('text/html');
    if (handled) {
      return '<!doctype html><html><head><meta charset="utf-8"><title>Authorized</title></head><body style="font-family:system-ui,sans-serif;padding:2rem;"><h1>Sign-in complete</h1><p>You can close this tab and return to the conversation.</p></body></html>';
    }
    return '<!doctype html><html><head><meta charset="utf-8"><title>OAuth error</title></head><body style="font-family:system-ui,sans-serif;padding:2rem;"><h1>Sign-in failed</h1><p>The authorization could not be matched or the provider reported an error. Return to the conversation for details.</p></body></html>';
  });
  const deviceInstaller = new DeviceInstaller(
    options.deviceReleaseDirectory ?? serverConfig.daemonReleaseDirectory,
    () =>
      identity.allowedOrigin ??
      `http://127.0.0.1:${(server.server.address() as { port: number } | null)?.port ?? serverConfig.port}`,
  );
  deviceInstaller.register(server);
  const guiRoutes = (router: Parameters<typeof registerGuiRoutes>[0]) =>
    registerGuiRoutes(router, {
      store,
      settings,
      coordinator,
      automations,
      logs,
      modelStatus:
        options.modelStatus ??
        (options.model
          ? {
              providerId: options.model.providerId,
              modelId: options.model.modelId,
              contextCapacity: options.model.contextWindowTokens,
              outputReserve: options.model.outputReserveTokens,
              available: true,
              configurationErrors: [],
            }
          : unavailableModel),
      authentication,
      deviceChannel,
      environments,
      environmentDirectories: new EnvironmentDirectories(
        environments,
        deviceChannel,
        options.now,
        (error) => server.log.error(error),
      ),
      deviceInstaller,
      ...(options.maxEventQueue ? { maxEventQueue: options.maxEventQueue } : {}),
      maxEventBytes: maxRpcBytes,
      mainEnvironment,
      isMainEnvironmentReady: (tenantId) =>
        isMainEnvironmentReady(environments, tenantId, mainEnvironment),
    });
  const connectOptions = {
    shutdownTimeoutMs: 5000,
    readMaxBytes: maxRpcBytes,
    writeMaxBytes: maxRpcBytes,
    requireConnectProtocolHeader: true,
  };
  void server.register(fastifyConnectPlugin, { routes: guiRoutes, ...connectOptions });
  void server.register(fastifyConnectPlugin, {
    prefix: '/api',
    routes: guiRoutes,
    ...connectOptions,
  });
  registerDeviceWebSocket(server, deviceChannel);
  const startup = Promise.resolve().then(() => {
    store.recoverInterrupted();
    coordinator.recoverManualCompactions();
    coordinator.recoverBackgroundTasks();
    coordinator.resumePeriodicRecaps();
    coordinator.resumeDeliveries();
    if (options.tenantId && memory) {
      ensureMemoryDreamAutomation(store, automations, {
        ownerId: options.tenantId,
        enabled: options.memoryDreamEnabled ?? serverConfig.memoryDreamEnabled,
        directory: memory.directory,
        indexMaxBytes: memory.indexMaxBytes,
      });
    }
    automations.start();
  });
  server.addHook('onReady', () => startup);
  let closing = false;
  server.addHook('onResponse', (_request, _reply, done) => {
    if (closing) server.server.closeIdleConnections();
    done();
  });
  server.addHook('preClose', async () => {
    closing = true;
    await automations.close();
    await coordinator.close();
    if (mcp) await mcp.close();
    server.server.closeIdleConnections();
  });
  server.addHook('onClose', async () => {
    database.close();
  });
  return server;
}
