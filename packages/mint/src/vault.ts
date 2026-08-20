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
