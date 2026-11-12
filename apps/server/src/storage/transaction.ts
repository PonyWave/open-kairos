import type { DatabaseSync } from 'node:sqlite';

export function inTransaction<T>(
  database: DatabaseSync,
  work: () => T,
  mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE',
): T {
  if (database.isTransaction) throw new Error('Nested SQLite transactions are not supported.');
  database.exec(`BEGIN ${mode}`);
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'SQLite work and rollback both failed.');
      }
    }
    throw error;
  }
}
