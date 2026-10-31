/**
 * Symbol collisions. The TIP-20 factory is permissionless, so anyone can
 * deploy a token whose `symbol()` says "USDT" or "OUSD" — with any supply they
 * like. Recognition that keys on a symbol (an issuer's transparency slug, a
 * market listing) must be attributed to at most one token per symbol, and
 * "largest supply wins" is wrong: a spoof can mint a billion. The rule here is
 * **consistency with the reference figure**: a token is eligible to carry a
 * symbol's recognition only if its live Tempo supply does not exceed the
 * reference — the issuer's cross-chain total (a hard bound: the issuer's own,
 * fresh figure) or the market's Tempo figure (a soft bound: DefiLlama lags a
 * day, and a coin can grow a lot in a day). Among eligible holders the one
 * closest to the reference is canonical. A lone holder is held to the same
 * test — a $1B "USDT" is not the listed asset just because nothing else
 * claims the name. With no reference at all, the largest supply is the fallback.
 * Every other holder of the symbol is a look-alike: symbol-bound recognition
 * is stripped and a red check says why.
 */
import type { Check } from './checks.js';

export type TrackReason = 'attested' | 'listed' | 'major' | 'active' | 'collision';

export interface Collidable {
  address: string;
  symbol: string;
  tempoSupply: bigint;
  tracked: TrackReason[];
}

export interface Resolved<T extends Collidable> {
  token: T;
  canonical: boolean;
  /** Other tracked tokens reporting the same symbol. */
  others: string[];
  /** Canonical holder's address when this token is not it (undefined if no holder qualified). */
  canonicalAddress?: string;
  /** How canonical was decided, for the detail text. */
  basis: 'reference' | 'largest' | 'unique';
  reference?: Reference;
}

const SYMBOL_BOUND = new Set<TrackReason>(['attested', 'listed', 'major']);
/** Over the issuer's own total: mint/burn timing only. */
const OVER_ISSUER_BPS = 100n;
/** Over the market's Tempo figure: DefiLlama is daily and a young coin can double in a day. */
const OVER_MARKET_BPS = 10_000n;

export interface Reference {
  /** Expected Tempo supply for this symbol (micro-units), if any source gives one. */
  tempoSupply?: bigint;
  /** Issuer's total across all chains — an upper bound on any single chain's supply. */
  issuerTotal?: bigint;
}

function abs(x: bigint) {
  return x < 0n ? -x : x;
}

function eligible(t: Collidable, ref: Reference): boolean {
  if (ref.issuerTotal !== undefined && ref.issuerTotal > 0n) return t.tempoSupply * 10_000n <= ref.issuerTotal * (10_000n + OVER_ISSUER_BPS);
  if (ref.tempoSupply !== undefined && ref.tempoSupply > 0n) return t.tempoSupply * 10_000n <= ref.tempoSupply * (10_000n + OVER_MARKET_BPS);
  return true;
}

function hasReference(ref: Reference | undefined): ref is Reference {
  return !!ref && ((ref.issuerTotal ?? 0n) > 0n || (ref.tempoSupply ?? 0n) > 0n);
}

function pickCanonical<T extends Collidable>(group: T[], ref: Reference | undefined): { token: T | null; basis: Resolved<T>['basis'] } {
  if (hasReference(ref)) {
    const ok = group.filter((t) => eligible(t, ref));
    if (!ok.length) return { token: null, basis: 'reference' };
    const target = ref.tempoSupply ?? ref.issuerTotal!;
    return { token: ok.reduce((best, t) => (abs(t.tempoSupply - target) < abs(best.tempoSupply - target) ? t : best)), basis: 'reference' };
  }
  if (group.length === 1) return { token: group[0]!, basis: 'unique' };
  return { token: group.reduce((best, t) => (t.tempoSupply > best.tempoSupply ? t : best)), basis: 'largest' };
}

export function resolveCollisions<T extends Collidable>(tokens: T[], references: Map<string, Reference> = new Map()): Resolved<T>[] {
  const bySymbol = new Map<string, T[]>();
  for (const t of tokens) {
    const key = t.symbol.trim().toLowerCase();
    if (!key) continue;
    bySymbol.set(key, [...(bySymbol.get(key) ?? []), t]);
  }
  // Attribution only matters where a symbol carries recognition or has a reference
  // figure. Two yield wrappers that happen to share a symbol are neither's look-alike.
  const contested = (sym: string, group: T[]) => hasReference(references.get(sym)) || group.some((t) => t.tracked.some((r) => SYMBOL_BOUND.has(r)));
  const canonicalBySymbol = new Map<string, { token: T | null; basis: Resolved<T>['basis'] }>();
  for (const [sym, group] of bySymbol) if (contested(sym, group)) canonicalBySymbol.set(sym, pickCanonical(group, references.get(sym)));
  return tokens.map((t) => {
    const key = t.symbol.trim().toLowerCase();
    const group = bySymbol.get(key) ?? [t];
    const pick = canonicalBySymbol.get(key);
    if (!pick) return { token: t, canonical: true, others: [], basis: 'unique' as const };
    const canonical = pick.token?.address === t.address;
    if (!canonical) t.tracked = [...t.tracked.filter((r) => !SYMBOL_BOUND.has(r) && r !== 'collision'), 'collision'];
    const ref = references.get(key);
    return {
      token: t,
      canonical,
      others: group.filter((x) => x.address !== t.address).map((x) => x.address),
      ...(!canonical && pick.token ? { canonicalAddress: pick.token.address } : {}),
      basis: pick.basis,
      ...(ref ? { reference: ref } : {}),
    };
  });
}

const usd = (micros: bigint) => `$${(micros / 1_000_000n).toLocaleString('en-US')}`;

export function collisionCheck(r: Resolved<Collidable>): Check | null {
  const n = r.others.length;
  const list = r.others.map((a) => a.slice(0, 10) + '…').join(', ');
  const refText = r.reference?.issuerTotal !== undefined ? `the issuer reports ${usd(r.reference.issuerTotal)} outstanding across all chains` : r.reference?.tempoSupply !== undefined ? `the market puts this symbol's Tempo supply at ${usd(r.reference.tempoSupply)}` : null;
  if (r.canonical) {
    if (n === 0) return null;
    return {
      id: 'symbol_collision',
      label: 'Symbol is unique among tracked tokens',
      ok: true,
      detail: `${n} other token${n > 1 ? 's' : ''} also report${n > 1 ? '' : 's'} symbol "${r.token.symbol}" (${list}); this address is treated as canonical because its supply ${r.basis === 'reference' ? 'is consistent with the reference figure' : 'is the largest and no reference figure exists'}`,
    };
  }
  return {
    id: 'symbol_collision',
    label: 'Token is the asset its symbol names',
    ok: false,
    detail: r.canonicalAddress
      ? `shares symbol "${r.token.symbol}" with the canonical token ${r.canonicalAddress} — this is NOT the attested or listed asset; treat as a look-alike`
      : `reports symbol "${r.token.symbol}" with ${usd(r.token.tempoSupply)} on Tempo, but ${refText ?? 'no reference figure supports it'} — this is NOT the attested or listed asset; treat as a look-alike`,
  };
}
