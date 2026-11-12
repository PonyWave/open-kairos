import type { DatabaseSync } from 'node:sqlite';
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify';
import Fastify from 'fastify';
import type { GuiAuthentication } from './api/auth.js';
import { registerGuiRoutes } from './api/connect.js';
import { registerHealthRoute } from './api/health.js';
import { BashLogReader } from './api/logs.js';
import type { EmailSender } from './auth/mailer.js';
import { SmtpEmailSender } from './auth/mailer.js';
import { AuthService, type AuthServiceOptions } from './auth/service.js';
import { AuthStore } from './auth/store.js';
import { AutomationService } from './automation/service.js';
import {
  type ModelConfigurationStatus,
  readPeriodicRecapConfig,
  readServerConfig,
} from './config.js';
import type { PlatformConfiguration } from './config-platform.js';
import { DeviceChannel } from './devices/channel.js';
import { DeviceInstaller } from './devices/device-installer.js';
import { EnvironmentDirectories } from './devices/environment-directories.js';
import { EnvironmentOperationStore } from './devices/environment-operation-store.js';
import { EnvironmentStore, type EnvironmentStoreOptions } from './devices/environment-store.js';
import { DeviceBashStore } from './devices/operation-store.js';
import {
  type StandaloneDeviceConfiguration,
  StandaloneDeviceUseGateway,
} from './devices/standalone-device.js';
import { registerDeviceWebSocket } from './devices/websocket.js';
import { OpenSandboxBackend } from './platform/backend.js';
import type { PlatformUseGateway } from './platform/contracts.js';
import { PlatformManager } from './platform/manager.js';
import { CgroupPhysicalObserver } from './platform/physical-observer.js';
import { UnavailablePlatformUseGateway } from './platform-unavailable.js';
import { platformWorkspaceGateway } from './platform-workspace.js';
import type { SqlRecallLimits } from './recall/index.js';
import type { PeriodicRecapConfiguration } from './recap/periodic.js';
import type { EnvironmentOperationGateway } from './sessions/environment-runtime.js';
import { RunCoordinator, type RuntimeModelConfiguration } from './sessions/runtime.js';
import { SessionStore } from './sessions/store.js';
import { SettingsStore } from './settings/store.js';
import type { WebToolOptions } from './tools/web.js';

export interface IdentityServerOptions {
  secret: string;
  invitedEmails: readonly string[];
  testAccountEnabled: boolean;
  allowedOrigin: string;
  secureCookies: boolean;
  smtp?: { url: string; from: string };
  mailer?: EmailSender;
  limits?: Partial<
    Pick<
      AuthServiceOptions,
      | 'verificationTtlMs'
      | 'setupTtlMs'
      | 'sessionTtlMs'
      | 'maxCodeAttempts'
      | 'resendIntervalMs'
      | 'sourceWindowMs'
      | 'sourceLimit'
      | 'globalWindowMs'
      | 'globalLimit'
    >
  >;
}

export interface ServerOptions {
  deviceReleaseDirectory?: string;
  identity?: IdentityServerOptions;
  environment?: EnvironmentStoreOptions;
  environmentOperations?: EnvironmentOperationGateway;
  platform?: PlatformConfiguration;
  platformUse?: PlatformUseGateway;
  standaloneDevice?: StandaloneDeviceConfiguration;
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

export function createServer(database: DatabaseSync, logger = false, options: ServerOptions = {}) {
  const identity = options.identity;
  if (!identity) throw new Error('Server identity authentication must be configured.');
  const maxRpcBytes = options.maxRpcBytes ?? 1024 * 1024;
  if (options.platform && options.standaloneDevice) {
    throw new Error('Platform sandbox and standalone device execution are mutually exclusive.');
  }
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
    ...(options.standaloneDevice ? { standaloneDevice: options.standaloneDevice } : {}),
  });
  const operations = new DeviceBashStore(database);
  const environments = new EnvironmentStore(database, {
    ...(options.environment ?? {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.standaloneDevice ? { standaloneDevice: options.standaloneDevice } : {}),
  });
  const environmentOperations = new EnvironmentOperationStore(database, options.now);
  let platformManager: PlatformManager | undefined;
  let platformReady = options.platformUse !== undefined;
  let platform: PlatformUseGateway =
    options.platformUse ?? new UnavailablePlatformUseGateway(environments);
  if (options.platform && !options.platformUse) {
    try {
      const configuration = options.platform;
      platformManager = new PlatformManager(database, {
        path: configuration.controlDatabasePath,
        deploymentId: configuration.deploymentId,
        cluster: configuration.cluster,
        capacity: configuration.capacity,
        sharedReleaseClaim: configuration.sharedReleaseClaim,
        backend: new OpenSandboxBackend(configuration),
        physicalObserver: new CgroupPhysicalObserver(configuration.cgroupProofFile),
        operations: {
          ensureWorkspaceReady: (input) =>
            platformWorkspaceGateway(
              environments,
              options.environmentOperations ?? deviceChannel,
              platform,
            ).ensureWorkspaceReady(input),
        },
        preparationTimeoutMs: configuration.preparationTimeoutMs,
        idleTimeoutMs: configuration.idleTimeoutMs,
        onEnvironmentChange: (environment) =>
          store.publishMainEnvironment(environment.tenantId, environment),
        onError: (error) => server.log.error(error),
      });
      platform = platformManager;
    } catch (error) {
      server.log.error(error, 'Platform configuration is unavailable.');
    }
  }
  const deviceChannel =
    options.deviceChannel ??
    new DeviceChannel({
      environments,
      environmentOperations,
      ...(platformManager ? { platform: platformManager } : {}),
      ...(options.now ? { now: options.now } : {}),
      onDeviceError: (error) => server.log.error(error),
    });
  if (!options.platformUse && options.standaloneDevice) {
    platform = new StandaloneDeviceUseGateway(
      environments,
      options.environmentOperations ?? deviceChannel,
      options.standaloneDevice,
    );
  }
  const settings = new SettingsStore(database, {
    secret: identity.secret,
    ...(options.model ? { platformModel: options.model } : {}),
    ...options.modelSettings,
    allowedOrigins: options.modelSettings?.allowedOrigins ?? serverConfig.modelAllowedOrigins,
  });
  let coordinator: RunCoordinator;
  const automations = new AutomationService(store, {
    ...(options.now ? { clock: options.now } : {}),
    deliver: (input, runId) => coordinator.deliver(input, runId),
    onError: (error) => server.log.error(error),
  });
  coordinator = new RunCoordinator({
    settings,
    store,
    automations,
    ...(options.model ? { model: options.model } : {}),
    environments,
    environmentOperations: options.environmentOperations ?? deviceChannel,
    platformUse: platform,
    ...(options.maxActiveThreads ? { maxActiveThreads: options.maxActiveThreads } : {}),
    ...(options.maxConcurrentModelRequests
      ? { maxConcurrentModelRequests: options.maxConcurrentModelRequests }
      : {}),
    ...(options.maxStepsPerRun ? { maxStepsPerRun: options.maxStepsPerRun } : {}),
    periodicRecap: options.periodicRecap ?? readPeriodicRecapConfig(),
    sqlRecall: options.sqlRecall ?? serverConfig.sqlRecall,
    web: options.web ?? serverConfig.web,
    ...(options.now ? { now: options.now } : {}),
    onError: (error) => server.log.error(error),
  });
  const logs = new BashLogReader({
    store,
    operations,
    ...(options.now ? { now: options.now } : {}),
  });
  const authentication: GuiAuthentication = {
    authService: new AuthService(new AuthStore(database), {
      secret: identity.secret,
      invitedEmails: identity.invitedEmails,
      testAccountEnabled: identity.testAccountEnabled,
      createMainThread: (tenantId) => store.getOrCreateMainThread(tenantId),
      ...(identity.mailer
        ? { mailer: identity.mailer }
        : identity.smtp
          ? { mailer: new SmtpEmailSender(identity.smtp) }
          : {}),
      ...(identity.limits ?? {}),
      ...(options.now ? { now: options.now } : {}),
    }),
    allowedOrigin: identity.allowedOrigin,
    secureCookies: identity.secureCookies,
  };
  server.addHook('onRequest', async (request) => {
    request.headers['x-kairos-source-address'] = request.ip;
  });
  registerHealthRoute(server, database);
  const deviceInstaller = new DeviceInstaller(
    options.deviceReleaseDirectory ?? serverConfig.daemonReleaseDirectory,
    identity.allowedOrigin,
  );
  deviceInstaller.register(server);
  void server.register(fastifyConnectPlugin, {
    routes: (router) =>
      registerGuiRoutes(router, {
        store,
        settings,
        coordinator,
        automations,
        operations,
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
        platformConfigured: platformManager !== undefined || options.platformUse !== undefined,
        isPlatformReady: () => platformReady,
        ...(options.standaloneDevice
          ? { standaloneDeviceEnvId: options.standaloneDevice.envId }
          : {}),
      }),
    shutdownTimeoutMs: 5000,
    readMaxBytes: maxRpcBytes,
    writeMaxBytes: maxRpcBytes,
    requireConnectProtocolHeader: true,
  });
  registerDeviceWebSocket(server, deviceChannel);
  const startup = Promise.resolve().then(() => {
    store.recoverInterrupted();
    coordinator.recoverManualCompactions();
    coordinator.resumePeriodicRecaps();
    if (!platformManager) {
      coordinator.resumeDeliveries();
      automations.start();
    }
  });
  server.addHook('onReady', () => startup);
  server.addHook('onListen', async () => {
    if (!platformManager) return;
    try {
      await platformManager.start();
      platformReady = true;
    } catch (error) {
      server.log.error(error, 'Platform recovery failed; new platform work remains unavailable.');
    }
    coordinator.resumeDeliveries();
    automations.start();
  });
  let closing = false;
  server.addHook('onResponse', (_request, _reply, done) => {
    if (closing) server.server.closeIdleConnections();
    done();
  });
  server.addHook('preClose', async () => {
    closing = true;
    await automations.close();
    await coordinator.close();
    await platformManager?.close();
    server.server.closeIdleConnections();
  });
  server.addHook('onClose', async () => {
    database.close();
  });
  return server;
}
