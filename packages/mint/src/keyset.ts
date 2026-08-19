import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { concatBytes } from '@noble/hashes/utils';
import { bytesToHex, derivePublicKey, ORDER, utf8ToBytes } from '@picocash/crypto';

export interface DenominationKey {
  privkey: Uint8Array;
  pubkey: Uint8Array;
}

export interface Keyset {
  id: string;
  unit: string;
  /** denomination (base units) → key pair, ascending */
  keys: Map<number, DenominationKey>;
}

/** Rejection-sampled scalar per spec/02-keysets.md: HMAC-SHA256(seed, label/i). */
function deriveDenominationPrivkey(seed: Uint8Array, unit: string, denomination: number): Uint8Array {
  for (let i = 0; ; i++) {
    const candidate = hmac(sha256, seed, utf8ToBytes(`picocash/keyset/v1/${unit}/${denomination}/${i}`));
    const x = BigInt('0x' + bytesToHex(candidate));
    if (x > 0n && x < ORDER) return candidate;
  }
}

/** Keyset id per spec/02: "00" + first 7 bytes of SHA256(pubkeys ascending by denomination). */
export function computeKeysetId(pubkeysAscending: Uint8Array[]): string {
  return '00' + bytesToHex(sha256(concatBytes(...pubkeysAscending))).slice(0, 14);
}

export function deriveKeyset(seed: Uint8Array, unit: string, maxPow2 = 30): Keyset {
  if (seed.length !== 32) throw new Error('keyset seed must be 32 bytes');
  const keys = new Map<number, DenominationKey>();
  const pubkeys: Uint8Array[] = [];
  for (let pow = 0; pow <= maxPow2; pow++) {
    const denomination = 2 ** pow;
    const privkey = deriveDenominationPrivkey(seed, unit, denomination);
    const pubkey = derivePublicKey(privkey);
    keys.set(denomination, { privkey, pubkey });
    pubkeys.push(pubkey);
  }
  return { id: computeKeysetId(pubkeys), unit, keys };
}

/** JSON shape for /v1/keys: { "1": "02…", "2": "03…", … }. */
export function publicKeysJson(keyset: Keyset): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [denomination, key] of keyset.keys) out[String(denomination)] = bytesToHex(key.pubkey);
  return out;
}
