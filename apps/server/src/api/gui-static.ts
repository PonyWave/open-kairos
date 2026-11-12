import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function contentType(path: string): string {
  const dot = path.lastIndexOf('.');
  return contentTypes[path.slice(dot)] ?? 'application/octet-stream';
}

export function registerGuiStatic(server: FastifyInstance, directory: string): boolean {
  if (!existsSync(join(directory, 'index.html'))) return false;
  const root = normalize(directory);
  const sendFile = (path: string, reply: FastifyReply) => {
    const resolved = normalize(join(root, path));
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return undefined;
    if (!existsSync(resolved) || !statSync(resolved).isFile()) return undefined;
    const immutable = resolved.includes(`${sep}assets${sep}`);
    return reply
      .type(contentType(resolved))
      .header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-store')
      .send(createReadStream(resolved));
  };
  server.get('/', async (_request, reply) => {
    const sent = sendFile('index.html', reply);
    if (!sent) return reply.code(404).send();
    return sent;
  });
  server.get<{ Params: { '*': string } }>('/*', async (request, reply) => {
    const sent = sendFile(request.params['*'], reply);
    if (!sent) return reply.code(404).send();
    return sent;
  });
  return true;
}
