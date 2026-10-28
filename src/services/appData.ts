import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../db/client';
import { resetDatabase } from '../db/migrations';
import { sweepOrphanTempExports } from './exporter';

export interface ResetAppDataResult {
  tablesReset: boolean;
  exportsCleared: boolean;
}

/**
 * Resets all application data to a clean initial state.
 *
 * Rules (05_Schema §4.5, 02_AppFlow §3.9):
 * 1. Drops all tables and re-creates them cleanly via registered migrations.
 * 2. Deletes all temporary export files and clears the exports cache directory.
 */
export async function resetAllAppData(db?: SQLiteDatabase): Promise<ResetAppDataResult> {
  const database = db ?? (await getDatabase());

  // 1. Drop all application tables & re-run all migrations
  await resetDatabase(database);

  // 2. Clear exports directory and orphaned temp files
  let exportsCleared = true;
  try {
    await sweepOrphanTempExports(database);
  } catch {
    exportsCleared = false;
  }

  return {
    tablesReset: true,
    exportsCleared,
  };
}
