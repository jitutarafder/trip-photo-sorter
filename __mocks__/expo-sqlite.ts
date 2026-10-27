// Jest mock for expo-sqlite in Node.js test environment
// Implements in-memory table and query tracking for unit testing repositories & client

export interface MockDatabase {
  databaseName: string;
  execSync: jest.Mock;
  execAsync: jest.Mock;
  runSync: jest.Mock;
  runAsync: jest.Mock;
  getFirstSync: jest.Mock;
  getFirstAsync: jest.Mock;
  getAllSync: jest.Mock;
  getAllAsync: jest.Mock;
  closeSync: jest.Mock;
  closeAsync: jest.Mock;
  withTransactionSync: jest.Mock;
  withTransactionAsync: jest.Mock;
}

export function createMockDatabase(name: string): MockDatabase {
  return {
    databaseName: name,
    execSync: jest.fn(),
    execAsync: jest.fn().mockResolvedValue(undefined),
    runSync: jest.fn().mockReturnValue({ lastInsertRowId: 1, changes: 1 }),
    runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
    getFirstSync: jest.fn().mockReturnValue(null),
    getFirstAsync: jest.fn().mockResolvedValue(null),
    getAllSync: jest.fn().mockReturnValue([]),
    getAllAsync: jest.fn().mockResolvedValue([]),
    closeSync: jest.fn(),
    closeAsync: jest.fn().mockResolvedValue(undefined),
    withTransactionSync: jest.fn((cb: () => void) => cb()),
    withTransactionAsync: jest.fn(async (cb: () => Promise<void>) => await cb()),
  };
}

let activeMockDb: MockDatabase | null = null;

export function openDatabaseSync(dbName: string): MockDatabase {
  activeMockDb = createMockDatabase(dbName);
  return activeMockDb;
}

export async function openDatabaseAsync(dbName: string): Promise<MockDatabase> {
  activeMockDb = createMockDatabase(dbName);
  return activeMockDb;
}

export function getActiveMockDb(): MockDatabase | null {
  return activeMockDb;
}
