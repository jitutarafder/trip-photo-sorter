import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../client';
import type { FaceAssignment, FaceRow } from '../types';

async function resolveDb(db?: SQLiteDatabase): Promise<SQLiteDatabase> {
  return db ?? (await getDatabase());
}

/**
 * Inserts a single detected face row into the database.
 */
export async function insertFace(
  face: FaceRow,
  db?: SQLiteDatabase
): Promise<FaceRow> {
  const database = await resolveDb(db);
  await database.runAsync(
    `INSERT INTO faces (
      id, photo_id, person_id, assignment, bbox_x, bbox_y, bbox_w, bbox_h,
      quality, quality_ok, blur, embedding
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      face.id,
      face.photo_id,
      face.person_id,
      face.assignment,
      face.bbox_x,
      face.bbox_y,
      face.bbox_w,
      face.bbox_h,
      face.quality,
      face.quality_ok,
      face.blur,
      face.embedding,
    ]
  );
  return face;
}

/**
 * Bulk inserts multiple faces within a single transaction.
 */
export async function insertFaces(
  faces: FaceRow[],
  db?: SQLiteDatabase
): Promise<void> {
  if (faces.length === 0) return;
  const database = await resolveDb(db);
  await database.withTransactionAsync(async () => {
    for (const face of faces) {
      await insertFace(face, database);
    }
  });
}

/**
 * Retrieves a face by ID.
 */
export async function getFaceById(
  id: string,
  db?: SQLiteDatabase
): Promise<FaceRow | null> {
  const database = await resolveDb(db);
  return await database.getFirstAsync<FaceRow>(
    'SELECT * FROM faces WHERE id = ?;',
    [id]
  );
}

/**
 * Retrieves all faces detected in a specific photo.
 */
export async function getFacesByPhotoId(
  photoId: string,
  db?: SQLiteDatabase
): Promise<FaceRow[]> {
  const database = await resolveDb(db);
  return await database.getAllAsync<FaceRow>(
    'SELECT * FROM faces WHERE photo_id = ?;',
    [photoId]
  );
}

/**
 * Retrieves all faces assigned to a specific person.
 */
export async function getFacesByPersonId(
  personId: string,
  db?: SQLiteDatabase
): Promise<FaceRow[]> {
  const database = await resolveDb(db);
  return await database.getAllAsync<FaceRow>(
    'SELECT * FROM faces WHERE person_id = ?;',
    [personId]
  );
}

/**
 * Retrieves all faces in a trip, optionally filtering by quality_ok = 1.
 */
export async function getFacesByTripId(
  tripId: string,
  options: { qualityOnly?: boolean } = {},
  db?: SQLiteDatabase
): Promise<FaceRow[]> {
  const database = await resolveDb(db);
  if (options.qualityOnly) {
    return await database.getAllAsync<FaceRow>(
      `SELECT f.* FROM faces f
       JOIN photos p ON f.photo_id = p.id
       WHERE p.trip_id = ? AND f.quality_ok = 1;`,
      [tripId]
    );
  }
  return await database.getAllAsync<FaceRow>(
    `SELECT f.* FROM faces f
     JOIN photos p ON f.photo_id = p.id
     WHERE p.trip_id = ?;`,
    [tripId]
  );
}

/**
 * Updates face attributes.
 */
export async function updateFace(
  id: string,
  updates: Partial<Omit<FaceRow, 'id' | 'photo_id'>>,
  db?: SQLiteDatabase
): Promise<FaceRow | null> {
  const database = await resolveDb(db);
  const existing = await getFaceById(id, database);
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
    `UPDATE faces SET ${fields.join(', ')} WHERE id = ?;`,
    values as (string | number | Uint8Array | null)[]
  );

  return await getFaceById(id, database);
}

/**
 * Assigns multiple faces to a person.
 */
export async function assignFacesToPerson(
  faceIds: string[],
  personId: string | null,
  assignment: FaceAssignment = 'auto',
  db?: SQLiteDatabase
): Promise<void> {
  if (faceIds.length === 0) return;
  const database = await resolveDb(db);
  const BATCH_SIZE = 500;
  for (let i = 0; i < faceIds.length; i += BATCH_SIZE) {
    const chunk = faceIds.slice(i, i + BATCH_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    await database.runAsync(
      `UPDATE faces SET person_id = ?, assignment = ? WHERE id IN (${placeholders});`,
      [personId, assignment, ...chunk]
    );
  }
}

/**
 * Manually moves a face to another person, setting assignment to 'manual' (pinned).
 */
export async function moveFace(
  faceId: string,
  targetPersonId: string | null,
  db?: SQLiteDatabase
): Promise<void> {
  const database = await resolveDb(db);
  await database.runAsync(
    "UPDATE faces SET person_id = ?, assignment = 'manual' WHERE id = ?;",
    [targetPersonId, faceId]
  );
}

/**
 * Deletes all faces for a photo.
 */
export async function deleteFacesByPhotoId(
  photoId: string,
  db?: SQLiteDatabase
): Promise<void> {
  const database = await resolveDb(db);
  await database.runAsync('DELETE FROM faces WHERE photo_id = ?;', [photoId]);
}

/**
 * Retrieves the clearest faces for a person, sorted by quality_ok DESC, blur DESC, quality DESC.
 * Used in the Naming flow (02_AppFlow §3.5) to pick a representative face.
 */
export async function getClearestFacesForPerson(
  personId: string,
  limit = 8,
  db?: SQLiteDatabase
): Promise<FaceRow[]> {
  const database = await resolveDb(db);
  return await database.getAllAsync<FaceRow>(
    `SELECT * FROM faces
     WHERE person_id = ?
     ORDER BY quality_ok DESC, blur DESC, quality DESC
     LIMIT ?;`,
    [personId, limit]
  );
}

/**
 * Retrieves face IDs belonging to a person for a given list of photo IDs.
 * Used when moving or removing selected photos from a person (02_AppFlow §3.6).
 */
export async function getFaceIdsForPersonPhotos(
  personId: string,
  photoIds: string[],
  db?: SQLiteDatabase
): Promise<string[]> {
  if (photoIds.length === 0) return [];
  const database = await resolveDb(db);
  const placeholders = photoIds.map(() => '?').join(', ');
  const rows = await database.getAllAsync<{ id: string }>(
    `SELECT id FROM faces 
     WHERE person_id = ? AND photo_id IN (${placeholders});`,
    [personId, ...photoIds]
  );
  return rows.map((r) => r.id);
}

/**
 * Deletes any faces associated with pending (uncompleted) photos for a trip.
 * Used during scan resumption to clean up any orphaned faces left from an interrupted/killed scan.
 */
export async function deleteOrphanFacesForPendingTripPhotos(
  tripId: string,
  db?: SQLiteDatabase
): Promise<number> {
  const database = await resolveDb(db);
  const result = await database.runAsync(
    `DELETE FROM faces WHERE photo_id IN (
       SELECT id FROM photos WHERE trip_id = ? AND scan_status = 'pending'
     );`,
    [tripId]
  );
  return result.changes;
}

/**
 * Atomically saves faces for a photo and marks the photo as done.
 * Deletes any existing faces for this photo first to prevent duplicate faces on scan resume.
 */
export async function savePhotoFacesAtomic(
  photoId: string,
  tripId: string,
  faces: FaceRow[],
  db?: SQLiteDatabase
): Promise<void> {
  const database = await resolveDb(db);
  await database.withTransactionAsync(async () => {
    await database.runAsync('DELETE FROM faces WHERE photo_id = ?;', [photoId]);
    for (const face of faces) {
      await database.runAsync(
        `INSERT INTO faces (
          id, photo_id, person_id, assignment, bbox_x, bbox_y, bbox_w, bbox_h,
          quality, quality_ok, blur, embedding
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          face.id,
          face.photo_id,
          face.person_id,
          face.assignment,
          face.bbox_x,
          face.bbox_y,
          face.bbox_w,
          face.bbox_h,
          face.quality,
          face.quality_ok,
          face.blur,
          face.embedding,
        ]
      );
    }
    await database.runAsync(
      'UPDATE photos SET scan_status = ?, face_count = ? WHERE id = ?;',
      ['done', faces.length, photoId]
    );
    await database.runAsync(
      'UPDATE trips SET scanned_count = scanned_count + ?, updated_at = ? WHERE id = ?;',
      [1, Date.now(), tripId]
    );
  });
}
