/**
 * NIP-01 events: id, BIP-340 signature, verification.
 *
 * The id is sha256 over `JSON.stringify([0, pubkey, created_at, kind, tags, content])`.
 * JS `JSON.stringify` already matches NIP-01's serialization (no whitespace,
 * non-ASCII left unescaped, control characters escaped) — the equivalent of
 * Python's `ensure_ascii=False`, which NIP-AE §gotchas calls out as the usual
 * divergence.
 */
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type EventTemplate = Pick<NostrEvent, 'created_at' | 'kind' | 'tags' | 'content'>;

export function eventId(event: Omit<NostrEvent, 'id' | 'sig'>): string {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  return bytesToHex(sha256(utf8ToBytes(serialized)));
}

/** x-only public key (hex) for a private key — the `pubkey` field. */
export function pubkeyOf(privkey: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(privkey));
}

/**
 * Sign a template. `aux` is the BIP-340 auxiliary randomness; it is injectable
 * ONLY to reproduce pinned test vectors (which use all-zero aux). Production
 * callers leave it undefined so the library draws fresh randomness.
 */
export function finalizeEvent(template: EventTemplate, privkey: Uint8Array, aux?: Uint8Array): NostrEvent {
  const pubkey = pubkeyOf(privkey);
  const unsigned = { ...template, pubkey };
  const id = eventId(unsigned);
  const sig = bytesToHex(aux ? schnorr.sign(hexToBytes(id), privkey, aux) : schnorr.sign(hexToBytes(id), privkey));
  return { ...unsigned, id, sig };
}

export function verifyEvent(event: NostrEvent): boolean {
  try {
    if (eventId(event) !== event.id) return false;
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}
