import { describe, expect, it } from 'vitest';
import { TempoVault, type ChainReader, type TransferLog } from '../src/vault-tempo.js';

const TOKEN = '0x20c0000000000000000000000000000000000000' as const;
const DEPOSIT_ADDR = '0x1111111111111111111111111111111111111111' as const;
const QUOTE = 'ab'.repeat(32);

function log(memo: string, amount: bigint, tx: string, logIndex = 0): TransferLog {
  return {
    args: { from: '0x2222222222222222222222222222222222222222', to: DEPOSIT_ADDR, amount, memo: `0x${memo}` as `0x${string}` },
    transactionHash: tx as `0x${string}`,
    logIndex,
  };
}

function makeVault(logsByRange: (from: bigint, to: bigint) => TransferLog[], head: () => bigint) {
  let getLogsCalls: Array<{ from: bigint; to: bigint }> = [];
  const client: ChainReader = {
    getBlockNumber: async () => head(),
    getLogs: async ({ fromBlock, toBlock }) => {
      getLogsCalls.push({ from: fromBlock, to: toBlock });
      return logsByRange(fromBlock, toBlock);
    },
  };
  const vault = new TempoVault({
    rpcUrl: 'stub',
    chainId: 42431,
    tokenAddress: TOKEN,
    depositAddress: DEPOSIT_ADDR,
    confirmations: 0,
    lookbackBlocks: 100n,
    client,
  });
  return { vault, getLogsCalls: () => getLogsCalls };
}

describe('TempoVault', () => {
  it('credits a quote from a memo-matching transfer and accumulates across transfers', async () => {
    const { vault } = makeVault(
      (from, to) => (from <= 1000n && 1000n <= to ? [log(QUOTE, 400_000n, '0xaa'), log(QUOTE, 600_000n, '0xbb')] : []),
      () => 1000n,
    );
    expect(await vault.getDeposit(QUOTE)).toEqual({ amount: 1_000_000, txRef: '0xbb' });
    expect(await vault.getDeposit('cd'.repeat(32))).toBeNull();
  });

  it('does not double-count under concurrent polls or cursor rescans', async () => {
    let head = 1000n;
    const { vault } = makeVault(
      (from, to) => (from <= 1000n && 1000n <= to ? [log(QUOTE, 500_000n, '0xaa')] : []),
      () => head,
    );
    const [a, b] = await Promise.all([vault.getDeposit(QUOTE), vault.getDeposit(QUOTE)]);
    expect(a).toEqual({ amount: 500_000, txRef: '0xaa' });
    expect(b).toEqual(a);
    head = 1005n; // later poll scans only new blocks; even a replayed log is deduped by (tx, logIndex)
    expect(await vault.getDeposit(QUOTE)).toEqual({ amount: 500_000, txRef: '0xaa' });
  });

  it('chunks long scan ranges below the RPC limit', async () => {
    const ranges: Array<bigint> = [];
    const vault = new TempoVault({
      rpcUrl: 'stub',
      chainId: 42431,
      tokenAddress: TOKEN,
      depositAddress: DEPOSIT_ADDR,
      confirmations: 0,
      lookbackBlocks: 25_000n,
      client: {
        getBlockNumber: async () => 25_000n,
        getLogs: async ({ fromBlock, toBlock }) => {
          ranges.push(toBlock - fromBlock + 1n);
          return [];
        },
      },
    });
    expect(await vault.getDeposit(QUOTE)).toBeNull();
    expect(ranges.length).toBeGreaterThan(1);
    for (const range of ranges) expect(range <= 10_000n).toBe(true);
  });
});
