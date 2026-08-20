import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { Db } from './db-core.js';

export { migrate, type Db, type Queryable } from './db-core.js';

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  return {
    query: async <R,>(sql: string, params?: unknown[]) => {
      const res = await pool.query(sql, params as unknown[]);
      return { rows: res.rows as R[] };
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async <R,>(sql: string, params?: unknown[]) => {
            const res = await client.query(sql, params as unknown[]);
            return { rows: res.rows as R[] };
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** `dataDir` undefined → in-memory (tests). A path persists across restarts (dev server). */
export function createPgliteDb(dataDir?: string): Db {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  return {
    query: async <R,>(sql: string, params?: unknown[]) => {
      const res = await lite.query(sql, params as unknown[]);
      return { rows: res.rows as R[] };
    },
    tx: (fn) =>
      lite.transaction(async (t) =>
        fn({
          query: async <R,>(sql: string, params?: unknown[]) => {
            const res = await t.query(sql, params as unknown[]);
            return { rows: res.rows as R[] };
          },
        }),
      ),
    close: () => lite.close(),
  };
}

