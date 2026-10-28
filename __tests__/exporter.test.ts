import * as React from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { openDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrations';
import { createTrip } from '../src/db/repositories/trips';
import { createExport, getExportById } from '../src/db/repositories/exports';
import {
  getExportsDirectory,
  ensureExportsDirectory,
  cleanupExportFile,
  sweepOrphanTempExports,
  useOrphanSweep,
} from '../src/services/exporter';

// Mock expo-file-system legacy
jest.mock('expo-file-system/legacy', () => {
  return {
    cacheDirectory: 'file:///mock/cache/',
    documentDirectory: 'file:///mock/documents/',
    getInfoAsync: jest.fn(),
    makeDirectoryAsync: jest.fn(),
    deleteAsync: jest.fn(),
    readDirectoryAsync: jest.fn(),
  };
});

// React 19 internals type for mocking hooks in node environment
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

describe('Orphan Temp Export Sweep Service (src/services/exporter.ts)', () => {
  let db: SQLiteDatabase;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = await openDb(':memory:');
    await runMigrations(db);

    // Create a parent trip for foreign keys
    await createTrip(
      {
        id: 'trip-test',
        name: 'Test Trip',
        start_at: 1000,
        end_at: 2000,
      },
      db
    );
  });

  describe('getExportsDirectory & ensureExportsDirectory', () => {
    it('returns the exports cache directory path ending with /', () => {
      const dir = getExportsDirectory();
      expect(dir).toBe('file:///mock/cache/exports/');
    });

    it('creates directory if it does not exist', async () => {
      (LegacyFileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
        exists: false,
        isDirectory: false,
      });
      (LegacyFileSystem.makeDirectoryAsync as jest.Mock).mockResolvedValueOnce(undefined);

      const dir = await ensureExportsDirectory();
      expect(dir).toBe('file:///mock/cache/exports/');
      expect(LegacyFileSystem.makeDirectoryAsync).toHaveBeenCalledWith(
        'file:///mock/cache/exports/',
        { intermediates: true }
      );
    });

    it('does not re-create directory if it already exists', async () => {
      (LegacyFileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
        exists: true,
        isDirectory: true,
      });

      await ensureExportsDirectory();
      expect(LegacyFileSystem.makeDirectoryAsync).not.toHaveBeenCalled();
    });
  });

  describe('cleanupExportFile', () => {
    it('deletes the export file on disk and sets zip_path to NULL in database', async () => {
      const exportRow = await createExport(
        {
          id: 'exp-1',
          trip_id: 'trip-test',
          status: 'ready',
          photo_count: 10,
          zip_path: 'file:///mock/cache/exports/exp-1.zip',
        },
        db
      );
      expect(exportRow.zip_path).toBe('file:///mock/cache/exports/exp-1.zip');

      (LegacyFileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
        exists: true,
        isDirectory: false,
      });
      (LegacyFileSystem.deleteAsync as jest.Mock).mockResolvedValueOnce(undefined);

      const cleaned = await cleanupExportFile('exp-1', null, db);
      expect(cleaned).toBe(true);
      expect(LegacyFileSystem.deleteAsync).toHaveBeenCalledWith(
        'file:///mock/cache/exports/exp-1.zip',
        { idempotent: true }
      );

      const check = await getExportById('exp-1', db);
      expect(check?.zip_path).toBeNull();
    });

    it('handles already-deleted file gracefully', async () => {
      await createExport(
        {
          id: 'exp-missing',
          trip_id: 'trip-test',
          status: 'ready',
          photo_count: 5,
          zip_path: 'file:///mock/cache/exports/missing.zip',
        },
        db
      );

      (LegacyFileSystem.getInfoAsync as jest.Mock).mockResolvedValueOnce({
        exists: false,
      });

      const cleaned = await cleanupExportFile('exp-missing', null, db);
      expect(cleaned).toBe(true);
      expect(LegacyFileSystem.deleteAsync).not.toHaveBeenCalled();

      const check = await getExportById('exp-missing', db);
      expect(check?.zip_path).toBeNull();
    });
  });

  describe('sweepOrphanTempExports at launch', () => {
    it('deletes lingering files in exports/ directory and marks interrupted DB exports as cancelled', async () => {
      // 1. Setup DB exports:
      // In-flight export that was interrupted (zipping)
      await createExport(
        {
          id: 'exp-interrupted-1',
          trip_id: 'trip-test',
          status: 'zipping',
          photo_count: 20,
          zip_path: 'file:///mock/cache/exports/in-flight.zip',
        },
        db
      );

      // In-flight export with status 'ready' that was interrupted before share finished
      await createExport(
        {
          id: 'exp-interrupted-2',
          trip_id: 'trip-test',
          status: 'ready',
          photo_count: 15,
          zip_path: 'file:///mock/cache/exports/ready.zip',
        },
        db
      );

      // Completed export (done) where zip_path was already cleaned
      await createExport(
        {
          id: 'exp-done',
          trip_id: 'trip-test',
          status: 'done',
          photo_count: 10,
          zip_path: null,
        },
        db
      );

      // 2. Mock file system:
      // Database check for in-flight files:
      (LegacyFileSystem.getInfoAsync as jest.Mock).mockImplementation((path: string) => {
        if (path === 'file:///mock/cache/exports/') {
          return Promise.resolve({ exists: true, isDirectory: true });
        }
        if (
          path === 'file:///mock/cache/exports/in-flight.zip' ||
          path === 'file:///mock/cache/exports/ready.zip' ||
          path === 'file:///mock/cache/exports/orphan-abandoned.zip'
        ) {
          return Promise.resolve({ exists: true, isDirectory: false });
        }
        return Promise.resolve({ exists: false, isDirectory: false });
      });

      (LegacyFileSystem.readDirectoryAsync as jest.Mock).mockResolvedValueOnce([
        'orphan-abandoned.zip',
      ]);
      (LegacyFileSystem.deleteAsync as jest.Mock).mockResolvedValue(undefined);

      // 3. Execute sweep
      const sweepResult = await sweepOrphanTempExports(db);

      expect(sweepResult.clearedDbRecordsCount).toBe(2);
      expect(sweepResult.deletedFilesCount).toBe(3); // 2 from DB zip_paths + 1 from directory enumeration
      expect(sweepResult.errors).toHaveLength(0);

      // Verify DB status transitions
      const exp1 = await getExportById('exp-interrupted-1', db);
      expect(exp1?.status).toBe('cancelled');
      expect(exp1?.zip_path).toBeNull();
      expect(exp1?.error).toBe('Interrupted by app termination');

      const exp2 = await getExportById('exp-interrupted-2', db);
      expect(exp2?.status).toBe('cancelled');
      expect(exp2?.zip_path).toBeNull();

      const expDone = await getExportById('exp-done', db);
      expect(expDone?.status).toBe('done');
      expect(expDone?.zip_path).toBeNull();
    });

    it('tolerates non-existent exports directory on clean installs', async () => {
      (LegacyFileSystem.getInfoAsync as jest.Mock).mockResolvedValue({
        exists: false,
        isDirectory: false,
      });

      const result = await sweepOrphanTempExports(db);
      expect(result.deletedFilesCount).toBe(0);
      expect(result.clearedDbRecordsCount).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('records errors without crashing if file deletion throws', async () => {
      await createExport(
        {
          id: 'exp-err',
          trip_id: 'trip-test',
          status: 'ready',
          photo_count: 5,
          zip_path: 'file:///mock/cache/exports/locked.zip',
        },
        db
      );

      (LegacyFileSystem.getInfoAsync as jest.Mock).mockImplementation((path: string) => {
        if (path === 'file:///mock/cache/exports/') {
          return Promise.resolve({ exists: false });
        }
        return Promise.resolve({ exists: true });
      });

      (LegacyFileSystem.deleteAsync as jest.Mock).mockRejectedValueOnce(
        new Error('Permission denied')
      );

      const result = await sweepOrphanTempExports(db);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Permission denied');
    });
  });

  describe('useOrphanSweep hook', () => {
    it('executes sweep on mount and sets sweepResult', async () => {
      (LegacyFileSystem.getInfoAsync as jest.Mock).mockResolvedValue({
        exists: false,
      });

      const harness = renderHookSim(() => useOrphanSweep(db));
      expect(harness.result.current.isSweeping).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(harness.result.current.isSweeping).toBe(false);
      expect(harness.result.current.sweepResult).not.toBeNull();
      expect(harness.result.current.sweepResult?.deletedFilesCount).toBe(0);
      expect(harness.result.current.error).toBeNull();

      harness.unmount();
    });

    it('supports manual resweep', async () => {
      (LegacyFileSystem.getInfoAsync as jest.Mock).mockResolvedValue({
        exists: false,
      });

      const harness = renderHookSim(() => useOrphanSweep(db));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await harness.result.current.resweep();
      expect(res.deletedFilesCount).toBe(0);
      expect(harness.result.current.isSweeping).toBe(false);

      harness.unmount();
    });
  });
});
