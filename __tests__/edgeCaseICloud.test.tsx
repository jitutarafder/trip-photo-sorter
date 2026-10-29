import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '../src/theme';
import ScanProgressModal from '../app/trip/[id]/scan';
import TripDetailScreen from '../app/trip/[id]/index';
import * as tripRepo from '../src/db/repositories/trips';
import * as photoRepo from '../src/db/repositories/photos';
import { getDatabase, closeDatabase } from '../src/db/client';
import {
  scanTripFaces,
  type FaceDetectorBackend,
  type FaceEmbedderBackend,
  type FaceDetectionBox,
} from '../src/services/faceScan';
import type { TripRow, PhotoRow } from '../src/db/types';

(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// Mock expo-router
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 'trip-icloud-test-1' }),
  Stack: Object.assign(() => null, { Screen: () => null }),
}));

// Mock safe-area
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock keep-awake
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn().mockResolvedValue(undefined),
  deactivateKeepAwake: jest.fn(),
}));

// Mock expo-image-manipulator
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({
    uri: 'file:///mock/crop.jpg',
    base64: 'mockBase64String',
  }),
  SaveFormat: {
    JPEG: 'jpeg',
    PNG: 'png',
  },
}));

// Mock purchases hook
jest.mock('../src/services/purchases', () => {
  const actual = jest.requireActual('../src/services/purchases');
  return {
    ...actual,
    useTripFreeTier: () => ({
      scannedCount: 0,
      limit: 50,
      remaining: 50,
      isPro: false,
      isGateEnabled: false,
      requiresPaywall: false,
    }),
    getTripFreeTierStatus: jest.fn().mockResolvedValue({
      scannedCount: 0,
      limit: 50,
      remaining: 50,
      isPro: false,
      isGateEnabled: false,
      requiresPaywall: false,
    }),
  };
});

describe('Task 4.2: iCloud-Only Photos Edge-Case Tests', () => {
  let db: any;

  beforeAll(async () => {
    db = await getDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const renderWithTheme = async (ui: React.ReactElement) => {
    return await render(<ThemeProvider colorScheme="dark">{ui}</ThemeProvider>);
  };

  const createMockDetector = (): FaceDetectorBackend => ({
    detectFaces: jest.fn(async (): Promise<FaceDetectionBox[]> => [
      {
        x: 0.2,
        y: 0.2,
        width: 0.3,
        height: 0.3,
        score: 0.95,
      },
    ]),
  });

  const createMockEmbedder = (): FaceEmbedderBackend => ({
    computeEmbedding: jest.fn(async (): Promise<Float32Array> => {
      const emb = new Float32Array(128);
      for (let i = 0; i < 128; i++) emb[i] = 1.0 / Math.sqrt(128);
      return emb;
    }),
  });

  describe('1. Face Scan Service iCloud Handling', () => {
    it('skips iCloud-only photos, updates SQLite is_local=0 and scan_status=skipped, and counts them', async () => {
      const tripId = 'trip-icloud-service-1';
      await tripRepo.createTrip(
        {
          id: tripId,
          name: 'iCloud Test Trip',
          start_at: 1700000000000,
          end_at: 1700100000000,
          photo_count: 3,
          scan_status: 'not_scanned',
        },
        db
      );

      const photos: PhotoRow[] = [
        {
          id: 'photo-local-1',
          trip_id: tripId,
          taken_at: 1700000010000,
          modified_at: 1700000010000,
          width: 1000,
          height: 1000,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'pending',
          face_count: 0,
          excluded: 0,
        },
        {
          id: 'photo-icloud-2',
          trip_id: tripId,
          taken_at: 1700000020000,
          modified_at: 1700000020000,
          width: 1000,
          height: 1000,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'pending',
          face_count: 0,
          excluded: 0,
        },
        {
          id: 'photo-local-3',
          trip_id: tripId,
          taken_at: 1700000030000,
          modified_at: 1700000030000,
          width: 1000,
          height: 1000,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'pending',
          face_count: 0,
          excluded: 0,
        },
      ];
      await photoRepo.upsertPhotos(photos, db);

      const progressSnapshots: any[] = [];
      const result = await scanTripFaces(tripId, {
        db,
        concurrency: 1,
        detector: createMockDetector(),
        embedder: createMockEmbedder(),
        autoCluster: false,
        photoUriResolver: async (photoId: string) => {
          if (photoId === 'photo-icloud-2') {
            return null; // Not on device (iCloud only)
          }
          return `file:///photos/${photoId}.jpg`;
        },
        onProgress: (p) => {
          progressSnapshots.push({ ...p });
        },
      });

      expect(result.status).toBe('completed');
      expect(result.scannedCount).toBe(2);
      expect(result.skippedCount).toBe(1);
      expect(result.facesFound).toBe(2);

      // Verify photo rows in SQLite
      const skippedPhoto = await photoRepo.getPhotoById('photo-icloud-2', db);
      expect(skippedPhoto?.is_local).toBe(0);
      expect(skippedPhoto?.scan_status).toBe('skipped');

      const localPhoto = await photoRepo.getPhotoById('photo-local-1', db);
      expect(localPhoto?.is_local).toBe(1);
      expect(localPhoto?.scan_status).toBe('done');

      // Verify onProgress received skippedCount
      const lastProgress = progressSnapshots[progressSnapshots.length - 1];
      expect(lastProgress.skippedCount).toBe(1);
    });

    it('handles trips where ALL photos are iCloud-only gracefully', async () => {
      const tripId = 'trip-all-icloud-1';
      await tripRepo.createTrip(
        {
          id: tripId,
          name: 'All iCloud Trip',
          start_at: 1700000000000,
          end_at: 1700100000000,
          photo_count: 2,
          scan_status: 'not_scanned',
        },
        db
      );

      await photoRepo.upsertPhotos(
        [
          {
            id: 'photo-all-icloud-1',
            trip_id: tripId,
            taken_at: 1700000010000,
            modified_at: 1700000010000,
            width: 1000,
            height: 1000,
            lat: null,
            lng: null,
            is_local: 1,
            scan_status: 'pending',
            face_count: 0,
            excluded: 0,
          },
          {
            id: 'photo-all-icloud-2',
            trip_id: tripId,
            taken_at: 1700000020000,
            modified_at: 1700000020000,
            width: 1000,
            height: 1000,
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

      const result = await scanTripFaces(tripId, {
        db,
        photoUriResolver: async () => null, // all iCloud
        autoCluster: false,
      });

      expect(result.status).toBe('completed');
      expect(result.scannedCount).toBe(0);
      expect(result.skippedCount).toBe(2);
      expect(result.facesFound).toBe(0);

      const allPhotos = await photoRepo.getPhotosByTripId(tripId, db);
      expect(allPhotos.every((p) => p.is_local === 0 && p.scan_status === 'skipped')).toBe(true);
    });
  });

  describe('2. Scan Progress Modal Visible iCloud Notice', () => {
    it('displays "n photos in iCloud skipped" notice in scan modal', async () => {
      jest.spyOn(require('../src/services/faceScan'), 'useFaceScan').mockReturnValue({
        isScanning: true,
        isPaused: false,
        progress: { current: 3, total: 5, facesFound: 4, skippedCount: 2 },
        error: null,
        startScan: jest.fn(),
        resumeScan: jest.fn(),
        cancelScan: jest.fn(),
        pauseScan: jest.fn(),
      });

      jest.spyOn(tripRepo, 'getTripById').mockResolvedValue({
        id: 'trip-icloud-test-1',
        name: 'Test Trip',
        start_at: 1700000000000,
        end_at: 1700100000000,
        photo_count: 5,
        cover_photo_id: null,
        is_away: 0,
        is_hidden: 0,
        is_user_edited: 0,
        scan_status: 'scanning',
        scanned_count: 3,
        created_at: 1700000000000,
        updated_at: 1700000000000,
      });

      const { getByTestId, getByText } = await renderWithTheme(<ScanProgressModal />);

      await waitFor(() => {
        expect(getByTestId('scan-icloud-skipped-notice')).toBeTruthy();
      });

      expect(getByText(/2 photos in iCloud skipped/i)).toBeTruthy();
    });

    it('displays singular "1 photo in iCloud skipped" notice when count is 1', async () => {
      jest.spyOn(require('../src/services/faceScan'), 'useFaceScan').mockReturnValue({
        isScanning: true,
        isPaused: false,
        progress: { current: 4, total: 5, facesFound: 3, skippedCount: 1 },
        error: null,
        startScan: jest.fn(),
        resumeScan: jest.fn(),
        cancelScan: jest.fn(),
        pauseScan: jest.fn(),
      });

      jest.spyOn(tripRepo, 'getTripById').mockResolvedValue({
        id: 'trip-icloud-test-1',
        name: 'Test Trip',
        start_at: 1700000000000,
        end_at: 1700100000000,
        photo_count: 5,
        cover_photo_id: null,
        is_away: 0,
        is_hidden: 0,
        is_user_edited: 0,
        scan_status: 'scanning',
        scanned_count: 4,
        created_at: 1700000000000,
        updated_at: 1700000000000,
      });

      const { getByTestId, getByText } = await renderWithTheme(<ScanProgressModal />);

      await waitFor(() => {
        expect(getByTestId('scan-icloud-skipped-notice')).toBeTruthy();
      });

      expect(getByText(/1 photo in iCloud skipped/i)).toBeTruthy();
    });
  });

  describe('3. Trip Detail iCloud Skipped Notice Banner', () => {
    it('renders trip-icloud-skipped-banner when photos were skipped due to iCloud', async () => {
      const trip: TripRow = {
        id: 'trip-icloud-detail-1',
        name: 'Summer Vacation',
        start_at: 1700000000000,
        end_at: 1700100000000,
        photo_count: 3,
        cover_photo_id: null,
        is_away: 0,
        is_hidden: 0,
        is_user_edited: 0,
        scan_status: 'scanned',
        scanned_count: 2,
        created_at: 1700000000000,
        updated_at: 1700000000000,
      };

      const photos: PhotoRow[] = [
        {
          id: 'p1',
          trip_id: trip.id,
          taken_at: 1700000010000,
          modified_at: 1700000010000,
          width: 100,
          height: 100,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
        {
          id: 'p2',
          trip_id: trip.id,
          taken_at: 1700000020000,
          modified_at: 1700000020000,
          width: 100,
          height: 100,
          lat: null,
          lng: null,
          is_local: 0,
          scan_status: 'skipped',
          face_count: 0,
          excluded: 0,
        },
      ];

      jest.spyOn(tripRepo, 'getTripById').mockResolvedValue(trip);
      jest.spyOn(photoRepo, 'getPhotosByTripId').mockResolvedValue(photos);

      const { getByTestId, getByText } = await renderWithTheme(<TripDetailScreen />);

      await waitFor(() => {
        expect(getByTestId('trip-icloud-skipped-banner')).toBeTruthy();
      });

      expect(getByText(/1 photo in iCloud was skipped/i)).toBeTruthy();
    });

    it('does not render trip-icloud-skipped-banner when all photos are local', async () => {
      const trip: TripRow = {
        id: 'trip-icloud-detail-2',
        name: 'Local Trip',
        start_at: 1700000000000,
        end_at: 1700100000000,
        photo_count: 2,
        cover_photo_id: null,
        is_away: 0,
        is_hidden: 0,
        is_user_edited: 0,
        scan_status: 'scanned',
        scanned_count: 2,
        created_at: 1700000000000,
        updated_at: 1700000000000,
      };

      const photos: PhotoRow[] = [
        {
          id: 'p1',
          trip_id: trip.id,
          taken_at: 1700000010000,
          modified_at: 1700000010000,
          width: 100,
          height: 100,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
        {
          id: 'p2',
          trip_id: trip.id,
          taken_at: 1700000020000,
          modified_at: 1700000020000,
          width: 100,
          height: 100,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
      ];

      jest.spyOn(tripRepo, 'getTripById').mockResolvedValue(trip);
      jest.spyOn(photoRepo, 'getPhotosByTripId').mockResolvedValue(photos);

      const { queryByTestId } = await renderWithTheme(<TripDetailScreen />);

      await waitFor(() => {
        expect(queryByTestId('trip-primary-button')).toBeTruthy();
      });

      expect(queryByTestId('trip-icloud-skipped-banner')).toBeNull();
    });
  });
});
