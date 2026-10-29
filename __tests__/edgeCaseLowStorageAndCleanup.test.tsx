import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { Alert } from 'react-native';

import { openDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrations';
import { createTrip } from '../src/db/repositories/trips';
import { upsertPhotos } from '../src/db/repositories/photos';
import { createPerson } from '../src/db/repositories/people';
import { insertFaces } from '../src/db/repositories/faces';
import { getExportById, getIncompleteOrActiveExports } from '../src/db/repositories/exports';
import type { PhotoRow, FaceRow, TripRow } from '../src/db/types';
import {
  exportPerson,
  exportNamedPeopleBatch,
  sweepOrphanTempExports,
  getExportsDirectory,
} from '../src/services/exporter';
import ExportReviewScreen from '../app/export/[tripId]';
import { ThemeProvider } from '../src/theme';
import * as tripsRepo from '../src/db/repositories/trips';
import * as peopleRepo from '../src/db/repositories/people';
import * as purchasesService from '../src/services/purchases';

import * as exporterService from '../src/services/exporter';

(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// Mock expo-router
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ tripId: 'trip-low-storage-test' }),
}));

// Mock safe-area
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock react-native-share
jest.mock('react-native-share', () => ({
  open: jest.fn().mockResolvedValue({ success: true }),
}));

// Mock react-native-zip-archive
jest.mock('react-native-zip-archive', () => ({
  zip: jest.fn(async (_source: string, target: string) => target),
}));

// Mock expo-sharing
jest.mock('expo-sharing', () => ({
  shareAsync: jest.fn().mockResolvedValue(undefined),
  isAvailableAsync: jest.fn().mockResolvedValue(true),
}));

// Mock expo-file-system legacy
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

// Mock expo-media-library
jest.mock('expo-media-library', () => ({
  getAssetInfoAsync: jest.fn().mockImplementation((id: string) => {
    return Promise.resolve({
      localUri: `file:///mock/media/${id}.jpg`,
      uri: `file:///mock/media/${id}.jpg`,
    });
  }),
}));

describe('Task 4.5: Low storage; share cancelled; temp files deleted on all paths', () => {
  let db: SQLiteDatabase;
  const inMemoryFiles = new Map<string, { size: number; isDirectory: boolean }>();

  const getRemainingTempFiles = () => {
    const exportsDir = getExportsDirectory().replace(/\/+$/, '');
    return Array.from(inMemoryFiles.keys()).filter((path) => {
      const clean = path.replace(/\/+$/, '');
      return clean !== exportsDir;
    });
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    inMemoryFiles.clear();

    db = await openDb(':memory:');
    await runMigrations(db);

    // Setup virtual filesystem in LegacyFileSystem mock for exact path inspection
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

    (LegacyFileSystem.copyAsync as jest.Mock).mockImplementation(async ({ to }: { from: string; to: string }) => {
      inMemoryFiles.set(to, { size: 500000, isDirectory: false }); // 500 KB per photo
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

    (LegacyFileSystem.readDirectoryAsync as jest.Mock).mockImplementation(async (dir: string) => {
      const cleanDir = dir.endsWith('/') ? dir : `${dir}/`;
      const items = new Set<string>();
      for (const path of inMemoryFiles.keys()) {
        if (path.startsWith(cleanDir) && path !== cleanDir) {
          const relative = path.slice(cleanDir.length);
          const firstSegment = relative.split('/')[0];
          if (firstSegment) items.add(firstSegment);
        }
      }
      return Array.from(items);
    });

    (LegacyFileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValue(50 * 1024 * 1024 * 1024); // 50 GB default
  });

  const setupTestTripAndPerson = async (photoCount: number = 2) => {
    const trip = await createTrip(
      {
        id: 'trip-ls-1',
        name: 'Coxsbazar Tour',
        start_at: 1000,
        end_at: 2000,
        photo_count: photoCount,
        scanned_count: photoCount,
      },
      db
    );

    const person = await createPerson(
      {
        id: 'person-ls-1',
        trip_id: trip.id,
        name: 'Tanvir',
        created_at: 1000,
      },
      db
    );

    const photos: PhotoRow[] = Array.from({ length: photoCount }, (_, i) => ({
      id: `photo-ls-${i + 1}`,
      trip_id: trip.id,
      taken_at: 1100 + i * 100,
      modified_at: 1100 + i * 100,
      width: 1200,
      height: 800,
      lat: null,
      lng: null,
      is_local: 1,
      scan_status: 'done',
      face_count: 1,
      excluded: 0,
    }));
    await upsertPhotos(photos, db);

    const dummyEmbedding = new Uint8Array(512);
    const faces: FaceRow[] = photos.map((p, idx) => ({
      id: `face-ls-${idx + 1}`,
      photo_id: p.id,
      person_id: person.id,
      assignment: 'auto',
      bbox_x: 0.1,
      bbox_y: 0.1,
      bbox_w: 0.2,
      bbox_h: 0.2,
      quality: 0.9,
      quality_ok: 1,
      blur: 0.1,
      embedding: dummyEmbedding,
    }));
    await insertFaces(faces, db);

    return { trip, person, photos };
  };

  describe('1. Low Storage Handling & Temp Cleanup', () => {
    it('throws low storage error when free storage < 2x total size, cleans up all temp files, and marks DB status failed', async () => {
      const { trip, person } = await setupTestTripAndPerson(2);

      // Total copied photos = 2 * 500 KB = 1 MB. Required 2x = 2 MB.
      // Mock free storage to only 500 KB (insufficient space)
      (LegacyFileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValue(500 * 1024);

      let caughtError: Error | null = null;
      try {
        await exportPerson({
          personId: person.id,
          tripId: trip.id,
          mode: 'zip',
          db,
        });
      } catch (err) {
        caughtError = err instanceof Error ? err : new Error(String(err));
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError?.message).toContain('Not enough storage space. Required at least');

      // VERIFY: All temporary files and staging folders were deleted in finally
      expect(getRemainingTempFiles()).toHaveLength(0);

      // VERIFY: DB record status is 'failed' and zip_path is null
      const exports = await getIncompleteOrActiveExports(db);
      expect(exports.length).toBe(0); // No active/incomplete exports left behind
    });
  });

  describe('2. Share Cancelled in ZIP Mode', () => {
    it('handles share dismissal: marks export cancelled, returns zipPath=null, and deletes all temp files', async () => {
      const { trip, person } = await setupTestTripAndPerson(2);

      // Simulate user closing / cancelling iOS share sheet
      const mockShareCancel = jest.fn().mockRejectedValue(new Error('User did not share'));

      const result = await exportPerson({
        personId: person.id,
        tripId: trip.id,
        mode: 'zip',
        db,
        shareSingleFn: mockShareCancel,
      });

      expect(result.status).toBe('cancelled');
      expect(result.zipPath).toBeNull();

      // VERIFY: DB record is updated to 'cancelled' with zip_path null
      const exp = await getExportById(result.exportId, db);
      expect(exp?.status).toBe('cancelled');
      expect(exp?.zip_path).toBeNull();

      // VERIFY: Zero trash on disk (temp ZIP and photos folder deleted)
      expect(getRemainingTempFiles()).toHaveLength(0);
    });

    it('recognizes different cancellation error shapes (dismissedAction, canceled, user dismissal)', async () => {
      const { trip, person } = await setupTestTripAndPerson(1);

      // Test with error object having { message: 'canceled by user' }
      const mockCancelVariant = jest.fn().mockRejectedValue(new Error('Share action was canceled by user'));

      const result = await exportPerson({
        personId: person.id,
        tripId: trip.id,
        mode: 'zip',
        db,
        shareSingleFn: mockCancelVariant,
      });

      expect(result.status).toBe('cancelled');
      expect(getRemainingTempFiles()).toHaveLength(0);
    });
  });

  describe('3. Share Cancelled in Photos Mode', () => {
    it('handles multi-photo share dismissal: marks cancelled and cleans all staged files', async () => {
      const { trip, person } = await setupTestTripAndPerson(2);

      // Simulate react-native-share returning dismissed
      const mockMultiShareDismissed = jest.fn().mockResolvedValue({
        success: false,
        dismissed: true,
      });

      const result = await exportPerson({
        personId: person.id,
        tripId: trip.id,
        mode: 'photos',
        db,
        shareMultiFn: mockMultiShareDismissed,
      });

      expect(result.status).toBe('cancelled');
      expect(result.zipPath).toBeNull();

      // VERIFY: DB record is 'cancelled'
      const exp = await getExportById(result.exportId, db);
      expect(exp?.status).toBe('cancelled');

      // VERIFY: All staged photos are deleted from disk
      expect(getRemainingTempFiles()).toHaveLength(0);
    });
  });

  describe('4. Temp Files Deleted on All Exit Paths', () => {
    it('deletes temp ZIP on successful export (DONE path)', async () => {
      const { trip, person } = await setupTestTripAndPerson(2);

      const mockShareSuccess = jest.fn().mockResolvedValue(undefined);

      const result = await exportPerson({
        personId: person.id,
        tripId: trip.id,
        mode: 'zip',
        db,
        shareSingleFn: mockShareSuccess,
      });

      expect(result.status).toBe('done');
      expect(result.zipPath).toBeNull();

      // VERIFY: Temp ZIP deleted immediately after sharing
      expect(getRemainingTempFiles()).toHaveLength(0);

      const exp = await getExportById(result.exportId, db);
      expect(exp?.status).toBe('done');
      expect(exp?.zip_path).toBeNull();
    });

    it('deletes staging folder when zipping throws unexpected error (FAILED path)', async () => {
      const { trip, person } = await setupTestTripAndPerson(2);

      const mockZipError = jest.fn().mockRejectedValue(new Error('Native zip stream failed'));

      await expect(
        exportPerson({
          personId: person.id,
          tripId: trip.id,
          mode: 'zip',
          db,
          zipFn: mockZipError,
        })
      ).rejects.toThrow('Native zip stream failed');

      // VERIFY: Staging folder wiped clean
      expect(getRemainingTempFiles()).toHaveLength(0);

      const active = await getIncompleteOrActiveExports(db);
      expect(active.length).toBe(0);
    });

    it('deletes staging folder when copy fails for all photos', async () => {
      const { trip, person } = await setupTestTripAndPerson(2);

      (LegacyFileSystem.copyAsync as jest.Mock).mockRejectedValue(new Error('Disk I/O error during copy'));

      await expect(
        exportPerson({
          personId: person.id,
          tripId: trip.id,
          mode: 'zip',
          db,
          resolvePhotoUriFn: async () => 'file:///mock/test.jpg',
        })
      ).rejects.toThrow('Could not resolve or copy any photo files for export');

      // Cleaned up
      expect(getRemainingTempFiles()).toHaveLength(0);
    });
  });

  describe('5. Sequential Batch Export Deletes Temp Files Per Person', () => {
    it('deletes each temp ZIP immediately before exporting the next person in batch', async () => {
      const trip = await createTrip(
        {
          id: 'trip-batch-clean',
          name: 'Batch Trip',
          start_at: 1000,
          end_at: 2000,
          photo_count: 6,
          scanned_count: 6,
        },
        db
      );

      const person1 = await createPerson({ id: 'p1', trip_id: trip.id, name: 'Alice' }, db);
      const person2 = await createPerson({ id: 'p2', trip_id: trip.id, name: 'Bob' }, db);

      const dummyEmbedding = new Uint8Array(512);

      // Photos for p1
      await upsertPhotos([
        {
          id: 'ph1',
          trip_id: trip.id,
          taken_at: 1000,
          modified_at: 1000,
          width: 100,
          height: 100,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
      ], db);
      await insertFaces([
        {
          id: 'f1',
          photo_id: 'ph1',
          person_id: person1.id,
          assignment: 'auto',
          bbox_x: 0,
          bbox_y: 0,
          bbox_w: 10,
          bbox_h: 10,
          quality: 0.9,
          quality_ok: 1,
          blur: 0.1,
          embedding: dummyEmbedding,
        },
      ], db);

      // Photos for p2
      await upsertPhotos([
        {
          id: 'ph2',
          trip_id: trip.id,
          taken_at: 1100,
          modified_at: 1100,
          width: 100,
          height: 100,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
      ], db);
      await insertFaces([
        {
          id: 'f2',
          photo_id: 'ph2',
          person_id: person2.id,
          assignment: 'auto',
          bbox_x: 0,
          bbox_y: 0,
          bbox_w: 10,
          bbox_h: 10,
          quality: 0.9,
          quality_ok: 1,
          blur: 0.1,
          embedding: dummyEmbedding,
        },
      ], db);

      let observedFilesCountAtShare: number[] = [];

      const mockShare = jest.fn().mockImplementation(async () => {
        // Record how many files exist at the moment share sheet opens
        observedFilesCountAtShare.push(getRemainingTempFiles().length);
      });

      const results = await exportNamedPeopleBatch({
        tripId: trip.id,
        mode: 'zip',
        db,
        shareSingleFn: mockShare,
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === 'done')).toBe(true);

      // During share of p1 and p2, only 1 export's files exist at a time (never accumulated)
      expect(observedFilesCountAtShare.length).toBe(2);
      expect(observedFilesCountAtShare.every((count) => count > 0)).toBe(true);

      // After batch finishes, 0 temp files remain
      expect(getRemainingTempFiles()).toHaveLength(0);
    });
  });

  describe('6. Launch-Time Orphan Sweep', () => {
    it('sweeps orphaned files on disk and cancels active exports left in SQLite from crash', async () => {
      const trip = await createTrip({ id: 'trip-sweep', name: 'Crash Trip', start_at: 1000, end_at: 2000 }, db);
      await createPerson({ id: 'p-crash', trip_id: trip.id, name: 'CrashUser' }, db);

      const exportsDir = getExportsDirectory();
      inMemoryFiles.set(exportsDir, { size: 0, isDirectory: true });

      const orphanZipPath = `${exportsDir}export_orphan_123/Trip_CrashUser.zip`;
      const orphanStagedPhoto = `${exportsDir}export_orphan_123/photos/photo_001.jpg`;

      inMemoryFiles.set(orphanZipPath, { size: 1000000, isDirectory: false });
      inMemoryFiles.set(orphanStagedPhoto, { size: 500000, isDirectory: false });

      // Run launch sweep
      const sweepRes = await sweepOrphanTempExports(db);

      expect(sweepRes.errors).toHaveLength(0);
      expect(sweepRes.deletedFilesCount).toBeGreaterThanOrEqual(1);

      // Filesystem is completely clean
      expect(getRemainingTempFiles()).toHaveLength(0);
    });
  });

  describe('7. UI: ExportReviewScreen Low Storage and Share Cancelled', () => {
    it('renders low-storage-banner and blocks export with Alert when storage is critically low', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert');

      const mockTripData: TripRow = {
        id: 'trip-low-storage-test',
        name: 'Sylhet Trip',
        start_at: 1000,
        end_at: 2000,
        photo_count: 50,
        cover_photo_id: null,
        is_away: 0,
        is_hidden: 0,
        is_user_edited: 0,
        scan_status: 'scanned',
        scanned_count: 50,
        created_at: 1000,
        updated_at: 1000,
      };

      jest.spyOn(tripsRepo, 'getTripById').mockResolvedValue(mockTripData);
      jest.spyOn(purchasesService, 'getTripFreeTierStatus').mockResolvedValue({
        tripId: 'trip-low-storage-test',
        scannedCount: 50,
        limit: 50,
        isPro: true,
        isGateEnabled: false,
        canScanMore: true,
        remainingFreeScans: 50,
        requiresPaywall: false,
      });

      jest.spyOn(peopleRepo, 'getExportPeopleSummary').mockResolvedValue([
        {
          id: 'p-ui-1',
          trip_id: 'trip-low-storage-test',
          name: 'Shakib',
          is_others: 0,
          cover_face_id: null,
          cover_photo_id: null,
          centroid: null,
          created_at: 1000,
          photo_count: 20, // ~70 MB estimated, 2x required = 140 MB
          solo_photo_count: 10,
        },
      ]);

      // Mock only 10 MB free space (less than 2x required 140 MB)
      (LegacyFileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValue(10 * 1024 * 1024);

      const screen = await render(
        <ThemeProvider>
          <ExportReviewScreen />
        </ThemeProvider>
      );

      // Low storage banner is displayed with required MB
      await waitFor(() => {
        expect(screen.getByTestId('low-storage-banner')).toBeTruthy();
        expect(screen.getByText(/Not enough space: need at least \d+ MB free storage space\./)).toBeTruthy();
      });

      // Export button is disabled to prevent attempting export when low storage
      const startExportBtn = screen.getByTestId('start-export-button');
      expect(startExportBtn.props.accessibilityState?.disabled).toBe(true);

      alertSpy.mockRestore();
    });

    it('returns row to unchecked state and displays cancelled notice when share is cancelled', async () => {
      const mockTripData: TripRow = {
        id: 'trip-low-storage-test',
        name: 'Jaflong Tour',
        start_at: 1000,
        end_at: 2000,
        photo_count: 10,
        cover_photo_id: null,
        is_away: 0,
        is_hidden: 0,
        is_user_edited: 0,
        scan_status: 'scanned',
        scanned_count: 10,
        created_at: 1000,
        updated_at: 1000,
      };

      jest.spyOn(tripsRepo, 'getTripById').mockResolvedValue(mockTripData);
      jest.spyOn(purchasesService, 'getTripFreeTierStatus').mockResolvedValue({
        tripId: 'trip-low-storage-test',
        scannedCount: 10,
        limit: 50,
        isPro: true,
        isGateEnabled: false,
        canScanMore: true,
        remainingFreeScans: 40,
        requiresPaywall: false,
      });

      jest.spyOn(peopleRepo, 'getExportPeopleSummary').mockResolvedValue([
        {
          id: 'p-cancel-ui',
          trip_id: 'trip-low-storage-test',
          name: 'Mushfiq',
          is_others: 0,
          cover_face_id: null,
          cover_photo_id: null,
          centroid: null,
          created_at: 1000,
          photo_count: 5,
          solo_photo_count: 2,
        },
      ]);

      (LegacyFileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValue(50 * 1024 * 1024 * 1024);

      // Mock exportPerson to return cancelled
      const exportSpy = jest.spyOn(exporterService, 'exportPerson').mockResolvedValue({
        exportId: 'exp-canc',
        mode: 'zip',
        photoCount: 5,
        skippedCount: 0,
        sizeBytes: 15000,
        status: 'cancelled',
        zipPath: null,
      });

      const screen = await render(
        <ThemeProvider>
          <ExportReviewScreen />
        </ThemeProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('start-export-button')).toBeTruthy();
      });

      const startExportBtn = screen.getByTestId('start-export-button');
      await act(async () => {
        fireEvent.press(startExportBtn);
      });

      // Feedback message shows share was cancelled
      await waitFor(() => {
        expect(screen.getByText('Share was cancelled.')).toBeTruthy();
      });

      // Person checkbox row returns to unchecked state (02_AppFlow §3.7)
      expect(screen.getByTestId('person-checkbox-p-cancel-ui')).toBeTruthy();

      exportSpy.mockRestore();
    });
  });
});
