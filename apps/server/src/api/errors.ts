import { Code, ConnectError } from '@connectrpc/connect';
import { ContractValidationError, ErrorDetailSchema } from '@kairos/contracts';
import { DeviceErrorCode } from '@kairos/contracts/device';
import { HardCutError } from '../context/model-input-service.js';
import { DeviceFailure } from '../devices/errors.js';
import type { SessionErrorCode } from '../sessions/errors.js';
import { SessionError } from '../sessions/errors.js';
import { toErrorDetail } from './convert.js';

const connectCodes: Record<SessionErrorCode, Code> = {
  unauthenticated: Code.Unauthenticated,
  permission_denied: Code.PermissionDenied,
  version_conflict: Code.Aborted,
  action_conflict: Code.AlreadyExists,
  device_offline: Code.Unavailable,
  operation_unknown: Code.FailedPrecondition,
  recap_invalid: Code.FailedPrecondition,
  input_too_large: Code.ResourceExhausted,
  protocol_incompatible: Code.Unimplemented,
  invalid_argument: Code.InvalidArgument,
  not_found: Code.NotFound,
  failed_precondition: Code.FailedPrecondition,
  internal: Code.Internal,
};

export function sessionConnectError(
  code: SessionErrorCode,
  message: string,
  options: {
    retryable?: boolean;
    clientActionId?: string;
    terminal?: boolean;
    cause?: unknown;
  } = {},
): ConnectError {
  const detail = toErrorDetail(
    {
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    },
    options.clientActionId,
  );
  return new ConnectError(
    message,
    connectCodes[code],
    undefined,
    [{ desc: ErrorDetailSchema, value: detail }],
    options.cause,
  );
}

export function asConnectError(error: unknown, clientActionId?: string): ConnectError {
  if (error instanceof ConnectError) return error;
  const action = clientActionId === undefined ? {} : { clientActionId };
  if (error instanceof SessionError) {
    return sessionConnectError(error.code, error.message, {
      retryable: error.retryable,
      ...action,
      ...(error.terminal === undefined ? {} : { terminal: error.terminal }),
      cause: error,
    });
  }
  if (error instanceof ContractValidationError) {
    return sessionConnectError(
      error.code === 'INVALID_MESSAGE' ? 'invalid_argument' : 'protocol_incompatible',
      error.message,
      { ...action, cause: error },
    );
  }
  if (error instanceof HardCutError) {
    const code: SessionErrorCode =
      error.code === 'request_conflict'
        ? 'action_conflict'
        : error.code === 'storage_failed'
          ? 'internal'
          : error.code === 'cancelled'
            ? 'failed_precondition'
            : 'recap_invalid';
    return sessionConnectError(code, error.message, {
      retryable: code === 'internal' || code === 'recap_invalid',
      ...action,
      cause: error,
    });
  }
  if (error instanceof DeviceFailure) {
    const code = deviceErrorCode(error.code);
    return sessionConnectError(code, error.message, {
      retryable: code === 'device_offline' || code === 'internal',
      ...action,
      cause: error,
    });
  }
  return sessionConnectError('internal', 'Server operation failed.', {
    ...action,
    cause: error,
  });
}

function deviceErrorCode(code: DeviceFailure['code']): SessionErrorCode {
  switch (code) {
    case DeviceErrorCode.UNAUTHENTICATED:
      return 'unauthenticated';
    case DeviceErrorCode.PERMISSION_DENIED:
    case DeviceErrorCode.DEVICE_REVOKED:
    case DeviceErrorCode.ENVIRONMENT_REVOKED:
      return 'permission_denied';
    case DeviceErrorCode.VERSION_CONFLICT:
    case DeviceErrorCode.IDENTITY_CONFLICT:
    case DeviceErrorCode.BINDING_CONFLICT:
    case DeviceErrorCode.FILE_VERSION_CONFLICT:
      return 'version_conflict';
    case DeviceErrorCode.OPERATION_CONFLICT:
      return 'action_conflict';
    case DeviceErrorCode.ENVIRONMENT_OFFLINE:
      return 'device_offline';
    case DeviceErrorCode.OPERATION_UNKNOWN:
    case DeviceErrorCode.OPERATION_EXPIRED:
      return 'operation_unknown';
    case DeviceErrorCode.MESSAGE_TOO_LARGE:
    case DeviceErrorCode.FILE_TOO_LARGE:
      return 'input_too_large';
    case DeviceErrorCode.PROTOCOL_INCOMPATIBLE:
      return 'protocol_incompatible';
    case DeviceErrorCode.INVALID_MESSAGE:
    case DeviceErrorCode.PATH_INVALID:
      return 'invalid_argument';
    case DeviceErrorCode.CAPABILITY_UNAVAILABLE:
    case DeviceErrorCode.DIRECTORY_INVALID:
      return 'failed_precondition';
    default:
      return 'internal';
  }
}
