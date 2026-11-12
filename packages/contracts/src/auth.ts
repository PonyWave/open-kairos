import { ContractValidationError } from './error.js';

export * from './gen/kairos/gui/v1/auth_pb.js';

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
