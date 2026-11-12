import { DatabaseSync } from 'node:sqlite';
import { DeviceErrorCode } from '@kairos/contracts/device';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceStore } from './device-store.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function seedDevice(database: DatabaseSync, ownerId: string, deviceId = 'historical-device') {
  database
    .prepare(
      `INSERT INTO devices(
        device_id, owner_id, device_name, account_description, bash_enabled,
        credential_hash, status, created_at, updated_at, paired_at
      ) VALUES (?, ?, 'Historical device', 'Audit fixture', 0, NULL, 'active', ?, ?, ?)`,
    )
    .run(
      deviceId,
      ownerId,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
  return deviceId;
}

describe('historical device audit reader', () => {
  it('reads retained devices only for their owner without creating credentials', () => {
    const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    databases.push(database);
    const store = new DeviceStore(database);
    const deviceId = seedDevice(database, 'owner-1');
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
});
