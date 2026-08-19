import { hashToCurve } from './hashToCurve.js';
import {
  bytesToScalar,
  mulBase,
  parsePoint,
  randomScalarBytes,
} from './points.js';

/**
 * BDHKE per spec/01-crypto.md §2. All points are 33-byte SEC1 compressed,
 * all scalars 32-byte big-endian.
 */

export interface BlindingResult {
  /** Blinded message B_ = hash_to_curve(secret) + r·G, sent to the mint. */
  B_: Uint8Array;
  /** Blinding factor r — keep private; needed to unblind and for proof-side DLEQ. */
  r: Uint8Array;
}

/** Client step 1–2: blind a secret. Omit `r` to draw a fresh CSPRNG factor. */
export function blindMessage(secret: Uint8Array, r?: Uint8Array): BlindingResult {
  const rBytes = r ?? randomScalarBytes();
  const rScalar = bytesToScalar(rBytes);
  const Y = hashToCurve(secret);
  return { B_: Y.add(mulBase(rScalar)).toRawBytes(true), r: rBytes };
}

/** Mint step 3: C_ = k·B_. */
export function signBlindedMessage(B_: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const k = bytesToScalar(privateKey);
  return parsePoint(B_).multiply(k).toRawBytes(true);
}

/** Client step 4: C = C_ − r·K, yielding the proof (secret, C) against mint pubkey K. */
export function unblindSignature(C_: Uint8Array, r: Uint8Array, mintPubkey: Uint8Array): Uint8Array {
  const K = parsePoint(mintPubkey);
  const rScalar = bytesToScalar(r);
  return parsePoint(C_).subtract(K.multiply(rScalar)).toRawBytes(true);
}

/** Mint-side spend check: k·hash_to_curve(secret) == C. */
export function verifyProof(secret: Uint8Array, C: Uint8Array, privateKey: Uint8Array): boolean {
  const k = bytesToScalar(privateKey);
  let point;
  try {
    point = parsePoint(C);
  } catch {
    return false;
  }
  return hashToCurve(secret).multiply(k).equals(point);
}

/** K = k·G, the published keyset pubkey for one denomination. */
export function derivePublicKey(privateKey: Uint8Array): Uint8Array {
  return mulBase(bytesToScalar(privateKey)).toRawBytes(true);
}
