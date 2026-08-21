export interface Deposit {
  amount: number;
  txRef: string;
}

/**
 * The mint's view of the vault: "has a deposit bound to this quote id (memo)
 * landed, and for how much?" The real implementation (build step 5) watches
 * vault-contract events on Tempo; the fake one is an in-memory map fed by the
 * /dev/deposit endpoint. The mint API is identical against either.
 */
export interface DepositOracle {
  getDeposit(quoteId: string): Promise<Deposit | null>;
  /** Vault publication-policy breach (PIP-04); quotes are refused while true. */
  isPublicationOverdue?(): Promise<boolean>;
  /** On-chain custody snapshot for the status page; null when not on a real chain. */
  chainStatus?(keysetId: string, probeAmount: number): Promise<ChainStatus | null>;
}

/** What the chain says about the vault right now (all amounts in base units as strings). */
export interface ChainStatus {
  block: number;
  balance: string;
  operator: string | null;
  last_outstanding: string | null;
  last_published_at: number | null;
  last_published_block: number | null;
  publish_threshold_bps: number | null;
  publish_interval_blocks: number | null;
  publication_overdue: boolean | null;
  max_melt_fee: string | null;
  rotation_timelock: number | null;
  emergency: { mode: boolean; grace_blocks: number; redeemed: string; cap: string; verifier: string } | null;
  keyset_registered: boolean | null;
  breaker: { limit_bps: number; epoch_blocks: number; epoch_start: number; baseline: string; allowance: string; melted: string; tripped_at: number } | null;
}

export class FakeVault implements DepositOracle {
  private readonly deposits = new Map<string, Deposit>();
  private counter = 0;

  simulateDeposit(quoteId: string, amount: number): Deposit {
    const existing = this.deposits.get(quoteId);
    const total = (existing?.amount ?? 0) + amount;
    const deposit = { amount: total, txRef: `fake-tx-${++this.counter}` };
    this.deposits.set(quoteId, deposit);
    return deposit;
  }

  async getDeposit(quoteId: string): Promise<Deposit | null> {
    return this.deposits.get(quoteId) ?? null;
  }
}
