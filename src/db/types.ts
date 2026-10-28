/**
 * Database schema type definitions for Trip Photo Sorter.
 * Corresponds to docs/05_Schema.md.
 */

export type ScanStatus =
  | 'not_scanned'
  | 'scanning'
  | 'paused'
  | 'clustering'
  | 'scanned'
  | 'failed';

export type TripScanStatus = ScanStatus;

export type PhotoScanStatus = 'pending' | 'done' | 'failed' | 'skipped';

export type FaceAssignment = 'auto' | 'manual';

export type ExportMode = 'photos' | 'zip';

export type ExportStatus =
  | 'pending'
  | 'zipping'
  | 'ready'
  | 'sharing'
  | 'done'
  | 'cancelled'
  | 'failed';

/**
 * `trips` table row
 */
export interface TripRow {
  id: string;
  name: string;
  start_at: number;
  end_at: number;
  photo_count: number;
  cover_photo_id: string | null;
  is_away: number;
  is_hidden: number;
  is_user_edited: number;
  scan_status: ScanStatus;
  scanned_count: number;
  created_at: number;
  updated_at: number;
}

/**
 * `photos` table row
 */
export interface PhotoRow {
  id: string;
  trip_id: string | null;
  taken_at: number;
  modified_at: number;
  width: number;
  height: number;
  lat: number | null;
  lng: number | null;
  is_local: number;
  scan_status: PhotoScanStatus;
  face_count: number;
  excluded: number;
}

/**
 * `people` table row
 */
export interface PersonRow {
  id: string;
  trip_id: string;
  name: string | null;
  is_others: number;
  cover_face_id: string | null;
  centroid: Uint8Array | null;
  created_at: number;
}

/**
 * `faces` table row
 */
export interface FaceRow {
  id: string;
  photo_id: string;
  person_id: string | null;
  assignment: FaceAssignment;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  quality: number;
  quality_ok: number;
  blur: number | null;
  embedding: Uint8Array;
}

/**
 * `person_photos_excluded` table row
 */
export interface PersonPhotoExcludedRow {
  person_id: string;
  photo_id: string;
}

/**
 * `exports` table row
 */
export interface ExportRow {
  id: string;
  person_id: string | null;
  trip_id: string;
  mode: ExportMode;
  solo_only: number;
  status: ExportStatus;
  photo_count: number;
  size_bytes: number | null;
  zip_path: string | null;
  error: string | null;
  created_at: number;
}

/**
 * `settings` key-value table row
 */
export interface SettingRow {
  key: string;
  value: string;
}

/**
 * `migrations` table row
 */
export interface MigrationRow {
  id: number;
  name: string;
  applied_at: number;
}
