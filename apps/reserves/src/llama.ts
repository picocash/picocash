/**
 * DefiLlama's public stablecoin API — used for the OTHER chains a coin lives
 * on. Tempo's own supply is read from the chain directly; DefiLlama provides
 * Ethereum/Base/Solana legs so a multi-chain coin (OUSD) can be reconciled
 * against the issuer's single total.
 */
export interface ChainSupply {
  chain: string;
  usd: number;
}
export interface LlamaCoin {
  id: string;
  symbol: string;
  name: string;
  chains: ChainSupply[];
  total: number;
}

const LIST = 'https://stablecoins.llama.fi/stablecoins?includePrices=false';

export async function fetchLlamaCoins(fetchImpl: typeof fetch = globalThis.fetch): Promise<LlamaCoin[]> {
  const res = await fetchImpl(LIST, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`DefiLlama ${res.status}`);
  const json = (await res.json()) as { peggedAssets: Array<{ id: string; symbol: string; name: string; chainCirculating?: Record<string, { current?: { peggedUSD?: number; peggedEUR?: number } }> }> };
  return json.peggedAssets.map((a) => {
    const chains = Object.entries(a.chainCirculating ?? {})
      .map(([chain, v]) => ({ chain, usd: v.current?.peggedUSD ?? v.current?.peggedEUR ?? 0 }))
      .filter((c) => c.usd > 0)
      .sort((x, y) => y.usd - x.usd);
    return { id: a.id, symbol: a.symbol, name: a.name, chains, total: chains.reduce((s, c) => s + c.usd, 0) };
  });
}

/** Pick the DefiLlama entry that has a Tempo leg matching this symbol (there are stale duplicates with the same ticker). */
/**
 * Only an entry that itself has a Tempo leg counts as a match. A same-ticker
 * coin with no Tempo presence is a different asset sharing a name (Sky's
 * USDS vs Arq's USDS on Tempo) and would wrongly import billions of
 * other-chain supply into the cross-chain comparison.
 */
export function matchLlama(coins: LlamaCoin[], symbol: string): LlamaCoin | null {
  const sym = symbol.toLowerCase();
  const onTempo = coins.filter((c) => c.symbol.toLowerCase() === sym && c.chains.some((ch) => ch.chain === 'Tempo'));
  return onTempo.sort((a, b) => b.total - a.total)[0] ?? null;
}
