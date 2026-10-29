import { useEffect, useState, useCallback } from 'react';
import { AppState, type AppStateStatus, Linking } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../db/client';
import { upsertPhotos } from '../db/repositories/photos';
import { getLastSyncAt, setLastSyncAt, deleteSetting } from '../db/repositories/settings';
import type { PhotoRow } from '../db/types';

export type LibraryPermissionStatus = 'full' | 'limited' | 'denied' | 'undetermined';

export interface LibraryPermissionState {
  status: LibraryPermissionStatus;
  granted: boolean;
  canAskAgain: boolean;
  accessPrivileges?: 'all' | 'limited' | 'none';
}

export interface UseLibraryPermissionOptions {
  autoRefreshOnActive?: boolean;
}

export interface UseLibraryPermissionResult extends LibraryPermissionState {
  isLoading: boolean;
  requestPermission: () => Promise<LibraryPermissionState>;
  refreshPermission: () => Promise<LibraryPermissionState>;
  openSettings: () => Promise<void>;
  presentPicker: () => Promise<void>;
}

/**
 * Maps expo-media-library's PermissionResponse to our tri-state domain permission model:
 * 'full' | 'limited' | 'denied' (or 'undetermined' prior to user action).
 */
export function mapPermissionResponse(
  response?: Pick<MediaLibrary.PermissionResponse, 'status' | 'granted' | 'canAskAgain' | 'accessPrivileges'> | null,
): LibraryPermissionState {
  if (!response) {
    return {
      status: 'undetermined',
      granted: false,
      canAskAgain: true,
      accessPrivileges: undefined,
    };
  }

  let mappedStatus: LibraryPermissionStatus;

  if (response.accessPrivileges === 'limited') {
    mappedStatus = 'limited';
  } else if (response.accessPrivileges === 'all') {
    mappedStatus = 'full';
  } else if (response.accessPrivileges === 'none') {
    if (
      response.status === MediaLibrary.PermissionStatus.UNDETERMINED ||
      (response.status as string) === 'undetermined'
    ) {
      mappedStatus = 'undetermined';
    } else {
      mappedStatus = 'denied';
    }
  } else {
    // If accessPrivileges is undefined (e.g. Android < 14 or mock environments)
    if (
      response.status === MediaLibrary.PermissionStatus.GRANTED ||
      (response.status as string) === 'granted'
    ) {
      mappedStatus = 'full';
    } else if (
      response.status === MediaLibrary.PermissionStatus.DENIED ||
      (response.status as string) === 'denied'
    ) {
      mappedStatus = 'denied';
    } else {
      mappedStatus = 'undetermined';
    }
  }

  const isGranted = mappedStatus === 'full' || mappedStatus === 'limited';

  return {
    status: mappedStatus,
    granted: isGranted,
    canAskAgain: response.canAskAgain ?? true,
    accessPrivileges: response.accessPrivileges,
  };
}

/**
 * Get current photo library permissions (read-only, writeOnly = false).
 */
export async function getLibraryPermissionStatus(): Promise<LibraryPermissionState> {
  const response = await MediaLibrary.getPermissionsAsync(false);
  return mapPermissionResponse(response);
}

/**
 * Request photo library permissions (read-only, writeOnly = false).
 */
export async function requestLibraryPermission(): Promise<LibraryPermissionState> {
  const response = await MediaLibrary.requestPermissionsAsync(false);
  return mapPermissionResponse(response);
}

/**
 * Open device system settings for this app (e.g. when permission is denied).
 */
export async function openLibrarySettings(): Promise<void> {
  await Linking.openSettings();
}

/**
 * Open system limited photo picker dialog so user can select additional photos.
 * Only applicable when access is 'limited' (iOS 14+ / Android 14+).
 */
export async function presentLimitedLibraryPicker(): Promise<void> {
  if (typeof MediaLibrary.presentPermissionsPickerAsync === 'function') {
    await MediaLibrary.presentPermissionsPickerAsync();
  }
}

/**
 * Hook to observe and request photo library permissions.
 * Re-checks status when the app returns to the foreground (AppState 'active').
 */
export function useLibraryPermission(
  options: UseLibraryPermissionOptions = {},
): UseLibraryPermissionResult {
  const { autoRefreshOnActive = true } = options;

  const [state, setState] = useState<LibraryPermissionState>({
    status: 'undetermined',
    granted: false,
    canAskAgain: true,
    accessPrivileges: undefined,
  });
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const applyStatus = useCallback(async () => {
    try {
      const result = await getLibraryPermissionStatus();
      setState(result);
      return result;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const requestPermission = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await requestLibraryPermission();
      setState(result);
      return result;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshPermission = useCallback(async () => {
    setIsLoading(true);
    return applyStatus();
  }, [applyStatus]);

  const openSettings = useCallback(async () => {
    await openLibrarySettings();
  }, []);

  const presentPicker = useCallback(async () => {
    await presentLimitedLibraryPicker();
  }, []);

  useEffect(() => {
    let isMounted = true;

    void (async () => {
      try {
        const result = await getLibraryPermissionStatus();
        if (isMounted) {
          setState(result);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    })();

    if (!autoRefreshOnActive) {
      return () => {
        isMounted = false;
      };
    }

    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'active' && isMounted) {
        void (async () => {
          try {
            const result = await getLibraryPermissionStatus();
            if (isMounted) {
              setState(result);
            }
          } catch {
            // Ignore background error during state transition
          }
        })();
      }
    });

    return () => {
      isMounted = false;
      subscription?.remove?.();
    };
  }, [autoRefreshOnActive]);

  return {
    ...state,
    isLoading,
    requestPermission,
    refreshPermission,
    openSettings,
    presentPicker,
  };
}

export const DEFAULT_SYNC_BATCH_SIZE = 500;

export interface SyncBatchProgress {
  batchIndex: number;
  batchSize: number;
  totalSynced: number;
  isFirstBatch: boolean;
}

export interface SyncLibraryOptions {
  batchSize?: number;
  forceFullSync?: boolean;
  db?: SQLiteDatabase;
  onBatchProgress?: (progress: SyncBatchProgress) => void;
}

export interface SyncLibraryResult {
  syncedCount: number;
  batchesCount: number;
  lastSyncAt: number;
  isIncremental: boolean;
}

/**
 * Performs incremental (or full) photo library synchronization into SQLite.
 *
 * Requirements:
 * - Batches of 500 assets (configurable).
 * - Incremental: only assets created after `settings.last_sync_at` (or all on cold start / forced).
 * - Existing photo records retain trip assignments and scan statuses on conflict.
 * - Dispatches onBatchProgress per batch so UI can dismiss skeletons on first batch.
 */
export async function syncLibrary(
  options: SyncLibraryOptions = {},
): Promise<SyncLibraryResult> {
  const batchSize = options.batchSize ?? DEFAULT_SYNC_BATCH_SIZE;
  const database = options.db ?? (await getDatabase());
  const syncStartTime = Date.now();

  const permission = await getLibraryPermissionStatus();
  if (!permission.granted) {
    throw new Error('Photo library permission not granted');
  }

  const previousSyncAt = options.forceFullSync ? null : await getLastSyncAt(database);
  const isIncremental = previousSyncAt !== null;

  let after: string | undefined = undefined;
  let hasNextPage = true;
  let totalSynced = 0;
  let batchIndex = 0;

  while (hasNextPage) {
    const assetsOptions: MediaLibrary.AssetsOptions = {
      first: batchSize,
      mediaType: [MediaLibrary.MediaType?.photo ?? 'photo'],
      sortBy: [MediaLibrary.SortBy?.creationTime ?? 'creationTime'],
    };

    if (after) {
      assetsOptions.after = after;
    }

    if (isIncremental && previousSyncAt !== null) {
      assetsOptions.createdAfter = previousSyncAt;
    }

    const pagedInfo = await MediaLibrary.getAssetsAsync(assetsOptions);

    if (!pagedInfo || !pagedInfo.assets || pagedInfo.assets.length === 0) {
      break;
    }

    const photoRows: PhotoRow[] = pagedInfo.assets.map((asset) => ({
      id: asset.id,
      trip_id: null,
      taken_at: Math.round(asset.creationTime),
      modified_at: Math.round(asset.modificationTime || asset.creationTime),
      width: asset.width,
      height: asset.height,
      lat: null,
      lng: null,
      is_local: 1,
      scan_status: 'pending',
      face_count: 0,
      excluded: 0,
    }));

    await upsertPhotos(photoRows, database);
    totalSynced += photoRows.length;

    options.onBatchProgress?.({
      batchIndex,
      batchSize: photoRows.length,
      totalSynced,
      isFirstBatch: batchIndex === 0,
    });

    batchIndex++;
    after = pagedInfo.endCursor;
    hasNextPage = Boolean(pagedInfo.hasNextPage && after && pagedInfo.assets.length > 0);
  }

  // Update last_sync_at timestamp
  await setLastSyncAt(syncStartTime, database);

  return {
    syncedCount: totalSynced,
    batchesCount: batchIndex,
    lastSyncAt: syncStartTime,
    isIncremental,
  };
}

/**
 * Clears the last sync timestamp to force a complete re-sync on the next run.
 */
export async function resetLibrarySync(db?: SQLiteDatabase): Promise<void> {
  const database = db ?? (await getDatabase());
  await deleteSetting('last_sync_at', database);
}

/**
 * Retrieves the timestamp of the last successful library sync.
 */
export async function getLastLibrarySync(db?: SQLiteDatabase): Promise<number | null> {
  const database = db ?? (await getDatabase());
  return await getLastSyncAt(database);
}

export interface UseLibrarySyncResult {
  isSyncing: boolean;
  error: Error | null;
  lastResult: SyncLibraryResult | null;
  sync: (options?: SyncLibraryOptions) => Promise<SyncLibraryResult>;
}

/**
 * Hook to execute and monitor photo library synchronization.
 */
export function useLibrarySync(): UseLibrarySyncResult {
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastResult, setLastResult] = useState<SyncLibraryResult | null>(null);

  const sync = useCallback(async (opts: SyncLibraryOptions = {}) => {
    setIsSyncing(true);
    setError(null);
    try {
      const result = await syncLibrary(opts);
      setLastResult(result);
      return result;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      throw e;
    } finally {
      setIsSyncing(false);
    }
  }, []);

  return {
    isSyncing,
    error,
    lastResult,
    sync,
  };
}

