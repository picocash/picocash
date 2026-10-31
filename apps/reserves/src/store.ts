/**
 * Persistence over a KV-shaped store (Cloudflare KV in production, a Map in
 * tests). Records:
 *
 *   registry            every TIP-20 discovered (address + created block) and the last block scanned
 *   meta                static metadata for every registered token (name, symbol, currency,
 *                       decimals, quote token) — read once per token, never per refresh.
 *                       The factory is permissionless; there are thousands of these.
 *   snapshot            the latest refresh: the TRACKED tokens with live figures and checks
 *   history:<address>   hourly points, capped at HISTORY_POINTS (≈ 90 days)
 *   last_run            outcome of the last refresh (ok / error / timing)
 *
 * bigint fields are serialized as decimal strings; conversion happens only here
 * and in refresh.ts.
 */
import type { Check } from './checks.js';

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export const HISTORY_POINTS = 24 * 90;

export interface RegistryEntry {
  address: string;
  createdBlock: number;
}
export interface Registry {
  tokens: RegistryEntry[];
  lastScannedBlock: number;
  updatedAt: string;
}

/** Static per-token facts; `supplyAtScan` is a hint for ordering the untracked list, not a live figure. */
export interface TokenMetaRecord {
  address: string;
  name: string;
  symbol: string;
  currency: string;
  decimals: number;
  quoteToken: string;
  createdBlock: number;
  supplyAtScan: string;
  scannedAt: string;
}
export type MetaMap = Record<string, TokenMetaRecord>;

export interface TokenSnapshot {
  address: string;
  name: string;
  symbol: string;
  currency: string;
  decimals: number;
  createdBlock: number;
  /** Why this token is tracked live. 'collision' = a look-alike sharing a recognized symbol. */
  tracked: Array<'attested' | 'listed' | 'major' | 'active' | 'collision'>;
  tempoSupply: string;
  supplyCap: string;
  paused: boolean;
  transferPolicyId: string;
  flows: {
    fromBlock: number;
    toBlock: number;
    seconds: number;
    minted: string;
    burned: string;
    mintEvents: number;
    burnEvents: number;
    transfers: number;
    memoTransfers: number;
    transferVolume: string;
  } | null;
  otherChains: Array<{ chain: string; usd: number }>;
  issuer: {
    source: 'bridge';
    slug: string;
    lastUpdated: string;
    reportedSupply: string;
    reportedReserves: string;
    breakdown: Array<{ type: string; amount: string }>;
    breakdownSum: string;
    collateralizationRatio: number;
    fetchedAt: string;
  } | null;
  checks: Check[];
  status: 'ok' | 'attention' | 'unattested';
}

export interface Snapshot {
  chainId: number;
  block: number;
  blockTimestamp: number;
  refreshedAt: string;
  tokens: TokenSnapshot[];
  /** Universe size and how many were active in the activity window. */
  universe: { registered: number; activeInWindow: number; activityWindowBlocks: number };
  errors: string[];
}

export interface HistoryPoint {
  t: number;
  block: number;
  tempoSupply: string;
  reportedSupply: string | null;
  reportedReserves: string | null;
  status: TokenSnapshot['status'];
}

export class Store {
  constructor(readonly kv: KvLike) {}

  async getRegistry(): Promise<Registry> {
    const raw = await this.kv.get('registry');
    return raw ? (JSON.parse(raw) as Registry) : { tokens: [], lastScannedBlock: -1, updatedAt: '' };
  }
  putRegistry(r: Registry): Promise<void> {
    return this.kv.put('registry', JSON.stringify(r));
  }

  async getMeta(): Promise<MetaMap> {
    const raw = await this.kv.get('meta');
    return raw ? (JSON.parse(raw) as MetaMap) : {};
  }
  putMeta(m: MetaMap): Promise<void> {
    return this.kv.put('meta', JSON.stringify(m));
  }

  async getSnapshot(): Promise<Snapshot | null> {
    const raw = await this.kv.get('snapshot');
    return raw ? (JSON.parse(raw) as Snapshot) : null;
  }
  putSnapshot(s: Snapshot): Promise<void> {
    return this.kv.put('snapshot', JSON.stringify(s));
  }

  async getHistory(address: string): Promise<HistoryPoint[]> {
    const raw = await this.kv.get(`history:${address.toLowerCase()}`);
    return raw ? (JSON.parse(raw) as HistoryPoint[]) : [];
  }

  /** Append one point unless the last one is younger than `minGapSeconds`. Returns whether it appended. */
  async appendHistory(address: string, point: HistoryPoint, minGapSeconds = 55 * 60): Promise<boolean> {
    const key = `history:${address.toLowerCase()}`;
    const points = await this.getHistory(address);
    const last = points.at(-1);
    if (last && point.t - last.t < minGapSeconds) return false;
    points.push(point);
    while (points.length > HISTORY_POINTS) points.shift();
    await this.kv.put(key, JSON.stringify(points));
    return true;
  }
}

/** In-memory KV for tests and local runs. */
export class MemoryKv implements KvLike {
  readonly map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
}
