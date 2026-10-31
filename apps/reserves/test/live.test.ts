/**
 * Integration against the live network: Tempo public RPC, Bridge's public
 * transparency feed, DefiLlama. Restricted to three known tokens so it stays
 * fast and does not run the full factory scan. Skipped when LIVE is unset.
 */
import { describe, expect, it } from 'vitest';
import { Rpc } from '../src/chain.js';
import { refresh } from '../src/refresh.js';
import { MemoryKv, Store } from '../src/store.js';

const PATH_USD = '0x20c0000000000000000000000000000000000000';
const USDC_E = '0x20c000000000000000000000b9537d11c60e8b50';

describe.skipIf(!process.env.LIVE)('live refresh (network)', () => {
  it('reconciles pathUSD exactly, leaves USDC.e unattested, and writes history', { timeout: 180_000 }, async () => {
    const kv = new MemoryKv();
    const store = new Store(kv);
    const snap = await refresh({
      rpc: new Rpc('https://rpc.tempo.xyz'),
      store,
      chainId: 4217,
      factory: '0x20fc000000000000000000000000000000000000',
      skipDiscovery: true,
      onlyAddresses: [PATH_USD, USDC_E],
      flowWindowBlocks: 6_000, // ~55 min — enough to see activity, cheap enough for a test
    });
    expect(snap.errors).toEqual([]);
    const path = snap.tokens.find((t) => t.address === PATH_USD)!;
    const usdc = snap.tokens.find((t) => t.address === USDC_E)!;

    expect(path.symbol).toBe('pathUSD');
    expect(path.issuer?.slug).toBe('path_usd');
    expect(path.status).not.toBe('unattested');
    const match = path.checks.find((c) => c.id === 'supply_matches_chain')!;
    expect(match.ok).toBe(true); // Tempo totalSupply == Bridge figure to the micro-unit
    expect(path.checks.find((c) => c.id === 'reserves_cover_chain')!.ok).toBe(true);

    expect(usdc.symbol).toBe('USDC.e');
    expect(usdc.status).toBe('unattested');
    expect(usdc.flows).not.toBeNull();
    expect(usdc.flows!.transfers).toBeGreaterThan(0);
    expect(usdc.flows!.memoTransfers).toBeGreaterThan(0);

    expect((await store.getHistory(PATH_USD)).length).toBe(1);
    const sup = snap.tokens.map((t) => BigInt(t.tempoSupply));
    expect(sup[0]! >= sup[1]!).toBe(true);
  });
});
