export type ProviderErrorCode =
  | 'invalid_config'
  | 'http_error'
  | 'invalid_response'
  | 'invalid_request'
  | 'request_failed'
  | 'request_timeout'
  | 'request_too_large';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: ErrorOptions & { status?: number } = {},
  ) {
    super(message, options);
    this.name = 'ProviderError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}
