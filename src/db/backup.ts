import { Platform } from 'react-native';
import { Paths } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { setExcludedFromBackup, isExcludedFromBackup } from 'apple-vision';
import { DB_NAME } from './client';

/**
 * Returns the directory path where expo-sqlite stores SQLite database files.
 */
export function getDatabaseDirectory(): string {
  let docDir = '';
  try {
    if (Paths?.document?.uri) {
      docDir = Paths.document.uri;
    }
  } catch {
    // Paths not available in test or legacy environment
  }
  if (!docDir && LegacyFileSystem?.documentDirectory) {
    docDir = LegacyFileSystem.documentDirectory;
  }
  const cleanDir = docDir.endsWith('/') ? docDir : `${docDir}/`;
  return `${cleanDir}SQLite/`;
}

/**
 * Returns the full path to the given SQLite database file.
 */
export function getDatabasePath(dbName: string = DB_NAME): string {
  return `${getDatabaseDirectory()}${dbName}`;
}

/**
 * Excludes the SQLite database directory and database file from iCloud and iTunes backup
 * by setting NSURLIsExcludedFromBackupKey on iOS (04_TRD §6, 05_Schema §4.6).
 *
 * @param dbName Name of the database file (defaults to DB_NAME)
 * @returns boolean indicating whether the operation succeeded
 */
export async function excludeDatabaseFromBackup(
  dbName: string = DB_NAME
): Promise<boolean> {
  if (Platform.OS !== 'ios') {
    // Non-iOS platforms do not use iCloud/iTunes backups
    return true;
  }

  const dbDir = getDatabaseDirectory();
  const dbPath = getDatabasePath(dbName);

  try {
    // 1. Exclude the entire SQLite directory (recursively excludes all DB files, -wal, -shm)
    const dirSuccess = await setExcludedFromBackup(dbDir);

    // 2. Also explicitly exclude the main DB file
    const fileSuccess = await setExcludedFromBackup(dbPath);

    return dirSuccess || fileSuccess;
  } catch (err) {
    console.warn('[excludeDatabaseFromBackup] Failed to set backup exclusion:', err);
    return false;
  }
}

/**
 * Verifies whether the SQLite database directory or file is excluded from backup.
 *
 * @param dbName Name of the database file (defaults to DB_NAME)
 * @returns boolean indicating whether backup exclusion is active
 */
export async function isDatabaseExcludedFromBackup(
  dbName: string = DB_NAME
): Promise<boolean> {
  if (Platform.OS !== 'ios') {
    return true;
  }

  const dbDir = getDatabaseDirectory();
  const dbPath = getDatabasePath(dbName);

  try {
    const fileExcluded = await isExcludedFromBackup(dbPath);
    if (fileExcluded) {
      return true;
    }
    const dirExcluded = await isExcludedFromBackup(dbDir);
    return dirExcluded;
  } catch (err) {
    console.warn('[isDatabaseExcludedFromBackup] Failed to verify backup exclusion:', err);
    return false;
  }
}
