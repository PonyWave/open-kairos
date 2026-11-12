import { ContractValidationError } from './error.js';
import type {
  CompleteProfileRequest,
  RequestEmailCodeRequest,
  VerifyEmailCodeRequest,
} from './gen/kairos/gui/v1/auth_pb.js';

export * from './gen/kairos/gui/v1/auth_pb.js';

function requireText(value: string, field: string, maximum: number): void {
  if (value.trim().length === 0 || value.length > maximum || value.includes('\0')) {
    throw new ContractValidationError(
      'INVALID_MESSAGE',
      `${field} must contain between 1 and ${maximum} characters without null characters.`,
    );
  }
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 320 || email.includes('\0') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ContractValidationError(
      'INVALID_MESSAGE',
      'An email address must contain one local part and a domain.',
    );
  }
  return email;
}

export function validateRequestEmailCodeRequest(request: RequestEmailCodeRequest): void {
  normalizeEmail(request.email);
  requireText(request.clientActionId, 'RequestEmailCodeRequest.client_action_id', 200);
}

export function validateVerifyEmailCodeRequest(request: VerifyEmailCodeRequest): void {
  normalizeEmail(request.email);
  requireText(request.verificationId, 'VerifyEmailCodeRequest.verification_id', 200);
  if (!/^\d{6}$/.test(request.code)) {
    throw new ContractValidationError(
      'INVALID_MESSAGE',
      'VerifyEmailCodeRequest.code must contain exactly six digits.',
    );
  }
}

export function validateCompleteProfileRequest(request: CompleteProfileRequest): void {
  requireText(request.username, 'CompleteProfileRequest.username', 80);
}
