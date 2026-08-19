import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export const Point = secp256k1.ProjectivePoint;
export type GroupPoint = InstanceType<typeof secp256k1.ProjectivePoint>;

export const ORDER = secp256k1.CURVE.n;

export function mod(x: bigint): bigint {
  const r = x % ORDER;
  return r >= 0n ? r : r + ORDER;
}

export function bytesToBigint(bytes: Uint8Array): bigint {
  return BigInt('0x' + (bytesToHex(bytes) || '0'));
}

/** Strict scalar parse for private values: 32 bytes, in [1, n). */
export function bytesToScalar(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) throw new Error('scalar must be 32 bytes');
  const x = bytesToBigint(bytes);
  if (x <= 0n || x >= ORDER) throw new Error('scalar out of range [1, n)');
  return x;
}

export function scalarToBytes(x: bigint): Uint8Array {
  return hexToBytes(mod(x).toString(16).padStart(64, '0'));
}

export function parsePoint(bytes: Uint8Array): GroupPoint {
  const p = Point.fromHex(bytes);
  p.assertValidity();
  if (p.equals(Point.ZERO)) throw new Error('point at infinity not allowed');
  return p;
}

/** scalar·G, tolerating 0 (returns identity). Public-data math only. */
export function mulBase(scalar: bigint): GroupPoint {
  return scalar === 0n ? Point.ZERO : Point.BASE.multiply(mod(scalar));
}

/** scalar·P, tolerating 0 (returns identity). Public-data math only. */
export function mulPoint(p: GroupPoint, scalar: bigint): GroupPoint {
  return scalar === 0n ? Point.ZERO : p.multiply(mod(scalar));
}

export function randomScalarBytes(): Uint8Array {
  return secp256k1.utils.randomPrivateKey();
}

/**
 * Cashu NUT-12 challenge hash: SHA256 over the UTF-8 encoding of the
 * concatenated lowercase-hex UNCOMPRESSED serializations of the points.
 * (Yes, hex-as-text — kept for byte compatibility with Cashu.)
 */
export function hashE(...points: GroupPoint[]): Uint8Array {
  let acc = '';
  for (const p of points) acc += bytesToHex(p.toRawBytes(false));
  return sha256(utf8ToBytes(acc));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
