import * as React from 'react';
import { AppState, Linking, type AppStateStatus } from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import type { SQLiteDatabase } from 'expo-sqlite';
import { openDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrations';
import { getPhotoById, upsertPhoto } from '../src/db/repositories/photos';
import { getLastSyncAt, setLastSyncAt } from '../src/db/repositories/settings';
import {
  mapPermissionResponse,
  getLibraryPermissionStatus,
  requestLibraryPermission,
  openLibrarySettings,
  presentLimitedLibraryPicker,
  useLibraryPermission,
  syncLibrary,
  resetLibrarySync,
  getLastLibrarySync,
  useLibrarySync,
  DEFAULT_SYNC_BATCH_SIZE,
} from '../src/services/library';

// Mock expo-media-library
jest.mock('expo-media-library', () => {
  return {
    MediaType: {
      photo: 'photo',
      video: 'video',
      audio: 'audio',
      unknown: 'unknown',
    },
    SortBy: {
      creationTime: 'creationTime',
      modificationTime: 'modificationTime',
      default: 'default',
    },
    PermissionStatus: {
      GRANTED: 'granted',
      DENIED: 'denied',
      UNDETERMINED: 'undetermined',
    },
    getPermissionsAsync: jest.fn(),
    requestPermissionsAsync: jest.fn(),
    presentPermissionsPickerAsync: jest.fn(),
    getAssetsAsync: jest.fn(),
  };
});

// React 19 internals type for mocking hooks in node environment
interface ReactInternalsWithDispatcher {
  H: {
    useState?: (initial: unknown) => [unknown, (updater: unknown) => void];
    useCallback?: (fn: unknown, deps?: unknown[]) => unknown;
    useEffect?: (effect: () => (() => void) | void, deps?: unknown[]) => void;
  } | null;
}

/**
 * A lightweight, reliable hook runner for testing React hooks in Node/Jest without
 * requiring external test-renderer / DOM engines.
 */
function renderHookSim<T>(hookFn: () => T) {
  const stateSlots: unknown[] = [];
  const setterSlots: ((val: unknown) => void)[] = [];
  let slotIndex = 0;
  let effectCleanup: (() => void) | void;
  let effectFn: (() => (() => void) | void) | undefined;
  let effectDeps: unknown[] | undefined;
  let prevEffectDeps: unknown[] | undefined;

  const result: { current: T } = { current: undefined as unknown as T };

  // React 19 client internals
  const reactInternals = (React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: ReactInternalsWithDispatcher;
  }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

  const originalDispatcher = reactInternals?.H ?? null;

  const runRender = () => {
    slotIndex = 0;
    if (reactInternals) {
      reactInternals.H = dispatcherMock;
    }
    result.current = hookFn();
  };

  const runEffect = () => {
    if (effectFn) {
      if (
        !effectDeps ||
        !prevEffectDeps ||
        effectDeps.length !== prevEffectDeps.length ||
        effectDeps.some((d, i) => !Object.is(d, prevEffectDeps![i]))
      ) {
        if (typeof effectCleanup === 'function') {
          effectCleanup();
        }
        effectCleanup = effectFn();
        prevEffectDeps = effectDeps;
      }
    }
  };

  const dispatcherMock = {
    useState: (initial: unknown) => {
      const currIndex = slotIndex++;
      if (stateSlots.length <= currIndex) {
        stateSlots[currIndex] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      }
      if (!setterSlots[currIndex]) {
        setterSlots[currIndex] = (updater: unknown) => {
          stateSlots[currIndex] =
            typeof updater === 'function'
              ? (updater as (prev: unknown) => unknown)(stateSlots[currIndex])
              : updater;
          runRender();
        };
      }
      return [stateSlots[currIndex], setterSlots[currIndex]] as [unknown, (updater: unknown) => void];
    },
    useCallback: (fn: unknown) => fn,
    useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
      effectFn = effect;
      effectDeps = deps;
    },
  };

  runRender();
  runEffect();

  return {
    result,
    unmount: () => {
      if (typeof effectCleanup === 'function') {
        effectCleanup();
      }
      if (reactInternals) {
        reactInternals.H = originalDispatcher;
      }
    },
    rerender: () => {
      runRender();
      runEffect();
    },
  };
}

describe('Photo Library Permissions Service (src/services/library.ts)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('mapPermissionResponse', () => {
    it('maps accessPrivileges: "all" to status: "full"', () => {
      const res = mapPermissionResponse({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
      });
      expect(res.status).toBe('full');
      expect(res.granted).toBe(true);
      expect(res.canAskAgain).toBe(true);
      expect(res.accessPrivileges).toBe('all');
    });

    it('maps accessPrivileges: "limited" to status: "limited"', () => {
      const res = mapPermissionResponse({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'limited',
      });
      expect(res.status).toBe('limited');
      expect(res.granted).toBe(true);
      expect(res.canAskAgain).toBe(true);
      expect(res.accessPrivileges).toBe('limited');
    });

    it('maps accessPrivileges: "none" with status: "denied" to status: "denied"', () => {
      const res = mapPermissionResponse({
        status: MediaLibrary.PermissionStatus.DENIED,
        granted: false,
        canAskAgain: false,
        accessPrivileges: 'none',
      });
      expect(res.status).toBe('denied');
      expect(res.granted).toBe(false);
      expect(res.canAskAgain).toBe(false);
      expect(res.accessPrivileges).toBe('none');
    });

    it('maps accessPrivileges: "none" with status: "undetermined" to status: "undetermined"', () => {
      const res = mapPermissionResponse({
        status: MediaLibrary.PermissionStatus.UNDETERMINED,
        granted: false,
        canAskAgain: true,
        accessPrivileges: 'none',
      });
      expect(res.status).toBe('undetermined');
      expect(res.granted).toBe(false);
      expect(res.canAskAgain).toBe(true);
      expect(res.accessPrivileges).toBe('none');
    });

    it('maps status: "granted" when accessPrivileges is undefined to "full"', () => {
      const res = mapPermissionResponse({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
      });
      expect(res.status).toBe('full');
      expect(res.granted).toBe(true);
    });

    it('maps status: "denied" when accessPrivileges is undefined to "denied"', () => {
      const res = mapPermissionResponse({
        status: MediaLibrary.PermissionStatus.DENIED,
        granted: false,
        canAskAgain: false,
      });
      expect(res.status).toBe('denied');
      expect(res.granted).toBe(false);
    });

    it('maps status: "undetermined" when accessPrivileges is undefined to "undetermined"', () => {
      const res = mapPermissionResponse({
        status: MediaLibrary.PermissionStatus.UNDETERMINED,
        granted: false,
        canAskAgain: true,
      });
      expect(res.status).toBe('undetermined');
      expect(res.granted).toBe(false);
    });
  });

  describe('getLibraryPermissionStatus', () => {
    it('requests current permission with writeOnly = false (read-only)', async () => {
      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
      });

      const result = await getLibraryPermissionStatus();

      expect(MediaLibrary.getPermissionsAsync).toHaveBeenCalledWith(false);
      expect(result).toEqual({
        status: 'full',
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
      });
    });
  });

  describe('requestLibraryPermission', () => {
    it('requests user permission with writeOnly = false (read-only)', async () => {
      (MediaLibrary.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'limited',
      });

      const result = await requestLibraryPermission();

      expect(MediaLibrary.requestPermissionsAsync).toHaveBeenCalledWith(false);
      expect(result).toEqual({
        status: 'limited',
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'limited',
      });
    });
  });

  describe('openLibrarySettings', () => {
    it('calls Linking.openSettings()', async () => {
      const openSettingsSpy = jest.spyOn(Linking, 'openSettings').mockResolvedValueOnce(undefined as never);

      await openLibrarySettings();

      expect(openSettingsSpy).toHaveBeenCalledTimes(1);
      openSettingsSpy.mockRestore();
    });
  });

  describe('presentLimitedLibraryPicker', () => {
    it('calls MediaLibrary.presentPermissionsPickerAsync()', async () => {
      (MediaLibrary.presentPermissionsPickerAsync as jest.Mock).mockResolvedValueOnce(undefined);

      await presentLimitedLibraryPicker();

      expect(MediaLibrary.presentPermissionsPickerAsync).toHaveBeenCalledTimes(1);
    });
  });

  describe('useLibraryPermission hook', () => {
    it('fetches initial permission status on mount', async () => {
      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
      });

      const harness = renderHookSim(() => useLibraryPermission());

      expect(harness.result.current.isLoading).toBe(true);

      // Wait for asynchronous mount effect
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(harness.result.current.isLoading).toBe(false);
      expect(harness.result.current.status).toBe('full');
      expect(harness.result.current.granted).toBe(true);
      expect(harness.result.current.accessPrivileges).toBe('all');

      harness.unmount();
    });

    it('updates status when requestPermission is called', async () => {
      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.UNDETERMINED,
        granted: false,
        canAskAgain: true,
        accessPrivileges: 'none',
      });

      const harness = renderHookSim(() => useLibraryPermission());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.result.current.status).toBe('undetermined');

      (MediaLibrary.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'limited',
      });

      const update = await harness.result.current.requestPermission();
      expect(update.status).toBe('limited');
      expect(harness.result.current.status).toBe('limited');
      expect(harness.result.current.granted).toBe(true);
      expect(harness.result.current.isLoading).toBe(false);

      harness.unmount();
    });

    it('updates status when refreshPermission is called', async () => {
      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.DENIED,
        granted: false,
        canAskAgain: false,
        accessPrivileges: 'none',
      });

      const harness = renderHookSim(() => useLibraryPermission());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.result.current.status).toBe('denied');

      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
      });

      const update = await harness.result.current.refreshPermission();
      expect(update.status).toBe('full');
      expect(harness.result.current.status).toBe('full');
      expect(harness.result.current.granted).toBe(true);

      harness.unmount();
    });

    it('re-checks permissions when AppState changes to active', async () => {
      let appStateListener: ((state: AppStateStatus) => void) | undefined;
      const removeMock = jest.fn();

      jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
        if (event === 'change') {
          appStateListener = listener as (state: AppStateStatus) => void;
        }
        return { remove: removeMock } as never;
      });

      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.DENIED,
        granted: false,
        canAskAgain: false,
        accessPrivileges: 'none',
      });

      const harness = renderHookSim(() => useLibraryPermission());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.result.current.status).toBe('denied');

      // User returns from Settings (app becomes active)
      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        accessPrivileges: 'all',
      });

      expect(appStateListener).toBeDefined();

      appStateListener?.('active');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(harness.result.current.status).toBe('full');

      harness.unmount();
      expect(removeMock).toHaveBeenCalledTimes(1);
    });

    it('respects autoRefreshOnActive: false', async () => {
      const addEventListenerSpy = jest.spyOn(AppState, 'addEventListener');

      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.DENIED,
        granted: false,
        canAskAgain: false,
      });

      const harness = renderHookSim(() => useLibraryPermission({ autoRefreshOnActive: false }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.result.current.isLoading).toBe(false);

      expect(addEventListenerSpy).not.toHaveBeenCalled();

      harness.unmount();
      addEventListenerSpy.mockRestore();
    });

    it('provides openSettings and presentPicker helper methods', async () => {
      const openSettingsSpy = jest.spyOn(Linking, 'openSettings').mockResolvedValueOnce(undefined as never);
      (MediaLibrary.presentPermissionsPickerAsync as jest.Mock).mockResolvedValueOnce(undefined);
      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
      });

      const harness = renderHookSim(() => useLibraryPermission());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.result.current.isLoading).toBe(false);

      await harness.result.current.openSettings();
      expect(openSettingsSpy).toHaveBeenCalledTimes(1);

      await harness.result.current.presentPicker();
      expect(MediaLibrary.presentPermissionsPickerAsync).toHaveBeenCalledTimes(1);

      harness.unmount();
      openSettingsSpy.mockRestore();
    });
  });
});

describe('Incremental Photo Library Sync (src/services/library.ts)', () => {
  let db: SQLiteDatabase;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = await openDb(':memory:');
    await runMigrations(db);

    // Default permissions mock: granted
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValue({
      status: MediaLibrary.PermissionStatus.GRANTED,
      granted: true,
      canAskAgain: true,
      accessPrivileges: 'all',
    });
  });

  it('rejects sync if photo library permission is not granted', async () => {
    (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      status: MediaLibrary.PermissionStatus.DENIED,
      granted: false,
      canAskAgain: false,
      accessPrivileges: 'none',
    });

    await expect(syncLibrary({ db })).rejects.toThrow('Photo library permission not granted');
  });

  it('performs cold start full sync when last_sync_at is null', async () => {
    const mockAssets: MediaLibrary.Asset[] = [
      {
        id: 'asset-1',
        filename: 'IMG_0001.JPG',
        uri: 'ph://asset-1',
        mediaType: 'photo',
        width: 4032,
        height: 3024,
        creationTime: 1700000000000,
        modificationTime: 1700000001000,
        duration: 0,
      },
      {
        id: 'asset-2',
        filename: 'IMG_0002.JPG',
        uri: 'ph://asset-2',
        mediaType: 'photo',
        width: 3024,
        height: 4032,
        creationTime: 1700000010000,
        modificationTime: 1700000010000,
        duration: 0,
      },
    ];

    (MediaLibrary.getAssetsAsync as jest.Mock).mockResolvedValueOnce({
      assets: mockAssets,
      endCursor: 'cursor-1',
      hasNextPage: false,
      totalCount: 2,
    });

    const progressBatches: unknown[] = [];
    const result = await syncLibrary({
      db,
      onBatchProgress: (p) => progressBatches.push(p),
    });

    expect(result.syncedCount).toBe(2);
    expect(result.batchesCount).toBe(1);
    expect(result.isIncremental).toBe(false);
    expect(result.lastSyncAt).toBeGreaterThan(0);

    // Verify assets stored in SQLite
    const photo1 = await getPhotoById('asset-1', db);
    expect(photo1).not.toBeNull();
    expect(photo1?.width).toBe(4032);
    expect(photo1?.height).toBe(3024);
    expect(photo1?.taken_at).toBe(1700000000000);
    expect(photo1?.scan_status).toBe('pending');
    expect(photo1?.is_local).toBe(1);

    const photo2 = await getPhotoById('asset-2', db);
    expect(photo2).not.toBeNull();
    expect(photo2?.id).toBe('asset-2');

    // Verify settings.last_sync_at updated
    const savedSync = await getLastSyncAt(db);
    expect(savedSync).toBe(result.lastSyncAt);

    // Verify progress callback called for first batch
    expect(progressBatches).toEqual([
      {
        batchIndex: 0,
        batchSize: 2,
        totalSynced: 2,
        isFirstBatch: true,
      },
    ]);
  });

  it('paginates across multiple batches of 500 assets', async () => {
    // Generate 1250 assets
    const createAssetBatch = (startIdx: number, count: number): MediaLibrary.Asset[] => {
      const list: MediaLibrary.Asset[] = [];
      for (let i = 0; i < count; i++) {
        const id = `asset-${startIdx + i}`;
        list.push({
          id,
          filename: `${id}.JPG`,
          uri: `ph://${id}`,
          mediaType: 'photo',
          width: 1920,
          height: 1080,
          creationTime: 1600000000000 + (startIdx + i) * 1000,
          modificationTime: 1600000000000 + (startIdx + i) * 1000,
          duration: 0,
        });
      }
      return list;
    };

    const batch1 = createAssetBatch(0, 500);
    const batch2 = createAssetBatch(500, 500);
    const batch3 = createAssetBatch(1000, 250);

    (MediaLibrary.getAssetsAsync as jest.Mock)
      .mockResolvedValueOnce({
        assets: batch1,
        endCursor: 'cursor-batch-1',
        hasNextPage: true,
        totalCount: 1250,
      })
      .mockResolvedValueOnce({
        assets: batch2,
        endCursor: 'cursor-batch-2',
        hasNextPage: true,
        totalCount: 1250,
      })
      .mockResolvedValueOnce({
        assets: batch3,
        endCursor: 'cursor-batch-3',
        hasNextPage: false,
        totalCount: 1250,
      });

    const batchProgressList: { batchIndex: number; isFirstBatch: boolean; totalSynced: number }[] = [];

    const result = await syncLibrary({
      db,
      batchSize: DEFAULT_SYNC_BATCH_SIZE,
      onBatchProgress: (p) => {
        batchProgressList.push({
          batchIndex: p.batchIndex,
          isFirstBatch: p.isFirstBatch,
          totalSynced: p.totalSynced,
        });
      },
    });

    expect(result.syncedCount).toBe(1250);
    expect(result.batchesCount).toBe(3);
    expect(MediaLibrary.getAssetsAsync).toHaveBeenCalledTimes(3);

    // First call has no 'after' cursor
    expect(MediaLibrary.getAssetsAsync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ first: 500 })
    );
    expect((MediaLibrary.getAssetsAsync as jest.Mock).mock.calls[0][0].after).toBeUndefined();

    // Second call passes endCursor from first
    expect(MediaLibrary.getAssetsAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ first: 500, after: 'cursor-batch-1' })
    );

    // Third call passes endCursor from second
    expect(MediaLibrary.getAssetsAsync).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ first: 500, after: 'cursor-batch-2' })
    );

    // Check progress callbacks
    expect(batchProgressList).toEqual([
      { batchIndex: 0, isFirstBatch: true, totalSynced: 500 },
      { batchIndex: 1, isFirstBatch: false, totalSynced: 1000 },
      { batchIndex: 2, isFirstBatch: false, totalSynced: 1250 },
    ]);
  });

  it('performs incremental sync when last_sync_at already exists', async () => {
    const priorSyncTime = 1690000000000;
    await setLastSyncAt(priorSyncTime, db);

    const newAssets: MediaLibrary.Asset[] = [
      {
        id: 'new-asset-1',
        filename: 'NEW_01.JPG',
        uri: 'ph://new-1',
        mediaType: 'photo',
        width: 1000,
        height: 1000,
        creationTime: 1690000005000,
        modificationTime: 1690000005000,
        duration: 0,
      },
    ];

    (MediaLibrary.getAssetsAsync as jest.Mock).mockResolvedValueOnce({
      assets: newAssets,
      endCursor: 'cur-inc-1',
      hasNextPage: false,
      totalCount: 1,
    });

    const result = await syncLibrary({ db });

    expect(result.isIncremental).toBe(true);
    expect(result.syncedCount).toBe(1);

    // MediaLibrary must have been queried with createdAfter: priorSyncTime
    expect(MediaLibrary.getAssetsAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAfter: priorSyncTime,
      })
    );
  });

  it('preserves existing trip assignments and scan statuses on conflicting asset updates', async () => {
    // 1. Manually insert photo that belongs to a trip and has been scanned
    await upsertPhoto(
      {
        id: 'existing-asset',
        trip_id: 'trip-summer-2026',
        taken_at: 1000000,
        modified_at: 1000000,
        width: 1000,
        height: 800,
        lat: null,
        lng: null,
        is_local: 1,
        scan_status: 'done',
        face_count: 3,
        excluded: 0,
      },
      db
    );

    // 2. Incremental sync brings updated modificationTime for this asset
    (MediaLibrary.getAssetsAsync as jest.Mock).mockResolvedValueOnce({
      assets: [
        {
          id: 'existing-asset',
          filename: 'UPDATED.JPG',
          uri: 'ph://existing-asset',
          mediaType: 'photo',
          width: 1000,
          height: 800,
          creationTime: 1000000,
          modificationTime: 2000000, // Modified later
          duration: 0,
        },
      ],
      endCursor: 'cursor-mod',
      hasNextPage: false,
      totalCount: 1,
    });

    await syncLibrary({ db });

    const photo = await getPhotoById('existing-asset', db);
    expect(photo).not.toBeNull();
    // modified_at is updated
    expect(photo?.modified_at).toBe(2000000);
    // trip_id and scan_status are preserved!
    expect(photo?.trip_id).toBe('trip-summer-2026');
    expect(photo?.scan_status).toBe('done');
    expect(photo?.face_count).toBe(3);
  });

  it('forces full sync when forceFullSync is true even if last_sync_at exists', async () => {
    await setLastSyncAt(1690000000000, db);

    (MediaLibrary.getAssetsAsync as jest.Mock).mockResolvedValueOnce({
      assets: [],
      endCursor: '',
      hasNextPage: false,
      totalCount: 0,
    });

    const result = await syncLibrary({ db, forceFullSync: true });

    expect(result.isIncremental).toBe(false);
    expect(MediaLibrary.getAssetsAsync).toHaveBeenCalledWith(
      expect.not.objectContaining({
        createdAfter: expect.anything(),
      })
    );
  });

  it('handles empty media library cleanly', async () => {
    (MediaLibrary.getAssetsAsync as jest.Mock).mockResolvedValueOnce({
      assets: [],
      endCursor: '',
      hasNextPage: false,
      totalCount: 0,
    });

    const result = await syncLibrary({ db });

    expect(result.syncedCount).toBe(0);
    expect(result.batchesCount).toBe(0);
    expect(result.lastSyncAt).toBeGreaterThan(0);
  });

  it('resets library sync via resetLibrarySync helper', async () => {
    await setLastSyncAt(12345678, db);
    expect(await getLastLibrarySync(db)).toBe(12345678);

    await resetLibrarySync(db);
    expect(await getLastLibrarySync(db)).toBeNull();
  });

  describe('useLibrarySync hook', () => {
    it('manages isSyncing state and stores lastResult on completion', async () => {
      (MediaLibrary.getAssetsAsync as jest.Mock).mockResolvedValueOnce({
        assets: [
          {
            id: 'hook-photo',
            filename: 'P.JPG',
            uri: 'ph://p',
            mediaType: 'photo',
            width: 100,
            height: 100,
            creationTime: 1000,
            modificationTime: 1000,
            duration: 0,
          },
        ],
        endCursor: 'cur-hook',
        hasNextPage: false,
        totalCount: 1,
      });

      const harness = renderHookSim(() => useLibrarySync());
      expect(harness.result.current.isSyncing).toBe(false);
      expect(harness.result.current.lastResult).toBeNull();

      const syncPromise = harness.result.current.sync({ db });
      expect(harness.result.current.isSyncing).toBe(true);

      const res = await syncPromise;
      expect(res.syncedCount).toBe(1);
      expect(harness.result.current.isSyncing).toBe(false);
      expect(harness.result.current.lastResult).toEqual(res);

      harness.unmount();
    });

    it('captures errors and resets isSyncing on failure', async () => {
      (MediaLibrary.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({
        status: MediaLibrary.PermissionStatus.DENIED,
        granted: false,
        canAskAgain: false,
      });

      const harness = renderHookSim(() => useLibrarySync());

      await expect(harness.result.current.sync({ db })).rejects.toThrow(
        'Photo library permission not granted'
      );

      expect(harness.result.current.isSyncing).toBe(false);
      expect(harness.result.current.error).not.toBeNull();
      expect(harness.result.current.error?.message).toBe('Photo library permission not granted');

      harness.unmount();
    });
  });
});
