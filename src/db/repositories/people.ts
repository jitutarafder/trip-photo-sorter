import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../client';
import type { PersonRow, PhotoRow } from '../types';

async function resolveDb(db?: SQLiteDatabase): Promise<SQLiteDatabase> {
  return db ?? (await getDatabase());
}

export interface CreatePersonInput {
  id: string;
  trip_id: string;
  name?: string | null;
  is_others?: number;
  cover_face_id?: string | null;
  centroid?: Uint8Array | null;
  created_at?: number;
}

/**
 * Creates a new person in a trip.
 */
export async function createPerson(
  input: CreatePersonInput,
  db?: SQLiteDatabase
): Promise<PersonRow> {
  const database = await resolveDb(db);
  const now = Date.now();
  const person: PersonRow = {
    id: input.id,
    trip_id: input.trip_id,
    name: input.name ?? null,
    is_others: input.is_others ?? 0,
    cover_face_id: input.cover_face_id ?? null,
    centroid: input.centroid ?? null,
    created_at: input.created_at ?? now,
  };

  await database.runAsync(
    `INSERT INTO people (
      id, trip_id, name, is_others, cover_face_id, centroid, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
    [
      person.id,
      person.trip_id,
      person.name,
      person.is_others,
      person.cover_face_id,
      person.centroid,
      person.created_at,
    ]
  );

  return person;
}

/**
 * Retrieves a person by ID.
 */
export async function getPersonById(
  id: string,
  db?: SQLiteDatabase
): Promise<PersonRow | null> {
  const database = await resolveDb(db);
  return await database.getFirstAsync<PersonRow>(
    'SELECT * FROM people WHERE id = ?;',
    [id]
  );
}

/**
 * Retrieves all people for a trip. "Others" can be placed last in UI.
 */
export async function getPeopleByTripId(
  tripId: string,
  db?: SQLiteDatabase
): Promise<PersonRow[]> {
  const database = await resolveDb(db);
  return await database.getAllAsync<PersonRow>(
    'SELECT * FROM people WHERE trip_id = ? ORDER BY is_others ASC, created_at ASC;',
    [tripId]
  );
}

/**
 * Finds or creates the single "Others" row for a trip.
 */
export async function getOrCreateOthersPerson(
  tripId: string,
  fallbackId: string,
  db?: SQLiteDatabase
): Promise<PersonRow> {
  const database = await resolveDb(db);
  const existing = await database.getFirstAsync<PersonRow>(
    'SELECT * FROM people WHERE trip_id = ? AND is_others = 1;',
    [tripId]
  );
  if (existing) {
    return existing;
  }

  return await createPerson(
    {
      id: fallbackId,
      trip_id: tripId,
      name: 'Others',
      is_others: 1,
    },
    database
  );
}

/**
 * Updates a person's name, cover face, or centroid.
 */
export async function updatePerson(
  id: string,
  updates: Partial<Omit<PersonRow, 'id' | 'trip_id' | 'created_at'>>,
  db?: SQLiteDatabase
): Promise<PersonRow | null> {
  const database = await resolveDb(db);
  const existing = await getPersonById(id, database);
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
    `UPDATE people SET ${fields.join(', ')} WHERE id = ?;`,
    values as (string | number | Uint8Array | null)[]
  );

  return await getPersonById(id, database);
}

/**
 * Deletes a person by ID.
 */
export async function deletePerson(
  id: string,
  db?: SQLiteDatabase
): Promise<boolean> {
  const database = await resolveDb(db);
  const result = await database.runAsync('DELETE FROM people WHERE id = ?;', [id]);
  return result.changes > 0;
}

/**
 * Retrieves all distinct, non-excluded photos containing a person's face.
 * Implements Schema §3 Key Query.
 */
export async function getPersonPhotos(
  personId: string,
  options: { soloOnly?: boolean } = {},
  db?: SQLiteDatabase
): Promise<PhotoRow[]> {
  const database = await resolveDb(db);

  if (options.soloOnly) {
    return await database.getAllAsync<PhotoRow>(
      `SELECT DISTINCT p.* FROM photos p
       JOIN faces f ON f.photo_id = p.id
       WHERE f.person_id = ? AND p.excluded = 0 AND p.face_count = 1
         AND p.id NOT IN (SELECT photo_id FROM person_photos_excluded WHERE person_id = ?)
       ORDER BY p.taken_at ASC;`,
      [personId, personId]
    );
  }

  return await database.getAllAsync<PhotoRow>(
    `SELECT DISTINCT p.* FROM photos p
     JOIN faces f ON f.photo_id = p.id
     WHERE f.person_id = ? AND p.excluded = 0
       AND p.id NOT IN (SELECT photo_id FROM person_photos_excluded WHERE person_id = ?)
     ORDER BY p.taken_at ASC;`,
    [personId, personId]
  );
}

/**
 * Excludes a photo from a specific person's export.
 */
export async function excludePhotoFromPerson(
  personId: string,
  photoId: string,
  db?: SQLiteDatabase
): Promise<void> {
  const database = await resolveDb(db);
  await database.runAsync(
    `INSERT OR IGNORE INTO person_photos_excluded (person_id, photo_id)
     VALUES (?, ?);`,
    [personId, photoId]
  );
}

/**
 * Re-includes a photo for a person's export (removes per-person exclusion).
 */
export async function includePhotoForPerson(
  personId: string,
  photoId: string,
  db?: SQLiteDatabase
): Promise<void> {
  const database = await resolveDb(db);
  await database.runAsync(
    'DELETE FROM person_photos_excluded WHERE person_id = ? AND photo_id = ?;',
    [personId, photoId]
  );
}

/**
 * Gets all photo IDs excluded for a specific person.
 */
export async function getExcludedPhotoIdsForPerson(
  personId: string,
  db?: SQLiteDatabase
): Promise<string[]> {
  const database = await resolveDb(db);
  const rows = await database.getAllAsync<{ photo_id: string }>(
    'SELECT photo_id FROM person_photos_excluded WHERE person_id = ?;',
    [personId]
  );
  return rows.map((r) => r.photo_id);
}

/**
 * Merges sourcePerson into targetPerson in a single transaction.
 * Reassigns faces with assignment='manual', moves per-person photo exclusions,
 * and deletes the source person.
 */
export async function mergePeople(
  targetPersonId: string,
  sourcePersonId: string,
  db?: SQLiteDatabase
): Promise<void> {
  const database = await resolveDb(db);

  await database.withTransactionAsync(async () => {
    // 1. Move faces to target person (pinned manual assignment)
    await database.runAsync(
      "UPDATE faces SET person_id = ?, assignment = 'manual' WHERE person_id = ?;",
      [targetPersonId, sourcePersonId]
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

    // 3. Delete source person
    await database.runAsync('DELETE FROM people WHERE id = ?;', [sourcePersonId]);
  });
}

export interface PersonWithDetails extends PersonRow {
  photo_count: number;
  cover_photo_id: string | null;
  cover_bbox_x: number | null;
  cover_bbox_y: number | null;
  cover_bbox_w: number | null;
  cover_bbox_h: number | null;
}

/**
 * Retrieves all people for a trip with photo counts and cover face coordinates.
 * Sorted by is_others ASC, photo_count DESC, created_at ASC (02_AppFlow §3.5).
 */
export async function getPeopleWithDetails(
  tripId: string,
  db?: SQLiteDatabase
): Promise<PersonWithDetails[]> {
  const database = await resolveDb(db);
  return await database.getAllAsync<PersonWithDetails>(
    `SELECT 
      p.id,
      p.trip_id,
      p.name,
      p.is_others,
      p.cover_face_id,
      p.centroid,
      p.created_at,
      COUNT(DISTINCT ph.id) AS photo_count,
      cf.photo_id AS cover_photo_id,
      cf.bbox_x AS cover_bbox_x,
      cf.bbox_y AS cover_bbox_y,
      cf.bbox_w AS cover_bbox_w,
      cf.bbox_h AS cover_bbox_h
    FROM people p
    LEFT JOIN faces f ON f.person_id = p.id
    LEFT JOIN photos ph ON ph.id = f.photo_id AND ph.excluded = 0
      AND ph.id NOT IN (SELECT photo_id FROM person_photos_excluded WHERE person_id = p.id)
    LEFT JOIN faces cf ON cf.id = COALESCE(
      p.cover_face_id,
      (SELECT id FROM faces WHERE person_id = p.id ORDER BY quality_ok DESC, blur DESC LIMIT 1)
    )
    WHERE p.trip_id = ?
    GROUP BY p.id
    ORDER BY p.is_others ASC, photo_count DESC, p.created_at ASC;`,
    [tripId]
  );
}
