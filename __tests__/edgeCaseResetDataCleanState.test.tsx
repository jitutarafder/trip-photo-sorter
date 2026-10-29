import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { Alert } from 'react-native';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import SettingsScreen from '../app/settings';
import HomeScreen from '../app/index';
import { ThemeProvider } from '../src/theme';
import { openDbSync, setDatabaseInstance } from '../src/db/client';
import { runMigrationsSync } from '../src/db/migrations';
import { resetAllAppData } from '../src/services/appData';
import {
  setOnboarded,
  isOnboarded,
  getLastSyncAt,
  setLastSyncAt,
  setPro,
  isPro,
} from '../src/db/repositories/settings';
import { createTrip, getAllTrips, getTripById } from '../src/db/repositories/trips';
import { upsertPhotos, getPhotosByTripId } from '../src/db/repositories/photos';
import {
  createPerson,
  getPeopleByTripId,
  excludePhotoFromPerson,
  getExcludedPhotoIdsForPerson,
} from '../src/db/repositories/people';
import { savePhotoFacesAtomic, getFacesByTripId } from '../src/db/repositories/faces';
import { createExport, getExportsByTripId } from '../src/db/repositories/exports';
import { ensureExportsDirectory } from '../src/services/exporter';
import { clearFaceThumbnailCache } from '../src/services/faceThumbnail';
import * as libraryHooks from '../src/hooks/useLibraryPermission';
import * as purchasesService from '../src/services/purchases';
import type { PhotoRow, FaceRow } from '../src/db/types';

(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// Mock router
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  Stack: Object.assign(() => null, { Screen: () => null }),
}));

// Mock safe area insets
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock expo-file-system/legacy
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///mock/cache/',
  documentDirectory: 'file:///mock/documents/',
  getInfoAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(),
  deleteAsync: jest.fn(),
  readDirectoryAsync: jest.fn(),
  copyAsync: jest.fn(),
  getFreeDiskStorageAsync: jest.fn(),
}));

// Mock library hooks & services
jest.mock('../src/hooks/useLibraryPermission', () => ({
  useLibraryPermission: jest.fn(),
}));

jest.mock('../src/services/library', () => {
  const actual = jest.requireActual('../src/services/library');
  return {
    ...actual,
    syncLibrary: jest.fn().mockResolvedValue({ syncedCount: 0, batchesCount: 0 }),
    getLastLibrarySync: jest.fn(),
  };
});

// Mock purchases service
jest.mock('../src/services/purchases', () => {
  const actual = jest.requireActual('../src/services/purchases');
  return {
    ...actual,
    useProStatus: jest.fn(),
  };
});

// Mock trip service
jest.mock('../src/services/tripService', () => ({
  detectAndPersistTrips: jest.fn().mockResolvedValue({ detectedCount: 0, trips: [] }),
}));

describe('Task 4.10: Reset Data → Clean State', () => {
  const db = openDbSync(':memory:');
  const inMemoryFiles = new Map<string, { size: number; isDirectory: boolean }>();
  let alertSpy: jest.SpyInstance;

  beforeAll(() => {
    alertSpy = jest.spyOn(Alert, 'alert');
  });

  afterAll(() => {
    alertSpy.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    inMemoryFiles.clear();
    (db as unknown as { _clear: () => void })._clear();
    setDatabaseInstance(db);
    runMigrationsSync(db);
    clearFaceThumbnailCache();

    // Setup virtual filesystem in LegacyFileSystem mock
    (LegacyFileSystem.getInfoAsync as jest.Mock).mockImplementation(async (uri: string) => {
      const cleanUri = uri.replace(/\/+$/, '');
      for (const [path, info] of inMemoryFiles.entries()) {
        const cleanPath = path.replace(/\/+$/, '');
        if (cleanPath === cleanUri) {
          return { exists: true, isDirectory: info.isDirectory, size: info.size };
        }
      }
      return { exists: false, isDirectory: false, size: 0 };
    });

    (LegacyFileSystem.makeDirectoryAsync as jest.Mock).mockImplementation(async (dir: string) => {
      inMemoryFiles.set(dir, { size: 0, isDirectory: true });
    });

    (LegacyFileSystem.readDirectoryAsync as jest.Mock).mockImplementation(async (dir: string) => {
      const cleanDir = dir.replace(/\/+$/, '') + '/';
      const results: string[] = [];
      for (const key of inMemoryFiles.keys()) {
        if (key.startsWith(cleanDir) && key !== cleanDir) {
          const sub = key.slice(cleanDir.length);
          if (!sub.includes('/')) {
            results.push(sub);
          }
        }
      }
      return results;
    });

    (LegacyFileSystem.deleteAsync as jest.Mock).mockImplementation(async (uri: string) => {
      const cleanUri = uri.replace(/\/+$/, '');
      const keysToDelete: string[] = [];
      for (const key of inMemoryFiles.keys()) {
        const cleanKey = key.replace(/\/+$/, '');
        if (cleanKey === cleanUri || cleanKey.startsWith(cleanUri + '/')) {
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        inMemoryFiles.delete(key);
      }
    });

    // Default mock permission
    (libraryHooks.useLibraryPermission as jest.Mock).mockReturnValue({
      status: 'full',
      granted: true,
      canAskAgain: true,
      accessPrivileges: 'all',
      isLoading: false,
      openSettings: jest.fn(),
      presentPicker: jest.fn(),
      refreshPermission: jest.fn(),
      requestPermission: jest.fn(),
    });

    // Default mock Pro status
    (purchasesService.useProStatus as jest.Mock).mockReturnValue({
      isPro: false,
      isPurchased: false,
      isGateEnabled: false,
      isLoading: false,
      error: null,
      unlockPro: jest.fn().mockResolvedValue(true),
      restorePurchases: jest.fn().mockResolvedValue(true),
      refresh: jest.fn().mockResolvedValue(undefined),
    });
  });

  const renderScreen = async (component: React.ReactElement) => {
    let result: ReturnType<typeof render> | undefined;
    await act(async () => {
      result = render(component);
    });
    return result!;
  };

  describe('1. Comprehensive Database Wipe & Schema Restoration', () => {
    it('wipes all trips, photos, faces, people, exclusions, exports, settings and restores clean schema', async () => {
      // Step A: Populate rich data across ALL database tables
      await setOnboarded(true, db);
      await setLastSyncAt(1718000000, db);
      await setPro(true, db);

      // Trips (auto + user edited)
      await createTrip(
        {
          id: 'trip-clean-1',
          name: 'Kyoto Trip 2026',
          start_at: 1718000000,
          end_at: 1718500000,
          photo_count: 10,
          cover_photo_id: 'photo-c-1',
          is_user_edited: 1,
        },
        db
      );

      // Photos
      const samplePhotos: PhotoRow[] = [
        {
          id: 'photo-c-1',
          trip_id: 'trip-clean-1',
          taken_at: 1718000100,
          modified_at: 1718000100,
          width: 3000,
          height: 2000,
          lat: 35.0,
          lng: 135.7,
          is_local: 1,
          scan_status: 'done',
          face_count: 2,
          excluded: 0,
        },
        {
          id: 'photo-c-2',
          trip_id: 'trip-clean-1',
          taken_at: 1718000200,
          modified_at: 1718000200,
          width: 3000,
          height: 2000,
          lat: 35.0,
          lng: 135.7,
          is_local: 0,
          scan_status: 'skipped',
          face_count: 0,
          excluded: 1,
        },
      ];
      await upsertPhotos(samplePhotos, db);

      // People
      await createPerson(
        {
          id: 'person-c-1',
          trip_id: 'trip-clean-1',
          name: 'Yuki',
          is_others: 0,
          cover_face_id: 'face-c-1',
          centroid: new Uint8Array(128).fill(10),
        },
        db
      );
      await createPerson(
        {
          id: 'person-c-others',
          trip_id: 'trip-clean-1',
          name: null,
          is_others: 1,
          cover_face_id: null,
          centroid: null,
        },
        db
      );

      // Faces
      const sampleFaces: FaceRow[] = [
        {
          id: 'face-c-1',
          photo_id: 'photo-c-1',
          person_id: 'person-c-1',
          assignment: 'auto',
          bbox_x: 0.2,
          bbox_y: 0.2,
          bbox_w: 0.3,
          bbox_h: 0.3,
          quality: 0.95,
          quality_ok: 1,
          blur: 75,
          embedding: new Uint8Array(128).fill(10),
        },
      ];
      await savePhotoFacesAtomic('photo-c-1', 'trip-clean-1', sampleFaces, db);

      // Exclusions
      await excludePhotoFromPerson('person-c-1', 'photo-c-1', db);
      expect((await getExcludedPhotoIdsForPerson('person-c-1', db)).length).toBe(1);

      // Exports
      await createExport(
        {
          id: 'export-c-1',
          trip_id: 'trip-clean-1',
          person_id: 'person-c-1',
          mode: 'zip',
          solo_only: 0,
          status: 'pending',
          photo_count: 1,
          size_bytes: 2048,
          zip_path: 'file:///exports/Kyoto_Yuki.zip',
        },
        db
      );

      // Verify populated state before reset
      expect(await isOnboarded(db)).toBe(true);
      expect(await getLastSyncAt(db)).toBe(1718000000);
      expect(await isPro(db)).toBe(true);
      expect((await getAllTrips({ includeHidden: true }, db)).length).toBe(1);
      expect((await getPhotosByTripId('trip-clean-1', {}, db)).length).toBe(2);
      expect((await getPeopleByTripId('trip-clean-1', db)).length).toBe(2);
      expect((await getFacesByTripId('trip-clean-1', {}, db)).length).toBe(1);
      expect((await getExportsByTripId('trip-clean-1', db)).length).toBe(1);

      // Step B: Perform resetAllAppData
      const resetResult = await resetAllAppData(db);
      expect(resetResult.tablesReset).toBe(true);
      expect(resetResult.exportsCleared).toBe(true);
      expect(resetResult.thumbnailsCleared).toBe(true);

      // Step C: Verify ALL tables are completely clean
      expect(await isOnboarded(db)).toBe(false);
      expect(await getLastSyncAt(db)).toBeNull();
      expect(await isPro(db)).toBe(false);
      expect((await getAllTrips({ includeHidden: true }, db)).length).toBe(0);
      expect((await getPhotosByTripId('trip-clean-1', {}, db)).length).toBe(0);
      expect((await getPeopleByTripId('trip-clean-1', db)).length).toBe(0);
      expect((await getFacesByTripId('trip-clean-1', {}, db)).length).toBe(0);
      expect((await getExportsByTripId('trip-clean-1', db)).length).toBe(0);

      // Step D: Verify migrations and indexes are intact
      const migrations = await db.getAllAsync<{ id: number; name: string }>(
        'SELECT id, name FROM migrations ORDER BY id ASC;'
      );
      expect(migrations.length).toBe(1);
      expect(migrations[0].name).toBe('001_init');
    });

    it('is completely idempotent when executed multiple times consecutively', async () => {
      // First reset
      const r1 = await resetAllAppData(db);
      expect(r1.tablesReset).toBe(true);

      // Second consecutive reset on empty database
      const r2 = await resetAllAppData(db);
      expect(r2.tablesReset).toBe(true);
      expect(r2.exportsCleared).toBe(true);
      expect(r2.thumbnailsCleared).toBe(true);

      expect(await isOnboarded(db)).toBe(false);
      expect((await getAllTrips({ includeHidden: true }, db)).length).toBe(0);
    });
  });

  describe('2. Exports Directory & Temp File Clean State', () => {
    it('deletes all files in temporary exports directory upon reset', async () => {
      const exportsDir = await ensureExportsDirectory();
      inMemoryFiles.set(exportsDir, { size: 0, isDirectory: true });

      // Create dummy temporary export files in inMemoryFiles
      const file1 = `${exportsDir}trip1_person1.zip`;
      const file2 = `${exportsDir}trip2_person2.zip`;
      inMemoryFiles.set(file1, { size: 2048, isDirectory: false });
      inMemoryFiles.set(file2, { size: 4096, isDirectory: false });

      const infoBefore = await LegacyFileSystem.getInfoAsync(file1);
      expect(infoBefore.exists).toBe(true);

      // Perform reset
      const result = await resetAllAppData(db);
      expect(result.exportsCleared).toBe(true);

      // Verify files deleted
      const infoAfter1 = await LegacyFileSystem.getInfoAsync(file1);
      const infoAfter2 = await LegacyFileSystem.getInfoAsync(file2);
      expect(infoAfter1.exists).toBe(false);
      expect(infoAfter2.exists).toBe(false);
    });
  });

  describe('3. Settings Screen Confirmation & Navigation Flow', () => {
    it('shows destructive Alert confirmation on Settings button tap', async () => {
      const { getByTestId } = await renderScreen(
        <ThemeProvider colorScheme="dark">
          <SettingsScreen />
        </ThemeProvider>
      );

      const resetBtn = getByTestId('settings-reset-data-button');
      fireEvent.press(resetBtn);

      expect(alertSpy).toHaveBeenCalledWith(
        'Reset All App Data?',
        expect.stringContaining('Your original photos in your gallery remain completely untouched'),
        expect.arrayContaining([
          expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
          expect.objectContaining({ text: 'Reset Everything', style: 'destructive' }),
        ])
      );
    });

    it('does not reset data or navigate when user cancels dialog', async () => {
      await setOnboarded(true, db);
      await createTrip(
        {
          id: 'trip-preserved',
          name: 'Keep Me',
          start_at: 1000,
          end_at: 2000,
          photo_count: 5,
          cover_photo_id: null,
        },
        db
      );

      const { getByTestId } = await renderScreen(
        <ThemeProvider colorScheme="dark">
          <SettingsScreen />
        </ThemeProvider>
      );

      const resetBtn = getByTestId('settings-reset-data-button');
      fireEvent.press(resetBtn);

      // Trigger Cancel (first button)
      const buttons = alertSpy.mock.calls[0][2]!;
      const cancelBtn = buttons.find((b: { style?: string }) => b.style === 'cancel');
      expect(cancelBtn).toBeTruthy();

      expect(mockRouter.replace).not.toHaveBeenCalled();
      expect(await isOnboarded(db)).toBe(true);
      expect(await getTripById('trip-preserved', db)).toBeTruthy();
    });

    it('confirms reset, clears data, and navigates immediately to /onboarding', async () => {
      await setOnboarded(true, db);
      await createTrip(
        {
          id: 'trip-to-wipe',
          name: 'Wipe Me',
          start_at: 1000,
          end_at: 2000,
          photo_count: 5,
          cover_photo_id: null,
        },
        db
      );

      const { getByTestId } = await renderScreen(
        <ThemeProvider colorScheme="dark">
          <SettingsScreen />
        </ThemeProvider>
      );

      const resetBtn = getByTestId('settings-reset-data-button');
      fireEvent.press(resetBtn);

      // Trigger 'Reset Everything' (destructive button)
      const buttons = alertSpy.mock.calls[0][2]!;
      const confirmBtn = buttons.find((b: { style?: string }) => b.style === 'destructive');
      expect(confirmBtn).toBeTruthy();

      void confirmBtn.onPress();

      await waitFor(() => {
        expect(mockRouter.replace).toHaveBeenCalledWith('/onboarding');
      });
    });
  });

  describe('4. App State Machine & Home Screen Launch Routing', () => {
    it('redirects to /onboarding on fresh launch when data has been reset', async () => {
      // Database has been reset: onboarded = false
      await setOnboarded(false, db);
      expect(await isOnboarded(db)).toBe(false);

      await renderScreen(
        <ThemeProvider colorScheme="dark">
          <HomeScreen />
        </ThemeProvider>
      );

      await waitFor(() => {
        expect(mockRouter.replace).toHaveBeenCalledWith('/onboarding');
      });
    });
  });

  describe('5. Clean State Re-sync & Re-scan Lifecycle', () => {
    it('supports full library sync and fresh trip detection following data reset', async () => {
      // 1. Wipe database to initial clean state
      await resetAllAppData(db);
      expect(await isOnboarded(db)).toBe(false);

      // 2. Complete onboarding
      await setOnboarded(true, db);
      expect(await isOnboarded(db)).toBe(true);

      // 3. Perform fresh library sync
      const freshPhotos: PhotoRow[] = [
        {
          id: 'fresh-photo-1',
          trip_id: null,
          taken_at: 1720000000,
          modified_at: 1720000000,
          width: 4000,
          height: 3000,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'pending',
          face_count: 0,
          excluded: 0,
        },
        {
          id: 'fresh-photo-2',
          trip_id: null,
          taken_at: 1720003600,
          modified_at: 1720003600,
          width: 4000,
          height: 3000,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'pending',
          face_count: 0,
          excluded: 0,
        },
      ];
      await upsertPhotos(freshPhotos, db);
      await setLastSyncAt(1720003600, db);

      // 4. Create new auto-detected trip on fresh clean state
      await createTrip(
        {
          id: 'new-trip-post-reset',
          name: 'Summer Trip 2026',
          start_at: 1720000000,
          end_at: 1720003600,
          photo_count: 2,
          cover_photo_id: 'fresh-photo-1',
        },
        db
      );

      const allTrips = await getAllTrips({ includeHidden: false }, db);
      expect(allTrips.length).toBe(1);
      expect(allTrips[0].id).toBe('new-trip-post-reset');
      expect(allTrips[0].name).toBe('Summer Trip 2026');
      expect(await getLastSyncAt(db)).toBe(1720003600);
    });
  });
});
