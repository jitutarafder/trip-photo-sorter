import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../client';
import type { TripRow } from '../types';

async function resolveDb(db?: SQLiteDatabase): Promise<SQLiteDatabase> {
  return db ?? (await getDatabase());
}

export interface CreateTripInput {
  id: string;
  name: string;
  start_at: number;
  end_at: number;
  photo_count?: number;
  cover_photo_id?: string | null;
  is_away?: number;
  is_hidden?: number;
  is_user_edited?: number;
  scan_status?: TripRow['scan_status'];
  scanned_count?: number;
  created_at?: number;
  updated_at?: number;
}

/**
 * Creates a new trip row in the database.
 */
export async function createTrip(
  input: CreateTripInput,
  db?: SQLiteDatabase
): Promise<TripRow> {
  const database = await resolveDb(db);
  const now = Date.now();
  const trip: TripRow = {
    id: input.id,
    name: input.name,
    start_at: input.start_at,
    end_at: input.end_at,
    photo_count: input.photo_count ?? 0,
    cover_photo_id: input.cover_photo_id ?? null,
    is_away: input.is_away ?? 0,
    is_hidden: input.is_hidden ?? 0,
    is_user_edited: input.is_user_edited ?? 0,
    scan_status: input.scan_status ?? 'not_scanned',
    scanned_count: input.scanned_count ?? 0,
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
  };

  await database.runAsync(
    `INSERT INTO trips (
      id, name, start_at, end_at, photo_count, cover_photo_id,
      is_away, is_hidden, is_user_edited, scan_status, scanned_count,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      trip.id,
      trip.name,
      trip.start_at,
      trip.end_at,
      trip.photo_count,
      trip.cover_photo_id,
      trip.is_away,
      trip.is_hidden,
      trip.is_user_edited,
      trip.scan_status,
      trip.scanned_count,
      trip.created_at,
      trip.updated_at,
    ]
  );

  return trip;
}

/**
 * Bulk inserts multiple trip rows.
 */
export async function createTrips(
  trips: CreateTripInput[],
  db?: SQLiteDatabase
): Promise<void> {
  const database = await resolveDb(db);
  await database.withTransactionAsync(async () => {
    for (const trip of trips) {
      await createTrip(trip, database);
    }
  });
}

/**
 * Retrieves a trip by ID.
 */
export async function getTripById(
  id: string,
  db?: SQLiteDatabase
): Promise<TripRow | null> {
  const database = await resolveDb(db);
  return await database.getFirstAsync<TripRow>(
    'SELECT * FROM trips WHERE id = ?;',
    [id]
  );
}

/**
 * Retrieves all trips ordered by start_at DESC.
 */
export async function getAllTrips(
  options: { includeHidden?: boolean } = {},
  db?: SQLiteDatabase
): Promise<TripRow[]> {
  const database = await resolveDb(db);
  if (options.includeHidden) {
    return await database.getAllAsync<TripRow>(
      'SELECT * FROM trips ORDER BY start_at DESC;'
    );
  }
  return await database.getAllAsync<TripRow>(
    'SELECT * FROM trips WHERE is_hidden = 0 ORDER BY start_at DESC;'
  );
}

/**
 * Updates an existing trip with partial fields.
 */
export async function updateTrip(
  id: string,
  updates: Partial<Omit<TripRow, 'id' | 'created_at'>>,
  db?: SQLiteDatabase
): Promise<TripRow | null> {
  const database = await resolveDb(db);
  const existing = await getTripById(id, database);
  if (!existing) {
    return null;
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  const mergedUpdates = {
    ...updates,
    updated_at: updates.updated_at ?? Date.now(),
  };

  for (const [key, val] of Object.entries(mergedUpdates)) {
    fields.push(`${key} = ?`);
    values.push(val);
  }

  if (fields.length === 0) {
    return existing;
  }

  values.push(id);
  await database.runAsync(
    `UPDATE trips SET ${fields.join(', ')} WHERE id = ?;`,
    values as (string | number | null)[]
  );

  return await getTripById(id, database);
}

/**
 * Deletes a trip by ID. Foreign keys handle cascading or nullifying.
 */
export async function deleteTrip(
  id: string,
  db?: SQLiteDatabase
): Promise<boolean> {
  const database = await resolveDb(db);
  const result = await database.runAsync('DELETE FROM trips WHERE id = ?;', [id]);
  return result.changes > 0;
}

/**
 * Recounts photos associated with the trip and updates `photo_count`.
 */
export async function updateTripPhotoCount(
  id: string,
  db?: SQLiteDatabase
): Promise<number> {
  const database = await resolveDb(db);
  const row = await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM photos WHERE trip_id = ?;',
    [id]
  );
  const count = row?.count ?? 0;
  await database.runAsync(
    'UPDATE trips SET photo_count = ?, updated_at = ? WHERE id = ?;',
    [count, Date.now(), id]
  );
  return count;
}

/**
 * Increments the free-tier scanned counter for a trip.
 */
export async function incrementScannedCount(
  id: string,
  count: number = 1,
  db?: SQLiteDatabase
): Promise<void> {
  const database = await resolveDb(db);
  await database.runAsync(
    'UPDATE trips SET scanned_count = scanned_count + ?, updated_at = ? WHERE id = ?;',
    [count, Date.now(), id]
  );
}

/**
 * Merges two trips into targetTripId in a single transaction.
 * Updates photo assignments, merges people and exports, recalculates dates/counts,
 * and deletes the source trip.
 */
export async function mergeTrips(
  targetTripId: string,
  sourceTripId: string,
  db?: SQLiteDatabase
): Promise<TripRow> {
  const database = await resolveDb(db);

  await database.withTransactionAsync(async () => {
    const target = await getTripById(targetTripId, database);
    const source = await getTripById(sourceTripId, database);

    if (!target) {
      throw new Error(`Target trip ${targetTripId} not found`);
    }
    if (!source) {
      throw new Error(`Source trip ${sourceTripId} not found`);
    }

    // 1. Move photos from source to target
    await database.runAsync(
      'UPDATE photos SET trip_id = ? WHERE trip_id = ?;',
      [targetTripId, sourceTripId]
    );

    // 2. Re-scope people from source to target
    // Find target and source "Others"
    const targetOthers = await database.getFirstAsync<{ id: string }>(
      'SELECT id FROM people WHERE trip_id = ? AND is_others = 1;',
      [targetTripId]
    );
    const sourceOthers = await database.getFirstAsync<{ id: string }>(
      'SELECT id FROM people WHERE trip_id = ? AND is_others = 1;',
      [sourceTripId]
    );

    if (sourceOthers && targetOthers) {
      // Re-assign faces from source Others to target Others
      await database.runAsync(
        'UPDATE faces SET person_id = ? WHERE person_id = ?;',
        [targetOthers.id, sourceOthers.id]
      );
      await database.runAsync('DELETE FROM people WHERE id = ?;', [sourceOthers.id]);
    }

    // Re-assign remaining people from source trip to target trip if no name collision
    const sourcePeople = await database.getAllAsync<{ id: string; name: string | null }>(
      'SELECT id, name FROM people WHERE trip_id = ?;',
      [sourceTripId]
    );

    for (const sp of sourcePeople) {
      if (sp.name) {
        const existingWithName = await database.getFirstAsync<{ id: string }>(
          'SELECT id FROM people WHERE trip_id = ? AND name = ?;',
          [targetTripId, sp.name]
        );
        if (existingWithName) {
          // Merge faces into existing target person
          await database.runAsync(
            "UPDATE faces SET person_id = ?, assignment = 'manual' WHERE person_id = ?;",
            [existingWithName.id, sp.id]
          );
          await database.runAsync('DELETE FROM people WHERE id = ?;', [sp.id]);
          continue;
        }
      }
      // Re-scope person to target trip
      await database.runAsync(
        'UPDATE people SET trip_id = ? WHERE id = ?;',
        [targetTripId, sp.id]
      );
    }

    // 3. Move exports
    await database.runAsync(
      'UPDATE exports SET trip_id = ? WHERE trip_id = ?;',
      [targetTripId, sourceTripId]
    );

    // 4. Update date range and metadata
    const startAt = Math.min(target.start_at, source.start_at);
    const endAt = Math.max(target.end_at, source.end_at);
    const scannedCount = target.scanned_count + source.scanned_count;
    const now = Date.now();

    await database.runAsync(
      `UPDATE trips SET
        start_at = ?, end_at = ?, scanned_count = ?,
        is_user_edited = 1, updated_at = ?
       WHERE id = ?;`,
      [startAt, endAt, scannedCount, now, targetTripId]
    );

    // 5. Update photo count
    const countRow = await database.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM photos WHERE trip_id = ?;',
      [targetTripId]
    );
    await database.runAsync(
      'UPDATE trips SET photo_count = ? WHERE id = ?;',
      [countRow?.count ?? 0, targetTripId]
    );

    // 6. Delete source trip
    await database.runAsync('DELETE FROM trips WHERE id = ?;', [sourceTripId]);
  });

  const updated = await getTripById(targetTripId, database);
  if (!updated) {
    throw new Error(`Failed to retrieve merged trip ${targetTripId}`);
  }
  return updated;
}

/**
 * Retrieves all user-edited trips (is_user_edited = 1) that are protected from re-detection.
 */
export async function getUserEditedTrips(
  db?: SQLiteDatabase
): Promise<TripRow[]> {
  const database = await resolveDb(db);
  return await database.getAllAsync<TripRow>(
    'SELECT * FROM trips WHERE is_user_edited = 1 ORDER BY start_at DESC;'
  );
}

/**
 * Retrieves all automatically detected trips (is_user_edited = 0).
 */
export async function getAutoDetectedTrips(
  db?: SQLiteDatabase
): Promise<TripRow[]> {
  const database = await resolveDb(db);
  return await database.getAllAsync<TripRow>(
    'SELECT * FROM trips WHERE is_user_edited = 0 ORDER BY start_at DESC;'
  );
}
