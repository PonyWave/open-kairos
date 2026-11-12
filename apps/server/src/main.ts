import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from './app.js';
import { AuthService } from './auth/service.js';
import { AuthStore } from './auth/store.js';
import { readServerConfig } from './config.js';
import { startEmbeddedDaemon } from './embedded-daemon.js';
import { SessionStore } from './sessions/store.js';
import { openDatabase } from './storage/database.js';

function loadOrCreateAuthSecret(dataDirectory: string): string {
  const path = join(dataDirectory, 'auth-secret');
  if (existsSync(path)) {
    const secret = readFileSync(path, 'utf8').trim();
    if (secret.length >= 32) return secret;
    throw new Error(`The stored authentication secret at ${path} is invalid.`);
  }
  const secret = randomBytes(32).toString('base64url');
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return secret;
}

const config = readServerConfig();
const database = openDatabase(join(config.dataDirectory, 'kairos.sqlite'));
const authSecret = config.auth.secret ?? loadOrCreateAuthSecret(config.dataDirectory);
const sessionStore = new SessionStore(database, { mainEnvironment: config.mainEnvironment });
const authService = new AuthService(new AuthStore(database), {
  secret: authSecret,
  createMainThread: (tenantId) => sessionStore.getOrCreateMainThread(tenantId),
});
const localIdentity = authService.ensureLocalIdentity();
const localSession = authService.createLocalSession();
const server = createServer(database, true, {
  tenantId: localIdentity.tenantId,
  identity: {
    secret: authSecret,
    allowedOrigin: config.auth.allowedOrigin,
    secureCookies: config.auth.secureCookies,
  },
  ...(config.model
    ? {
        model: {
          configurationId: config.model.configurationId,
          provider: config.model.provider,
          providerId: config.model.status.providerId,
          modelId: config.model.status.modelId,
          contextWindowTokens: config.model.status.contextCapacity,
          outputReserveTokens: config.model.status.outputReserve,
          countTokens: config.model.countTokens,
        },
      }
    : {}),
  modelStatus: config.modelStatus,
  mainEnvironment: config.mainEnvironment,
  maxRpcBytes: config.maxRpcBytes,
  maxEventQueue: config.maxEventQueue,
  maxActiveThreads: config.maxActiveThreads,
  maxConcurrentModelRequests: config.maxConcurrentModelRequests,
  maxStepsPerRun: config.maxStepsPerRun,
});

let closing = false;
const shutdownHandlers: Array<() => Promise<void>> = [];
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const handler of shutdownHandlers.splice(0).reverse()) await handler();
  await server.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().catch((error: unknown) => {
      server.log.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  const port = process.env.KAIROS_PORT === undefined ? 0 : config.port;
  await server.listen({ host: config.host, port });
  const address = server.server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : config.port;
  const embeddedDaemon = await startEmbeddedDaemon({
    database,
    tenantId: localIdentity.tenantId,
    mainEnvironment: config.mainEnvironment,
    port: actualPort,
    dataDirectory: config.dataDirectory,
    onError: (error) => server.log.error(error),
  });
  const hostForUrl = config.host.includes(':') ? `[${config.host}]` : config.host;
  console.log(
    `open-kairos 已启动：http://${hostForUrl}:${actualPort}/#token=${localSession.token}`,
  );
  shutdownHandlers.push(() => embeddedDaemon.stop());
} catch (error) {
  server.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
