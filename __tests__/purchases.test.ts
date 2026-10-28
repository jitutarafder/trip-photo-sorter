import * as React from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { openDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrations';
import { createTrip, updateTrip } from '../src/db/repositories/trips';
import { upsertPhotos } from '../src/db/repositories/photos';
import { createPerson } from '../src/db/repositories/people';
import { insertFaces } from '../src/db/repositories/faces';
import type { PhotoRow, FaceRow } from '../src/db/types';
import { CONFIG } from '../src/domain/config';
import {
  isProUser,
  setProStatus,
  getTripFreeTierStatus,
  canScanPhotos,
  getProProductDetails,
  unlockProStub,
  restorePurchasesStub,
  verifyReceiptStub,
  useProStatus,
  useTripFreeTier,
} from '../src/services/purchases';
import { scanTripFaces } from '../src/services/faceScan';
import { exportPerson } from '../src/services/exporter';

// Mock native file system & media library for exporter/scan integration
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///mock/cache/',
  documentDirectory: 'file:///mock/documents/',
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true, isDirectory: false, size: 5000 }),
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  copyAsync: jest.fn().mockResolvedValue(undefined),
  getFreeDiskStorageAsync: jest.fn().mockResolvedValue(1024 * 1024 * 1024),
}));

jest.mock('expo-media-library', () => ({
  getAssetInfoAsync: jest.fn().mockImplementation((id: string) =>
    Promise.resolve({ localUri: `file:///mock/${id}.jpg`, uri: `file:///mock/${id}.jpg` })
  ),
}));

// React 19 hook simulation harness
interface ReactInternalsWithDispatcher {
  H: {
    useState?: (initial: unknown) => [unknown, (updater: unknown) => void];
    useCallback?: (fn: unknown, deps?: unknown[]) => unknown;
    useEffect?: (effect: () => (() => void) | void, deps?: unknown[]) => void;
  } | null;
}

function renderHookSim<T>(hookFn: () => T) {
  const stateSlots: unknown[] = [];
  const setterSlots: ((val: unknown) => void)[] = [];
  let slotIndex = 0;
  let effectCleanup: (() => void) | void;
  let effectFn: (() => (() => void) | void) | undefined;
  let effectDeps: unknown[] | undefined;
  let prevEffectDeps: unknown[] | undefined;

  const result: { current: T } = { current: undefined as unknown as T };

  const reactInternals = (React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: ReactInternalsWithDispatcher;
  }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

  const originalDispatcher = reactInternals?.H ?? null;

  const runRender = () => {
    slotIndex = 0;
    if (reactInternals) {
      reactInternals.H = dispatcherMock;
    }
    result.current = hookFn();
  };

  const runEffect = () => {
    if (effectFn) {
      if (
        !effectDeps ||
        !prevEffectDeps ||
        effectDeps.length !== prevEffectDeps.length ||
        effectDeps.some((d, i) => !Object.is(d, prevEffectDeps![i]))
      ) {
        if (typeof effectCleanup === 'function') {
          effectCleanup();
        }
        effectCleanup = effectFn();
        prevEffectDeps = effectDeps;
      }
    }
  };

  const dispatcherMock = {
    useState: (initial: unknown) => {
      const currIndex = slotIndex++;
      if (stateSlots.length <= currIndex) {
        stateSlots[currIndex] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      }
      if (!setterSlots[currIndex]) {
        setterSlots[currIndex] = (updater: unknown) => {
          stateSlots[currIndex] =
            typeof updater === 'function'
              ? (updater as (prev: unknown) => unknown)(stateSlots[currIndex])
              : updater;
          runRender();
        };
      }
      return [stateSlots[currIndex], setterSlots[currIndex]] as [unknown, (updater: unknown) => void];
    },
    useCallback: (fn: unknown) => fn,
    useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
      effectFn = effect;
      effectDeps = deps;
    },
  };

  runRender();
  runEffect();

  return {
    result,
    unmount: () => {
      if (typeof effectCleanup === 'function') {
        effectCleanup();
      }
      if (reactInternals) {
        reactInternals.H = originalDispatcher;
      }
    },
    rerender: () => {
      runRender();
      runEffect();
    },
  };
}

describe('Free-Tier Gate & Purchases Service (Task 2.9)', () => {
  let db: SQLiteDatabase;
  const TRIP_ID = 'trip_purchases_test';

  beforeEach(async () => {
    db = await openDb(':memory:');
    await runMigrations(db);

    await createTrip(
      {
        id: TRIP_ID,
        name: 'Sajek Valley',
        start_at: 1000,
        end_at: 2000,
        scanned_count: 0,
      },
      db
    );
  });

  describe('isProUser & Feature Flag Behaviour', () => {
    it('returns true by default when ENABLE_PRO_GATE is OFF ($0 MVP, everything unlocked)', async () => {
      // By default CONFIG.ENABLE_PRO_GATE is false
      expect(CONFIG.ENABLE_PRO_GATE).toBe(false);

      const pro = await isProUser(db);
      expect(pro).toBe(true);
    });

    it('checks SQLite is_pro when gate is explicitly enabled', async () => {
      const proDefault = await isProUser(db, true);
      expect(proDefault).toBe(false);

      await setProStatus(true, db);
      const proAfterSet = await isProUser(db, true);
      expect(proAfterSet).toBe(true);
    });
  });

  describe('getTripFreeTierStatus', () => {
    it('returns unlimited status when gate is OFF', async () => {
      const status = await getTripFreeTierStatus(TRIP_ID, db, false);
      expect(status.isPro).toBe(true);
      expect(status.canScanMore).toBe(true);
      expect(status.remainingFreeScans).toBe(Infinity);
      expect(status.requiresPaywall).toBe(false);
    });

    it('calculates remaining free scans accurately when gate is ON', async () => {
      // Trip with 0 scanned photos
      const s0 = await getTripFreeTierStatus(TRIP_ID, db, true);
      expect(s0.scannedCount).toBe(0);
      expect(s0.limit).toBe(50);
      expect(s0.remainingFreeScans).toBe(50);
      expect(s0.canScanMore).toBe(true);
      expect(s0.requiresPaywall).toBe(false);

      // Trip with 35 scanned photos
      await updateTrip(TRIP_ID, { scanned_count: 35 }, db);
      const s35 = await getTripFreeTierStatus(TRIP_ID, db, true);
      expect(s35.scannedCount).toBe(35);
      expect(s35.remainingFreeScans).toBe(15);
      expect(s35.canScanMore).toBe(true);
      expect(s35.requiresPaywall).toBe(false);

      // Trip with 50 scanned photos (limit reached)
      await updateTrip(TRIP_ID, { scanned_count: 50 }, db);
      const s50 = await getTripFreeTierStatus(TRIP_ID, db, true);
      expect(s50.scannedCount).toBe(50);
      expect(s50.remainingFreeScans).toBe(0);
      expect(s50.canScanMore).toBe(false);
      expect(s50.requiresPaywall).toBe(true);

      // Trip with 60 scanned photos (exceeded)
      await updateTrip(TRIP_ID, { scanned_count: 60 }, db);
      const s60 = await getTripFreeTierStatus(TRIP_ID, db, true);
      expect(s60.remainingFreeScans).toBe(0);
      expect(s60.canScanMore).toBe(false);
      expect(s60.requiresPaywall).toBe(true);
    });

    it('unblocks trip when user is Pro even if scanned count > 50', async () => {
      await updateTrip(TRIP_ID, { scanned_count: 75 }, db);
      await setProStatus(true, db);

      const status = await getTripFreeTierStatus(TRIP_ID, db, true);
      expect(status.isPro).toBe(true);
      expect(status.canScanMore).toBe(true);
      expect(status.remainingFreeScans).toBe(Infinity);
      expect(status.requiresPaywall).toBe(false);
    });
  });

  describe('canScanPhotos batch quota calculation', () => {
    it('allows full batch when user is Pro', async () => {
      await setProStatus(true, db);
      const res = await canScanPhotos(TRIP_ID, 100, db, true);
      expect(res.allowed).toBe(true);
      expect(res.allowedCount).toBe(100);
      expect(res.requiresPaywall).toBe(false);
    });

    it('caps allowedCount to remaining free quota and flags requiresPaywall', async () => {
      await updateTrip(TRIP_ID, { scanned_count: 42 }, db);

      // 42 scanned -> 8 remaining free scans
      const res = await canScanPhotos(TRIP_ID, 15, db, true);
      expect(res.allowed).toBe(true);
      expect(res.allowedCount).toBe(8);
      expect(res.requiresPaywall).toBe(true);
    });

    it('disallows scanning when quota is 0', async () => {
      await updateTrip(TRIP_ID, { scanned_count: 50 }, db);
      const res = await canScanPhotos(TRIP_ID, 5, db, true);
      expect(res.allowed).toBe(false);
      expect(res.allowedCount).toBe(0);
      expect(res.requiresPaywall).toBe(true);
    });
  });

  describe('Purchases Stubs & Product Details', () => {
    it('returns Pro product details matching PRD specs', () => {
      const details = getProProductDetails();
      expect(details.id).toBe('trip_photo_sorter_pro');
      expect(details.price).toBe('$4.99');
      expect(details.benefits.length).toBeGreaterThan(0);
      expect(details.benefits[0]).toContain('50 photos');
    });

    it('unlockProStub sets is_pro to true in SQLite', async () => {
      expect(await isProUser(db, true)).toBe(false);
      const result = await unlockProStub(db);
      expect(result).toBe(true);
      expect(await isProUser(db, true)).toBe(true);
    });

    it('restorePurchasesStub returns current Pro status', async () => {
      expect(await restorePurchasesStub(db)).toBe(false);
      await unlockProStub(db);
      expect(await restorePurchasesStub(db)).toBe(true);
    });

    it('verifyReceiptStub returns valid receipt object', async () => {
      const result = await verifyReceiptStub('mock_receipt_token');
      expect(result.valid).toBe(true);
      expect(result.isPro).toBe(true);
    });
  });

  describe('React Hooks (useProStatus & useTripFreeTier)', () => {
    it('useProStatus loads initial status, unlocks pro, and restores purchases', async () => {
      const harness = renderHookSim(() => useProStatus(db, true));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(harness.result.current.isPro).toBe(false);
      expect(harness.result.current.isLoading).toBe(false);

      // Trigger unlockPro
      await harness.result.current.unlockPro();
      expect(harness.result.current.isPro).toBe(true);

      harness.unmount();
    });

    it('useTripFreeTier loads status and supports refresh', async () => {
      await updateTrip(TRIP_ID, { scanned_count: 20 }, db);

      const harness = renderHookSim(() => useTripFreeTier(TRIP_ID, db, true));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(harness.result.current.status?.scannedCount).toBe(20);
      expect(harness.result.current.status?.remainingFreeScans).toBe(30);

      // Update DB and refresh
      await updateTrip(TRIP_ID, { scanned_count: 50 }, db);
      await harness.result.current.refresh();

      expect(harness.result.current.status?.scannedCount).toBe(50);
      expect(harness.result.current.status?.requiresPaywall).toBe(true);

      harness.unmount();
    });
  });

  describe('Integration with Face Scanner (scanTripFaces)', () => {
    it('allows full scan when gate is OFF ($0 MVP default)', async () => {
      await updateTrip(TRIP_ID, { scanned_count: 50 }, db);

      const photos: PhotoRow[] = [
        {
          id: 'p_free_1',
          trip_id: TRIP_ID,
          taken_at: 1000,
          modified_at: 1000,
          width: 100,
          height: 100,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'pending',
          face_count: 0,
          excluded: 0,
        },
      ];
      await upsertPhotos(photos, db);

      const mockDetector = {
        detectFaces: jest.fn().mockResolvedValue([]),
      };

      const result = await scanTripFaces(TRIP_ID, {
        db,
        detector: mockDetector,
        photoUriResolver: async () => 'file:///mock/p1.jpg',
        enableProGate: false,
      });

      expect(result.status).toBe('completed');
      expect(result.scannedCount).toBe(1);
      expect(result.paywallRequired).toBe(false);
    });

    it('pauses and flags paywallRequired if trip already reached 50 photos when gate is ON', async () => {
      await updateTrip(TRIP_ID, { scanned_count: 50 }, db);

      const photos: PhotoRow[] = [
        {
          id: 'p_blocked_1',
          trip_id: TRIP_ID,
          taken_at: 1000,
          modified_at: 1000,
          width: 100,
          height: 100,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'pending',
          face_count: 0,
          excluded: 0,
        },
      ];
      await upsertPhotos(photos, db);

      const result = await scanTripFaces(TRIP_ID, {
        db,
        enableProGate: true,
      });

      expect(result.status).toBe('paused');
      expect(result.paywallRequired).toBe(true);
      expect(result.scannedCount).toBe(0);
    });
  });

  describe('Integration with Exporter (exportPerson)', () => {
    const dummyBlob = new Uint8Array(512);

    beforeEach(async () => {
      const person = await createPerson({ id: 'p_exp_gate', trip_id: TRIP_ID, name: 'Tanvir' }, db);

      const photos: PhotoRow[] = [
        {
          id: 'p_exp_1',
          trip_id: TRIP_ID,
          taken_at: 1000,
          modified_at: 1000,
          width: 100,
          height: 100,
          lat: null,
          lng: null,
          is_local: 1,
          scan_status: 'done',
          face_count: 1,
          excluded: 0,
        },
      ];
      await upsertPhotos(photos, db);

      const faces: FaceRow[] = [
        {
          id: 'f_exp_1',
          photo_id: 'p_exp_1',
          person_id: person.id,
          assignment: 'auto',
          bbox_x: 0,
          bbox_y: 0,
          bbox_w: 0.1,
          bbox_h: 0.1,
          quality: 0.9,
          quality_ok: 1,
          blur: 50,
          embedding: dummyBlob,
        },
      ];
      await insertFaces(faces, db);
    });

    it('allows export when gate is OFF even if trip scanned_count > 50', async () => {
      await updateTrip(TRIP_ID, { scanned_count: 65 }, db);

      const result = await exportPerson({
        personId: 'p_exp_gate',
        tripId: TRIP_ID,
        mode: 'zip',
        db,
        enableProGate: false,
      });

      expect(result.status).toBe('done');
    });

    it('blocks export when gate is ON and trip scanned_count > 50 (AppFlow §3.7)', async () => {
      await updateTrip(TRIP_ID, { scanned_count: 55 }, db);

      await expect(
        exportPerson({
          personId: 'p_exp_gate',
          tripId: TRIP_ID,
          mode: 'zip',
          db,
          enableProGate: true,
        })
      ).rejects.toThrow('Free-tier limit exceeded (55 photos scanned, max 50). Unlock Pro to export.');
    });

    it('unblocks export when user unlocks Pro', async () => {
      await updateTrip(TRIP_ID, { scanned_count: 55 }, db);
      await unlockProStub(db);

      const result = await exportPerson({
        personId: 'p_exp_gate',
        tripId: TRIP_ID,
        mode: 'zip',
        db,
        enableProGate: true,
      });

      expect(result.status).toBe('done');
    });
  });
});
