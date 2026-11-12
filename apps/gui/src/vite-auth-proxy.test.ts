import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { createKairosClients } from './client.js';

async function availablePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配测试端口。');
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForServer(
  child: ChildProcessByStdio<null, Readable, Readable>,
  url: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('真实 Auth Server 提前退出。');
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server 尚未开始监听，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('等待真实 Auth Server 超时。');
}

async function stopServer(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('Vite development proxy authentication', () => {
  it('forwards a real Auth write with the Origin accepted by the real Server', async () => {
    const repository = fileURLToPath(new URL('../../../', import.meta.url));
    const dataDirectory = await mkdtemp(join(tmpdir(), 'kairos-vite-auth-'));
    const serverPort = await availablePort();
    let vitePort = await availablePort();
    if (vitePort === serverPort) vitePort = await availablePort();
    const serverOrigin = `http://127.0.0.1:${serverPort}`;
    const previousHost = process.env.KAIROS_HOST;
    const previousPort = process.env.KAIROS_PORT;
    let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
    let vite: ViteDevServer | undefined;
    try {
      const serverProcess = spawn(
        process.execPath,
        ['--import', 'tsx', 'apps/server/src/main.ts'],
        {
          cwd: repository,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            NODE_ENV: 'test',
            KAIROS_HOST: '127.0.0.1',
            KAIROS_PORT: String(serverPort),
            KAIROS_DATA_DIR: dataDirectory,
            KAIROS_WORKSPACE_DIR: dataDirectory,
            KAIROS_AUTH_SECRET: 'vite-proxy-test-secret-0123456789abcdef',
            KAIROS_PUBLIC_ORIGIN: serverOrigin,
            KAIROS_AUTH_INVITED_EMAILS: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      child = serverProcess;
      serverProcess.stdout.resume();
      serverProcess.stderr.resume();
      await waitForServer(serverProcess, `${serverOrigin}/health`);

      process.env.KAIROS_HOST = '127.0.0.1';
      process.env.KAIROS_PORT = String(serverPort);
      vite = await createViteServer({
        root: fileURLToPath(new URL('..', import.meta.url)),
        configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
        logLevel: 'silent',
        server: { host: '127.0.0.1', port: vitePort, strictPort: true },
      });
      await vite.listen();
      const viteOrigin = `http://127.0.0.1:${vitePort}`;
      const current = await fetch(
        `${viteOrigin}/api/kairos.gui.v1.AuthService/GetCurrentIdentity`,
        {
          method: 'POST',
          headers: {
            origin: viteOrigin,
            'content-type': 'application/json',
            'connect-protocol-version': '1',
          },
          body: '{}',
        },
      );
      expect(current.status).toBe(200);
      const csrfToken = /kairos_csrf=([^;]+)/.exec(current.headers.get('set-cookie') ?? '')?.[1];
      expect(csrfToken).toBeTruthy();
      if (!csrfToken) throw new Error('AuthService 未设置 CSRF Cookie。');

      const clients = createKairosClients({
        baseUrl: `${viteOrigin}/api`,
        getCsrfToken: () => csrfToken,
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set('origin', viteOrigin);
          headers.set('cookie', `kairos_csrf=${csrfToken}`);
          return fetch(input, { ...init, headers });
        },
      });
      const response = await clients.auth.requestEmailCode({
        email: 'test@kairos.com',
        clientActionId: 'vite-real-proxy-request-email-code',
      });
      expect(response.verificationId).toBeTruthy();
    } finally {
      await vite?.close();
      if (child) await stopServer(child);
      restoreEnvironment('KAIROS_HOST', previousHost);
      restoreEnvironment('KAIROS_PORT', previousPort);
      await rm(dataDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});
