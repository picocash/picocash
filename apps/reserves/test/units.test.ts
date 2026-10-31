import { describe, expect, it } from 'vitest';
import { bridgeSlugFor, parseIssuerReport, toMicros } from '../src/bridge.js';
import { decodeString, selector, topic } from '../src/chain.js';
import { runChecks } from '../src/checks.js';
import { matchLlama } from '../src/llama.js';
import { HISTORY_POINTS, MemoryKv, Store } from '../src/store.js';

// Real payloads captured from transparency.bridge.xyz on 2026-10-31.
const PATH_USD = { last_updated: '2026-10-31T21:20:33Z', total_onchain_amount: '39370804.012684', total_reserve_amount: '39370804.01', reserves: [{ type: 'cash', amount: '9649732.92' }, { type: 'treasury', amount: '54648585.55' }], collateralization_ratio: '1.0' };
const OUSD = { last_updated: '2026-10-31T21:20:32Z', total_onchain_amount: '893248150.03664', total_reserve_amount: '895248267.45', reserves: [{ type: 'cash', amount: '108625475.1' }, { type: 'treasury', amount: '784625164.51' }], collateralization_ratio: '1.0022' };

describe('bridge parsing', () => {
  it('converts decimals to micro-units exactly (no floats)', () => {
    expect(toMicros('39370804.012684')).toBe(39370804012684n);
    expect(toMicros('893248150.03664')).toBe(893248150036640n);
    expect(toMicros('1.0')).toBe(1000000n);
    expect(toMicros('0')).toBe(0n);
    expect(() => toMicros('abc')).toThrow();
  });
  it('parses a report and sums the breakdown separately from the total', () => {
    const r = parseIssuerReport('path_usd', PATH_USD, '2026-10-31T22:00:00Z');
    expect(r.reportedSupply).toBe(39370804012684n);
    expect(r.reportedReserves).toBe(39370804010000n);
    expect(r.breakdownSum).toBe(64298318470000n); // 9,649,732.92 + 54,648,585.55 — does NOT equal the total
    expect(r.collateralizationRatio).toBe(1);
  });
  it('maps TIP-20 symbols to Bridge slugs case-insensitively', () => {
    expect(bridgeSlugFor('pathUSD')).toBe('path_usd');
    expect(bridgeSlugFor('DLUSD')).toBe('deel_usd');
    expect(bridgeSlugFor('OUSD')).toBe('ousd');
    expect(bridgeSlugFor('USDC.e')).toBeNull();
  });
});

describe('chain helpers', () => {
  it('derives the selectors and topics the monitor relies on', () => {
    expect(selector('transferWithMemo(address,uint256,bytes32)')).toBe('0x95777d59');
    expect(topic('Mint(address,uint256)')).toBe('0x0f6798a560793a54c3bcfe86a93cde1e73087d944c0ea20544137d4121396885');
    expect(topic('Burn(address,uint256)')).toBe('0xcc16f5dbb4873280815c1ee09dbd06736cffcc184412cf7a71a0fdb75d397ca5');
  });
  it('decodes ABI strings', () => {
    // "pathUSD"
    const hex = '0x' + '20'.padStart(64, '0') + '7'.padStart(64, '0') + Buffer.from('pathUSD').toString('hex').padEnd(64, '0');
    expect(decodeString(hex)).toBe('pathUSD');
    expect(decodeString('0x')).toBe('');
  });
});

describe('checks', () => {
  const base = { symbol: 'pathUSD', decimals: 6, supplyCap: 2n ** 128n - 1n, paused: false, otherChains: [] as Array<{ chain: string; usd: number }> };
  it('pathUSD: on-chain equals issuer to the micro-unit → all green', () => {
    const issuer = parseIssuerReport('path_usd', PATH_USD);
    const checks = runChecks({ ...base, tempoSupply: 39370804012684n, issuer, issuerAgeSeconds: 600 });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.reserves_cover_supply!.ok).toBe(true);
    expect(byId.supply_matches_chain!.ok).toBe(true);
    expect(byId.reserves_cover_chain!.ok).toBe(true);
    expect(byId.issuer_fresh!.ok).toBe(true);
    expect(byId.breakdown_consistent!.ok).toBeNull(); // the real data quirk: surfaced as unverifiable, not as a failure
    expect(byId.breakdown_consistent!.detail).toMatch(/pooled account/);
    expect(byId.under_cap!.detail).toMatch(/unlimited/);
    expect(byId.not_paused!.ok).toBe(true);
  });
  it('OUSD: multi-chain sum reconciles within tolerance; surplus reported', () => {
    const issuer = parseIssuerReport('ousd', OUSD);
    const other = [{ chain: 'Ethereum', usd: 120_200_000 }, { chain: 'Base', usd: 92_200_000 }, { chain: 'Solana', usd: 80_700_000 }];
    const checks = runChecks({ ...base, symbol: 'OUSD', tempoSupply: 599_800_000_000_000n, otherChains: other, issuer, issuerAgeSeconds: 100 });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.supply_matches_chain!.ok).toBe(true); // 892.9M vs 893.25M within 0.1%
    expect(byId.supply_matches_chain!.label).toMatch(/across all chains/);
    expect(byId.reserves_cover_supply!.detail).toMatch(/surplus \$2,000,117/);
  });
  it('a real shortfall is red with the gap in dollars', () => {
    const issuer = parseIssuerReport('x', { ...PATH_USD, total_reserve_amount: '39000000.00' });
    const checks = runChecks({ ...base, tempoSupply: 39370804012684n, issuer, issuerAgeSeconds: 600 });
    const c = checks.find((x) => x.id === 'reserves_cover_supply')!;
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/SHORTFALL \$370,804/);
  });
  it('supply vs chain: chain > issuer is red; issuer > chain with no other legs is grey; stale feed is red; no issuer is grey', () => {
    // Issuer reports LESS than is on Tempo → more exists than reported → red.
    const under = parseIssuerReport('x', { ...PATH_USD, total_onchain_amount: '39000000.00', total_reserve_amount: '39000000.00' });
    const red = runChecks({ ...base, tempoSupply: 39370804012684n, issuer: under, issuerAgeSeconds: 3 * 86400 });
    const sm = red.find((x) => x.id === 'supply_matches_chain')!;
    expect(sm.ok).toBe(false);
    expect(sm.detail).toMatch(/EXCEEDS/);
    expect(red.find((x) => x.id === 'issuer_fresh')!.ok).toBe(false);

    // Issuer reports MORE than is on Tempo and we see no other chains → cannot judge → grey, says why.
    const over = parseIssuerReport('x', { ...PATH_USD, total_onchain_amount: '122935131.07', total_reserve_amount: '122935131.07' });
    const grey = runChecks({ ...base, symbol: 'USDB', tempoSupply: 40_374_758_120_000n, issuer: over, issuerAgeSeconds: 60 });
    const g = grey.find((x) => x.id === 'supply_matches_chain')!;
    expect(g.ok).toBeNull();
    expect(g.detail).toMatch(/cannot observe/);

    // Attested but zero supply on Tempo → chain checks grey, not red.
    const zero = runChecks({ ...base, symbol: 'GUSD', tempoSupply: 0n, issuer: over, issuerAgeSeconds: 60 });
    expect(zero.find((x) => x.id === 'supply_matches_chain')!.ok).toBeNull();
    expect(zero.find((x) => x.id === 'reserves_cover_chain')!.ok).toBeNull();

    // Multi-chain but the visible legs fall short → red.
    const short = runChecks({ ...base, symbol: 'OUSD', tempoSupply: 100_000_000_000_000n, otherChains: [{ chain: 'Base', usd: 1_000_000 }], issuer: parseIssuerReport('ousd', OUSD), issuerAgeSeconds: 60 });
    expect(short.find((x) => x.id === 'supply_matches_chain')!.ok).toBe(false);

    const none = runChecks({ ...base, symbol: 'USDC.e', tempoSupply: 1n, issuer: null, issuerAgeSeconds: null });
    expect(none.filter((c) => c.ok === null).length).toBeGreaterThanOrEqual(4);
  });
  it('paused and over-cap are red', () => {
    const checks = runChecks({ ...base, tempoSupply: 10n, supplyCap: 5n, paused: true, issuer: null, issuerAgeSeconds: null });
    expect(checks.find((x) => x.id === 'under_cap')!.ok).toBe(false);
    expect(checks.find((x) => x.id === 'not_paused')!.ok).toBe(false);
  });
});

describe('store', () => {
  it('history appends at most hourly and caps at 90 days', async () => {
    const store = new Store(new MemoryKv());
    const p = (t: number) => ({ t, block: t, tempoSupply: '1', reportedSupply: null, reportedReserves: null, status: 'unattested' as const });
    expect(await store.appendHistory('0xabc', p(1000))).toBe(true);
    expect(await store.appendHistory('0xabc', p(1000 + 600))).toBe(false); // 10 min later: skipped
    expect(await store.appendHistory('0xabc', p(1000 + 3600))).toBe(true);
    for (let i = 0; i < HISTORY_POINTS + 50; i++) await store.appendHistory('0xabc', p(100_000 + i * 3600));
    expect((await store.getHistory('0xabc')).length).toBe(HISTORY_POINTS);
  });
  it('registry round-trips', async () => {
    const store = new Store(new MemoryKv());
    expect((await store.getRegistry()).lastScannedBlock).toBe(-1);
    await store.putRegistry({ tokens: [{ address: '0x1', createdBlock: 5 }], lastScannedBlock: 10, updatedAt: 'x' });
    expect((await store.getRegistry()).tokens[0]!.createdBlock).toBe(5);
  });
});

describe('symbol collisions', () => {
  it('with no reference, the largest holder is canonical and look-alikes are flagged', async () => {
    const { resolveCollisions, collisionCheck } = await import('../src/collisions.js');
    const real = { address: '0xaaa', symbol: 'USDC.e', tempoSupply: 26_000_000_000_000n, tracked: ['major', 'active'] as any[] };
    const fake1 = { address: '0xbbb', symbol: 'USDC.e', tempoSupply: 350_000_000n, tracked: ['major', 'active'] as any[] };
    const fake2 = { address: '0xccc', symbol: 'usdc.e', tempoSupply: 0n, tracked: ['major'] as any[] };
    const other = { address: '0xddd', symbol: 'OUSD', tempoSupply: 1n, tracked: ['attested'] as any[] };
    const res = resolveCollisions([real, fake1, fake2, other]);
    const byAddr = Object.fromEntries(res.map((r) => [r.token.address, r]));
    expect(byAddr['0xaaa']!.canonical).toBe(true);
    expect(byAddr['0xaaa']!.basis).toBe('largest');
    expect(byAddr['0xaaa']!.token.tracked).toEqual(['major', 'active']);
    expect(byAddr['0xbbb']!.token.tracked).toEqual(['active', 'collision']);
    expect(byAddr['0xccc']!.token.tracked).toEqual(['collision']);
    expect(byAddr['0xddd']!.others).toEqual([]);
    expect(collisionCheck(byAddr['0xbbb']!)!.ok).toBe(false);
    expect(collisionCheck(byAddr['0xbbb']!)!.detail).toContain('0xaaa');
    expect(collisionCheck(byAddr['0xaaa']!)!.ok).toBe(true);
    expect(collisionCheck(byAddr['0xddd']!)).toBeNull();
  });
  it('with a reference figure, a billion-dollar spoof does NOT win over the token that matches the market', async () => {
    const { resolveCollisions } = await import('../src/collisions.js');
    // Two fake "USDT" with $1B each, one real-ish at $10.6M; DefiLlama says USDT on Tempo = $10.6M.
    const spoofA = { address: '0x111', symbol: 'USDT', tempoSupply: 1_000_000_000_000_000n, tracked: ['listed'] as any[] };
    const spoofB = { address: '0x222', symbol: 'USDT', tempoSupply: 1_000_000_000_000_000n, tracked: ['listed', 'active'] as any[] };
    const real = { address: '0x333', symbol: 'USDT', tempoSupply: 10_597_697_570_000n, tracked: ['listed'] as any[] };
    const refs = new Map([['usdt', { tempoSupply: 10_600_000_000_000n }]]);
    const res = Object.fromEntries(resolveCollisions([spoofA, spoofB, real], refs).map((r) => [r.token.address, r]));
    expect(res['0x333']!.canonical).toBe(true);
    expect(res['0x333']!.basis).toBe('reference');
    expect(res['0x111']!.token.tracked).toEqual(['collision']); // listed stripped, not active → effectively dropped
    expect(res['0x222']!.token.tracked).toEqual(['active', 'collision']);
  });
  it('an issuer total is an upper bound: a token above it cannot be the attested one', async () => {
    const { resolveCollisions } = await import('../src/collisions.js');
    const big = { address: '0x1', symbol: 'OUSD', tempoSupply: 5_000_000_000_000_000n, tracked: ['attested'] as any[] };
    const real = { address: '0x2', symbol: 'OUSD', tempoSupply: 600_000_000_000_000n, tracked: ['attested', 'active'] as any[] };
    const refs = new Map([['ousd', { issuerTotal: 893_000_000_000_000n }]]);
    const res = Object.fromEntries(resolveCollisions([big, real], refs).map((r) => [r.token.address, r]));
    expect(res['0x2']!.canonical).toBe(true);
    expect(res['0x1']!.token.tracked).toEqual(['collision']);
  });
  it('two merely-active tokens sharing a symbol are not each other\'s look-alikes', async () => {
    const { resolveCollisions, collisionCheck } = await import('../src/collisions.js');
    const a = { address: '0x1', symbol: 'senOUSDmainE', tempoSupply: 18_000_000_000_000n, tracked: ['active'] as any[] };
    const b = { address: '0x2', symbol: 'senOUSDmainE', tempoSupply: 1_000_000n, tracked: ['active'] as any[] };
    const res = resolveCollisions([a, b]);
    expect(res.every((r) => r.canonical)).toBe(true);
    expect(b.tracked).toEqual(['active']);
    expect(collisionCheck(res[1]!)).toBeNull();
  });
  it('a LONE holder of a symbol is held to the reference too: a $1B "USDT" is not the listed asset', async () => {
    const { resolveCollisions, collisionCheck } = await import('../src/collisions.js');
    const spoof = { address: '0x9', symbol: 'USDT', tempoSupply: 1_000_000_000_000_000n, tracked: ['listed'] as any[] };
    const refs = new Map([['usdt', { tempoSupply: 10_600_000_000_000n }]]);
    const [r] = resolveCollisions([spoof], refs);
    expect(r!.canonical).toBe(false);
    expect(r!.canonicalAddress).toBeUndefined();
    expect(r!.token.tracked).toEqual(['collision']);
    const check = collisionCheck(r!)!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('$1,000,000,000');
    expect(check.detail).toContain('$10,600,000');
  });
  it('a real coin that outgrew a stale market figure keeps its recognition (market bound is 2×, issuer bound is 1%)', async () => {
    const { resolveCollisions } = await import('../src/collisions.js');
    // OUSD mints ~$28M/day; DefiLlama's Tempo figure can trail by 5%+.
    const ousd = { address: '0xa', symbol: 'OUSD', tempoSupply: 630_000_000_000_000n, tracked: ['attested', 'listed', 'active'] as any[] };
    const [byMarket] = resolveCollisions([{ ...ousd }], new Map([['ousd', { tempoSupply: 600_000_000_000_000n }]]));
    expect(byMarket!.canonical).toBe(true);
    expect(byMarket!.token.tracked).toEqual(['attested', 'listed', 'active']);
    // The issuer's own total is a hard bound: 5% above it is not the attested coin.
    const [byIssuer] = resolveCollisions([{ ...ousd }], new Map([['ousd', { issuerTotal: 600_000_000_000_000n }]]));
    expect(byIssuer!.canonical).toBe(false);
    // Issuer bound takes precedence over the market figure when both exist.
    const [both] = resolveCollisions([{ ...ousd }], new Map([['ousd', { tempoSupply: 500_000_000_000_000n, issuerTotal: 631_000_000_000_000n }]]));
    expect(both!.canonical).toBe(true);
  });
});

describe('llama matching', () => {
  it('prefers the entry with a Tempo leg among same-ticker duplicates', () => {
    const coins = [
      { id: '23', symbol: 'OUSD', name: 'Origin Dollar', chains: [{ chain: 'Ethereum', usd: 6.4e6 }], total: 6.4e6 },
      { id: '443', symbol: 'OUSD', name: 'Open USD', chains: [{ chain: 'Tempo', usd: 6e8 }, { chain: 'Base', usd: 9e7 }], total: 6.9e8 },
    ];
    expect(matchLlama(coins, 'ousd')!.id).toBe('443');
    expect(matchLlama(coins, 'nope')).toBeNull();
  });
});
