import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OperationStatus } from '@kairos/contracts/device';
import type { EnvironmentOperationGateway } from '../sessions/environment-runtime.js';
import { SessionError } from '../sessions/errors.js';
import type { EnvironmentStore } from './environment-store.js';
import type { EnvironmentUseGateway } from './environment-use.js';

export interface WorkspaceReadinessGateway {
  ensureWorkspaceReady(input: {
    tenantId: string;
    envId: string;
    pwd: string;
    signal: AbortSignal;
  }): Promise<void>;
}

export function workspaceReadinessGateway(
  environments: EnvironmentStore,
  operations: EnvironmentOperationGateway,
  environmentUse: EnvironmentUseGateway,
): WorkspaceReadinessGateway {
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
          environmentUse.reserveUse(use);
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
                  throw new SessionError(
                    'failed_precondition',
                    'The workspace directory check failed.',
                    {
                      retryable: true,
                    },
                  );
                }
                environments.requireReady(input.tenantId, input.envId);
                environmentUse.releaseUse(use);
                return;
              }
              await delay(50, undefined, { signal: input.signal });
            }
            throw new SessionError('device_offline', 'The workspace directory check timed out.', {
              retryable: true,
            });
          } catch (error) {
            if (started) {
              try {
                await operations.cancelEnvironmentOperation({
                  tenantId: input.tenantId,
                  operationId,
                  reason: 'Workspace preparation stopped.',
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
      throw new SessionError('device_offline', 'The environment Daemon did not connect in time.', {
        retryable: true,
      });
    },
  };
}
