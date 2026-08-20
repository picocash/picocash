import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { TempoConfig } from './config.js';

/**
 * Executes melt payouts. Tempo mode calls vault.withdraw() as operator; the
 * vault enforces one payout per meltId on-chain, so retries can never
 * double-pay. Fake mode backs unit tests and the no-chain dev server.
 */
export interface PayoutExecutor {
  /** Returns the settlement tx reference. MUST throw if the payout did not land. */
  execute(to: string, amount: number, meltId: string): Promise<string>;
  /** On-chain truth for crash recovery: has this melt id already been paid out? */
  isPaid(meltId: string): Promise<boolean>;
}

const vaultAbi = parseAbi(['function ecashMelt(address to, uint256 amount, bytes32 meltId)', 'function meltPaid(bytes32) view returns (bool)']);

export class TempoPayout implements PayoutExecutor {
  private readonly wallet;
  private readonly publicClient;
  private readonly vaultAddress: `0x${string}`;

  constructor(tempo: TempoConfig) {
    if (!tempo.operatorKey) throw new Error('TempoPayout requires an operator key');
    const chain = defineChain({
      id: tempo.chainId,
      name: `tempo-${tempo.chainId}`,
      nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
      rpcUrls: { default: { http: [tempo.rpcUrl] } },
    });
    this.vaultAddress = tempo.depositAddress;
    this.wallet = createWalletClient({ account: privateKeyToAccount(tempo.operatorKey), chain, transport: http() });
    this.publicClient = createPublicClient({ chain, transport: http() });
  }

  async isPaid(meltId: string): Promise<boolean> {
    return this.publicClient.readContract({ address: this.vaultAddress, abi: vaultAbi, functionName: 'meltPaid', args: [`0x${meltId}` as `0x${string}`] });
  }

  async execute(to: string, amount: number, meltId: string): Promise<string> {
    const hash = await this.wallet.writeContract({
      address: this.vaultAddress,
      abi: vaultAbi,
      functionName: 'ecashMelt',
      args: [to as `0x${string}`, BigInt(amount), `0x${meltId}` as `0x${string}`],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== 'success') throw new Error(`vault.ecashMelt reverted: ${hash}`);
    return hash;
  }
}

export class FakePayout implements PayoutExecutor {
  readonly calls: Array<{ to: string; amount: number; meltId: string }> = [];
  readonly paid = new Set<string>();
  failNext = false;
  /** Simulate "chain success, response lost": mark paid but throw. */
  landButFailNext = false;
  private counter = 0;

  async isPaid(meltId: string): Promise<boolean> {
    return this.paid.has(meltId);
  }

  async execute(to: string, amount: number, meltId: string): Promise<string> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('fake payout failure (test-injected)');
    }
    if (this.landButFailNext) {
      this.landButFailNext = false;
      this.paid.add(meltId);
      this.calls.push({ to, amount, meltId });
      throw new Error('fake: tx landed but the response was lost');
    }
    this.paid.add(meltId);
    this.calls.push({ to, amount, meltId });
    return `fake-payout-${++this.counter}`;
  }
}
