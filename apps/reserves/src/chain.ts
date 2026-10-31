/**
 * Tempo JSON-RPC access for the monitor: metadata reads, chunked log queries,
 * and the TIP-20 flow aggregations, with the rate-limit behaviour of the public
 * RPC baked in (it answers `-32005 rate limited` under load, and caps
 * eth_getLogs at 100,000 blocks INCLUSIVE — so a window is at most 99,999).
 *
 * Everything here is pure fetch + bigint: no viem, so it runs unchanged in a
 * Worker, a test, or a one-off script.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/** The RPC's "max block range 100000" rejects ranges at the boundary; stay well inside it. */
export const MAX_LOG_WINDOW = 99_000;

export const SEL = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
  currency: selector('currency()'),
  supplyCap: selector('supplyCap()'),
  paused: selector('paused()'),
  transferPolicyId: selector('transferPolicyId()'),
  quoteToken: selector('quoteToken()'),
} as const;

export const TOPIC = {
  TokenCreated: topic('TokenCreated(address,string,string,string,address,address,bytes32)'),
  Transfer: topic('Transfer(address,address,uint256)'),
  TransferWithMemo: topic('TransferWithMemo(address,address,uint256,bytes32)'),
  Mint: topic('Mint(address,uint256)'),
  Burn: topic('Burn(address,uint256)'),
} as const;

export function selector(sig: string): string {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(sig))).slice(0, 8)}`;
}
export function topic(sig: string): string {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(sig)))}`;
}

export interface Log {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export interface RpcOptions {
  fetchImpl?: typeof fetch;
  /** Retries on rate-limit / transient failure. */
  retries?: number;
  /** Base backoff in ms (doubles). */
  backoffMs?: number;
  /** Per-request timeout. A stalled connection must fail, never hang a refresh. */
  timeoutMs?: number;
}

export class Rpc {
  private readonly f: typeof fetch;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;
  private id = 1;

  constructor(
    readonly url: string,
    opts: RpcOptions = {},
  ) {
    // Stored as a property and invoked as `this.f(...)`, so `this` would be the
    // Rpc instance — workerd rejects that ("Illegal invocation"); Node does not.
    // Bind to the global so it behaves the same everywhere.
    this.f = (opts.fetchImpl ?? globalThis.fetch).bind(globalThis);
    this.retries = opts.retries ?? 5;
    this.backoffMs = opts.backoffMs ?? 250;
    this.timeoutMs = opts.timeoutMs ?? 25_000;
  }

  async call<T = unknown>(method: string, params: unknown[]): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.f(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'tempo-reserves-monitor/0.1 (+https://reserves.a9n9.net)' },
          body: JSON.stringify({ jsonrpc: '2.0', id: this.id++, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) throw new RpcError(`HTTP ${res.status}`, res.status);
        if (!res.ok) throw new RpcError(`HTTP ${res.status} from RPC (${(await res.text()).slice(0, 120)})`, res.status);
        const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
        if (json.error) {
          const rateLimited = json.error.code === -32005 || /rate limit/i.test(json.error.message);
          if (!rateLimited) throw new RpcError(json.error.message, json.error.code);
          throw new RpcError(json.error.message, -32005);
        }
        return json.result as T;
      } catch (err) {
        lastErr = err;
        // Timeouts and network failures are retried; RPC-level errors only when rate-limited.
        const transient = err instanceof RpcError ? err.code === -32005 || (err.code ?? 0) >= 429 : true;
        if (!transient || attempt === this.retries) throw err;
        await new Promise((r) => setTimeout(r, this.backoffMs * 2 ** attempt + Math.random() * 100));
      }
    }
    throw lastErr;
  }

  blockNumber(): Promise<number> {
    return this.call<string>('eth_blockNumber', []).then((h) => Number.parseInt(h, 16));
  }

  async blockTimestamp(block: number): Promise<number> {
    const b = await this.call<{ timestamp: string } | null>('eth_getBlockByNumber', [`0x${block.toString(16)}`, false]);
    if (!b) throw new RpcError(`block ${block} not found`);
    return Number.parseInt(b.timestamp, 16);
  }

  ethCall(to: string, data: string, block: string | number = 'latest'): Promise<string> {
    const tag = typeof block === 'number' ? `0x${block.toString(16)}` : block;
    return this.call<string>('eth_call', [{ to, data }, tag]);
  }

  /** eth_getLogs over an arbitrary range, split into windows the RPC accepts. */
  async getLogs(filter: { address?: string | string[]; topics?: (string | null)[]; fromBlock: number; toBlock: number }): Promise<Log[]> {
    const out: Log[] = [];
    for (let from = filter.fromBlock; from <= filter.toBlock; from += MAX_LOG_WINDOW + 1) {
      const to = Math.min(from + MAX_LOG_WINDOW, filter.toBlock);
      const logs = await this.call<Log[]>('eth_getLogs', [
        { ...(filter.address ? { address: filter.address } : {}), ...(filter.topics ? { topics: filter.topics } : {}), fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` },
      ]);
      out.push(...logs);
    }
    return out;
  }
}

// ---- ABI helpers (only what TIP-20 needs) ----

export function decodeString(hex: string): string {
  if (!hex || hex === '0x') return '';
  const h = hex.slice(2);
  try {
    const off = Number.parseInt(h.slice(0, 64), 16) * 2;
    const len = Number.parseInt(h.slice(off, off + 64), 16) * 2;
    return new TextDecoder().decode(Uint8Array.from(h.slice(off + 64, off + 64 + len).match(/../g)!.map((b) => Number.parseInt(b, 16))));
  } catch {
    return '';
  }
}
export function decodeUint(hex: string): bigint {
  return !hex || hex === '0x' ? 0n : BigInt(hex);
}
export function decodeBool(hex: string): boolean {
  return decodeUint(hex) === 1n;
}
export function decodeAddress(hex32: string): string {
  return `0x${hex32.slice(-40)}`.toLowerCase();
}

// ---- TIP-20 reads ----

export interface TokenMeta {
  address: string;
  name: string;
  symbol: string;
  currency: string;
  decimals: number;
  totalSupply: bigint;
  supplyCap: bigint;
  paused: boolean;
  transferPolicyId: bigint;
  quoteToken: string;
}

export async function readTokenMeta(rpc: Rpc, address: string): Promise<TokenMeta> {
  const [name, symbol, decimals, totalSupply, currency, supplyCap, paused, policy, quote] = await Promise.all([
    rpc.ethCall(address, SEL.name),
    rpc.ethCall(address, SEL.symbol),
    rpc.ethCall(address, SEL.decimals),
    rpc.ethCall(address, SEL.totalSupply),
    rpc.ethCall(address, SEL.currency).catch(() => '0x'),
    rpc.ethCall(address, SEL.supplyCap).catch(() => '0x'),
    rpc.ethCall(address, SEL.paused).catch(() => '0x'),
    rpc.ethCall(address, SEL.transferPolicyId).catch(() => '0x'),
    rpc.ethCall(address, SEL.quoteToken).catch(() => '0x'),
  ]);
  return {
    address: address.toLowerCase(),
    name: decodeString(name),
    symbol: decodeString(symbol),
    currency: decodeString(currency),
    decimals: Number(decodeUint(decimals)) || 6,
    totalSupply: decodeUint(totalSupply),
    supplyCap: decodeUint(supplyCap),
    paused: decodeBool(paused),
    transferPolicyId: decodeUint(policy),
    quoteToken: quote && quote !== '0x' ? decodeAddress(quote) : '',
  };
}

/** Every TIP-20 ever created, from the factory's TokenCreated events in [fromBlock, toBlock]. */
export async function discoverTokens(rpc: Rpc, factory: string, fromBlock: number, toBlock: number): Promise<Array<{ address: string; createdBlock: number }>> {
  const logs = await rpc.getLogs({ address: factory, topics: [TOPIC.TokenCreated], fromBlock, toBlock });
  return logs.map((l) => ({
    // token is the first indexed param when indexed, else the first data word
    address: l.topics[1] ? decodeAddress(l.topics[1]) : decodeAddress(l.data.slice(2, 66)),
    createdBlock: Number.parseInt(l.blockNumber, 16),
  }));
}

export interface FlowStats {
  fromBlock: number;
  toBlock: number;
  minted: bigint;
  burned: bigint;
  mintEvents: number;
  burnEvents: number;
  transfers: number;
  memoTransfers: number;
  transferVolume: bigint;
}

/**
 * Mint/burn and transfer activity for one token over a block range. Transfer
 * volume counts Transfer events (mints/burns appear there too with the zero
 * address and are excluded from volume). Memo share = TransferWithMemo / Transfer.
 */
export async function readFlows(rpc: Rpc, token: string, fromBlock: number, toBlock: number): Promise<FlowStats> {
  const [mints, burns, transfers, memos] = await Promise.all([
    rpc.getLogs({ address: token, topics: [TOPIC.Mint], fromBlock, toBlock }),
    rpc.getLogs({ address: token, topics: [TOPIC.Burn], fromBlock, toBlock }),
    rpc.getLogs({ address: token, topics: [TOPIC.Transfer], fromBlock, toBlock }),
    rpc.getLogs({ address: token, topics: [TOPIC.TransferWithMemo], fromBlock, toBlock }),
  ]);
  const amt = (l: Log) => decodeUint(l.data.slice(0, 66));
  const zero = `0x${'0'.repeat(64)}`;
  const realTransfers = transfers.filter((l) => l.topics[1] !== zero && l.topics[2] !== zero);
  return {
    fromBlock,
    toBlock,
    minted: mints.reduce((s, l) => s + amt(l), 0n),
    burned: burns.reduce((s, l) => s + amt(l), 0n),
    mintEvents: mints.length,
    burnEvents: burns.length,
    transfers: realTransfers.length,
    memoTransfers: memos.length,
    transferVolume: realTransfers.reduce((s, l) => s + amt(l), 0n),
  };
}
