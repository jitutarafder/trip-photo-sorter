import {
  openDb,
  openDbSync,
  getDatabase,
  getDatabaseSync,
  closeDatabase,
  setDatabaseInstance,
  DB_NAME,
} from '../src/db/client';

describe('Database Client (Task 1.1)', () => {
  beforeEach(() => {
    closeDatabase();
    setDatabaseInstance(null);
  });

  afterEach(() => {
    closeDatabase();
    setDatabaseInstance(null);
  });

  it('exposes DB_NAME constant', () => {
    expect(DB_NAME).toBe('tripphotosorter.db');
  });

  it('opens database synchronously with WAL mode and foreign keys enabled', () => {
    const db = openDbSync(DB_NAME);
    expect(db).toBeDefined();

    // Verify WAL mode and foreign keys PRAGMAs were executed
    expect(db.execSync).toHaveBeenCalledWith('PRAGMA journal_mode = WAL;');
    expect(db.execSync).toHaveBeenCalledWith('PRAGMA foreign_keys = ON;');
  });

  it('opens database asynchronously with WAL mode and foreign keys enabled', async () => {
    const db = await openDb(DB_NAME);
    expect(db).toBeDefined();

    expect(db.execAsync).toHaveBeenCalledWith('PRAGMA journal_mode = WAL;');
    expect(db.execAsync).toHaveBeenCalledWith('PRAGMA foreign_keys = ON;');
  });

  it('provides singleton database instance via getDatabaseSync and getDatabase', async () => {
    const dbSync = getDatabaseSync();
    expect(dbSync).toBeDefined();

    // Second call returns same instance without re-opening
    const dbSync2 = getDatabaseSync();
    expect(dbSync2).toBe(dbSync);

    const dbAsync = await getDatabase();
    expect(dbAsync).toBe(dbSync);
  });

  it('allows overriding database instance with setDatabaseInstance for testing', () => {
    const customDb = openDbSync(':memory:');
    setDatabaseInstance(customDb);

    const activeDb = getDatabaseSync();
    expect(activeDb).toBe(customDb);
  });

  it('safely closes the database connection and resets singleton', () => {
    const db = getDatabaseSync();
    expect(db).toBeDefined();

    closeDatabase();
    expect(db.closeSync).toHaveBeenCalled();

    // Opening again creates a new instance
    const newDb = getDatabaseSync();
    expect(newDb).toBeDefined();
  });
});
