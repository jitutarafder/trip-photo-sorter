import type { SQLiteDatabase } from 'expo-sqlite';
import { migration001 } from './001_init';
import {
  Migration,
  MigrationResult,
  runMigrations as runMigrationsWithList,
  runMigrationsSync as runMigrationsSyncWithList,
  resetDatabase as resetDatabaseWithList,
  resetDatabaseSync as resetDatabaseSyncWithList,
  getAppliedMigrations,
  getAppliedMigrationsSync,
  CREATE_MIGRATIONS_TABLE_SQL,
  DROP_ALL_TABLES_SQL,
} from './runner';

export type { Migration, MigrationResult };
export {
  getAppliedMigrations,
  getAppliedMigrationsSync,
  CREATE_MIGRATIONS_TABLE_SQL,
  DROP_ALL_TABLES_SQL,
};
export * from './001_init';

/**
 * All registered migrations in ascending execution order.
 * Append-only per docs/05_Schema.md §4: never edit an applied migration.
 */
export const migrations: Migration[] = [migration001];

/**
 * Runs all registered pending migrations on the given database.
 */
export async function runMigrations(
  db: SQLiteDatabase,
  migrationList: Migration[] = migrations
): Promise<MigrationResult> {
  return runMigrationsWithList(db, migrationList);
}

/**
 * Synchronously runs all registered pending migrations on the given database.
 */
export function runMigrationsSync(
  db: SQLiteDatabase,
  migrationList: Migration[] = migrations
): MigrationResult {
  return runMigrationsSyncWithList(db, migrationList);
}

/**
 * Drops all tables and re-runs all registered migrations.
 */
export async function resetDatabase(
  db: SQLiteDatabase,
  migrationList: Migration[] = migrations
): Promise<MigrationResult> {
  return resetDatabaseWithList(db, migrationList);
}

/**
 * Synchronously drops all tables and re-runs all registered migrations.
 */
export function resetDatabaseSync(
  db: SQLiteDatabase,
  migrationList: Migration[] = migrations
): MigrationResult {
  return resetDatabaseSyncWithList(db, migrationList);
}
