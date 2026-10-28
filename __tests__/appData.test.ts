import { openDbSync } from '../src/db/client';
import { runMigrationsSync } from '../src/db/migrations';
import { createTrip, getAllTrips } from '../src/db/repositories/trips';
import { resetAllAppData } from '../src/services/appData';
import { setOnboarded, isOnboarded } from '../src/db/repositories/settings';

describe('AppData Service (Task 3.11)', () => {
  const db = openDbSync(':memory:');

  beforeEach(() => {
    (db as unknown as { _clear: () => void })._clear();
    runMigrationsSync(db);
  });

  it('resetAllAppData clears all database data and re-migrates cleanly', async () => {
    // 1. Populate some data
    await setOnboarded(true, db);
    await createTrip(
      {
        id: 'trip_to_reset',
        name: 'Trip to be wiped',
        start_at: 1000,
        end_at: 2000,
        photo_count: 5,
        cover_photo_id: null,
      },
      db
    );

    expect(await isOnboarded(db)).toBe(true);
    const tripsBefore = await getAllTrips({ includeHidden: true }, db);
    expect(tripsBefore.length).toBe(1);

    // 2. Execute resetAllAppData
    const result = await resetAllAppData(db);

    expect(result.tablesReset).toBe(true);
    expect(result.exportsCleared).toBe(true);

    // 3. Verify clean state
    expect(await isOnboarded(db)).toBe(false);
    const tripsAfter = await getAllTrips({ includeHidden: true }, db);
    expect(tripsAfter.length).toBe(0);
  });
});
