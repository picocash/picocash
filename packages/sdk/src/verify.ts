import { hexToBytes, verifyDleqProof } from '@picocash/crypto';
import type { KeysetInfo, Proof } from './types.js';

/**
 * Offline proof verification (spec/01 §3): checks the proof's DLEQ against the
 * given keyset public keys, with no mint round-trip. This proves the token was
 * signed by the keyset's key — it does NOT prove it is unspent; that guarantee
 * only comes from redeeming (swap/melt) at the mint.
 */
export function verifyProofOffline(proof: Proof, keyset: KeysetInfo): boolean {
  if (proof.keyset_id !== keyset.id) return false;
  const pubkeyHex = keyset.keys[String(proof.amount)];
  if (!pubkeyHex || !proof.dleq) return false;
  try {
    return verifyDleqProof(
      hexToBytes(proof.secret),
      hexToBytes(proof.C),
      hexToBytes(proof.dleq.r),
      hexToBytes(pubkeyHex),
      { e: hexToBytes(proof.dleq.e), s: hexToBytes(proof.dleq.s) },
    );
  } catch {
    return false;
  }
}
