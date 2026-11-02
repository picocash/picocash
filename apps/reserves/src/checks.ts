/**
 * Reconciliation checks — each is a statement that SHOULD hold, evaluated from
 * numbers the reader can see, with the delta stated plainly when it does not.
 * `ok: null` means "we do not have the data to say", never "fine".
 *
 * Same discipline as the picocash mint status page: a check is either a
 * green statement, a red statement with the gap in dollars, or an honest grey.
 */
import type { IssuerReport } from './bridge.js';

export interface Check {
  id: string;
  label: string;
  ok: boolean | null;
  detail: string;
}

export interface TokenFacts {
  symbol: string;
  decimals: number;
  /** Tempo on-chain totalSupply, micro-units. */
  tempoSupply: bigint;
  supplyCap: bigint;
  paused: boolean;
  /** Other chains' circulating supply in USD (DefiLlama), excluding Tempo. */
  otherChains: Array<{ chain: string; usd: number }>;
  issuer: IssuerReport | null;
  /** Seconds since the issuer's `last_updated`. */
  issuerAgeSeconds: number | null;
}

const USD = (micros: bigint, decimals = 6) => {
  const neg = micros < 0n;
  const v = neg ? -micros : micros;
  const w = v / 10n ** BigInt(decimals);
  const f = (v % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').slice(0, 2);
  return `${neg ? '−' : ''}$${w.toLocaleString('en-US')}.${f}`;
};
const pct = (num: bigint, den: bigint) => (den === 0n ? '—' : `${(Number((num * 1_000_000n) / den) / 10_000).toFixed(3)}%`);
const abs = (x: bigint) => (x < 0n ? -x : x);

/** Relative tolerance in basis points of the larger figure (0.1% across chains for DefiLlama pricing/timing skew; 0.01% single-chain). */
function within(a: bigint, b: bigint, bps: bigint): boolean {
  const base = a > b ? a : b;
  return abs(a - b) * 10_000n <= base * bps;
}

/**
 * Issuers report reserves to the cent while on-chain supply carries six
 * decimals, so a strict ≥ can fail by a fraction of a cent (pathUSD: reserves
 * $…804.01 vs supply $…804.012684). A shortfall under one cent is rounding,
 * not under-backing — and we say which it was.
 */
const ONE_CENT = 10_000n;
function covers(reserves: bigint, supply: bigint): { ok: boolean; rounding: boolean } {
  if (reserves >= supply) return { ok: true, rounding: false };
  return { ok: supply - reserves <= ONE_CENT, rounding: supply - reserves <= ONE_CENT };
}

export function runChecks(t: TokenFacts): Check[] {
  const checks: Check[] = [];
  const otherUsd = t.otherChains.reduce((s, c) => s + c.usd, 0);
  const otherMicros = BigInt(Math.round(otherUsd * 1e6));
  const allChains = t.tempoSupply + otherMicros;
  const multiChain = t.otherChains.length > 0;

  // 1. Attested reserves cover the issuer's own total supply.
  if (t.issuer) {
    const c = covers(t.issuer.reportedReserves, t.issuer.reportedSupply);
    const diff = t.issuer.reportedReserves - t.issuer.reportedSupply;
    checks.push({
      id: 'reserves_cover_supply',
      label: 'Issuer-reported reserves ≥ issuer-reported supply',
      ok: c.ok,
      detail: `${USD(t.issuer.reportedReserves)} reserves vs ${USD(t.issuer.reportedSupply)} supply → ${c.rounding ? `equal within cent rounding (reserves reported to $0.01; difference ${USD(abs(diff))})` : diff >= 0n ? `surplus ${USD(diff)}` : `SHORTFALL ${USD(abs(diff))}`} (ratio ${t.issuer.collateralizationRatio.toFixed(4)})`,
    });
  } else {
    checks.push({ id: 'reserves_cover_supply', label: 'Issuer-reported reserves ≥ supply', ok: null, detail: 'no public issuer attestation source for this token' });
  }

  // 2. What the issuer says is outstanding vs what the chains we can see say exists.
  //    The issuer's total spans every chain the coin is on; we see Tempo directly and
  //    other chains only through DefiLlama. Tempo is stated first — it is the figure
  //    we read ourselves — and the cross-chain sum second, as the reconciliation. So:
  //      Tempo alone > issuer                   → RED: more exists on Tempo than the issuer admits anywhere
  //      chain  >  issuer (beyond tolerance)    → RED: more exists than the issuer admits
  //      chain  ≈  issuer                       → green (exact to the micro-unit, or within tolerance)
  //      chain  <  issuer, no other legs seen   → GREY: the remainder lives on chains we cannot observe
  //      chain  <  issuer, other legs seen      → RED: the legs we can see do not add up
  if (t.issuer) {
    const gap = allChains - t.issuer.reportedSupply; // >0 means chain holds more than issuer reports
    const tol = within(allChains, t.issuer.reportedSupply, 10n);
    const exact = gap === 0n;
    const tempoShare = pct(t.tempoSupply, t.issuer.reportedSupply);
    let ok: boolean | null;
    let verdict: string;
    if (t.tempoSupply > t.issuer.reportedSupply && !within(t.tempoSupply, t.issuer.reportedSupply, 1n)) {
      ok = false;
      verdict = `Tempo alone EXCEEDS the issuer's total by ${USD(t.tempoSupply - t.issuer.reportedSupply)} — more exists on Tempo than is reported anywhere`;
    } else if (tol) {
      ok = true;
      verdict = exact ? 'equal to the micro-unit' : `within tolerance (gap ${USD(abs(gap))}, ${pct(abs(gap), t.issuer.reportedSupply)})`;
    } else if (multiChain && within(allChains, t.issuer.reportedSupply, 200n)) {
      // Other-chain figures are third-party (DefiLlama) and lag issuer mints and burns; a gap this small cannot support a public accusation.
      ok = null;
      verdict = `inconclusive: a ${pct(abs(gap), t.issuer.reportedSupply)} gap (${USD(abs(gap))}) against third-party other-chain figures, which lag issuer mints and burns`;
    } else if (gap > 0n) {
      ok = false;
      verdict = `on-chain EXCEEDS the issuer's figure by ${USD(gap)} — more exists than is reported`;
    } else if (!multiChain && t.tempoSupply > 0n) {
      ok = null;
      verdict = `issuer reports ${USD(abs(gap))} more than is on Tempo; that remainder is on chains this monitor cannot observe (no other-chain data for this coin)`;
    } else if (t.tempoSupply === 0n && !multiChain) {
      ok = null;
      verdict = 'not deployed with supply on Tempo; the issuer figure describes other chains';
    } else {
      ok = false;
      verdict = `the chains we can see hold ${USD(abs(gap))} less than the issuer reports (${pct(abs(gap), t.issuer.reportedSupply)})`;
    }
    const detail = multiChain
      ? `Tempo ${USD(t.tempoSupply)} is ${tempoShare} of the issuer's ${USD(t.issuer.reportedSupply)} (all chains). Across all chains: Tempo + ${t.otherChains.map((c) => `${c.chain} $${Math.round(c.usd).toLocaleString('en-US')}`).join(' + ')} = ${USD(allChains)} vs issuer → ${verdict}`
      : `Tempo ${USD(t.tempoSupply)} vs issuer ${USD(t.issuer.reportedSupply)} → ${verdict}`;
    checks.push({
      id: 'supply_matches_chain',
      label: multiChain ? 'Issuer-reported supply accounts for Tempo on-chain supply (reconciled across all chains)' : 'Issuer-reported supply matches Tempo on-chain supply',
      ok,
      detail,
    });
  } else {
    checks.push({ id: 'supply_matches_chain', label: 'Issuer-reported supply matches on-chain supply', ok: null, detail: 'no issuer figure to compare' });
  }

  // 3. Reserves cover what is on Tempo — stated first — and, for multi-chain coins,
  //    what is on every chain we can see; the latter decides the verdict.
  if (t.issuer) {
    if (t.tempoSupply === 0n && !multiChain) {
      checks.push({ id: 'reserves_cover_chain', label: 'Issuer-reported reserves ≥ on-chain supply', ok: null, detail: 'no supply on Tempo to cover' });
    } else {
      const describe = (supply: bigint) => {
        const c = covers(t.issuer!.reportedReserves, supply);
        const diff = t.issuer!.reportedReserves - supply;
        return { ok: c.ok, text: c.rounding ? `covered within cent rounding (difference ${USD(abs(diff))})` : diff >= 0n ? `covered, surplus ${USD(diff)}` : `UNDER-BACKED by ${USD(abs(diff))}` };
      };
      const tempo = describe(t.tempoSupply);
      const all = describe(allChains);
      checks.push({
        id: 'reserves_cover_chain',
        label: multiChain ? 'Issuer-reported reserves ≥ Tempo on-chain supply (and all chains together)' : 'Issuer-reported reserves ≥ Tempo on-chain supply',
        // Tempo is read directly; the all-chain sum leans on lagging third-party data, so a small shortfall there is inconclusive, not a finding.
        ok: !all.ok && tempo.ok && multiChain && within(allChains, t.issuer.reportedReserves, 200n) ? null : all.ok,
        detail: multiChain
          ? `${USD(t.issuer.reportedReserves)} reserves vs ${USD(t.tempoSupply)} on Tempo → ${tempo.text}. Across all chains ${USD(allChains)} → ${!all.ok && tempo.ok && within(allChains, t.issuer.reportedReserves, 200n) ? `inconclusive: ${USD(allChains - t.issuer.reportedReserves)} over reserves using third-party other-chain figures, which lag issuer mints and burns` : all.text}`
          : `${USD(t.issuer.reportedReserves)} vs ${USD(t.tempoSupply)} on Tempo → ${tempo.text}`,
      });
    }
  } else {
    checks.push({ id: 'reserves_cover_chain', label: 'Issuer-reported reserves ≥ on-chain supply', ok: null, detail: 'no issuer figure' });
  }

  // 4. Issuer data is fresh.
  checks.push({
    id: 'issuer_fresh',
    label: 'Issuer attestation updated within 24 h',
    ok: t.issuerAgeSeconds === null ? null : t.issuerAgeSeconds <= 86_400,
    detail: t.issuerAgeSeconds === null ? 'no issuer feed' : `last updated ${formatAge(t.issuerAgeSeconds)} ago`,
  });

  // 5. The issuer's own breakdown adds up to its total. When it does not, the
  //    breakdown is describing something other than this coin (Bridge publishes
  //    a pooled account's cash/treasury split), so the composition of THIS
  //    coin's reserves cannot be verified from it — grey, with the numbers shown.
  //    It is not evidence of under-backing; checks 1–3 use the total.
  if (t.issuer) {
    const consistent = within(t.issuer.breakdownSum, t.issuer.reportedReserves, 1n);
    checks.push({
      id: 'breakdown_consistent',
      label: 'Issuer reserve breakdown sums to the reported total',
      ok: consistent ? true : null,
      detail: consistent
        ? `${t.issuer.breakdown.map((b) => `${b.type} ${USD(b.amount)}`).join(' + ')} = ${USD(t.issuer.breakdownSum)}`
        : `${t.issuer.breakdown.map((b) => `${b.type} ${USD(b.amount)}`).join(' + ')} = ${USD(t.issuer.breakdownSum)}, but total reported is ${USD(t.issuer.reportedReserves)} — the breakdown appears to describe a pooled account, so this coin's reserve composition cannot be verified from it`,
    });
  }

  // 6. Protocol-level sanity on Tempo.
  checks.push({
    id: 'under_cap',
    label: 'Supply within the on-chain supply cap',
    ok: t.supplyCap === 0n ? null : t.tempoSupply <= t.supplyCap,
    detail: t.supplyCap === 0n ? 'no cap read' : t.supplyCap >= 2n ** 120n ? 'cap is effectively unlimited (default)' : `${USD(t.tempoSupply)} of ${USD(t.supplyCap)} cap (${pct(t.tempoSupply, t.supplyCap)})`,
  });
  checks.push({ id: 'not_paused', label: 'Token is not paused', ok: !t.paused, detail: t.paused ? 'transfers are PAUSED by the issuer' : 'transfers enabled' });

  return checks;
}

export function formatAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} d`;
}

export { USD as formatUsd };
