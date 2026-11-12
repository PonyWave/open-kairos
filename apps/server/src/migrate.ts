import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkDatabaseFile, upgradeDatabaseFile } from './storage/upgrades.js';

try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'data-dir': { type: 'string' },
      'backup-dir': { type: 'string' },
      check: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  if (!values['data-dir'] || !values['backup-dir']) {
    throw new Error(
      'Usage: node apps/server/dist/migrate.js --data-dir <dir> --backup-dir <dir> [--check]',
    );
  }
  const dataDirectory = resolve(values['data-dir']);
  const backupDirectory = resolve(values['backup-dir']);
  const databasePath = resolve(dataDirectory, 'kairos.sqlite');
  const result = values.check
    ? checkDatabaseFile(databasePath)
    : await upgradeDatabaseFile({ dataDirectory, backupDirectory });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
