import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DEFAULT_PLATFORM_IDLE_TIMEOUT_MS } from './control-schema.js';
import { initializePlatformControlDatabase } from './control-store.js';

export function initializePlatformControlFromFile(path: string): void {
  const input = z
    .object({
      path: z.string(),
      capacity: z.number().int().min(1).max(5),
      idleTimeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(86_400_000)
        .default(DEFAULT_PLATFORM_IDLE_TIMEOUT_MS),
      cluster: z.object({
        caSha256: z.string(),
        nodeUid: z.string(),
        nodeName: z.string(),
        namespace: z.string(),
      }),
    })
    .strict()
    .parse(JSON.parse(readFileSync(path, 'utf8')));
  initializePlatformControlDatabase(input);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3)
    throw new Error('Usage: node initialize.js <explicit-control-initialization.json>');
  initializePlatformControlFromFile(process.argv[2] ?? '');
}
