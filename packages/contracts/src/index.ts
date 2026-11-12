import { z } from 'zod';

export * from './auth.js';
export * from './environment.js';
export * from './error.js';
export * from './gui.js';
export * from './workspace.js';

export const PROTOCOL_VERSION = '1.0';

export const healthResponseSchema = z.strictObject({
  protocol_version: z.literal(PROTOCOL_VERSION),
  service: z.literal('kairos-server'),
  status: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from './gen/kairos/gui/v1/settings_pb.js';
