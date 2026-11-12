import type { DatabaseSync } from 'node:sqlite';
import { sessionMigrations } from '../sessions/migrations.js';
import { deviceMigrations, environmentOperationMigrations } from './device-migrations.js';
import {
  contextRecapMigrations,
  inspectMigration,
  type Migration,
  type MigrationInspection,
  migrateDatabase,
  SchemaMigrationRequiredError,
} from './migrations.js';

export type ServerNamespace =
  | 'context_recap'
  | 'server_runtime'
  | 'devices'
  | 'environment_operations';

export interface ServerMigrationPlan {
  namespace: ServerNamespace;
  migrations: readonly Migration[];
}

export const serverMigrationPlans: readonly ServerMigrationPlan[] = [
  { namespace: 'context_recap', migrations: contextRecapMigrations },
  { namespace: 'server_runtime', migrations: sessionMigrations },
  { namespace: 'devices', migrations: deviceMigrations },
  { namespace: 'environment_operations', migrations: environmentOperationMigrations },
];

export interface ServerMigrationInspection extends MigrationInspection {
  namespace: ServerNamespace;
}

export function inspectServerDatabase(database: DatabaseSync): ServerMigrationInspection[] {
  return serverMigrationPlans.map((plan) => ({
    namespace: plan.namespace,
    ...inspectMigration(database, plan.migrations, plan.namespace),
  }));
}

export function assertServerDatabaseCompatible(database: DatabaseSync): void {
  const outdated = inspectServerDatabase(database).find(
    (inspection) => inspection.kind === 'upgrade',
  );
  if (outdated) {
    throw new SchemaMigrationRequiredError(
      outdated.namespace,
      outdated.currentVersion,
      outdated.requiredVersion,
    );
  }
}

export function migrateServerDatabase(database: DatabaseSync): void {
  assertServerDatabaseCompatible(database);
  for (const plan of serverMigrationPlans) {
    migrateDatabase(database, plan.migrations, plan.namespace);
  }
}
