import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OperationStatus } from '@kairos/contracts/device';
import type { EnvironmentStore } from './devices/environment-store.js';
import type { PlatformUseGateway } from './platform/contracts.js';
import type { PlatformWorkspaceGateway } from './platform/manager.js';
import type { EnvironmentOperationGateway } from './sessions/environment-runtime.js';
import { SessionError } from './sessions/errors.js';

export function platformWorkspaceGateway(
  environments: EnvironmentStore,
  operations: EnvironmentOperationGateway,
  platform: PlatformUseGateway,
): PlatformWorkspaceGateway {
  return {
    async ensureWorkspaceReady(input) {
      const expiresAt = new Date(Date.now() + 30_000);
      while (Date.now() < expiresAt.getTime()) {
        input.signal.throwIfAborted();
        const environment = environments.get(input.tenantId, input.envId);
        if (environment.bindingStatus === 'active' && environment.connectionStatus === 'online') {
          if (environment.ready) return;
          const operationId = randomUUID();
          const use = {
            tenantId: input.tenantId,
            envId: input.envId,
            kind: 'operation' as const,
            usageId: `operation:${operationId}`,
          };
          platform.reserveUse(use);
          let started = false;
          try {
            await operations.startEnvironmentOperation({
              operationId,
              tenantId: input.tenantId,
              envId: input.envId,
              action: { case: 'directoryCheck', value: { path: input.pwd, loadWorkspace: true } },
              expiresAt,
            });
            started = true;
            while (Date.now() < expiresAt.getTime()) {
              input.signal.throwIfAborted();
              const operation = operations.getEnvironmentOperation(input.tenantId, operationId);
              if (operation.resultStatus !== undefined) {
                if (operation.resultStatus !== OperationStatus.COMPLETED) {
                  throw new SessionError('sandbox_unavailable', '平台工作区目录检查失败。', {
                    retryable: true,
                  });
                }
                environments.requireReady(input.tenantId, input.envId);
                platform.releaseUse(use);
                return;
              }
              await delay(50, undefined, { signal: input.signal });
            }
            throw new SessionError('sandbox_unavailable', '平台工作区目录检查超时。', {
              retryable: true,
            });
          } catch (error) {
            if (started) {
              try {
                await operations.cancelEnvironmentOperation({
                  tenantId: input.tenantId,
                  operationId,
                  reason: 'Platform workspace preparation stopped.',
                });
              } catch {
                /* The durable Operation reference remains until its outcome is reconciled. */
              }
            }
            // A failed send may have persisted its intent; reconciliation owns the reference.
            throw error;
          }
        }
        await delay(100, undefined, { signal: input.signal });
      }
      throw new SessionError('sandbox_unavailable', '平台 Daemon 未在期限内连接。', {
        retryable: true,
      });
    },
  };
}
