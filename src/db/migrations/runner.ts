import type { SQLiteDatabase } from 'expo-sqlite';
import type { MigrationRow } from '../types';

export interface Migration {
  id: number;
  name: string;
  up: (db: SQLiteDatabase) => Promise<void>;
  upSync?: (db: SQLiteDatabase) => void;
}

export interface MigrationResult {
  appliedCount: number;
  appliedIds: number[];
  allApplied: MigrationRow[];
}

export const CREATE_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS migrations (
  id INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

export const DROP_ALL_TABLES_SQL = `
DROP TABLE IF EXISTS person_photos_excluded;
DROP TABLE IF EXISTS exports;
DROP TABLE IF EXISTS faces;
DROP TABLE IF EXISTS people;
DROP TABLE IF EXISTS photos;
DROP TABLE IF EXISTS trips;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS migrations;
`;

/**
 * Returns all applied migrations ordered by ID ascending.
 */
export async function getAppliedMigrations(
  db: SQLiteDatabase
): Promise<MigrationRow[]> {
  await db.execAsync(CREATE_MIGRATIONS_TABLE_SQL);
  return await db.getAllAsync<MigrationRow>(
    'SELECT id, name, applied_at FROM migrations ORDER BY id ASC;'
  );
}

/**
 * Synchronously returns all applied migrations ordered by ID ascending.
 */
export function getAppliedMigrationsSync(
  db: SQLiteDatabase
): MigrationRow[] {
  db.execSync(CREATE_MIGRATIONS_TABLE_SQL);
  return db.getAllSync<MigrationRow>(
    'SELECT id, name, applied_at FROM migrations ORDER BY id ASC;'
  );
}

/**
 * Runs all pending migrations against the SQLite database within transactions.
 *
 * @param db Active SQLite database connection
 * @param migrationList List of migrations to evaluate and run
 */
export async function runMigrations(
  db: SQLiteDatabase,
  migrationList: Migration[]
): Promise<MigrationResult> {
  await db.execAsync(CREATE_MIGRATIONS_TABLE_SQL);

  const appliedRows = await db.getAllAsync<MigrationRow>(
    'SELECT id, name, applied_at FROM migrations ORDER BY id ASC;'
  );
  const appliedMap = new Map<number, MigrationRow>();
  for (const row of appliedRows) {
    appliedMap.set(row.id, row);
  }

  // Verify consistency of already applied migrations
  for (const m of migrationList) {
    const recorded = appliedMap.get(m.id);
    if (recorded && recorded.name !== m.name) {
      console.warn(
        `[runMigrations] Migration id ${m.id} mismatch: applied as '${recorded.name}' but registered as '${m.name}'`
      );
    }
  }

  const pending = migrationList
    .filter((m) => !appliedMap.has(m.id))
    .sort((a, b) => a.id - b.id);

  const appliedIds: number[] = [];

  for (const migration of pending) {
    await db.withTransactionAsync(async () => {
      await migration.up(db);
      const now = Date.now();
      await db.runAsync(
        'INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?);',
        [migration.id, migration.name, now]
      );
      appliedMap.set(migration.id, {
        id: migration.id,
        name: migration.name,
        applied_at: now,
      });
      appliedIds.push(migration.id);
    });
  }

  const allApplied = Array.from(appliedMap.values()).sort((a, b) => a.id - b.id);
  return {
    appliedCount: appliedIds.length,
    appliedIds,
    allApplied,
  };
}

/**
 * Synchronously runs all pending migrations against the SQLite database within transactions.
 *
 * @param db Active SQLite database connection
 * @param migrationList List of migrations to evaluate and run
 */
export function runMigrationsSync(
  db: SQLiteDatabase,
  migrationList: Migration[]
): MigrationResult {
  db.execSync(CREATE_MIGRATIONS_TABLE_SQL);

  const appliedRows = db.getAllSync<MigrationRow>(
    'SELECT id, name, applied_at FROM migrations ORDER BY id ASC;'
  );
  const appliedMap = new Map<number, MigrationRow>();
  for (const row of appliedRows) {
    appliedMap.set(row.id, row);
  }

  for (const m of migrationList) {
    const recorded = appliedMap.get(m.id);
    if (recorded && recorded.name !== m.name) {
      console.warn(
        `[runMigrationsSync] Migration id ${m.id} mismatch: applied as '${recorded.name}' but registered as '${m.name}'`
      );
    }
  }

  const pending = migrationList
    .filter((m) => !appliedMap.has(m.id))
    .sort((a, b) => a.id - b.id);

  const appliedIds: number[] = [];

  for (const migration of pending) {
    db.withTransactionSync(() => {
      if (!migration.upSync) {
        throw new Error(
          `Migration ${migration.name} does not provide synchronous runner upSync`
        );
      }
      migration.upSync(db);
      const now = Date.now();
      db.runSync(
        'INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?);',
        [migration.id, migration.name, now]
      );
      appliedMap.set(migration.id, {
        id: migration.id,
        name: migration.name,
        applied_at: now,
      });
      appliedIds.push(migration.id);
    });
  }

  const allApplied = Array.from(appliedMap.values()).sort((a, b) => a.id - b.id);
  return {
    appliedCount: appliedIds.length,
    appliedIds,
    allApplied,
  };
}

/**
 * Drops all application tables and migrations, then re-runs migrations.
 * Implements the database reset portion of PRD §4 / Schema §4.5 ("Reset all data").
 */
export async function resetDatabase(
  db: SQLiteDatabase,
  migrationList: Migration[]
): Promise<MigrationResult> {
  await db.execAsync(DROP_ALL_TABLES_SQL);
  return await runMigrations(db, migrationList);
}

/**
 * Synchronously drops all application tables and migrations, then re-runs migrations.
 */
export function resetDatabaseSync(
  db: SQLiteDatabase,
  migrationList: Migration[]
): MigrationResult {
  db.execSync(DROP_ALL_TABLES_SQL);
  return runMigrationsSync(db, migrationList);
}
