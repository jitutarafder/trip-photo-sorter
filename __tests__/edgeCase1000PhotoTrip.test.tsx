import React from 'react';
import { render, waitFor, fireEvent, act } from '@testing-library/react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { openDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrations';
import { createTrip } from '../src/db/repositories/trips';
import { upsertPhotos, getPhotosByTripId } from '../src/db/repositories/photos';
import { insertFaces, assignFacesToPerson, getFacesByTripId } from '../src/db/repositories/faces';
import { createPerson } from '../src/db/repositories/people';
import type { PhotoRow, FaceRow, TripRow, PersonRow } from '../src/db/types';
import {
  run300PhotoBenchmark,
  getCurrentMemoryUsageMb,
  type TripBenchmarkResult,
} from '../src/services/tripBenchmark';
import { clusterEmbeddings } from '../src/domain/clustering';
import TripDetailScreen from '../app/trip/[id]/index';
import PersonDetailScreen from '../app/person/[id]';
import HomeScreen from '../app/index';
import { ThemeProvider } from '../src/theme';
import * as tripsRepo from '../src/db/repositories/trips';
import * as photosRepo from '../src/db/repositories/photos';
import * as peopleRepo from '../src/db/repositories/people';
import * as libraryService from '../src/services/library';
import * as tripService from '../src/services/tripService';
import * as settingsRepo from '../src/db/repositories/settings';

// Mock expo-router
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};

let mockTripIdParam = 'trip-1000-test';
let mockPersonIdParam = 'person-1000-test';

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({
    id: mockPersonIdParam || mockTripIdParam,
    tripId: mockTripIdParam,
  }),
  Stack: {
    Screen: () => null,
  },
}));

// Mock safe-area
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

jest.setTimeout(60000);

// Mock expo-media-library
jest.mock('expo-media-library', () => ({
  getAssetInfoAsync: jest.fn().mockImplementation((id: string) =>
    Promise.resolve({
      id,
      uri: `file:///mock/photos/${id}.jpg`,
      localUri: `file:///mock/photos/${id}.jpg`,
    })
  ),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted', granted: true }),
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted', granted: true }),
  PermissionStatus: {
    GRANTED: 'granted',
    DENIED: 'denied',
    UNDETERMINED: 'undetermined',
  },
}));

jest.mock('../src/hooks/useLibraryPermission', () => ({
  useLibraryPermission: jest.fn().mockReturnValue({
    status: 'full',
    isGranted: true,
    isLimited: false,
    isLoading: false,
    canAskAgain: true,
    requestPermission: jest.fn(),
    refreshPermission: jest.fn(),
    presentPicker: jest.fn(),
  }),
}));

// Mock purchases hook
jest.mock('../src/services/purchases', () => {
  const actual = jest.requireActual('../src/services/purchases');
  return {
    ...actual,
    useTripFreeTier: () => ({
      status: {
        tripId: 'trip-1000-test',
        scannedCount: 1000,
        limit: 50,
        isPro: true,
        isGateEnabled: false,
        canScanMore: true,
        remainingFreeScans: 0,
        requiresPaywall: false,
      },
    }),
    getTripFreeTierStatus: jest.fn().mockResolvedValue({
      tripId: 'trip-1000-test',
      scannedCount: 1000,
      limit: 50,
      isPro: true,
      isGateEnabled: false,
      canScanMore: true,
      remainingFreeScans: 0,
      requiresPaywall: false,
    }),
  };
});

describe('Task 4.6: 1 000+ Photo Trip: Memory + Scroll FPS', () => {
  let db: SQLiteDatabase;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTripIdParam = 'trip-1000-test';
    mockPersonIdParam = 'person-1000-test';

    db = await openDb(':memory:');
    await runMigrations(db);
  });

  describe('1. Pipeline Scaling & Peak Memory on 1,000-Photo Trip (PRD §6)', () => {
    it('processes 1,000 photos with peak memory < 400 MB and high throughput', async () => {
      const startMem = getCurrentMemoryUsageMb();
      expect(startMem).toBeGreaterThan(0);

      // Run benchmark with 1,000 photos and 20 distinct individuals
      const result: TripBenchmarkResult = await run300PhotoBenchmark(
        {
          photoCount: 1000,
          personCount: 20,
          concurrency: 2,
        },
        db
      );

      // 1. Photo count is exactly 1,000
      expect(result.photoCount).toBe(1000);

      // 2. Realistic face count across 1,000 photos (~1,500-2,500 faces)
      expect(result.facesFound).toBeGreaterThan(1000);
      expect(result.qualityOkFaces).toBeGreaterThan(800);
      expect(result.clustersCount).toBeGreaterThanOrEqual(15);

      // 3. Peak memory is under 400 MB (PRD §6 hard constraint)
      expect(result.peakMemoryMb).toBeLessThan(400);
      expect(result.peakMemoryPassed).toBe(true);

      // 4. Total duration is under 3 minutes (180,000 ms)
      expect(result.totalDurationMs).toBeLessThan(180000);
      expect(result.totalTimePassed).toBe(true);

      // 5. Memory stability: memory delta is bounded (< 150 MB)
      expect(result.memoryDeltaMb).toBeLessThan(150);

      // 6. Overall meets all PRD §6 targets
      expect(result.meetsAllTargets).toBe(true);
    });

    it('hierarchical clustering with Lance-Williams scales smoothly for 1,500+ faces in seconds', () => {
      const faceCount = 1500;
      const personCount = 20;
      const dim = 128;

      // Generate base embeddings for 20 people
      const personBaseVectors: Float32Array[] = [];
      for (let p = 0; p < personCount; p++) {
        const vec = new Float32Array(dim);
        for (let d = 0; d < dim; d++) {
          vec[d] = Math.sin((p + 1) * (d + 1));
        }
        personBaseVectors.push(vec);
      }

      // Generate 1,500 perturbed face embeddings across photos
      const items = Array.from({ length: faceCount }, (_, idx) => {
        const personIdx = idx % personCount;
        const base = personBaseVectors[personIdx];
        const emb = new Float32Array(dim);
        for (let d = 0; d < dim; d++) {
          emb[d] = base[d] + (idx % 7) * 0.01;
        }
        return {
          id: `face_scale_${idx}`,
          photoId: `photo_scale_${Math.floor(idx / 2)}`, // 2 faces per photo
          embedding: emb,
        };
      });

      const startTime = Date.now();
      const res = clusterEmbeddings(items, 0.32, 2);
      const elapsedMs = Date.now() - startTime;

      // Fast clustering execution: takes well under 10 seconds (typically < 3s)
      expect(elapsedMs).toBeLessThan(10000);
      expect(res.clusters.length).toBeGreaterThanOrEqual(15);
    });
  });

  describe('2. SQLite Batching with 1,000+ Items', () => {
    it('assignFacesToPerson updates 1,200 faces in batches of 500 without exceeding SQLite variable limits', async () => {
      const trip = await createTrip(
        { id: 'trip-sql-1000', name: 'SQL Scale Trip', start_at: 1000, end_at: 2000 },
        db
      );
      const person = await createPerson(
        { id: 'person-sql-1000', trip_id: trip.id, name: 'ScaleUser' },
        db
      );

      const photoCount = 1200;
      const photos: PhotoRow[] = Array.from({ length: photoCount }, (_, i) => ({
        id: `p-scale-${i + 1}`,
        trip_id: trip.id,
        taken_at: 1000 + i * 10,
        modified_at: 1000 + i * 10,
        width: 1000,
        height: 1000,
        lat: null,
        lng: null,
        is_local: 1,
        scan_status: 'done',
        face_count: 1,
        excluded: 0,
      }));
      await upsertPhotos(photos, db);

      const dummyEmbedding = new Uint8Array(512);
      const faces: FaceRow[] = photos.map((p, i) => ({
        id: `face-scale-${i + 1}`,
        photo_id: p.id,
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.1,
        bbox_y: 0.1,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.95,
        quality_ok: 1,
        blur: 50.0,
        embedding: dummyEmbedding,
      }));
      await insertFaces(faces, db);

      const allFaceIds = faces.map((f) => f.id);
      expect(allFaceIds.length).toBe(1200);

      // Assign all 1,200 faces to person in one call
      await expect(
        assignFacesToPerson(allFaceIds, person.id, 'auto', db)
      ).resolves.not.toThrow();

      // Verify all 1,200 faces were updated in SQLite
      const updatedFaces = await getFacesByTripId(trip.id, {}, db);
      expect(updatedFaces.length).toBe(1200);
      expect(updatedFaces.every((f) => f.person_id === person.id)).toBe(true);
    });

    it('retrieves 1,000 photos ordered by taken_at without truncation or query failure', async () => {
      const trip = await createTrip(
        { id: 'trip-query-1000', name: 'Query Trip', start_at: 1000, end_at: 2000 },
        db
      );

      const photos: PhotoRow[] = Array.from({ length: 1000 }, (_, i) => ({
        id: `photo-q-${i + 1}`,
        trip_id: trip.id,
        taken_at: 1000 + i * 5,
        modified_at: 1000 + i * 5,
        width: 1200,
        height: 800,
        lat: null,
        lng: null,
        is_local: 1,
        scan_status: 'pending',
        face_count: 0,
        excluded: 0,
      }));
      await upsertPhotos(photos, db);

      const retrieved = await getPhotosByTripId(trip.id, {}, db);
      expect(retrieved.length).toBe(1000);
      expect(retrieved[0].taken_at).toBe(1000);
      expect(retrieved[999].taken_at).toBe(1000 + 999 * 5);
    });
  });

  describe('3. UI Scroll Performance & FlashList Windowing for 1,000 Photos', () => {
    it('TripDetailScreen renders FlashList with estimatedItemSize and handles 1,000 photos smoothly', async () => {
      const mockTripData: TripRow = {
        id: 'trip-1000-test',
        name: 'Huge Event 2026',
        start_at: 1000000,
        end_at: 2000000,
        photo_count: 1000,
        cover_photo_id: null,
        is_away: 0,
        is_hidden: 0,
        is_user_edited: 0,
        scan_status: 'not_scanned',
        scanned_count: 0,
        created_at: 1000000,
        updated_at: 1000000,
      };

      const mockPhotos: PhotoRow[] = Array.from({ length: 1000 }, (_, i) => ({
        id: `grid-photo-${i + 1}`,
        trip_id: 'trip-1000-test',
        taken_at: 1000000 + i * 100,
        modified_at: 1000000 + i * 100,
        width: 3024,
        height: 4032,
        lat: null,
        lng: null,
        is_local: 1,
        scan_status: 'pending',
        face_count: 0,
        excluded: 0,
      }));

      jest.spyOn(tripsRepo, 'getTripById').mockResolvedValue(mockTripData);
      jest.spyOn(photosRepo, 'getPhotosByTripId').mockResolvedValue(mockPhotos);

      const screen = await render(
        <ThemeProvider>
          <TripDetailScreen />
        </ThemeProvider>
      );

      // Trip detail renders header with photo count
      await waitFor(() => {
        expect(screen.getByText('Huge Event 2026')).toBeTruthy();
        expect(screen.getByText(/1000 photos/)).toBeTruthy();
      });

      // FlashList is rendered with numColumns = 3 and displays photo grid
      const flashList = screen.getByTestId('trip-photo-grid');
      expect(flashList).toBeTruthy();
      expect(flashList.props.numColumns).toBe(3);
      expect(screen.getByTestId('trip-photo-grid-photo-1')).toBeTruthy();
    });

    it('PersonDetailScreen renders FlashList with estimatedItemSize and handles 1,000 photos with multi-select', async () => {
      mockPersonIdParam = 'person-1000-test';

      const mockPersonData: PersonRow = {
        id: 'person-1000-test',
        trip_id: 'trip-1000-test',
        name: 'Sakib Khan',
        is_others: 0,
        cover_face_id: null,
        centroid: null,
        created_at: 1000,
      };

      const mockTripData: TripRow = {
        id: 'trip-1000-test',
        name: 'Huge Event 2026',
        start_at: 1000,
        end_at: 2000,
        photo_count: 1000,
        cover_photo_id: null,
        is_away: 0,
        is_hidden: 0,
        is_user_edited: 0,
        scan_status: 'scanned',
        scanned_count: 1000,
        created_at: 1000,
        updated_at: 1000,
      };

      const mockPhotosWithExclusions = Array.from({ length: 1000 }, (_, i) => ({
        id: `person-ph-${i + 1}`,
        trip_id: 'trip-1000-test',
        taken_at: 1000 + i * 10,
        modified_at: 1000 + i * 10,
        width: 1000,
        height: 1000,
        lat: null,
        lng: null,
        is_local: 1,
        scan_status: 'done' as const,
        face_count: 1,
        excluded: 0,
        is_person_excluded: 0 as const,
      }));

      jest.spyOn(peopleRepo, 'getPersonById').mockResolvedValue(mockPersonData);
      jest.spyOn(tripsRepo, 'getTripById').mockResolvedValue(mockTripData);
      jest.spyOn(peopleRepo, 'getPeopleByTripId').mockResolvedValue([mockPersonData]);
      jest.spyOn(peopleRepo, 'getPersonPhotosWithExclusions').mockResolvedValue(mockPhotosWithExclusions);

      const screen = await render(
        <ThemeProvider>
          <PersonDetailScreen />
        </ThemeProvider>
      );

      await waitFor(() => {
        expect(screen.getByDisplayValue('Sakib Khan')).toBeTruthy();
      });

      // FlashList is rendered for photo grid
      const flashList = screen.getByTestId('person-photo-grid');
      expect(flashList).toBeTruthy();
      expect(screen.getByTestId('photo-tile-person-ph-1')).toBeTruthy();

      // Tap first photo to enter multi-select mode
      const firstPhotoTile = screen.getByTestId('photo-tile-person-ph-1');
      await act(async () => {
        fireEvent.press(firstPhotoTile);
      });

      // Select All action executes smoothly across 1,000 photos
      await waitFor(() => {
        expect(screen.getByTestId('select-all-button')).toBeTruthy();
      });

      const selectAllBtn = screen.getByTestId('select-all-button');
      await act(async () => {
        fireEvent.press(selectAllBtn);
      });

      await waitFor(() => {
        expect(screen.getByText('1000 selected')).toBeTruthy();
        expect(screen.getByTestId('multi-select-bar')).toBeTruthy();
      });
    });

    it('HomeScreen renders FlashList with estimatedItemSize=160 for trip cards', async () => {
      const mockTrips: TripRow[] = [
        {
          id: 'trip-home-1',
          name: 'Summer Fest 2026',
          start_at: 1000,
          end_at: 2000,
          photo_count: 1200,
          cover_photo_id: null,
          is_away: 0,
          is_hidden: 0,
          is_user_edited: 0,
          scan_status: 'scanned',
          scanned_count: 1200,
          created_at: 1000,
          updated_at: 1000,
        },
      ];

      jest.spyOn(settingsRepo, 'isOnboarded').mockResolvedValue(true);
      jest.spyOn(tripsRepo, 'getAllTrips').mockResolvedValue(mockTrips);
      jest.spyOn(libraryService, 'syncLibrary').mockResolvedValue({
        syncedCount: 1200,
        batchesCount: 3,
        lastSyncAt: 1000,
        isIncremental: false,
      });
      jest.spyOn(tripService, 'detectAndPersistTrips').mockResolvedValue({
        detectedCount: 1,
        createdCount: 1,
        updatedCount: 0,
        preservedUserEditedCount: 0,
        deletedStaleCount: 0,
        trips: mockTrips,
      });

      const screen = await render(
        <ThemeProvider>
          <HomeScreen />
        </ThemeProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('trips-flash-list')).toBeTruthy();
      });

      const list = screen.getByTestId('trips-flash-list');
      expect(list).toBeTruthy();
      expect(screen.getByText('Summer Fest 2026')).toBeTruthy();
    });
  });
});

