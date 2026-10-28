import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../client';
import type { SettingRow } from '../types';

async function resolveDb(db?: SQLiteDatabase): Promise<SQLiteDatabase> {
  return db ?? (await getDatabase());
}

/**
 * Retrieves a single setting value by key.
 */
export async function getSetting(
  key: string,
  defaultValue: string | null = null,
  db?: SQLiteDatabase
): Promise<string | null> {
  const database = await resolveDb(db);
  const row = await database.getFirstAsync<SettingRow>(
    'SELECT * FROM settings WHERE key = ?;',
    [key]
  );
  return row ? row.value : defaultValue;
}

/**
 * Sets or updates a key-value setting.
 */
export async function setSetting(
  key: string,
  value: string,
  db?: SQLiteDatabase
): Promise<void> {
  const database = await resolveDb(db);
  await database.runAsync(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    [key, value]
  );
}

/**
 * Returns all settings as a key-value record object.
 */
export async function getAllSettings(
  db?: SQLiteDatabase
): Promise<Record<string, string>> {
  const database = await resolveDb(db);
  const rows = await database.getAllAsync<SettingRow>(
    'SELECT * FROM settings ORDER BY key ASC;'
  );
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

/**
 * Deletes a setting by key.
 */
export async function deleteSetting(
  key: string,
  db?: SQLiteDatabase
): Promise<boolean> {
  const database = await resolveDb(db);
  const result = await database.runAsync(
    'DELETE FROM settings WHERE key = ?;',
    [key]
  );
  return result.changes > 0;
}

/**
 * Checks if onboarding has been completed.
 */
export async function isOnboarded(db?: SQLiteDatabase): Promise<boolean> {
  const val = await getSetting('onboarded', '0', db);
  return val === '1' || val === 'true';
}

/**
 * Sets onboarding completion status.
 */
export async function setOnboarded(
  value: boolean,
  db?: SQLiteDatabase
): Promise<void> {
  await setSetting('onboarded', value ? '1' : '0', db);
}

/**
 * Checks whether user has Pro status unlocked.
 */
export async function isPro(db?: SQLiteDatabase): Promise<boolean> {
  const val = await getSetting('is_pro', '0', db);
  return val === '1' || val === 'true';
}

/**
 * Sets user Pro status.
 */
export async function setPro(
  value: boolean,
  db?: SQLiteDatabase
): Promise<void> {
  await setSetting('is_pro', value ? '1' : '0', db);
}

/**
 * Gets timestamp of last incremental photo library sync.
 */
export async function getLastSyncAt(
  db?: SQLiteDatabase
): Promise<number | null> {
  const val = await getSetting('last_sync_at', null, db);
  return val ? parseInt(val, 10) : null;
}

/**
 * Sets timestamp of last incremental photo library sync.
 */
export async function setLastSyncAt(
  timestamp: number,
  db?: SQLiteDatabase
): Promise<void> {
  await setSetting('last_sync_at', timestamp.toString(), db);
}

/**
 * Gets the current database schema version.
 */
export async function getSchemaVersion(
  db?: SQLiteDatabase
): Promise<string | null> {
  return await getSetting('schema_version', null, db);
}
