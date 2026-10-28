import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../client';
import type { ExportRow, ExportStatus } from '../types';

async function resolveDb(db?: SQLiteDatabase): Promise<SQLiteDatabase> {
  return db ?? (await getDatabase());
}

export interface CreateExportInput {
  id: string;
  person_id?: string | null;
  trip_id: string;
  mode?: ExportRow['mode'];
  solo_only?: number;
  status: ExportStatus;
  photo_count: number;
  size_bytes?: number | null;
  zip_path?: string | null;
  error?: string | null;
  created_at?: number;
}

/**
 * Creates a new export record.
 */
export async function createExport(
  input: CreateExportInput,
  db?: SQLiteDatabase
): Promise<ExportRow> {
  const database = await resolveDb(db);
  const now = Date.now();
  const exportRow: ExportRow = {
    id: input.id,
    person_id: input.person_id ?? null,
    trip_id: input.trip_id,
    mode: input.mode ?? 'zip',
    solo_only: input.solo_only ?? 0,
    status: input.status,
    photo_count: input.photo_count,
    size_bytes: input.size_bytes ?? null,
    zip_path: input.zip_path ?? null,
    error: input.error ?? null,
    created_at: input.created_at ?? now,
  };

  await database.runAsync(
    `INSERT INTO exports (
      id, person_id, trip_id, mode, solo_only, status,
      photo_count, size_bytes, zip_path, error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      exportRow.id,
      exportRow.person_id,
      exportRow.trip_id,
      exportRow.mode,
      exportRow.solo_only,
      exportRow.status,
      exportRow.photo_count,
      exportRow.size_bytes,
      exportRow.zip_path,
      exportRow.error,
      exportRow.created_at,
    ]
  );

  return exportRow;
}

/**
 * Retrieves an export by ID.
 */
export async function getExportById(
  id: string,
  db?: SQLiteDatabase
): Promise<ExportRow | null> {
  const database = await resolveDb(db);
  return await database.getFirstAsync<ExportRow>(
    'SELECT * FROM exports WHERE id = ?;',
    [id]
  );
}

/**
 * Retrieves all exports for a trip ordered by created_at DESC.
 */
export async function getExportsByTripId(
  tripId: string,
  db?: SQLiteDatabase
): Promise<ExportRow[]> {
  const database = await resolveDb(db);
  return await database.getAllAsync<ExportRow>(
    'SELECT * FROM exports WHERE trip_id = ? ORDER BY created_at DESC;',
    [tripId]
  );
}

/**
 * Updates an export row (e.g. status, size_bytes, zip_path, error).
 */
export async function updateExport(
  id: string,
  updates: Partial<Omit<ExportRow, 'id' | 'trip_id' | 'created_at'>>,
  db?: SQLiteDatabase
): Promise<ExportRow | null> {
  const database = await resolveDb(db);
  const existing = await getExportById(id, database);
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
    `UPDATE exports SET ${fields.join(', ')} WHERE id = ?;`,
    values as (string | number | null)[]
  );

  return await getExportById(id, database);
}

/**
 * Deletes an export record.
 */
export async function deleteExport(
  id: string,
  db?: SQLiteDatabase
): Promise<boolean> {
  const database = await resolveDb(db);
  const result = await database.runAsync('DELETE FROM exports WHERE id = ?;', [id]);
  return result.changes > 0;
}

/**
 * Clears the zip_path to NULL after the temporary ZIP file is deleted.
 * Per Schema §1 ("NULL after cleanup").
 */
export async function cleanupExportPath(
  id: string,
  db?: SQLiteDatabase
): Promise<void> {
  const database = await resolveDb(db);
  await database.runAsync(
    'UPDATE exports SET zip_path = NULL WHERE id = ?;',
    [id]
  );
}

/**
 * Retrieves all exports that have an active zip_path or an in-flight status.
 */
export async function getIncompleteOrActiveExports(
  db?: SQLiteDatabase
): Promise<ExportRow[]> {
  const database = await resolveDb(db);
  return await database.getAllAsync<ExportRow>(
    `SELECT * FROM exports
     WHERE zip_path IS NOT NULL
        OR status IN ('pending', 'zipping', 'ready', 'sharing');`
  );
}

/**
 * Marks in-flight exports as cancelled and clears their zip_path.
 * Per AppFlow §2.2 & 06_Plan 1.7.
 */
export async function markInterruptedExportsAsCancelled(
  db?: SQLiteDatabase
): Promise<number> {
  const database = await resolveDb(db);
  const result = await database.runAsync(
    `UPDATE exports
     SET status = 'cancelled',
         error = COALESCE(error, 'Interrupted by app termination'),
         zip_path = NULL
     WHERE status IN ('pending', 'zipping', 'ready', 'sharing')
        OR zip_path IS NOT NULL;`
  );
  return result.changes;
}
