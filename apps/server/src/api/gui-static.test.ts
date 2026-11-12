import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { registerGuiStatic } from './gui-static.js';

const directories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-gui-static-'));
  directories.push(directory);
  writeFileSync(join(directory, 'index.html'), '<html><body>open-kairos</body></html>');
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'assets', 'app.js'), 'console.log(1);');
  const server = Fastify({ logger: false });
  expect(registerGuiStatic(server, directory)).toBe(true);
  return server;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('serves the GUI entry and hashed assets with cache headers', async () => {
  const server = fixture();
  try {
    const index = await server.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.headers['cache-control']).toBe('no-store');
    expect(index.body).toContain('open-kairos');

    const asset = await server.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.headers['cache-control']).toContain('immutable');
  } finally {
    await server.close();
  }
});

it('rejects missing files and path traversal', async () => {
  const server = fixture();
  try {
    expect((await server.inject({ method: 'GET', url: '/missing.js' })).statusCode).toBe(404);
    expect(
      (await server.inject({ method: 'GET', url: '/assets/..%2F..%2Fetc%2Fpasswd' })).statusCode,
    ).toBe(404);
  } finally {
    await server.close();
  }
});

it('reports missing GUI build output', () => {
  const server = Fastify({ logger: false });
  expect(registerGuiStatic(server, '/nonexistent-gui-dist')).toBe(false);
});
