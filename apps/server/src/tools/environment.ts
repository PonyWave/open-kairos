import type { AgentTool } from '@kairos/agent-core';
import { GrepMode } from '@kairos/contracts/device';
import { z } from 'zod';
import type { AgentEnvironmentRuntime } from '../sessions/environment-runtime.js';
import { SessionError } from '../sessions/errors.js';
import type { RunRecord } from '../sessions/records.js';

const envListSchema = z.object({}).strict();
const envTarget = { env_id: z.string().min(1).max(200).optional() };
const envTargetParameters = {
  env_id: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    description:
      'Authorized target environment for this call only. Omit to use the main environment (env_id main); the choice does not affect later calls or loaded instructions.',
  },
};
const pathParameter = {
  type: 'string',
  maxLength: 4096,
  description: 'Absolute path, or a path relative to the workspace of the selected environment.',
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
const globSchema = z
  .object({
    ...envTarget,
    pattern: z.string().min(1).max(4096),
    path: pathSchema.optional(),
    head_limit: z.number().int().positive().max(1000).optional(),
    offset: z.number().int().nonnegative().max(100_000).optional(),
  })
  .strict();
const grepSchema = z
  .object({
    ...envTarget,
    pattern: z.string().min(1).max(4096),
    path: pathSchema.optional(),
    include: z.string().min(1).max(4096).optional(),
    case_insensitive: z.boolean().optional(),
    mode: z.enum(['content', 'files_with_matches', 'count']).default('content'),
    head_limit: z.number().int().positive().max(1000).optional(),
    offset: z.number().int().nonnegative().max(100_000).optional(),
  })
  .strict();

function createBashSchema(defaultTimeoutSeconds: number) {
  return z
    .object({
      ...envTarget,
      command: z.string().min(1).max(1_000_000),
      cwd: z.string().min(1).max(4096).optional(),
      timeoutSeconds: z.number().int().positive().max(3600).default(defaultTimeoutSeconds),
      run_in_background: z.boolean().default(false),
      description: z.string().min(1).max(2000).optional(),
    })
    .strict()
    .refine((value) => !value.run_in_background || value.description !== undefined, {
      message: 'description is required when run_in_background is true.',
    });
}

export interface BackgroundBashStarter {
  start(
    input: { command: string; cwd?: string; timeoutSeconds: number; description: string },
    envId: string | undefined,
    call: { id: string },
    signal: AbortSignal,
  ): Promise<string>;
}

export function createEnvironmentTools(
  runtime: AgentEnvironmentRuntime,
  run: RunRecord,
  background?: BackgroundBashStarter,
): [
  AgentTool<z.infer<typeof envListSchema>>,
  AgentTool<z.infer<typeof readSchema>>,
  AgentTool<z.infer<typeof readImageSchema>>,
  AgentTool<z.infer<typeof writeSchema>>,
  AgentTool<z.infer<typeof editSchema>>,
  AgentTool<z.infer<typeof globSchema>>,
  AgentTool<z.infer<typeof grepSchema>>,
  AgentTool<z.infer<ReturnType<typeof createBashSchema>>>,
  AgentTool<z.infer<typeof envSyncSchema>>,
] {
  const bashSchema = createBashSchema(runtime.bashDefaultTimeoutSeconds);
  return [
    {
      name: 'env_list',
      description:
        'List authorized environments with their connection and lifecycle states, including the main environment. Listing does not start an environment.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      concurrent: true,
      validate: (value) => envListSchema.parse(value),
      execute: async () => runtime.list(run),
    },
    {
      name: 'read',
      description:
        'Read a UTF-8 text file from the selected environment. offset is the 1-based first line (default 1) and limit caps the returned lines (default and maximum 2000). The result carries the returned line range, has_more with next_offset for continuation, a truncated flag and file_version. Pass file_version to edit as expected_file_version. Files above the inspection size limit are rejected; use bash tools such as sed or rg for targeted views of very large files.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          ...envTargetParameters,
          path: pathParameter,
          offset: {
            type: 'integer',
            minimum: 1,
            description: '1-based first line to return; defaults to 1.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 2000,
            description: 'Maximum number of lines to return; defaults to 2000.',
          },
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
        'Read a PNG or JPEG file from the selected environment and return it as image input for the model. Files are limited to 700000 bytes.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: { ...envTargetParameters, path: pathParameter },
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
        'Atomically write a UTF-8 file in the selected environment and return its file_version. overwrite defaults to false and the write fails if the file already exists; set overwrite true to replace it. Prefer edit for targeted changes to existing files.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          ...envTargetParameters,
          path: pathParameter,
          content: {
            type: 'string',
            maxLength: 1_000_000,
            description: 'Complete UTF-8 file content to write.',
          },
          overwrite: {
            type: 'boolean',
            default: false,
            description: 'Replace an existing file; defaults to false.',
          },
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
        'Replace exact text in a file in the selected environment. Read the file first and pass its file_version as expected_file_version; the edit fails when the file changed since that read. oldText must match the file content exactly; expectedOccurrences asserts the expected number of replacements and the edit fails when the actual count differs.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'oldText', 'newText', 'expected_file_version'],
        properties: {
          ...envTargetParameters,
          path: pathParameter,
          oldText: {
            type: 'string',
            minLength: 1,
            maxLength: 1_000_000,
            description: 'Exact text to replace, matching the file content byte for byte.',
          },
          newText: {
            type: 'string',
            maxLength: 1_000_000,
            description: 'Replacement text; must differ from oldText.',
          },
          expectedOccurrences: {
            type: 'integer',
            minimum: 1,
            maximum: 1000,
            description:
              'Expected number of replacements; the edit fails when the actual count differs.',
          },
          expected_file_version: {
            type: 'string',
            pattern: '^[a-f0-9]{64}$',
            description:
              'file_version returned by the most recent read of this file; the edit fails when the file changed since.',
          },
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
      name: 'glob',
      description:
        'Find files in the selected environment whose names match a glob pattern, most recently modified first. Hidden files are included; version-control directories are excluded.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['pattern'],
        properties: {
          ...envTargetParameters,
          pattern: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            description: 'Glob pattern matched against file paths, for example "**/*.ts".',
          },
          path: {
            type: 'string',
            maxLength: 4096,
            description: 'Directory to search; omission searches the working directory.',
          },
          head_limit: { type: 'integer', minimum: 1, maximum: 1000, default: 250 },
          offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
        },
      },
      concurrent: true,
      validate: (value) => globSchema.parse(value),
      execute: async (input, { call, signal }) =>
        runtime.execute(
          run,
          {
            case: 'glob',
            value: {
              pattern: input.pattern,
              path: input.path ?? '.',
              cwd: '',
              ...(input.head_limit === undefined ? {} : { headLimit: input.head_limit }),
              ...(input.offset === undefined ? {} : { offset: input.offset }),
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
      name: 'grep',
      description:
        'Search file contents in the selected environment with a regular expression. Returns matching lines with file and line number by default; mode selects files_with_matches or per-file count instead. Hidden files are included; version-control directories are excluded.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['pattern'],
        properties: {
          ...envTargetParameters,
          pattern: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            description: 'Regular expression understood by ripgrep.',
          },
          path: {
            type: 'string',
            maxLength: 4096,
            description: 'File or directory to search; omission searches the working directory.',
          },
          include: {
            type: 'string',
            maxLength: 4096,
            description: 'Optional glob restricting searched files, for example "*.{ts,tsx}".',
          },
          case_insensitive: { type: 'boolean', default: false },
          mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            default: 'content',
          },
          head_limit: { type: 'integer', minimum: 1, maximum: 1000, default: 250 },
          offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
        },
      },
      concurrent: true,
      validate: (value) => grepSchema.parse(value),
      execute: async (input, { call, signal }) =>
        runtime.execute(
          run,
          {
            case: 'grep',
            value: {
              pattern: input.pattern,
              path: input.path ?? '.',
              cwd: '',
              ...(input.include === undefined ? {} : { include: input.include }),
              caseInsensitive: input.case_insensitive ?? false,
              mode:
                input.mode === 'files_with_matches'
                  ? GrepMode.FILES_WITH_MATCHES
                  : input.mode === 'count'
                    ? GrepMode.COUNT
                    : GrepMode.CONTENT,
              lineNumbers: true,
              ...(input.head_limit === undefined ? {} : { headLimit: input.head_limit }),
              ...(input.offset === undefined ? {} : { offset: input.offset }),
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
        'Execute a /bin/bash command in the selected environment and return the exit code with a bounded output preview. Each call runs in a fresh shell: variables, cd and shell history do not persist, so pass cwd or use absolute paths. The default working directory is the workspace of the selected environment. Do not run interactive commands or commands that never exit; give long-running commands a realistic timeoutSeconds and prefer delegating lengthy builds or watchers. When the preview is truncated, the full output is written to a log file on the executing environment and the result points to that file for read or grep with the same env_id.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: {
          ...envTargetParameters,
          command: {
            type: 'string',
            minLength: 1,
            maxLength: 1_000_000,
            description: 'The bash command line to execute.',
          },
          cwd: {
            type: 'string',
            maxLength: 4096,
            description: 'Working directory override for this call only.',
          },
          timeoutSeconds: {
            type: 'integer',
            minimum: 1,
            maximum: 3600,
            description: 'Timeout in seconds; a server default applies when omitted.',
          },
          run_in_background: {
            type: 'boolean',
            default: false,
            description:
              'Run the command as a background task and return a task_id immediately; the terminal result is persisted and delivered automatically.',
          },
          description: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
            description: 'Required with run_in_background: a short summary of the command.',
          },
        },
      },
      validate: (value) => bashSchema.parse(value),
      execute: async (input, { call, signal }) => {
        if (input.run_in_background) {
          if (!background) {
            throw new SessionError(
              'permission_denied',
              'Background execution is not available for this Agent.',
            );
          }
          return background.start(
            {
              command: input.command,
              ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
              timeoutSeconds: input.timeoutSeconds,
              description: input.description ?? '',
            },
            input.env_id,
            call,
            signal,
          );
        }
        return runtime.execute(
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
        );
      },
    },
    {
      name: 'env_sync',
      description:
        'Copy a regular file or directory between two different authorized environments using normalized absolute POSIX paths. The main environment env_id is main. on_conflict defaults to fail; skip and overwrite apply only to files with different content, while identical files are always skipped. overwrite never deletes extra target entries.',
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
