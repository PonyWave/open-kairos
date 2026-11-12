import { Code } from '@connectrpc/connect';
import { ErrorCode, ErrorDetailSchema } from '@kairos/contracts';
import { DeviceErrorCode } from '@kairos/contracts/device';
import { expect, it } from 'vitest';
import { HardCutError } from '../context/model-input-service.js';
import { DeviceFailure } from '../devices/errors.js';
import { SessionError } from '../sessions/errors.js';
import { asConnectError } from './errors.js';

it.each([
  [DeviceErrorCode.ENVIRONMENT_OFFLINE, Code.Unavailable, ErrorCode.DEVICE_OFFLINE, true],
  [DeviceErrorCode.ENVIRONMENT_REVOKED, Code.PermissionDenied, ErrorCode.PERMISSION_DENIED, false],
  [DeviceErrorCode.IDENTITY_CONFLICT, Code.Aborted, ErrorCode.VERSION_CONFLICT, false],
  [DeviceErrorCode.BINDING_CONFLICT, Code.Aborted, ErrorCode.VERSION_CONFLICT, false],
  [DeviceErrorCode.FILE_VERSION_CONFLICT, Code.Aborted, ErrorCode.VERSION_CONFLICT, false],
  [
    DeviceErrorCode.CAPABILITY_UNAVAILABLE,
    Code.FailedPrecondition,
    ErrorCode.FAILED_PRECONDITION,
    false,
  ],
  [
    DeviceErrorCode.DIRECTORY_INVALID,
    Code.FailedPrecondition,
    ErrorCode.FAILED_PRECONDITION,
    false,
  ],
  [DeviceErrorCode.PATH_INVALID, Code.InvalidArgument, ErrorCode.INVALID_ARGUMENT, false],
  [DeviceErrorCode.FILE_TOO_LARGE, Code.ResourceExhausted, ErrorCode.INPUT_TOO_LARGE, false],
] as const)(
  'maps environment failure %s to its actionable Connect error',
  (source, code, detailCode, retryable) => {
    const error = asConnectError(
      new DeviceFailure(source, 'Environment operation failed.'),
      'action-1',
    );
    expect(error.code).toBe(code);
    expect(error.findDetails(ErrorDetailSchema)).toEqual([
      expect.objectContaining({ code: detailCode, retryable, clientActionId: 'action-1' }),
    ]);
  },
);

it('maps model request conflicts to an action conflict with the original action ID', () => {
  const error = asConnectError(
    new HardCutError('request_conflict', 'Request parameters changed.'),
    'action-1',
  );
  expect(error.code).toBe(Code.AlreadyExists);
  expect(error.findDetails(ErrorDetailSchema)).toEqual([
    expect.objectContaining({
      code: ErrorCode.ACTION_CONFLICT,
      clientActionId: 'action-1',
    }),
  ]);
});

it('maps storage failures without exposing internal details as success', () => {
  const error = asConnectError(new HardCutError('storage_failed', 'SQLite commit failed.'));
  expect(error.code).toBe(Code.Internal);
  expect(error.findDetails(ErrorDetailSchema)[0]?.code).toBe(ErrorCode.INTERNAL);
  expect(error.findDetails(ErrorDetailSchema)[0]?.terminal).toBeUndefined();
});

it('propagates terminal only when the SessionError explicitly marks a persisted outcome', () => {
  const terminal = asConnectError(
    new SessionError('internal', 'The accepted operation failed and was recorded.', {
      retryable: true,
      terminal: true,
    }),
    'action-terminal',
  );
  expect(terminal.findDetails(ErrorDetailSchema)).toEqual([
    expect.objectContaining({
      code: ErrorCode.INTERNAL,
      message: 'The accepted operation failed and was recorded.',
      retryable: true,
      clientActionId: 'action-terminal',
      terminal: true,
    }),
  ]);

  const unknown = asConnectError(
    new SessionError('operation_unknown', 'The operation outcome is unknown.', {
      retryable: true,
    }),
    'action-unknown',
  );
  expect(unknown.findDetails(ErrorDetailSchema)).toEqual([
    expect.objectContaining({
      code: ErrorCode.OPERATION_UNKNOWN,
      retryable: true,
      clientActionId: 'action-unknown',
    }),
  ]);
  expect(unknown.findDetails(ErrorDetailSchema)[0]?.terminal).toBeUndefined();
});
