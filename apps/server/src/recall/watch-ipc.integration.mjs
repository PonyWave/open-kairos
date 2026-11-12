import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  DEFAULT_SQL_RECALL_LIMITS,
  recallWorkerResponseSchema,
  sqlRecallResultSchema,
} from '../../dist/recall/types.js';
import { SessionStore } from '../../dist/sessions/store.js';
import { openDatabase } from '../../dist/storage/database.js';

const executorPath = fileURLToPath(
  new URL('../../dist/recall/executor-process.js', import.meta.url),
);

const watchReportSchema = z.discriminatedUnion('ok', [
  z.object({
    kairosRecallWatchReport: z.literal(true),
    ok: z.literal(true),
    results: z.array(sqlRecallResultSchema).length(4),
    queryError: z.object({ code: z.string(), message: z.string() }),
    activeProcessCount: z.number().int().nonnegative(),
    watchImportCount: z.number().int().nonnegative(),
  }),
  z.object({
    kairosRecallWatchReport: z.literal(true),
    ok: z.literal(false),
    failure: z.string(),
    watchImportCount: z.number().int().nonnegative(),
  }),
]);

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const forceKill = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.kill('SIGTERM');
  await exited;
  clearTimeout(forceKill);
}

function send(child, message) {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function receive(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the executor response.'));
    }, 10_000);
    const onMessage = (message) => {
      if (
        message !== null &&
        typeof message === 'object' &&
        (Array.isArray(message['watch:import']) || Array.isArray(message['watch:require']))
      ) {
        return;
      }
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Executor exited with code ${code} and signal ${signal}.`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function forkExecutor() {
  return fork(executorPath, {
    execArgv: [],
    serialization: 'json',
    silent: true,
    env: { ...process.env, WATCH_REPORT_DEPENDENCIES: '' },
  });
}

const directory = await mkdtemp(join(tmpdir(), 'kairos-recall-watch-'));
const databaseDirectory = await mkdtemp(join(tmpdir(), 'kairos-recall-watch-db-'));
const databasePath = join(databaseDirectory, 'watch.sqlite');
const setup = openDatabase(databasePath);
new SessionStore(setup);
setup.close();
const authorization = {
  scope: { threadId: 'thread-main', agentId: 'thread' },
  currentRunId: 'watch-run',
  includeDescendants: false,
  visibility: 'self',
};
const executorInput = (sql) => ({
  sql,
  limits: DEFAULT_SQL_RECALL_LIMITS,
  databasePath,
  authorization,
});

async function checkExecutorControls() {
  for (const control of [
    { 'watch:import': ['file:///tmp/recall-executor.js'] },
    { 'watch:require': [null] },
  ]) {
    const child = forkExecutor();
    try {
      const response = receive(child);
      await send(child, control);
      await send(child, executorInput('SELECT 1 AS value'));
      assert.deepStrictEqual(recallWorkerResponseSchema.parse(await response), {
        ok: true,
        result: { columns: ['value'], rows: [[1]], truncated: false },
      });
    } finally {
      await terminate(child);
    }
  }

  const child = forkExecutor();
  try {
    const response = receive(child);
    await send(child, { 'watch:import': ['file:///tmp/recall-executor.js'] });
    await send(child, { sql: 'SELECT 1' });
    const result = recallWorkerResponseSchema.parse(await response);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('The invalid executor input unexpectedly succeeded.');
    assert.equal(result.error.code, 'invalid_query');
  } finally {
    await terminate(child);
  }
}

await checkExecutorControls();
console.info('SQL recall executor watch IPC checks passed: import, require and invalid input.');

let child;
try {
  const queries = [
    "SELECT COUNT(*) AS total_messages, SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_messages, SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistant_messages, SUM(CASE WHEN role NOT IN ('user', 'assistant') THEN 1 ELSE 0 END) AS other_role_messages, MIN(seq) AS first_seq, MAX(seq) AS latest_seq FROM context WHERE thread_id = 'thread-main';",
    "SELECT COUNT(*) AS total_messages FROM context WHERE thread_id = 'thread-main'",
    "SELECT seq, role FROM context WHERE thread_id = 'thread-main' ORDER BY seq",
    'SELECT seq, role, length(content) AS content_length FROM context ORDER BY seq LIMIT 20',
  ];
  const driver = `
    import { fork } from 'node:child_process';
    import { once } from 'node:events';
    import { openDatabase } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../../dist/storage/database.js', import.meta.url))).href)};
    import { ContextStore } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../../dist/context/context-store.js', import.meta.url))).href)};
    import { SqlRecallEngine } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../../dist/recall/engine.js', import.meta.url))).href)};
    import { DEFAULT_SQL_RECALL_LIMITS, RecallError, recallWorkerResponseSchema } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../../dist/recall/types.js', import.meta.url))).href)};

    const database = openDatabase(${JSON.stringify(databasePath)});
    let report;
    let watchImportCount = 0;
    try {
      if (process.env.WATCH_REPORT_DEPENDENCIES !== '1') throw new Error('The driver is not running under node --watch.');
      const probe = fork(${JSON.stringify(fileURLToPath(new URL('../../dist/recall/executor-process.js', import.meta.url)))}, {
        execArgv: [],
        serialization: 'json',
        silent: true,
      });
      probe.stderr?.setEncoding('utf8');
      let probeDiagnostics = '';
      probe.stderr?.on('data', (chunk) => { probeDiagnostics = (probeDiagnostics + chunk).slice(-65536); });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error('Timed out waiting for the watch probe response after ' + watchImportCount + ' imports. ' + probeDiagnostics));
          }, 10000);
          const onMessage = (message) => {
            if (message !== null && typeof message === 'object' && Array.isArray(message['watch:import'])) {
              watchImportCount += 1;
              return;
            }
            if (message === null || typeof message !== 'object' || typeof message.ok !== 'boolean') return;
            try {
              const response = recallWorkerResponseSchema.parse(message);
              if (!response.ok) throw new Error('The watch probe failed: ' + response.error.message);
              const expected = { columns: ['value'], rows: [[1]], truncated: false };
              if (JSON.stringify(response.result) !== JSON.stringify(expected)) throw new Error('The watch probe returned an unexpected result.');
              cleanup();
              resolve();
            } catch (error) {
              cleanup();
              reject(error);
            }
          };
          const onError = (error) => {
            cleanup();
            reject(error);
          };
          const onExit = (code, signal) => {
            cleanup();
            reject(new Error('Probe exited with code ' + code + ' and signal ' + signal + '. ' + probeDiagnostics));
          };
          const cleanup = () => {
            clearTimeout(timer);
            probe.off('message', onMessage);
            probe.off('error', onError);
            probe.off('exit', onExit);
          };
          probe.on('message', onMessage);
          probe.once('error', onError);
          probe.once('exit', onExit);
          probe.send({
            sql: 'SELECT 1 AS value',
            limits: DEFAULT_SQL_RECALL_LIMITS,
            databasePath: ${JSON.stringify(databasePath)},
            authorization: ${JSON.stringify(authorization)},
          }, (error) => {
            if (error) {
              cleanup();
              reject(error);
            }
          });
        });
      } finally {
        if (probe.exitCode === null && probe.signalCode === null) {
          const exited = once(probe, 'exit');
          const forceKill = setTimeout(() => probe.kill('SIGKILL'), 5000);
          probe.kill('SIGTERM');
          await exited;
          clearTimeout(forceKill);
        }
      }
      database.prepare("INSERT INTO threads(thread_id, owner_id, title, thread_type, created_at, updated_at) VALUES ('thread-main', 'owner', 'Watch', 'main', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z')").run();
      const context = new ContextStore(database);
      context.append({ threadId: 'thread-main', agentId: 'thread', message: { role: 'user', content: 'user message' } });
      context.append({ threadId: 'thread-main', agentId: 'thread', message: { role: 'assistant', content: 'assistant message' } });
      const engine = new SqlRecallEngine(database, ${JSON.stringify(authorization)});
      const results = [];
      for (const sql of ${JSON.stringify(queries)}) results.push(await engine.execute(sql));
      const queryError = await engine.execute('SELECT missing_column FROM context').then(
        () => { throw new Error('The invalid query unexpectedly succeeded.'); },
        (error) => {
          if (!(error instanceof RecallError)) throw error;
          return { code: error.code, message: error.message };
        },
      );
      report = { kairosRecallWatchReport: true, ok: true, results, queryError, activeProcessCount: engine.activeProcessCount, watchImportCount };
    } catch (error) {
      report = { kairosRecallWatchReport: true, ok: false, failure: error instanceof Error ? error.stack : String(error), watchImportCount };
    } finally {
      database.close();
    }
    process.stdout.write('KAIROS_RECALL_WATCH_REPORT ' + JSON.stringify(report) + String.fromCharCode(10));
  `;
  const driverPath = join(directory, 'driver.mjs');
  await writeFile(driverPath, driver, 'utf8');
  child = spawn(process.execPath, ['--watch', `--watch-path=${directory}`, driverPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  let diagnostics = '';
  let stdout = '';
  const captureOutput = (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-65_536);
  };
  child.stderr.on('data', captureOutput);
  const reportPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for the watch report.\n${diagnostics}`));
    }, 15_000);
    const onStdout = (chunk) => {
      captureOutput(chunk);
      stdout = (stdout + chunk).slice(-65_536);
      const marker = 'KAIROS_RECALL_WATCH_REPORT ';
      const start = stdout.indexOf(marker);
      if (start < 0) return;
      const end = stdout.indexOf('\n', start);
      if (end < 0) return;
      cleanup();
      try {
        resolve(JSON.parse(stdout.slice(start + marker.length, end)));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Watch exited with code ${code} and signal ${signal}.\n${diagnostics}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onStdout);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  const report = watchReportSchema.parse(await reportPromise);
  if (!report.ok) throw new Error(report.failure);
  assert.deepStrictEqual(report.results, [
    {
      columns: [
        'total_messages',
        'user_messages',
        'assistant_messages',
        'other_role_messages',
        'first_seq',
        'latest_seq',
      ],
      rows: [[2, 1, 1, 0, 1, 2]],
      truncated: false,
    },
    { columns: ['total_messages'], rows: [[2]], truncated: false },
    {
      columns: ['seq', 'role'],
      rows: [
        [1, 'user'],
        [2, 'assistant'],
      ],
      truncated: false,
    },
    {
      columns: ['seq', 'role', 'content_length'],
      rows: [
        [1, 'user', 12],
        [2, 'assistant', 17],
      ],
      truncated: false,
    },
  ]);
  assert.equal(report.queryError.code, 'invalid_query');
  assert.equal(report.activeProcessCount, 0);
  assert.ok(report.watchImportCount > 0, 'The watch run did not report any watch:import messages.');
  console.info(
    `SQL recall node --watch integration passed: 4 queries, invalid_query, ${report.watchImportCount} watch:import messages.`,
  );
} finally {
  if (child) await terminate(child);
  await rm(directory, { recursive: true, force: true });
  await rm(databaseDirectory, { recursive: true, force: true });
}
