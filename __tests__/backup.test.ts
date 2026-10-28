import { Platform } from 'react-native';
import * as AppleVisionModule from 'apple-vision';
import {
  getDatabaseDirectory,
  getDatabasePath,
  excludeDatabaseFromBackup,
  isDatabaseExcludedFromBackup,
} from '../src/db/backup';
import { openDb, DB_NAME } from '../src/db/client';

jest.mock('apple-vision', () => ({
  __esModule: true,
  setExcludedFromBackup: jest.fn().mockResolvedValue(true),
  isExcludedFromBackup: jest.fn().mockResolvedValue(true),
  detectFacesWithAppleVision: jest.fn().mockResolvedValue([]),
  isAppleVisionAvailable: jest.fn().mockReturnValue(true),
  default: {
    detectFaces: jest.fn().mockResolvedValue([]),
    setExcludedFromBackup: jest.fn().mockResolvedValue(true),
    isExcludedFromBackup: jest.fn().mockResolvedValue(true),
  },
}));

describe('Database Backup Exclusion (Task 1.4 - docs/04_TRD.md §6 & 05_Schema.md §4.6)', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalPlatform });
    jest.clearAllMocks();
  });

  it('computes correct database directory and file paths', () => {
    const dir = getDatabaseDirectory();
    expect(dir.endsWith('SQLite/')).toBe(true);

    const path = getDatabasePath('test.db');
    expect(path.endsWith('SQLite/test.db')).toBe(true);

    const defaultPath = getDatabasePath();
    expect(defaultPath.endsWith(`SQLite/${DB_NAME}`)).toBe(true);
  });

  describe('on iOS', () => {
    beforeEach(() => {
      Object.defineProperty(Platform, 'OS', { value: 'ios' });
    });

    it('excludes database directory and file from backup via NSURLIsExcludedFromBackupKey', async () => {
      const success = await excludeDatabaseFromBackup('custom.db');

      expect(success).toBe(true);
      expect(AppleVisionModule.setExcludedFromBackup).toHaveBeenCalledWith(
        expect.stringMatching(/SQLite\/$/)
      );
      expect(AppleVisionModule.setExcludedFromBackup).toHaveBeenCalledWith(
        expect.stringMatching(/SQLite\/custom\.db$/)
      );
    });

    it('verifies that database is excluded from backup', async () => {
      (AppleVisionModule.isExcludedFromBackup as jest.Mock).mockResolvedValueOnce(true);

      const isExcluded = await isDatabaseExcludedFromBackup('custom.db');
      expect(isExcluded).toBe(true);
      expect(AppleVisionModule.isExcludedFromBackup).toHaveBeenCalledWith(
        expect.stringMatching(/SQLite\/custom\.db$/)
      );
    });

    it('handles native verification fallback to directory when file check is false', async () => {
      (AppleVisionModule.isExcludedFromBackup as jest.Mock)
        .mockResolvedValueOnce(false) // File check
        .mockResolvedValueOnce(true); // Directory check

      const isExcluded = await isDatabaseExcludedFromBackup('custom.db');
      expect(isExcluded).toBe(true);
      expect(AppleVisionModule.isExcludedFromBackup).toHaveBeenCalledTimes(2);
    });

    it('gracefully handles native errors without throwing', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      (AppleVisionModule.setExcludedFromBackup as jest.Mock).mockRejectedValueOnce(
        new Error('Native filesystem error')
      );

      const result = await excludeDatabaseFromBackup('custom.db');
      expect(result).toBe(false);
      warnSpy.mockRestore();
    });
  });

  describe('on non-iOS platforms (Android, etc.)', () => {
    beforeEach(() => {
      Object.defineProperty(Platform, 'OS', { value: 'android' });
    });

    it('returns true as no-op without calling iOS native module', async () => {
      const success = await excludeDatabaseFromBackup('android.db');
      expect(success).toBe(true);
      expect(AppleVisionModule.setExcludedFromBackup).not.toHaveBeenCalled();

      const isExcluded = await isDatabaseExcludedFromBackup('android.db');
      expect(isExcluded).toBe(true);
      expect(AppleVisionModule.isExcludedFromBackup).not.toHaveBeenCalled();
    });
  });

  describe('Integration with openDb', () => {
    beforeEach(() => {
      Object.defineProperty(Platform, 'OS', { value: 'ios' });
    });

    it('automatically triggers excludeDatabaseFromBackup when opening named database', async () => {
      const db = await openDb('production_test.db');
      expect(db).toBeDefined();

      expect(AppleVisionModule.setExcludedFromBackup).toHaveBeenCalledWith(
        expect.stringMatching(/SQLite\/production_test\.db$/)
      );
    });

    it('does not attempt backup exclusion for in-memory test databases', async () => {
      const db = await openDb(':memory:');
      expect(db).toBeDefined();

      expect(AppleVisionModule.setExcludedFromBackup).not.toHaveBeenCalled();
    });
  });
});
