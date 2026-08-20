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
}

const vaultAbi = parseAbi(['function ecashMelt(address to, uint256 amount, bytes32 meltId)']);

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
  failNext = false;
  private counter = 0;

  async execute(to: string, amount: number, meltId: string): Promise<string> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('fake payout failure (test-injected)');
    }
    this.calls.push({ to, amount, meltId });
    return `fake-payout-${++this.counter}`;
  }
}
