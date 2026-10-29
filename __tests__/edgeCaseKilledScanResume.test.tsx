import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import { openDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrations';
import {
  createTrip,
  getTripById,
  updateTrip,
  reconcileInterruptedTripScans,
} from '../src/db/repositories/trips';
import {
  upsertPhotos,
  getPhotoById,
  getPhotosByTripId,
  markPhotoScanFailedAtomic,
} from '../src/db/repositories/photos';
import {
  getFacesByTripId,
  getFacesByPhotoId,
  insertFace,
  deleteOrphanFacesForPendingTripPhotos,
  savePhotoFacesAtomic,
} from '../src/db/repositories/faces';
import { getPeopleByTripId } from '../src/db/repositories/people';
import {
  scanTripFaces,
  type FaceDetectorBackend,
  type FaceEmbedderBackend,
  type FaceDetectionBox,
} from '../src/services/faceScan';
import type { PhotoRow, FaceRow, TripRow } from '../src/db/types';
import TripDetailScreen from '../app/trip/[id]/index';
import { ThemeProvider } from '../src/theme';
import * as tripsRepo from '../src/db/repositories/trips';
import * as photosRepo from '../src/db/repositories/photos';

(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// Mock expo-router
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ id: 'trip-killed-ui-test' }),
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

describe('Task 4.4: App killed mid-scan → resume, no duplicate faces', () => {
  let db: SQLiteDatabase;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = await openDb(':memory:');
    await runMigrations(db);
  });

  const createMockDetector = (facesPerPhoto: number = 2): FaceDetectorBackend => ({
    detectFaces: jest.fn(async (_photoUri: string): Promise<FaceDetectionBox[]> => {
      const boxes: FaceDetectionBox[] = [];
      for (let i = 0; i < facesPerPhoto; i++) {
        boxes.push({
          x: 0.1 + i * 0.3,
          y: 0.1 + i * 0.3,
          width: 0.25,
          height: 0.25,
          score: 0.95,
        });
      }
      return boxes;
    }),
  });

  const createMockEmbedder = (): FaceEmbedderBackend => ({
    computeEmbedding: jest.fn(async (): Promise<Float32Array> => {
      const emb = new Float32Array(128);
      for (let i = 0; i < 128; i++) emb[i] = 1.0 / Math.sqrt(128);
      return emb;
    }),
  });

  describe('1. Reconcile Interrupted Trip Scans', () => {
    it('transitions trips from scanning and clustering to paused, leaving others unchanged', async () => {
      await createTrip({ id: 't1', name: 'Scanning Trip', start_at: 1000, end_at: 2000, scan_status: 'scanning' }, db);
      await createTrip({ id: 't2', name: 'Clustering Trip', start_at: 2000, end_at: 3000, scan_status: 'clustering' }, db);
      await createTrip({ id: 't3', name: 'Scanned Trip', start_at: 3000, end_at: 4000, scan_status: 'scanned' }, db);
      await createTrip({ id: 't4', name: 'Not Scanned Trip', start_at: 4000, end_at: 5000, scan_status: 'not_scanned' }, db);
      await createTrip({ id: 't5', name: 'Paused Trip', start_at: 5000, end_at: 6000, scan_status: 'paused' }, db);
      await createTrip({ id: 't6', name: 'Failed Trip', start_at: 6000, end_at: 7000, scan_status: 'failed' }, db);

      const changes = await reconcileInterruptedTripScans(db);
      expect(changes).toBe(2);

      const t1 = await getTripById('t1', db);
      const t2 = await getTripById('t2', db);
      const t3 = await getTripById('t3', db);
      const t4 = await getTripById('t4', db);
      const t5 = await getTripById('t5', db);
      const t6 = await getTripById('t6', db);

      expect(t1?.scan_status).toBe('paused');
      expect(t2?.scan_status).toBe('paused');
      expect(t3?.scan_status).toBe('scanned');
      expect(t4?.scan_status).toBe('not_scanned');
      expect(t5?.scan_status).toBe('paused');
      expect(t6?.scan_status).toBe('failed');
    });
  });

  describe('2. Delete Orphan Faces for Pending Photos', () => {
    it('deletes faces belonging to pending photos of the trip, leaving done photos and other trips intact', async () => {
      const trip1 = await createTrip({ id: 'trip-clean-1', name: 'Trip 1', start_at: 1000, end_at: 2000 }, db);
      const trip2 = await createTrip({ id: 'trip-clean-2', name: 'Trip 2', start_at: 3000, end_at: 4000 }, db);

      // Photos for Trip 1: p1 is done, p2 is pending (with partial faces from killed scan)
      const p1: PhotoRow = {
        id: 'p1',
        trip_id: trip1.id,
        taken_at: 1100,
        modified_at: 1100,
        width: 1000,
        height: 1000,
        lat: null,
        lng: null,
        is_local: 1,
        scan_status: 'done',
        face_count: 2,
        excluded: 0,
      };
      const p2: PhotoRow = {
        id: 'p2',
        trip_id: trip1.id,
        taken_at: 1200,
        modified_at: 1200,
        width: 1000,
        height: 1000,
        lat: null,
        lng: null,
        is_local: 1,
        scan_status: 'pending',
        face_count: 0,
        excluded: 0,
      };
      // Photo for Trip 2: p3 is pending
      const p3: PhotoRow = {
        id: 'p3',
        trip_id: trip2.id,
        taken_at: 3100,
        modified_at: 3100,
        width: 1000,
        height: 1000,
        lat: null,
        lng: null,
        is_local: 1,
        scan_status: 'pending',
        face_count: 0,
        excluded: 0,
      };
      await upsertPhotos([p1, p2, p3], db);

      const dummyEmbedding = new Uint8Array(512);
      await insertFace({
        id: 'face-p1-1',
        photo_id: 'p1',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0,
        bbox_y: 0,
        bbox_w: 10,
        bbox_h: 10,
        quality: 0.9,
        quality_ok: 1,
        blur: 0.1,
        embedding: dummyEmbedding,
      }, db);
      await insertFace({
        id: 'face-p1-2',
        photo_id: 'p1',
        person_id: null,
        assignment: 'auto',
        bbox_x: 10,
        bbox_y: 10,
        bbox_w: 10,
        bbox_h: 10,
        quality: 0.9,
        quality_ok: 1,
        blur: 0.1,
        embedding: dummyEmbedding,
      }, db);
      await insertFace({
        id: 'face-p2-orphan',
        photo_id: 'p2',
        person_id: null,
        assignment: 'auto',
        bbox_x: 20,
        bbox_y: 20,
        bbox_w: 10,
        bbox_h: 10,
        quality: 0.8,
        quality_ok: 1,
        blur: 0.2,
        embedding: dummyEmbedding,
      }, db);
      await insertFace({
        id: 'face-p3-other-trip',
        photo_id: 'p3',
        person_id: null,
        assignment: 'auto',
        bbox_x: 30,
        bbox_y: 30,
        bbox_w: 10,
        bbox_h: 10,
        quality: 0.85,
        quality_ok: 1,
        blur: 0.15,
        embedding: dummyEmbedding,
      }, db);

      const deleted = await deleteOrphanFacesForPendingTripPhotos(trip1.id, db);
      expect(deleted).toBe(1);

      // p1 faces are intact (done)
      const p1Faces = await getFacesByPhotoId('p1', db);
      expect(p1Faces).toHaveLength(2);

      // p2 faces are cleared (pending orphan deleted)
      const p2Faces = await getFacesByPhotoId('p2', db);
      expect(p2Faces).toHaveLength(0);

      // p3 faces in trip2 are intact
      const p3Faces = await getFacesByPhotoId('p3', db);
      expect(p3Faces).toHaveLength(1);
    });
  });

  describe('3. savePhotoFacesAtomic Prevents Duplicate Faces', () => {
    it('wipes any previous faces for the photo, inserts new faces, updates status and scanned_count atomically', async () => {
      const trip = await createTrip({ id: 'trip-atomic-1', name: 'Atomic Trip', start_at: 1000, end_at: 2000, scanned_count: 0 }, db);
      const photo: PhotoRow = {
        id: 'photo-atomic-1',
        trip_id: trip.id,
        taken_at: 1100,
        modified_at: 1100,
        width: 1000,
        height: 1000,
        lat: null,
        lng: null,
        is_local: 1,
        scan_status: 'pending',
        face_count: 0,
        excluded: 0,
      };
      await upsertPhotos([photo], db);

      const dummyEmbedding = new Uint8Array(512);

      // Pre-existing old face for this photo
      await insertFace({
        id: 'old-face-1',
        photo_id: photo.id,
        person_id: null,
        assignment: 'auto',
        bbox_x: 0,
        bbox_y: 0,
        bbox_w: 10,
        bbox_h: 10,
        quality: 0.8,
        quality_ok: 1,
        blur: 0.1,
        embedding: dummyEmbedding,
      }, db);

      expect((await getFacesByPhotoId(photo.id, db)).length).toBe(1);

      // Save 2 new faces atomically
      const newFaces: FaceRow[] = [
        {
          id: 'new-face-1',
          photo_id: photo.id,
          person_id: null,
          assignment: 'auto',
          bbox_x: 20,
          bbox_y: 20,
          bbox_w: 15,
          bbox_h: 15,
          quality: 0.95,
          quality_ok: 1,
          blur: 0.05,
          embedding: dummyEmbedding,
        },
        {
          id: 'new-face-2',
          photo_id: photo.id,
          person_id: null,
          assignment: 'auto',
          bbox_x: 50,
          bbox_y: 50,
          bbox_w: 15,
          bbox_h: 15,
          quality: 0.92,
          quality_ok: 1,
          blur: 0.08,
          embedding: dummyEmbedding,
        },
      ];

      await savePhotoFacesAtomic(photo.id, trip.id, newFaces, db);

      // Verify old face was removed and only new faces exist (NO duplicate faces)
      const finalFaces = await getFacesByPhotoId(photo.id, db);
      expect(finalFaces).toHaveLength(2);
      expect(finalFaces.map((f) => f.id).sort()).toEqual(['new-face-1', 'new-face-2']);

      // Photo is marked 'done' with face_count = 2
      const updatedPhoto = await getPhotoById(photo.id, db);
      expect(updatedPhoto?.scan_status).toBe('done');
      expect(updatedPhoto?.face_count).toBe(2);

      // Trip scanned_count incremented to 1
      const updatedTrip = await getTripById(trip.id, db);
      expect(updatedTrip?.scanned_count).toBe(1);
    });

    it('markPhotoScanFailedAtomic clears faces and updates photo status', async () => {
      const trip = await createTrip({ id: 'trip-atomic-fail', name: 'Fail Trip', start_at: 1000, end_at: 2000 }, db);
      const photo: PhotoRow = {
        id: 'photo-fail-1',
        trip_id: trip.id,
        taken_at: 1100,
        modified_at: 1100,
        width: 1000,
        height: 1000,
        lat: null,
        lng: null,
        is_local: 1,
        scan_status: 'pending',
        face_count: 0,
        excluded: 0,
      };
      await upsertPhotos([photo], db);

      const dummyEmbedding = new Uint8Array(512);
      await insertFace({
        id: 'partial-face-1',
        photo_id: photo.id,
        person_id: null,
        assignment: 'auto',
        bbox_x: 0,
        bbox_y: 0,
        bbox_w: 10,
        bbox_h: 10,
        quality: 0.8,
        quality_ok: 1,
        blur: 0.1,
        embedding: dummyEmbedding,
      }, db);

      await markPhotoScanFailedAtomic(photo.id, db);

      const faces = await getFacesByPhotoId(photo.id, db);
      expect(faces).toHaveLength(0);

      const updatedPhoto = await getPhotoById(photo.id, db);
      expect(updatedPhoto?.scan_status).toBe('failed');
      expect(updatedPhoto?.face_count).toBe(0);
    });
  });

  describe('4. Full Kill-and-Resume Workflow', () => {
    it('resumes cleanly when app is killed mid-scan without creating duplicate faces', async () => {
      const tripId = 'trip-kill-resume-1';
      await createTrip({
        id: tripId,
        name: 'Sreemangal Tour',
        start_at: 1000000000000,
        end_at: 1000100000000,
        photo_count: 5,
        scan_status: 'not_scanned',
        scanned_count: 0,
      }, db);

      // Create 5 test photos
      const photos: PhotoRow[] = Array.from({ length: 5 }, (_, i) => ({
        id: `photo-kr-${i + 1}`,
        trip_id: tripId,
        taken_at: 1000000000000 + i * 60000,
        modified_at: 1000000000000 + i * 60000,
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

      const mockDetector = createMockDetector(2); // 2 faces per photo
      const mockEmbedder = createMockEmbedder();

      // SIMULATION PHASE 1: Scan starts, processes photo-kr-1 and photo-kr-2,
      // and photo-kr-3 has partial faces inserted before simulated process kill.
      await savePhotoFacesAtomic(
        'photo-kr-1',
        tripId,
        [
          {
            id: 'face-1-a',
            photo_id: 'photo-kr-1',
            person_id: null,
            assignment: 'auto',
            bbox_x: 0.1,
            bbox_y: 0.1,
            bbox_w: 0.2,
            bbox_h: 0.2,
            quality: 0.9,
            quality_ok: 1,
            blur: 0.1,
            embedding: new Uint8Array(512),
          },
          {
            id: 'face-1-b',
            photo_id: 'photo-kr-1',
            person_id: null,
            assignment: 'auto',
            bbox_x: 0.5,
            bbox_y: 0.5,
            bbox_w: 0.2,
            bbox_h: 0.2,
            quality: 0.9,
            quality_ok: 1,
            blur: 0.1,
            embedding: new Uint8Array(512),
          },
        ],
        db
      );

      await savePhotoFacesAtomic(
        'photo-kr-2',
        tripId,
        [
          {
            id: 'face-2-a',
            photo_id: 'photo-kr-2',
            person_id: null,
            assignment: 'auto',
            bbox_x: 0.2,
            bbox_y: 0.2,
            bbox_w: 0.2,
            bbox_h: 0.2,
            quality: 0.9,
            quality_ok: 1,
            blur: 0.1,
            embedding: new Uint8Array(512),
          },
          {
            id: 'face-2-b',
            photo_id: 'photo-kr-2',
            person_id: null,
            assignment: 'auto',
            bbox_x: 0.6,
            bbox_y: 0.6,
            bbox_w: 0.2,
            bbox_h: 0.2,
            quality: 0.9,
            quality_ok: 1,
            blur: 0.1,
            embedding: new Uint8Array(512),
          },
        ],
        db
      );

      // Photo 3: Partial face inserted right before sudden process termination
      await insertFace({
        id: 'face-3-partial-orphan',
        photo_id: 'photo-kr-3',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.15,
        bbox_y: 0.15,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.7,
        quality_ok: 1,
        blur: 0.3,
        embedding: new Uint8Array(512),
      }, db);

      // At point of kill: trip was in 'scanning'
      await updateTrip(tripId, { scan_status: 'scanning' }, db);

      // Verify pre-reconciliation state
      const preTrip = await getTripById(tripId, db);
      expect(preTrip?.scan_status).toBe('scanning');
      expect(preTrip?.scanned_count).toBe(2);

      // 5 faces currently in faces table (4 from p1, p2 + 1 orphan from p3)
      const preFaces = await getFacesByTripId(tripId, {}, db);
      expect(preFaces).toHaveLength(5);

      // SIMULATION PHASE 2: App restarts (reconcileInterruptedTripScans runs on launch)
      const reconciled = await reconcileInterruptedTripScans(db);
      expect(reconciled).toBe(1);

      const postRelaunchTrip = await getTripById(tripId, db);
      expect(postRelaunchTrip?.scan_status).toBe('paused');

      // SIMULATION PHASE 3: User resumes scan
      const progressUpdates: number[] = [];
      const resumeResult = await scanTripFaces(tripId, {
        db,
        concurrency: 2,
        detector: mockDetector,
        embedder: mockEmbedder,
        autoCluster: true,
        photoUriResolver: async (id) => `file:///mock/${id}.jpg`,
        onProgress: (p) => progressUpdates.push(p.current),
      });

      expect(resumeResult.error).toBeUndefined();
      expect(resumeResult.status).toBe('completed');
      // Exactly 3 pending photos were scanned (photo-kr-3, photo-kr-4, photo-kr-5)
      expect(resumeResult.scannedCount).toBe(3);
      expect(mockDetector.detectFaces).toHaveBeenCalledTimes(3);

      // VERIFICATION: Check SQLite database integrity
      // 1. All 5 photos are 'done'
      const allPhotos = await getPhotosByTripId(tripId, {}, db);
      expect(allPhotos).toHaveLength(5);
      for (const p of allPhotos) {
        expect(p.scan_status).toBe('done');
        expect(p.face_count).toBe(2);
      }

      // 2. NO DUPLICATE FACES: Exactly 10 faces in faces table (2 faces * 5 photos)
      const allFaces = await getFacesByTripId(tripId, {}, db);
      expect(allFaces).toHaveLength(10);

      // Verify the orphan face was deleted and photo 3 has exactly 2 faces
      const photo3Faces = await getFacesByPhotoId('photo-kr-3', db);
      expect(photo3Faces).toHaveLength(2);
      expect(photo3Faces.find((f) => f.id === 'face-3-partial-orphan')).toBeUndefined();

      // Verify every face has a unique ID
      const faceIds = allFaces.map((f) => f.id);
      const uniqueFaceIds = new Set(faceIds);
      expect(uniqueFaceIds.size).toBe(10);

      // 3. Trip is scanned and free-tier scanned_count is 5
      const finalTrip = await getTripById(tripId, db);
      expect(finalTrip?.scan_status).toBe('scanned');
      expect(finalTrip?.scanned_count).toBe(5);

      // 4. Clustering executed and created people for the faces
      const people = await getPeopleByTripId(tripId, db);
      expect(people.length).toBeGreaterThan(0);
      for (const face of allFaces) {
        expect(face.person_id).not.toBeNull();
      }
    });

    it('resumes cleanly when app was killed during clustering step', async () => {
      const tripId = 'trip-kill-clustering-1';
      await createTrip({
        id: tripId,
        name: 'Clustering Kill Trip',
        start_at: 1000,
        end_at: 2000,
        photo_count: 3,
        scan_status: 'clustering', // App killed during clustering
        scanned_count: 3,
      }, db);

      // All 3 photos finished scanning
      const photos: PhotoRow[] = Array.from({ length: 3 }, (_, i) => ({
        id: `photo-kc-${i + 1}`,
        trip_id: tripId,
        taken_at: 1000 + i * 100,
        modified_at: 1000 + i * 100,
        width: 1000,
        height: 1000,
        lat: null,
        lng: null,
        is_local: 1,
        scan_status: 'done',
        face_count: 2,
        excluded: 0,
      }));
      await upsertPhotos(photos, db);

      // Insert 6 faces for these 3 photos
      const dummyEmbedding = new Uint8Array(512);
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 2; j++) {
          await insertFace({
            id: `face-kc-${i}-${j}`,
            photo_id: `photo-kc-${i + 1}`,
            person_id: null,
            assignment: 'auto',
            bbox_x: 0.1 + j * 0.4,
            bbox_y: 0.1 + j * 0.4,
            bbox_w: 0.2,
            bbox_h: 0.2,
            quality: 0.9,
            quality_ok: 1,
            blur: 0.1,
            embedding: dummyEmbedding,
          }, db);
        }
      }

      // 1. App restarts: reconciles 'clustering' -> 'paused'
      await reconcileInterruptedTripScans(db);
      const postRestartTrip = await getTripById(tripId, db);
      expect(postRestartTrip?.scan_status).toBe('paused');

      // 2. User resumes: scanTripFaces with autoCluster=true
      const result = await scanTripFaces(tripId, {
        db,
        autoCluster: true,
      });

      expect(result.status).toBe('completed');
      expect(result.scannedCount).toBe(0); // 0 pending photos to scan

      // Verify trip is now 'scanned'
      const finalTrip = await getTripById(tripId, db);
      expect(finalTrip?.scan_status).toBe('scanned');

      // Verify clustering created people and assigned faces
      const people = await getPeopleByTripId(tripId, db);
      expect(people.length).toBeGreaterThan(0);

      const faces = await getFacesByTripId(tripId, {}, db);
      expect(faces).toHaveLength(6);
      expect(faces.every((f) => f.person_id !== null)).toBe(true);
    });

    it('handles multiple successive kills and resumptions without duplicate faces', async () => {
      const tripId = 'trip-multi-kill';
      await createTrip({
        id: tripId,
        name: 'Multi Kill Trip',
        start_at: 1000,
        end_at: 5000,
        photo_count: 4,
        scan_status: 'not_scanned',
        scanned_count: 0,
      }, db);

      const photos: PhotoRow[] = Array.from({ length: 4 }, (_, i) => ({
        id: `photo-mk-${i + 1}`,
        trip_id: tripId,
        taken_at: 1000 + i * 100,
        modified_at: 1000 + i * 100,
        width: 1000,
        height: 1000,
        lat: null,
        lng: null,
        is_local: 1,
        scan_status: 'pending',
        face_count: 0,
        excluded: 0,
      }));
      await upsertPhotos(photos, db);

      const mockDetector = createMockDetector(1); // 1 face per photo
      const mockEmbedder = createMockEmbedder();

      // Session 1: Scan photo 1 then KILL
      await savePhotoFacesAtomic('photo-mk-1', tripId, [{
        id: 'face-mk-1',
        photo_id: 'photo-mk-1',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.1,
        bbox_y: 0.1,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.9,
        quality_ok: 1,
        blur: 0.1,
        embedding: new Uint8Array(512),
      }], db);
      await updateTrip(tripId, { scan_status: 'scanning' }, db);

      // Kill 1 -> Relaunch 1
      await reconcileInterruptedTripScans(db);
      expect((await getTripById(tripId, db))?.scan_status).toBe('paused');

      // Session 2: Scan photo 2 then KILL
      await savePhotoFacesAtomic('photo-mk-2', tripId, [{
        id: 'face-mk-2',
        photo_id: 'photo-mk-2',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.2,
        bbox_y: 0.2,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.9,
        quality_ok: 1,
        blur: 0.1,
        embedding: new Uint8Array(512),
      }], db);
      // Photo 3 had dangling face inserted right at crash
      await insertFace({
        id: 'face-mk-3-crash',
        photo_id: 'photo-mk-3',
        person_id: null,
        assignment: 'auto',
        bbox_x: 0.3,
        bbox_y: 0.3,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.9,
        quality_ok: 1,
        blur: 0.1,
        embedding: new Uint8Array(512),
      }, db);
      await updateTrip(tripId, { scan_status: 'scanning' }, db);

      // Kill 2 -> Relaunch 2
      await reconcileInterruptedTripScans(db);
      expect((await getTripById(tripId, db))?.scan_status).toBe('paused');

      // Session 3: Final resume to completion
      const finalResult = await scanTripFaces(tripId, {
        db,
        detector: mockDetector,
        embedder: mockEmbedder,
        autoCluster: true,
        photoUriResolver: async (id) => `file:///mock/${id}.jpg`,
      });

      expect(finalResult.status).toBe('completed');
      expect(finalResult.scannedCount).toBe(2); // Only photos 3 and 4

      // Verify exactly 4 faces total (NO duplicates from crash face or rescans)
      const faces = await getFacesByTripId(tripId, {}, db);
      expect(faces).toHaveLength(4);
      expect(faces.find((f) => f.id === 'face-mk-3-crash')).toBeUndefined();

      const trip = await getTripById(tripId, db);
      expect(trip?.scan_status).toBe('scanned');
      expect(trip?.scanned_count).toBe(4);
    });
  });

  describe('5. UI: TripDetailScreen Reconciles Interrupted Scan and Shows Resume', () => {
    it('automatically reconciles scanning state to paused and displays "Resume scan" button', async () => {
      const tripData: TripRow = {
        id: 'trip-killed-ui-test',
        name: 'Sylhet Tour',
        start_at: 1000,
        end_at: 2000,
        photo_count: 5,
        cover_photo_id: null,
        is_away: 0,
        is_hidden: 0,
        is_user_edited: 0,
        scan_status: 'scanning', // Left in scanning from killed process
        scanned_count: 2,
        created_at: 1000,
        updated_at: 1000,
      };

      const photos: PhotoRow[] = [
        {
          id: 'photo-ui-1',
          trip_id: tripData.id,
          taken_at: 1100,
          modified_at: 1100,
          width: 800,
          height: 600,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 2,
          excluded: 0,
        },
        {
          id: 'photo-ui-2',
          trip_id: tripData.id,
          taken_at: 1200,
          modified_at: 1200,
          width: 800,
          height: 600,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'pending',
          face_count: 0,
          excluded: 0,
        },
      ];

      const getTripSpy = jest.spyOn(tripsRepo, 'getTripById').mockResolvedValue(tripData);
      const updateTripSpy = jest.spyOn(tripsRepo, 'updateTrip').mockImplementation(async (_id, updates) => ({
        ...tripData,
        ...updates,
      } as TripRow));
      const getPhotosSpy = jest.spyOn(photosRepo, 'getPhotosByTripId').mockResolvedValue(photos);

      const screen = await render(
        <ThemeProvider>
          <TripDetailScreen />
        </ThemeProvider>
      );

      // Reconciles to paused on load
      await waitFor(() => {
        expect(updateTripSpy).toHaveBeenCalledWith('trip-killed-ui-test', { scan_status: 'paused' });
      });

      // Primary button displays "Resume scan"
      await waitFor(() => {
        const resumeBtn = screen.getByTestId('trip-primary-button');
        expect(resumeBtn).toBeTruthy();
        expect(screen.getByText('Resume scan')).toBeTruthy();
      });

      // Tapping "Resume scan" navigates to scan progress modal
      const resumeBtn = screen.getByTestId('trip-primary-button');
      await act(async () => {
        fireEvent.press(resumeBtn);
      });

      expect(mockRouter.push).toHaveBeenCalledWith('/trip/trip-killed-ui-test/scan');

      getTripSpy.mockRestore();
      updateTripSpy.mockRestore();
      getPhotosSpy.mockRestore();
    });
  });
});

