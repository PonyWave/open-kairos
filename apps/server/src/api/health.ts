import type { DatabaseSync } from 'node:sqlite';
import { healthResponseSchema, PROTOCOL_VERSION } from '@kairos/contracts';
import type { FastifyInstance } from 'fastify';

export function registerHealthRoute(server: FastifyInstance, database: DatabaseSync): void {
  const handler = async () => {
    database.prepare('SELECT 1').get();
    return healthResponseSchema.parse({
      protocol_version: PROTOCOL_VERSION,
      service: 'kairos-server',
      status: 'ok',
    });
  };
  server.get('/health', handler);
  // 生产形态下 GUI 与 Connect 接口同端口托管，页面经 /api 前缀访问健康检查。
  server.get('/api/health', handler);
}
