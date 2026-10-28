import * as React from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import * as LegacyFileSystem from 'expo-file-system/legacy';

import { openDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrations';
import { createTrip } from '../src/db/repositories/trips';
import { upsertPhotos } from '../src/db/repositories/photos';
import { createPerson } from '../src/db/repositories/people';
import { insertFaces } from '../src/db/repositories/faces';
import { createExport, getExportById, getExportsByTripId } from '../src/db/repositories/exports';
import type { PhotoRow, FaceRow } from '../src/db/types';
import {
  getExportsDirectory,
  ensureExportsDirectory,
  cleanupExportFile,
  sweepOrphanTempExports,
  useOrphanSweep,
  sanitizeFilename,
  buildExportZipFilename,
  resolvePhotoLocalUri,
  isUserCancellation,
  exportPerson,
  exportNamedPeopleBatch,
} from '../src/services/exporter';

// Mock expo-file-system legacy
jest.mock('expo-file-system/legacy', () => {
  return {
    cacheDirectory: 'file:///mock/cache/',
    documentDirectory: 'file:///mock/documents/',
    getInfoAsync: jest.fn(),
    makeDirectoryAsync: jest.fn(),
    deleteAsync: jest.fn(),
    readDirectoryAsync: jest.fn(),
    copyAsync: jest.fn(),
    getFreeDiskStorageAsync: jest.fn(),
  };
});

// Mock expo-media-library
jest.mock('expo-media-library', () => {
  return {
    getAssetInfoAsync: jest.fn().mockImplementation((id: string) => {
      return Promise.resolve({
        localUri: `file:///mock/media/${id}.jpg`,
        uri: `file:///mock/media/${id}.jpg`,
      });
    }),
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

function renderHookSim<T>(hookFn: () => T) {
  const stateSlots: unknown[] = [];
  const setterSlots: ((val: unknown) => void)[] = [];
  let slotIndex = 0;
  let effectCleanup: (() => void) | void;
  let effectFn: (() => (() => void) | void) | undefined;
  let effectDeps: unknown[] | undefined;
  let prevEffectDeps: unknown[] | undefined;

  const result: { current: T } = { current: undefined as unknown as T };

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

describe('Exporter Service (src/services/exporter.ts)', () => {
  let db: SQLiteDatabase;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = await openDb(':memory:');
    await runMigrations(db);

    // Setup standard mock responses for file system
    (LegacyFileSystem.getInfoAsync as jest.Mock).mockResolvedValue({
      exists: true,
      isDirectory: false,
      size: 1024 * 500, // 500 KB per photo
    });
    (LegacyFileSystem.makeDirectoryAsync as jest.Mock).mockResolvedValue(undefined);
    (LegacyFileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);
    (LegacyFileSystem.copyAsync as jest.Mock).mockResolvedValue(undefined);
    (LegacyFileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValue(1024 * 1024 * 1024); // 1 GB free
  });

  describe('Filename Sanitization (04_TRD §6)', () => {
    it('strips forbidden characters / \\ : * ? " < > | and trims whitespace', () => {
      expect(sanitizeFilename('Trip: Paris / Rome *?')).toBe('Trip Paris  Rome');
      expect(sanitizeFilename('  John "The Rock" Doe  ')).toBe('John The Rock Doe');
      expect(sanitizeFilename('<<Special>>|Chars/')).toBe('SpecialChars');
    });

    it('caps sanitized filename at 40 characters', () => {
      const longName = 'ThisIsAnExtremelyLongTripNameThatExceedsTheFortyCharacterLimitCompletely';
      const result = sanitizeFilename(longName);
      expect(result.length).toBe(40);
      expect(result).toBe('ThisIsAnExtremelyLongTripNameThatExceeds');
    });

    it('returns fallback if result is empty after stripping forbidden characters', () => {
      expect(sanitizeFilename('///:::***', 'FallbackTrip')).toBe('FallbackTrip');
      expect(sanitizeFilename('   ', 'DefaultPerson')).toBe('DefaultPerson');
    });

    it('builds standard zip filename {Trip}_{Person}.zip', () => {
      const zipName = buildExportZipFilename('Cox\'s Bazar', 'Rafi/Ahmed:');
      expect(zipName).toBe('Cox\'s Bazar_RafiAhmed.zip');
    });
  });

  describe('Photo URI Resolution & User Cancellation Helper', () => {
    it('returns null for iCloud-only photos (is_local = 0)', async () => {
      const photo: PhotoRow = {
        id: 'icloud_asset_1',
        trip_id: 't1',
        taken_at: 1000,
        modified_at: 1000,
        width: 100,
        height: 100,
        lat: null,
        lng: null,
        is_local: 0,
        scan_status: 'done',
        face_count: 1,
        excluded: 0,
      };
      const uri = await resolvePhotoLocalUri(photo);
      expect(uri).toBeNull();
    });

    it('returns file URI directly if already local', async () => {
      const photo: PhotoRow = {
        id: 'file:///local/path/pic.jpg',
        trip_id: 't1',
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
      };
      const uri = await resolvePhotoLocalUri(photo);
      expect(uri).toBe('file:///local/path/pic.jpg');
    });

    it('identifies cancellation error patterns', () => {
      expect(isUserCancellation(new Error('User did not share'))).toBe(true);
      expect(isUserCancellation({ dismissed: true })).toBe(true);
      expect(isUserCancellation('Operation was cancelled')).toBe(true);
      expect(isUserCancellation(new Error('Network error'))).toBe(false);
      expect(isUserCancellation(null)).toBe(false);
    });
  });

  describe('exportPerson in ZIP mode', () => {
    const TRIP_ID = 'trip_export_zip';
    const dummyBlob = new Uint8Array(512);

    beforeEach(async () => {
      await createTrip({ id: TRIP_ID, name: 'Sylhet Tour', start_at: 1000, end_at: 2000 }, db);
    });

    it('executes full zip export lifecycle, shares single zip, and cleans up temp files on success', async () => {
      const person = await createPerson({ id: 'p_tarek', trip_id: TRIP_ID, name: 'Tarek' }, db);

      const photos: PhotoRow[] = [
        {
          id: 'photo_1',
          trip_id: TRIP_ID,
          taken_at: 1000,
          modified_at: 1000,
          width: 1920,
          height: 1080,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
        {
          id: 'photo_2',
          trip_id: TRIP_ID,
          taken_at: 2000,
          modified_at: 2000,
          width: 1920,
          height: 1080,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 2, // Group photo
          excluded: 0,
        },
      ];
      await upsertPhotos(photos, db);

      const faces: FaceRow[] = [
        {
          id: 'f1',
          photo_id: 'photo_1',
          person_id: person.id,
          assignment: 'auto',
          bbox_x: 0.1,
          bbox_y: 0.1,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.9,
          quality_ok: 1,
          blur: 50,
          embedding: dummyBlob,
        },
        {
          id: 'f2',
          photo_id: 'photo_2',
          person_id: person.id,
          assignment: 'auto',
          bbox_x: 0.2,
          bbox_y: 0.2,
          bbox_w: 0.2,
          bbox_h: 0.2,
          quality: 0.9,
          quality_ok: 1,
          blur: 50,
          embedding: dummyBlob,
        },
      ];
      await insertFaces(faces, db);

      const mockZip = jest.fn().mockImplementation((src: string, target: string) => Promise.resolve(target));
      const mockShareSingle = jest.fn().mockResolvedValue(undefined);

      const result = await exportPerson({
        personId: person.id,
        tripId: TRIP_ID,
        mode: 'zip',
        soloOnly: false,
        db,
        zipFn: mockZip,
        shareSingleFn: mockShareSingle,
      });

      expect(result.mode).toBe('zip');
      expect(result.photoCount).toBe(2);
      expect(result.status).toBe('done');
      expect(result.zipPath).toBeNull(); // Cleaned up in finally!

      expect(mockZip).toHaveBeenCalledTimes(1);
      expect(mockShareSingle).toHaveBeenCalledTimes(1);
      expect(mockShareSingle.mock.calls[0][0]).toContain('Sylhet Tour_Tarek.zip');

      // Verify temp files were copied and then deleted
      expect(LegacyFileSystem.copyAsync).toHaveBeenCalledTimes(2);
      expect(LegacyFileSystem.deleteAsync).toHaveBeenCalled();

      // Verify DB record status is 'done' and zip_path is NULL
      const exp = await getExportById(result.exportId, db);
      expect(exp?.status).toBe('done');
      expect(exp?.zip_path).toBeNull();
      expect(exp?.photo_count).toBe(2);
    });

    it('respects soloOnly option (only exports photos where face_count = 1)', async () => {
      const person = await createPerson({ id: 'p_solo', trip_id: TRIP_ID, name: 'SoloPerson' }, db);

      const photos: PhotoRow[] = [
        {
          id: 'p_solo_1',
          trip_id: TRIP_ID,
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
        {
          id: 'p_group_2',
          trip_id: TRIP_ID,
          taken_at: 2000,
          modified_at: 2000,
          width: 100,
          height: 100,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 3, // Group photo
          excluded: 0,
        },
      ];
      await upsertPhotos(photos, db);

      await insertFaces(
        [
          {
            id: 'f_s1',
            photo_id: 'p_solo_1',
            person_id: person.id,
            assignment: 'auto',
            bbox_x: 0,
            bbox_y: 0,
            bbox_w: 0.1,
            bbox_h: 0.1,
            quality: 0.9,
            quality_ok: 1,
            blur: 50,
            embedding: dummyBlob,
          },
          {
            id: 'f_s2',
            photo_id: 'p_group_2',
            person_id: person.id,
            assignment: 'auto',
            bbox_x: 0,
            bbox_y: 0,
            bbox_w: 0.1,
            bbox_h: 0.1,
            quality: 0.9,
            quality_ok: 1,
            blur: 50,
            embedding: dummyBlob,
          },
        ],
        db
      );

      const result = await exportPerson({
        personId: person.id,
        tripId: TRIP_ID,
        mode: 'zip',
        soloOnly: true,
        db,
      });

      expect(result.photoCount).toBe(1);

      const exp = await getExportById(result.exportId, db);
      expect(exp?.solo_only).toBe(1);
      expect(exp?.photo_count).toBe(1);
    });

    it('rejects export if person is unnamed (AppFlow §3.7: Name first)', async () => {
      const unnamed = await createPerson({ id: 'p_unnamed', trip_id: TRIP_ID, name: null }, db);
      await expect(
        exportPerson({
          personId: unnamed.id,
          tripId: TRIP_ID,
          db,
        })
      ).rejects.toThrow('Person must have a name before export');
    });

    it('rejects export if person has 0 photos', async () => {
      const person = await createPerson({ id: 'p_empty', trip_id: TRIP_ID, name: 'EmptyPerson' }, db);
      await expect(
        exportPerson({
          personId: person.id,
          tripId: TRIP_ID,
          db,
        })
      ).rejects.toThrow('No eligible photos found');
    });
  });

  describe('exportPerson in Photos mode (≤ 30 photos multi-share)', () => {
    const TRIP_ID = 'trip_export_photos';
    const dummyBlob = new Uint8Array(512);

    beforeEach(async () => {
      await createTrip({ id: TRIP_ID, name: 'Photos Mode Trip', start_at: 1000, end_at: 2000 }, db);
    });

    it('shares multiple photos via react-native-share and cleans up files', async () => {
      const person = await createPerson({ id: 'p_photos_mode', trip_id: TRIP_ID, name: 'Amina' }, db);

      await upsertPhotos(
        [
          {
            id: 'photo_pm_1',
            trip_id: TRIP_ID,
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
          {
            id: 'photo_pm_2',
            trip_id: TRIP_ID,
            taken_at: 2000,
            modified_at: 2000,
            width: 100,
            height: 100,
            lat: null,
            lng: null,
            is_local: 1,
            scan_status: 'done',
            face_count: 1,
            excluded: 0,
          },
        ],
        db
      );

      await insertFaces(
        [
          {
            id: 'f_pm_1',
            photo_id: 'photo_pm_1',
            person_id: person.id,
            assignment: 'auto',
            bbox_x: 0,
            bbox_y: 0,
            bbox_w: 0.1,
            bbox_h: 0.1,
            quality: 0.9,
            quality_ok: 1,
            blur: 50,
            embedding: dummyBlob,
          },
          {
            id: 'f_pm_2',
            photo_id: 'photo_pm_2',
            person_id: person.id,
            assignment: 'auto',
            bbox_x: 0,
            bbox_y: 0,
            bbox_w: 0.1,
            bbox_h: 0.1,
            quality: 0.9,
            quality_ok: 1,
            blur: 50,
            embedding: dummyBlob,
          },
        ],
        db
      );

      const mockShareMulti = jest.fn().mockResolvedValue({ success: true });

      const result = await exportPerson({
        personId: person.id,
        tripId: TRIP_ID,
        mode: 'photos',
        db,
        shareMultiFn: mockShareMulti,
      });

      expect(result.mode).toBe('photos');
      expect(result.photoCount).toBe(2);
      expect(result.status).toBe('done');
      expect(mockShareMulti).toHaveBeenCalledTimes(1);
      expect(mockShareMulti.mock.calls[0][0]).toHaveLength(2);

      // Verify temp folder was deleted in finally
      expect(LegacyFileSystem.deleteAsync).toHaveBeenCalled();

      const exp = await getExportById(result.exportId, db);
      expect(exp?.status).toBe('done');
      expect(exp?.mode).toBe('photos');
    });

    it('rejects photos mode if photo count exceeds 30 (PRD US-09, Plan 2.8)', async () => {
      const person = await createPerson({ id: 'p_too_many', trip_id: TRIP_ID, name: 'BigSet' }, db);

      const photos: PhotoRow[] = [];
      const faces: FaceRow[] = [];
      for (let i = 0; i < 35; i++) {
        photos.push({
          id: `bulk_p_${i}`,
          trip_id: TRIP_ID,
          taken_at: 1000 + i * 10,
          modified_at: 1000 + i * 10,
          width: 100,
          height: 100,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        });
        faces.push({
          id: `bulk_f_${i}`,
          photo_id: `bulk_p_${i}`,
          person_id: person.id,
          assignment: 'auto',
          bbox_x: 0,
          bbox_y: 0,
          bbox_w: 0.1,
          bbox_h: 0.1,
          quality: 0.9,
          quality_ok: 1,
          blur: 50,
          embedding: dummyBlob,
        });
      }
      await upsertPhotos(photos, db);
      await insertFaces(faces, db);

      await expect(
        exportPerson({
          personId: person.id,
          tripId: TRIP_ID,
          mode: 'photos',
          db,
        })
      ).rejects.toThrow('Photos mode is limited to 30 photos or fewer');
    });
  });

  describe('Exit paths & Error handling (Zero trash & temp cleanup)', () => {
    const TRIP_ID = 'trip_exit_paths';
    const dummyBlob = new Uint8Array(512);

    beforeEach(async () => {
      await createTrip({ id: TRIP_ID, name: 'Error Trip', start_at: 1000, end_at: 2000 }, db);
    });

    it('handles share dismissal by user: marks cancelled and cleans up temp files', async () => {
      const person = await createPerson({ id: 'p_cancel', trip_id: TRIP_ID, name: 'Canceller' }, db);

      await upsertPhotos(
        [
          {
            id: 'p_canc_1',
            trip_id: TRIP_ID,
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
        ],
        db
      );
      await insertFaces(
        [
          {
            id: 'f_canc_1',
            photo_id: 'p_canc_1',
            person_id: person.id,
            assignment: 'auto',
            bbox_x: 0,
            bbox_y: 0,
            bbox_w: 0.1,
            bbox_h: 0.1,
            quality: 0.9,
            quality_ok: 1,
            blur: 50,
            embedding: dummyBlob,
          },
        ],
        db
      );

      const mockShareCancel = jest.fn().mockRejectedValue(new Error('User did not share'));

      const result = await exportPerson({
        personId: person.id,
        tripId: TRIP_ID,
        mode: 'zip',
        db,
        shareSingleFn: mockShareCancel,
      });

      expect(result.status).toBe('cancelled');
      expect(result.zipPath).toBeNull();

      // Verify temp folder was deleted
      expect(LegacyFileSystem.deleteAsync).toHaveBeenCalled();

      // Verify DB record status is 'cancelled'
      const exp = await getExportById(result.exportId, db);
      expect(exp?.status).toBe('cancelled');
      expect(exp?.zip_path).toBeNull();
    });

    it('enforces low storage pre-check (< 2x ZIP size free) and cleans up', async () => {
      const person = await createPerson({ id: 'p_space', trip_id: TRIP_ID, name: 'SpacePerson' }, db);

      await upsertPhotos(
        [
          {
            id: 'p_sp_1',
            trip_id: TRIP_ID,
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
        ],
        db
      );
      await insertFaces(
        [
          {
            id: 'f_sp_1',
            photo_id: 'p_sp_1',
            person_id: person.id,
            assignment: 'auto',
            bbox_x: 0,
            bbox_y: 0,
            bbox_w: 0.1,
            bbox_h: 0.1,
            quality: 0.9,
            quality_ok: 1,
            blur: 50,
            embedding: dummyBlob,
          },
        ],
        db
      );

      // Free space is very low: 100 bytes (less than 2x photo size)
      (LegacyFileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValueOnce(100);

      await expect(
        exportPerson({
          personId: person.id,
          tripId: TRIP_ID,
          mode: 'zip',
          db,
        })
      ).rejects.toThrow('Not enough storage space');

      // Temp folder must still be cleaned up in finally
      expect(LegacyFileSystem.deleteAsync).toHaveBeenCalled();
    });

    it('cleans up temp files and marks DB status failed on unexpected zipping error', async () => {
      const person = await createPerson({ id: 'p_fail', trip_id: TRIP_ID, name: 'FailPerson' }, db);

      await upsertPhotos(
        [
          {
            id: 'p_f_1',
            trip_id: TRIP_ID,
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
        ],
        db
      );
      await insertFaces(
        [
          {
            id: 'f_f_1',
            photo_id: 'p_f_1',
            person_id: person.id,
            assignment: 'auto',
            bbox_x: 0,
            bbox_y: 0,
            bbox_w: 0.1,
            bbox_h: 0.1,
            quality: 0.9,
            quality_ok: 1,
            blur: 50,
            embedding: dummyBlob,
          },
        ],
        db
      );

      const mockZipFail = jest.fn().mockRejectedValue(new Error('Corrupt archive engine error'));

      await expect(
        exportPerson({
          personId: person.id,
          tripId: TRIP_ID,
          mode: 'zip',
          db,
          zipFn: mockZipFail,
        })
      ).rejects.toThrow('Corrupt archive engine error');

      // Temp folder must still be cleaned up in finally
      expect(LegacyFileSystem.deleteAsync).toHaveBeenCalled();

      const exportsList = await getExportsByTripId(TRIP_ID, db);
      expect(exportsList.length).toBeGreaterThan(0);
      expect(exportsList[0].status).toBe('failed');
      expect(exportsList[0].error).toContain('Corrupt archive');
      expect(exportsList[0].zip_path).toBeNull();
    });
  });

  describe('exportNamedPeopleBatch (01_PRD US-10)', () => {
    const TRIP_ID = 'trip_batch';
    const dummyBlob = new Uint8Array(512);

    beforeEach(async () => {
      await createTrip({ id: TRIP_ID, name: 'Batch Trip', start_at: 1000, end_at: 2000 }, db);
    });

    it('sequentially exports all named people and calls onProgress', async () => {
      const p1 = await createPerson({ id: 'p_b1', trip_id: TRIP_ID, name: 'Alice' }, db);
      const p2 = await createPerson({ id: 'p_b2', trip_id: TRIP_ID, name: 'Bob' }, db);
      // Unnamed person should be ignored by batch
      await createPerson({ id: 'p_b3_unnamed', trip_id: TRIP_ID, name: null }, db);

      await upsertPhotos(
        [
          {
            id: 'ph_b1',
            trip_id: TRIP_ID,
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
          {
            id: 'ph_b2',
            trip_id: TRIP_ID,
            taken_at: 2000,
            modified_at: 2000,
            width: 100,
            height: 100,
            lat: null,
            lng: null,
            is_local: 1,
            scan_status: 'done',
            face_count: 1,
            excluded: 0,
          },
        ],
        db
      );

      await insertFaces(
        [
          {
            id: 'f_b1',
            photo_id: 'ph_b1',
            person_id: p1.id,
            assignment: 'auto',
            bbox_x: 0,
            bbox_y: 0,
            bbox_w: 0.1,
            bbox_h: 0.1,
            quality: 0.9,
            quality_ok: 1,
            blur: 50,
            embedding: dummyBlob,
          },
          {
            id: 'f_b2',
            photo_id: 'ph_b2',
            person_id: p2.id,
            assignment: 'auto',
            bbox_x: 0,
            bbox_y: 0,
            bbox_w: 0.1,
            bbox_h: 0.1,
            quality: 0.9,
            quality_ok: 1,
            blur: 50,
            embedding: dummyBlob,
          },
        ],
        db
      );

      const progressCalls: [number, number, string][] = [];
      const onProgress = (curr: number, tot: number, name: string) => {
        progressCalls.push([curr, tot, name]);
      };

      const results = await exportNamedPeopleBatch({
        tripId: TRIP_ID,
        mode: 'zip',
        db,
        onProgress,
      });

      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('done');
      expect(results[1].status).toBe('done');
      expect(progressCalls).toEqual([
        [1, 2, 'Alice'],
        [2, 2, 'Bob'],
      ]);
    });
  });

  describe('getExportsDirectory & ensureExportsDirectory', () => {
    it('returns the exports cache directory path ending with /', () => {
      const dir = getExportsDirectory();
      expect(dir).toBe('file:///mock/cache/exports/');
    });

    it('creates directory if it does not exist', async () => {
      (LegacyFileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
        exists: false,
        isDirectory: false,
      });
      (LegacyFileSystem.makeDirectoryAsync as jest.Mock).mockResolvedValueOnce(undefined);

      const dir = await ensureExportsDirectory();
      expect(dir).toBe('file:///mock/cache/exports/');
      expect(LegacyFileSystem.makeDirectoryAsync).toHaveBeenCalledWith(
        'file:///mock/cache/exports/',
        { intermediates: true }
      );
    });

    it('does not re-create directory if it already exists', async () => {
      (LegacyFileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
        exists: true,
        isDirectory: true,
      });

      await ensureExportsDirectory();
      expect(LegacyFileSystem.makeDirectoryAsync).not.toHaveBeenCalled();
    });
  });

  describe('cleanupExportFile', () => {
    it('deletes the export file on disk and sets zip_path to NULL in database', async () => {
      const exportRow = await createExport(
        {
          id: 'exp-1',
          trip_id: 'trip-test',
          status: 'ready',
          photo_count: 10,
          zip_path: 'file:///mock/cache/exports/exp-1.zip',
        },
        db
      );
      expect(exportRow.zip_path).toBe('file:///mock/cache/exports/exp-1.zip');

      (LegacyFileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
        exists: true,
        isDirectory: false,
      });
      (LegacyFileSystem.deleteAsync as jest.Mock).mockResolvedValueOnce(undefined);

      const cleaned = await cleanupExportFile('exp-1', null, db);
      expect(cleaned).toBe(true);
      expect(LegacyFileSystem.deleteAsync).toHaveBeenCalledWith(
        'file:///mock/cache/exports/exp-1.zip',
        { idempotent: true }
      );

      const check = await getExportById('exp-1', db);
      expect(check?.zip_path).toBeNull();
    });

    it('handles already-deleted file gracefully', async () => {
      await createExport(
        {
          id: 'exp-missing',
          trip_id: 'trip-test',
          status: 'ready',
          photo_count: 5,
          zip_path: 'file:///mock/cache/exports/missing.zip',
        },
        db
      );

      (LegacyFileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
        exists: false,
      });

      const cleaned = await cleanupExportFile('exp-missing', null, db);
      expect(cleaned).toBe(true);
      expect(LegacyFileSystem.deleteAsync).not.toHaveBeenCalled();

      const check = await getExportById('exp-missing', db);
      expect(check?.zip_path).toBeNull();
    });
  });

  describe('sweepOrphanTempExports at launch', () => {
    it('deletes lingering files in exports/ directory and marks interrupted DB exports as cancelled', async () => {
      await createTrip({ id: 'trip-test', name: 'Trip Test', start_at: 1000, end_at: 2000 }, db);

      await createExport(
        {
          id: 'exp-interrupted-1',
          trip_id: 'trip-test',
          status: 'zipping',
          photo_count: 20,
          zip_path: 'file:///mock/cache/exports/in-flight.zip',
        },
        db
      );

      await createExport(
        {
          id: 'exp-interrupted-2',
          trip_id: 'trip-test',
          status: 'ready',
          photo_count: 15,
          zip_path: 'file:///mock/cache/exports/ready.zip',
        },
        db
      );

      await createExport(
        {
          id: 'exp-done',
          trip_id: 'trip-test',
          status: 'done',
          photo_count: 10,
          zip_path: null,
        },
        db
      );

      (LegacyFileSystem.getInfoAsync as jest.Mock).mockImplementation((path: string) => {
        if (path === 'file:///mock/cache/exports/') {
          return Promise.resolve({ exists: true, isDirectory: true });
        }
        if (
          path === 'file:///mock/cache/exports/in-flight.zip' ||
          path === 'file:///mock/cache/exports/ready.zip' ||
          path === 'file:///mock/cache/exports/orphan-abandoned.zip'
        ) {
          return Promise.resolve({ exists: true, isDirectory: false });
        }
        return Promise.resolve({ exists: false, isDirectory: false });
      });

      (LegacyFileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
        'orphan-abandoned.zip',
      ]);
      (LegacyFileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);

      const sweepResult = await sweepOrphanTempExports(db);

      expect(sweepResult.clearedDbRecordsCount).toBe(2);
      expect(sweepResult.deletedFilesCount).toBe(3);
      expect(sweepResult.errors).toHaveLength(0);

      const exp1 = await getExportById('exp-interrupted-1', db);
      expect(exp1?.status).toBe('cancelled');
      expect(exp1?.zip_path).toBeNull();
      expect(exp1?.error).toBe('Interrupted by app termination');

      const exp2 = await getExportById('exp-interrupted-2', db);
      expect(exp2?.status).toBe('cancelled');
      expect(exp2?.zip_path).toBeNull();

      const expDone = await getExportById('exp-done', db);
      expect(expDone?.status).toBe('done');
      expect(expDone?.zip_path).toBeNull();
    });

    it('tolerates non-existent exports directory on clean installs', async () => {
      (LegacyFileSystem.getInfoAsync as jest.Mock).mockResolvedValue({
        exists: false,
        isDirectory: false,
      });

      const result = await sweepOrphanTempExports(db);
      expect(result.deletedFilesCount).toBe(0);
      expect(result.clearedDbRecordsCount).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('records errors without crashing if file deletion throws', async () => {
      await createTrip({ id: 'trip-test', name: 'Trip Test', start_at: 1000, end_at: 2000 }, db);

      await createExport(
        {
          id: 'exp-err',
          trip_id: 'trip-test',
          status: 'ready',
          photo_count: 5,
          zip_path: 'file:///mock/cache/exports/locked.zip',
        },
        db
      );

      (LegacyFileSystem.getInfoAsync as jest.Mock).mockImplementation((path: string) => {
        if (path === 'file:///mock/cache/exports/') {
          return Promise.resolve({ exists: false });
        }
        return Promise.resolve({ exists: true });
      });

      (LegacyFileSystem.deleteAsync as jest.Mock).mockRejectedValueOnce(
        new Error('Permission denied')
      );

      const result = await sweepOrphanTempExports(db);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Permission denied');
    });
  });

  describe('useOrphanSweep hook', () => {
    it('executes sweep on mount and sets sweepResult', async () => {
      (LegacyFileSystem.getInfoAsync as jest.Mock).mockResolvedValue({
        exists: false,
      });

      const harness = renderHookSim(() => useOrphanSweep(db));
      expect(harness.result.current.isSweeping).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(harness.result.current.isSweeping).toBe(false);
      expect(harness.result.current.sweepResult).not.toBeNull();
      expect(harness.result.current.sweepResult?.deletedFilesCount).toBe(0);
      expect(harness.result.current.error).toBeNull();

      harness.unmount();
    });

    it('supports manual resweep', async () => {
      (LegacyFileSystem.getInfoAsync as jest.Mock).mockResolvedValue({
        exists: false,
      });

      const harness = renderHookSim(() => useOrphanSweep(db));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await harness.result.current.resweep();
      expect(res.deletedFilesCount).toBe(0);
      expect(harness.result.current.isSweeping).toBe(false);

      harness.unmount();
    });
  });
});
