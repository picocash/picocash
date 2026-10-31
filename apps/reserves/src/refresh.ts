/**
 * One refresh, in tiers — because the TIP-20 factory is permissionless and has
 * produced thousands of tokens, almost all of them tests:
 *
 *   universe   every token ever created (registry + cached static metadata;
 *              discovery is incremental and bounded; metadata is read once per
 *              NEW token, never per refresh)
 *   tracked    the tokens we read LIVE each run — recognized (issuer-attested,
 *              DefiLlama-listed, or a bridged major) or ACTIVE (any Transfer
 *              in the activity window, found with ONE unfiltered log query)
 *   flows      sampled for tracked tokens above a supply floor
 *
 * Runs identically from the Worker cron, a local script, and tests.
 */
import { bridgeSlugFor, fetchIssuerReport, type IssuerReport } from './bridge.js';
import { decodeUint, discoverTokens, readFlows, readTokenMeta, Rpc, SEL, TOPIC, type FlowStats } from './chain.js';
import { runChecks } from './checks.js';
import { collisionCheck, resolveCollisions, type Reference } from './collisions.js';
import { fetchLlamaCoins, matchLlama, type LlamaCoin } from './llama.js';
import type { HistoryPoint, MetaMap, Snapshot, Store, TokenMetaRecord, TokenSnapshot } from './store.js';

/**
 * Bridged majors with no issuer feed we can read, pinned by ADDRESS — never by
 * symbol, because the factory already holds three tokens calling themselves
 * "USDC.e". Canonical Tempo mainnet addresses, verified against the factory scan.
 */
export const MAJOR_ADDRESSES = new Map<string, string>([
  ['0x20c000000000000000000000b9537d11c60e8b50', 'USDC.e'],
  ['0x20c00000000000000000000014f22ca97301eb73', 'USDT0'],
  ['0x20c0000000000000000000001621e21f71cf12fb', 'EURC.e'],
]);

/**
 * Tokens that exist on Tempo without a factory `TokenCreated` event, so
 * discovery can never find them: pathUSD is a genesis precompile at the
 * zero-suffixed TIP-20 address. Always part of the universe.
 */
export const GENESIS_TOKENS: Array<{ address: string; createdBlock: number }> = [{ address: '0x20c0000000000000000000000000000000000000', createdBlock: 0 }];

export interface RefreshOptions {
  rpc: Rpc;
  store: Store;
  chainId: number;
  factory: string;
  fetchImpl?: typeof fetch;
  /** Only sample flows for tracked tokens with at least this many micro-units in supply. */
  flowSupplyFloor?: bigint;
  /** Flow sample window in blocks (≈0.55 s each). Default ≈ 6 h. */
  flowWindowBlocks?: number;
  /** Activity window for "has anyone transferred this recently". Default ≈ 1.5 h. */
  activityWindowBlocks?: number;
  skipDiscovery?: boolean;
  /** Restrict live tracking to these addresses (tests / local runs). */
  onlyAddresses?: string[];
  concurrency?: number;
  /** Max 99K-block windows to scan for new tokens per run (cold start converges over several crons). */
  maxDiscoveryWindows?: number;
  /** Max NEW tokens whose metadata is read per run. */
  maxMetaReadsPerRun?: number;
  /** Phase markers (e.g. console.log) — the last one before a crash names the phase. */
  log?: (message: string) => void;
  now?: () => Date;
}

const s = (b: bigint) => b.toString();

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

/** Live, per-run fields: supply, cap, pause, policy. Four calls instead of nine. */
async function readLive(rpc: Rpc, address: string) {
  const [supply, cap, paused, policy] = await Promise.all([
    rpc.ethCall(address, SEL.totalSupply),
    rpc.ethCall(address, SEL.supplyCap).catch(() => '0x'),
    rpc.ethCall(address, SEL.paused).catch(() => '0x'),
    rpc.ethCall(address, SEL.transferPolicyId).catch(() => '0x'),
  ]);
  return { totalSupply: decodeUint(supply), supplyCap: decodeUint(cap), paused: decodeUint(paused) === 1n, transferPolicyId: decodeUint(policy) };
}

export async function refresh(o: RefreshOptions): Promise<Snapshot> {
  const now = o.now ?? (() => new Date());
  const errors: string[] = [];
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const flowFloor = o.flowSupplyFloor ?? 10_000n * 1_000_000n;
  const flowWindow = o.flowWindowBlocks ?? 39_000;
  const activityWindow = o.activityWindowBlocks ?? 10_000;
  const concurrency = o.concurrency ?? 3;
  const log = o.log ?? (() => {});
  const t0 = Date.now();
  const mark = (phase: string) => log(`[refresh +${((Date.now() - t0) / 1000).toFixed(1)}s] ${phase}`);

  const head = await o.rpc.blockNumber();
  const headTs = await o.rpc.blockTimestamp(head);
  mark(`head ${head}`);

  // 1. Universe: registry (bounded incremental discovery) + metadata for new tokens only.
  const registry = await o.store.getRegistry();
  const meta: MetaMap = await o.store.getMeta();
  mark(`registry ${registry.tokens.length} tokens, meta ${Object.keys(meta).length}, lastScanned ${registry.lastScannedBlock}`);
  let registryDirty = false;
  for (const g of GENESIS_TOKENS) {
    if (!registry.tokens.some((t) => t.address === g.address)) registry.tokens.unshift({ ...g }), (registryDirty = true);
  }
  if (!o.skipDiscovery && head > registry.lastScannedBlock) {
    const from = registry.lastScannedBlock + 1;
    const to = Math.min(head, from + (o.maxDiscoveryWindows ?? 40) * 99_000 - 1);
    try {
      const found = await discoverTokens(o.rpc, o.factory, from, to);
      const known = new Set(registry.tokens.map((t) => t.address));
      for (const t of found) if (!known.has(t.address)) registry.tokens.push(t), known.add(t.address);
      registry.lastScannedBlock = to;
      registryDirty = true;
      if (to < head) errors.push(`discovery: scanned to block ${to} of ${head}; registry still catching up (${head - to} blocks behind)`);
    } catch (err) {
      errors.push(`discovery: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (registryDirty) {
    registry.updatedAt = now().toISOString();
    await o.store.putRegistry(registry);
  }
  const needMeta = registry.tokens.filter((t) => !meta[t.address]).slice(0, o.maxMetaReadsPerRun ?? 60);
  if (needMeta.length) {
    await mapLimit(needMeta, concurrency, async (e) => {
      try {
        const m = await readTokenMeta(o.rpc, e.address);
        meta[e.address] = { address: e.address, name: m.name, symbol: m.symbol, currency: m.currency, decimals: m.decimals, quoteToken: m.quoteToken, createdBlock: e.createdBlock, supplyAtScan: s(m.totalSupply), scannedAt: now().toISOString() };
      } catch (err) {
        errors.push(`meta ${e.address}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    await o.store.putMeta(meta);
    if (registry.tokens.length - Object.keys(meta).length > 0) errors.push(`metadata: ${registry.tokens.length - Object.keys(meta).length} tokens still unread (backfilling ${o.maxMetaReadsPerRun ?? 60} per run)`);
  }

  mark('discovery + metadata done');

  // 2. Other-chain figures (one call) — also tells us which symbols the market lists.
  let llama: LlamaCoin[] = [];
  try {
    llama = await fetchLlamaCoins(fetchImpl);
  } catch (err) {
    errors.push(`defillama: ${err instanceof Error ? err.message : String(err)}`);
  }
  const listedSymbols = new Set(llama.filter((c) => c.chains.some((ch) => ch.chain === 'Tempo')).map((c) => c.symbol.toLowerCase()));

  mark(`defillama ${llama.length} assets, ${listedSymbols.size} listed on Tempo`);

  // 3. Activity: one unfiltered Transfer query, intersected with the registry.
  const registered = new Set(registry.tokens.map((t) => t.address));
  const activeCounts = new Map<string, number>();
  try {
    const logs = await o.rpc.getLogs({ topics: [TOPIC.Transfer], fromBlock: Math.max(0, head - activityWindow + 1), toBlock: head });
    for (const l of logs) {
      const a = l.address.toLowerCase();
      if (registered.has(a)) activeCounts.set(a, (activeCounts.get(a) ?? 0) + 1);
    }
  } catch (err) {
    errors.push(`activity: ${err instanceof Error ? err.message : String(err)}`);
  }

  mark(`activity: ${activeCounts.size} registered tokens moved in last ${activityWindow} blocks`);

  // 4. Tracked set.
  const reasonsFor = (m: TokenMetaRecord | undefined, addr: string): TokenSnapshot['tracked'] => {
    const r: TokenSnapshot['tracked'] = [];
    const sym = (m?.symbol ?? '').toLowerCase();
    if (m && bridgeSlugFor(m.symbol)) r.push('attested');
    if (sym && listedSymbols.has(sym)) r.push('listed');
    if (MAJOR_ADDRESSES.has(addr)) r.push('major');
    if (activeCounts.has(addr)) r.push('active');
    return r;
  };
  let trackedEntries = registry.tokens
    .map((t) => ({ ...t, meta: meta[t.address], tracked: reasonsFor(meta[t.address], t.address) }))
    .filter((t) => t.tracked.length > 0 && t.meta);
  if (o.onlyAddresses) {
    const want = new Set(o.onlyAddresses.map((a) => a.toLowerCase()));
    trackedEntries = trackedEntries.filter((t) => want.has(t.address));
    for (const a of want) {
      if (!trackedEntries.some((t) => t.address === a)) {
        let m: TokenMetaRecord | undefined = meta[a];
        if (!m) {
          const x = await readTokenMeta(o.rpc, a);
          m = { address: a, name: x.name, symbol: x.symbol, currency: x.currency, decimals: x.decimals, quoteToken: x.quoteToken, createdBlock: 0, supplyAtScan: s(x.totalSupply), scannedAt: now().toISOString() };
          meta[a] = m;
        }
        const reasons = reasonsFor(m, a);
        trackedEntries.push({ address: a, createdBlock: m.createdBlock, meta: m, tracked: reasons.length ? reasons : ['active'] });
      }
    }
  }

  // 5. Live reads for tracked tokens.
  const live = await mapLimit(trackedEntries, concurrency, async (t) => {
    try {
      return { ...t, ...(await readLive(o.rpc, t.address)) };
    } catch (err) {
      errors.push(`live ${t.meta!.symbol || t.address}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  });
  const tokens = live.filter((x): x is NonNullable<typeof x> => x !== null);
  mark(`live reads for ${trackedEntries.length} tracked tokens (${tokens.length} ok)`);

  // 6a. Issuer reports for every slug any tracked symbol maps to (a dozen at most).
  //     Needed BEFORE collision resolution: the issuer's total is the upper bound
  //     that decides which holder of a symbol can be the attested one.
  const issuerBySlug = new Map<string, IssuerReport | null>();
  const slugs = [...new Set(tokens.map((t) => bridgeSlugFor(t.meta!.symbol)).filter((x): x is string => !!x))];
  await mapLimit(slugs, 4, async (slug) => {
    try {
      issuerBySlug.set(slug, await fetchIssuerReport(slug, fetchImpl));
    } catch (err) {
      issuerBySlug.set(slug, null);
      errors.push(`issuer ${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  mark(`issuer reports for ${slugs.length} slugs`);

  // 6b. Symbol collisions: one canonical token per symbol, chosen by consistency
  //     with a reference figure (market's Tempo leg, or issuer total), never by
  //     "largest supply" — a spoof can mint a billion.
  const references = new Map<string, Reference>();
  for (const t of tokens) {
    const sym = t.meta!.symbol.trim().toLowerCase();
    if (!sym || references.has(sym)) continue;
    const lm = matchLlama(llama, t.meta!.symbol);
    const tempoLeg = lm?.chains.find((c) => c.chain === 'Tempo')?.usd;
    const slug = bridgeSlugFor(t.meta!.symbol);
    const issuer = slug ? issuerBySlug.get(slug) : null;
    const ref: Reference = {};
    if (tempoLeg && tempoLeg > 0) ref.tempoSupply = BigInt(Math.round(tempoLeg * 1e6));
    if (issuer) ref.issuerTotal = issuer.reportedSupply;
    if (ref.tempoSupply !== undefined || ref.issuerTotal !== undefined) references.set(sym, ref);
  }
  const resolved = resolveCollisions(tokens.map((t) => ({ address: t.address, symbol: t.meta!.symbol, tempoSupply: t.totalSupply, tracked: t.tracked })), references);
  const resolvedByAddr = new Map(resolved.map((r) => [r.token.address, r]));
  for (const t of tokens) t.tracked = resolvedByAddr.get(t.address)!.token.tracked;
  const isCanonical = (addr: string) => resolvedByAddr.get(addr)?.canonical ?? true;
  // A look-alike that was never active has nothing left to justify tracking it live.
  const kept = tokens.filter((t) => t.tracked.length > 0 && !(t.tracked.length === 1 && t.tracked[0] === 'collision' && !activeCounts.has(t.address)));

  // 6c. Flows for tracked tokens above the floor.
  const flowTargets = kept.filter((t) => t.totalSupply >= flowFloor);
  const flowFrom = Math.max(0, head - flowWindow + 1);
  const flowsByAddr = new Map<string, FlowStats>();
  const flowsP = mapLimit(flowTargets, 2, async (t) => {
    try {
      flowsByAddr.set(t.address, await readFlows(o.rpc, t.address, flowFrom, head));
    } catch (err) {
      errors.push(`flows ${t.meta!.symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  mark(`collisions resolved, ${kept.length} kept; sampling flows for ${flowTargets.length}`);
  await flowsP;
  const flowSeconds = flowsByAddr.size ? Math.max(1, headTs - (await o.rpc.blockTimestamp(flowFrom).catch(() => headTs - Math.round(flowWindow * 0.55)))) : 0;
  mark(`flows done (${flowsByAddr.size})`);

  // 7. Assemble + check.
  const nowTs = Math.floor(now().getTime() / 1000);
  const snapshotTokens: TokenSnapshot[] = kept.map((t) => {
    const m = t.meta!;
    const canonical = isCanonical(t.address);
    const slug = canonical ? bridgeSlugFor(m.symbol) : null;
    const issuer = slug ? (issuerBySlug.get(slug) ?? null) : null;
    const lm = canonical ? matchLlama(llama, m.symbol) : null;
    const otherChains = lm ? lm.chains.filter((c) => c.chain !== 'Tempo') : [];
    const issuerAge = issuer?.lastUpdated ? Math.max(0, nowTs - Math.floor(Date.parse(issuer.lastUpdated) / 1000)) : null;
    const checks = runChecks({ symbol: m.symbol, decimals: m.decimals, tempoSupply: t.totalSupply, supplyCap: t.supplyCap, paused: t.paused, otherChains, issuer, issuerAgeSeconds: issuerAge });
    const collision = collisionCheck(resolvedByAddr.get(t.address)!);
    if (collision) checks.unshift(collision);
    const status: TokenSnapshot['status'] = !issuer ? 'unattested' : checks.some((c) => c.ok === false) ? 'attention' : 'ok';
    const f = flowsByAddr.get(t.address);
    return {
      address: t.address,
      name: m.name,
      symbol: m.symbol,
      currency: m.currency,
      decimals: m.decimals,
      createdBlock: t.createdBlock,
      tracked: t.tracked,
      tempoSupply: s(t.totalSupply),
      supplyCap: s(t.supplyCap),
      paused: t.paused,
      transferPolicyId: s(t.transferPolicyId),
      flows: f
        ? { fromBlock: f.fromBlock, toBlock: f.toBlock, seconds: flowSeconds, minted: s(f.minted), burned: s(f.burned), mintEvents: f.mintEvents, burnEvents: f.burnEvents, transfers: f.transfers, memoTransfers: f.memoTransfers, transferVolume: s(f.transferVolume) }
        : null,
      otherChains,
      issuer: issuer
        ? { source: 'bridge', slug: issuer.slug, lastUpdated: issuer.lastUpdated, reportedSupply: s(issuer.reportedSupply), reportedReserves: s(issuer.reportedReserves), breakdown: issuer.breakdown.map((b) => ({ type: b.type, amount: s(b.amount) })), breakdownSum: s(issuer.breakdownSum), collateralizationRatio: issuer.collateralizationRatio, fetchedAt: issuer.fetchedAt }
        : null,
      checks,
      status,
    };
  });
  // Recognized first (attested/listed/major), then merely-active; within a tier by supply.
  const rank = (t: TokenSnapshot) => (t.tracked.some((r) => r !== 'active') ? 0 : 1);
  snapshotTokens.sort((a, b) => rank(a) - rank(b) || (BigInt(b.tempoSupply) > BigInt(a.tempoSupply) ? 1 : BigInt(b.tempoSupply) < BigInt(a.tempoSupply) ? -1 : 0));

  const snapshot: Snapshot = {
    chainId: o.chainId,
    block: head,
    blockTimestamp: headTs,
    refreshedAt: now().toISOString(),
    tokens: snapshotTokens,
    universe: { registered: registry.tokens.length, activeInWindow: activeCounts.size, activityWindowBlocks: activityWindow },
    errors,
  };
  await o.store.putSnapshot(snapshot);
  mark(`snapshot written (${snapshotTokens.length} tokens)`);

  // 8. Hourly history for recognized tokens (not every test token that moved once).
  for (const t of snapshotTokens) {
    if (rank(t) !== 0) continue;
    const point: HistoryPoint = { t: nowTs, block: head, tempoSupply: t.tempoSupply, reportedSupply: t.issuer?.reportedSupply ?? null, reportedReserves: t.issuer?.reportedReserves ?? null, status: t.status };
    await o.store.appendHistory(t.address, point);
  }
  return snapshot;
}
