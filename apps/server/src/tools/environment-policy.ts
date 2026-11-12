import { z } from 'zod';
import type { EnvironmentPolicyInput } from '../sessions/environment-policies.js';

export const environmentPolicyFields = {
  allowed_env: z.array(z.string().min(1).max(200)).min(1).max(32),
};

export const optionalEnvironmentPolicySchema = z.object(environmentPolicyFields).partial();

export function environmentPolicyInput(
  input: { allowed_env?: string[] | undefined },
  resolveEnvironmentIds?: (envIds: readonly string[]) => string[],
): EnvironmentPolicyInput | undefined {
  return input.allowed_env === undefined
    ? undefined
    : { allowedEnv: resolveEnvironmentIds?.(input.allowed_env) ?? input.allowed_env };
}

export function environmentPolicyJson(
  input: EnvironmentPolicyInput,
  resolveEnvironmentIds?: (envIds: readonly string[]) => string[],
): Record<string, unknown> {
  return {
    allowed_env: resolveEnvironmentIds?.(input.allowedEnv) ?? [...input.allowedEnv],
  };
}
