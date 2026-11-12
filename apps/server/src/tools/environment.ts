import type { AgentTool } from '@kairos/agent-core';
import { z } from 'zod';
import type { AgentEnvironmentRuntime } from '../sessions/environment-runtime.js';
import type { RunRecord } from '../sessions/records.js';

const envListSchema = z.object({}).strict();
const envTarget = { env_id: z.string().min(1).max(200).optional() };
const envTargetParameters = {
  env_id: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    description:
      'Optional authorized target for this call; omission uses the tenant sandbox workspace, whose explicit env_id is sandbox.',
  },
};
const pathSchema = z.string().min(1).max(4096);
const readSchema = z
  .object({
    ...envTarget,
    path: pathSchema,
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(2000).optional(),
  })
  .strict();
const readImageSchema = z.object({ ...envTarget, path: pathSchema }).strict();
const writeSchema = z
  .object({
    ...envTarget,
    path: pathSchema,
    content: z.string().max(1_000_000),
    overwrite: z.boolean().default(false),
  })
  .strict();
const editSchema = z
  .object({
    ...envTarget,
    path: pathSchema,
    oldText: z.string().min(1).max(1_000_000),
    newText: z.string().max(1_000_000),
    expectedOccurrences: z.number().int().positive().max(1000).optional(),
    expected_file_version: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine((input) => input.oldText !== input.newText, {
    message: 'newText must differ from oldText.',
  });
const envSyncSchema = z
  .object({
    source_env_id: z.string().min(1).max(200),
    source_path: pathSchema,
    target_env_id: z.string().min(1).max(200),
    target_path: pathSchema,
    on_conflict: z.enum(['fail', 'skip', 'overwrite']).default('fail'),
  })
  .strict();
const readOutputSchema = z
  .object({
    operation_id: z.string().min(1).max(200),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z
      .number()
      .int()
      .positive()
      .max(64 * 1024)
      .default(16 * 1024),
  })
  .strict();

function createBashSchema(defaultTimeoutSeconds: number) {
  return z
    .object({
      ...envTarget,
      command: z.string().min(1).max(1_000_000),
      cwd: z.string().min(1).max(4096).optional(),
      timeoutSeconds: z.number().int().positive().max(3600).default(defaultTimeoutSeconds),
    })
    .strict();
}

export function createEnvironmentTools(
  runtime: AgentEnvironmentRuntime,
  run: RunRecord,
): [
  AgentTool<z.infer<typeof envListSchema>>,
  AgentTool<z.infer<typeof readSchema>>,
  AgentTool<z.infer<typeof readImageSchema>>,
  AgentTool<z.infer<typeof writeSchema>>,
  AgentTool<z.infer<typeof editSchema>>,
  AgentTool<z.infer<ReturnType<typeof createBashSchema>>>,
  AgentTool<z.infer<typeof readOutputSchema>>,
  AgentTool<z.infer<typeof envSyncSchema>>,
] {
  const bashSchema = createBashSchema(runtime.bashDefaultTimeoutSeconds);
  return [
    {
      name: 'env_list',
      description:
        'List authorized environments and their connection and lifecycle states, including the tenant sandbox; listing does not start an environment.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      concurrent: true,
      validate: (value) => envListSchema.parse(value),
      execute: async () => runtime.list(run),
    },
    {
      name: 'read',
      description: 'Read bounded UTF-8 text from the selected remote environment.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          ...envTargetParameters,
          path: { type: 'string', maxLength: 4096 },
          offset: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 2000 },
        },
      },
      concurrent: true,
      validate: (value) => readSchema.parse(value),
      execute: async (input, { call, signal }) =>
        runtime.execute(
          run,
          {
            case: 'read',
            value: {
              path: input.path,
              cwd: '',
              ...(input.offset === undefined ? {} : { offset: input.offset }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            },
          },
          call.id,
          signal,
          {
            ...(input.env_id === undefined ? {} : { envId: input.env_id }),
            ...('cwd' in input && typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
          },
        ),
    },
    {
      name: 'read_image',
      description:
        'Read a PNG or JPEG file from the selected remote environment and return it as image input for the model. Files are limited to 700000 bytes.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: { ...envTargetParameters, path: { type: 'string', maxLength: 4096 } },
      },
      concurrent: true,
      validate: (value) => readImageSchema.parse(value),
      execute: async (input, { call, signal }) =>
        runtime.execute(
          run,
          {
            case: 'readImage',
            value: {
              path: input.path,
              cwd: '',
            },
          },
          call.id,
          signal,
          {
            ...(input.env_id === undefined ? {} : { envId: input.env_id }),
            ...('cwd' in input && typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
          },
        ),
    },
    {
      name: 'write',
      description:
        'Atomically write a UTF-8 file in the selected remote environment; overwrite defaults to false.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          ...envTargetParameters,
          path: { type: 'string', maxLength: 4096 },
          content: { type: 'string', maxLength: 1_000_000 },
          overwrite: { type: 'boolean', default: false },
        },
      },
      validate: (value) => writeSchema.parse(value),
      execute: async (input, { call, signal }) =>
        runtime.execute(
          run,
          {
            case: 'write',
            value: {
              path: input.path,
              cwd: '',
              content: input.content,
              overwrite: input.overwrite,
            },
          },
          call.id,
          signal,
          {
            ...(input.env_id === undefined ? {} : { envId: input.env_id }),
            ...('cwd' in input && typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
          },
        ),
    },
    {
      name: 'edit',
      description:
        'Replace exact text in the selected remote environment using the file version returned by read.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'oldText', 'newText', 'expected_file_version'],
        properties: {
          ...envTargetParameters,
          path: { type: 'string', maxLength: 4096 },
          oldText: { type: 'string', minLength: 1, maxLength: 1_000_000 },
          newText: { type: 'string', maxLength: 1_000_000 },
          expectedOccurrences: { type: 'integer', minimum: 1, maximum: 1000 },
          expected_file_version: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
      },
      validate: (value) => editSchema.parse(value),
      execute: async (input, { call, signal }) =>
        runtime.execute(
          run,
          {
            case: 'edit',
            value: {
              path: input.path,
              cwd: '',
              oldText: input.oldText,
              newText: input.newText,
              ...(input.expectedOccurrences === undefined
                ? {}
                : { expectedOccurrences: input.expectedOccurrences }),
              expectedFileVersion: input.expected_file_version,
            },
          },
          call.id,
          signal,
          {
            ...(input.env_id === undefined ? {} : { envId: input.env_id }),
            ...('cwd' in input && typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
          },
        ),
    },
    {
      name: 'bash',
      description:
        'Execute /bin/bash in the selected remote environment. A cwd override applies only to this call.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: {
          ...envTargetParameters,
          command: { type: 'string', minLength: 1, maxLength: 1_000_000 },
          cwd: { type: 'string', maxLength: 4096 },
          timeoutSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
        },
      },
      validate: (value) => bashSchema.parse(value),
      execute: async (input, { call, signal }) =>
        runtime.execute(
          run,
          {
            case: 'bash',
            value: {
              command: input.command,
              cwd: '',
              timeoutSeconds: input.timeoutSeconds,
            },
          },
          call.id,
          signal,
          {
            ...(input.env_id === undefined ? {} : { envId: input.env_id }),
            ...('cwd' in input && typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
          },
        ),
    },
    {
      name: 'read_output',
      description: 'Read an authorized operation output log stored on the Server by byte offset.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['operation_id'],
        properties: {
          operation_id: { type: 'string', maxLength: 200 },
          offset: { type: 'integer', minimum: 0, default: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 65536, default: 16384 },
        },
      },
      concurrent: true,
      validate: (value) => readOutputSchema.parse(value),
      execute: async (input) =>
        runtime.readOutput(run, {
          operationId: input.operation_id,
          offset: BigInt(input.offset),
          limit: input.limit,
        }),
    },
    {
      name: 'env_sync',
      description:
        'Copy a regular file or directory between two different authorized environments using normalized absolute POSIX paths. The sandbox env_id is sandbox. on_conflict defaults to fail; skip and overwrite apply only to files with different content, while identical files are always skipped. overwrite never deletes extra target entries.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['source_env_id', 'source_path', 'target_env_id', 'target_path'],
        properties: {
          source_env_id: { type: 'string', minLength: 1, maxLength: 200 },
          source_path: { type: 'string', minLength: 1, maxLength: 4096 },
          target_env_id: { type: 'string', minLength: 1, maxLength: 200 },
          target_path: { type: 'string', minLength: 1, maxLength: 4096 },
          on_conflict: { type: 'string', enum: ['fail', 'skip', 'overwrite'], default: 'fail' },
        },
      },
      validate: (value) => envSyncSchema.parse(value),
      execute: async (input, { call, signal }) =>
        runtime.sync(
          run,
          {
            sourceEnvId: input.source_env_id,
            sourcePath: input.source_path,
            targetEnvId: input.target_env_id,
            targetPath: input.target_path,
            onConflict: input.on_conflict,
          },
          call.id,
          signal,
        ),
    },
  ];
}
