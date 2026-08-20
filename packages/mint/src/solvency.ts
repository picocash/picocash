import type { Queryable } from './db-core.js';

/**
 * Outstanding token supply for a keyset, from the mint's own ledgers:
 *
 *   outstanding = Σ issued blind signatures − Σ spent secrets
 *
 * Swaps add equal amounts to both sides (net zero), mints only issue, melts
 * only spend — so this is exactly the vault liability. The solvency invariant
 * (PIP-04) is: vault balance ≥ this number.
 */
export async function computeOutstanding(db: Queryable, keysetId: string): Promise<number> {
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

/**
 * Capacity already promised but not yet issued: unexpired quotes in UNPAID or
 * PAID state. The outstanding cap must count these, or an attacker opens many
 * quotes while supply is low and funds them all later (review P0-4).
 */
export async function computeReserved(db: Queryable, nowSeconds: number): Promise<number> {
  const r = await db.query<{ total: string | number | null }>(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM mint_quotes WHERE state IN ('UNPAID', 'PAID') AND expires_at >= $1",
    [nowSeconds],
  );
  return Number(r.rows[0]?.total ?? 0);
}
