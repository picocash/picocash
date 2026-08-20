import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
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
 * DLEQ proofs per PIP-00 §3 (byte-compatible with Cashu NUT-12).
 * picocash mints attach one to every blind signature — offline verifiability
 * is what makes accept-then-settle sound.
 */

export interface DleqProof {
  e: Uint8Array;
  s: Uint8Array;
}

/**
 * Deterministic proof nonce: HMAC-SHA256(key = privateKey, "picocash-dleq-nonce" || B_),
 * reduced mod n. A biased or repeated `w` leaks the signing key (review P1-7);
 * deriving it from the key and the message removes the RNG from that path,
 * the way RFC 6979 does for ECDSA. Callers may still pass an explicit nonce
 * (test vectors); it MUST be uniformly random and never reused.
 */
function deterministicNonce(privateKey: Uint8Array, B_: Uint8Array): Uint8Array {
  const msg = new Uint8Array(DLEQ_NONCE_DOMAIN.length + B_.length);
  msg.set(DLEQ_NONCE_DOMAIN, 0);
  msg.set(B_, DLEQ_NONCE_DOMAIN.length);
  return hmac(sha256, privateKey, msg);
}
const DLEQ_NONCE_DOMAIN = new TextEncoder().encode('picocash-dleq-nonce');

/** Mint side: prove C_ = k·B_ under K = k·G. Omit `nonce` for a deterministic (RFC 6979-style) draw. */
export function createDleqProof(
  B_: Uint8Array,
  privateKey: Uint8Array,
  nonce?: Uint8Array,
): DleqProof {
  const k = bytesToScalar(privateKey);
  const w = bytesToScalar(nonce ?? deterministicNonce(privateKey, B_));
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
