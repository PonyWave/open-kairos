import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const MEMORY_INDEX_FILE = 'MEMORY.md';
export const MEMORY_STATE_FILE = 'STATE.json';
export const DEFAULT_MEMORY_INDEX_MAX_BYTES = 10 * 1024;
export const MEMORY_TOPIC_MAX_BYTES = 64 * 1024;

const memoryConfigurationSchema = z
  .object({
    directory: z
      .string()
      .min(1)
      .refine(isAbsolute, 'The memory directory must be an absolute path.'),
    indexMaxBytes: z
      .number()
      .int()
      .min(1024)
      .max(1024 * 1024)
      .default(DEFAULT_MEMORY_INDEX_MAX_BYTES),
  })
  .strict();

export type MemoryConfiguration = z.input<typeof memoryConfigurationSchema>;
export type ParsedMemoryConfiguration = z.infer<typeof memoryConfigurationSchema>;

export function parseMemoryConfiguration(
  configuration: MemoryConfiguration,
): ParsedMemoryConfiguration {
  return memoryConfigurationSchema.parse(configuration);
}
