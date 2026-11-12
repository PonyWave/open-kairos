import { expect, it } from 'vitest';
import { seedTestSession } from '../integration/test-authentication.js';
import { openDatabase } from '../storage/database.js';
import { ensureTenantPlatformEnvironment } from './registry.js';

it('creates one logical tenant workspace transactionally without pairing, usage or default-device changes', () => {
  const db = openDatabase(':memory:');
  try {
    seedTestSession(db, 'tenant-1', 'session');
    const before = db
      .prepare('SELECT default_env_id FROM tenants WHERE tenant_id=?')
      .get('tenant-1');
    db.exec('BEGIN IMMEDIATE');
    const env = ensureTenantPlatformEnvironment(db, 'tenant-1');
    expect(ensureTenantPlatformEnvironment(db, 'tenant-1')).toBe(env);
    db.exec('ROLLBACK');
    const committed = ensureTenantPlatformEnvironment(db, 'tenant-1');
    expect(ensureTenantPlatformEnvironment(db, 'tenant-1')).toBe(committed);
    expect(
      db
        .prepare('SELECT kind,platform_lifecycle_state FROM environments WHERE env_id=?')
        .get(committed),
    ).toMatchObject({ kind: 'platform_sandbox', platform_lifecycle_state: 'uninitialized' });
    expect(
      db.prepare('SELECT default_env_id FROM tenants WHERE tenant_id=?').get('tenant-1'),
    ).toEqual(before);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM environment_pairing_credentials').get(),
    ).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM platform_usage_intents').get()).toMatchObject({
      n: 0,
    });
    expect(() => ensureTenantPlatformEnvironment(db, 'absent')).toThrowError(
      expect.objectContaining({ code: 'not_found' }),
    );
  } finally {
    db.close();
  }
});
