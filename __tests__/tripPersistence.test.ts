import { openDbSync } from '../src/db/client';
import { runMigrationsSync } from '../src/db/migrations';
import {
  createTrip,
  getTripById,
  getAllTrips,
  getUserEditedTrips,
  getAutoDetectedTrips,
} from '../src/db/repositories/trips';
import {
  upsertPhotos,
  getPhotosByTripId,
  getPhotoById,
} from '../src/db/repositories/photos';
import { getPeopleByTripId } from '../src/db/repositories/people';
import type { PhotoRow } from '../src/db/types';
import {
  detectAndPersistTrips,
} from '../src/services/tripService';

describe('Trip Persistence & Re-detection Service', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const BASE_TIME = Date.UTC(2026, 9, 24, 8, 0, 0); // 2026-10-24 08:00:00 UTC
  const db = openDbSync(':memory:');

  beforeEach(() => {
    (db as unknown as { _clear: () => void })._clear();
    runMigrationsSync(db);
  });

  function createMockPhotos(
    count: number,
    intervalMs: number,
    startMs: number = BASE_TIME,
    prefix: string = 'p'
  ): PhotoRow[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `${prefix}_${i + 1}`,
      trip_id: null,
      taken_at: startMs + i * intervalMs,
      modified_at: startMs + i * intervalMs,
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

  it('persists newly detected trips and assigns photos.trip_id on first run', async () => {
    // 20 photos for a valid trip (30 min apart, span = 9.5 hours)
    const tripPhotos = createMockPhotos(20, 30 * 60 * 1000, BASE_TIME, 't1');
    // 3 isolated single-photo days (should NOT form a trip)
    const isolatedPhotos: PhotoRow[] = [
      {
        id: 'iso_1',
        trip_id: null,
        taken_at: BASE_TIME + 48 * HOUR_MS,
        modified_at: BASE_TIME + 48 * HOUR_MS,
        width: 1920,
        height: 1080,
        lat: null,
        lng: null,
        is_local: 1,
        scan_status: 'pending',
        face_count: 0,
        excluded: 0,
      },
      {
        id: 'iso_2',
        trip_id: null,
        taken_at: BASE_TIME + 72 * HOUR_MS,
        modified_at: BASE_TIME + 72 * HOUR_MS,
        width: 1920,
        height: 1080,
        lat: null,
        lng: null,
        is_local: 1,
        scan_status: 'pending',
        face_count: 0,
        excluded: 0,
      },
    ];

    await upsertPhotos([...tripPhotos, ...isolatedPhotos], db);

    const result = await detectAndPersistTrips({ db, timeZone: 'UTC' });

    expect(result.detectedCount).toBe(1);
    expect(result.createdCount).toBe(1);
    expect(result.updatedCount).toBe(0);
    expect(result.trips).toHaveLength(1);

    const persistedTrip = result.trips[0];
    expect(persistedTrip.photo_count).toBe(20);
    expect(persistedTrip.cover_photo_id).toBe('t1_1');
    expect(persistedTrip.is_user_edited).toBe(0);
    expect(persistedTrip.scan_status).toBe('not_scanned');
    expect(persistedTrip.name).toBe('Trip · Oct 24, 2026');

    // Verify photos have photos.trip_id assigned
    const assignedPhotos = await getPhotosByTripId(persistedTrip.id, {}, db);
    expect(assignedPhotos).toHaveLength(20);

    // Verify isolated photos remain without trip_id
    const iso1 = await getPhotoById('iso_1', db);
    const iso2 = await getPhotoById('iso_2', db);
    expect(iso1?.trip_id).toBeNull();
    expect(iso2?.trip_id).toBeNull();

    // Verify "Others" person row was created for the new trip
    const people = await getPeopleByTripId(persistedTrip.id, db);
    expect(people).toHaveLength(1);
    expect(people[0].is_others).toBe(1);
    expect(people[0].name).toBe('Others');
  });

  it('reconciles existing auto-detected trip when incremental photos are synced', async () => {
    // Initial 16 photos
    const initialPhotos = createMockPhotos(16, 20 * 60 * 1000, BASE_TIME, 't');
    await upsertPhotos(initialPhotos, db);

    const firstRun = await detectAndPersistTrips({ db, timeZone: 'UTC' });
    expect(firstRun.createdCount).toBe(1);
    const originalTripId = firstRun.trips[0].id;

    // Simulate partial scanning on the trip
    await db.runAsync("UPDATE trips SET scan_status = 'scanning', scanned_count = 5 WHERE id = ?;", [
      originalTripId,
    ]);

    // Incremental sync adds 4 new photos to the same trip
    const lastInitialTime = initialPhotos[initialPhotos.length - 1].taken_at;
    const additionalPhotos = createMockPhotos(4, 20 * 60 * 1000, lastInitialTime + 20 * 60 * 1000, 'extra');
    await upsertPhotos(additionalPhotos, db);

    // Run detection again
    const secondRun = await detectAndPersistTrips({ db, timeZone: 'UTC' });
    expect(secondRun.detectedCount).toBe(1);
    expect(secondRun.createdCount).toBe(0);
    expect(secondRun.updatedCount).toBe(1);
    expect(secondRun.trips).toHaveLength(1);

    const updatedTrip = secondRun.trips[0];
    // Trip ID is preserved
    expect(updatedTrip.id).toBe(originalTripId);
    // Photo count increased from 16 to 20
    expect(updatedTrip.photo_count).toBe(20);
    // Existing scan progress is preserved
    expect(updatedTrip.scan_status).toBe('scanning');
    expect(updatedTrip.scanned_count).toBe(5);

    // All 20 photos are assigned to the trip
    const assignedPhotos = await getPhotosByTripId(originalTripId, {}, db);
    expect(assignedPhotos).toHaveLength(20);
  });

  it('strictly preserves is_user_edited = 1 trips on re-detection', async () => {
    // 1. Create a user-edited trip directly with custom name and dates
    const userTripId = 'user-custom-trip-1';
    const userTripStart = BASE_TIME;
    const userTripEnd = BASE_TIME + 8 * HOUR_MS;
    await createTrip(
      {
        id: userTripId,
        name: "Sylhet Family Vacation",
        start_at: userTripStart,
        end_at: userTripEnd,
        photo_count: 18,
        cover_photo_id: 'user_p_1',
        is_user_edited: 1, // Marked as user edited
        scan_status: 'scanned',
        scanned_count: 18,
      },
      db
    );

    // 18 photos belonging to the user-edited trip
    const userPhotos: PhotoRow[] = Array.from({ length: 18 }, (_, i) => ({
      id: `user_p_${i + 1}`,
      trip_id: userTripId,
      taken_at: userTripStart + i * (20 * 60 * 1000),
      modified_at: userTripStart + i * (20 * 60 * 1000),
      width: 1920,
      height: 1080,
      lat: null,
      lng: null,
      is_local: 1,
      scan_status: 'done',
      face_count: 1,
      excluded: 0,
    }));
    await upsertPhotos(userPhotos, db);

    // 2. Add 20 unassigned photos for a completely new, separate auto trip 3 days later
    const newAutoStart = BASE_TIME + 72 * HOUR_MS;
    const autoPhotos = createMockPhotos(20, 20 * 60 * 1000, newAutoStart, 'new_trip');
    await upsertPhotos(autoPhotos, db);

    // 3. Run trip detection
    const result = await detectAndPersistTrips({ db, timeZone: 'UTC' });

    expect(result.preservedUserEditedCount).toBe(1);
    expect(result.createdCount).toBe(1);
    expect(result.trips).toHaveLength(2);

    // Verify user-edited trip was completely preserved
    const retrievedUserTrip = await getTripById(userTripId, db);
    expect(retrievedUserTrip).not.toBeNull();
    expect(retrievedUserTrip?.name).toBe("Sylhet Family Vacation"); // Name NOT overwritten
    expect(retrievedUserTrip?.is_user_edited).toBe(1);
    expect(retrievedUserTrip?.scan_status).toBe('scanned');
    expect(retrievedUserTrip?.cover_photo_id).toBe('user_p_1');

    // Verify all 18 photos still belong to the user-edited trip
    const userTripPhotos = await getPhotosByTripId(userTripId, {}, db);
    expect(userTripPhotos).toHaveLength(18);

    // Verify the newly created auto trip is separate
    const autoTrips = await getAutoDetectedTrips(db);
    expect(autoTrips).toHaveLength(1);
    expect(autoTrips[0].photo_count).toBe(20);
    expect(autoTrips[0].is_user_edited).toBe(0);
  });

  it('deletes stale auto-trips if photos are removed below threshold but keeps user-edited trips', async () => {
    // Create an auto-detected trip with 16 photos
    const photos = createMockPhotos(16, 20 * 60 * 1000, BASE_TIME, 't');
    await upsertPhotos(photos, db);

    const firstResult = await detectAndPersistTrips({ db, timeZone: 'UTC' });
    expect(firstResult.createdCount).toBe(1);
    const autoTripId = firstResult.trips[0].id;

    // Create a user-edited trip with 5 photos (below 15 threshold, but protected)
    const userTripId = 'user-protected-trip';
    await createTrip(
      {
        id: userTripId,
        name: 'Manual Small Trip',
        start_at: BASE_TIME + 48 * HOUR_MS,
        end_at: BASE_TIME + 50 * HOUR_MS,
        photo_count: 5,
        is_user_edited: 1,
      },
      db
    );
    const userSmallPhotos: PhotoRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `small_${i + 1}`,
      trip_id: userTripId,
      taken_at: BASE_TIME + 48 * HOUR_MS + i * (30 * 60 * 1000),
      modified_at: BASE_TIME + 48 * HOUR_MS,
      width: 1920,
      height: 1080,
      lat: null,
      lng: null,
      is_local: 1,
      scan_status: 'pending',
      face_count: 0,
      excluded: 0,
    }));
    await upsertPhotos(userSmallPhotos, db);

    // Now delete 10 photos of the auto-trip so only 6 remain (below 15 threshold)
    const photosToDelete = photos.slice(0, 10).map((p) => p.id);
    const placeholders = photosToDelete.map(() => '?').join(', ');
    await db.runAsync(`DELETE FROM photos WHERE id IN (${placeholders});`, photosToDelete);

    // Re-detect trips
    const secondResult = await detectAndPersistTrips({ db, timeZone: 'UTC' });

    // The auto-trip is now stale (< 15 photos) and should be deleted
    expect(secondResult.deletedStaleCount).toBe(1);
    const staleTrip = await getTripById(autoTripId, db);
    expect(staleTrip).toBeNull();

    // Remaining 6 photos of that auto-trip now have trip_id = null
    for (const p of photos.slice(10)) {
      const row = await getPhotoById(p.id, db);
      expect(row?.trip_id).toBeNull();
    }

    // But the user-edited trip is PRESERVED despite having only 5 photos!
    const userTrip = await getTripById(userTripId, db);
    expect(userTrip).not.toBeNull();
    expect(userTrip?.name).toBe('Manual Small Trip');
    expect(userTrip?.is_user_edited).toBe(1);
  });

  it('handles empty database and preserves all user trips without errors', async () => {
    const result = await detectAndPersistTrips({ db, timeZone: 'UTC' });

    expect(result.detectedCount).toBe(0);
    expect(result.createdCount).toBe(0);
    expect(result.updatedCount).toBe(0);
    expect(result.preservedUserEditedCount).toBe(0);
    expect(result.deletedStaleCount).toBe(0);
    expect(result.trips).toEqual([]);
  });

  it('correctly queries getUserEditedTrips and getAutoDetectedTrips repositories', async () => {
    await createTrip({ id: 'auto-1', name: 'Auto 1', start_at: 100, end_at: 200, is_user_edited: 0 }, db);
    await createTrip({ id: 'auto-2', name: 'Auto 2', start_at: 300, end_at: 400, is_user_edited: 0 }, db);
    await createTrip({ id: 'user-1', name: 'User 1', start_at: 500, end_at: 600, is_user_edited: 1 }, db);

    const autoTrips = await getAutoDetectedTrips(db);
    const userTrips = await getUserEditedTrips(db);
    const all = await getAllTrips({}, db);

    expect(autoTrips).toHaveLength(2);
    expect(userTrips).toHaveLength(1);
    expect(all).toHaveLength(3);
    expect(userTrips[0].id).toBe('user-1');
  });
});
