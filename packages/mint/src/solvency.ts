import type { Db } from './db.js';

/**
 * Outstanding token supply for a keyset, from the mint's own ledgers:
 *
 *   outstanding = Σ issued blind signatures − Σ spent secrets
 *
 * Swaps add equal amounts to both sides (net zero), mints only issue, melts
 * only spend — so this is exactly the vault liability. The solvency invariant
 * (spec/05) is: vault balance ≥ this number.
 */
export async function computeOutstanding(db: Db, keysetId: string): Promise<number> {
  const issued = await db.query<{ total: string | number | null }>(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM blind_signatures WHERE keyset_id = $1',
    [keysetId],
  );
  const spent = await db.query<{ total: string | number | null }>(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM spent_secrets WHERE keyset_id = $1',
    [keysetId],
  );
  return Number(issued.rows[0]?.total ?? 0) - Number(spent.rows[0]?.total ?? 0);
}
