import type { Db, Queryable } from '../db-core.js';

/**
 * Db over Durable Object SQLite storage. The mint's SQL is written in the
 * Postgres dialect (pg / PGlite); this adapter translates the small surface
 * the mint actually uses. Keep the shim honest: anything not covered here
 * should be added explicitly, not papered over.
 */

/** Minimal slice of DurableObjectStorage we depend on (keeps this file testable without the runtime). */
export interface DoStorageLike {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
  transaction<T>(closure: () => Promise<T>): Promise<T>;
}

export function translate(sql: string, params: unknown[] = []): { sql: string; bindings: unknown[] } {
  let out = sql;
  // Postgres-isms with no SQLite equivalent or a different spelling
  out = out.replace(/::int\b/g, '');
  out = out.replace(/\bFOR UPDATE\b/g, ''); // DO is single-threaded; the transaction provides isolation
  out = out.replace(/\bTIMESTAMPTZ\b/g, 'TEXT');
  out = out.replace(/\bnow\(\)/g, 'CURRENT_TIMESTAMP');
  out = out.replace(/ADD COLUMN IF NOT EXISTS/g, 'ADD COLUMN'); // duplicate-column error swallowed by the caller
  // $n placeholders → ? in order of appearance (queries may reference $2 before $1)
  const bindings: unknown[] = [];
  out = out.replace(/\$(\d+)/g, (_, n: string) => {
    bindings.push(params[Number(n) - 1]);
    return '?';
  });
  return { sql: out, bindings };
}

export function createDoDb(storage: DoStorageLike): Db {
  const queryable: Queryable = {
    query: async <R,>(sql: string, params?: unknown[]) => {
      const t = translate(sql, params ?? []);
      try {
        return { rows: storage.sql.exec(t.sql, ...t.bindings).toArray() as R[] };
      } catch (err) {
        // SQLite has no ADD COLUMN IF NOT EXISTS; treat "already exists" as success.
        if (/ADD COLUMN/i.test(t.sql) && /duplicate column/i.test(String(err))) return { rows: [] as R[] };
        throw err;
      }
    },
  };
  return {
    query: queryable.query,
    // storage.transaction() accepts an async closure and rolls back on throw —
    // sql.exec() calls inside it are part of the transaction.
    tx: (fn) => storage.transaction(() => fn(queryable)),
    close: async () => {},
  };
}
