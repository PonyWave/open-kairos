export type ContractValidationErrorCode =
  | 'INCOMPATIBLE_PROTOCOL_MAJOR'
  | 'INVALID_MESSAGE'
  | 'UNSUPPORTED_PAYLOAD';

export class ContractValidationError extends Error {
  readonly code: ContractValidationErrorCode;

  constructor(code: ContractValidationErrorCode, message: string) {
    super(message);
    this.name = 'ContractValidationError';
    this.code = code;
  }
}
