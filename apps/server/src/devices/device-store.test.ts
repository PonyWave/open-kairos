import { DatabaseSync } from 'node:sqlite';
import { DeviceErrorCode } from '@kairos/contracts/device';
import { afterEach, describe, expect, it } from 'vitest';
import { seedHistoricalDevice } from '../integration/device-audit-fixture.js';
import { DeviceStore } from './device-store.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('historical device audit reader', () => {
  it('reads retained devices only for their owner without creating credentials', () => {
    const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    databases.push(database);
    const store = new DeviceStore(database);
    const deviceId = seedHistoricalDevice(database, 'owner-1');
    expect(store.getForOwner('owner-1', deviceId)).toMatchObject({
      deviceId,
      ownerId: 'owner-1',
      bashEnabled: false,
    });
    expect(store.listForOwner('owner-1')).toHaveLength(1);
    expect(store.listForOwner('owner-2')).toEqual([]);
    expect(() => store.getForOwner('owner-2', deviceId)).toThrowError(
      expect.objectContaining({ code: DeviceErrorCode.PERMISSION_DENIED }),
    );
    expect(Object.getOwnPropertyNames(DeviceStore.prototype)).toEqual([
      'constructor',
      'getForOwner',
      'listForOwner',
    ]);
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM device_pairing_credentials').get(),
    ).toEqual({ count: 0 });
  });

  it('rejects an outdated namespace before installing historical tables', () => {
    const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    databases.push(database);
    database.exec(
      'CREATE TABLE schema_migrations (namespace TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY(namespace, version))',
    );
    database.exec(
      "INSERT INTO schema_migrations VALUES ('server_runtime', 1, 'old', '2026-01-01')",
    );
    expect(() => new DeviceStore(database)).toThrow();
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'devices'").get(),
    ).toBeUndefined();
  });
});
