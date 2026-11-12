import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OperationStatus } from '@kairos/contracts/device';
import { SessionError } from '../sessions/errors.js';
import type { DeviceChannel } from './channel.js';
import type {
  EnvironmentOperationAction,
  EnvironmentOperationRecord,
} from './environment-operation-store.js';
import type { EnvironmentStore } from './environment-store.js';

type Gateway = Pick<
  DeviceChannel,
  'startEnvironmentOperation' | 'getEnvironmentOperation' | 'cancelEnvironmentOperation'
>;

export class EnvironmentDirectories {
  constructor(
    private readonly environments: EnvironmentStore,
    private readonly gateway: Gateway,
    private readonly now: () => Date = () => new Date(),
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  async list(
    tenantId: string,
    envId: string,
    path: string,
    offset: number,
    limit: number,
    signal: AbortSignal,
  ) {
    const result = await this.execute(
      tenantId,
      envId,
      { case: 'directoryList', value: { path, offset, limit } },
      signal,
    );
    if (result.outcome?.case !== 'directoryList')
      throw new SessionError('internal', 'Device returned an incompatible directory result.');
    return result.outcome.value;
  }

  async check(tenantId: string, envId: string, path: string, signal: AbortSignal) {
    const result = await this.execute(
      tenantId,
      envId,
      { case: 'directoryCheck', value: { path, loadWorkspace: false } },
      signal,
    );
    if (result.outcome?.case !== 'directoryCheck')
      throw new SessionError('internal', 'Device returned an incompatible directory check.');
    return {
      normalizedPath: result.outcome.value.normalizedPath,
      deviceBindingId: result.deviceBindingId,
      instanceId: result.targetInstanceId,
    };
  }

  private async execute(
    tenantId: string,
    envId: string,
    action: EnvironmentOperationAction,
    signal: AbortSignal,
  ): Promise<EnvironmentOperationRecord> {
    const environment = this.environments.get(tenantId, envId);
    if (environment.connectionStatus !== 'online' || environment.bindingStatus !== 'active')
      throw new SessionError('device_offline', 'Device is offline.');
    const operationId = randomUUID();
    let started = false;
    let finished = false;
    try {
      signal.throwIfAborted();
      await this.gateway.startEnvironmentOperation({
        operationId,
        tenantId,
        envId,
        action,
        expiresAt: new Date(this.now().getTime() + 10_000),
      });
      started = true;
      const deadline = Date.now() + 10_000;
      while (true) {
        signal.throwIfAborted();
        const result = this.gateway.getEnvironmentOperation(tenantId, operationId);
        if (
          result.deviceBindingId !== environment.deviceBindingId ||
          result.targetInstanceId !== environment.instanceId
        )
          throw new SessionError(
            'version_conflict',
            'Device connection changed during directory access.',
          );
        const status = result.resultStatus ?? result.status;
        if (status >= OperationStatus.COMPLETED) {
          finished = true;
          const current = this.environments.get(tenantId, envId);
          if (
            current.bindingStatus !== 'active' ||
            current.instanceId !== result.targetInstanceId ||
            current.deviceBindingId !== result.deviceBindingId
          )
            throw new SessionError(
              'version_conflict',
              'Device connection changed during directory access.',
            );
          if (status !== OperationStatus.COMPLETED) {
            const reason =
              result.outcome?.case === 'directoryList' || result.outcome?.case === 'directoryCheck'
                ? result.outcome.value.reason
                : undefined;
            throw new SessionError(
              'failed_precondition',
              reason ?? 'Directory is unavailable or permission was denied.',
            );
          }
          return result;
        }
        if (Date.now() >= deadline)
          throw new SessionError('failed_precondition', 'Device directory request timed out.');
        await delay(20, undefined, { signal });
      }
    } finally {
      if (started && !finished) {
        try {
          await this.gateway.cancelEnvironmentOperation({
            tenantId,
            operationId,
            reason: 'GUI directory request ended.',
          });
        } catch (error) {
          this.onError(error);
        }
      }
    }
  }
}
