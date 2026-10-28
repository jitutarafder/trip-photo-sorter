import {
  runMigrations,
  runMigrationsSync,
  getAppliedMigrations,
  getAppliedMigrationsSync,
  resetDatabase,
  resetDatabaseSync,
  migrations,
  migration001,
  INIT_SCHEMA_SQL,
  CREATE_MIGRATIONS_TABLE_SQL,
  DROP_ALL_TABLES_SQL,
  Migration,
} from '../src/db/migrations';
import { openDbSync } from '../src/db/client';

describe('Database Migrations (Task 1.2)', () => {
  describe('001_init SQL schema completeness (docs/05_Schema.md)', () => {
    it('defines all required tables with expected constraints', () => {
      // trips table
      expect(INIT_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS trips');
      expect(INIT_SCHEMA_SQL).toContain('id TEXT PRIMARY KEY NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('name TEXT NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('start_at INTEGER NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('end_at INTEGER NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('photo_count INTEGER NOT NULL DEFAULT 0');
      expect(INIT_SCHEMA_SQL).toContain('cover_photo_id TEXT');
      expect(INIT_SCHEMA_SQL).toContain('is_away INTEGER NOT NULL DEFAULT 0');
      expect(INIT_SCHEMA_SQL).toContain('is_hidden INTEGER NOT NULL DEFAULT 0');
      expect(INIT_SCHEMA_SQL).toContain('is_user_edited INTEGER NOT NULL DEFAULT 0');
      expect(INIT_SCHEMA_SQL).toContain("scan_status TEXT NOT NULL DEFAULT 'not_scanned'");
      expect(INIT_SCHEMA_SQL).toContain('scanned_count INTEGER NOT NULL DEFAULT 0');
      expect(INIT_SCHEMA_SQL).toContain('created_at INTEGER NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('updated_at INTEGER NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain(
        'FOREIGN KEY (cover_photo_id) REFERENCES photos(id) ON DELETE SET NULL'
      );

      // photos table
      expect(INIT_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS photos');
      expect(INIT_SCHEMA_SQL).toContain('trip_id TEXT');
      expect(INIT_SCHEMA_SQL).toContain('taken_at INTEGER NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('modified_at INTEGER NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('width INTEGER NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('height INTEGER NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('lat REAL');
      expect(INIT_SCHEMA_SQL).toContain('lng REAL');
      expect(INIT_SCHEMA_SQL).toContain('is_local INTEGER NOT NULL DEFAULT 1');
      expect(INIT_SCHEMA_SQL).toContain("scan_status TEXT NOT NULL DEFAULT 'pending'");
      expect(INIT_SCHEMA_SQL).toContain('face_count INTEGER NOT NULL DEFAULT 0');
      expect(INIT_SCHEMA_SQL).toContain('excluded INTEGER NOT NULL DEFAULT 0');
      expect(INIT_SCHEMA_SQL).toContain(
        'FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE SET NULL'
      );

      // people table
      expect(INIT_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS people');
      expect(INIT_SCHEMA_SQL).toContain('trip_id TEXT NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('name TEXT');
      expect(INIT_SCHEMA_SQL).toContain('is_others INTEGER NOT NULL DEFAULT 0');
      expect(INIT_SCHEMA_SQL).toContain('cover_face_id TEXT');
      expect(INIT_SCHEMA_SQL).toContain('centroid BLOB');
      expect(INIT_SCHEMA_SQL).toContain(
        'FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE'
      );
      expect(INIT_SCHEMA_SQL).toContain(
        'FOREIGN KEY (cover_face_id) REFERENCES faces(id) ON DELETE SET NULL'
      );
      expect(INIT_SCHEMA_SQL).toContain('UNIQUE(trip_id, name)');

      // faces table
      expect(INIT_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS faces');
      expect(INIT_SCHEMA_SQL).toContain('photo_id TEXT NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('person_id TEXT');
      expect(INIT_SCHEMA_SQL).toContain("assignment TEXT NOT NULL DEFAULT 'auto'");
      expect(INIT_SCHEMA_SQL).toContain('bbox_x REAL NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('bbox_y REAL NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('bbox_w REAL NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('bbox_h REAL NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('quality REAL NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('quality_ok INTEGER NOT NULL DEFAULT 1');
      expect(INIT_SCHEMA_SQL).toContain('blur REAL');
      expect(INIT_SCHEMA_SQL).toContain('embedding BLOB NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain(
        'FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE'
      );
      expect(INIT_SCHEMA_SQL).toContain(
        'FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL'
      );

      // person_photos_excluded table
      expect(INIT_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS person_photos_excluded');
      expect(INIT_SCHEMA_SQL).toContain('PRIMARY KEY (person_id, photo_id)');
      expect(INIT_SCHEMA_SQL).toContain(
        'FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE'
      );
      expect(INIT_SCHEMA_SQL).toContain(
        'FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE'
      );

      // exports table
      expect(INIT_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS exports');
      expect(INIT_SCHEMA_SQL).toContain("mode TEXT NOT NULL DEFAULT 'zip'");
      expect(INIT_SCHEMA_SQL).toContain('solo_only INTEGER NOT NULL DEFAULT 0');
      expect(INIT_SCHEMA_SQL).toContain('status TEXT NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('photo_count INTEGER NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('size_bytes INTEGER');
      expect(INIT_SCHEMA_SQL).toContain('zip_path TEXT');
      expect(INIT_SCHEMA_SQL).toContain('error TEXT');
      expect(INIT_SCHEMA_SQL).toContain(
        'FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL'
      );
      expect(INIT_SCHEMA_SQL).toContain(
        'FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE'
      );

      // settings table
      expect(INIT_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS settings');
      expect(INIT_SCHEMA_SQL).toContain('key TEXT PRIMARY KEY NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain('value TEXT NOT NULL');
      expect(INIT_SCHEMA_SQL).toContain("INSERT OR IGNORE INTO settings (key, value) VALUES ('schema_version', '1');");
    });

    it('defines all 8 performance indexes specified in 05_Schema.md', () => {
      expect(INIT_SCHEMA_SQL).toContain(
        'CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at);'
      );
      expect(INIT_SCHEMA_SQL).toContain(
        'CREATE INDEX IF NOT EXISTS idx_photos_trip ON photos(trip_id, taken_at);'
      );
      expect(INIT_SCHEMA_SQL).toContain(
        'CREATE INDEX IF NOT EXISTS idx_photos_scan ON photos(trip_id, scan_status);'
      );
      expect(INIT_SCHEMA_SQL).toContain(
        'CREATE INDEX IF NOT EXISTS idx_faces_photo ON faces(photo_id);'
      );
      expect(INIT_SCHEMA_SQL).toContain(
        'CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id);'
      );
      expect(INIT_SCHEMA_SQL).toContain(
        'CREATE INDEX IF NOT EXISTS idx_people_trip ON people(trip_id);'
      );
      expect(INIT_SCHEMA_SQL).toContain(
        'CREATE INDEX IF NOT EXISTS idx_trips_start ON trips(start_at DESC);'
      );
      expect(INIT_SCHEMA_SQL).toContain(
        'CREATE INDEX IF NOT EXISTS idx_exports_trip ON exports(trip_id, status);'
      );
    });

    it('exports migration001 with id 1 and name 001_init', () => {
      expect(migration001.id).toBe(1);
      expect(migration001.name).toBe('001_init');
      expect(typeof migration001.up).toBe('function');
      expect(typeof migration001.upSync).toBe('function');
    });

    it('includes migration001 in migrations registry', () => {
      expect(migrations).toContain(migration001);
      expect(migrations[0].id).toBe(1);
    });
  });

  describe('runMigrations (async runner)', () => {
    it('creates migrations table and applies pending migrations inside a transaction', async () => {
      const db = openDbSync(':memory:');
      (db.getAllAsync as jest.Mock).mockResolvedValueOnce([]); // No migrations yet

      const result = await runMigrations(db, [migration001]);

      expect(db.execAsync).toHaveBeenCalledWith(CREATE_MIGRATIONS_TABLE_SQL);
      expect(db.execAsync).toHaveBeenCalledWith(INIT_SCHEMA_SQL);
      expect(db.withTransactionAsync).toHaveBeenCalled();
      expect(db.runAsync).toHaveBeenCalledWith(
        'INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?);',
        expect.arrayContaining([1, '001_init'])
      );
      expect(result.appliedCount).toBe(1);
      expect(result.appliedIds).toEqual([1]);
      expect(result.allApplied.length).toBe(1);
      expect(result.allApplied[0].name).toBe('001_init');
    });

    it('skips already applied migrations (idempotent)', async () => {
      const db = openDbSync(':memory:');
      (db.getAllAsync as jest.Mock).mockResolvedValueOnce([
        { id: 1, name: '001_init', applied_at: 1000 },
      ]);

      const result = await runMigrations(db, [migration001]);

      expect(db.execAsync).toHaveBeenCalledWith(CREATE_MIGRATIONS_TABLE_SQL);
      // Migration up SQL should NOT be executed again
      expect(db.execAsync).not.toHaveBeenCalledWith(INIT_SCHEMA_SQL);
      expect(result.appliedCount).toBe(0);
      expect(result.appliedIds).toEqual([]);
      expect(result.allApplied.length).toBe(1);
    });

    it('runs only pending migrations in order when earlier ones are applied', async () => {
      const db = openDbSync(':memory:');
      (db.getAllAsync as jest.Mock).mockResolvedValueOnce([
        { id: 1, name: '001_init', applied_at: 1000 },
      ]);

      const upMock = jest.fn().mockResolvedValue(undefined);
      const testMigration2: Migration = {
        id: 2,
        name: '002_test',
        up: upMock,
      };

      const result = await runMigrations(db, [migration001, testMigration2]);

      expect(upMock).toHaveBeenCalled();
      expect(result.appliedCount).toBe(1);
      expect(result.appliedIds).toEqual([2]);
      expect(result.allApplied.map((m) => m.id)).toEqual([1, 2]);
    });

    it('propagates errors when a migration fails', async () => {
      const db = openDbSync(':memory:');
      (db.getAllAsync as jest.Mock).mockResolvedValueOnce([]);

      const failingMigration: Migration = {
        id: 99,
        name: '099_fail',
        up: jest.fn().mockRejectedValue(new Error('Syntax error in migration')),
      };

      await expect(runMigrations(db, [failingMigration])).rejects.toThrow(
        'Syntax error in migration'
      );
    });
  });

  describe('runMigrationsSync (sync runner)', () => {
    it('applies pending migrations synchronously inside a transaction', () => {
      const db = openDbSync(':memory:');
      (db.getAllSync as jest.Mock).mockReturnValueOnce([]);

      const result = runMigrationsSync(db, [migration001]);

      expect(db.execSync).toHaveBeenCalledWith(CREATE_MIGRATIONS_TABLE_SQL);
      expect(db.execSync).toHaveBeenCalledWith(INIT_SCHEMA_SQL);
      expect(db.withTransactionSync).toHaveBeenCalled();
      expect(db.runSync).toHaveBeenCalledWith(
        'INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?);',
        expect.arrayContaining([1, '001_init'])
      );
      expect(result.appliedCount).toBe(1);
      expect(result.appliedIds).toEqual([1]);
    });

    it('skips already applied migrations synchronously', () => {
      const db = openDbSync(':memory:');
      (db.getAllSync as jest.Mock).mockReturnValueOnce([
        { id: 1, name: '001_init', applied_at: 1000 },
      ]);

      const result = runMigrationsSync(db, [migration001]);

      expect(db.execSync).toHaveBeenCalledWith(CREATE_MIGRATIONS_TABLE_SQL);
      expect(db.execSync).not.toHaveBeenCalledWith(INIT_SCHEMA_SQL);
      expect(result.appliedCount).toBe(0);
      expect(result.appliedIds).toEqual([]);
    });

    it('throws when migration does not implement upSync', () => {
      const db = openDbSync(':memory:');
      (db.getAllSync as jest.Mock).mockReturnValueOnce([]);

      const asyncOnlyMigration: Migration = {
        id: 2,
        name: '002_async_only',
        up: jest.fn(),
      };

      expect(() => runMigrationsSync(db, [asyncOnlyMigration])).toThrow(
        /does not provide synchronous runner/
      );
    });
  });

  describe('getAppliedMigrations and getAppliedMigrationsSync', () => {
    it('queries applied migrations asynchronously', async () => {
      const db = openDbSync(':memory:');
      const mockRows = [{ id: 1, name: '001_init', applied_at: 12345 }];
      (db.getAllAsync as jest.Mock).mockResolvedValueOnce(mockRows);

      const rows = await getAppliedMigrations(db);
      expect(rows).toEqual(mockRows);
      expect(db.getAllAsync).toHaveBeenCalledWith(
        'SELECT id, name, applied_at FROM migrations ORDER BY id ASC;'
      );
    });

    it('queries applied migrations synchronously', () => {
      const db = openDbSync(':memory:');
      const mockRows = [{ id: 1, name: '001_init', applied_at: 12345 }];
      (db.getAllSync as jest.Mock).mockReturnValueOnce(mockRows);

      const rows = getAppliedMigrationsSync(db);
      expect(rows).toEqual(mockRows);
      expect(db.getAllSync).toHaveBeenCalledWith(
        'SELECT id, name, applied_at FROM migrations ORDER BY id ASC;'
      );
    });
  });

  describe('resetDatabase and resetDatabaseSync (PRD §4 / Schema §4.5)', () => {
    it('drops all tables in reverse dependency order and re-executes migrations asynchronously', async () => {
      const db = openDbSync(':memory:');
      (db.getAllAsync as jest.Mock).mockResolvedValueOnce([]); // Fresh after drop

      const result = await resetDatabase(db, [migration001]);

      expect(db.execAsync).toHaveBeenCalledWith(DROP_ALL_TABLES_SQL);
      expect(db.execAsync).toHaveBeenCalledWith(INIT_SCHEMA_SQL);
      expect(result.appliedCount).toBe(1);
    });

    it('drops all tables and re-executes migrations synchronously', () => {
      const db = openDbSync(':memory:');
      (db.getAllSync as jest.Mock).mockReturnValueOnce([]);

      const result = resetDatabaseSync(db, [migration001]);

      expect(db.execSync).toHaveBeenCalledWith(DROP_ALL_TABLES_SQL);
      expect(db.execSync).toHaveBeenCalledWith(INIT_SCHEMA_SQL);
      expect(result.appliedCount).toBe(1);
    });
  });
});
