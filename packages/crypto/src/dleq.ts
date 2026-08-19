import { hashToCurve } from './hashToCurve.js';
import {
  bytesEqual,
  bytesToBigint,
  bytesToScalar,
  GroupPoint,
  hashE,
  mod,
  mulBase,
  mulPoint,
  parsePoint,
  randomScalarBytes,
  scalarToBytes,
} from './points.js';

/**
 * DLEQ proofs per spec/01-crypto.md §3 (byte-compatible with Cashu NUT-12).
 * picocash mints attach one to every blind signature — offline verifiability
 * is what makes accept-then-settle sound.
 */

export interface DleqProof {
  e: Uint8Array;
  s: Uint8Array;
}

/** Mint side: prove C_ = k·B_ under K = k·G. Omit `nonce` for a fresh CSPRNG draw. */
export function createDleqProof(
  B_: Uint8Array,
  privateKey: Uint8Array,
  nonce?: Uint8Array,
): DleqProof {
  const k = bytesToScalar(privateKey);
  const w = bytesToScalar(nonce ?? randomScalarBytes());
  const Bp = parsePoint(B_);
  const R1 = mulBase(w);
  const R2 = Bp.multiply(w);
  const K = mulBase(k);
  const C_ = Bp.multiply(k);
  const e = hashE(R1, R2, K, C_);
  const s = mod(w + mod(bytesToBigint(e)) * k);
  return { e, s: scalarToBytes(s) };
}

function verify(B_: GroupPoint, C_: GroupPoint, K: GroupPoint, proof: DleqProof): boolean {
  if (proof.e.length !== 32 || proof.s.length !== 32) return false;
  const e = mod(bytesToBigint(proof.e));
  const s = mod(bytesToBigint(proof.s));
  const R1 = mulBase(s).subtract(mulPoint(K, e));
  const R2 = mulPoint(B_, s).subtract(mulPoint(C_, e));
  let recomputed: Uint8Array;
  try {
    recomputed = hashE(R1, R2, K, C_);
  } catch {
    return false; // R1/R2 landed on the identity — unserializable, proof invalid
  }
  return bytesEqual(recomputed, proof.e);
}

/** Issuance-side verification: client holds B_ and the mint's C_. */
export function verifyDleqBlindSignature(
  B_: Uint8Array,
  C_: Uint8Array,
  mintPubkey: Uint8Array,
  proof: DleqProof,
): boolean {
  try {
    return verify(parsePoint(B_), parsePoint(C_), parsePoint(mintPubkey), proof);
  } catch {
    return false;
  }
}

/**
 * Proof-side (offline) verification: any holder of a token (secret, C) plus the
 * blinding factor r reconstructs B_ = Y + r·G and C_ = C + r·K, then verifies.
 * This is the sub-100ms acceptance path — no mint round-trip.
 */
export function verifyDleqProof(
  secret: Uint8Array,
  C: Uint8Array,
  r: Uint8Array,
  mintPubkey: Uint8Array,
  proof: DleqProof,
): boolean {
  try {
    const K = parsePoint(mintPubkey);
    const Cp = parsePoint(C);
    const rScalar = bytesToScalar(r);
    const B_ = hashToCurve(secret).add(mulBase(rScalar));
    const C_ = Cp.add(K.multiply(rScalar));
    return verify(B_, C_, K, proof);
  } catch {
    return false;
  }
}
