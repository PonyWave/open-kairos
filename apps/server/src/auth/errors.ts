export type AuthErrorCode =
  | 'unauthenticated'
  | 'permission_denied'
  | 'invalid_argument'
  | 'not_found'
  | 'conflict'
  | 'resource_exhausted'
  | 'unavailable'
  | 'internal';

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly retryable: boolean;

  constructor(code: AuthErrorCode, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}
