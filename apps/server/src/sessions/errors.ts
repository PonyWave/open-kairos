export type SessionErrorCode =
  | 'unauthenticated'
  | 'permission_denied'
  | 'version_conflict'
  | 'action_conflict'
  | 'device_offline'
  | 'operation_unknown'
  | 'recap_invalid'
  | 'input_too_large'
  | 'protocol_incompatible'
  | 'invalid_argument'
  | 'not_found'
  | 'failed_precondition'
  | 'internal';

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  readonly retryable: boolean;
  readonly clientActionId?: string;
  readonly terminal?: boolean;

  constructor(
    code: SessionErrorCode,
    message: string,
    options: ErrorOptions & {
      retryable?: boolean;
      clientActionId?: string;
      terminal?: boolean;
    } = {},
  ) {
    super(message, options);
    this.name = 'SessionError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.clientActionId !== undefined) this.clientActionId = options.clientActionId;
    if (options.terminal !== undefined) this.terminal = options.terminal;
  }
}

export function requireText(
  value: string,
  field: string,
  maximum: number,
  options: { allowEmpty?: boolean; maximumBytes?: number } = {},
): string {
  if ((!options.allowEmpty && value.trim().length === 0) || value.length > maximum) {
    throw new SessionError(
      'invalid_argument',
      `${field} must contain ${options.allowEmpty ? 'at most' : 'between 1 and'} ${maximum} characters.`,
    );
  }
  if (value.includes('\0')) {
    throw new SessionError('invalid_argument', `${field} must not contain a null character.`);
  }
  if (options.maximumBytes !== undefined && Buffer.byteLength(value) > options.maximumBytes) {
    throw new SessionError('input_too_large', `${field} exceeds the configured byte limit.`);
  }
  return value;
}

export function requirePositiveInteger(value: number, field: string, maximum = 100): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new SessionError(
      'invalid_argument',
      `${field} must be a positive integer no greater than ${maximum}.`,
    );
  }
  return value;
}
