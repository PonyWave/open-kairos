import { DeviceErrorAction, DeviceErrorCode } from '@kairos/contracts/device';
import { DeviceFailure } from './errors.js';

export interface EnvironmentConnectionPresence {
  instanceId: string;
  open: boolean;
  lastSeen: number;
}

export function arbitrateEnvironmentConnection(
  previous: EnvironmentConnectionPresence | undefined,
  instanceId: string,
  now: number,
  offlineAfterMilliseconds: number,
): void {
  if (previous === undefined || previous.instanceId === instanceId) return;
  const online = previous.open && now - previous.lastSeen <= offlineAfterMilliseconds;
  if (online) {
    throw new DeviceFailure(
      DeviceErrorCode.IDENTITY_CONFLICT,
      'Another live Daemon instance already uses this environment binding.',
      DeviceErrorAction.REAUTHENTICATE,
    );
  }
}
