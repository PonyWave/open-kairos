import { backup, type DatabaseSync } from 'node:sqlite';

/** Native backup can wait for another event-loop turn without scheduling a wakeup. */
export async function backupDatabase(database: DatabaseSync, path: string): Promise<number> {
  const progress = setInterval(() => undefined, 10);
  try {
    return await backup(database, path);
  } finally {
    clearInterval(progress);
  }
}
