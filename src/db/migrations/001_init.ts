import type { SQLiteDatabase } from 'expo-sqlite';

export const INIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  photo_count INTEGER NOT NULL DEFAULT 0,
  cover_photo_id TEXT,
  is_away INTEGER NOT NULL DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  is_user_edited INTEGER NOT NULL DEFAULT 0,
  scan_status TEXT NOT NULL DEFAULT 'not_scanned',
  scanned_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (cover_photo_id) REFERENCES photos(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY NOT NULL,
  trip_id TEXT,
  taken_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  lat REAL,
  lng REAL,
  is_local INTEGER NOT NULL DEFAULT 1,
  scan_status TEXT NOT NULL DEFAULT 'pending',
  face_count INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY NOT NULL,
  trip_id TEXT NOT NULL,
  name TEXT,
  is_others INTEGER NOT NULL DEFAULT 0,
  cover_face_id TEXT,
  centroid BLOB,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
  FOREIGN KEY (cover_face_id) REFERENCES faces(id) ON DELETE SET NULL,
  UNIQUE(trip_id, name)
);

CREATE TABLE IF NOT EXISTS faces (
  id TEXT PRIMARY KEY NOT NULL,
  photo_id TEXT NOT NULL,
  person_id TEXT,
  assignment TEXT NOT NULL DEFAULT 'auto',
  bbox_x REAL NOT NULL,
  bbox_y REAL NOT NULL,
  bbox_w REAL NOT NULL,
  bbox_h REAL NOT NULL,
  quality REAL NOT NULL,
  quality_ok INTEGER NOT NULL DEFAULT 1,
  blur REAL,
  embedding BLOB NOT NULL,
  FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS person_photos_excluded (
  person_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  PRIMARY KEY (person_id, photo_id),
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
  FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY NOT NULL,
  person_id TEXT,
  trip_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'zip',
  solo_only INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  photo_count INTEGER NOT NULL,
  size_bytes INTEGER,
  zip_path TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at);
CREATE INDEX IF NOT EXISTS idx_photos_trip ON photos(trip_id, taken_at);
CREATE INDEX IF NOT EXISTS idx_photos_scan ON photos(trip_id, scan_status);
CREATE INDEX IF NOT EXISTS idx_faces_photo ON faces(photo_id);
CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id);
CREATE INDEX IF NOT EXISTS idx_people_trip ON people(trip_id);
CREATE INDEX IF NOT EXISTS idx_trips_start ON trips(start_at DESC);
CREATE INDEX IF NOT EXISTS idx_exports_trip ON exports(trip_id, status);

INSERT OR IGNORE INTO settings (key, value) VALUES ('schema_version', '1');
`;

export const migration001 = {
  id: 1,
  name: '001_init',
  up: async (db: SQLiteDatabase): Promise<void> => {
    await db.execAsync(INIT_SCHEMA_SQL);
  },
  upSync: (db: SQLiteDatabase): void => {
    db.execSync(INIT_SCHEMA_SQL);
  },
};
