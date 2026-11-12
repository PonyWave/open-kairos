import { join } from 'node:path';
import { createServer } from './app.js';
import { readServerConfig } from './config.js';
import { readPlatformConfiguration } from './config-platform.js';
import { openDatabase } from './storage/database.js';

const config = readServerConfig();
if (!config.auth.secret) {
  throw new Error('KAIROS_AUTH_SECRET must contain at least 32 characters.');
}
const database = openDatabase(join(config.dataDirectory, 'kairos.sqlite'));
const server = createServer(database, true, {
  identity: {
    secret: config.auth.secret,
    invitedEmails: config.auth.invitedEmails,
    testAccountEnabled: config.auth.testAccountEnabled,
    allowedOrigin: config.auth.allowedOrigin,
    secureCookies: config.auth.secureCookies,
    ...(config.auth.smtp ? { smtp: config.auth.smtp } : {}),
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
  ...(config.sandboxConfigFile
    ? { platform: readPlatformConfiguration(config.sandboxConfigFile) }
    : {}),
  ...(config.standaloneDevice ? { standaloneDevice: config.standaloneDevice } : {}),
  maxRpcBytes: config.maxRpcBytes,
  maxEventQueue: config.maxEventQueue,
  maxActiveThreads: config.maxActiveThreads,
  maxConcurrentModelRequests: config.maxConcurrentModelRequests,
  maxStepsPerRun: config.maxStepsPerRun,
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
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
  await server.listen({ host: config.host, port: config.port });
} catch (error) {
  server.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
