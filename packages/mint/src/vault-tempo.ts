import { createPublicClient, defineChain, http, parseAbi, parseAbiItem } from 'viem';
import type { TempoConfig } from './config.js';
import type { ChainStatus, Deposit, DepositOracle } from './vault.js';

// NB: memo is INDEXED on Tempo's TIP-20 (verified against a Moderato receipt:
// memo sits in topic3, amount in data). Declaring it non-indexed makes viem
// decode memo as undefined and every deposit gets silently skipped.
export const transferWithMemoEvent = parseAbiItem(
  'event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)',
);

export interface TransferLog {
  args: {
    from?: `0x${string}` | undefined;
    to?: `0x${string}` | undefined;
    amount?: bigint | undefined;
    memo?: `0x${string}` | undefined;
  };
  transactionHash: `0x${string}` | null;
  logIndex: number | null;
}

/** The slice of a viem PublicClient the oracle needs — injectable for tests. */
export interface ChainReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: `0x${string}`;
    event: typeof transferWithMemoEvent;
    args: { to: `0x${string}` };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<TransferLog[]>;
  readContract?(args: { address: `0x${string}`; abi: unknown; functionName: string; args?: unknown[] }): Promise<unknown>;
}

const overdueAbi = parseAbi(['function isPublicationOverdue() view returns (bool)']);
const statusAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function operator() view returns (address)',
  'function lastOutstanding() view returns (uint256)',
  'function lastPublishedAt() view returns (uint256)',
  'function lastPublishedBlock() view returns (uint256)',
  'function publishThresholdBps() view returns (uint16)',
  'function publishIntervalBlocks() view returns (uint64)',
  'function maxMeltFee() view returns (uint256)',
  'function rotationTimelock() view returns (uint256)',
  'function emergencyInfo() view returns (bool mode, uint64 graceBlocks, uint256 redeemed, uint256 cap, address verifier)',
  'function keysetKey(bytes8 keysetId, uint256 amount) view returns (bytes)',
]);

export interface TempoVaultOptions {
  rpcUrl: string;
  chainId: number;
  tokenAddress: `0x${string}`;
  depositAddress: `0x${string}`;
  /** Blocks behind head to treat as settled (reorg safety). */
  confirmations?: number;
  /** How far behind head the first scan starts. Quotes older than this are invisible. */
  lookbackBlocks?: bigint;
  client?: ChainReader;
}

const CHUNK = 10_000n;

/** Public RPCs rate-limit by source IP (shared egress on hosted platforms hits it first). */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 5, baseMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err instanceof Error ? err.message : err);
      if (!/too many|rate|429|limit/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw lastErr;
}

/**
 * Startup check for the unit ↔ token ↔ vault binding (PIP-01): the unit's
 * token address must be a live TIP-20 on this chain, and if the deposit
 * address is a vault contract, its token() must be exactly that token.
 * Refusing to start beats minting tokens backed by the wrong asset.
 */
export async function verifyTokenBinding(
  tempo: TempoConfig,
  meltFee?: number,
): Promise<{ symbol: string; decimals: number }> {
  const client = createPublicClient({
    chain: defineChain({
      id: tempo.chainId,
      name: `tempo-${tempo.chainId}`,
      nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
      rpcUrls: { default: { http: [tempo.rpcUrl] } },
    }),
    transport: http(tempo.rpcUrl),
  });
  const tokenAbi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

  // Sequential, with backoff: a parallel burst is exactly what trips per-IP limits.
  if (!(await withRetry(() => client.getCode({ address: tempo.tokenAddress })))) {
    throw new Error(`unit token ${tempo.tokenAddress} has no code on chain ${tempo.chainId} — not a TIP-20`);
  }
  let symbol: string;
  let decimals: number;
  try {
    symbol = await withRetry(() => client.readContract({ address: tempo.tokenAddress, abi: tokenAbi, functionName: 'symbol' }));
    decimals = Number(await withRetry(() => client.readContract({ address: tempo.tokenAddress, abi: tokenAbi, functionName: 'decimals' })));
  } catch {
    throw new Error(`token ${tempo.tokenAddress} does not answer symbol()/decimals() — not a TIP-20`);
  }

  if (await withRetry(() => client.getCode({ address: tempo.depositAddress }))) {
    const vaultToken = await withRetry(() =>
      client.readContract({
        address: tempo.depositAddress,
        abi: parseAbi(['function token() view returns (address)']),
        functionName: 'token',
      }),
    ).catch(() => {
      throw new Error(`deposit contract ${tempo.depositAddress} exposes no token() — not a picocash vault`);
    });
    if (vaultToken.toLowerCase() !== tempo.tokenAddress.toLowerCase()) {
      throw new Error(
        `vault ${tempo.depositAddress} is bound to token ${vaultToken}, but the mint's unit expects ${tempo.tokenAddress} — refusing to start`,
      );
    }
    // The exit-tax ceiling is an on-chain commitment; a mint quoting above it
    // is in breach, so refuse to run in that state at all.
    if (meltFee !== undefined) {
      const cap = await withRetry(() =>
        client.readContract({
          address: tempo.depositAddress,
          abi: parseAbi(['function maxMeltFee() view returns (uint256)']),
          functionName: 'maxMeltFee',
        }),
      ).catch(() => null); // pre-ceiling vault deployments
      if (cap === null) {
        console.warn(`[mint] vault ${tempo.depositAddress} predates the maxMeltFee ceiling — fee cap unverifiable on-chain`);
      } else if (BigInt(meltFee) > cap) {
        throw new Error(
          `configured melt fee ${meltFee} exceeds the vault's on-chain maxMeltFee ${cap} — refusing to start (lower PICOCASH_MELT_FEE or raise the ceiling via its timelock)`,
        );
      }
    }
  } else {
    console.warn(`[mint] deposit address ${tempo.depositAddress} is an EOA (no vault contract) — token binding unverifiable on-chain`);
  }
  return { symbol, decimals };
}

/**
 * Real DepositOracle for build step 5: watches TIP-20 TransferWithMemo events
 * to the deposit address on Tempo and credits quotes by memo (= quote id,
 * 32 bytes). Scans incrementally from a cursor; refreshes are serialized and
 * logs deduped by (tx, logIndex) so concurrent polls can't double-count.
 */
export class TempoVault implements DepositOracle {
  private readonly client: ChainReader;
  private readonly tokenAddress: `0x${string}`;
  private readonly depositAddress: `0x${string}`;
  private readonly confirmations: bigint;
  private readonly lookbackBlocks: bigint;
  private cursor: bigint | null = null;
  private readonly totals = new Map<string, { amount: bigint; txRef: string }>();
  private readonly seen = new Set<string>();
  private refreshing: Promise<void> | null = null;

  constructor(options: TempoVaultOptions) {
    this.tokenAddress = options.tokenAddress;
    this.depositAddress = options.depositAddress;
    this.confirmations = BigInt(options.confirmations ?? 1);
    this.lookbackBlocks = options.lookbackBlocks ?? 5_000n;
    this.client =
      options.client ??
      // viem's readContract generics don't structurally match the minimal
      // ChainReader slice; runtime shape is identical.
      (createPublicClient({
        chain: defineChain({
          id: options.chainId,
          name: `tempo-${options.chainId}`,
          nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 }, // Tempo has no native token; viem requires the field
          rpcUrls: { default: { http: [options.rpcUrl] } },
        }),
        transport: http(options.rpcUrl),
      }) as unknown as ChainReader);
  }

  async getDeposit(quoteId: string): Promise<Deposit | null> {
    await this.refresh();
    const hit = this.totals.get(quoteId.toLowerCase());
    if (!hit) return null;
    if (hit.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`deposit for quote ${quoteId} exceeds safe integer range`);
    }
    return { amount: Number(hit.amount), txRef: hit.txRef };
  }

  private overdueCache: { value: boolean; at: number } | null = null;

  /**
   * Mirrors vault.isPublicationOverdue(), cached for 30s. The vault gates
   * allowance deposits on this; the mint mirrors it by refusing new quotes,
   * covering the memo-transfer path the contract cannot intercept.
   */
  async isPublicationOverdue(): Promise<boolean> {
    if (this.overdueCache && Date.now() - this.overdueCache.at < 30_000) return this.overdueCache.value;
    if (!this.client.readContract) return false; // test stubs without contract reads
    const value = (await this.client.readContract({
      address: this.depositAddress,
      abi: overdueAbi,
      functionName: 'isPublicationOverdue',
    })) as boolean;
    this.overdueCache = { value, at: Date.now() };
    return value;
  }

  private statusCache: { value: ChainStatus; at: number; key: string } | null = null;

  /** Everything the status page shows about custody, read from the chain (cached 15 s). Tolerates v1 vaults. */
  async chainStatus(keysetId: string, probeAmount: number): Promise<ChainStatus | null> {
    const cacheKey = `${keysetId}:${probeAmount}`;
    if (this.statusCache && this.statusCache.key === cacheKey && Date.now() - this.statusCache.at < 15_000) return this.statusCache.value;
    if (!this.client.readContract) return null;
    const read = async <T>(address: `0x${string}`, functionName: string, args?: unknown[]): Promise<T | null> => {
      try {
        return (await this.client.readContract!({ address, abi: statusAbi, functionName, ...(args ? { args } : {}) } as never)) as T;
      } catch {
        return null;
      }
    };
    const v = this.depositAddress;
    const [block, balance, operator, lastOutstanding, lastAt, lastBlock, thr, interval, maxFee, timelock, em, key, overdue] = await Promise.all([
      withRetry(() => this.client.getBlockNumber()),
      read<bigint>(this.tokenAddress, 'balanceOf', [v]),
      read<string>(v, 'operator'),
      read<bigint>(v, 'lastOutstanding'),
      read<bigint>(v, 'lastPublishedAt'),
      read<bigint>(v, 'lastPublishedBlock'),
      read<number>(v, 'publishThresholdBps'),
      read<bigint>(v, 'publishIntervalBlocks'),
      read<bigint>(v, 'maxMeltFee'),
      read<bigint>(v, 'rotationTimelock'),
      read<[boolean, bigint, bigint, bigint, string]>(v, 'emergencyInfo'),
      read<string>(v, 'keysetKey', [`0x${keysetId}`, BigInt(probeAmount)]),
      this.isPublicationOverdue().catch(() => null),
    ]);
    const str = (x: bigint | null) => (x === null ? null : x.toString());
    const num = (x: bigint | number | null) => (x === null ? null : Number(x));
    const value: ChainStatus = {
      block: Number(block),
      balance: balance?.toString() ?? '0',
      operator,
      last_outstanding: str(lastOutstanding),
      last_published_at: num(lastAt),
      last_published_block: num(lastBlock),
      publish_threshold_bps: num(thr),
      publish_interval_blocks: num(interval),
      publication_overdue: overdue,
      max_melt_fee: str(maxFee),
      rotation_timelock: num(timelock),
      emergency: em ? { mode: em[0], grace_blocks: Number(em[1]), redeemed: em[2].toString(), cap: em[3].toString(), verifier: em[4] } : null,
      keyset_registered: key === null ? null : key !== '0x',
    };
    this.statusCache = { value, at: Date.now(), key: cacheKey };
    return value;
  }

  private refresh(): Promise<void> {
    this.refreshing ??= this.scan().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async scan(): Promise<void> {
    const head = await withRetry(() => this.client.getBlockNumber());
    const settled = head > this.confirmations ? head - this.confirmations : 0n;
    let cursor = this.cursor ?? (settled > this.lookbackBlocks ? settled - this.lookbackBlocks : 0n);
    while (cursor <= settled) {
      const toBlock = cursor + CHUNK - 1n < settled ? cursor + CHUNK - 1n : settled;
      const logs = await withRetry(() =>
        this.client.getLogs({
          address: this.tokenAddress,
          event: transferWithMemoEvent,
          args: { to: this.depositAddress },
          fromBlock: cursor,
          toBlock,
        }),
      );
      for (const log of logs) {
        const memo = log.args.memo;
        const amount = log.args.amount;
        if (!memo || amount === undefined) continue;
        const key = `${log.transactionHash}:${log.logIndex}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        const quoteId = memo.slice(2).toLowerCase();
        const existing = this.totals.get(quoteId);
        this.totals.set(quoteId, {
          amount: (existing?.amount ?? 0n) + amount,
          txRef: log.transactionHash ?? key,
        });
      }
      cursor = toBlock + 1n;
    }
    this.cursor = cursor;
  }
}
