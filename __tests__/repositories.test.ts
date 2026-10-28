import { openDbSync } from '../src/db/client';
import { runMigrationsSync } from '../src/db/migrations';
import {
  createTrip,
  createTrips,
  getTripById,
  getAllTrips,
  updateTrip,
  deleteTrip,
  updateTripPhotoCount,
  incrementScannedCount,
  mergeTrips,
} from '../src/db/repositories/trips';
import {
  upsertPhoto,
  upsertPhotos,
  getPhotoById,
  getPhotosByTripId,
  getPendingPhotosByTripId,
  updatePhoto,
  updatePhotoScanStatus,
  setPhotoExcluded,
  deletePhotos,
  deleteMissingGalleryPhotos,
} from '../src/db/repositories/photos';
import {
  createPerson,
  getPersonById,
  getPeopleByTripId,
  getOrCreateOthersPerson,
  updatePerson,
  deletePerson,
  getPersonPhotos,
  excludePhotoFromPerson,
  includePhotoForPerson,
  getExcludedPhotoIdsForPerson,
  mergePeople,
} from '../src/db/repositories/people';
import {
  insertFace,
  insertFaces,
  getFaceById,
  getFacesByPhotoId,
  getFacesByPersonId,
  getFacesByTripId,
  updateFace,
  assignFacesToPerson,
  moveFace,
  deleteFacesByPhotoId,
} from '../src/db/repositories/faces';
import {
  createExport,
  getExportById,
  getExportsByTripId,
  updateExport,
  deleteExport,
  cleanupExportPath,
} from '../src/db/repositories/exports';
import {
  getSetting,
  setSetting,
  getAllSettings,
  deleteSetting,
  isOnboarded,
  setOnboarded,
  isPro,
  setPro,
  getLastSyncAt,
  setLastSyncAt,
  getSchemaVersion,
} from '../src/db/repositories/settings';
import type { PhotoRow, FaceRow } from '../src/db/types';

describe('Database Repositories (Task 1.3)', () => {
  const db = openDbSync(':memory:');

  beforeEach(() => {
    // Re-initialize fresh database schema in memory
    (db as unknown as { _clear: () => void })._clear();
    runMigrationsSync(db);
  });

  describe('Trips Repository', () => {
    it('creates and retrieves a trip', async () => {
      const trip = await createTrip(
        {
          id: 'trip-1',
          name: 'Coxsbazar Trip',
          start_at: 1000,
          end_at: 2000,
        },
        db
      );

      expect(trip.id).toBe('trip-1');
      expect(trip.name).toBe('Coxsbazar Trip');
      expect(trip.photo_count).toBe(0);
      expect(trip.scan_status).toBe('not_scanned');

      const retrieved = await getTripById('trip-1', db);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.name).toBe('Coxsbazar Trip');
    });

    it('creates multiple trips and retrieves all sorted by start_at DESC', async () => {
      await createTrips(
        [
          { id: 'trip-old', name: 'Old Trip', start_at: 100, end_at: 200 },
          { id: 'trip-new', name: 'New Trip', start_at: 500, end_at: 600 },
          { id: 'trip-hidden', name: 'Hidden Trip', start_at: 300, end_at: 400, is_hidden: 1 },
        ],
        db
      );

      const visible = await getAllTrips({}, db);
      expect(visible.map((t) => t.id)).toEqual(['trip-new', 'trip-old']);

      const all = await getAllTrips({ includeHidden: true }, db);
      expect(all.map((t) => t.id)).toEqual(['trip-new', 'trip-hidden', 'trip-old']);
    });

    it('updates a trip partial fields', async () => {
      await createTrip({ id: 'trip-up', name: 'Initial', start_at: 10, end_at: 20 }, db);
      const updated = await updateTrip('trip-up', { name: 'Updated Name', is_user_edited: 1 }, db);
      expect(updated?.name).toBe('Updated Name');
      expect(updated?.is_user_edited).toBe(1);
    });

    it('deletes a trip', async () => {
      await createTrip({ id: 'trip-del', name: 'Del', start_at: 1, end_at: 2 }, db);
      const deleted = await deleteTrip('trip-del', db);
      expect(deleted).toBe(true);

      const found = await getTripById('trip-del', db);
      expect(found).toBeNull();
    });

    it('updates trip photo count and increments scanned count', async () => {
      await createTrip({ id: 'trip-cnt', name: 'Count Test', start_at: 1, end_at: 2 }, db);
      await upsertPhoto(
        {
          id: 'p-1',
          trip_id: 'trip-cnt',
          taken_at: 1,
          modified_at: 1,
          width: 100,
          height: 100,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'pending',
          face_count: 0,
          excluded: 0,
        },
        db
      );

      const count = await updateTripPhotoCount('trip-cnt', db);
      expect(count).toBe(1);

      await incrementScannedCount('trip-cnt', 5, db);
      const t = await getTripById('trip-cnt', db);
      expect(t?.scanned_count).toBe(5);
    });

    it('merges two trips into target trip in a single transaction', async () => {
      await createTrip({ id: 'target', name: 'Target Trip', start_at: 200, end_at: 400 }, db);
      await createTrip({ id: 'source', name: 'Source Trip', start_at: 100, end_at: 300 }, db);

      await upsertPhoto(
        {
          id: 'photo-src',
          trip_id: 'source',
          taken_at: 150,
          modified_at: 150,
          width: 800,
          height: 600,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
        db
      );

      const merged = await mergeTrips('target', 'source', db);
      expect(merged.id).toBe('target');
      expect(merged.start_at).toBe(100);
      expect(merged.end_at).toBe(400);
      expect(merged.is_user_edited).toBe(1);
      expect(merged.photo_count).toBe(1);

      // Source trip should be deleted
      const sourceCheck = await getTripById('source', db);
      expect(sourceCheck).toBeNull();

      // Photo should now belong to target
      const photoCheck = await getPhotoById('photo-src', db);
      expect(photoCheck?.trip_id).toBe('target');
    });
  });

  describe('Photos Repository', () => {
    it('upserts a photo and retrieves it by ID', async () => {
      const photo: PhotoRow = {
        id: 'asset-123',
        trip_id: 'trip-1',
        taken_at: 5000,
        modified_at: 5000,
        width: 1920,
        height: 1080,
        lat: 21.42,
        lng: 91.97,
        is_local: 1,
        scan_status: 'pending',
        face_count: 0,
        excluded: 0,
      };

      await upsertPhoto(photo, db);
      const retrieved = await getPhotoById('asset-123', db);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.width).toBe(1920);
      expect(retrieved?.lat).toBe(21.42);
    });

    it('bulk upserts photos and queries by trip and pending scan status', async () => {
      const photos: PhotoRow[] = [
        {
          id: 'ph-1',
          trip_id: 'trip-test',
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
          id: 'ph-2',
          trip_id: 'trip-test',
          taken_at: 2000,
          modified_at: 2000,
          width: 100,
          height: 100,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'pending',
          face_count: 0,
          excluded: 0,
        },
      ];

      await upsertPhotos(photos, db);

      const allTripPhotos = await getPhotosByTripId('trip-test', {}, db);
      expect(allTripPhotos.length).toBe(2);

      const pending = await getPendingPhotosByTripId('trip-test', undefined, db);
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe('ph-2');
    });

    it('updates photo scan status and excluded state', async () => {
      await upsertPhoto(
        {
          id: 'ph-stat',
          trip_id: 't-1',
          taken_at: 10,
          modified_at: 10,
          width: 10,
          height: 10,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'pending',
          face_count: 0,
          excluded: 0,
        },
        db
      );

      await updatePhotoScanStatus('ph-stat', 'done', 2, db);
      let p = await getPhotoById('ph-stat', db);
      expect(p?.scan_status).toBe('done');
      expect(p?.face_count).toBe(2);

      await setPhotoExcluded('ph-stat', true, db);
      p = await getPhotoById('ph-stat', db);
      expect(p?.excluded).toBe(1);

      await updatePhoto('ph-stat', { width: 4000, height: 3000 }, db);
      p = await getPhotoById('ph-stat', db);
      expect(p?.width).toBe(4000);
      expect(p?.height).toBe(3000);
    });

    it('deletes photos and missing gallery photos', async () => {
      await upsertPhotos(
        [
          { id: 'p-a', trip_id: 't', taken_at: 1, modified_at: 1, width: 1, height: 1, lat: null, lng: null, is_local: 1, scan_status: 'done', face_count: 0, excluded: 0 },
          { id: 'p-b', trip_id: 't', taken_at: 2, modified_at: 2, width: 1, height: 1, lat: null, lng: null, is_local: 1, scan_status: 'done', face_count: 0, excluded: 0 },
        ],
        db
      );

      await deletePhotos(['p-a'], db);
      expect(await getPhotoById('p-a', db)).toBeNull();
      expect(await getPhotoById('p-b', db)).not.toBeNull();

      // Delete missing: only p-c exists in gallery, so p-b should be removed
      await deleteMissingGalleryPhotos(['p-c'], db);
      expect(await getPhotoById('p-b', db)).toBeNull();
    });
  });

  describe('People Repository', () => {
    it('creates, retrieves, and updates person', async () => {
      const person = await createPerson(
        {
          id: 'person-1',
          trip_id: 'trip-1',
          name: 'Rahim',
        },
        db
      );

      expect(person.id).toBe('person-1');
      expect(person.name).toBe('Rahim');

      const retrieved = await getPersonById('person-1', db);
      expect(retrieved?.name).toBe('Rahim');

      const updated = await updatePerson('person-1', { name: 'Rahim Uddin' }, db);
      expect(updated?.name).toBe('Rahim Uddin');

      const peopleInTrip = await getPeopleByTripId('trip-1', db);
      expect(peopleInTrip.length).toBe(1);

      await deletePerson('person-1', db);
      expect(await getPersonById('person-1', db)).toBeNull();
    });

    it('creates or retrieves the single Others person for a trip', async () => {
      const others = await getOrCreateOthersPerson('trip-1', 'others-1', db);
      expect(others.id).toBe('others-1');
      expect(others.is_others).toBe(1);

      // Calling again returns existing
      const second = await getOrCreateOthersPerson('trip-1', 'different-id', db);
      expect(second.id).toBe('others-1');
    });

    it('retrieves person photos using key query with exclusions and solo-only filter', async () => {
      await createTrip({ id: 't-people', name: 'T', start_at: 1, end_at: 2 }, db);
      await createPerson({ id: 'pers-a', trip_id: 't-people', name: 'Alice' }, db);

      // Photo 1: Solo Alice
      await upsertPhoto(
        { id: 'photo-solo', trip_id: 't-people', taken_at: 100, modified_at: 100, width: 10, height: 10, lat: null, lng: null, is_local: 1, scan_status: 'done', face_count: 1, excluded: 0 },
        db
      );
      // Photo 2: Group (Alice + Bob)
      await upsertPhoto(
        { id: 'photo-group', trip_id: 't-people', taken_at: 200, modified_at: 200, width: 10, height: 10, lat: null, lng: null, is_local: 1, scan_status: 'done', face_count: 2, excluded: 0 },
        db
      );
      // Photo 3: Excluded globally
      await upsertPhoto(
        { id: 'photo-ex', trip_id: 't-people', taken_at: 300, modified_at: 300, width: 10, height: 10, lat: null, lng: null, is_local: 1, scan_status: 'done', face_count: 1, excluded: 1 },
        db
      );

      const dummyEmbedding = new Uint8Array(512);
      await insertFace(
        { id: 'f-1', photo_id: 'photo-solo', person_id: 'pers-a', assignment: 'auto', bbox_x: 0, bbox_y: 0, bbox_w: 1, bbox_h: 1, quality: 0.9, quality_ok: 1, blur: null, embedding: dummyEmbedding },
        db
      );
      await insertFace(
        { id: 'f-2', photo_id: 'photo-group', person_id: 'pers-a', assignment: 'auto', bbox_x: 0, bbox_y: 0, bbox_w: 1, bbox_h: 1, quality: 0.9, quality_ok: 1, blur: null, embedding: dummyEmbedding },
        db
      );
      await insertFace(
        { id: 'f-3', photo_id: 'photo-ex', person_id: 'pers-a', assignment: 'auto', bbox_x: 0, bbox_y: 0, bbox_w: 1, bbox_h: 1, quality: 0.9, quality_ok: 1, blur: null, embedding: dummyEmbedding },
        db
      );

      // Default: returns photo-solo and photo-group (photo-ex excluded)
      const allPhotos = await getPersonPhotos('pers-a', {}, db);
      expect(allPhotos.map((p) => p.id)).toEqual(['photo-solo', 'photo-group']);

      // Solo only: returns photo-solo
      const soloPhotos = await getPersonPhotos('pers-a', { soloOnly: true }, db);
      expect(soloPhotos.map((p) => p.id)).toEqual(['photo-solo']);

      // Exclude photo-group specifically for pers-a
      await excludePhotoFromPerson('pers-a', 'photo-group', db);
      const excludedIds = await getExcludedPhotoIdsForPerson('pers-a', db);
      expect(excludedIds).toContain('photo-group');

      const afterExcluded = await getPersonPhotos('pers-a', {}, db);
      expect(afterExcluded.map((p) => p.id)).toEqual(['photo-solo']);

      // Re-include
      await includePhotoForPerson('pers-a', 'photo-group', db);
      const afterReInclude = await getPersonPhotos('pers-a', {}, db);
      expect(afterReInclude.map((p) => p.id)).toEqual(['photo-solo', 'photo-group']);
    });

    it('merges two people and pins face assignments', async () => {
      await createTrip({ id: 't-m', name: 'T', start_at: 1, end_at: 2 }, db);
      await createPerson({ id: 'target-p', trip_id: 't-m', name: 'Target' }, db);
      await createPerson({ id: 'source-p', trip_id: 't-m', name: 'Source' }, db);

      const dummyEmbedding = new Uint8Array(512);
      await insertFace(
        { id: 'f-src', photo_id: 'ph-dummy', person_id: 'source-p', assignment: 'auto', bbox_x: 0, bbox_y: 0, bbox_w: 1, bbox_h: 1, quality: 0.9, quality_ok: 1, blur: null, embedding: dummyEmbedding },
        db
      );

      await mergePeople('target-p', 'source-p', db);

      const sourcePerson = await getPersonById('source-p', db);
      expect(sourcePerson).toBeNull();

      const face = await getFaceById('f-src', db);
      expect(face?.person_id).toBe('target-p');
      expect(face?.assignment).toBe('manual'); // Pinned
    });
  });

  describe('Faces Repository', () => {
    it('inserts and queries faces by photo, person, and trip', async () => {
      const dummyEmbedding = new Uint8Array(512);
      const face: FaceRow = {
        id: 'face-1',
        photo_id: 'photo-1',
        person_id: 'pers-1',
        assignment: 'auto',
        bbox_x: 0.1,
        bbox_y: 0.1,
        bbox_w: 0.2,
        bbox_h: 0.2,
        quality: 0.95,
        quality_ok: 1,
        blur: 150.2,
        embedding: dummyEmbedding,
      };

      await insertFace(face, db);
      const retrieved = await getFaceById('face-1', db);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.quality).toBe(0.95);

      const byPhoto = await getFacesByPhotoId('photo-1', db);
      expect(byPhoto.length).toBe(1);

      const byPerson = await getFacesByPersonId('pers-1', db);
      expect(byPerson.length).toBe(1);

      await updateFace('face-1', { quality: 0.99 }, db);
      const updatedFace = await getFaceById('face-1', db);
      expect(updatedFace?.quality).toBe(0.99);

      const byTrip = await getFacesByTripId('trip-1', {}, db);
      expect(byTrip.length).toBe(0);
    });

    it('bulk inserts faces and assigns them to a person', async () => {
      const dummyEmbedding = new Uint8Array(512);
      await insertFaces(
        [
          { id: 'f-a', photo_id: 'p1', person_id: null, assignment: 'auto', bbox_x: 0, bbox_y: 0, bbox_w: 1, bbox_h: 1, quality: 0.9, quality_ok: 1, blur: null, embedding: dummyEmbedding },
          { id: 'f-b', photo_id: 'p1', person_id: null, assignment: 'auto', bbox_x: 0, bbox_y: 0, bbox_w: 1, bbox_h: 1, quality: 0.9, quality_ok: 1, blur: null, embedding: dummyEmbedding },
        ],
        db
      );

      await assignFacesToPerson(['f-a', 'f-b'], 'assigned-person', 'auto', db);
      const fA = await getFaceById('f-a', db);
      expect(fA?.person_id).toBe('assigned-person');

      await moveFace('f-a', 'moved-person', db);
      const fMoved = await getFaceById('f-a', db);
      expect(fMoved?.person_id).toBe('moved-person');
      expect(fMoved?.assignment).toBe('manual');
    });

    it('deletes faces by photo ID', async () => {
      const dummyEmbedding = new Uint8Array(512);
      await insertFace(
        { id: 'f-del', photo_id: 'p-to-del', person_id: null, assignment: 'auto', bbox_x: 0, bbox_y: 0, bbox_w: 1, bbox_h: 1, quality: 0.9, quality_ok: 1, blur: null, embedding: dummyEmbedding },
        db
      );

      await deleteFacesByPhotoId('p-to-del', db);
      expect(await getFaceById('f-del', db)).toBeNull();
    });
  });

  describe('Exports Repository', () => {
    it('creates, queries, updates, and cleans up an export', async () => {
      const exportItem = await createExport(
        {
          id: 'exp-1',
          trip_id: 'trip-1',
          person_id: 'person-1',
          mode: 'zip',
          status: 'pending',
          photo_count: 25,
          zip_path: '/tmp/test.zip',
        },
        db
      );

      expect(exportItem.id).toBe('exp-1');
      expect(exportItem.status).toBe('pending');

      const byTrip = await getExportsByTripId('trip-1', db);
      expect(byTrip.length).toBe(1);

      await updateExport('exp-1', { status: 'done', size_bytes: 10485760 }, db);
      const updated = await getExportById('exp-1', db);
      expect(updated?.status).toBe('done');
      expect(updated?.size_bytes).toBe(10485760);

      await cleanupExportPath('exp-1', db);
      const cleaned = await getExportById('exp-1', db);
      expect(cleaned?.zip_path).toBeNull();

      await deleteExport('exp-1', db);
      expect(await getExportById('exp-1', db)).toBeNull();
    });
  });

  describe('Settings Repository', () => {
    it('sets, gets, and deletes settings', async () => {
      await setSetting('custom_key', 'custom_value', db);
      const val = await getSetting('custom_key', null, db);
      expect(val).toBe('custom_value');

      const all = await getAllSettings(db);
      expect(all['custom_key']).toBe('custom_value');

      await deleteSetting('custom_key', db);
      expect(await getSetting('custom_key', null, db)).toBeNull();
    });

    it('handles typed settings: onboarded, is_pro, last_sync_at, and schema_version', async () => {
      expect(await isOnboarded(db)).toBe(false);
      await setOnboarded(true, db);
      expect(await isOnboarded(db)).toBe(true);

      expect(await isPro(db)).toBe(false);
      await setPro(true, db);
      expect(await isPro(db)).toBe(true);

      expect(await getLastSyncAt(db)).toBeNull();
      const now = 1700000000000;
      await setLastSyncAt(now, db);
      expect(await getLastSyncAt(db)).toBe(now);

      const version = await getSchemaVersion(db);
      expect(version).toBe('1');
    });
  });
});
