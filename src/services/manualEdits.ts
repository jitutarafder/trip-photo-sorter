import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../db/client';
import {
  getPersonById,
  updatePerson,
  getOrCreateOthersPerson,
  deletePerson,
} from '../db/repositories/people';
import { getFacesByPersonId } from '../db/repositories/faces';
import type { PersonRow } from '../db/types';
import { generateUUID } from '../utils/uuid';
import { recomputePersonCentroid } from './assignment';

export interface MoveFacesResult {
  movedCount: number;
  targetPerson: PersonRow;
  affectedPersonIds: string[];
}

export interface RemoveFacesResult {
  removedCount: number;
  othersPerson: PersonRow;
  affectedPersonIds: string[];
}

export interface MergePeopleResult {
  targetPerson: PersonRow;
  mergedFacesCount: number;
}

/**
 * Moves one or more faces to a target person in an atomic transaction.
 *
 * Rules (Plan Task 2.7, TRD §4):
 * - Sets `assignment = 'manual'` (pinned, immune to future auto-clustering / re-assignment).
 * - Recomputes centroid for targetPerson from its quality_ok = 1 faces.
 * - Recomputes centroids for all source people who lost faces.
 */
export async function moveFacesToPerson(
  faceIds: string[],
  targetPersonId: string,
  db?: SQLiteDatabase
): Promise<MoveFacesResult> {
  if (faceIds.length === 0) {
    const database = db ?? (await getDatabase());
    const target = await getPersonById(targetPersonId, database);
    if (!target) throw new Error(`Target person ${targetPersonId} not found`);
    return { movedCount: 0, targetPerson: target, affectedPersonIds: [] };
  }

  const database = db ?? (await getDatabase());
  let targetPerson!: PersonRow;
  const affectedPersonIds = new Set<string>();

  await database.withTransactionAsync(async () => {
    const target = await getPersonById(targetPersonId, database);
    if (!target) {
      throw new Error(`Target person ${targetPersonId} not found`);
    }

    // 1. Find previous person_id for each face
    const placeholders = faceIds.map(() => '?').join(', ');
    const prevRows = await database.getAllAsync<{ id: string; person_id: string | null }>(
      `SELECT id, person_id FROM faces WHERE id IN (${placeholders});`,
      faceIds
    );

    for (const r of prevRows) {
      if (r.person_id && r.person_id !== targetPersonId) {
        affectedPersonIds.add(r.person_id);
      }
    }

    // 2. Move faces and set assignment='manual'
    await database.runAsync(
      `UPDATE faces SET person_id = ?, assignment = 'manual' WHERE id IN (${placeholders});`,
      [targetPersonId, ...faceIds]
    );

    // 3. If target has no cover face, set to first moved face
    if (!target.cover_face_id) {
      await updatePerson(targetPersonId, { cover_face_id: faceIds[0] }, database);
    }

    // 4. Recompute centroid for target person
    await recomputePersonCentroid(targetPersonId, database);

    // 5. Recompute centroids for all affected source people
    for (const srcPid of affectedPersonIds) {
      await recomputePersonCentroid(srcPid, database);
    }

    const refreshed = await getPersonById(targetPersonId, database);
    if (!refreshed) {
      throw new Error(`Failed to reload target person ${targetPersonId}`);
    }
    targetPerson = refreshed;
  });

  return {
    movedCount: faceIds.length,
    targetPerson,
    affectedPersonIds: Array.from(affectedPersonIds),
  };
}

/**
 * Convenience single-face move wrapper.
 */
export async function moveFaceToPerson(
  faceId: string,
  targetPersonId: string,
  db?: SQLiteDatabase
): Promise<MoveFacesResult> {
  return await moveFacesToPerson([faceId], targetPersonId, db);
}

/**
 * Removes one or more faces from their current person and routes them to "Others".
 *
 * Rules (Plan Task 2.7, AppFlow §3.6, TRD §4):
 * - Sets `assignment = 'manual'` (pinned, excluded from target person).
 * - Routes to trip's `Others` person row (`is_others = 1`).
 * - Recomputes centroids for all source people who lost faces.
 */
export async function removeFacesFromPerson(
  faceIds: string[],
  tripId?: string,
  db?: SQLiteDatabase
): Promise<RemoveFacesResult> {
  if (faceIds.length === 0) {
    const database = db ?? (await getDatabase());
    const fallbackTripId = tripId ?? 'unknown';
    const others = await getOrCreateOthersPerson(fallbackTripId, generateUUID(), database);
    return { removedCount: 0, othersPerson: others, affectedPersonIds: [] };
  }

  const database = db ?? (await getDatabase());
  let othersPerson!: PersonRow;
  const affectedPersonIds = new Set<string>();

  await database.withTransactionAsync(async () => {
    const placeholders = faceIds.map(() => '?').join(', ');

    // 1. Lookup trip_id and current person_id from photos
    const faceRows = await database.getAllAsync<{
      id: string;
      person_id: string | null;
      trip_id: string | null;
    }>(
      `SELECT f.id, f.person_id, p.trip_id
       FROM faces f
       JOIN photos p ON f.photo_id = p.id
       WHERE f.id IN (${placeholders});`,
      faceIds
    );

    const resolvedTripId = tripId ?? faceRows[0]?.trip_id;
    if (!resolvedTripId) {
      throw new Error('Unable to resolve trip ID for faces being removed');
    }

    othersPerson = await getOrCreateOthersPerson(resolvedTripId, generateUUID(), database);

    for (const r of faceRows) {
      if (r.person_id && r.person_id !== othersPerson.id) {
        affectedPersonIds.add(r.person_id);
      }
    }

    // 2. Set person_id to Others and assignment='manual'
    await database.runAsync(
      `UPDATE faces SET person_id = ?, assignment = 'manual' WHERE id IN (${placeholders});`,
      [othersPerson.id, ...faceIds]
    );

    // 3. Recompute centroids for all affected source people
    for (const srcPid of affectedPersonIds) {
      await recomputePersonCentroid(srcPid, database);
    }
  });

  return {
    removedCount: faceIds.length,
    othersPerson,
    affectedPersonIds: Array.from(affectedPersonIds),
  };
}

/**
 * Convenience single-face remove wrapper.
 */
export async function removeFaceFromPerson(
  faceId: string,
  tripId?: string,
  db?: SQLiteDatabase
): Promise<RemoveFacesResult> {
  return await removeFacesFromPerson([faceId], tripId, db);
}

/**
 * Merges sourcePerson into targetPerson in an atomic transaction.
 *
 * Rules (Plan Task 2.7, AppFlow §3.6, TRD §4):
 * - Moves all faces to target person and sets `assignment = 'manual'`.
 * - Transfers photo exclusions from source to target.
 * - Preserves name/cover_face_id if target person was unnamed.
 * - Deletes source person.
 * - Recomputes centroid for targetPerson.
 */
export async function mergePeople(
  targetPersonId: string,
  sourcePersonId: string,
  db?: SQLiteDatabase
): Promise<MergePeopleResult> {
  if (targetPersonId === sourcePersonId) {
    throw new Error('Cannot merge a person into themselves');
  }

  const database = db ?? (await getDatabase());
  let targetPerson!: PersonRow;
  let mergedFacesCount = 0;

  await database.withTransactionAsync(async () => {
    const target = await getPersonById(targetPersonId, database);
    const source = await getPersonById(sourcePersonId, database);

    if (!target) {
      throw new Error(`Target person ${targetPersonId} not found`);
    }
    if (!source) {
      throw new Error(`Source person ${sourcePersonId} not found`);
    }

    const sourceFaces = await getFacesByPersonId(sourcePersonId, database);
    mergedFacesCount = sourceFaces.length;

    // 1. Move faces to target person and set assignment='manual' on all merged faces
    await database.runAsync(
      "UPDATE faces SET person_id = ?, assignment = 'manual' WHERE person_id = ?;",
      [targetPersonId, sourcePersonId]
    );
    await database.runAsync(
      "UPDATE faces SET assignment = 'manual' WHERE person_id = ?;",
      [targetPersonId]
    );

    // 2. Transfer photo exclusions
    await database.runAsync(
      `INSERT OR IGNORE INTO person_photos_excluded (person_id, photo_id)
       SELECT ?, photo_id FROM person_photos_excluded WHERE person_id = ?;`,
      [targetPersonId, sourcePersonId]
    );
    await database.runAsync(
      'DELETE FROM person_photos_excluded WHERE person_id = ?;',
      [sourcePersonId]
    );

    // 3. Delete source person first so adopting source.name doesn't violate UNIQUE(trip_id, name)
    await deletePerson(sourcePersonId, database);

    // 4. If target is unnamed and source had a name, adopt source name
    const updates: Partial<PersonRow> = {};
    if (!target.name && source.name) {
      updates.name = source.name;
    }
    if (!target.cover_face_id && source.cover_face_id) {
      updates.cover_face_id = source.cover_face_id;
    }
    if (Object.keys(updates).length > 0) {
      await updatePerson(targetPersonId, updates, database);
    }

    // 5. Recompute centroid for target person
    await recomputePersonCentroid(targetPersonId, database);

    const refreshed = await getPersonById(targetPersonId, database);
    if (!refreshed) {
      throw new Error(`Failed to reload target person ${targetPersonId}`);
    }
    targetPerson = refreshed;
  });

  return {
    targetPerson,
    mergedFacesCount,
  };
}
