import * as SQLite from 'expo-sqlite';

export const DB_NAME = 'tripphotosorter.db';

let dbInstance: SQLite.SQLiteDatabase | null = null;

/**
 * Opens a SQLite database instance and configures WAL mode and foreign key constraints.
 *
 * @param dbName Database name or ':memory:' for tests
 */
export async function openDb(dbName: string = DB_NAME): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(dbName);
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync('PRAGMA foreign_keys = ON;');
  return db;
}

/**
 * Synchronously opens a SQLite database instance and configures WAL mode and foreign key constraints.
 *
 * @param dbName Database name or ':memory:' for tests
 */
export function openDbSync(dbName: string = DB_NAME): SQLite.SQLiteDatabase {
  const db = SQLite.openDatabaseSync(dbName);
  db.execSync('PRAGMA journal_mode = WAL;');
  db.execSync('PRAGMA foreign_keys = ON;');
  return db;
}

/**
 * Returns the singleton database instance for the application (async).
 */
export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!dbInstance) {
    dbInstance = await openDb(DB_NAME);
  }
  return dbInstance;
}

/**
 * Returns the singleton database instance for the application (sync).
 */
export function getDatabaseSync(): SQLite.SQLiteDatabase {
  if (!dbInstance) {
    dbInstance = openDbSync(DB_NAME);
  }
  return dbInstance;
}

/**
 * Sets the active singleton database instance (useful for testing with in-memory or mock DBs).
 */
export function setDatabaseInstance(db: SQLite.SQLiteDatabase | null): void {
  dbInstance = db;
}

/**
 * Closes the active singleton database connection if open.
 */
export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.closeSync();
    } catch (err) {
      console.warn('[closeDatabase] Error closing database:', err);
    }
    dbInstance = null;
  }
}
