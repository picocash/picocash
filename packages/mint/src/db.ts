import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

/**
 * Minimal SQL surface shared by node-postgres (production, DATABASE_URL) and
 * PGlite (embedded Postgres — dev server and tests). Both give real Postgres
 * semantics; the spent-secret ledger's PRIMARY KEY is the security model.
 * All byte values are stored as lowercase hex TEXT.
 */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS keysets (
  id TEXT PRIMARY KEY,
  unit TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mint_quotes (
  id TEXT PRIMARY KEY,
  amount BIGINT NOT NULL CHECK (amount > 0),
  unit TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'UNPAID',
  deposit_ref TEXT,
  expires_at BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The double-spend ledger. PRIMARY KEY on y + insert-before-sign inside one
-- transaction IS the runtime security model (architecture.md).
CREATE TABLE IF NOT EXISTS spent_secrets (
  y TEXT PRIMARY KEY,
  keyset_id TEXT NOT NULL,
  amount BIGINT NOT NULL,
  spent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS melt_quotes (
  id TEXT PRIMARY KEY,
  amount BIGINT NOT NULL CHECK (amount > 0),
  unit TEXT NOT NULL,
  to_address TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'UNPAID',
  inputs_hash TEXT,
  tx_hash TEXT,
  expires_at BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every issued blind signature. PRIMARY KEY on b makes each B_ single-use
-- globally and gives /v1/mint its idempotent replay.
CREATE TABLE IF NOT EXISTS blind_signatures (
  b TEXT PRIMARY KEY,
  keyset_id TEXT NOT NULL,
  amount BIGINT NOT NULL,
  c TEXT NOT NULL,
  dleq_e TEXT NOT NULL,
  dleq_s TEXT NOT NULL,
  quote_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function migrate(db: Db): Promise<void> {
  // Strip line comments before splitting so a ';' in a comment can't shear a statement.
  const bare = SCHEMA.replace(/^\s*--.*$/gm, '');
  for (const statement of bare.split(';')) {
    const sql = statement.trim();
    if (sql) await db.query(sql);
  }
}
