import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { modelFetch, validateModelUrl } from './model-network.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

it.each([204, 205, 600])(
  'handles HTTP %s without throwing from the network callback',
  async (status) => {
    const server = createServer((_request, response) => {
      response.writeHead(status);
      response.end();
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing address');
    const origin = `http://127.0.0.1:${address.port}`;
    const request = modelFetch([origin])(`${origin}/v1/chat/completions`, { body: '{}' });
    if (status === 600) await expect(request).rejects.toThrow(/无效 HTTP/);
    else {
      const response = await request;
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
    }
  },
);

it('cancels an in-flight request and refuses private targets without administrator approval', async () => {
  let accepted = () => {};
  const seen = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const server = createServer(() => accepted());
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const origin = `http://127.0.0.1:${address.port}`;
  const controller = new AbortController();
  const pending = modelFetch([origin])(`${origin}/v1/chat/completions`, {
    body: '{}',
    signal: controller.signal,
  });
  const rejected = expect(pending).rejects.toThrow(/连接失败/);
  await seen;
  controller.abort();
  await rejected;
  await expect(
    modelFetch()('https://127.0.0.1/v1/chat/completions', { body: '{}' }),
  ).rejects.toThrow(/网络目标/);
  expect(() => validateModelUrl('https://example.com/v1?')).toThrow();
  expect(() => validateModelUrl('https://example.com/v1#')).toThrow();
});
