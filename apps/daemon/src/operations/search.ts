import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DaemonMessageInit, GlobAction, GrepAction } from '@kairos/contracts/device';
import { DeviceErrorAction, DeviceErrorCode, GrepMode } from '@kairos/contracts/device';
import { BashOperationFailure } from '../bash/manager.js';
import { FileOperationCancelled } from './files.js';

type OperationResult = Extract<DaemonMessageInit['payload'], { case: 'operationResult' }>['value'];
type GlobOutcome = Extract<OperationResult['outcome'], { case: 'glob' }>['value'];
type GrepOutcome = Extract<OperationResult['outcome'], { case: 'grep' }>['value'];

export const SEARCH_DEFAULT_HEAD_LIMIT = 250;
export const SEARCH_MAX_HEAD_LIMIT = 1000;
export const SEARCH_MAX_OFFSET = 100_000;
const SEARCH_TIMEOUT_MS = 25_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_PATTERN_BYTES = 4096;
const MAX_PATH_BYTES = 4096;
const MAX_REASON_CHARS = 1000;
const RG_MAX_COLUMNS = 500;
const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'] as const;

function failure(
  code: DeviceErrorCode,
  message: string,
  action: DeviceErrorAction = DeviceErrorAction.ABORT,
): BashOperationFailure {
  return new BashOperationFailure(code, message, action);
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new FileOperationCancelled();
}

function rgPath(): string {
  const configured = process.env.KAIROS_RG_PATH;
  return configured !== undefined && configured.length > 0 ? configured : 'rg';
}

function validateText(value: string, field: string, maximumBytes: number): void {
  if (value.includes('\0') || !value.isWellFormed() || Buffer.byteLength(value) > maximumBytes) {
    throw failure(DeviceErrorCode.INVALID_MESSAGE, `${field} is not valid bounded UTF-8 text.`);
  }
}

function boundedLimit(headLimit: number | undefined, offset: number | undefined) {
  const limit = headLimit ?? SEARCH_DEFAULT_HEAD_LIMIT;
  const skip = offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_HEAD_LIMIT) {
    throw failure(
      DeviceErrorCode.INVALID_MESSAGE,
      `head_limit must be an integer between 1 and ${String(SEARCH_MAX_HEAD_LIMIT)}.`,
    );
  }
  if (!Number.isInteger(skip) || skip < 0 || skip > SEARCH_MAX_OFFSET) {
    throw failure(
      DeviceErrorCode.INVALID_MESSAGE,
      `offset must be an integer between 0 and ${String(SEARCH_MAX_OFFSET)}.`,
    );
  }
  return { limit, skip };
}

async function realDirectory(path: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) {
      throw failure(DeviceErrorCode.DIRECTORY_INVALID, 'Operation cwd is not a real directory.');
    }
    return canonical;
  } catch (error) {
    if (error instanceof BashOperationFailure) throw error;
    throw failure(DeviceErrorCode.DIRECTORY_INVALID, 'Operation cwd cannot be inspected.');
  }
}

async function existingSearchPath(
  cwd: string,
  path: string,
  directoryOnly: boolean,
): Promise<string> {
  validateText(path, 'path', MAX_PATH_BYTES);
  validateText(cwd, 'cwd', MAX_PATH_BYTES);
  if (!cwd.startsWith('/')) {
    throw failure(DeviceErrorCode.PATH_INVALID, 'Operation cwd must be absolute.');
  }
  const directory = await realDirectory(cwd);
  let canonical: string;
  try {
    canonical = await realpath(resolve(directory, path));
  } catch {
    throw failure(DeviceErrorCode.PATH_INVALID, 'Search path cannot be inspected.');
  }
  const status = await stat(canonical);
  if (directoryOnly ? !status.isDirectory() : !status.isDirectory() && !status.isFile()) {
    throw failure(
      DeviceErrorCode.PATH_INVALID,
      directoryOnly ? 'Glob path is not a directory.' : 'Search path is not a file or directory.',
    );
  }
  return canonical;
}

interface RgRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
}

function runRg(args: readonly string[], cwd: string, signal: AbortSignal): Promise<RgRunResult> {
  checkSignal(signal);
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(rgPath(), [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      rejectPromise(spawnFailure(error));
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error !== undefined) rejectPromise(error);
    };
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process already exited.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      truncated = true;
      kill();
    }, SEARCH_TIMEOUT_MS);
    const onAbort = () => {
      kill();
      finish(new FileOperationCancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      finish(spawnFailure(error));
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) {
        truncated = true;
        kill();
        return;
      }
      stdoutBytes += chunk.byteLength;
      stdoutChunks.push(chunk);
      if (stdoutBytes >= MAX_OUTPUT_BYTES) {
        truncated = true;
        kill();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_REASON_CHARS * 4) {
        stderrBytes += chunk.byteLength;
        stderrChunks.push(chunk);
      }
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolvePromise({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode,
        truncated,
        timedOut,
      });
    });
  });
}

function spawnFailure(error: unknown): BashOperationFailure {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return failure(
      DeviceErrorCode.CAPABILITY_UNAVAILABLE,
      'ripgrep (rg) is not available in this environment.',
    );
  }
  return failure(
    DeviceErrorCode.INTERNAL,
    error instanceof Error ? error.message : 'Failed to start ripgrep.',
  );
}

function vcsExcludeArgs(): string[] {
  return VCS_DIRECTORIES_TO_EXCLUDE.flatMap((directory) => ['--glob', `!${directory}`]);
}

function rgError(run: RgRunResult): BashOperationFailure | undefined {
  if (run.exitCode === null || run.exitCode <= 1) return undefined;
  const stderr = run.stderr.trim().slice(0, MAX_REASON_CHARS);
  return failure(
    DeviceErrorCode.INVALID_MESSAGE,
    stderr.length > 0 ? `ripgrep failed: ${stderr}` : 'ripgrep failed.',
  );
}

function searchReason(run: RgRunResult): string | undefined {
  if (run.timedOut) return 'The search timed out before it completed.';
  if (run.exitCode !== null && run.exitCode > 1) {
    return run.stderr.trim().slice(0, MAX_REASON_CHARS) || 'ripgrep failed.';
  }
  const warning = run.stderr.trim();
  return warning.length > 0
    ? `Completed with warnings: ${warning.slice(0, MAX_REASON_CHARS)}`
    : undefined;
}

function completeLines(stdout: string, truncated: boolean): string[] {
  let text = stdout;
  if (truncated && !text.endsWith('\n')) {
    const lastNewline = text.lastIndexOf('\n');
    text = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
  }
  return text.split('\n').filter((line) => line.length > 0);
}

export async function runRemoteGlob(value: GlobAction, signal: AbortSignal): Promise<GlobOutcome> {
  const pattern = value.pattern;
  validateText(pattern, 'pattern', MAX_PATTERN_BYTES);
  if (pattern.length === 0) {
    throw failure(DeviceErrorCode.INVALID_MESSAGE, 'pattern must not be empty.');
  }
  const { limit, skip } = boundedLimit(value.headLimit, value.offset);
  const searchPath = await existingSearchPath(value.cwd, value.path, true);
  const run = await runRg(
    [
      '--files',
      '--hidden',
      '--sortr=modified',
      ...vcsExcludeArgs(),
      '--glob',
      pattern,
      '--',
      searchPath,
    ],
    value.cwd,
    signal,
  );
  checkSignal(signal);
  const error = rgError(run);
  if (error !== undefined && run.stdout.length === 0) throw error;
  const lines = completeLines(run.stdout, run.truncated);
  const files = lines.slice(skip, skip + limit);
  const reason = searchReason(run);
  return {
    path: searchPath,
    files,
    truncated: run.truncated || lines.length > skip + limit,
    ...(reason === undefined ? {} : { reason }),
  };
}

export async function runRemoteGrep(value: GrepAction, signal: AbortSignal): Promise<GrepOutcome> {
  const pattern = value.pattern;
  validateText(pattern, 'pattern', MAX_PATTERN_BYTES);
  if (pattern.length === 0) {
    throw failure(DeviceErrorCode.INVALID_MESSAGE, 'pattern must not be empty.');
  }
  const mode = value.mode === GrepMode.UNSPECIFIED ? GrepMode.CONTENT : value.mode;
  if (
    mode !== GrepMode.CONTENT &&
    mode !== GrepMode.FILES_WITH_MATCHES &&
    mode !== GrepMode.COUNT
  ) {
    throw failure(DeviceErrorCode.INVALID_MESSAGE, 'mode is not a supported GrepMode.');
  }
  const { limit, skip } = boundedLimit(value.headLimit, value.offset);
  const searchPath = await existingSearchPath(value.cwd, value.path, false);
  const args: string[] = ['--hidden', '--sort=path', ...vcsExcludeArgs()];
  if (mode === GrepMode.FILES_WITH_MATCHES) {
    args.push('-l');
  } else if (mode === GrepMode.COUNT) {
    args.push('--count-matches', '--with-filename');
  } else {
    args.push('--max-columns', String(RG_MAX_COLUMNS), '--with-filename', '--null', '-n');
  }
  if (value.caseInsensitive) args.push('-i');
  if (value.include !== undefined && value.include.length > 0) {
    validateText(value.include, 'include', MAX_PATTERN_BYTES);
    args.push('--glob', value.include);
  }
  args.push('--', pattern, searchPath);
  const run = await runRg(args, value.cwd, signal);
  checkSignal(signal);
  const error = rgError(run);
  if (error !== undefined && run.stdout.length === 0) throw error;
  const lines = completeLines(run.stdout, run.truncated);
  const reason = searchReason(run);
  if (mode === GrepMode.FILES_WITH_MATCHES) {
    return {
      path: searchPath,
      matches: [],
      files: lines.slice(skip, skip + limit),
      counts: [],
      truncated: run.truncated || lines.length > skip + limit,
      ...(reason === undefined ? {} : { reason }),
    };
  }
  if (mode === GrepMode.COUNT) {
    const counts = lines.slice(skip, skip + limit).map((line) => {
      const separator = line.lastIndexOf(':');
      const count = separator >= 0 ? Number.parseInt(line.slice(separator + 1), 10) : Number.NaN;
      return {
        file: separator >= 0 ? line.slice(0, separator) : line,
        count: BigInt(Number.isFinite(count) ? count : 0),
      };
    });
    return {
      path: searchPath,
      matches: [],
      files: [],
      counts,
      truncated: run.truncated || lines.length > skip + limit,
      ...(reason === undefined ? {} : { reason }),
    };
  }
  const matches = lines.slice(skip, skip + limit).map((line) => {
    const separator = line.indexOf('\0');
    if (separator < 0) return { file: '', line: 0, text: line };
    const file = line.slice(0, separator);
    const rest = line.slice(separator + 1);
    const match = /^(\d+):([\s\S]*)$/.exec(rest);
    if (match === null) return { file, line: 0, text: rest };
    return { file, line: Number.parseInt(match[1] ?? '0', 10), text: match[2] ?? '' };
  });
  return {
    path: searchPath,
    matches,
    files: [],
    counts: [],
    truncated: run.truncated || lines.length > skip + limit,
    ...(reason === undefined ? {} : { reason }),
  };
}
