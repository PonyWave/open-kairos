import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './index.js';

describe('health response contract', () => {
  const response = { protocol_version: '1.0', service: 'kairos-server', status: 'ok' };

  it('rejects incompatible versions and unregistered fields', () => {
    expect(healthResponseSchema.parse(response)).toEqual(response);
    expect(healthResponseSchema.safeParse({ ...response, protocol_version: '2.0' }).success).toBe(
      false,
    );
    expect(
      healthResponseSchema.safeParse({ ...response, database_path: '/private/db' }).success,
    ).toBe(false);
  });
});
