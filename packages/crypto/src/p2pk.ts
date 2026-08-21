/**
 * PIP-08 — Pay-to-Public-Key spending conditions.
 *
 * Wire-compatible with Cashu NUT-10 (well-known secret) + NUT-11 (P2PK):
 *
 *   secret  = UTF-8 JSON  ["P2PK", { nonce, data: <33-byte pubkey hex>, tags? }]
 *   witness = JSON        { signatures: [<64-byte BIP-340 Schnorr hex>, …] }
 *
 * Signatures are over sha256(secret bytes) (SIG_INPUTS). Recognised tags:
 *   ["locktime", "<unix seconds>"]   lock expires at this time
 *   ["refund",   "<pubkey>", …]      after locktime, any of these keys may spend
 *   ["pubkeys",  "<pubkey>", …]      additional lock keys (with n_sigs)
 *   ["n_sigs",   "<k>"]              k-of-(data + pubkeys) required (default 1)
 *   ["sigflag",  "SIG_INPUTS"]       the only flag supported in v0.1
 *
 * After locktime with no refund keys the proof is spendable by anyone (the
 * lock simply expired). A secret that is not P2PK has no conditions.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export interface P2pkConditions {
  nonce: string;
  /** Primary lock key, 33-byte compressed hex. */
  data: string;
  tags: string[][];
  /** Derived views of the tags. */
  locktime?: number;
  refund: string[];
  pubkeys: string[];
  nSigs: number;
  sigflag: 'SIG_INPUTS';
}

const PUBKEY = /^0[23][0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;

export class P2pkError extends Error {}

/** Build a P2PK secret (hex of UTF-8 JSON). Field order nonce → data → tags is canonical. */
export function p2pkSecretHex(
  lockPubkey: string,
  options: { nonce?: string; locktime?: number; refund?: string[]; pubkeys?: string[]; nSigs?: number } = {},
): string {
  if (!PUBKEY.test(lockPubkey)) throw new P2pkError('lock pubkey must be 33-byte compressed hex');
  const tags: string[][] = [];
  if (options.locktime !== undefined) {
    if (!Number.isSafeInteger(options.locktime) || options.locktime <= 0) throw new P2pkError('locktime must be a positive unix timestamp');
    tags.push(['locktime', String(options.locktime)]);
  }
  if (options.refund?.length) {
    for (const k of options.refund) if (!PUBKEY.test(k)) throw new P2pkError('refund pubkey must be 33-byte compressed hex');
    tags.push(['refund', ...options.refund]);
  }
  if (options.pubkeys?.length) {
    for (const k of options.pubkeys) if (!PUBKEY.test(k)) throw new P2pkError('pubkey must be 33-byte compressed hex');
    tags.push(['pubkeys', ...options.pubkeys]);
  }
  if (options.nSigs !== undefined && options.nSigs !== 1) {
    const max = 1 + (options.pubkeys?.length ?? 0);
    if (!Number.isSafeInteger(options.nSigs) || options.nSigs < 1 || options.nSigs > max) throw new P2pkError(`n_sigs must be 1..${max}`);
    tags.push(['n_sigs', String(options.nSigs)]);
  }
  const nonce = options.nonce ?? bytesToHex(secp256k1.utils.randomPrivateKey());
  const body: Record<string, unknown> = { nonce, data: lockPubkey };
  if (tags.length) body.tags = tags;
  return bytesToHex(utf8ToBytes(JSON.stringify(['P2PK', body])));
}

/** Parse a hex secret as P2PK. Returns null if it is not a P2PK secret; throws P2pkError if it is malformed P2PK. */
export function parseP2pkSecret(secretHex: string): P2pkConditions | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(secretHex)));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== 'P2PK') return null;
  const body = parsed[1] as Record<string, unknown>;
  if (typeof body?.nonce !== 'string' || typeof body?.data !== 'string') throw new P2pkError('P2PK secret needs string nonce and data');
  if (!PUBKEY.test(body.data)) throw new P2pkError('P2PK data must be a 33-byte compressed pubkey');
  const tags = (body.tags ?? []) as unknown;
  if (!Array.isArray(tags) || !tags.every((t) => Array.isArray(t) && t.length >= 1 && t.every((x) => typeof x === 'string'))) {
    throw new P2pkError('P2PK tags must be arrays of strings');
  }
  const c: P2pkConditions = { nonce: body.nonce, data: body.data, tags: tags as string[][], refund: [], pubkeys: [], nSigs: 1, sigflag: 'SIG_INPUTS' };
  for (const [name, ...values] of c.tags) {
    switch (name) {
      case 'locktime': {
        const t = Number(values[0]);
        if (!Number.isSafeInteger(t) || t <= 0) throw new P2pkError('locktime tag must be a positive unix timestamp');
        c.locktime = t;
        break;
      }
      case 'refund':
        if (!values.length || !values.every((k) => PUBKEY.test(k))) throw new P2pkError('refund tag must list compressed pubkeys');
        c.refund = values;
        break;
      case 'pubkeys':
        if (!values.length || !values.every((k) => PUBKEY.test(k))) throw new P2pkError('pubkeys tag must list compressed pubkeys');
        c.pubkeys = values;
        break;
      case 'n_sigs': {
        const n = Number(values[0]);
        if (!Number.isSafeInteger(n) || n < 1) throw new P2pkError('n_sigs must be a positive integer');
        c.nSigs = n;
        break;
      }
      case 'sigflag':
        if (values[0] !== 'SIG_INPUTS') throw new P2pkError(`unsupported sigflag ${values[0]} (only SIG_INPUTS in PIP-08 v0.1)`);
        break;
      default:
        break; // unknown tags are ignored (forward compatibility)
    }
  }
  if (c.nSigs > 1 + c.pubkeys.length) throw new P2pkError('n_sigs exceeds the number of lock keys');
  return c;
}

/** The message every P2PK signature covers: sha256 of the raw secret bytes. */
export function p2pkMessage(secretHex: string): Uint8Array {
  return sha256(hexToBytes(secretHex));
}

/** Sign a P2PK secret with a 32-byte private key; returns the 64-byte Schnorr signature (hex). */
export function signP2pk(secretHex: string, privateKey: Uint8Array): string {
  return bytesToHex(schnorr.sign(p2pkMessage(secretHex), privateKey));
}

/** Compressed (33-byte) public key for a private key — the form that goes in `data`. */
export function p2pkPublicKey(privateKey: Uint8Array): string {
  return bytesToHex(secp256k1.getPublicKey(privateKey, true));
}

/** Build the witness JSON for a proof. */
export function p2pkWitness(signatures: string[]): string {
  return JSON.stringify({ signatures });
}

export function parseP2pkWitness(witness: string | undefined): string[] {
  if (witness === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(witness);
  } catch {
    throw new P2pkError('witness is not JSON');
  }
  const sigs = (parsed as { signatures?: unknown })?.signatures;
  if (!Array.isArray(sigs) || !sigs.every((s) => typeof s === 'string' && SIG.test(s))) throw new P2pkError('witness.signatures must be 64-byte hex strings');
  return sigs as string[];
}

function verifySig(sig: string, msg: Uint8Array, pubkey33: string): boolean {
  try {
    return schnorr.verify(hexToBytes(sig), msg, hexToBytes(pubkey33).slice(1)); // x-only
  } catch {
    return false;
  }
}

export type P2pkVerdict =
  | { ok: true; path: 'unconditional' | 'lock' | 'refund' | 'expired' }
  | { ok: false; reason: string };

/**
 * Evaluate the spending conditions of one proof at time `now` (unix seconds).
 * Non-P2PK secrets are unconditional. Any signature that does not verify
 * against a permitted key is ignored (it is not an error to over-provide).
 */
export function verifyP2pkSpend(secretHex: string, witness: string | undefined, now: number): P2pkVerdict {
  let c: P2pkConditions | null;
  try {
    c = parseP2pkSecret(secretHex);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (!c) return { ok: true, path: 'unconditional' };
  let sigs: string[];
  try {
    sigs = parseP2pkWitness(witness);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  const msg = p2pkMessage(secretHex);
  const expired = c.locktime !== undefined && now >= c.locktime;

  if (!expired) {
    const lockKeys = [c.data, ...c.pubkeys];
    const signed = new Set(lockKeys.filter((k) => sigs.some((s) => verifySig(s, msg, k))));
    if (signed.size >= c.nSigs) return { ok: true, path: 'lock' };
    return { ok: false, reason: `P2PK: need ${c.nSigs} signature(s) from the lock key(s), got ${signed.size}${c.locktime ? ` (lock expires at ${c.locktime})` : ''}` };
  }
  if (c.refund.length === 0) return { ok: true, path: 'expired' };
  if (c.refund.some((k) => sigs.some((s) => verifySig(s, msg, k)))) return { ok: true, path: 'refund' };
  return { ok: false, reason: 'P2PK: lock expired; a refund-key signature is required' };
}
