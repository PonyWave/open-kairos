import type { DatabaseSync } from 'node:sqlite';
import { DeviceErrorCode } from '@kairos/contracts/device';
import { z } from 'zod';
import { deviceMigrations } from '../storage/device-migrations.js';
import { migrateDatabase } from '../storage/migrations.js';
import { assertServerDatabaseCompatible } from '../storage/server-schema.js';
import { DeviceFailure } from './errors.js';

export { deviceMigrations } from '../storage/device-migrations.js';

const deviceRowSchema = z.object({
  device_id: z.string(),
  owner_id: z.string(),
  device_name: z.string(),
  account_description: z.string(),
  bash_enabled: z.number().int().min(0).max(1),
  credential_hash: z.string().nullable(),
  status: z.enum(['pairing', 'active', 'revoked']),
  created_at: z.string(),
  updated_at: z.string(),
  paired_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  last_seen_at: z.string().nullable(),
});

export type DeviceStatus = 'pairing' | 'active' | 'revoked';

export interface DeviceRecord {
  deviceId: string;
  ownerId: string;
  deviceName: string;
  accountDescription: string;
  bashEnabled: boolean;
  status: DeviceStatus;
  createdAt: string;
  updatedAt: string;
  pairedAt?: string;
  revokedAt?: string;
  lastSeenAt?: string;
}

type DeviceRow = z.infer<typeof deviceRowSchema>;

function toDevice(row: DeviceRow): DeviceRecord {
  return {
    deviceId: row.device_id,
    ownerId: row.owner_id,
    deviceName: row.device_name,
    accountDescription: row.account_description,
    bashEnabled: row.bash_enabled === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.paired_at === null ? {} : { pairedAt: row.paired_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
  };
}

function readDevice(database: DatabaseSync, deviceId: string): DeviceRow | undefined {
  const row = database.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
  return row === undefined ? undefined : deviceRowSchema.parse(row);
}

export class DeviceStore {
  constructor(readonly database: DatabaseSync) {
    assertServerDatabaseCompatible(database);
    migrateDatabase(database, deviceMigrations, 'devices');
  }

  getForOwner(ownerId: string, deviceId: string): DeviceRecord {
    const row = readDevice(this.database, deviceId);
    if (row === undefined || row.owner_id !== ownerId) {
      throw new DeviceFailure(
        DeviceErrorCode.PERMISSION_DENIED,
        'Device is not available to this owner.',
      );
    }
    return toDevice(row);
  }

  listForOwner(ownerId: string): DeviceRecord[] {
    const rows = this.database
      .prepare('SELECT * FROM devices WHERE owner_id = ? ORDER BY created_at, device_id')
      .all(ownerId);
    return rows.map((row) => toDevice(deviceRowSchema.parse(row)));
  }
}
