import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  checkPlatformControlDatabaseFile,
  migratePlatformControlDatabaseFile,
} from './control-migration.js';

export async function runPlatformControlMigration(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      path: { type: 'string' },
      'backup-dir': { type: 'string' },
      check: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  if (!values.path || (!values.check && !values['backup-dir']))
    throw new Error(
      'Stop all Servers sharing the control database, then run: node apps/server/dist/platform/migrate.js --path <control.sqlite> --backup-dir <dir> [--check]',
    );
  const path = resolve(values.path);
  const result = values.check
    ? await checkPlatformControlDatabaseFile(path)
    : await migratePlatformControlDatabaseFile({
        path,
        backupDirectory: resolve(values['backup-dir'] ?? ''),
      });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runPlatformControlMigration(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
