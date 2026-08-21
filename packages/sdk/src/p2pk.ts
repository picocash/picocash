import { p2pkPublicKey, p2pkWitness, parseP2pkSecret, parseP2pkWitness, signP2pk, type P2pkConditions } from '@picocash/crypto';
import type { Proof } from './types.js';

/** The P2PK conditions a proof is locked under, or null if it is unconditional. Throws on malformed P2PK. */
export function lockOf(proof: Proof): P2pkConditions | null {
  return parseP2pkSecret(proof.secret);
}

/**
 * Attach a signature from `privateKey` to every P2PK proof it is relevant to
 * (lock, pubkeys, or refund key). Unconditional proofs pass through untouched;
 * existing signatures from other keys are kept (multisig accumulates).
 */
export function signProofs(proofs: Proof[], privateKey: Uint8Array): Proof[] {
  const pub = p2pkPublicKey(privateKey);
  return proofs.map((proof) => {
    const c = parseP2pkSecret(proof.secret);
    if (!c) return proof;
    const relevant = c.data === pub || c.pubkeys.includes(pub) || c.refund.includes(pub);
    if (!relevant) return proof;
    const existing = parseP2pkWitness(proof.witness);
    const sig = signP2pk(proof.secret, privateKey);
    return { ...proof, witness: p2pkWitness(existing.includes(sig) ? existing : [...existing, sig]) };
  });
}
