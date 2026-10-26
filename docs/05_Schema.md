# 05_Schema — Local Database (SQLite)

No server, no auth, no Row-Level Security: single-user, on-device. "Access control" = OS sandbox + the repository rules below.

Engine: `expo-sqlite`, WAL mode, `PRAGMA foreign_keys = ON`. Timestamps = Unix epoch **milliseconds** (INTEGER). IDs = TEXT (UUID v4) except `photos.id`, which is the media library asset id.

## 1. Tables

### `trips`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PK | |
| name | TEXT | NOT NULL | |
| start_at | INTEGER | NOT NULL | |
| end_at | INTEGER | NOT NULL | |
| photo_count | INTEGER | NOT NULL DEFAULT 0 | denormalised, updated in transaction |
| cover_photo_id | TEXT | FK → photos.id ON DELETE SET NULL | |
| is_away | INTEGER | NOT NULL DEFAULT 0 | reserved for v2 (GPS); unused in MVP |
| is_hidden | INTEGER | NOT NULL DEFAULT 0 | |
| is_user_edited | INTEGER | NOT NULL DEFAULT 0 | protects from re-detection |
| scan_status | TEXT | NOT NULL DEFAULT 'not_scanned' | `not_scanned, scanning, paused, clustering, scanned, failed` |
| scanned_count | INTEGER | NOT NULL DEFAULT 0 | free-tier counter |
| created_at | INTEGER | NOT NULL | |
| updated_at | INTEGER | NOT NULL | |

### `photos`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PK | media library asset id |
| trip_id | TEXT | FK → trips.id ON DELETE SET NULL | |
| taken_at | INTEGER | NOT NULL | creationTime |
| modified_at | INTEGER | NOT NULL | for incremental sync |
| width | INTEGER | NOT NULL | |
| height | INTEGER | NOT NULL | |
| lat | REAL | | nullable; reserved for v2, not used in MVP |
| lng | REAL | | nullable; reserved for v2, not used in MVP |
| is_local | INTEGER | NOT NULL DEFAULT 1 | 0 = iCloud-only |
| scan_status | TEXT | NOT NULL DEFAULT 'pending' | `pending, done, failed, skipped` |
| face_count | INTEGER | NOT NULL DEFAULT 0 | |
| excluded | INTEGER | NOT NULL DEFAULT 0 | user removed from all exports |

### `people`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PK | |
| trip_id | TEXT | NOT NULL, FK → trips.id ON DELETE CASCADE | people are per-trip |
| name | TEXT | | NULL = unnamed |
| is_others | INTEGER | NOT NULL DEFAULT 0 | one "Others" row per trip |
| cover_face_id | TEXT | FK → faces.id ON DELETE SET NULL | |
| centroid | BLOB | | 128 × float32; set when named/confirmed; recomputed after manual edits |
| created_at | INTEGER | NOT NULL | |
| | | UNIQUE(trip_id, name) | duplicate names blocked (NULLs allowed) |

### `faces`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PK | |
| photo_id | TEXT | NOT NULL, FK → photos.id ON DELETE CASCADE | |
| person_id | TEXT | FK → people.id ON DELETE SET NULL | |
| assignment | TEXT | NOT NULL DEFAULT 'auto' | `auto` or `manual` (= pinned; never overwritten by clustering/re-assignment) |
| bbox_x, bbox_y, bbox_w, bbox_h | REAL | NOT NULL | normalised 0–1 |
| quality | REAL | NOT NULL | detector confidence |
| quality_ok | INTEGER | NOT NULL DEFAULT 1 | 0 = too small/blurry/extreme pose; never forms or moves a centroid |
| blur | REAL | | Laplacian variance of crop |
| embedding | BLOB | NOT NULL | 128 × float32 = 512 bytes |

### `person_photos_excluded`
Per-person exclusion from a ZIP.
| Column | Type | Constraints |
|--------|------|-------------|
| person_id | TEXT | FK → people.id ON DELETE CASCADE |
| photo_id | TEXT | FK → photos.id ON DELETE CASCADE |
| | | PRIMARY KEY (person_id, photo_id) |

### `exports`
| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | TEXT | PK | |
| person_id | TEXT | FK → people.id ON DELETE SET NULL | |
| trip_id | TEXT | FK → trips.id ON DELETE CASCADE | |
| mode | TEXT | NOT NULL DEFAULT 'zip' | `photos` or `zip` |
| solo_only | INTEGER | NOT NULL DEFAULT 0 | 1 = only photos where `face_count = 1` |
| status | TEXT | NOT NULL | `pending, zipping, ready, sharing, done, cancelled, failed` |
| photo_count | INTEGER | NOT NULL | |
| size_bytes | INTEGER | | |
| zip_path | TEXT | | NULL after cleanup |
| error | TEXT | | |
| created_at | INTEGER | NOT NULL | |

### `settings` (key-value)
| Column | Type | Constraints |
|--------|------|-------------|
| key | TEXT | PK |
| value | TEXT | NOT NULL |
Keys: `onboarded`, `last_sync_at`, `is_pro`, `home_lat`, `home_lng`, `schema_version`.

### `migrations`
`id INTEGER PK, name TEXT NOT NULL, applied_at INTEGER NOT NULL`.

## 2. Indexes
```sql
CREATE INDEX idx_photos_taken_at ON photos(taken_at);
CREATE INDEX idx_photos_trip ON photos(trip_id, taken_at);
CREATE INDEX idx_photos_scan ON photos(trip_id, scan_status);
CREATE INDEX idx_faces_photo ON faces(photo_id);
CREATE INDEX idx_faces_person ON faces(person_id);
CREATE INDEX idx_people_trip ON people(trip_id);
CREATE INDEX idx_trips_start ON trips(start_at DESC);
CREATE INDEX idx_exports_trip ON exports(trip_id, status);
```

## 3. Key Queries
- Person's photos (distinct, not excluded):
```sql
SELECT DISTINCT p.* FROM photos p
JOIN faces f ON f.photo_id = p.id
WHERE f.person_id = ? AND p.excluded = 0
  AND p.id NOT IN (SELECT photo_id FROM person_photos_excluded WHERE person_id = ?)
ORDER BY p.taken_at;
```
- Solo-only filter: add `AND p.face_count = 1`.
- Free-tier check: `trips.scanned_count < 50` unless `settings.is_pro = '1'`.

## 4. Data Access Rules (replaces Auth/RLS)
1. Only files in `src/db/repositories/` may execute SQL; UI never touches the DB.
2. Multi-row changes (merge people, move faces, trip merge) run in **one transaction**.
3. Migrations are append-only files `src/db/migrations/NNN_name.ts`; never edit an applied migration.
4. Embeddings are never logged, exported, or included in the ZIP.
5. "Reset all data" drops all tables, recreates via migrations, and deletes the exports cache directory.
6. DB file location: app sandbox; flagged excluded-from-backup (see 04_TRD §6).

## 5. Integrity Notes
- Deleted gallery asset → delete `photos` row → cascades to `faces`; recompute `trips.photo_count` and empty-trip cleanup in same transaction.
- Manual assignments (`assignment='manual'`) survive rescans.
