// Jest mock for expo-sqlite in Node.js test environment
// Provides an in-memory SQL execution engine for unit testing repositories, migrations & client

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
  _tables: Map<string, Map<string, Record<string, unknown>>>;
  _clear: () => void;
}

class InMemoryEngine {
  tables = new Map<string, Map<string, Record<string, unknown>>>();

  constructor() {
    this.reset();
  }

  reset(): void {
    this.tables.clear();
    const tableNames = [
      'trips',
      'photos',
      'people',
      'faces',
      'person_photos_excluded',
      'exports',
      'settings',
      'migrations',
    ];
    for (const name of tableNames) {
      this.tables.set(name, new Map());
    }
  }

  getTable(name: string): Map<string, Record<string, unknown>> {
    let t = this.tables.get(name);
    if (!t) {
      t = new Map();
      this.tables.set(name, t);
    }
    return t;
  }

  execute(sqlRaw: string, params: unknown[] = []): { changes: number; lastInsertRowId: number } {
    const trimmed = sqlRaw.trim();
    if (trimmed.includes(';')) {
      const statements = trimmed
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('--'));

      if (statements.length > 1) {
        let totalChanges = 0;
        let lastId = 0;
        for (const stmt of statements) {
          const res = this.executeSingle(stmt, params);
          totalChanges += res.changes;
          lastId = res.lastInsertRowId || lastId;
        }
        return { changes: totalChanges, lastInsertRowId: lastId };
      }
    }

    return this.executeSingle(trimmed, params);
  }

  private executeSingle(sqlRaw: string, params: unknown[] = []): { changes: number; lastInsertRowId: number } {
    const cleanSql = sqlRaw.replace(/;\s*$/, '').trim();

    if (cleanSql.startsWith('PRAGMA') || cleanSql.startsWith('--') || cleanSql.length === 0) {
      return { changes: 0, lastInsertRowId: 0 };
    }

    if (/^DROP\s+TABLE/i.test(cleanSql)) {
      const match = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_]+)/i.exec(cleanSql);
      if (match) {
        this.tables.delete(match[1]);
      }
      return { changes: 0, lastInsertRowId: 0 };
    }

    if (/^CREATE\s+TABLE/i.test(cleanSql)) {
      const match = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/i.exec(cleanSql);
      if (match) {
        this.getTable(match[1]);
      }
      return { changes: 0, lastInsertRowId: 0 };
    }

    if (/^CREATE\s+INDEX/i.test(cleanSql)) {
      return { changes: 0, lastInsertRowId: 0 };
    }

    if (/^INSERT/i.test(cleanSql)) {
      return this.handleInsert(cleanSql, params);
    }

    if (/^UPDATE/i.test(cleanSql)) {
      return this.handleUpdate(cleanSql, params);
    }

    if (/^DELETE/i.test(cleanSql)) {
      return this.handleDelete(cleanSql, params);
    }

    return { changes: 0, lastInsertRowId: 0 };
  }

  private handleInsert(sql: string, params: unknown[]): { changes: number; lastInsertRowId: number } {
    const tableMatch = /INSERT\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?INTO\s+([a-zA-Z0-9_]+)/i.exec(sql);
    if (!tableMatch) return { changes: 0, lastInsertRowId: 0 };

    const tableName = tableMatch[1];
    const table = this.getTable(tableName);

    // INSERT INTO ... SELECT
    if (/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+person_photos_excluded\s*\(person_id,\s*photo_id\)\s*SELECT\s*\?,\s*photo_id\s*FROM\s*person_photos_excluded\s*WHERE\s*person_id\s*=\s*\?/i.test(sql)) {
      const targetPersonId = params[0] as string;
      const sourcePersonId = params[1] as string;
      let changes = 0;
      for (const row of Array.from(table.values())) {
        if (row.person_id === sourcePersonId) {
          const newKey = `${targetPersonId}:::${row.photo_id}`;
          if (!table.has(newKey)) {
            table.set(newKey, { person_id: targetPersonId, photo_id: row.photo_id });
            changes++;
          }
        }
      }
      return { changes, lastInsertRowId: 1 };
    }

    const colsMatch = /\(([^)]+)\)\s*VALUES/i.exec(sql);
    if (!colsMatch) return { changes: 0, lastInsertRowId: 0 };

    const columns = colsMatch[1].split(',').map((c) => c.trim());
    let values = params;
    if (params.length === 0) {
      const valsMatch = /VALUES\s*\(([^)]+)\)/i.exec(sql);
      if (valsMatch) {
        values = valsMatch[1].split(',').map((v) => {
          const trimmed = v.trim();
          if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
            return trimmed.slice(1, -1);
          }
          if (!isNaN(Number(trimmed))) {
            return Number(trimmed);
          }
          return trimmed;
        });
      }
    }

    const row: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      row[col] = values[idx];
    });

    let pk: string;
    if (tableName === 'person_photos_excluded') {
      pk = `${row.person_id}:::${row.photo_id}`;
    } else if (tableName === 'settings') {
      pk = String(row.key);
    } else {
      pk = String(row.id);
    }

    if (table.has(pk)) {
      if (/ON\s+CONFLICT/i.test(sql)) {
        const existing = table.get(pk)!;
        const doUpdateMatch = /DO\s+UPDATE\s+SET\s+(.+)$/is.exec(sql);
        if (doUpdateMatch) {
          const updated = { ...existing };
          const rawClause = doUpdateMatch[1].replace(/;+$/, '');
          const assignments: string[] = [];
          let currentAssign = '';
          let parenDepth = 0;
          for (let i = 0; i < rawClause.length; i++) {
            const char = rawClause[i];
            if (char === '(') {
              parenDepth++;
              currentAssign += char;
            } else if (char === ')') {
              parenDepth = Math.max(0, parenDepth - 1);
              currentAssign += char;
            } else if (char === ',' && parenDepth === 0) {
              if (currentAssign.trim().length > 0) {
                assignments.push(currentAssign.trim());
              }
              currentAssign = '';
            } else {
              currentAssign += char;
            }
          }
          if (currentAssign.trim().length > 0) {
            assignments.push(currentAssign.trim());
          }

          for (const assign of assignments) {
            const eqIdx = assign.indexOf('=');
            if (eqIdx === -1) continue;
            const targetCol = assign.slice(0, eqIdx).trim();
            const expr = assign.slice(eqIdx + 1).trim();
            if (!targetCol || !expr) continue;
            const coalesceMatch = /COALESCE\(\s*excluded\.([a-zA-Z0-9_]+)\s*,\s*([a-zA-Z0-9_.]+)\s*\)/i.exec(expr);
            if (coalesceMatch) {
              const excludedCol = coalesceMatch[1];
              updated[targetCol] =
                row[excludedCol] !== null && row[excludedCol] !== undefined
                  ? row[excludedCol]
                  : existing[targetCol];
            } else if (expr.startsWith('excluded.')) {
              const excludedCol = expr.replace('excluded.', '').trim();
              updated[targetCol] = row[excludedCol];
            } else {
              updated[targetCol] = row[targetCol];
            }
          }
          table.set(pk, updated);
          return { changes: 1, lastInsertRowId: 1 };
        }
        table.set(pk, { ...existing, ...row });
        return { changes: 1, lastInsertRowId: 1 };
      }
      if (/OR\s+IGNORE/i.test(sql)) {
        return { changes: 0, lastInsertRowId: 0 };
      }
    }

    table.set(pk, row);
    return { changes: 1, lastInsertRowId: 1 };
  }

  private handleUpdate(sql: string, params: unknown[]): { changes: number; lastInsertRowId: number } {
    const tableMatch = /UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/is.exec(sql);
    if (!tableMatch) return { changes: 0, lastInsertRowId: 0 };

    const tableName = tableMatch[1];
    const setClause = tableMatch[2].trim();
    const whereClause = tableMatch[3].trim();

    const table = this.getTable(tableName);

    // Count how many '?' in setClause
    const setParamMatches = setClause.match(/\?/g);
    const numSetParams = setParamMatches ? setParamMatches.length : 0;
    const setParams = params.slice(0, numSetParams);
    const whereParams = params.slice(numSetParams);

    let changes = 0;
    for (const [pk, row] of Array.from(table.entries())) {
      if (this.evalWhere(whereClause, row, whereParams)) {
        const updated = { ...row };
        const setAssignments = setClause.split(',').map((s) => s.trim());
        let pIdx = 0;
        for (const assign of setAssignments) {
          const [col, expr] = assign.split('=').map((s) => s.trim());
          if (expr === '?') {
            updated[col] = setParams[pIdx++];
          } else if (expr.includes('+ ?')) {
            const current = (Number(updated[col]) || 0);
            updated[col] = current + Number(setParams[pIdx++]);
          } else if (expr === 'NULL') {
            updated[col] = null;
          } else if (expr.startsWith("'") && expr.endsWith("'")) {
            updated[col] = expr.slice(1, -1);
          } else if (!isNaN(Number(expr))) {
            updated[col] = Number(expr);
          }
        }
        table.set(pk, updated);
        changes++;
      }
    }

    return { changes, lastInsertRowId: 0 };
  }

  private handleDelete(sql: string, params: unknown[]): { changes: number; lastInsertRowId: number } {
    const tableMatch = /DELETE\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+(.+))?$/is.exec(sql);
    if (!tableMatch) return { changes: 0, lastInsertRowId: 0 };

    const tableName = tableMatch[1];
    const whereClause = tableMatch[2]?.trim();
    const table = this.getTable(tableName);

    if (!whereClause) {
      const count = table.size;
      table.clear();
      return { changes: count, lastInsertRowId: 0 };
    }

    let changes = 0;
    for (const [pk, row] of Array.from(table.entries())) {
      if (this.evalWhere(whereClause, row, params)) {
        table.delete(pk);
        changes++;
      }
    }

    return { changes, lastInsertRowId: 0 };
  }

  private evalWhere(whereClause: string, row: Record<string, unknown>, params: unknown[]): boolean {
    const clause = whereClause.replace(/;\s*$/, '').trim();

    if (/^id\s*=\s*\?$/i.test(clause)) {
      return row.id === params[0];
    }
    if (/^key\s*=\s*\?$/i.test(clause)) {
      return row.key === params[0];
    }
    if (/^photo_id\s*=\s*\?$/i.test(clause)) {
      return row.photo_id === params[0];
    }
    if (/^person_id\s*=\s*\?$/i.test(clause)) {
      return row.person_id === params[0];
    }
    if (/^trip_id\s*=\s*\?$/i.test(clause)) {
      return row.trip_id === params[0];
    }
    if (/^trip_id\s*=\s*\?\s*AND\s*is_others\s*=\s*1$/i.test(clause)) {
      return row.trip_id === params[0] && (Number(row.is_others) === 1);
    }
    if (/^trip_id\s*=\s*\?\s*AND\s*name\s*=\s*\?$/i.test(clause)) {
      return row.trip_id === params[0] && row.name === params[1];
    }
    if (/^trip_id\s*=\s*\?\s*AND\s*scan_status\s*=\s*'pending'$/i.test(clause)) {
      return row.trip_id === params[0] && row.scan_status === 'pending';
    }
    if (/^person_id\s*=\s*\?\s*AND\s*photo_id\s*=\s*\?$/i.test(clause)) {
      return row.person_id === params[0] && row.photo_id === params[1];
    }
    if (/^id\s+IN\s*\(/i.test(clause)) {
      return params.includes(row.id);
    }
    if (/^id\s+NOT\s+IN\s*\(/i.test(clause)) {
      return !params.includes(row.id);
    }
    if (/^is_hidden\s*=\s*0$/i.test(clause)) {
      return Number(row.is_hidden) === 0;
    }

    return false;
  }

  query<T>(sqlRaw: string, params: unknown[] = []): T[] {
    const sql = sqlRaw.replace(/;\s*$/, '').trim();

    // SELECT COUNT(*) as count FROM photos WHERE trip_id = ?
    if (/SELECT\s+COUNT\(\*\)\s+as\s+count\s+FROM\s+photos\s+WHERE\s+trip_id\s*=\s*\?/i.test(sql)) {
      const tripId = params[0];
      const photos = this.getTable('photos');
      let count = 0;
      for (const p of Array.from(photos.values())) {
        if (p.trip_id === tripId) count++;
      }
      return [{ count }] as unknown as T[];
    }

    // Key query: SELECT DISTINCT p.* FROM photos p JOIN faces f ON f.photo_id = p.id WHERE f.person_id = ? AND p.excluded = 0 AND p.id NOT IN (SELECT photo_id FROM person_photos_excluded WHERE person_id = ?) [AND p.face_count = 1] ORDER BY p.taken_at ASC
    if (/FROM\s+photos\s+p\s+JOIN\s+faces\s+f/i.test(sql)) {
      const personId = params[0] as string;
      const soloOnly = /p\.face_count\s*=\s*1/i.test(sql);

      const photos = this.getTable('photos');
      const faces = this.getTable('faces');
      const exclusions = this.getTable('person_photos_excluded');

      const excludedPhotoIds = new Set<string>();
      for (const row of Array.from(exclusions.values())) {
        if (row.person_id === personId) {
          excludedPhotoIds.add(row.photo_id as string);
        }
      }

      const matchingPhotoIds = new Set<string>();
      for (const f of Array.from(faces.values())) {
        if (f.person_id === personId) {
          matchingPhotoIds.add(f.photo_id as string);
        }
      }

      const results: Record<string, unknown>[] = [];
      for (const p of Array.from(photos.values())) {
        if (!matchingPhotoIds.has(p.id as string)) continue;
        if (Number(p.excluded) === 1) continue;
        if (excludedPhotoIds.has(p.id as string)) continue;
        if (soloOnly && Number(p.face_count) !== 1) continue;
        results.push(p);
      }

      results.sort((a, b) => Number(a.taken_at) - Number(b.taken_at));
      return results as unknown as T[];
    }

    // SELECT f.* FROM faces f JOIN photos p ON f.photo_id = p.id WHERE p.trip_id = ? [AND f.quality_ok = 1]
    if (/FROM\s+faces\s+f\s+JOIN\s+photos\s+p/i.test(sql)) {
      const tripId = params[0] as string;
      const qualityOnly = /f\.quality_ok\s*=\s*1/i.test(sql);

      const faces = this.getTable('faces');
      const photos = this.getTable('photos');

      const tripPhotoIds = new Set<string>();
      for (const p of Array.from(photos.values())) {
        if (p.trip_id === tripId) {
          tripPhotoIds.add(p.id as string);
        }
      }

      const results: Record<string, unknown>[] = [];
      for (const f of Array.from(faces.values())) {
        if (tripPhotoIds.has(f.photo_id as string)) {
          if (qualityOnly && Number(f.quality_ok) !== 1) continue;
          results.push(f);
        }
      }
      return results as unknown as T[];
    }

    // Generic: SELECT ... FROM tableName [WHERE ...] [ORDER BY ...] [LIMIT ... [OFFSET ...]]
    const fromMatch = /FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(\?|[0-9]+)(?:\s+OFFSET\s+(\?|[0-9]+))?)?$/is.exec(sql);
    if (!fromMatch) return [];

    const tableName = fromMatch[1];
    const whereClause = fromMatch[2]?.trim();
    const orderClause = fromMatch[3]?.trim();
    const table = this.getTable(tableName);

    let rows = Array.from(table.values());

    if (whereClause) {
      rows = rows.filter((r) => this.evalWhere(whereClause, r, params));
    }

    if (orderClause) {
      if (/start_at\s+DESC/i.test(orderClause)) {
        rows.sort((a, b) => Number(b.start_at) - Number(a.start_at));
      } else if (/taken_at\s+ASC/i.test(orderClause)) {
        rows.sort((a, b) => Number(a.taken_at) - Number(b.taken_at));
      } else if (/created_at\s+DESC/i.test(orderClause)) {
        rows.sort((a, b) => Number(b.created_at) - Number(a.created_at));
      } else if (/is_others\s+ASC,\s*created_at\s+ASC/i.test(orderClause)) {
        rows.sort((a, b) => {
          const othersDiff = Number(a.is_others) - Number(b.is_others);
          if (othersDiff !== 0) return othersDiff;
          return Number(a.created_at) - Number(b.created_at);
        });
      } else if (/id\s+ASC/i.test(orderClause)) {
        rows.sort((a, b) => Number(a.id) - Number(b.id));
      } else if (/key\s+ASC/i.test(orderClause)) {
        rows.sort((a, b) => String(a.key).localeCompare(String(b.key)));
      }
    }

    if (fromMatch[4] !== undefined) {
      let limit: number;
      let offset = 0;
      if (fromMatch[5] !== undefined) {
        offset = fromMatch[5] === '?' ? Number(params[params.length - 1]) : Number(fromMatch[5]);
        limit = fromMatch[4] === '?' ? Number(params[params.length - 2]) : Number(fromMatch[4]);
      } else {
        limit = fromMatch[4] === '?' ? Number(params[params.length - 1]) : Number(fromMatch[4]);
      }
      rows = rows.slice(offset, offset + limit);
    }

    return rows as unknown as T[];
  }
}

export function createMockDatabase(name: string): MockDatabase {
  const engine = new InMemoryEngine();

  const mockDb: MockDatabase = {
    databaseName: name,
    execSync: jest.fn((sql: string) => {
      engine.execute(sql);
    }),
    execAsync: jest.fn(async (sql: string) => {
      engine.execute(sql);
    }),
    runSync: jest.fn((sql: string, params: unknown[] = []) => {
      return engine.execute(sql, params);
    }),
    runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      return engine.execute(sql, params);
    }),
    getFirstSync: jest.fn((sql: string, params: unknown[] = []) => {
      const rows = engine.query(sql, params);
      return rows.length > 0 ? rows[0] : null;
    }),
    getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      const rows = engine.query(sql, params);
      return rows.length > 0 ? rows[0] : null;
    }),
    getAllSync: jest.fn((sql: string, params: unknown[] = []) => {
      return engine.query(sql, params);
    }),
    getAllAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      return engine.query(sql, params);
    }),
    closeSync: jest.fn(),
    closeAsync: jest.fn().mockResolvedValue(undefined),
    withTransactionSync: jest.fn((cb: () => void) => cb()),
    withTransactionAsync: jest.fn(async (cb: () => Promise<void>) => await cb()),
    _tables: engine.tables,
    _clear: () => engine.reset(),
  };

  return mockDb;
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
