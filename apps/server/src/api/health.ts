import type { DatabaseSync } from 'node:sqlite';
import { healthResponseSchema, PROTOCOL_VERSION } from '@kairos/contracts';
import type { FastifyInstance } from 'fastify';

export function registerHealthRoute(server: FastifyInstance, database: DatabaseSync): void {
  server.get('/health', async () => {
    database.prepare('SELECT 1').get();
    return healthResponseSchema.parse({
      protocol_version: PROTOCOL_VERSION,
      service: 'kairos-server',
      status: 'ok',
    });
  });
}
