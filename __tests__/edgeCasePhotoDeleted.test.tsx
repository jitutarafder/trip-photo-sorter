import * as React from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

import { openDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrations';
import { createTrip, getTripById } from '../src/db/repositories/trips';
import { upsertPhotos, getPhotoById } from '../src/db/repositories/photos';
import { createPerson } from '../src/db/repositories/people';
import { insertFaces, getFacesByPhotoId } from '../src/db/repositories/faces';
import type { PhotoRow, FaceRow, TripRow } from '../src/db/types';
import { exportPerson } from '../src/services/exporter';
import {
  reconcileDeletedGalleryPhotos,
  syncLibrary,
} from '../src/services/library';
import ExportReviewScreen from '../app/export/[tripId]';
import { ThemeProvider } from '../src/theme';
import * as tripsRepo from '../src/db/repositories/trips';
import * as peopleRepo from '../src/db/repositories/people';
import * as purchasesService from '../src/services/purchases';
import * as exporterService from '../src/services/exporter';

jest.setTimeout(15000);
(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// Mock expo-router
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ tripId: 'trip-export-ui-test' }),
}));

// Mock safe-area
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock expo-file-system/legacy
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///mock/cache/',
  documentDirectory: 'file:///mock/documents/',
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true, isDirectory: false, size: 5000 }),
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  readDirectoryAsync: jest.fn().mockResolvedValue([]),
  copyAsync: jest.fn().mockResolvedValue(undefined),
  getFreeDiskStorageAsync: jest.fn().mockResolvedValue(50 * 1024 * 1024 * 1024),
}));

// Mock expo-media-library
jest.mock('expo-media-library', () => {
  return {
    getPermissionsAsync: jest.fn().mockResolvedValue({
      status: 'granted',
      granted: true,
      canAskAgain: true,
      accessPrivileges: 'all',
    }),
    requestPermissionsAsync: jest.fn().mockResolvedValue({
      status: 'granted',
      granted: true,
      canAskAgain: true,
      accessPrivileges: 'all',
    }),
    getAssetsAsync: jest.fn().mockResolvedValue({
      assets: [],
      endCursor: undefined,
      hasNextPage: false,
      totalCount: 0,
    }),
    getAssetInfoAsync: jest.fn().mockImplementation((id: string) => {
      return Promise.resolve({
        localUri: `file:///mock/media/${id}.jpg`,
        uri: `file:///mock/media/${id}.jpg`,
      });
    }),
    MediaType: { photo: 'photo' },
    SortBy: { creationTime: 'creationTime' },
    PermissionStatus: {
      GRANTED: 'granted',
      DENIED: 'denied',
      UNDETERMINED: 'undetermined',
    },
  };
});

describe('Task 4.3 Edge Cases: Photo deleted between scan and export', () => {
  let db: SQLiteDatabase;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = await openDb(':memory:');
    await runMigrations(db);
  });

  describe('1. ExportPerson handles photo deleted from gallery', () => {
    it('silently skips deleted photos, tracks skippedCount, and exports remaining photos', async () => {
      const trip = await createTrip(
        {
          id: 'trip-del-1',
          name: 'Deleted Photo Trip',
          start_at: 1000,
          end_at: 2000,
          photo_count: 2,
        },
        db
      );

      const person = await createPerson(
        {
          id: 'person-del-1',
          trip_id: trip.id,
          name: 'Alice',
          created_at: 1000,
        },
        db
      );

      const photos: PhotoRow[] = [
        {
          id: 'photo-available-1',
          trip_id: trip.id,
          taken_at: 1100,
          modified_at: 1100,
          width: 800,
          height: 600,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
        {
          id: 'photo-deleted-2',
          trip_id: trip.id,
          taken_at: 1200,
          modified_at: 1200,
          width: 800,
          height: 600,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
      ];
      await upsertPhotos(photos, db);

      const dummyEmbedding = new Uint8Array([1, 2, 3]);
      const faces: FaceRow[] = [
        {
          id: 'face-del-1',
          photo_id: 'photo-available-1',
          person_id: person.id,
          assignment: 'auto',
          bbox_x: 0,
          bbox_y: 0,
          bbox_w: 50,
          bbox_h: 50,
          quality: 0.9,
          quality_ok: 1,
          blur: 0.1,
          embedding: dummyEmbedding,
        },
        {
          id: 'face-del-2',
          photo_id: 'photo-deleted-2',
          person_id: person.id,
          assignment: 'auto',
          bbox_x: 0,
          bbox_y: 0,
          bbox_w: 50,
          bbox_h: 50,
          quality: 0.9,
          quality_ok: 1,
          blur: 0.1,
          embedding: dummyEmbedding,
        },
      ];
      await insertFaces(faces, db);

      const mockZipFn = jest.fn().mockImplementation(async (_src, target) => target);
      const mockShareFn = jest.fn().mockResolvedValue(undefined);

      // Custom resolver where photo-deleted-2 returns null (asset was deleted from gallery)
      const resolvePhotoUriFn = jest.fn().mockImplementation(async (p: PhotoRow) => {
        if (p.id === 'photo-deleted-2') {
          return null; // Missing asset
        }
        return `file:///photos/${p.id}.jpg`;
      });

      const result = await exportPerson({
        personId: person.id,
        tripId: trip.id,
        mode: 'zip',
        db,
        zipFn: mockZipFn,
        shareSingleFn: mockShareFn,
        resolvePhotoUriFn,
      });

      expect(result.status).toBe('done');
      expect(result.photoCount).toBe(1); // Only 1 photo copied
      expect(result.skippedCount).toBe(1); // 1 photo silently skipped
      expect(mockZipFn).toHaveBeenCalledTimes(1);
      expect(mockShareFn).toHaveBeenCalledTimes(1);
    });

    it('throws clean error when ALL photos for person are deleted before export', async () => {
      const trip = await createTrip(
        {
          id: 'trip-all-del',
          name: 'All Deleted Trip',
          start_at: 1000,
          end_at: 2000,
          photo_count: 1,
        },
        db
      );

      const person = await createPerson(
        {
          id: 'person-all-del',
          trip_id: trip.id,
          name: 'Bob',
          created_at: 1000,
        },
        db
      );

      const photos: PhotoRow[] = [
        {
          id: 'photo-gone-1',
          trip_id: trip.id,
          taken_at: 1100,
          modified_at: 1100,
          width: 800,
          height: 600,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
      ];
      await upsertPhotos(photos, db);

      const dummyEmbedding = new Uint8Array([1, 2, 3]);
      await insertFaces(
        [
          {
            id: 'face-gone-1',
            photo_id: 'photo-gone-1',
            person_id: person.id,
            assignment: 'auto',
            bbox_x: 0,
            bbox_y: 0,
            bbox_w: 50,
            bbox_h: 50,
            quality: 0.9,
            quality_ok: 1,
            blur: 0.1,
            embedding: dummyEmbedding,
          },
        ],
        db
      );

      const resolvePhotoUriFn = jest.fn().mockResolvedValue(null);

      await expect(
        exportPerson({
          personId: person.id,
          tripId: trip.id,
          mode: 'zip',
          db,
          resolvePhotoUriFn,
        })
      ).rejects.toThrow('Could not resolve or copy any photo files for export');
    });

    it('skips photo when copyAsync throws concurrent filesystem error', async () => {
      const trip = await createTrip(
        {
          id: 'trip-fs-err',
          name: 'FS Error Trip',
          start_at: 1000,
          end_at: 2000,
          photo_count: 2,
        },
        db
      );

      const person = await createPerson(
        {
          id: 'person-fs-err',
          trip_id: trip.id,
          name: 'Charlie',
          created_at: 1000,
        },
        db
      );

      const photos: PhotoRow[] = [
        {
          id: 'photo-ok',
          trip_id: trip.id,
          taken_at: 1100,
          modified_at: 1100,
          width: 800,
          height: 600,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
        {
          id: 'photo-fail-copy',
          trip_id: trip.id,
          taken_at: 1200,
          modified_at: 1200,
          width: 800,
          height: 600,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
      ];
      await upsertPhotos(photos, db);

      const dummyEmbedding = new Uint8Array([1, 2, 3]);
      await insertFaces(
        photos.map((p, idx) => ({
          id: `face-fs-${idx}`,
          photo_id: p.id,
          person_id: person.id,
          assignment: 'auto',
          bbox_x: 0,
          bbox_y: 0,
          bbox_w: 50,
          bbox_h: 50,
          quality: 0.9,
          quality_ok: 1,
          blur: 0.1,
          embedding: dummyEmbedding,
        })),
        db
      );

      (LegacyFileSystem.copyAsync as jest.Mock).mockImplementation(
        async ({ from }: { from: string }) => {
          if (from.includes('photo-fail-copy')) {
            throw new Error('File deleted during copy operation');
          }
        }
      );

      const mockZipFn = jest.fn().mockImplementation(async (_src, target) => target);
      const mockShareFn = jest.fn().mockResolvedValue(undefined);

      const result = await exportPerson({
        personId: person.id,
        tripId: trip.id,
        mode: 'zip',
        db,
        zipFn: mockZipFn,
        shareSingleFn: mockShareFn,
      });

      expect(result.status).toBe('done');
      expect(result.photoCount).toBe(1);
      expect(result.skippedCount).toBe(1);
    });
  });

  describe('2. Reconcile deleted gallery photos in SQLite database', () => {
    it('deletes missing photo records, cascades to faces, recomputes photo_count, and deletes empty auto trips', async () => {
      // Create auto-detected trip with 2 photos
      const autoTrip = await createTrip(
        {
          id: 'trip-auto-reconcile',
          name: 'Auto Trip',
          start_at: 1000,
          end_at: 2000,
          photo_count: 2,
          is_user_edited: 0,
        },
        db
      );

      // Create user-edited trip with 1 photo
      const userTrip = await createTrip(
        {
          id: 'trip-user-reconcile',
          name: 'User Edited Trip',
          start_at: 3000,
          end_at: 4000,
          photo_count: 1,
          is_user_edited: 1,
        },
        db
      );

      const photos: PhotoRow[] = [
        {
          id: 'photo-auto-1',
          trip_id: autoTrip.id,
          taken_at: 1100,
          modified_at: 1100,
          width: 800,
          height: 600,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
        {
          id: 'photo-auto-2',
          trip_id: autoTrip.id,
          taken_at: 1200,
          modified_at: 1200,
          width: 800,
          height: 600,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
        {
          id: 'photo-user-3',
          trip_id: userTrip.id,
          taken_at: 3100,
          modified_at: 3100,
          width: 800,
          height: 600,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
      ];
      await upsertPhotos(photos, db);

      const dummyEmbedding = new Uint8Array([1, 2, 3]);
      await insertFaces(
        [
          {
            id: 'face-auto-1',
            photo_id: 'photo-auto-1',
            person_id: null,
            assignment: 'auto',
            bbox_x: 0,
            bbox_y: 0,
            bbox_w: 50,
            bbox_h: 50,
            quality: 0.9,
            quality_ok: 1,
            blur: 0.1,
            embedding: dummyEmbedding,
          },
          {
            id: 'face-auto-2',
            photo_id: 'photo-auto-2',
            person_id: null,
            assignment: 'auto',
            bbox_x: 0,
            bbox_y: 0,
            bbox_w: 50,
            bbox_h: 50,
            quality: 0.9,
            quality_ok: 1,
            blur: 0.1,
            embedding: dummyEmbedding,
          },
          {
            id: 'face-user-3',
            photo_id: 'photo-user-3',
            person_id: null,
            assignment: 'auto',
            bbox_x: 0,
            bbox_y: 0,
            bbox_w: 50,
            bbox_h: 50,
            quality: 0.9,
            quality_ok: 1,
            blur: 0.1,
            embedding: dummyEmbedding,
          },
        ],
        db
      );

      // Gallery currently only has 'photo-auto-2'
      // photo-auto-1 and photo-user-3 were deleted from device
      const existingInGallery = ['photo-auto-2'];

      const result = await reconcileDeletedGalleryPhotos(existingInGallery, db);

      expect(result.deletedPhotosCount).toBe(2);
      expect(result.affectedTripsCount).toBe(2);
      expect(result.cleanedEmptyTripsCount).toBe(0); // userTrip is protected because is_user_edited = 1

      // Verify photos deleted from SQLite
      const photo1 = await getPhotoById('photo-auto-1', db);
      const photo2 = await getPhotoById('photo-auto-2', db);
      const photo3 = await getPhotoById('photo-user-3', db);

      expect(photo1).toBeNull();
      expect(photo2).not.toBeNull();
      expect(photo3).toBeNull();

      // Verify faces cascaded
      const facesPhoto1 = await getFacesByPhotoId('photo-auto-1', db);
      const facesPhoto2 = await getFacesByPhotoId('photo-auto-2', db);
      const facesPhoto3 = await getFacesByPhotoId('photo-user-3', db);

      expect(facesPhoto1).toHaveLength(0);
      expect(facesPhoto2).toHaveLength(1);
      expect(facesPhoto3).toHaveLength(0);

      // Verify trip photo_count recomputed
      const updatedAutoTrip = await getTripById(autoTrip.id, db);
      const updatedUserTrip = await getTripById(userTrip.id, db);

      expect(updatedAutoTrip).not.toBeNull();
      expect(updatedAutoTrip?.photo_count).toBe(1);

      // User edited trip has 0 photos remaining, but is retained
      expect(updatedUserTrip).not.toBeNull();
      expect(updatedUserTrip?.photo_count).toBe(0);

      // Now photo-auto-2 is also deleted from gallery
      const result2 = await reconcileDeletedGalleryPhotos([], db);
      expect(result2.deletedPhotosCount).toBe(1);
      expect(result2.cleanedEmptyTripsCount).toBe(1); // autoTrip cleaned up!

      const deletedAutoTrip = await getTripById(autoTrip.id, db);
      expect(deletedAutoTrip).toBeNull(); // Cleaned up because is_user_edited was 0
    });

    it('syncLibrary reconciles deleted photos during full sync', async () => {
      // Insert photo in DB
      await upsertPhotos(
        [
          {
            id: 'old-photo-deleted',
            trip_id: null,
            taken_at: 1000,
            modified_at: 1000,
            width: 800,
            height: 600,
            lat: null,
            lng: null,
            is_local: 1,
            scan_status: 'pending',
            face_count: 0,
            excluded: 0,
          },
        ],
        db
      );

      // MediaLibrary currently returns asset-new-1
      (MediaLibrary.getAssetsAsync as jest.Mock).mockResolvedValueOnce({
        assets: [
          {
            id: 'asset-new-1',
            creationTime: 2000,
            modificationTime: 2000,
            width: 1024,
            height: 768,
          },
        ],
        endCursor: 'cur-1',
        hasNextPage: false,
        totalCount: 1,
      });

      const syncRes = await syncLibrary({
        forceFullSync: true,
        db,
      });

      expect(syncRes.syncedCount).toBe(1);
      expect(syncRes.reconciledDeletedCount).toBe(1);

      // old-photo-deleted should be removed from DB
      const oldPhoto = await getPhotoById('old-photo-deleted', db);
      expect(oldPhoto).toBeNull();

      const newPhoto = await getPhotoById('asset-new-1', db);
      expect(newPhoto).not.toBeNull();
    });
  });

  describe('3. ExportReviewScreen shows skipped count notice in completion feedback', () => {
    it('displays missing/deleted photo count in feedback summary when skippedCount > 0', async () => {
      const mockTripData: TripRow = {
        id: 'trip-export-ui-test',
        name: 'Sylhet Adventure',
        start_at: 1000,
        end_at: 2000,
        photo_count: 10,
        cover_photo_id: null,
        is_away: 1,
        is_hidden: 0,
        is_user_edited: 0,
        scan_status: 'scanned',
        scanned_count: 10,
        created_at: 1000,
        updated_at: 2000,
      };

      const getTripSpy = jest
        .spyOn(tripsRepo, 'getTripById')
        .mockResolvedValue(mockTripData);
      const getPaywallSpy = jest
        .spyOn(purchasesService, 'getTripFreeTierStatus')
        .mockResolvedValue({
          tripId: 'trip-export-ui-test',
          scannedCount: 10,
          limit: 50,
          isPro: true,
          isGateEnabled: false,
          canScanMore: true,
          remainingFreeScans: 40,
          requiresPaywall: false,
        });
      const getSummarySpy = jest
        .spyOn(peopleRepo, 'getExportPeopleSummary')
        .mockResolvedValue([
          {
            id: 'person-ui-1',
            trip_id: 'trip-export-ui-test',
            name: 'Rahim',
            is_others: 0,
            cover_face_id: null,
            cover_photo_id: null,
            centroid: null,
            created_at: 1000,
            photo_count: 5,
            solo_photo_count: 2,
          },
        ]);
      const exportSpy = jest
        .spyOn(exporterService, 'exportPerson')
        .mockResolvedValue({
          exportId: 'exp-ui-1',
          mode: 'zip',
          photoCount: 3,
          skippedCount: 2,
          sizeBytes: 15000,
          status: 'done',
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

      const startButton = screen.getByTestId('start-export-button');

      await act(async () => {
        fireEvent.press(startButton);
      });

      // Feedback message should announce the export completed and 2 photos were skipped
      const notice = await screen.findByText(/Export complete!/i);
      expect(notice).toBeTruthy();
      expect(notice.props.children).toContain('2 missing or deleted photos were skipped');

      getTripSpy.mockRestore();
      getPaywallSpy.mockRestore();
      getSummarySpy.mockRestore();
      exportSpy.mockRestore();
    });
  });
});
