import { randomSecretHex, parsePcBindSecret, sumProofs, verifyProofOffline, yOfSecret, MintApiError, decompose, type Wallet } from '@picocash/sdk';
import {
  CredentialRejected,
  type PicocashChallenge,
  type PicocashCredential,
  type PicocashReceipt,
  type TrustedMint,
} from './types.js';

export interface AcceptorOptions {
  realm: string;
  /** Mints (with preloaded keysets) this service accepts tokens from. */
  mints: TrustedMint[];
  challengeTtlSeconds?: number;
  maxAmount?: number;
}

interface ChallengeState {
  challenge: PicocashChallenge;
  credential?: PicocashCredential;
  receipt?: PicocashReceipt;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Service side of the `picocash` MPP method (spec/04): issues challenges,
 * verifies credentials entirely OFFLINE (the sub-100ms path — no mint
 * round-trip), and settles asynchronously at the mint. Accept-then-settle:
 * the service's double-spend exposure is bounded by amount × settlement lag.
 */
export class PicocashAcceptor {
  private readonly realm: string;
  private readonly mints: TrustedMint[];
  private readonly ttl: number;
  private readonly maxAmount: number;
  private readonly challenges = new Map<string, ChallengeState>();
  /** Y values of recently accepted proofs — cross-challenge duplicate guard. */
  private readonly seenYs = new Set<string>();

  constructor(options: AcceptorOptions) {
    if (options.mints.length === 0) throw new Error('acceptor needs at least one trusted mint');
    this.realm = options.realm;
    this.mints = options.mints;
    this.ttl = options.challengeTtlSeconds ?? 300;
    this.maxAmount = options.maxAmount ?? 10_000_000;
  }

  createChallenge(amount: number): PicocashChallenge {
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > this.maxAmount) {
      throw new Error(`amount must be a positive integer ≤ ${this.maxAmount}`);
    }
    const unit = this.mints[0]!.keyset.unit;
    const challenge: PicocashChallenge = {
      method: 'picocash',
      realm: this.realm,
      challenge_id: `chal_${randomSecretHex().slice(0, 32)}`,
      nonce: randomSecretHex(),
      amount,
      unit,
      mints: this.mints.map((m) => ({ url: m.url, keyset_ids: [m.keyset.id] })),
      expiry: nowSeconds() + this.ttl,
    };
    this.challenges.set(challenge.challenge_id, { challenge });
    return challenge;
  }

  /**
   * The offline verification pipeline, in spec/04 order. Throws
   * CredentialRejected naming the failed check; returns a `pending` receipt on
   * success and marks the challenge paid (single-use).
   *
   * `externalChallenge` supports transports (like mppx) where the framework —
   * not this acceptor — issues and integrity-checks the challenge: pass the
   * reconstructed challenge and the acceptor adopts it, keeping only the
   * single-use and duplicate-token state itself.
   */
  verifyCredential(credential: PicocashCredential, externalChallenge?: PicocashChallenge): PicocashReceipt {
    return this.process(credential, externalChallenge, true);
  }

  /** Non-mutating pre-check: runs every check, consumes nothing. */
  precheckCredential(credential: PicocashCredential, externalChallenge?: PicocashChallenge): PicocashChallenge {
    this.process(credential, externalChallenge, false);
    return this.resolveChallenge(credential, externalChallenge).challenge;
  }

  private resolveChallenge(credential: PicocashCredential, externalChallenge?: PicocashChallenge): ChallengeState {
    let state = this.challenges.get(credential.challenge_id);
    if (!state && externalChallenge && externalChallenge.challenge_id === credential.challenge_id) {
      state = { challenge: externalChallenge };
    }
    if (!state) throw new CredentialRejected('UNKNOWN_CHALLENGE', `no challenge ${credential.challenge_id}`);
    return state;
  }

  private process(credential: PicocashCredential, externalChallenge: PicocashChallenge | undefined, consume: boolean): PicocashReceipt {
    // 1. challenge known, unexpired, never previously accepted
    const state = this.resolveChallenge(credential, externalChallenge);
    const { challenge } = state;
    if (state.receipt) throw new CredentialRejected('CHALLENGE_ALREADY_PAID', 'challenge is single-use and already paid');
    if (challenge.expiry < nowSeconds()) throw new CredentialRejected('CHALLENGE_EXPIRED', 'challenge expired; request a new one');

    // 2. mint + keyset allowlisted
    const trusted = this.mints.find((m) => m.url === credential.mint && m.keyset.id === credential.keyset_id);
    if (!trusted) throw new CredentialRejected('MINT_NOT_ALLOWED', `mint ${credential.mint} / keyset ${credential.keyset_id} not in allowlist`);

    // 3. every secret commits to this challenge's nonce and realm
    for (const [i, proof] of credential.proofs.entries()) {
      const bind = parsePcBindSecret(proof.secret);
      if (!bind || bind.nonce !== challenge.nonce || bind.realm !== challenge.realm) {
        throw new CredentialRejected('BINDING_INVALID', `proof ${i} is not bound to this challenge (PC-BIND nonce/realm mismatch)`);
      }
    }

    // 4. exact amount, valid denominations
    if (sumProofs(credential.proofs) !== challenge.amount) {
      throw new CredentialRejected('AMOUNT_INVALID', `proofs sum to ${sumProofs(credential.proofs)}, challenge is for ${challenge.amount}`);
    }
    for (const [i, proof] of credential.proofs.entries()) {
      if (!trusted.keyset.keys[String(proof.amount)]) {
        throw new CredentialRejected('AMOUNT_INVALID', `proof ${i}: ${proof.amount} is not a denomination of keyset ${trusted.keyset.id}`);
      }
    }

    // 5. DLEQ verifies offline against the cached keyset
    for (const [i, proof] of credential.proofs.entries()) {
      if (!verifyProofOffline(proof, trusted.keyset)) {
        throw new CredentialRejected('DLEQ_INVALID', `proof ${i} failed offline DLEQ verification`);
      }
    }

    // 6. no duplicate Y within the credential or across recent acceptances
    const ys = credential.proofs.map((p) => yOfSecret(p.secret));
    if (new Set(ys).size !== ys.length || ys.some((y) => this.seenYs.has(y))) {
      throw new CredentialRejected('DUPLICATE_TOKEN', 'a proof in this credential was already presented');
    }

    const receipt: PicocashReceipt = {
      method: 'picocash',
      challenge_id: challenge.challenge_id,
      accepted_at: nowSeconds(),
      amount: challenge.amount,
      settlement: 'pending',
      checkstate_ref: null,
    };
    if (consume) {
      for (const y of ys) this.seenYs.add(y);
      state.credential = credential;
      state.receipt = receipt;
      this.challenges.set(challenge.challenge_id, state); // adopt external challenges
    }
    return receipt;
  }

  /**
   * Async settlement: swap the accepted proofs for fresh service-owned ones at
   * the mint. This is the double-spend check and the moment of finality; a
   * TOKEN_ALREADY_SPENT here marks the receipt double-spent (service-level
   * recourse applies — spec/04).
   */
  async settle(challengeId: string, wallet: Wallet): Promise<PicocashReceipt> {
    const state = this.challenges.get(challengeId);
    if (!state?.receipt || !state.credential) throw new Error(`nothing to settle for ${challengeId}`);
    if (state.receipt.settlement !== 'pending') return state.receipt;
    try {
      const fresh = await wallet.swap(
        state.credential.proofs,
        decompose(state.receipt.amount).map((amount) => ({ amount })),
      );
      state.receipt = { ...state.receipt, settlement: 'settled', checkstate_ref: fresh[0]?.keyset_id ?? null };
    } catch (err) {
      if (err instanceof MintApiError && err.code === 'TOKEN_ALREADY_SPENT') {
        state.receipt = { ...state.receipt, settlement: 'double-spent' };
      } else {
        throw err; // transient mint failure: stay pending, retry later
      }
    }
    return state.receipt;
  }

  getReceipt(challengeId: string): PicocashReceipt | null {
    return this.challenges.get(challengeId)?.receipt ?? null;
  }
}
