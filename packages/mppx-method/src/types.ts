import type { KeysetInfo, Proof } from '@picocash/sdk';

/** Challenge issued by a service (PIP-05). */
export interface PicocashChallenge {
  method: 'picocash';
  realm: string;
  challenge_id: string;
  /** 32-byte hex; PC-BIND secrets commit to it. */
  nonce: string;
  amount: number;
  unit: string;
  mints: Array<{ url: string; keyset_ids: string[] }>;
  expiry: number;
}

/** Credential the agent answers with: proofs bound to the challenge. */
export interface PicocashCredential {
  method: 'picocash';
  challenge_id: string;
  mint: string;
  keyset_id: string;
  /** Every proof MUST carry its dleq {e, s, r} — that is what gets verified offline. */
  proofs: Proof[];
}

/** Receipt the service returns on acceptance (PIP-05). */
export interface PicocashReceipt {
  method: 'picocash';
  challenge_id: string;
  accepted_at: number;
  amount: number;
  settlement: 'pending' | 'settled' | 'double-spent';
  checkstate_ref: string | null;
}

/** A mint the service trusts, with its keyset preloaded for offline checks. */
export interface TrustedMint {
  url: string;
  keyset: KeysetInfo;
}

/** Structured rejection: `reason` names the failed check from PIP-05. */
export class CredentialRejected extends Error {
  constructor(
    public readonly reason:
      | 'UNKNOWN_CHALLENGE'
      | 'CHALLENGE_EXPIRED'
      | 'CHALLENGE_ALREADY_PAID'
      | 'MINT_NOT_ALLOWED'
      | 'UNIT_MISMATCH'
      | 'DOUBLE_SPENT'
      | 'BINDING_INVALID'
      | 'AMOUNT_INVALID'
      | 'DLEQ_INVALID'
      | 'DUPLICATE_TOKEN',
    message: string,
  ) {
    super(message);
    this.name = 'CredentialRejected';
  }
}
