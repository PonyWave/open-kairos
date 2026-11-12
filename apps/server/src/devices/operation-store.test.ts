import { DatabaseSync } from 'node:sqlite';
import { BashStatus, DeviceErrorCode, OutputStream } from '@kairos/contracts/device';
import { afterEach, describe, expect, it } from 'vitest';
import {
  seedHistoricalBashOperation,
  seedHistoricalDevice,
} from '../integration/device-audit-fixture.js';
import { DeviceStore } from './device-store.js';
import { DeviceBashStore } from './operation-store.js';

const databases: DatabaseSync[] = [];
function fixture() {
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  databases.push(database);
  new DeviceStore(database);
  const store = new DeviceBashStore(database);
  const deviceId = seedHistoricalDevice(database, 'owner-1');
  return { database, store, deviceId };
}
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('historical Bash audit reader', () => {
  it('retains terminal evidence and lossless output offsets across reopen', () => {
    const { database, store, deviceId } = fixture();
    const offset = BigInt(Number.MAX_SAFE_INTEGER) + 12n;
    seedHistoricalBashOperation(database, {
      operationId: 'audit-operation',
      ownerId: 'owner-1',
      deviceId,
      runId: 'old-run',
      status: BashStatus.UNKNOWN,
      outputComplete: false,
      endOffset: offset + 3n,
      chunks: [{ offset, data: Buffer.from('abc'), stream: OutputStream.STDERR }],
    });
    expect(store.getForOwner('owner-1', 'audit-operation')).toMatchObject({
      status: BashStatus.UNKNOWN,
      endOffset: offset + 3n,
      outputGap: true,
    });
    const reopened = new DeviceBashStore(database);
    const [chunk] = reopened.readOutputForOwner('owner-1', 'audit-operation', offset);
    expect(chunk).toMatchObject({ offset, endOffset: offset + 3n, stream: OutputStream.STDERR });
    expect(Buffer.from(chunk?.data ?? []).toString()).toBe('abc');
    expect(store.find('missing')).toBeUndefined();
  });

  it('enforces audit authorization and query bounds without live mutation methods', () => {
    const { database, store, deviceId } = fixture();
    seedHistoricalBashOperation(database, {
      operationId: 'audit-operation',
      ownerId: 'owner-1',
      deviceId,
      runId: 'old-run',
    });
    expect(() => store.getForOwner('owner-2', 'audit-operation')).toThrowError(
      expect.objectContaining({ code: DeviceErrorCode.PERMISSION_DENIED }),
    );
    expect(() => store.readOutputForOwner('owner-2', 'audit-operation', 0n)).toThrowError(
      expect.objectContaining({ code: DeviceErrorCode.PERMISSION_DENIED }),
    );
    expect(() => store.readOutputForOwner('owner-1', 'audit-operation', -1n)).toThrow();
    expect(() => store.readOutputForOwner('owner-1', 'audit-operation', 0n, 1001)).toThrow();
    expect(Object.getOwnPropertyNames(DeviceBashStore.prototype)).toEqual([
      'constructor',
      'find',
      'getForOwner',
      'readOutputForOwner',
    ]);
  });
});
