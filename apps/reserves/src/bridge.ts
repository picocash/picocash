/**
 * Bridge "Open Issuance Transparency" — the issuer-reported side of the
 * reconciliation. `GET https://transparency.bridge.xyz/v0/stablecoins/{slug}`
 * is public (no API key) and returns the issuer's own figures:
 *
 *   { last_updated, total_onchain_amount, total_reserve_amount,
 *     reserves: [{type: cash|treasury, amount}], collateralization_ratio }
 *
 * Two things we learned reading it and encode here rather than trust:
 *  - `total_onchain_amount` is across ALL chains the coin is on; reconciling
 *    it needs every chain's supply, not just Tempo's.
 *  - `reserves[]` does not always sum to `total_reserve_amount` (it appears to
 *    describe a pooled account). We treat the TOTAL as the attested figure and
 *    report the breakdown's consistency as its own check.
 *
 * Bridge's page says of itself that it is not an independent attestation; this
 * monitor is the independent reconciliation of those numbers against chains.
 */
export const BRIDGE_TRANSPARENCY = 'https://transparency.bridge.xyz/v0/stablecoins';

/** Ticker (as a TIP-20 reports `symbol()`) → Bridge slug. From Bridge's own page. */
export const BRIDGE_SLUGS: Record<string, string> = {
  afri: 'afri',
  cash: 'cash',
  clusd: 'clusd',
  dkusd: 'dkusd',
  dlusd: 'deel_usd',
  eurr: 'eurr',
  fnd: 'fnd',
  gdus: 'gdus',
  gusd: 'gusd',
  lavausd: 'lava_usd',
  mgusd: 'mgusd',
  musd: 'musd',
  ousd: 'ousd',
  pathusd: 'path_usd',
  pyreusd: 'pyre_usd',
  ripusd: 'ripusd',
  squsd: 'squsd',
  tako: 'tako',
  usd2: 'usd2',
  usdb: 'usdb',
  usdcbl: 'usdcbl',
  usdh: 'usdh',
  usds: 'usds_arq',
  usdsl: 'usdsl',
  usdsui: 'usd_sui',
  usdv: 'usdv',
  usdz: 'usdz',
};

export function bridgeSlugFor(symbol: string): string | null {
  return BRIDGE_SLUGS[symbol.toLowerCase()] ?? null;
}

/** Amounts in micro-units (6 decimals) as bigint — no floats on money. */
export interface IssuerReport {
  source: 'bridge';
  slug: string;
  lastUpdated: string;
  /** Issuer's total circulating supply, all chains. */
  reportedSupply: bigint;
  /** Issuer's total reserve figure. */
  reportedReserves: bigint;
  breakdown: Array<{ type: string; amount: bigint }>;
  /** Sum of the breakdown lines — compare to reportedReserves. */
  breakdownSum: bigint;
  collateralizationRatio: number;
  fetchedAt: string;
}

export class IssuerFetchError extends Error {}

/** "39370804.012684" → 39370804012684n (truncating beyond 6 decimals). */
export function toMicros(decimal: string | number): bigint {
  const s = typeof decimal === 'number' ? decimal.toFixed(6) : decimal.trim();
  const neg = s.startsWith('-');
  const [w, f = ''] = (neg ? s.slice(1) : s).split('.');
  if (!/^\d+$/.test(w!) || !/^\d*$/.test(f)) throw new IssuerFetchError(`bad decimal ${decimal}`);
  const v = BigInt(w!) * 1_000_000n + BigInt(f.slice(0, 6).padEnd(6, '0'));
  return neg ? -v : v;
}

export function parseIssuerReport(slug: string, json: unknown, fetchedAt = new Date().toISOString()): IssuerReport {
  const j = json as { last_updated?: string; total_onchain_amount?: string; total_reserve_amount?: string; reserves?: Array<{ type: string; amount: string }>; collateralization_ratio?: string };
  if (!j || typeof j.total_onchain_amount !== 'string' || typeof j.total_reserve_amount !== 'string') {
    throw new IssuerFetchError(`unexpected transparency payload for ${slug}`);
  }
  const breakdown = (j.reserves ?? []).map((r) => ({ type: String(r.type), amount: toMicros(r.amount) }));
  return {
    source: 'bridge',
    slug,
    lastUpdated: j.last_updated ?? '',
    reportedSupply: toMicros(j.total_onchain_amount),
    reportedReserves: toMicros(j.total_reserve_amount),
    breakdown,
    breakdownSum: breakdown.reduce((s, r) => s + r.amount, 0n),
    collateralizationRatio: Number(j.collateralization_ratio ?? 'NaN'),
    fetchedAt,
  };
}

export async function fetchIssuerReport(slug: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<IssuerReport> {
  const res = await fetchImpl(`${BRIDGE_TRANSPARENCY}/${slug}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new IssuerFetchError(`Bridge transparency ${slug}: HTTP ${res.status}`);
  return parseIssuerReport(slug, await res.json());
}
