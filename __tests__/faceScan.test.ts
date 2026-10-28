import { AppState } from 'react-native';
import { openDbSync } from '../src/db/client';
import { runMigrationsSync } from '../src/db/migrations';
import { createTrip, getTripById } from '../src/db/repositories/trips';
import { upsertPhotos, getPhotosByTripId, getPhotoById } from '../src/db/repositories/photos';
import { getFacesByTripId } from '../src/db/repositories/faces';
import type { PhotoRow } from '../src/db/types';
import {
  scanTripFaces,
  ScanController,
  type FaceDetectorBackend,
  type FaceEmbedderBackend,
  type FaceDetectionBox,
} from '../src/services/faceScan';

// Mock dependencies
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn().mockResolvedValue(undefined),
  deactivateKeepAwake: jest.fn(),
}));

jest.mock('apple-vision', () => ({
  isAppleVisionAvailable: jest.fn().mockReturnValue(false),
  detectFacesWithAppleVision: jest.fn().mockResolvedValue([]),
}));

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

describe('Face Scan Service (Task 2.3)', () => {
  const db = openDbSync(':memory:');
  const TRIP_ID = 'trip-scan-test-1';

  beforeEach(() => {
    (db as unknown as { _clear: () => void })._clear();
    runMigrationsSync(db);
    jest.clearAllMocks();
  });

  function createTestPhotos(count: number, prefix: string = 'scan_p'): PhotoRow[] {
    const baseTime = 1700000000000;
    return Array.from({ length: count }, (_, i) => ({
      id: `${prefix}_${i + 1}`,
      trip_id: TRIP_ID,
      taken_at: baseTime + i * 60000,
      modified_at: baseTime + i * 60000,
      width: 1920,
      height: 1080,
      lat: null,
      lng: null,
      is_local: 1,
      scan_status: 'pending',
      face_count: 0,
      excluded: 0,
    }));
  }

  function createMockDetector(facesPerPhoto: number = 2): FaceDetectorBackend {
    return {
      detectFaces: jest.fn(async (): Promise<FaceDetectionBox[]> => {
        return Array.from({ length: facesPerPhoto }, (_, i) => ({
          x: 0.1 * (i + 1),
          y: 0.1 * (i + 1),
          width: 0.2,
          height: 0.2,
          score: 0.95 - i * 0.05,
        }));
      }),
    };
  }

  function createMockEmbedder(): FaceEmbedderBackend {
    return {
      computeEmbedding: jest.fn(async (): Promise<Float32Array> => {
        const emb = new Float32Array(128);
        for (let i = 0; i < 128; i++) emb[i] = 1.0 / Math.sqrt(128);
        return emb;
      }),
    };
  }

  it('scans photos with concurrency 2 and writes faces to database', async () => {
    await createTrip({ id: TRIP_ID, name: 'Test Trip', start_at: 1000, end_at: 2000 }, db);
    const photos = createTestPhotos(6);
    await upsertPhotos(photos, db);

    let activeInFlight = 0;
    let maxObservedConcurrency = 0;

    const mockDetector: FaceDetectorBackend = {
      detectFaces: jest.fn(async (): Promise<FaceDetectionBox[]> => {
        activeInFlight++;
        if (activeInFlight > maxObservedConcurrency) {
          maxObservedConcurrency = activeInFlight;
        }
        // Small delay to test overlap
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeInFlight--;
        return [
          { x: 0.2, y: 0.2, width: 0.3, height: 0.3, score: 0.98 },
          { x: 0.6, y: 0.3, width: 0.25, height: 0.25, score: 0.92 },
        ];
      }),
    };

    const mockEmbedder = createMockEmbedder();

    const progressUpdates: number[] = [];
    const result = await scanTripFaces(TRIP_ID, {
      db,
      concurrency: 2,
      detector: mockDetector,
      embedder: mockEmbedder,
      photoUriResolver: async (id) => `file:///mock/${id}.jpg`,
      onProgress: (p) => progressUpdates.push(p.current),
    });

    expect(result.status).toBe('completed');
    expect(result.scannedCount).toBe(6);
    expect(result.facesFound).toBe(12); // 2 faces * 6 photos
    expect(maxObservedConcurrency).toBeLessThanOrEqual(2);

    // Verify trip scan_status is 'scanned'
    const updatedTrip = await getTripById(TRIP_ID, db);
    expect(updatedTrip?.scan_status).toBe('scanned');
    expect(updatedTrip?.scanned_count).toBe(6);

    // Verify photos are updated
    const updatedPhotos = await getPhotosByTripId(TRIP_ID, {}, db);
    expect(updatedPhotos).toHaveLength(6);
    for (const p of updatedPhotos) {
      expect(p.scan_status).toBe('done');
      expect(p.face_count).toBe(2);
    }

    // Verify faces table has 12 entries
    const allFaces = await getFacesByTripId(TRIP_ID, {}, db);
    expect(allFaces).toHaveLength(12);
    expect(allFaces[0].embedding.length).toBe(512); // 128 float32 = 512 bytes
    expect(allFaces[0].assignment).toBe('auto');
  });

  it('resumes scanning by only scanning pending photos (skips already done photos)', async () => {
    await createTrip({ id: TRIP_ID, name: 'Test Trip', start_at: 1000, end_at: 2000 }, db);
    const photos = createTestPhotos(5);
    // Mark first 3 photos as already done
    photos[0].scan_status = 'done';
    photos[0].face_count = 1;
    photos[1].scan_status = 'done';
    photos[1].face_count = 2;
    photos[2].scan_status = 'done';
    photos[2].face_count = 1;
    await upsertPhotos(photos, db);

    const mockDetector = createMockDetector(1);
    const mockEmbedder = createMockEmbedder();

    const result = await scanTripFaces(TRIP_ID, {
      db,
      detector: mockDetector,
      embedder: mockEmbedder,
      photoUriResolver: async (id) => `file:///mock/${id}.jpg`,
    });

    expect(result.status).toBe('completed');
    // Only the 2 pending photos were scanned
    expect(result.scannedCount).toBe(2);
    expect(mockDetector.detectFaces).toHaveBeenCalledTimes(2);

    // All 5 photos are now done
    const allPhotos = await getPhotosByTripId(TRIP_ID, {}, db);
    for (const p of allPhotos) {
      expect(p.scan_status).toBe('done');
    }
  });

  it('cancels scan gracefully when controller.cancel() is invoked', async () => {
    await createTrip({ id: TRIP_ID, name: 'Cancel Trip', start_at: 1000, end_at: 2000 }, db);
    const photos = createTestPhotos(10);
    await upsertPhotos(photos, db);

    const controller = new ScanController();

    const mockDetector: FaceDetectorBackend = {
      detectFaces: jest.fn(async (): Promise<FaceDetectionBox[]> => {
        // Cancel on the second photo
        controller.cancel();
        return [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2, score: 0.9 }];
      }),
    };
    const mockEmbedder = createMockEmbedder();

    const result = await scanTripFaces(TRIP_ID, {
      db,
      concurrency: 1, // Single worker so we cancel right away
      controller,
      detector: mockDetector,
      embedder: mockEmbedder,
      photoUriResolver: async (id) => `file:///mock/${id}.jpg`,
    });

    expect(result.status).toBe('cancelled');
    expect(result.scannedCount).toBeLessThan(10);

    // Trip status should be 'paused' (resumable)
    const trip = await getTripById(TRIP_ID, db);
    expect(trip?.scan_status).toBe('paused');
  });

  it('pauses scan when AppState changes to background', async () => {
    await createTrip({ id: TRIP_ID, name: 'Background Pause Trip', start_at: 1000, end_at: 2000 }, db);
    const photos = createTestPhotos(8);
    await upsertPhotos(photos, db);

    let appStateListener: ((state: string) => void) | null = null;
    const addEventListenerSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((type, listener) => {
        if (type === 'change') {
          appStateListener = listener as (state: string) => void;
        }
        return { remove: jest.fn() };
      });

    const mockDetector: FaceDetectorBackend = {
      detectFaces: jest.fn(async (): Promise<FaceDetectionBox[]> => {
        // Simulate app moving to background while processing
        if (appStateListener) {
          appStateListener('background');
        }
        return [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2, score: 0.9 }];
      }),
    };
    const mockEmbedder = createMockEmbedder();

    const result = await scanTripFaces(TRIP_ID, {
      db,
      concurrency: 1,
      pauseOnBackground: true,
      detector: mockDetector,
      embedder: mockEmbedder,
      photoUriResolver: async (id) => `file:///mock/${id}.jpg`,
    });

    expect(result.status).toBe('paused');
    const trip = await getTripById(TRIP_ID, db);
    expect(trip?.scan_status).toBe('paused');

    addEventListenerSpy.mockRestore();
  });

  it('handles single photo errors resiliently without crashing the scan', async () => {
    await createTrip({ id: TRIP_ID, name: 'Resilient Trip', start_at: 1000, end_at: 2000 }, db);
    const photos = createTestPhotos(3);
    await upsertPhotos(photos, db);

    const mockDetector: FaceDetectorBackend = {
      detectFaces: jest.fn(async (uri: string): Promise<FaceDetectionBox[]> => {
        if (uri.includes('scan_p_2')) {
          throw new Error('Corrupt JPEG format');
        }
        return [{ x: 0.2, y: 0.2, width: 0.3, height: 0.3, score: 0.9 }];
      }),
    };
    const mockEmbedder = createMockEmbedder();

    const result = await scanTripFaces(TRIP_ID, {
      db,
      concurrency: 1,
      detector: mockDetector,
      embedder: mockEmbedder,
      photoUriResolver: async (id) => `file:///mock/${id}.jpg`,
    });

    expect(result.status).toBe('completed');
    expect(result.scannedCount).toBe(2);
    expect(result.failedCount).toBe(1);

    // Photo 2 should be marked 'failed'
    const failedPhoto = await getPhotoById('scan_p_2', db);
    expect(failedPhoto?.scan_status).toBe('failed');

    // Photo 1 and 3 should be marked 'done'
    const donePhoto = await getPhotoById('scan_p_1', db);
    expect(donePhoto?.scan_status).toBe('done');
  });

  it('skips iCloud-only photos gracefully and marks is_local = 0', async () => {
    await createTrip({ id: TRIP_ID, name: 'iCloud Trip', start_at: 1000, end_at: 2000 }, db);
    const photos = createTestPhotos(2);
    await upsertPhotos(photos, db);

    const result = await scanTripFaces(TRIP_ID, {
      db,
      detector: createMockDetector(1),
      embedder: createMockEmbedder(),
      photoUriResolver: async (id) => {
        if (id === 'scan_p_1') return null; // iCloud-only, not downloaded
        return `file:///mock/${id}.jpg`;
      },
    });

    expect(result.status).toBe('completed');
    expect(result.skippedCount).toBe(1);
    expect(result.scannedCount).toBe(1);

    const icloudPhoto = await getPhotoById('scan_p_1', db);
    expect(icloudPhoto?.is_local).toBe(0);
    expect(icloudPhoto?.scan_status).toBe('skipped');
  });

  it('handles trip not found error', async () => {
    await expect(
      scanTripFaces('non-existent-trip-id', { db })
    ).rejects.toThrow('Trip with ID "non-existent-trip-id" not found');
  });

  it('handles trip with 0 pending photos immediately as completed', async () => {
    await createTrip({ id: TRIP_ID, name: 'Empty Trip', start_at: 1000, end_at: 2000 }, db);
    const result = await scanTripFaces(TRIP_ID, { db });
    expect(result.status).toBe('completed');
    expect(result.scannedCount).toBe(0);
    expect(result.totalPhotos).toBe(0);
  });
});
