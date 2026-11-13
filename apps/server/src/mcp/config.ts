import { readFileSync } from 'node:fs';
import { z } from 'zod';

const serverBase = {
  name: z.string().min(1).max(100),
  env_id: z.string().min(1).max(200).default('main'),
};

const stdioSchema = z
  .object({
    ...serverBase,
    transport: z.literal('stdio'),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(64).default([]),
    env: z.record(z.string().max(200), z.string().max(4096)).default({}),
  })
  .strict();

const remoteSchema = z
  .object({
    ...serverBase,
    transport: z.enum(['http', 'sse']),
    url: z.string().url().max(4096),
    headers: z.record(z.string().max(200), z.string().max(4096)).default({}),
  })
  .strict();

const serverSchema = z.discriminatedUnion('transport', [stdioSchema, remoteSchema]);

const fileSchema = z.object({
  servers: z.array(serverSchema).max(64),
});

export type McpServerConfig = z.infer<typeof serverSchema>;

export function parseMcpServerConfigs(raw: unknown): McpServerConfig[] {
  const configs = fileSchema.parse(raw).servers;
  const seen = new Set<string>();
  for (const config of configs) {
    const key = `${config.env_id}${config.name}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate MCP server "${config.name}" for environment "${config.env_id}".`);
    }
    seen.add(key);
  }
  return configs;
}

export function loadMcpServerConfigs(path: string): McpServerConfig[] {
  return parseMcpServerConfigs(JSON.parse(readFileSync(path, 'utf8')));
}
