/** A spendable token unit. `dleq` (with the blinding factor r) makes it
 *  offline-verifiable by anyone holding the mint's public keys — required for
 *  agent-to-agent transfer and MPP accept-then-settle (PIP-00 §3, PIP-05). */
export interface Proof {
  amount: number;
  keyset_id: string;
  /** Secret as raw bytes, hex-encoded. */
  secret: string;
  C: string;
  dleq?: { e: string; s: string; r: string };
}

/** Serialized transfer format: everything a receiver needs to verify offline. */
export interface TokenBundle {
  mint: string;
  unit: string;
  keyset_id: string;
  proofs: Proof[];
}

export interface KeysetInfo {
  id: string;
  unit: string;
  /** denomination (decimal string) → compressed pubkey hex */
  keys: Record<string, string>;
}

export interface MintQuote {
  quote_id: string;
  amount: number;
  unit: string;
  state: 'UNPAID' | 'PAID' | 'ISSUED';
  deposit: {
    method: string;
    chain_id?: number;
    token?: string;
    to?: string;
    memo: string;
    note: string;
  };
  expires_at: number;
}

export interface MeltQuote {
  melt_id: string;
  /** The on-chain payout. */
  amount: number;
  /** The mint's melt fee; inputs must sum to `total = amount + fee`. */
  fee: number;
  total: number;
  unit: string;
  to: string;
  state: 'UNPAID' | 'PENDING' | 'PAID' | 'OWED';
  tx_hash: string | null;
  expires_at: number;
}

export class MintApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly recovery: string,
  ) {
    super(message);
    this.name = 'MintApiError';
  }
}
