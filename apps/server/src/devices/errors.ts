import { DeviceErrorAction, type DeviceErrorCode } from '@kairos/contracts/device';

export class DeviceFailure extends Error {
  constructor(
    readonly code: DeviceErrorCode,
    message: string,
    readonly action: DeviceErrorAction = DeviceErrorAction.ABORT,
    readonly operationId?: string,
  ) {
    super(message);
    this.name = 'DeviceFailure';
  }
}
