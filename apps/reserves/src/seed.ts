/**
 * Convert the offline factory scan (`tip20-registry.json`: rows of
 * {address, symbol, name, currency, supply, created_block}) into the
 * `registry` and `meta` records, so a fresh deployment does not spend ~470
 * log queries and thousands of metadata calls catching up on a permissionless
 * factory. Used by the Node server on first boot and by scripts/seed-registry.mjs
 * for Workers KV.
 */
import type { MetaMap, Registry } from './store.js';

export interface ScanRow {
  address: string;
  symbol?: string;
  name?: string;
  currency?: string;
  supply?: string | number;
  created_block?: number;
  createdBlock?: number;
}

const addr = (r: ScanRow) => String(r.address).toLowerCase();
const created = (r: ScanRow) => Number(r.created_block ?? r.createdBlock ?? 0);

export function registryFromScan(rows: ScanRow[], now = new Date().toISOString(), lastScannedBlock?: number): Registry {
  const tokens = rows.map((r) => ({ address: addr(r), createdBlock: created(r) }));
  // The refresh rescans from here; overlap is harmless (dedupe by address).
  return { tokens, lastScannedBlock: lastScannedBlock ?? Math.max(0, ...tokens.map((t) => t.createdBlock)), updatedAt: now };
}

export function metaFromScan(rows: ScanRow[], now = new Date().toISOString()): MetaMap {
  const meta: MetaMap = {};
  for (const r of rows) {
    meta[addr(r)] = {
      address: addr(r),
      name: String(r.name ?? ''),
      symbol: String(r.symbol ?? ''),
      currency: String(r.currency ?? ''),
      decimals: 6,
      quoteToken: '',
      createdBlock: created(r),
      supplyAtScan: String(r.supply ?? 0),
      scannedAt: now,
    };
  }
  return meta;
}
