import {
  blindMessage,
  bytesToHex,
  hashToCurve,
  hexToBytes,
  unblindSignature,
  verifyDleqBlindSignature,
} from '@picocash/crypto';
import { randomSecretHex } from './secrets.js';
import type { KeysetInfo, Proof } from './types.js';

export interface OutputSpec {
  amount: number;
  /** Hex secret; omit for a fresh random one. Structured (PC-BIND) secrets go here. */
  secret?: string;
}

export interface PendingOutput {
  amount: number;
  secret: string;
  r: Uint8Array;
  B_: string;
}

export interface WireOutput {
  amount: number;
  keyset_id: string;
  B_: string;
}

export function prepareOutputs(keysetId: string, specs: OutputSpec[]): { outputs: WireOutput[]; pending: PendingOutput[] } {
  const pending = specs.map((spec) => {
    const secret = spec.secret ?? randomSecretHex();
    const { B_, r } = blindMessage(hexToBytes(secret));
    return { amount: spec.amount, secret, r, B_: bytesToHex(B_) };
  });
  return {
    outputs: pending.map((p) => ({ amount: p.amount, keyset_id: keysetId, B_: p.B_ })),
    pending,
  };
}

/**
 * Unblind mint signatures into proofs, verifying every DLEQ against the
 * published keyset first — never trust a signature the mint can't prove.
 * The resulting proofs carry {e, s, r} so third parties can verify offline.
 */
export function finalizeSignatures(
  keyset: KeysetInfo,
  pending: PendingOutput[],
  signatures: Array<{ amount: number; C_: string; dleq: { e: string; s: string } }>,
): Proof[] {
  if (signatures.length !== pending.length) throw new Error('mint returned a different number of signatures than requested');
  return signatures.map((sig, i) => {
    const p = pending[i]!;
    const pubkeyHex = keyset.keys[String(p.amount)];
    if (!pubkeyHex) throw new Error(`keyset has no key for denomination ${p.amount}`);
    const pubkey = hexToBytes(pubkeyHex);
    const ok = verifyDleqBlindSignature(hexToBytes(p.B_), hexToBytes(sig.C_), pubkey, {
      e: hexToBytes(sig.dleq.e),
      s: hexToBytes(sig.dleq.s),
    });
    if (!ok) throw new Error(`DLEQ verification failed for output ${i} — rejecting the mint's signature`);
    const C = unblindSignature(hexToBytes(sig.C_), p.r, pubkey);
    return {
      amount: p.amount,
      keyset_id: keyset.id,
      secret: p.secret,
      C: bytesToHex(C),
      dleq: { e: sig.dleq.e, s: sig.dleq.s, r: bytesToHex(p.r) },
    };
  });
}

export function yOfSecret(secretHex: string): string {
  return bytesToHex(hashToCurve(hexToBytes(secretHex)).toRawBytes(true));
}

/** Binary decomposition into power-of-2 denominations, descending. */
export function decompose(amount: number): number[] {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer');
  const parts: number[] = [];
  for (let pow = 30; pow >= 0; pow--) {
    const denomination = 2 ** pow;
    if (amount >= denomination) {
      parts.push(denomination);
      amount -= denomination;
    }
  }
  if (amount !== 0) throw new Error('amount exceeds representable range');
  return parts;
}

export function sumProofs(proofs: Array<{ amount: number }>): number {
  return proofs.reduce((total, proof) => total + proof.amount, 0);
}
