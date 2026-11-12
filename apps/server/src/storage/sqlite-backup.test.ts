import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('advances repeated native backups in an otherwise idle process and releases its wakeup timer on success and failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kairos-backup-progress-'));
  const script = join(directory, 'backup.mjs');
  try {
    writeFileSync(
      script,
      `
      import { DatabaseSync } from 'node:sqlite';
      import { join } from 'node:path';
      import { backupDatabase } from ${JSON.stringify(new URL('./sqlite-backup.ts', import.meta.url).href)};
      const deadline = setTimeout(() => process.exit(2), 2000);
      const source = new DatabaseSync(':memory:');
      source.exec("CREATE TABLE data(value TEXT); INSERT INTO data VALUES ('retained');");
      for (let index = 0; index < 2; index += 1) {
        const path = join(process.argv[2], 'backup-' + index + '.sqlite');
        await backupDatabase(source, path);
        const saved = new DatabaseSync(path, { readOnly: true });
        if (saved.prepare('SELECT value FROM data').get()?.value !== 'retained') process.exit(3);
        saved.close();
      }
      source.close();
      let rejected = false;
      try { await backupDatabase(source, join(process.argv[2], 'closed.sqlite')); }
      catch { rejected = true; }
      if (!rejected) process.exit(4);
      clearTimeout(deadline);
      process.stdout.write('completed');
    `,
    );
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, directory], {
      encoding: 'utf8',
      timeout: 4000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('completed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
