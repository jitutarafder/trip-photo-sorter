import { useEffect, useState, useCallback } from 'react';
import { Paths } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../db/client';
import {
  getExportById,
  cleanupExportPath,
  getIncompleteOrActiveExports,
  markInterruptedExportsAsCancelled,
} from '../db/repositories/exports';

export interface SweepResult {
  deletedFilesCount: number;
  clearedDbRecordsCount: number;
  errors: string[];
}

export interface UseOrphanSweepResult {
  isSweeping: boolean;
  sweepResult: SweepResult | null;
  error: Error | null;
  resweep: () => Promise<SweepResult>;
}

/**
 * Returns the directory path where temporary export files and ZIP archives are stored.
 */
export function getExportsDirectory(): string {
  let cacheDir = '';
  try {
    if (Paths?.cache?.uri) {
      cacheDir = Paths.cache.uri;
    }
  } catch {
    // Paths not available in test or legacy environment
  }
  if (!cacheDir && LegacyFileSystem?.cacheDirectory) {
    cacheDir = LegacyFileSystem.cacheDirectory;
  }
  const cleanDir = cacheDir.endsWith('/') ? cacheDir : `${cacheDir}/`;
  return `${cleanDir}exports/`;
}

/**
 * Ensures the temporary exports directory exists on disk.
 */
export async function ensureExportsDirectory(): Promise<string> {
  const dir = getExportsDirectory();
  try {
    const info = await LegacyFileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await LegacyFileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
  } catch {
    // Fall back or ignore in environments where directory already exists
  }
  return dir;
}

/**
 * Deletes a single temporary export file and cleans its zip_path in SQLite.
 * Per AGENTS.md ("Temp ZIPs must be deleted on every exit path") and AppFlow §2.2.
 */
export async function cleanupExportFile(
  exportId: string,
  filePath?: string | null,
  db?: SQLiteDatabase
): Promise<boolean> {
  const database = db ?? (await getDatabase());
  let targetPath = filePath;

  if (!targetPath) {
    const exp = await getExportById(exportId, database);
    targetPath = exp?.zip_path ?? null;
  }

  if (targetPath) {
    try {
      const info = await LegacyFileSystem.getInfoAsync(targetPath);
      if (info.exists) {
        await LegacyFileSystem.deleteAsync(targetPath, { idempotent: true });
      }
    } catch {
      // Ignore if file was already removed
    }
  }

  await cleanupExportPath(exportId, database);
  return true;
}

/**
 * Sweeps all orphaned temporary export files and updates interrupted export states.
 * Runs at app launch (AppFlow §2.2 & 06_Plan Task 1.7).
 *
 * 1. Finds all exports in SQLite with active zip_path or in-flight status, deletes files, and marks records as cancelled.
 * 2. Enumerates `<cacheDir>/exports/` and deletes all lingering temporary files/folders.
 */
export async function sweepOrphanTempExports(
  db?: SQLiteDatabase
): Promise<SweepResult> {
  const result: SweepResult = {
    deletedFilesCount: 0,
    clearedDbRecordsCount: 0,
    errors: [],
  };

  const database = db ?? (await getDatabase());

  // 1. Database consistency sweep
  try {
    const activeExports = await getIncompleteOrActiveExports(database);
    for (const exp of activeExports) {
      if (exp.zip_path) {
        try {
          const info = await LegacyFileSystem.getInfoAsync(exp.zip_path);
          if (info.exists) {
            await LegacyFileSystem.deleteAsync(exp.zip_path, { idempotent: true });
            result.deletedFilesCount++;
          }
        } catch (fileErr) {
          result.errors.push(
            `Failed to delete export file ${exp.zip_path}: ${fileErr instanceof Error ? fileErr.message : String(fileErr)}`
          );
        }
      }
    }

    const cleared = await markInterruptedExportsAsCancelled(database);
    result.clearedDbRecordsCount = cleared;
  } catch (dbErr) {
    result.errors.push(
      `Database export sweep failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`
    );
  }

  // 2. Filesystem directory sweep
  try {
    const exportsDir = getExportsDirectory();
    const dirInfo = await LegacyFileSystem.getInfoAsync(exportsDir);
    if (dirInfo.exists && dirInfo.isDirectory) {
      const items = await LegacyFileSystem.readDirectoryAsync(exportsDir);
      for (const item of items) {
        const itemPath = `${exportsDir}${item}`;
        try {
          await LegacyFileSystem.deleteAsync(itemPath, { idempotent: true });
          result.deletedFilesCount++;
        } catch (itemErr) {
          result.errors.push(
            `Failed to remove orphaned export item ${itemPath}: ${itemErr instanceof Error ? itemErr.message : String(itemErr)}`
          );
        }
      }
    }
  } catch (fsErr) {
    result.errors.push(
      `Filesystem export sweep failed: ${fsErr instanceof Error ? fsErr.message : String(fsErr)}`
    );
  }

  return result;
}

/**
 * Hook to run orphan export sweep at app launch.
 */
export function useOrphanSweep(db?: SQLiteDatabase): UseOrphanSweepResult {
  const [isSweeping, setIsSweeping] = useState<boolean>(true);
  const [sweepResult, setSweepResult] = useState<SweepResult | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const runSweep = useCallback(async () => {
    setIsSweeping(true);
    setError(null);
    try {
      const res = await sweepOrphanTempExports(db);
      setSweepResult(res);
      return res;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      throw e;
    } finally {
      setIsSweeping(false);
    }
  }, [db]);

  useEffect(() => {
    let isMounted = true;
    void (async () => {
      try {
        const res = await sweepOrphanTempExports(db);
        if (isMounted) {
          setSweepResult(res);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (isMounted) {
          setIsSweeping(false);
        }
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [db]);

  return {
    isSweeping,
    sweepResult,
    error,
    resweep: runSweep,
  };
}
