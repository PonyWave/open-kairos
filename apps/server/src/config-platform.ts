import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { DEFAULT_PLATFORM_IDLE_TIMEOUT_MS } from './platform/control-schema.js';

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(isAbsolute, 'An absolute path is required.');
const serviceUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, 'A plain HTTP(S) service URL is required.');
const configurationSchema = z
  .object({
    deploymentId: z.string().regex(/^[a-z0-9-]{1,32}$/),
    controlDatabasePath: absolutePath,
    capacity: z.number().int().min(1).max(5).default(5),
    lifecycleUrl: serviceUrl,
    apiKeyFile: absolutePath,
    kubernetesUrl: serviceUrl.refine((value) => new URL(value).protocol === 'https:'),
    kubernetesCaFile: absolutePath,
    kubernetesTokenFile: absolutePath,
    cluster: z
      .object({
        caSha256: z.string().regex(/^[a-f0-9]{64}$/),
        nodeUid: z.string().regex(/^[a-f0-9-]{36}$/),
        nodeName: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,252}$/),
        namespace: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
      })
      .strict(),
    image: z
      .string()
      .min(1)
      .max(4096)
      .regex(/@sha256:[a-f0-9]{64}$/),
    serverWssUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'wss:' && !url.username && !url.password && !url.search && !url.hash
        );
      }),
    sharedReleaseClaim: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,252}$/),
    registryUrl: serviceUrl.refine((value) => new URL(value).protocol === 'https:'),
    registryCaFile: absolutePath,
    registryCredentialsFile: absolutePath,
    cgroupProofFile: absolutePath,
    preparationTimeoutMs: z.number().int().min(1000).max(600_000).default(180_000),
    requestTimeoutMs: z.number().int().min(1000).max(90_000).default(75_000),
    idleTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(86_400_000)
      .default(DEFAULT_PLATFORM_IDLE_TIMEOUT_MS),
  })
  .strict();

export type PlatformConfiguration = z.infer<typeof configurationSchema>;

export function readPlatformConfiguration(path: string): PlatformConfiguration {
  absolutePath.parse(path);
  const content = readFileSync(path);
  if (content.length > 64 * 1024) throw new Error('Sandbox configuration exceeds 64 KiB.');
  return configurationSchema.parse(JSON.parse(content.toString('utf8')));
}
