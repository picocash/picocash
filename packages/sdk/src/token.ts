import type { Proof, TokenBundle } from './types.js';

/**
 * PIP-06 token serialization: "pico" + version letter + base64url(JSON).
 * Version A payload uses short keys and groups proofs by keyset.
 */

const PREFIX = 'pico';
const VERSION = 'A';
const MEMO_MAX_BYTES = 256;

interface PayloadA {
  m: string;
  u: string;
  t: Array<{ i: string; p: Array<{ a: number; s: string; c: string; d: { e: string; s: string; r: string } }> }>;
  memo?: string;
}

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s: string): Uint8Array {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export class TokenFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenFormatError';
  }
}

/** Encode a bundle as a `picoA…` string. Every proof MUST carry its DLEQ payload. */
export function serializeToken(bundle: TokenBundle, memo?: string): string {
  if (bundle.proofs.length === 0) throw new TokenFormatError('cannot serialize an empty bundle');
  if (memo !== undefined && new TextEncoder().encode(memo).length > MEMO_MAX_BYTES) {
    throw new TokenFormatError(`memo exceeds ${MEMO_MAX_BYTES} bytes`);
  }
  const groups = new Map<string, PayloadA['t'][number]['p']>();
  for (const [i, proof] of bundle.proofs.entries()) {
    if (!proof.dleq) throw new TokenFormatError(`proof ${i} has no DLEQ payload; tokens must be offline-verifiable`);
    const list = groups.get(proof.keyset_id) ?? [];
    list.push({ a: proof.amount, s: proof.secret, c: proof.C, d: { e: proof.dleq.e, s: proof.dleq.s, r: proof.dleq.r } });
    groups.set(proof.keyset_id, list);
  }
  const payload: PayloadA = {
    m: bundle.mint,
    u: bundle.unit,
    t: [...groups.entries()].map(([i, p]) => ({ i, p: [...p].sort((x, y) => y.a - x.a) })),
    ...(memo !== undefined ? { memo } : {}),
  };
  return PREFIX + VERSION + b64url(new TextEncoder().encode(JSON.stringify(payload)));
}

const HEX = /^[0-9a-f]+$/;

/** Decode a `pico…` string into a bundle (+ memo). Throws TokenFormatError on anything malformed. */
/** Hard parse limits (PIP-06 §Limits): bound memory and CPU on untrusted input. */
export const TOKEN_LIMITS = { maxChars: 1024 * 1024, maxProofs: 1024, maxMemoChars: 512, maxMintUrlChars: 512 } as const;

export function parseToken(input: string): { bundle: TokenBundle; memo?: string } {
  if (input.length > TOKEN_LIMITS.maxChars) throw new TokenFormatError(`token exceeds ${TOKEN_LIMITS.maxChars} characters`);
  const s = input.trim();
  if (!s.startsWith(PREFIX)) throw new TokenFormatError('not a picocash token (expected "pico" prefix)');
  const version = s.charAt(PREFIX.length);
  if (version !== VERSION) throw new TokenFormatError(`unsupported token version "${version}" (this wallet understands ${VERSION})`);
  let payload: PayloadA;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(unb64url(s.slice(PREFIX.length + 1)))) as PayloadA;
  } catch {
    throw new TokenFormatError('token payload is not valid base64url JSON');
  }
  if (typeof payload?.m !== 'string' || typeof payload?.u !== 'string' || !Array.isArray(payload?.t) || payload.t.length === 0) {
    throw new TokenFormatError('token is missing mint, unit, or proofs');
  }
  if (payload.memo !== undefined && typeof payload.memo !== 'string') throw new TokenFormatError('memo must be a string');
  if ((payload.memo?.length ?? 0) > TOKEN_LIMITS.maxMemoChars) throw new TokenFormatError(`memo exceeds ${TOKEN_LIMITS.maxMemoChars} characters`);
  if (payload.m.length > TOKEN_LIMITS.maxMintUrlChars || !/^https?:\/\//.test(payload.m)) throw new TokenFormatError('mint must be an http(s) URL');
  if (!/^tip20:\d+:0x[0-9a-fA-F]{40}$/.test(payload.u)) throw new TokenFormatError('unit must be tip20:<chain_id>:<token_address>');

  const proofs: Proof[] = [];
  for (const group of payload.t) {
    if (typeof group?.i !== 'string' || !/^[0-9a-f]{16}$/.test(group.i) || !Array.isArray(group.p)) throw new TokenFormatError('malformed keyset group');
    for (const p of group.p) {
      if (proofs.length >= TOKEN_LIMITS.maxProofs) throw new TokenFormatError(`token exceeds ${TOKEN_LIMITS.maxProofs} proofs`);
      const ok =
        Number.isSafeInteger(p?.a) && p.a > 0 &&
        typeof p.s === 'string' && HEX.test(p.s) &&
        typeof p.c === 'string' && HEX.test(p.c) && p.c.length === 66 &&
        p.d && [p.d.e, p.d.s, p.d.r].every((x) => typeof x === 'string' && HEX.test(x) && x.length === 64);
      if (!ok) throw new TokenFormatError('malformed proof in token');
      proofs.push({ amount: p.a, keyset_id: group.i, secret: p.s, C: p.c, dleq: { e: p.d.e, s: p.d.s, r: p.d.r } });
    }
  }
  const bundle: TokenBundle = { mint: payload.m, unit: payload.u, keyset_id: payload.t[0]!.i, proofs };
  return payload.memo !== undefined ? { bundle, memo: payload.memo } : { bundle };
}
