/**
 * Nostr key adapter (picocash × Buzz, plan component 1).
 *
 * A Nostr identity is a secp256k1 keypair; the npub is the bech32 (NIP-19)
 * encoding of the 32-byte x-only public key, and P2PK locks (PIP-08) are
 * BIP-340 Schnorr over `sha256(secret)` — the same curve and signature. So an
 * agent's Nostr key can hold and spend picocash with no new key material.
 *
 * The one subtlety this module exists to handle: a P2PK lock's `data` is a
 * 33-byte *compressed* key, but an npub carries only the x-only coordinate, so
 * we lock to `"02" + x`. For a Nostr key whose true Y is odd, the real
 * compressed key is `"03" + x` — so `@picocash/sdk`'s `signProofs`, which
 * matches the lock by full compressed equality, would skip it. BIP-340
 * verification is x-only and parity-independent, so the signature itself is
 * valid; only the *relevance match* breaks. `signerFromNsec` therefore matches
 * proofs by x-only coordinate, never by the parity byte.
 *
 * NIP-19 `npub`/`nsec` are plain bech32 (no TLV), so a minimal decoder suffices
 * — no new dependency.
 */
import { bytesToHex, hexToBytes, parseP2pkSecret, parseP2pkWitness, p2pkPublicKey, p2pkWitness, signP2pk } from '@picocash/crypto';
import type { Proof } from './types.js';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error('invalid bech32 value');
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new Error('invalid bech32 padding');
  }
  return out;
}

/** Decode a bech32 string, asserting the human-readable prefix, returning the data bytes. */
function bech32Decode(s: string, expectedHrp: string): Uint8Array {
  const lower = s.toLowerCase();
  if (s !== lower && s !== s.toUpperCase()) throw new Error('bech32: mixed case');
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) throw new Error('bech32: no separator');
  const hrp = lower.slice(0, pos);
  if (hrp !== expectedHrp) throw new Error(`expected ${expectedHrp}…, got ${hrp}…`);
  const dataChars: number[] = [];
  for (const ch of lower.slice(pos + 1)) {
    const d = CHARSET.indexOf(ch);
    if (d === -1) throw new Error(`bech32: bad char "${ch}"`);
    dataChars.push(d);
  }
  if (polymod([...hrpExpand(hrp), ...dataChars]) !== 1) throw new Error('bech32: bad checksum');
  return Uint8Array.from(convertBits(dataChars.slice(0, -6), 5, 8, false));
}

function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits([...bytes], 8, 5, true);
  const checksum = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const chk: number[] = [];
  for (let i = 0; i < 6; i++) chk.push((checksum >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...chk].map((d) => CHARSET[d]).join('')}`;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** 32-byte x-only hex from an `npub1…`, bare 64-hex x-only, or 66-hex compressed key. */
function xOnlyFrom(input: string): string {
  const s = input.trim();
  if (s.startsWith('npub1')) return bytesToHex(bech32Decode(s, 'npub'));
  const hex = s.toLowerCase();
  if (HEX64.test(hex)) return hex;
  if (/^0[23][0-9a-f]{64}$/.test(hex)) return hex.slice(2);
  throw new Error('expected an npub, 32-byte x-only hex, or 33-byte compressed hex');
}

/**
 * P2PK lock key (33-byte compressed hex) for a Nostr identity. Nostr carries
 * only x-only, so the parity byte is fixed to `02` by convention; verification
 * is x-only so the choice is immaterial to spending. Pass this as the lock
 * `data` to `p2pkSecretHex`.
 */
export function lockKeyFromNpub(npubOrHex: string): string {
  return `02${xOnlyFrom(npubOrHex)}`;
}

/** 32-byte private key from an `nsec1…` or bare 64-hex secret. */
export function privkeyFromNsec(nsecOrHex: string): Uint8Array {
  const s = nsecOrHex.trim();
  if (s.startsWith('nsec1')) return bech32Decode(s, 'nsec');
  const hex = s.toLowerCase();
  if (HEX64.test(hex)) return hexToBytes(hex);
  throw new Error('expected an nsec or 32-byte hex secret');
}

/** bech32 `npub` from a 32-byte x-only hex or a 33-byte compressed hex. */
export function npubFromPubkey(xOnlyOrCompressed: string): string {
  return bech32Encode('npub', hexToBytes(xOnlyFrom(xOnlyOrCompressed)));
}

export interface NostrSigner {
  /** This key's P2PK lock key (`02` + x-only) — what it can be locked to. */
  readonly lockKey: string;
  /** This key's npub. */
  readonly npub: string;
  /**
   * Sign every proof whose P2PK lock references this key (by x-only coordinate,
   * ignoring the parity byte) — `data`, a `pubkeys` member, or a `refund`
   * member. Proofs not locked to this key pass through untouched. Idempotent:
   * a signature already present is not duplicated.
   */
  sign(proofs: Proof[]): Proof[];
}

/**
 * Build a parity-robust signer from a Nostr secret. Use this instead of
 * `signProofs` whenever the lock was derived from an npub — see the module
 * note on the `02`/`03` parity mismatch.
 */
export function signerFromNsec(nsecOrHex: string): NostrSigner {
  const privkey = privkeyFromNsec(nsecOrHex);
  const xOnly = p2pkPublicKey(privkey).slice(2); // drop the real parity byte; Nostr is x-only
  const matches = (key: string | undefined) => typeof key === 'string' && key.length >= 64 && key.slice(-64) === xOnly;
  return {
    lockKey: `02${xOnly}`,
    npub: bech32Encode('npub', hexToBytes(xOnly)),
    sign(proofs: Proof[]): Proof[] {
      return proofs.map((proof) => {
        const c = parseP2pkSecret(proof.secret);
        if (!c) return proof;
        const relevant = matches(c.data) || c.pubkeys.some(matches) || c.refund.some(matches);
        if (!relevant) return proof;
        const existing = parseP2pkWitness(proof.witness);
        const sig = signP2pk(proof.secret, privkey);
        return existing.includes(sig) ? proof : { ...proof, witness: p2pkWitness([...existing, sig]) };
      });
    },
  };
}

