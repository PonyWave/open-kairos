import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DeviceCapability } from '@kairos/contracts/device';
import { requireText, SessionError } from '../sessions/errors.js';

/** Creates only a logical environment inside the caller's business transaction. */
export function ensureTenantPlatformEnvironment(
  database: DatabaseSync,
  tenantId: string,
  createdAt = new Date(),
): string {
  requireText(tenantId, 'tenantId', 200);
  const now = createdAt.toISOString();
  const tenant = database
    .prepare('SELECT tenant_id FROM tenants WHERE tenant_id = ?')
    .get(tenantId);
  if (!tenant)
    throw new SessionError('not_found', 'The platform environment tenant does not exist.');
  const existing = database
    .prepare('SELECT env_id FROM platform_environments WHERE tenant_id = ?')
    .get(tenantId);
  if (existing && typeof existing.env_id === 'string') return existing.env_id;
  const ownTransaction = !database.isTransaction;
  if (ownTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    const concurrent = database
      .prepare('SELECT env_id FROM platform_environments WHERE tenant_id = ?')
      .get(tenantId);
    if (concurrent && typeof concurrent.env_id === 'string') {
      if (ownTransaction) database.exec('COMMIT');
      return concurrent.env_id;
    }
    const envId = randomUUID();
    const capabilities = JSON.stringify([
      DeviceCapability.BASH,
      DeviceCapability.FILE_READ,
      DeviceCapability.FILE_WRITE,
      DeviceCapability.FILE_EDIT,
      DeviceCapability.DIRECTORY_CHECK,
      DeviceCapability.DIRECTORY_LIST,
    ]);
    database
      .prepare(`INSERT INTO environments(
      env_id,tenant_id,name,kind,recommended_pwd,binding_status,connection_status,capability_status,directory_status,
      authorized_capabilities_json,granted_capabilities_json,created_at,updated_at,auto_detect,settings_version,platform_lifecycle_state
    ) VALUES (?,?,'平台工作区','platform_sandbox','/workspace','pairing','offline','pending','pending',?,'[]',?,?,0,'1','uninitialized')`)
      .run(envId, tenantId, capabilities, now, now);
    database
      .prepare(
        'INSERT INTO platform_environments(env_id,tenant_id,created_at,updated_at) VALUES (?,?,?,?)',
      )
      .run(envId, tenantId, now, now);
    if (ownTransaction) database.exec('COMMIT');
    return envId;
  } catch (error) {
    if (ownTransaction && database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}
