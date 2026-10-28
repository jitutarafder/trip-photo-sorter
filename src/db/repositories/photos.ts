import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../client';
import type { PhotoRow, PhotoScanStatus } from '../types';

async function resolveDb(db?: SQLiteDatabase): Promise<SQLiteDatabase> {
  return db ?? (await getDatabase());
}

/**
 * Upserts a single photo record (inserts or updates on conflict).
 */
export async function upsertPhoto(
  photo: PhotoRow,
  db?: SQLiteDatabase
): Promise<PhotoRow> {
  const database = await resolveDb(db);
  await database.runAsync(
    `INSERT INTO photos (
      id, trip_id, taken_at, modified_at, width, height,
      lat, lng, is_local, scan_status, face_count, excluded
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      trip_id = COALESCE(excluded.trip_id, photos.trip_id),
      modified_at = excluded.modified_at,
      width = excluded.width,
      height = excluded.height,
      lat = excluded.lat,
      lng = excluded.lng,
      is_local = excluded.is_local;`,
    [
      photo.id,
      photo.trip_id,
      photo.taken_at,
      photo.modified_at,
      photo.width,
      photo.height,
      photo.lat,
      photo.lng,
      photo.is_local,
      photo.scan_status,
      photo.face_count,
      photo.excluded,
    ]
  );
  return photo;
}

/**
 * Bulk upserts photos in a single transaction (used for incremental library sync in batches).
 */
export async function upsertPhotos(
  photos: PhotoRow[],
  db?: SQLiteDatabase
): Promise<void> {
  const database = await resolveDb(db);
  await database.withTransactionAsync(async () => {
    for (const photo of photos) {
      await upsertPhoto(photo, database);
    }
  });
}

/**
 * Retrieves a photo by its media library asset ID.
 */
export async function getPhotoById(
  id: string,
  db?: SQLiteDatabase
): Promise<PhotoRow | null> {
  const database = await resolveDb(db);
  return await database.getFirstAsync<PhotoRow>(
    'SELECT * FROM photos WHERE id = ?;',
    [id]
  );
}

/**
 * Retrieves all photos for a trip ordered by taken_at ASC.
 */
export async function getPhotosByTripId(
  tripId: string,
  options: { limit?: number; offset?: number } = {},
  db?: SQLiteDatabase
): Promise<PhotoRow[]> {
  const database = await resolveDb(db);
  if (options.limit !== undefined) {
    const offset = options.offset ?? 0;
    return await database.getAllAsync<PhotoRow>(
      'SELECT * FROM photos WHERE trip_id = ? ORDER BY taken_at ASC LIMIT ? OFFSET ?;',
      [tripId, options.limit, offset]
    );
  }
  return await database.getAllAsync<PhotoRow>(
    'SELECT * FROM photos WHERE trip_id = ? ORDER BY taken_at ASC;',
    [tripId]
  );
}

/**
 * Retrieves pending (unscanned) photos for a trip.
 */
export async function getPendingPhotosByTripId(
  tripId: string,
  limit?: number,
  db?: SQLiteDatabase
): Promise<PhotoRow[]> {
  const database = await resolveDb(db);
  if (limit !== undefined) {
    return await database.getAllAsync<PhotoRow>(
      "SELECT * FROM photos WHERE trip_id = ? AND scan_status = 'pending' ORDER BY taken_at ASC LIMIT ?;",
      [tripId, limit]
    );
  }
  return await database.getAllAsync<PhotoRow>(
    "SELECT * FROM photos WHERE trip_id = ? AND scan_status = 'pending' ORDER BY taken_at ASC;",
    [tripId]
  );
}

/**
 * Updates a photo row.
 */
export async function updatePhoto(
  id: string,
  updates: Partial<Omit<PhotoRow, 'id'>>,
  db?: SQLiteDatabase
): Promise<PhotoRow | null> {
  const database = await resolveDb(db);
  const existing = await getPhotoById(id, database);
  if (!existing) {
    return null;
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(val);
  }

  if (fields.length === 0) {
    return existing;
  }

  values.push(id);
  await database.runAsync(
    `UPDATE photos SET ${fields.join(', ')} WHERE id = ?;`,
    values as (string | number | null)[]
  );

  return await getPhotoById(id, database);
}

/**
 * Updates a photo's scan status and optionally face count.
 */
export async function updatePhotoScanStatus(
  id: string,
  status: PhotoScanStatus,
  faceCount?: number,
  db?: SQLiteDatabase
): Promise<void> {
  const database = await resolveDb(db);
  if (faceCount !== undefined) {
    await database.runAsync(
      'UPDATE photos SET scan_status = ?, face_count = ? WHERE id = ?;',
      [status, faceCount, id]
    );
  } else {
    await database.runAsync(
      'UPDATE photos SET scan_status = ? WHERE id = ?;',
      [status, id]
    );
  }
}

/**
 * Toggles or sets exclusion of a photo from all exports.
 */
export async function setPhotoExcluded(
  id: string,
  excluded: boolean,
  db?: SQLiteDatabase
): Promise<void> {
  const database = await resolveDb(db);
  await database.runAsync(
    'UPDATE photos SET excluded = ? WHERE id = ?;',
    [excluded ? 1 : 0, id]
  );
}

/**
 * Deletes photos by IDs (cascades to faces).
 */
export async function deletePhotos(
  ids: string[],
  db?: SQLiteDatabase
): Promise<number> {
  if (ids.length === 0) return 0;
  const database = await resolveDb(db);
  const placeholders = ids.map(() => '?').join(', ');
  const result = await database.runAsync(
    `DELETE FROM photos WHERE id IN (${placeholders});`,
    ids
  );
  return result.changes;
}

/**
 * Deletes photos from the database that are no longer in the user's gallery.
 * Implements Schema §5 integrity rule: deleted asset -> delete photos -> cascade to faces.
 */
export async function deleteMissingGalleryPhotos(
  existingAssetIds: string[],
  db?: SQLiteDatabase
): Promise<number> {
  if (existingAssetIds.length === 0) return 0;
  const database = await resolveDb(db);

  // For large libraries, run in batches or temporary table if needed.
  // Using NOT IN with placeholders:
  const placeholders = existingAssetIds.map(() => '?').join(', ');
  const result = await database.runAsync(
    `DELETE FROM photos WHERE id NOT IN (${placeholders});`,
    existingAssetIds
  );
  return result.changes;
}

/**
 * Assigns a trip ID to an array of photo IDs (chunks queries to stay within SQLite limits).
 */
export async function assignPhotosToTrip(
  photoIds: string[],
  tripId: string | null,
  db?: SQLiteDatabase
): Promise<number> {
  if (photoIds.length === 0) return 0;
  const database = await resolveDb(db);
  const CHUNK_SIZE = 400;
  let totalChanges = 0;

  for (let i = 0; i < photoIds.length; i += CHUNK_SIZE) {
    const chunk = photoIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const result = await database.runAsync(
      `UPDATE photos SET trip_id = ? WHERE id IN (${placeholders});`,
      [tripId, ...chunk]
    );
    totalChanges += result.changes;
  }

  return totalChanges;
}

/**
 * Sets trip_id to NULL for all photos belonging to a trip.
 */
export async function unassignPhotosFromTrip(
  tripId: string,
  db?: SQLiteDatabase
): Promise<number> {
  const database = await resolveDb(db);
  const result = await database.runAsync(
    'UPDATE photos SET trip_id = NULL WHERE trip_id = ?;',
    [tripId]
  );
  return result.changes;
}

/**
 * Retrieves photo timestamp items for trip detection, excluding photos
 * assigned to protected user-edited trips.
 */
export async function getPhotosForTripDetection(
  protectedTripIds: string[] = [],
  db?: SQLiteDatabase
): Promise<{ id: string; taken_at: number; trip_id: string | null }[]> {
  const database = await resolveDb(db);
  if (protectedTripIds.length > 0) {
    const placeholders = protectedTripIds.map(() => '?').join(', ');
    return await database.getAllAsync<{ id: string; taken_at: number; trip_id: string | null }>(
      `SELECT id, taken_at, trip_id FROM photos
       WHERE trip_id IS NULL OR trip_id NOT IN (${placeholders})
       ORDER BY taken_at ASC;`,
      protectedTripIds
    );
  }
  return await database.getAllAsync<{ id: string; taken_at: number; trip_id: string | null }>(
    'SELECT id, taken_at, trip_id FROM photos ORDER BY taken_at ASC;'
  );
}
