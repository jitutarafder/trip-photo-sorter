import { useEffect, useState, useCallback } from 'react';
import { Paths } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import Share from 'react-native-share';
import { zip } from 'react-native-zip-archive';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../db/client';
import { generateUUID } from '../utils/uuid';
import { getPersonById, getPersonPhotos, getPeopleByTripId } from '../db/repositories/people';
import { getTripById } from '../db/repositories/trips';
import {
  createExport,
  getExportById,
  updateExport,
  cleanupExportPath,
  getIncompleteOrActiveExports,
  markInterruptedExportsAsCancelled,
} from '../db/repositories/exports';
import type { ExportStatus, PhotoRow } from '../db/types';
import { CONFIG } from '../domain/config';
import { isProUser } from './purchases';

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

export interface ExportPersonOptions {
  personId: string;
  tripId: string;
  mode?: 'photos' | 'zip';
  soloOnly?: boolean;
  customPhotoIds?: string[];
  shareTitle?: string;
  db?: SQLiteDatabase;
  // Dependency injection hooks for testing & custom platforms
  zipFn?: (source: string, target: string) => Promise<string>;
  shareSingleFn?: (url: string, title?: string) => Promise<void>;
  shareMultiFn?: (
    urls: string[],
    title?: string
  ) => Promise<{ success?: boolean; dismissed?: boolean; dismissedAction?: boolean }>;
  resolvePhotoUriFn?: (photo: PhotoRow) => Promise<string | null>;
  enableProGate?: boolean;
}

export interface ExportResult {
  exportId: string;
  mode: 'photos' | 'zip';
  photoCount: number;
  skippedCount?: number;
  sizeBytes: number;
  status: ExportStatus;
  zipPath: null; // Per AGENTS.md, temp ZIPs are deleted on every exit path
  stagedFiles?: string[];
}

export interface BatchExportOptions {
  tripId: string;
  mode?: 'photos' | 'zip';
  soloOnly?: boolean;
  db?: SQLiteDatabase;
  onProgress?: (current: number, total: number, personName: string) => void;
  zipFn?: (source: string, target: string) => Promise<string>;
  shareSingleFn?: (url: string, title?: string) => Promise<void>;
  shareMultiFn?: (
    urls: string[],
    title?: string
  ) => Promise<{ success?: boolean; dismissed?: boolean; dismissedAction?: boolean }>;
  resolvePhotoUriFn?: (photo: PhotoRow) => Promise<string | null>;
  enableProGate?: boolean;
}

/**
 * Sanitises a string for use in file and ZIP archive names.
 * Strips `/ \ : * ? " < > |`, trims, and caps at 40 characters (04_TRD §6).
 */
export function sanitizeFilename(name: string, fallback = 'Unnamed'): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, '').trim();
  const valid = cleaned.length > 0 ? cleaned : fallback;
  // Use Array.from to count Unicode code points rather than raw UTF-16 code units,
  // preventing broken surrogate pairs when capping at 40 characters.
  const codePoints = Array.from(valid);
  return codePoints.slice(0, 40).join('');
}

/**
 * Builds the standard ZIP filename: `{Trip}_{Person}.zip` (04_TRD §6).
 */
export function buildExportZipFilename(tripName: string, personName: string): string {
  const cleanTrip = sanitizeFilename(tripName, 'Trip');
  const cleanPerson = sanitizeFilename(personName, 'Person');
  return `${cleanTrip}_${cleanPerson}.zip`;
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
 * Resolves the local file URI for a photo asset.
 * If photo is marked iCloud-only (is_local=0), returns null (AppFlow §4).
 */
export async function resolvePhotoLocalUri(photo: PhotoRow): Promise<string | null> {
  if (photo.is_local === 0) {
    return null;
  }
  if (photo.id.startsWith('file://')) {
    return photo.id;
  }
  try {
    const asset = await MediaLibrary.getAssetInfoAsync(photo.id);
    return asset?.localUri || asset?.uri || null;
  } catch {
    return null;
  }
}

/**
 * Helper to determine whether an error represents user cancellation of the share dialog.
 */
export function isUserCancellation(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === 'object') {
    if ('dismissed' in err && Boolean((err as { dismissed?: boolean }).dismissed)) {
      return true;
    }
    if ('dismissedAction' in err && Boolean((err as { dismissedAction?: boolean }).dismissedAction)) {
      return true;
    }
    if ('message' in err && typeof (err as { message: unknown }).message === 'string') {
      const msg = (err as { message: string }).message.toLowerCase();
      return (
        msg.includes('user did not share') ||
        msg.includes('dismissed') ||
        msg.includes('cancel') ||
        msg.includes('cancelled') ||
        msg.includes('canceled')
      );
    }
  }
  const str = String(err).toLowerCase();
  return (
    str.includes('user did not share') ||
    str.includes('dismissed') ||
    str.includes('cancel') ||
    str.includes('cancelled') ||
    str.includes('canceled')
  );
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
 * Exports a person's photos in either "photos" mode (≤ 30 photos) or "zip" mode.
 *
 * Rules (01_PRD US-09, 04_TRD §6, 06_Plan Task 2.8):
 * - Two modes:
 *     • "photos": ≤ 30 photos, copied to temporary directory, shared via react-native-share.
 *     • "zip": compressed with react-native-zip-archive, shared via expo-sharing.
 * - Option soloOnly: filters photos with face_count = 1 vs group photos.
 * - Temp cleanup on EVERY exit path (done, cancelled, or failed).
 */
export async function exportPerson(
  options: ExportPersonOptions
): Promise<ExportResult> {
  const database = options.db ?? (await getDatabase());
  const mode = options.mode ?? 'zip';
  const soloOnly = options.soloOnly ?? false;

  // 1. Validate person & trip existence
  const person = await getPersonById(options.personId, database);
  if (!person) {
    throw new Error(`Person ${options.personId} not found`);
  }
  if (!person.name && !person.is_others) {
    throw new Error('Person must have a name before export (unnamed people cannot be exported)');
  }
  const personName = person.name || (person.is_others ? 'Others' : 'Person');

  const trip = await getTripById(options.tripId, database);
  if (!trip) {
    throw new Error(`Trip ${options.tripId} not found`);
  }

  // Free-tier export gate (05_Schema §3 Key Query, AppFlow §3.7)
  const isPro = await isProUser(database, options.enableProGate);
  if (!isPro && trip.scanned_count > CONFIG.FREE_SCAN_LIMIT_PER_TRIP) {
    throw new Error(
      `Free-tier limit exceeded (${trip.scanned_count} photos scanned, max ${CONFIG.FREE_SCAN_LIMIT_PER_TRIP}). Unlock Pro to export.`
    );
  }

  // 2. Query photos for person with solo-only filter (05_Schema Key Query)
  let photos = await getPersonPhotos(options.personId, { soloOnly }, database);
  if (options.customPhotoIds && options.customPhotoIds.length > 0) {
    const idSet = new Set(options.customPhotoIds);
    photos = photos.filter((p) => idSet.has(p.id));
  }

  if (photos.length === 0) {
    throw new Error(`No eligible photos found to export for ${personName}`);
  }

  // 3. Mode constraint: Photos mode is strictly limited to ≤ 30 photos (PRD US-09, Plan 2.8)
  if (mode === 'photos' && photos.length > 30) {
    throw new Error(
      `Photos mode is limited to 30 photos or fewer (selected ${photos.length}). Use ZIP mode instead.`
    );
  }

  // 4. Create Export DB row in 'pending' status
  const exportId = generateUUID();
  await createExport(
    {
      id: exportId,
      person_id: person.id,
      trip_id: trip.id,
      mode,
      solo_only: soloOnly ? 1 : 0,
      status: 'pending',
      photo_count: photos.length,
    },
    database
  );

  const exportsDir = await ensureExportsDirectory();
  const exportFolder = `${exportsDir}export_${exportId}/`;
  let zipPath: string | null = null;
  const stagedFiles: string[] = [];
  let totalBytes = 0;
  let skippedCount = 0;
  let finalStatus: ExportStatus = 'failed';

  try {
    await LegacyFileSystem.makeDirectoryAsync(exportFolder, { intermediates: true });

    const stagedDir = mode === 'zip' ? `${exportFolder}photos/` : exportFolder;
    if (mode === 'zip') {
      await LegacyFileSystem.makeDirectoryAsync(stagedDir, { intermediates: true });
    }

    // Resolve local URIs and copy photos to staging directory
    const resolveUri = options.resolvePhotoUriFn ?? resolvePhotoLocalUri;
    let copiedCount = 0;
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      const sourceUri = await resolveUri(photo);
      if (!sourceUri) {
        skippedCount++;
        continue; // Skip iCloud-only or deleted asset
      }

      let ext = 'jpg';
      const extMatch = sourceUri.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
      if (extMatch) {
        ext = extMatch[1].toLowerCase();
      }
      const safePhotoId = photo.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const targetFileName = `photo_${String(i + 1).padStart(3, '0')}_${safePhotoId}.${ext}`;
      const targetPath = `${stagedDir}${targetFileName}`;

      try {
        await LegacyFileSystem.copyAsync({ from: sourceUri, to: targetPath });
        const info = await LegacyFileSystem.getInfoAsync(targetPath);
        if (info.exists && !info.isDirectory) {
          totalBytes += (info as { size?: number }).size || 0;
        }
        stagedFiles.push(targetPath);
        copiedCount++;
      } catch {
        skippedCount++;
        // Individual copy failure is skipped silently per AppFlow §4
      }
    }

    if (copiedCount === 0) {
      throw new Error('Could not resolve or copy any photo files for export');
    }

    // Disk storage space pre-check (< 2x ZIP size free, AppFlow §3.7)
    try {
      if (typeof LegacyFileSystem.getFreeDiskStorageAsync === 'function') {
        const freeStorage = await LegacyFileSystem.getFreeDiskStorageAsync();
        if (freeStorage > 0 && freeStorage < 2 * totalBytes) {
          const reqMb = Math.ceil((2 * totalBytes) / (1024 * 1024));
          throw new Error(`Not enough storage space. Required at least ${reqMb} MB free space.`);
        }
      }
    } catch (storageErr) {
      if (storageErr instanceof Error && storageErr.message.includes('Not enough storage space')) {
        throw storageErr;
      }
    }

    if (mode === 'zip') {
      // ZIP Mode
      await updateExport(exportId, { status: 'zipping' }, database);

      const zipFilename = buildExportZipFilename(trip.name, personName);
      zipPath = `${exportFolder}${zipFilename}`;

      const doZip = options.zipFn ?? zip;
      await doZip(stagedDir, zipPath);

      const zipInfo = await LegacyFileSystem.getInfoAsync(zipPath);
      const zipSize =
        (zipInfo.exists && !zipInfo.isDirectory && (zipInfo as { size?: number }).size) || totalBytes;

      await updateExport(
        exportId,
        {
          status: 'ready',
          zip_path: zipPath,
          size_bytes: zipSize,
          photo_count: copiedCount,
        },
        database
      );

      await updateExport(exportId, { status: 'sharing' }, database);

      const doShareSingle =
        options.shareSingleFn ??
        (async (url: string, title?: string) => {
          await Sharing.shareAsync(url, {
            mimeType: 'application/zip',
            UTI: 'public.zip-archive',
            dialogTitle: title,
          });
        });

      await doShareSingle(zipPath, options.shareTitle ?? zipFilename);

      finalStatus = 'done';
      await updateExport(exportId, { status: 'done' }, database);
    } else {
      // Photos Mode (multi-file share)
      await updateExport(
        exportId,
        {
          status: 'ready',
          size_bytes: totalBytes,
          photo_count: copiedCount,
        },
        database
      );

      await updateExport(exportId, { status: 'sharing' }, database);

      const doShareMulti =
        options.shareMultiFn ??
        (async (urls: string[], title?: string) => {
          return await Share.open({
            urls,
            title,
            type: 'image/*',
          });
        });

      const shareRes = await doShareMulti(stagedFiles, options.shareTitle ?? `${personName} Photos`);
      const isDismissed =
        !shareRes ||
        shareRes.success === false ||
        ('dismissed' in shareRes && Boolean((shareRes as { dismissed?: boolean }).dismissed)) ||
        ('dismissedAction' in shareRes &&
          Boolean((shareRes as { dismissedAction?: boolean }).dismissedAction));

      if (isDismissed) {
        finalStatus = 'cancelled';
        await updateExport(exportId, { status: 'cancelled', error: 'Share dismissed' }, database);
      } else {
        finalStatus = 'done';
        await updateExport(exportId, { status: 'done' }, database);
      }
    }

    return {
      exportId,
      mode,
      photoCount: copiedCount,
      skippedCount,
      sizeBytes: totalBytes,
      status: finalStatus,
      zipPath: null, // Always NULL after exit cleanup
    };
  } catch (err) {
    if (isUserCancellation(err)) {
      finalStatus = 'cancelled';
      await updateExport(
        exportId,
        { status: 'cancelled', error: 'User cancelled share' },
        database
      );
      return {
        exportId,
        mode,
        photoCount: stagedFiles.length,
        skippedCount,
        sizeBytes: totalBytes,
        status: 'cancelled',
        zipPath: null,
      };
    }

    finalStatus = 'failed';
    const errMsg = err instanceof Error ? err.message : String(err);
    await updateExport(
      exportId,
      { status: 'failed', error: errMsg },
      database
    );
    throw err;
  } finally {
    // Temp cleanup on EVERY exit path (done, cancelled, or failed)
    try {
      await LegacyFileSystem.deleteAsync(exportFolder, { idempotent: true });
    } catch {
      // Ignore directory cleanup error if already removed
    }
    await cleanupExportFile(exportId, zipPath, database);
  }
}

/**
 * Sequential batch export for all named people in a trip (01_PRD US-10).
 */
export async function exportNamedPeopleBatch(
  options: BatchExportOptions
): Promise<ExportResult[]> {
  const database = options.db ?? (await getDatabase());
  const allPeople = await getPeopleByTripId(options.tripId, database);
  const namedPeople = allPeople.filter((p) => p.name && !p.is_others);

  const results: ExportResult[] = [];
  for (let i = 0; i < namedPeople.length; i++) {
    const person = namedPeople[i];
    if (options.onProgress) {
      options.onProgress(i + 1, namedPeople.length, person.name ?? 'Unnamed');
    }

    try {
      const res = await exportPerson({
        personId: person.id,
        tripId: options.tripId,
        mode: options.mode,
        soloOnly: options.soloOnly,
        db: database,
        zipFn: options.zipFn,
        shareSingleFn: options.shareSingleFn,
        shareMultiFn: options.shareMultiFn,
        resolvePhotoUriFn: options.resolvePhotoUriFn,
        enableProGate: options.enableProGate,
      });
      results.push(res);
    } catch {
      // If individual export fails, record failure and continue next person in queue
      results.push({
        exportId: generateUUID(),
        mode: options.mode ?? 'zip',
        photoCount: 0,
        sizeBytes: 0,
        status: 'failed',
        zipPath: null,
      });
    }
  }

  return results;
}

/**
 * Sweeps all orphaned temporary export files and updates interrupted export states.
 * Runs at app launch (AppFlow §2.2 & 06_Plan Task 1.7).
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
